import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credential, json, serve, sse, catalog } from "./helpers.ts";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createCostrictProvider } from "../src/provider.ts";

test("Pi loads the package without local node_modules, discovers a model and sends a prompt", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, (req, res) => {
    if (req.url.pathname === "/ai-gateway/api/v1/models") json(res, catalog);
    else sse(res, [{ content: "PLUGIN_SMOKE_OK" }]);
  });
  const dir = await mkdtemp(join(tmpdir(), "pi-costrict-smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(resolve("src"), join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", pi: { extensions: ["./src/index.ts"] } }));
  const saved = credential(server.origin);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ costrict: saved }));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("costrict", async () => saved);
  const modelsStore = new InMemoryModelsStore();
  // ModelRuntime registration starts an unawaited refresh; seed the fixture without that race.
  const models = createModels({ credentials, modelsStore });
  models.setProvider(createCostrictProvider());
  const refreshed = await models.refresh({ providers: ["costrict"], allowNetwork: true });
  assert.equal(refreshed.aborted, false);
  assert.equal(refreshed.errors.size, 0);
  const snapshot = await modelsStore.read("costrict");
  assert.ok(snapshot?.models.some((model) => model.id === "kimi-test"), "fixture must persist the discovered model");
  await writeFile(join(dir, "models-store.json"), JSON.stringify({ costrict: snapshot }));
  const cli = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent").replace(/index\.js$/, "cli.js"));
  const run = async (args: string[]) => {
    const child = promisify(execFile)(process.execPath, [
      cli, "--no-extensions", "-e", dir,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session", "--no-tools", ...args,
    ], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, COSTRICT_BASE_URL: "" },
      timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    child.child.stdin?.end();
    return child;
  };
  const listed = await run(["--list-models", "costrict"]);
  assert.match(listed.stdout, /kimi-test/);
  assert.equal(server.requests.length, 1, "listing should restore the account-scoped disk cache");
  const result = await run(["--provider", "costrict", "--model", "kimi-test", "-p", "Say hello"]);
  assert.match(result.stdout, /PLUGIN_SMOKE_OK/);
  assert.doesNotMatch(result.stderr, /Failed to load extension|Cannot find|ERR_MODULE/);
  assert.ok(server.requests.some((req) => req.url.pathname === "/ai-gateway/api/v1/models"));
  assert.ok(server.requests.some((req) => req.url.pathname === "/chat-rag/api/v1/chat/completions"));
});
