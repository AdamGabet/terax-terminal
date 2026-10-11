import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FleetAgent } from "../lib/fleet";
import { AgentRow, agentTone } from "./AgentRow";

const agent: FleetAgent = {
  pid: 1,
  cwd: "/project",
  kind: "background",
  startedAt: null,
  sessionId: "worker-session",
  name: "Worker",
  status: "busy",
  state: null,
  waitingFor: null,
};

describe("agent status colors", () => {
  it.each([
    ["blocked", "blocked", "bg-orange-500"],
    ["succeeded", "done", "bg-sky-500"],
    ["failed", "failed", "bg-rose-500"],
    [null, "idle", "bg-muted-foreground/40"],
  ])("distinguishes idle state %s even after it has been seen", (state, tone, color) => {
    const current = { ...agent, status: "idle", state };
    expect(agentTone(current, false)).toBe(tone);
    const html = renderToStaticMarkup(<AgentRow agent={current} unseen={false} />);
    expect(html).toContain(color);
    expect(html).toContain(`title="${tone}"`);
  });

  it("does not show blocked agents as actively working", () => {
    expect(agentTone({ ...agent, state: "blocked" }, false)).toBe("blocked");
  });

  it("prioritizes a prompt over a blocked state", () => {
    expect(agentTone({ ...agent, state: "blocked", waitingFor: "question" }, false)).toBe("attention");
  });

  it("still marks newly completed idle agents as done", () => {
    expect(agentTone({ ...agent, status: "idle" }, true)).toBe("done");
  });
});

describe("AgentRow actions", () => {
  const render = (waitingFor: string | null) => renderToStaticMarkup(
    <AgentRow
      agent={{ ...agent, waitingFor }}
      unseen={false}
      onClick={vi.fn()}
      onAttach={vi.fn()}
      onAttachSplit={vi.fn()}
      onStop={vi.fn()}
    />,
  );

  it("groups secondary actions under one menu button", () => {
    const html = render(null);
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain("Actions for Worker");
    expect(html).not.toContain('title="Attach in a new tab"');
    expect(html).not.toContain('title="Stop session"');
  });

  it("shows an amber waiting status without a duplicate Permit action", () => {
    const html = render("permission prompt");
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain("permission prompt");
    expect(html).toContain("bg-amber-500/10");
    expect(html).not.toContain("Permit");
  });

  it("shows waiting status on compact interactive rows with no extra button", () => {
    const html = renderToStaticMarkup(
      <AgentRow
        agent={{ ...agent, kind: "interactive", waitingFor: "question" }}
        unseen={false}
        compact
        onClick={vi.fn()}
      />,
    );
    expect(html).toContain("Needs you");
    expect(html).toContain('title="question"');
    expect(html).not.toContain("<button");
  });
});
