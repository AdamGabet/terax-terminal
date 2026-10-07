import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { rtlRanges } from "./bidiRanges";
import { pasteClipboard } from "./clipboardPaste";
import { createFileLinkProvider } from "./fileLinks";
import { registerClipboardHandler } from "./osc-handlers";
import {
  terminalDeleteSequence,
  terminalLineNavigationSequence,
  terminalWordNavigationSequence,
} from "./keymap";

export const POOL_MAX_SIZE = 6;
const FIT_DEBOUNCE_MS = 8;
const PTY_RESIZE_DEBOUNCE_MS = 256;
const SNAPSHOT_SCROLLBACK_CAP = 5_000;
const TERMINAL_SCROLL_SENSITIVITY = 0.75;
const TERMINAL_FAST_SCROLL_SENSITIVITY = 4;
const TERMINAL_SMOOTH_SCROLL_MS = 80;

export type SlotAdapter = {
  resolveLeaf(leafId: number): LeafBridge | null;
  evictLeaf(leafId: number): void;
  isLeafFocused(leafId: number): boolean;
  /** Last-known cwd of the leaf's shell (OSC 7 / SSH poll), for file links. */
  getLeafCwd(leafId: number): string | null;
};

export type LeafBridge = {
  writeToPty(data: string): void;
  resizePty(cols: number, rows: number): void;
  // Force a SIGWINCH on the underlying PTY at the given dims. Implemented
  // as a +1 row / restore bump because the Linux kernel suppresses winsize
  // ioctls that don't actually change the size. Used to make alt-screen
  // TUIs repaint from scratch after they were dormant.
  kickPty(cols: number, rows: number): void;
};

export type Slot = {
  readonly id: number;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  readonly serializeAddon: SerializeAddon;
  readonly host: HTMLDivElement;
  webglAddon: WebglAddon | null;
  webglCanvases: HTMLCanvasElement[];
  currentLeafId: number | null;
  oscDisposers: (() => void)[];
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  unhideRaf: number | null;
  lastCols: number;
  lastRows: number;
  lastW: number;
  lastH: number;
  lastUsedAt: number;
};

const slots: Slot[] = [];
let recyclerEl: HTMLDivElement | null = null;
let adapter: SlotAdapter | null = null;

export function configureRendererPool(a: SlotAdapter): void {
  adapter = a;
}

export function forEachSlot(fn: (slot: Slot) => void): void {
  for (const s of slots) fn(s);
}

export function poolSize(): number {
  return slots.length;
}

// Bracketed paste via xterm, so an app that enabled it (Claude Code) treats a
// dropped path as a real paste while a plain shell gets the literal text.
export function pasteIntoLeaf(leafId: number, text: string): boolean {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return false;
  slot.term.paste(text);
  return true;
}

function getRecycler(): HTMLDivElement {
  if (recyclerEl && recyclerEl.isConnected) return recyclerEl;
  const el = document.createElement("div");
  el.setAttribute("data-terax-recycler", "");
  el.style.cssText =
    "position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;overflow:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(el);
  recyclerEl = el;
  return el;
}

const MCR_BG_ACTIVE = 4.5;
const MCR_BG_INACTIVE = 1;

function bgActive(
  prefs: ReturnType<typeof usePreferencesStore.getState>,
): boolean {
  return prefs.backgroundKind === "image" && !!prefs.backgroundImageId;
}

