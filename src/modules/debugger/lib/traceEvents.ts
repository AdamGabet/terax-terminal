import type { TraceEvent } from "./types";

export const TERAX_PREFIX = "@@TERAX_DBG@@";

/**
 * Splits debug-adapter output into tracer events and plain console text.
 *
 * debugpy chunks output events arbitrarily — a tracer line can arrive split
 * across two events, or glued to program output — so this buffers partial
 * lines per output category and only parses complete lines.
 */
/**
 * Ceiling on a single unterminated line. A debuggee that writes without ever
 * emitting a newline (progress bar, one-line JSON dump) would otherwise grow
 * `partial` without bound. Mirrors MAX_LINE in the Rust port scanner; sized
 * far above any realistic single line so the spill path stays unreachable in
 * practice.
 */
const MAX_PARTIAL = 1024 * 1024;

export class OutputDemux {
  private partial = new Map<string, string>();

  push(
    category: string,
    text: string,
  ): { events: TraceEvent[]; console: string } {
    const buffered = (this.partial.get(category) ?? "") + text;
    const lines = buffered.split("\n");
    // Last element is either "" (text ended with \n) or an incomplete line.
    let tail = lines.pop() ?? "";
    // Over the ceiling: force a break rather than keep buffering. Program
    // output is the user's data so it spills to console; a tracer line this
    // long is malformed, and truncating one yields garbage either way — same
    // reasoning as flush() below.
    let spilled = "";
    if (tail.length > MAX_PARTIAL) {
      if (!tail.startsWith(TERAX_PREFIX)) spilled = tail;
      tail = "";
    }
    this.partial.set(category, tail);

    const events: TraceEvent[] = [];
    const consoleParts: string[] = [];
    for (const line of lines) {
      const at = line.indexOf(TERAX_PREFIX);
      if (at === -1) {
        consoleParts.push(line);
        continue;
      }
      // Program output printed without a trailing newline can end up glued
      // in front of a tracer line; keep it.
      if (at > 0) consoleParts.push(line.slice(0, at));
      const parsed = parseTraceLine(line.slice(at + TERAX_PREFIX.length));
      if (parsed) events.push(parsed);
      else consoleParts.push(line);
    }
    if (spilled) consoleParts.push(spilled);
    return {
      events,
      console: consoleParts.length ? `${consoleParts.join("\n")}\n` : "",
    };
  }

  /** Any trailing unterminated line, flushed at process exit. */
  flush(category: string): string {
    const rest = this.partial.get(category) ?? "";
    this.partial.set(category, "");
    if (!rest) return "";
    if (rest.startsWith(TERAX_PREFIX)) {
      // A truncated tracer line is garbage either way; drop it.
      return "";
    }
    return rest;
  }
}

export function parseTraceLine(json: string): TraceEvent | null {
  try {
    const e = JSON.parse(json) as TraceEvent;
    if (typeof e !== "object" || e === null || typeof e.type !== "string") {
      return null;
    }
    return e;
  } catch {
    return null;
  }
}
