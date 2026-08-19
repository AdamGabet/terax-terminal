/**
 * Byte-level reproductions of the situations where Hebrew currently breaks.
 * A number in `chunks` is a pause in milliseconds, so a fixture can reproduce
 * the incremental arrival that the stream transform depends on.
 */
import claudeCapture from "./captures/claude-hebrew.raw?raw";
import claudeMixedCapture from "./captures/claude-mixed.raw?raw";
import opencodeCapture from "./captures/opencode-hebrew.raw?raw";

export type Fixture = {
  id: string;
  label: string;
  /** What to watch for when comparing the panels. */
  note: string;
  chunks: (string | number)[];
  /** Logical text of the row(s), for the browser-rendered reference. */
  reference: string[];
  /** Alt-screen fixtures leave the terminal in a state that needs a reset. */
  altScreen?: boolean;
};

const ESC = "\x1b";
const CSI = `${ESC}[`;

/** Types `text` one character at a time, the way a shell echoes keystrokes. */
function typed(text: string, delay = 40): (string | number)[] {
  const out: (string | number)[] = [];
  for (const ch of text) {
    out.push(ch, delay);
  }
  return out;
}

/**
 * Real PTY output, recorded with `script` while typing Hebrew into the TUI's
 * input box. Split into small chunks so the replay exercises the same partial
 * arrival — including escape sequences straddling a chunk boundary — that a
 * transform sees from a live pty.
 */
function replay(capture: string, chunkSize = 48): (string | number)[] {
  const chunks: (string | number)[] = [];
  for (let i = 0; i < capture.length; i += chunkSize) {
    chunks.push(capture.slice(i, i + chunkSize), 1);
  }
  return chunks;
}

