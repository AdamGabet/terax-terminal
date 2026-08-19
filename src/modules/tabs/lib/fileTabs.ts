import type {
  EditorTab,
  FilePreviewTab,
  MarkdownTab,
  Tab,
} from "./useTabs";

/**
 * Functional core for opening file-backed tabs (editor, markdown, image/PDF
 * viewer) with VSCode-style transient "preview" semantics:
 *
 * - At most one tab in the whole list is a transient preview (the global
 *   preview slot). A single-click open replaces it in place rather than
 *   accumulating tabs.
 * - Pinning (double-click, edit, or an explicit "Open") promotes the tab to
 *   persistent so the next preview no longer replaces it.
 * - Image/PDF (`file-preview`) tabs are additionally capped to a configurable
 *   count; opening past the cap evicts the oldest.
 *
 * Kept dependency-free and pure so the tab-lifecycle invariants are unit
 * tested without a React render.
 */

export type FileBackedKind = "editor" | "markdown" | "file-preview";

export type FileBackedTab = EditorTab | MarkdownTab | FilePreviewTab;

export function isFileBackedTab(t: Tab): t is FileBackedTab {
  return (
    t.kind === "editor" || t.kind === "markdown" || t.kind === "file-preview"
  );
}

/** True for the single transient preview slot. */
export function isPreviewTab(t: Tab): boolean {
  if (isFileBackedTab(t)) return t.preview === true;
  return t.kind === "git-diff" && t.preview === true;
}

function pathOf(t: Tab): string | null {
  return isFileBackedTab(t) ? t.path : null;
}

function promote(t: Tab): Tab {
  return isFileBackedTab(t) ? { ...t, preview: false } : t;
}

function makeFileTab(
  kind: FileBackedKind,
  id: number,
  path: string,
  title: string,
  preview: boolean,
): FileBackedTab {
  if (kind === "editor") {
    return { id, kind: "editor", title, path, dirty: false, preview };
  }
  if (kind === "markdown") {
    return { id, kind: "markdown", title, path, preview };
  }
  return { id, kind: "file-preview", title, path, preview };
}

/**
 * Enforce the combined image+PDF tab cap, evicting the oldest `file-preview`
 * tabs (by list order) while always keeping `keepId`.
 */
export function capFilePreviewTabs(
  tabs: Tab[],
  max: number,
  keepId: number,
): Tab[] {
  // max <= 0 (or non-finite) means unlimited — no eviction.
  if (!Number.isFinite(max) || max <= 0) return tabs;
  const limit = Math.floor(max);
  const previews = tabs.filter((t) => t.kind === "file-preview");
  if (previews.length <= limit) return tabs;
  const excess = previews.length - limit;
  const victims = new Set(
    previews
      .filter((t) => t.id !== keepId)
      .slice(0, excess)
      .map((t) => t.id),
  );
  return tabs.filter((t) => !victims.has(t.id));
}

export interface FileOpenInput {
  kind: FileBackedKind;
  path: string;
  title: string;
  /** false → transient preview slot; true → persistent. */
  pin: boolean;
  /** Candidate id, consumed only when a new tab is created. */
  nextId: number;
  /** Combined image+PDF cap. */
  maxFilePreview: number;
}

export interface FileOpenResult {
  tabs: Tab[];
  activeId: number;
  /** True when `nextId` was used (a new tab was created). */
  consumedId: boolean;
}

export function applyFileOpen(curr: Tab[], input: FileOpenInput): FileOpenResult {
  const { kind, path, title, pin, nextId, maxFilePreview } = input;

  const persistent = curr.find(
    (t) => t.kind === kind && pathOf(t) === path && !isPreviewTab(t),
  );
  if (persistent) {
    return { tabs: curr, activeId: persistent.id, consumedId: false };
  }

  const existingPreview = curr.find(
    (t) => t.kind === kind && pathOf(t) === path && isPreviewTab(t),
  );
  if (existingPreview) {
    if (pin) {
      return {
        tabs: curr.map((t) =>
          t.id === existingPreview.id ? promote(t) : t,
        ),
        activeId: existingPreview.id,
        consumedId: false,
      };
    }
    return { tabs: curr, activeId: existingPreview.id, consumedId: false };
  }

  const tab = makeFileTab(kind, nextId, path, title, !pin);
  let tabs: Tab[];
  if (pin) {
    tabs = [...curr, tab];
  } else {
    const slot = curr.findIndex((t) => isPreviewTab(t));
    if (slot === -1) {
      tabs = [...curr, tab];
    } else {
      tabs = curr.slice();
      tabs[slot] = tab;
    }
  }
  if (kind === "file-preview") {
    tabs = capFilePreviewTabs(tabs, maxFilePreview, nextId);
  }
  return { tabs, activeId: nextId, consumedId: true };
}
