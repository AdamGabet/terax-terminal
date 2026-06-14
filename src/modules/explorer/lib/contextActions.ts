import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  currentWorkspaceEnv,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { joinPath } from "./useFileTree";

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

export function relativePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  if (path.startsWith(`${rootPath}/`)) return path.slice(rootPath.length + 1);
  return path;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}

function basename(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

type ReadBinaryResult =
  | { kind: "data"; base64: string; size: number }
  | { kind: "toolarge"; size: number; limit: number };

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Save a remote (SSH) file to the local machine via a native save dialog.
 * Reads the bytes through the workspace-aware `fs_read_file_base64` command and
 * writes them locally with `fs_write_file_base64`. Capped at the backend's
 * 50 MB binary-read limit.
 */
export async function downloadRemoteFile(remotePath: string): Promise<void> {
  const source = currentWorkspaceEnv();
  try {
    const dest = await save({ defaultPath: basename(remotePath) });
    if (!dest) return; // user cancelled

    const res = await invoke<ReadBinaryResult>("fs_read_file_base64", {
      path: remotePath,
      workspace: source,
    });
    if (res.kind === "toolarge") {
      toast.error(
        `${basename(remotePath)} is too large to download (max ${mb(res.limit)} MB)`,
      );
      return;
    }
    await invoke("fs_write_file_base64", {
      path: dest,
      base64: res.base64,
      workspace: LOCAL_WORKSPACE,
    });
    toast.success(`Downloaded ${basename(remotePath)}`);
  } catch (e) {
    console.error("downloadRemoteFile failed:", e);
    toast.error(`Download failed: ${String(e)}`);
  }
}

/**
 * Download one or more remote files to the local machine. A single file uses
 * the save dialog (choose name + location); multiple files prompt once for a
 * destination folder and land there keeping their names.
 */
export async function downloadRemoteFiles(remotePaths: string[]): Promise<void> {
  if (remotePaths.length === 0) return;
  if (remotePaths.length === 1) {
    await downloadRemoteFile(remotePaths[0]);
    return;
  }

  const source = currentWorkspaceEnv();
  const destDir = await open({
    directory: true,
    title: "Choose a download destination",
  });
  if (!destDir || typeof destDir !== "string") return;

  let downloaded = 0;
  const failed: string[] = [];
  for (const src of remotePaths) {
    try {
      const res = await invoke<ReadBinaryResult>("fs_read_file_base64", {
        path: src,
        workspace: source,
      });
      if (res.kind === "toolarge") {
        failed.push(`${basename(src)} (over ${mb(res.limit)} MB)`);
        continue;
      }
      await invoke("fs_write_file_base64", {
        path: joinPath(destDir, basename(src)),
        base64: res.base64,
        workspace: LOCAL_WORKSPACE,
      });
      downloaded += 1;
    } catch (e) {
      console.error(`download ${src} failed:`, e);
      // Folders (recursive download) aren't supported yet — they land here.
      failed.push(basename(src));
    }
  }

  if (downloaded > 0) {
    toast.success(`Downloaded ${downloaded} file${downloaded > 1 ? "s" : ""}`);
  }
  if (failed.length > 0) toast.error(`Couldn't download: ${failed.join(", ")}`);
}

// --- in-app file clipboard ---------------------------------------------------

type FileClipboard = { paths: string[]; sourceWorkspace: WorkspaceEnv };

// Module-level so a copy in one tree survives until the next copy/paste. Lets
// you copy a *remote* file (which never lands on the OS clipboard) and paste it
// elsewhere — local or remote.
let fileClipboard: FileClipboard | null = null;

/** Copy a file reference into the in-app clipboard for a later paste. */
export function copyFileToClipboard(path: string): void {
  copyFilesToClipboard([path]);
}

/** Copy one or more file references into the in-app clipboard. */
export function copyFilesToClipboard(paths: string[]): void {
  if (paths.length === 0) return;
  fileClipboard = { paths, sourceWorkspace: currentWorkspaceEnv() };
  toast(
    paths.length === 1
      ? `Copied ${basename(paths[0])}`
      : `Copied ${paths.length} items`,
  );
}

/**
 * Write the clipboard's file(s) into `destFolder` (the current workspace).
 * Prefers the in-app clipboard; otherwise falls back to files copied in the OS
 * file manager (Finder/Explorer) via the `clipboard_read_files` command.
 * Every case is a base64 round-trip, so local→remote uploads, remote→local
 * downloads, and same-host copies all work uniformly. Returns the count pasted.
 */
export async function pasteIntoFolder(destFolder: string): Promise<number> {
  const destWorkspace = currentWorkspaceEnv();

  let sources: FileClipboard;
  if (fileClipboard && fileClipboard.paths.length > 0) {
    sources = fileClipboard;
  } else {
    let osPaths: string[] = [];
    try {
      osPaths = await invoke<string[]>("clipboard_read_files");
    } catch (e) {
      console.error("clipboard_read_files failed:", e);
    }
    if (osPaths.length === 0) {
      toast("Clipboard has no files to paste");
      return 0;
    }
    sources = { paths: osPaths, sourceWorkspace: LOCAL_WORKSPACE };
  }

  let pasted = 0;
  const failed: string[] = [];
  for (const src of sources.paths) {
    try {
      const res = await invoke<ReadBinaryResult>("fs_read_file_base64", {
        path: src,
        workspace: sources.sourceWorkspace,
      });
      if (res.kind === "toolarge") {
        failed.push(`${basename(src)} (over ${mb(res.limit)} MB)`);
        continue;
      }
      await invoke("fs_write_file_base64", {
        path: joinPath(destFolder, basename(src)),
        base64: res.base64,
        workspace: destWorkspace,
      });
      pasted += 1;
    } catch (e) {
      console.error(`paste ${src} failed:`, e);
      // Folders (recursive copy) aren't supported yet — they land here.
      failed.push(basename(src));
    }
  }

  if (pasted > 0) toast.success(`Pasted ${pasted} file${pasted > 1 ? "s" : ""}`);
  if (failed.length > 0) toast.error(`Couldn't paste: ${failed.join(", ")}`);
  return pasted;
}
