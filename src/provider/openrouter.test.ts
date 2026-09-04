import assert from "node:assert/strict";
import test from "node:test";

import { runAgent } from "../agent.js";
import { createBuiltInProviderRegistry } from "./builtins.js";
import { createOpenRouterAgentModel } from "./openrouter.js";
import type { AgentTool } from "../tools.js";

function sse(chunks: readonly Record<string, unknown>[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(
  id: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

test("OpenRouter is registered as an API-key provider with model-dependent tool calling", () => {
  const provider = createBuiltInProviderRegistry().get("openrouter");

  assert.equal(provider.label, "OpenRouter");
  assert.equal(provider.credentialRequirement, "api-key");
  assert.deepEqual(provider.capabilities, {
    streaming: true,
    toolCalls: true,
    toolResultContinuation: true,
    usageMetadata: true,
  });
});

test("OpenRouter streams fragmented tool calls through the unchanged authorization gate and continuation", async () => {
  const requests: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];
  let executions = 0;
  const model = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    model: "openai/gpt-4.1-mini",
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      headers.push(new Headers(init?.headers));
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return sse([
          chunk("or-first", { role: "assistant", content: "I will inspect it. " }),
          chunk("or-first", {
            tool_calls: [{ index: 0, id: "call_or_1", type: "function", function: { name: "read_fixture", arguments: "{" } }],
          }),
          chunk("or-first", {
            tool_calls: [{ index: 0, function: { arguments: "}" } }],
          }, "tool_calls", { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }),
        ]);
      }
      return sse([
        chunk("or-second", { role: "assistant", content: "Completed safely." }, "stop", { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 }),
      ]);
    },
  });
  const tool: AgentTool = {
    name: "read_fixture",
    operation: "READ",
    description: "Read deterministic fixture data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      executions += 1;
      return { ok: true, output: "fixture result" };
    },
  };
  const deltas: string[] = [];

  const result = await runAgent({ task: "Inspect safely.", model, tools: [tool], onEvent: (event) => {
    if (event.type === "message_delta") deltas.push(event.text);
  } });

  assert.equal(result.finalText, "Completed safely.");
  assert.equal(executions, 1);
  assert.deepEqual(deltas, ["I will inspect it. ", "Completed safely."]);
  assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  assert.equal(requests.length, 2);
  assert.match(urls[0] ?? "", /\/api\/v1\/chat\/completions$/);
  assert.equal(headers[0]?.get("authorization"), "Bearer test-openrouter-key");
  assert.doesNotMatch(JSON.stringify(requests[0]), /test-openrouter-key/);
  assert.equal(requests[0]?.stream, true);
  assert.deepEqual(requests[0]?.stream_options, { include_usage: true });
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", content: "Inspect safely." },
    { role: "assistant", content: "I will inspect it. ", tool_calls: [{ id: "call_or_1", type: "function", function: { name: "read_fixture", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_or_1", content: "fixture result" },
  ]);
});

test("OpenRouter rejects malformed or incomplete streamed tool calls before any WRITE execution", async () => {
  let executions = 0;
  const tool: AgentTool = {
    name: "write_fixture",
    operation: "WRITE",
    description: "Fixture write.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      executions += 1;
      return { ok: true, output: "unexpected" };
    },
  };
  const malformed = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async () => sse([
      chunk("or-bad", { tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "write_fixture", arguments: "[]" } }] }, "tool_calls"),
    ]),
  });
  const truncated = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async () => new Response(`data: ${JSON.stringify(chunk("or-truncated", { tool_calls: [{ index: 0, id: "call_partial", type: "function", function: { name: "write_fixture", arguments: "{" } }] }))}\n\n`, { status: 200 }),
  });
  const afterDone = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async () => new Response(`data: [DONE]\n\ndata: ${JSON.stringify(chunk("or-after-done", { tool_calls: [{ index: 0, id: "call_after_done", type: "function", function: { name: "write_fixture", arguments: "{}" } }] }, "tool_calls"))}\n\n`, { status: 200 }),
  });

  await assert.rejects(runAgent({ task: "Do not execute malformed output.", model: malformed, tools: [tool], authorize: () => true }), /malformed|incompatible/i);
  await assert.rejects(runAgent({ task: "Do not execute incomplete output.", model: truncated, tools: [tool], authorize: () => true }), /malformed|incompatible/i);
  await assert.rejects(runAgent({ task: "Do not execute post-terminal output.", model: afterDone, tools: [tool], authorize: () => true }), /malformed|incompatible/i);
  assert.equal(executions, 0);
});

