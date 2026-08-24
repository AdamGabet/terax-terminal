import bidiFactory from "bidi-js";

const HEBREW_CHAR_RE = /[\u0590-\u05ff]/u;
const bidi = bidiFactory();

/**
 * xterm paints terminal cells in column order and does not apply the Unicode
 * bidi algorithm. Convert logical text to visual order with UAX #9 while
 * keeping combining marks attached to their grapheme. The original PTY stream
 * remains untouched; this value is only used for display.
 */
export function visualOrderHebrewRuns(text: string): string {
  if (!HEBREW_CHAR_RE.test(text)) return text;

  // Runs of alignment whitespace usually separate terminal table columns. Each
  // column is its own bidi paragraph so RTL text cannot pull numbers or labels
  // across column boundaries.
  return text
    .split(/([ \t]{2,})/u)
    .map((part) =>
      HEBREW_CHAR_RE.test(part) ? visualOrderBidiParagraph(part) : part,
    )
    .join("");
}

function visualOrderBidiParagraph(text: string): string {
  // A terminal row and its prompt are anchored on the left. Hebrew still forms
  // an RTL directional run, while surrounding English, numbers and the prompt
  // retain their expected positions.
  const levels = bidi.getEmbeddingLevels(text, "ltr");
  return bidi
    .getReorderedString(text, levels)
    .replace(
      /([\u0591-\u05c7]+)([\u05d0-\u05ea])/gu,
      (_, marks: string, letter: string) =>
        letter + Array.from(marks).reverse().join(""),
    );
}

type EscapeState = "esc" | "csi" | "osc" | "oscEsc" | "charset" | null;

/**
 * Reordering a Hebrew word that is already painted requires erasing the row and
 * repainting it from `currentLine`. That is only sound while `currentLine` is a
 * faithful model of the row, which holds for a shell echoing keystrokes but not
 * for a full-screen TUI: those paint with cursor moves and erases, and the gaps
 * they skip over never reach `currentLine`, so a repaint would swallow them.
 *
 * So the model is marked invalid as soon as the stream does anything the
 * append-only model cannot represent, and from there the transform degrades to
 * reordering each plain segment in place — no erase, no repaint.
 */
export class HebrewRtlTransform {
  private state: EscapeState = null;
  private csiParams = "";
  private currentLine = "";
  private currentLineCells = 0;
  private currentLineHasHebrew = false;
  /** What this row already shows, in visual order — the repaint baseline. */
  private painted = "";
  private lineModelValid = true;
  private altScreen = false;
  private rowStartedAtColumnZero = false;
  private cols = 0;

  /** Terminal width, used to stop repainting once a row is about to wrap. */
  setCols(cols: number): void {
    this.cols = cols > 0 ? cols : 0;
  }

  process(text: string): string {
    let out = "";
    let plain = "";

    const flushPlain = () => {
      if (!plain) return;
      out += this.processPlain(plain);
      plain = "";
    };

    for (const ch of text) {
      if (this.state === "osc") {
        out += ch;
        if (ch === "\x07") this.state = null;
        else if (ch === "\x1b") this.state = "oscEsc";
        continue;
      }
      if (this.state === "oscEsc") {
        out += ch;
        this.state = ch === "\\" ? null : "osc";
        continue;
      }
      if (this.state === "csi") {
        out += ch;
        if (ch >= "@" && ch <= "~") {
          this.applyCsi(ch);
          this.state = null;
        } else this.csiParams += ch;
        continue;
      }
      if (this.state === "charset") {
        out += ch;
        this.state = null;
        continue;
      }
      if (this.state === "esc") {
        out += ch;
        if (ch === "[") {
          this.csiParams = "";
          this.state = "csi";
        } else if (ch === "]") this.state = "osc";
        else if (ch === "(" || ch === ")") this.state = "charset";
        else {
          // Two-character escapes (RI, DECSC/DECRC, NEL, …) move the cursor.
          this.lineModelValid = false;
          this.state = null;
        }
        continue;
      }
      if (ch === "\x1b") {
        flushPlain();
        out += ch;
        this.state = "esc";
        continue;
      }
      plain += ch;
    }

    flushPlain();
    return out;
  }

