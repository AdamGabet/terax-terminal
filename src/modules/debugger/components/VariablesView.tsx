import { cn } from "@/lib/utils";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useDebuggerStore } from "../lib/store";
import type { DapVariable, ValueDesc } from "../lib/types";
import { ValueBadge } from "./ValueBadge";

/** Right slot: live frame variables when paused; otherwise the inspector for
 * the selected graph node (its last hits) or the crash report. */
export function VariablesView() {
  const paused = useDebuggerStore((s) => s.paused);
  if (paused) return <PausedVariables />;
  return <RecordedInspector />;
}

// --- paused: real DAP variable tree ---

function PausedVariables() {
  const paused = useDebuggerStore((s) => s.paused);
  if (!paused) return null;
  const scopes = paused.scopes;
  if (scopes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading variables…
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto px-1 py-1">
      {scopes.map((scope, i) => (
        <ScopeBlock
          key={scope.variablesReference}
          name={scope.name}
          variablesReference={scope.variablesReference}
          defaultOpen={i === 0}
          // Shape summaries only exist for the frame's own locals.
          described={i === 0 ? paused.described : undefined}
        />
      ))}
    </div>
  );
}

function ScopeBlock({
  name,
  variablesReference,
  defaultOpen,
  described,
}: {
  name: string;
  variablesReference: number;
  defaultOpen: boolean;
  described?: Record<string, ValueDesc>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const fetchChildren = useDebuggerStore((s) => s.fetchChildren);
  const vars = useDebuggerStore((s) => s.paused?.variables[variablesReference]);
  if (open && !vars) fetchChildren(variablesReference);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent/50"
      >
        <HugeiconsIcon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          size={12}
        />
        {name}
      </button>
      {open &&
        (vars ?? []).map((v) => (
          <VariableRow
            key={`${variablesReference}:${v.name}`}
            v={v}
            depth={1}
            desc={described?.[v.name]}
          />
        ))}
    </div>
  );
}

/** Kinds whose shape/len summary adds info the DAP repr hides. */
function summaryDesc(desc: ValueDesc | undefined): ValueDesc | undefined {
  if (!desc) return undefined;
  return desc.kind === "tensor" ||
    desc.kind === "ndarray" ||
    desc.kind === "seq" ||
    desc.kind === "map" ||
    desc.kind === "module"
    ? desc
    : undefined;
}

function VariableRow({
  v,
  depth,
  desc,
}: {
  v: DapVariable;
  depth: number;
  desc?: ValueDesc;
}) {
  const [open, setOpen] = useState(false);
  const fetchChildren = useDebuggerStore((s) => s.fetchChildren);
  const children = useDebuggerStore(
    (s) => s.paused?.variables[v.variablesReference],
  );
  const expandable = v.variablesReference > 0;
  const toggle = () => {
    if (!expandable) return;
    if (!open) fetchChildren(v.variablesReference);
    setOpen((o) => !o);
  };
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent/50",
          !expandable && "cursor-default",
        )}
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="w-3 shrink-0 text-muted-foreground">
          {expandable && (
            <HugeiconsIcon
              icon={open ? ArrowDown01Icon : ArrowRight01Icon}
              size={12}
            />
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-foreground">
          {v.name}
        </span>
        {v.type ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
            {v.type}
          </span>
        ) : null}
        {summaryDesc(desc) ? (
          <ValueBadge desc={desc} className="shrink-0" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
          {v.value}
        </span>
      </button>
      {open &&
        (children ?? []).map((c) => (
          <VariableRow
            key={`${v.variablesReference}:${c.name}`}
            v={c}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

// --- not paused: recorded data for the selected node / crash ---

function RecordedInspector() {
  const selectedKey = useDebuggerStore((s) => s.selectedNodeKey);
  const node = useDebuggerStore((s) =>
    s.selectedNodeKey ? s.graph.nodes[s.selectedNodeKey] : undefined,
  );
  const crash = useDebuggerStore((s) => s.crash);
  const status = useDebuggerStore((s) => s.status);

  if (node) {
    return (
      <div className="h-full overflow-auto px-2 py-1.5">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-[11px] font-medium text-foreground">
            {node.name}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {node.count} call{node.count === 1 ? "" : "s"} ·{" "}
            {(node.time * 1000).toFixed(1)}ms total
          </span>
        </div>
        <ValueTable title="last args" values={node.args} />
        {node.ret ? (
          <div className="mt-1.5">
            <SectionLabel>returns</SectionLabel>
            <div className="flex items-center justify-between gap-2 px-1 py-0.5">
              <span className="font-mono text-[11px] text-muted-foreground">
                →
              </span>
              <ValueBadge desc={node.ret} />
            </div>
          </div>
        ) : null}
        {node.recent.length > 1 && (
          <div className="mt-1.5">
            <SectionLabel>recent calls</SectionLabel>
            {[...node.recent].reverse().map((hit) => (
              <div
                key={hit.n}
                className="flex items-center justify-between gap-2 border-b border-border/30 px-1 py-0.5 last:border-0"
              >
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  #{hit.n}
                </span>
                <span className="min-w-0 flex-1 truncate text-right">
                  {hit.ret ? <ValueBadge desc={hit.ret} /> : null}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {(hit.dt * 1000).toFixed(1)}ms
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (crash) {
    return (
      <div className="h-full overflow-auto px-2 py-1.5">
        <div className="mb-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
          {crash.excType}: {crash.excMsg}
        </div>
        {[...crash.frames].reverse().map((f, i) =>
          f.own ? (
            <div key={`${f.file}:${f.line}:${i}`} className="mb-1.5">
              <SectionLabel>
                {f.func} — {f.file.split("/").pop()}:{f.line}
              </SectionLabel>
              <ValueTable title={null} values={f.locals ?? {}} />
            </div>
          ) : null,
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {status === "running"
        ? "Click a node in the map to inspect its captured calls."
        : selectedKey
          ? "Node no longer in the map."
          : "Variables appear here at a breakpoint — or click a map node."}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

function ValueTable({
  title,
  values,
}: {
  title: string | null;
  values: Record<string, ValueDesc>;
}) {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  return (
    <div>
      {title && <SectionLabel>{title}</SectionLabel>}
      {entries.map(([name, desc]) => (
        <div
          key={name}
          className="flex items-center justify-between gap-2 px-1 py-0.5"
        >
          <span className="shrink-0 font-mono text-[11px] text-foreground">
            {name}
          </span>
          <ValueBadge desc={desc} className="truncate" />
        </div>
      ))}
    </div>
  );
}