/** The font the user asked for, before it is snapped to the cell grid. */
function requestedFont(): { family: string; size: number } {
  const prefs = usePreferencesStore.getState();
  return {
    family: prefs.terminalFontFamily || detectMonoFontFamily(),
    size: Math.max(4, Math.round(prefs.terminalFontSize * prefs.zoomLevel)),
  };
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Nudge the font size so one character's advance lands on a whole device pixel.
 *
 * The WebGL renderer floors the cell width to a whole device pixel while the
 * font's real advance is fractional — Menlo 14px at dpr 2 is 8.429px in an 8px
 * cell, 5.36% of drift per character. One glyph per cell hides that, but a
 * character-joined RTL run is drawn as a single string and overflows its cell
 * box, so the glyph atlas crops the tail and letters go missing at the end of
 * the run. 14 → 14.12 takes the drift to 0.01%/char, far too small to see.
 */
function snapFontSize(size: number, family: string): number {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  const ctx = measureCtx;
  if (!ctx) return size;

  const driftAt = (value: number): number => {
    ctx.font = `${value}px ${family}`;
    const advance = ctx.measureText("x").width;
    const cell = Math.floor(advance * devicePixelRatio) / devicePixelRatio;
    return cell > 0 ? (advance - cell) / cell : Infinity;
  };

  let best = size;
  let bestDrift = driftAt(size);
  for (let candidate = size - 0.5; candidate <= size + 0.5; candidate += 0.01) {
    const drift = driftAt(candidate);
    if (drift < bestDrift) {
      bestDrift = drift;
      best = Number(candidate.toFixed(2));
    }
  }
  return best;
}

function applyFontOnSlot(slot: Slot, family: string, size: number): void {
  const snapped = snapFontSize(size, family);
  if (
    slot.term.options.fontFamily === family &&
    slot.term.options.fontSize === snapped
  ) {
    return;
  }
  slot.term.options.fontFamily = family;
  slot.term.options.fontSize = snapped;
  slot.fitAddon.fit();
  syncPtySize(slot);
}

// The snapped size is only right for the display the window is on, so it has to
// be recomputed when the window moves between monitors of different densities.
let dprQuery: MediaQueryList | null = null;
function watchDevicePixelRatio(): void {
  dprQuery?.removeEventListener("change", onDevicePixelRatioChange);
  dprQuery = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  dprQuery.addEventListener("change", onDevicePixelRatioChange);
}
function onDevicePixelRatioChange(): void {
  const font = requestedFont();
  for (const slot of slots) applyFontOnSlot(slot, font.family, font.size);
  watchDevicePixelRatio();
}

function termOptions() {
  const prefs = usePreferencesStore.getState();
  const font = requestedFont();
  return {
    fontFamily: font.family,
    letterSpacing: prefs.terminalLetterSpacing,
    fontSize: snapFontSize(font.size, font.family),
    theme: buildTerminalTheme(),
    cursorBlink: false,
    cursorStyle: "bar" as const,
    cursorInactiveStyle: "outline" as const,
    scrollback: prefs.terminalScrollback,
    scrollSensitivity: TERMINAL_SCROLL_SENSITIVITY,
    fastScrollSensitivity: TERMINAL_FAST_SCROLL_SENSITIVITY,
    smoothScrollDuration: TERMINAL_SMOOTH_SCROLL_MS,
    allowProposedApi: true,
    macOptionIsMeta: true,
    minimumContrastRatio: bgActive(prefs) ? MCR_BG_ACTIVE : MCR_BG_INACTIVE,
  };
}

export function applyBackgroundActive(active: boolean): void {
  const value = active ? MCR_BG_ACTIVE : MCR_BG_INACTIVE;
  for (const slot of slots) {
    if (slot.term.options.minimumContrastRatio === value) continue;
    slot.term.options.minimumContrastRatio = value;
  }
}

function createSlot(): Slot {
  if (!dprQuery) watchDevicePixelRatio();
  const term = new Terminal(termOptions());
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => openUrl(uri).catch(console.error)),
  );
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";
  host.setAttribute("data-terax-slot", String(slots.length));
  getRecycler().appendChild(host);
  term.open(host);
  // Bidi at paint time: the buffer stays in logical order (so selection, search
  // and serialization see real text) and the WebGL renderer draws each RTL run
  // as one fillText, letting the browser apply UAX #9 to it. Must come after
  // open() — the character joiner service does not exist until then.
  term.registerCharacterJoiner(rtlRanges);
  registerClipboardHandler(term, (text) => {
    void clipboardWriteText(text).catch(() => {});
  });

  const slot: Slot = {
    id: slots.length,
    term,
    fitAddon,
    searchAddon,
    serializeAddon,
    host,
    webglAddon: null,
    webglCanvases: [],
    currentLeafId: null,
    oscDisposers: [],
    observer: null,
    fitTimer: null,
    ptyTimer: null,
    unhideRaf: null,
    lastCols: term.cols,
    lastRows: term.rows,
    lastW: 0,
    lastH: 0,
    lastUsedAt: 0,
  };

  attachWebgl(slot);

  term.registerLinkProvider(
    createFileLinkProvider(term, () =>
      slot.currentLeafId === null
        ? null
        : (adapter?.getLeafCwd(slot.currentLeafId) ?? null),
    ),
  );

  term.attachCustomKeyEventHandler((event) => {
    // During IME composition the browser is assembling a multi-keystroke
    // character (Chinese pinyin → hanzi, Korean jamo → syllable, etc.).
    // Raw keydown events — including the Enter that commits a candidate —
    // must NOT be forwarded to the PTY; xterm will receive the final
    // composed string through its own compositionend handler instead.
    // keyCode 229 ("Process") is what Chromium reports for every key
    // pressed inside an active IME session when isComposing is not yet set.
    if (event.isComposing || event.keyCode === 229) return false;

    const leafId = slot.currentLeafId;
    if (leafId === null) return false;
    const bridge = adapter?.resolveLeaf(leafId);
    if (!bridge) return true;
    const lineNavigation = terminalLineNavigationSequence(event, {
      isMac: IS_MAC,
    });
    if (lineNavigation) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(lineNavigation);
      return false;
    }
    const wordNavigation = terminalWordNavigationSequence(event);
    if (wordNavigation) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(wordNavigation);
      return false;
    }
    const deleteSeq = terminalDeleteSequence(event, { isMac: IS_MAC });
    if (deleteSeq) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(deleteSeq);
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty("\x1b\r");
      return false;
    }
    if (isTerminalCopy(event) || isMacCopy(event)) {
      if (event.type === "keydown" && slot.term.hasSelection()) {
        const sel = slot.term.getSelection();
        // Write via the Tauri clipboard plugin: on macOS Cmd+C was never
        // intercepted before, so it relied on the webview's native DOM-selection
        // copy, which only fired when that selection happened to match xterm's
        // (hence "works sometimes"). The plugin copies the real selection every time.
        if (sel) void clipboardWriteText(sel).catch(() => {});
      }
      event.preventDefault();
      return false;
    }
    // Cmd+V normally stays native (the xterm textarea's paste event), but
    // that path is text-only. In SSH workspaces take over so a clipboard
    // image can be uploaded to the remote host and pasted as a path.
    if (
      isTerminalPaste(event) ||
      (isMacPaste(event) && currentWorkspaceEnv().kind === "ssh")
    ) {
      if (event.type === "keydown") {
        void pasteClipboard({
          paste: (text) => slot.term.paste(text),
          sendInput: (text) => bridge.writeToPty(text),
        });
      }
      event.preventDefault();
      return false;
    }
    return true;
  });

  term.onData((data) => {
    const leafId = slot.currentLeafId;
    if (leafId === null) return;
    adapter?.resolveLeaf(leafId)?.writeToPty(data);
  });

  slots.push(slot);
  return slot;
}

