import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModel } from "../../dist/agent.js";
import { ProviderRequestFailureBoundary, getProviderRequestFailure, providerCompatibilityError } from "../../dist/provider/compatibility.js";
import { createAnthropicAgentModel } from "../../dist/provider/anthropic.js";
import { createGeminiAgentModel } from "../../dist/provider/gemini.js";
import { createOpenRouterAgentModel } from "../../dist/provider/openrouter.js";
import { createLocalAgentModel } from "../../dist/provider/local.js";
import { createCodexAgentModel } from "../../dist/provider/codex.js";
import { createOpenAIAgentModel } from "../../dist/provider/openai.js";

const factories: Record<string, (fetchImpl: typeof fetch) => AgentModel> = {
  anthropic: (fetchImpl) => createAnthropicAgentModel({ fetchImpl, apiKey: "synthetic" }),
  gemini: (fetchImpl) => createGeminiAgentModel({ fetchImpl, apiKey: "synthetic" }),
  openrouter: (fetchImpl) => createOpenRouterAgentModel({ fetchImpl, apiKey: "synthetic" }),
  local: (fetchImpl) => createLocalAgentModel({ fetchImpl }),
  chatgpt: (fetchImpl) => createCodexAgentModel({ fetchImpl, credentials: { getValidCredentials: async () => ({ accessToken: "synthetic", refreshToken: "synthetic", expiresAt: "2099-01-01T00:00:00Z", tokenType: "Bearer" }) } }),
  openai: (fetchImpl) => { globalThis.fetch = fetchImpl; return createOpenAIAgentModel(undefined, undefined, "synthetic"); },
};
const request = { task: "synthetic", tools: [], toolOutputs: [] };
for (const [provider, factory] of Object.entries(factories)) {
  test(`${provider}: tool-only acquired streams cannot grant HTTP replay evidence`, async () => {
    const original = globalThis.fetch;
    let fetches = 0;
    let deltas = 0;
    const event = provider === "anthropic"
      ? { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "read_fixture", input: {} } }
      : provider === "gemini"
        ? { candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: "read_fixture", args: {} } }] } }] }
        : provider === "openrouter" || provider === "local"
          ? { id: "id", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read_fixture", arguments: "{}" } }] }, finish_reason: null }] }
          : { type: "response.output_item.done", item: { type: "function_call", status: "completed", call_id: "call", name: "read_fixture", arguments: "{}" } };
    try {
      const model = factory(async () => {
        fetches += 1;
        let first = true;
        return new Response(new ReadableStream({ pull(controller) {
          if (first) { first = false; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); }
          else controller.error(providerCompatibilityError(provider, "transient", 503));
        } }), { headers: { "content-type": "text/event-stream" } });
      });
      await assert.rejects(model.respond(request, () => { deltas += 1; }), (error: unknown) => {
        assert.deepEqual(getProviderRequestFailure(error), { phase: "stream-started", source: "unknown", httpRetryable: false });
        return true;
      });
      assert.equal(fetches, 1);
      assert.equal(deltas, 0);
    } finally { globalThis.fetch = original; }
  });
  test(`${provider}: acquired empty/broken stream is never pre-stream`, async () => {
    const original = globalThis.fetch;
    try {
      for (const body of ["", "data: not-json\n\n"]) {
        const model = factory(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
        await assert.rejects(model.respond(request), (error: unknown) => {
          assert.equal(getProviderRequestFailure(error)?.phase, "stream-started");
          assert.equal(getProviderRequestFailure(error)?.httpRetryable, false);
          return true;
        });
      }
    } finally { globalThis.fetch = original; }
  });
  test(`${provider}: HTTP failure evidence is bounded and body-free`, async () => {
    const original = globalThis.fetch;
    try {
      for (const status of [401, 403, 404, 429, 503]) {
        const model = factory(async () => new Response("synthetic-private-body", { status, headers: { "retry-after": "2", "x-private": "synthetic-private-header" } }));
        await assert.rejects(model.respond(request), (error: unknown) => {
          assert.deepEqual(getProviderRequestFailure(error), { phase: "pre-stream", source: "http", status, retryAfterMilliseconds: 2000, httpRetryable: status === 429 || status === 503 });
          assert.equal(JSON.stringify(getProviderRequestFailure(error)).includes("private"), false);
          return true;
        });
      }
    } finally { globalThis.fetch = original; }
  });
  test(`${provider}: arbitrary transport errors do not prove HTTP retryability`, async () => {
    const original = globalThis.fetch;
    try {
      const model = factory(async () => { throw new TypeError("network timeout temporarily unavailable"); });
      await assert.rejects(model.respond(request), (error: unknown) => {
        assert.deepEqual(getProviderRequestFailure(error), { phase: "pre-stream", source: "unknown", httpRetryable: false });
        return true;
      });
    } finally { globalThis.fetch = original; }
  });
}


test("failure evidence is explicit, immutable, bounded, and preserves thrown objects", () => {
  assert.equal(getProviderRequestFailure(Object.assign(new TypeError("network timeout"), { status: 503 })), undefined);
  assert.equal(getProviderRequestFailure(providerCompatibilityError("openai", "transient", 503)), undefined);
  for (const retryAfter of ["86401", "999999999999999999999", "-1", "1.2", "Wed, 21 Oct 2015 07:28:00 GMT", "private"]) {
    const boundary = new ProviderRequestFailureBoundary();
    boundary.httpFailure(503, retryAfter);
    const error = Object.freeze(new Error("unchanged"));
    assert.equal(boundary.finish(error), error);
    assert.equal(getProviderRequestFailure(error)?.retryAfterMilliseconds, undefined);
    assert.ok(Object.isFrozen(getProviderRequestFailure(error)));
  }
  const boundary = new ProviderRequestFailureBoundary();
  boundary.httpFailure(503, "2");
  boundary.beginAttempt();
  const error = boundary.finish(new Error("unknown final attempt"));
  assert.deepEqual(getProviderRequestFailure(error), { phase: "pre-stream", source: "unknown", httpRetryable: false });
  boundary.httpFailure(503, "2");
  assert.equal(getProviderRequestFailure(boundary.finish(new DOMException("Aborted", "AbortError")))?.httpRetryable, false);
  boundary.streamStarted();
  boundary.httpFailure(503, "2");
  const streamed = boundary.finish(new Error("stream failure"));
  assert.equal(getProviderRequestFailure(streamed)?.phase, "stream-started");
  assert.equal(getProviderRequestFailure(new ProviderRequestFailureBoundary().finish(streamed))?.phase, "stream-started");
});
