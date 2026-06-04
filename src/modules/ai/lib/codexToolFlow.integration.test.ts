/**
 * Comprehensive integration test suite for Codex multi-turn and tool-call flows.
 *
 * Goal: map every scenario that can break so we know exactly what the backend
 * accepts and what the AI SDK sends vs. what we need to patch.
 *
 * Requires a valid ~/.codex/auth.json — all tests are skipped when absent.
 *
 * Run these tests:
 *   pnpm test codexToolFlow
 *
 * Each describe block is labelled with a hypothesis about what should happen.
 * The console.info lines are intentional — they print the raw bodies so you
 * can read them alongside the test results.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { patchCodexBody } from "./codexBody";

// ---------------------------------------------------------------------------
// Auth helpers (shared with codexEndpoint.integration.test.ts)
// ---------------------------------------------------------------------------

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

// The model used throughout.
const MODEL = "gpt-5.3-codex";

type AuthTokens = {
  access_token: string;
  refresh_token: string;
  account_id?: string;
};
type AuthFile = { auth_mode?: string; tokens: AuthTokens };
type Creds = { accessToken: string; accountId: string };

function jwtClaim(token: string, topKey: string, subKey: string): string | null {
  try {
    const seg = token.split(".")[1];
    const pad = (4 - (seg.length % 4)) % 4;
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
    const payload = JSON.parse(atob(b64)) as Record<string, unknown>;
    const top = payload[topKey] as Record<string, unknown> | undefined;
    return (top?.[subKey] as string) ?? null;
  } catch {
    return null;
  }
}

function loadCreds(): Creds | null {
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const auth: AuthFile = JSON.parse(raw) as AuthFile;
    const accessToken = auth.tokens.access_token;
    const accountId =
      auth.tokens.account_id ??
      jwtClaim(accessToken, "https://api.openai.com/auth", "chatgpt_account_id") ??
      "";
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

const CREDS = loadCreds();
const NO_AUTH = !CREDS;

// ---------------------------------------------------------------------------
// HTTP helper — raw fetch with full SSE parsing
// ---------------------------------------------------------------------------

type CodexEvent = {
  type: string;
  [k: string]: unknown;
};

type CodexResponse = {
  status: number;
  ok: boolean;
  rawBody: string;
  events: CodexEvent[];
  /** Merged output items collected from response.output_item.done events */
  outputItems: Record<string, unknown>[];
  /** The final response.completed payload */
  completedPayload: Record<string, unknown> | null;
  /** Convenience: error detail if status is not 2xx */
  errorDetail: string | null;
};

async function postCodex(
  body: Record<string, unknown>,
  creds: Creds,
): Promise<CodexResponse> {
  const resp = await fetch(CODEX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      "chatgpt-account-id": creds.accountId,
      originator: "terax",
      "OpenAI-Beta": "responses=experimental",
    },
    body: JSON.stringify(body),
  });

  const rawBody = await resp.text();
  const events: CodexEvent[] = [];
  const outputItems: Record<string, unknown>[] = [];
  let completedPayload: Record<string, unknown> | null = null;
  let errorDetail: string | null = null;

  if (!resp.ok) {
    // Error responses are plain JSON
    try {
      const json = JSON.parse(rawBody) as Record<string, unknown>;
      errorDetail = json.detail
        ? String(json.detail)
        : JSON.stringify(json).slice(0, 300);
    } catch {
      errorDetail = rawBody.slice(0, 300);
    }
  } else {
    // Parse SSE stream
    for (const line of rawBody.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
      try {
        const event = JSON.parse(trimmed.slice(6)) as CodexEvent;
        events.push(event);
        if (event.type === "response.output_item.done" && event.item) {
          outputItems.push(event.item as Record<string, unknown>);
        }
        if (event.type === "response.completed" && event.response) {
          completedPayload = event.response as Record<string, unknown>;
        }
      } catch {
        /* skip malformed lines */
      }
    }
  }

  return { status: resp.status, ok: resp.ok, rawBody, events, outputItems, completedPayload, errorDetail };
}

