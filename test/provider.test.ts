import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, InMemoryCredentialStore, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai";
import { createCostrictProvider } from "../src/provider.ts";
import { catalog, context, credential, json, jwt, runtime, serve, sse, tokenEnvelope } from "./helpers.ts";

test("streams Unicode text with usage, headers and caller lifecycle hooks", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, [{ content: "你好🌍" }]));
  let payloads = 0, responses = 0, rawEvents = 0, fetches = 0;
  const stream = run.models.streamSimple(run.model, context(), {
    maxTokens: 100,
    onPayload: (payload) => { payloads++; return { ...(payload as object), custom: "kept" }; },
    onResponse: (response) => { responses++; assert.equal(response.status, 200); },
    onProviderStreamEvent: () => { rawEvents++; },
    fetch: (input, init) => { fetches++; assert.equal(init?.redirect, "error"); return fetch(input, init); },
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [{ type: "text", text: "你好🌍" }]);
  assert.equal(result.usage.input, 10);
  assert.equal(result.usage.output, 5);
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.usage.cost.total, 0);
  assert.equal(events.filter((e) => e.type === "start").length, 1);
  assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
  assert.equal(payloads, 1);
  assert.equal(responses, 1);
  assert.ok(rawEvents >= 2);
  assert.equal(fetches, 1);
  const req = run.requests.find((r) => r.body)!;
  assert.equal(req.url.pathname, "/chat-rag/api/v1/chat/completions");
  assert.equal(req.headers.authorization, `Bearer ${run.saved.access}`);
  assert.equal(req.headers["x-user-id"], "test-user");
  assert.equal(req.headers["zgsm-client-id"], run.saved.costrict.machineCode);
  assert.equal(req.headers["x-request-id"], req.headers["zgsm-request-id"]);
  assert.equal(req.body.max_tokens, 100);
  assert.equal(req.body.max_completion_tokens, undefined);
  assert.equal(req.body.store, undefined);
  assert.equal(req.body.reasoning_effort, undefined);
  assert.equal(req.body.custom, "kept");
  assert.equal(req.body.messages[0].role, "system");
});

test("round-trips reasoning and successive tool calls through three model turns", async (t) => {
  let round = 0;
  const run = await runtime(t, (_req, res) => {
    round++;
    if (round < 3) sse(res, [
      { reasoning_content: "让我检查" },
      { tool_calls: [{ index: 0, id: `call-${round}`, type: "function", function: { name: "lookup", arguments: '{"key":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] },
    ], "tool_calls");
    else sse(res, [{ content: "完成" }]);
  });
  const ctx: Context = { ...context(), tools: [{ name: "lookup", description: "Look up a value",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }] };
  for (let i = 0; i < 2; i++) {
    const response = await run.models.complete(run.model, ctx, { toolChoice: "required", maxRetries: 0 });
    assert.equal(response.stopReason, "toolUse");
    const call = response.content.find((block) => block.type === "toolCall");
    assert.ok(call?.type === "toolCall");
    assert.deepEqual(call.arguments, { key: "value" });
    ctx.messages.push(response, { role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "found" }], isError: false, timestamp: Date.now() });
  }
  const final = await run.models.completeSimple(run.model, ctx);
  assert.equal(final.stopReason, "stop");
  assert.equal(round, 3);
  const chats = run.requests.filter((r) => r.body);
  assert.equal(chats[0].body.tool_choice, "auto");
  assert.equal(chats[0].body.tools[0].function.strict, undefined);
  const assistant = chats[1].body.messages.find((m: any) => m.role === "assistant");
  assert.equal(assistant.reasoning_content, "让我检查");
  assert.equal(assistant.tool_calls[0].id, "call-1");
  assert.equal(chats[1].body.messages.at(-1).tool_call_id, "call-1");
  assert.equal(chats[2].body.messages.filter((m: any) => m.role === "tool").length, 2);
  assert.notEqual(chats[0].headers["x-request-id"], chats[1].headers["x-request-id"]);
});

test("image input and image tool results become data URLs", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, [{ content: "image received" }]));
  const ctx: Context = { messages: [{
    role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], timestamp: Date.now(),
  }] };
  await run.models.completeSimple(run.model, ctx);
  const body = run.requests.find((r) => r.body)!.body;
  assert.equal(body.messages[0].content[0].image_url.url, "data:image/png;base64,AAAA");
  const toolResponse = await run.models.completeSimple(run.model, {
    messages: [...ctx.messages, {
      ...await run.models.completeSimple(run.model, context()),
      content: [{ type: "toolCall", id: "image-call", name: "capture", arguments: {} }], stopReason: "toolUse",
    }, {
      role: "toolResult", toolCallId: "image-call", toolName: "capture", isError: false,
      content: [{ type: "image", mimeType: "image/png", data: "BBBB" }], timestamp: Date.now(),
    }],
  });
  assert.equal(toolResponse.stopReason, "stop");
  const imageResult = run.requests.at(-1)!.body.messages.at(-1).content;
  assert.equal(imageResult.at(-1).image_url.url, "data:image/png;base64,BBBB");
});

