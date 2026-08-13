import type { WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

/** How many ancestors the remote marker walk climbs before giving up. Mirrors
 * the debugger's remote root resolution. */
const REMOTE_WALK_DEPTH = 12;

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i > 0) return path.slice(0, i);
  return i === 0 ? "/" : path;
}

/**
 * Nearest ancestor of `path` containing any of `markers`, or null when none is
 * found within the walk depth. Local workspaces use the Rust walk
 * (`lsp_resolve_root`); SSH ones walk up with workspace-routed `fs_stat` calls
 * (capped) so the root is resolved on the remote host, not the local disk. WSL
 * is unsupported (LSP servers don't spawn there yet).
 */
export async function resolveWorkspaceRoot(
  path: string,
  markers: string[],
  env: WorkspaceEnv,
): Promise<string | null> {
  if (env.kind === "local") {
    return invoke<string | null>("lsp_resolve_root", { path, markers }).catch(
      () => null,
    );
  }
  if (env.kind !== "ssh") return null;
  let dir = dirname(path);
  for (let depth = 0; depth < REMOTE_WALK_DEPTH && dir.length > 1; depth++) {
    const hits = await Promise.all(
      markers.map((m) =>
        invoke("fs_stat", { path: `${dir}/${m}`, workspace: env }).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (hits.some(Boolean)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
