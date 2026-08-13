import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  FlowchartIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  discoverInterpreters,
  displayPython,
  getDebuggerRootOverride,
  getPythonOverride,
  setDebuggerRootOverride,
  setPythonOverride,
} from "../lib/interpreter";
import { normalizePythonPath } from "../lib/session";
import {
  defaultSlurmDebugOptions,
  type LeftView,
  useDebuggerStore,
} from "../lib/store";
import { ConsoleView } from "./ConsoleView";
import { FramesView } from "./FramesView";
import { GraphView } from "./GraphView";
import { VariablesView } from "./VariablesView";

const MIN_H = 140;
const MAX_H_RATIO = 0.7;
const DEFAULT_H = 300;

type Props = {
  onOpenSource?: (path: string, line: number) => void;
};

/**
 * The debugger's bottom dock: a header with run controls and the frame
 * breadcrumb, above two independently switchable slots —
 * left: execution map ⇄ frames, right: variables ⇄ console.
 */
export function DebugDock({ onOpenSource }: Props) {
  const dockOpen = useDebuggerStore((s) => s.dockOpen);
  const paused = useDebuggerStore((s) => s.paused);
  const [height, setHeight] = useState(DEFAULT_H);
  const dragState = useRef<{ startY: number; startH: number } | null>(null);

  // Follow the debugger: open the selected frame's source when execution
  // pauses or the user picks another frame. Deduped so variable fetches
  // (which also replace the paused object) don't re-steal the cursor.
  const lastNav = useRef("");
  const frame = paused?.frames[paused.selectedFrame];
  useEffect(() => {
    if (!paused) {
      lastNav.current = "";
      return;
    }
    const path = frame?.source?.path;
    if (!path) return;
    const key = `${frame.id}:${frame.line}`;
    if (key === lastNav.current) return;
    lastNav.current = key;
    onOpenSource?.(path, frame.line);
  }, [paused, frame, onOpenSource]);

  const onHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragState.current = { startY: e.clientY, startH: height };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [height],
  );
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    const maxH = window.innerHeight * MAX_H_RATIO;
    setHeight(
      Math.min(maxH, Math.max(MIN_H, drag.startH + (drag.startY - e.clientY))),
    );
  }, []);
  const onHandleUp = useCallback(() => {
    dragState.current = null;
  }, []);

  if (!dockOpen) return null;

  return (
    <div
      className="flex min-h-0 shrink-0 flex-col border-t border-border/60 bg-card"
      style={{ height }}
    >
      <div
        className="h-1 shrink-0 cursor-row-resize hover:bg-primary/40"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
      />
      <DockHeader />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="debug-left" defaultSize="55%" minSize="20%">
          <LeftSlot onOpenSource={onOpenSource} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="debug-right" defaultSize="45%" minSize="20%">
          <RightSlot />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function LeftSlot({ onOpenSource }: Props) {
  const leftView = useDebuggerStore((s) => s.leftView);
  const setLeftView = useDebuggerStore((s) => s.setLeftView);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SlotHeader
        options={[
          { id: "graph", label: "Map" },
          { id: "frames", label: "Frames" },
          // Console on the left too → Variables + Console side by side.
          { id: "console", label: "Console" },
        ]}
        active={leftView}
        onSelect={(v) => setLeftView(v as LeftView)}
      />
      <div className="min-h-0 flex-1">
        {leftView === "graph" ? (
          <GraphView />
        ) : leftView === "frames" ? (
          <FramesView onOpenSource={onOpenSource} />
        ) : (
          <ConsoleView />
        )}
      </div>
    </div>
  );
}

function RightSlot() {
  const rightView = useDebuggerStore((s) => s.rightView);
  const setRightView = useDebuggerStore((s) => s.setRightView);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SlotHeader
        options={[
          { id: "variables", label: "Variables" },
          { id: "console", label: "Console" },
        ]}
        active={rightView}
        onSelect={(v) => setRightView(v as "variables" | "console")}
      />
      <div className="min-h-0 flex-1">
        {rightView === "variables" ? <VariablesView /> : <ConsoleView />}
      </div>
    </div>
  );
}

