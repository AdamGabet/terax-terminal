import {
  ComputerTerminal02Icon,
  HierarchySquare01Icon,
  IncognitoIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { useChatStore } from "@/modules/ai";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { DebugPill } from "@/modules/debugger/components/DebugPill";
import { AiStatusBarControls } from "@/modules/ai/components/AiStatusBarControls";
import type { WorkspaceEnv } from "@/modules/workspace";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { DiagnosticsBadge } from "./DiagnosticsBadge";
import { SshRemoteSelector } from "./SshRemoteSelector";
import { TmuxSessionsPopover } from "./TmuxSessionsPopover";
import { Button } from "@/components/ui/button";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onOpenMini: () => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
  tmuxAvailable: boolean;
  onAttachTmux: (name: string) => void;
  floatingTerminalOpen: boolean;
  onToggleFloatingTerminal: () => void;
  orchestratorOpen: boolean;
  onToggleOrchestrator: () => void;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onOpenMini,
  hasComposer,
  privateActive,
  tmuxAvailable,
  onAttachTmux,
  floatingTerminalOpen,
  onToggleFloatingTerminal,
  orchestratorOpen,
  onToggleOrchestrator,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SshRemoteSelector onSelect={onWorkspaceChange} />
        <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        <DiagnosticsBadge filePath={filePath ?? null} />
        <DebugPill filePath={filePath ?? null} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private: hidden from AI</span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-[11px] leading-relaxed"
            >
              AI can't see this terminal's output. Use it for secrets, SSH, or
              anything you don't want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <TmuxSessionsPopover
          available={tmuxAvailable}
          onAttach={onAttachTmux}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          title={
            floatingTerminalOpen
              ? "Close floating terminal"
              : "Open floating terminal"
          }
          onClick={onToggleFloatingTerminal}
        >
          <HugeiconsIcon icon={ComputerTerminal02Icon} size={12} />
          floating
        </Button>
        <AgentStatusPill onClick={onOpenMini} />
        {panelOpen && hasComposer ? <AiStatusBarControls /> : null}
        <Button
          variant={orchestratorOpen ? "secondary" : "outline"}
          size="sm"
          className="h-6 gap-1.5 px-2 text-[11px]"
          title={`Open orchestrator (${fmtShortcut(MOD_KEY, "I")})`}
          onClick={onToggleOrchestrator}
        >
          <HugeiconsIcon icon={HierarchySquare01Icon} size={12} />
          Orchestrator
        </Button>
      </div>
    </footer>
  );
}
