import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ResizeDir } from "@/modules/ai/lib/miniWindowGeometry";
import { useMiniWindowGeometry } from "@/modules/ai/lib/useMiniWindowGeometry";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  ArrowExpand01Icon,
  Cancel01Icon,
  HierarchySquare01Icon,
  MinusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useState, type PointerEvent } from "react";
import { hostLabel, ORCHESTRATOR_LEAF_ID, type FleetAgent } from "../lib/fleet";
import {
  refreshFleetNow,
  useFleetPolling,
  useFleetStore,
} from "../store/fleetStore";
import { AgentRow } from "./AgentRow";
import { OrchestratorPane } from "./OrchestratorPane";

type Props = {
  initialCwd?: string;
  visible: boolean;
  onHide: () => void;
  onRequestClose: () => void;
  /** Open the full fleet tab. */
  onExpand: () => void;
  onAttachAgent: (agent: FleetAgent) => Promise<void>;
};

// Same geometry/resize shell as FloatingTerminalWindow.
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

export function OrchestratorWindow({
  initialCwd,
  visible,
  onHide,
  onRequestClose,
  onExpand,
  onAttachAgent,
}: Props) {
  const { ref, onHeaderPointerDown, startResize } = useMiniWindowGeometry();
  const env = useWorkspaceEnvStore((s) => s.env);
  const agents = useFleetStore((s) => s.agents);
  const unseenDone = useFleetStore((s) => s.unseenDone);
  const error = useFleetStore((s) => s.error);
  const loading = useFleetStore((s) => s.loading);
  const [actionError, setActionError] = useState<string | null>(null);
  useFleetPolling(visible);

  const attention = agents.filter((a) => a.waitingFor).length;

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
          className={cn(
            "absolute z-50 touch-none select-none",
            RESIZE_HANDLE_CLASS[dir],
          )}
        />
      ))}
      <div
        className="flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-border/60 px-3"
        onPointerDown={
          onHeaderPointerDown as (event: PointerEvent<HTMLDivElement>) => void
        }
      >
        <HugeiconsIcon icon={HierarchySquare01Icon} size={14} />
        <span className="text-xs font-medium">Orchestrator</span>
        <span className="text-xs text-muted-foreground">
          · {hostLabel(env)}
        </span>
        <span className="ml-1 text-[10px] text-muted-foreground">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
          {attention ? (
            <span className="ml-1 rounded bg-amber-500/15 px-1 font-medium text-amber-600 dark:text-amber-400">
              {attention} waiting
            </span>
          ) : null}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Refresh fleet"
          disabled={loading}
          onClick={() => void refreshFleetNow()}
        >
          {loading ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={RefreshIcon} size={13} />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Open Fleet board with agent terminal"
          onClick={onExpand}
        >
          <HugeiconsIcon icon={ArrowExpand01Icon} size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Hide"
          onClick={onHide}
        >
          <HugeiconsIcon icon={MinusSignIcon} size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Close (the orchestrator keeps running in the background)"
          onClick={onRequestClose}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} />
        </Button>
      </div>

      <div className="max-h-36 shrink-0 overflow-auto border-b border-border/60 px-1 py-1">
        {actionError ? (
          <div role="status" className="px-2 py-1 text-[11px] text-destructive">
            {actionError}
          </div>
        ) : null}
        {error ? (
          <div className="px-2 py-1 text-[11px] text-destructive">{error}</div>
        ) : agents.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            {loading ? "Listing agents…" : "No Claude sessions on this host."}
          </div>
        ) : (
          agents.map((a) => (
            <AgentRow
              key={a.sessionId}
              agent={a}
              compact
              unseen={!!unseenDone[a.sessionId]}
              onClick={() => {
                setActionError(null);
                void onAttachAgent(a).catch((e) => setActionError(String(e)));
              }}
            />
          ))
        )}
      </div>

      <div className="min-h-0 flex-1 p-2">
        <OrchestratorPane
          leafId={ORCHESTRATOR_LEAF_ID}
          visible={visible}
          initialCwd={initialCwd}
        />
      </div>
    </motion.div>
  );
}