test("empty successful responses finish normally", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, []));
  const result = await run.models.completeSimple(run.model, context());
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, []);
});

test("caller cancellation aborts a live HTTP stream", async (t) => {
  const run = await runtime(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
  });
  const controller = new AbortController();
  const stream = run.models.streamSimple(run.model, context(), { signal: controller.signal });
  for await (const event of stream) {
    if (event.type === "text_delta") controller.abort();
  }
  assert.equal((await stream.result()).stopReason, "aborted");
});

test("truncated streams produce an error instead of silent success", async (t) => {
  const run = await runtime(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
  });
  const result = await run.models.completeSimple(run.model, context(), { maxRetries: 0 });
  assert.equal(result.stopReason, "error");
  assert.ok(result.errorMessage);
});

test("compaction-style summaries tolerate streams that omit finish_reason", async (t) => {
  const run = await runtime(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"## Goal\\nShip the fix"},"finish_reason":null}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const summaryContext = {
    systemPrompt: "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.",
    messages: [{
      role: "user" as const,
      content: [{ type: "text" as const, text: "<conversation>\nuser: hi\nassistant: hello\n</conversation>\n\nSummarize." }],
      timestamp: Date.now(),
    }],
  };
  const result = await run.models.completeSimple(run.model, summaryContext, { maxRetries: 0, reasoning: "high" });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [{ type: "text", text: "## Goal\nShip the fix" }]);
  const body = run.requests.find((r) => r.body)!.body;
  assert.equal(body.reasoning_effort, undefined);
});

for (const status of [401, 429, 400]) {
  test(`preserves HTTP ${status} failure semantics`, async (t) => {
    const run = await runtime(t, (_req, res) => json(res, {
      error: { message: status === 400 ? "context_length_exceeded" : "upstream failure", type: "test_error" },
    }, status));
    const result = await run.models.completeSimple(run.model, context(), { maxRetries: 0 });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, new RegExp(status === 400 ? "context_length_exceeded" : String(status)));
  });
}

test("payload replacement is validated after the caller hook and before network I/O", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, []));
  const result = await run.models.completeSimple(run.model, context(), {
    onPayload: () => ({ tools: [{ type: "web_search" }] }), maxRetries: 0,
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /function tools/);
  assert.equal(run.requests.filter((r) => r.body).length, 0);
});

test("catalog refresh caches, force-refreshes, retains valid state on failure and isolates accounts", async (t) => {
  const payload: any = structuredClone(catalog);
  const run = await runtime(t, (_req, res) => sse(res, []), payload);
  await run.models.refresh();
  assert.equal(run.requests.length, 1);
  await run.models.refresh({ force: true });
  assert.equal(run.requests.length, 2);
  payload.data = null;
  assert.equal((await run.models.refresh({ force: true })).errors.size, 1);
  assert.equal(run.models.getModels("costrict").length, 1);
  await run.credentials.modify("costrict", async () => ({ ...run.saved, userId: "another-user" }));
  assert.deepEqual(await run.models.getAvailable("costrict"), []);
  assert.equal((await run.models.refresh({ force: true })).errors.size, 1);
  assert.deepEqual(run.models.getModels("costrict"), []);
});

test("a restart restores account-scoped models without contacting a new login environment", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, []));
  const restarted = createModels({ credentials: run.credentials, modelsStore: run.modelsStore });
  restarted.setProvider(createCostrictProvider({ baseUrl: "https://never-contact.example" }));
  assert.equal((await restarted.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(restarted.getModels("costrict").length, 1);
  assert.equal(run.requests.length, 1);
  await restarted.logout("costrict");
  assert.deepEqual(await restarted.getAvailable("costrict"), []);
});

test("offline refresh never contacts the service or restores a foreign disk catalog", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, []));
  const copy = createCostrictProvider();
  let publications = 0;
  await copy.refreshModels!({ credential: run.saved, allowNetwork: false,
    stored: { models: [run.model] }, signal: new AbortController().signal,
    publish: async (publication) => { publications++; publication.update?.(); return true; } });
  assert.deepEqual(copy.getModels(), []);
  assert.equal(run.requests.length, 1);
  assert.ok(publications > 0);
});

