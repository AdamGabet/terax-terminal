import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { rtlRanges } from "../modules/terminal/lib/bidiRanges";
import { HebrewRtlTransform } from "./hebrewRtl";
import { FIXTURES, type Fixture } from "./rtlFixtures";

/**
 * A bench for the four ways xterm can be made to show Hebrew, all fed the same
 * bytes at the same time so the differences are the only thing on screen.
 *
 * Dev-only: served by vite at /rtl-lab.html and left out of the build inputs,
 * so nothing here reaches the shipped app.
 */
type Strategy = {
  id: string;
  label: string;
  note: string;
  renderer: "webgl" | "dom";
  /** Rewrites the PTY bytes before xterm parses them. */
  transform?: () => (text: string) => string;
  /** Reorders at paint time, leaving the buffer logical. */
  joiner?: boolean;
  /** Applied to the terminal element, for the CSS-only experiment. */
  css?: string;
};

const STRATEGIES: Strategy[] = [
  {
    id: "baseline",
    label: "1 · Baseline",
    note: "Stock xterm + WebGL. What every other terminal shows: logical order.",
    renderer: "webgl",
  },
  {
    id: "stream",
    label: "2 · Stream transform (today)",
    note: "HebrewRtlTransform rewrites the bytes. Buffer holds visual order.",
    renderer: "webgl",
    transform: () => {
      const t = new HebrewRtlTransform();
      t.setCols(COLS);
      return (text) => t.process(text);
    },
  },
  {
    id: "joiner",
    label: "3 · Character joiner (proposed)",
    note: "Buffer stays logical; WebGL draws each RTL run as one fillText.",
    renderer: "webgl",
    joiner: true,
  },
  {
    id: "dom",
    label: "4 · DOM renderer + CSS",
    note: "No WebGL, no joiner. Whatever the browser does to xterm's spans.",
    renderer: "dom",
    css: "unicode-bidi: plaintext;",
  },
];

const COLS = 100;
const ROWS = 14;

type Panel = {
  strategy: Strategy;
  term: Terminal;
  write: (text: string) => void;
  selection: HTMLElement;
};

const panels: Panel[] = [];
let running = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function buildPanel(strategy: Strategy, host: HTMLElement): Panel {
  const card = el("section", "panel");
  card.append(el("h2", undefined, strategy.label));
  card.append(el("p", "note", strategy.note));

  const screen = el("div", "screen");
  card.append(screen);

  const footer = el("div", "footer");
  const copyButton = el("button", undefined, "select all → copy");
  const selection = el("code", "selection");
  footer.append(copyButton, selection);
  card.append(footer);
  host.append(card);

  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    fontFamily: fontInput.value,
    fontSize: Number(sizeInput.value),
    convertEol: false,
    allowProposedApi: true,
    theme: { background: "#11131a", foreground: "#e6e6e6" },
  });
  term.open(screen);

  if (strategy.renderer === "webgl") {
    try {
      term.loadAddon(new WebglAddon());
    } catch (error) {
      card.append(el("p", "warn", `WebGL failed: ${String(error)}`));
    }
  }
  if (strategy.joiner) term.registerCharacterJoiner(rtlRanges);
  if (strategy.css && term.element) {
    term.element.setAttribute(
      "style",
      `${term.element.getAttribute("style") ?? ""};${strategy.css}`,
    );
  }

  const transform = strategy.transform?.();

  copyButton.addEventListener("click", () => {
    term.selectAll();
    // What a copy would put on the clipboard — the buffer's own order.
    selection.textContent = term
      .getSelection()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .join(" ⏎ ");
  });

  return {
    strategy,
    term,
    selection,
    write: (text) => term.write(transform ? transform(text) : text),
  };
}

