import { cn } from "@/lib/utils";
import { useMemo } from "react";
import {
  layoutGraph,
  shapeSignature,
  type LaidOutNode,
} from "../lib/graphModel";
import { useDebuggerStore } from "../lib/store";
import type { TraceNode } from "../lib/types";

// Node boxes deliberately narrower than the column: the gap is where edges
// and their ×count labels live — without it they vanish behind the boxes.
const COL_W = 200;
const ROW_H = 60;
const NODE_W = 148;
const NODE_H = 44;
const PAD = 16;

function nodeAnomaly(node: TraceNode): "nonfinite" | "shape" | null {
  const recent = node.recent;
  const last = recent[recent.length - 1];
  if (last) {
    const values = [
      ...Object.values(last.args),
      ...(last.ret ? [last.ret] : []),
    ];
    if (
      values.some(
        (v) =>
          (v.nonfinite ?? 0) > 0 ||
          (v.kind === "scalar" &&
            typeof v.value === "string" &&
            (v.value === "nan" || v.value.includes("inf"))),
      )
    ) {
      return "nonfinite";
    }
  }
  if (recent.length >= 2) {
    const prev = recent[recent.length - 2];
    const changed = (a: typeof prev.args, b: typeof prev.args) =>
      Object.keys(a).some(
        (k) => k in b && shapeSignature(a[k]) !== shapeSignature(b[k]),
      );
    const lastHit = recent[recent.length - 1];
    if (
      changed(prev.args, lastHit.args) ||
      (prev.ret &&
        lastHit.ret &&
        shapeSignature(prev.ret) !== shapeSignature(lastHit.ret))
    ) {
      return "shape";
    }
  }
  return null;
}

function retLabel(node: TraceNode): string {
  if (!node.ret) return "";
  const sig = shapeSignature(node.ret);
  if (node.ret.kind === "tensor" || node.ret.kind === "ndarray") {
    return `[${(node.ret.shape ?? []).join("×")}]`;
  }
  if (node.ret.kind === "scalar") {
    return typeof node.ret.value === "number"
      ? Number.isInteger(node.ret.value)
        ? String(node.ret.value)
        : node.ret.value.toPrecision(3)
      : String(node.ret.value);
  }
  return sig ? `(${sig})` : "";
}

const pos = (n: LaidOutNode) => ({
  x: PAD + n.col * COL_W,
  y: PAD + n.row * ROW_H,
});

/**
 * The execution map: functions the run actually passed through, layered by
 * call depth, growing live as tracer deltas stream in.
 */
export function GraphView() {
  const graph = useDebuggerStore((s) => s.graph);
  const selectedKey = useDebuggerStore((s) => s.selectedNodeKey);
  const selectNode = useDebuggerStore((s) => s.selectNode);
  const status = useDebuggerStore((s) => s.status);

  const layout = useMemo(
    () => layoutGraph(graph.nodes, graph.edges),
    [graph.nodes, graph.edges],
  );
  const byKey = useMemo(
    () => new Map(layout.nodes.map((n) => [n.node.key, n])),
    [layout],
  );

  if (layout.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {status === "running" || status === "starting"
          ? "Waiting for calls… the map draws itself as your code runs."
          : "Run a debug session to build the execution map."}
      </div>
    );
  }

  const width = PAD * 2 + layout.cols * COL_W;
  const height = PAD * 2 + layout.rows * ROW_H;

  return (
    <div className="relative h-full overflow-auto">
      {graph.budgetExhausted && (
        <div className="sticky top-0 z-10 border-b border-border/60 bg-card/90 px-3 py-1 text-[11px] text-amber-500">
          Trace budget exhausted — map is frozen; program keeps running.
        </div>
      )}
      <svg
        width={width}
        height={height}
        className="block"
        role="img"
        aria-label="Execution map"
      >
        <g>
          {layout.edges.map((e) => {
            const from = byKey.get(e.from);
            const to = byKey.get(e.to);
            if (!from || !to) return null;
            const a = pos(from);
            const b = pos(to);
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            const d = e.backEdge
              ? `M ${a.x + NODE_W / 2} ${a.y} C ${a.x + NODE_W / 2} ${a.y - 24}, ${b.x + NODE_W / 2} ${b.y - 24}, ${b.x + NODE_W / 2} ${b.y}`
              : `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
            return (
              <g key={`${e.from}->${e.to}`}>
                <path
                  d={d}
                  fill="none"
                  className="stroke-muted-foreground/50"
                  strokeWidth={Math.min(
                    1.2 + Math.log2(e.count + 1) * 0.6,
                    3.5,
                  )}
                  strokeDasharray={e.backEdge ? "4 3" : undefined}
                />
                {e.count > 1 && !e.backEdge && (
                  <text
                    x={mid}
                    y={(y1 + y2) / 2 - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[9px]"
                  >
                    ×{e.count}
                  </text>
                )}
              </g>
            );
          })}
        </g>
        <g>
          {layout.nodes.map((n) => {
            const p = pos(n);
            const anomaly = nodeAnomaly(n.node);
            const selected = n.node.key === selectedKey;
            const ret = retLabel(n.node);
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: svg node grid
              <g
                key={n.node.key}
                transform={`translate(${p.x}, ${p.y})`}
                onClick={() => selectNode(selected ? null : n.node.key)}
                className="cursor-pointer"
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  className={cn(
                    "fill-card stroke-border transition-[stroke]",
                    anomaly === "nonfinite" && "stroke-destructive",
                    anomaly === "shape" && "stroke-amber-500",
                    selected && "stroke-primary",
                  )}
                  strokeWidth={selected || anomaly ? 1.6 : 1}
                />
                <text
                  x={9}
                  y={18}
                  className="fill-foreground text-[11px] font-medium"
                >
                  {n.node.name.length > 17
                    ? `${n.node.name.slice(0, 16)}…`
                    : n.node.name}
                </text>
                <text
                  x={9}
                  y={34}
                  className={cn(
                    "font-mono text-[10px]",
                    anomaly === "nonfinite"
                      ? "fill-destructive"
                      : "fill-muted-foreground",
                  )}
                >
                  {ret.length > 14 ? `${ret.slice(0, 13)}…` : ret}
                </text>
                <text
                  x={NODE_W - 7}
                  y={18}
                  textAnchor="end"
                  className="fill-muted-foreground font-mono text-[10px]"
                >
                  ×{n.node.count}
                </text>
                <text
                  x={NODE_W - 7}
                  y={34}
                  textAnchor="end"
                  className="fill-muted-foreground/70 font-mono text-[9px]"
                >
                  {n.node.time >= 0.0005
                    ? `${(n.node.time * 1000).toFixed(0)}ms`
                    : ""}
                </text>
                {n.node.compiled_hint && (
                  <g transform={`translate(${NODE_W - 14}, -6)`}>
                    <title>
                      compiled region — calls inside it are invisible to the
                      tracer
                    </title>
                    <circle
                      cx={6}
                      cy={6}
                      r={7}
                      className="fill-card stroke-violet-500"
                    />
                    <text
                      x={6}
                      y={9}
                      textAnchor="middle"
                      className="fill-violet-500 text-[8px] font-semibold"
                    >
                      ⚡
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