function SlotHeader({
  options,
  active,
  onSelect,
}: {
  options: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onSelect(o.id)}
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px]",
            o.id === active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function DockHeader() {
  const status = useDebuggerStore((s) => s.status);
  const statusDetail = useDebuggerStore((s) => s.statusDetail);
  const script = useDebuggerStore((s) => s.script);
  const paused = useDebuggerStore((s) => s.paused);
  const resume = useDebuggerStore((s) => s.resume);
  const next = useDebuggerStore((s) => s.next);
  const stepIn = useDebuggerStore((s) => s.stepIn);
  const stepOut = useDebuggerStore((s) => s.stepOut);
  const pause = useDebuggerStore((s) => s.pause);
  const stop = useDebuggerStore((s) => s.stop);
  const startPrepared = useDebuggerStore((s) => s.startPrepared);
  const setDockOpen = useDebuggerStore((s) => s.setDockOpen);
  const selectFrame = useDebuggerStore((s) => s.selectFrame);

  const live =
    status === "running" || status === "paused" || status === "starting";

  // Innermost last, PyCharm-style: main ▸ train_epoch ▸ train_step
  const crumbs = paused
    ? paused.frames
        .map((f, i) => ({ f, i }))
        .slice(0, 4)
        .reverse()
    : [];

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <HugeiconsIcon
        icon={FlowchartIcon}
        size={13}
        className="shrink-0 text-muted-foreground"
      />
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          status === "paused" && "bg-amber-500",
          status === "running" && "animate-pulse bg-emerald-500",
          status === "starting" && "animate-pulse bg-sky-500",
          status === "ended" && "bg-muted-foreground/50",
        )}
      />
      <span className="max-w-40 truncate font-mono text-[11px] text-muted-foreground">
        {script?.split("/").pop() ?? ""}
      </span>
      <span className="text-[10px] text-muted-foreground/60">
        {status === "paused"
          ? (statusDetail ?? "paused")
          : status === "ended"
            ? (statusDetail ?? "finished")
            : status === "idle"
              ? "ready"
              : status}
      </span>

      <ProjectRootPicker />
      <InterpreterPicker />

      <div className="mx-1 h-4 w-px bg-border/60" />

      {!live ? (
        <>
          <ControlButton
            label="Start local/SSH debug"
            onClick={() => startPrepared()}
            icon={PlayIcon}
            disabled={!script}
          />
          <SlurmLauncher />
        </>
      ) : status === "paused" ? (
        <ControlButton label="Continue (F5)" onClick={resume} icon={PlayIcon} />
      ) : (
        <ControlButton
          label="Pause"
          onClick={pause}
          icon={PauseIcon}
          disabled={status !== "running"}
        />
      )}
      <ControlButton
        label="Step over (F10)"
        onClick={next}
        icon={ArrowRight02Icon}
        disabled={status !== "paused"}
      />
      <ControlButton
        label="Step into (F11)"
        onClick={stepIn}
        icon={ArrowDown02Icon}
        disabled={status !== "paused"}
      />
      <ControlButton
        label="Step out (Shift+F11)"
        onClick={stepOut}
        icon={ArrowUp02Icon}
        disabled={status !== "paused"}
      />
      <ControlButton
        label="Stop"
        onClick={stop}
        icon={StopIcon}
        disabled={!live}
        danger
      />

      <div className="min-w-0 flex-1 overflow-hidden">
        {crumbs.length > 0 && (
          <div className="flex items-center justify-end gap-0.5 truncate">
            {crumbs.map(({ f, i }, idx) => (
              <span key={f.id} className="flex items-center gap-0.5">
                {idx > 0 && (
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    size={10}
                    className="text-muted-foreground/50"
                  />
                )}
                <button
                  type="button"
                  onClick={() => selectFrame(i)}
                  className={cn(
                    "rounded px-1 font-mono text-[10px] hover:bg-accent/60",
                    i === paused?.selectedFrame
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {f.name}
                </button>
              </span>
            ))}
            <span className="ml-1 shrink-0 font-mono text-[10px] text-muted-foreground/60">
              {paused?.frames[paused.selectedFrame]?.source?.name ??
                paused?.frames[paused.selectedFrame]?.source?.path
                  ?.split("/")
                  .pop()}
              :{paused?.frames[paused.selectedFrame]?.line}
            </span>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setDockOpen(false)}
        className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Close debug panel"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={13} />
      </button>
    </div>
  );
}

function SlurmLauncher() {
  const startSlurm = useDebuggerStore((s) => s.startSlurmPrepared);
  const script = useDebuggerStore((s) => s.script);
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState(defaultSlurmDebugOptions);

  const set = (patch: Partial<typeof opts>) =>
    setOpts((cur) => ({ ...cur, ...patch }));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!script}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              Start GPU…
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Debug on mcluster11 GPU via Slurm tunnel</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80 p-2">
        <div className="mb-2 text-[11px] text-muted-foreground">
          Starts debugpy inside an mcluster11 Slurm allocation, tunnels it back,
          then attaches automatically.
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Field label="partition">
            <Input value={opts.partition} onChange={(v) => set({ partition: v })} />
          </Field>
          <Field label="GPU">
            <Input value={opts.gpu} onChange={(v) => set({ gpu: v })} />
          </Field>
          <Field label="CPUs">
            <Input
              value={String(opts.cpu)}
              onChange={(v) => set({ cpu: Math.max(1, Number(v) || 1) })}
            />
          </Field>
          <Field label="memory">
            <Input value={opts.mem} onChange={(v) => set({ mem: v })} />
          </Field>
          <Field label="port">
            <Input
              value={String(opts.port)}
              onChange={(v) => set({ port: Math.max(1, Number(v) || 5678) })}
            />
          </Field>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            startSlurm(opts);
          }}
          className="mt-2 w-full rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:opacity-90"
        >
          Start GPU debug
        </button>
      </PopoverContent>
    </Popover>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5 text-[10px] text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function Input({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-0 rounded border border-border/60 bg-background px-1.5 py-1 font-mono text-[11px] text-foreground outline-none focus:border-primary/50"
    />
  );
}

