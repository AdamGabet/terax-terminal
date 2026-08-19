import { describe, expect, it } from "vitest";
import { rtlRanges } from "./bidiRanges";

const slice = (text: string): string[] =>
  rtlRanges(text).map(([from, to]) => text.slice(from, to));

describe("rtlRanges", () => {
  it("returns nothing for text with no RTL characters", () => {
    expect(rtlRanges("npm run build")).toEqual([]);
    expect(rtlRanges("")).toEqual([]);
  });

  it("covers a Hebrew run and leaves the surrounding English alone", () => {
    expect(slice("open שלום עולם now")).toEqual(["שלום עולם"]);
  });

  it("keeps digits inside a Hebrew sentence in the same range", () => {
    // Digits resolve to level 2 here, so splitting them out would leave the
    // two Hebrew halves painted in logical order around them.
    const text = "יש 42 קבצים";
    expect(slice(text)).toEqual([text]);
  });

  it("ends a range at a strong LTR word", () => {
    // At an LTR base direction the path is level 0, so it splits the sentence
    // into two runs, each laid out RTL on its own. Laying the whole line out
    // RTL instead needs a base-direction switch plus a renderer patch — see
    // "Not done: whole line RTL" in hebrew_rtl_handoff.md.
    expect(slice("תפתח את src/main.ts ותוסיף")).toEqual(["תפתח את", "ותוסיף"]);
  });

  it("splits at a gap of two or more spaces so columns never swap", () => {
    // Bidi resolves whitespace between two RTL runs to RTL, which would fuse
    // the two columns into one range and show them in the wrong order.
    expect(slice("שלום    עולם")).toEqual(["שלום", "עולם"]);
  });

  it("does not split on the single spaces inside a sentence", () => {
    expect(slice("שלום עולם")).toEqual(["שלום עולם"]);
  });

  it("leaves trailing whitespace outside the range", () => {
    expect(slice("  שלום  ")).toEqual(["שלום"]);
  });

  it("returns sorted, non-overlapping ranges", () => {
    const ranges = rtlRanges("a שלום b עולם c");
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeGreaterThanOrEqual(ranges[i - 1][1]);
    }
    for (const [from, to] of ranges) expect(to).toBeGreaterThan(from);
  });

  it("ignores a single RTL character, which bidi cannot reorder", () => {
    expect(rtlRanges("a ש b")).toEqual([]);
  });
});
