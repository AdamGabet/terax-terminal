export const HIBERNATE_AFTER_MS = 60 * 60 * 1000;
export const HIBERNATE_CHECK_MS = 60 * 1000;

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
