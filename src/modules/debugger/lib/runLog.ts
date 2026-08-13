/** Run persistence: every debug run's raw TraceEvent stream is appended to
 * `appCacheDir()/debug/runs/<stamp>-<script>.jsonl` (always the LOCAL cache,
 * whichever workspace the debuggee ran in). Replaying a file through
 * `applyTraceEvents` reconstructs the GraphState exactly, so agents can query
 * past runs after the store has moved on. `index.json` beside the logs holds
 * one summary row per run for cheap listing. */

import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { applyTraceEvents, emptyGraph, type GraphState } from "./graphModel";
import type { CrashFrame, TraceEvent } from "./types";

export const KEEP_RUNS = 20;
const FLUSH_EVERY = 64;
/** Stop appending beyond this so a runaway run can't fill the disk. */
const MAX_LOG_BYTES = 40 * 1024 * 1024;

export type RunCrash = {
  excType: string;
  excMsg: string;
  frames: CrashFrame[];
};

export type RunMeta = {
  id: string;
  script: string;
  time: string;
  crashed: boolean;
  nodes: number;
  snaps: number;
};

async function runsDir(): Promise<string> {
  return join(await appCacheDir(), "debug", "runs");
}

async function runPath(id: string): Promise<string> {
  return join(await runsDir(), `${id}.jsonl`);
}

async function indexPath(): Promise<string> {
  return join(await runsDir(), "index.json");
}

async function readIndex(): Promise<RunMeta[]> {
  const res = await invoke<{ kind: string; content?: string }>("fs_read_file", {
    path: await indexPath(),
  }).catch(() => null);
  if (res?.kind !== "text" || !res.content) return [];
  try {
    const parsed = JSON.parse(res.content);
    return Array.isArray(parsed) ? (parsed as RunMeta[]) : [];
  } catch {
    return [];
  }
}

/** Buffered, ordered JSONL appender for one run. */
export class RunLogWriter {
  readonly id: string;
  private script: string;
  private startedAt = new Date().toISOString();
  private buf: string[] = [];
  private bytes = 0;
  private closed = false;
  /** Appends are chained so chunks land in stream order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(script: string) {
    const stamp = this.startedAt.replace(/[:.]/g, "-");
    const base = (script.split("/").pop() ?? "run").replace(/\.py$/, "");
    this.id = `${stamp}-${base}`;
    this.script = script;
  }

  push(events: TraceEvent[]): void {
    if (this.closed || this.bytes >= MAX_LOG_BYTES) return;
    for (const e of events) this.buf.push(JSON.stringify(e));
    if (this.buf.length >= FLUSH_EVERY) this.flush();
  }

  private flush(): void {
    if (this.buf.length === 0) return;
    const chunk = `${this.buf.splice(0).join("\n")}\n`;
    this.bytes += chunk.length;
    this.chain = this.chain
      .then(async () =>
        invoke("fs_append_file", {
          path: await runPath(this.id),
          content: chunk,
        }),
      )
      .catch(() => {});
  }

  /** Final flush + index row. Safe to call once, when the run ends. */
  close(summary: { crashed: boolean; nodes: number; snaps: number }): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    const meta: RunMeta = {
      id: this.id,
      script: this.script,
      time: this.startedAt,
      ...summary,
    };
    this.chain = this.chain
      .then(async () => {
        const index = [
          meta,
          ...(await readIndex()).filter((m) => m.id !== meta.id),
        ];
        await invoke("fs_write_file", {
          path: await indexPath(),
          content: JSON.stringify(index.slice(0, KEEP_RUNS), null, 1),
        });
      })
      .catch(() => {});
  }
}

/** Deletes run logs beyond the newest KEEP_RUNS. Called on run start. */
export async function pruneRuns(keep = KEEP_RUNS): Promise<void> {
  const dir = await runsDir();
  const entries = await invoke<{ name: string; kind: string }[]>(
    "fs_read_dir",
    { path: dir, showHidden: false },
  ).catch(() => [] as { name: string; kind: string }[]);
  const logs = entries
    .filter((e) => e.kind === "file" && e.name.endsWith(".jsonl"))
    .map((e) => e.name)
    .sort() // stamp prefix sorts chronologically
    .reverse();
  await Promise.all(
    logs
      .slice(keep)
      .map(async (name) =>
        invoke("fs_delete", { path: await join(dir, name) }).catch(() => {}),
      ),
  );
}

/** Newest-first run summaries; unindexed logs (app died mid-run) get a stub. */
export async function listRuns(): Promise<
  (RunMeta | { id: string; note: string })[]
> {
  const dir = await runsDir();
  const entries = await invoke<{ name: string; kind: string }[]>(
    "fs_read_dir",
    { path: dir, showHidden: false },
  ).catch(() => [] as { name: string; kind: string }[]);
  const ids = entries
    .filter((e) => e.kind === "file" && e.name.endsWith(".jsonl"))
    .map((e) => e.name.slice(0, -".jsonl".length))
    .sort()
    .reverse();
  const byId = new Map((await readIndex()).map((m) => [m.id, m]));
  return ids
    .slice(0, KEEP_RUNS)
    .map(
      (id) =>
        byId.get(id) ?? { id, note: "incomplete run (ended without summary)" },
    );
}

/** Replays a persisted run into a GraphState + crash report. */
export async function loadRun(
  id: string,
): Promise<{ graph: GraphState; crash: RunCrash | null }> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid run id: ${id}`);
  const res = await invoke<{ kind: string; content?: string }>("fs_read_file", {
    path: await runPath(id),
    force: true,
  }).catch(() => null);
  if (res?.kind !== "text" || !res.content) {
    throw new Error(`run "${id}" not found — call list_runs for valid ids`);
  }
  const events: TraceEvent[] = [];
  for (const line of res.content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TraceEvent;
      if (ev && typeof ev.type === "string") events.push(ev);
    } catch {
      // torn tail line from a killed run — skip
    }
  }
  if (events.length === 0) throw new Error(`run "${id}" is empty`);
  const graph = applyTraceEvents(emptyGraph(), events);
  const crashEv = events.find((e) => e.type === "crash");
  const crash =
    crashEv && crashEv.type === "crash"
      ? {
          excType: crashEv.exc_type,
          excMsg: crashEv.exc_msg,
          frames: crashEv.frames,
        }
      : null;
  return { graph, crash };
}