async function runFixture(fixture: Fixture): Promise<void> {
  if (running) return;
  running = true;
  status.textContent = `running: ${fixture.label}`;
  reference.replaceChildren(
    el("div", "reference-label", "browser reference (HTML bidi)"),
    ...fixture.reference.map((line) => el("div", "reference-line", line)),
    el("div", "reference-note", fixture.note),
  );

  for (const panel of panels) panel.selection.textContent = "";

  for (const chunk of fixture.chunks) {
    if (typeof chunk === "number") {
      await new Promise((resolve) => setTimeout(resolve, chunk));
      continue;
    }
    for (const panel of panels) panel.write(chunk);
  }

  if (fixture.altScreen) {
    for (const panel of panels) panel.write("\x1b[?1049l");
  }
  status.textContent = `done: ${fixture.label}`;
  running = false;
}

function reset(): void {
  for (const panel of panels) {
    panel.term.reset();
    panel.selection.textContent = "";
  }
  status.textContent = "reset";
}

// ---------------------------------------------------------------- chrome

const root = document.getElementById("lab")!;
const controls = el("header", "controls");
const fontInput = el("input", "font");
fontInput.value = "Menlo, Monaco, monospace";
fontInput.size = 30;
const sizeInput = el("input", "font");
sizeInput.type = "number";
sizeInput.value = "14";
sizeInput.size = 3;
const snapInput = el("input");
snapInput.type = "checkbox";
const status = el("span", "status", "idle");
const drift = el("span", "drift");
const reference = el("div", "reference");
const grid = el("div", "grid");

const fixtureButtons = el("div", "fixtures");
for (const fixture of FIXTURES) {
  const button = el("button", undefined, fixture.label);
  button.addEventListener("click", () => void runFixture(fixture));
  fixtureButtons.append(button);
}

const runAll = el("button", "primary", "run all");
runAll.addEventListener("click", async () => {
  reset();
  for (const fixture of FIXTURES) {
    if (fixture.altScreen) continue;
    await runFixture(fixture);
    for (const panel of panels) panel.write("\r\n");
  }
});

const resetButton = el("button", undefined, "reset");
resetButton.addEventListener("click", reset);

fontInput.addEventListener("change", () => {
  for (const panel of panels) panel.term.options.fontFamily = fontInput.value;
});

/**
 * The WebGL renderer floors its cell width to a whole device pixel, so at most
 * sizes the font's natural advance is wider than a cell. A single glyph per
 * cell hides that, but a joined run is drawn as one string and overflows.
 * This readout shows the drift for the current font and size.
 */
