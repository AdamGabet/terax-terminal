import { describe, expect, it } from "vitest";
import { gridSplitTarget, type PaneNode, splitLeaf } from "./panes";

describe("gridSplitTarget", () => {
  it("fills a 2x2 grid: left|right, right top/bottom, left top/bottom", () => {
    let tree: PaneNode = { kind: "leaf", id: 1 };
    let next = 10;
    for (let i = 0; i < 3; i++) {
      const { targetId, dir } = gridSplitTarget(tree);
      tree = splitLeaf(tree, targetId, next++, next++, dir);
    }
    expect(tree).toEqual({
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        {
          kind: "split",
          id: 14,
          dir: "col",
          children: [
            { kind: "leaf", id: 1 },
            { kind: "leaf", id: 15 },
          ],
        },
        {
          kind: "split",
          id: 12,
          dir: "col",
          children: [
            { kind: "leaf", id: 11 },
            { kind: "leaf", id: 13 },
          ],
        },
      ],
    });
  });
});