// ---------------------------------------------------------------------------
// Tool definitions used in tests
// ---------------------------------------------------------------------------

/** A simple deterministic tool the model is very likely to call when asked. */
const ECHO_TOOL = {
  type: "function",
  name: "echo_back",
  description:
    "Returns the exact string the caller passes in. Use this when the user asks you to echo something.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The string to echo back." },
    },
    required: ["message"],
  },
};

const MATH_TOOL = {
  type: "function",
  name: "multiply",
  description:
    "Multiplies two integers together. Always use this tool for multiplication; never compute it yourself.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "integer" },
      b: { type: "integer" },
    },
    required: ["a", "b"],
  },
};

// ---------------------------------------------------------------------------
// SCENARIO 1: Observe the raw function_call item shape in the response
//
// Hypothesis: the model returns a `function_call` output item with fields
// { type, id, call_id, name, arguments }.  We need to know the exact field
// set before we can construct a valid second turn.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 1 — function_call response shape",
  () => {
    it("captures the exact fields returned in a function_call output item", async () => {
      const body = {
        model: MODEL,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: 'Call echo_back with message="hello-world" now.',
              },
            ],
          },
        ],
        tools: [ECHO_TOOL],
        store: false,
        stream: true,
        instructions: "You are a helpful assistant. Follow the user's instructions exactly.",
        include: ["reasoning.encrypted_content"],
        tool_choice: { type: "function", name: "echo_back" },
      };

      const result = await postCodex(body, CREDS!);

      console.info("\n[S1] status:", result.status);
      console.info("[S1] output items:", JSON.stringify(result.outputItems, null, 2));

      expect(result.ok).toBe(true);

      const fcItems = result.outputItems.filter((x) => x.type === "function_call");
      console.info("[S1] function_call items:", JSON.stringify(fcItems, null, 2));

      expect(fcItems.length).toBeGreaterThan(0);

      const fc = fcItems[0];
      console.info("[S1] function_call fields present:", Object.keys(fc));
      // Document which fields are present — this drives all subsequent tests
      expect(fc.type).toBe("function_call");
      expect(typeof fc.call_id).toBe("string");
      expect(typeof fc.name).toBe("string");
      expect(typeof fc.arguments).toBe("string");
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 2: Two-turn tool call — inlined function_call WITH original `id`
//
// Hypothesis: including the function_call item in the input WITH its `id`
// field causes the backend to reject it in stateless mode.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 2 — two-turn tool call: function_call with id (likely fails)",
  () => {
    it("Turn 1 succeeds and produces a function_call item", async () => {
      const turn1 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 7 by 8 using the multiply tool." }],
            },
          ],
          tools: [MATH_TOOL],
          tool_choice: { type: "function", name: "multiply" },
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("\n[S2-T1] status:", turn1.status, "| output types:", turn1.outputItems.map((x) => x.type));
      expect(turn1.ok).toBe(true);

      const fc = turn1.outputItems.find((x) => x.type === "function_call");
      expect(fc).toBeDefined();
      console.info("[S2-T1] function_call item:", JSON.stringify(fc, null, 2));

      // Turn 2 — include function_call item WITH its original `id`
      const turn2 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 7 by 8 using the multiply tool." }],
            },
            // Inline the function_call item from Turn 1 as-is (with id)
            fc,
            {
              type: "function_call_output",
              call_id: fc!.call_id,
              output: JSON.stringify({ result: 56 }),
            },
          ],
          tools: [MATH_TOOL],
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("[S2-T2 with id] status:", turn2.status, turn2.errorDetail ?? "OK");
      console.info("[S2-T2 with id] output types:", turn2.outputItems.map((x) => x.type));
      // Document the behaviour — does having `id` cause a rejection?
    }, 40_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 3: Two-turn tool call — inlined function_call WITHOUT `id`
