import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequest } from "../agent.js";
import { CODEX_ADAPTER_COMPATIBILITY_VERSION, createCodexAgentModel, DEFAULT_CODEX_MODEL } from "./codex.js";

function sse(events: object[]): Response {
  const encoder = new TextEncoder();
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

const request: AgentRequest = {
  task: "Read package.json",
  tools: [{
    name: "read_file",
    description: "Read one file",
    operation: "READ",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to read." } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async () => ({ ok: true, output: "unused" }),
  }],
  toolOutputs: [],
};

test("Codex transport streams ordered text and surfaces only completed function calls", async () => {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const model = createCodexAgentModel({
    credentials: {
      getValidCredentials: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        accountId: "acct_test",
        tokenType: "Bearer",
      }),
    },
    fetchImpl: async (_input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return sse([
        { type: "response.output_text.delta", delta: "Checking " },
        { type: "response.output_item.added", item: { type: "function_call", call_id: "call_123", name: "read_file", arguments: "{\"path\":", status: "in_progress" } },
        { type: "response.output_text.delta", delta: "now." },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_123", name: "read_file", arguments: "{\"path\":\"package.json\"}", status: "completed" } },
        { type: "response.completed", response: { id: "resp_1" } },
      ]);
    },
  });
  const deltas: string[] = [];

  const response = await model.respond(request, (text) => deltas.push(text));

  assert.equal(DEFAULT_CODEX_MODEL, "gpt-5.6-terra");
  assert.deepEqual(deltas, ["Checking ", "now."]);
  assert.deepEqual(response, {
    responseId: "resp_1",
    text: "Checking now.",
    textWasStreamed: true,
    toolCalls: [{ callId: "call_123", name: "read_file", arguments: "{\"path\":\"package.json\"}" }],
    continuationState: {
      kind: "chatgpt-codex",
      adapterVersion: CODEX_ADAPTER_COMPATIBILITY_VERSION,
      conversation: [
        { role: "user", content: [{ type: "input_text", text: "Read package.json" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking now." }] },
      ],
    },
  });
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer access-token");
  assert.equal(requests[0]?.headers.get("chatgpt-account-id"), "acct_test");
  assert.equal(requests[0]?.headers.get("originator"), "dragons-agent");
  assert.match(requests[0]?.headers.get("user-agent") ?? "", /^DragonsAgent\//);
  assert.equal(requests[0]?.body.model, DEFAULT_CODEX_MODEL);
  assert.equal(requests[0]?.body.store, false);
  assert.equal(requests[0]?.body.parallel_tool_calls, false);
  assert.equal((requests[0]?.body.tools as Array<{ strict: boolean }>)[0]?.strict, false);
});

test("Codex transport ignores terminal function-argument framing and waits for the completed tool item", async () => {
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async () => sse([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "call_456", name: "read_file", arguments: "{", status: "in_progress" } },
      { type: "response.function_call_arguments.done", item_id: "item_456", output_index: 0, arguments: "{\"path\":\"package.json\"}" },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_456", name: "read_file", arguments: "{\"path\":\"package.json\"}", status: "completed" } },
      { type: "response.completed", response: { id: "resp_function_done" } },
    ]),
  });

  const response = await model.respond(request);
  assert.deepEqual(response.toolCalls, [{ callId: "call_456", name: "read_file", arguments: "{\"path\":\"package.json\"}" }]);
});

test("opt-in Codex stream diagnostics retain event shape but not delta or argument values", async () => {
  const diagnostics: unknown[] = [];
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({ accessToken: "access-token", refreshToken: "refresh-token", expiresAt: "2099-01-01T00:00:00.000Z", tokenType: "Bearer" }) },
    onStreamDiagnostic: (entry) => diagnostics.push(entry),
    fetchImpl: async () => sse([
      { type: "response.output_text.delta", delta: "sensitive text" },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "safe-id", name: "read_file", arguments: "{\"path\":\"sensitive-path\"}", status: "completed" } },
      { type: "response.completed", response: { id: "response-id", status: "completed" } },
    ]),
  });
  await model.respond(request);
  assert.deepEqual(diagnostics, [
    { index: 0, type: "response.output_text.delta", hasCallId: false, hasToolName: false, decision: "handled" },
    { index: 1, type: "response.output_item.done", itemType: "function_call", itemStatus: "completed", hasCallId: true, hasToolName: true, decision: "handled" },
    { index: 2, type: "response.completed", responseStatus: "completed", hasCallId: false, hasToolName: false, decision: "handled" },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive text|sensitive-path|safe-id|response-id/);
});

