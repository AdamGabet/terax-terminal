import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ensureMonoFontsLoaded } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  connectSsh,
  currentWorkspaceEnv,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { DormantRing } from "./dormantRing";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
} from "./osc-handlers";
import { openPty, type PtySession, type TmuxLaunch } from "./pty-bridge";
import {
  acquireSlot,
  applyBackgroundActive,
  applyFontFamily,
  applyFontSize,
  applyLetterSpacing,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyWebglPreference,
  configureRendererPool,
  focusSlot,
  getSlotForLeaf,
  releaseSlot,
  setSlotFocused,
} from "./rendererPool";

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

type Session = {
  pty: PtySession | null;
  ptyOpening: boolean;
  initialCwd: string | undefined;
  lastCwd: string | null;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  cols: number;
  rows: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  searchQuery: string | null;
  dormantRing: DormantRing;
  hasSlot: boolean;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the most recent release. Read once on the next bind to trigger a
  // SIGWINCH-driven repaint instead of replaying dormant bytes.
  altScreenAtRelease: boolean;
  // Workspace env captured when the session was created. Used on exit to tell
  // an SSH connection drop apart from a clean local/remote shell exit, and to
  // pick which sessions to respawn on reconnect.
  workspaceAtOpen: WorkspaceEnv;
  tmux?: TmuxLaunch;
};

const sessions = new Map<number, Session>();

const readyLeaves = new Set<number>();
const readyWaiters = new Map<
  number,
  { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]
>();

function markSessionReady(leafId: number): void {
  if (readyLeaves.has(leafId)) return;
  readyLeaves.add(leafId);
  const waiters = readyWaiters.get(leafId);
  if (!waiters) return;
  readyWaiters.delete(leafId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function whenSessionReady(
  leafId: number,
  timeoutMs = 4000,
): Promise<void> {
  if (readyLeaves.has(leafId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = readyWaiters.get(leafId);
      const i = arr?.findIndex((w) => w.timer === timer) ?? -1;
      if (arr && i >= 0) arr.splice(i, 1);
      resolve();
    }, timeoutMs);
    const arr = readyWaiters.get(leafId) ?? [];
    arr.push({ resolve, timer });
    readyWaiters.set(leafId, arr);
  });
}

export function writeToSession(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  if (!s || !s.pty) return false;
  void s.pty.write(data);
  return true;
}

/**
 * Clear the scrollback and screen of the currently focused terminal, keeping
 * the active prompt line — macOS Terminal's ⌘K behaviour. Returns false when no
 * focused terminal slot is bound (e.g. focus is in the editor or AI panel).
 */
export function clearFocusedTerminal(): boolean {
  for (const [leafId, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow) continue;
    const slot = getSlotForLeaf(leafId);
    if (!slot) continue;
    slot.term.clear();
    return true;
  }
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  for (const [leafId, s] of sessions) {
    if (s.pty?.id === ptyId) return leafId;
  }
  return null;
}

// Out-of-band cwd updates for SSH terminals: the backend polls the remote
// shell's real cwd (works for any shell, OSC 7 or not) and pushes changes.
// Routed through the same callback as the OSC 7 handler.
void listen<{ id: number; cwd: string }>("terax:ssh-cwd", (event) => {
  const leafId = leafIdForPty(event.payload.id);
  if (leafId === null) return;
  const s = sessions.get(leafId);
  if (!s) return;
  markSessionReady(leafId);
  if (s.lastCwd === event.payload.cwd) return;
  s.lastCwd = event.payload.cwd;
  s.callbacks.onCwd?.(event.payload.cwd);
});

configureRendererPool({
  resolveLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return null;
    return {
      writeToPty: (data) => {
        s.pty?.write(data);
      },
      resizePty: (cols, rows) => {
        s.cols = cols;
        s.rows = rows;
        s.pty?.resize(cols, rows);
      },
      kickPty: (cols, rows) => {
        const pty = s.pty;
        if (!pty || cols <= 0 || rows <= 0) return;
        // Linux only emits SIGWINCH when the winsize ioctl actually
        // changes dims, so bump +1 row then restore. The TUI receives
        // (possibly two) SIGWINCHes and repaints from scratch.
        pty
          .resize(cols, rows + 1)
          .then(() => pty.resize(cols, rows))
          .catch((e) => console.warn("[terax] kickPty failed:", e));
      },
    };
  },
  evictLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return;
    unbindLeafFromSlot(leafId, s);
  },
  isLeafFocused(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.visibleNow && s.focusedNow;
  },
  getLeafCwd(leafId) {
    const s = sessions.get(leafId);
    return s ? (s.lastCwd ?? s.initialCwd ?? null) : null;
  },
});

