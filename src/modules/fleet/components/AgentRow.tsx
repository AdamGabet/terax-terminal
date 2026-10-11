import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Copy01Icon,
  LayoutTwoColumnIcon,
  Link04Icon,
  MoreHorizontalIcon,
  PlayIcon,
  StopCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  ageLabel,
  basename,
  isAttachable,
  type FleetAgent,
} from "../lib/fleet";

export type AgentTone =
  | "attention"
  | "blocked"
  | "working"
  | "done"
  | "failed"
  | "idle";

export function agentTone(agent: FleetAgent, unseen: boolean): AgentTone {
  if (agent.waitingFor) return "attention";
  if (agent.state === "blocked") return "blocked";
  if (agent.state === "succeeded") return "done";
  if (agent.state === "failed") return "failed";
  if (agent.status === "busy") return "working";
  if (unseen) return "done";
  return "idle";
}

const DOT: Record<AgentTone, string> = {
  attention: "bg-amber-500 animate-pulse",
  blocked: "bg-orange-500",
  working: "bg-emerald-500 animate-pulse",
  done: "bg-sky-500",
  failed: "bg-rose-500",
  idle: "bg-muted-foreground/40",
};

const LABEL: Record<AgentTone, string> = {
  attention: "needs you",
  blocked: "blocked",
  working: "working",
  done: "done",
  failed: "failed",
  idle: "idle",
};

export function StatusDot({
  tone,
  className,
}: {
  tone: AgentTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT[tone],
        className,
      )}
      title={LABEL[tone]}
    />
  );
}

type Props = {
  agent: FleetAgent;
  unseen: boolean;
  selected?: boolean;
  /** Single-line row for the orchestrator window strip. */
  compact?: boolean;
  onClick?: () => void;
  onAttach?: () => void;
  onAttachSplit?: () => void;
  onStop?: () => void;
  /** Remembered session no longer in the listing ("Recent / gone"). */
  gone?: boolean;
  resuming?: boolean;
  onResume?: () => void;
  onForget?: () => void;
};

/** Plain id text; the copy button only appears once the row is selected. */
function SessionId({
  sessionId,
  showCopy,
}: {
  sessionId: string;
  showCopy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate font-mono text-[9px] text-muted-foreground/80">
        {sessionId}
      </span>
      {showCopy ? (
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
          title="Copy session id"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard
              ?.writeText(sessionId)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => {});
          }}
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={10} />
        </button>
      ) : null}
    </div>
  );
}

export function AgentRow({
  agent,
  unseen,
  selected,
  compact,
  onClick,
  onAttach,
  onAttachSplit,
  onStop,
  gone,
  resuming,
  onResume,
  onForget,
}: Props) {
  const tone = agentTone(agent, unseen);
  const [confirmStop, setConfirmStop] = useState(false);
  const attachable = isAttachable(agent);
  const opencode = agent.kind === "opencode";
  const detail = gone
    ? "gone"
    : (agent.waitingFor ?? agent.state ?? LABEL[tone]);

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-md px-2 text-xs outline-none",
        compact ? "h-7" : "h-14",
        onClick &&
          "cursor-pointer hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-accent",
      )}
      title={`${agent.name}\n${agent.cwd}\n${agent.sessionId}`}
    >
      <StatusDot tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">
            {agent.name || agent.sessionId.slice(0, 8)}
          </span>
          <span
            className={cn(
              "shrink-0 rounded px-1 font-mono text-[9px] uppercase leading-4",
              attachable
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}
            title={
              opencode
                ? "opencode session (opencode -s)"
                : attachable
                  ? "Background session (claude --bg)"
                  : "Interactive / headless session"
            }
          >
            {opencode ? "oc" : attachable ? "bg" : "tty"}
          </span>
          {compact ? (
            <span className="truncate text-[10px] text-muted-foreground">
              {basename(agent.cwd)}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {ageLabel(agent.startedAt)}
          </span>
        </div>
        {!compact ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="truncate">{basename(agent.cwd)}</span>
            <span className="shrink-0">·</span>
            <span
              className={cn(
                "min-w-0 truncate",
                tone === "attention" &&
                  "rounded bg-amber-500/10 px-1 font-medium text-amber-600 dark:text-amber-400",
                tone === "blocked" && "text-orange-600 dark:text-orange-400",
                tone === "done" && "text-sky-600 dark:text-sky-400",
                tone === "failed" && "text-rose-600 dark:text-rose-400",
              )}
            >
              {detail}
            </span>
          </div>
        ) : null}
        {!compact ? (
          <SessionId sessionId={agent.sessionId} showCopy={selected} />
        ) : null}
      </div>
      {compact && !gone && tone === "attention" ? (
        <span
          className="shrink-0 rounded bg-amber-500/10 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
          title={agent.waitingFor ?? "Needs your attention"}
        >
          Needs you
        </span>
      ) : null}
      {!compact &&
      (gone
        ? onResume || onForget
        : attachable && (onAttach || onAttachSplit || onStop)) ? (
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu onOpenChange={() => setConfirmStop(false)}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                title="Agent actions"
                aria-label={`Actions for ${agent.name || agent.sessionId.slice(0, 8)}`}
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!gone && onAttach ? (
                <DropdownMenuItem onSelect={onAttach}>
                  <HugeiconsIcon icon={Link04Icon} size={14} />
                  Open in new tab
                </DropdownMenuItem>
              ) : null}
              {!gone && onAttachSplit ? (
                <DropdownMenuItem onSelect={onAttachSplit}>
                  <HugeiconsIcon icon={LayoutTwoColumnIcon} size={14} />
                  Open in split
                </DropdownMenuItem>
              ) : null}
              {!gone && onStop ? (
                <>
                  {onAttach || onAttachSplit ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(e) => {
                      if (!confirmStop) {
                        e.preventDefault();
                        setConfirmStop(true);
                      } else {
                        setConfirmStop(false);
                        onStop();
                      }
                    }}
                  >
                    <HugeiconsIcon icon={StopCircleIcon} size={14} />
                    {confirmStop ? "Confirm stop session" : "Stop session…"}
                  </DropdownMenuItem>
                </>
              ) : null}
              {gone && onResume ? (
                <DropdownMenuItem disabled={resuming} onSelect={onResume}>
                  <HugeiconsIcon icon={PlayIcon} size={14} />
                  {resuming ? "Resuming…" : "Resume in background"}
                </DropdownMenuItem>
              ) : null}
              {gone && onForget ? (
                <DropdownMenuItem onSelect={onForget}>
                  <HugeiconsIcon icon={Cancel01Icon} size={14} />
                  Remove from list
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  );
}
