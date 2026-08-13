import type { ChangeDesc, Text } from "@codemirror/state";

/**
 * Remaps probe line numbers across a document edit.
 *
 * A probe's line counts as deleted when the whole span [line start, next
 * line start] collapses to a single position (mapping the start with
 * assoc -1 and the end with assoc 1 lands on the same spot) — editing
 * within the line or joining it into the previous one keeps the probe.
 * Surviving probes follow their line-start position; two probes landing
 * on the same line keep only the first.
 */
export function remapProbeLines(
  lines: number[],
  changes: ChangeDesc,
  oldDoc: Text,
  newDoc: Text,
): { moves: [number, number][]; dropped: number[] } {
  const moves: [number, number][] = [];
  const dropped: number[] = [];
  const claimed = new Set<number>();
  for (const line of lines) {
    if (line < 1 || line > oldDoc.lines) {
      dropped.push(line);
      continue;
    }
    const l = oldDoc.line(line);
    const endExclusive = Math.min(l.to + 1, oldDoc.length);
    if (
      endExclusive > l.from &&
      changes.mapPos(l.from, -1) === changes.mapPos(endExclusive, 1)
    ) {
      dropped.push(line);
      continue;
    }
    const mapped = Math.min(changes.mapPos(l.from, 1), newDoc.length);
    const newLine = newDoc.lineAt(mapped).number;
    if (claimed.has(newLine)) {
      dropped.push(line);
      continue;
    }
    claimed.add(newLine);
    if (newLine !== line) moves.push([line, newLine]);
  }
  return { moves, dropped };
}
