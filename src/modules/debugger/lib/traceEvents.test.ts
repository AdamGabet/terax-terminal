import { describe, expect, it } from "vitest";
import { OutputDemux, TERAX_PREFIX } from "./traceEvents";

describe("OutputDemux partial-line ceiling", () => {
  it("buffers an unterminated line across pushes", () => {
    const d = new OutputDemux();
    expect(d.push("stdout", "half ").console).toBe("");
    expect(d.push("stdout", "a line\n").console).toBe("half a line\n");
  });

  it("spills program output once a single line exceeds the ceiling", () => {
    const d = new OutputDemux();
    // No newline anywhere: without a ceiling this would buffer forever.
    // Stays under the 1 MiB cap for two pushes, spills on the third.
    expect(d.push("stdout", "x".repeat(500_000)).console).toBe("");
    expect(d.push("stdout", "x".repeat(500_000)).console).toBe("");
    const out = d.push("stdout", "x".repeat(500_000)).console;
    expect(out.length).toBeGreaterThan(1_000_000);
    // Buffer was reset, so nothing is left to flush.
    expect(d.flush("stdout")).toBe("");
  });

  it("drops an over-long tracer line instead of spilling it to console", () => {
    const d = new OutputDemux();
    d.push("stdout", TERAX_PREFIX + "y".repeat(600_000));
    const out = d.push("stdout", "y".repeat(600_000)).console;
    expect(out).toBe("");
    expect(d.flush("stdout")).toBe("");
  });

  it("keeps buffering a long line that stays under the ceiling", () => {
    const d = new OutputDemux();
    d.push("stdout", "z".repeat(1000));
    expect(d.push("stdout", "\n").console).toBe(`${"z".repeat(1000)}\n`);
  });
});
