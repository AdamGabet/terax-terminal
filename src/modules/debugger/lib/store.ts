import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { quoteShellArg } from "@/lib/shellQuote";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { applyTraceEvents, emptyGraph, type GraphState } from "./graphModel";
import { getPythonOverride } from "./interpreter";
import { pruneRuns, RunLogWriter } from "./runLog";
import {
  debugPythonPath,
  DebugSession,
  ensureTracerAsset,
  moduleNameForScript,
  resolvePython,
  type LaunchConfig,
} from "./session";
import type {
  ConsoleEntry,
  CrashFrame,
  DapScope,
  DapStackFrame,
  DapVariable,
  Probe,
  ProbeKind,
  SessionStatus,
  TraceEvent,
  ValueDesc,
} from "./types";

export type LeftView = "graph" | "frames" | "console";
export type RightView = "variables" | "console";

/** Anchor for the probe config popover (opened from the editor gutter). */
export type ProbeEditorAnchor = {
  file: string;
  line: number;
  x: number;
  y: number;
};

type PausedState = {
  reason: string;
  threadId: number;
  frames: DapStackFrame[];
  selectedFrame: number;
  scopes: DapScope[];
  /** variablesReference -> children (lazily fetched). */
  variables: Record<number, DapVariable[]>;
  /** Tensor/seq summaries of the selected frame's locals, via
   * __terax_describe in the debuggee — DAP reprs don't carry shapes. */
  described: Record<string, ValueDesc>;
};

type CrashInfo = { excType: string; excMsg: string; frames: CrashFrame[] };

type DebuggerState = {
  probes: Record<string, Probe[]>;
  status: SessionStatus;
  statusDetail: string | null;
  script: string | null;
  /** Effective root + workspace of the last (or current) run, for the dock UI. */
  root: string | null;
  /** Auto-detected root before any debugger override was applied. */
  detectedRoot: string | null;
  runWorkspace: WorkspaceEnv | null;
  graph: GraphState;
  paused: PausedState | null;
  crash: CrashInfo | null;
  console: ConsoleEntry[];
  dockOpen: boolean;
  leftView: LeftView;
  rightView: RightView;
  selectedNodeKey: string | null;
  /** Bumped on run start so views can reset scroll/selection. */
  runId: number;
  probeEditor: ProbeEditorAnchor | null;

  toggleProbe: (file: string, line: number, kind: ProbeKind) => void;
  updateProbe: (file: string, line: number, patch: Partial<Probe>) => void;
  /** Idempotent add-or-update — never removes (toggle semantics are wrong
   * for agents; calling set_breakpoint twice must not delete it). */
  upsertProbe: (
    file: string,
    line: number,
    kind: ProbeKind,
    patch?: Partial<Probe>,
  ) => Probe;
  removeProbe: (file: string, line: number) => void;
  clearProbes: (file: string) => void;
  /** Applies editor-driven line moves ([from, to][]) and deletions in one
   * shot, then live-resyncs the file's breakpoints. */
  remapProbes: (
    file: string,
    moves: [number, number][],
    dropped: number[],
  ) => void;
  setProbeEditor: (anchor: ProbeEditorAnchor | null) => void;
  prepare: (
    script: string,
    root: string,
    opts?: { detectedRoot?: string },
  ) => void;
  start: (
    script: string,
    root: string,
    opts?: {
      trace?: boolean;
      args?: string[];
      detectedRoot?: string;
      attach?: { host: string; port: number };
      preserveConsole?: boolean;
      consoleMessage?: string;
    },
  ) => void;
  startPrepared: (opts?: { trace?: boolean; args?: string[] }) => void;
  attach: (host: string, port: number) => void;
  startSlurmPrepared: (opts: SlurmDebugOptions) => void;
  stop: () => void;
  resume: () => void;
  next: () => void;
  stepIn: () => void;
  stepOut: () => void;
  pause: () => void;
  selectFrame: (index: number) => void;
  /** selectFrame that resolves once scopes + primary variables are fetched. */
  selectFrameAndWait: (index: number) => Promise<void>;
  fetchChildren: (variablesReference: number) => void;
  evaluate: (expression: string) => void;
  /** evaluate that returns the result (and mirrors it to the console). */
  evaluateForResult: (
    expression: string,
    frameIndex?: number,
  ) => Promise<string>;
  selectNode: (key: string | null) => void;
  setLeftView: (v: LeftView) => void;
  setRightView: (v: RightView) => void;
  setDockOpen: (open: boolean) => void;
};