export const FIXTURES: Fixture[] = [
  {
    id: "plain",
    label: "Plain Hebrew line",
    note: "The baseline. Must read שלום עולם right to left.",
    chunks: ["שלום עולם\r\n"],
    reference: ["שלום עולם"],
  },
  {
    id: "mixed",
    label: "Hebrew phrase inside English",
    note: "The Hebrew block flips; the English on both sides must not move.",
    chunks: ["how do i show זה שאתם מאוד טובים במה שאתם looks good\r\n"],
    reference: ["how do i show זה שאתם מאוד טובים במה שאתם looks good"],
  },
  {
    id: "numbers",
    label: "Numbers and brackets in an RTL run",
    note: "123 stays LTR inside the Hebrew; the parens must mirror.",
    chunks: ["abc שלום (123) def\r\n", "יש לי 3 קבצים בתיקייה\r\n"],
    reference: ["abc שלום (123) def", "יש לי 3 קבצים בתיקייה"],
  },
  {
    id: "niqqud",
    label: "Combining marks (niqqud)",
    note: "Marks must stay on their own letter, not slide one letter over.",
    chunks: ["abc שָׁלוֹם דָּוִד def\r\n"],
    reference: ["abc שָׁלוֹם דָּוִד def"],
  },
  {
    id: "colors",
    label: "SGR colour inside a Hebrew run",
    note: "Each word keeps its own colour. The stream transform flattens these.",
    chunks: [
      `${CSI}32mשלום ${CSI}33mעולם ${CSI}36mנעים מאוד${CSI}0m done\r\n`,
    ],
    reference: ["שלום עולם נעים מאוד done"],
  },
  {
    id: "table",
    label: "Aligned columns",
    note: "Column edges must stay put; Hebrew must not drag numbers across.",
    chunks: [
      "NAME          QTY   SIZE\r\n",
      "דיסטיקב         3   6.12\r\n",
      "קובץ ראשי      12   1.40\r\n",
    ],
    reference: [
      "NAME          QTY   SIZE",
      "דיסטיקב         3   6.12",
      "קובץ ראשי      12   1.40",
    ],
  },
  {
    id: "box",
    label: "Hebrew in a box frame",
    note: "Claude Code's input box. The right border must stay in one column.",
    chunks: [
      "╭────────────────────────────────────────────╮\r\n",
      "│ > תכתוב לי פונקציה שמסדרת את הרשימה        │\r\n",
      "╰────────────────────────────────────────────╯\r\n",
    ],
    reference: [
      "╭────────────────────────────────────────────╮",
      "│ > תכתוב לי פונקציה שמסדרת את הרשימה        │",
      "╰────────────────────────────────────────────╯",
    ],
  },
  {
    id: "typed",
    label: "Typed at a prompt, char by char",
    note: "Each keystroke must reflow the word without smearing the prompt.",
    chunks: ["adam@terax ~ % ", ...typed("שלום עולם"), 400, "\r\n"],
    reference: ["adam@terax ~ % שלום עולם"],
  },
  {
    id: "backspace",
    label: "Typed, then backspaced",
    note: "Deleting from the logical end must delete the leftmost visual glyph.",
    chunks: [
      "adam@terax ~ % ",
      ...typed("שלום עולם"),
      300,
      ...typed("\b \b\b \b\b \b", 120),
      400,
      "\r\n",
    ],
    reference: ["adam@terax ~ % שלום ע"],
  },
  {
    id: "ink-repaint",
    label: "Ink-style repaint (Claude Code)",
    note: "The regression from bug-039: gaps are made with CHA, not spaces.",
    chunks: [
      `${CSI}2K\r`,
      `  ${CSI}20Gתשובה${CSI}40Gדונה`,
      300,
      `${CSI}2K\r`,
      `  ${CSI}20Gתשובה ארוכה יותר${CSI}45Gסיום`,
      300,
      "\r\n",
    ],
    reference: ["  תשובה ארוכה יותר         סיום"],
  },
  {
    id: "cursor-move",
    label: "Arrow keys into a Hebrew word",
    note: "Does the run flip back to logical order while the cursor is inside?",
    chunks: [
      "adam@terax ~ % ",
      ...typed("שלום עולם"),
      300,
      `${CSI}D`,
      300,
      `${CSI}D`,
      300,
      `${CSI}D`,
      600,
    ],
    reference: ["adam@terax ~ % שלום עולם"],
  },
  {
    id: "wrap",
    label: "Long Hebrew line that wraps",
    note: "Reordering must not walk the text down the screen row by row.",
    chunks: [
      "זהו משפט ארוך מאוד בעברית שנועד לבדוק מה קורה כאשר השורה מגיעה לסוף המסך וממשיכה לשורה הבאה בלי לאבד את הסדר הנכון של המילים\r\n",
    ],
    reference: [
      "זהו משפט ארוך מאוד בעברית שנועד לבדוק מה קורה כאשר השורה מגיעה לסוף המסך וממשיכה לשורה הבאה בלי לאבד את הסדר הנכון של המילים",
    ],
  },
  {
    id: "hebrew-with-code",
    label: "Hebrew sentence with code in it",
    note: "The path and identifier must stay LTR and readable inside the Hebrew.",
    chunks: [
      "תפתח את הקובץ src/main.ts ותוסיף פונקציה\r\n",
      "הפונקציה getUserName לא עובדת בכלל\r\n",
      "יש 3 שגיאות בקובץ app.tsx שצריך לתקן\r\n",
      "תריץ npm run build ותגיד לי מה קורה\r\n",
    ],
    reference: [
      "תפתח את הקובץ src/main.ts ותוסיף פונקציה",
      "הפונקציה getUserName לא עובדת בכלל",
      "יש 3 שגיאות בקובץ app.tsx שצריך לתקן",
      "תריץ npm run build ותגיד לי מה קורה",
    ],
  },
  {
    id: "mixed-per-word-sgr",
    label: "Mixed script, colour per word (Ink style)",
    note: "The realistic case: every word carries its own SGR, so the joiner is handed one word at a time.",
    chunks: [
      [
        "\x1b[32mתפתח\x1b[0m",
        "\x1b[32mאת\x1b[0m",
        "\x1b[36msrc/main.ts\x1b[0m",
        "\x1b[32mותוסיף\x1b[0m",
        "\x1b[33mfunction\x1b[0m",
        "\x1b[32mחדשה\x1b[0m",
      ].join(" ") + "\r\n",
    ],
    reference: ["תפתח את src/main.ts ותוסיף function חדשה"],
  },
  {
    id: "claude-real",
    label: "★ Claude Code (real capture)",
    note: "Typed שלום עולם מה קורה into the input box. Words are placed with CHA jumps, so the gaps between them are real cells, not spaces.",
    altScreen: true,
    chunks: replay(claudeCapture),
    reference: ["שלום עולם מה קורה"],
  },
  {
    id: "claude-mixed-real",
    label: "★ Claude Code mixed script (real capture)",
    note: "Typed a Hebrew instruction containing src/main.ts, function and 3 into the real input box.",
    altScreen: true,
    chunks: replay(claudeMixedCapture),
    reference: ["תפתח את הקובץ src/main.ts ותוסיף function חדשה עם 3 params"],
  },
  {
    id: "opencode-real",
    label: "★ opencode (real capture)",
    note: "Same input, different TUI toolkit. Compare how it places the words.",
    altScreen: true,
    chunks: replay(opencodeCapture),
    reference: ["שלום עולם מה קורה"],
  },
  {
    id: "altscreen",
    label: "Alternate screen (vim-like)",
    note: "Cursor-addressed paint. The stream transform gives up here.",
    altScreen: true,
    chunks: [
      `${CSI}?1049h${CSI}2J`,
      `${CSI}1;1Hשורה ראשונה`,
      `${CSI}2;1H  line two with עברית inside`,
      `${CSI}3;5Hשלישית`,
      `${CSI}4;1H-- INSERT --`,
      1500,
      `${CSI}?1049l`,
    ],
    reference: ["שורה ראשונה", "  line two with עברית inside", "    שלישית"],
  },
];
