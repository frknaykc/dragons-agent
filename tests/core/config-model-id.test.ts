import assert from "node:assert/strict";
import test from "node:test";
import { parseDragonsConfig } from "../../dist/config.js";
import { apiKeyAccount, isApiKeySlot } from "../../dist/provider/api-key-auth.js";

test("config preserves exact model IDs in legacy and per-provider fields", () => {
  const model = "vendor/Model-v1:exact";
  assert.equal(parseDragonsConfig({ model }).model, model);
  assert.deepEqual(parseDragonsConfig({ models: { local: model } }).models, { local: model });
});


test("config rejects malformed model IDs instead of trimming them", () => {
  for (const model of [" model", "model ", "model\n", "model\tname", "", "__proto__", "x".repeat(257)]) {
    assert.throws(() => parseDragonsConfig({ model }), /model/);
    assert.throws(() => parseDragonsConfig({ models: { local: model } }), /model/);
  }
});

test("config accepts only safe API-key slot references and never accepts a key value", () => {
  assert.deepEqual(parseDragonsConfig({ apiKeySlots: { gemini: "primary_1", anthropic: "backup" } }).apiKeySlots, { gemini: "primary_1", anthropic: "backup" });
  for (const slot of ["primary_1", "backup", "1", "0backup", "work-", "work_", "a".repeat(32)]) {
    assert.equal(isApiKeySlot(slot), true);
    assert.doesNotThrow(() => apiKeyAccount("default", "gemini", slot));
    assert.equal(parseDragonsConfig({ apiKeySlots: { gemini: slot } }).apiKeySlots?.gemini, slot);
  }
  for (const slot of ["_first", "-first", "a".repeat(33), "has:colon", "a/b", " a", "a ", "A"]) {
    assert.equal(isApiKeySlot(slot), false);
    assert.throws(() => apiKeyAccount("default", "gemini", slot));
    assert.throws(() => parseDragonsConfig({ apiKeySlots: { gemini: slot } }));
  }
  for (const apiKeySlots of [{ local: "primary" }, { chatgpt: "primary" }, { gemini: "UPPER" }, { gemini: "secret value" }]) {
    assert.throws(() => parseDragonsConfig({ apiKeySlots }), /apiKeySlots/);
  }
});
