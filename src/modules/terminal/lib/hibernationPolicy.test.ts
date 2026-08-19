import { describe, expect, it } from "vitest";
import {
  HIBERNATE_AFTER_MS,
  shouldHibernateTerminal,
} from "./hibernationPolicy";

const idle = (
  over: Partial<Parameters<typeof shouldHibernateTerminal>[0]> = {},
) =>
  shouldHibernateTerminal({
    hidden: true,
    focused: false,
    lastActivityAt: 0,
    now: HIBERNATE_AFTER_MS,
    hasForegroundProcess: false,
    agentActivity: null,
    ...over,
  });

describe("shouldHibernateTerminal", () => {
  it("hibernates an old hidden shell at a prompt", () => {
    expect(idle()).toBe(true);
  });

  it("keeps visible, focused, recent, and working terminals live", () => {
    expect(idle({ hidden: false })).toBe(false);
    expect(idle({ focused: true })).toBe(false);
    expect(idle({ now: HIBERNATE_AFTER_MS - 1 })).toBe(false);
    expect(idle({ agentActivity: "working" })).toBe(false);
  });

  it("allows waiting agents to hibernate after the timeout", () => {
    expect(idle({ agentActivity: "waiting", hasForegroundProcess: true })).toBe(
      true,
    );
  });

  it("keeps ordinary terminals with a child process live", () => {
    expect(idle({ hasForegroundProcess: true })).toBe(false);
  });
});
