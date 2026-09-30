import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFilePersistentGoalStore, inspectPersistentGoalLock, recoverAbandonedPersistentGoalLock } from "../../dist/persistent-goal-store.js";
import { PersistentGoalManager, type PersistentGoal, validatePersistentGoal } from "../../dist/persistent-goals.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-25T12:00:00.000Z";
const END = "2026-09-26T12:00:00.000Z";
function goal(id = ID): PersistentGoal {
  return { version: 1, id, sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Review open tasks.", criterion: "All tasks reviewed.", state: "ready", maxTurns: 3, turnsUsed: 0, createdAt: NOW, updatedAt: NOW, deadlineAt: END, revision: 0 };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dragons-goals-"));
  return { directory, store: createFilePersistentGoalStore(directory) };
}

test("goal records reject unknown fields, credentials, impossible budgets, and invalid state", () => {
  validatePersistentGoal(goal());
  for (const invalid of [
    { ...goal(), objective: "api_key: do-not-store-this" },
    { ...goal(), criterion: "password=do-not-store-this" },
    { ...goal(), maxTurns: 0 },
    { ...goal(), turnsUsed: 4 },
    { ...goal(), state: "running", turnsUsed: 0 },
    { ...goal(), state: "ready", turnsUsed: 3 },
    { ...goal(), deadlineAt: NOW },
    { ...goal(), continuation: { token: "private" } },
    { ...goal(), id: "../../outside" },
  ]) assert.throws(() => validatePersistentGoal(invalid), /Invalid persistent goal/);
});

