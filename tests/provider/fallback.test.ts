import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, type AgentModel, type AgentRequest } from "../../dist/agent.js";
import type { AgentTool } from "../../dist/tools.js";
import { ProviderRequestFailureBoundary } from "../../dist/provider/compatibility.js";
import { createProviderRegistry, type ProviderDescriptor } from "../../dist/provider/registry.js";

function failure(status = 503, stream = false): Error {
  const boundary = new ProviderRequestFailureBoundary();
  boundary.httpFailure(status, null);
  if (stream) boundary.streamStarted();
  return boundary.finish(new Error("fixture failure"));
}
const answer = { responseId: "target-response", text: "done", toolCalls: [] };
function setup(respond: AgentModel["respond"], fallback: AgentModel["respond"] = async () => answer) {
  let calls = 0;
  const descriptor = (id: string, fn: AgentModel["respond"]): ProviderDescriptor => ({
    id, label: id, defaultModel: `${id}-exact`, credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: true },
    createModel: () => ({ respond: fn }),
  });
  const registry = createProviderRegistry([descriptor("primary", respond), descriptor("target", async (...args) => { calls++; return fallback(...args); })]);
  const enable = () => registry.configureFallback({ enabled: true, targets: [{ provider: "target", model: "target-exact" }] });
  return { registry, enable, calls: () => calls };
}

test("registry fallback is default-off and requires host identity adoption even when opted in", async () => {
  const error = failure();
  const s = setup(async () => { throw error; });
  await assert.rejects(runAgent({ task: "test", tools: [], model: s.registry.createModel("primary") }), (e) => e === error);
  s.enable();
  await assert.rejects(runAgent({ task: "test", tools: [], model: s.registry.createModel("primary") }), /identity adoption/);
  assert.equal(s.calls(), 0);
});

for (const [name, error, streamDelta] of [
  ["auth", failure(401), undefined], ["permission", failure(403), undefined],
  ["unknown", Object.assign(new Error("unknown"), { status: 503, httpRetryable: true }), undefined],
  ["stream acquired", failure(503, true), undefined], ["empty text emitted", failure(), ""], ["text emitted", failure(), "partial"],
] as const) test(`registry through runAgent denies ${name}`, async () => {
  const s = setup(async (_request, delta) => { if (streamDelta !== undefined) delta?.(streamDelta); throw error; });
  s.enable();
  await assert.rejects(runAgent({ task: "test", tools: [], model: s.registry.createModel("primary", {}, async () => true) }), (e) => e === error);
  assert.equal(s.calls(), 0);
});

for (const state of [{ conversationResponseId: "prior" }, { continuationState: {} }]) {
  test(`registry denies existing continuation ${Object.keys(state)[0]}`, async () => {
    const error = failure();
    const s = setup(async () => { throw error; }); s.enable();
    await assert.rejects(runAgent({ task: "test", tools: [], ...state, model: s.registry.createModel("primary", {}, async () => true) }), (e) => e === error);
    assert.equal(s.calls(), 0);
  });
}

test("fallback pins after first success, preserves only target continuation and never replays tools", async () => {
  let primaryCalls = 0;
  let executions = 0;
  let adopted = false;
  const requests: AgentRequest[] = [];
  const s = setup(async () => { primaryCalls++; throw failure(); }, async (request) => {
    assert.equal(adopted, true);
    requests.push(request);
    if (requests.length === 1) return { ...answer, continuationState: { owner: "target" }, toolCalls: [{ callId: "once", name: "fixture", arguments: "{}" }] };
    throw failure();
  });
  s.enable();
  const tool: AgentTool = { name: "fixture", description: "fixture", operation: "READ", inputSchema: { type: "object", properties: {} },
    async execute() { executions++; return { ok: true, output: "ok" }; } };
  await assert.rejects(runAgent({ task: "test", tools: [tool], model: s.registry.createModel("primary", {}, async (target) => {
    assert.deepEqual(target, { provider: "target", model: "target-exact" }); adopted = true; return true;
  }) }), /fixture failure/);
  assert.equal(primaryCalls, 1); assert.equal(s.calls(), 2); assert.equal(executions, 1);
  assert.equal(requests[0]!.continuationState, undefined);
  assert.deepEqual(requests[1]!.continuationState, { owner: "target" });
  assert.equal(requests[1]!.toolOutputs.length, 1);
});

test("primary tool success forbids a later switch", async () => {
  let calls = 0;
  const s = setup(async () => {
    if (++calls === 1) return { ...answer, toolCalls: [{ callId: "once", name: "missing", arguments: "{}" }] };
    throw failure();
  }); s.enable();
  await assert.rejects(runAgent({ task: "test", tools: [], model: s.registry.createModel("primary", {}, async () => true) }), /fixture failure/);
  assert.equal(s.calls(), 0);
});

test("bounded exact registered fallback targets are validated before use", () => {
  const s = setup(async () => answer);
  for (const target of [{ provider: "unknown", model: "target-exact" }, { provider: "target", model: " target-exact" }, { provider: "target", model: "unregistered" }]) {
    assert.throws(() => s.registry.configureFallback({ enabled: true, targets: [target] }));
  }
  const target = { provider: "target", model: "target-exact" };
  assert.throws(() => s.registry.configureFallback({ enabled: true, targets: [target, target] }));
  assert.throws(() => s.registry.configureFallback({ enabled: true, targets: [] }));
  assert.throws(() => s.registry.configureFallback({ enabled: true, targets: [target, target, target, target] }));
});

test("identity rejection prevents target requests and locks uncertain model reuse", async () => {
  const s = setup(async () => { throw failure(); }); s.enable();
  const model = s.registry.createModel("primary", {}, async () => false);
  await assert.rejects(runAgent({ task: "test", tools: [], model }), /adoption was denied/);
  await assert.rejects(runAgent({ task: "test", tools: [], model }), /cannot be reused/);
  assert.equal(s.calls(), 0);
});

test("cancellation during the first request cannot switch", async () => {
  const controller = new AbortController();
  const s = setup(async () => { controller.abort(); throw failure(); }); s.enable();
  await assert.rejects(runAgent({ task: "test", tools: [], signal: controller.signal,
    model: s.registry.createModel("primary", {}, async () => true) }), /cancelled/);
  assert.equal(s.calls(), 0);
});

test("first respond with tool outputs or a previous response is ineligible", async () => {
  for (const state of [{ previousResponseId: "prior" }, { toolOutputs: [{ callId: "prior", output: "already executed" }] }]) {
    const error = failure();
    const s = setup(async () => { throw error; }); s.enable();
    await assert.rejects(s.registry.createModel("primary", {}, async () => true).respond({ task: "test", tools: [], toolOutputs: [], ...state }), (e) => e === error);
    assert.equal(s.calls(), 0);
  }
});

test("successful fallback returns through the single runAgent loop", async () => {
  const s = setup(async () => { throw failure(429); }); s.enable();
  let starts = 0;
  const result = await runAgent({ task: "test", tools: [], model: s.registry.createModel("primary", {}, async () => true), onEvent: (event) => { if (event.type === "agent_started") starts++; } });
  assert.equal(result.finalText, "done"); assert.equal(starts, 1); assert.equal(s.calls(), 1);
});