function ensureSession(leafId: number, initialCwd?: string): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const session: Session = {
    pty: null,
    ptyOpening: false,
    initialCwd,
    lastCwd: null,
    pendingExit: null,
    shellExited: false,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    cols: 0,
    rows: 0,
    container: null,
    snapshot: null,
    searchQuery: null,
    dormantRing: new DormantRing(),
    hasSlot: false,
    altScreenAtRelease: false,
    workspaceAtOpen: currentWorkspaceEnv(),
  };
  sessions.set(leafId, session);

  session.ready = (async () => {
    await ensureMonoFontsLoaded();
    await document.fonts.ready;
  })();

  return session;
}

function configureSessionLaunch(s: Session, tmux?: TmuxLaunch): void {
  if (!s.pty && !s.ptyOpening && !s.shellExited) s.tmux = tmux;
}

function deliverPtyBytes(leafId: number, bytes: Uint8Array): void {
  const s = sessions.get(leafId);
  if (!s) return;
  const slot = getSlotForLeaf(leafId);
  if (slot) slot.term.write(bytes);
  else s.dormantRing.push(bytes);
}

async function openPtyForSession(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<PtySession> {
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  return openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => deliverPtyBytes(leafId, bytes),
      onExit: (code) => {
        s.shellExited = true;
        s.pty = null;
        const slot = getSlotForLeaf(leafId);
        if (slot) slot.term.options.disableStdin = true;
        // SSH connection drop (VPN/network blip): the local `ssh -t` exits
        // non-zero (255 = ssh fatal/connection-lost). Keep the pane and its
        // scrollback, surface a Reconnect affordance, and DON'T fall through to
        // the normal exit path (which closes/respawns the pane). A clean logout
        // (`exit`, code 0) is handled normally. `readyLeaves` gates out hosts
        // that never connected so we don't offer reconnect on a bad spawn.
        const env = s.workspaceAtOpen;
        if (env.kind === "ssh" && readyLeaves.has(leafId) && code !== 0) {
          deliverPtyBytes(
            leafId,
            new TextEncoder().encode(
              `\r\n\x1b[2m[terax] Connection to ${env.host} lost — reconnecting…\x1b[0m\r\n`,
            ),
          );
          notifySshDropped();
          return;
        }
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    },
    cwd,
    s.tmux,
  );
}

