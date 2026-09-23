import assert from "node:assert/strict";
import test from "node:test";
import { apiKeyAccount, createApiKeyAuth, createApiKeyStore } from "../../dist/provider/api-key-auth.js";
import { createBuiltInProviderRegistry } from "../../dist/provider/builtins.js";
import { SecretInput } from "../../dist/tui/secret-input.js";

function fixture() {
  let value: string | null = null;
  return { async getPassword() { return value; }, async setPassword(key: string) { value = key; }, async deletePassword() { value = null; return true; } };
}
test("OS API keys persist across instances with independent profile/provider namespaces", async () => {
  const entry = fixture();
  await createApiKeyStore("work", "anthropic", entry).save("synthetic-key");
  assert.equal(await createApiKeyStore("work", "anthropic", entry).load(), "synthetic-key");
  await createApiKeyStore("work", "anthropic", entry).remove();
  assert.equal(await createApiKeyStore("work", "anthropic", entry).load(), undefined);
  assert.equal(apiKeyAccount("work", "anthropic"), ["api-key", "work", "anthropic"].join(":"));
  assert.notEqual(apiKeyAccount("work", "anthropic"), apiKeyAccount("default", "anthropic"));
  assert.notEqual(apiKeyAccount("work", "anthropic"), apiKeyAccount("work", "gemini"));
  assert.throws(() => apiKeyAccount("../escape", "gemini"));
});
test("native failures are sanitized, verification fails closed, invalid keys never reach store", async () => {
  let writes = 0;
  const entry = { async getPassword(): Promise<string | null> { throw new Error("synthetic-secret"); }, async setPassword() { writes++; throw new Error("synthetic-secret"); }, async deletePassword(): Promise<boolean> { throw new Error("synthetic-secret"); } };
  const store = createApiKeyStore("default", "gemini", entry);
  for (const action of [() => store.load(), () => store.save("valid"), () => store.remove()]) {
    await assert.rejects(action, (e: Error) => !e.message.includes("synthetic-secret") && e.cause === undefined);
  }
  await assert.rejects(() => store.save("key\nother"));
  assert.equal(writes, 1);
  await assert.rejects(() => createApiKeyStore("default", "gemini", { ...fixture(), async setPassword() {} }).save("valid"), /verify/);
});
test("cancelled prompts and abort before persistence never mutate store", async () => {
  let writes = 0;
  const auth = createApiKeyAuth("work", () => ({ async save() { writes++; }, async load() { return undefined; }, async remove() {} }));
  const controller = new AbortController();
  assert.equal(await auth.login("gemini", async () => undefined, controller.signal), false);
  assert.equal(await auth.login("gemini", async () => { controller.abort(); return "synthetic"; }, controller.signal), false);
  assert.equal(await auth.login("gemini", async () => { throw new Error("must not run"); }, controller.signal), false);
  assert.equal(writes, 0);
});

test("registry copies configured slot references and creates a fresh facade for each model", () => {
  const received: unknown[] = [];
  const selection = { gemini: "backup" };
  const registry = createBuiltInProviderRegistry({
    apiKeySlots: selection,
    apiKeyAuth: {
      async credentials() { return undefined; },
      forRun(selection) { received.push(selection); return { async credentials() { return undefined; }, reportRateLimit() {} }; },
    },
  });
  selection.gemini = "changed";
  assert.deepEqual(received, []);
  registry.createModel("gemini");
  registry.createModel("gemini");
  assert.deepEqual(received, [{ gemini: "backup" }, { gemini: "backup" }]);
});

test("dedicated secret widget masks output, excludes JSON state, clears on submit/cancel/abort", async () => {
  const widget = new SecretInput();
  const controller = new AbortController();
  let result = widget.request(controller.signal, () => {});
  widget.handle({ type: "insert", text: "synthetic-key" });
  assert.ok(!widget.mask.includes("synthetic-key"));
  assert.equal(JSON.stringify(widget), "{}");
  widget.handle({ type: "enter" });
  assert.equal(await result, "synthetic-key");
  assert.equal(widget.active, false);
  result = widget.request(controller.signal, () => {});
  widget.handle({ type: "insert", text: "another" });
  widget.handle({ type: "cancel" });
  assert.equal(await result, undefined);
  result = widget.request(controller.signal, () => {});
  controller.abort();
  assert.equal(await result, undefined);
  assert.ok(!widget.mask.includes("*"));
});
