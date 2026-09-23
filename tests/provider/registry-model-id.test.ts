import assert from "node:assert/strict";
import test from "node:test";
import { createProviderRegistry, type ProviderDescriptor } from "../../dist/provider/registry.js";

function descriptor(defaultModel: string): ProviderDescriptor {
  return {
    id: "test-provider", label: "Test provider", defaultModel,
    credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: false, toolResultContinuation: false, usageMetadata: false },
    createModel: () => { throw new Error("Metadata inspection must not create a model."); },
  };
}

test("registry rejects malformed default model IDs rather than silently repairing them", () => {
  for (const id of [" model", "model ", "model\n", "model\tname", "", "__proto__", "x".repeat(257)]) {
    assert.throws(() => createProviderRegistry([descriptor(id)]), /model/i);
  }
});

test("registry preserves exact routed default IDs without model creation", () => {
  const id = "vendor/Model-v1:exact";
  const registry = createProviderRegistry([descriptor(id)]);
  assert.equal(registry.get("test-provider").defaultModel, id);
});
