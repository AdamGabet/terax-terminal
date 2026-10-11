import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import {
  fleetOpencodeMessages,
  fleetTranscriptTail,
  type FleetAgent,
} from "../lib/fleet";
import { parseOpencodeMessages } from "../lib/opencodeTranscript";
import {
  emptyStats,
  formatTokens,
  parseTranscriptTail,
  type ParsedTranscript,
  type TranscriptEntry,
} from "../lib/transcript";

const TAIL_BYTES = 256 * 1024;
// Tool outputs make opencode messages big (~10 KB each); this is polled.
const OPENCODE_MESSAGES = 40;
const REFRESH_MS = 3000;

type Props = {
  agent: FleetAgent | null;
  visible: boolean;
};

export function TranscriptView({ agent, visible }: Props) {
  const [parsed, setParsed] = useState<ParsedTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const lastText = useRef<string>("");
  const key = agent ? `${agent.cwd}\0${agent.sessionId}` : null;

  useEffect(() => {
    setParsed(null);
    setError(null);
    setFollow(true);
    lastText.current = "";
    if (!key || !visible || !agent) return;
    // opencode transcripts live in its service, not ~/.claude/projects.
    const opencode = agent.kind === "opencode";
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const text = opencode
          ? await fleetOpencodeMessages(agent.sessionId, OPENCODE_MESSAGES)
          : await fleetTranscriptTail(agent.cwd, agent.sessionId, TAIL_BYTES);
        if (cancelled) return;
        if (text !== lastText.current) {
          lastText.current = text;
          setParsed(
            opencode ? parseOpencodeMessages(text) : parseTranscriptTail(text),
          );
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
      if (!cancelled) timer = setTimeout(load, REFRESH_MS);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, visible]);

  // Stick to the bottom while the user hasn't scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    const el = listRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [parsed, follow]);

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        Select an agent to read its transcript.
      </div>
    );
  }

  const stats = parsed?.stats ?? emptyStats();
  const entries = parsed?.entries ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">{agent.name}</span>
        {stats.gitBranch ? (
          <span className="font-mono">{stats.gitBranch}</span>
        ) : null}
        {stats.model ? (
          <span>{stats.model.replace(/^claude-/, "")}</span>
        ) : null}
        <span title="last 256 KB of the transcript">
          {stats.turns} recent turns
        </span>
        <span title="input / output tokens — last 256 KB of the transcript">
          recent ↑
          {formatTokens(
            stats.inputTokens + stats.cacheReadTokens + stats.cacheCreateTokens,
          )}{" "}
          ↓{formatTokens(stats.outputTokens)}
        </span>
        {stats.lastTs ? (
          <span title={new Date(stats.lastTs).toLocaleString()}>
            last {relative(stats.lastTs)}
          </span>
        ) : null}
        <button
          type="button"
          className={cn(
            "ml-auto rounded px-1.5 py-0.5",
            follow ? "bg-primary/10 text-primary" : "hover:bg-accent",
          )}
          onClick={() => setFollow((f) => !f)}
          title="Auto-scroll to newest"
        >
          follow
        </button>
      </div>
      {error ? (
        <div className="px-3 py-2 text-xs text-destructive">
          {error.includes("No such file") || error.includes("open ")
            ? "No transcript yet for this session."
            : error}
        </div>
      ) : null}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {parsed?.truncated ? (
          <div className="mb-2 text-center text-[10px] text-muted-foreground">
            … earlier entries not shown (tail of {TAIL_BYTES / 1024} KB)
          </div>
        ) : null}
        {!parsed && !error ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : null}
        {parsed && entries.length === 0 && !error ? (
          <div className="text-xs text-muted-foreground">
            Transcript is empty.
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <Entry key={e.uuid} entry={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  const time = entry.ts
    ? new Date(entry.ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  if (entry.role === "user") {
    return (
      <div
        className={cn(
          "rounded-md bg-primary/10 px-2.5 py-1.5",
          entry.sidechain && "opacity-70",
        )}
      >
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-medium text-primary">
            {entry.sidechain ? "subagent prompt" : "you"}
          </span>
          <span>{time}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-xs">
          {entry.text}
        </div>
      </div>
    );
  }
  if (entry.role === "assistant") {
    return (
      <div className={cn("px-2.5 py-1", entry.sidechain && "opacity-70")}>
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-medium">
            {entry.sidechain ? "subagent" : "claude"}
          </span>
          <span>{time}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-xs">
          {entry.text}
        </div>
      </div>
    );
  }
  if (entry.role === "tool") {
    return (
      <div className="flex min-w-0 items-baseline gap-1.5 px-2.5 font-mono text-[11px]">
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-foreground/80">
          {entry.tool}
        </span>
        <span className="truncate text-muted-foreground" title={entry.text}>
          {entry.text}
        </span>
      </div>
    );
  }
  return (
    <pre
      className={cn(
        "ml-6 max-h-24 overflow-hidden whitespace-pre-wrap break-words rounded border border-border/40 bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground",
        entry.isError && "border-destructive/40 text-destructive",
      )}
    >
      {entry.text || (entry.isError ? "(error)" : "(no output)")}
    </pre>
  );
}

function relative(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
