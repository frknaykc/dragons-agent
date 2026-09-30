import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRunCancelledError, type AgentRequest } from "../../dist/agent.js";
import { batchWorkspaceDirectory, createFileBatchQueue } from "../../dist/batch-queue.js";
import { runBatch } from "../../dist/batch-runner.js";
import type { AgentTool } from "../../dist/tools.js";

const read: AgentTool = { name: "read_fixture", description: "Read.", operation: "READ", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "evidence" }; } };
const write: AgentTool = { name: "write_fixture", description: "Write.", operation: "WRITE", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { throw new Error("Unexpected write"); } };

async function fixture(prompts = ["alpha", "beta", "gamma"], maxRuns = prompts.length) {
  const root = await mkdtemp(join(tmpdir(), "dragons-batch-runner-"));
  const workspace = join(root, "workspace");
  const queue = createFileBatchQueue(batchWorkspaceDirectory(root, workspace), workspace);
  const batch = await queue.create(prompts, maxRuns);
  return { queue, batch, async close() { await rm(root, { recursive: true, force: true }); } };
}

test("batch runner spends the reserved budget sequentially with fresh isolated READ-only runs", async () => {
  const f = await fixture();
  const requests: AgentRequest[] = [];
  let creations = 0;
  try {
    const done = await runBatch({ queue: f.queue, id: f.batch.id, revision: f.batch.revision, tools: [read, write], createModel: () => {
      creations++;
      return { async respond(request) {
        requests.push(request);
        assert.deepEqual(request.tools.map((tool) => tool.name), ["read_fixture"]);
        assert.equal(request.conversationResponseId, undefined);
        assert.equal(request.continuationState, undefined);
        assert.deepEqual(request.toolOutputs, []);
        return { responseId: "response", text: `report for ${request.task}`, toolCalls: [] };
      } };
    } });
    assert.equal(creations, 3);
    assert.deepEqual(requests.map((request) => request.task), ["alpha", "beta", "gamma"]);
    assert.deepEqual(done.tasks.map((task) => task.state), ["completed", "completed", "completed"]);
    assert.equal(done.revision, 6);
    assert.equal((await f.queue.load(f.batch.id))?.tasks[1]?.result, "report for beta");
    await assert.rejects(() => runBatch({ queue: f.queue, id: done.id, revision: f.batch.revision, tools: [], createModel: () => { throw new Error("unexpected"); } }), /changed/);
  } finally { await f.close(); }
});

test("batch runner never starts beyond the explicitly reserved run budget", async () => {
  const f = await fixture(["alpha", "beta", "gamma"], 1);
  try {
    let calls = 0;
    const done = await runBatch({ queue: f.queue, id: f.batch.id, revision: 0, tools: [], createModel: () => ({ async respond() { calls++; return { responseId: "ok", text: "ok", toolCalls: [] }; } }) });
    assert.equal(calls, 1);
    assert.deepEqual(done.tasks.map((task) => task.state), ["completed", "queued", "queued"]);
  } finally { await f.close(); }
});

test("batch runner checkpoints provider failures, rejects secrets and does not launch later tasks", async () => {
  for (const output of ["provider failure", "secret result"]) {
    const f = await fixture(["first", "second"]);
    let calls = 0;
    try {
      await assert.rejects(() => runBatch({ queue: f.queue, id: f.batch.id, revision: 0, tools: [], createModel: () => ({ async respond() {
        calls++;
        if (output === "provider failure") throw new Error("Provider unavailable");
        return { responseId: "unsafe", text: "Bearer fake-token", toolCalls: [] };
      } }) }), /Provider unavailable|Invalid batch result/);
      assert.equal(calls, 1);
      const state = (await f.queue.load(f.batch.id))!;
      assert.deepEqual(state.tasks.map((task) => task.state), ["failed", "queued"]);
      assert.equal(state.tasks[0]?.result, undefined);
      assert.equal(await f.queue.reserve(state.id, state.revision), undefined);
    } finally { await f.close(); }
  }
});

test("batch runner persists interrupted state on abort and never replays the task", async () => {
  const f = await fixture(["first", "second"]);
  const controller = new AbortController();
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  try {
    const run = runBatch({ queue: f.queue, id: f.batch.id, revision: 0, tools: [], signal: controller.signal, createModel: () => ({ async respond(request) {
      calls++;
      started();
      return await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new AgentRunCancelledError()), { once: true }));
    } }) });
    await pending;
    controller.abort();
    await assert.rejects(run, AgentRunCancelledError);
    assert.equal(calls, 1);
    const state = (await f.queue.load(f.batch.id))!;
    assert.deepEqual(state.tasks.map((task) => task.state), ["interrupted", "queued"]);
    assert.equal(await f.queue.reserve(state.id, state.revision), undefined);
  } finally { await f.close(); }
});

test("batch runner refuses stale or already running records before creating a model", async () => {
  const f = await fixture();
  try {
    const reserved = (await f.queue.reserve(f.batch.id, 0))!;
    let creations = 0;
    await assert.rejects(() => runBatch({ queue: f.queue, id: f.batch.id, revision: 0, tools: [], createModel: () => { creations++; throw new Error("unsafe"); } }), /changed/);
    await assert.rejects(() => runBatch({ queue: f.queue, id: f.batch.id, revision: reserved.revision, tools: [], createModel: () => { creations++; throw new Error("unsafe"); } }), /running/);
    assert.equal(creations, 0);
  } finally { await f.close(); }
});
