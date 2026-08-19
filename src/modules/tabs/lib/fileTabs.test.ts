import { describe, expect, it } from "vitest";
import {
  applyFileOpen,
  capFilePreviewTabs,
  type FileBackedKind,
  isPreviewTab,
} from "./fileTabs";
import type { Tab } from "./useTabs";

function terminal(id: number): Tab {
  return {
    id,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: id + 1000 },
    activeLeafId: id + 1000,
  };
}

function fileTab(
  id: number,
  kind: FileBackedKind,
  path: string,
  preview: boolean,
): Tab {
  if (kind === "editor") {
    return { id, kind, title: path, path, dirty: false, preview };
  }
  if (kind === "markdown") {
    return { id, kind, title: path, path, preview };
  }
  return { id, kind: "file-preview", title: path, path, preview };
}

function gitDiffTab(id: number, mode: "-" | "+", preview: boolean): Tab {
  return {
    id,
    kind: "git-diff",
    title: "file",
    path: "/file",
    repoRoot: "/repo",
    mode,
    originalPath: null,
    preview,
  };
}

const open = (
  curr: Tab[],
  kind: FileBackedKind,
  path: string,
  pin: boolean,
  nextId = 100,
  maxFilePreview = 3,
) =>
  applyFileOpen(curr, {
    kind,
    path,
    title: path,
    pin,
    nextId,
    maxFilePreview,
  });

const previewCount = (tabs: Tab[]) => tabs.filter(isPreviewTab).length;

describe("isPreviewTab", () => {
  it("recognizes staged Git diffs as transient previews", () => {
    expect(isPreviewTab(gitDiffTab(2, "+", true))).toBe(true);
    expect(isPreviewTab(gitDiffTab(3, "-", false))).toBe(false);
  });
});

describe("applyFileOpen — transient preview slot", () => {
  it("creates a single transient preview tab", () => {
    const res = open([terminal(1)], "editor", "/a.ts", false);
    expect(res.consumedId).toBe(true);
    expect(res.activeId).toBe(100);
    expect(res.tabs).toHaveLength(2);
    expect(previewCount(res.tabs)).toBe(1);
  });

  it("reuses the one global slot across kinds (open img replaces previewed code)", () => {
    const start = [terminal(1), fileTab(2, "editor", "/a.ts", true)];
    const previewed = open(start, "editor", "/a.ts", false, 100); // already pinned -> activates, no new tab
    expect(previewed.consumedId).toBe(false);

    // Fresh transient code, then transient image: image replaces the slot.
    const code = open([terminal(1)], "editor", "/a.ts", false, 100);
    const img = open(code.tabs, "file-preview", "/p.png", false, 101);
    expect(img.tabs).toHaveLength(2); // terminal + the single preview slot
    expect(previewCount(img.tabs)).toBe(1);
    expect(img.tabs.some((t) => t.kind === "file-preview")).toBe(true);
    expect(img.tabs.some((t) => t.kind === "editor")).toBe(false);
  });

  it("activates an existing persistent tab instead of duplicating", () => {
    const start = [terminal(1), fileTab(2, "editor", "/a.ts", false)];
    const res = open(start, "editor", "/a.ts", false, 100);
    expect(res.consumedId).toBe(false);
    expect(res.activeId).toBe(2);
    expect(res.tabs).toBe(start);
  });

  it("pinning an existing preview promotes it in place", () => {
    const start = [terminal(1), fileTab(2, "file-preview", "/p.png", true)];
    const res = open(start, "file-preview", "/p.png", true, 100);
    expect(res.consumedId).toBe(false);
    expect(res.activeId).toBe(2);
    expect(previewCount(res.tabs)).toBe(0);
  });

  it("a pinned open appends a persistent tab and leaves the preview slot intact", () => {
    const start = [terminal(1), fileTab(2, "editor", "/a.ts", true)];
    const res = open(start, "editor", "/b.ts", true, 100);
    expect(res.tabs).toHaveLength(3);
    expect(previewCount(res.tabs)).toBe(1); // the original /a.ts preview survives
  });
});

describe("file-preview cap (combined image + PDF)", () => {
  it("evicts the oldest file-preview tab when opening past the cap", () => {
    const start: Tab[] = [
      terminal(1),
      fileTab(2, "file-preview", "/1.png", false),
      fileTab(3, "file-preview", "/2.pdf", false),
      fileTab(4, "file-preview", "/3.png", false),
    ];
    const res = open(start, "file-preview", "/4.pdf", false, 100, 3);
    const fp = res.tabs.filter((t) => t.kind === "file-preview");
    expect(fp).toHaveLength(3);
    expect(fp.map((t) => t.id)).toEqual([3, 4, 100]); // oldest (id 2) evicted
  });

  it("never evicts the just-opened tab even under a tight cap", () => {
    const start: Tab[] = [
      fileTab(2, "file-preview", "/1.png", true),
      fileTab(3, "file-preview", "/2.png", true),
    ];
    const res = capFilePreviewTabs([...start, fileTab(100, "file-preview", "/3.png", false)], 1, 100);
    const fp = res.filter((t) => t.kind === "file-preview");
    expect(fp.map((t) => t.id)).toEqual([100]);
  });

  it("treats max <= 0 as unlimited (no eviction)", () => {
    const start: Tab[] = [
      fileTab(2, "file-preview", "/1.png", false),
      fileTab(3, "file-preview", "/2.png", false),
      fileTab(4, "file-preview", "/3.png", false),
    ];
    const res = open(start, "file-preview", "/4.png", true, 100, 0);
    expect(res.tabs.filter((t) => t.kind === "file-preview")).toHaveLength(4);
    expect(capFilePreviewTabs(res.tabs, 0, 100)).toBe(res.tabs);
  });

  it("does not touch non-file-preview tabs", () => {
    const start: Tab[] = [
      terminal(1),
      fileTab(2, "editor", "/a.ts", false),
      fileTab(3, "markdown", "/b.md", false),
      fileTab(4, "file-preview", "/1.png", true),
    ];
    const res = open(start, "file-preview", "/2.png", false, 100, 1);
    expect(res.tabs.some((t) => t.kind === "editor")).toBe(true);
    expect(res.tabs.some((t) => t.kind === "markdown")).toBe(true);
    expect(res.tabs.filter((t) => t.kind === "file-preview")).toHaveLength(1);
  });
});
