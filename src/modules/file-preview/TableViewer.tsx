import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv, useWorkspaceEnvStore } from "@/modules/workspace";
import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { Button } from "@/components/ui/button";

type TextResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type BinaryResult =
  | { kind: "data"; base64: string; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | {
      kind: "ready";
      sheets: string[];
      rowsBySheet: string[][][];
      /** Verbatim source text for delimited files; null for workbooks. */
      rawTexts: (string | null)[];
      size: number;
    }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "binary"; size: number }
  | { kind: "error"; message: string };

const MAX_ROWS = 2000;
const MAX_COLS = 100;

import { parseDelimited, sniffDelimiter } from "./delimited";

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

type Props = {
  path: string;
  onOpenInEditor?: (path: string) => void;
};

/**
 * Spreadsheet viewer for csv/tsv/xls/xlsx: table view with a Raw toggle.
 * The table never wraps (`whitespace-nowrap` + horizontal scroll); raw shows
 * the verbatim source text (CSV of the active sheet for workbooks). Delimited
 * files stay editable via "Open in Editor".
 */
export function TableViewer({ path, onOpenInEditor }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  const reconnectGen = useWorkspaceEnvStore((s) => s.reconnectGeneration);
  const [mode, setMode] = useState<"table" | "raw">("table");
  const [sheet, setSheet] = useState(0);

  const ext = extOf(path);
  const isWorkbook = ext === "xls" || ext === "xlsx";

  useEffect(() => {
    setStatus({ kind: "loading" });
    setSheet(0);
    setMode("table");
  }, [path]);

  // Re-read when the file changes on disk (mirrors FilePreviewPane).
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
    if (isWorkbook) {
      invoke<BinaryResult>("fs_read_file_base64", {
        path,
        workspace: currentWorkspaceEnv(),
      })
        .then(async (res) => {
          if (cancelled) return;
          if (res.kind !== "data") {
            setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
            return;
          }
          try {
            const { read, utils } = await import("xlsx");
            const bytes = base64ToBytes(res.base64);
            const wb = read(bytes, { type: "array", dense: true });
            const sheets: string[] = wb.SheetNames.length
              ? wb.SheetNames
              : ["Sheet1"];
            const rowsBySheet = sheets.map((name) => {
              const ws = wb.Sheets[name];
              if (!ws) return [] as string[][];
              const aoa = utils.sheet_to_json<string[]>(ws, {
                header: 1,
                defval: "",
                raw: false,
              }) as unknown as string[][];
              return aoa.map((r) =>
                (Array.isArray(r) ? r : [r]).map((c) =>
                  c === null || c === undefined ? "" : String(c),
                ),
              );
            });
            setStatus({
              kind: "ready",
              sheets,
              rowsBySheet,
              rawTexts: sheets.map(() => null),
              size: res.size,
            });
          } catch (e) {
            setStatus({ kind: "error", message: String(e) });
          }
        })
        .catch((e) => {
          if (!cancelled) setStatus({ kind: "error", message: String(e) });
        });
    } else {
      invoke<TextResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
        force: false,
      })
        .then((res) => {
          if (cancelled) return;
          if (res.kind === "text") {
            const delimiter =
              ext === "tsv" ? "\t" : sniffDelimiter(res.content.slice(0, 8192));
            const rows = parseDelimited(res.content, delimiter);
            setStatus({
              kind: "ready",
              sheets: [""],
              rowsBySheet: [rows],
              rawTexts: [res.content],
              size: res.size,
            });
          } else if (res.kind === "binary") {
            setStatus({ kind: "binary", size: res.size });
          } else {
            setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
          }
        })
        .catch((e) => {
          if (!cancelled) setStatus({ kind: "error", message: String(e) });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [path, generation, reconnectGen, isWorkbook, ext]);

  const active = useMemo(() => {
    if (status.kind !== "ready") return null;
    const idx = Math.min(sheet, status.rowsBySheet.length - 1);
    return {
      name: status.sheets[idx] ?? "",
      rows: status.rowsBySheet[idx] ?? [],
      raw: status.rawTexts[idx] ?? null,
    };
  }, [status, sheet]);

  const truncated = useMemo(() => {
    if (!active) return null;
    const totalCols = active.rows.reduce((m, r) => Math.max(m, r.length), 0);
    return {
      rows: active.rows.slice(0, MAX_ROWS),
      colsClipped: Math.max(0, totalCols - MAX_COLS),
      rowsClipped: Math.max(0, active.rows.length - MAX_ROWS),
      totalRows: active.rows.length,
      totalCols,
    };
  }, [active]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        {status.kind === "ready" && active && truncated && (
          <span className="px-1 text-[11px] text-muted-foreground">
            {truncated.totalRows} row{truncated.totalRows === 1 ? "" : "s"} ×{" "}
            {truncated.totalCols} col{truncated.totalCols === 1 ? "" : "s"}
            {status.sheets.length > 1 && active.name ? ` · ${active.name}` : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {status.kind === "ready" && status.sheets.length > 1 && (
            <select
              aria-label="Sheet"
              className="h-6 max-w-40 rounded-sm border border-border/60 bg-background px-1 text-[11px] text-muted-foreground"
              value={Math.min(sheet, status.sheets.length - 1)}
              onChange={(e) => setSheet(Number(e.target.value))}
            >
              {status.sheets.map((name, i) => (
                <option key={`${i}-${name}`} value={i}>
                  {name || `Sheet ${i + 1}`}
                </option>
              ))}
            </select>
          )}
          <div className="flex overflow-hidden rounded-sm border border-border/60">
            {(["table", "raw"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "px-2 py-0.5 text-[11px] capitalize",
                  mode === m
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "raw" ? "Raw" : "Table"}
              </button>
            ))}
          </div>
          {!isWorkbook && onOpenInEditor && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => onOpenInEditor(path)}
            >
              Open in Editor
            </Button>
          )}
        </div>
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
        {status.kind === "binary" && (
          <p className="px-6 py-4 text-[12px] text-muted-foreground">
            File looks binary and can't be shown as a table.
          </p>
        )}
        {status.kind === "toolarge" && (
          <p className="px-6 py-4 text-[12px] text-muted-foreground">
            File is too large to preview.
          </p>
        )}
        {status.kind === "ready" && active && truncated && mode === "raw" && (
          <RawView
            rows={active.rows}
            verbatim={active.raw}
            isWorkbook={isWorkbook}
          />
        )}
        {status.kind === "ready" && active && truncated && mode === "table" && (
          // `select-text` opts out of the app-wide `user-select: none` so
          // cell text can be selected and copied.
          <div className="select-text w-fit min-w-full">
            {truncated.rows.length === 0 ? (
              <p className="px-6 py-4 text-[12px] text-muted-foreground">
                No rows.
              </p>
            ) : (
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {truncated.rows[0].slice(0, MAX_COLS).map((h, i) => (
                      <th
                        key={i}
                        className="whitespace-nowrap border-b border-border bg-muted/80 px-2 py-1 text-left font-medium text-muted-foreground backdrop-blur-sm"
                      >
                        {h === "" ? `Column ${i + 1}` : h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {truncated.rows.slice(1).map((r, ri) => (
                    <tr
                      key={ri}
                      className="odd:bg-background even:bg-muted/20 hover:bg-accent/40"
                    >
                      {truncated.rows[0].slice(0, MAX_COLS).map((_, ci) => (
                        <td
                          key={ci}
                          className="max-w-80 overflow-hidden text-ellipsis whitespace-nowrap border-b border-border/40 px-2 py-1 text-foreground/90"
                          title={r[ci] ?? ""}
                        >
                          {r[ci] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(truncated.rowsClipped > 0 || truncated.colsClipped > 0) && (
              <p className="px-4 py-2 text-[11px] text-muted-foreground">
                Showing first {truncated.rows.length} rows
                {truncated.colsClipped > 0
                  ? ` and ${MAX_COLS} of ${truncated.totalCols} columns`
                  : ""}
                .
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RawView({
  rows,
  verbatim,
  isWorkbook,
}: {
  rows: string[][];
  verbatim: string | null;
  isWorkbook: boolean;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  useEffect(() => {
    if (!isWorkbook) return;
    let alive = true;
    void import("xlsx").then(({ utils }) => {
      if (!alive) return;
      const ws = utils.aoa_to_sheet(rows);
      setCsv(utils.sheet_to_csv(ws));
    });
    return () => {
      alive = false;
    };
  }, [isWorkbook, rows]);
  const text = isWorkbook ? (csv ?? "Loading…") : (verbatim ?? "");
  return (
    <pre className="select-text w-fit min-w-full px-4 py-2 font-mono text-[12px] leading-relaxed whitespace-pre text-foreground/90">
      {text}
    </pre>
  );
}
