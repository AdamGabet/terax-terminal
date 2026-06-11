/**
 * Pure matching/resolution logic for terminal file links. Kept free of Tauri
 * imports so it is unit-testable; the xterm provider lives in fileLinks.ts.
 */

import { PREVIEWABLE_EXTENSIONS } from "@/modules/file-preview/previewable";
import type { WorkspaceEnv } from "@/modules/workspace";

// Optional drive-letter prefix, then a run of path-safe chars, ending in a
// previewable extension. Quotes/brackets/colons delimit so `a.png:12` (grep
// output) still matches `a.png`.
const FILE_LINK_RE = new RegExp(
  "(?:[A-Za-z]:[\\\\/])?[^\\s\"'`()\\[\\]:;,<>|*?]+\\.(?:" +
    PREVIEWABLE_EXTENSIONS.join("|") +
    ")\\b",
  "gi",
);

export type FileLinkMatch = { index: number; text: string };

export function findFileLinkMatches(text: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = [];
  FILE_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    out.push({ index: m.index, text: m[0] });
  }
  return out;
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** Lexical normalize: forward slashes, resolve `.` and `..` segments. */
function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const drive = /^[A-Za-z]:\//.test(slashed) ? slashed.slice(0, 2) : "";
  const rest = drive ? slashed.slice(2) : slashed;
  const absolute = rest.startsWith("/");
  const segments: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (segments.length && segments[segments.length - 1] !== "..") {
        segments.pop();
        continue;
      }
      if (absolute) continue;
    }
    segments.push(seg);
  }
  return drive + (absolute ? "/" : "") + segments.join("/");
}

/**
 * Absolute path for a matched token, or null when it can't be resolved.
 * `~` stays literal for SSH (the remote agent expands it); locally it's
 * replaced with the host home dir.
 */
export function resolveFileLinkPath(
  raw: string,
  cwd: string | null,
  env: WorkspaceEnv,
  homeDir: string | null,
): string | null {
  if (raw.startsWith("~/")) {
    if (env.kind === "ssh") return raw;
    if (!homeDir) return null;
    return normalizePath(`${homeDir}/${raw.slice(2)}`);
  }
  if (isAbsolute(raw)) return normalizePath(raw);
  if (!cwd) return null;
  return normalizePath(`${cwd}/${raw}`);
}