test("generation-rejected refresh cannot overwrite the current model catalog", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, []));
  const copy = createCostrictProvider();
  await copy.refreshModels!({ credential: run.saved, allowNetwork: true,
    signal: new AbortController().signal, publish: async () => false });
  assert.equal(run.requests.length, 1);
  assert.deepEqual(copy.getModels(), []);
});

test("Pi serializes token rotation and saves the new credential once for concurrent requests", async (t) => {
  let renewals = 0;
  const server = await serve(t, (_req, res) => {
    renewals++;
    json(res, tokenEnvelope("test-state", { rotated: true }));
  });
  const credentials = new InMemoryCredentialStore();
  const old = { ...credential(server.origin), expires: Date.now() - 1 };
  await credentials.modify("costrict", async () => old);
  const models = createModels({ credentials });
  models.setProvider(createCostrictProvider());
  const [a, b] = await Promise.all([models.getAuth("costrict"), models.getAuth("costrict")]);
  assert.equal(renewals, 1);
  assert.equal(a?.auth.apiKey, b?.auth.apiKey);
  assert.notEqual(a?.auth.apiKey, old.access);
  assert.equal((await credentials.read("costrict") as any).access, a?.auth.apiKey);
});

test("a failed refresh preserves credentials instead of logging the user out", async (t) => {
  const server = await serve(t, (_req, res) => json(res, { success: false }, 401));
  const credentials = new InMemoryCredentialStore();
  const old = { ...credential(server.origin), expires: 1 };
  await credentials.modify("costrict", async () => old);
  const models = createModels({ credentials });
  models.setProvider(createCostrictProvider());
  await assert.rejects(models.getAuth("costrict"), /OAuth refresh failed/);
  assert.deepEqual(await credentials.read("costrict"), old);
});

test("stream redirects cannot forward a prompt to another service", async (t) => {
  let leaked = false;
  const target = await serve(t, (_req, res) => { leaked = true; sse(res, []); });
  const run = await runtime(t, (_req, res) => { res.writeHead(307, { Location: target.origin }).end(); });
  const result = await run.models.completeSimple(run.model, context(), { maxRetries: 0 });
  assert.equal(result.stopReason, "error");
  assert.equal(leaked, false);
});

test("a valid persisted catalog is rejected for another account or service", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, []));
  const stored = await run.modelsStore.read("costrict");
  assert.ok(stored?.etag);
  assert.ok(!JSON.stringify(stored).includes(run.saved.access));
  for (const saved of [
    { ...run.saved, userId: "someone-else" },
    { ...run.saved, costrict: { ...run.saved.costrict, baseUrl: "https://another.example" } },
  ]) {
    const copy = createCostrictProvider();
    await copy.refreshModels!({ credential: saved, stored, allowNetwork: false,
      signal: new AbortController().signal, publish: async (publication) => {
        publication.update?.();
        return true;
      } });
    assert.deepEqual(copy.getModels(), []);
  }
  assert.equal(run.requests.length, 1);
});

test("an already-cancelled catalog refresh publishes no fetched model state", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, []));
  const controller = new AbortController();
  controller.abort();
  const copy = createCostrictProvider();
  await copy.refreshModels!({ credential: run.saved, allowNetwork: true, signal: controller.signal,
    publish: async (publication) => { publication.update?.(); return true; } });
  assert.deepEqual(copy.getModels(), []);
  assert.equal(run.requests.length, 1);
});

test("cross-provider assistant/tool history survives a handoff", async (t) => {
  const run = await runtime(t, (_req, res) => sse(res, [{ content: "continued" }]));
  const previous = await run.models.completeSimple(run.model, context());
  const result = await run.models.completeSimple(run.model, {
    ...context(),
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }],
    messages: [...context().messages, {
      ...previous, provider: "another-provider", model: "another-model", api: "anthropic-messages",
      content: [{ type: "toolCall", id: "foreign-call", name: "lookup", arguments: {} }],
      stopReason: "toolUse",
    }, {
      role: "toolResult", toolCallId: "foreign-call", toolName: "lookup", content: [{ type: "text", text: "found" }],
      isError: false, timestamp: Date.now(),
    }],
  });
  assert.equal(result.stopReason, "stop");
  const messages = run.requests.at(-1)!.body.messages;
  const call = messages.find((message: any) => message.role === "assistant").tool_calls[0];
  assert.equal(messages.find((message: any) => message.role === "tool").tool_call_id, call.id);
});
