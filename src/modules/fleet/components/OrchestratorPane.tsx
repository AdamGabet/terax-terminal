import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  disposeSession,
  TerminalPane,
  writeToSession,
} from "@/modules/terminal";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import {
  agentHandle,
  attachCommand,
  fleetStop,
  findOrchestrator,
  orchestratorAttachCommand,
  orchestratorStartCommand,
} from "../lib/fleet";
import { refreshFleetNow, useFleetStore } from "../store/fleetStore";

type Props = {
  leafId: number;
  visible: boolean;
  initialCwd?: string;
  focused?: boolean;
  onExit?: () => void;
  /** Directory the orchestrator was started in / attached from. */
  onCwdChange?: (cwd: string) => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "running"; cwd: string; command: string; autoAttach: boolean };

const AUTO_ATTACH_POLL_MS = 1000;
const AUTO_ATTACH_TIMEOUT_MS = 20_000;

/**
 * Orchestrator terminal behind an explicit launch panel: nothing is typed
 * into a shell until the user picks a directory and clicks Start (or Attach
 * when the `--bg` session already runs).
 */
export function OrchestratorPane({
  leafId,
  visible,
  initialCwd,
  focused,
  onExit,
  onCwdChange,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const autoAttach = phase.kind === "running" && phase.autoAttach;

  // After Start, wait for the new `--bg` job to be listed and attach by its
  // short id. Cancelled on unmount or when the session exits (phase → idle).
  useEffect(() => {
    if (!autoAttach) return;
    let done = false;
    const startedAt = Date.now();
    const cancel = () => {
      done = true;
      clearInterval(timer);
    };
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > AUTO_ATTACH_TIMEOUT_MS) return cancel();
      await refreshFleetNow();
      if (done) return;
      const orch = findOrchestrator(useFleetStore.getState().agents);
      if (!orch?.id) return;
      if (writeToSession(leafId, `${attachCommand(orch)}\r`)) cancel();
    }, AUTO_ATTACH_POLL_MS);
    return cancel;
  }, [autoAttach, leafId]);

  if (phase.kind === "running") {
    return (
      <TerminalPane
        leafId={leafId}
        visible={visible}
        focused={focused}
        initialCwd={phase.cwd}
        restartCommand={phase.command}
        launchWithoutMarker
        onExit={() => {
          // Drop the exited session so the next Start opens a fresh PTY.
          disposeSession(leafId);
          setPhase({ kind: "idle" });
          onExit?.();
        }}
      />
    );
  }

  return (
    <LaunchPanel
      initialCwd={initialCwd}
      onLaunch={(cwd, command, autoAttach) => {
        onCwdChange?.(cwd);
        setPhase({ kind: "running", cwd, command, autoAttach });
      }}
    />
  );
}

function LaunchPanel({
  initialCwd,
  onLaunch,
}: {
  initialCwd?: string;
  onLaunch: (cwd: string, command: string, autoAttach: boolean) => void;
}) {
  const env = useWorkspaceEnvStore((s) => s.env);
  const agents = useFleetStore((s) => s.agents);
  const updatedAt = useFleetStore((s) => s.updatedAt);
  const fleetError = useFleetStore((s) => s.error);
  const [dir, setDir] = useState(initialCwd ?? "");
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (useFleetStore.getState().updatedAt === null) void refreshFleetNow();
  }, []);

  const running = findOrchestrator(agents);
  const listed = updatedAt !== null || fleetError !== null;
  const cwd = dir.trim();

  const browse = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: cwd || undefined,
      title: "Start the orchestrator in…",
    });
    if (typeof picked === "string") setDir(picked);
  };

  const stop = async () => {
    if (!running) return;
    setStopping(true);
    setError(null);
    try {
      await fleetStop(agentHandle(running));
      await refreshFleetNow();
    } catch (e) {
      setError(String(e));
    } finally {
      setStopping(false);
    }
  };

  if (!listed) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Looking up the orchestrator…
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col gap-3 text-xs">
        {running ? (
          <>
            <div className="text-muted-foreground">
              An orchestrator is already running in{" "}
              <span className="font-mono text-foreground">{running.cwd}</span>
            </div>
            <Button
              onClick={() =>
                onLaunch(running.cwd, orchestratorAttachCommand(running), false)
              }
            >
              Attach to running orchestrator
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={stopping}
                onClick={() => void stop()}
              >
                {stopping ? <Spinner className="size-3" /> : null}
                Stop
              </Button>
              <Button variant="outline" size="sm" disabled>
                Start a new one here
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Stop it first to start a new one.
            </div>
          </>
        ) : (
          <>
            <label className="text-muted-foreground" htmlFor="orch-cwd">
              Start the orchestrator in
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="orch-cwd"
                value={dir}
                placeholder="/path/to/project"
                spellCheck={false}
                className="h-8 font-mono text-xs md:text-xs"
                onChange={(e) => setDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && cwd) {
                    onLaunch(cwd, orchestratorStartCommand(), true);
                  }
                }}
              />
              {env.kind === "local" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void browse()}
                >
                  Browse…
                </Button>
              ) : null}
            </div>
            <Button
              disabled={!cwd}
              onClick={() => onLaunch(cwd, orchestratorStartCommand(), true)}
            >
              Start orchestrator
            </Button>
          </>
        )}
        {error ? <div className="text-destructive">{error}</div> : null}
      </div>
    </div>
  );
}
