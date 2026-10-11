import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";

/** One row of `claude agents --json --all` (see src-tauri fleet.rs). */
export type FleetAgent = {
  pid: number | null;
  cwd: string;
  /**
   * "interactive" (terminal or `-p`), "background" (`--bg`, attachable), or
   * "opencode" (a session on the host's opencode v2 service, attachable).
   */
  kind: string;
  startedAt: number | null;
  /** Short job id (e.g. "59be4b42") — background sessions only. */
  id?: string | null;
  sessionId: string;
  name: string;
  /** "busy" | "idle" */
  status: string;
  state: string | null;
  /** e.g. "permission prompt" — background sessions only. */
  waitingFor: string | null;
};

export function fleetList(): Promise<FleetAgent[]> {
  return invoke<FleetAgent[]>("fleet_list", {
    workspace: currentWorkspaceEnv(),
  });
}

export function fleetStop(id: string): Promise<void> {
  return invoke("fleet_stop", { workspace: currentWorkspaceEnv(), id });
}

/** Sessions on the host's opencode v2 service (empty when it isn't running). */
export function fleetListOpencode(): Promise<FleetAgent[]> {
  return invoke<FleetAgent[]>("fleet_list_opencode", {
    workspace: currentWorkspaceEnv(),
  });
}

/**
 * Stop button: `claude stop` for Claude sessions; for opencode, interrupt the
 * current run (the session stays and can be prompted again).
 */
export function fleetStopAgent(agent: FleetAgent): Promise<void> {
  if (agent.kind === "opencode") {
    return invoke("fleet_opencode_interrupt", {
      workspace: currentWorkspaceEnv(),
      id: agent.sessionId,
    });
  }
  return fleetStop(agentHandle(agent));
}

/** Newest `limit` messages of an opencode session, as the raw API body. */
export function fleetOpencodeMessages(
  id: string,
  limit: number,
): Promise<string> {
  return invoke<string>("fleet_opencode_messages", {
    workspace: currentWorkspaceEnv(),
    id,
    limit,
  });
}

/** Sessions a terminal can attach to (`claude attach` / `opencode -s`). */
export function isAttachable(agent: FleetAgent): boolean {
  return agent.kind === "background" || agent.kind === "opencode";
}

/**
 * `claude --bg --resume <sessionId> --name <name>` from `cwd`: continues a
 * finished/stopped session in the background (or starts a copy if it is
 * still running). Resolves to the CLI output.
 */
export function fleetResume(
  cwd: string,
  sessionId: string,
  name: string,
): Promise<string> {
  return invoke<string>("fleet_resume", {
    workspace: currentWorkspaceEnv(),
    cwd,
    sessionId,
    name,
  });
}

/** A session seen in an earlier listing, kept so it can be resumed. */
export type RememberedSession = {
  name: string;
  cwd: string;
  kind: string;
  lastSeen: number;
};

export const REMEMBERED_CAP = 30;

/**
 * Fold a listing into the remembered map (refreshing lastSeen for every
 * listed session) and keep only the `cap` most recently seen.
 */
export function mergeRemembered(
  prev: Record<string, RememberedSession>,
  agents: FleetAgent[],
  now: number,
  cap = REMEMBERED_CAP,
): Record<string, RememberedSession> {
  const next: Record<string, RememberedSession> = { ...prev };
  for (const a of agents) {
    // Resume is `claude --bg --resume`; opencode sessions persist in their
    // service and list themselves.
    if (a.kind === "opencode") continue;
    next[a.sessionId] = {
      name: a.name || prev[a.sessionId]?.name || "",
      cwd: a.cwd,
      kind: a.kind,
      lastSeen: now,
    };
  }
  const keep = Object.entries(next)
    .sort((x, y) => y[1].lastSeen - x[1].lastSeen)
    .slice(0, cap);
  return Object.fromEntries(keep);
}

/** Remembered sessions missing from the current listing, newest first. */
export function goneSessions(
  remembered: Record<string, RememberedSession>,
  agents: FleetAgent[],
): FleetAgent[] {
  const live = new Set(agents.map((a) => a.sessionId));
  return Object.entries(remembered)
    .filter(([sid]) => !live.has(sid))
    .sort((x, y) => y[1].lastSeen - x[1].lastSeen)
    .map(([sessionId, r]) => ({
      pid: null,
      cwd: r.cwd,
      kind: r.kind,
      startedAt: null,
      sessionId,
      name: r.name,
      status: "gone",
      state: null,
      waitingFor: null,
    }));
}

