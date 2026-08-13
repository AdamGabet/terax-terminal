/** Per-root interpreter override for debug runs, picked from the dock.
 * Stored in localStorage (scoped by workspace + project root) so a choice
 * survives restarts without touching the settings surface. */

import { invoke } from "@tauri-apps/api/core";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { pythonCandidates } from "./session";

const LS_PREFIX = "terax-debug-python:";
const ROOT_LS_PREFIX = "terax-debug-root:";

const overrideKey = (workspace: WorkspaceEnv, root: string) =>
  `${LS_PREFIX}${workspaceScopeKey(workspace)}:${root}`;

const rootOverrideKey = (workspace: WorkspaceEnv, detectedRoot: string) =>
  `${ROOT_LS_PREFIX}${workspaceScopeKey(workspace)}:${detectedRoot}`;

export function getPythonOverride(
  workspace: WorkspaceEnv,
  root: string,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(overrideKey(workspace, root));
  } catch {
    return null;
  }
}

export function setPythonOverride(
  workspace: WorkspaceEnv,
  root: string,
  path: string | null,
): void {
  if (typeof window === "undefined") return;
  try {
    if (path) window.localStorage.setItem(overrideKey(workspace, root), path);
    else window.localStorage.removeItem(overrideKey(workspace, root));
  } catch {
    /* ignore */
  }
}

/** Per-auto-detected-root debugger project root override. This lets users fix
 * bad marker detection while keeping future launches scoped to the same file
 * tree that produced the mistaken root. */
export function getDebuggerRootOverride(
  workspace: WorkspaceEnv,
  detectedRoot: string,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(rootOverrideKey(workspace, detectedRoot));
  } catch {
    return null;
  }
}

export function setDebuggerRootOverride(
  workspace: WorkspaceEnv,
  detectedRoot: string,
  root: string | null,
): void {
  if (typeof window === "undefined") return;
  try {
    if (root) window.localStorage.setItem(rootOverrideKey(workspace, detectedRoot), root);
    else window.localStorage.removeItem(rootOverrideKey(workspace, detectedRoot));
  } catch {
    /* ignore */
  }
}

/** Interpreters worth offering for a root: venvs that actually exist there,
 * then the system fallback. */
export async function discoverInterpreters(
  root: string,
  workspace: WorkspaceEnv,
): Promise<string[]> {
  const hits = await Promise.all(
    pythonCandidates(root, workspace).map((p) =>
      invoke("fs_stat", { path: p, workspace }).then(
        () => p,
        () => null,
      ),
    ),
  );
  const found = hits.filter((p): p is string => p !== null);
  found.push("python3");
  return [...new Set(found)];
}

/** Compact display form: relative to the root when possible. */
export function displayPython(path: string, root: string | null): string {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}
