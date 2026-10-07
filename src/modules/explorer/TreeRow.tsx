import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useRef, useState } from "react";
import { toast } from "sonner";
import { InlineInput } from "./InlineInput";
import { folderAtPoint, useExplorerDropStore } from "./lib/dropTarget";
import {
  copyFilesToClipboard,
  copyToClipboard,
  downloadRemoteFiles,
  pasteIntoFolder,
  relativePath,
  revealInFinder,
} from "./lib/contextActions";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import type { useFileTree } from "./lib/useFileTree";

type Tree = ReturnType<typeof useFileTree>;

export type SelectMode = "only" | "toggle" | "range";

export type EntryRowProps = {
  path: string;
  name: string;
  isDir: boolean;
  isExpanded: boolean;
  depth: number;
  rootPath: string;
  isRemote: boolean;
  tree: Tree;
  isSelected: boolean;
  /** Ordered current selection — used to compute multi-target context actions. */
  selectedPaths: string[];
  isRenaming: boolean;
  onOpenFile: (path: string, pin?: boolean) => void;
  onSelect: (path: string, mode: SelectMode) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onOpenMarkdownPreview?: (path: string) => void;
};

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function EntryRowImpl(props: EntryRowProps) {
  const {
    path,
    name,
    isDir,
    isExpanded,
    depth,
    rootPath,
    isRemote,
    tree,
    isSelected,
    selectedPaths,
    isRenaming,
    onOpenFile,
    onSelect,
    onRevealInTerminal,
    onAttachToAgent,
    onOpenMarkdownPreview,
  } = props;

  const [isConfirming, setIsConfirming] = useState(false);
  const iconUrl = isDir ? folderIconUrl(name, isExpanded) : fileIconUrl(name);
  const createTarget = isDir
    ? path
    : path.slice(0, path.lastIndexOf("/")) || rootPath;
  const paddingLeft = 6 + depth * 12;

  // Context actions operate on the whole selection when the right-clicked row
  // is part of it; otherwise just on this row.
  const targets = selectedPaths.includes(path) ? selectedPaths : [path];
  const multi = targets.length > 1;

  // Pointer-based drag to move file(s)/folder(s) into another folder. Pointer
  // events (not HTML5 drag) because Tauri's native drag-drop is enabled and
  // suppresses HTML5 element dragging in the webview.
  const dropTarget = useExplorerDropStore((s) => s.targetFolder);
  const isDropTarget = isDir && dropTarget === path;
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Set when a drag just ended, so the trailing `click` is swallowed (and the
  // file isn't opened / folder toggled). Cleared by that click or the next
  // pointer-down. dragRef is null by the time the click fires, so we can't
  // read `.moved` there.
  const justDraggedRef = useRef(false);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverFolderRef = useRef<string | null>(null);

  const clearExpandTimer = () => {
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
    hoverFolderRef.current = null;
  };

  const cancelRowDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    clearExpandTimer();
    if (!d?.moved) return;
    justDraggedRef.current = true;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released — ignore.
    }
    useExplorerDropStore.getState().endDrag();
  };

  const onRowPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || isRenaming) return;
    justDraggedRef.current = false;
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };

  const onRowPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const store = useExplorerDropStore.getState();
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < 5 && Math.abs(e.clientY - d.y) < 5)
        return;
      d.moved = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // Capture unavailable (e.g. mouse already up) — continue without it.
      }
      store.startDrag(
        { name, isDir, count: targets.length },
        e.clientX,
        e.clientY,
      );
      // Escape cancels the in-flight drag without moving anything.
      const onKey = (ke: KeyboardEvent) => {
        if (ke.key !== "Escape") return;
        ke.preventDefault();
        ke.stopPropagation();
        dragRef.current = null;
        clearExpandTimer();
        justDraggedRef.current = true;
        useExplorerDropStore.getState().endDrag();
        window.removeEventListener("keydown", onKey, true);
      };
      window.addEventListener("keydown", onKey, true);
      // Remove the listener when the drag store resets (drop/cancel elsewhere).
      const unsub = useExplorerDropStore.subscribe((s) => {
        if (s.drag === null) {
          window.removeEventListener("keydown", onKey, true);
          unsub();
        }
      });
    }
    store.moveDrag(e.clientX, e.clientY);
    const dest = folderAtPoint(e.clientX, e.clientY, rootPath);
    store.setTarget(dest);

    // Auto-scroll the tree when dragging near the top/bottom edge.
    const root = (e.currentTarget as HTMLElement).closest(
      "[data-explorer-root]",
    );
    const scroller = root?.querySelector(".overflow-y-auto");
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const MARGIN = 28;
      const SPEED = 10;
      if (e.clientY < r.top + MARGIN) scroller.scrollTop -= SPEED;
      else if (e.clientY > r.bottom - MARGIN) scroller.scrollTop += SPEED;
    }

    // Hover a collapsed folder ~700ms to auto-expand it, so drops can reach
    // nested targets without aborting the drag.
    if (dest && dest !== hoverFolderRef.current) {
      clearExpandTimer();
      hoverFolderRef.current = dest;
      if (!tree.expanded.has(dest)) {
        expandTimerRef.current = setTimeout(() => {
          if (dragRef.current?.moved) tree.expand(dest);
        }, 700);
      }
    } else if (!dest) {
      clearExpandTimer();
    }
  };

  const endRowDrag = (e: React.PointerEvent) => {
    // Pointer-cancel (leaving the window, OS interruption, touch cancel) must
    // never trigger a move — only a real pointer-up drops.
    if (e.type === "pointercancel") {
      cancelRowDrag(e);
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    clearExpandTimer();
    if (!d?.moved) return;
    justDraggedRef.current = true;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released — ignore.
    }
    const dest = folderAtPoint(e.clientX, e.clientY, rootPath);
    useExplorerDropStore.getState().endDrag();
    if (!dest) return;
    // Silent no-op when dropping onto where the items already are (or into
    // themselves / a descendant) — avoids a confusing "Couldn't move" toast
    // for an accidental self-drop. movePaths still guards this; this just
    // skips the round-trip and the error toast.
    const isSelfDrop = targets.every((t) => {
      const parent = t.slice(0, t.lastIndexOf("/")) || rootPath;
      if (parent === dest) return true;
      return dest === t || dest.startsWith(`${t}/`);
    });
    if (isSelfDrop) return;
    void tree.movePaths(targets, dest).then((r) => {
      if (r.failed.length > 0) {
        toast.error(`Couldn't move: ${r.failed.join(", ")}`);
      } else if (r.moved > 0) {
        toast.success(`Moved ${r.moved} item${r.moved > 1 ? "s" : ""}`);
      }
    });
  };

  const handleClick = (e: React.MouseEvent) => {
    if (tree.renaming) return;
    if (e.shiftKey) {
      onSelect(path, "range");
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      onSelect(path, "toggle");
      return;
    }
    onSelect(path, "only");
    if (isDir) tree.toggle(path);
    else onOpenFile(path);
  };

  // Right-click on a row outside the current selection collapses onto it, so
  // the menu acts on what the user clicked (Finder/VSCode behavior).
  const handleContextMenu = () => {
    if (!selectedPaths.includes(path)) onSelect(path, "only");
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {isRenaming ? (
          <div
            className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
            style={{ paddingLeft }}
          >
            <span className="size-3.5 shrink-0" />
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <InlineInput
              initial={name}
              onCommit={tree.commitRename}
              onCancel={tree.cancelRename}
            />
          </div>
        ) : (
          <button
            type="button"
            data-fs-path={path}
            data-fs-dir={isDir ? "1" : undefined}
            onClick={handleClick}
            onDoubleClick={() => !isDir && onOpenFile(path, true)}
            onContextMenu={handleContextMenu}
            onPointerDown={onRowPointerDown}
            onPointerMove={onRowPointerMove}
            onPointerUp={endRowDrag}
            onPointerCancel={endRowDrag}
            onClickCapture={(e) => {
              // Swallow the click that trails a real drag (would select/open).
              if (justDraggedRef.current) {
                justDraggedRef.current = false;
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            className={cn(
              "group flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-accent/70",
              isSelected && "bg-accent text-foreground",
              isDropTarget && "ring-1 ring-inset ring-primary bg-accent/50",
            )}
            style={{ paddingLeft }}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
              {isDir ? (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={12}
                  strokeWidth={2.25}
                  className={cn(
                    "transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
              ) : null}
            </span>
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{name}</span>
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent
        className={COMPACT_CONTENT}
        onCloseAutoFocus={(e) => {
          if (tree.renaming || tree.pendingCreate) e.preventDefault();
        }}
      >
        {!isDir && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenFile(path, true)}
          >
            Open
          </ContextMenuItem>
        )}
        {!isDir && isMarkdownPath(path) && onOpenMarkdownPreview && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenMarkdownPreview(path)}
          >
            Open Preview
          </ContextMenuItem>
        )}
        {isDir && onRevealInTerminal && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onRevealInTerminal(targets[0])}
          >
            Open in Terminal
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void revealInFinder(targets[0])}
        >
          Reveal in Finder
        </ContextMenuItem>
        {!isDir && isRemote && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => void downloadRemoteFiles(targets)}
          >
            {multi ? `Download ${targets.length} items…` : "Download…"}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => tree.beginCreate(createTarget, "file")}
        >
          New File
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => tree.beginCreate(createTarget, "dir")}
        >
          New Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => copyFilesToClipboard(targets)}
        >
          {multi ? `Copy ${targets.length} items` : "Copy"}
        </ContextMenuItem>
        {isDir && !multi && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={async () => {
              const n = await pasteIntoFolder(path);
              if (n > 0) {
                tree.expand(path);
                tree.refresh(path);
              }
            }}
          >
            Paste
          </ContextMenuItem>
        )}
        {!isDir && !multi && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => tree.beginRename(path)}
          >
            Rename
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(targets.join("\n"))}
        >
          {multi ? "Copy Paths" : "Copy Path"}
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() =>
            void copyToClipboard(
              targets.map((p) => relativePath(rootPath, p)).join("\n"),
            )
          }
        >
          {multi ? "Copy Relative Paths" : "Copy Relative Path"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => {
            for (const p of targets) onAttachToAgent?.(p);
          }}
        >
          {multi
            ? `Attach ${targets.length} items to Agent`
            : "Attach to Agent"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          variant="destructive"
          onSelect={(e) => {
            e.preventDefault();
            if (isConfirming) {
              if (multi) void tree.deletePaths(targets);
              else void tree.deletePath(path);
            } else {
              setIsConfirming(true);
            }
          }}
          onMouseLeave={() => setTimeout(() => setIsConfirming(false), 1500)}
        >
          {isConfirming
            ? "Click again to confirm"
            : multi
              ? `Delete ${targets.length} items`
              : "Delete"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const EntryRow = memo(EntryRowImpl);

export type PendingRowProps = {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
};

export function PendingRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: PendingRowProps) {
  return (
    <div
      className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="size-3.5 shrink-0" />
      <img
        src={
          kind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")
        }
        alt=""
        className="size-4 shrink-0 opacity-70"
      />
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function StatusRow({
  depth,
  message,
  tone,
}: {
  depth: number;
  message: string;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: 6 + depth * 12 + 18 }}
    >
      {message}
    </div>
  );
}
