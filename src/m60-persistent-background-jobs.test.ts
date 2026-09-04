import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { PersistentBackgroundJobManager, createPersistentBackgroundJobStore } from "./persistent-background-jobs.js";
import { main } from "./cli.js";
import type { AgentTool } from "./tools.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_JOB_ID = "44444444-4444-4444-8444-444444444444";

const readTool: AgentTool = {
  name: "read_fixture", operation: "READ", description: "Read deterministic fixture data.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { ok: true, output: "fixture" }; },
};

async function nextTurn(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
async function waitForState(manager: PersistentBackgroundJobManager, id: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) { if (manager.show(id)?.state === state) return; await nextTurn(); }
  assert.fail(`Persistent job ${id} did not reach ${state}.`);
}

test("M60 persists terminal read-only jobs across reload without persisting runtime handles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m60-jobs-"));
  try {
    const store = createPersistentBackgroundJobStore(directory);
    const manager = new PersistentBackgroundJobManager({ store, createId: () => JOB_ID });
    const created = await manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Inspect safely.", createModel: () => ({ async respond() { return { responseId: "done", text: "bounded report", toolCalls: [] }; } }), tools: [readTool] });
    assert.equal(created.state, "queued");
    await waitForState(manager, JOB_ID, "completed");
    const reloaded = new PersistentBackgroundJobManager({ store });
    await reloaded.initialize();
    const job = reloaded.show(JOB_ID)!;
    assert.deepEqual(job, { version: 1, id: JOB_ID, sessionId: SESSION_ID, workingDirectory: directory, prompt: "Inspect safely.", executionPolicy: "READ_ONLY_MANUAL_RESUME", provenance: "INTERACTIVE_COMMAND", state: "completed", createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt, completedAt: job.completedAt, revision: job.revision, executionAttempts: 1, transcript: "bounded report", report: "bounded report" });
    assert.doesNotMatch(await (await import("node:fs/promises")).readFile(join(directory, `${JOB_ID}.json`), "utf8"), /controller|promise|createModel|toolOutputs/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("M60 reconciles abandoned queued/running jobs once as interrupted and never auto-runs them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m60-reconcile-"));
  let modelsCreated = 0;
  try {
    await writeFile(join(directory, `${JOB_ID}.json`), JSON.stringify({ version: 1, id: JOB_ID, sessionId: SESSION_ID, workingDirectory: directory, prompt: "Prior process task.", executionPolicy: "READ_ONLY_MANUAL_RESUME", provenance: "INTERACTIVE_COMMAND", state: "running", createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:01.000Z", startedAt: "2026-09-04T00:00:01.000Z", revision: 0, executionAttempts: 1, transcript: "partial" }));
    const manager = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory), now: () => new Date("2026-09-04T01:00:00.000Z") });
    assert.equal((await manager.initialize()).reconciled, 1);
    assert.equal(manager.show(JOB_ID)?.state, "interrupted");
    assert.match(manager.show(JOB_ID)?.error ?? "", /not automatically retried/i);
    assert.equal((await manager.initialize()).reconciled, 0);
    assert.equal(modelsCreated, 0);
    await manager.resume(JOB_ID, { createModel: () => { modelsCreated += 1; return { async respond() { return { responseId: "manual", text: "manual resume", toolCalls: [] }; } }; }, tools: [readTool] });
    await waitForState(manager, JOB_ID, "completed");
    assert.equal(modelsCreated, 1);
    assert.equal(manager.show(JOB_ID)?.executionAttempts, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("M60 denies duplicate active execution, preserves scope isolation, and safely ignores malformed durable files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m60-isolation-"));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    await writeFile(join(directory, "malformed.json"), "not json");
    const manager = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory), createId: (() => { const ids = [JOB_ID, OTHER_JOB_ID]; return () => ids.shift()!; })() });
    const first = await manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Wait safely.", createModel: () => ({ async respond() { await pending; return { responseId: "first", text: "done", toolCalls: [] }; } }), tools: [readTool] });
    await waitForState(manager, first.id, "running");
    await assert.rejects(manager.resume(first.id, { createModel: () => ({ async respond() { throw new Error("must not run"); } }), tools: [readTool] }), /not interrupted/i);
    const second = await manager.start({ sessionId: OTHER_SESSION_ID, workingDirectory: directory, prompt: "Other scope.", createModel: () => ({ async respond() { return { responseId: "second", text: "done", toolCalls: [] }; } }), tools: [readTool] });
    await waitForState(manager, second.id, "completed");
    assert.deepEqual(manager.list(SESSION_ID).map((job) => job.id), [JOB_ID]);
    assert.deepEqual(manager.list(OTHER_SESSION_ID).map((job) => job.id), [OTHER_JOB_ID]);
    assert.equal(manager.show(first.id, OTHER_SESSION_ID), undefined);
    assert.equal(await manager.cancel(first.id, OTHER_SESSION_ID), false);
    assert.equal(await manager.cleanup({ sessionId: SESSION_ID, limit: 1 }), 0);
    assert.equal(await manager.cancel(first.id), true);
    assert.equal(await manager.cleanup({ sessionId: OTHER_SESSION_ID, limit: 1 }), 1);
    assert.equal(manager.show(OTHER_JOB_ID), undefined);
    release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("M60 exposes explicitly persistent jobs through bounded slash management after session reload", async () => {
  const jobsDirectory = await mkdtemp(join(tmpdir(), "dragons-m60-cli-jobs-"));
  const sessionsDirectory = await mkdtemp(join(tmpdir(), "dragons-m60-cli-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m60-cli-workspace-"));
  const output: string[] = [];
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  try {
    async function* input(): AsyncGenerator<string> {
      yield "/jobs start Persist this safe research.\n";
      await done;
      for (let attempt = 0; attempt < 100 && !/\[completed\].*Persist this safe research/i.test(output.join("")); attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      yield "/jobs\n";
      yield "/exit\n";
    }
    await main([], { workingDirectory: workspace, sessionDirectory: sessionsDirectory, backgroundJobsDirectory: jobsDirectory, input: Readable.from(input()), tools: [readTool], write: (text) => output.push(text), modelFactory: () => ({ async respond(request) { assert.equal(request.task, "Persist this safe research."); assert.deepEqual(request.tools.map((tool) => tool.name), ["read_fixture"]); completed(); return { responseId: "job", text: "Persisted result", toolCalls: [] }; } }) });
    assert.match(output.join(""), /Persistent background job started: [0-9a-f-]{36}/i);
    assert.match(output.join(""), /\[completed\].*Persist this safe research/i);
    const reloaded = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(jobsDirectory) });
    await reloaded.initialize();
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0]?.state, "completed");
  } finally { await Promise.all([rm(jobsDirectory, { recursive: true, force: true }), rm(sessionsDirectory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]); }
});

test("M60 fails closed for symlinked storage roots and job files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-m60-secure-root-"));
  const outside = await mkdtemp(join(tmpdir(), "dragons-m60-secure-outside-"));
  const linkedRoot = join(root, "linked-jobs");
  try {
    await symlink(outside, linkedRoot);
    await assert.rejects(createPersistentBackgroundJobStore(linkedRoot).list(), /real directory, not a symlink/i);
    await writeFile(join(outside, "job.json"), JSON.stringify({ version: 1, id: JOB_ID, sessionId: SESSION_ID, workingDirectory: outside, prompt: "External job.", executionPolicy: "READ_ONLY_MANUAL_RESUME", provenance: "INTERACTIVE_COMMAND", state: "completed", createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.000Z", revision: 0, executionAttempts: 1, transcript: "" }));
    const jobs = join(root, "jobs");
    await (await import("node:fs/promises")).mkdir(jobs);
    await symlink(join(outside, "job.json"), join(jobs, `${JOB_ID}.json`));
    assert.equal(await createPersistentBackgroundJobStore(jobs).load(JOB_ID), undefined);
  } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
});
