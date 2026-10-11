import { describe, expect, it } from "vitest";
import { formatTokens, parseTranscriptTail, toolSummary } from "./transcript";

const line = (o: unknown) => JSON.stringify(o);

const user = (text: unknown, extra = {}) =>
  line({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-07T13:00:00.000Z",
    gitBranch: "autoresearch/agent-A",
    message: { role: "user", content: text },
    ...extra,
  });

const assistant = (content: unknown[], id = "msg_1", extra = {}) =>
  line({
    type: "assistant",
    uuid: `a-${id}`,
    timestamp: "2026-10-07T13:00:05.000Z",
    message: {
      id,
      model: "claude-fable-5-1",
      content,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 4,
      },
    },
    ...extra,
  });

describe("parseTranscriptTail", () => {
  it("builds a timeline of prompts, replies, tool calls and results", () => {
    const text = [
      user("fix the bug <system-reminder>ignored</system-reminder>"),
      assistant([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "On it." },
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "ls -la", description: "List files" },
        },
      ]),
      user([
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "a.txt\nb.txt",
          is_error: false,
        },
      ]),
      line({ type: "attachment", uuid: "x" }),
      line({ type: "file-history-snapshot" }),
    ].join("\n");
    const { entries, stats, truncated } = parseTranscriptTail(text);
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "result",
    ]);
    expect(entries[0].text).toBe("fix the bug");
    expect(entries[2].tool).toBe("Bash");
    expect(entries[2].text).toBe("List files");
    expect(entries[3].text).toBe("a.txt\nb.txt");
    expect(stats.lastPrompt).toBe("fix the bug");
    expect(stats.gitBranch).toBe("autoresearch/agent-A");
    expect(stats.model).toBe("claude-fable-5-1");
    expect(stats.lastTs).toBe(Date.parse("2026-10-07T13:00:05.000Z"));
  });

  it("counts usage once per API response even when split across lines", () => {
    const text = [
      assistant([{ type: "text", text: "a" }], "msg_1"),
      assistant(
        [
          {
            type: "tool_use",
            id: "t",
            name: "Read",
            input: { file_path: "/x" },
          },
        ],
        "msg_1",
      ),
      assistant([{ type: "text", text: "b" }], "msg_2"),
    ].join("\n");
    const { stats } = parseTranscriptTail(text);
    expect(stats.turns).toBe(2);
    expect(stats.inputTokens).toBe(20);
    expect(stats.outputTokens).toBe(40);
    expect(stats.cacheReadTokens).toBe(600);
  });

  it("drops a partial first line and skips meta/sidechain prompts for lastPrompt", () => {
    const text = [
      '"content":"garbage tail of a cut line"}',
      user("hidden", { isMeta: true }),
      user("sub task", { isSidechain: true, uuid: "s" }),
      user("real prompt", { uuid: "r" }),
    ].join("\n");
    const { entries, stats, truncated } = parseTranscriptTail(text);
    expect(truncated).toBe(true);
    expect(entries.map((e) => e.text)).toEqual(["sub task", "real prompt"]);
    expect(entries[0].sidechain).toBe(true);
    expect(stats.lastPrompt).toBe("real prompt");
  });

  it("tolerates junk and empty input", () => {
    expect(parseTranscriptTail("").entries).toEqual([]);
    expect(parseTranscriptTail('not json\n{"type":"user"}\n').entries).toEqual(
      [],
    );
  });
});

describe("toolSummary / formatTokens", () => {
  it("prefers readable fields and clips", () => {
    expect(toolSummary("Edit", { file_path: "/a/b.ts", old_string: "x" })).toBe(
      "/a/b.ts",
    );
    expect(toolSummary("Grep", { pattern: "foo\n  bar" })).toBe("foo bar");
    expect(toolSummary("X", { n: 1 })).toBe('{"n":1}');
    expect(toolSummary("X", { description: "a".repeat(200) }).length).toBe(161);
  });
  it("formats token counts", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(4321)).toBe("4.3k");
    expect(formatTokens(43210)).toBe("43k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});