/** `--name` for a resumed session: its old name, or `agent-<sid prefix>`. */
export function resumeName(agent: FleetAgent): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(agent.name)
    ? agent.name
    : `agent-${agent.sessionId.slice(0, 8)}`;
}

export function fleetTranscriptTail(
  cwd: string,
  sessionId: string,
  maxBytes: number,
): Promise<string> {
  return invoke<string>("fleet_transcript_tail", {
    workspace: currentWorkspaceEnv(),
    cwd,
    sessionId,
    maxBytes,
  });
}

/** Name of the per-host orchestrator background session. */
export const ORCHESTRATOR_NAME = "orchestrator";

// Single-quoted into the launch line below: keep it free of single quotes.
const ORCHESTRATOR_PROMPT =
  "You are the orchestrator for the coding-agent fleet on this host. " +
  "Workers are Claude Code sessions started from your own shell with " +
  '`claude --bg --name <agent> --settings {"crossSessionInbound":"accept"} "<task>"`, ' +
  "one git worktree per agent. Coordinate them with ListAgents and SendMessage, " +
  "inspect them with `claude agents --json --all`. " +
  "Session ids are the sessionId field of that listing; a worker that disappeared or was stopped " +
  "can be continued in the background from its cwd with `claude --bg --resume <sessionId> --name <name>`. " +
  "Workers can also be opencode sessions, which you can message directly: from the worker worktree, run " +
  '`opencode run --auto -s ses_<agent> --title <agent> "<task>"` as a background Bash command ' +
  "(session ids must start with ses_; -s creates the session or continues it; add -m <provider/model> " +
  "if the default model fails). " +
  "It exits with the worker reply when its turn ends, so you get notified; send follow-ups the same way " +
  "with a new message, never while a run for that worker is still going. " +
  "The user can open a worker with `opencode -s ses_<agent>`. " +
  "Wait for instructions.";

/**
 * Leaf id reserved for the orchestrator window's terminal. Tabs and pane
 * leaves are numbered from 2 upwards (0 is the floating terminal).
 */
export const ORCHESTRATOR_LEAF_ID = 1;

/** Running `--bg` orchestrator session in a listing, if any. */
/**
 * `claude agents --all` keeps sessions after `claude stop`, as `"stopped"`
 * or `"done"` — either way a background session without a pid has no process.
 */
export function isLiveAgent(a: FleetAgent): boolean {
  if (a.state === "stopped") return false;
  return a.kind !== "background" || a.pid != null;
}

export function findOrchestrator(agents: FleetAgent[]): FleetAgent | null {
  return (
    agents.find(
      (a) =>
        a.name === ORCHESTRATOR_NAME &&
        a.kind === "background" &&
        isLiveAgent(a),
    ) ?? null
  );
}

/**
 * Shell line that attaches to the running orchestrator session by its short
 * job id: a bare name is ambiguous once a worker's task text mentions it.
 */
export function orchestratorAttachCommand(agent: FleetAgent): string {
  return attachCommand(agent);
}

/**
 * Shell line that starts the orchestrator detached. The caller attaches by id
 * once the job shows up in `claude agents`.
 */
export function orchestratorStartCommand(): string {
  return `claude --bg --name ${ORCHESTRATOR_NAME} '${ORCHESTRATOR_PROMPT}'`;
}

/**
 * Identifier `claude attach` / `claude stop` accept: the short job id or the
 * name. They reject the full sessionId (that's only the transcript filename).
 */
export function agentHandle(agent: FleetAgent): string {
  return agent.id || agent.name || agent.sessionId;
}

export function attachCommand(agent: FleetAgent): string {
  if (agent.kind === "opencode") return `opencode -s ${agent.sessionId}`;
  return `claude attach ${agentHandle(agent)}`;
}

export function hostLabel(env: WorkspaceEnv): string {
  if (env.kind === "ssh") return env.host;
  if (env.kind === "wsl") return `wsl:${env.distro}`;
  return "local";
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function ageLabel(startedAtMs: number | null, now = Date.now()): string {
  if (!startedAtMs) return "";
  const seconds = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
