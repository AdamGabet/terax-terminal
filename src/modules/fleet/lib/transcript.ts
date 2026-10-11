/**
 * Parser for the tail of a Claude Code session transcript
 * (`~/.claude/projects/<slug>/<sessionId>.jsonl`). The format is undocumented;
 * this reads the stable parts: `user` / `assistant` entries with Anthropic
 * message content blocks, `message.usage`, and per-entry `gitBranch`.
 * Everything else (attachments, snapshots, summaries) is skipped.
 */

export type TranscriptRole = "user" | "assistant" | "tool" | "result";

export type TranscriptEntry = {
  uuid: string;
  /** Epoch ms. */
  ts: number;
  role: TranscriptRole;
  text: string;
  /** Tool name for `tool` entries. */
  tool?: string;
  isError?: boolean;
  /** Subagent (sidechain) turn. */
  sidechain: boolean;
};

export type TranscriptStats = {
  model: string | null;
  gitBranch: string | null;
  /** Assistant API responses (deduped by message id). */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  lastTs: number | null;
  /** Most recent user prompt (not a tool result). */
  lastPrompt: string | null;
};

export type ParsedTranscript = {
  entries: TranscriptEntry[];
  stats: TranscriptStats;
  /** The tail started mid-line, so the first (partial) line was dropped. */
  truncated: boolean;
};

const MAX_TEXT = 4000;
const MAX_RESULT = 600;

export function emptyStats(): TranscriptStats {
  return {
    model: null,
    gitBranch: null,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    lastTs: null,
    lastPrompt: null,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSONL
type Json = any;

export function parseTranscriptTail(text: string): ParsedTranscript {
  const entries: TranscriptEntry[] = [];
  const stats = emptyStats();
  const seenMessages = new Set<string>();
  let truncated = false;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: Json;
    try {
      row = JSON.parse(line);
    } catch {
      if (i === 0) truncated = true;
      continue;
    }
    if (row?.type !== "user" && row?.type !== "assistant") continue;
    if (row.isMeta) continue;
    const ts = Date.parse(row.timestamp ?? "") || 0;
    const sidechain = row.isSidechain === true;
    const uuid = String(row.uuid ?? `${i}`);
    if (typeof row.gitBranch === "string" && row.gitBranch) {
      stats.gitBranch = row.gitBranch;
    }
    if (ts) stats.lastTs = Math.max(stats.lastTs ?? 0, ts);

    const message = row.message ?? {};
    if (row.type === "assistant") {
      const id = typeof message.id === "string" ? message.id : null;
      if (id && !seenMessages.has(id)) {
        seenMessages.add(id);
        stats.turns++;
        if (typeof message.model === "string") stats.model = message.model;
        const u = message.usage ?? {};
        stats.inputTokens += num(u.input_tokens);
        stats.outputTokens += num(u.output_tokens);
        stats.cacheReadTokens += num(u.cache_read_input_tokens);
        stats.cacheCreateTokens += num(u.cache_creation_input_tokens);
      }
      for (const [j, block] of blocks(message.content).entries()) {
        const key = `${uuid}:${j}`;
        if (block.type === "text" && typeof block.text === "string") {
          const t = block.text.trim();
          if (t)
            entries.push({
              uuid: key,
              ts,
              role: "assistant",
              text: clip(t, MAX_TEXT),
              sidechain,
            });
        } else if (block.type === "tool_use") {
          entries.push({
            uuid: key,
            ts,
            role: "tool",
            tool: String(block.name ?? "tool"),
            text: toolSummary(block.name, block.input),
            sidechain,
          });
        }
      }
      continue;
    }

    // user
    for (const [j, block] of blocks(message.content).entries()) {
      const key = `${uuid}:${j}`;
      if (block.type === "text" && typeof block.text === "string") {
        const t = stripReminders(block.text).trim();
        if (!t) continue;
        entries.push({
          uuid: key,
          ts,
          role: "user",
          text: clip(t, MAX_TEXT),
          sidechain,
        });
        if (!sidechain) stats.lastPrompt = clip(t, 200);
      } else if (block.type === "tool_result") {
        entries.push({
          uuid: key,
          ts,
          role: "result",
          text: clip(resultText(block.content), MAX_RESULT),
          isError: block.is_error === true,
          sidechain,
        });
      }
    }
  }
  return { entries, stats, truncated };
}

function blocks(content: Json): Json[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function num(v: Json): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function stripReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}

function resultText(content: Json): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b?.type === "text" && typeof b.text === "string" ? b.text : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

/** One-line description of a tool call, favouring the human-readable field. */
export function toolSummary(name: Json, input: Json): string {
  const i = input ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (typeof i[k] === "string" && i[k].trim()) return i[k].trim();
    }
    return null;
  };
  const s =
    pick(
      "description",
      "command",
      "file_path",
      "path",
      "pattern",
      "query",
      "url",
      "prompt",
    ) ??
    (typeof input === "object" && input
      ? JSON.stringify(input)
      : String(input ?? ""));
  return clip(s.replace(/\s+/g, " "), 160) || String(name ?? "");
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