type PickResult = { slot: Slot; previousLeafId: number | null };

function isAltScreen(s: Slot): boolean {
  try {
    return s.term.buffer.active.type === "alternate";
  } catch {
    return false;
  }
}

function pickSlotFor(leafId: number): PickResult {
  const free = slots.find((s) => s.currentLeafId === null);
  if (free) return { slot: free, previousLeafId: null };
  if (slots.length < POOL_MAX_SIZE)
    return { slot: createSlot(), previousLeafId: null };

  let best: Slot | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (s.currentLeafId === leafId) return { slot: s, previousLeafId: null };
    const focused =
      s.currentLeafId !== null &&
      (adapter?.isLeafFocused(s.currentLeafId) ?? false);
    const score =
      (isAltScreen(s) ? 100 : 0) + (focused ? 10 : 0) + s.lastUsedAt / 1e12;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const chosen = best!;
  return { slot: chosen, previousLeafId: chosen.currentLeafId };
}

export type AcquireParams = {
  leafId: number;
  container: HTMLDivElement;
  snapshot: string | null;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the time it was released. When set, bindSlot skips ring replay
  // and kicks SIGWINCH so the TUI repaints from scratch.
  altScreen: boolean;
  drainRing: (write: (bytes: Uint8Array) => void) => void;
  shellExited: boolean;
  searchQuery: string | null;
  cols: number;
  rows: number;
  registerOsc: (term: Terminal) => (() => void)[];
  onSearchReady: (addon: SearchAddon) => void;
};

