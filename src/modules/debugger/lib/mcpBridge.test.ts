import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: vi.fn(async () => "/tmp"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("@/modules/workspace", () => ({ LOCAL_WORKSPACE: "local" }));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { invoke } from "@tauri-apps/api/core";
import { emptyGraph } from "./graphModel";
import { dispatchTool } from "./mcpBridge";
import { useDebuggerStore } from "./store";
import type { ProbeSnapshot, TraceNode, ValueDesc } from "./types";

const tensor = (shape: number[], nonfinite = 0): ValueDesc => ({
  kind: "tensor",
  shape,
  dtype: "float32",
  device: "cpu",
  ...(nonfinite ? { nonfinite } : {}),
});

const snap = (
  probe: string,
  seq: number,
  values: Record<string, ValueDesc>,
): ProbeSnapshot => ({ probe, seq, t: seq, values });

const node = (name: string, over: Partial<TraceNode> = {}): TraceNode => ({
  key: `/p/train.py:1:${name}`,
  file: "/p/train.py",
  line: 1,
  name,
  count: 1,
  time: 0.0123,
  args: {},
  ret: null,
  recent: [],
  ...over,
});

function resetStore() {
  useDebuggerStore.setState({
    probes: {},
    status: "idle",
    statusDetail: null,
    script: null,
    graph: emptyGraph(),
    paused: null,
    crash: null,
    console: [],
  });
}

function pauseAt(file: string, line: number, fn = "train_step") {
  useDebuggerStore.setState({
    status: "paused",
    paused: {
      reason: "breakpoint",
      threadId: 1,
      frames: [
        { id: 10, name: fn, source: { path: file }, line, column: 1 },
        { id: 11, name: "main", source: { path: file }, line: 99, column: 1 },
      ],
      selectedFrame: 0,
      scopes: [],
      variables: {},
      described: {},
    },
  });
}

beforeEach(resetStore);

describe("dispatchTool", () => {
  it("rejects unknown tools", async () => {
    await expect(dispatchTool("bogus", {})).rejects.toThrow("unknown tool");
  });

  it("validates required arguments", async () => {
    await expect(dispatchTool("set_breakpoint", {})).rejects.toThrow(
      "missing required string argument: file",
    );
    await expect(
      dispatchTool("set_breakpoint", { file: "/p/a.py", line: "3" }),
    ).rejects.toThrow("missing required integer argument: line");
  });
});

describe("probes", () => {
  it("set_breakpoint is idempotent (no toggle-off on repeat)", async () => {
    await dispatchTool("set_breakpoint", { file: "/p/a.py", line: 3 });
    await dispatchTool("set_breakpoint", { file: "/p/a.py", line: 3 });
    const probes = useDebuggerStore.getState().probes["/p/a.py"];
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ kind: "break", line: 3, enabled: true });
  });

  it("set_tracepoint upserts over a breakpoint and keeps config", async () => {
    await dispatchTool("set_breakpoint", {
      file: "/p/a.py",
      line: 3,
      condition: "x > 0",
    });
    const result = (await dispatchTool("set_tracepoint", {
      file: "/p/a.py",
      line: 3,
      exprs: ["loss"],
      capture: "stats",
    })) as { probe: { kind: string }; note: string };
    const probes = useDebuggerStore.getState().probes["/p/a.py"];
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      kind: "trace",
      exprs: ["loss"],
      capture: "stats",
    });
    expect(result.probe.kind).toBe("tracepoint");
    expect(result.note).toContain("BEFORE");
  });

  it("rejects a bad capture level", async () => {
    await expect(
      dispatchTool("set_tracepoint", {
        file: "/p/a.py",
        line: 3,
        capture: "sample",
      }),
    ).rejects.toThrow("capture must be");
  });

  it("remove_probe + list_probes round-trip", async () => {
    await dispatchTool("set_breakpoint", { file: "/p/a.py", line: 3 });
    await dispatchTool("set_tracepoint", { file: "/p/b.py", line: 7 });
    let listed = (await dispatchTool("list_probes", {})) as {
      probes: unknown[];
    };
    expect(listed.probes).toHaveLength(2);
    await dispatchTool("remove_probe", { file: "/p/a.py", line: 3 });
    listed = (await dispatchTool("list_probes", {})) as { probes: unknown[] };
    expect(listed.probes).toHaveLength(1);
    const missing = (await dispatchTool("remove_probe", {
      file: "/p/a.py",
      line: 3,
    })) as { note?: string };
    expect(missing.note).toContain("no probe");
  });
});

