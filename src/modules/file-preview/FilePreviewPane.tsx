import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { usePinchZoom } from "./usePinchZoom";
import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { currentWorkspaceEnv, useWorkspaceEnvStore } from "@/modules/workspace";
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
  // Also re-fetch after an SSH reconnect (the remote read now succeeds).
  const reconnectGen = useWorkspaceEnvStore((s) => s.reconnectGeneration);
  // Image zoom (1 = fit-to-pane). The image is sized in real pixels so the
  // scroll container pans in both axes when zoomed in, and so zooming out
  // below the fit actually shrinks the image.
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [paneSize, setPaneSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  usePinchZoom(scrollRef, zoom, setZoom, { min: 0.5, max: 4 });

  // Track the available pane size so "fit" (zoom 1) matches object-contain.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setPaneSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    setStatus({ kind: "loading" });
    setZoom(1);
    setNatural(null);
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
  }, [path, generation, reconnectGen]);

  const size =
    status.kind === "image" || status.kind === "pdf" ? status.size : null;

  // Displayed image size: object-contain "fit" at zoom 1 (never upscaling a
  // small image past natural), then multiplied by zoom. Sized in real pixels
  // so the container scrolls both axes when zoomed past the pane.
  const IMG_PAD = 16; // matches the p-4 around the image
  const fitScale =
    natural && paneSize.w > 0 && paneSize.h > 0
      ? Math.min(
          (paneSize.w - IMG_PAD * 2) / natural.w,
          (paneSize.h - IMG_PAD * 2) / natural.h,
          1,
        )
      : null;
  const imgW = natural && fitScale ? natural.w * fitScale * zoom : null;
  const imgH = natural && fitScale ? natural.h * fitScale * zoom : null;

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
        {status.kind === "image" && zoom !== 1 && (
          <button
            type="button"
            className="shrink-0 rounded-sm px-1 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Reset zoom"
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
        )}
      </div>
      {status.kind === "pdf" ? (
        <div className="min-h-0 flex-1">
          <PdfViewer data={status.data} />
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
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
            // Centers the image when it's smaller than the pane; when zoomed
            // bigger the container grows to the image so `overflow-auto` pans
            // in both axes. `safe` centering falls back to start on overflow so
            // the left/top edges stay reachable (plain centering clips them).
            <div className="flex min-h-full min-w-full p-4 [align-items:safe_center] [justify-content:safe_center]">
              <img
                src={status.url}
                alt={path}
                draggable={false}
                onLoad={(e) =>
                  setNatural({
                    w: e.currentTarget.naturalWidth,
                    h: e.currentTarget.naturalHeight,
                  })
                }
                className="object-contain"
                style={
                  imgW && imgH
                    ? {
                        width: imgW,
                        height: imgH,
                        maxWidth: "none",
                        maxHeight: "none",
                      }
                    : { maxWidth: "100%", maxHeight: "100%" }
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