function measureDrift(size: number | string = sizeInput.value): string {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${size}px ${fontInput.value}`;
  const advance = ctx.measureText("x").width;
  const cell = Math.floor(advance * devicePixelRatio) / devicePixelRatio;
  const drift = ((advance - cell) / cell) * 100;
  return `advance ${advance.toFixed(2)}px · cell ${cell}px · drift ${drift.toFixed(2)}%/char`;
}

/**
 * The clipping fix. xterm floors the cell to a whole device pixel, so at most
 * sizes a joined run is drawn wider than the cells it is allowed to occupy and
 * the tail is cut off. Nudging the font size by a fraction of a pixel — far too
 * little to see — lands the advance exactly on the grid and the run fits.
 */
function snapToGrid(requested: string | number): number {
  const size = Number(requested);
  const ctx = document.createElement("canvas").getContext("2d")!;
  const driftAt = (value: number): number => {
    ctx.font = `${value}px ${fontInput.value}`;
    const advance = ctx.measureText("x").width;
    const cell = Math.floor(advance * devicePixelRatio) / devicePixelRatio;
    return cell > 0 ? (advance - cell) / cell : Infinity;
  };

  let best = size;
  let bestDrift = driftAt(size);
  for (let candidate = size - 0.5; candidate <= size + 0.5; candidate += 0.01) {
    const value = driftAt(candidate);
    if (value < bestDrift) {
      bestDrift = value;
      best = Number(candidate.toFixed(2));
    }
  }
  return best;
}

function applyFontSize(): void {
  const requested = Number(sizeInput.value);
  if (!Number.isFinite(requested) || requested < 6) return;
  const size = snapInput.checked ? snapToGrid(requested) : requested;
  for (const panel of panels) panel.term.options.fontSize = size;
  drift.textContent = `${snapInput.checked ? `snapped ${requested}→${size} · ` : ""}${measureDrift(size)}`;
}
sizeInput.addEventListener("change", applyFontSize);
fontInput.addEventListener("change", applyFontSize);
snapInput.addEventListener("change", applyFontSize);

controls.append(
  el("h1", undefined, "Hebrew RTL lab"),
  runAll,
  resetButton,
  el("label", undefined, "font"),
  fontInput,
  sizeInput,
  snapInput,
  el("label", undefined, "snap size to cell grid"),
  status,
  drift,
);
root.append(controls, fixtureButtons, reference, grid);

for (const strategy of STRATEGIES) panels.push(buildPanel(strategy, grid));

// The WebGL renderer only paints on change, and its drawing buffer is not
// preserved, so a screenshot driver needs a way to force a frame.
Object.assign(window as unknown as Record<string, unknown>, {
  labRefresh: () => {
    for (const panel of panels) panel.term.refresh(0, ROWS - 1);
  },
  labPanels: panels,
});

// A WebGL canvas that scrolls out of view and back comes back blank until
// something forces a frame, which makes the panels look empty exactly when you
// scroll down to compare them.
let repaintTimer = 0;
window.addEventListener(
  "scroll",
  () => {
    clearTimeout(repaintTimer);
    repaintTimer = window.setTimeout(() => {
      for (const panel of panels) panel.term.refresh(0, ROWS - 1);
    }, 80);
  },
  { passive: true },
);

// `#<fixture-id>` runs one fixture on load, so a screenshot tool can capture
// each case without driving the buttons.
function runFromHash(): void {
  const fixture = FIXTURES.find((f) => f.id === location.hash.slice(1));
  if (!fixture) return;
  reset();
  setTimeout(() => void runFixture(fixture), 250);
}
window.addEventListener("hashchange", runFromHash);
runFromHash();

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; padding: 16px; background: #0b0d12; color: #d8dce6;
         font: 13px/1.5 -apple-system, system-ui, sans-serif; }
  h1 { font-size: 16px; margin: 0 12px 0 0; }
  h2 { font-size: 13px; margin: 0 0 2px; color: #9ecbff; }
  .controls { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .fixtures { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  button { background: #1b2030; color: #d8dce6; border: 1px solid #2c3348;
           border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer; }
  button:hover { background: #242b3e; }
  button.primary { background: #2b4b7d; border-color: #3a63a3; }
  input.font { background: #1b2030; color: #d8dce6; border: 1px solid #2c3348;
               border-radius: 6px; padding: 4px 8px; font: inherit; }
  .status { color: #7f8ba3; }
  .drift { color: #c9a227; font-family: Menlo, monospace; font-size: 11px; }
  input[type="number"].font { width: 56px; }
  .reference { background: #141824; border: 1px solid #232a3c; border-radius: 8px;
               padding: 10px 12px; margin-bottom: 12px; }
  .reference-label { color: #7f8ba3; font-size: 11px; text-transform: uppercase;
                     letter-spacing: .06em; margin-bottom: 4px; }
  .reference-line { font-family: Menlo, monospace; font-size: 14px; white-space: pre;
                    overflow-x: auto; }
  .reference-note { color: #c9a227; margin-top: 6px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .panel { background: #141824; border: 1px solid #232a3c; border-radius: 8px; padding: 10px; }
  .note { color: #7f8ba3; margin: 0 0 8px; }
  .warn { color: #ff8080; }
  .screen { height: ${ROWS * 19}px; }
  .footer { display: flex; gap: 8px; align-items: baseline; margin-top: 8px; }
  .selection { color: #8fd694; font-family: Menlo, monospace; font-size: 11px;
               overflow-x: auto; white-space: nowrap; }
`;
document.head.append(style);
