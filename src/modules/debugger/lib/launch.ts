import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { toast } from "sonner";
import { getDebuggerRootOverride } from "./interpreter";
import { useDebuggerStore } from "./store";

export const ROOT_MARKERS = [
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  ".git",
];

/** How many ancestors the remote marker walk climbs before giving up. */
const REMOTE_WALK_DEPTH = 12;

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i > 0) return path.slice(0, i);
  return i === 0 ? "/" : path;
}

/** Ancestor directories to probe for project markers, nearest first —
 * the remote root walk's iteration order. (Pure, for tests.) */
export function ancestorDirs(path: string, maxDepth = REMOTE_WALK_DEPTH) {
  const out: string[] = [];
  let dir = dirname(path);
  for (let depth = 0; depth < maxDepth && dir.length > 1; depth++) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Nearest ancestor with a project marker, else the script's directory.
 * Local workspaces use the Rust walk (`lsp_resolve_root`); remote ones walk
 * up with workspace-routed `fs_stat` calls (capped).
 */
export async function resolveRootForFile(
  path: string,
  workspace: WorkspaceEnv,
): Promise<string> {
  if (workspace.kind === "local") {
    const root = await invoke<string | null>("lsp_resolve_root", {
      path,
      markers: ROOT_MARKERS,
    }).catch(() => null);
    return root ?? dirname(path);
  }
  for (const dir of ancestorDirs(path)) {
    const hits = await Promise.all(
      ROOT_MARKERS.map((m) =>
        invoke("fs_stat", { path: `${dir}/${m}`, workspace }).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (hits.some(Boolean)) return dir;
  }
  return dirname(path);
}

/**
 * Resolves the project root for a .py file and starts debugging it in the
 * current workspace (local or SSH). Shared by the statusbar DebugPill and
 * the F5 shortcut.
 */
export async function startDebuggingFile(path: string): Promise<void> {
  const target = await prepareDebuggingFile(path);
  if (!target) return;
  useDebuggerStore.getState().start(target.path, target.root, {
    detectedRoot: target.detectedRoot,
  });
}

export async function openDebugPanelForFile(path: string): Promise<void> {
  const target = await prepareDebuggingFile(path);
  if (!target) return;
  useDebuggerStore.getState().prepare(target.path, target.root, {
    detectedRoot: target.detectedRoot,
  });
}

async function prepareDebuggingFile(path: string): Promise<{
  path: string;
  root: string;
  detectedRoot: string;
} | null> {
  const workspace = currentWorkspaceEnv();
  if (workspace.kind === "wsl") {
    toast.warning("Python debugging is not supported on WSL workspaces yet");
    return null;
  }
  const detectedRoot = await resolveRootForFile(path, workspace);
  const root = getDebuggerRootOverride(workspace, detectedRoot) ?? detectedRoot;
  return { path, root, detectedRoot };
}
