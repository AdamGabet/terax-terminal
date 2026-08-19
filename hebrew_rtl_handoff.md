# Hebrew RTL — findings and plan

Status as of 2026-08-14. The approach is decided and validated in a lab; the
production change has **not** been made yet.

## Decision

Move bidi out of the PTY byte stream and into paint time, using xterm's
`registerCharacterJoiner`. The stream stays logical, the xterm buffer stays
logical, and the WebGL renderer draws each RTL run as a single `fillText` — the
browser applies UAX #9 itself.

This is "panel 3" in the lab, reviewed and approved by Adam (a Hebrew reader)
on the real Claude Code captures, with font-size snapping enabled.

### Why the current stream transform has to go

`src/modules/terminal/lib/hebrewRtl.ts` rewrites PTY bytes into visual order
before xterm parses them. Two problems that cannot be engineered away:

1. It has to model the row to know what to reorder, which means reimplementing a
   terminal emulator inside a transform (`lineModelValid`, `altScreen`,
   `rowStartedAtColumnZero`, `setCols`). Every entry in the buglog is a hole in
   that model, and there will always be another (DECSTBM, ICH/DCH, REP, wide
   chars, wrapped rows, `\x1b[?7l`).
2. The buffer then holds reversed text. Verified in the lab: `getSelection()`
   returns reversed Hebrew, so copy/paste, search and `SerializeAddon` tab
   snapshots are all corrupted. It also flattens per-word SGR colour.

## What ships

### 1. The joiner

`src/lab/bidiRanges.ts` holds the finished algorithm — move it to
`src/modules/terminal/lib/` and register it in `rendererPool.ts` next to the
other addons (`term.registerCharacterJoiner(rtlRanges)`; `allowProposedApi` is
already true at `rendererPool.ts:129`).

`rtlRanges(text)` returns column ranges whose bidi embedding level is non-zero,
with one crucial guard: **a gap of two or more spaces ends a range**. Bidi
resolves whitespace between two RTL runs to RTL, which would fuse two table
columns into one range and swap them on screen. This mirrors the 2+-space split
`visualOrderHebrewRuns` already uses. Found the hard way — see bug-025.

### 2. Font-size snapping (required, not optional)

xterm's WebGL renderer floors the cell width to a whole device pixel; the DOM
renderer uses the true font advance. Menlo 14px at dpr 2: advance 8.429px vs an
8px cell = **5.36% drift per character**. A single glyph per cell hides this,
but a joined run is drawn as one string and overflows its cell box, so the
glyph atlas crops the tail — visibly losing letters at the ends of runs.

Fix: nudge the requested font size to the nearest value whose advance lands on a
whole device pixel. 14 → 14.12 takes the drift to 0.01%/char and is far too
small to see. Working implementation is `snapToGrid()` in `src/lab/rtlLab.ts`;
it belongs wherever `rendererPool.ts` resolves the font, and must be recomputed
when `devicePixelRatio` changes (moving windows between monitors).

### 3. Removals

Delete `hebrewRtl.ts`, `hebrewRtl.test.ts`, and the wiring in
`useTerminalSession.ts` (lines 35, 62, 229, 252-253, 444).

## Constraints found in the lab

- **`CharacterJoinerService` splits each row at fg/bg boundaries before calling
  the handler.** This is a gift and a limit. Gift: a joined range can never
  cross a colour boundary, so per-run SGR colour survives automatically — the
  thing the stream transform destroys. Limit: Claude Code emits fresh SGR per
  word, so the handler is called with `"Claude"`, `"Code"`, `"v2.1.232"` one at a
  time and can never see two Hebrew words together on those rows.
- **Never force `ctx.direction` globally.** Setting it on every 2d context also
  flips `textAlign`, so the atlas drew each glyph off the left edge of its own
  box and shredded every panel. See bug-026.
- **Character joiners are WebGL-only.** The DOM fallback renderer does its own
  thing and disagrees with both WebGL and correct bidi. Needs a separate
  decision before the DOM path can be considered supported for Hebrew.
- **`isValidJoinRange`** (`WebglRenderer.ts:445-450`) disables joining when the
  cursor sits inside a range or a selection covers it partially, so a run flips
  to logical order while you edit inside it.

## Not done: "whole line RTL"

Requested rule: *if a line starts and ends with Hebrew, lay the whole line out
RTL* (so `תפתח את הקובץ src/main.ts ותוסיף פונקציה` reads as one Hebrew
sentence with the path LTR inside it).

The range half is easy — switch the base direction passed to
`getEmbeddingLevels` when the first and last strong characters are both RTL,
which makes the whole row one range. The rendering half is not reachable from
outside: the joined run is drawn by the glyph atlas with `fillText`, and its
base direction comes from the canvas's `direction`. That canvas is usually
detached from the document, so CSS cannot reach it.

Doing this properly means patching `@xterm/addon-webgl` (patch-package) to set
`direction` **and** `textAlign` on the atlas context for RTL joined runs only —
not globally, which is what broke things. Treat as a separate, carefully tested
change.

## The lab

Dev-only, deliberately left out of `vite.config.ts` build inputs so it never
ships. `pnpm dev`, then http://localhost:1420/rtl-lab.html

Four panels fed identical bytes — baseline, stream transform, character joiner,
DOM+CSS — plus a reference row showing what the browser itself considers correct
bidi. `#<fixture-id>` in the URL runs one fixture on load.

- `rtl-lab.html`, `src/lab/rtlLab.ts` — the bench, font/size controls, the
  "snap size to cell grid" toggle and the drift readout.
- `src/lab/rtlFixtures.ts` — fixtures: mixed script, niqqud, per-word SGR,
  aligned columns, box frames, typed echo with backspace, Ink-style repaint,
  wrapping, alt-screen.
- `src/lab/captures/*.raw` — **real PTY output**, recorded with
  `script` while typing Hebrew into the actual Claude Code and opencode input
  boxes. These are the fixtures that matter; the synthetic ones missed the
  per-word SGR behaviour entirely. Recapture with:

  ```sh
  ( sleep 8; printf 'שלום עולם'; sleep 5; printf '\x1b'; sleep 1; printf '\x03\x03'; sleep 2 ) \
    | COLUMNS=100 LINES=30 script -q capture.raw claude
  ```

## Verification evidence

On the real Claude Code capture and on synthetic mixed-script lines, with
snapping on, the joiner produced output Adam confirmed as correct, while:

- keeping the buffer logical (`getSelection()` returns real text, not reversed),
- preserving per-word colour where the stream transform flattened three colours
  into one,
- keeping English paths and identifiers (`src/main.ts`, `getUserName`,
  `app.tsx`, `npm run build`) LTR and correctly placed inside Hebrew sentences.

## Note for whoever picks this up

Do not try to judge Hebrew glyph order from screenshots — I did, repeatedly, and
got it wrong more than once. Ask a Hebrew reader, or compare against the lab's
browser-reference row, which is rendered by the browser's own bidi engine.