let session: DebugSession | null = null;
let runLog: RunLogWriter | null = null;
let slurmHandle: number | null = null;
let consoleId = 1;

export type SlurmDebugOptions = {
  partition: string;
  gpu: string;
  cpu: number;
  mem: string;
  port: number;
  args?: string[];
};

export function defaultSlurmDebugOptions(): SlurmDebugOptions {
  return { partition: "long.q", gpu: "L40S:1", cpu: 6, mem: "48gb", port: 5678 };
}

const probeId = (file: string, line: number) => `${file}:${line}`;

function appendConsole(
  entries: ConsoleEntry[],
  kind: ConsoleEntry["kind"],
  text: string,
): ConsoleEntry[] {
  const next = [...entries, { id: consoleId++, kind, text }];
  return next.length > 2000 ? next.slice(next.length - 2000) : next;
}

async function waitForLocalPort(
  workspace: WorkspaceEnv,
  port: number,
  timeoutMs = 15 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await invoke<{ exit_code: number | null }>("shell_run_command", {
      command: `python3 -c "import socket; s=socket.create_connection(('127.0.0.1', ${port}), 1); s.close()"`,
      cwd: null,
      timeoutSecs: 3,
      workspace,
    }).catch(() => null);
    if (out?.exit_code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for debugpy on localhost:${port}`);
}

async function pollBackgroundLogs(
  handle: number,
  append: (text: string) => void,
  shouldStop: () => boolean,
): Promise<void> {
  let offset = 0;
  while (!shouldStop()) {
    const logs = await invoke<{
      bytes: string;
      next_offset: number;
      exited: boolean;
      exit_code: number | null;
    }>("shell_bg_logs", { handle, sinceOffset: offset }).catch(() => null);
    if (!logs) return;
    offset = logs.next_offset;
    if (logs.bytes) append(logs.bytes);
    if (logs.exited) {
      append(`Slurm launcher exited${logs.exit_code != null ? ` (${logs.exit_code})` : ""}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export const useDebuggerStore = create<DebuggerState>((set, get) => {
  const closeRunLog = () => {
    const log = runLog;
    runLog = null;
    if (!log) return;
    const st = get();
    log.close({
      crashed: st.crash != null,
      nodes: Object.keys(st.graph.nodes).length,
      snaps: Object.values(st.graph.snapshots).reduce(
        (a, ring) => a + ring.length,
        0,
      ),
    });
  };

  const withSession = (fn: (s: DebugSession) => Promise<void>) => {
    const s = session;
    if (!s) return;
    void fn(s).catch((e) => {
      set((st) => ({
        console: appendConsole(st.console, "error", `${String(e)}\n`),
      }));
    });
  };

  const syncFileToSession = (file: string) => {
    const s = session;
    if (!s) return;
    void s.updateBreakpoints(file, get().probes[file] ?? []);
  };

  // One evaluate per frame selection describes every local (shape-level)
  // through the tracer's builtin. Base64 round-trip because DAP returns the
  // repr of the string — unescaping repr is fragile, base64 is not.
  const DESCRIBE_LOCALS_EXPR =
    "__import__('base64').b64encode(__import__('json').dumps(" +
    "{k: __terax_describe(v, 'shape') for k, v in list(locals().items())[:80]" +
    " if not k.startswith('_')}).encode()).decode()";

  const fetchDescribedLocals = async (
    s: DebugSession,
    frameId: number,
    index: number,
  ) => {
    try {
      const { result } = await s.evaluate(DESCRIBE_LOCALS_EXPR, frameId);
      const described = JSON.parse(
        atob(result.replace(/^['"]|['"]$/g, "")),
      ) as Record<string, ValueDesc>;
      set((st) =>
        st.paused && st.paused.selectedFrame === index
          ? { paused: { ...st.paused, described } }
          : {},
      );
    } catch {
      // tracer builtins absent (attach without bootstrap) or eval failed —
      // rows just show the plain DAP reprs.
    }
  };

  const selectFrameInner = async (index: number) => {
    const s = session;
    const paused = get().paused;
    if (!s || !paused) return;
    const frame = paused.frames[index];
    if (!frame) return;
    const scopes = await s.scopes(frame.id).catch(() => [] as DapScope[]);
    const variables: Record<number, DapVariable[]> = {};
    const primary = scopes.find((sc) => !sc.expensive) ?? scopes[0];
    if (primary) {
      variables[primary.variablesReference] = await s
        .variables(primary.variablesReference)
        .catch(() => []);
    }
    set((st) =>
      st.paused
        ? {
            paused: {
              ...st.paused,
              selectedFrame: index,
              scopes,
              variables,
              described: {},
            },
          }
        : {},
    );
    void fetchDescribedLocals(s, frame.id, index);
  };

  return {
    probes: {},
    status: "idle",
    statusDetail: null,
    script: null,
    root: null,
    detectedRoot: null,
    runWorkspace: null,
    graph: emptyGraph(),
    paused: null,
    crash: null,
    console: [],
    dockOpen: false,
    leftView: "graph",
    rightView: "variables",
    selectedNodeKey: null,
    runId: 0,
    probeEditor: null,

    toggleProbe: (file, line, kind) => {
      set((st) => {
        const list = st.probes[file] ?? [];
        const existing = list.find((p) => p.line === line);
        let next: Probe[];
        if (existing && existing.kind === kind) {
          next = list.filter((p) => p.line !== line);
        } else if (existing) {
          next = list.map((p) => (p.line === line ? { ...p, kind } : p));
        } else {
          next = [
            ...list,
            {
              id: probeId(file, line),
              file,
              line,
              kind,
              enabled: true,
              exprs: [],
              capture: "shape",
            },
          ];
        }
        return { probes: { ...st.probes, [file]: next } };
      });
      syncFileToSession(file);
    },

    upsertProbe: (file, line, kind, patch) => {
      let result!: Probe;
      set((st) => {
        const list = st.probes[file] ?? [];
        const existing = list.find((p) => p.line === line);
        const base: Probe = existing ?? {
          id: probeId(file, line),
          file,
          line,
          kind,
          enabled: true,
          exprs: [],
          capture: "shape",
        };
        result = { ...base, ...patch, kind, enabled: true };
        return {
          probes: {
            ...st.probes,
            [file]: existing
              ? list.map((p) => (p.line === line ? result : p))
              : [...list, result],
          },
        };
      });
      syncFileToSession(file);
      return result;
    },

    removeProbe: (file, line) => {
      set((st) => ({
        probes: {
          ...st.probes,
          [file]: (st.probes[file] ?? []).filter((p) => p.line !== line),
        },
      }));
      syncFileToSession(file);
    },

    updateProbe: (file, line, patch) => {
      set((st) => ({
        probes: {
          ...st.probes,
          [file]: (st.probes[file] ?? []).map((p) =>
            p.line === line ? { ...p, ...patch } : p,
          ),
        },
      }));
      syncFileToSession(file);
    },

    clearProbes: (file) => {
      set((st) => ({ probes: { ...st.probes, [file]: [] } }));
      syncFileToSession(file);
    },

    remapProbes: (file, moves, dropped) => {
      if (moves.length === 0 && dropped.length === 0) return;
      const moveMap = new Map(moves);
      const drop = new Set(dropped);
      set((st) => {
        const list = st.probes[file] ?? [];
        const next: Probe[] = [];
        for (const p of list) {
          if (drop.has(p.line)) continue;
          const to = moveMap.get(p.line);
          next.push(to == null ? p : { ...p, line: to, id: probeId(file, to) });
        }
        let editor = st.probeEditor;
        if (editor?.file === file) {
          if (drop.has(editor.line)) editor = null;
          else {
            const to = moveMap.get(editor.line);
            if (to != null) editor = { ...editor, line: to };
          }
        }
        return { probes: { ...st.probes, [file]: next }, probeEditor: editor };
      });
      syncFileToSession(file);
    },

    setProbeEditor: (anchor) => set({ probeEditor: anchor }),

    prepare: (script, root, opts) => {
      set({
        status: "idle",
        statusDetail: null,
        script,
        root,
        detectedRoot: opts?.detectedRoot ?? root,
        runWorkspace: currentWorkspaceEnv(),
        dockOpen: true,
        console: [],
      });
    },

    start: (script, root, opts) => {
      if (session) {
        toast.warning("A debug session is already running");
        return;
      }
      const allProbes = Object.values(get().probes).flat();
      // The debuggee lives wherever this window is pointed right now.
      const workspace = currentWorkspaceEnv();
      const config: LaunchConfig = {
        script,
        root,
        workspace,
        // Dock-picked interpreter for this root, if any; else auto-resolve.
        python: getPythonOverride(workspace, root) ?? undefined,
        args: opts?.args,
        trace: opts?.trace ?? true,
        capture: "shape",
        probes: allProbes,
        attach: opts?.attach,
      };
      set((st) => ({
        status: "starting",
        statusDetail: null,
        script,
        root,
        detectedRoot: opts?.detectedRoot ?? root,
        runWorkspace: workspace,
        graph: emptyGraph(),
        paused: null,
        crash: null,
        console: appendConsole(
          opts?.preserveConsole ? st.console : [],
          "info",
          opts?.consoleMessage ?? `debugging ${script}\n`,
        ),
        dockOpen: true,
        selectedNodeKey: null,
        runId: st.runId + 1,
      }));

      // Persist the run's raw event stream; prune old logs while at it.
      runLog = new RunLogWriter(script);
      void pruneRuns().catch(() => {});

      const s = new DebugSession(config, {
        onStatus: (status, detail) => {
          if (status === "ended") {
            session = null;
            set((st) => ({
              status: "ended",
              statusDetail: detail ?? null,
              paused: null,
              // Dying during startup means the error is in the console
              // (missing debugpy, bad interpreter) — put it in view.
              ...(st.status === "starting" ? { rightView: "console" } : {}),
            }));
            closeRunLog();
            return;
          }
          set({
            status,
            statusDetail: detail ?? null,
            ...(status !== "paused" ? { paused: null } : {}),
          });
        },
        onStopped: ({ reason, frames, threadId }) => {
          set({
            paused: {
              reason,
              threadId,
              frames,
              selectedFrame: 0,
              scopes: [],
              variables: {},
              described: {},
            },
          });
          void selectFrameInner(0);
        },
        onTraceEvents: (events: TraceEvent[]) => {
          runLog?.push(events);
          set((st) => {
            const patch: Partial<DebuggerState> = {
              graph: applyTraceEvents(st.graph, events),
            };
            const crash = events.find((e) => e.type === "crash");
            if (crash && crash.type === "crash") {
              patch.crash = {
                excType: crash.exc_type,
                excMsg: crash.exc_msg,
                frames: crash.frames,
              };
              patch.console = appendConsole(
                st.console,
                "error",
                `${crash.exc_type}: ${crash.exc_msg}\n`,
              );
            }
            return patch;
          });
        },
        onConsole: (kind, text) => {
          set((st) => ({ console: appendConsole(st.console, kind, text) }));
        },
      });
      session = s;
      void s.launch().catch((e) => {
        session = null;
        set((st) => ({
          status: "ended",
          statusDetail: String(e),
          console: appendConsole(st.console, "error", `${String(e)}\n`),
          rightView: "console",
        }));
        closeRunLog();
      });
    },

    startPrepared: (opts) => {
      const st = get();
      if (!st.script || !st.root) return;
      st.start(st.script, st.root, {
        ...opts,
        detectedRoot: st.detectedRoot ?? st.root,
      });
    },

    attach: (host, port) => {
      const st = get();
      if (!st.script || !st.root) return;
      st.start(st.script, st.root, {
        detectedRoot: st.detectedRoot ?? st.root,
        attach: { host, port },
        preserveConsole: true,
        consoleMessage: `attaching to debugpy at ${host}:${port}\n`,
      });
    },

    startSlurmPrepared: (opts) => {
      const st = get();
      if (!st.script || !st.root) return;
      if (session) {
        toast.warning("A debug session is already running");
        return;
      }
      const workspace = st.runWorkspace ?? currentWorkspaceEnv();
      const script = st.script;
      const root = st.root;
      set((cur) => ({
        status: "starting",
        statusDetail: "waiting for Slurm allocation",
        dockOpen: true,
        rightView: "console",
        console: appendConsole(
          cur.console,
          "info",
          `starting Slurm GPU tunnel on localhost:${opts.port}\n`,
        ),
      }));
      void (async () => {
        const tracerPath = await ensureTracerAsset(workspace);
        const python = getPythonOverride(workspace, root) ?? (await resolvePython(root, workspace));
        const envJson = JSON.stringify({
          root,
          module: moduleNameForScript(script, root),
          trace: true,
          capture: "shape",
        });
        const args = (opts.args ?? [])
          .map((arg) => quoteShellArg(arg, false))
          .join(" ");
        const gpuScript = [
          `cd ${quoteShellArg(root, false)} || exit 1`,
          `export PYTHONPATH=${quoteShellArg(debugPythonPath(root), false)}${"${PYTHONPATH:+:$PYTHONPATH}"}`,
          `export TERAX_DEBUG_CONFIG=${quoteShellArg(envJson, false)}`,
          `echo TERAX_GPU_NODE=$(hostname)`,
          `echo TERAX_DEBUGPY_PORT=${opts.port}`,
          `${quoteShellArg(python, false)} -m debugpy --listen 127.0.0.1:${opts.port} --wait-for-client ${quoteShellArg(tracerPath, false)} ${quoteShellArg(script, false)}${args ? ` ${args}` : ""} &`,
          `debug_pid=$!`,
          `ssh -N -R ${opts.port}:127.0.0.1:${opts.port} adamgab@mcluster11 &`,
          `tunnel_pid=$!`,
          `wait $debug_pid`,
          `kill $tunnel_pid 2>/dev/null || true`,
        ].join("\n");
        const mclusterScript = [
          "exec srun",
          "--job-name terax-debug",
          "--output /home/adamgab/slurm-terax-%j.out",
          "--error /home/adamgab/slurm-terax-%j.err",
          `--mem ${quoteShellArg(opts.mem, false)}`,
          `--cpus-per-task ${opts.cpu}`,
          `-p ${quoteShellArg(opts.partition, false)}`,
          `--gres=gpu:${quoteShellArg(opts.gpu, false)}`,
          "/bin/bash -s <<'TERAX_GPU'",
          gpuScript,
          "TERAX_GPU",
        ].join("\n");
        const command = `ssh -L ${opts.port}:127.0.0.1:${opts.port} adamgab@mcluster11 bash -s <<'TERAX_MCLUSTER'\n${mclusterScript}\nTERAX_MCLUSTER`;
        slurmHandle = await invoke<number>("shell_bg_spawn", {
          command,
          cwd: root,
          workspace,
        });
        let attached = false;
        void pollBackgroundLogs(
          slurmHandle,
          (text) => {
            set((cur) => ({ console: appendConsole(cur.console, "info", text) }));
          },
          () => attached || slurmHandle == null,
        );
        set((cur) => ({
          console: appendConsole(
            cur.console,
            "info",
            `Slurm launcher handle ${slurmHandle}; waiting for debugpy…\n`,
          ),
        }));
        await waitForLocalPort(workspace, opts.port);
        attached = true;
        get().attach("127.0.0.1", opts.port);
      })().catch((e) => {
        set((cur) => ({
          status: "ended",
          statusDetail: String(e),
          console: appendConsole(cur.console, "error", `${String(e)}\n`),
        }));
      });
    },

    stop: () => {
      if (slurmHandle != null) {
        void invoke("shell_bg_kill", { handle: slurmHandle }).catch(() => {});
        slurmHandle = null;
      }
      withSession((s) => s.stop());
      if (!session) set({ status: "ended", statusDetail: "stopped" });
    },
    resume: () => withSession((s) => s.continue_()),
    next: () => withSession((s) => s.next()),
    stepIn: () => withSession((s) => s.stepIn()),
    stepOut: () => withSession((s) => s.stepOut()),
    pause: () => withSession((s) => s.pause()),

    selectFrame: (index) => void selectFrameInner(index),

    selectFrameAndWait: (index) => selectFrameInner(index),

    fetchChildren: (variablesReference) => {
      const s = session;
      if (!s || variablesReference <= 0) return;
      if (get().paused?.variables[variablesReference]) return;
      void s
        .variables(variablesReference)
        .then((vars) => {
          set((st) =>
            st.paused
              ? {
                  paused: {
                    ...st.paused,
                    variables: {
                      ...st.paused.variables,
                      [variablesReference]: vars,
                    },
                  },
                }
              : {},
          );
        })
        .catch(() => {});
    },

    evaluate: (expression) => {
      const s = session;
      if (!s) return;
      const st = get();
      const frameId = st.paused?.frames[st.paused.selectedFrame]?.id;
      set((cur) => ({
        console: appendConsole(cur.console, "input", `${expression}\n`),
      }));
      void s
        .evaluate(expression, frameId)
        .then(({ result }) => {
          set((cur) => ({
            console: appendConsole(cur.console, "result", `${result}\n`),
          }));
        })
        .catch((e) => {
          set((cur) => ({
            console: appendConsole(
              cur.console,
              "error",
              `${(e as Error).message ?? String(e)}\n`,
            ),
          }));
        });
    },

    evaluateForResult: async (expression, frameIndex) => {
      const s = session;
      if (!s) throw new Error("no active debug session");
      const paused = get().paused;
      const frameId =
        paused?.frames[frameIndex ?? paused.selectedFrame ?? 0]?.id;
      set((cur) => ({
        console: appendConsole(cur.console, "input", `${expression}\n`),
      }));
      try {
        const { result } = await s.evaluate(expression, frameId);
        set((cur) => ({
          console: appendConsole(cur.console, "result", `${result}\n`),
        }));
        return result;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        set((cur) => ({
          console: appendConsole(cur.console, "error", `${msg}\n`),
        }));
        throw new Error(msg);
      }
    },

    selectNode: (key) => set({ selectedNodeKey: key }),
    setLeftView: (v) => set({ leftView: v }),
    setRightView: (v) => set({ rightView: v }),
    setDockOpen: (open) => set({ dockOpen: open }),
  };
});

/** Probes for a file, for the editor gutter. */
export function probesForFile(file: string): Probe[] {
  return useDebuggerStore.getState().probes[file] ?? [];
}

/** Resolves once the status satisfies `pred`; on timeout resolves with the
 * current status anyway (callers report it rather than hang). */
export function waitForStatus(
  pred: (status: SessionStatus) => boolean,
  timeoutMs = 15_000,
): Promise<SessionStatus> {
  if (pred(useDebuggerStore.getState().status)) {
    return Promise.resolve(useDebuggerStore.getState().status);
  }
  return new Promise((resolve) => {
    let cleanup = () => {};
    const unsub = useDebuggerStore.subscribe((st) => {
      if (pred(st.status)) {
        cleanup();
        resolve(st.status);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      resolve(useDebuggerStore.getState().status);
    }, timeoutMs);
    cleanup = () => {
      unsub();
      clearTimeout(timer);
    };
  });
}

/** Resolves on the next stop (a NEW paused state — the `stopped` event may
 * beat the step/continue response, so the store, not DAP, is the source of
 * truth) or when the run ends. Timeout resolves with the current status. */
export function waitForNextStop(timeoutMs = 10_000): Promise<SessionStatus> {
  const initialPaused = useDebuggerStore.getState().paused;
  return new Promise((resolve) => {
    let cleanup = () => {};
    const check = (st: { status: SessionStatus; paused: unknown }): boolean => {
      if (
        st.status === "ended" ||
        st.status === "idle" ||
        (st.status === "paused" &&
          st.paused !== null &&
          st.paused !== initialPaused)
      ) {
        cleanup();
        resolve(st.status);
        return true;
      }
      return false;
    };
    const unsub = useDebuggerStore.subscribe((st) => void check(st));
    const timer = setTimeout(() => {
      cleanup();
      resolve(useDebuggerStore.getState().status);
    }, timeoutMs);
    cleanup = () => {
      unsub();
      clearTimeout(timer);
    };
    check(useDebuggerStore.getState());
  });
}