export function acquireSlot(params: AcquireParams): Slot {
  const existing = slots.find((s) => s.currentLeafId === params.leafId);
  if (existing) {
    rewireSlot(existing, params);
    return existing;
  }

  const pick = pickSlotFor(params.leafId);
  if (pick.previousLeafId !== null) {
    adapter?.evictLeaf(pick.previousLeafId);
  }
  if (
    pick.slot.currentLeafId !== null &&
    pick.slot.currentLeafId !== params.leafId
  ) {
    detachSlotFromLeaf(pick.slot);
  }
  bindSlot(pick.slot, params);
  return pick.slot;
}

function bindSlot(slot: Slot, p: AcquireParams): void {
  const stale =
    !slot.webglAddon || performance.now() - slot.lastUsedAt > SLOT_STALE_MS;
  slot.currentLeafId = p.leafId;
  slot.lastUsedAt = performance.now();

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "hidden";

  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }

  slot.term.options.disableStdin = p.shellExited;
  slot.term.clear();
  slot.term.reset();

  if (
    p.cols > 0 &&
    p.rows > 0 &&
    (slot.term.cols !== p.cols || slot.term.rows !== p.rows)
  ) {
    slot.term.resize(p.cols, p.rows);
  }

  if (p.snapshot) {
    try {
      slot.term.write(p.snapshot);
    } catch (e) {
      console.warn("[terax] snapshot replay failed:", e);
    }
  }
  if (p.altScreen) {
    // Discard the dormant ring. TUI output is incremental cursor-positioned
    // updates that can't be replayed coherently on top of a stale snapshot
    // — see the SIGWINCH kick below, which makes the TUI redraw from scratch.
    p.drainRing(() => {});
  } else {
    p.drainRing((bytes) => slot.term.write(bytes));
  }
  try {
    slot.term.write("\x1b[?25h");
  } catch {}

  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = p.registerOsc(slot.term);

  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.lastCols !== p.cols || slot.lastRows !== p.rows) {
    // resizePty updates session.cols/rows + pty backend; no separate scope call.
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
  }

  if (p.searchQuery) {
    try {
      slot.searchAddon.findNext(p.searchQuery);
    } catch {}
  }

  applyCursorBlinkOnSlot(slot, adapter?.isLeafFocused(p.leafId) ?? false);

  if (p.altScreen && !p.shellExited) {
    adapter?.resolveLeaf(p.leafId)?.kickPty(slot.term.cols, slot.term.rows);
  }

  scheduleUnhide(slot, stale);

  p.onSearchReady(slot.searchAddon);
}

function scheduleUnhide(slot: Slot, stale: boolean): void {
  slot.unhideRaf = requestAnimationFrame(() => {
    slot.unhideRaf = requestAnimationFrame(() => {
      slot.unhideRaf = null;
      slot.host.style.visibility = "";
      // The pane only has its final geometry once it is shown — a split or a
      // tab switch can still be settling when bindSlot fits. Reconcile here so
      // the grid and the PTY can't be left disagreeing after a re-show.
      slot.fitAddon.fit();
      syncPtySize(slot);
      if (stale) {
        if (!slot.webglAddon) attachWebgl(slot);
        try {
          slot.term.refresh(0, slot.term.rows - 1);
        } catch {}
      }
      const leafId = slot.currentLeafId;
      if (leafId !== null && adapter?.isLeafFocused(leafId)) {
        slot.term.focus();
      }
    });
  });
}

function cancelPendingUnhide(slot: Slot): void {
  if (slot.unhideRaf !== null) {
    cancelAnimationFrame(slot.unhideRaf);
    slot.unhideRaf = null;
  }
}

function rewireSlot(slot: Slot, p: AcquireParams): void {
  slot.lastUsedAt = performance.now();
  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }
  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.term.cols !== p.cols || slot.term.rows !== p.rows) {
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.term.cols, slot.term.rows);
  }
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  p.onSearchReady(slot.searchAddon);
}

// The PTY's winsize must converge on xterm's grid. While they disagree a TUI
// paints to a width the emulator doesn't have: full-width borders land a
// column off and stale cells are never overwritten, and nothing repairs it
// until some later resize happens to refit. Every path that can change the
// grid routes its PTY update through here.
function syncPtySize(slot: Slot): void {
  const leafId = slot.currentLeafId;
  if (leafId === null) return;
  if (slot.term.cols === slot.lastCols && slot.term.rows === slot.lastRows)
    return;
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  adapter?.resolveLeaf(leafId)?.resizePty(slot.lastCols, slot.lastRows);
}

