import { createProvider, type Model, type Provider, type Credential, type ProviderRequestOptions, type Context } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createHash } from "node:crypto";
import {
  costrictHeaders, isRecord, login, normalizeBaseUrl, readCredential, refresh, requestJson,
  type CostrictCredential, type CostrictOptions,
} from "./auth.ts";
import { adaptPayload, isSummarizationContext } from "./request.ts";

type ChatModel = Model<"openai-completions">;
const CATALOG_TTL = 10 * 60_000;

/** Compaction/branch summaries are one-shot text replies; tolerate CoStrict streams that omit finish_reason. */
function modelForContext(model: Model<"openai-completions">, context: Context): Model<"openai-completions"> {
  if (!isSummarizationContext(context)) return model;
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsFinishReason: false,
    },
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function parseModels(payload: unknown, baseUrl: string): ChatModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("CoStrict: invalid model catalog");
  const ids = new Set<string>();
  return payload.data.map((entry): ChatModel => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id)) {
      throw new Error("CoStrict: model catalog contains invalid or duplicate IDs");
    }
    ids.add(entry.id);
    // shortcut: missing limits use conservative defaults; override verified limits in models.json.
    const contextWindow = positiveInteger(entry.contextWindow, 32768);
    return {
      type: "chat", provider: "costrict", api: "openai-completions",
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
      baseUrl,
      reasoning: entry.supportsReasoning === true || entry.reasoning === true,
      input: entry.supportsImages === true ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens: Math.min(contextWindow, positiveInteger(entry.maxTokens, 8192)),
      // CoStrict credits are not USD/token prices. Zero means unknown, not free.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        maxTokensField: "max_tokens",
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
      },
    };
  });
}

function scopeOf(credential: CostrictCredential): string {
  return "costrict:" + createHash("sha256").update(JSON.stringify([credential.costrict.baseUrl, credential.userId])).digest("hex");
}

function oauthCredential(value: Credential | undefined): CostrictCredential | undefined {
  return value?.type === "oauth" ? readCredential(value) : undefined;
}

function requestOptions<T extends ProviderRequestOptions>(options: T | undefined, modelId: string): T {
  const send = options?.fetch ?? globalThis.fetch;
  return {
    ...options,
    // Fail closed on redirects instead of forwarding prompts or client identity elsewhere.
    fetch: (input, init) => send(input, { ...init, redirect: "error" }),
    async onPayload(payload, model) {
      const replacement = await options?.onPayload?.(payload, model);
      return adaptPayload(replacement === undefined ? payload : replacement, modelId);
    },
  } as T;
}

export function createCostrictProvider(options: CostrictOptions = {}): Provider<"openai-completions"> {
  let models: ChatModel[] = [];
  let scope: string | undefined;
  let checkedAt = 0;
  const api = openAICompletionsApi();
  const provider = createProvider<"openai-completions">({
    id: "costrict",
    name: "CoStrict",
    auth: {
      oauth: {
        name: "CoStrict",
        login: (interaction) => login(interaction, options),
        refresh,
        async toAuth(value) {
          const credential = readCredential(value);
          return {
            apiKey: credential.access,
            baseUrl: new URL("/chat-rag/api/v1", credential.costrict.baseUrl).toString(),
            headers: costrictHeaders(credential),
          };
        },
      },
    },
    models: [],
    api: {
      stream: (model, context, streamOptions) =>
        api.stream(modelForContext(model as ChatModel, context), context, requestOptions(streamOptions, model.id)),
      streamSimple: (model, context, streamOptions) =>
        api.streamSimple(modelForContext(model as ChatModel, context), context, requestOptions(streamOptions, model.id)),
    },
    filterModels: (catalog, value) => {
      const credential = oauthCredential(value);
      return credential && scopeOf(credential) === scope ? catalog : [];
    },
  });
  return {
    ...provider,
    getModels: () => models,
    getAllModels: () => models,
    async refreshModels(context) {
      const credential = oauthCredential(context.credential);
      const nextScope = credential ? scopeOf(credential) : undefined;
      if (nextScope !== scope || !credential) {
        if (!await context.publish({
          ...(context.stored?.etag !== nextScope ? { persist: null } : {}),
          update: () => { models = []; scope = nextScope; checkedAt = 0; },
        })) return;
      }
      if (!credential || context.signal.aborted) return;
      const origin = normalizeBaseUrl(credential.costrict.baseUrl, credential.costrict.allowHttp);
      const baseUrl = new URL("/chat-rag/api/v1", origin).toString();
      const stored = context.stored;
      if (!checkedAt && stored && stored.etag === nextScope && stored.models.every((model) =>
        model.provider === "costrict" && model.api === "openai-completions" && model.baseUrl === baseUrl &&
        (model.type === undefined || model.type === "chat"))) {
        if (!await context.publish({ update: () => {
          models = [...stored.models] as ChatModel[];
          checkedAt = stored.checkedAt ?? 0;
        } })) return;
      }
      if (!context.allowNetwork) return;
      if (!context.force && checkedAt && Date.now() - checkedAt < CATALOG_TTL) return;
      const payload = await requestJson(new URL("/ai-gateway/api/v1/models", origin), context.signal, costrictHeaders(credential));
      const fetched = parseModels(payload, baseUrl);
      context.signal.throwIfAborted();
      const now = Date.now();
      // The opaque validator binds this snapshot to its service/account; it contains no tokens.
      await context.publish({
        persist: { models: fetched, etag: nextScope, checkedAt: now },
        update: () => { models = fetched; scope = nextScope; checkedAt = now; },
      });
    },
  };
}