//
// Hypothesis: stripping `id` from the function_call item (as patchCodexBody
// does) and sending it in the next turn's input is the correct approach.
// The `call_id` field links the function_call to function_call_output.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 3 — two-turn tool call: function_call without id (expected correct path)",
  () => {
    it("Turn 2 with id-stripped function_call should succeed", async () => {
      // Turn 1
      const turn1 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 11 by 3 using the multiply tool." }],
            },
          ],
          tools: [MATH_TOOL],
          tool_choice: { type: "function", name: "multiply" },
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      expect(turn1.ok).toBe(true);
      const fc = turn1.outputItems.find((x) => x.type === "function_call");
      expect(fc).toBeDefined();

      // Strip id from the function_call item (mimics patchCodexBody step 4d)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id: _id, ...fcNoId } = fc as Record<string, unknown>;

      console.info("\n[S3-T1] function_call (id stripped):", JSON.stringify(fcNoId, null, 2));

      // Turn 2
      const turn2 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 11 by 3 using the multiply tool." }],
            },
            fcNoId,
            {
              type: "function_call_output",
              call_id: fc!.call_id,
              output: JSON.stringify({ result: 33 }),
            },
          ],
          tools: [MATH_TOOL],
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("[S3-T2 no-id] status:", turn2.status, turn2.errorDetail ?? "OK");
      console.info("[S3-T2 no-id] output types:", turn2.outputItems.map((x) => x.type));

      const textItem = turn2.outputItems.find((x) => x.type === "message" || x.type === "output_text");
      console.info("[S3-T2 no-id] text output:", JSON.stringify(textItem, null, 2));

      expect(turn2.ok).toBe(true);
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 4: Two-turn — ONLY function_call_output, no function_call in input
//
// Hypothesis: this is what happens after patchCodexBody strips item_references
// that the SDK uses to refer to the previous turn's function_call. The backend
// returns "No tool call found for function call output with call_id ...".
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 4 — function_call_output with no matching function_call (reproduces the bug)",
  () => {
    it("returns an error when function_call_output has no corresponding function_call", async () => {
      // Turn 1
      const turn1 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 4 by 5 using the multiply tool." }],
            },
          ],
          tools: [MATH_TOOL],
          tool_choice: { type: "function", name: "multiply" },
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      expect(turn1.ok).toBe(true);
      const fc = turn1.outputItems.find((x) => x.type === "function_call");
      expect(fc).toBeDefined();

      // Turn 2 — deliberately omit the function_call item (only send output)
      const turn2 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 4 by 5 using the multiply tool." }],
            },
            // function_call item intentionally MISSING — simulates what happens
            // when patchCodexBody strips item_references that the SDK uses
            {
              type: "function_call_output",
              call_id: fc!.call_id,
              output: JSON.stringify({ result: 20 }),
            },
          ],
          tools: [MATH_TOOL],
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("\n[S4] status:", turn2.status);
      console.info("[S4] error detail:", turn2.errorDetail);
      console.info("[S4] raw body (first 500):", turn2.rawBody.slice(0, 500));

      // This SHOULD fail — it reproduces the bug
      expect(turn2.ok).toBe(false);
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 5: What does patchCodexBody do to a realistic SDK-style body?
//
// The AI SDK uses item_reference entries to refer to previous response items.
// We simulate a body that includes item_references (as the SDK would send)
// and test whether stripping them causes the same error as Scenario 4.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 5 — item_reference stripping: does it lose the function_call?",
  () => {
    it("simulates SDK sending item_reference for previous function_call", async () => {
      // Turn 1
      const turn1 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 6 by 7 using the multiply tool." }],
            },
          ],
          tools: [MATH_TOOL],
          tool_choice: { type: "function", name: "multiply" },
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      expect(turn1.ok).toBe(true);
      const fc = turn1.outputItems.find((x) => x.type === "function_call");
      expect(fc).toBeDefined();

      const fcId = fc!.id as string;
      const fcCallId = fc!.call_id as string;

      // Simulate what the AI SDK sends for Turn 2:
      // Instead of inlining the full function_call item, it sends an item_reference.
      const sdkStyleBody = {
        model: MODEL,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Multiply 6 by 7 using the multiply tool." }],
          },
          // SDK uses item_reference to refer to the function_call from Turn 1
          { type: "item_reference", id: fcId },
          {
            type: "function_call_output",
            call_id: fcCallId,
            output: JSON.stringify({ result: 42 }),
          },
        ],
        tools: [MATH_TOOL],
        store: false,
        stream: true,
        instructions: "Use tools when asked.",
        include: ["reasoning.encrypted_content"],
      };

      console.info("\n[S5] SDK-style body before patchCodexBody:", JSON.stringify(sdkStyleBody, null, 2));

      // Test A: send with item_reference as-is (without patching)
      const rawResult = await postCodex(sdkStyleBody, CREDS!);
      console.info("[S5-raw] status with item_reference:", rawResult.status, rawResult.errorDetail ?? "OK");

      // Test B: send after patchCodexBody (strips item_reference)
      const patched = patchCodexBody(sdkStyleBody);
      console.info("[S5] after patchCodexBody:", JSON.stringify(patched, null, 2));

      const patchedResult = await postCodex(patched, CREDS!);
      console.info("[S5-patched] status after stripping item_reference:", patchedResult.status, patchedResult.errorDetail ?? "OK");

      // Both approaches should be documented. patchedResult is the current behaviour.
      // If patchedResult fails with the "No tool call found" error, that confirms the bug.
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 6: The correct fix — expand item_reference into the actual item
//
// Hypothesis: instead of stripping item_references, we need to replace them
// with the actual function_call item. This test verifies that approach works.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 6 — correct fix: replace item_reference with inlined function_call",
  () => {
    it("Turn 2 succeeds when item_reference is replaced by the inlined function_call", async () => {
      // Turn 1
      const turn1 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Multiply 9 by 4 using the multiply tool." }],
            },
          ],
          tools: [MATH_TOOL],
          tool_choice: { type: "function", name: "multiply" },
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      expect(turn1.ok).toBe(true);
      const fc = turn1.outputItems.find((x) => x.type === "function_call");
      expect(fc).toBeDefined();

      const fcId = fc!.id as string;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id: _id, ...fcNoId } = fc as Record<string, unknown>;

      // Simulate SDK sending item_reference, but patch it to inline the actual item
      const sdkStyleInput = [
        {
          role: "user",
          content: [{ type: "input_text", text: "Multiply 9 by 4 using the multiply tool." }],
        },
        { type: "item_reference", id: fcId },
        { type: "function_call_output", call_id: fc!.call_id, output: JSON.stringify({ result: 36 }) },
      ];

      // The "fix": replace item_reference with the actual item (id stripped)
      const resolvedInput = sdkStyleInput.map((item) =>
        item.type === "item_reference" && item.id === fcId ? fcNoId : item,
      );

      console.info("\n[S6] resolved input (item_reference expanded):", JSON.stringify(resolvedInput, null, 2));

      const turn2 = await postCodex(
        {
          model: MODEL,
          input: resolvedInput,
          tools: [MATH_TOOL],
          store: false,
          stream: true,
          instructions: "Use tools when asked.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("[S6-T2] status:", turn2.status, turn2.errorDetail ?? "OK");
      console.info("[S6-T2] output types:", turn2.outputItems.map((x) => x.type));
      const textItems = turn2.outputItems.filter((x) => x.type === "message");
      console.info("[S6-T2] text:", JSON.stringify(textItems, null, 2));

      expect(turn2.ok).toBe(true);
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 7: Multi-turn text — stateless continuity with reasoning tokens
//
// Hypothesis: for reasoning models in stateless mode, the encrypted reasoning
// token from Turn 1 must be included in Turn 2 for the model to maintain
// context. Test whether this works and what the token structure looks like.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 7 — multi-turn text with encrypted reasoning continuity",
  () => {
    it("Turn 2 can reference Turn 1 content when reasoning token is passed", async () => {
      // Turn 1: ask for a secret number
      const turn1 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Pick a secret number between 1 and 100. Tell me you've chosen it but don't reveal it yet." },
              ],
            },
          ],
          store: false,
          stream: true,
          instructions: "Follow the user's instructions exactly.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      expect(turn1.ok).toBe(true);
      console.info("\n[S7-T1] output types:", turn1.outputItems.map((x) => x.type));

      const reasoningItem = turn1.outputItems.find((x) => x.type === "reasoning");
      const messageItem = turn1.outputItems.find((x) => x.type === "message");
      console.info("[S7-T1] reasoning item keys:", reasoningItem ? Object.keys(reasoningItem) : "none");
      console.info("[S7-T1] message:", JSON.stringify(messageItem, null, 2));

      // Check if encrypted_content is in the reasoning item
      const hasEncryptedReasoning =
        reasoningItem &&
        Array.isArray(reasoningItem.content) &&
        (reasoningItem.content as unknown[]).some(
          (c) => (c as Record<string, unknown>).type === "reasoning_encrypted",
        );
      console.info("[S7-T1] has encrypted reasoning:", hasEncryptedReasoning);

      // Turn 2: ask it to reveal the number
      // Include reasoning item from Turn 1 (for continuity)
      const turn1Items = turn1.outputItems.map(
        // Strip `id` from items for stateless mode
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ({ id: _id, ...rest }) => rest,
      );

      const turn2 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Pick a secret number between 1 and 100. Tell me you've chosen it but don't reveal it yet." },
              ],
            },
            ...turn1Items,
            {
              role: "user",
              content: [{ type: "input_text", text: "Now reveal the number you picked." }],
            },
          ],
          store: false,
          stream: true,
          instructions: "Follow the user's instructions exactly.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("[S7-T2] status:", turn2.status, turn2.errorDetail ?? "OK");
      const t2Message = turn2.outputItems.find((x) => x.type === "message");
      console.info("[S7-T2] response:", JSON.stringify(t2Message, null, 2));

      expect(turn2.ok).toBe(true);
    }, 90_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 8: Parallel tool calls
