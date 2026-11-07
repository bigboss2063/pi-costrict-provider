import { isRecord } from "./auth.ts";

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
  return result;
}
