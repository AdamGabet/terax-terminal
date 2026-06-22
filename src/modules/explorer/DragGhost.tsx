import { createPortal } from "react-dom";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { useExplorerDropStore } from "./lib/dropTarget";

/**
 * A small badge pinned next to the cursor while dragging file(s) in the tree,
 * so it reads as "holding a file". Portaled to <body> and pointer-events-none
 * so it never intercepts the drop. Rendered once by FileExplorer.
 */
export function DragGhost() {
  const drag = useExplorerDropStore((s) => s.drag);
  const pointer = useExplorerDropStore((s) => s.pointer);
  if (!drag) return null;

  const icon = drag.isDir
    ? folderIconUrl(drag.name, false)
    : fileIconUrl(drag.name);
  return createPortal(
    <div
      className="pointer-events-none fixed z-[9999] flex max-w-56 items-center gap-1.5 rounded-md border border-border/70 bg-popover/95 px-2 py-1 text-xs text-foreground shadow-lg backdrop-blur-sm animate-in fade-in zoom-in-95 duration-100"
      style={{
        left: pointer.x + 12,
        top: pointer.y + 12,
      }}
    >
      {icon ? (
        <img src={icon} alt="" className="size-4 shrink-0" />
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span className="truncate">{drag.name}</span>
      {drag.count > 1 && (
        <span className="ml-0.5 shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground">
          {drag.count}
        </span>
      )}
    </div>,
    document.body,
  );
}
