import { describe, expect, it } from "vitest";
import { type PaneNode, splitLeaf } from "@/modules/terminal/lib/panes";
import {
  findCommandLeaf,
  pickSplitTargetTab,
  type Tab,
  type TerminalTab,
} from "./useTabs";

function term(id: number, leaves = 1, extra?: Partial<TerminalTab>): Tab {
  const children: PaneNode[] = Array.from({ length: leaves }, (_, i) => ({
    kind: "leaf",
    id: id * 100 + i,
  }));
  return {
    id,
    kind: "terminal",
    title: "shell",
    paneTree:
      leaves === 1
        ? children[0]
        : { kind: "split", id: id * 100 + 99, dir: "row", children },
    activeLeafId: id * 100,
    ...extra,
  };
}

const fleet: Tab = {
  id: 9,
  kind: "fleet",
  title: "Fleet",
  scope: "local",
  leafId: 900,
} as Tab;

describe("pickSplitTargetTab", () => {
  it("uses the only terminal tab even when it is not the most recent", () => {
    expect(pickSplitTargetTab([term(1), fleet], [9])?.id).toBe(1);
  });

  it("picks the most recently active terminal tab, skipping the fleet tab", () => {
    expect(pickSplitTargetTab([term(1), term(2), fleet], [9, 2, 1])?.id).toBe(
      2,
    );
  });

  it("skips tmux tabs and full tabs", () => {
    const tabs = [term(1), term(2, 4), term(3, 1, { tmux: { name: "x" } })];
    expect(pickSplitTargetTab(tabs, [3, 2, 1])?.id).toBe(1);
  });

  it("returns null when nothing is splittable or no terminal tab is in the MRU", () => {
    expect(pickSplitTargetTab([fleet], [9])).toBeNull();
    expect(pickSplitTargetTab([term(1), term(2)], [9])).toBeNull();
  });
});

describe("splitLeaf leafExtra", () => {
  it("puts the restart command on the new leaf only", () => {
    const tree = splitLeaf(
      { kind: "leaf", id: 1, cwd: "/a" },
      1,
      2,
      3,
      "row",
      "/b",
      {
        restartCommand: "claude attach x",
        launchWithoutMarker: true,
      },
    );
    expect(tree).toEqual({
      kind: "split",
      id: 2,
      dir: "row",
      children: [
        { kind: "leaf", id: 1, cwd: "/a" },
        {
          kind: "leaf",
          id: 3,
          cwd: "/b",
          restartCommand: "claude attach x",
          launchWithoutMarker: true,
        },
      ],
    });
  });
});

describe("findCommandLeaf", () => {
  const attached = (id: number, command: string): Tab => ({
    ...(term(id, 2) as TerminalTab),
    paneTree: {
      kind: "split",
      id: id * 1000,
      dir: "row",
      children: [
        { kind: "leaf", id: id * 100 },
        { kind: "leaf", id: id * 100 + 1, restartCommand: command },
      ],
    },
  });

  it("finds the pane opened with the command", () => {
    const tabs = [term(1), attached(2, "claude attach 59be4b42")];
    expect(findCommandLeaf(tabs, "claude attach 59be4b42")).toEqual({
      tabId: 2,
      leafId: 201,
    });
  });

  it("returns null when no pane runs it", () => {
    const tabs = [attached(2, "claude attach other")];
    expect(findCommandLeaf(tabs, "claude attach 59be4b42")).toBeNull();
  });
});
