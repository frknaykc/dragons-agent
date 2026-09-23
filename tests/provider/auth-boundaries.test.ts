import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createApiKeyAuth, createApiKeyStore } from "../../dist/provider/api-key-auth.js";
import { createBuiltInProviderRegistry } from "../../dist/provider/builtins.js";
import { createOpenAIAgentModel, streamOpenAIResponse } from "../../dist/provider/openai.js";
import { createChatGPTAuthService } from "../../dist/provider/codex-auth.js";
import { createNativeCodexCredentialStore, createLoginReplacementCodexCredentialStore, type CodexCredentials, type CodexCredentialStore } from "../../dist/provider/credential-store.js";

const request = { task: "fixture", tools: [], toolOutputs: [] };
const signal = new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function nativeFixture() {
  let value: string | null = null; let reads = 0;
  return { get reads() { return reads; }, get value() { return value; }, set value(v: string | null) { value = v; },
    async getPassword() { reads++; return value; }, async setPassword(v: string) { value = v; }, async deletePassword() { value = null; return true; } };
}
const expired: CodexCredentials = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: "2000-01-01T00:00:00Z", tokenType: "Bearer" };
function memoryStore(initial?: CodexCredentials) {
  let value = initial;
  return { async load() { return value; }, async save(v: CodexCredentials) { value = v; }, async remove() { value = undefined; }, async storageDescription() { return "fixture"; } };
}

test("OpenAI rejects credentialed HTTP/env URLs before transport in model and streaming paths", async () => {
  const previous = process.env.OPENAI_BASE_URL; const key = process.env.OPENAI_API_KEY; const original = globalThis.fetch;
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("transport forbidden"); };
  process.env.OPENAI_API_KEY = "synthetic";
  try {
    for (const endpoint of ["http://example.test/v1", "http://127.0.0.1/v1", "https://user:pass@example.test/v1", "https://example.test/v1?q=private", "not-a-url"]) {
      process.env.OPENAI_BASE_URL = endpoint;
      assert.throws(() => createOpenAIAgentModel(), /HTTPS URL/);
      await assert.rejects(streamOpenAIResponse("fixture").next(), /HTTPS URL/);
      await assert.rejects(createBuiltInProviderRegistry({ apiKeyAuth: { async credentials() { return "stored-synthetic"; } } }).createModel("openai-api").respond(request), /HTTPS URL/);
    }
    assert.equal(calls, 0);
    process.env.OPENAI_BASE_URL = "https://fixture.test/v1";
    globalThis.fetch = async (input, init) => {
      assert.equal(new Request(input, init).url, "https://fixture.test/v1/responses");
      assert.equal(init?.redirect, "error");
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    };
    assert.equal((await createOpenAIAgentModel().respond(request)).responseId, "fixture");
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous;
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
  }
});

test("explicit slots cannot silently downgrade to environment-only or slot-unaware authentication", () => {
  assert.throws(() => createBuiltInProviderRegistry({ apiKeyAuth: false, apiKeySlots: { "openai-api": "work" } }), /slot-aware/);
  assert.throws(() => createBuiltInProviderRegistry({ apiKeyAuth: { async credentials() { return undefined; } }, apiKeySlots: { "openai-api": "work" } }), /slot-aware/);
});

test("explicit configured slot recovers verified OS record with fresh inventory, list performs no reads", async () => {
  const profile = randomUUID(); const entry = nativeFixture();
  const store = () => createApiKeyStore(profile, "openai-api", entry, "work_key-");
  const first = createApiKeyAuth(profile, store);
  await first.add("openai-api", "work_key-", async () => "synthetic", signal);
  // A distinct module instance has the same durable native fixture and empty process inventory.
  const restarted = await import(`${new URL("../../dist/provider/api-key-auth.js", import.meta.url).href}?restart=${randomUUID()}`) as typeof import("../../dist/provider/api-key-auth.js");
  const auth = restarted.createApiKeyAuth(profile, store);
  const reads = entry.reads;
  assert.deepEqual(await auth.list("openai-api"), []);
  assert.equal(entry.reads, reads);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"recovered"}}\n\n', { headers: { "content-type": "text/event-stream" } });
  try {
    const registry = createBuiltInProviderRegistry({ apiKeyAuth: auth, apiKeySlots: { "openai-api": "work_key-" } });
    assert.equal((await registry.createModel("openai-api").respond(request)).responseId, "recovered");
  } finally { globalThis.fetch = original; }
  assert.deepEqual(await auth.list("openai-api"), [{ slot: "work_key-", state: "ready" }]);
  for (const payload of [null, "historical-unverified-raw", JSON.stringify({ version: 1, state: "unverified", key: "synthetic" })]) {
    entry.value = payload;
    const isolated = restarted.createApiKeyAuth(randomUUID(), store);
    await assert.rejects(isolated.credentials("openai-api", "work_key-"), /unavailable/);
  }
});

