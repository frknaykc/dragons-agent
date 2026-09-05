import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPersistentBackgroundJobStore, PersistentBackgroundJobManager, type PersistentBackgroundJobStore } from "./persistent-background-jobs.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("timeout during initial durable running transition terminalizes without creating a model", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = await mkdtemp(join(tmpdir(), "dragons-job-lifecycle-"));
  const entered = barrier();
  const resume = barrier();
  const released = barrier();
  const backing = createPersistentBackgroundJobStore(directory);
  const store: PersistentBackgroundJobStore = {
    ...backing,
    async save(job, revision) {
      if (job.state === "running") { entered.release(); await resume.promise; }
      return backing.save(job, revision);
    },
    async claim(id) {
      const release = await backing.claim(id);
      return async () => { await release(); released.release(); };
    },
  };
  let modelsCreated = 0;
  const manager = new PersistentBackgroundJobManager({ store, createId: () => JOB_ID, maxDurationMs: 20 });
  try {
    await manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Read safely.", tools: [], createModel: () => { modelsCreated += 1; throw new Error("Must not create model after timeout."); } });
    await entered.promise;
    t.mock.timers.tick(20);
    resume.release();
    await released.promise;
    assert.equal(manager.show(JOB_ID)?.state, "failed");
    assert.equal((await backing.load(JOB_ID))?.state, "failed");
    assert.match(manager.show(JOB_ID)?.error ?? "", /duration limit/i);
    assert.equal(modelsCreated, 0);
    assert.equal(await backing.hasActiveClaim(JOB_ID), false);
  } finally {
    resume.release();
    await released.promise;
    await rm(directory, { recursive: true, force: true });
  }
});

test("wait drains the single in-flight poll and claim release after terminal state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const directory = await mkdtemp(join(tmpdir(), "dragons-job-drain-"));
  const backing = createPersistentBackgroundJobStore(directory);
  const modelEntered = barrier();
  const modelResume = barrier();
  const pollResume = barrier();
  const terminalSaved = barrier();
  const claimEntered = barrier();
  const claimResume = barrier();
  let loads = 0;
  const store: PersistentBackgroundJobStore = {
    ...backing,
    async load(id) { loads += 1; await pollResume.promise; return backing.load(id); },
    async save(job, revision) {
      const saved = await backing.save(job, revision);
      if (job.state === "completed") terminalSaved.release();
      return saved;
    },
    async claim(id) {
      const release = await backing.claim(id);
      return async () => { claimEntered.release(); await claimResume.promise; await release(); };
    },
  };
  const manager = new PersistentBackgroundJobManager({ store, createId: () => JOB_ID });
  let settled = false;
  try {
    await manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Read safely.", tools: [], createModel: () => ({ async respond() { modelEntered.release(); await modelResume.promise; return { responseId: "done", text: "done", toolCalls: [] }; } }) });
    await modelEntered.promise;
    const waiting = manager.wait(JOB_ID).then(() => { settled = true; });
    t.mock.timers.tick(50);
    t.mock.timers.tick(150);
    assert.equal(loads, 1, "blocked polling must remain single-flight");
    modelResume.release();
    await terminalSaved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.show(JOB_ID)?.state, "completed");
    assert.equal(settled, false, "terminal state does not mean resource work settled");
    assert.equal(await backing.hasActiveClaim(JOB_ID), true);
    pollResume.release();
    await claimEntered.promise;
    assert.equal(settled, false, "wait must include claim release");
    claimResume.release();
    await waiting;
    assert.equal(await backing.hasActiveClaim(JOB_ID), false);
    assert.equal(loads, 1);
  } finally {
    modelResume.release(); pollResume.release(); claimResume.release();
    await manager.wait(JOB_ID);
    await rm(directory, { recursive: true, force: true });
  }
});

test("detached persistence rejection is handled without claiming a durable terminal success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-job-rejection-"));
  const backing = createPersistentBackgroundJobStore(directory);
  const released = barrier();
  const store: PersistentBackgroundJobStore = {
    ...backing,
    async save(job, revision) {
      if (job.state === "completed" || job.state === "failed") throw new Error("Injected terminal persistence failure.");
      return backing.save(job, revision);
    },
    async claim(id) {
      const release = await backing.claim(id);
      return async () => { await release(); released.release(); };
    },
  };
  const manager = new PersistentBackgroundJobManager({ store, createId: () => JOB_ID });
  try {
    await manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Read safely.", tools: [], createModel: () => ({ async respond() { return { responseId: "done", text: "done", toolCalls: [] }; } }) });
    await released.promise;
    // Cross the rejection-reporting checkpoint without a wait() rejection handler.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await backing.load(JOB_ID))?.state, "running");
    assert.equal(await backing.hasActiveClaim(JOB_ID), false);
  } finally {
    await released.promise;
    await manager.wait(JOB_ID);
    await rm(directory, { recursive: true, force: true });
  }
});

test("initial transition storage failure is terminalized and fully observed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-job-save-failure-"));
  const backing = createPersistentBackgroundJobStore(directory);
  const store: PersistentBackgroundJobStore = {
    ...backing,
    async save(job, revision) {
      if (job.state === "running") throw new Error("Injected initial durable transition failure.");
      return backing.save(job, revision);
    },
  };
  const manager = new PersistentBackgroundJobManager({ store, createId: () => JOB_ID });
  try {
    await manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Read safely.", tools: [], createModel: () => { throw new Error("Must not run."); } });
    await manager.wait(JOB_ID);
    assert.equal((await backing.load(JOB_ID))?.state, "failed");
    assert.match(manager.show(JOB_ID)?.error ?? "", /Injected initial durable transition failure/);
    assert.equal(await backing.hasActiveClaim(JOB_ID), false);
  } finally {
    await manager.wait(JOB_ID);
    await rm(directory, { recursive: true, force: true });
  }
});
