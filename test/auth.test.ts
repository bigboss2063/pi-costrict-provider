import assert from "node:assert/strict";
import { test } from "node:test";
import { authUrl, costrictHeaders, login, normalizeBaseUrl, pollLogin, readCredential, refresh, requestJson } from "../src/auth.ts";
import { credential, json, jwt, params, serve, tokenEnvelope } from "./helpers.ts";

test("service origin validation rejects secrets, paths and insecure remote HTTP", () => {
  assert.equal(normalizeBaseUrl(" https://example.com/ "), "https://example.com");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
  assert.equal(normalizeBaseUrl("http://example.com", true), "http://example.com");
  for (const value of ["bad", "file:///tmp", "http://example.com", "https://user:secret@example.com",
    "https://example.com/v1", "https://example.com/?token=secret", "https://example.com/#secret"]) {
    assert.throws(() => normalizeBaseUrl(value), /CoStrict:/);
  }
});

test("login and refresh query parameters differ only in machine_code", () => {
  const p = params("https://example.com");
  const initial = authUrl(p, "token", true);
  const renewed = authUrl(p, "token", false);
  assert.equal(initial.pathname, "/oidc-auth/api/v1/plugin/login/token");
  assert.equal(initial.searchParams.get("machine_code"), p.machineCode);
  assert.equal(renewed.searchParams.has("machine_code"), false);
  assert.equal(renewed.searchParams.get("provider"), "casdoor");
  assert.equal(renewed.searchParams.get("state"), p.state);
});

test("browser login generates a client identity, checks status and returns canonical credentials", async (t) => {
  const events: any[] = [];
  const { origin, requests } = await serve(t, (req, res) => {
    if (req.url.pathname.endsWith("/status")) {
      assert.ok(req.headers.authorization?.startsWith("Bearer "));
      json(res, { success: true, data: { status: "logged_in", state: req.url.searchParams.get("state") } });
    } else {
      assert.equal(req.headers.authorization, undefined);
      json(res, tokenEnvelope(req.url.searchParams.get("state")));
    }
  });
  const result = await login({
    signal: new AbortController().signal,
    prompt: async () => origin,
    notify: (event) => events.push(event),
  }, {});
  assert.equal(result.type, "oauth");
  assert.equal(result.userId, "test-user");
  assert.equal(result.costrict.baseUrl, origin);
  assert.match(result.costrict.machineCode, /^[a-f0-9]{64}$/);
  assert.ok(result.expires > Date.now());
  assert.equal(events[0].type, "auth_url");
  assert.equal(new URL(events[0].url).searchParams.get("machine_code"), result.costrict.machineCode);
  assert.equal(requests.length, 2);
  assert.deepEqual(readCredential(JSON.parse(JSON.stringify(result))), result);
});

test("polls pending responses without losing state", async (t) => {
  let count = 0;
  const { origin } = await serve(t, (req, res) => {
    if (req.url.pathname.endsWith("/status")) json(res, { success: true, data: { status: "logged_in" } });
    else if (++count === 1) json(res, { success: false, message: "not logged in" });
    else json(res, tokenEnvelope("test-state"));
  });
  assert.equal((await pollLogin(params(origin), new AbortController().signal, 1)).userId, "test-user");
  assert.equal(count, 2);
});

for (const mode of ["state", "status", "expired", "partial", "denied", "malformed", "identity"] as const) {
  test(`rejects invalid login: ${mode}`, async (t) => {
    const { origin } = await serve(t, (req, res) => {
      if (req.url.pathname.endsWith("/status")) {
        json(res, { success: true, data: { status: mode === "status" ? "pending" : "logged_in" } });
        return;
      }
      const tokens = tokenEnvelope(mode === "state" ? "wrong-state" : "test-state");
      if (mode === "expired") tokens.data.access_token = jwt({ exp: 1 });
      if (mode === "partial") tokens.data.refresh_token = "";
      if (mode === "identity") {
        tokens.data.access_token = jwt({ universal_id: null, sub: null });
        tokens.data.refresh_token = jwt({ universal_id: null, sub: null });
      }
      json(res, mode === "denied" ? { success: false, data: { status: "denied" } } :
        mode === "malformed" ? { unexpected: true } : tokens);
    });
    await assert.rejects(pollLogin(params(origin), new AbortController().signal, 1), /CoStrict:/);
  });
}

