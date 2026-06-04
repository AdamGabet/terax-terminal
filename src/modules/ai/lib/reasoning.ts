import type { ProviderId } from "../config";

export const REASONING_LEVELS = ["none", "low", "medium", "high"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
type ProviderReasoningEffort = Exclude<ReasoningLevel, "none">;

export const DEFAULT_CHAT_REASONING_LEVEL: ReasoningLevel = "medium";
export const DEFAULT_AUTOCOMPLETE_REASONING_LEVEL: ReasoningLevel = "low";

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return (
    typeof value === "string" &&
    (REASONING_LEVELS as readonly string[]).includes(value)
  );
}

export function normalizeReasoningLevel(
  value: unknown,
  fallback: ReasoningLevel,
): ReasoningLevel {
  return isReasoningLevel(value) ? value : fallback;
}

export function buildReasoningProviderOptions(
  provider: ProviderId,
  resolvedModelId: string,
  level: ReasoningLevel,
): Record<string, { reasoningEffort: ProviderReasoningEffort }> | undefined {
  if (level === "none") return undefined;

  if (provider === "openai" || provider === "codex") {
    if (isOpenAIReasoningModel(resolvedModelId)) {
      return { openai: { reasoningEffort: level } };
    }
  }

  if (
    (provider === "cerebras" || provider === "groq") &&
    /\bgpt-oss\b/i.test(resolvedModelId)
  ) {
    return { [provider]: { reasoningEffort: level } };
  }

  return undefined;
}

function isOpenAIReasoningModel(modelId: string): boolean {
  return (
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4") ||
    (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-chat")) ||
    /\bgpt-oss\b/i.test(modelId)
  );
}
