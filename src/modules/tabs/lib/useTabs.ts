import { useCallback, useEffect, useRef, useState } from "react";
import {
  findLeafCwd,
  hasLeaf,
  leafIds,
  nextLeafId,
  removeLeaf,
  removeSplitChild,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
import { disposeSession } from "@/modules/terminal/lib/useTerminalSession";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { applyFileOpen, isFileBackedTab, isPreviewTab } from "./fileTabs";

// Matches the renderer slot pool size — over this we'd evict an active leaf.
export const MAX_PANES_PER_TAB = 4;

export type TerminalTab = {
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  /** AI agent cannot read buffer / context of this terminal. */
  private?: boolean;
  /** User-set label that overrides the cwd-derived name. Survives cd. */
  customTitle?: string;
  /** Terminal is a client attached to a persistent tmux session. */
  tmux?: { name: string; attach?: boolean };
};

export type EditorTab = {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  /**
   * True while the tab is in the transient "preview" state — opened by a
   * single-click in the explorer and not yet pinned by the user. A preview tab
   * is replaced by the next single-click rather than accumulating.
   */
  preview: boolean;
  overrideLanguage?: string | null;
};

export type PreviewTab = {
  id: number;
  kind: "preview";
  title: string;
  url: string;
};

export type MarkdownTab = {
  id: number;
  kind: "markdown";
  title: string;
  path: string;
  /** Transient preview slot; see EditorTab.preview. */
  preview: boolean;
};

/** In-app viewer for binary files (images, PDFs). */
export type FilePreviewTab = {
  id: number;
  kind: "file-preview";
  title: string;
  path: string;
  /** Transient preview slot; see EditorTab.preview. */
  preview: boolean;
};

export type AiDiffStatus = "pending" | "approved" | "rejected";

export type AiDiffTab = {
  id: number;
  kind: "ai-diff";
  title: string;
  path: string;
  /** "" for newly created files. */
  originalContent: string;
  proposedContent: string;
  /** Tool-call approval id used to resolve the AI SDK approval. */
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type GitDiffTab = {
  id: number;
  kind: "git-diff";
  title: string;
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath: string | null;
  /** True for staged diffs opened in the transient preview slot. */
  preview: boolean;
};

export type GitHistoryTab = {
  id: number;
  kind: "git-history";
  title: string;
  repoRoot: string;
};

export type GitCommitFileDiffTab = {
  id: number;
  kind: "git-commit-file";
  title: string;
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type Tab =
  | TerminalTab
  | EditorTab
  | PreviewTab
  | MarkdownTab
  | FilePreviewTab
  | AiDiffTab
  | GitDiffTab
  | GitHistoryTab
  | GitCommitFileDiffTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  url: string;
  /** Empty string resets a terminal tab to its cwd-derived name. */
  customTitle: string;
  overrideLanguage: string | null;
}>;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "preview";
  }
}