test("goal store persists only bounded metadata, increments revisions, and rejects stale writers", async () => {
  const f = await fixture();
  try {
    const first = await f.store.save(goal());
    assert.equal(first.revision, 0);
    assert.deepEqual(await createFilePersistentGoalStore(f.directory).load(ID), first);
    const next = await f.store.save({ ...first, state: "running", turnsUsed: 1, updatedAt: END }, first.revision);
    assert.equal(next.revision, 1);
    assert.equal((await f.store.list()).length, 1);
    await assert.rejects(f.store.save(first, 0), /changed/);
    await assert.rejects(f.store.save(goal(), undefined), /changed/);
    assert.equal(JSON.parse(await readFile(join(f.directory, `${ID}.json`), "utf8")).state, "running");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("goal store ignores invalid records on list, fails closed on direct load and unsafe links", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "dragons-goal-outside-"));
  try {
    await f.store.save(goal());
    await writeFile(join(outside, "other.json"), JSON.stringify(goal(OTHER)));
    await symlink(join(outside, "other.json"), join(f.directory, `${OTHER}.json`));
    assert.deepEqual((await f.store.list()).map((item) => item.id), [ID]);
    await assert.rejects(f.store.load(OTHER), /Unsafe|Invalid/);
    await writeFile(join(f.directory, `${ID}.json`), "not json");
    assert.deepEqual(await f.store.list(), []);
    await assert.rejects(f.store.load(ID));
    await assert.rejects(f.store.save(goal(), 0));
    assert.equal(await f.store.load("../../outside"), undefined);
    await assert.rejects(f.store.save({ ...goal(), id: "../../outside" }));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("goal store rejects linked root, refuses contention and enforces record count", async () => {
  const f = await fixture();
  const link = `${f.directory}-link`;
  try {
    await symlink(f.directory, link, "dir");
    await assert.rejects(createFilePersistentGoalStore(link).save(goal()), /directory/);
    await writeFile(join(f.directory, ".persistent-goals.lock"), "occupied");
    await assert.rejects(f.store.save(goal()), /busy/);
    await rm(join(f.directory, ".persistent-goals.lock"));
    await f.store.save(goal());
    await assert.rejects(createFilePersistentGoalStore(f.directory, { maxGoals: 1 }).save(goal(OTHER)), /limit/);
    assert.equal((await f.store.list()).length, 1);
  } finally { await rm(link, { force: true }); await rm(f.directory, { recursive: true, force: true }); }
});

test("explicit goal lock recovery refuses a live owner, other host, malformed data and links", async () => {
  const f = await fixture();
  const lock = join(f.directory, ".persistent-goals.lock");
  const token = ID;
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token }));
    await assert.rejects(recoverAbandonedPersistentGoalLock(f.directory, token), /active/);
    await assert.rejects(f.store.save(goal()), /busy/);
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: "other-host", token }));
    await assert.rejects(recoverAbandonedPersistentGoalLock(f.directory, token), /host/);
    await writeFile(lock, JSON.stringify({ pid: process.pid, token }));
    await assert.rejects(recoverAbandonedPersistentGoalLock(f.directory, token), /Invalid/);
    await writeFile(lock, "invalid");
    await assert.rejects(recoverAbandonedPersistentGoalLock(f.directory, token));
    await rm(lock);
    await symlink(join(f.directory, "missing"), lock);
    await assert.rejects(recoverAbandonedPersistentGoalLock(f.directory, token));
    await assert.rejects(f.store.save(goal()), /busy/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("explicit goal lock recovery requires the exact token and a dead local owner", async () => {
  const f = await fixture();
  const lock = join(f.directory, ".persistent-goals.lock");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await once(child, "exit");
  try {
    await writeFile(lock, JSON.stringify({ pid, host: hostname(), token: ID }));
    await assert.rejects(recoverAbandonedPersistentGoalLock(f.directory, OTHER), /token/);
    await assert.rejects(f.store.save(goal()), /busy/);
    assert.equal(await recoverAbandonedPersistentGoalLock(f.directory, ID), true);
    assert.equal(await recoverAbandonedPersistentGoalLock(f.directory, ID), false);
    await f.store.save(goal());
    assert.equal((await f.store.load(ID))?.state, "ready");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("goal lock inspection is bounded and rejects unsafe or malformed lock records", async () => {
  const f = await fixture();
  const lock = join(f.directory, ".persistent-goals.lock");
  try {
    assert.equal(await inspectPersistentGoalLock(f.directory), undefined);
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: ID }));
    assert.deepEqual(await inspectPersistentGoalLock(f.directory), { pid: process.pid, host: hostname(), token: ID });
    await writeFile(lock, "invalid");
    await assert.rejects(inspectPersistentGoalLock(f.directory), /Invalid/);
    await rm(lock);
    await symlink(join(f.directory, "missing"), lock);
    await assert.rejects(inspectPersistentGoalLock(f.directory), /Unsafe/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("persistent goal reserves turns, evaluates via trusted host, and completes without extra runs", async () => {
  const f = await fixture();
  let calls = 0;
  const manager = new PersistentGoalManager({ store: f.store, now: () => new Date(NOW), createId: () => ID,
    runReadOnly: async () => ++calls, evaluateCompletion: async (_goal, result) => result === 2 });
  try {
    const created = await manager.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Review open tasks.", criterion: "All tasks reviewed.", maxTurns: 3, deadlineAt: END });
    assert.equal(created.state, "ready");
    assert.equal((await manager.advance(ID))?.state, "ready");
    assert.equal((await createFilePersistentGoalStore(f.directory).load(ID))?.turnsUsed, 1);
    assert.equal((await manager.advance(ID))?.state, "completed");
    assert.equal(await manager.advance(ID), undefined);
    assert.equal(calls, 2);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("persistent goal exhausts budget or deadline before another run", async () => {
  const f = await fixture();
  let now = new Date(NOW);
  let calls = 0;
  const manager = new PersistentGoalManager({ store: f.store, now: () => now, createId: () => ID,
    runReadOnly: async () => { calls += 1; }, evaluateCompletion: async () => false });
  try {
    await manager.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Read.", criterion: "Reviewed.", maxTurns: 1, deadlineAt: END });
    assert.equal((await manager.advance(ID))?.state, "exhausted");
    assert.equal(calls, 1);
    assert.equal(await manager.advance(ID), undefined);
    await f.store.save({ ...goal(OTHER), sessionId: ID });
    now = new Date(END);
    assert.equal((await manager.advance(OTHER))?.state, "exhausted");
    assert.equal(calls, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("failed evaluation pauses and consumes the reserved turn; restart never auto-replays", async () => {
  const f = await fixture();
  let calls = 0;
  const manager = new PersistentGoalManager({ store: f.store, now: () => new Date(NOW), createId: () => ID,
    runReadOnly: async () => { calls += 1; return "untrusted output"; },
    evaluateCompletion: async () => { throw new Error("evaluator failed"); } });
  try {
    await manager.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Read.", criterion: "Reviewed.", maxTurns: 2, deadlineAt: END });
    await assert.rejects(manager.advance(ID), /evaluator failed/);
    assert.equal((await f.store.load(ID))?.state, "paused");
    assert.equal((await f.store.load(ID))?.turnsUsed, 1);
    assert.equal(await manager.advance(ID), undefined);
    assert.equal(calls, 1);
    const restored = new PersistentGoalManager({ store: createFilePersistentGoalStore(f.directory), now: () => new Date(NOW),
      runReadOnly: async () => { calls += 1; }, evaluateCompletion: async () => false });
    assert.equal(await restored.advance(ID), undefined);
    assert.equal((await restored.resume(ID))?.state, "ready");
    assert.equal((await restored.advance(ID))?.state, "exhausted");
    assert.equal(calls, 2);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("concurrent hosts cannot start the same turn, and a stranded running state cannot be resumed", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const options = { store: f.store, now: () => new Date(NOW), createId: () => ID,
    runReadOnly: async () => { calls += 1; entered(); await blocked; }, evaluateCompletion: async () => false };
  const first = new PersistentGoalManager(options);
  try {
    await first.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Read.", criterion: "Reviewed.", maxTurns: 2, deadlineAt: END });
    const active = first.advance(ID);
    await waiting;
    const second = new PersistentGoalManager({ ...options, store: createFilePersistentGoalStore(f.directory) });
    assert.equal(await second.resume(ID), undefined);
    assert.equal(await second.advance(ID), undefined);
    assert.equal((await f.store.load(ID))?.state, "running");
    release();
    assert.equal((await active)?.state, "ready");
    assert.equal(calls, 1);
  } finally { release(); await rm(f.directory, { recursive: true, force: true }); }
});

test("cancellation seals the reserved turn without storing output or permitting a replay", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const manager = new PersistentGoalManager({ store: f.store, now: () => new Date(NOW), createId: () => ID,
    runReadOnly: async (_goal, signal) => { entered(); await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }); }, evaluateCompletion: async () => true });
  try {
    await manager.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Read.", criterion: "Reviewed.", maxTurns: 2, deadlineAt: END });
    const active = manager.advance(ID, controller.signal);
    await waiting;
    controller.abort();
    await assert.rejects(active, /cancelled/);
    assert.equal((await f.store.load(ID))?.turnsUsed, 1);
    assert.equal((await f.store.load(ID))?.state, "interrupted");
    assert.equal(await manager.resume(ID), undefined);
    assert.equal(await manager.advance(ID), undefined);
    assert.equal((await readFile(join(f.directory, `${ID}.json`), "utf8")).includes("cancelled"), false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("explicitly marking a stranded turn interrupted never replays it or lets an old host overwrite recovery", async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let evaluated = false;
  const first = new PersistentGoalManager({ store: f.store, now: () => new Date(NOW), createId: () => ID,
    runReadOnly: async () => { entered(); await blocked; }, evaluateCompletion: async () => { evaluated = true; return true; } });
  try {
    await first.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Read.", criterion: "Reviewed.", maxTurns: 2, deadlineAt: END });
    const active = first.advance(ID);
    await waiting;
    const recovered = new PersistentGoalManager({ store: createFilePersistentGoalStore(f.directory), now: () => new Date(NOW),
      runReadOnly: async () => assert.fail("stranded turn replayed"), evaluateCompletion: async () => true });
    assert.equal((await recovered.markInterrupted(ID))?.state, "interrupted");
    assert.equal(await recovered.markInterrupted(ID), undefined);
    assert.equal(await recovered.advance(ID), undefined);
    assert.equal(await recovered.resume(ID), undefined);
    release();
    await assert.rejects(active, /changed/);
    assert.equal(evaluated, false);
    assert.equal((await f.store.load(ID))?.state, "interrupted");
    assert.equal((await f.store.load(ID))?.turnsUsed, 1);
  } finally { release(); await rm(f.directory, { recursive: true, force: true }); }
});

test("deadline reached during a turn cannot be bypassed by a positive evaluator", async () => {
  const f = await fixture();
  let now = new Date(NOW);
  const manager = new PersistentGoalManager({ store: f.store, now: () => now, createId: () => ID,
    runReadOnly: async () => { now = new Date(END); }, evaluateCompletion: async () => true });
  try {
    await manager.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Read.", criterion: "Reviewed.", maxTurns: 2, deadlineAt: END });
    assert.equal((await manager.advance(ID))?.state, "exhausted");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("only an explicit trusted host can complete a settled goal after at least one turn", async () => {
  const f = await fixture();
  const manager = new PersistentGoalManager({ store: f.store, now: () => new Date(NOW), createId: () => ID,
    runReadOnly: async () => "model claims done", evaluateCompletion: async () => false });
  try {
    await manager.create({ sessionId: OTHER, workingDirectory: "/trusted/workspace", objective: "Review.", criterion: "Confirmed by user.", maxTurns: 2, deadlineAt: END });
    assert.equal(await manager.complete(ID), undefined);
    assert.equal((await manager.advance(ID))?.state, "ready");
    assert.equal((await manager.complete(ID))?.state, "completed");
    assert.equal(await manager.complete(ID), undefined);
    assert.equal(await manager.advance(ID), undefined);
    assert.equal((await f.store.load(ID))?.turnsUsed, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
