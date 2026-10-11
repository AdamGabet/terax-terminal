export type PaneId = number;

export type SplitDir = "row" | "col";

export type PaneNode =
  | {
      kind: "leaf";
      id: PaneId;
      cwd?: string;
      restartShell?: string;
      restartCommand?: string;
      /** Type `restartCommand` once output goes quiet, without a shell marker. */
      launchWithoutMarker?: boolean;
    }
  | {
      kind: "split";
      id: PaneId;
      dir: SplitDir;
      children: PaneNode[];
    };

export function isLeaf(
  n: PaneNode,
): n is Extract<PaneNode, { kind: "leaf" }> {
  return n.kind === "leaf";
}

export function leafIds(n: PaneNode): PaneId[] {
  if (isLeaf(n)) return [n.id];
  return n.children.flatMap(leafIds);
}

export function findLeafCwd(n: PaneNode, id: PaneId): string | undefined {
  if (isLeaf(n)) return n.id === id ? n.cwd : undefined;
  for (const c of n.children) {
    const found = findLeafCwd(c, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function setLeafCwd(
  n: PaneNode,
  id: PaneId,
  cwd: string,
): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.cwd === cwd) return n;
    return { ...n, cwd };
  }
  let changed = false;
  const next = n.children.map((c) => {
    const u = setLeafCwd(c, id, cwd);
    if (u !== c) changed = true;
    return u;
  });
  return changed ? { ...n, children: next } : n;
}

/**
 * Insert a new leaf next to `targetId` in direction `dir`.
 *
 * If the target's enclosing split already runs in `dir`, the new leaf is
 * appended as a sibling there (avoids nested same-direction splits — keeps
 * the tree shallow and the resize handles aligned).
 */
export function splitLeaf(
  tree: PaneNode,
  targetId: PaneId,
  newSplitId: PaneId,
  newLeafId: PaneId,
  dir: SplitDir,
  newCwd?: string,
  leafExtra?: Pick<
    Extract<PaneNode, { kind: "leaf" }>,
    "restartCommand" | "launchWithoutMarker"
  >,
): PaneNode {
  if (tree.kind === "split" && tree.dir === dir) {
    const idx = tree.children.findIndex(
      (c) => c.kind === "leaf" && c.id === targetId,
    );
    if (idx >= 0) {
      const newLeaf: PaneNode = {
        kind: "leaf",
        id: newLeafId,
        cwd: newCwd,
        ...leafExtra,
      };
      return {
        ...tree,
        children: [
          ...tree.children.slice(0, idx + 1),
          newLeaf,
          ...tree.children.slice(idx + 1),
        ],
      };
    }
  }
  if (isLeaf(tree)) {
    if (tree.id !== targetId) return tree;
    const newLeaf: PaneNode = {
      kind: "leaf",
      id: newLeafId,
      cwd: newCwd,
      ...leafExtra,
    };
    return {
      kind: "split",
      id: newSplitId,
      dir,
      children: [tree, newLeaf],
    };
  }
  return {
    ...tree,
    children: tree.children.map((c) =>
      splitLeaf(c, targetId, newSplitId, newLeafId, dir, newCwd, leafExtra),
    ),
  };
}

/**
 * Where the next auto-split goes so attached panes fill a 2x2 grid:
 * left|right, then the right column top/bottom, then the left one.
 */
export function gridSplitTarget(tree: PaneNode): {
  targetId: PaneId;
  dir: SplitDir;
} {
  const ids = leafIds(tree);
  if (ids.length === 1) return { targetId: ids[0], dir: "row" };
  if (ids.length === 2) return { targetId: ids[1], dir: "col" };
  return { targetId: ids[0], dir: "col" };
}

/**
 * Remove a leaf and collapse single-child splits left in its wake. Returns
 * `null` when the entire subtree is gone.
 */
export function removeLeaf(
  tree: PaneNode,
  targetId: PaneId,
): PaneNode | null {
  if (isLeaf(tree)) return tree.id === targetId ? null : tree;
  const newChildren: PaneNode[] = [];
  for (const c of tree.children) {
    const r = removeLeaf(c, targetId);
    if (r !== null) newChildren.push(r);
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...tree, children: newChildren };
}

export function removeSplitChild(
  tree: PaneNode,
  splitId: PaneId,
  childIndex: number,
): { tree: PaneNode | null; removedLeafIds: PaneId[] } {
  if (isLeaf(tree)) return { tree, removedLeafIds: [] };

  if (tree.id === splitId) {
    const child = tree.children[childIndex];
    if (!child) return { tree, removedLeafIds: [] };
    const children = tree.children.filter((_, i) => i !== childIndex);
    const nextTree =
      children.length === 0
        ? null
        : children.length === 1
          ? children[0]
          : { ...tree, children };
    return { tree: nextTree, removedLeafIds: leafIds(child) };
  }

  let removedLeafIds: PaneId[] = [];
  const children = tree.children.map((child) => {
    const result = removeSplitChild(child, splitId, childIndex);
    if (result.removedLeafIds.length > 0) {
      removedLeafIds = result.removedLeafIds;
      return result.tree;
    }
    return child;
  });
  if (removedLeafIds.length === 0) return { tree, removedLeafIds };

  const nextChildren = children.filter((child): child is PaneNode => child !== null);
  const nextTree =
    nextChildren.length === 0
      ? null
      : nextChildren.length === 1
        ? nextChildren[0]
        : { ...tree, children: nextChildren };
  return { tree: nextTree, removedLeafIds };
}

export function nextLeafId(
  tree: PaneNode,
  currentId: PaneId,
  delta: 1 | -1,
): PaneId {
  const ids = leafIds(tree);
  if (ids.length === 0) return currentId;
  const idx = ids.indexOf(currentId);
  if (idx < 0) return ids[0];
  return ids[(idx + delta + ids.length) % ids.length];
}

// Closest neighbor of `leafId` within its enclosing split — prefer the
// next sibling, fall back to the previous. Used to pick the new focus
// when a pane closes (so focus stays in the same neighborhood instead of
// snapping to the first pane in the tree).
export function siblingLeafOf(
  tree: PaneNode,
  leafId: PaneId,
): PaneId | null {
  if (isLeaf(tree)) return null;
  for (let i = 0; i < tree.children.length; i++) {
    const c = tree.children[i];
    if (isLeaf(c) && c.id === leafId) {
      const sibling = tree.children[i + 1] ?? tree.children[i - 1];
      if (!sibling) return null;
      return leafIds(sibling)[0] ?? null;
    }
  }
  for (const c of tree.children) {
    if (!isLeaf(c)) {
      const r = siblingLeafOf(c, leafId);
      if (r !== null) return r;
    }
  }
  return null;
}

export function hasLeaf(tree: PaneNode, id: PaneId): boolean {
  return leafIds(tree).includes(id);
}
