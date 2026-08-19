import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { previewKindForPath } from "@/modules/file-preview/previewable";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { File02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootPath: string | null;
  homePath?: string | null;
  onOpenPath: (path: string) => void;
};

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

/**
 * Absolute paths a typed entry could mean, most-local first. Absolute and
 * `~`-relative entries are unambiguous (one candidate); a bare/relative entry
 * is tried against the workspace root first, then the home directory — so
 * `notes.md` finds the one in this repo, and `Downloads/x.png` still resolves
 * when nothing matches locally.
 *
 * Callers stat these in order and take the first that exists; when none do,
 * candidate 0 is where a new file gets created.
 */
export function resolveCandidates(
  input: string,
  rootPath: string | null,
  homePath: string | null,
): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    if (!homePath) return [];
    return [trimmed === "~" ? homePath : joinPath(homePath, trimmed.slice(2))];
  }
  if (trimmed.startsWith("/")) return [trimmed];
  const out: string[] = [];
  if (rootPath) out.push(joinPath(rootPath, trimmed));
  if (homePath) {
    const inHome = joinPath(homePath, trimmed);
    if (!out.includes(inHome)) out.push(inHome);
  }
  return out;
}

type Kind = "file" | "dir" | "symlink";

/** Which viewer an existing path will open in — mirrors App's `handleOpenFile`. */
function describeOpen(path: string): string {
  return previewKindForPath(path) ?? "editor";
}

/** First candidate that exists, else candidate 0 marked as new. */
async function probe(
  candidates: string[],
  workspace: ReturnType<typeof currentWorkspaceEnv>,
): Promise<{ path: string; kind: Kind | null } | null> {
  if (candidates.length === 0) return null;
  for (const path of candidates) {
    const stat = await invoke<{ kind: Kind }>("fs_stat", {
      path,
      workspace,
    }).catch(() => null);
    if (stat) return { path, kind: stat.kind };
  }
  return { path: candidates[0], kind: null };
}

export function NewEditorDialog({
  open,
  onOpenChange,
  rootPath,
  homePath = null,
  onOpenPath,
}: Props) {
  const [name, setName] = useState("untitled.txt");
  const [error, setError] = useState<string | null>(null);
  // What the typed path currently resolves to; `kind: null` = will be created.
  const [resolved, setResolved] = useState<{
    path: string;
    kind: Kind | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const candidates = resolveCandidates(name, rootPath, homePath);
  // Effects depend on the candidate list by value, not identity.
  const candidateKey = candidates.join("\n");

  useEffect(() => {
    if (!open) return;
    setName("untitled.txt");
    setError(null);
    setResolved(null);
    // Pre-select the basename so the user can quickly retype the filename
    // while keeping the extension handy.
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = el.value.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
    }, 0);
  }, [open]);

  // Live "opens / creates" hint. Debounced so typing a long path doesn't fire
  // a stat per keystroke; the submit path stats again, so a stale hint is
  // cosmetic only.
  useEffect(() => {
    if (!open || candidates.length === 0) {
      setResolved(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void probe(candidates, currentWorkspaceEnv()).then(
        (hit) => alive && setResolved(hit),
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: candidateKey stands in for the array by value
  }, [open, candidateKey]);

  const submit = async () => {
    if (!name.trim()) {
      setError("Path is required");
      return;
    }
    const workspace = currentWorkspaceEnv();
    const hit = await probe(candidates, workspace);
    if (!hit) {
      setError(
        name.trim().startsWith("~")
          ? "Home directory unknown"
          : "No workspace root",
      );
      return;
    }
    if (hit.kind === "dir") {
      setError("That's a folder — enter a file path");
      return;
    }
    // Existing file: open it as-is. Nothing there: create an empty one first.
    if (hit.kind === null) {
      try {
        await invoke("fs_create_file", { path: hit.path, workspace });
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    onOpenPath(hit.path);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex gap-1.75">
            <HugeiconsIcon icon={File02Icon} size={16} strokeWidth={1.75} />
            Open file
          </DialogTitle>
          <DialogDescription>
            Path to open — relative to the workspace root, absolute, or
            <code className="px-0.5">~/…</code>. Existing files open in the
            viewer that fits their type; anything else is created.
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="example.ts  ·  ~/Downloads/shot.png  ·  /etc/hosts"
        />
        {error ? (
          <div className="min-w-0 wrap-anywhere text-xs text-destructive">
            {error}
          </div>
        ) : (
          // `min-w-0` keeps the long resolved path from widening the dialog's
          // grid column — without it every sibling lays out past the panel.
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 wrap-anywhere">
              {resolved?.path ?? candidates[0] ?? "—"}
            </span>
            {resolved ? (
              <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px]">
                {resolved.kind === null
                  ? "new file"
                  : resolved.kind === "dir"
                    ? "folder"
                    : describeOpen(resolved.path)}
              </span>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()}>
            {resolved && resolved.kind !== null ? "Open" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
