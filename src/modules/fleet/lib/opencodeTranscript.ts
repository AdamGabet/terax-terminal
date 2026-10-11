/**
 * Maps an opencode v2 message list (`GET /api/session/{id}/message`, newest
 * first) onto the Claude transcript shape so TranscriptView renders both.
 * `user` / `assistant` messages carry the text; assistant `tool` items become
 * a call entry plus a result entry once they finish. Reasoning and `idle`
 * markers are skipped.
 */
import {
  emptyStats,
  type ParsedTranscript,
  type TranscriptEntry,
  toolSummary,
} from "./transcript";

const MAX_TEXT = 4000;
const MAX_RESULT = 600;

// biome-ignore lint/suspicious/noExplicitAny: untyped API body
type Json = any;

export function parseOpencodeMessages(body: string): ParsedTranscript {
  const entries: TranscriptEntry[] = [];
  const stats = emptyStats();
  let data: Json[] = [];
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed?.data)) data = parsed.data;
  } catch {
    return { entries, stats, truncated: false };
  }

  for (const msg of [...data].reverse()) {
    const ts = num(msg?.time?.created);
    const id = String(msg?.id ?? entries.length);
    if (ts) stats.lastTs = Math.max(stats.lastTs ?? 0, ts);

    if (msg?.type === "user") {
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text) continue;
      entries.push({
        uuid: id,
        ts,
        role: "user",
        text: clip(text, MAX_TEXT),
        sidechain: false,
      });
      stats.lastPrompt = clip(text, 200);
      continue;
    }
    if (msg?.type !== "assistant") continue;

    stats.turns++;
    if (typeof msg.model?.id === "string") stats.model = msg.model.id;
    const t = msg.tokens ?? {};
    stats.inputTokens += num(t.input);
    stats.outputTokens += num(t.output) + num(t.reasoning);
    stats.cacheReadTokens += num(t.cache?.read);
    stats.cacheCreateTokens += num(t.cache?.write);

    const content: Json[] = Array.isArray(msg.content) ? msg.content : [];
    for (const [j, item] of content.entries()) {
      const key = `${id}:${j}`;
      if (item?.type === "text" && typeof item.text === "string") {
        const text = item.text.trim();
        if (text)
          entries.push({
            uuid: key,
            ts,
            role: "assistant",
            text: clip(text, MAX_TEXT),
            sidechain: false,
          });
      } else if (item?.type === "tool") {
        const name = String(item.name ?? "tool");
        entries.push({
          uuid: key,
          ts,
          role: "tool",
          tool: name,
          text: toolSummary(name, item.state?.input),
          sidechain: false,
        });
        const status = item.state?.status;
        if (status === "completed" || status === "error") {
          entries.push({
            uuid: `${key}:result`,
            ts,
            role: "result",
            text: clip(resultText(item.state), MAX_RESULT),
            isError: status === "error",
            sidechain: false,
          });
        }
      }
    }
  }
  return { entries, stats, truncated: false };
}

function resultText(state: Json): string {
  // `error` is `{type, message}` (seen live); accept a bare string too.
  const error = state?.error?.message ?? state?.error;
  if (typeof error === "string") return error.trim();
  const content: Json[] = Array.isArray(state?.content) ? state.content : [];
  return content
    .map((c) =>
      c?.type === "text" && typeof c.text === "string" ? c.text : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function num(v: Json): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
