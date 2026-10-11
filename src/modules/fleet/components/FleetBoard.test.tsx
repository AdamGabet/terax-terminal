import type { ComponentProps, ReactNode } from "react";
import { forwardRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetAgent } from "../lib/fleet";
import type { AgentRow } from "./AgentRow";
import type { TerminalPane } from "@/modules/terminal/TerminalPane";
import { FleetBoard } from "./FleetBoard";

const mocks = vi.hoisted(() => ({
  agents: [] as FleetAgent[],
  remembered: {} as Record<string, FleetAgent>,
  rows: [] as ComponentProps<typeof AgentRow>[],
  terminals: [] as ComponentProps<typeof TerminalPane>[],
  markSeen: vi.fn(),
  error: null as string | null,
}));

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  useWorkspaceEnvStore: (select: (state: unknown) => unknown) =>
    select({ env: { kind: "local" } }),
}));
vi.mock("../store/fleetStore", () => ({
  useFleetPolling: vi.fn(),
  refreshFleetNow: vi.fn(),
  useFleetStore: (select: (state: unknown) => unknown) =>
    select({
      agents: mocks.agents,
      unseenDone: {},
      remembered: mocks.remembered,
      markSeen: mocks.markSeen,
      forget: vi.fn(),
      error: mocks.error,
      loading: false,
      updatedAt: null,
    }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ id, children }: { id: string; children: ReactNode }) =>
    <section data-panel={id}>{children}</section>,
  ResizableHandle: () => null,
}));
vi.mock("./OrchestratorPane", () => ({
  OrchestratorPane: () => <div>Orchestrator terminal</div>,
}));
vi.mock("./AgentRow", () => ({
  AgentRow: (props: ComponentProps<typeof AgentRow>) => {
    mocks.rows.push(props);
    return <div>{props.agent.name}</div>;
  },
}));
vi.mock("@/modules/terminal/TerminalPane", () => ({
  TerminalPane: forwardRef((props: ComponentProps<typeof TerminalPane>, _ref) => {
    mocks.terminals.push(props);
    return <div>Attached agent terminal</div>;
  }),
}));

const agent: FleetAgent = {
  pid: 1,
  cwd: "/project",
  kind: "background",
  startedAt: null,
  id: "worker",
  sessionId: "session-worker",
  name: "Worker",
  status: "busy",
  state: null,
  waitingFor: "permission prompt",
};

const props = () => ({
  tab: { id: 5, leafId: 6 },
  visible: true,
  onAttachAgent: vi.fn(),
  onAttachAgentSplit: vi.fn(),
  onAttachAgentHere: vi.fn().mockResolvedValue(undefined),
  onCloseTerminal: vi.fn(),
  onCwdChange: vi.fn(),
  agentTerminal: null,
});

