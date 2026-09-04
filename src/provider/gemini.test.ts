import assert from "node:assert/strict";
import test from "node:test";

import { runAgent } from "../agent.js";
import { createBuiltInProviderRegistry } from "./builtins.js";
import { createGeminiAgentModel } from "./gemini.js";
import type { AgentTool } from "../tools.js";

function sse(chunks: readonly Record<string, unknown>[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function candidate(parts: readonly Record<string, unknown>[], usageMetadata: Record<string, unknown> = {}, finished = true): Record<string, unknown> {
  return {
    candidates: [{ index: 0, ...(finished ? { finishReason: "STOP" } : {}), content: { role: "model", parts } }],
    usageMetadata,
  };
}

test("Gemini is a registered API-key provider with explicit tool and usage capabilities", () => {
  const provider = createBuiltInProviderRegistry().get("gemini");

  assert.equal(provider.label, "Google Gemini");
  assert.equal(provider.credentialRequirement, "api-key");
  assert.deepEqual(provider.capabilities, {
    streaming: true,
    toolCalls: true,
    toolResultContinuation: true,
    usageMetadata: true,
  });
});

test("Gemini streams text and a completed function call through the unchanged authorized agent continuation", async () => {
  const requests: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];
  let executions = 0;
  const model = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    model: "gemini-test",
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      headers.push(new Headers(init?.headers));
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return sse([
          candidate([{ text: "I will inspect it. ", thoughtSignature: "text-thought-signature" }], {}, false),
          candidate([{ functionCall: { id: "call_gemini_1", name: "read_fixture", args: {} } }], { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }),
        ]);
      }
      return sse([
        candidate([{ text: "Completed safely." }], { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 }),
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
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  assert.equal(requests.length, 2);
  assert.match(urls[0] ?? "", /\/v1beta\/models\/gemini-test:streamGenerateContent\?alt=sse$/);
  assert.equal(headers[0]?.get("x-goog-api-key"), "test-gemini-key");
  assert.doesNotMatch(JSON.stringify(requests[0]), /test-gemini-key/);
  assert.deepEqual(requests[0]?.contents, [{ role: "user", parts: [{ text: "Inspect safely." }] }]);
  assert.deepEqual(requests[1]?.contents, [
    { role: "user", parts: [{ text: "Inspect safely." }] },
    { role: "model", parts: [{ text: "I will inspect it. ", thoughtSignature: "text-thought-signature" }, { functionCall: { id: "call_gemini_1", name: "read_fixture", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { id: "call_gemini_1", name: "read_fixture", response: { output: "fixture result" } } }] },
  ]);
});

test("Gemini rejects malformed or duplicate streamed function calls before the agent can execute them", async () => {
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
  const malformed = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => sse([candidate([{ functionCall: { id: "bad", name: "write_fixture", args: [] } }])]),
  });
  const duplicate = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => sse([candidate([
      { functionCall: { id: "duplicate", name: "write_fixture", args: {} } },
      { functionCall: { id: "duplicate", name: "write_fixture", args: {} } },
    ])]),
  });

  await assert.rejects(runAgent({ task: "Do not execute malformed output.", model: malformed, tools: [tool], authorize: () => true }), /malformed|incompatible/i);
  await assert.rejects(runAgent({ task: "Do not execute duplicate output.", model: duplicate, tools: [tool], authorize: () => true }), /malformed|incompatible/i);
  assert.equal(executions, 0);
});

test("Gemini bounds valid-looking streamed output before it can become non-restorable provider state", async () => {
  const model = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => sse([
      candidate([{ text: "x".repeat(48_000) }], {}, false),
      candidate([{ text: "overflow" }]),
    ]),
  });

  await assert.rejects(
    model.respond({ task: "Bound streamed output.", tools: [], toolOutputs: [] }),
    /malformed|incompatible/i,
  );
});

test("Gemini restores a completed function-response conversation in an isolated model instance", async () => {
  const requests: Record<string, unknown>[] = [];
  const state = {
    kind: "gemini-generate-content",
    adapterVersion: 1,
    contents: [
      { role: "user", parts: [{ text: "Old task." }] },
      { role: "model", parts: [{ functionCall: { id: "call_restore", name: "read_fixture", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "call_restore", name: "read_fixture", response: { output: "old result" } } }] },
      { role: "model", parts: [{ text: "Old answer." }] },
    ],
  };
  const model = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([candidate([{ text: "Resumed safely." }])]);
    },
  });

  const response = await model.respond({
    task: "New task.",
    conversationResponseId: "prior-response",
    continuationState: state,
    tools: [],
    toolOutputs: [],
  });

  assert.equal(response.text, "Resumed safely.");
  assert.deepEqual(requests[0]?.contents, [...state.contents, { role: "user", parts: [{ text: "New task." }] }]);
});

