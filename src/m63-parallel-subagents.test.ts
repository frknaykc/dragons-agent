import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { AgentRunCancelledError, type AgentRequest } from "./agent.js";
import { main } from "./cli.js";
import { createParallelSubagentTool } from "./parallel-subagents.js";
import type { AgentTool } from "./tools.js";

const readTool: AgentTool = { name: "read_fixture", operation: "READ", description: "Read.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "read" }; } };
const writeTool: AgentTool = { name: "write_fixture", operation: "WRITE", description: "Write.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "unexpected" }; } };

test("M63 bounds concurrent read-only fan-out and returns reports in input order", async () => {
  const requests: AgentRequest[] = [];
  let active = 0;
  let maximumActive = 0;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const tool = createParallelSubagentTool({
    maxChildren: 3,
    maxConcurrency: 2,
    createModel: () => ({
      async respond(request) {
        requests.push(request);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === 2) release?.();
        await started;
        active -= 1;
        return { responseId: request.task, text: `report:${request.task}`, toolCalls: [] };
      },
    }),
    tools: [readTool, writeTool],
  });

  const result = await tool.execute({ tasks: ["first", "second", "third"] });

  assert.deepEqual(result, { ok: true, output: "Parallel subagent reports:\n[1] report:first\n\n[2] report:second\n\n[3] report:third" });
  assert.equal(maximumActive, 2);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["read_fixture"]);
});

test("M63 rejects malformed or oversized fan-out before creating child models and propagates cancellation", async () => {
  let models = 0;
  const tool = createParallelSubagentTool({
    createModel: () => { models += 1; return { async respond() { return { responseId: "unused", text: "unused", toolCalls: [] }; } }; },
    tools: [readTool],
  });
  assert.deepEqual(await tool.execute({ tasks: [] }), { ok: false, output: "Expected tasks as an array containing 1 to 4 focused tasks." });
  assert.deepEqual(await tool.execute({ tasks: ["a", "b", "c", "d", "e"] }), { ok: false, output: "Expected tasks as an array containing 1 to 4 focused tasks." });
  assert.equal(models, 0);

  const controller = new AbortController();
  const cancelled = createParallelSubagentTool({
    createModel: () => ({ async respond(request) { return await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new AgentRunCancelledError()), { once: true })); } }),
    tools: [readTool],
  });
  const run = cancelled.execute({ tasks: ["first", "second"] }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(run, AgentRunCancelledError);
});

test("M63 bounds aggregate reports independently of individual child caps", async () => {
  const tool = createParallelSubagentTool({
    maxOutputCharacters: 80,
    createModel: () => ({ async respond(request) { return { responseId: request.task, text: `${request.task}:${"x".repeat(100)}`, toolCalls: [] }; } }),
    tools: [readTool],
  });

  const result = await tool.execute({ tasks: ["first", "second"] });

  assert.equal(result.ok, true);
  assert.ok(result.output.length <= 80);
  assert.match(result.output, /parallel subagent reports truncated/i);
});

test("M63 returns a bounded recoverable failure when its advisory plan snapshot cannot load", async () => {
  let models = 0;
  const tool = createParallelSubagentTool({
    maxOutputCharacters: 80,
    createModel: () => { models += 1; return { async respond() { return { responseId: "unused", text: "unused", toolCalls: [] }; } }; },
    getPlan: async () => { throw new Error("plan snapshot unavailable"); },
    tools: [readTool],
  });

  const result = await tool.execute({ tasks: ["inspect"] });

  assert.deepEqual(result, { ok: false, output: "Parallel subagents failed: plan snapshot unavailable" });
  assert.equal(models, 0);
});

test("M63 caps child tool calls even when a model returns multiple calls in one turn", async () => {
  let readExecutions = 0;
  const tool = createParallelSubagentTool({
    maxToolCalls: 1,
    createModel: () => ({ async respond() { return { responseId: "overflow", text: "", toolCalls: [
      { callId: "one", name: "read_fixture", arguments: "{}" },
      { callId: "two", name: "read_fixture", arguments: "{}" },
    ] }; } }),
    tools: [{ ...readTool, async execute() { readExecutions += 1; return { ok: true, output: "read" }; } }],
  });

  const result = await tool.execute({ tasks: ["inspect"] });

  assert.deepEqual(result, { ok: true, output: "Parallel subagent reports:\n[1] Subagent failed: Agent reached the maximum of 1 tool calls." });
  assert.equal(readExecutions, 0);
});

test("M63 cancellation prevents queued children from creating models", async () => {
  const controller = new AbortController();
  let models = 0;
  let started!: () => void;
  const childStarted = new Promise<void>((resolve) => { started = resolve; });
  const tool = createParallelSubagentTool({
    maxConcurrency: 1,
    createModel: () => {
      models += 1;
      return { async respond(request) {
        started();
        return await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new AgentRunCancelledError()), { once: true }));
      } };
    },
    tools: [readTool],
  });

  const run = tool.execute({ tasks: ["first", "never starts"] }, { signal: controller.signal });
  await childStarted;
  controller.abort();

  await assert.rejects(run, AgentRunCancelledError);
  assert.equal(models, 1);
});

test("M63 CLI wiring preserves top-level EXECUTE authorization before any child starts", async () => {
  let turns = 0;
  const model = {
    async respond(request: AgentRequest) {
      turns += 1;
      if (turns === 1) return { responseId: "parent", text: "", toolCalls: [{ callId: "fan-out", name: "delegate_parallel_subagents", arguments: '{"tasks":["inspect"]}' }] };
      assert.deepEqual(request.toolOutputs, [{ callId: "fan-out", output: "Authorization denied for delegate_parallel_subagents." }]);
      return { responseId: "complete", text: "Denied.", toolCalls: [] };
    },
  };

  await main(["Inspect safely."], { model, tools: [readTool], input: Readable.from(["no\n"]), write: () => undefined });

  assert.equal(turns, 2);
});
