import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptPayload } from "../src/request.ts";
import { parseModels } from "../src/provider.ts";

test("models use service metadata, conservative missing limits and unknown pricing", () => {
  const models = parseModels({ data: [
    { id: "vision", name: "Vision", contextWindow: 64000, maxTokens: 8000, supportsImages: true, supportsReasoning: true },
    { id: "plain", creditConsumption: 9 },
    { id: "bad-limits", contextWindow: -1, maxTokens: "many", supportsImages: "true" },
  ] }, "https://example.com/chat-rag/api/v1");
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].contextWindow, 64000);
  assert.equal(models[0].maxTokens, 8000);
  assert.equal(models[1].contextWindow, 32768);
  assert.equal(models[1].maxTokens, 8192);
  assert.deepEqual(models[2].input, ["text"]);
  assert.equal(models[1].cost.input, 0);
});

test("invalid model catalogs fail instead of poisoning the current catalog", () => {
  for (const payload of [null, {}, { data: {} }, { data: [null] }, { data: [{ id: "" }] },
    { data: [{ id: "a" }, { id: "a" }] }]) assert.throws(() => parseModels(payload, "https://example.com"));
  assert.deepEqual(parseModels({ data: [] }, "https://example.com"), []);
});

test("model policies preserve unrelated fields and do not mutate input", () => {
  const original = { stream: true, tool_choice: "required", response_format: { type: "json_schema" },
    temperature: 0.5, tools: [{ type: "function" }], custom: 123 };
  const kimi = adaptPayload(original, "Vendor-Kimi") as any;
  assert.equal(kimi.tool_choice, "auto");
  assert.equal(kimi.response_format, undefined);
  assert.equal(kimi.temperature, undefined);
  assert.equal(kimi.custom, 123);
  assert.equal(original.tool_choice, "required");
  assert.deepEqual(adaptPayload(original, "glm-5"), original);
  const nonstream = adaptPayload({ ...original, stream: false }, "kimi") as any;
  assert.equal(nonstream.tool_choice, "required");
  assert.equal((adaptPayload(original, "DeepSeek") as any).tool_choice, "auto");
  assert.equal((adaptPayload(original, "auto") as any).tool_choice, "auto");
});

test("normal tool choice stays intact while forced functions are downgraded only where needed", () => {
  assert.equal((adaptPayload({ tool_choice: "none" }, "kimi") as any).tool_choice, "none");
  assert.equal((adaptPayload({ tool_choice: { type: "function" } }, "deepseek") as any).tool_choice, "auto");
});

test("only function tools and base64 image URLs are accepted", () => {
  assert.throws(() => adaptPayload({ tools: [{ type: "web_search" }] }, "glm"), /function tools/);
  assert.throws(() => adaptPayload({ messages: [{ content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] }, "glm"), /base64/);
  const payload = { messages: [{ content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
  assert.deepEqual(adaptPayload(payload, "glm"), payload);
  assert.throws(() => adaptPayload(null, "glm"), /object/);
});
