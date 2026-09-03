import assert from "node:assert/strict";
import test from "node:test";

import { runAgent, type AgentRequest } from "./agent.js";
import { RuntimeDiagnosticsService } from "./diagnostics.js";
import { createCodexAgentModel } from "./provider/codex.js";
import { createOpenAIAgentModel } from "./provider/openai.js";
import type { CodexCredentials } from "./provider/codex-auth.js";

const credentials: CodexCredentials = {
  accessToken: "access-fixture",
  refreshToken: "refresh-fixture",
  expiresAt: "2099-01-01T00:00:00.000Z",
  accountId: "acct_fixture",
  tokenType: "Bearer",
};

const request: AgentRequest = { task: "Inspect the fixture.", tools: [], toolOutputs: [] };

function sse(events: object[]): Response {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function codex(events: object[], diagnostics: string[] = []) {
  return createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => sse(events),
  }).respond({ ...request, onProviderDiagnostic: (kind) => diagnostics.push(kind) });
}

test("M36 Codex ignores non-critical stream metadata but rejects unknown critical completion semantics", async () => {
  const diagnostics: string[] = [];
  const response = await codex([
    { type: "response.progress.snapshot", phase: "queued" },
    { type: "response.reasoning.delta", delta: "ignored" },
    { type: "response.output_text.delta", delta: "Done." },
    { type: "response.completed", response: { id: "resp_ok" } },
  ], diagnostics);
  assert.equal(response.text, "Done.");
  assert.deepEqual(diagnostics, ["protocol_drift"]);

  await assert.rejects(codex([
    { type: "response.unrecognized_tool_call.completed", call_id: "call_bad" },
    { type: "response.completed", response: { id: "resp_bad" } },
  ]), /incompatible with this Dragons adapter/);
});

test("M36 rejects malformed and duplicate completed ChatGPT calls before the agent can execute a tool", async () => {
  let executions = 0;
  const tool = {
    name: "write_file",
    operation: "WRITE" as const,
    description: "write",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false as const },
    async execute() { executions += 1; return { ok: true, output: "unexpected" }; },
  };
  const malformed = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => sse([
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "write_file", arguments: "{", status: "completed" } },
      { type: "response.completed", response: { id: "resp_1" } },
    ]),
  });
  await assert.rejects(runAgent({ task: "do not write", model: malformed, tools: [tool], authorize: () => true }), /malformed response/);
  assert.equal(executions, 0);

  const duplicate = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => sse([
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "write_file", arguments: "{}", status: "completed" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "write_file", arguments: "{}", status: "completed" } },
      { type: "response.completed", response: { id: "resp_2" } },
    ]),
  });
  await assert.rejects(runAgent({ task: "do not write", model: duplicate, tools: [tool], authorize: () => true }), /incompatible with this Dragons adapter/);
  assert.equal(executions, 0);
});

test("M36 validates ChatGPT continuation state and exact tool-output IDs", async () => {
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => sse([{ type: "response.completed", response: { id: "never" } }]),
  });
  await assert.rejects(model.respond({ ...request, continuationState: { kind: "openai-responses", previousResponseId: "response" } }), /incompatible with this Dragons adapter/);

  const first = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => sse([
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}", status: "completed" } },
      { type: "response.completed", response: { id: "resp_1" } },
    ]),
  });
  await first.respond(request);
  await assert.rejects(first.respond({ ...request, previousResponseId: "resp_1", toolOutputs: [{ callId: "different", output: "x" }] }), /incompatible with this Dragons adapter/);
});

test("M36 classifies ChatGPT backend failures without response-body disclosure and records safe diagnostics", async () => {
  const service = new RuntimeDiagnosticsService({ createRunId: () => "compat-run" });
  const run = service.start({ provider: "chatgpt", model: "fixture" });
  const model = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => new Response("workspace entitlement access-fixture", { status: 403 }),
  });
  await assert.rejects(runAgent({ task: "x", model, tools: [], diagnostics: run }), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /not entitled/);
    assert.doesNotMatch(message, /access-fixture/);
    return true;
  });
  assert.deepEqual(service.recent()[0]?.providerDiagnosticCounts, { entitlement: 1 });
});

test("M36 agent runtime rejects duplicate call IDs so an approved side effect runs once", async () => {
  let executions = 0;
  let turn = 0;
  const requests: AgentRequest[] = [];
  await runAgent({
    task: "write once",
    model: {
      async respond(next) {
        requests.push(next);
        turn += 1;
        if (turn === 1) return {
          responseId: "first",
          text: "",
          toolCalls: [
            { callId: "once", name: "write_file", arguments: "{}" },
            { callId: "once", name: "write_file", arguments: "{}" },
          ],
        };
        return { responseId: "done", text: "done", toolCalls: [] };
      },
    },
    tools: [{
      name: "write_file",
      operation: "WRITE",
      description: "write",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { executions += 1; return { ok: true, output: "wrote once" }; },
    }],
    authorize: () => true,
  });
  assert.equal(executions, 1);
  assert.deepEqual(requests[1]?.toolOutputs, [
    { callId: "once", output: "wrote once" },
    { callId: "once", output: "Duplicate tool call ID rejected: once." },
  ]);
});

test("M36 OpenAI rejects malformed or duplicate completed calls before tool execution", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => new Response([
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"write_file","arguments":"{"}}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
  ].join(""), { headers: { "content-type": "text/event-stream" } });
  try {
    await assert.rejects(runAgent({
      task: "do not write",
      model: createOpenAIAgentModel(),
      tools: [{ name: "write_file", operation: "WRITE", description: "write", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { calls += 1; return { ok: true, output: "unexpected" }; } }],
      authorize: () => true,
    }), /malformed response/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("M36 classifies provider auth, model, rate-limit, and transient failures without leaking provider bodies", async () => {
  const auth = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => new Response("access-fixture", { status: 401 }),
  });
  await assert.rejects(auth.respond(request), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /authentication failed/);
    assert.doesNotMatch(message, /access-fixture/);
    return true;
  });

  const unavailable = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => new Response("model unavailable access-fixture", { status: 404 }),
  });
  await assert.rejects(unavailable.respond(request), /model is unavailable or not entitled/);

  let attempts = 0;
  let retries = 0;
  const rateLimited = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => {
      attempts += 1;
      return new Response("refresh-fixture", { status: 429 });
    },
  });
  await assert.rejects(rateLimited.respond({ ...request, onProviderRetry: () => { retries += 1; } }), /rate limit reached/);
  assert.equal(attempts, 3);
  assert.equal(retries, 2);

  let transientAttempts = 0;
  const transient = createCodexAgentModel({
    credentials: { getValidCredentials: async () => credentials },
    fetchImpl: async () => {
      transientAttempts += 1;
      return new Response("server detail access-fixture", { status: 503 });
    },
  });
  await assert.rejects(transient.respond(request), /temporarily unavailable/);
  assert.equal(transientAttempts, 3);
});

test("M36 OpenAI classifies authentication and rate limits before a response progresses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let attempts = 0;
  let retries = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: { message: "access-fixture" } }), { status: 429, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(createOpenAIAgentModel().respond({ ...request, onProviderRetry: () => { retries += 1; } }), (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.match(message, /rate limit reached/);
      assert.doesNotMatch(message, /access-fixture/);
      return true;
    });
    assert.equal(attempts, 3);
    assert.equal(retries, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
