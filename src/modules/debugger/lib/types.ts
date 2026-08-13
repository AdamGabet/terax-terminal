/** Compact value summary produced by terax_debug.py's describe(). */
export type ValueDesc = {
  kind:
    | "tensor"
    | "ndarray"
    | "scalar"
    | "seq"
    | "map"
    | "module"
    | "obj"
    | "none"
    | "opaque";
  type?: string;
  shape?: number[];
  dtype?: string;
  device?: string;
  value?: number | string | boolean;
  len?: number;
  items?: ValueDesc[] | Record<string, ValueDesc>;
  id?: number;
  ptr?: number;
  version?: number;
  requires_grad?: boolean;
  has_grad?: boolean;
  min?: number;
  max?: number;
  mean?: number;
  std?: number;
  nonfinite?: number;
  params?: number;
  training?: boolean;
};

export type TraceHit = {
  n: number;
  t: number;
  dt: number;
  args: Record<string, ValueDesc>;
  ret: ValueDesc | null;
};

export type TraceNode = {
  key: string;
  file: string;
  line: number;
  name: string;
  count: number;
  time: number;
  args: Record<string, ValueDesc>;
  ret: ValueDesc | null;
  recent: TraceHit[];
  /** The node's file mentions torch.compile — calls inside compiled regions
   * emit no profile events, so the map may be missing children here. */
  compiled_hint?: boolean;
};

export type TraceEdge = { from: string; to: string; count: number };

export type CrashFrame = {
  file: string;
  line: number;
  func: string;
  own: boolean;
  locals?: Record<string, ValueDesc>;
};

export type TraceEvent =
  | {
      type: "run_start";
      script: string;
      python: string;
      pid: number;
      trace: boolean;
      /** Tracer hook: "monitoring" (py3.12+) or "profile". */
      backend?: string;
      seq: number;
      t: number;
    }
  | { type: "run_end"; exit_code: number; seq: number; t: number }
  | {
      type: "graph";
      nodes: TraceNode[];
      edges: TraceEdge[];
      seq: number;
      t: number;
    }
  | {
      type: "snap";
      probe: string;
      values: Record<string, ValueDesc>;
      seq: number;
      t: number;
    }
  | {
      type: "crash";
      exc_type: string;
      exc_msg: string;
      frames: CrashFrame[];
      seq: number;
      t: number;
    }
  | { type: "trace_budget_exhausted"; hits: number; seq: number; t: number };

export type ProbeKind = "break" | "trace";

export type Probe = {
  /** Stable identity: `${file}:${line}` — also the id sent to __terax_snap. */
  id: string;
  file: string;
  line: number;
  kind: ProbeKind;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  /** Tracepoint expressions to capture; empty = all locals. */
  exprs: string[];
  capture: "shape" | "stats";
  verified?: boolean;
};

// --- DAP wire subset ---

export type DapStackFrame = {
  id: number;
  name: string;
  source?: { path?: string; name?: string };
  line: number;
  column: number;
};

export type DapScope = {
  name: string;
  variablesReference: number;
  expensive?: boolean;
};

export type DapVariable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  indexedVariables?: number;
  namedVariables?: number;
};

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "ended";

export type ConsoleEntry = {
  id: number;
  kind: "stdout" | "stderr" | "input" | "result" | "error" | "info";
  text: string;
};

/** A recorded snapshot hit at a tracepoint. */
export type ProbeSnapshot = {
  probe: string;
  seq: number;
  t: number;
  values: Record<string, ValueDesc>;
};
