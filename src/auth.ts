import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

export const CLIENT_DEFAULTS = {
  pluginVersion: "3.0.23",
  vscodeVersion: "1.143.0",
  provider: "casdoor",
  uriScheme: "vscode",
} as const;

export interface LoginParams {
  baseUrl: string;
  machineCode: string;
  state: string;
  provider: string;
  pluginVersion: string;
  vscodeVersion: string;
  uriScheme: string;
  allowHttp: boolean;
}

export interface CostrictCredential extends OAuthCredential {
  costrict: LoginParams;
  userId: string;
}

export interface CostrictOptions {
  baseUrl?: string;
  pluginVersion?: string;
  vscodeVersion?: string;
  allowHttp?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeBaseUrl(raw: string, allowHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("CoStrict: enter a valid service origin, e.g. https://costrict.example.com");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || allowHttp))) {
    throw new Error("CoStrict: HTTPS is required; set COSTRICT_ALLOW_HTTP=1 only for a trusted HTTP service");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("CoStrict: use the service origin only, without credentials, path, query or fragment");
  }
  return url.origin;
}

function headerValue(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]+$/.test(value);
}

export function readCredential(value: OAuthCredential): CostrictCredential {
  const params = value.costrict;
  if (!isRecord(params) || typeof params.allowHttp !== "boolean" ||
      !["baseUrl", "machineCode", "state", "provider", "pluginVersion", "vscodeVersion", "uriScheme"]
        .every((key) => headerValue(params[key])) || !headerValue(value.userId) ||
      !headerValue(value.access) || !headerValue(value.refresh) || !Number.isFinite(value.expires)) {
    throw new Error("CoStrict: invalid stored credentials; run /login costrict again");
  }
  normalizeBaseUrl(params.baseUrl as string, params.allowHttp);
  if (!/^[a-f0-9]{64}$/.test(params.machineCode as string)) {
    throw new Error("CoStrict: invalid client identity; run /login costrict again");
  }
  return value as CostrictCredential;
}

export function authUrl(params: LoginParams, path: "login" | "token" | "status", includeMachine: boolean): URL {
  const suffix = path === "login" ? "" : `/${path}`;
  const url = new URL(`/oidc-auth/api/v1/plugin/login${suffix}`, params.baseUrl);
  url.search = new URLSearchParams({
    ...(includeMachine ? { machine_code: params.machineCode } : {}),
    state: params.state,
    provider: params.provider,
    plugin_version: params.pluginVersion,
    vscode_version: params.vscodeVersion,
    uri_scheme: params.uriScheme,
  }).toString();
  return url;
}

export class CostrictHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`CoStrict: HTTP ${status}${status === 401 || status === 403 ? "; sign in again or check account permissions" : ""}`);
    this.status = status;
  }
}

export async function requestJson(url: URL, signal: AbortSignal, headers: Record<string, string> = {}): Promise<unknown> {
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: bounded,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CostrictHttpError(response.status);
    }
    if (response.status === 202 || response.status === 204) return undefined;
    return await response.json();
  } catch (error) {
    signal.throwIfAborted();
    if (bounded.aborted) throw new Error("CoStrict: request timed out");
    if (error instanceof CostrictHttpError) throw error;
    // Do not include URLs, response bodies or low-level causes containing credentials.
    throw new Error("CoStrict: request failed; check connectivity, TLS and the service response format");
  }
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    const claims: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (isRecord(claims)) return claims;
  } catch {
    // JWT payload is used for expiry/identity only, not as signature verification.
  }
  throw new Error("CoStrict: access token has no valid JWT metadata");
}

function credentialFromTokens(params: LoginParams, data: Record<string, unknown>, previous?: CostrictCredential): CostrictCredential {
  const access = data.access_token;
  const refresh = data.refresh_token ?? previous?.refresh;
  if (!headerValue(access) || !headerValue(refresh)) throw new Error("CoStrict: incomplete token response");
  const claims = jwtClaims(access);
  const expires = typeof claims.exp === "number" ? claims.exp * 1000 : NaN;
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("CoStrict: token expiry is missing or already expired");
  let userId = [claims.universal_id, claims.sub].find(headerValue);
  if (!headerValue(userId)) {
    const refreshClaims = jwtClaims(refresh);
    userId = [refreshClaims.universal_id, refreshClaims.sub].find(headerValue);
  }
  if (!headerValue(userId)) throw new Error("CoStrict: token has no usable user identity");
  return { type: "oauth", access, refresh, expires, costrict: params, userId };
}