describe("FleetBoard agent terminal", () => {
  beforeEach(() => {
    mocks.agents = [agent];
    mocks.remembered = {};
    mocks.rows = [];
    mocks.terminals = [];
    mocks.markSeen.mockClear();
    mocks.error = null;
  });

  it("offers an agent terminal in the middle, not a transcript", () => {
    const html = renderToStaticMarkup(<FleetBoard {...props()} />);
    expect(html).toContain('data-panel="agent-terminal"');
    expect(html).toContain("Click an agent to select it");
    expect(html).not.toContain("Transcript");
    expect(html).toContain("Orchestrator terminal");
  });

  it("reserves a fixed-height status footer even when no error is shown", () => {
    const html = renderToStaticMarkup(<FleetBoard {...props()} />);
    expect(html).toMatch(/data-slot="fleet-status"[^>]*class="[^"]*h-16 shrink-0 overflow-auto/);
    expect(html.indexOf('data-slot="fleet-status"')).toBeGreaterThan(html.indexOf("<div>Worker</div>"));
  });

  it("shows Fleet errors below the agent list, not above its rows", () => {
    mocks.error = "Fleet refresh failed";
    const html = renderToStaticMarkup(<FleetBoard {...props()} />);
    const statusIndex = html.indexOf('data-slot="fleet-status"');
    expect(statusIndex).toBeGreaterThan(html.indexOf("<div>Worker</div>"));
    expect(html.indexOf(mocks.error)).toBeGreaterThan(statusIndex);
    expect(html).toContain('role="status"');
  });

  it.each(["background", "opencode"])("attaches %s rows in the middle", (kind) => {
    const current = { ...agent, kind };
    mocks.agents = [current];
    const callbacks = props();
    renderToStaticMarkup(<FleetBoard {...callbacks} />);
    mocks.rows[0].onClick?.();
    expect(callbacks.onAttachAgentHere).not.toHaveBeenCalled();
    mocks.rows[0].onClick?.();
    expect(callbacks.onAttachAgentHere).toHaveBeenNthCalledWith(1, current);
    expect(mocks.markSeen).toHaveBeenCalledWith(current.sessionId);
    expect(callbacks.onAttachAgent).not.toHaveBeenCalled();
  });

  it("routes interactive sessions to their existing terminal without detaching the middle", () => {
    mocks.agents = [{ ...agent, kind: "interactive" }];
    const callbacks = props();
    renderToStaticMarkup(<FleetBoard {...callbacks} />);
    mocks.rows[0].onClick?.();
    expect(callbacks.onAttachAgentHere).not.toHaveBeenCalled();
    mocks.rows[0].onClick?.();
    expect(callbacks.onAttachAgentHere).toHaveBeenCalledWith(mocks.agents[0]);
    expect(callbacks.onCloseTerminal).not.toHaveBeenCalled();
  });

  it.each<[string, string | null]>([
    ["background", null],
    ["background", "blocked"],
    ["background", "succeeded"],
    ["opencode", null],
    ["opencode", "blocked"],
    ["opencode", "succeeded"],
  ])("loads idle %s agents with state %s in the middle", (kind, state) => {
    const current = { ...agent, kind, state, status: "idle", waitingFor: null };
    mocks.agents = [current];
    const callbacks = props();
    renderToStaticMarkup(<FleetBoard {...callbacks} />);
    mocks.rows[0].onClick?.();
    expect(callbacks.onAttachAgentHere).not.toHaveBeenCalled();
    mocks.rows[0].onClick?.();
    expect(callbacks.onAttachAgentHere).toHaveBeenCalledWith(current);
    expect(callbacks.onCloseTerminal).not.toHaveBeenCalled();
  });

  it("does not detach the middle terminal when an interactive lookup fails", async () => {
    mocks.agents = [{ ...agent, kind: "interactive" }];
    const callbacks = props();
    callbacks.onAttachAgentHere.mockRejectedValue(new Error("Not found in Terax"));
    renderToStaticMarkup(<FleetBoard {...callbacks} />);
    mocks.rows[0].onClick?.();
    mocks.rows[0].onClick?.();
    await Promise.resolve();
    expect(callbacks.onCloseTerminal).not.toHaveBeenCalled();
  });

  it("puts gone sessions under a collapsed native disclosure without disrupting the middle", () => {
    const gone = { ...agent, sessionId: "gone-session", name: "Gone worker" };
    mocks.remembered = { [gone.sessionId]: gone };
    const callbacks = props();
    const html = renderToStaticMarkup(<FleetBoard {...callbacks} />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Recent / gone · 1");
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
    const row = mocks.rows.find((r) => r.gone)!;
    row.onClick?.();
    expect(callbacks.onAttachAgentHere).not.toHaveBeenCalled();
    expect(callbacks.onCloseTerminal).not.toHaveBeenCalled();
    expect(row.onResume).toBeDefined();
    expect(row.onForget).toBeDefined();
  });

  it.each([true, false])("sets visibility and keyboard focus to %s", (visible) => {
    const callbacks = props();
    const terminal = {
      sessionId: agent.sessionId,
      leafId: -5,
      cwd: agent.cwd,
      title: agent.name,
      command: "claude attach worker",
    };
    const html = renderToStaticMarkup(
      <FleetBoard {...callbacks} visible={visible} agentTerminal={terminal} />,
    );
    expect(html).toContain("Attached agent terminal");
    expect(html).toContain("Detach agent terminal");
    expect(mocks.terminals[0]).toMatchObject({
      leafId: -5,
      visible,
      focused: visible,
      initialCwd: agent.cwd,
      restartCommand: terminal.command,
      launchWithoutMarker: true,
      onExit: callbacks.onCloseTerminal,
    });
    expect(mocks.rows[0].selected).toBe(true);
  });

  it("keeps the terminal attached when the permission has been answered", () => {
    mocks.agents = [{ ...agent, waitingFor: null }];
    const callbacks = props();
    renderToStaticMarkup(
      <FleetBoard {...callbacks} agentTerminal={{
        sessionId: agent.sessionId,
        leafId: -5,
        cwd: agent.cwd,
        title: agent.name,
        command: "claude attach worker",
      }} />,
    );
    expect(mocks.terminals).toHaveLength(1);
    expect(callbacks.onCloseTerminal).not.toHaveBeenCalled();
  });

  it("keeps the old attachment and its status on the first click, then switches on the second", () => {
    const next = { ...agent, sessionId: "next-agent", name: "Next worker", waitingFor: "question" };
    mocks.agents = [{ ...agent, waitingFor: null }, next];
    const callbacks = props();
    const terminal = {
      sessionId: agent.sessionId,
      leafId: -5,
      cwd: agent.cwd,
      title: agent.name,
      command: "claude attach worker",
    };
    renderToStaticMarkup(<FleetBoard {...callbacks} agentTerminal={terminal} />);
    const nextRow = mocks.rows.find((row) => row.agent.sessionId === next.sessionId)!;
    nextRow.onClick?.();
    expect(callbacks.onAttachAgentHere).not.toHaveBeenCalled();
    expect(callbacks.onCloseTerminal).not.toHaveBeenCalled();
    expect(mocks.terminals[0].restartCommand).toBe(terminal.command);
    nextRow.onClick?.();
    expect(callbacks.onAttachAgentHere).toHaveBeenCalledOnce();
    expect(callbacks.onAttachAgentHere).toHaveBeenCalledWith(next);
  });

  it("requires another click when selection changes between agents", () => {
    const next = { ...agent, sessionId: "next-agent", name: "Next worker" };
    mocks.agents = [agent, next];
    const callbacks = props();
    renderToStaticMarkup(<FleetBoard {...callbacks} />);
    const [firstRow, nextRow] = mocks.rows;
    firstRow.onClick?.();
    nextRow.onClick?.();
    firstRow.onClick?.();
    expect(callbacks.onAttachAgentHere).not.toHaveBeenCalled();
    firstRow.onClick?.();
    expect(callbacks.onAttachAgentHere).toHaveBeenCalledWith(agent);
  });

  it("accepts a quick double-click before React re-renders and attaches only once", () => {
    const callbacks = props();
    renderToStaticMarkup(<FleetBoard {...callbacks} />);
    const click = mocks.rows[0].onClick!;
    click();
    expect(callbacks.onAttachAgentHere).not.toHaveBeenCalled();
    click();
    expect(callbacks.onAttachAgentHere).toHaveBeenCalledOnce();
    expect(callbacks.onAttachAgentHere).toHaveBeenCalledWith(agent);
  });
});
