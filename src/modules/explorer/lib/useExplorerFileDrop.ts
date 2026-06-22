import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";
import { currentWorkspaceEnv, LOCAL_WORKSPACE } from "@/modules/workspace";
import { copyPathsIntoFolder } from "./contextActions";
import { folderAtPoint, useExplorerDropStore } from "./dropTarget";

// Tauri reports the drop point in physical pixels on some platforms and
// logical on others; only scale down when it overflows the logical viewport.
// (Mirrors the terminal drop hook.)
function toLogical(x: number, y: number): [number, number] {
  if (x > window.innerWidth || y > window.innerHeight) {
    const dpr = window.devicePixelRatio || 1;
    return [x / dpr, y / dpr];
  }
  return [x, y];
}

/**
 * Wires native OS file drops onto the file-explorer tree: highlights the folder
 * under the cursor while dragging, and on drop copies the dropped file(s) and
 * folder(s) into it (recursively, and across SSH). Drops outside the explorer
 * are ignored here — the terminal drop hook handles those. `onCopied` runs with
 * the destination folder so the caller can refresh/expand it.
 */
export function useExplorerFileDrop(opts: {
  rootPath: string | null;
  onCopied: (destFolder: string) => void;
}): void {
  const rootRef = useRef(opts.rootPath);
  rootRef.current = opts.rootPath;
  const onCopiedRef = useRef(opts.onCopied);
  onCopiedRef.current = opts.onCopied;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const setTarget = useExplorerDropStore.getState().setTarget;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") {
          const [x, y] = toLogical(p.position.x, p.position.y);
          setTarget(folderAtPoint(x, y, rootRef.current));
          return;
        }
        if (p.type === "leave") {
          setTarget(null);
          return;
        }
        if (p.type === "drop") {
          const [x, y] = toLogical(p.position.x, p.position.y);
          const dest = folderAtPoint(x, y, rootRef.current);
          setTarget(null);
          if (!dest || !p.paths.length) return;
          void copyPathsIntoFolder(
            p.paths,
            LOCAL_WORKSPACE,
            dest,
            currentWorkspaceEnv(),
          ).then((n) => {
            if (n > 0) onCopiedRef.current(dest);
          });
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("[terax] explorer drag-drop listen failed:", err),
      );

    return () => {
      disposed = true;
      setTarget(null);
      unlisten?.();
    };
  }, []);
}