//
// Hypothesis: some models return multiple function_call items in a single turn.
// We need to handle all of them in the next input.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 8 — parallel tool calls: multiple function_call items in one turn",
  () => {
    it("sends results for all parallel tool calls and gets a final response", async () => {
      const turn1 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Call multiply(2,3) AND multiply(4,5) in parallel, then tell me both results.",
                },
              ],
            },
          ],
          tools: [MATH_TOOL],
          parallel_tool_calls: true,
          store: false,
          stream: true,
          instructions:
            "Use tools. When asked for parallel calls, issue both function_call items simultaneously.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("\n[S8-T1] status:", turn1.status);
      const fcItems = turn1.outputItems.filter((x) => x.type === "function_call");
      console.info("[S8-T1] function_call count:", fcItems.length);
      console.info("[S8-T1] function_calls:", JSON.stringify(fcItems, null, 2));

      if (!turn1.ok || fcItems.length === 0) {
        console.info("[S8] skipping T2 — no function_calls produced");
        return;
      }

      // Strip ids and build function_call_output for each
      const inlinedFCs = fcItems.map(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ({ id: _id, ...rest }) => rest,
      );
      const toolResults = fcItems.map((fc) => {
        const args = JSON.parse(fc.arguments as string) as { a: number; b: number };
        return {
          type: "function_call_output",
          call_id: fc.call_id,
          output: JSON.stringify({ result: args.a * args.b }),
        };
      });

      const turn2 = await postCodex(
        {
          model: MODEL,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Call multiply(2,3) AND multiply(4,5) in parallel, then tell me both results.",
                },
              ],
            },
            ...inlinedFCs,
            ...toolResults,
          ],
          tools: [MATH_TOOL],
          store: false,
          stream: true,
          instructions:
            "Use tools. When asked for parallel calls, issue both function_call items simultaneously.",
          include: ["reasoning.encrypted_content"],
        },
        CREDS!,
      );

      console.info("[S8-T2] status:", turn2.status, turn2.errorDetail ?? "OK");
      console.info("[S8-T2] output types:", turn2.outputItems.map((x) => x.type));
      const msg = turn2.outputItems.find((x) => x.type === "message");
      console.info("[S8-T2] response:", JSON.stringify(msg, null, 2));

      expect(turn2.ok).toBe(true);
    }, 90_000);
  },
);

