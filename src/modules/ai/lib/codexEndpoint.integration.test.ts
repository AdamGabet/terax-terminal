/**
 * Integration tests — real HTTP requests to chatgpt.com/backend-api/codex/responses
 *
 * These tests require a valid ~/.codex/auth.json (from `npx @openai/codex login`).
 * They are automatically SKIPPED when that file is absent.
 *
 * Purpose: document what the real Codex backend accepts/rejects.
 *
 * RED PHASE before the fix:
 *   - "broken body succeeds" tests will fail because the broken body actually
 *     causes an error (confirms the bug is real)
 *   - "fixed body" tests show what the correct body looks like
 *
 * Run only these tests:
 *   pnpm test codexEndpoint
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

// The model used in tests.  Must be one the account has access to.
const TEST_MODEL = "gpt-5.3-codex";

type AuthTokens = {
  access_token: string;
  refresh_token: string;
  account_id?: string;
};

type AuthFile = {
  auth_mode?: string;
  tokens: AuthTokens;
};

type Creds = { accessToken: string; accountId: string };

function loadCreds(): Creds | null {
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const auth: AuthFile = JSON.parse(raw) as AuthFile;
    const accessToken = auth.tokens.access_token;

    // account_id lives directly on tokens, or inside the JWT claims.
    const accountId =
      auth.tokens.account_id ??
      jwtClaim(
        accessToken,
        "https://api.openai.com/auth",
        "chatgpt_account_id",
      ) ??
      "";

    return { accessToken, accountId };
  } catch {
    return null;
  }
}

/** Extract a nested string claim from a JWT payload without verifying the sig. */
function jwtClaim(
  token: string,
  topKey: string,
  subKey: string,
): string | null {
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

const CREDS = loadCreds();
const NO_AUTH = !CREDS;

// ---------------------------------------------------------------------------
// HTTP helper — direct fetch (no Tauri proxy, tests the raw endpoint)
// ---------------------------------------------------------------------------

interface CodexResponse {
  status: number;
  ok: boolean;
  body: string;
  // Parsed if JSON
  json?: Record<string, unknown>;
}

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
      // Header name used by all known community implementations:
      "openai-originator": "terax",
      "OpenAI-Beta": "responses=experimental",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json: Record<string, unknown> | undefined;

  // Try plain JSON first — error responses (4xx) are always plain JSON.
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // SSE streaming response — reconstruct a response object from the stream.
    // The Codex backend sends output items via response.output_item.done events;
    // the response.completed event may carry an empty output array, so we
    // collect items separately and merge them in.
    let baseResponse: Record<string, unknown> | undefined;
    const outputItems: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
      try {
        const event = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
        // Capture the last event that carries a response object (response.completed).
        if (event.response && typeof event.response === "object") {
          baseResponse = event.response as Record<string, unknown>;
        }
        // Collect output items from completion events.
        if (event.type === "response.output_item.done" && event.item) {
          outputItems.push(event.item as Record<string, unknown>);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    if (baseResponse) {
      json =
        outputItems.length > 0
          ? { ...baseResponse, output: outputItems }
          : baseResponse;
    }
  }

  return { status: resp.status, ok: resp.ok, body: text, json };
}

// ---------------------------------------------------------------------------
// Minimal valid inputs for a single-turn "hi" request
// ---------------------------------------------------------------------------

const USER_TURN = [
  {
    role: "user",
    content: [{ type: "input_text", text: "Reply with exactly one word: hello" }],
  },
];

// ---------------------------------------------------------------------------
// BUG-1 integration — max_output_tokens causes a 400
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "Codex endpoint — BUG-1: max_output_tokens is rejected",
  () => {
    it("returns 400 when max_output_tokens is present", async () => {
      // This is what the @ai-sdk/openai SDK can send when maxOutputTokens is set.
      const brokenBody = {
        model: TEST_MODEL,
        input: USER_TURN,
        store: false,
        max_output_tokens: 512,
      };

      const result = await postCodex(brokenBody, CREDS!);

      // Expect the backend to reject the unknown parameter.
      expect(result.status).toBe(400);
      console.info(
        "[BUG-1 response]",
        result.status,
        result.body.slice(0, 400),
      );
    }, 20_000);

    it("succeeds when max_output_tokens is absent", async () => {
      const fixedBody = {
        model: TEST_MODEL,
        input: USER_TURN,
        store: false,
        stream: true,
        instructions: "Reply concisely.",
        include: ["reasoning.encrypted_content"],
      };

      const result = await postCodex(fixedBody, CREDS!);

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// BUG-2 integration — missing include: reasoning.encrypted_content
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "Codex endpoint — BUG-2: missing reasoning.encrypted_content in include",
  () => {
    it("returns an error or incomplete response without include", async () => {
      // Current broken body — store: false but no include.
      const brokenBody = {
        model: TEST_MODEL,
        input: USER_TURN,
        store: false,
        // include deliberately absent — this is what patchCodexBody currently sends
      };

      const result = await postCodex(brokenBody, CREDS!);

      // Document the actual failure.  The assertion records the behaviour —
      // if the backend returns 400 this test is RED before the fix, GREEN after.
      console.info(
        "[BUG-2 broken response]",
        result.status,
        result.body.slice(0, 400),
      );

      // We expect either an explicit error status or a response missing the
      // encrypted reasoning tokens that would break a second turn.
      //
      // If the backend DOES return 200 here, remove this assertion and instead
      // add a test that checks the response lacks 'reasoning' in the output.
      expect(result.ok).toBe(false);
    }, 10_000);

    it("succeeds and includes reasoning token when include is correct", async () => {
      const fixedBody = {
        model: TEST_MODEL,
        input: USER_TURN,
        store: false,
        stream: true,
        instructions: "Reply concisely.",
        include: ["reasoning.encrypted_content"],
      };

      const result = await postCodex(fixedBody, CREDS!);

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);

      // The response should contain output — at minimum a text item.
      const output = result.json?.output as unknown[] | undefined;
      expect(Array.isArray(output)).toBe(true);

      console.info(
        "[BUG-2 fixed response output types]",
        (output ?? [])
          .map((x) => (x as Record<string, unknown>).type)
          .join(", "),
      );
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// BUG-4 integration — item_reference causes a 400
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)(
  "Codex endpoint — BUG-4: item_reference in input is rejected",
  () => {
    it("returns 400 when input contains an item_reference entry", async () => {
      // The @ai-sdk/openai SDK injects these in conversation/multi-turn mode.
      // Instructions and stream are valid so the endpoint reaches the
      // item_reference validation (not a missing-instructions 400).
      const brokenBody = {
        model: TEST_MODEL,
        input: [
          { type: "item_reference", id: "resp_fakeid123" },
          ...USER_TURN,
        ],
        store: false,
        stream: true,
        instructions: "Reply concisely.",
        include: ["reasoning.encrypted_content"],
      };

      const result = await postCodex(brokenBody, CREDS!);

      expect(result.status).toBe(404);
      console.info(
        "[BUG-4 response]",
        result.status,
        result.body.slice(0, 400),
      );
    }, 10_000);

    it("succeeds when item_reference entries are removed", async () => {
      const fixedBody = {
        model: TEST_MODEL,
        input: USER_TURN, // no item_reference
        store: false,
        stream: true,
        instructions: "Reply concisely.",
        include: ["reasoning.encrypted_content"],
      };

      const result = await postCodex(fixedBody, CREDS!);

      expect(result.ok).toBe(true);
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// Sanity — fully-correct minimal body returns a text response
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)("Codex endpoint — sanity: correct body", () => {
  it("returns 200 with output text for a minimal correct request", async () => {
    const body = {
      model: TEST_MODEL,
      input: USER_TURN,
      store: false,
      stream: true,
      instructions: "Reply concisely.",
      include: ["reasoning.encrypted_content"],
    };

    const result = await postCodex(body, CREDS!);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    const output = result.json?.output as
      | Array<Record<string, unknown>>
      | undefined;
    expect(Array.isArray(output)).toBe(true);
    expect(output!.length).toBeGreaterThan(0);

    console.info(
      "[Sanity response] model:",
      result.json?.model,
      "| output items:",
      output?.length,
      "| types:",
      output?.map((x) => x.type).join(", "),
    );
  }, 30_000);
});
