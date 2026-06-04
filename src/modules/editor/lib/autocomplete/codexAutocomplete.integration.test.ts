/**
 * Integration tests — Codex autocomplete end-to-end via the real HTTP endpoint.
 *
 * These tests bypass the Tauri runtime by reading ~/.codex/auth.json directly
 * (the same file the Rust codex_get_access_token command reads) and POST to
 * the Codex endpoint with a patchCodexBody-patched autocomplete body, exactly
 * as the real app does.
 *
 * They are automatically SKIPPED when auth.json is absent.
 *
 * Run only these tests:
 *   pnpm test codexAutocomplete
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { patchCodexBody } from "@/modules/ai/lib/codexBody";
import {
  buildUserPrompt,
  COMPLETION_SYSTEM_PROMPT,
} from "./prompt";

// ---------------------------------------------------------------------------
// Auth (mirrors the Rust codex_get_access_token command)
// ---------------------------------------------------------------------------

const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

type AuthFile = {
  tokens: {
    access_token: string;
    account_id?: string;
  };
};

type Creds = { accessToken: string; accountId: string };

function loadCreds(): Creds | null {
  try {
    const raw = fs.readFileSync(AUTH_PATH, "utf8");
    const auth = JSON.parse(raw) as AuthFile;
    const accessToken = auth.tokens.access_token;
    const accountId = auth.tokens.account_id ?? jwtClaim(accessToken) ?? "";
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function jwtClaim(token: string): string | null {
  try {
    const seg = token.split(".")[1];
    const pad = (4 - (seg.length % 4)) % 4;
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
    const payload = JSON.parse(atob(b64)) as Record<string, unknown>;
    const ns = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    return (ns?.chatgpt_account_id as string) ?? null;
  } catch {
    return null;
  }
}

const CREDS = loadCreds();
const NO_AUTH = !CREDS;

// ---------------------------------------------------------------------------
// HTTP helper — SSE-aware fetch for the Codex streaming endpoint
// ---------------------------------------------------------------------------

interface CodexResult {
  status: number;
  ok: boolean;
  text: string;
  outputText: string | null;
}

async function postCodexStream(
  body: Record<string, unknown>,
  creds: Creds,
): Promise<CodexResult> {
  const resp = await fetch(CODEX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.accessToken}`,
      "chatgpt-account-id": creds.accountId,
      "openai-originator": "terax",
      "OpenAI-Beta": "responses=experimental",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

  // For error responses (4xx) the body is plain JSON.
  if (!resp.ok) {
    console.error("[autocomplete] error", resp.status, text.slice(0, 400));
    return { status: resp.status, ok: false, text, outputText: null };
  }

  // For streaming (200) responses collect output_text from SSE events.
  let outputText: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
    try {
      const event = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
      // response.output_text.done carries the full text for a single text block.
      if (event.type === "response.output_text.done" && typeof event.text === "string") {
        outputText = (outputText ?? "") + (event.text as string);
      }
    } catch {
      /* skip malformed lines */
    }
  }

  return { status: resp.status, ok: true, text, outputText };
}

// ---------------------------------------------------------------------------
// The autocomplete model used in tests — confirmed working against the real endpoint.
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_MODEL = "gpt-5.3-codex";

// ---------------------------------------------------------------------------
// Helper — build the patched body as the app does
// ---------------------------------------------------------------------------

function buildAutocompletebody(
  prefix: string,
  suffix: string,
): Record<string, unknown> {
  // Mirrors what @ai-sdk/openai builds for generateText with a system + user prompt.
  const rawBody: Record<string, unknown> = {
    model: AUTOCOMPLETE_MODEL,
    input: [
      {
        role: "developer",
        content: COMPLETION_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildUserPrompt({ prefix, suffix, language: "typescript", filename: "test.ts" }),
      },
    ],
    max_output_tokens: 128,
  };

  return patchCodexBody(rawBody);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(NO_AUTH)("Codex autocomplete — patchCodexBody shapes the request correctly", () => {
  it("patchCodexBody produces a valid Codex request body from a typical autocomplete input", () => {
    const body = buildAutocompletebody(
      "function add(a: number, b: number): ",
      "\n  return a + b;\n}",
    );

    // instructions extracted from developer message
    expect(typeof body.instructions).toBe("string");
    expect((body.instructions as string).length).toBeGreaterThan(0);

    // developer message removed from input
    const input = body.input as Record<string, unknown>[];
    expect(input.every((item) => item.role !== "developer")).toBe(true);
    expect(input.every((item) => item.role !== "system")).toBe(true);

    // max_output_tokens removed
    expect(body).not.toHaveProperty("max_output_tokens");

    // stream and store set
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);

    // reasoning.encrypted_content in include (gpt-5.1-codex-mini is a reasoning model)
    expect(body.include as string[]).toContain("reasoning.encrypted_content");
  });
});

describe.skipIf(NO_AUTH)("Codex autocomplete — real endpoint", () => {
  it("returns a non-empty completion for a partial function signature", async () => {
    const body = buildAutocompletebody(
      "function add(a: number, b: number): ",
      "\n  return a + b;\n}",
    );

    console.info("[autocomplete] sending body:", JSON.stringify(body, null, 2));

    const result = await postCodexStream(body, CREDS!);

    console.info(
      "[autocomplete] status:", result.status,
      "| output:", JSON.stringify(result.outputText),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(typeof result.outputText).toBe("string");
    // Should complete the return type — "number" or similar.
    expect((result.outputText as string).trim().length).toBeGreaterThan(0);
  }, 30_000);

  it("returns 200 for a multi-line completion request", async () => {
    const body = buildAutocompletebody(
      "// Clamp n between lo and hi\nfunction clamp(",
      ") {\n  return Math.min(hi, Math.max(lo, n));\n}",
    );

    const result = await postCodexStream(body, CREDS!);

    console.info(
      "[autocomplete multi-line] status:", result.status,
      "| output:", JSON.stringify(result.outputText),
    );

    expect(result.ok).toBe(true);
  }, 30_000);
});
