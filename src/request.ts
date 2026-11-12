import { isRecord } from "./auth.ts";

const SUMMARIZATION_MARKER = "context summarization assistant";

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** Pi /compact and branch summaries use a dedicated system prompt and wrap history in tags. */
export function isSummarizationPayload(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.messages)) return false;
  for (const message of payload.messages) {
    if (!isRecord(message)) continue;
    const text = messageText(message);
    if (text.includes(SUMMARIZATION_MARKER)) return true;
    if (text.includes("<conversation>") && text.includes("</conversation>")) return true;
  }
  return false;
}

export function isSummarizationContext(context: { systemPrompt?: string; messages?: unknown[] }): boolean {
  if (typeof context.systemPrompt === "string" && context.systemPrompt.includes(SUMMARIZATION_MARKER)) {
    return true;
  }
  return isSummarizationPayload({ messages: context.messages });
}

// Only model-specific differences observed by costrict-router are applied here.
export function adaptPayload(payload: unknown, modelId: string): unknown {
  if (!isRecord(payload)) throw new Error("CoStrict: chat payload must be an object");
  const result = { ...payload };
  const model = modelId.toLowerCase();
  const deepseek = model.includes("deepseek");
  const kimi = model.includes("kimi");
  const auto = model === "auto";
  const hasTools = Array.isArray(result.tools) && result.tools.length > 0;
  const hasFormat = result.response_format != null;
  if (deepseek || auto || (kimi && result.stream === true)) {
    if (result.tool_choice === "required" || isRecord(result.tool_choice)) result.tool_choice = "auto";
  }
  if ((deepseek || kimi || auto) && hasTools) delete result.response_format;
  if (hasFormat && (auto || (kimi && result.temperature !== 1))) delete result.temperature;
  if (Array.isArray(result.tools) && result.tools.some((tool) => !isRecord(tool) || tool.type !== "function")) {
    throw new Error("CoStrict: only function tools are supported");
  }
  if (Array.isArray(result.messages)) {
    for (const message of result.messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (isRecord(block) && block.type === "image_url" &&
            (!isRecord(block.image_url) || typeof block.image_url.url !== "string" ||
             !/^data:image\/[a-z0-9.+-]+;base64,/i.test(block.image_url.url))) {
          throw new Error("CoStrict: images must use base64 data URLs; remote image URLs are not supported");
        }
      }
    }
  }
  // One-shot summaries (/compact, branch summary) do not need client-requested thinking.
  // Leaving reasoning_effort on these requests makes CoStrict's long silent thinking windows
  // more likely, which Pi surfaces as "Stream ended without finish_reason".
  // Do not inject thinking.type=disabled: some CoStrict models reject that with HTTP 400.
  if (isSummarizationPayload(result)) {
    delete result.reasoning_effort;
    delete result.reasoning;
    delete result.enable_thinking;
  }
  return result;
}
