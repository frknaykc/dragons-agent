import assert from "node:assert/strict";
import test from "node:test";

import { classifyReadToolDiagnostic, runChatGPTStreamTrace } from "./chatgpt-stream-trace.js";

test("stream trace is emitted after a provider compatibility failure without payload content", async () => {
  const output: string[] = [];
  const trace = [{ index: 0, type: "response.output_item.added", itemType: "function_call", hasCallId: true, hasToolName: true, decision: "waiting" as const }];
  const result = await runChatGPTStreamTrace({
    trace,
    write: (text) => output.push(text),
    model: { respond: async () => { throw new Error("ChatGPT Subscription response is incompatible with this Dragons adapter. No tool was executed."); } },
  });
  assert.match(result.failure ?? "", /incompatible/);
  assert.deepEqual(result.trace, trace);
  assert.equal(result.cleanedUp, true);
  assert.match(output.join(""), /^CHATGPT_STREAM_TRACE /);
  assert.doesNotMatch(output.join(""), /Authorization|Bearer|access[_-]?token|refresh[_-]?token|prompt|arguments/i);
});

test("read trace diagnostic retains no arbitrary path", () => {
  const diagnostic = classifyReadToolDiagnostic("read_file", JSON.stringify({ path: "/not-the-fixture.txt" }), { ok: false }, "README.txt");
  assert.deepEqual(diagnostic, { toolName: "read_file", argumentsParsed: true, argumentShape: "path_string", ok: false });
});

test("trace harness parses provider tool arguments before executing read_file", async () => {
  let executed = 0;
  const result = await runChatGPTStreamTrace({
    write: () => {},
    tools: async () => [{ name: "read_file", operation: "READ", description: "Read.", inputSchema: { type: "object" }, async execute(input) { executed += 1; assert.deepEqual(input, { path: "README.txt" }); return { ok: true, output: "fixture" }; } }],
    model: { respond: async (request) => request.toolOutputs.length === 0 ? { responseId: "first", text: "", toolCalls: [{ callId: "fixed-call-id", name: "read_file", arguments: '{"path":"README.txt"}' }] } : { responseId: "second", text: "done", textWasStreamed: true, toolCalls: [] } },
  });
  assert.equal(executed, 1);
  assert.equal(result.toolResultOk, true);
  assert.equal(result.finalStreamed, true);
});

test("trace harness rejects malformed arguments before tool execution", async () => {
  let executed = 0;
  const result = await runChatGPTStreamTrace({
    write: () => {},
    tools: async () => [{ name: "read_file", operation: "READ", description: "Read.", inputSchema: { type: "object" }, async execute() { executed += 1; return { ok: true, output: "unexpected" }; } }],
    model: { respond: async () => ({ responseId: "first", text: "", toolCalls: [{ callId: "fixed-call-id", name: "read_file", arguments: "{" }] }) },
  });
  assert.equal(executed, 0);
  assert.match(result.failure ?? "", /malformed tool arguments/);
});

test("read trace diagnostic retains only the known fixture-relative path on success", () => {
  const diagnostic = classifyReadToolDiagnostic("read_file", JSON.stringify({ path: "README.txt" }), { ok: true }, "README.txt");
  assert.deepEqual(diagnostic, { toolName: "read_file", argumentsParsed: true, argumentShape: "path_string", requestedRelativePath: "README.txt", ok: true });
});
