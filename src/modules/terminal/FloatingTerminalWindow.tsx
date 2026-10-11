import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  MinusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import type { PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ResizeDir } from "@/modules/ai/lib/miniWindowGeometry";
import { useMiniWindowGeometry } from "@/modules/ai/lib/useMiniWindowGeometry";
import { cn } from "@/lib/utils";
import { TerminalPane } from "./TerminalPane";

type Props = {
  initialCwd?: string;
  /** Header text (default "Floating terminal"). */
  title?: string;
  /** Typed into the fresh shell once it's up (e.g. `claude attach <id>`). */
  command?: string;
  /** Give the terminal keyboard focus as soon as it's ready. */
  autoFocus?: boolean;
  visible: boolean;
  onHide: () => void;
  onRequestClose: () => void;
  onExit: () => void;
};

const RESIZE_HANDLE_CLASS: Record<ResizeDir, string> = {
  n: "top-0 left-3 right-3 h-1.5 cursor-ns-resize",
  s: "bottom-0 left-3 right-3 h-1.5 cursor-ns-resize",
  w: "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize",
  e: "top-3 bottom-3 right-0 w-1.5 cursor-ew-resize",
  nw: "top-0 left-0 size-3 cursor-nwse-resize",
  ne: "top-0 right-0 size-3 cursor-nesw-resize",
  sw: "bottom-0 left-0 size-3 cursor-nesw-resize",
  se: "bottom-0 right-0 size-3 cursor-nwse-resize",
};

const RESIZE_DIRS: ResizeDir[] = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];

export function FloatingTerminalWindow({
  initialCwd,
  title,
  command,
  autoFocus,
  visible,
  onHide,
  onRequestClose,
  onExit,
}: Props) {
  const { ref, onHeaderPointerDown, startResize } = useMiniWindowGeometry();

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_24px_48px_-12px_rgba(0,0,0,0.45),0_8px_16px_-8px_rgba(0,0,0,0.3)]",
        "ring-1 ring-black/5 dark:ring-white/5",
        !visible && "invisible pointer-events-none",
      )}
    >
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          data-no-drag
          onPointerDown={startResize(dir)}
          className={cn("absolute z-50 touch-none select-none", RESIZE_HANDLE_CLASS[dir])}
        />
      ))}
      <div
        className="flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-border/60 px-3"
        onPointerDown={onHeaderPointerDown as (event: PointerEvent<HTMLDivElement>) => void}
      >
        <HugeiconsIcon icon={ComputerTerminal02Icon} size={14} />
        <span className="flex-1 truncate text-xs font-medium">
          {title ?? "Floating terminal"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Hide floating terminal"
          onClick={onHide}
        >
          <HugeiconsIcon icon={MinusSignIcon} size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Close floating terminal"
          onClick={onRequestClose}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <TerminalPane
          leafId={0}
          visible={visible}
          focused={autoFocus && visible}
          initialCwd={initialCwd}
          restartCommand={command}
          launchWithoutMarker={command !== undefined}
          onExit={onExit}
        />
      </div>
    </motion.div>
  );
}
