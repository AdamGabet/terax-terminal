import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDebuggerStore } from "../lib/store";
import type { Probe } from "../lib/types";

const WIDTH = 264;

/**
 * Right-click probe editor: floats at the gutter contextmenu position and
 * edits the anchored probe's condition / hit condition / captured
 * expressions / capture level. Renders from the store's `probeEditor`
 * slice so the CodeMirror extension stays prop-free (static identity).
 */
export function ProbePopover() {
  const anchor = useDebuggerStore((s) => s.probeEditor);
  const probe = useDebuggerStore((s) =>
    anchor
      ? (s.probes[anchor.file] ?? []).find((p) => p.line === anchor.line)
      : undefined,
  );
  const setProbeEditor = useDebuggerStore((s) => s.setProbeEditor);

  // The probe can vanish under the popover (gutter click, clearProbes).
  useEffect(() => {
    if (anchor && !probe) setProbeEditor(null);
  }, [anchor, probe, setProbeEditor]);

  if (!anchor || !probe) return null;
  return (
    <ProbeForm
      key={probe.id}
      anchor={anchor}
      probe={probe}
      onClose={() => setProbeEditor(null)}
    />
  );
}

function ProbeForm({
  anchor,
  probe,
  onClose,
}: {
  anchor: { file: string; line: number; x: number; y: number };
  probe: Probe;
  onClose: () => void;
}) {
  const updateProbe = useDebuggerStore((s) => s.updateProbe);
  const removeProbe = useDebuggerStore((s) => s.removeProbe);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });

  const [condition, setCondition] = useState(probe.condition ?? "");
  const [hitCondition, setHitCondition] = useState(probe.hitCondition ?? "");
  const [exprs, setExprs] = useState(probe.exprs.join("\n"));

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setPos({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - WIDTH - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - h - 8)),
    });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const patch = (p: Partial<Probe>) => updateProbe(anchor.file, anchor.line, p);
  const commitCondition = () =>
    patch({ condition: condition.trim() || undefined });
  const commitHitCondition = () =>
    patch({ hitCondition: hitCondition.trim() || undefined });
  const commitExprs = () =>
    patch({
      exprs: exprs
        .split("\n")
        .map((e) => e.trim())
        .filter(Boolean),
    });
  const commitOnEnter =
    (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") commit();
    };

  return (
    <div
      ref={ref}
      className="fixed z-50 flex flex-col gap-2 rounded-md border border-border/60 bg-card p-2.5 shadow-lg"
      style={{ left: pos.x, top: pos.y, width: WIDTH }}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">
          {anchor.file.split("/").pop()}:{anchor.line}
        </span>
        <div className="ml-auto flex gap-0.5">
          <KindButton
            active={probe.kind === "break"}
            onClick={() => patch({ kind: "break" })}
            glyph="●"
            glyphClass="text-red-500"
            label="Break"
          />
          <KindButton
            active={probe.kind === "trace"}
            onClick={() => patch({ kind: "trace" })}
            glyph="◆"
            glyphClass="text-sky-500"
            label="Trace"
          />
        </div>
      </div>

      <Field label="Condition">
        <input
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          onBlur={commitCondition}
          onKeyDown={commitOnEnter(commitCondition)}
          placeholder="e.g. not torch.isfinite(loss)"
          className={inputClass}
          spellCheck={false}
        />
      </Field>
      <Field label="Hit condition">
        <input
          value={hitCondition}
          onChange={(e) => setHitCondition(e.target.value)}
          onBlur={commitHitCondition}
          onKeyDown={commitOnEnter(commitHitCondition)}
          placeholder="e.g. % 10  ·  >= 5"
          className={inputClass}
          spellCheck={false}
        />
      </Field>

      {probe.kind === "trace" && (
        <>
          <Field label="Expressions (one per line, empty = all locals)">
            <textarea
              value={exprs}
              onChange={(e) => setExprs(e.target.value)}
              onBlur={commitExprs}
              placeholder={"loss\nlogits.norm()"}
              rows={2}
              className={cn(inputClass, "resize-y font-mono")}
              spellCheck={false}
            />
          </Field>
          <Field label="Capture">
            <div className="flex gap-0.5">
              {(["shape", "stats"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => patch({ capture: c })}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px]",
                    probe.capture === c
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c === "shape" ? "shape" : "stats (NaN/min/max)"}
                </button>
              ))}
            </div>
          </Field>
        </>
      )}

      <div className="flex items-center justify-between border-t border-border/60 pt-1.5">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={probe.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="h-3 w-3 accent-primary"
          />
          Enabled
        </label>
        <button
          type="button"
          onClick={() => {
            removeProbe(anchor.file, anchor.line);
            onClose();
          }}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-destructive"
        >
          Delete
        </button>
      </div>
      <div className="text-[10px] leading-snug text-muted-foreground/70">
        Probes fire before this line runs — to capture <code>x = …</code>, probe
        the line after it.
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded border border-border/60 bg-background px-1.5 py-1 text-[11px] outline-none placeholder:text-muted-foreground/50 focus:border-primary/50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function KindButton({
  active,
  onClick,
  glyph,
  glyphClass,
  label,
}: {
  active: boolean;
  onClick: () => void;
  glyph: string;
  glyphClass: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className={cn("text-[9px]", glyphClass)}>{glyph}</span>
      {label}
    </button>
  );
}
