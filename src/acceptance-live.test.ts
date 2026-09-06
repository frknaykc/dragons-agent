import assert from "node:assert/strict";
import test from "node:test";
import { exerciseProvider } from "./acceptance-live.js";
import type { ProviderDescriptor } from "./provider/registry.js";

function fixture(streaming = true): ProviderDescriptor {
  let calls = 0;
  return {
    id: "fixture", label: "Deterministic acceptance test", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel() {
      return { async respond(request, delta) {
        calls += 1;
        if (request.task.includes("integers")) {
          assert.equal(request.continuationState, undefined);
          delta?.("1 ");
          if (request.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
          throw new Error("Cancellation not observed");
        }
        if (calls === 2) return { responseId: "tool", text: "", toolCalls: [{ callId: "read", name: "read_file", arguments: '{"path":"fixture.txt"}' }] };
        const text = calls === 1 ? "DRAGONS_READY" : request.toolOutputs[0]?.output ?? "MISSING";
        if (streaming) delta?.(text);
        return { responseId: `response-${calls}`, text, textWasStreamed: streaming, toolCalls: [] };
      } };
    },
  };
}

test("M76 deterministic harness proof traverses runtime READ authorization and real fixture read; not live evidence", async () => {
  const result = await exerciseProvider(fixture(), "fixture");
  assert.equal(result.text, true);
  assert.equal(result.toolCall, true);
  assert.equal(result.continuation, true);
  assert.equal(result.multiTurn, true);
  assert.equal(result.isolation, true);
  assert.equal(result.cancellation, true);
  assert.equal(result.cleanup, true);
  assert.equal(result.failure, "");
  assert.equal("status" in result, false);
});

test("M76 synthesized runtime deltas cannot masquerade as native provider streaming", async () => {
  const result = await exerciseProvider(fixture(false), "fixture");
  assert.equal(result.text, true);
  assert.equal(result.streaming, false);
  assert.equal(result.cleanup, true);
});

test("M76 observed credential leakage blocks evidence and removes fixture without printing secret", async () => {
  const descriptor: ProviderDescriptor = { ...fixture(), createModel: () => ({ async respond() { return { responseId: "x", text: "synthetic-sensitive-value", toolCalls: [] }; } }) };
  await assert.rejects(exerciseProvider(descriptor, "fixture", ["synthetic-sensitive-value"]), /ACCEPTANCE_SECRET_LEAK/);
});
