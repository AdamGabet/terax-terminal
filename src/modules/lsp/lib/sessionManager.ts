import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  currentWorkspaceEnv,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { TeraxLspClient } from "./client";
import { clearResolvedBinaries, resolveServerBinary } from "./detect";
import { getLspNavigator } from "./navigator";
import { type LspPreset, serverForLanguage } from "./presets";
import { resolveWorkspaceRoot } from "./root";
import { useLspRuntimeStore } from "./runtimeStore";
import type { TauriLspTransport } from "./transport";
import { fileUriToPath, pathToFileUri } from "./uri";

const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const MAX_CRASHES = 3;
const SHUTDOWN_TIMEOUT_MS = 2000;
const MAX_SESSIONS_PER_PRESET = 4;
const CRASH_COOLDOWN_MS = [2_000, 10_000, 30_000];

type Managed = {
  key: string;
  preset: LspPreset;
  root: string;
  client: TeraxLspClient;
  transport: TauriLspTransport;
  refs: Map<string, number>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
};

export type LspDocHandle = {
  extension: Extension;
  release: () => void;
};

const sessions = new Map<string, Managed>();
const creating = new Map<string, Promise<Managed | null>>();
const crashTimes = new Map<string, number[]>();

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function crashedOut(key: string): boolean {
  const now = Date.now();
  const times = (crashTimes.get(key) ?? []).filter(
    (t) => now - t < CRASH_WINDOW_MS,
  );
  crashTimes.set(key, times);
  return times.length >= MAX_CRASHES;
}

function recordCrash(key: string): void {
  const times = crashTimes.get(key) ?? [];
  times.push(Date.now());
  crashTimes.set(key, times);
}

export async function acquireDocExtension(
  path: string,
  langId: string,
): Promise<LspDocHandle | null> {
  const env = currentWorkspaceEnv();
  // Local + SSH are wired up; WSL LSP isn't supported yet.
  if (env.kind !== "local" && env.kind !== "ssh") return null;
  const prefs = usePreferencesStore.getState();
  const preset = serverForLanguage(langId, prefs.lspCustomServers);
  if (!preset) return null;
  if (prefs.lspActivation[preset.id] !== "enabled") return null;

  // No project root means no session: a per-directory fallback multiplied
  // servers per open file and burned gigabytes. Root resolves first so the
  // binary probe can look inside this repo's venv, not just PATH. Remote roots
  // resolve on the SSH host.
  const markers = preset.rootMarkers.length > 0 ? preset.rootMarkers : [".git"];
  const root = await resolveWorkspaceRoot(path, markers, env);
  if (!root) {
    // No ancestor carries a project marker, so we can't scope a session or
    // locate the repo venv. Silently returning left the pill idle with no
    // clue; surface it as a fixable error naming the markers we looked for.
    // A bare `.git` isn't in most servers' marker lists (e.g. pyright wants
    // pyproject.toml/setup.py/requirements.txt/Pipfile), which is why git
    // worktrees — which carry only a `.git` file — commonly land here. Only
    // shown when the server is enabled and not already running (see useLspHint).
    useLspRuntimeStore
      .getState()
      .setFailed(
        preset.id,
        `No project root found — add a marker file (${markers.join(
          ", ",
        )}) at your project root so the ${preset.name} server can start.`,
      );
    return null;
  }
  const scope = workspaceScopeKey(env);
  // Scope by workspace so a local and a remote repo sharing a path
  // don't collide on one server.
  const key = `${preset.id}\u0000${scope}\u0000${root}`;
  if (crashedOut(key)) return null;

  let managed = sessions.get(key) ?? null;
  if (!managed) {
    if (
      [...sessions.values()].filter((m) => m.preset.id === preset.id).length >=
      MAX_SESSIONS_PER_PRESET
    ) {
      console.warn(
        `[lsp] session cap reached for ${preset.id}, skipping ${root}`,
      );
      return null;
    }

    // Resolve the binary the way we'll spawn it: the repo venv (or the user's
    // override) first, PATH last. A server installed only inside the venv is
    // now both detected and launched from there.
    const venv = prefs.lspVenvOverrides[root] ?? null;
    const command = await resolveServerBinary(preset.command, root, venv, env);
    if (!command) return null;

    // A heavy server idling for a workspace with no open docs is wasted
    // memory the moment another workspace needs one; evict it now instead
    // of waiting out the grace period.
    for (const m of sessions.values()) {
      if (m.preset.id === preset.id && m.refs.size === 0 && !m.closing) {
        void closeSession(m);
      }
    }

    managed = await getOrCreateSession(key, preset, root, command, env);
  }
  if (!managed) return null;

  const uri = pathToFileUri(path);
  const languageId = preset.languages[langId] ?? langId;
  const mod = await import("./client");
  const extension: Extension = [
    mod.lspInteractions({
      client: managed.client,
      documentUri: uri,
      onExternal: (extUri, line) => {
        const target = fileUriToPath(extUri);
        if (target) getLspNavigator()?.openFile(target, line);
      },
    }),
    mod.languageServerWithTransport({
      client: managed.client,
      transport: managed.transport,
      rootUri: pathToFileUri(managed.root),
      workspaceFolders: [
        { uri: pathToFileUri(managed.root), name: basename(managed.root) },
      ],
      documentUri: uri,
      languageId,
      allowHTMLContent: false,
      synchronizationMethod: mod.SynchronizationMethod.Incremental,
    }) as Extension,
  ];

  addRef(managed, uri);
  let released = false;
  return {
    extension,
    release: () => {
      if (released) return;
      released = true;
      releaseRef(managed, uri);
    },
  };
}

