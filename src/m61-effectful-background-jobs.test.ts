import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEffectfulBackgroundGrant, createEffectfulBackgroundJobManager, createPersistentEffectfulBackgroundJobManager } from "./effectful-background-jobs.js";
import { AgentRunCancelledError } from "./agent.js";
import { createPersistentBackgroundJobStore } from "./persistent-background-jobs.js";
import type { AgentTool } from "./tools.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const write: AgentTool = { name: "write_fixture", operation: "WRITE", description: "Write.", inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"], additionalProperties: false }, async execute() { return { ok: true, output: "written" }; } };
const execute: AgentTool = { name: "execute_fixture", operation: "EXECUTE", description: "Execute.", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false }, async execute() { return { ok: true, output: "ran" }; } };
const modelFor = (calls: Array<{ name: string; arguments: string }>) => () => ({ async respond(request: { toolOutputs: Array<{ callId: string; output: string }> }) { if (request.toolOutputs.length > 0) return { responseId: "done", text: "done", toolCalls: [] }; return { responseId: "first", text: "", toolCalls: calls.map((call, index) => ({ callId: `call-${index}`, ...call })) }; } });

test("M61 executes only exact pre-authorized WRITE and EXECUTE calls once", async () => {
  const manager = createEffectfulBackgroundJobManager({ createId: () => JOB });
  const grant = createEffectfulBackgroundGrant({ jobId: JOB, sessionId: SESSION, workspace: process.cwd(), calls: [
    { name: write.name, operation: "WRITE", arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" },
    { name: execute.name, operation: "EXECUTE", arguments: "{\"command\":\"node --version\"}" },
  ] });
  const result = await manager.start({ sessionId: SESSION, workspace: process.cwd(), prompt: "Apply approved work.", grant, createModel: modelFor([
    { name: write.name, arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" },
    { name: execute.name, arguments: "{\"command\":\"node --version\"}" },
  ]), tools: [write, execute] });
  assert.equal(result.state, "completed");
  await assert.rejects(manager.start({ sessionId: SESSION, workspace: process.cwd(), prompt: "Replay.", grant, createModel: modelFor([]), tools: [write, execute] }), /consumed|grant/i);
});

test("M61 denies missing, cross-scope, changed, expired, and operation-mismatched grants", async () => {
  const manager = createEffectfulBackgroundJobManager({ createId: () => JOB, now: () => new Date("2026-09-04T00:00:10.000Z") });
  const writeOnly = createEffectfulBackgroundGrant({ jobId: JOB, sessionId: SESSION, workspace: process.cwd(), expiresAt: "2026-09-04T00:00:00.000Z", calls: [{ name: write.name, operation: "WRITE", arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" }] });
  await assert.rejects(manager.start({ sessionId: SESSION, workspace: process.cwd(), prompt: "No grant.", createModel: modelFor([]), tools: [write] }), /grant/i);
  await assert.rejects(manager.start({ sessionId: SESSION, workspace: process.cwd(), prompt: "Expired.", grant: writeOnly, createModel: modelFor([]), tools: [write] }), /expired/i);
  const fresh = createEffectfulBackgroundGrant({ jobId: JOB, sessionId: SESSION, workspace: process.cwd(), calls: [{ name: write.name, operation: "WRITE", arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" }] });
  const denied = await manager.start({ sessionId: SESSION, workspace: process.cwd(), prompt: "Try changed effect.", grant: fresh, createModel: modelFor([{ name: execute.name, arguments: "{\"command\":\"node --version\"}" }]), tools: [write, execute] });
  assert.equal(denied.state, "failed");
  assert.match(denied.error ?? "", /not pre-authorized/i);
});

test("M61 restart reconciles effectful work and fails closed without a fresh grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m61-restart-"));
  let createdModels = 0;
  let writes = 0;
  try {
    const first = createPersistentEffectfulBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory), createId: () => JOB });
    const job = await first.prepare({ sessionId: SESSION, workspace: process.cwd(), prompt: "Apply a reviewed change." });
    assert.equal(job.executionPolicy, "EFFECTFUL_REAUTH_REQUIRED");
    const restarted = createPersistentEffectfulBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory) });
    await restarted.initialize();
    await assert.rejects(restarted.resume(JOB, { sessionId: SESSION, workspace: process.cwd(), createModel: () => { createdModels += 1; return modelFor([])(); }, tools: [write] }), /grant/i);
    assert.equal(createdModels, 0);
    assert.equal(restarted.show(JOB, SESSION)?.state, "interrupted");
    const grant = createEffectfulBackgroundGrant({ jobId: JOB, sessionId: SESSION, workspace: process.cwd(), calls: [{ name: write.name, operation: "WRITE", arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" }] });
    const countedWrite: AgentTool = { ...write, async execute() { writes += 1; return { ok: true, output: "written" }; } };
    const completed = await restarted.resume(JOB, { sessionId: SESSION, workspace: process.cwd(), grant, createModel: modelFor([{ name: write.name, arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" }]), tools: [countedWrite] });
    assert.equal(completed.state, "completed");
    assert.equal(writes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M61 durable resume rejects a grant issued for another job before model creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m61-grant-scope-"));
  let createdModels = 0;
  try {
    const manager = createPersistentEffectfulBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory), createId: () => JOB });
    await manager.prepare({ sessionId: SESSION, workspace: process.cwd(), prompt: "Apply a reviewed change." });
    await manager.initialize();
    const otherJob = "33333333-3333-4333-8333-333333333333";
    const grant = createEffectfulBackgroundGrant({ jobId: otherJob, sessionId: SESSION, workspace: process.cwd(), calls: [{ name: write.name, operation: "WRITE", arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" }] });
    await assert.rejects(manager.resume(JOB, { sessionId: SESSION, workspace: process.cwd(), grant, createModel: () => { createdModels += 1; return modelFor([])(); }, tools: [write] }), /grant.*scope|scope.*grant/i);
    assert.equal(createdModels, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M61 enforces a bounded effectful execution duration", async () => {
  const manager = createEffectfulBackgroundJobManager({ createId: () => JOB, maxDurationMs: 10 });
  const grant = createEffectfulBackgroundGrant({ jobId: JOB, sessionId: SESSION, workspace: process.cwd(), calls: [{ name: write.name, operation: "WRITE", arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" }] });
  const result = await manager.start({ sessionId: SESSION, workspace: process.cwd(), prompt: "Apply approved work.", grant, tools: [write], createModel: () => ({ async respond(request: { signal?: AbortSignal }) { return await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new AgentRunCancelledError()), { once: true })); } }) });
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /duration limit/i);
});

test("M61 propagates durable cancellation to an effectful owner without terminal overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m61-cancel-"));
  let responseStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { responseStarted = resolve; });
  let abortSeen = false;
  try {
    const owner = createPersistentEffectfulBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory), createId: () => JOB });
    await owner.prepare({ sessionId: SESSION, workspace: process.cwd(), prompt: "Apply a reviewed change." });
    await owner.initialize();
    const grant = createEffectfulBackgroundGrant({ jobId: JOB, sessionId: SESSION, workspace: process.cwd(), calls: [{ name: write.name, operation: "WRITE", arguments: "{\"path\":\"fixture.txt\",\"text\":\"safe\"}" }] });
    const running = owner.resume(JOB, { sessionId: SESSION, workspace: process.cwd(), grant, tools: [write], createModel: () => ({ async respond(request: { signal?: AbortSignal }) { responseStarted?.(); return await new Promise((_, reject) => request.signal?.addEventListener("abort", () => { abortSeen = true; reject(new AgentRunCancelledError()); }, { once: true })); } }) });
    await started;
    const canceller = createPersistentEffectfulBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory) });
    await canceller.initialize();
    assert.equal(await canceller.cancel(JOB, SESSION), true);
    const completed = await running;
    assert.equal(abortSeen, true);
    assert.equal(completed.state, "cancelled");
    assert.equal((await createPersistentBackgroundJobStore(directory).load(JOB))?.state, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
