import { describe, expect, it } from "vitest";
import {
  applyTraceEvents,
  emptyGraph,
  formatValue,
  hasNonfinite,
  layoutGraph,
  shapeSignature,
} from "./graphModel";
import { OutputDemux, TERAX_PREFIX } from "./traceEvents";
import type { TraceEdge, TraceEvent, TraceNode } from "./types";

const node = (key: string, over: Partial<TraceNode> = {}): TraceNode => ({
  key,
  file: "/p/train.py",
  line: 1,
  name: key.split(":").pop() ?? key,
  count: 1,
  time: 0.1,
  args: {},
  ret: null,
  recent: [],
  ...over,
});

const graphEvent = (
  nodes: TraceNode[],
  edges: TraceEdge[] = [],
): TraceEvent => ({ type: "graph", nodes, edges, seq: 1, t: 0 });

describe("applyTraceEvents", () => {
  it("merges graph deltas by node key", () => {
    let g = emptyGraph();
    g = applyTraceEvents(g, [graphEvent([node("a:f", { count: 1 })])]);
    g = applyTraceEvents(g, [graphEvent([node("a:f", { count: 5 })])]);
    expect(Object.keys(g.nodes)).toEqual(["a:f"]);
    expect(g.nodes["a:f"].count).toBe(5);
  });

  it("keeps snapshot ring per probe and marks budget exhaustion", () => {
    let g = emptyGraph();
    g = applyTraceEvents(g, [
      { type: "snap", probe: "p1", values: {}, seq: 1, t: 0.1 },
      { type: "snap", probe: "p1", values: {}, seq: 2, t: 0.2 },
      { type: "trace_budget_exhausted", hits: 9, seq: 3, t: 0.3 },
    ]);
    expect(g.snapshots.p1).toHaveLength(2);
    expect(g.budgetExhausted).toBe(true);
  });

  it("returns the same reference when nothing changed", () => {
    const g = emptyGraph();
    expect(applyTraceEvents(g, [])).toBe(g);
  });
});

describe("layoutGraph", () => {
  it("layers by call depth", () => {
    const nodes = {
      "a:main": node("a:main"),
      "a:step": node("a:step"),
      "a:loss": node("a:loss"),
    };
    const edges = {
      e1: { from: "a:main", to: "a:step", count: 4 },
      e2: { from: "a:step", to: "a:loss", count: 4 },
    };
    const layout = layoutGraph(nodes, edges);
    const colOf = Object.fromEntries(
      layout.nodes.map((n) => [n.node.key, n.col]),
    );
    expect(colOf["a:main"]).toBe(0);
    expect(colOf["a:step"]).toBe(1);
    expect(colOf["a:loss"]).toBe(2);
    expect(layout.cols).toBe(3);
  });

  it("survives recursion by flagging back-edges", () => {
    const nodes = { "a:f": node("a:f"), "a:g": node("a:g") };
    const edges = {
      e1: { from: "a:f", to: "a:g", count: 2 },
      e2: { from: "a:g", to: "a:f", count: 1 },
      self: { from: "a:f", to: "a:f", count: 3 },
    };
    const layout = layoutGraph(nodes, edges);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges.filter((e) => e.backEdge)).toHaveLength(2);
  });
});

describe("display helpers", () => {
  it("formats tensors with shape, dtype and device", () => {
    expect(
      formatValue({
        kind: "tensor",
        shape: [32, 512],
        dtype: "float32",
        device: "cuda:0",
      }),
    ).toBe("[32×512] float32 cuda:0");
  });

  it("tracks shape signatures for change detection", () => {
    expect(shapeSignature({ kind: "tensor", shape: [32, 512] })).toBe("32×512");
    expect(shapeSignature({ kind: "tensor", shape: [7, 512] })).not.toBe(
      shapeSignature({ kind: "tensor", shape: [32, 512] }),
    );
  });

  it("detects nonfinite values including stringified NaN scalars", () => {
    expect(
      hasNonfinite({ loss: { kind: "scalar", type: "float", value: "nan" } }),
    ).toBe(true);
    expect(
      hasNonfinite({ x: { kind: "tensor", shape: [2], nonfinite: 3 } }),
    ).toBe(true);
    expect(
      hasNonfinite({ x: { kind: "tensor", shape: [2], nonfinite: 0 } }),
    ).toBe(false);
  });
});

describe("OutputDemux", () => {
  it("separates tracer lines from program output", () => {
    const demux = new OutputDemux();
    const { events, console } = demux.push(
      "stderr",
      `${TERAX_PREFIX}{"type":"run_start","script":"s","python":"3.12","pid":1,"trace":true,"seq":1,"t":0}\nplain error\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run_start");
    expect(console).toBe("plain error\n");
  });

  it("reassembles tracer lines split across chunks", () => {
    const demux = new OutputDemux();
    const line = `${TERAX_PREFIX}{"type":"run_end","exit_code":0,"seq":9,"t":1}\n`;
    const first = demux.push("stderr", line.slice(0, 30));
    expect(first.events).toHaveLength(0);
    const second = demux.push("stderr", line.slice(30));
    expect(second.events).toHaveLength(1);
    expect(second.events[0].type).toBe("run_end");
  });

  it("keeps output glued in front of a tracer line", () => {
    const demux = new OutputDemux();
    const { events, console } = demux.push(
      "stderr",
      `warning${TERAX_PREFIX}{"type":"run_end","exit_code":0,"seq":2,"t":1}\n`,
    );
    expect(events).toHaveLength(1);
    expect(console).toBe("warning\n");
  });

  it("buffers partial lines per category independently", () => {
    const demux = new OutputDemux();
    demux.push("stdout", "partial");
    const err = demux.push("stderr", "other\n");
    expect(err.console).toBe("other\n");
    const out = demux.push("stdout", " done\n");
    expect(out.console).toBe("partial done\n");
  });
});
