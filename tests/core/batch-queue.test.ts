import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { batchWorkspaceDirectory, createFileBatchQueue, inspectBatchLock, recoverAbandonedBatchLock } from "../../dist/batch-queue.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dragons-batch-queue-"));
  const directory = batchWorkspaceDirectory(root, join(root, "workspace"));
  const queue = createFileBatchQueue(directory, join(root, "workspace"));
  return { root, directory, queue, async close() { await rm(root, { recursive: true, force: true }); } };
}

test("batch queue reserves a bounded budget and persists each result with CAS checkpoints", async () => {
  const f = await fixture();
  try {
    const batch = await f.queue.create(["Inspect alpha", "Inspect beta", "Inspect gamma"], 2);
    assert.equal(batch.revision, 0);
    assert.equal((await f.queue.list()).length, 1);
    const other = createFileBatchQueue(f.directory, join(f.root, "workspace"));
    const first = await other.reserve(batch.id, 0);
    assert.equal(first?.tasks[0]?.state, "running");
    await assert.rejects(() => f.queue.reserve(batch.id, 0), /changed/);
    assert.equal(await f.queue.reserve(batch.id, first!.revision), undefined);
    const saved = await f.queue.finish(batch.id, first!.tasks[0]!.id, first!.revision, "completed", "alpha report", first!.tasks[0]!.owner?.token);
    assert.equal(saved.tasks[0]?.result, "alpha report");
    await assert.rejects(() => f.queue.finish(batch.id, first!.tasks[0]!.id, first!.revision, "completed", "late"), /changed/);
    const second = await other.reserve(batch.id, saved.revision);
    assert.equal(second?.tasks[1]?.state, "running");
    const done = await f.queue.finish(batch.id, second!.tasks[1]!.id, second!.revision, "completed", "beta report", second!.tasks[1]!.owner?.token);
    assert.equal(done.runsUsed, 2);
    assert.equal(await other.reserve(batch.id, done.revision), undefined);
    assert.equal((await other.load(batch.id))?.tasks[2]?.state, "queued");
    assert.equal((await readFile(join(f.directory, `${batch.id}.json`), "utf8")).includes("alpha report"), true);
  } finally { await f.close(); }
});

test("interrupted and failed reservations cannot replay or start later queued tasks", async () => {
  const f = await fixture();
  try {
    const batch = await f.queue.create(["a", "b"], 2);
    const claimed = (await f.queue.reserve(batch.id, batch.revision))!;
    assert.equal(await createFileBatchQueue(f.directory, join(f.root, "workspace")).reserve(batch.id, claimed.revision), undefined);
    const interrupted = await f.queue.finish(batch.id, claimed.tasks[0]!.id, claimed.revision, "interrupted", undefined, claimed.tasks[0]!.owner?.token);
    assert.equal(await f.queue.reserve(batch.id, interrupted.revision), undefined);
    assert.equal(interrupted.tasks[1]?.state, "queued");
    await assert.rejects(() => f.queue.finish(batch.id, interrupted.tasks[0]!.id, interrupted.revision, "completed", "late"), /running/);
  } finally { await f.close(); }
});

test("batch queue rejects credential-shaped prompts, oversize output and foreign workspace records", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.queue.create(["api_key=not-for-storage"], 1), /prompt/);
    await assert.rejects(() => f.queue.create(Array(9).fill("task"), 9), /tasks/);
    const batch = await f.queue.create(["task"], 1);
    const claimed = (await f.queue.reserve(batch.id, batch.revision))!;
    await assert.rejects(() => f.queue.finish(batch.id, claimed.tasks[0]!.id, claimed.revision, "completed", "x".repeat(2001), claimed.tasks[0]!.owner?.token), /result/);
    await assert.rejects(() => f.queue.finish(batch.id, claimed.tasks[0]!.id, claimed.revision, "completed", "Bearer fake-token", claimed.tasks[0]!.owner?.token), /result/);
    const other = createFileBatchQueue(f.directory, join(f.root, "other"));
    await assert.rejects(() => other.load(batch.id), /workspace/);
  } finally { await f.close(); }
});

test("batch queue rejects symlink swaps and unsafe records without following them", async (t) => {
  const f = await fixture();
  try {
    const batch = await f.queue.create(["task"], 1);
    const record = join(f.directory, `${batch.id}.json`);
    const original = await readFile(record, "utf8");
    await rm(record);
    try { await symlink(join(f.root, "outside.json"), record); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Symlink creation denied on this host."); return; }
      throw error;
    }
    await assert.rejects(() => f.queue.load(batch.id), /Unsafe/);
    await rm(record);
    await writeFile(record, original.replace('"runsUsed":0', '"runsUsed":99'));
    await assert.rejects(() => f.queue.load(batch.id), /Invalid/);
  } finally { await f.close(); }
});