export function useTabs(initial?: Partial<TerminalTab>) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const tabId = 1;
    const leafId = 2;
    return [
      {
        id: tabId,
        kind: "terminal",
        title: initial?.title ?? "shell",
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  const [activeId, setActiveId] = useState(1);
  const nextIdRef = useRef(3);
  const tabsRef = useRef(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const maxFilePreview = usePreferencesStore((p) => p.maxFilePreviewTabs);
  const maxFilePreviewRef = useRef(maxFilePreview);
  useEffect(() => {
    maxFilePreviewRef.current = maxFilePreview;
  }, [maxFilePreview]);

  const newTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "shell",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  const newAgentTab = useCallback((cwd: string | undefined, title: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title,
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
      },
    ]);
    setActiveId(tabId);
    return { tabId, leafId };
  }, []);

  const newPrivateTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "private",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
        private: true,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  const newTmuxTab = useCallback(
    (cwd?: string, opts?: { name?: string; attach?: boolean }) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      const name = opts?.name ?? `terax-${tabId}-${Date.now().toString(36)}`;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          title: "tmux",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
          tmux: { name, attach: opts?.attach },
        },
      ]);
      setActiveId(tabId);
      return tabId;
    },
    [],
  );

  /**
   * Opens a file-backed tab (editor / markdown / image-PDF viewer) with
   * VSCode-style transient preview semantics. A single global preview slot is
   * shared across file-backed tabs and staged Git diffs; see
   * `fileTabs.applyFileOpen`.
   *
   * - `pin = true` opens or activates a **persistent** tab (promoting the slot
   *   if it already shows this path).
   * - `pin = false` opens in the shared **preview** slot, replacing whatever it
   *   currently holds.
   */
  const openFileBacked = useCallback(
    (
      kind: "editor" | "markdown" | "file-preview",
      path: string,
      pin: boolean,
    ) => {
      const curr = tabsRef.current;
      const res = applyFileOpen(curr, {
        kind,
        path,
        title: basename(path),
        pin,
        nextId: nextIdRef.current,
        maxFilePreview: maxFilePreviewRef.current,
      });
      if (res.consumedId) nextIdRef.current++;
      tabsRef.current = res.tabs;
      setTabs(res.tabs);
      setActiveId(res.activeId);
      return res.activeId;
    },
    [],
  );

  const openFileTab = useCallback(
    (path: string, pin = true) => openFileBacked("editor", path, pin),
    [openFileBacked],
  );

  /**
   * Promotes a preview tab (including staged Git diffs) to persistent.
   * Called on double-click of the tab title. Dirty editor edits also
   * auto-promote (see `updateTab`).
   */
  const pinTab = useCallback((id: number) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && (isFileBackedTab(t) || t.kind === "git-diff")
          ? { ...t, preview: false }
          : t,
      ),
    );
  }, []);

  const openAiDiffTab = useCallback(
    (input: {
      path: string;
      originalContent: string;
      proposedContent: string;
      approvalId: string;
      isNewFile: boolean;
    }) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "ai-diff" && t.approvalId === input.approvalId,
        );
        if (existing) {
          targetId = existing.id;
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        const title = `${basename(input.path)} (AI diff)`;
        return [
          ...curr,
          {
            id,
            kind: "ai-diff",
            title,
            path: input.path,
            originalContent: input.originalContent,
            proposedContent: input.proposedContent,
            approvalId: input.approvalId,
            status: "pending",
            isNewFile: input.isNewFile,
          },
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId as number | null;
    },
    [],
  );

  const setAiDiffStatus = useCallback(
    (approvalId: string, status: AiDiffStatus) => {
      setTabs((curr) =>
        curr.map((t) =>
          t.kind === "ai-diff" && t.approvalId === approvalId
            ? { ...t, status }
            : t,
        ),
      );
    },
    [],
  );

  const closeAiDiffTab = useCallback((approvalId: string) => {
    setTabs((curr) => {
      const target = curr.find(
        (t) => t.kind === "ai-diff" && t.approvalId === approvalId,
      );
      if (!target || curr.length <= 1) {
        if (!target) return curr;
        return curr.map((t) =>
          t.kind === "ai-diff" && t.approvalId === approvalId
            ? { ...t, status: "approved" as AiDiffStatus }
            : t,
        );
      }
      const idx = curr.findIndex((t) => t.id === target.id);
      const next = curr.filter((t) => t.id !== target.id);
      setActiveId((active) =>
        target.id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
  }, []);

  const newPreviewTab = useCallback((url: string) => {
    const id = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      { id, kind: "preview", title: titleFromUrl(url), url },
    ]);
    setActiveId(id);
    return id;
  }, []);

  const newMarkdownTab = useCallback(
    (path: string, pin = false) => openFileBacked("markdown", path, pin),
    [openFileBacked],
  );

  const newFilePreviewTab = useCallback(
    (path: string, pin = false) => openFileBacked("file-preview", path, pin),
    [openFileBacked],
  );

  const setOverrideLanguage = useCallback((id: number, lang: string | null) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== id || t.kind !== "editor") return t;
        return {
          ...t,
          overrideLanguage: lang,
        };
      }),
    );
  }, []);

  const openGitDiffTab = useCallback(
    (input: {
      path: string;
      repoRoot: string;
      mode: "-" | "+";
      originalPath?: string | null;
      title?: string;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-diff" &&
          t.repoRoot === input.repoRoot &&
          t.mode === input.mode &&
          (t.path === input.path || input.mode === "+"),
      );
      const computedTitle =
        input.title ?? `${basename(input.path)} (${input.mode})`;
      const originalPath = input.originalPath ?? null;

      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? { ...t, title: computedTitle, path: input.path, originalPath }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }

      const id = nextIdRef.current++;
      const tab = {
        id,
        kind: "git-diff",
        title: computedTitle,
        path: input.path,
        repoRoot: input.repoRoot,
        mode: input.mode,
        originalPath,
        preview: input.mode === "+",
      } satisfies GitDiffTab;
      const previewSlot = tab.preview
        ? curr.findIndex((t) => isPreviewTab(t))
        : -1;
      const nextTabs =
        previewSlot === -1
          ? [...curr, tab]
          : curr.map((t, index) => (index === previewSlot ? tab : t));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitHistoryTab = useCallback(
    (input: { repoRoot: string; branch?: string | null }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) => t.kind === "git-history" && t.repoRoot === input.repoRoot,
      );
      const title = input.branch ? `History · ${input.branch}` : "Git History";
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id ? { ...t, title } : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-history",
          title,
          repoRoot: input.repoRoot,
        } satisfies GitHistoryTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitFileDiffTab = useCallback(
    (input: {
      repoRoot: string;
      sha: string;
      shortSha: string;
      subject: string;
      path: string;
      originalPath: string | null;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-commit-file" &&
          t.repoRoot === input.repoRoot &&
          t.sha === input.sha &&
          t.path === input.path,
      );
      const title = `${basename(input.path)} @ ${input.shortSha}`;
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                title,
                subject: input.subject,
                originalPath: input.originalPath,
              }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-commit-file",
          title,
          repoRoot: input.repoRoot,
          sha: input.sha,
          shortSha: input.shortSha,
          subject: input.subject,
          path: input.path,
          originalPath: input.originalPath,
        } satisfies GitCommitFileDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const closeTab = useCallback((id: number) => {
    let toDispose: number[] = [];
    setTabs((curr) => {
      if (curr.length <= 1) return curr;
      const idx = curr.findIndex((t) => t.id === id);
      const target = curr[idx];
      if (target && target.kind === "terminal") {
        toDispose = leafIds(target.paneTree);
      }
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) =>
        id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  const updateTab = useCallback((id: number, patch: TabPatch) => {
    setTabs((t) =>
      t.map((x) => {
        if (x.id !== id) return x;
        if (x.kind === "terminal") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.cwd !== undefined && { cwd: patch.cwd }),
            ...(patch.customTitle !== undefined && {
              customTitle:
                patch.customTitle === "" ? undefined : patch.customTitle,
            }),
          };
        }
        if (x.kind === "preview") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.url !== undefined && {
              url: patch.url,
              title: patch.title ?? titleFromUrl(patch.url),
            }),
          };
        }
        if (x.kind === "markdown") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
          };
        }
        // editor tab: auto-promote from preview the moment the file becomes dirty.
        const autoPin =
          patch.dirty === true && (x as EditorTab).preview
            ? { preview: false }
            : {};
        return {
          ...x,
          ...autoPin,
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.dirty !== undefined && { dirty: patch.dirty }),
          ...(patch.path !== undefined && { path: patch.path }),
          ...(patch.overrideLanguage !== undefined && {
            overrideLanguage: patch.overrideLanguage,
          }),
        };
      }),
    );
  }, []);

  const selectByIndex = useCallback(
    (idx: number) => {
      const t = tabs[idx];
      if (t) setActiveId(t.id);
    },
    [tabs],
  );

  /** Update a leaf's cwd; mirror to the tab's `cwd` when the leaf is active.
   * Bails out without setTabs when nothing actually changed — shell integration
   * re-emits OSC 7 on every prompt, including empty Enters, so this fires at
   * keystroke rate. Always-setTabs there cascades a paneTree re-render across
   * every open tab. */
  const setLeafCwd = useCallback((leafId: number, cwd: string) => {
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        const isActive = t.activeLeafId === leafId;
        const cwdChanged = isActive && t.cwd !== cwd;
        if (paneTree === t.paneTree && !cwdChanged) return t;
        changed = true;
        return { ...t, paneTree, ...(cwdChanged && { cwd }) };
      });
      return changed ? next : curr;
    });
  }, []);

  const focusPane = useCallback((tabId: number, leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        if (t.activeLeafId === leafId) return t;
        const cwd = findLeafCwd(t.paneTree, leafId);
        return {
          ...t,
          activeLeafId: leafId,
          ...(cwd !== undefined && { cwd }),
        };
      }),
    );
  }, []);

  const focusNextPaneInTab = useCallback((tabId: number, delta: 1 | -1) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
        if (next === t.activeLeafId) return t;
        const cwd = findLeafCwd(t.paneTree, next);
        return { ...t, activeLeafId: next, ...(cwd !== undefined && { cwd }) };
      }),
    );
  }, []);

  /** Split the active leaf of `tabId` along `dir`. Returns the new leaf id. */
  const splitActivePane = useCallback(
    (tabId: number, dir: SplitDir): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          const paneTree = splitLeaf(
            t.paneTree,
            t.activeLeafId,
            splitId,
            leafId,
            dir,
            t.cwd,
          );
          return { ...t, paneTree, activeLeafId: leafId };
        }),
      );
      return newLeafId;
    },
    [],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    let didRemove = false;
    setTabs((curr) => {
      const tab = curr.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return curr;
      const newTree = removeLeaf(tab.paneTree, leafId);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tab.id);
        const next = curr.filter((x) => x.id !== tab.id);
        setActiveId((active) =>
          active === tab.id ? next[Math.max(0, idx - 1)].id : active,
        );
        didRemove = true;
        return next;
      }
      const remaining = leafIds(newTree);
      let newActive = tab.activeLeafId;
      if (tab.activeLeafId === leafId) {
        const sib = siblingLeafOf(tab.paneTree, leafId);
        newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      }
      didRemove = true;
      return curr.map((x) =>
        x.id === tab.id
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (didRemove) disposeSession(leafId);
  }, []);

  const closeSplitChild = useCallback(
    (splitId: number, childIndex: number): void => {
      let removedLeaves: number[] = [];
      setTabs((curr) => {
        let changed = false;
        const next = curr.map((tab) => {
          if (tab.kind !== "terminal") return tab;
          const result = removeSplitChild(tab.paneTree, splitId, childIndex);
          if (result.removedLeafIds.length === 0 || result.tree === null)
            return tab;
          changed = true;
          removedLeaves = result.removedLeafIds;
          const remaining = leafIds(result.tree);
          const activeLeafId = remaining.includes(tab.activeLeafId)
            ? tab.activeLeafId
            : remaining[0];
          const cwd = findLeafCwd(result.tree, activeLeafId);
          return {
            ...tab,
            paneTree: result.tree,
            activeLeafId,
            ...(cwd !== undefined && { cwd }),
          };
        });
        return changed ? next : curr;
      });
      for (const leafId of removedLeaves) disposeSession(leafId);
    },
    [],
  );

  const closeActivePane = useCallback((tabId: number): boolean => {
    let closedTab = false;
    let removedLeaf: number | null = null;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === tabId);
      if (!t || t.kind !== "terminal") return curr;
      const target = t.activeLeafId;
      const newTree = removeLeaf(t.paneTree, target);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tabId);
        const next = curr.filter((x) => x.id !== tabId);
        setActiveId((active) =>
          active === tabId ? next[Math.max(0, idx - 1)].id : active,
        );
        closedTab = true;
        removedLeaf = target;
        return next;
      }
      const remaining = leafIds(newTree);
      const sib = siblingLeafOf(t.paneTree, target);
      const newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      removedLeaf = target;
      return curr.map((x) =>
        x.id === tabId
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (removedLeaf !== null) disposeSession(removedLeaf);
    return closedTab;
  }, []);

  /** Move tab `fromId` to sit just before `beforeId`; `null` moves it to the
   * end. No-ops when the order would not change. */
  const reorderTab = useCallback((fromId: number, beforeId: number | null) => {
    if (fromId === beforeId) return;
    setTabs((curr) => {
      const from = curr.findIndex((t) => t.id === fromId);
      if (from === -1) return curr;
      const at =
        beforeId === null
          ? curr.length
          : curr.findIndex((t) => t.id === beforeId);
      if (at === -1) return curr;
      // Already in place (the tab right before `beforeId`, or already last).
      if (from === at - 1 || (beforeId === null && from === curr.length - 1)) {
        return curr;
      }
      const next = [...curr];
      const [moved] = next.splice(from, 1);
      const insertAt =
        beforeId === null
          ? next.length
          : next.findIndex((t) => t.id === beforeId);
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  const resetWorkspace = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    let toDispose: number[] = [];
    setTabs((curr) => {
      toDispose = curr.flatMap((t) =>
        t.kind === "terminal" ? leafIds(t.paneTree) : [],
      );
      return [
        {
          id: tabId,
          kind: "terminal",
          title: "shell",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ];
    });
    setActiveId(tabId);
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  return {
    tabs,
    activeId,
    setActiveId,
    setOverrideLanguage,
    newTab,
    newAgentTab,
    newPrivateTab,
    newTmuxTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    newFilePreviewTab,
    openAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    setAiDiffStatus,
    closeAiDiffTab,
    closeTab,
    reorderTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    closeSplitChild,
    resetWorkspace,
  };
}
