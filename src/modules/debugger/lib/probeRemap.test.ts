import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { remapProbeLines } from "./probeRemap";

function doc(...lines: string[]): Text {
  return Text.of(lines);
}

function apply(oldDoc: Text, spec: Parameters<typeof ChangeSet.of>[0]) {
  const changes = ChangeSet.of(spec, oldDoc.length);
  const newDoc = changes.apply(oldDoc);
  return { changes, newDoc };
}

describe("remapProbeLines", () => {
  const base = doc("a = 1", "b = 2", "c = 3", "d = 4");

  it("shifts probes down when lines are inserted above", () => {
    const { changes, newDoc } = apply(base, {
      from: 0,
      insert: "x = 0\ny = 0\n",
    });
    const r = remapProbeLines([2, 4], changes, base, newDoc);
    expect(r.moves).toEqual([
      [2, 4],
      [4, 6],
    ]);
    expect(r.dropped).toEqual([]);
  });

  it("shifts probes up when lines above are deleted", () => {
    // Delete line 1 including its newline.
    const { changes, newDoc } = apply(base, { from: 0, to: 6 });
    const r = remapProbeLines([3], changes, base, newDoc);
    expect(r.moves).toEqual([[3, 2]]);
    expect(r.dropped).toEqual([]);
  });

  it("drops a probe whose line is deleted", () => {
    // Delete line 2 ("b = 2\n"): offsets 6..12.
    const { changes, newDoc } = apply(base, { from: 6, to: 12 });
    const r = remapProbeLines([2, 3], changes, base, newDoc);
    expect(r.dropped).toEqual([2]);
    expect(r.moves).toEqual([[3, 2]]);
  });

  it("keeps a probe when its line is joined into the previous one", () => {
    // Delete just the newline at the end of line 1 (offset 5..6).
    const { changes, newDoc } = apply(base, { from: 5, to: 6 });
    const r = remapProbeLines([2], changes, base, newDoc);
    expect(r.moves).toEqual([[2, 1]]);
    expect(r.dropped).toEqual([]);
  });

  it("drops the later probe on a line collision", () => {
    // Join lines 1+2: probes on both collapse to line 1.
    const { changes, newDoc } = apply(base, { from: 5, to: 6 });
    const r = remapProbeLines([1, 2], changes, base, newDoc);
    expect(r.moves).toEqual([]);
    expect(r.dropped).toEqual([2]);
  });

  it("ignores edits within the probed line", () => {
    // Replace "2" on line 2 (offset 10..11).
    const { changes, newDoc } = apply(base, {
      from: 10,
      to: 11,
      insert: "99",
    });
    const r = remapProbeLines([2], changes, base, newDoc);
    expect(r.moves).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  it("drops probes already out of range", () => {
    const { changes, newDoc } = apply(base, { from: 0, insert: "x\n" });
    const r = remapProbeLines([99], changes, base, newDoc);
    expect(r.dropped).toEqual([99]);
    expect(r.moves).toEqual([]);
  });
});