test("Gemini retains an uncommitted restored transcript after a failed resumed request", async () => {
  const requests: Record<string, unknown>[] = [];
  let attempt = 0;
  const model = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempt += 1;
      if (attempt === 1) return sse([{ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "partial" }] } }] }]);
      return sse([candidate([{ text: "Resumed safely." }])]);
    },
  });
  const restored = {
    kind: "gemini-generate-content",
    adapterVersion: 1,
    contents: [
      { role: "user", parts: [{ text: "Old task." }] },
      { role: "model", parts: [{ text: "Old answer." }] },
    ],
  };

  await assert.rejects(model.respond({ task: "New task.", continuationState: restored, tools: [], toolOutputs: [] }), /malformed|incompatible/i);
  const retried = await model.respond({ task: "New task.", tools: [], toolOutputs: [] });

  assert.equal(retried.text, "Resumed safely.");
  assert.deepEqual(requests[1]?.contents, [...restored.contents, { role: "user", parts: [{ text: "New task." }] }]);
});

test("Gemini bounds successful continuation state so a fresh model can restore it", async () => {
  let responseNumber = 0;
  const model = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      responseNumber += 1;
      return sse([candidate([{ text: `answer ${responseNumber}` }])]);
    },
  });
  let response = await model.respond({ task: "Task 0", tools: [], toolOutputs: [] });
  for (let index = 1; index <= 128; index += 1) {
    response = await model.respond({ task: `Task ${index}`, conversationResponseId: response.responseId, tools: [], toolOutputs: [] });
  }
  assert.ok(((response.continuationState as { contents: unknown[] }).contents).length <= 256);
  const restored = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => sse([candidate([{ text: "restored" }])]),
  });

  const next = await restored.respond({
    task: "Task after restore",
    conversationResponseId: response.responseId,
    continuationState: response.continuationState,
    tools: [],
    toolOutputs: [],
  });

  assert.equal(next.text, "restored");
});

test("Gemini does not retain failed tool-result continuations for a retry", async () => {
  const requests: Record<string, unknown>[] = [];
  let attempt = 0;
  const model = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempt += 1;
      if (attempt === 1) return sse([candidate([{ functionCall: { id: "call_retry", name: "read_fixture", args: {} } }])]);
      if (attempt === 2) return sse([{ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "partial" }] } }] }]);
      return sse([candidate([{ text: "Retried safely." }])]);
    },
  });
  const first = await model.respond({ task: "Read once.", tools: [], toolOutputs: [] });
  const continuation = { previousResponseId: first.responseId, toolOutputs: [{ callId: "call_retry", output: "result" }] };

  await assert.rejects(model.respond({ task: "Read once.", tools: [], ...continuation }), /malformed|incompatible/i);
  const final = await model.respond({ task: "Read once.", tools: [], ...continuation });

  assert.equal(final.text, "Retried safely.");
  const functionResponseTurns = (requests[2]?.contents as Array<{ parts: Array<Record<string, unknown>> }>)
    .filter((content) => "functionResponse" in (content.parts[0] ?? {}));
  assert.equal(functionResponseTurns.length, 1);
});

test("Gemini rejects empty or stale tool-result continuations before a network request", async () => {
  let requests = 0;
  const noToolModel = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      requests += 1;
      return sse([candidate([{ text: "No tools." }])]);
    },
  });
  const first = await noToolModel.respond({ task: "Answer.", tools: [], toolOutputs: [] });
  await assert.rejects(
    noToolModel.respond({ task: "Answer.", previousResponseId: first.responseId, tools: [], toolOutputs: [] }),
    /incompatible/i,
  );
  assert.equal(requests, 1);

  const pendingToolModel = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      requests += 1;
      return sse([candidate([{ functionCall: { id: "call_stale", name: "read_fixture", args: {} } }])]);
    },
  });
  await pendingToolModel.respond({ task: "Call once.", tools: [], toolOutputs: [] });
  await assert.rejects(
    pendingToolModel.respond({
      task: "Call once.",
      previousResponseId: "gemini-0",
      tools: [],
      toolOutputs: [{ callId: "call_stale", output: "result" }],
    }),
    /incompatible/i,
  );
  assert.equal(requests, 2);
});

test("Gemini retries only a pre-stream transient response and redacts provider error bodies", async () => {
  let attempts = 0;
  let retries = 0;
  const model = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("x-goog-api-key=do-not-expose", { status: 503 });
      return sse([candidate([{ text: "Recovered." }])]);
    },
  });

  const response = await model.respond({ task: "Retry safely.", tools: [], toolOutputs: [], onProviderRetry: () => { retries += 1; } });

  assert.equal(response.text, "Recovered.");
  assert.equal(attempts, 2);
  assert.equal(retries, 1);
});

test("Gemini classifies in-stream errors and forwards cancellation without exposing provider bodies", async () => {
  const diagnostics: string[] = [];
  const errored = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async () => sse([{ error: { code: 429, message: "x-goog-api-key=do-not-expose" } }]),
  });
  await assert.rejects(
    errored.respond({ task: "Handle safely.", tools: [], toolOutputs: [], onProviderDiagnostic: (kind: string) => diagnostics.push(kind) }),
    (error: unknown) => error instanceof Error && /rate limit/i.test(error.message) && !/do-not-expose/i.test(error.message),
  );
  assert.equal(diagnostics[0], "rate_limit");

  let requestSignal: AbortSignal | undefined;
  const cancellable = createGeminiAgentModel({
    apiKey: "test-gemini-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const response = cancellable.respond({ task: "Cancel.", tools: [], toolOutputs: [], signal: controller.signal });

  await Promise.resolve();
  controller.abort();

  await assert.rejects(response, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(requestSignal, controller.signal);
});