describe("session state guards", () => {
  it("debug_status reports idle", async () => {
    const status = (await dispatchTool("debug_status", {})) as {
      status: string;
    };
    expect(status.status).toBe("idle");
  });

  it("execution tools require a paused session", async () => {
    for (const tool of [
      "debug_continue",
      "step_over",
      "step_into",
      "step_out",
    ]) {
      await expect(dispatchTool(tool, {})).rejects.toThrow(
        "requires a paused session",
      );
    }
    await expect(dispatchTool("debug_pause", {})).rejects.toThrow(
      "requires a running session",
    );
  });

  it("debug_launch refuses when a session is active", async () => {
    useDebuggerStore.setState({ status: "running" });
    await expect(
      dispatchTool("debug_launch", { script: "/p/train.py" }),
    ).rejects.toThrow("already active");
  });

  it("debug_stop without a session is a no-op", async () => {
    const result = (await dispatchTool("debug_stop", {})) as { note?: string };
    expect(result.note).toContain("no active session");
  });
});

describe("paused inspection", () => {
  it("get_stack maps frames with indices", async () => {
    pauseAt("/p/train.py", 42);
    const stack = (await dispatchTool("get_stack", {})) as {
      frames: { i: number; function: string; file: string; line: number }[];
    };
    expect(stack.frames).toEqual([
      { i: 0, function: "train_step", file: "/p/train.py", line: 42 },
      { i: 1, function: "main", file: "/p/train.py", line: 99 },
    ]);
  });

  it("get_variables validates the frame index", async () => {
    pauseAt("/p/train.py", 42);
    await expect(dispatchTool("get_variables", { frame: 5 })).rejects.toThrow(
      "no frame 5",
    );
  });

  it("debug_status includes the paused location", async () => {
    pauseAt("/p/train.py", 42);
    const status = (await dispatchTool("debug_status", {})) as {
      status: string;
      pausedAt: { file: string; line: number };
    };
    expect(status.status).toBe("paused");
    expect(status.pausedAt).toMatchObject({ file: "/p/train.py", line: 42 });
  });
});

