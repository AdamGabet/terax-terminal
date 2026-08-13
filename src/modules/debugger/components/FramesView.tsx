import { cn } from "@/lib/utils";
import { useDebuggerStore } from "../lib/store";

/** Full call-stack list; the header breadcrumb covers the common case. */
export function FramesView({
  onOpenSource,
}: {
  onOpenSource?: (path: string, line: number) => void;
}) {
  const paused = useDebuggerStore((s) => s.paused);
  const selectFrame = useDebuggerStore((s) => s.selectFrame);

  if (!paused) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        The call stack appears when execution pauses.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto py-0.5">
      {paused.frames.map((f, i) => (
        <button
          key={f.id}
          type="button"
          onClick={() => {
            selectFrame(i);
            if (f.source?.path) onOpenSource?.(f.source.path, f.line);
          }}
          className={cn(
            "flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-accent/50",
            i === paused.selectedFrame && "bg-accent/70",
          )}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
            {f.name}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {f.source?.name ?? f.source?.path?.split("/").pop() ?? "?"}:{f.line}
          </span>
        </button>
      ))}
    </div>
  );
}
