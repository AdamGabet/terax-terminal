import { describe, expect, it } from "vitest";
import { parseOpencodeMessages } from "./opencodeTranscript";

// Newest first, as the API returns it.
const BODY = JSON.stringify({
  data: [
    { id: "msg_4", type: "idle", outcome: "succeeded", time: { created: 40 } },
    {
      id: "msg_3",
      type: "assistant",
      model: { id: "gpt-6.1-sol" },
      tokens: {
        input: 100,
        output: 5,
        reasoning: 2,
        cache: { read: 50, write: 0 },
      },
      time: { created: 30 },
      content: [
        { type: "reasoning", text: "" },
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "BRIEF.md" },
            content: [{ type: "text", text: "file body" }],
          },
        },
        {
          type: "tool",
          name: "bash",
          state: {
            status: "error",
            input: { command: "ls" },
            error: { type: "unknown", message: "denied" },
          },
        },
        { type: "tool", name: "edit", state: { status: "running", input: {} } },
        { type: "text", text: "Done." },
      ],
    },
    { id: "msg_1", type: "user", text: "Read BRIEF.md", time: { created: 10 } },
  ],
});

describe("parseOpencodeMessages", () => {
  it("orders oldest first and maps text, tools and results", () => {
    const { entries, stats } = parseOpencodeMessages(BODY);
    expect(entries.map((e) => [e.role, e.tool ?? "", e.text])).toEqual([
      ["user", "", "Read BRIEF.md"],
      ["tool", "read", "BRIEF.md"],
      ["result", "", "file body"],
      ["tool", "bash", "ls"],
      ["result", "", "denied"],
      ["tool", "edit", "{}"],
      ["assistant", "", "Done."],
    ]);
    expect(entries[4].isError).toBe(true);
    expect(stats).toMatchObject({
      model: "gpt-6.1-sol",
      turns: 1,
      inputTokens: 100,
      outputTokens: 7,
      cacheReadTokens: 50,
      lastTs: 40,
      lastPrompt: "Read BRIEF.md",
    });
  });

  it("tolerates garbage", () => {
    expect(parseOpencodeMessages("nope").entries).toEqual([]);
  });
});