  /**
   * `\x1b[?1049h` and friends swap to the alternate screen, where the cursor is
   * driven by the application rather than appended to.
   */
  private applyCsi(final: string): void {
    const params = this.csiParams;
    this.csiParams = "";

    if (final === "h" || final === "l") {
      if (
        params.includes("1049") ||
        params.includes("1047") ||
        params === "?47"
      ) {
        const next = final === "h";
        if (next !== this.altScreen) {
          this.altScreen = next;
          this.resetLine();
        }
      }
      return;
    }

    // Interactive renderers such as Ink (used by Claude Code) erase a row and
    // then use CHA/CUP to begin its replacement at column 1. This gives us the
    // same trustworthy full-row boundary as CR, even on the alternate screen.
    if (
      (final === "G" && (params === "" || params === "1")) ||
      ((final === "H" || final === "f") && csiColumn(params) === 1)
    ) {
      this.resetLine(true);
      return;
    }

    // SGR is colour only. EL 2 after CR is the standard readline/TUI pattern
    // for replacing a complete input row; at that point the row model is exact
    // again, even on the alternate screen.
    if (final === "m") return;
    if (final === "K" && params === "2" && this.rowStartedAtColumnZero) {
      this.resetLine(true);
      return;
    }
    // EL with no parameter erases from the cursor to the end of the row, which
    // for an append-only row erases nothing we modelled. DSR, DA, window ops and
    // cursor-style leave the cursor alone.
    if (final === "K" && (params === "" || params === "0")) return;
    if (final === "n" || final === "c" || final === "t" || final === "q")
      return;

    this.lineModelValid = false;
  }

  private trusted(): boolean {
    return (
      this.lineModelValid && (!this.altScreen || this.rowStartedAtColumnZero)
    );
  }

  private resetLine(rowStartedAtColumnZero = false): void {
    this.currentLine = "";
    this.currentLineCells = 0;
    this.currentLineHasHebrew = false;
    this.painted = "";
    this.lineModelValid = true;
    this.rowStartedAtColumnZero = rowStartedAtColumnZero;
  }

  private appendToLine(text: string): void {
    this.currentLine += text;
    this.currentLineCells += text.length;
    if (!this.currentLineHasHebrew && HEBREW_CHAR_RE.test(text)) {
      this.currentLineHasHebrew = true;
    }
    // A repaint of a row that wraps would land on the continuation row and walk
    // the text down the screen one row per character.
    if (this.cols > 0 && this.currentLineCells >= this.cols) {
      this.lineModelValid = false;
    }
  }

  private processPlain(text: string): string {
    const trusted = this.trusted();
    if (
      isSimpleAppend(text) &&
      text.length > 1 &&
      (!trusted || !this.currentLineHasHebrew)
    ) {
      const visual = visualOrderHebrewRuns(text);
      if (trusted) {
        // The row held no Hebrew, so no run can straddle this boundary and the
        // segment's visual order is independent of what precedes it.
        this.appendToLine(text);
        this.painted += visual;
      }
      return visual;
    }

    let out = "";
    // Printable characters held back so an untrusted segment is still reordered
    // as a whole rather than character by character.
    let run = "";
    const flushRun = () => {
      if (!run) return;
      out += visualOrderHebrewRuns(run);
      run = "";
    };

    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        flushRun();
        this.resetLine(ch === "\r");
        out += ch;
        continue;
      }

      if (!this.trusted()) {
        if (ch === "\t" || ch === "\v" || ch === "\f" || ch === "\b") {
          flushRun();
          out += ch;
        } else if (ch < " ") {
          flushRun();
          out += ch;
        } else run += ch;
        continue;
      }

      if (ch === "\b") {
        this.currentLine = Array.from(this.currentLine).slice(0, -1).join("");
        this.currentLineCells = Math.max(0, this.currentLineCells - 1);
        if (this.currentLineHasHebrew) out += this.repaint();
        else {
          this.painted = this.currentLine;
          out += ch;
        }
        continue;
      }

      // Tabs and vertical motion move the cursor by an amount the row model
      // cannot account for.
      if (ch === "\t" || ch === "\v" || ch === "\f") {
        this.lineModelValid = false;
        out += ch;
        continue;
      }

      if (ch < " ") {
        out += ch;
        continue;
      }

      this.appendToLine(ch);
      if (this.trusted() && this.currentLineHasHebrew) out += this.repaint();
      else {
        this.painted += ch;
        out += ch;
      }
    }

    flushRun();
    return out;
  }

  /**
   * Appending a character usually leaves the visual order of everything already
   * on the row untouched — then the new cells are simply written at the cursor,
   * which keeps whatever SGR state the application set. Only when the reordering
   * rewrites earlier cells (a Hebrew run growing, words joining into a sequence)
   * does the row have to be erased and repainted, and that loses per-run colour.
   */
  private repaint(): string {
    const next = visualOrderHebrewRuns(this.currentLine);
    const previous = this.painted;
    this.painted = next;
    if (next.startsWith(previous)) return next.slice(previous.length);
    return `\r\x1b[2K${next}`;
  }
}

function isSimpleAppend(text: string): boolean {
  for (const ch of text) {
    if (ch === "\r" || ch === "\n" || ch === "\b" || ch < " ") return false;
  }
  return true;
}

function csiColumn(params: string): number {
  const separator = params.indexOf(";");
  if (separator === -1) return 1;
  const value = Number(params.slice(separator + 1));
  return Number.isFinite(value) && value > 0 ? value : 1;
}
