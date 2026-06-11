/**
 * Clickable file links in the terminal for previewable files (images, PDFs).
 *
 * A custom xterm link provider scans hovered lines for path-like tokens with
 * a previewable extension, resolves them against the leaf's cwd (OSC 7 /
 * SSH-polled), validates existence with fs_stat (workspace-aware, so it works
 * over SSH), and opens the in-app file preview tab on click.
 */

import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findFileLinkMatches, resolveFileLinkPath } from "./fileLinkMatch";

type Opener = (path: string) => void;

let opener: Opener | null = null;
let localHomeDir: string | null = null;

/** Wire the App-level tab opener + local home dir (for `~` expansion). */
export function configureFileLinks(cfg: {
  open: Opener;
  homeDir: string | null;
}): void {
  opener = cfg.open;
  localHomeDir = cfg.homeDir;
}

type FileStat = {
  size: number;
  mtime: number;
  kind: "file" | "dir" | "symlink";
};

const STAT_CACHE_TTL_MS = 5_000;
const STAT_CACHE_MAX = 200;
const statCache = new Map<string, { ok: boolean; at: number }>();

async function isExistingFile(path: string): Promise<boolean> {
  const key = `${currentWorkspaceEnv().kind}:${path}`;
  const hit = statCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < STAT_CACHE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const stat = await invoke<FileStat>("fs_stat", {
      path,
      workspace: currentWorkspaceEnv(),
    });
    ok = stat.kind === "file";
  } catch {
    ok = false;
  }
  if (statCache.size >= STAT_CACHE_MAX) statCache.clear();
  statCache.set(key, { ok, at: now });
  return ok;
}

export function createFileLinkProvider(
  term: Terminal,
  getCwd: () => string | null,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      const text = line?.translateToString(true) ?? "";
      const matches = findFileLinkMatches(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const cwd = getCwd();
      const env = currentWorkspaceEnv();
      void Promise.all(
        matches.map(async (m): Promise<ILink | null> => {
          const resolved = resolveFileLinkPath(m.text, cwd, env, localHomeDir);
          if (!resolved || !(await isExistingFile(resolved))) return null;
          return {
            range: {
              start: { x: m.index + 1, y: bufferLineNumber },
              end: { x: m.index + m.text.length, y: bufferLineNumber },
            },
            text: m.text,
            decorations: { pointerCursor: true, underline: true },
            activate: () => opener?.(resolved),
          };
        }),
      ).then((links) => {
        const valid = links.filter((l): l is ILink => l !== null);
        callback(valid.length ? valid : undefined);
      });
    },
  };
}
