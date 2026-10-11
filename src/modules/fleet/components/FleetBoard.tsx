import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import {
  TerminalPane,
  type TerminalPaneHandle,
} from "@/modules/terminal/TerminalPane";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  ComputerTerminal02Icon,
  HierarchySquare01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  fleetResume,
  fleetStopAgent,
  findOrchestrator,
  goneSessions,
  hostLabel,
  isAttachable,
  resumeName,
  type FleetAgent,
} from "../lib/fleet";
import {
  refreshFleetNow,
  useFleetPolling,
  useFleetStore,
} from "../store/fleetStore";
import { AgentRow } from "./AgentRow";
import { OrchestratorPane } from "./OrchestratorPane";

export type FleetBoardTab = {
  id: number;
  leafId: number;
  cwd?: string;
};

export type FleetBoardHandle = {
  focusOrchestrator: () => void;
};

type Props = {
  ref?: Ref<FleetBoardHandle>;
  tab: FleetBoardTab;
  visible: boolean;
  onAttachAgent: (agent: FleetAgent) => void;
  onAttachAgentSplit: (agent: FleetAgent) => void;
  onAttachAgentHere: (agent: FleetAgent) => Promise<void>;
  agentTerminal: {
    sessionId: string;
    leafId: number;
    cwd: string;
    title: string;
    command: string;
  } | null;
  onCloseTerminal: () => void;
  /** Mirror the orchestrator's cwd onto the tab (drives the explorer root). */
  onCwdChange: (tabId: number, cwd: string) => void;
};

