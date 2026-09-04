import assert from "node:assert/strict";
import test from "node:test";

import { runAgent } from "../agent.js";
import { createAnthropicAgentModel } from "./anthropic.js";
import { createBuiltInProviderRegistry } from "./builtins.js";
import type { AgentTool } from "../tools.js";

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("Anthropic is a registered API-key provider with explicit tool and usage capabilities", () => {
  const provider = createBuiltInProviderRegistry().get("anthropic");

  assert.equal(provider.label, "Anthropic");
  assert.equal(provider.defaultModel, "claude-sonnet-5");
  assert.equal(provider.credentialRequirement, "api-key");
  assert.deepEqual(provider.capabilities, {
    streaming: true,
    toolCalls: true,
    toolResultContinuation: true,
    usageMetadata: true,
  });
});

test("Anthropic streams a completed tool use through the unchanged authorized agent continuation", async () => {
  const requests: Record<string, unknown>[] = [];
  let executions = 0;
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    model: "claude-test",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return sse([
          { type: "message_start", message: { id: "msg_tool", usage: { input_tokens: 7 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_fixture", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ]);
      }
      return sse([
        { type: "message_start", message: { id: "msg_final", usage: { input_tokens: 12 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Completed safely." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
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
  assert.deepEqual(deltas, ["Completed safely."]);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "Inspect safely." }]);
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", content: "Inspect safely." },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_fixture", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "fixture result" }] },
  ]);
});

test("Anthropic rejects a tool block received before message_start without executing it", async () => {
  let executions = 0;
  const model = createAnthropicAgentModel({
    apiKey: "test-...ey",
    fetchImpl: async () => sse([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_before_start", name: "read_fixture", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_start", message: { id: "msg_late", usage: {} } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
      { type: "message_stop" },
    ]),
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

  await assert.rejects(runAgent({ task: "Inspect safely.", model, tools: [tool], maxTurns: 1 }), /incompatible|malformed/i);
  assert.equal(executions, 0);
});

test("Anthropic restores a completed tool-result conversation in an isolated model instance", async () => {
  const toolResponse = [
    { type: "message_start", message: { id: "msg_tool", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_resume", name: "read_fixture", input: {} } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const finalResponse = [
    { type: "message_start", message: { id: "msg_final", usage: { input_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First complete." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  let firstRequests = 0;
  const first = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => sse(firstRequests++ === 0 ? toolResponse : finalResponse),
  });
  const toolTurn = await first.respond({ task: "First task.", tools: [], toolOutputs: [] });
  const completed = await first.respond({
    task: "First task.",
    tools: [],
    previousResponseId: toolTurn.responseId,
    toolOutputs: [{ callId: "toolu_resume", output: "fixture result" }],
  });
  const resumedRequests: Record<string, unknown>[] = [];
  const resumed = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      resumedRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse(finalResponse);
    },
  });

  const next = await resumed.respond({
    task: "Next task.",
    tools: [],
    conversationResponseId: completed.responseId,
    continuationState: completed.continuationState,
    toolOutputs: [],
  });

  assert.equal(next.text, "First complete.");
  assert.deepEqual(resumedRequests[0]?.messages, [
    { role: "user", content: "First task." },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_resume", name: "read_fixture", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_resume", content: "fixture result" }] },
    { role: "assistant", content: [{ type: "text", text: "First complete." }] },
    { role: "user", content: "Next task." },
  ]);
});

test("Anthropic retains an uncommitted restored transcript after a failed resumed request", async () => {
  const requests: Record<string, unknown>[] = [];
  let attempt = 0;
  const model = createAnthropicAgentModel({
    apiKey: "test-...ey",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempt += 1;
      if (attempt === 1) return sse([{ type: "message_start", message: { id: "msg_failed_resume", usage: {} } }]);
      return sse([
        { type: "message_start", message: { id: "msg_retried_resume", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "resumed" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    },
  });
  const restored = {
    kind: "anthropic-messages",
    adapterVersion: 1,
    messages: [
      { role: "user", content: "Old task." },
      { role: "assistant", content: [{ type: "text", text: "Old answer." }] },
    ],
  };

  await assert.rejects(model.respond({ task: "New task.", tools: [], continuationState: restored, toolOutputs: [] }), /malformed response/i);
  const retried = await model.respond({ task: "New task.", tools: [], toolOutputs: [] });

  assert.equal(retried.text, "resumed");
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", content: "Old task." },
    { role: "assistant", content: [{ type: "text", text: "Old answer." }] },
    { role: "user", content: "New task." },
  ]);
});

test("Anthropic bounds successful continuation state so a fresh model can restore it", async () => {
  let responseNumber = 0;
  const model = createAnthropicAgentModel({
    apiKey: "test-...ey",
    fetchImpl: async () => {
      responseNumber += 1;
      return sse([
        { type: "message_start", message: { id: `msg_${responseNumber}`, usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `answer ${responseNumber}` } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    },
  });
  let response = await model.respond({ task: "Task 0", tools: [], toolOutputs: [] });
  for (let index = 1; index <= 128; index += 1) {
    response = await model.respond({
      task: `Task ${index}`,
      tools: [],
      conversationResponseId: response.responseId,
      toolOutputs: [],
    });
  }
  assert.ok(((response.continuationState as { messages: unknown[] }).messages).length <= 256);
  const restoredRequests: Record<string, unknown>[] = [];
  const restored = createAnthropicAgentModel({
    apiKey: "test-...ey",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      restoredRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([
        { type: "message_start", message: { id: "msg_restored", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "restored" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    },
  });

  const next = await restored.respond({
    task: "Task after restore",
    tools: [],
    conversationResponseId: response.responseId,
    continuationState: response.continuationState,
    toolOutputs: [],
  });

  assert.equal(next.text, "restored");
  assert.ok((restoredRequests[0]?.messages as unknown[]).length <= 257);
});

test("Anthropic does not retain failed tool-result continuation messages for a retry", async () => {
  const requests: Record<string, unknown>[] = [];
  let attempt = 0;
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempt += 1;
      if (attempt === 1) {
        return sse([
          { type: "message_start", message: { id: "msg_tool", usage: { input_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_retry", name: "read_file", input: {} } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]);
      }
      if (attempt === 2) return sse([{ type: "message_start", message: { id: "msg_failed", usage: {} } }]);
      return sse([
        { type: "message_start", message: { id: "msg_final", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "retried" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    },
  });
  const first = await model.respond({ task: "Read once.", tools: [], toolOutputs: [] });
  const continuation = { previousResponseId: first.responseId, toolOutputs: [{ callId: "toolu_retry", output: "result" }] };

  await assert.rejects(model.respond({ task: "Read once.", tools: [], ...continuation }), /malformed response/i);
  const final = await model.respond({ task: "Read once.", tools: [], ...continuation });

  assert.equal(final.text, "retried");
  const messages = requests[2]?.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.filter((message) => Array.isArray(message.content)).length, 2);
  assert.deepEqual(messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_retry", content: "result" }],
  });
});

test("Anthropic rejects an invalid restored tool-result direction before making a request", async () => {
  let requested = false;
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => {
      requested = true;
      return sse([]);
    },
  });

  await assert.rejects(
    model.respond({
      task: "Next task.",
      tools: [],
      conversationResponseId: "msg_prior",
      continuationState: {
        kind: "anthropic-messages",
        adapterVersion: 1,
        messages: [{ role: "assistant", content: [{ type: "tool_result", tool_use_id: "toolu_invalid", content: "invalid" }] }],
      },
      toolOutputs: [],
    }),
    /incompatible/i,
  );
  assert.equal(requested, false);
});

test("Anthropic rejects an orphaned restored tool result before making a request", async () => {
  let requested = false;
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => {
      requested = true;
      return sse([
        { type: "message_start", message: { id: "msg_after_orphan", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "unsafe resume" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    },
  });

  await assert.rejects(
    model.respond({
      task: "Resume safely.",
      conversationResponseId: "msg_saved",
      continuationState: {
        kind: "anthropic-messages",
        adapterVersion: 1,
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_orphan", content: "unsafe" }] }],
      },
      tools: [],
      toolOutputs: [],
    }),
    (error: unknown) => error instanceof Error && /incompatible/i.test(error.message),
  );
  assert.equal(requested, false);
});

test("Anthropic rejects malformed streamed tool input before the agent can execute it", async () => {
  let executions = 0;
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => sse([
      { type: "message_start", message: { id: "msg_bad", usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_bad", name: "write_fixture", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "not-json" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
      { type: "message_stop" },
    ]),
  });
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

  await assert.rejects(runAgent({ task: "Unsafe fixture.", model, tools: [tool], authorize: () => true }), /malformed/i);
  assert.equal(executions, 0);
});

test("Anthropic rejects duplicate streamed tool identifiers before continuation", async () => {
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => sse([
      { type: "message_start", message: { id: "msg_duplicate", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_duplicate", name: "read_file", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_duplicate", name: "read_file", input: {} } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]),
  });

  await assert.rejects(
    model.respond({ task: "Inspect safely.", tools: [], toolOutputs: [] }),
    (error: unknown) => error instanceof Error && /incompatible/i.test(error.message),
  );
});

test("Anthropic rejects events received after message_stop before returning tool calls", async () => {
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => sse([
      { type: "message_start", message: { id: "msg_terminal", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_terminal", name: "read_file", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    ]),
  });

  await assert.rejects(
    model.respond({ task: "Do not execute malformed stream.", tools: [], toolOutputs: [] }),
    (error: unknown) => error instanceof Error && /incompatible/i.test(error.message),
  );
});

test("Anthropic retries only the pre-stream rate-limited request and redacts provider error bodies", async () => {
  let attempts = 0;
  let retries = 0;
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("x-api-key=do-not-expose", { status: 429 });
      return sse([
        { type: "message_start", message: { id: "msg_retry", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Recovered." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    },
  });

  const response = await model.respond({ task: "Retry safely.", tools: [], toolOutputs: [], onProviderRetry: () => { retries += 1; } });

  assert.equal(response.text, "Recovered.");
  assert.equal(attempts, 2);
  assert.equal(retries, 1);
});

test("Anthropic classifies an in-stream overloaded error without exposing its body", async () => {
  const diagnostics: string[] = [];
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async () => sse([
      { type: "message_start", message: { id: "msg_error", usage: {} } },
      { type: "error", error: { type: "overloaded_error", message: "x-api-key=do-not-expose" } },
    ]),
  });

  await assert.rejects(
    model.respond({ task: "Handle safely.", tools: [], toolOutputs: [], onProviderDiagnostic: (kind: string) => diagnostics.push(kind) }),
    (error: unknown) => error instanceof Error && /temporarily unavailable/i.test(error.message) && !/do-not-expose/i.test(error.message),
  );
  assert.equal(diagnostics[0], "transient");
});

test("Anthropic forwards cancellation to an active request", async () => {
  let requestSignal: AbortSignal | undefined;
  const model = createAnthropicAgentModel({
    apiKey: "test-only-anthropic-key",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const response = model.respond({ task: "Cancel.", tools: [], toolOutputs: [], signal: controller.signal });

  await Promise.resolve();
  controller.abort();

  await assert.rejects(response, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(requestSignal, controller.signal);
});