// FitAddon derives cols/rows from the cell size xterm measured when the font
// was last applied. Re-measure before refitting so a font that loaded late
// doesn't leave the grid sized from fallback metrics.
function remeasureCell(slot: Slot): void {
  try {
    (
      slot.term as unknown as {
        _core?: { _charSizeService?: { measure(): void } };
      }
    )._core?._charSizeService?.measure();
  } catch {}
}

// A webfont that resolves after a terminal was opened changes the cell width
// under a grid that was already computed — xterm keeps the stale cols while
// painting wider or narrower glyphs. Refit every bound slot whenever fonts
// finish loading.
if (typeof document !== "undefined" && document.fonts?.addEventListener) {
  document.fonts.addEventListener("loadingdone", () => {
    for (const slot of slots) {
      if (slot.currentLeafId === null) continue;
      remeasureCell(slot);
      slot.fitAddon.fit();
      syncPtySize(slot);
    }
  });
}

function setupResizeObserver(slot: Slot, p: AcquireParams): void {
  slot.observer?.disconnect();
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  const container = p.container;
  const flushPty = () => {
    slot.ptyTimer = null;
    if (slot.currentLeafId !== p.leafId) return;
    syncPtySize(slot);
  };

  slot.observer = new ResizeObserver(() => {
    if (slot.fitTimer) clearTimeout(slot.fitTimer);
    slot.fitTimer = setTimeout(() => {
      slot.fitTimer = null;
      if (slot.currentLeafId !== p.leafId) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === slot.lastW && h === slot.lastH) return;
      slot.lastW = w;
      slot.lastH = h;
      slot.fitAddon.fit();
      if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
      slot.ptyTimer = setTimeout(flushPty, PTY_RESIZE_DEBOUNCE_MS);
    }, FIT_DEBOUNCE_MS);
  });
  slot.observer.observe(container);
}

export type SerializeOutput = {
  snapshot: string | null;
  cols: number;
  rows: number;
  altScreen: boolean;
};

export function releaseSlot(leafId: number): SerializeOutput | null {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return null;
  const out = serializeSlot(slot);
  detachSlotFromLeaf(slot);
  return out;
}

function serializeSlot(slot: Slot): SerializeOutput {
  let snapshot: string | null = null;
  try {
    const cap = Math.min(
      SNAPSHOT_SCROLLBACK_CAP,
      usePreferencesStore.getState().terminalScrollback,
    );
    snapshot = slot.serializeAddon.serialize({ scrollback: cap });
  } catch (e) {
    console.warn("[terax] serialize failed:", e);
  }
  return {
    snapshot,
    cols: slot.term.cols,
    rows: slot.term.rows,
    altScreen: isAltScreen(slot),
  };
}

function detachSlotFromLeaf(slot: Slot): void {
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = [];

  slot.observer?.disconnect();
  slot.observer = null;
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "";

  if (slot.host.parentNode !== getRecycler()) {
    getRecycler().appendChild(slot.host);
  }

  slot.currentLeafId = null;
  slot.lastUsedAt = performance.now();
}

const WEBGL_RECOVERY_DELAY_MS = 250;
// Below this a re-shown slot is fresh enough to trust; above it, repaint on
// unhide to defeat silent GPU/context staleness.
const SLOT_STALE_MS = 10_000;

function attachWebgl(slot: Slot): void {
  if (slot.webglAddon || !slot.term.element) return;
  if (!usePreferencesStore.getState().terminalWebglEnabled) return;
  const elem = slot.term.element;
  const before = new Set<HTMLCanvasElement>(
    elem.querySelectorAll<HTMLCanvasElement>("canvas"),
  );
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      const cur = slot.webglAddon;
      if (cur === webgl) {
        slot.webglAddon = null;
        slot.webglCanvases = [];
      }
      try {
        webgl.dispose();
      } catch {}
      // Recovery: WebKit may transiently lose contexts on sleep/wake or GPU
      // reset; without re-attach the slot would silently fall back to DOM
      // forever. Defer past WebKit's reset window before retrying.
      setTimeout(() => {
        if (slot.webglAddon) return;
        if (!usePreferencesStore.getState().terminalWebglEnabled) return;
        attachWebgl(slot);
        if (slot.webglAddon) {
          try {
            slot.term.refresh(0, slot.term.rows - 1);
          } catch {}
        }
      }, WEBGL_RECOVERY_DELAY_MS);
    });
    slot.term.loadAddon(webgl);
    const after = elem.querySelectorAll<HTMLCanvasElement>("canvas");
    const added: HTMLCanvasElement[] = [];
    for (const c of after) if (!before.has(c)) added.push(c);
    slot.webglAddon = webgl;
    slot.webglCanvases = added;
  } catch (e) {
    console.warn("[terax-webgl] unavailable:", e);
  }
}

