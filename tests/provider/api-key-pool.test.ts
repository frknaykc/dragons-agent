import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { apiKeyAccount, createApiKeyAuth, createApiKeyStore, MAX_API_KEY_SLOTS, type ApiKeyProvider } from "../../dist/provider/api-key-auth.js";

function setup() {
  const profile = randomUUID();
  const values = new Map<string, string>();
  let brokenDelete = false;
  let brokenWrite = false;
  const factory = (provider: ApiKeyProvider, slot?: string) => {
    const account = apiKeyAccount(profile, provider, slot);
    return createApiKeyStore(profile, provider, {
      async getPassword() { return values.get(account) ?? null; },
      async setPassword(key) { values.set(account, brokenWrite ? randomUUID() : key); },
      async deletePassword() { if (brokenDelete) return false; return values.delete(account); },
    }, slot);
  };
  return { auth: createApiKeyAuth(profile, factory), other: createApiKeyAuth(profile, factory), values,
    breakDelete(value: boolean) { brokenDelete = value; }, breakWrite() { brokenWrite = true; } };
}
const signal = new AbortController().signal;
test("namespaces preserve singleton and reject malformed slot IDs without collisions", () => {
  assert.equal(apiKeyAccount("default", "gemini"), "api-key:default:gemini");
  const names = new Set<string>();
  for (const profile of ["default", "work"]) for (const provider of ["gemini", "anthropic"] as const)
    for (const slot of [undefined, "default", "work"]) names.add(apiKeyAccount(profile, provider, slot));
  assert.equal(names.size, 12);
  for (const slot of ["", "a:b", "../a", "A", "a ", "a".repeat(33)]) assert.throws(() => apiKeyAccount("default", "gemini", slot));
});
test("trusted metadata, singleton compatibility and run-pinned explicit resolution", async () => {
  const { auth, other } = setup();
  const singleton = randomUUID(); const key = randomUUID();
  await auth.login("gemini", async () => singleton, signal);
  await auth.add("gemini", "one", async () => key, signal);
  assert.deepEqual(await other.list("gemini"), [{ slot: "one", state: "ready" }]);
  assert.ok(!JSON.stringify(await auth.list("gemini")).includes(key));
  const selection = { gemini: "one" };
  const run = auth.forRun(selection); selection.gemini = "missing";
  assert.ok(await run.credentials("gemini") === key);
  await other.remove("gemini", "one");
  assert.ok(await run.credentials("gemini") === key);
  await assert.rejects(auth.forRun({ gemini: "one" }).credentials("gemini"), /unavailable/);
  assert.ok(await auth.credentials("gemini") === singleton);
  await auth.logout("gemini");
  assert.equal(await auth.credentials("gemini"), undefined);
});
test("failed readback and deletion retain blocked recovery metadata", async () => {
  const f = setup();
  await f.auth.add("gemini", "one", async () => randomUUID(), signal);
  f.breakDelete(true);
  await assert.rejects(f.auth.remove("gemini", "one"), /verify/);
  assert.deepEqual(await f.auth.list("gemini"), [{ slot: "one", state: "unverified" }]);
  await assert.rejects(f.auth.credentials("gemini", "one"));
  f.breakDelete(false); await f.auth.remove("gemini", "one");
  assert.deepEqual(await f.auth.list("gemini"), []);
  f.breakWrite();
  await assert.rejects(f.auth.add("gemini", "two", async () => randomUUID(), signal));
  assert.deepEqual(await f.auth.list("gemini"), [{ slot: "two", state: "unverified" }]);
  await assert.rejects(f.auth.credentials("gemini", "two"));
});
test("concurrent instances serialize duplicate adds and enforce slot bounds", async () => {
  const { auth, other } = setup();
  const results = await Promise.allSettled([auth.add("gemini", "same", async () => randomUUID(), signal), other.add("gemini", "same", async () => randomUUID(), signal)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  // Literal product bound: increasing the exported constant must not weaken this test.
  assert.equal(MAX_API_KEY_SLOTS, 8);
  for (let i = 1; i < 8; i++) await auth.add("gemini", `s${i}`, async () => randomUUID(), signal);
  let overflowPrompts = 0;
  await assert.rejects(other.add("gemini", "overflow", async () => { overflowPrompts++; return randomUUID(); }, signal), /limit/);
  assert.equal(overflowPrompts, 0);
  assert.equal((await auth.list("gemini")).length, 8);
});

test("rate-limit cooldown is memory-only, bounded, and preserves a pinned slot", async () => {
  let now = 1_000;
  const values = new Map<string, string>();
  const auth = createApiKeyAuth(randomUUID(), (provider, slot) => {
    const account = `${provider}:${slot}`;
    return { async load() { return values.get(account); }, async save(key) { values.set(account, key); }, async remove() { values.delete(account); } };
  }, { now: () => now });
  const key = randomUUID();
  await auth.add("gemini", "one", async () => key, signal);
  const run = auth.forRun({ gemini: "one" });
  await run.credentials("gemini");
  run.reportRateLimit("gemini", 999_999);
  await assert.rejects(auth.forRun({ gemini: "one" }).credentials("gemini"), /unavailable/);
  assert.equal(await run.credentials("gemini"), key);
  now += 300_000;
  assert.equal(await auth.forRun({ gemini: "one" }).credentials("gemini"), key);
});

test("explicit missing failures remain pinned and cancelled additions leave no inventory", async () => {
  const { auth } = setup();
  const run = auth.forRun({ gemini: "later" });
  await assert.rejects(run.credentials("gemini"));
  await auth.add("gemini", "later", async () => randomUUID(), signal);
  await assert.rejects(run.credentials("gemini"));
  assert.equal(await auth.add("gemini", "cancel", async () => undefined, signal), false);
  assert.equal((await auth.list("gemini")).length, 1);
});