// ---------------------------------------------------------------------------
// SCENARIO 9: What does patchCodexBody actually receive from the AI SDK?
//
// This intercepts the codexFetch call at the patchCodexBody level to log
// the exact body the SDK constructs before any patching, so we can see
// whether it uses item_references, direct function_call items, or another
// format.
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "SCENARIO 9 — intercept: log raw SDK request body for tool call continuation",
  () => {
    it("shows what the AI SDK sends to patchCodexBody for a 2-turn tool call", async () => {
      // We can't run the actual SDK here (no Tauri), but we can simulate what
      // streamText + responses() would construct based on the AI SDK source.
      //
      // The AI SDK's responses provider, when continuing after a tool call,
      // adds the tool result as a new input item. The prior assistant output
      // items are referenced via item_reference if a previous_response_id is
      // available, or inlined directly if not.
      //
      // Since we force store=false (no server-side storage), the SDK cannot
      // use previous_response_id for references.  Instead it should inline.
      //
      // Let's verify both shapes are handled correctly by patchCodexBody.

      // Shape A: SDK inlines function_call directly (expected for stateless)
      const shapeA = {
        model: MODEL,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Multiply 3 by 3." }] },
          { type: "function_call", id: "fc_abc", call_id: "call_abc", name: "multiply", arguments: '{"a":3,"b":3}', status: "completed" },
          { type: "function_call_output", call_id: "call_abc", output: '{"result":9}' },
        ],
        tools: [MATH_TOOL],
        store: true, // SDK may send store:true, patchCodexBody forces false
        stream: false, // SDK may send stream:false, patchCodexBody forces true
        instructions: "Use tools.",
        max_output_tokens: 1024, // SDK may include this, patchCodexBody strips it
      };

      const patchedA = patchCodexBody(shapeA);
      console.info("\n[S9-shapeA] raw:", JSON.stringify(shapeA, null, 2));
      console.info("[S9-shapeA] patched:", JSON.stringify(patchedA, null, 2));

      const resultA = await postCodex(patchedA, CREDS!);
      console.info("[S9-shapeA] status:", resultA.status, resultA.errorDetail ?? "OK");
      console.info("[S9-shapeA] output:", resultA.outputItems.map((x) => x.type));

      // Shape B: SDK sends item_reference (stateful-style, but we have store=false)
      const shapeB = {
        model: MODEL,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Multiply 3 by 3." }] },
          { type: "item_reference", id: "fc_abc" }, // references previous function_call
          { type: "function_call_output", call_id: "call_abc", output: '{"result":9}' },
        ],
        tools: [MATH_TOOL],
        store: false,
        stream: true,
        instructions: "Use tools.",
        include: ["reasoning.encrypted_content"],
      };

      const patchedB = patchCodexBody(shapeB);
      console.info("\n[S9-shapeB] raw:", JSON.stringify(shapeB, null, 2));
      console.info("[S9-shapeB] patched:", JSON.stringify(patchedB, null, 2));

      const resultB = await postCodex(patchedB, CREDS!);
      console.info("[S9-shapeB] status after stripping item_reference:", resultB.status, resultB.errorDetail ?? "OK");
      // We expect this to fail — it demonstrates the bug when SDK uses item_references

      // Summary
      console.info("\n[S9 SUMMARY]");
      console.info("  Shape A (inlined function_call) result:", resultA.ok ? "SUCCESS" : `FAIL (${resultA.status})`);
      console.info("  Shape B (item_reference stripped) result:", resultB.ok ? "SUCCESS" : `FAIL (${resultB.status})`);
    }, 60_000);
  },
);
