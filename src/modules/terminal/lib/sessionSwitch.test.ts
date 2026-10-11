import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyHandlers } from "./pty-bridge";
import { disposeSession, useTerminalSession } from "./useTerminalSession";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  handlers: [] as PtyHandlers[],
  slot: { term: { options: { disableStdin: false }, write: vi.fn() } },
  release: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
}));

// Exercise the terminal hook's real mount/cleanup and PTY event boundaries
// without loading xterm or a browser renderer.
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: async () => {} }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  connectSsh: vi.fn(),
  useWorkspaceEnvStore: (select: (state: unknown) => unknown) => select({ env: { kind: "local" } }),
}));
vi.mock("@/modules/agents/store/agentStore", () => ({
  useAgentStore: { getState: () => ({ sessions: {} }) },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (state: unknown) => unknown) => select({
    terminalFontSize: 14, zoomLevel: 1, terminalFontFamily: "mono",
    terminalLetterSpacing: 0, terminalScrollback: 100, terminalWebglEnabled: false,
  }),
}));
vi.mock("./rendererPool", () => ({
  acquireSlot: vi.fn(),
  releaseSlot: mocks.release,
  getSlotForLeaf: () => mocks.slot,
  focusSlot: vi.fn(),
  setSlotFocused: vi.fn(),
  configureRendererPool: vi.fn(),
  applyBackgroundActive: vi.fn(),
  applyFontFamily: vi.fn(),
  applyFontSize: vi.fn(),
  applyLetterSpacing: vi.fn(),
  applyTheme: vi.fn(),
  applyScrollback: vi.fn(),
  applyWebglPreference: vi.fn(),
}));
vi.mock("./pty-bridge", () => ({
  openPty: async (_cols: number, _rows: number, handlers: PtyHandlers) => {
    mocks.handlers.push(handlers);
    return { id: mocks.handlers.length, close: mocks.close, write: mocks.write, resize: vi.fn() };
  },
}));

async function mount(leafId: number, command: string, onExit = vi.fn()) {
  mocks.effects = [];
  useTerminalSession({
    leafId,
    container: { current: {} as HTMLDivElement },
    visible: true,
    focused: true,
    restartCommand: command,
    launchWithoutMarker: true,
    onExit,
  });
  const cleanups = mocks.effects.map((effect) => effect());
  for (let i = 0; i < 4; i++) await Promise.resolve();
  return () => cleanups.forEach((cleanup) => cleanup?.());
}

describe("switching terminal attachments", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { fonts: { ready: Promise.resolve() } });
    mocks.handlers = [];
    mocks.slot.term.options.disableStdin = false;
    mocks.slot.term.write.mockClear();
    mocks.release.mockClear();
    mocks.close.mockClear();
    mocks.write.mockClear();
  });

  afterEach(() => {
    disposeSession(-101);
    disposeSession(-102);
    vi.unstubAllGlobals();
  });

  it("ignores the previous client's late output and exit while the new client launches", async () => {
    const oldExit = vi.fn();
    const oldCleanup = await mount(-101, "claude attach old", oldExit);
    const old = mocks.handlers[0];
    disposeSession(-101);
    const newExit = vi.fn();
    await mount(-102, "claude attach new", newExit);
    oldCleanup();
    old.onData(new TextEncoder().encode("stale old output"));
    old.onExit?.(0);
    expect(oldExit).not.toHaveBeenCalled();
    expect(newExit).not.toHaveBeenCalled();
    expect(mocks.slot.term.options.disableStdin).toBe(false);
    expect(mocks.slot.term.write).not.toHaveBeenCalled();
    mocks.handlers[1].onData(new TextEncoder().encode("\x1b]133;S;sh\x07"));
    expect(mocks.write).toHaveBeenCalledWith("claude attach new\r");
  });

  it("does not detach a replacement when an old cleanup runs for the same leaf id", async () => {
    const oldCleanup = await mount(-101, "claude attach old");
    const old = mocks.handlers[0];
    disposeSession(-101);
    const newExit = vi.fn();
    await mount(-101, "claude attach new", newExit);
    mocks.release.mockClear();
    oldCleanup();
    expect(mocks.release).not.toHaveBeenCalled();
    old.onData(new TextEncoder().encode("stale old output"));
    old.onExit?.(0);
    expect(mocks.slot.term.options.disableStdin).toBe(false);
    expect(mocks.slot.term.write).not.toHaveBeenCalled();
    mocks.handlers[1].onExit?.(0);
    expect(newExit).toHaveBeenCalledWith(0);
  });
});