function tokenData(payload: unknown): Record<string, unknown> | undefined {
  if (payload === undefined) return undefined;
  if (!isRecord(payload) || typeof payload.success !== "boolean") throw new Error("CoStrict: invalid token response");
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (data && ["denied", "failed", "expired", "cancelled"].includes(String(data.status))) {
    throw new Error("CoStrict: login was rejected or expired; run /login costrict again");
  }
  if (!payload.success) return undefined;
  if (!data) throw new Error("CoStrict: token response is missing data");
  return data;
}

export async function pollLogin(params: LoginParams, signal: AbortSignal, intervalMs = 3000): Promise<CostrictCredential> {
  for (;;) {
    const data = tokenData(await requestJson(authUrl(params, "token", true), signal));
    if (data && (data.access_token || data.refresh_token)) {
      if (data.state !== undefined && data.state !== params.state) throw new Error("CoStrict: login state mismatch");
      const credential = credentialFromTokens(params, data);
      const status = await requestJson(authUrl(params, "status", false), signal, { Authorization: `Bearer ${credential.access}` });
      if (!isRecord(status) || status.success !== true || !isRecord(status.data) || status.data.status !== "logged_in") {
        throw new Error("CoStrict: server did not confirm the login session");
      }
      if (status.data.state !== undefined && status.data.state !== params.state) throw new Error("CoStrict: login state mismatch");
      return credential;
    }
    await delay(intervalMs, undefined, { signal });
  }
}

export async function login(interaction: ProviderAuthInteraction, options: CostrictOptions): Promise<CostrictCredential> {
  interaction.signal.throwIfAborted();
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? await interaction.prompt({
    type: "text", message: "CoStrict service origin", placeholder: "https://costrict.example.com",
  }), options.allowHttp);
  const pluginVersion = options.pluginVersion ?? CLIENT_DEFAULTS.pluginVersion;
  const vscodeVersion = options.vscodeVersion ?? CLIENT_DEFAULTS.vscodeVersion;
  if (![pluginVersion, vscodeVersion].every((v) => /^\d+\.\d+(?:\.\d+)?$/.test(v))) {
    throw new Error("CoStrict: client versions must be numeric dotted versions");
  }
  const params: LoginParams = {
    ...CLIENT_DEFAULTS, baseUrl, pluginVersion, vscodeVersion,
    machineCode: randomBytes(32).toString("hex"),
    state: randomBytes(8).toString("hex") + Date.now().toString(36),
    allowHttp: options.allowHttp ?? false,
  };
  interaction.notify({ type: "auth_url", url: authUrl(params, "login", true).toString(),
    instructions: "Open this URL in your browser. Complete login and return here; no VS Code callback is required." });
  interaction.notify({ type: "progress", message: "Waiting for CoStrict login (up to 5 minutes)…" });
  const timeout = AbortSignal.timeout(5 * 60_000);
  try {
    return await pollLogin(params, AbortSignal.any([interaction.signal, timeout]));
  } catch (error) {
    interaction.signal.throwIfAborted();
    if (timeout.aborted) throw new Error("CoStrict: login timed out; run /login costrict again");
    throw error;
  }
}

export async function refresh(value: OAuthCredential, signal: AbortSignal): Promise<CostrictCredential> {
  const previous = readCredential(value);
  const payload = await requestJson(authUrl(previous.costrict, "token", false), signal, { Authorization: `Bearer ${previous.refresh}` });
  const data = tokenData(payload);
  if (!data) throw new Error("CoStrict: token refresh rejected; run /login costrict again");
  const params = { ...previous.costrict };
  if (data.state !== undefined) {
    if (!headerValue(data.state)) throw new Error("CoStrict: invalid refreshed login state");
    params.state = data.state;
  }
  return credentialFromTokens(params, data, previous);
}

export function costrictHeaders(credential: CostrictCredential): Record<string, string> {
  const requestId = randomUUID();
  return {
    Authorization: `Bearer ${credential.access}`,
    "Accept-Language": "zh-CN",
    "HTTP-Referer": "https://github.com/RooVetGit/Roo-Cline",
    "X-Title": "Roo Code",
    "User-Agent": `RooCode/3.52.1 plugin_vscode/${credential.costrict.pluginVersion}`,
    "X-Costrict-Version": credential.costrict.pluginVersion,
    "x-costrict-idea": "Visual Studio Code",
    "x-quota-identity": "system",
    "X-Request-ID": requestId,
    "zgsm-request-id": requestId,
    "zgsm-task-id": randomUUID(),
    "x-user-id": credential.userId,
    "zgsm-client-id": credential.costrict.machineCode,
    "zgsm-provider": "costrict",
    "x-caller": "chat",
  };
}
