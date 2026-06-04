/**
 * Tests for patchCodexBody — the body-mutation layer applied to every Codex
 * responses-API request before it is forwarded through the Tauri HTTP proxy.
 *
 * RED PHASE: several of these tests currently FAIL because patchCodexBody
 * only implements store/stream injection.  The green phase (the fix) will
 * implement the missing patches and make all tests pass.
 *
 * Bugs documented here:
 *   BUG-1  max_output_tokens / max_completion_tokens not removed
 *   BUG-2  reasoning.encrypted_content not added to `include` for gpt-5 models
 *   BUG-3  input item `id` fields not stripped for stateless mode
 *   BUG-4  item_reference input entries not removed
 */

import { describe, expect, it } from "vitest";
import { isCodexReasoningModel, patchCodexBody } from "./codexBody";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const userItem = {
  role: "user",
  content: [{ type: "input_text", text: "hi" }],
};

const assistantItem = {
  role: "assistant",
  content: [{ type: "output_text", text: "hello" }],
};

// ---------------------------------------------------------------------------
// isCodexReasoningModel
// ---------------------------------------------------------------------------

describe("isCodexReasoningModel", () => {
  it("identifies all gpt-5.x codex models as reasoning", () => {
    expect(isCodexReasoningModel("gpt-5.3-codex")).toBe(true);
    expect(isCodexReasoningModel("gpt-5.2-codex")).toBe(true);
    expect(isCodexReasoningModel("gpt-5.1-codex-max")).toBe(true);
    expect(isCodexReasoningModel("gpt-5.1-codex-mini")).toBe(true);
    expect(isCodexReasoningModel("gpt-5.4")).toBe(true);
  });

  it("identifies o-series as reasoning", () => {
    expect(isCodexReasoningModel("o1")).toBe(true);
    expect(isCodexReasoningModel("o3")).toBe(true);
    expect(isCodexReasoningModel("o4-mini")).toBe(true);
    expect(isCodexReasoningModel("o1-mini")).toBe(true);
  });

  it("does NOT flag non-reasoning models", () => {
    expect(isCodexReasoningModel("gpt-4o")).toBe(false);
    expect(isCodexReasoningModel("gpt-5-chat")).toBe(false);
    expect(isCodexReasoningModel("gpt-4.1-mini")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// patchCodexBody — always-on fields
// ---------------------------------------------------------------------------

describe("patchCodexBody — always-on fields", () => {
  it("sets store: false", () => {
    const out = patchCodexBody({ model: "gpt-5.3-codex", input: [userItem] });
    expect(out.store).toBe(false);
  });

  it("sets stream: true", () => {
    const out = patchCodexBody({ model: "gpt-5.3-codex", input: [userItem] });
    expect(out.stream).toBe(true);
  });

  it("overrides an existing store: true with store: false", () => {
    const out = patchCodexBody({ model: "gpt-5.3-codex", store: true, input: [userItem] });
    expect(out.store).toBe(false);
  });

  it("does NOT mutate the input object", () => {
    const original: Record<string, unknown> = {
      model: "gpt-5.3-codex",
      input: [userItem],
    };
    patchCodexBody(original);
    expect(original.store).toBeUndefined();
    expect(original.stream).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BUG-1  max_output_tokens / max_completion_tokens must be removed
// The Codex backend rejects these fields with a 400 error.
// ---------------------------------------------------------------------------

describe("patchCodexBody — BUG-1: remove unsupported token-limit fields", () => {
  it("removes max_output_tokens when present", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      max_output_tokens: 2048,
      input: [userItem],
    });
    expect(out).not.toHaveProperty("max_output_tokens");
  });

  it("removes max_completion_tokens when present", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      max_completion_tokens: 2048,
      input: [userItem],
    });
    expect(out).not.toHaveProperty("max_completion_tokens");
  });

  it("is a no-op when neither field is present", () => {
    const out = patchCodexBody({ model: "gpt-5.3-codex", input: [userItem] });
    expect(out).not.toHaveProperty("max_output_tokens");
    expect(out).not.toHaveProperty("max_completion_tokens");
  });
});

// ---------------------------------------------------------------------------
// BUG-2  reasoning.encrypted_content must be in `include` for reasoning models
// When store=false, the Codex backend requires this include entry so it can
// return encrypted reasoning tokens needed for stateless multi-turn continuity.
// ---------------------------------------------------------------------------

describe("patchCodexBody — BUG-2: reasoning.encrypted_content in include", () => {
  it("adds reasoning.encrypted_content for gpt-5.3-codex", () => {
    const out = patchCodexBody({ model: "gpt-5.3-codex", input: [userItem] });
    expect(out.include as string[]).toContain("reasoning.encrypted_content");
  });

  it("adds reasoning.encrypted_content for gpt-5.4", () => {
    const out = patchCodexBody({ model: "gpt-5.4", input: [userItem] });
    expect(out.include as string[]).toContain("reasoning.encrypted_content");
  });

  it("merges with existing include entries instead of replacing them", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      include: ["web_search_call.action.sources"],
      input: [userItem],
    });
    const inc = out.include as string[];
    expect(inc).toContain("web_search_call.action.sources");
    expect(inc).toContain("reasoning.encrypted_content");
  });

  it("does NOT add reasoning.encrypted_content for non-reasoning models", () => {
    const out = patchCodexBody({ model: "gpt-4o", input: [userItem] });
    const inc = (out.include as string[] | undefined) ?? [];
    expect(inc).not.toContain("reasoning.encrypted_content");
  });

  it("does NOT duplicate reasoning.encrypted_content if already in include", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      include: ["reasoning.encrypted_content"],
      input: [userItem],
    });
    const inc = out.include as string[];
    const count = inc.filter((x) => x === "reasoning.encrypted_content").length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BUG-3  input item `id` fields must be stripped for stateless mode
// The Codex backend rejects input items that carry IDs in stateless operation.
// ---------------------------------------------------------------------------

describe("patchCodexBody — BUG-3: strip id from input items", () => {
  it("removes id from a user input item", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      input: [{ id: "msg_abc123", ...userItem }],
    });
    const items = out.input as Record<string, unknown>[];
    expect(items[0]).not.toHaveProperty("id");
  });

  it("removes id from all input items", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      input: [
        { id: "msg_abc", ...userItem },
        { id: "msg_def", ...assistantItem },
        { id: "msg_ghi", ...userItem },
      ],
    });
    const items = out.input as Record<string, unknown>[];
    expect(items.every((item) => !("id" in item))).toBe(true);
  });

  it("preserves all other fields on input items", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      input: [{ id: "msg_abc", ...userItem }],
    });
    const item = (out.input as Record<string, unknown>[])[0];
    expect(item.role).toBe("user");
    expect(item.content).toEqual(userItem.content);
  });

  it("is a no-op when input items have no id", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      input: [userItem, assistantItem],
    });
    const items = out.input as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// BUG-4  item_reference input entries must be removed
// @ai-sdk/openai injects "item_reference" items when using conversation mode.
// The Codex backend does not understand this type and returns an error.
// ---------------------------------------------------------------------------

describe("patchCodexBody — BUG-4: remove item_reference input entries", () => {
  it("removes a single item_reference entry", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      input: [
        { type: "item_reference", id: "msg_abc123" },
        userItem,
      ],
    });
    const items = out.input as Record<string, unknown>[];
    expect(items.some((x) => x.type === "item_reference")).toBe(false);
  });

  it("removes all item_reference entries, leaving normal items intact", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      input: [
        { type: "item_reference", id: "msg_1" },
        userItem,
        { type: "item_reference", id: "msg_2" },
        assistantItem,
      ],
    });
    const items = out.input as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0].role).toBe("user");
    expect(items[1].role).toBe("assistant");
  });

  it("leaves input unchanged when no item_reference entries exist", () => {
    const out = patchCodexBody({
      model: "gpt-5.3-codex",
      input: [userItem, assistantItem],
    });
    const items = out.input as Record<string, unknown>[];
    expect(items).toHaveLength(2);
  });
});
