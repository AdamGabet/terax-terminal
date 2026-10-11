import { describe, expect, it } from "vitest";
import {
  attachCommand,
  findOrchestrator,
  type FleetAgent,
  goneSessions,
  isAttachable,
  mergeRemembered,
  orchestratorAttachCommand,
  orchestratorStartCommand,
  resumeName,
} from "./fleet";

const agent = (extra: Partial<FleetAgent>): FleetAgent => ({
  pid: 1,
  cwd: "/a",
  kind: "background",
  startedAt: null,
  sessionId: "59be4b42-81e0-4118-ad3e-e65a3d20d7b6",
  name: "",
  status: "idle",
  state: null,
  waitingFor: null,
  ...extra,
});

describe("attachCommand", () => {
  it("uses the short job id when present", () => {
    expect(attachCommand(agent({ id: "59be4b42", name: "opg-scout" }))).toBe(
      "claude attach 59be4b42",
    );
  });

  it("falls back to the name without an id", () => {
    expect(attachCommand(agent({ name: "opg-scout" }))).toBe(
      "claude attach opg-scout",
    );
  });

  it("opens opencode sessions by session id", () => {
    const oc = agent({ kind: "opencode", id: "ses_w1", sessionId: "ses_w1" });
    expect(attachCommand(oc)).toBe("opencode -s ses_w1");
    expect(isAttachable(oc)).toBe(true);
    expect(isAttachable(agent({ kind: "interactive" }))).toBe(false);
  });
});

describe("opencode rows", () => {
  it("are not remembered for claude resume", () => {
    const oc = agent({ kind: "opencode", sessionId: "ses_w1" });
    expect(mergeRemembered({}, [oc], 1)).toEqual({});
  });
});

describe("orchestrator commands", () => {
  it("attaches to the orchestrator by short id", () => {
    expect(
      orchestratorAttachCommand(
        agent({ id: "8fbc27fe", name: "orchestrator" }),
      ),
    ).toBe("claude attach 8fbc27fe");
  });

  it("starts detached without attaching by name", () => {
    const cmd = orchestratorStartCommand();
    expect(cmd.startsWith("claude --bg --name orchestrator '")).toBe(true);
    expect(cmd).not.toContain("attach");
  });
});

describe("remembered sessions", () => {
  const sid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("remembers listed sessions and refreshes lastSeen", () => {
    const a = agent({ sessionId: sid(1), name: "w1", cwd: "/w" });
    const first = mergeRemembered({}, [a], 100);
    expect(first[sid(1)]).toEqual({
      name: "w1",
      cwd: "/w",
      kind: "background",
      lastSeen: 100,
    });
    const second = mergeRemembered(first, [a], 200);
    expect(second[sid(1)].lastSeen).toBe(200);
  });

  it("keeps sessions that left the listing and lists them as gone", () => {
    const a = agent({ sessionId: sid(1), name: "w1" });
    const b = agent({ sessionId: sid(2), name: "w2" });
    const remembered = mergeRemembered(mergeRemembered({}, [a, b], 1), [a], 2);
    expect(Object.keys(remembered)).toHaveLength(2);
    const gone = goneSessions(remembered, [a]);
    expect(gone.map((g) => g.sessionId)).toEqual([sid(2)]);
    expect(gone[0]).toMatchObject({ name: "w2", cwd: "/a", status: "gone" });
  });

  it("drops the oldest beyond the cap", () => {
    let r = {};
    for (let i = 0; i < 5; i++) {
      r = mergeRemembered(r, [agent({ sessionId: sid(i) })], i, 3);
    }
    expect(Object.keys(r).sort()).toEqual([sid(2), sid(3), sid(4)]);
  });

  it("resumes under the old name or agent-<sid prefix>", () => {
    expect(resumeName(agent({ name: "probe-fmt" }))).toBe("probe-fmt");
    expect(resumeName(agent({ name: "" }))).toBe("agent-59be4b42");
    expect(resumeName(agent({ name: "has space" }))).toBe("agent-59be4b42");
  });
});

describe("findOrchestrator", () => {
  it("skips stopped sessions still in the --all listing", () => {
    const stopped = agent({ name: "orchestrator", state: "stopped", id: "a" });
    const live = agent({ name: "orchestrator", state: "running", id: "b" });
    expect(findOrchestrator([stopped])).toBeNull();
    expect(findOrchestrator([stopped, live])).toBe(live);
    // `claude stop` can also leave it as "done" without a pid.
    const doneNoPid = agent({ name: "orchestrator", state: "done", pid: null });
    expect(findOrchestrator([doneNoPid])).toBeNull();
    expect(findOrchestrator([agent({ name: "orchestrator", state: "done" })]))
      .not.toBeNull();
  });
});
