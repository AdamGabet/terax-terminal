const HEBREW_RUN_RE = /[\u0590-\u05ff]+/gu;
const HEBREW_CHAR_RE = /[\u0590-\u05ff]/u;
const HEBREW_WORD_SEQUENCE_RE =
  /[\u0590-\u05ff]+(?:[ \t,.;:!?־\-]+[\u0590-\u05ff]+)+/gu;

type GraphemeSegmenter = {
  segment(text: string): Iterable<{ segment: string }>;
};

const IntlWithSegmenter = globalThis.Intl as typeof Intl & {
  Segmenter?: new (
    locale?: string,
    options?: { granularity: "grapheme" },
  ) => GraphemeSegmenter;
};

const segmenter =
  typeof globalThis.Intl !== "undefined" && IntlWithSegmenter.Segmenter
    ? new IntlWithSegmenter.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function reverseGraphemes(text: string): string {
  const parts = segmenter
    ? [...segmenter.segment(text)].map((part) => part.segment)
    : Array.from(text);
  return parts.reverse().join("");
}

/**
 * xterm paints terminal cells in column order and does not apply the Unicode
 * bidi algorithm, so Hebrew appears left-to-right. Reverse consecutive Hebrew
 * word sequences first, then individual Hebrew words. ASCII table layout and
 * ANSI escape sequences remain untouched.
 */
export function visualOrderHebrewRuns(text: string): string {
  const sequences: string[] = [];
  const withoutSequences = text.replace(HEBREW_WORD_SEQUENCE_RE, (match) => {
    const index = sequences.push(reverseGraphemes(match)) - 1;
    return `\u{f0000}${index}\u{f0001}`;
  });
  return withoutSequences
    .replace(HEBREW_RUN_RE, reverseGraphemes)
    .replace(
      /\u{f0000}(\d+)\u{f0001}/gu,
      (_, index: string) => sequences[Number(index)],
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

    // SGR is colour only; EL with no parameter erases from the cursor to the end
    // of the row, which for an append-only row erases nothing we modelled. DSR,
    // DA, window ops and cursor-style leave the cursor alone.
    if (final === "m") return;
    if (final === "K" && (params === "" || params === "0")) return;
    if (final === "n" || final === "c" || final === "t" || final === "q")
      return;

    this.lineModelValid = false;
  }

  private trusted(): boolean {
    return this.lineModelValid && !this.altScreen;
  }

  private resetLine(): void {
    this.currentLine = "";
    this.currentLineCells = 0;
    this.currentLineHasHebrew = false;
    this.painted = "";
    this.lineModelValid = true;
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
        this.resetLine();
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
