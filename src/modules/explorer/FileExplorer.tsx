import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExplorerSearch, type ExplorerSearchHandle } from "./ExplorerSearch";
import { EntryRow, PendingRow, StatusRow } from "./TreeRow";
import { InlineInput } from "./InlineInput";
import {
  copyToClipboard,
  pasteIntoFolder,
  revealInFinder,
} from "./lib/contextActions";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { cn } from "@/lib/utils";
import { DragGhost } from "./DragGhost";
import { useFileTree } from "./lib/useFileTree";
import { useExplorerDropStore } from "./lib/dropTarget";
import { useExplorerFileDrop } from "./lib/useExplorerFileDrop";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import { useWorkspaceEnvStore } from "@/modules/workspace";

export type FileExplorerHandle = {
  focus: () => void;
  isFocused: () => boolean;
};

type Props = {
  rootPath: string | null;
  activeFilePath?: string | null;
  onOpenFile: (path: string, pin?: boolean) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onOpenMarkdownPreview?: (path: string) => void;
};

type Row =
  | {
      kind: "entry";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      isExpanded: boolean;
      depth: number;
    }
  | {
      kind: "rename";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      depth: number;
    }
  | { kind: "pending"; key: string; depth: number; pendingKind: "file" | "dir" }
  | {
      kind: "status";
      key: string;
      depth: number;
      tone: "muted" | "error";
      message: string;
    };

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function buildRows(
  rootPath: string,
  tree: ReturnType<typeof useFileTree>,
): { rows: Row[]; entryIndexByPath: Map<string, number> } {
  const rows: Row[] = [];
  const entryIndexByPath = new Map<string, number>();

  const walk = (parent: string, depth: number) => {
    const node = tree.nodes[parent];
    if (!node || node.status !== "loaded") return;
    for (const entry of node.entries) {
      const path = tree.joinPath(parent, entry.name);
      const isDir = entry.kind === "dir";
      const expanded = isDir && tree.expanded.has(path);
      const isRenaming = tree.renaming === path;
      if (isRenaming) {
        rows.push({
          kind: "rename",
          key: `rename:${path}`,
          path,
          name: entry.name,
          isDir,
          depth,
        });
      } else {
        entryIndexByPath.set(path, rows.length);
        rows.push({
          kind: "entry",
          key: path,
          path,
          name: entry.name,
          isDir,
          isExpanded: expanded,
          depth,
        });
      }
      if (isDir && expanded) {
        const child = tree.nodes[path];
        if (tree.pendingCreate?.parentPath === path) {
          rows.push({
            kind: "pending",
            key: `pending:${path}`,
            depth: depth + 1,
            pendingKind: tree.pendingCreate.kind,
          });
        }
        if (child?.status === "loading") {
          rows.push({
            kind: "status",
            key: `loading:${path}`,
            depth: depth + 1,
            tone: "muted",
            message: "Loading…",
          });
        } else if (child?.status === "error") {
          rows.push({
            kind: "status",
            key: `error:${path}`,
            depth: depth + 1,
            tone: "error",
            message: child.message,
          });
        } else if (child?.status === "loaded") {
          walk(path, depth + 1);
        }
      }
    }
  };

  walk(rootPath, 0);
  return { rows, entryIndexByPath };
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(
  function FileExplorer(
    {
      rootPath,
      activeFilePath,
      onOpenFile,
      onPathRenamed,
      onPathDeleted,
      onRevealInTerminal,
      onAttachToAgent,
      onOpenMarkdownPreview,
    },
    ref,
  ) {
    const tree = useFileTree(rootPath, { onPathRenamed, onPathDeleted });
    const isRemote = useWorkspaceEnvStore((s) => s.env.kind === "ssh");
    // Multi-select: `selectedPaths` is the full selection; `leadPath` is the
    // active cursor / "last clicked" row used for keyboard nav, range anchor
    // origin, and New File/Folder/Rename targets.
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [leadPath, setLeadPath] = useState<string | null>(null);
    const anchorRef = useRef<string | null>(null);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [isSearchActive, setIsSearchActive] = useState(false);
    const searchRef = useRef<ExplorerSearchHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { rows, entryIndexByPath } = useMemo(() => {
      if (!rootPath)
        return {
          rows: [] as Row[],
          entryIndexByPath: new Map<string, number>(),
        };
      return buildRows(rootPath, tree);
    }, [
      rootPath,
      tree.nodes,
      tree.expanded,
      tree.renaming,
      tree.pendingCreate,
      tree,
    ]);

    const entryPaths = useMemo<string[]>(() => {
      const out: string[] = [];
      for (const row of rows) if (row.kind === "entry") out.push(row.path);
      return out;
    }, [rows]);

    // Ordered selection (visible rows only), for multi-target context actions.
    const selectedPathList = useMemo(
      () => entryPaths.filter((p) => selectedPaths.has(p)),
      [entryPaths, selectedPaths],
    );

    // Drop any selected/lead path that's no longer visible (collapsed, deleted).
    useEffect(() => {
      setSelectedPaths((prev) => {
        let changed = false;
        const next = new Set<string>();
        for (const p of prev) {
          if (entryIndexByPath.has(p)) next.add(p);
          else changed = true;
        }
        return changed ? next : prev;
      });
      if (leadPath && !entryIndexByPath.has(leadPath)) setLeadPath(null);
    }, [entryIndexByPath, leadPath]);

    const selectOnly = useCallback((path: string) => {
      setSelectedPaths(new Set([path]));
      setLeadPath(path);
      anchorRef.current = path;
    }, []);

    const toggleSelect = useCallback((path: string) => {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setLeadPath(path);
      anchorRef.current = path;
    }, []);

    const selectRange = useCallback(
      (path: string) => {
        const anchor = anchorRef.current ?? leadPath ?? path;
        const ai = entryPaths.indexOf(anchor);
        const bi = entryPaths.indexOf(path);
        if (ai < 0 || bi < 0) {
          selectOnly(path);
          return;
        }
        const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
        setSelectedPaths(new Set(entryPaths.slice(lo, hi + 1)));
        setLeadPath(path);
      },
      [entryPaths, leadPath, selectOnly],
    );

    const handleSelect = useCallback(
      (path: string, mode: "only" | "toggle" | "range") => {
        if (mode === "toggle") toggleSelect(path);
        else if (mode === "range") selectRange(path);
        else selectOnly(path);
      },
      [toggleSelect, selectRange, selectOnly],
    );

    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      getItemKey: (index) => rows[index]?.key ?? index,
    });

    const scrollEntryIntoView = useCallback(
      (path: string) => {
        const index = entryIndexByPath.get(path);
        if (index === undefined) return;
        virtualizer.scrollToIndex(index, { align: "auto" });
      },
      [entryIndexByPath, virtualizer],
    );

    const lastSyncedActivePathRef = useRef<string | null>(null);
    useEffect(() => {
      if (
        !activeFilePath ||
        activeFilePath === lastSyncedActivePathRef.current
      ) {
        return;
      }
      if (!entryIndexByPath.has(activeFilePath)) return;
      lastSyncedActivePathRef.current = activeFilePath;
      selectOnly(activeFilePath);
      requestAnimationFrame(() => scrollEntryIntoView(activeFilePath));
    }, [activeFilePath, entryIndexByPath, scrollEntryIntoView, selectOnly]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          containerRef.current?.focus();
          if (!leadPath && entryPaths.length > 0) {
            const first = entryPaths[0];
            selectOnly(first);
            requestAnimationFrame(() => scrollEntryIntoView(first));
          }
        },
        isFocused: () => {
          const c = containerRef.current;
          if (!c) return false;
          const active = document.activeElement;
          return active instanceof Node && c.contains(active);
        },
      }),
      [entryPaths, scrollEntryIntoView, leadPath, selectOnly],
    );

    useGlobalShortcuts({
      "explorer.search": () => {
        if (searchRef.current?.isFocused()) {
          setIsSearchOpen(false);
          return;
        }
        setIsSearchOpen(true);
        searchRef.current?.focus();
      },
    });

    // Refresh (and reveal) a folder after files land in it via drop / move.
    const refreshDest = useCallback(
      (folder: string) => {
        if (folder !== rootPath) tree.expand(folder);
        tree.refresh(folder);
      },
      [rootPath, tree],
    );

    // Native OS file drops onto the tree (Finder → folder), incl. SSH.
    useExplorerFileDrop({ rootPath, onCopied: refreshDest });

    // Highlight ring for the current drop target (rows handle their own; this
    // covers a drop onto the empty area = root).
    const dropTarget = useExplorerDropStore((s) => s.targetFolder);

    if (!rootPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={24}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
          <div className="text-xs text-muted-foreground">
            No current directory
          </div>
        </div>
      );
    }

    const root = tree.nodes[rootPath];
    const pendingAtRoot =
      tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

    const pasteToFolder = async (destFolder: string) => {
      const n = await pasteIntoFolder(destFolder);
      if (n > 0) {
        if (destFolder !== rootPath) tree.expand(destFolder);
        tree.refresh(destFolder);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (tree.renaming || tree.pendingCreate || isSearchOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;

      // Cmd/Ctrl+V — paste clipboard file(s) into the selected folder (or the
      // parent folder of a selected file, or the root when nothing is selected).
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "v" || e.key === "V")
      ) {
        e.preventDefault();
        let destFolder = rootPath;
        if (leadPath) {
          const idx = entryIndexByPath.get(leadPath);
          const row = idx !== undefined ? rows[idx] : undefined;
          if (row && row.kind === "entry") {
            destFolder = row.isDir
              ? row.path
              : row.path.slice(0, row.path.lastIndexOf("/")) || rootPath;
          }
        }
        void pasteToFolder(destFolder);
        return;
      }

      // F2 — rename the lead file (rename moved off double-click).
      if (e.key === "F2" && leadPath) {
        const idx = entryIndexByPath.get(leadPath);
        const row = idx !== undefined ? rows[idx] : undefined;
        if (row && row.kind === "entry" && !row.isDir) {
          e.preventDefault();
          tree.beginRename(leadPath);
        }
        return;
      }

      if (entryPaths.length === 0) return;

      const currentIdx = leadPath ? entryPaths.indexOf(leadPath) : -1;
      const move = (next: number, extend = false) => {
        const clamped = Math.max(0, Math.min(entryPaths.length - 1, next));
        const path = entryPaths[clamped];
        if (extend) selectRange(path);
        else selectOnly(path);
        requestAnimationFrame(() => scrollEntryIntoView(path));
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(currentIdx < 0 ? 0 : currentIdx + 1, e.shiftKey);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(
            currentIdx < 0 ? entryPaths.length - 1 : currentIdx - 1,
            e.shiftKey,
          );
          break;
        case "ArrowRight": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) {
            if (!row.isExpanded) tree.toggle(row.path);
            else move(currentIdx + 1);
          }
          break;
        }
        case "ArrowLeft": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir && row.isExpanded) {
            tree.toggle(row.path);
          } else {
            const parent = row.path.slice(0, row.path.lastIndexOf("/"));
            if (parent && parent !== rootPath) selectOnly(parent);
          }
          break;
        }
        case "Enter": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) tree.toggle(row.path);
          else onOpenFile(row.path);
          break;
        }
      }
    };

    const renderRow = (row: Row) => {
      switch (row.kind) {
        case "entry":
        case "rename": {
          return (
            <EntryRow
              path={row.path}
              name={row.name}
              isDir={row.isDir}
              isExpanded={row.kind === "entry" ? row.isExpanded : false}
              depth={row.depth}
              rootPath={rootPath}
              isRemote={isRemote}
              tree={tree}
              isSelected={selectedPaths.has(row.path)}
              selectedPaths={selectedPathList}
              isRenaming={row.kind === "rename"}
              onOpenFile={onOpenFile}
              onSelect={handleSelect}
              onRevealInTerminal={onRevealInTerminal}
              onAttachToAgent={onAttachToAgent}
              onOpenMarkdownPreview={onOpenMarkdownPreview}
            />
          );
        }
        case "pending":
          return (
            <PendingRow
              depth={row.depth}
              kind={row.pendingKind}
              onCommit={tree.commitCreate}
              onCancel={tree.cancelCreate}
            />
          );
        case "status":
          return (
            <StatusRow
              depth={row.depth}
              message={row.message}
              tone={row.tone}
            />
          );
      }
    };

    return (
      <div
        ref={containerRef}
        data-explorer-root={rootPath}
        className={cn(
          "flex h-full flex-col outline-none",
          // Drops onto empty space target the root folder.
          dropTarget === rootPath && "ring-1 ring-inset ring-primary",
        )}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <DragGhost />
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span
            className="flex flex-1 items-center truncate text-xs font-medium text-foreground/80"
            title={rootPath}
          >
            <img
              src={folderIconUrl(basename(rootPath), false)}
              alt=""
              height={15}
              width={15}
              className="mx-1.5"
            />
            {basename(rootPath)}
          </span>

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => setIsSearchOpen((v) => !v)}
            title="Search files"
            aria-label="Search files"
          >
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "file")}
            title="New file"
          >
            <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "dir")}
            title="New folder"
          >
            <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.refresh(rootPath)}
            title="Refresh"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
          </Button>
        </div>

        <ExplorerSearch
          ref={searchRef}
          rootPath={rootPath}
          onOpenFile={onOpenFile}
          open={isSearchOpen}
          onRequestClose={() => setIsSearchOpen(false)}
          onActiveChange={setIsSearchActive}
          onRevealInTerminal={onRevealInTerminal}
          onAttachToAgent={onAttachToAgent}
        />

        {!isSearchActive ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={scrollRef}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
              >
                {pendingAtRoot ? (
                  <div
                    className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
                    style={{ paddingLeft: 6 }}
                  >
                    <span className="size-3.5 shrink-0" />
                    <img
                      src={
                        pendingAtRoot.kind === "dir"
                          ? folderIconUrl("", false)
                          : fileIconUrl("untitled")
                      }
                      alt=""
                      className="size-4 shrink-0 opacity-70"
                    />
                    <InlineInput
                      initial=""
                      placeholder={
                        pendingAtRoot.kind === "dir" ? "New folder" : "New file"
                      }
                      onCommit={tree.commitCreate}
                      onCancel={tree.cancelCreate}
                    />
                  </div>
                ) : null}
                {root?.status === "loading" && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Loading…
                  </div>
                )}
                {root?.status === "error" && (
                  <div className="px-3 py-2 text-[11px] text-destructive">
                    {root.message}
                  </div>
                )}
                {root?.status === "loaded" ? (
                  <div
                    style={{
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                      width: "100%",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          data-virtual-row-index={virtualRow.index}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          {renderRow(row)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              className={COMPACT_CONTENT}
              onCloseAutoFocus={(e) => {
                if (tree.renaming || tree.pendingCreate) e.preventDefault();
              }}
            >
              {onRevealInTerminal && (
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => onRevealInTerminal(rootPath)}
                >
                  Open in Terminal
                </ContextMenuItem>
              )}
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void revealInFinder(rootPath)}
              >
                Reveal in Finder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.beginCreate(rootPath, "file")}
              >
                New File
              </ContextMenuItem>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.beginCreate(rootPath, "dir")}
              >
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void pasteToFolder(rootPath)}
              >
                Paste
              </ContextMenuItem>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void copyToClipboard(rootPath)}
              >
                Copy Path
              </ContextMenuItem>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.refresh(rootPath)}
              >
                Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}
      </div>
    );
  },
);
