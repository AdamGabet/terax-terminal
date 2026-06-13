import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { PdfViewer } from "./PdfViewer";
import { mimeForPath, previewKindForPath } from "./previewable";

type ReadBinaryResult =
  | { kind: "data"; base64: string; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "image"; url: string; size: number }
  | { kind: "pdf"; data: Uint8Array; size: number }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
};

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreviewPane({ path, visible }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  // Bumped when the file changes on disk; refetches without flashing
  // "Loading…" so a regenerated image/PDF swaps in place.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setStatus({ kind: "loading" });
  }, [path]);

  useEffect(() => {
    const dir = parentDir(path);
    watchAdd([dir]);
    let alive = true;
    let unlisten: (() => void) | undefined;
    const normalized = path.replace(/\\/g, "/");
    void listenFsChanged((paths) => {
      if (paths.some((p) => p.replace(/\\/g, "/") === normalized)) {
        setGeneration((g) => g + 1);
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
      watchRemove([dir]);
    };
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    invoke<ReadBinaryResult>("fs_read_file_base64", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind !== "data") {
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
          return;
        }
        const previewKind = previewKindForPath(path);
        if (previewKind === null) {
          setStatus({ kind: "error", message: "Unsupported file type." });
          return;
        }
        const bytes = base64ToBytes(res.base64);
        if (previewKind === "pdf") {
          setStatus({ kind: "pdf", data: bytes, size: res.size });
        } else {
          objectUrl = URL.createObjectURL(
            new Blob([bytes], { type: mimeForPath(path) }),
          );
          setStatus({ kind: "image", url: objectUrl, size: res.size });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, generation]);

  const size =
    status.kind === "image" || status.kind === "pdf" ? status.size : null;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="truncate text-[11px] text-muted-foreground">
          {path}
        </span>
        {size !== null && (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
            {formatBytes(size)}
          </span>
        )}
      </div>
      {status.kind === "pdf" ? (
        <div className="min-h-0 flex-1">
          <PdfViewer data={status.data} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {status.kind === "loading" && (
            <p className="px-6 py-4 text-[12px] text-muted-foreground">
              Loading…
            </p>
          )}
          {status.kind === "error" && (
            <p className="px-6 py-4 text-[12px] text-destructive">
              Failed to read file: {status.message}
            </p>
          )}
          {status.kind === "toolarge" && (
            <p className="px-6 py-4 text-[12px] text-muted-foreground">
              File is {formatBytes(status.size)}; preview limit is{" "}
              {formatBytes(status.limit)}.
            </p>
          )}
          {status.kind === "image" && (
            <div className="flex h-full w-full items-center justify-center p-4">
              <img
                src={status.url}
                alt={path}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
