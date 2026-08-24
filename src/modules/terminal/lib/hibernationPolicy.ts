export const HIBERNATE_AFTER_MS = 60 * 60 * 1000;
export const HIBERNATE_CHECK_MS = 60 * 1000;
/** How many hidden, idle terminals to keep alive (never hibernate). Matches
 * the renderer pool size — the 6 most recently used hidden terminals stay hot
 * so the user can flip back without a PTY re-spawn. */
export const HIBERNATE_KEEP_ALIVE = 6;

export type AgentActivity = "working" | "waiting" | null;

export function shouldHibernateTerminal(input: {
  hidden: boolean;
  focused: boolean;
  lastActivityAt: number;
  now: number;
  hasForegroundProcess: boolean;
  agentActivity: AgentActivity;
}): boolean {
  if (!input.hidden || input.focused) return false;
  if (input.now - input.lastActivityAt < HIBERNATE_AFTER_MS) return false;
  if (input.agentActivity === "working") return false;
  if (input.agentActivity === "waiting") return true;
  return !input.hasForegroundProcess;
}
