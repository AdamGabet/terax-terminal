import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  getAllModels,
  LMSTUDIO_DEFAULT_BASE_URL,
  type AutocompleteProviderId,
} from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import {
  buildReasoningProviderOptions,
  DEFAULT_AUTOCOMPLETE_REASONING_LEVEL,
  type ReasoningLevel,
} from "@/modules/ai/lib/reasoning";
import { generateText, streamText } from "ai";
import {
  buildUserPrompt,
  COMPLETION_SYSTEM_PROMPT,
  type CompletionRequest,
} from "./prompt";

export type CompletionDeps = {
  provider: AutocompleteProviderId;
  modelId: string;
  apiKey: string | null;
  lmstudioBaseURL: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  openaiCompatibleBaseURL?: string;
  reasoningLevel?: ReasoningLevel;
};

const MAX_OUTPUT_TOKENS_DEFAULT = 128;
// Reasoning models burn output tokens on internal thought before producing
// any visible content; with a tight cap they finish_reason="length" with
// empty text. The trim step still caps visible output at MAX_LINES.
const MAX_OUTPUT_TOKENS_REASONING = 1024;

export async function requestCompletion(
  req: CompletionRequest,
  deps: CompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  const modelId =
    deps.modelId.trim() || DEFAULT_AUTOCOMPLETE_MODEL[deps.provider] || "";
  if (!modelId) {
    throw new Error(
      `No autocomplete model id set for ${deps.provider}.`,
    );
  }

  // Settings store the model's MODELS-registry id (e.g. "codex/gpt-5.3-codex").
  // buildLanguageModel needs the actual provider model id (e.g. "gpt-5.3-codex").
  // Mirrors what buildConfiguredLanguageModel does for chat.
  const resolvedModelId =
    getAllModels().find((m) => m.id === modelId)?.providerModelId ?? modelId;

  const keys = { ...EMPTY_PROVIDER_KEYS, [deps.provider]: deps.apiKey };
  const model = await buildLanguageModel(deps.provider, keys, resolvedModelId, {
    lmstudioBaseURL: deps.lmstudioBaseURL || LMSTUDIO_DEFAULT_BASE_URL,
    mlxBaseURL: deps.mlxBaseURL,
    ollamaBaseURL: deps.ollamaBaseURL,
    openaiCompatibleBaseURL: deps.openaiCompatibleBaseURL,
  });

  const providerOptions = buildReasoningProviderOptions(
    deps.provider,
    resolvedModelId,
    deps.reasoningLevel ?? DEFAULT_AUTOCOMPLETE_REASONING_LEVEL,
  );
  const isReasoning = !!providerOptions;

  const sharedArgs = {
    model,
    system: COMPLETION_SYSTEM_PROMPT,
    prompt: buildUserPrompt(req),
    maxOutputTokens: isReasoning
      ? MAX_OUTPUT_TOKENS_REASONING
      : MAX_OUTPUT_TOKENS_DEFAULT,
    maxRetries: 0,
    abortSignal: signal,
    temperature: 0.2,
    ...(providerOptions ? { providerOptions } : {}),
  };

  // The Codex provider endpoint only supports streaming (stream: true).
  // generateText uses doGenerate which sends no stream field and expects a
  // JSON response — it fails silently when the endpoint returns SSE.
  // Use streamText for codex and accumulate the text promise instead.
  if (deps.provider === "codex") {
    const result = streamText(sharedArgs);
    const text = await result.text;
    return cleanCompletion(text);
  }

  const { text } = await generateText(sharedArgs);
  return cleanCompletion(text);
}

function cleanCompletion(raw: string): string {
  let t = raw;
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  t = t.replace(/^<\|cursor\|>/, "");
  return t;
}