test("one real registry isolates model credentials, cooldown, removals and cached failures", async () => {
  let now = 0; const entry = nativeFixture(); const profile = randomUUID();
  const auth = createApiKeyAuth(profile, () => createApiKeyStore(profile, "openai-api", entry, "work"), { now: () => now });
  const registry = createBuiltInProviderRegistry({ apiKeyAuth: auth, apiKeySlots: { "openai-api": "work" } });
  const failed = registry.createModel("openai-api");
  await assert.rejects(failed.respond(request), /unavailable/);
  await auth.add("openai-api", "work", async () => "synthetic", signal);
  await assert.rejects(failed.respond(request), /unavailable/);
  let calls = 0; let limited = false; const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++;
    if (limited) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture"}}\n\n', { headers: { "content-type": "text/event-stream" } }); };
  try {
    const pinned = registry.createModel("openai-api");
    await pinned.respond(request);
    limited = true;
    await assert.rejects(pinned.respond(request));
    limited = false;
    const beforeBlocked = calls;
    await assert.rejects(registry.createModel("openai-api").respond(request), /unavailable/);
    assert.equal(calls, beforeBlocked);
    await pinned.respond(request);
    now = 1_000;
    await registry.createModel("openai-api").respond(request);
    await auth.remove("openai-api", "work");
    await assert.rejects(registry.createModel("openai-api").respond(request), /unavailable/);
    assert.equal(calls, beforeBlocked + 2);
  } finally { globalThis.fetch = original; }
});

for (const phase of ["load", "fetch", "save"] as const) test(`logout invalidates refresh paused at ${phase}, no credential resurrection`, async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  const base = memoryStore(expired);
  let saves = 0;
  const store: CodexCredentialStore = { ...base,
    async load() { const value = await base.load(); if (phase === "load") { entered.resolve(); await release.promise; } return value; },
    async save(value) { saves++; if (phase === "save") { entered.resolve(); await release.promise; } await base.save(value); },
  };
  const service = createChatGPTAuthService({ credentialStore: store, fetchImpl: async () => {
    if (phase === "fetch") { entered.resolve(); await release.promise; }
    return Response.json({ access_token: "synthetic-new", refresh_token: "synthetic-new-refresh", expires_in: 3600 });
  } });
  const refresh = service.credentials.getValidCredentials(); const rejection = assert.rejects(refresh, /changed|secure storage/);
  await entered.promise;
  const logout = service.logout();
  release.resolve();
  await Promise.all([logout, rejection]);
  assert.equal(await base.load(), undefined);
  assert.equal(saves, phase === "save" ? 1 : 0);
});

test("credential requests admitted during logout wait for removal instead of refreshing stale credentials", async () => {
  const entered = deferred<void>(); const release = deferred<void>(); const base = memoryStore(expired);
  let requests = 0;
  const service = createChatGPTAuthService({ credentialStore: { ...base, async remove() { entered.resolve(); await release.promise; await base.remove(); } },
    fetchImpl: async () => { requests++; return Response.json({ access_token: "synthetic-new", refresh_token: "synthetic-new-refresh" }); } });
  const logout = service.logout(); await entered.promise;
  const rejected = assert.rejects(service.credentials.getValidCredentials(), /login is required/);
  release.resolve(); await Promise.all([logout, rejected]);
  assert.equal(requests, 0);
  assert.equal(await base.load(), undefined);
});

test("failed named-slot verification and deletion remain unrecoverable without inventory", async () => {
  const entry = nativeFixture(); const profile = randomUUID();
  let reads = 0;
  const broken = { ...entry, async getPassword() { reads++; return reads === 2 ? "wrong-readback" : entry.getPassword(); } };
  await assert.rejects(createApiKeyStore(profile, "gemini", broken, "one").save("synthetic"), /verify/);
  await assert.rejects(createApiKeyStore(profile, "gemini", entry, "one").recover!());
  const store = createApiKeyStore(profile, "gemini", { ...entry, async deletePassword() { return false; } }, "one");
  await store.save("synthetic");
  await assert.rejects(store.remove(), /remove/);
  await assert.rejects(createApiKeyStore(profile, "gemini", entry, "one").recover!());
});

test("actual native replacement probes initial availability; never downgrades a selected usable backend", async () => {
  const legacy = memoryStore(); let writes = 0;
  const unavailable = createNativeCodexCredentialStore({ entry: { async getPassword() { throw new Error("private"); }, async setPassword() { throw new Error("private"); }, async deletePassword() { return false; } } });
  const fallback = createLoginReplacementCodexCredentialStore(unavailable, legacy);
  await fallback.save(expired);
  assert.deepEqual(await legacy.load(), expired);
  assert.match(await fallback.storageDescription(), /fallback/);
  for (const phase of ["write", "verify", "previously-usable"] as const) {
    let reads = 0;
    const native = createNativeCodexCredentialStore({ entry: {
      async getPassword() { reads++; if (reads > 1) throw new Error("private"); return null; },
      async setPassword() { if (phase === "write") throw new Error("private"); }, async deletePassword() { return true; },
    } });
    if (phase === "previously-usable") await native.load();
    const replacement = createLoginReplacementCodexCredentialStore(native, { ...memoryStore(), async save() { writes++; } });
    await assert.rejects(replacement.save(expired), /secure storage/);
  }
  assert.equal(writes, 0);
});