test("batch queue serializes capacity check and does not delete a foreign lock", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 8; index++) await f.queue.create([`task ${index}`], 1);
    await assert.rejects(() => f.queue.create(["overflow"], 1), /limit/);
    await writeFile(join(f.directory, ".batch.lock"), "foreign", { flag: "wx" });
    await assert.rejects(() => f.queue.create(["later"], 1), /busy/);
    assert.equal(await readFile(join(f.directory, ".batch.lock"), "utf8"), "foreign");
  } finally { await f.close(); }
});

test("batch lock recovery requires an inspected token and a stopped same-host owner", async () => {
  const f = await fixture();
  try {
    await f.queue.create(["task"], 1);
    const lockPath = join(f.directory, ".batch.lock");
    const token = randomUUID();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), token }), { flag: "wx" });
    assert.deepEqual(await inspectBatchLock(f.directory), { pid: process.pid, host: hostname(), token });
    await assert.rejects(() => recoverAbandonedBatchLock(f.directory, token), /active/);
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, host: "other-host", token }));
    await assert.rejects(() => recoverAbandonedBatchLock(f.directory, token), /another host/);
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, host: hostname(), token }));
    await assert.rejects(() => recoverAbandonedBatchLock(f.directory, randomUUID()), /changed/);
    assert.equal(await recoverAbandonedBatchLock(f.directory, token), true);
    assert.equal(await inspectBatchLock(f.directory), undefined);
    assert.equal(await recoverAbandonedBatchLock(f.directory, token), false);
    assert.equal((await f.queue.list()).length, 1);
  } finally { await f.close(); }
});

test("batch lock recovery refuses invalid and symlinked lock files without deleting them", async (t) => {
  const f = await fixture();
  try {
    await f.queue.create(["task"], 1);
    const lockPath = join(f.directory, ".batch.lock");
    await writeFile(lockPath, "not-json", { flag: "wx" });
    await assert.rejects(() => inspectBatchLock(f.directory), /Invalid/);
    await rm(lockPath);
    const outside = join(f.root, "outside-lock");
    const token = randomUUID();
    await writeFile(outside, JSON.stringify({ pid: 2147483647, host: hostname(), token }));
    try { await symlink(outside, lockPath); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Symlink creation denied on this host."); return; }
      throw error;
    }
    await assert.rejects(() => inspectBatchLock(f.directory), /Unsafe/);
    await assert.rejects(() => recoverAbandonedBatchLock(f.directory, token), /Unsafe/);
    assert.equal((await readFile(outside, "utf8")).includes(token), true);
  } finally { await f.close(); }
});

test("orphaned batch reservation requires matching owner and stopped same-host process", async () => {
  const f = await fixture();
  try {
    const batch = await f.queue.create(["first", "second"], 2);
    const reserved = (await f.queue.reserve(batch.id, batch.revision))!;
    const task = reserved.tasks[0]!;
    const token = task.owner!.token;
    assert.equal(task.owner?.pid, process.pid);
    await assert.rejects(() => f.queue.finish(batch.id, task.id, reserved.revision, "completed", "no token"), /owner mismatch/);
    await assert.rejects(() => f.queue.recover(batch.id, task.id, reserved.revision, token), /still active/);
    const path = join(f.directory, `${batch.id}.json`);
    const orphan = structuredClone(reserved);
    orphan.tasks[0]!.owner!.pid = 2147483647;
    orphan.tasks[0]!.owner!.host = "other-host";
    await writeFile(path, `${JSON.stringify(orphan)}\n`);
    await assert.rejects(() => f.queue.recover(batch.id, task.id, reserved.revision, token), /another host/);
    orphan.tasks[0]!.owner!.host = hostname();
    await writeFile(path, `${JSON.stringify(orphan)}\n`);
    await assert.rejects(() => f.queue.recover(batch.id, task.id, reserved.revision, randomUUID()), /changed/);
    const done = await f.queue.recover(batch.id, task.id, reserved.revision, token);
    assert.deepEqual(done.tasks.map((entry) => entry.state), ["interrupted", "queued"]);
    assert.equal(done.tasks[0]?.owner, undefined);
    assert.equal(done.runsUsed, 1);
    assert.equal(done.revision, reserved.revision + 1);
    assert.equal(await f.queue.reserve(batch.id, done.revision), undefined);
    await assert.rejects(() => f.queue.recover(batch.id, task.id, reserved.revision, token), /changed/);
  } finally { await f.close(); }
});

test("legacy running batch without owner cannot be recovered automatically", async () => {
  const f = await fixture();
  try {
    const batch = await f.queue.create(["task"], 1);
    const running = (await f.queue.reserve(batch.id, batch.revision))!;
    const token = running.tasks[0]!.owner!.token;
    delete running.tasks[0]!.owner;
    await writeFile(join(f.directory, `${batch.id}.json`), `${JSON.stringify(running)}\n`);
    assert.equal((await f.queue.load(batch.id))?.tasks[0]?.state, "running");
    await assert.rejects(() => f.queue.recover(batch.id, running.tasks[0]!.id, running.revision, token), /cannot be verified/);
  } finally { await f.close(); }
});