function bindLeafToSlot(leafId: number, s: Session): void {
  if (!s.container) return;
  const altScreen = s.altScreenAtRelease;
  s.altScreenAtRelease = false;
  acquireSlot({
    leafId,
    container: s.container,
    snapshot: s.snapshot,
    altScreen,
    drainRing: (write) => s.dormantRing.drain(write),
    shellExited: s.shellExited,
    searchQuery: s.searchQuery,
    cols: s.cols,
    rows: s.rows,
    registerOsc: (term) => {
      // Shared in-command flag — see osc-handlers.ts. The prompt tracker
      // flips it on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC
      // 7 emitted by untrusted command output (remote SSH, `cat` of an
      // attacker file, etc.).
      const shellState = createShellIntegrationState();
      const prompt = registerPromptTracker(term, shellState);
      const cwd = registerCwdHandler(
        term,
        (next) => {
          markSessionReady(leafId);
          if (s.lastCwd === next) return;
          s.lastCwd = next;
          s.callbacks.onCwd?.(next);
        },
        shellState,
      );
      return [prompt.dispose, cwd];
    },
    onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
  });
  s.snapshot = null;
  s.hasSlot = true;
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindLeafFromSlot(leafId: number, s: Session): void {
  if (!s.hasSlot) return;
  const out = releaseSlot(leafId);
  if (out) {
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
    s.altScreenAtRelease = out.altScreen;
  }
  s.hasSlot = false;
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  s.container = container;

  if (s.visibleNow) bindLeafToSlot(leafId, s);

  if (!s.pty && !s.ptyOpening && !s.shellExited) {
    s.ptyOpening = true;
    openPtyForSession(leafId, s, s.initialCwd)
      .then((pty) => {
        s.ptyOpening = false;
        if (s.disposed) {
          pty.close();
          return;
        }
        s.pty = pty;
        if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
      })
      .catch((e) => {
        s.ptyOpening = false;
        console.error("[terax] openPty failed:", e);
        showSpawnError(leafId, s, e);
      });
  }
}

/**
 * Surface a failed pty spawn inside the terminal view (red notice) instead of
 * leaving a silently-blank pane. The common case is an SSH host that became
 * unreachable (VPN/network drop) — `ssh::ensure_reachable` rejects the spawn so
 * a dead connection can't pile up. The shell is marked exited so the pane can
 * be respawned (e.g. after reconnecting) via the normal restart path.
 */
function showSpawnError(leafId: number, s: Session, e: unknown): void {
  s.shellExited = true;
  s.pty = null;
  const slot = getSlotForLeaf(leafId);
  if (slot) slot.term.options.disableStdin = true;
  const msg = String(e instanceof Error ? e.message : e).trim();
  deliverPtyBytes(
    leafId,
    new TextEncoder().encode(`\r\n\x1b[31m[terax] ${msg}\x1b[0m\r\n`),
  );
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  unbindLeafFromSlot(leafId, s);
  s.callbacks = {};
  s.container = null;
}

/**
 * Open a fresh shell in an existing session. By default ("restart") it clears
 * the screen and scrollback. With `preserveHistory` (the SSH-reconnect path) it
 * keeps the visible scrollback and appends a "Reconnected" banner — the new
 * remote shell's prompt lands below the old output. The backend transparently
 * rebuilds the SSH master/agent when the new pty spawns.
 */
export async function respawnSession(
  leafId: number,
  cwd?: string,
  opts?: { preserveHistory?: boolean },
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  const preserve = opts?.preserveHistory ?? false;
  s.pty?.close();
  s.pty = null;
  s.shellExited = false;
  s.pendingExit = null;

  const slot = getSlotForLeaf(leafId);
  if (slot) slot.term.options.disableStdin = false;
  if (!preserve) {
    s.snapshot = null;
    s.dormantRing = new DormantRing();
    s.altScreenAtRelease = false;
    if (slot) {
      slot.term.clear();
      slot.term.reset();
    }
  }

  s.ptyOpening = true;
  let pty: PtySession;
  try {
    const startCwd =
      cwd ?? (preserve ? (s.lastCwd ?? s.initialCwd) : s.initialCwd);
    pty = await openPtyForSession(leafId, s, startCwd ?? undefined);
  } catch (e) {
    s.ptyOpening = false;
    console.error("[terax] respawn openPty failed:", e);
    // preserve: host still unreachable — keep the disconnected state so the
    // Reconnect affordance stays for another attempt. Otherwise show the error.
    if (preserve) {
      s.shellExited = true;
      if (slot) slot.term.options.disableStdin = true;
      throw e;
    }
    showSpawnError(leafId, s, e);
    return;
  }
  s.ptyOpening = false;
  if (s.disposed) {
    pty.close();
    return;
  }
  s.pty = pty;
  if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
  if (preserve) {
    deliverPtyBytes(
      leafId,
      new TextEncoder().encode(`\x1b[2m[terax] Reconnected.\x1b[0m\r\n`),
    );
  }
}

// Auto-reconnect backoff: attempt at +1s, +3s, +10s, +30s after a drop, then
// stop and wait for a manual "Reconnect" click.
const AUTO_BACKOFF_MS = [1000, 3000, 10000, 30000];
let autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let autoReconnectStep = 0;

function clearAutoReconnect(): void {
  if (autoReconnectTimer) {
    clearTimeout(autoReconnectTimer);
    autoReconnectTimer = null;
  }
  autoReconnectStep = 0;
  useWorkspaceEnvStore.getState().setNextAttemptAt(null);
}

function scheduleAutoReconnect(): void {
  if (autoReconnectTimer) return; // an attempt is already queued
  if (autoReconnectStep >= AUTO_BACKOFF_MS.length) {
    // Auto-retries exhausted — clear the countdown; manual only from here.
    useWorkspaceEnvStore.getState().setNextAttemptAt(null);
    return;
  }
  const delay = AUTO_BACKOFF_MS[autoReconnectStep];
  useWorkspaceEnvStore.getState().setNextAttemptAt(Date.now() + delay);
  autoReconnectTimer = setTimeout(() => {
    autoReconnectTimer = null;
    autoReconnectStep += 1;
    useWorkspaceEnvStore.getState().setNextAttemptAt(null); // attempt in flight
    void attemptReconnect(true);
  }, delay);
}

/**
 * One reconnect attempt: re-establish the master/agent, respawn every dropped
 * SSH shell (history preserved), then bump the reconnect generation so open
 * remote file tabs re-read. On failure, an auto attempt queues the next backoff
 * step; a manual attempt just stays disconnected.
 */
async function attemptReconnect(auto: boolean): Promise<void> {
  const store = useWorkspaceEnvStore.getState();
  const env = store.env;
  if (env.kind !== "ssh") {
    clearAutoReconnect();
    return;
  }
  if (store.sshStatus === "reconnecting") return; // attempt already in flight
  store.setReconnectAttempts(store.reconnectAttempts + 1);
  store.setSshStatus("reconnecting");
  try {
    await connectSsh(env.host);
    const dropped = [...sessions.keys()].filter((leafId) => {
      const s = sessions.get(leafId);
      return s?.workspaceAtOpen.kind === "ssh" && s.shellExited && !s.disposed;
    });
    const results = await Promise.allSettled(
      dropped.map((leafId) =>
        respawnSession(leafId, undefined, { preserveHistory: true }),
      ),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (failed && failed.status === "rejected") throw failed.reason;
    useWorkspaceEnvStore.getState().bumpReconnectGeneration();
    useWorkspaceEnvStore.getState().setReconnectAttempts(0);
    useWorkspaceEnvStore.getState().setSshStatus("connected");
    clearAutoReconnect();
  } catch (e) {
    console.error("[terax] ssh reconnect failed:", e);
    useWorkspaceEnvStore.getState().setSshStatus("disconnected");
    if (auto) scheduleAutoReconnect();
  }
}

/**
 * Called when an SSH terminal drops. Flips the window to "disconnected" and, on
 * the first drop of a connected session, starts the auto-reconnect backoff.
 */
function notifySshDropped(): void {
  const store = useWorkspaceEnvStore.getState();
  if (store.env.kind !== "ssh") return;
  if (store.sshStatus !== "connected") return; // already handling a drop
  store.setReconnectAttempts(0);
  store.setSshStatus("disconnected");
  clearAutoReconnect();
  scheduleAutoReconnect();
}

/**
 * Manual reconnect ("retry now"): cancel any pending auto-retry, attempt once,
 * and do NOT resume auto-retries afterward — the user is in control.
 */
export function reconnectSsh(): void {
  clearAutoReconnect();
  autoReconnectStep = AUTO_BACKOFF_MS.length; // block auto from resuming
  void attemptReconnect(false);
}

export async function leafHasForegroundProcess(
  leafId: number,
): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return false;
  try {
    const result = await invoke<boolean>("pty_has_foreground_process", {
      id: s.pty.id,
    });
    return result;
  } catch (e) {
    console.error(
      "[terax] pty_has_foreground_process failed for leaf",
      leafId,
      e,
    );
    return false;
  }
}

export function disposeSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.disposed = true;
  unbindLeafFromSlot(leafId, s);
  s.snapshot = null;
  s.pty?.close();
  s.pty = null;
  sessions.delete(leafId);
  readyLeaves.delete(leafId);
  const waiters = readyWaiters.get(leafId);
  if (waiters) {
    readyWaiters.delete(leafId);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

type Options = {
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  tmux?: TmuxLaunch;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  tmux,
  onSearchReady,
  onExit,
  onCwd,
}: Options) {
  const cbRef = useRef({ onSearchReady, onExit, onCwd });
  cbRef.current = { onSearchReady, onExit, onCwd };

  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(leafId, initialCwd);
    configureSessionLaunch(s, tmux);
    s.ready.then(() => {
      if (cancelled || s.disposed) return;
      const node = container.current;
      if (!node) return;
      attachSession(leafId, node, {
        onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
        onExit: (c) => cbRef.current.onExit?.(c),
        onCwd: (c) => cbRef.current.onCwd?.(c),
      });
      if (s.visibleNow && s.focusedNow) focusSlot(leafId);
    });
    return () => {
      cancelled = true;
      detachSession(leafId);
    };
  }, [leafId, container, initialCwd, tmux]);

  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useEffect(() => {
    applyFontSize(Math.max(4, Math.round(fontSize * zoomLevel)));
  }, [fontSize, zoomLevel]);

  const fontFamily = usePreferencesStore((p) => p.terminalFontFamily);
  useEffect(() => {
    applyFontFamily(fontFamily);
  }, [fontFamily]);

  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  useEffect(() => {
    applyLetterSpacing(letterSpacing);
  }, [letterSpacing]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  const bgActive = usePreferencesStore(
    (p) => p.backgroundKind === "image" && !!p.backgroundImageId,
  );
  useEffect(() => {
    applyBackgroundActive(bgActive);
  }, [bgActive]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    if (visible) {
      if (s.container && !s.hasSlot) bindLeafToSlot(leafId, s);
      setSlotFocused(leafId, focused);
      if (focused) focusSlot(leafId);
    } else if (s.hasSlot) {
      unbindLeafFromSlot(leafId, s);
    }
  }, [leafId, visible, focused]);

  const write = useCallback(
    (data: string) => sessions.get(leafId)?.pty?.write(data),
    [leafId],
  );

  const focus = useCallback(() => focusSlot(leafId), [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const slot = getSlotForLeaf(leafId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForLeaf(leafId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  return useMemo(
    () => ({ write, focus, getBuffer, getSelection, applyTheme }),
    [write, focus, getBuffer, getSelection, applyTheme],
  );
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