describe("recorded data", () => {
  it("query_graph flattens values to strings and converts time to ms", async () => {
    const graph = emptyGraph();
    graph.nodes.a = node("train_step", {
      args: { x: tensor([32, 512]) },
      ret: tensor([32, 10]),
    });
    graph.edges["a b"] = { from: "a", to: "b", count: 5 };
    useDebuggerStore.setState({ graph });
    const result = (await dispatchTool("query_graph", {})) as {
      nodes: {
        name: string;
        total_ms: number;
        last_args: Record<string, string>;
        last_ret: string;
      }[];
      edges: { from: string; to: string; count: number }[];
    };
    expect(result.nodes[0].total_ms).toBe(12.3);
    expect(result.nodes[0].last_args.x).toBe("[32×512] float32");
    expect(result.nodes[0].last_ret).toBe("[32×10] float32");
    expect(result.edges).toEqual([{ from: "a", to: "b", count: 5 }]);
  });

  it("query_snapshots flags nonfinite and shape changes", async () => {
    const graph = emptyGraph();
    graph.snapshots["/p/a.py:3"] = [
      snap("/p/a.py:3", 1, { loss: tensor([32]) }),
      snap("/p/a.py:3", 2, { loss: tensor([16]) }),
      snap("/p/a.py:3", 3, { loss: tensor([16], 2) }),
    ];
    useDebuggerStore.setState({ graph });
    const result = (await dispatchTool("query_snapshots", {})) as {
      snapshots: {
        probe: string;
        rows: {
          seq: number;
          nonfinite?: string[];
          shape_changed?: string[];
        }[];
      }[];
    };
    const rows = result.snapshots[0].rows;
    expect(rows[0].nonfinite).toBeUndefined();
    expect(rows[1].shape_changed).toEqual(["loss: [32] → [16]"]);
    expect(rows[2].nonfinite).toEqual(["loss"]);
  });

  it("query_snapshots respects `last` against the full ring", async () => {
    const graph = emptyGraph();
    graph.snapshots.p = [
      snap("p", 1, { x: tensor([8]) }),
      snap("p", 2, { x: tensor([4]) }),
      snap("p", 3, { x: tensor([4]) }),
    ];
    useDebuggerStore.setState({ graph });
    const result = (await dispatchTool("query_snapshots", { last: 2 })) as {
      snapshots: {
        total_hits: number;
        rows: { seq: number; shape_changed?: string[] }[];
      }[];
    };
    expect(result.snapshots[0].total_hits).toBe(3);
    expect(result.snapshots[0].rows.map((r) => r.seq)).toEqual([2, 3]);
    // Row seq=2's predecessor (seq=1) is outside the slice but must still count.
    expect(result.snapshots[0].rows[0].shape_changed).toEqual(["x: [8] → [4]"]);
  });

  it("find_anomalies reports first nonfinite, shape changes, and the crash", async () => {
    const graph = emptyGraph();
    graph.snapshots["/p/a.py:3"] = [
      snap("/p/a.py:3", 1, { loss: tensor([32]) }),
      snap("/p/a.py:3", 2, { loss: tensor([32], 1) }),
      snap("/p/a.py:3", 3, { loss: tensor([16], 1) }),
    ];
    graph.nodes.a = node("train_step", {
      recent: [
        { n: 1, t: 0, dt: 1, args: { x: tensor([8]) }, ret: tensor([8]) },
        { n: 2, t: 1, dt: 1, args: { x: tensor([8]) }, ret: tensor([8], 3) },
      ],
    });
    useDebuggerStore.setState({
      graph,
      crash: {
        excType: "RuntimeError",
        excMsg: "boom",
        frames: [{ file: "/p/a.py", line: 3, func: "train_step", own: true }],
      },
    });
    const result = (await dispatchTool("find_anomalies", {})) as {
      anomalies: { where: string; hit: number; what: string }[];
    };
    const whats = result.anomalies.map((a) => `${a.where} | ${a.what}`);
    expect(whats).toContainEqual(
      "tracepoint /p/a.py:3 | first nonfinite values: loss",
    );
    expect(whats).toContainEqual(
      "tracepoint /p/a.py:3 | shape change loss: [32] → [16]",
    );
    expect(whats).toContainEqual(
      "train_step (/p/train.py:1) | first nonfinite values: ret",
    );
    expect(whats).toContainEqual(
      "train_step (/p/a.py:3) | crash: RuntimeError: boom".replace(
        "train_step (/p/a.py:3)",
        "train_step (/p/a.py:3)",
      ),
    );
  });

  it("find_anomalies notes the stats requirement when clean", async () => {
    const result = (await dispatchTool("find_anomalies", {})) as {
      anomalies: unknown[];
      note: string;
    };
    expect(result.anomalies).toHaveLength(0);
    expect(result.note).toContain('capture:"stats"');
  });

  it("query_graph surfaces the compiled_hint badge", async () => {
    const graph = emptyGraph();
    graph.nodes.a = node("fwd", { compiled_hint: true });
    useDebuggerStore.setState({ graph });
    const result = (await dispatchTool("query_graph", {})) as {
      nodes: { compiled_hint?: string }[];
    };
    expect(result.nodes[0].compiled_hint).toContain("torch.compile");
  });

  it("get_crash_report formats locals and handles absence", async () => {
    let report = (await dispatchTool("get_crash_report", {})) as {
      crash: null;
    };
    expect(report.crash).toBeNull();
    useDebuggerStore.setState({
      crash: {
        excType: "ValueError",
        excMsg: "bad shape",
        frames: [
          {
            file: "/p/a.py",
            line: 9,
            func: "f",
            own: true,
            locals: { x: tensor([2, 3]) },
          },
        ],
      },
    });
    report = (await dispatchTool("get_crash_report", {})) as never;
    expect(report).toMatchObject({
      exc_type: "ValueError",
      frames: [
        {
          file: "/p/a.py",
          line: 9,
          function: "f",
          locals: { x: "[2×3] float32" },
        },
      ],
    });
  });
});