function ProjectRootPicker() {
  const root = useDebuggerStore((s) => s.root);
  const detectedRoot = useDebuggerStore((s) => s.detectedRoot);
  const runWorkspace = useDebuggerStore((s) => s.runWorkspace);
  const status = useDebuggerStore((s) => s.status);
  const [open, setOpen] = useState(false);
  const [override, setOverride] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  const workspace = runWorkspace ?? currentWorkspaceEnv();
  const detected = detectedRoot ?? root;
  const live =
    status === "running" || status === "paused" || status === "starting";

  useEffect(() => {
    if (!open || !detected) return;
    const current = getDebuggerRootOverride(workspace, detected);
    setOverride(current);
    setCustom(current ?? root ?? detected);
  }, [open, workspace, detected, root]);

  if (!root || !detected) return null;

  const choose = (path: string | null) => {
    setDebuggerRootOverride(workspace, detected, path);
    setOverride(path);
    setCustom(path ?? detected);
    setOpen(false);
  };

  const effective = override ?? root;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={effective}
              className="flex max-w-52 items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <span className="truncate">root: {effective.split("/").pop()}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={10} className="shrink-0" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px]">
          Debug project root / PYTHONPATH{live ? " — applies to the next run" : ""}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-96 p-1.5">
        <div className="px-1.5 pb-1 text-[10px] text-muted-foreground/70">
          Debug launches use this root as cwd and prepend it to PYTHONPATH
          {live ? " on the next run" : ""}.
        </div>
        <div className="mb-1 flex flex-col gap-1 rounded bg-accent/30 px-1.5 py-1 text-[10px]">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">detected root</span>
            <span className="break-all font-mono text-foreground">{detected}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">effective root</span>
            <span className="break-all font-mono text-foreground">{effective}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">PYTHONPATH</span>
            <span className="break-all font-mono text-foreground">{effective}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => choose(null)}
          className={cn(
            "w-full rounded px-1.5 py-1 text-left font-mono text-[11px]",
            override === null
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          auto — use detected root
        </button>
        <form
          className="mt-1 flex gap-1 border-t border-border/60 pt-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const path = custom.trim();
            if (path) choose(path);
          }}
        >
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="/path/to/project/root"
            className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 font-mono text-[11px] outline-none focus:border-ring"
          />
          <button
            type="submit"
            className="rounded border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Set
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Dock-header interpreter picker: choose which python runs the NEXT debug
 * session for this project root (persisted per root+workspace). Fixes the
 * "session just exits" case where the auto-resolved interpreter (project
 * venv, else python3) has no debugpy — pick the venv that does.
 */
