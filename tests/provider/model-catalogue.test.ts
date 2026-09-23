import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltInProviderRegistry } from "../../dist/provider/builtins.js";
import { createProviderRegistry, type ProviderDescriptor } from "../../dist/provider/registry.js";
import { BUILTIN_MODEL_CATALOGUES, validateModelCatalogue, modelCatalogueChoices } from "../../dist/provider/model-catalogue.js";
import { slashChoices } from "../../dist/slash-choices.js";

test("real builtins expose scoped catalogues without reading credentials", () => {
  const registry = createBuiltInProviderRegistry({ apiKeyAuth: { credentials: async () => { throw new Error("credentials read"); } }, chatgptAuth: { credentials: { getValidCredentials: async () => { throw new Error("credentials read"); } } } });
  for (const [id, catalogue] of Object.entries(BUILTIN_MODEL_CATALOGUES)) {
    const provider = registry.get(id);
    const choices = slashChoices("/model ", ["/model"], registry.list(), id);
    assert.ok(choices.length > 1, id);
    assert.deepEqual(choices.map((c) => c.value), [...new Set([provider.defaultModel, ...catalogue])].map((m) => `/model ${m}`));
    assert.ok(choices.every((c) => c.description.includes("access not verified")));
  }
  assert.equal(slashChoices("/model ", ["/model"], registry.list(), "local").length, 1);
  assert.deepEqual(slashChoices("/model custom-private-id", ["/model"], registry.list(), "chatgpt"), []);
  assert.deepEqual(slashChoices("/reasoning ", ["/reasoning"], registry.list(), "chatgpt", "gpt-5.3-codex"), []);
  assert.ok(slashChoices("/reasoning ", ["/reasoning"], registry.list(), "chatgpt", "gpt-5.4").some((c) => c.value === "/reasoning xhigh"));
});

test("catalogue validation bounds exact IDs and registration copies immutable metadata", () => {
  for (const value of [new Array(1), ["a", "a"], ["a\n"], [" a"], ["a b"], ["x".repeat(257)], ["__proto__"], Array.from({ length: 129 }, (_, i) => `m${i}`), { token: "fake" }]) {
    assert.throws(() => validateModelCatalogue(value), /catalogue/);
  }
  const ids = ["org/model:tag", "model-2"];
  const descriptor = { id: "fixture", label: "Fixture", defaultModel: ids[0]!, credentialRequirement: "none", capabilities: { streaming: false, toolCalls: false, toolResultContinuation: false, usageMetadata: false }, modelCatalogue: ids, createModel: () => ({ respond: async () => ({ content: "" }) }) } as unknown as ProviderDescriptor;
  const registry = createProviderRegistry([descriptor]);
  ids.push("later");
  assert.equal(slashChoices("/model ", ["/model"], registry.list(), "fixture").length, 2);
  assert.ok(Object.isFrozen(Reflect.get(registry.get("fixture"), "modelCatalogue")));
  assert.throws(() => createProviderRegistry([{ ...descriptor, modelCatalogue: ["bad\n"] } as ProviderDescriptor]), /catalogue/);
});

test("transported catalogue metadata is bounded, deduplicated and never repaired", () => {
  const provider = { id: "fixture", label: "Fixture", defaultModel: "default", credentialRequirement: "none" as const, modelCatalogue: ["bad\u001b[31m", "bad\n", "default", ...Array.from({ length: 200 }, (_, i) => `model-${i}`)] };
  const choices = slashChoices("/model ", ["/model"], [provider], "fixture", "configured");
  assert.equal(choices.length, 32);
  assert.equal(choices[0]!.value, "/model configured");
  assert.equal(choices[1]!.value, "/model default");
  assert.ok(choices.every((c) => !/[\x00-\x1f\x7f]/.test(c.value + c.description)));
  assert.deepEqual(slashChoices("/model model-199", ["/model"], [provider], "fixture"), []);
  assert.deepEqual(slashChoices("/model configured ", ["/model"], [provider], "fixture", "configured"), []);
  assert.deepEqual(modelCatalogueChoices({ defaultModel: "local-default" }, "local-configured").map((c) => c.value), ["local-configured", "local-default"]);
});