test("OpenRouter explicitly reports a model that rejects tools without exposing provider error content", async () => {
  const diagnostics: string[] = [];
  const model = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async () => new Response('{"error":{"message":"selected model does not support tool calling; api_key=test-openrouter-key"}}', { status: 400 }),
  });

  await assert.rejects(
    model.respond({ task: "Use tool.", tools: [{ name: "read_fixture", operation: "READ", description: "Read fixture.", inputSchema: { type: "object" }, async execute() { return { ok: true, output: "unused" }; } }], toolOutputs: [], onProviderDiagnostic: (kind: string) => diagnostics.push(kind) }),
    (error: unknown) => error instanceof Error && /does not support tool calls/i.test(error.message) && !/test-openrouter-key/i.test(error.message),
  );
  assert.deepEqual(diagnostics, ["tool_unsupported"]);
});

test("OpenRouter preserves a restored transcript after a failed request and restores it in an isolated model", async () => {
  const requests: Record<string, unknown>[] = [];
  let attempt = 0;
  const restored = {
    kind: "openrouter-chat-completions",
    adapterVersion: 1,
    messages: [
      { role: "user", content: "Old task." },
      { role: "assistant", content: "Old answer." },
    ],
  };
  const model = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempt += 1;
      if (attempt === 1) return new Response(`data: ${JSON.stringify(chunk("or-partial", { content: "partial" }))}\n\n`, { status: 200 });
      return sse([chunk("or-restored", { content: "Resumed safely." }, "stop")]);
    },
  });

  await assert.rejects(model.respond({ task: "New task.", continuationState: restored, tools: [], toolOutputs: [] }), /malformed|incompatible/i);
  const retried = await model.respond({ task: "New task.", tools: [], toolOutputs: [] });

  assert.equal(retried.text, "Resumed safely.");
  assert.deepEqual(requests[1]?.messages, [...restored.messages, { role: "user", content: "New task." }]);
});

test("OpenRouter retries only pre-stream transients, keeps continuation state bounded, and forwards cancellation", async () => {
  let attempts = 0;
  let retries = 0;
  const model = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("authorization=do-not-expose", { status: 503 });
      return sse([chunk("or-recovered", { content: "Recovered." }, "stop")]);
    },
  });
  const response = await model.respond({ task: "Retry safely.", tools: [], toolOutputs: [], onProviderRetry: () => { retries += 1; } });
  assert.equal(response.text, "Recovered.");
  assert.equal(attempts, 2);
  assert.equal(retries, 1);

  let signal: AbortSignal | undefined;
  const cancellable = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = cancellable.respond({ task: "Cancel.", tools: [], toolOutputs: [], signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(signal, controller.signal);
});

test("OpenRouter aborts an oversized provider stream frame before it can retain unbounded data", async () => {
  let cancelled = false;
  const oversizedFrame = `data: ${JSON.stringify(chunk("or-oversized", { content: "x".repeat(200_000) }, "stop"))}\n\n`;
  const model = createOpenRouterAgentModel({
    apiKey: "test-openrouter-key",
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversizedFrame));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 }),
  });

  await assert.rejects(model.respond({ task: "Reject oversized stream data.", tools: [], toolOutputs: [] }), /malformed|incompatible/i);
  assert.equal(cancelled, true);
});