function InterpreterPicker() {
  const root = useDebuggerStore((s) => s.root);
  const runWorkspace = useDebuggerStore((s) => s.runWorkspace);
  const status = useDebuggerStore((s) => s.status);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[] | null>(null);
  const [override, setOverride] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  const workspace = runWorkspace ?? currentWorkspaceEnv();
  const live =
    status === "running" || status === "paused" || status === "starting";

  useEffect(() => {
    if (!open || !root) return;
    setOverride(getPythonOverride(workspace, root));
    setCustom("");
    setOptions(null);
    let cancelled = false;
    void discoverInterpreters(root, workspace).then((found) => {
      if (!cancelled) setOptions(found);
    });
    return () => {
      cancelled = true;
    };
  }, [open, root, workspace]);

  if (!root) return null;

  const choose = (path: string | null) => {
    setPythonOverride(workspace, root, path);
    setOverride(path);
    setOpen(false);
  };

  const itemClass = (active: boolean) =>
    cn(
      "w-full rounded px-1.5 py-1 text-left font-mono text-[11px]",
      active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={override ?? "auto"}
              className="flex max-w-48 items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <span className="truncate">
                {override ? displayPython(override, root) : "python: auto"}
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={10}
                className="shrink-0"
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px]">
          Python interpreter for this project
          {live ? " — applies to the next run" : ""}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80 p-1.5">
        <div className="px-1.5 pb-1 text-[10px] text-muted-foreground/70">
          Interpreter for {root.split("/").pop()}
          {live ? " (takes effect on the next run)" : ""} — needs debugpy
          installed.
        </div>
        {override ? (
          <div className="mb-1 break-all rounded bg-accent/40 px-1.5 py-1 font-mono text-[10px] text-foreground">
            current: {override}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => choose(null)}
          className={itemClass(override === null)}
        >
          auto — project venv, else python3
        </button>
        {options === null ? (
          <div className="px-1.5 py-1 text-[10px] text-muted-foreground/60">
            scanning…
          </div>
        ) : (
          options.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => choose(p)}
              className={itemClass(override === p)}
              title={p}
            >
              {displayPython(p, root)}
            </button>
          ))
        )}
        <form
          className="mt-1 flex gap-1 border-t border-border/60 pt-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const path = custom.trim();
            if (!path) return;
            // A pasted venv DIRECTORY resolves to the binary inside it.
            void normalizePythonPath(path, workspace).then(choose);
          }}
        >
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="/path/to/venv/bin/python"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-border/60 bg-background px-1.5 py-1 font-mono text-[11px] outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
          />
          <button
            type="submit"
            disabled={!custom.trim()}
            className="rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            Use
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ControlButton({
  label,
  onClick,
  icon,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  icon: typeof PlayIcon;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            danger && "hover:text-destructive",
          )}
        >
          <HugeiconsIcon icon={icon} size={13} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
