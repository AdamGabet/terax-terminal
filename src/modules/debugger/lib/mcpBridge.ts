/** MCP tool dispatch: executes bridged `terax:mcp-request` calls against the
 * debugger store. Pure dispatch table — unit-testable without MCP. Every
 * result must be LLM-sized: values flattened to strings, lists capped. */

import { currentWorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import {
  formatValue,
  type GraphState,
  hasNonfinite,
  shapeSignature,
} from "./graphModel";
import { getDebuggerRootOverride, getPythonOverride } from "./interpreter";
import { resolveRootForFile } from "./launch";
import { listRuns, loadRun, type RunCrash } from "./runLog";
import { normalizePythonPath, resolvePython } from "./session";
import { useDebuggerStore, waitForNextStop, waitForStatus } from "./store";
import type { DapStackFrame, Probe, ValueDesc } from "./types";

export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs) => Promise<unknown>;

const MAX_GRAPH_NODES = 200;
const MAX_VARIABLES = 100;
const MAX_STACK_FRAMES = 40;
const MAX_ANOMALIES = 50;
const VALUE_CHARS = 120;

const PROBE_TIMING_NOTE =
  "probes fire BEFORE their line executes — to capture a value, probe the line AFTER its assignment";

// --- arg coercion ---

function reqStr(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string argument: ${key}`);
  }
  return v;
}

function optStr(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function reqInt(args: ToolArgs, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`missing required integer argument: ${key}`);
  }
  return v;
}

function optInt(args: ToolArgs, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

// --- shaping helpers ---

const clip = (s: string, n = VALUE_CHARS) =>
  s.length > n ? `${s.slice(0, n)}…` : s;

function formatValues(
  values: Record<string, ValueDesc>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) out[k] = formatValue(v);
  return out;
}

function frameLocation(frame: DapStackFrame | undefined) {
  if (!frame) return null;
  return {
    function: frame.name,
    file: frame.source?.path ?? frame.source?.name ?? "?",
    line: frame.line,
  };
}

function pausedLocation() {
  const paused = useDebuggerStore.getState().paused;
  return frameLocation(paused?.frames[0]);
}

function describeProbe(p: Probe) {
  return {
    id: p.id,
    file: p.file,
    line: p.line,
    kind: p.kind === "break" ? "breakpoint" : "tracepoint",
    ...(p.condition ? { condition: p.condition } : {}),
    ...(p.hitCondition ? { hit_condition: p.hitCondition } : {}),
    ...(p.kind === "trace"
      ? { exprs: p.exprs.length ? p.exprs : "(all locals)", capture: p.capture }
      : {}),
  };
}

/** Recorded-data source: the live store, or a persisted run when `run_id`
 * is passed. Also returns a tag echoed into results so the agent can tell
 * which run it is looking at. */
async function recordedState(
  args: ToolArgs,
): Promise<{ graph: GraphState; crash: RunCrash | null; run_id?: string }> {
  const runId = optStr(args, "run_id");
  if (!runId) {
    const st = useDebuggerStore.getState();
    return { graph: st.graph, crash: st.crash };
  }
  const { graph, crash } = await loadRun(runId);
  return { graph, crash, run_id: runId };
}

function requirePaused() {
  const st = useDebuggerStore.getState();
  if (st.status !== "paused" || !st.paused) {
    throw new Error(
      `requires a paused session (status: ${st.status}) — set a breakpoint or use debug_pause`,
    );
  }
  return st.paused;
}

/** Where execution settled after a resume/step: location, end, or timeout. */
function afterStop(status: string) {
  const st = useDebuggerStore.getState();
  if (status === "paused" && st.paused) {
    return {
      status: "paused",
      reason: st.paused.reason,
      location: pausedLocation(),
    };
  }
  if (status === "ended" || status === "idle") {
    return {
      status: "ended",
      ...(st.statusDetail ? { detail: st.statusDetail } : {}),
      ...(st.crash
        ? { crashed: true, hint: "call get_crash_report for the traceback" }
        : {}),
    };
  }
  return {
    status,
    note: "still running — poll debug_status, or read query_graph/query_snapshots meanwhile",
  };
}

async function step(
  action: "resume" | "next" | "stepIn" | "stepOut",
): Promise<unknown> {
  requirePaused();
  useDebuggerStore.getState()[action]();
  return afterStop(await waitForNextStop());
}

const nonfiniteNames = (values: Record<string, ValueDesc>): string[] =>
  Object.entries(values)
    .filter(
      ([, v]) =>
        (v.nonfinite ?? 0) > 0 ||
        (v.kind === "scalar" &&
          typeof v.value === "string" &&
          (v.value === "nan" || v.value.includes("inf"))),
    )
    .map(([k]) => k);

/** Per-key shape changes between two consecutive value maps. */
function shapeChanges(
  prev: Record<string, ValueDesc>,
  cur: Record<string, ValueDesc>,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(cur)) {
    const a = shapeSignature(prev[k]);
    const b = shapeSignature(v);
    if (a && b && a !== b) out.push(`${k}: [${a}] → [${b}]`);
  }
  return out;
}

// --- tool handlers ---

export const toolHandlers: Record<string, ToolHandler> = {
  async debug_launch(args) {
    const script = reqStr(args, "script");
    const st = useDebuggerStore.getState();
    if (
      st.status === "starting" ||
      st.status === "running" ||
      st.status === "paused"
    ) {
      throw new Error(
        "a debug session is already active — stop it first (debug_stop) or in the Terax GUI",
      );
    }
    // The debuggee runs in the Terax window's active workspace — script and
    // root are paths on that workspace (local disk or the SSH host).
    const workspace = currentWorkspaceEnv();
    if (workspace.kind === "wsl") {
      throw new Error(
        "the Terax window is on a WSL workspace — debugging is not supported there yet",
      );
    }
    const explicitRoot = optStr(args, "root");
    const detectedRoot = explicitRoot ?? (await resolveRootForFile(script, workspace));
    const root = explicitRoot
      ? explicitRoot
      : (getDebuggerRootOverride(workspace, detectedRoot) ?? detectedRoot);
    // The dock's per-root interpreter pick applies to MCP launches too
    // (store.start reads the same override).
    const overridePath = getPythonOverride(workspace, root);
    const interpreter = overridePath
      ? await normalizePythonPath(overridePath, workspace)
      : await resolvePython(root, workspace);
    const scriptArgs = Array.isArray(args.args)
      ? args.args.map(String)
      : undefined;
    st.start(script, root, {
      trace: typeof args.trace === "boolean" ? args.trace : true,
      args: scriptArgs,
      detectedRoot,
    });
    const status = await waitForStatus(
      (s) => s === "running" || s === "paused" || s === "ended",
      20_000,
    );
    if (status === "ended") {
      const detail = useDebuggerStore.getState().statusDetail;
      throw new Error(`launch failed: ${detail ?? "see the debug console"}`);
    }
    return {
      ok: true,
      interpreter,
      root,
      workspace: workspaceScopeKey(workspace),
      status,
      ...(status === "paused" ? { pausedAt: pausedLocation() } : {}),
    };
  },

  async debug_stop() {
    const st = useDebuggerStore.getState();
    if (st.status === "idle" || st.status === "ended") {
      return { ok: true, note: "no active session" };
    }
    st.stop();
    const status = await waitForStatus(
      (s) => s === "ended" || s === "idle",
      10_000,
    );
    return { ok: true, status };
  },

  async debug_status() {
    const st = useDebuggerStore.getState();
    return {
      status: st.status,
      ...(st.statusDetail ? { detail: st.statusDetail } : {}),
      script: st.script,
      ...(st.status === "paused" ? { pausedAt: pausedLocation() } : {}),
      ...(st.crash
        ? { crashed: true, hint: "call get_crash_report for the traceback" }
        : {}),
      ...(st.graph.budgetExhausted
        ? { note: "trace budget exhausted — the execution map stopped growing" }
        : {}),
    };
  },

  async set_breakpoint(args) {
    const probe = useDebuggerStore
      .getState()
      .upsertProbe(reqStr(args, "file"), reqInt(args, "line"), "break", {
        condition: optStr(args, "condition"),
        hitCondition: optStr(args, "hit_condition"),
      });
    return { ok: true, probe: describeProbe(probe), note: PROBE_TIMING_NOTE };
  },

  async set_tracepoint(args) {
    const exprs = Array.isArray(args.exprs) ? args.exprs.map(String) : [];
    const capture = optStr(args, "capture");
    if (capture && capture !== "shape" && capture !== "stats") {
      throw new Error(`capture must be "shape" or "stats", got: ${capture}`);
    }
    const probe = useDebuggerStore
      .getState()
      .upsertProbe(reqStr(args, "file"), reqInt(args, "line"), "trace", {
        exprs,
        capture: (capture as "shape" | "stats") ?? "shape",
        hitCondition: optStr(args, "hit_condition"),
      });
    return {
      ok: true,
      probe: describeProbe(probe),
      note: `${PROBE_TIMING_NOTE}; NaN/Inf detection needs capture:"stats"`,
    };
  },

  async remove_probe(args) {
    const file = reqStr(args, "file");
    const line = reqInt(args, "line");
    const existed = (useDebuggerStore.getState().probes[file] ?? []).some(
      (p) => p.line === line,
    );
    useDebuggerStore.getState().removeProbe(file, line);
    return { ok: true, ...(existed ? {} : { note: "no probe was set there" }) };
  },

  async list_probes() {
    const probes = Object.values(useDebuggerStore.getState().probes)
      .flat()
      .map(describeProbe);
    return { probes };
  },

  debug_continue: () => step("resume"),
  step_over: () => step("next"),
  step_into: () => step("stepIn"),
  step_out: () => step("stepOut"),

  async debug_pause() {
    const st = useDebuggerStore.getState();
    if (st.status !== "running") {
      throw new Error(`requires a running session (status: ${st.status})`);
    }
    st.pause();
    return afterStop(await waitForNextStop());
  },

  async get_stack() {
    const paused = requirePaused();
    return {
      frames: paused.frames.slice(0, MAX_STACK_FRAMES).map((f, i) => ({
        i,
        ...frameLocation(f),
      })),
    };
  },

  async get_variables(args) {
    const paused = requirePaused();
    const index = optInt(args, "frame") ?? paused.selectedFrame;
    if (!paused.frames[index]) {
      throw new Error(
        `no frame ${index} (stack has ${paused.frames.length} frames)`,
      );
    }
    await useDebuggerStore.getState().selectFrameAndWait(index);
    const fresh = useDebuggerStore.getState().paused;
    if (!fresh) throw new Error("session resumed while fetching variables");
    const primary = fresh.scopes.find((sc) => !sc.expensive) ?? fresh.scopes[0];
    const vars = primary
      ? (fresh.variables[primary.variablesReference] ?? [])
      : [];
    return {
      frame: { i: index, ...frameLocation(fresh.frames[index]) },
      variables: vars.slice(0, MAX_VARIABLES).map((v) => ({
        name: v.name,
        ...(v.type ? { type: v.type } : {}),
        value: clip(v.value),
      })),
      ...(vars.length > MAX_VARIABLES
        ? { truncated: `${vars.length - MAX_VARIABLES} more variables hidden` }
        : {}),
    };
  },

  async evaluate(args) {
    const expression = reqStr(args, "expression");
    requirePaused();
    const result = await useDebuggerStore
      .getState()
      .evaluateForResult(expression, optInt(args, "frame"));
    return { result: clip(result, 2_000) };
  },

  async list_runs() {
    const runs = await listRuns();
    return {
      runs,
      ...(runs.length === 0
        ? { note: "no persisted runs yet — every debug run is recorded" }
        : {
            note: "pass a run id as `run_id` to query_graph/query_snapshots/find_anomalies/get_crash_report to inspect that run",
          }),
    };
  },

  async query_graph(args) {
    const src = await recordedState(args);
    const graph = src.graph;
    const all = Object.values(graph.nodes);
    const nodes = all.slice(0, MAX_GRAPH_NODES).map((n) => ({
      name: n.name,
      file: n.file,
      line: n.line,
      count: n.count,
      total_ms: Math.round(n.time * 1000 * 10) / 10,
      last_args: formatValues(n.args),
      last_ret: formatValue(n.ret),
      ...(n.compiled_hint
        ? {
            compiled_hint:
              "file uses torch.compile — calls inside compiled regions are invisible to the tracer",
          }
        : {}),
    }));
    return {
      ...(src.run_id ? { run_id: src.run_id } : {}),
      nodes,
      edges: Object.values(graph.edges).map((e) => ({
        from: e.from,
        to: e.to,
        count: e.count,
      })),
      ...(all.length > MAX_GRAPH_NODES
        ? { truncated: `${all.length - MAX_GRAPH_NODES} more nodes hidden` }
        : {}),
      ...(graph.budgetExhausted
        ? { note: "trace budget exhausted — the map stopped growing mid-run" }
        : {}),
    };
  },

  async query_snapshots(args) {
    const probeId = optStr(args, "probe_id");
    const last = optInt(args, "last") ?? 20;
    const src = await recordedState(args);
    const snapshots = src.graph.snapshots;
    const ids = probeId ? [probeId] : Object.keys(snapshots);
    const result = ids.map((id) => {
      const ring = snapshots[id] ?? [];
      const start = Math.max(0, ring.length - last);
      const rows = ring.slice(start).map((snap, i) => {
        const prev = ring[start + i - 1];
        const bad = nonfiniteNames(snap.values);
        const changed = prev ? shapeChanges(prev.values, snap.values) : [];
        return {
          seq: snap.seq,
          values: formatValues(snap.values),
          ...(bad.length ? { nonfinite: bad } : {}),
          ...(changed.length ? { shape_changed: changed } : {}),
        };
      });
      return { probe: id, total_hits: ring.length, rows };
    });
    if (result.length === 0) {
      return {
        ...(src.run_id ? { run_id: src.run_id } : {}),
        snapshots: [],
        note: "no snapshots recorded — set a tracepoint (set_tracepoint) and run",
      };
    }
    return {
      ...(src.run_id ? { run_id: src.run_id } : {}),
      snapshots: result,
    };
  },

  async find_anomalies(args) {
    const src = await recordedState(args);
    const anomalies: { where: string; hit: number; what: string }[] = [];

    for (const [id, ring] of Object.entries(src.graph.snapshots)) {
      let reportedNonfinite = false;
      for (let i = 0; i < ring.length; i++) {
        if (anomalies.length >= MAX_ANOMALIES) break;
        const snap = ring[i];
        if (!reportedNonfinite && hasNonfinite(snap.values)) {
          reportedNonfinite = true;
          anomalies.push({
            where: `tracepoint ${id}`,
            hit: i + 1,
            what: `first nonfinite values: ${nonfiniteNames(snap.values).join(", ")}`,
          });
        }
        const prev = ring[i - 1];
        if (prev) {
          for (const change of shapeChanges(prev.values, snap.values)) {
            anomalies.push({
              where: `tracepoint ${id}`,
              hit: i + 1,
              what: `shape change ${change}`,
            });
          }
        }
      }
    }

    for (const node of Object.values(src.graph.nodes)) {
      if (anomalies.length >= MAX_ANOMALIES) break;
      const where = `${node.name} (${node.file}:${node.line})`;
      let reportedNonfinite = false;
      for (let i = 0; i < node.recent.length; i++) {
        const hit = node.recent[i];
        const values = hit.ret ? { ...hit.args, ret: hit.ret } : hit.args;
        if (!reportedNonfinite && hasNonfinite(values)) {
          reportedNonfinite = true;
          anomalies.push({
            where,
            hit: hit.n,
            what: `first nonfinite values: ${nonfiniteNames(values).join(", ")}`,
          });
        }
        const prev = node.recent[i - 1];
        if (prev) {
          const prevValues = prev.ret
            ? { ...prev.args, ret: prev.ret }
            : prev.args;
          for (const change of shapeChanges(prevValues, values)) {
            anomalies.push({
              where,
              hit: hit.n,
              what: `shape change ${change}`,
            });
          }
        }
      }
    }

    if (src.crash) {
      const own = src.crash.frames.find((f) => f.own);
      anomalies.push({
        where: own ? `${own.func} (${own.file}:${own.line})` : "crash",
        hit: 0,
        what: `crash: ${src.crash.excType}: ${clip(src.crash.excMsg)}`,
      });
    }

    return {
      ...(src.run_id ? { run_id: src.run_id } : {}),
      anomalies: anomalies.slice(0, MAX_ANOMALIES),
      ...(anomalies.length === 0
        ? {
            note: 'nothing recorded looks anomalous — note that NaN/Inf in tensors is only detected at capture:"stats" (the default is "shape")',
          }
        : {}),
    };
  },

  async get_crash_report(args) {
    const src = await recordedState(args);
    const crash = src.crash;
    if (!crash) {
      return {
        ...(src.run_id ? { run_id: src.run_id } : {}),
        crash: null,
        note: "no crash recorded for this run",
      };
    }
    return {
      ...(src.run_id ? { run_id: src.run_id } : {}),
      exc_type: crash.excType,
      exc_msg: crash.excMsg,
      frames: crash.frames.map((f) => ({
        file: f.file,
        line: f.line,
        function: f.func,
        own: f.own,
        ...(f.locals ? { locals: formatValues(f.locals) } : {}),
      })),
    };
  },
};

/** Runs one bridged tool call. Exposed for McpBridge and tests. */
export async function dispatchTool(
  tool: string,
  args: ToolArgs,
): Promise<unknown> {
  const handler = toolHandlers[tool];
  if (!handler) throw new Error(`unknown tool: ${tool}`);
  return handler(args ?? {});
}
