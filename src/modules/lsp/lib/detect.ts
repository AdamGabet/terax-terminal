import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useLspRuntimeStore } from "./runtimeStore";

const pending = new Map<string, Promise<string | null>>();

export function detectBinary(command: string): Promise<string | null> {
  const cached = useLspRuntimeStore.getState().detected[command];
  if (cached !== undefined) return Promise.resolve(cached);
  let p = pending.get(command);
  if (!p) {
    p = invoke<string | null>("lsp_detect", { command })
      .catch(() => null)
      .then((path) => {
        pending.delete(command);
        useLspRuntimeStore.getState().setDetected(command, path);
        return path;
      });
    pending.set(command, p);
  }
  return p;
}

export function redetectBinary(command: string): Promise<string | null> {
  pending.delete(command);
  useLspRuntimeStore.getState().clearDetected(command);
  return detectBinary(command);
}

const resolveCache = new Map<string, Promise<string | null>>();
const SEP = "\u0000";

function resolveKey(
  command: string,
  root: string | null,
  venv: string | null,
  scope: string,
): string {
  return `${command}${SEP}${scope}${SEP}${root ?? ""}${SEP}${venv ?? ""}`;
}

/** Resolve the absolute binary a server will actually spawn, preferring a
 * repo-level `.venv`/`venv` under `root` (or the explicit `venv` override) over
 * PATH. This is what makes pyright/ruff installed only inside a project venv
 * discoverable. `root`/`venv` may be null (falls back to PATH). On an SSH
 * `workspace` the probe runs on the remote host. Negative results aren't
 * cached, so a venv created after the first check is picked up on the next
 * open. */
export function resolveServerBinary(
  command: string,
  root: string | null,
  venv: string | null,
  workspace?: WorkspaceEnv,
): Promise<string | null> {
  const scope = workspace ? workspaceScopeKey(workspace) : "local";
  const key = resolveKey(command, root, venv, scope);
  let p = resolveCache.get(key);
  if (!p) {
    p = invoke<string | null>("lsp_detect", {
      command,
      root: root ?? null,
      venv: venv ?? null,
      workspace: workspace ?? null,
    })
      .catch(() => null)
      .then((path) => {
        if (path === null) resolveCache.delete(key);
        return path;
      });
    resolveCache.set(key, p);
  }
  return p;
}

/** Drop cached resolutions so the next spawn re-probes the filesystem. Pass a
 * `root` to invalidate only that repo (e.g. after its venv override changed). */
export function clearResolvedBinaries(root?: string): void {
  if (root === undefined) {
    resolveCache.clear();
    return;
  }
  const marker = `${SEP}${root}${SEP}`;
  for (const key of resolveCache.keys()) {
    if (key.includes(marker)) resolveCache.delete(key);
  }
}
