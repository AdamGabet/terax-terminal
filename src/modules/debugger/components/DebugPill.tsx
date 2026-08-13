import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BugIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openDebugPanelForFile } from "../lib/launch";
import { useDebuggerStore } from "../lib/store";

/** Statusbar pill: opens the debug panel for the active .py file. */
export function DebugPill({ filePath }: { filePath: string | null }) {
  const status = useDebuggerStore((s) => s.status);
  const dockOpen = useDebuggerStore((s) => s.dockOpen);
  const setDockOpen = useDebuggerStore((s) => s.setDockOpen);

  const live =
    status === "running" || status === "paused" || status === "starting";
  const isPy = filePath?.endsWith(".py") ?? false;
  if (!isPy && !live && !(status === "ended" && !dockOpen)) return null;

  const onClick = async () => {
    if (live) {
      setDockOpen(true);
      return;
    }
    if (!dockOpen && status === "ended") {
      setDockOpen(true);
      return;
    }
    if (!filePath) return;
    await openDebugPanelForFile(filePath);
  };

  const label = live
    ? "Show debug panel"
    : status === "ended" && !dockOpen
      ? "Show debug panel"
      : `Open debug panel for ${filePath?.split("/").pop()}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void onClick()}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
            live
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={BugIcon} size={11} strokeWidth={2} />
          <span>
            {status === "paused" ? "paused" : live ? "debugging" : "debug"}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {label}
        {!live && isPy
          ? " — breakpoints: click gutter · tracepoints: ⌥-click"
          : ""}
      </TooltipContent>
    </Tooltip>
  );
}
