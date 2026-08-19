import bidiFactory from "bidi-js";

const bidi = bidiFactory();
const RTL_CHAR_RE = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;

/**
 * Column ranges of a row that the Unicode bidi algorithm resolves to something
 * other than the paragraph's own direction — i.e. the parts whose display order
 * differs from their logical order.
 *
 * Every character with a non-zero embedding level belongs in the same range:
 * a number inside a Hebrew sentence resolves to level 2, and splitting it out
 * would leave the renderer painting the two Hebrew halves in logical order
 * around it. Only level 0 (plain LTR at the base direction) ends a range.
 *
 * Returned as [start, end) string indices, sorted and non-overlapping, which is
 * the contract xterm's `registerCharacterJoiner` expects.
 */
export function rtlRanges(text: string): [number, number][] {
  if (!RTL_CHAR_RE.test(text)) return [];

  const { levels } = bidi.getEmbeddingLevels(text, "ltr");
  const ranges: [number, number][] = [];
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    // A gap of two or more spaces is column alignment, not prose. Bidi resolves
    // it to RTL when it sits between two RTL runs, which would fuse two table
    // columns into one range and swap them on screen.
    if (levels[i] > 0 && !isColumnGap(text, i)) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1) {
      pushRange(ranges, text, start, i);
      start = -1;
    }
  }
  if (start !== -1) pushRange(ranges, text, start, text.length);

  return ranges;
}

function isColumnGap(text: string, i: number): boolean {
  if (text[i] !== " " && text[i] !== "\t") return false;
  return (
    text[i - 1] === " " ||
    text[i - 1] === "\t" ||
    text[i + 1] === " " ||
    text[i + 1] === "\t"
  );
}

/**
 * Trailing whitespace inside a range would be painted as part of the joined
 * glyph and, in a proportional fallback font, at the wrong advance. It never
 * changes place under bidi, so it is left as ordinary cells.
 */
function pushRange(
  ranges: [number, number][],
  text: string,
  start: number,
  end: number,
): void {
  let from = start;
  let to = end;
  while (from < to && text[from] === " ") from++;
  while (to > from && text[to - 1] === " ") to--;
  if (to - from > 1) ranges.push([from, to]);
}
