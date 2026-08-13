import { describe, expect, it } from "vitest";
import { HebrewRtlTransform, visualOrderHebrewRuns } from "./hebrewRtl";

describe("visualOrderHebrewRuns", () => {
  it("reverses Hebrew words for xterm cell rendering", () => {
    expect(visualOrderHebrewRuns("term תשמע 5")).toBe("term עמשת 5");
  });

  it("reverses consecutive Hebrew word order", () => {
    expect(visualOrderHebrewRuns("היי שלומך מה")).toBe("המ ךמולש ייה");
  });

  it("does not pull non-Hebrew words into Hebrew word sequences", () => {
    expect(visualOrderHebrewRuns("one שלום תודה two מה קורה")).toBe(
      "one הדות םולש two הרוק המ",
    );
  });

  it("keeps surrounding table text and columns in place", () => {
    expect(visualOrderHebrewRuns("  דיסטיקב     3  6.12  -")).toBe(
      "  בקיטסיד     3  6.12  -",
    );
  });

  it("does not reorder Hebrew inside escape sequences", () => {
    const transform = new HebrewRtlTransform();
    expect(transform.process("\x1b]7;file://host/עברית\x07 עברית")).toBe(
      "\x1b]7;file://host/עברית\x07 תירבע",
    );
  });

  it("redraws an incrementally typed Hebrew word in visual order", () => {
    const transform = new HebrewRtlTransform();
    expect(transform.process("adam % ")).toBe("adam % ");
    // The first letter does not reorder anything already on the row.
    expect(transform.process("ק")).toBe("ק");
    expect(transform.process("ר")).toBe("\r\x1b[2Kadam % רק");
    expect(transform.process("ה")).toBe("\r\x1b[2Kadam % הרק");
  });

  it("redraws incrementally typed consecutive Hebrew words", () => {
    const transform = new HebrewRtlTransform();
    transform.process("% ");
    for (const ch of "קרה זה") transform.process(ch);
    expect(transform.process(" ")).toBe(" ");
    for (const ch of "הלך".slice(0, -1)) transform.process(ch);
    expect(transform.process("ך")).toBe("\r\x1b[2K% ךלה הז הרק");
  });

  it("appends without repainting when visual order is unchanged", () => {
    const transform = new HebrewRtlTransform();
    // Colouring is lost by a repaint, so a plain append must not trigger one.
    expect(transform.process("a \x1b[1mשלום עולם\x1b[0m b\r\n")).toBe(
      "a \x1b[1mםלוע םולש\x1b[0m b\r\n",
    );
  });

  it("does not repaint a row painted with cursor moves", () => {
    const transform = new HebrewRtlTransform();
    transform.setCols(80);
    // A TUI skips over blank cells with CUF instead of writing spaces; those
    // columns never reach the row model, so a repaint would swallow them.
    const frame = "\x1b[2Cthe\x1b[1Cא\x1b[1Cwindow\x1b[1Citself\r\n";
    expect(transform.process(frame)).toBe(frame);
  });

  it("resumes tracking the row after a carriage return", () => {
    const transform = new HebrewRtlTransform();
    transform.setCols(80);
    transform.process("\x1b[5Cגג\r\n");
    expect(transform.process("שלום")).toBe("םולש");
  });

  it("does not repaint a row that would wrap", () => {
    const transform = new HebrewRtlTransform();
    transform.setCols(20);
    expect(transform.process("aaaaaaaaaaaaaaaaaaaaaaaa שלום bbb\r\n")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaa םולש bbb\r\n",
    );
  });

  it("does not repaint on the alternate screen", () => {
    const transform = new HebrewRtlTransform();
    transform.setCols(80);
    expect(transform.process("\x1b[?1049hhi שלום there\r\n")).toBe(
      "\x1b[?1049hhi םולש there\r\n",
    );
  });

  it("resumes repainting after leaving the alternate screen", () => {
    const transform = new HebrewRtlTransform();
    transform.setCols(80);
    transform.process("\x1b[?1049hvim\x1b[?1049l");
    transform.process("% ");
    transform.process("ש");
    expect(transform.process("ל")).toBe("\r\x1b[2K% לש");
  });
});
