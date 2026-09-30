import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CronScheduler } from "../../dist/cron-scheduler.js";
import { createFileCronTaskStore } from "../../dist/cron-store.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const START = new Date("2026-09-25T11:14:00.000Z");

async function fixture(run: ConstructorParameters<typeof CronScheduler>[0]["run"]) {
  const directory = await mkdtemp(join(tmpdir(), "dragons-cron-"));
  const store = createFileCronTaskStore(directory);
  let now = START;
  const scheduler = new CronScheduler({ store, run, now: () => now, createId: () => ID });
  return { directory, store, scheduler, advance: (value: string) => { now = new Date(value); } };
}

test("cron tasks persist UTC recurrence and skip replay after a restart", async () => {
  const completed: string[] = [];
  const f = await fixture(async (task) => { completed.push(task.id); });
  try {
    const created = await f.scheduler.create({ workingDirectory: f.directory, prompt: "Summarize project safely.", skillId: "quick-notes", schedule: { kind: "cron", expression: "*/15 * * * *" } });
    assert.equal(created.nextRunAt, "2026-09-25T11:15:00.000Z");
    assert.equal(await f.scheduler.tick(), 0);
    f.advance("2026-09-25T11:15:00.000Z");
    assert.equal(await f.scheduler.tick(), 1);
    assert.deepEqual(completed, [ID]);
    assert.equal((await f.store.load(ID))?.nextRunAt, "2026-09-25T11:30:00.000Z");
    assert.equal(await f.scheduler.tick(), 0);
    const restored = new CronScheduler({ store: createFileCronTaskStore(f.directory), now: () => new Date("2026-09-25T11:15:00Z"), run: async () => { throw new Error("replayed after restart"); } });
    assert.equal(await restored.tick(), 0);
    assert.equal((await restored.list()).length, 1);
    assert.equal(JSON.parse(await readFile(join(f.directory, `${ID}.json`), "utf8")).skillId, "quick-notes");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("one-off tasks run once, and pause/resume/manual triggers preserve cadence", async () => {
  const completed: string[] = [];
  const f = await fixture(async (task) => { completed.push(task.id); });
  try {
    await f.scheduler.create({ workingDirectory: f.directory, prompt: "Report status.", schedule: { kind: "once", at: "2026-09-25T11:15:00.000Z" } });
    assert.equal((await f.scheduler.pause(ID))?.state, "paused");
    assert.equal(await f.scheduler.tick(), 0);
    assert.equal(await f.scheduler.trigger(ID), true);
    assert.equal((await f.store.load(ID))?.state, "paused");
    assert.equal((await f.scheduler.resume(ID))?.state, "active");
    f.advance("2026-09-25T11:15:00.000Z");
    assert.equal(await f.scheduler.tick(), 1);
    assert.equal(await f.scheduler.trigger(ID), false);
    assert.equal((await f.store.load(ID))?.state, "finished");
    assert.deepEqual(completed, [ID, ID]);
    assert.equal(await f.scheduler.remove(ID), true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("cron scheduler skips a stale due slot rather than replaying downtime", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls += 1; });
  try {
    await f.scheduler.create({ workingDirectory: f.directory, prompt: "Safe report.", schedule: { kind: "cron", expression: "0 12 * * *" } });
    f.advance("2026-09-28T12:05:00.000Z");
    assert.equal(await f.scheduler.tick(), 0);
    assert.equal(calls, 0);
    assert.equal((await f.store.load(ID))?.nextRunAt, "2026-09-29T12:00:00.000Z");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("failed runs are reserved before execution and never replayed across hosts", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls += 1; throw new Error("provider unavailable"); });
  try {
    await f.scheduler.create({ workingDirectory: f.directory, prompt: "Safe report.", schedule: { kind: "cron", expression: "* * * * *" } });
    f.advance("2026-09-25T11:15:00.000Z");
    await assert.rejects(f.scheduler.tick(), /provider unavailable/);
    assert.equal(calls, 1);
    const other = new CronScheduler({ store: createFileCronTaskStore(f.directory), now: () => new Date("2026-09-25T11:15:00Z"), run: async () => { calls += 1; } });
    assert.equal(await other.tick(), 0);
    assert.equal(calls, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a failed due task is reported without delaying a sibling due task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-cron-"));
  const store = createFileCronTaskStore(directory);
  const ids = [ID, OTHER];
  const ran: string[] = [];
  const errors: string[] = [];
  let now = START;
  const scheduler = new CronScheduler({ store, now: () => now, createId: () => ids.shift()!,
    run: async (task) => { ran.push(task.id); if (task.id === ID) throw new Error("first task failed"); } });
  try {
    for (const prompt of ["First task.", "Second task."]) await scheduler.create({
      workingDirectory: directory, prompt, schedule: { kind: "cron", expression: "* * * * *" },
    });
    now = new Date("2026-09-25T11:15:00.000Z");
    assert.equal(await scheduler.tick((error) => { errors.push((error as Error).message); }), 1);
    assert.deepEqual(ran, [ID, OTHER]);
    assert.deepEqual(errors, ["first task failed"]);
    assert.equal(await scheduler.tick(), 0);
    assert.equal((await store.load(ID))?.nextRunAt, "2026-09-25T11:16:00.000Z");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shutdown cancellation is not reported as a failed scheduled run", async () => {
  const errors: unknown[] = [];
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(async (_task, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });
  try {
    await f.scheduler.create({ workingDirectory: f.directory, prompt: "Read only.", schedule: { kind: "cron", expression: "* * * * *" } });
    f.advance("2026-09-25T11:15:00.000Z");
    const tick = f.scheduler.tick((error) => errors.push(error));
    await entered;
    await f.scheduler.stop();
    assert.equal(await tick, 0);
    assert.deepEqual(errors, []);
    assert.equal((await f.store.load(ID))?.nextRunAt, "2026-09-25T11:16:00.000Z");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("stopping while listing due tasks prevents a late scheduled run", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls += 1; });
  try {
    await f.scheduler.create({ workingDirectory: f.directory, prompt: "Safe report.", schedule: { kind: "cron", expression: "* * * * *" } });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const scheduler = new CronScheduler({
      store: { ...f.store, async list() { entered(); await blocked; return f.store.list(); } },
      run: async () => { calls += 1; },
      now: () => new Date("2026-09-25T11:15:00.000Z"),
    });
    const tick = scheduler.tick();
    await waiting;
    const stop = scheduler.stop();
    release();
    assert.equal(await tick, 0);
    await stop;
    assert.equal(await scheduler.tick(), 0);
    assert.equal(calls, 0);
    assert.equal((await f.store.load(ID))?.nextRunAt, "2026-09-25T11:15:00.000Z");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("stopping during a durable reservation waits and never starts the model afterward", async () => {
  const f = await fixture(async () => undefined);
  try {
    await f.scheduler.create({ workingDirectory: f.directory, prompt: "Safe report.", schedule: { kind: "cron", expression: "* * * * *" } });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const scheduler = new CronScheduler({
      store: { ...f.store, async save(task, revision) { entered(); await blocked; return f.store.save(task, revision); } },
      run: async () => { calls += 1; },
      now: () => new Date("2026-09-25T11:15:00.000Z"),
    });
    const tick = scheduler.tick();
    await waiting;
    const stop = scheduler.stop();
    release();
    assert.equal(await tick, 0);
    await stop;
    assert.equal(calls, 0);
    assert.equal((await f.store.load(ID))?.nextRunAt, "2026-09-25T11:16:00.000Z");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("cron storage rejects credential prompts, corrupted records, symlinks and stale revisions", async () => {
  const f = await fixture(async () => undefined);
  try {
    await assert.rejects(f.scheduler.create({ workingDirectory: f.directory, prompt: "password: dangerous", schedule: { kind: "cron", expression: "* * * * *" } }), /invalid cron task/i);
    await f.scheduler.create({ workingDirectory: f.directory, prompt: "Safe report.", schedule: { kind: "cron", expression: "* * * * *" } });
    const task = (await f.store.load(ID))!;
    await f.scheduler.pause(ID);
    await assert.rejects(f.store.save(task, task.revision), /changed/);
    await writeFile(join(f.directory, `${OTHER}.json`), "{bad json");
    assert.equal((await f.store.list()).length, 1);
    await rm(join(f.directory, `${OTHER}.json`));
    try {
      await symlink(join(f.directory, `${ID}.json`), join(f.directory, `${OTHER}.json`));
      assert.equal((await f.store.list()).length, 1);
      await assert.rejects(f.store.load(OTHER), /unsafe/i);
    } catch (error: unknown) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Windows symlink creation depends on developer mode or administrator privilege.
    }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