describe("run persistence", () => {
  const runId = "2026-07-11T12-00-00-000Z-train";
  const runLines = `${[
    JSON.stringify({
      type: "run_start",
      script: "/p/train.py",
      python: "3.12.11",
      pid: 1,
      trace: true,
      seq: 1,
      t: 0,
    }),
    JSON.stringify({
      type: "graph",
      nodes: [node("train_step", { ret: tensor([32, 10]) })],
      edges: [{ from: "a", to: "b", count: 2 }],
      seq: 2,
      t: 1,
    }),
    JSON.stringify({
      type: "snap",
      probe: "/p/a.py:3",
      values: { loss: tensor([32], 1) },
      seq: 3,
      t: 2,
    }),
    JSON.stringify({
      type: "crash",
      exc_type: "RuntimeError",
      exc_msg: "boom",
      frames: [{ file: "/p/train.py", line: 5, func: "train_step", own: true }],
      seq: 4,
      t: 3,
    }),
    JSON.stringify({ type: "run_end", exit_code: 1, seq: 5, t: 4 }),
  ].join("\n")}\n`;

  function mockRunFs() {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const path = (args as { path?: string } | undefined)?.path ?? "";
      if (cmd === "fs_read_dir") {
        return [
          { name: `${runId}.jsonl`, kind: "file" },
          { name: "index.json", kind: "file" },
        ];
      }
      if (cmd === "fs_read_file" && path.endsWith("index.json")) {
        return {
          kind: "text",
          content: JSON.stringify([
            {
              id: runId,
              script: "/p/train.py",
              time: "2026-07-11T12:00:00Z",
              crashed: true,
              nodes: 1,
              snaps: 1,
            },
          ]),
        };
      }
      if (cmd === "fs_read_file" && path.endsWith(`${runId}.jsonl`)) {
        return { kind: "text", content: runLines };
      }
      if (cmd === "fs_read_file") throw new Error("no such file");
      return null;
    });
  }

  afterEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("list_runs merges the index with the runs directory", async () => {
    mockRunFs();
    const result = (await dispatchTool("list_runs", {})) as {
      runs: { id: string; script?: string; crashed?: boolean }[];
      note: string;
    };
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      id: runId,
      script: "/p/train.py",
      crashed: true,
    });
    expect(result.note).toContain("run_id");
  });

  it("query_graph replays a persisted run via run_id", async () => {
    mockRunFs();
    const result = (await dispatchTool("query_graph", {
      run_id: runId,
    })) as {
      run_id: string;
      nodes: { name: string; last_ret: string }[];
      edges: { count: number }[];
    };
    expect(result.run_id).toBe(runId);
    expect(result.nodes[0].name).toBe("train_step");
    expect(result.nodes[0].last_ret).toBe("[32×10] float32");
    expect(result.edges[0].count).toBe(2);
  });

  it("find_anomalies over a run sees its snapshots and crash", async () => {
    mockRunFs();
    const result = (await dispatchTool("find_anomalies", {
      run_id: runId,
    })) as { run_id: string; anomalies: { what: string }[] };
    expect(result.run_id).toBe(runId);
    const whats = result.anomalies.map((a) => a.what);
    expect(whats).toContainEqual("first nonfinite values: loss");
    expect(whats).toContainEqual("crash: RuntimeError: boom");
  });

  it("get_crash_report over a run reads the persisted crash", async () => {
    mockRunFs();
    const result = (await dispatchTool("get_crash_report", {
      run_id: runId,
    })) as { exc_type: string };
    expect(result.exc_type).toBe("RuntimeError");
  });

  it("rejects an unknown run id with a hint", async () => {
    mockRunFs();
    await expect(
      dispatchTool("query_graph", { run_id: "nope" }),
    ).rejects.toThrow("list_runs");
  });

  it("rejects run ids with path characters", async () => {
    await expect(
      dispatchTool("query_graph", { run_id: "../etc/passwd" }),
    ).rejects.toThrow("invalid run id");
  });
});
