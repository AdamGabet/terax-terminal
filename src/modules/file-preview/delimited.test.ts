import { describe, expect, it } from "vitest";
import { parseDelimited, sniffDelimiter } from "./delimited";

describe("parseDelimited", () => {
  it("parses simple comma rows", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseDelimited('"a, b","c""d"\n', ",")).toEqual([["a, b", 'c"d']]);
  });

  it("handles CRLF line breaks, preserving CRLF inside quotes", () => {
    expect(parseDelimited('a,"x\r\ny"\r\n1,2\r\n', ",")).toEqual([
      ["a", "x\r\ny"],
      ["1", "2"],
    ]);
  });

  it("drops empty trailing rows from a trailing newline", () => {
    expect(parseDelimited("a,b\n", ",")).toEqual([["a", "b"]]);
  });

  it("parses tab-delimited rows", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });
});

describe("sniffDelimiter", () => {
  it("prefers semicolon when it dominates", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3\n")).toBe(";");
  });

  it("prefers tab when it dominates", () => {
    expect(sniffDelimiter("a\tb\n1\t2\n")).toBe("\t");
  });

  it("defaults to comma", () => {
    expect(sniffDelimiter("a,b\n1,2\n")).toBe(",");
  });
});