function disposeSlotWebgl(slot: Slot): void {
  if (!slot.webglAddon) return;
  const addon = slot.webglAddon;
  for (const canvas of slot.webglCanvases) releaseCanvasContext(canvas);
  slot.webglCanvases = [];
  try {
    addon.dispose();
  } catch (e) {
    console.warn("[terax-webgl] dispose failed:", e);
  }
  try {
    const r = (
      addon as unknown as { _renderer?: Record<string, unknown> | null }
    )._renderer;
    if (r) {
      r._canvas = null;
      r._gl = null;
      r._charAtlas = null;
      r._atlas = null;
    }
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderer = null;
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderService = null;
  } catch {}
  slot.webglAddon = null;
}

function releaseCanvasContext(canvas: HTMLCanvasElement): void {
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  } catch {}
  if (!gl) {
    try {
      gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    } catch {}
  }
  if (gl) {
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext && !gl.isContextLost()) ext.loseContext();
    } catch {}
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {}
}

export function applyWebglPreference(enabled: boolean): void {
  for (const slot of slots) {
    if (enabled && !slot.webglAddon) attachWebgl(slot);
    else if (!enabled && slot.webglAddon) disposeSlotWebgl(slot);
  }
}

export function applyFontSize(size: number): void {
  const family = requestedFont().family;
  for (const slot of slots) applyFontOnSlot(slot, family, size);
}

export function applyLetterSpacing(spacing: number): void {
  for (const slot of slots) {
    if (slot.term.options.letterSpacing === spacing) continue;
    slot.term.options.letterSpacing = spacing;
    slot.fitAddon.fit();
    syncPtySize(slot);
  }
}

export function applyFontFamily(family: string): void {
  // A different family has a different advance, so the snapped size changes
  // with it — both have to be pushed together.
  const resolved = family || detectMonoFontFamily();
  const size = requestedFont().size;
  for (const slot of slots) applyFontOnSlot(slot, resolved, size);
}

export function applyScrollback(value: number): void {
  for (const slot of slots) {
    if (slot.term.options.scrollback === value) continue;
    slot.term.options.scrollback = value;
  }
}

export function applyTheme(): void {
  const theme = buildTerminalTheme();
  for (const slot of slots) {
    slot.term.options.theme = theme;
  }
}

export function focusSlot(leafId: number): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  slot?.term.focus();
}

export function setSlotFocused(leafId: number, focused: boolean): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  applyCursorBlinkOnSlot(slot, focused);
}

function applyCursorBlinkOnSlot(slot: Slot, focused: boolean): void {
  const desired = focused;
  if (slot.term.options.cursorBlink === desired) return;
  slot.term.options.cursorBlink = desired;
}

export function getSlotForLeaf(leafId: number): Slot | null {
  return slots.find((s) => s.currentLeafId === leafId) ?? null;
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

function isTerminalCopy(e: KeyboardEvent): boolean {
  return (
    !IS_MAC &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyC" || e.key === "c" || e.key === "C")
  );
}

function isTerminalPaste(e: KeyboardEvent): boolean {
  return (
    !IS_MAC &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V")
  );
}

function isMacPaste(e: KeyboardEvent): boolean {
  return (
    IS_MAC &&
    e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V")
  );
}

function isMacCopy(e: KeyboardEvent): boolean {
  return (
    IS_MAC &&
    e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey &&
    (e.code === "KeyC" || e.key === "c" || e.key === "C")
  );
}

function isShiftEnter(e: KeyboardEvent): boolean {
  return (
    e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  );
}
