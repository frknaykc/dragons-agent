import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunCancelledError, type AgentRequest } from "../../dist/agent.js";
import { runMixtureOfAgents } from "../../dist/mixture-of-agents.js";
import type { AgentTool } from "../../dist/tools.js";

const readTool: AgentTool = { name: "read_fixture", operation: "READ", description: "Read.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "evidence" }; } };
const writeTool: AgentTool = { name: "write_fixture", operation: "WRITE", description: "Write.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { throw new Error("Unexpected write"); } };

function candidates(ids: readonly string[], respond: (id: string, request: AgentRequest) => Promise<string>) {
  return ids.map((id) => ({ id, createModel: () => ({ async respond(request: AgentRequest) { return { responseId: id, text: await respond(id, request), toolCalls: [] }; } }) }));
}

test("MoA runs distinct selected models with READ only, then aggregates bounded reports in selection order", async () => {
  const requests: { id: string; request: AgentRequest }[] = [];
  let release!: () => void;
  const secondStarted = new Promise<void>((resolve) => { release = resolve; });
  let aggregatorCalls = 0;
  const result = await runMixtureOfAgents({
    task: "Compare the alternatives.", preset: "duo", tools: [readTool, writeTool],
    candidates: candidates(["alpha", "beta"], async (id, request) => {
      requests.push({ id, request });
      if (id === "alpha") await secondStarted;
      else release();
      return id === "alpha" ? "A" : "B";
    }),
    createAggregatorModel: () => ({ async respond(request) {
      aggregatorCalls += 1;
      assert.deepEqual(request.tools, []);
      assert.match(request.task, /Compare the alternatives/);
      assert.match(request.task, /\[alpha\] A\n\[beta\] B/);
      assert.equal(request.conversationResponseId, undefined);
      assert.equal(request.continuationState, undefined);
      return { responseId: "aggregate", text: "Combined answer.", toolCalls: [] };
    } }),
  });
  assert.deepEqual(result, { finalText: "Combined answer." });
  assert.equal(aggregatorCalls, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.request.tools.map((tool) => tool.name), ["read_fixture"]);
  assert.equal(requests[0]?.request.conversationResponseId, undefined);
});

test("MoA rejects invalid preset, duplicate models and oversized inputs before model creation", async () => {
  let creations = 0;
  const option = {
    task: "Inspect.", preset: "duo" as const, tools: [readTool],
    candidates: ["same", "same"].map((id) => ({ id, createModel: () => { creations += 1; return { async respond() { return { responseId: id, text: id, toolCalls: [] }; } }; } })),
    createAggregatorModel: () => { creations += 1; throw new Error("Do not start"); },
  };
  await assert.rejects(runMixtureOfAgents(option), /distinct/);
  await assert.rejects(runMixtureOfAgents({ ...option, preset: "trio" }), /three|3/);
  await assert.rejects(runMixtureOfAgents({ ...option, task: "x".repeat(4_001) }), /task/i);
  assert.equal(creations, 0);
});

test("MoA does not aggregate after a failed candidate and stops queued candidates", async () => {
  let created = 0;
  let aggregated = false;
  await assert.rejects(runMixtureOfAgents({
    task: "Inspect.", preset: "trio", tools: [],
    candidates: ["one", "two", "three"].map((id) => ({ id, createModel: () => { created += 1; return { async respond(request: AgentRequest) {
      if (id === "one") throw new Error("Provider unavailable");
      if (id === "two") return await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new AgentRunCancelledError()), { once: true }));
      return { responseId: id, text: id, toolCalls: [] };
    } }; } })),
    createAggregatorModel: () => { aggregated = true; throw new Error("Unexpected aggregator"); },
  }), /Provider unavailable/);
  assert.equal(created, 2);
  assert.equal(aggregated, false);
});

test("MoA cancellation propagates and does not launch the aggregator", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  let aggregated = false;
  const run = runMixtureOfAgents({
    task: "Inspect.", preset: "duo", tools: [], signal: controller.signal,
    candidates: candidates(["one", "two"], async (_id, request) => {
      started();
      return await new Promise<string>((_, reject) => request.signal?.addEventListener("abort", () => reject(new AgentRunCancelledError()), { once: true }));
    }),
    createAggregatorModel: () => { aggregated = true; throw new Error("Unexpected aggregator"); },
  });
  await firstStarted;
  controller.abort();
  await assert.rejects(run, AgentRunCancelledError);
  assert.equal(aggregated, false);
});

test("MoA caps candidate report and final synthesis independently", async () => {
  const result = await runMixtureOfAgents({
    task: "Inspect.", preset: "duo", tools: [],
    candidates: candidates(["one", "two"], async () => "r".repeat(10_000)),
    createAggregatorModel: () => ({ async respond(request) {
      assert.ok(request.task.length < 5_000);
      assert.match(request.task, /truncated/);
      return { responseId: "synthesis", text: "s".repeat(20_000), toolCalls: [] };
    } }),
  });
  assert.ok(result.finalText.length <= 8_000);
});

test("MoA gives the aggregator no tool authority even when it requests a write", async () => {
  let turns = 0;
  const result = await runMixtureOfAgents({
    task: "Inspect.", preset: "duo", tools: [readTool, writeTool],
    candidates: candidates(["one", "two"], async () => "safe"),
    createAggregatorModel: () => ({ async respond(request) {
      turns += 1;
      if (turns === 1) return { responseId: "attempt", text: "", toolCalls: [{ callId: "write", name: "write_fixture", arguments: "{}" }] };
      assert.deepEqual(request.toolOutputs, [{ callId: "write", output: "Unknown tool: write_fixture" }]);
      return { responseId: "final", text: "No changes made.", toolCalls: [] };
    } }),
  });
  assert.deepEqual(result, { finalText: "No changes made." });
});