test("completed reasoning output items are ignored before a validated function call and continuation", async () => {
  const diagnostics: Array<{ type: string; decision: string }> = [];
  const streams = [
    sse([
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.in_progress", response: { status: "in_progress" } },
      { type: "response.output_item.added", item: { type: "reasoning" } },
      { type: "response.output_item.done", item: { type: "reasoning" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_reasoning", name: "read_file", arguments: "{\"path\":\"package.json\"}", status: "completed" } },
      { type: "response.completed", response: { id: "resp_reasoning" } },
    ]),
    sse([{ type: "response.output_text.delta", delta: "Done." }, { type: "response.completed", response: { id: "resp_after_reasoning" } }]),
  ];
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({ accessToken: "access-token", refreshToken: "refresh-token", expiresAt: "2099-01-01T00:00:00.000Z", tokenType: "Bearer" }) },
    onStreamDiagnostic: (entry) => diagnostics.push({ type: entry.type, decision: entry.decision }),
    fetchImpl: async () => streams.shift()!,
  });
  const first = await model.respond(request);
  assert.deepEqual(first.toolCalls, [{ callId: "call_reasoning", name: "read_file", arguments: "{\"path\":\"package.json\"}" }]);
  const second = await model.respond({ ...request, previousResponseId: first.responseId, toolOutputs: [{ callId: "call_reasoning", output: "{\"ok\":true}" }] });
  assert.equal(second.text, "Done.");
  assert.deepEqual(diagnostics.slice(2, 4), [
    { type: "response.output_item.added", decision: "waiting" },
    { type: "response.output_item.done", decision: "ignored" },
  ]);
});

test("completed message items close streamed text without duplicating it", async () => {
  const diagnostics: Array<{ type: string; decision: string }> = [];
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({ accessToken: "access-token", refreshToken: "refresh-token", expiresAt: "2099-01-01T00:00:00.000Z", tokenType: "Bearer" }) },
    onStreamDiagnostic: (entry) => diagnostics.push({ type: entry.type, decision: entry.decision }),
    fetchImpl: async () => sse([
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.in_progress", response: { status: "in_progress" } },
      { type: "response.output_item.added", item: { type: "reasoning" } },
      { type: "response.output_item.done", item: { type: "reasoning" } },
      { type: "response.output_item.added", item: { type: "message", status: "in_progress" } },
      { type: "response.content_part.added" },
      { type: "response.output_text.delta", delta: "Only once." },
      { type: "response.output_text.done" },
      { type: "response.content_part.done" },
      { type: "response.output_item.done", item: { type: "message", status: "completed" } },
      { type: "response.completed", response: { id: "resp_message" } },
    ]),
  });
  const deltas: string[] = [];
  const response = await model.respond(request, (delta) => deltas.push(delta));
  assert.equal(response.text, "Only once.");
  assert.deepEqual(deltas, ["Only once."]);
  assert.deepEqual(response.toolCalls, []);
  assert.deepEqual(diagnostics.at(-2), { type: "response.output_item.done", decision: "ignored" });
});

test("Codex transport replays completed function calls with tool outputs into the next turn", async () => {
  const bodies: Record<string, unknown>[] = [];
  const streams = [
    sse([
      { type: "response.output_text.delta", delta: "I will check." },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_123", name: "read_file", arguments: "{\"path\":\"package.json\"}", status: "completed" } },
      { type: "response.completed", response: { id: "resp_1" } },
    ]),
    sse([
      { type: "response.output_text.delta", delta: "Done." },
      { type: "response.completed", response: { id: "resp_2" } },
    ]),
  ];
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const stream = streams.shift();
      assert.ok(stream);
      return stream;
    },
  });

  const first = await model.respond(request);
  const second = await model.respond({
    ...request,
    previousResponseId: first.responseId,
    toolOutputs: [{ callId: "call_123", output: "{\"ok\":true}" }],
  });

  assert.equal(second.text, "Done.");
  assert.deepEqual(bodies[1]?.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Read package.json" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I will check." }],
    },
    { type: "function_call", call_id: "call_123", name: "read_file", arguments: "{\"path\":\"package.json\"}" },
    { type: "function_call_output", call_id: "call_123", output: "{\"ok\":true}" },
  ]);
});

