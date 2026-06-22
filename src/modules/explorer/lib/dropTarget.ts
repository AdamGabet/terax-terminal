import { create } from "zustand";

/** What the in-tree drag is carrying, for the cursor ghost. */
export type DragInfo = { name: string; isDir: boolean; count: number };

// Shared drag state for the file explorer: the highlighted drop-target folder
// (also used by the OS-file drop hook) plus the in-tree drag's payload and live
// pointer position, which drive the small "holding a file" cursor ghost.
type DropState = {
  targetFolder: string | null;
  setTarget: (path: string | null) => void;
  drag: DragInfo | null;
  pointer: { x: number; y: number };
  startDrag: (info: DragInfo, x: number, y: number) => void;
  moveDrag: (x: number, y: number) => void;
  endDrag: () => void;
};

export const useExplorerDropStore = create<DropState>((set) => ({
  targetFolder: null,
  setTarget: (path) =>
    set((s) => (s.targetFolder === path ? s : { targetFolder: path })),
  drag: null,
  pointer: { x: 0, y: 0 },
  startDrag: (drag, x, y) => set({ drag, pointer: { x, y } }),
  moveDrag: (x, y) => set({ pointer: { x, y } }),
  endDrag: () => set({ drag: null, targetFolder: null }),
}));

/**
 * Resolve the folder a drop at logical screen coords (x, y) targets:
 * a directory row → that folder; a file row → its parent; anywhere inside the
 * explorer but not on a row → the root. Returns null when outside the explorer.
 */
export function folderAtPoint(
  x: number,
  y: number,
  rootPath: string | null,
): string | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const path = row.dataset.fsPath ?? "";
    if (row.dataset.fsDir === "1") return path;
    const parent = path.slice(0, path.lastIndexOf("/"));
    return parent || rootPath;
  }
  if (el.closest("[data-explorer-root]")) return rootPath;
  return null;
}