function getOrCreateSession(
  key: string,
  preset: LspPreset,
  root: string,
  command: string,
  env: WorkspaceEnv,
): Promise<Managed | null> {
  let inflight = creating.get(key);
  if (!inflight) {
    inflight = createSession(key, preset, root, command, env).finally(() =>
      creating.delete(key),
    );
    creating.set(key, inflight);
  }
  return inflight;
}

async function createSession(
  key: string,
  preset: LspPreset,
  root: string,
  command: string,
  env: WorkspaceEnv,
): Promise<Managed | null> {
  const existing = sessions.get(key);
  if (existing) return existing;

  const store = useLspRuntimeStore.getState();
  store.upsertSession({ key, presetId: preset.id, root, status: "starting" });

  const [{ TauriLspTransport }, { TeraxLspClient }] = await Promise.all([
    import("./transport"),
    import("./client"),
  ]);

  if (TeraxLspClient.hostPid === null) {
    TeraxLspClient.hostPid = await invoke<number>("lsp_host_pid").catch(
      () => null,
    );
  }

  const transport = new TauriLspTransport();
  try {
    await transport.start({
      command,
      args: preset.args,
      root,
      env: preset.env,
      maxMemoryMb: preset.maxMemoryMb,
    });
  } catch (e) {
    recordCrash(key);
    store.removeSession(key, preset.id);
    toast.error(`${preset.name} language server failed to start`, {
      description: String(e),
    });
    return null;
  }

  const rootUri = pathToFileUri(root);
  // A remote server can't watch the local app's PID, so send processId: null
  // over SSH (a stale PID would make the server's parent-exit watchdog quit
  // immediately). Read synchronously right before construction — the parent
  // constructor calls getInitializeParams() before this frame yields.
  TeraxLspClient.nextRemote = env.kind === "ssh";
  const client = new TeraxLspClient({
    transport,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: basename(root) }],
    documentUri: rootUri,
    languageId: "",
    initializationOptions: preset.initializationOptions,
    onClose: () => handleServerExit(key),
    onError: (e) => console.error(`[lsp:${preset.id}]`, e),
  });

  const managed: Managed = {
    key,
    preset,
    root,
    client,
    transport,
    refs: new Map(),
    idleTimer: null,
    closing: false,
  };
  sessions.set(key, managed);
  // Exit can beat the map insert when the binary dies instantly (e.g. a
  // rustup proxy for an uninstalled component); reap it here.
  if (transport.exitInfo) {
    handleServerExit(key);
    return null;
  }

  void client.initializePromise.then(() => {
    if (sessions.get(key) === managed) {
      const runtime = useLspRuntimeStore.getState();
      runtime.clearFailed(preset.id);
      runtime.upsertSession({
        key,
        presetId: preset.id,
        root,
        status: "running",
      });
    }
  });

  return managed;
}