test("cancels polling sleep and does not perform another request", async (t) => {
  const controller = new AbortController();
  const { origin, requests } = await serve(t, (_req, res) => {
    json(res, { success: false });
    setTimeout(() => controller.abort(), 10);
  });
  await assert.rejects(pollLogin(params(origin), controller.signal, 10_000), { name: "AbortError" });
  assert.equal(requests.length, 1);
});

test("cancels in-flight authentication requests", async (t) => {
  const controller = new AbortController();
  const { origin } = await serve(t, () => controller.abort());
  await assert.rejects(requestJson(new URL(origin), controller.signal), { name: "AbortError" });
});

test("HTTP errors and invalid JSON do not expose URLs, response bodies or tokens", async (t) => {
  for (const status of [401, 403, 500, 200]) {
    const { origin } = await serve(t, (_req, res) => {
      res.writeHead(status).end("secret-refresh-token");
    });
    await assert.rejects(requestJson(new URL(origin + "/?token=secret-query"), new AbortController().signal),
      (error: Error) => !/secret|127\.0\.0\.1/.test(error.message));
  }
});

test("refresh uses Bearer refresh token, preserves client identity and accepts token/state rotation", async (t) => {
  const { origin, requests } = await serve(t, (_req, res) => json(res, tokenEnvelope("new-state", { rotation: 2 })));
  const old = credential(origin);
  const next = await refresh(old, new AbortController().signal);
  assert.notEqual(next.access, old.access);
  assert.equal(next.costrict.machineCode, old.costrict.machineCode);
  assert.equal(next.costrict.state, "new-state");
  assert.equal(old.costrict.state, "test-state");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers.authorization, `Bearer ${old.refresh}`);
  assert.equal(requests[0].url.searchParams.has("machine_code"), false);
});

test("refresh keeps the previous refresh token when the server omits rotation", async (t) => {
  const { origin } = await serve(t, (_req, res) => json(res, { success: true, data: { access_token: jwt() } }));
  const old = credential(origin);
  assert.equal((await refresh(old, new AbortController().signal)).refresh, old.refresh);
});

test("stored credentials reject missing metadata and header injection", () => {
  const saved = credential("https://example.com");
  assert.throws(() => readCredential({ ...saved, costrict: undefined }), /invalid stored/);
  assert.throws(() => readCredential({ ...saved, userId: "bad\r\nuser" }), /invalid stored/);
});

test("CoStrict headers include authenticated identity and unique request/task IDs", () => {
  const saved = credential("https://example.com");
  const a = costrictHeaders(saved);
  const b = costrictHeaders(saved);
  assert.equal(a.Authorization, `Bearer ${saved.access}`);
  assert.equal(a["zgsm-client-id"], saved.costrict.machineCode);
  assert.equal(a["x-user-id"], saved.userId);
  assert.equal(a["X-Request-ID"], a["zgsm-request-id"]);
  assert.notEqual(a["X-Request-ID"], b["X-Request-ID"]);
  assert.notEqual(a["zgsm-task-id"], b["zgsm-task-id"]);
});

test("redirects are rejected before credentials reach another endpoint", async (t) => {
  let leaked = false;
  const target = await serve(t, (_req, res) => { leaked = true; json(res, {}); });
  const source = await serve(t, (_req, res) => { res.writeHead(307, { Location: target.origin }).end(); });
  await assert.rejects(requestJson(new URL(source.origin), new AbortController().signal, { Authorization: "Bearer test" }));
  assert.equal(leaked, false);
});

test("empty token fields and accepted responses remain pending until tokens arrive", async (t) => {
  let count = 0;
  const { origin } = await serve(t, (req, res) => {
    if (req.url.pathname.endsWith("/status")) json(res, { success: true, data: { status: "logged_in" } });
    else if (++count === 1) res.writeHead(202).end();
    else if (count === 2) json(res, { success: true, data: { access_token: "", refresh_token: "" } });
    else json(res, tokenEnvelope("test-state"));
  });
  assert.equal((await pollLogin(params(origin), new AbortController().signal, 1)).userId, "test-user");
  assert.equal(count, 3);
});

test("uses sub when universal_id is empty", async (t) => {
  const { origin } = await serve(t, (req, res) => {
    if (req.url.pathname.endsWith("/status")) json(res, { success: true, data: { status: "logged_in" } });
    else json(res, tokenEnvelope("test-state", { universal_id: "", sub: "subject-user" }));
  });
  assert.equal((await pollLogin(params(origin), new AbortController().signal)).userId, "subject-user");
});