export function FleetBoard({
  ref,
  tab,
  visible,
  onAttachAgent,
  onAttachAgentSplit,
  onAttachAgentHere,
  agentTerminal,
  onCloseTerminal,
  onCwdChange,
}: Props) {
  const env = useWorkspaceEnvStore((s) => s.env);
  const agents = useFleetStore((s) => s.agents);
  const unseenDone = useFleetStore((s) => s.unseenDone);
  const markSeen = useFleetStore((s) => s.markSeen);
  const error = useFleetStore((s) => s.error);
  const loading = useFleetStore((s) => s.loading);
  const updatedAt = useFleetStore((s) => s.updatedAt);
  const remembered = useFleetStore((s) => s.remembered);
  const forget = useFleetStore((s) => s.forget);
  useFleetPolling(visible);

  // The listing is for the current host, so only the visible board syncs.
  const orchestratorCwd = findOrchestrator(agents)?.cwd;
  useEffect(() => {
    if (visible && orchestratorCwd && orchestratorCwd !== tab.cwd) {
      onCwdChange(tab.id, orchestratorCwd);
    }
  }, [visible, orchestratorCwd, tab.id, tab.cwd, onCwdChange]);

  const [selectedId, setSelectedId] = useState<string | null>(
    agentTerminal?.sessionId ?? null,
  );
  const selectionRef = useRef(selectedId);
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const orchestratorRef = useRef<HTMLDivElement>(null);
  const [focusedPane, setFocusedPane] = useState<"agent" | "orchestrator">("agent");
  useImperativeHandle(
    ref,
    () => ({
      focusOrchestrator: () => {
        setFocusedPane("orchestrator");
        requestAnimationFrame(() => {
          orchestratorRef.current
            ?.querySelector<HTMLElement>("textarea, input, button")
            ?.focus();
        });
      },
    }),
    [],
  );
  const attachedId = agentTerminal?.sessionId ?? null;
  useEffect(() => {
    selectionRef.current = attachedId;
    setSelectedId(attachedId);
  }, [attachedId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const gone = useMemo(
    () => goneSessions(remembered, agents),
    [remembered, agents],
  );
  const selected =
    agents.find((a) => a.sessionId === selectedId) ??
    gone.find((a) => a.sessionId === selectedId) ??
    null;
  const attached = agents.find((a) => a.sessionId === attachedId);

  const select = (a: FleetAgent) => {
    const alreadySelected = selectionRef.current === a.sessionId;
    selectionRef.current = a.sessionId;
    setSelectedId(a.sessionId);
    markSeen(a.sessionId);
    setActionError(null);
    if (alreadySelected && agents.includes(a)) {
      setFocusedPane("agent");
      void onAttachAgentHere(a).catch((e) => setActionError(String(e)));
      if (agentTerminal?.sessionId === a.sessionId) terminalRef.current?.focus();
    }
  };

  const stop = async (a: FleetAgent) => {
    setActionError(null);
    try {
      await fleetStopAgent(a);
      await refreshFleetNow();
    } catch (e) {
      setActionError(String(e));
    }
  };

  const resume = async (a: FleetAgent) => {
    setActionError(null);
    setResumingId(a.sessionId);
    try {
      await fleetResume(a.cwd, a.sessionId, resumeName(a));
      await refreshFleetNow();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setResumingId(null);
    }
  };

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
      <ResizablePanel
        id="agents"
        defaultSize="26%"
        minSize="18%"
        className="flex min-h-0 flex-col"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <HugeiconsIcon icon={HierarchySquare01Icon} size={14} />
          <span className="text-xs font-medium">Fleet</span>
          <span className="text-xs text-muted-foreground">
            · {hostLabel(env)}
          </span>
          <div className="flex-1" />
          {updatedAt ? (
            <span
              className="text-[10px] text-muted-foreground"
              title="Last refresh"
            >
              {new Date(updatedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title="Refresh"
            disabled={loading}
            onClick={() => void refreshFleetNow()}
          >
            {loading ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={RefreshIcon} size={12} />
            )}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          <div className="px-2 py-1 text-[10px] text-muted-foreground">
            Click to select · click again to open
          </div>
          {!error && agents.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              {loading ? "Listing agents…" : "No Claude sessions on this host."}
              <div className="mt-2 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
                claude --bg --name agent-A "task…"
              </div>
            </div>
          ) : null}
          {agents.map((a) => (
            <AgentRow
              key={a.sessionId}
              agent={a}
              unseen={!!unseenDone[a.sessionId]}
              selected={a.sessionId === selectedId}
              onClick={() => select(a)}
              onAttach={() => onAttachAgent(a)}
              onAttachSplit={() => onAttachAgentSplit(a)}
              onStop={() => void stop(a)}
            />
          ))}
          {gone.length > 0 ? (
            <details className="group/recent mt-2 border-t border-border/60 pt-1">
              <summary
                className="flex w-full cursor-pointer list-none items-center gap-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
              >
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={10}
                  className="transition-transform group-open/recent:rotate-90"
                />
                Recent / gone · {gone.length}
              </summary>
              {gone.map((a) => (
                <AgentRow
                  key={a.sessionId}
                  agent={a}
                  unseen={false}
                  gone
                  resuming={resumingId === a.sessionId}
                  selected={a.sessionId === selectedId}
                  onClick={() => select(a)}
                  onResume={() => void resume(a)}
                  onForget={() => forget(a.sessionId)}
                />
              ))}
            </details>
          ) : null}
        </div>
        <div
          data-slot="fleet-status"
          role="status"
          className="h-16 shrink-0 overflow-auto border-t border-border/60 px-3 py-2 text-[11px] text-destructive"
        >
          {error ? <div>{error}</div> : null}
          {actionError ? <div>{actionError}</div> : null}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id="agent-terminal"
        defaultSize="40%"
        minSize="20%"
        className="min-h-0"
      >
        {agentTerminal ? (
          <div
            className="flex h-full min-h-0 flex-col"
            onFocusCapture={() => setFocusedPane("agent")}
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              <HugeiconsIcon icon={ComputerTerminal02Icon} size={14} />
              <span className="flex-1 truncate text-xs font-medium">
                {agentTerminal.title}
              </span>
              {attached?.waitingFor ? (
                <span className="truncate text-[10px] text-amber-600 dark:text-amber-400">
                  {attached.waitingFor}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                title="Detach terminal (agent keeps running)"
                aria-label="Detach agent terminal"
                onClick={onCloseTerminal}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} />
              </Button>
            </div>
            <div className="min-h-0 flex-1 p-2">
              <TerminalPane
                ref={terminalRef}
                key={agentTerminal.leafId}
                leafId={agentTerminal.leafId}
                visible={visible}
                focused={visible && focusedPane === "agent"}
                initialCwd={agentTerminal.cwd || undefined}
                restartCommand={agentTerminal.command}
                launchWithoutMarker
                onExit={onCloseTerminal}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs font-medium">
              <HugeiconsIcon icon={ComputerTerminal02Icon} size={14} />
              Agent terminal
            </div>
            <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
              {selected && !isAttachable(selected)
                ? "Interactive agents open in their existing Terax terminal when found."
                : selected && gone.includes(selected)
                  ? "Resume this session, then click twice to attach."
                  : "Click an agent to select it, then click it again to attach here. Detaching leaves the agent running."}
            </div>
          </div>
        )}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id="orchestrator"
        defaultSize="34%"
        minSize="20%"
        className="flex min-h-0 flex-col"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs">
          <span className="font-medium">Orchestrator</span>
          <span className="text-muted-foreground">
            claude attach orchestrator
          </span>
        </div>
        <div
          ref={orchestratorRef}
          className="min-h-0 flex-1 p-2"
          onFocusCapture={() => setFocusedPane("orchestrator")}
        >
          <OrchestratorPane
            leafId={tab.leafId}
            visible={visible}
            focused={visible && focusedPane === "orchestrator"}
            initialCwd={tab.cwd}
            onCwdChange={(cwd) => {
              if (cwd !== tab.cwd) onCwdChange(tab.id, cwd);
            }}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