function handleServerExit(key: string): void {
  const managed = sessions.get(key);
  if (!managed || managed.closing) return;
  managed.closing = true;
  if (managed.idleTimer) clearTimeout(managed.idleTimer);
  recordCrash(key);
  sessions.delete(key);
  managed.client.close();
  useLspRuntimeStore.getState().removeSessionQuiet(key);
  const info = managed.transport.exitInfo;
  // Budget kills don't respawn: reloading would repay the startup peak
  // that got the server killed. Restart from the pill is explicit.
  if (info?.reason) {
    crashTimes.set(
      key,
      Array.from({ length: MAX_CRASHES }, () => Date.now()),
    );
    useLspRuntimeStore.getState().setFailed(managed.preset.id, info.reason);
    toast.error(`${managed.preset.name} language server stopped`, {
      description: info.reason,
    });
    return;
  }
  const tail = info?.stderrTail;
  if (crashedOut(key)) {
    useLspRuntimeStore
      .getState()
      .setFailed(
        managed.preset.id,
        tail ? tail.slice(-300) : "The server kept crashing.",
      );
    toast.error(`${managed.preset.name} language server keeps crashing`, {
      description: tail ? tail.slice(-300) : "Giving up for this workspace.",
    });
    return;
  }
  if (tail) {
    toast.error(`${managed.preset.name} language server exited`, {
      description: tail.slice(-300),
    });
  }
  // Delay the re-acquire trigger so an OOM-killed server doesn't respawn
  // into an instant second memory spike.
  const crashes = crashTimes.get(key)?.length ?? 1;
  const delay =
    CRASH_COOLDOWN_MS[Math.min(crashes - 1, CRASH_COOLDOWN_MS.length - 1)];
  setTimeout(
    () => useLspRuntimeStore.getState().bumpGeneration(managed.preset.id),
    delay,
  );
}

function addRef(managed: Managed, uri: string): void {
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
  }
  managed.refs.set(uri, (managed.refs.get(uri) ?? 0) + 1);
}

function releaseRef(managed: Managed, uri: string): void {
  const count = managed.refs.get(uri);
  if (count === undefined) return;
  if (count > 1) {
    managed.refs.set(uri, count - 1);
    return;
  }
  managed.refs.delete(uri);
  if (!managed.closing) managed.client.textDocumentDidClose(uri);
  if (managed.refs.size === 0 && !managed.closing) {
    managed.idleTimer = setTimeout(() => {
      void closeSession(managed);
    }, IDLE_SHUTDOWN_MS);
  }
}

async function closeSession(managed: Managed): Promise<void> {
  if (managed.closing) return;
  managed.closing = true;
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
  }
  sessions.delete(managed.key);
  useLspRuntimeStore.getState().removeSession(managed.key, managed.preset.id);
  await managed.client.shutdownGracefully(SHUTDOWN_TIMEOUT_MS);
  managed.transport.close();
}

export function notifyDocumentSaved(path: string): void {
  const uri = pathToFileUri(path);
  for (const managed of sessions.values()) {
    if (managed.refs.has(uri) && !managed.closing) {
      managed.client.textDocumentDidSave(uri);
    }
  }
}

export async function stopPresetSessions(presetId: string): Promise<void> {
  const targets = [...sessions.values()].filter(
    (m) => m.preset.id === presetId,
  );
  await Promise.all(targets.map((m) => closeSession(m)));
  for (const key of crashTimes.keys()) {
    if (key.startsWith(`${presetId}\u0000`)) crashTimes.delete(key);
  }
}

export async function lspFormatDocument(view: EditorView): Promise<void> {
  if (sessions.size === 0) return;
  const { formatDocumentAndWait } = await import("./client");
  await formatDocumentAndWait(view);
}

// Open docs re-acquire automatically via the generation bump, so a stop
// while still enabled is a restart.
export async function restartPresetSessions(presetId: string): Promise<void> {
  await stopPresetSessions(presetId);
  const store = useLspRuntimeStore.getState();
  store.clearFailed(presetId);
  store.bumpGeneration(presetId);
}

// Disabling can happen in the Settings window; sessions live here. React to
// the mirrored preference change instead of a direct call.
usePreferencesStore.subscribe((state, prev) => {
  if (state.lspActivation === prev.lspActivation) return;
  for (const managed of sessions.values()) {
    if (state.lspActivation[managed.preset.id] !== "enabled") {
      void stopPresetSessions(managed.preset.id);
    }
  }
});

// A venv override changes which binary a repo's servers resolve to. Drop the
// cached resolution and restart the affected sessions so open docs re-acquire
// against the new interpreter. Change is authored in the Settings window.
usePreferencesStore.subscribe((state, prev) => {
  if (state.lspVenvOverrides === prev.lspVenvOverrides) return;
  const changed = new Set<string>();
  for (const root of new Set([
    ...Object.keys(state.lspVenvOverrides),
    ...Object.keys(prev.lspVenvOverrides),
  ])) {
    if (state.lspVenvOverrides[root] !== prev.lspVenvOverrides[root]) {
      changed.add(root);
    }
  }
  for (const root of changed) clearResolvedBinaries(root);
  for (const managed of [...sessions.values()]) {
    // closeSession bumps the preset generation, re-acquiring open docs.
    if (changed.has(managed.root)) void closeSession(managed);
  }
});
