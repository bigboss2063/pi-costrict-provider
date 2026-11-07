import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, type Context } from "@earendil-works/pi-ai";
import { CLIENT_DEFAULTS, type CostrictCredential, type LoginParams } from "../src/auth.ts";
import { createCostrictProvider } from "../src/provider.ts";

export interface Request {
  url: URL;
  method: string;
  headers: IncomingHttpHeaders;
  body: any;
}
export type Handler = (request: Request, response: ServerResponse) => void | Promise<void>;

export async function serve(t: TestContext, handler: Handler) {
  const requests: Request[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const request = { url: new URL(req.url!, "http://localhost"), method: req.method!,
        headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(request);
      await handler(request, res);
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (errors.length) throw new AggregateError(errors, "mock handler failed");
  });
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

export function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}
export function jwt(claims: Record<string, unknown> = {}) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600, universal_id: "test-user", ...claims,
  })).toString("base64url")}.test-signature`;
}
export function params(origin: string): LoginParams {
  return { ...CLIENT_DEFAULTS, baseUrl: origin, machineCode: "a".repeat(64), state: "test-state", allowHttp: false };
}
export function credential(origin: string): CostrictCredential {
  return { type: "oauth", access: jwt(), refresh: jwt({ kind: "refresh" }),
    expires: Date.now() + 3600_000, costrict: params(origin), userId: "test-user" };
}
export function tokenEnvelope(state: string | null, claims: Record<string, unknown> = {}) {
  return { success: true, data: { access_token: jwt(claims), refresh_token: jwt({ kind: "refresh" }), ...(state ? { state } : {}) } };
}
export function sse(res: ServerResponse, deltas: unknown[], reason = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const delta of deltas) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
export const context = (): Context => ({
  systemPrompt: "You are a test assistant.",
  messages: [{ role: "user", content: "你好", timestamp: Date.now() }],
});
export const catalog = { data: [{ id: "kimi-test", contextWindow: 128000, maxTokens: 16000, supportsImages: true, supportsReasoning: true }] };

export async function runtime(t: TestContext, chat: Handler, modelPayload: unknown = catalog) {
  const server = await serve(t, (req, res) => {
    if (req.url.pathname === "/ai-gateway/api/v1/models") json(res, modelPayload);
    else return chat(req, res);
  });
  const credentials = new InMemoryCredentialStore();
  const saved = credential(server.origin);
  await credentials.modify("costrict", async () => saved);
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore });
  const provider = createCostrictProvider();
  models.setProvider(provider);
  const result = await models.refresh();
  if (result.errors.size) throw [...result.errors.values()][0];
  const model = models.getModel("costrict", "kimi-test");
  if (!model) throw new Error("missing test model");
  return { ...server, credentials, modelsStore, models, provider, model, saved };
}