test("Codex provider receives the same project and git context semantics as OpenAI", async () => {
  let body: Record<string, unknown> | undefined;
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([{ type: "response.completed", response: { id: "resp_context" } }]);
    },
  });

  await model.respond({
    ...request,
    task: "Fix the failing auth test.",
    projectContext: {
      instructions: { path: ".hermes.md", content: "Use project fixtures.\n" },
      git: {
        isRepository: true,
        repositoryRoot: "/fixture/repository",
        branch: "main",
        dirty: true,
        changedFiles: ["src/auth.ts", "src/auth.test.ts"],
        changedFileCount: 2,
      },
    },
  });

  assert.match(String(body?.instructions), /Repository-local project instructions \(.hermes\.md\):/);
  assert.match(String(body?.instructions), /Use project fixtures/);
  assert.match(String(body?.instructions), /repository root: \/fixture\/repository/);
  assert.match(String(body?.instructions), /branch: main/);
  assert.match(String(body?.instructions), /working tree: dirty/);
  assert.match(String(body?.instructions), /changed files \(2\): src\/auth\.ts, src\/auth\.test\.ts/);
  assert.deepEqual(body?.input, [{
    role: "user",
    content: [{ type: "input_text", text: "Fix the failing auth test." }],
  }]);
});

test("Codex provider retains completed interactive turns before adding the next user task", async () => {
  const bodies: Record<string, unknown>[] = [];
  const streams = [
    sse([
      { type: "response.output_text.delta", delta: "The auth bug is in auth.ts." },
      { type: "response.completed", response: { id: "resp_1" } },
    ]),
    sse([
      { type: "response.completed", response: { id: "resp_2" } },
    ]),
  ];
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const stream = streams.shift();
      assert.ok(stream);
      return stream;
    },
  });

  await model.respond({ ...request, task: "Find the auth bug." });
  await model.respond({
    ...request,
    task: "Fix it.",
    conversationResponseId: "resp_1",
  });

  assert.deepEqual(bodies[1]?.input, [
    { role: "user", content: [{ type: "input_text", text: "Find the auth bug." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "The auth bug is in auth.ts." }] },
    { role: "user", content: [{ type: "input_text", text: "Fix it." }] },
  ]);
});

test("Codex provider restores serialized conversation state in a new runtime", async () => {
  const first = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async () => sse([
      { type: "response.output_text.delta", delta: "The bug is in auth.ts." },
      { type: "response.completed", response: { id: "resp_1" } },
    ]),
  });
  const firstResponse = await first.respond({ ...request, task: "Find the auth bug." });
  const bodies: Record<string, unknown>[] = [];
  const resumed = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "different-access-token",
      refreshToken: "different-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([{ type: "response.completed", response: { id: "resp_2" } }]);
    },
  });

  await resumed.respond({
    ...request,
    task: "Fix it.",
    conversationResponseId: firstResponse.responseId,
    continuationState: JSON.parse(JSON.stringify(firstResponse.continuationState)) as Record<string, unknown>,
  });

  assert.deepEqual(bodies[0]?.input, [
    { role: "user", content: [{ type: "input_text", text: "Find the auth bug." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "The bug is in auth.ts." }] },
    { role: "user", content: [{ type: "input_text", text: "Fix it." }] },
  ]);
  assert.doesNotMatch(JSON.stringify(firstResponse.continuationState), /access-token|refresh-token/);
});

test("Codex transport stops with a first-party identity blocker instead of impersonating another client", async () => {
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async () => new Response("originator must be codex_cli_rs", { status: 403 }),
  });

  await assert.rejects(model.respond(request), /M9A_BLOCKED_FIRST_PARTY_IDENTITY_REQUIRED/);
});

test("Codex transport aborts an active stream and forwards the run signal", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }) },
    fetchImpl: async (_input, init) => {
      observedSignal = init?.signal;
      return new Response(new ReadableStream({
        start(controller_) {
          streamController = controller_;
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const response = model.respond({ ...request, signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(streamController);
  controller.abort();

  await assert.rejects(response, { name: "AbortError" });
  assert.equal(observedSignal, controller.signal);
});
