/**
 * Pure helpers for adapting AI SDK Responses requests to the Codex backend.
 * Kept outside the transport so the provider-specific body patch is testable.
 */


export function isCodexReasoningModel(modelId: string): boolean {
  return (
    modelId.startsWith("o1") ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4-mini") ||
    (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-chat"))
  );
}

type JsonBody = Record<string, unknown>;
type InputItem = Record<string, unknown>;

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map((part) =>
        part.type === "input_text" || part.type === "text"
          ? String(part.text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

export function patchCodexBody(body: JsonBody): JsonBody {
  const out = { ...body };

  out.store = false;
  out.stream = true;

  delete out.max_output_tokens;
  delete out.max_completion_tokens;

  let inputItems: InputItem[] = Array.isArray(out.input)
    ? (out.input as InputItem[])
    : [];

  if (!out.instructions) {
    const systemItems = inputItems.filter(
      (item) => item.role === "developer" || item.role === "system",
    );
    if (systemItems.length > 0) {
      out.instructions = systemItems
        .map((item) => extractContent(item.content))
        .join("\n");
    }
  }

  inputItems = inputItems.filter(
    (item) => item.role !== "developer" && item.role !== "system",
  );

  inputItems = inputItems.filter((item) => item.type !== "item_reference");

  inputItems = inputItems.map((item) => {
    if (!("id" in item)) return item;
    return Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== "id"),
    );
  });

  out.input = inputItems;

  if (isCodexReasoningModel(String(out.model ?? ""))) {
    const existing = Array.isArray(out.include)
      ? (out.include as string[])
      : [];
    if (!existing.includes("reasoning.encrypted_content")) {
      out.include = [...existing, "reasoning.encrypted_content"];
    }
  }

  return out;
}
