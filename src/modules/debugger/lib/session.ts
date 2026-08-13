import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import {
  getSshHome,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import tracerSource from "../python/terax_debug.py?raw";
import { DapConnection } from "./dapClient";
import { OutputDemux } from "./traceEvents";
import type {
  DapScope,
  DapStackFrame,
  DapVariable,
  Probe,
  TraceEvent,
} from "./types";

export type SessionCallbacks = {
  onStatus: (
    status: "starting" | "running" | "paused" | "ended",
    detail?: string,
  ) => void;
  onStopped: (info: {
    reason: string;
    frames: DapStackFrame[];
    threadId: number;
  }) => void;
  onTraceEvents: (events: TraceEvent[]) => void;
  onConsole: (
    kind: "stdout" | "stderr" | "info" | "error",
    text: string,
  ) => void;
};

/** One write per app run per workspace; rewrites keep it current. */
const tracerPathPromises = new Map<string, Promise<string>>();

/** Remote tracer location under the SSH user's home (pure, for tests). */
export function remoteTracerDir(
  home: string,
  platform: "posix" | "windows" = "posix",
): string {
  const separator = platform === "windows" ? "\\" : "/";
  const base =
    platform === "windows"
      ? home.replace(/\//g, "\\").replace(/[\\/]+$/, "")
      : home.replace(/[\\/]+$/, "");
  return `${base}${separator}.cache${separator}terax${separator}debug`;
}

/** Writes the tracer asset where the debuggee can read it: the local app
 * cache, or `~/.cache/terax/debug/` on the SSH host (fs ops route by the
 * `workspace` arg). */
export function ensureTracerAsset(workspace: WorkspaceEnv): Promise<string> {
  const key = workspaceScopeKey(workspace);
  let promise = tracerPathPromises.get(key);
  if (!promise) {
    promise = (async () => {
      const dir =
        workspace.kind === "ssh"
          ? remoteTracerDir(await getSshHome(workspace.host), workspace.platform)
          : await join(await appCacheDir(), "debug");
      await invoke("fs_create_dir", { path: dir, workspace }).catch(() => {});
      const path =
        workspace.kind === "ssh"
          ? `${dir}${workspace.platform === "windows" ? "\\" : "/"}terax_debug.py`
          : await join(dir, "terax_debug.py");
      await invoke("fs_write_file", { path, content: tracerSource, workspace });
      return path;
    })();
    tracerPathPromises.set(key, promise);
    // A failed write must not poison later launches (e.g. SSH reconnect).
    promise.catch(() => tracerPathPromises.delete(key));
  }
  return promise;
}

/** Interpreter candidates, most specific first. Windows venv layouts only
 * make sense locally — SSH remotes are POSIX. (Pure, for tests.) */
export function pythonCandidates(
  root: string,
  workspace: WorkspaceEnv,
): string[] {
  return [
    `${root}/.venv/bin/python`,
    `${root}/venv/bin/python`,
    ...(workspace.kind === "local"
      ? [`${root}/.venv/Scripts/python.exe`, `${root}/venv/Scripts/python.exe`]
      : workspace.kind === "ssh" && workspace.platform === "windows"
        ? [
          `${root.replace(/[\\/]+$/, "")}\\.venv\\Scripts\\python.exe`,
          `${root.replace(/[\\/]+$/, "")}\\venv\\Scripts\\python.exe`,
        ]
        : []),
  ];
}

/** Binaries a venv/interpreter *directory* might contain, in probe order. */
export function venvBinaryCandidates(dir: string): string[] {
  const d = dir.replace(/\/+$/, "");
  return [`${d}/bin/python`, `${d}/bin/python3`, `${d}/Scripts/python.exe`];
}

/** Users paste venv directories ("…/genetics/.venv") where a python binary
 * is expected; spawning a directory fails with EACCES. If `path` stats as a
 * dir, resolve to the interpreter inside it; otherwise pass through. */
export async function normalizePythonPath(
  path: string,
  workspace: WorkspaceEnv,
): Promise<string> {
  const stat = await invoke<{ kind?: string }>("fs_stat", {
    path,
    workspace,
  }).catch(() => null);
  if (stat?.kind !== "dir") return path;
  for (const p of venvBinaryCandidates(path)) {
    const s = await invoke("fs_stat", { path: p, workspace }).catch(() => null);
    if (s) return p;
  }
  return path;
}

/** The project venv's interpreter when one exists — that's where the user's
 * deps (torch, and hopefully debugpy) live — else the system python3.
 * Stats through the workspace so venv detection happens on the remote too.
 * Exported so the MCP bridge can report which interpreter a launch will use. */
export async function resolvePython(
  root: string,
  workspace: WorkspaceEnv = LOCAL_WORKSPACE,
): Promise<string> {
  for (const p of pythonCandidates(root, workspace)) {
    const stat = await invoke("fs_stat", { path: p, workspace }).catch(
      () => null,
    );
    if (stat) return p;
  }
  return workspace.kind === "ssh" && workspace.platform === "windows"
    ? "python"
    : "python3";
}

export type LaunchConfig = {
  script: string;
  root: string;
  /** Where the debuggee lives; adapter spawn + fs ops route through it. */
  workspace: WorkspaceEnv;
  python?: string;
  args?: string[];
  /** Execution-map tracing on launch. */
  trace: boolean;
  capture: "shape" | "stats";
  probes: Probe[];
  attach?: { host: string; port: number };
};

/** Debuggee import path: put the effective project root first so scripts run
 * from subdirectories can import sibling packages. */
export function debugPythonPath(root: string): string {
  return root;
}

/** Convert /proj/pkg/train.py launched from /proj into pkg.train so package
 * relative imports work under the debugger. */
export function moduleNameForScript(script: string, root: string): string | null {
  const normalizedScript = script.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/");
  const prefix = `${normalizedRoot.replace(/\/+$/, "")}/`;
  if (!normalizedScript.startsWith(prefix) || !normalizedScript.endsWith(".py"))
    return null;
  const rel = normalizedScript.slice(prefix.length, -3);
  if (!rel || rel.split("/").some((part) => !part)) return null;
  if (rel.endsWith("/__init__")) {
    return rel.slice(0, -"/__init__".length).replace(/\//g, ".");
  }
  return rel.replace(/\//g, ".");
}

function probeToDap(p: Probe): Record<string, unknown> {
  const bp: Record<string, unknown> = { line: p.line };
  if (p.condition) bp.condition = p.condition;
  if (p.hitCondition) bp.hitCondition = p.hitCondition;
  if (p.kind === "trace") {
    const kwargs =
      p.exprs.length === 0
        ? "_all=locals()"
        : p.exprs.map((e, i) => `e${i}=(${e})`).join(", ");
    bp.logMessage = `{__terax_snap(${JSON.stringify(p.id)}, ${JSON.stringify(
      p.capture,
    )}, ${kwargs})}`;
  }
  return bp;
}

export class DebugSession {
  private conn = new DapConnection();
  private demux = new OutputDemux();
  private threadId: number | null = null;
  private disposed = false;
  private configured = false;
  readonly config: LaunchConfig;
  private cb: SessionCallbacks;

  constructor(config: LaunchConfig, cb: SessionCallbacks) {
    this.config = config;
    this.cb = cb;
  }

  async launch(): Promise<void> {
    const { config } = this;
    this.cb.onStatus("starting");
    const tracerPath = config.attach
      ? null
      : await ensureTracerAsset(config.workspace);
    // normalize: saved overrides may point at a venv dir, not the binary.
    const python = config.python
      ? await normalizePythonPath(config.python, config.workspace)
      : await resolvePython(config.root, config.workspace);
    this.cb.onConsole(
      "info",
      `interpreter: ${python}${
        config.workspace.kind === "ssh" ? ` (on ${config.workspace.host})` : ""
      }\n`,
    );

    this.conn.onEvent((event, body) => this.handleEvent(event, body));
    this.conn.onExit((info) => {
      if (this.disposed) return;
      const tail = info.stderrTail.trim();
      if (info.code !== 0 && info.code !== null && tail) {
        const hint = tail.includes("No module named debugpy")
          ? `debugpy is not installed for ${python}\n→ run: uv pip install -p ${python} debugpy   (or: ${python} -m pip install debugpy)`
          : tail.slice(-400);
        this.cb.onConsole("error", `${hint}\n`);
      }
      this.end(info.reason ?? undefined);
    });

    await this.conn.start({
      command: python,
      args: ["-m", "debugpy.adapter"],
      root: config.root,
      workspace: config.workspace,
    });

    await this.conn.request("initialize", {
      clientID: "terax",
      clientName: "Terax",
      adapterID: "debugpy",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      locale: "en",
    });

    // The launch/attach response only arrives after configurationDone; the
    // breakpoint config happens inside the `initialized` event handler.
    if (config.attach) {
      await this.conn.request(
        "attach",
        {
          request: "attach",
          type: "python",
          name: "Terax Attach",
          connect: config.attach,
          justMyCode: true,
        },
        120_000,
      );
    } else {
      await this.conn.request(
        "launch",
        {
          request: "launch",
          type: "python",
          name: "Terax Debug",
          program: tracerPath,
          args: [config.script, ...(config.args ?? [])],
          cwd: config.root,
          console: "internalConsole",
          redirectOutput: true,
          justMyCode: true,
          python,
          env: {
            PYTHONPATH: debugPythonPath(config.root),
            TERAX_DEBUG_CONFIG: JSON.stringify({
              root: config.root,
              module: moduleNameForScript(config.script, config.root),
              trace: config.trace,
              capture: config.capture,
            }),
          },
        },
        120_000,
      );
    }
    if (!this.disposed) this.cb.onStatus("running");
  }

  private async handleEvent(event: string, body: unknown): Promise<void> {
    if (this.disposed) return;
    const b = (body ?? {}) as Record<string, unknown>;
    switch (event) {
      case "initialized": {
        if (this.configured) return;
        this.configured = true;
        try {
          await this.sendAllBreakpoints();
          await this.conn.request("setExceptionBreakpoints", {
            filters: ["uncaught"],
          });
          await this.conn.request("configurationDone", {});
        } catch (e) {
          this.cb.onConsole("error", `breakpoint setup failed: ${String(e)}\n`);
        }
        return;
      }
      case "output": {
        const category = (b.category as string) ?? "console";
        const text = (b.output as string) ?? "";
        if (category === "stdout" || category === "stderr") {
          const { events, console: plain } = this.demux.push(category, text);
          if (events.length) this.cb.onTraceEvents(events);
          if (plain) this.cb.onConsole(category, plain);
        } else if (category !== "telemetry") {
          // debugpy chats on "console"; keep it out of the user's face but
          // surface real errors.
          if (/error|traceback/i.test(text)) this.cb.onConsole("info", text);
        }
        return;
      }
      case "stopped": {
        const threadId = (b.threadId as number) ?? this.threadId ?? 1;
        this.threadId = threadId;
        const reason = (b.reason as string) ?? "pause";
        try {
          const st = await this.conn.request<{ stackFrames: DapStackFrame[] }>(
            "stackTrace",
            { threadId, startFrame: 0, levels: 40 },
          );
          this.cb.onStatus("paused", reason);
          this.cb.onStopped({ reason, frames: st.stackFrames ?? [], threadId });
        } catch {
          this.cb.onStatus("paused", reason);
          this.cb.onStopped({ reason, frames: [], threadId });
        }
        return;
      }
      case "continued":
        this.cb.onStatus("running");
        return;
      case "exited": {
        const code = b.exitCode as number | undefined;
        this.cb.onConsole(
          "info",
          `process exited${code != null ? ` with code ${code}` : ""}\n`,
        );
        return;
      }
      case "terminated":
        this.end();
        return;
      default:
    }
  }

  private probesByFile(): Map<string, Probe[]> {
    const map = new Map<string, Probe[]>();
    for (const p of this.config.probes) {
      if (!p.enabled) continue;
      const list = map.get(p.file) ?? [];
      list.push(p);
      map.set(p.file, list);
    }
    return map;
  }

  private syncedFiles = new Set<string>();

  private async sendAllBreakpoints(): Promise<void> {
    const byFile = this.probesByFile();
    for (const file of byFile.keys()) this.syncedFiles.add(file);
    await Promise.all(
      [...byFile.entries()].map(([file, probes]) =>
        this.conn.request("setBreakpoints", {
          source: { path: file },
          breakpoints: probes.map(probeToDap),
        }),
      ),
    );
  }

  /** Re-syncs one file's probes mid-session (gutter edits while running). */
  async updateBreakpoints(file: string, probes: Probe[]): Promise<void> {
    this.config.probes = [
      ...this.config.probes.filter((p) => p.file !== file),
      ...probes,
    ];
    if (!this.configured || this.disposed) return;
    const active = probes.filter((p) => p.enabled);
    if (active.length === 0 && !this.syncedFiles.has(file)) return;
    this.syncedFiles.add(file);
    await this.conn
      .request("setBreakpoints", {
        source: { path: file },
        breakpoints: active.map(probeToDap),
      })
      .catch(() => {});
  }

  // --- execution control ---

  async continue_(): Promise<void> {
    if (this.threadId == null) return;
    await this.conn.request("continue", { threadId: this.threadId });
    this.cb.onStatus("running");
  }

  async next(): Promise<void> {
    if (this.threadId == null) return;
    await this.conn.request("next", { threadId: this.threadId });
  }

  async stepIn(): Promise<void> {
    if (this.threadId == null) return;
    await this.conn.request("stepIn", { threadId: this.threadId });
  }

  async stepOut(): Promise<void> {
    if (this.threadId == null) return;
    await this.conn.request("stepOut", { threadId: this.threadId });
  }

  async pause(): Promise<void> {
    const threads = await this.conn.request<{
      threads: { id: number; name: string }[];
    }>("threads");
    const id = this.threadId ?? threads.threads[0]?.id;
    if (id != null) await this.conn.request("pause", { threadId: id });
  }

  // --- inspection ---

  async scopes(frameId: number): Promise<DapScope[]> {
    const r = await this.conn.request<{ scopes: DapScope[] }>("scopes", {
      frameId,
    });
    return r.scopes ?? [];
  }

  async variables(variablesReference: number): Promise<DapVariable[]> {
    const r = await this.conn.request<{ variables: DapVariable[] }>(
      "variables",
      { variablesReference },
    );
    return r.variables ?? [];
  }

  async evaluate(
    expression: string,
    frameId?: number,
  ): Promise<{ result: string; variablesReference: number }> {
    return await this.conn.request("evaluate", {
      expression,
      frameId,
      context: "repl",
    });
  }

  async stop(): Promise<void> {
    try {
      await this.conn.request("terminate", {}, 3_000);
    } catch {
      try {
        await this.conn.request(
          "disconnect",
          { terminateDebuggee: true },
          3_000,
        );
      } catch {
        // adapter already gone
      }
    }
    this.end();
  }

  private end(detail?: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cb.onStatus("ended", detail);
    this.conn.close();
  }
}
