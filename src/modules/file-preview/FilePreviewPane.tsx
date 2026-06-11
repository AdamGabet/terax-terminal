import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { mimeForPath, previewKindForPath } from "./previewable";

type ReadBinaryResult =
  | { kind: "data"; base64: string; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; url: string; size: number }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
};

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreviewPane({ path, visible }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const previewKind = previewKindForPath(path);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setStatus({ kind: "loading" });
    invoke<ReadBinaryResult>("fs_read_file_base64", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "data") {
          objectUrl = URL.createObjectURL(
            base64ToBlob(res.base64, mimeForPath(path)),
          );
          setStatus({ kind: "ready", url: objectUrl, size: res.size });
        } else {
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

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
        {status.kind === "ready" && (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
            {formatBytes(status.size)}
          </span>
        )}
      </div>
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
        {status.kind === "ready" && previewKind === "image" && (
          <div className="flex h-full w-full items-center justify-center p-4">
            <img
              src={status.url}
              alt={path}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
        {status.kind === "ready" && previewKind === "pdf" && (
          <embed
            src={status.url}
            type="application/pdf"
            className="h-full w-full"
          />
        )}
        {status.kind === "ready" && previewKind === null && (
          <p className="px-6 py-4 text-[12px] text-muted-foreground">
            Unsupported file type.
          </p>
        )}
      </div>
    </div>
  );
}
