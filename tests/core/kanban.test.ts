import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileKanbanBoard, inspectKanbanLock, kanbanWorkspaceDirectory, recoverAbandonedKanbanLock } from "../../dist/kanban.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dragons-kanban-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  const directory = kanbanWorkspaceDirectory(configPath, root);
  return { root, directory, profiles, board: createFileKanbanBoard(directory, profiles) };
}

test("shared board persists cross-profile tasks, dependencies, progress and assignments", async (t) => {
  const { root, directory, profiles, board } = await fixture(t);
  const prerequisite = await board.create("alpha", "Review patch", "alpha", []);
  const task = await board.create("alpha", "Run checks", "beta", [prerequisite.id]);
  assert.deepEqual((await createFileKanbanBoard(directory, profiles).list("beta")).map((entry) => entry.id), [prerequisite.id, task.id]);
  await assert.rejects(board.updateProgress("beta", task.id, task.revision, "doing", 25), /dependencies/);
  await assert.rejects(board.updateProgress("alpha", task.id, task.revision, "doing", 25), /assignee/);
  const ready = await board.updateProgress("alpha", prerequisite.id, prerequisite.revision, "done", 100);
  assert.equal(ready.revision, 1);
  const active = await board.updateProgress("beta", task.id, task.revision, "doing", 50);
  assert.equal(active.progress, 50);
  const done = await board.updateProgress("beta", task.id, active.revision, "done", 100);
  assert.equal(done.status, "done");
  assert.deepEqual((await createFileKanbanBoard(directory, profiles).get("alpha", task.id))?.dependsOn, [prerequisite.id]);
  assert.equal((await readFile(join(directory, "board.json"), "utf8")).includes("Run checks"), true);
  assert.notEqual(kanbanWorkspaceDirectory(join(root, "profiles", "alpha", "config.json"), root), directory);
});

test("board rejects forged profiles, stale revisions, self/cyclic dependencies and state regression", async (t) => {
  const { board } = await fixture(t);
  await assert.rejects(board.create("forged", "Task", "alpha", []), /profile/);
  await assert.rejects(board.create("alpha", "Task", "forged", []), /profile/);
  const a = await board.create("alpha", "First", "alpha", []);
  const b = await board.create("alpha", "Second", "beta", [a.id]);
  await assert.rejects(board.addDependency("beta", a.id, a.revision, b.id), /creator/);
  await assert.rejects(board.addDependency("alpha", a.id, a.revision, a.id), /cycle/);
  await assert.rejects(board.addDependency("alpha", a.id, a.revision, b.id), /cycle/);
  await assert.rejects(board.addDependency("alpha", b.id, b.revision, "00000000-0000-4000-8000-000000000000"), /dependency/);
  await assert.rejects(board.updateProgress("alpha", a.id, a.revision, "done", 90), /100/);
  const done = await board.updateProgress("alpha", a.id, a.revision, "done", 100);
  await assert.rejects(board.updateProgress("alpha", a.id, done.revision, "doing", 90), /done/);
  await assert.rejects(board.assign("alpha", a.id, a.revision, "beta"), /revision/);
  const reassigned = await board.assign("alpha", b.id, b.revision, "alpha");
  assert.equal(reassigned.assignee, "alpha");
  assert.equal(done.createdBy, "alpha");
});

test("cross-profile handoff requires an assignee offer and a target acceptance", async (t) => {
  const { directory, profiles, board } = await fixture(t);
  const task = await board.create("alpha", "Review", "alpha", []);
  await assert.rejects(board.offerHandoff("beta", task.id, 0, "beta"), /assignee/);
  await assert.rejects(board.offerHandoff("alpha", task.id, 0, "unknown"), /profile/);
  await assert.rejects(board.offerHandoff("alpha", task.id, 0, "alpha"), /different/);
  const offered = await board.offerHandoff("alpha", task.id, 0, "beta");
  assert.equal(offered.handoffTo, "beta");
  assert.equal(offered.revision, 1);
  await assert.rejects(board.acceptHandoff("alpha", task.id, 1), /target/);
  await assert.rejects(board.updateProgress("alpha", task.id, 1, "doing", 10), /handoff/);
  const reopened = createFileKanbanBoard(directory, profiles);
  assert.equal((await reopened.get("beta", task.id))?.handoffTo, "beta");
  const accepted = await reopened.acceptHandoff("beta", task.id, 1);
  assert.equal(accepted.assignee, "beta");
  assert.equal(accepted.handoffTo, undefined);
  assert.equal(accepted.revision, 2);
  await assert.rejects(board.acceptHandoff("beta", task.id, 1), /revision/);
  await assert.rejects(board.updateProgress("alpha", task.id, 2, "doing", 10), /assignee/);
  assert.equal((await board.updateProgress("beta", task.id, 2, "doing", 10)).revision, 3);
  await assert.rejects(board.offerHandoff("beta", task.id, 3, "alpha"), /idle/);
});

test("handoff cancellation and creator reassignment invalidate old offers", async (t) => {
  const { board } = await fixture(t);
  const task = await board.create("alpha", "Review", "alpha", []);
  const offered = await board.offerHandoff("alpha", task.id, 0, "beta");
  const cancelled = await board.cancelHandoff("alpha", task.id, offered.revision);
  assert.equal(cancelled.handoffTo, undefined);
  await assert.rejects(board.acceptHandoff("beta", task.id, offered.revision), /revision/);
  const again = await board.offerHandoff("alpha", task.id, cancelled.revision, "beta");
  const reassigned = await board.assign("alpha", task.id, again.revision, "beta");
  assert.equal(reassigned.handoffTo, undefined);
  await assert.rejects(board.acceptHandoff("beta", task.id, again.revision), /revision/);
});

test("handoff acceptance serializes competing managers and rejects malformed persisted offers", async (t) => {
  const { directory, profiles, board } = await fixture(t);
  const task = await board.create("alpha", "Review", "alpha", []);
  const offer = await board.offerHandoff("alpha", task.id, 0, "beta");
  const other = createFileKanbanBoard(directory, profiles);
  const race = await Promise.allSettled([
    board.acceptHandoff("beta", task.id, offer.revision),
    other.cancelHandoff("alpha", task.id, offer.revision),
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await other.get("beta", task.id))?.handoffTo, undefined);
  const boardFile = join(directory, "board.json");
  const valid = await readFile(boardFile, "utf8");
  await writeFile(boardFile, JSON.stringify({ version: 1, tasks: [{ ...task, handoffTo: "!" }] }));
  await assert.rejects(other.list("beta"), /Invalid Kanban task/);
  await writeFile(boardFile, valid);
  assert.equal((await other.list("beta")).length, 1);
});

test("creator cannot silently reassign active work or mutate dependencies during a pending handoff", async (t) => {
  const { board } = await fixture(t);
  const working = await board.create("alpha", "Running", "beta", []);
  const active = await board.updateProgress("beta", working.id, 0, "doing", 25);
  await assert.rejects(board.assign("alpha", working.id, active.revision, "alpha"), /idle/);
  assert.equal((await board.get("alpha", working.id))?.assignee, "beta");
  const blocked = await board.updateProgress("beta", working.id, active.revision, "blocked", 25);
  await assert.rejects(board.assign("alpha", working.id, blocked.revision, "alpha"), /idle/);
  const partial = await board.updateProgress("beta", working.id, blocked.revision, "todo", 25);
  await assert.rejects(board.assign("alpha", working.id, partial.revision, "alpha"), /idle/);

  const offered = await board.create("alpha", "Transfer", "alpha", []);
  const pending = await board.offerHandoff("alpha", offered.id, 0, "beta");
  await assert.rejects(board.addDependency("alpha", offered.id, pending.revision, working.id), /handoff/);
  assert.deepEqual((await board.get("beta", offered.id))?.dependsOn, []);
  const reset = await board.assign("alpha", offered.id, pending.revision, "alpha");
  assert.equal(reset.handoffTo, undefined);
});

test("worker claim is exclusive, credential-free in board views, and fences stale completions", async (t) => {
  const { directory, profiles, board } = await fixture(t);
  const task = await board.create("alpha", "Review patch", "beta", []);
  const other = createFileKanbanBoard(directory, profiles);
  await assert.rejects(board.claimWorker("alpha", task.id, 0), /assignee/);
  const race = await Promise.allSettled([
    board.claimWorker("beta", task.id, 0), other.claimWorker("beta", task.id, 0),
  ]);
  const won = race.find((result) => result.status === "fulfilled");
  assert.ok(won && won.status === "fulfilled");
  const { token, task: claimed } = won.value;
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(claimed.status, "doing");
  assert.equal(claimed.worker?.profile, "beta");
  assert.equal(claimed.worker?.pid, process.pid);
  assert.equal(JSON.stringify(await other.list("alpha")).includes(token), false);
  assert.equal((await readFile(join(directory, "board.json"), "utf8")).includes(token), false);
  await assert.rejects(other.updateProgress("beta", task.id, claimed.revision, "done", 100), /worker claim/);
  await assert.rejects(other.assign("alpha", task.id, claimed.revision, "alpha"), /idle/);
  await assert.rejects(other.finishWorker("beta", task.id, claimed.revision, randomUUID()), /worker claim/);
  await assert.rejects(other.finishWorker("alpha", task.id, claimed.revision, token), /worker claim/);
  const done = await other.finishWorker("beta", task.id, claimed.revision, token);
  assert.equal(done.status, "done");
  assert.equal(done.progress, 100);
  assert.equal(done.worker, undefined);
  await assert.rejects(board.finishWorker("beta", task.id, claimed.revision, token), /revision/);
});

test("worker release is explicit and a crashed claim cannot be resumed implicitly", async (t) => {
  const { directory, profiles, board } = await fixture(t);
  const task = await board.create("alpha", "Fix tests", "alpha", []);
  const claim = await board.claimWorker("alpha", task.id, 0);
  const reopened = createFileKanbanBoard(directory, profiles);
  await assert.rejects(reopened.claimWorker("alpha", task.id, claim.task.revision), /idle/);
  await assert.rejects(reopened.releaseWorker("alpha", task.id, claim.task.revision, randomUUID()), /worker claim/);
  const released = await reopened.releaseWorker("alpha", task.id, claim.task.revision, claim.token);
  assert.equal(released.status, "blocked");
  assert.equal(released.worker, undefined);
  await assert.rejects(board.finishWorker("alpha", task.id, claim.task.revision, claim.token), /revision/);
  const resumed = await board.updateProgress("alpha", task.id, released.revision, "todo", 0);
  assert.equal((await board.claimWorker("alpha", task.id, resumed.revision)).task.status, "doing");
  const raw = await readFile(join(directory, "board.json"), "utf8");
  await writeFile(join(directory, "board.json"), raw.replace(/"digest":"[a-f0-9]{64}"/, '"digest":"broken"'));
  await assert.rejects(reopened.list("beta"), /Invalid Kanban task/);
});

test("worker cannot claim a pending handoff or unfinished dependency", async (t) => {
  const { board } = await fixture(t);
  const prerequisite = await board.create("alpha", "Prepare", "alpha", []);
  const task = await board.create("alpha", "Deliver", "alpha", [prerequisite.id]);
  const offered = await board.offerHandoff("alpha", task.id, 0, "beta");
  await assert.rejects(board.claimWorker("alpha", task.id, offered.revision), /handoff/);
  const accepted = await board.acceptHandoff("beta", task.id, offered.revision);
  await assert.rejects(board.claimWorker("beta", task.id, accepted.revision), /dependencies/);
  assert.equal((await board.get("alpha", task.id))?.revision, accepted.revision);
  await board.updateProgress("alpha", prerequisite.id, 0, "done", 100);
  assert.equal((await board.claimWorker("beta", task.id, accepted.revision)).task.status, "doing");
});

test("worker recovery requires matching ownership, revision and a verified stopped local process", async (t) => {
  const { directory, profiles, board } = await fixture(t);
  const task = await board.create("alpha", "Recover worker", "beta", []);
  const claim = await board.claimWorker("beta", task.id, task.revision);
  const other = createFileKanbanBoard(directory, profiles);
  await assert.rejects(other.recoverWorker("alpha", task.id, claim.task.revision, process.pid), /assignee/);
  await assert.rejects(other.recoverWorker("beta", task.id, task.revision, process.pid), /revision/);
  await assert.rejects(other.recoverWorker("beta", task.id, claim.task.revision, process.pid + 1), /changed/);
  await assert.rejects(other.recoverWorker("beta", task.id, claim.task.revision, process.pid), /still active/);
  assert.equal((await other.get("beta", task.id))?.status, "doing");

  const boardPath = join(directory, "board.json");
  const original = await readFile(boardPath, "utf8");
  const persisted = JSON.parse(original) as { tasks: Array<{ workerClaim: { pid: number; host: string } }> };
  persisted.tasks[0]!.workerClaim.pid = 999999999;
  persisted.tasks[0]!.workerClaim.host = "foreign-host";
  await writeFile(boardPath, JSON.stringify(persisted));
  await assert.rejects(other.recoverWorker("beta", task.id, claim.task.revision, 999999999), /another host/);
  persisted.tasks[0]!.workerClaim.host = hostname();
  await writeFile(boardPath, JSON.stringify(persisted));
  await assert.rejects(other.recoverWorker("beta", task.id, claim.task.revision, process.pid), /changed/);
  await assert.rejects(other.recoverWorker("beta", task.id, claim.task.revision, 0), /PID/);
  const originalKill = process.kill;
  process.kill = (() => { throw Object.assign(new Error("unknown"), { code: "EPERM" }); }) as typeof process.kill;
  try { await assert.rejects(other.recoverWorker("beta", task.id, claim.task.revision, 999999999), /cannot be verified/); }
  finally { process.kill = originalKill; }
  const attempts = await Promise.allSettled([
    other.recoverWorker("beta", task.id, claim.task.revision, 999999999),
    board.recoverWorker("beta", task.id, claim.task.revision, 999999999),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  const winner = attempts.find((entry) => entry.status === "fulfilled");
  assert.ok(winner && winner.status === "fulfilled");
  const blocked = winner.value;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.progress, 0);
  assert.equal(blocked.worker, undefined);
  assert.equal(blocked.revision, claim.task.revision + 1);
  await assert.rejects(board.finishWorker("beta", task.id, claim.task.revision, claim.token), /revision/);
  await assert.rejects(board.recoverWorker("beta", task.id, blocked.revision, 999999999), /claim/);
  const idle = await board.updateProgress("beta", task.id, blocked.revision, "todo", 0);
  assert.equal((await board.claimWorker("beta", task.id, idle.revision)).task.status, "doing");
});

test("board serializes concurrent writers and rejects linked or corrupted state without overwriting it", async (t) => {
  const { root, directory, profiles, board } = await fixture(t);
  const task = await board.create("alpha", "First", "alpha", []);
  const attempts = await Promise.allSettled([
    board.assign("alpha", task.id, task.revision, "beta"),
    createFileKanbanBoard(directory, profiles).assign("alpha", task.id, task.revision, "beta"),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await board.get("alpha", task.id))?.revision, 1);
  const boardPath = join(directory, "board.json");
  const original = await readFile(boardPath, "utf8");
  await writeFile(boardPath, JSON.stringify({ version: 1, tasks: [{ ...task, injected: "unexpected" }] }));
  await assert.rejects(board.list("alpha"), /Invalid Kanban/);
  await assert.rejects(board.create("alpha", "Second", "alpha", []), /Invalid Kanban/);
  await writeFile(boardPath, original);
  await rm(boardPath);
  const external = join(root, "outside.json");
  await writeFile(external, "not a board");
  await symlink(external, boardPath);
  await assert.rejects(board.list("alpha"), /Unsafe Kanban/);
  await assert.rejects(board.create("alpha", "Second", "alpha", []), /Unsafe Kanban/);
  assert.equal(await readFile(external, "utf8"), "not a board");
  await rm(boardPath);
  await rm(directory, { recursive: true });
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), directory);
  await assert.rejects(board.list("alpha"), /directory/);
});

test("board rejects oversized task metadata and workspace boundaries remain separate", async (t) => {
  const { root, directory, profiles, board } = await fixture(t);
  await assert.rejects(board.create("alpha", "x".repeat(300), "alpha", []), /title/);
  await assert.rejects(board.create("alpha", "escape\u001b[31m", "alpha", []), /title/);
  const other = createFileKanbanBoard(kanbanWorkspaceDirectory(join(root, "config.json"), join(root, "other")), profiles);
  await board.create("alpha", "In workspace", "alpha", []);
  assert.deepEqual(await other.list("alpha"), []);
  assert.equal((await board.list("alpha")).length, 1);
  assert.equal(directory.startsWith(join(root, "kanban")), true);
});

test("Kanban lock recovery is explicit, token-bound and rejects active, foreign, linked or malformed locks", async (t) => {
  const { root, directory, board } = await fixture(t);
  assert.equal(await inspectKanbanLock(directory), undefined);
  assert.equal(await recoverAbandonedKanbanLock(directory, randomUUID()), false);
  await board.create("alpha", "First", "alpha", []);
  const lockPath = join(directory, ".kanban.lock");
  const token = randomUUID();
  const save = async (pid: number, host = hostname(), value = token) =>
    writeFile(lockPath, JSON.stringify({ pid, host, token: value }));
  await save(process.pid);
  assert.deepEqual(await inspectKanbanLock(directory), { pid: process.pid, host: hostname(), token });
  await assert.rejects(recoverAbandonedKanbanLock(directory, token), /still active/);
  await save(999999999, "other-host");
  await assert.rejects(recoverAbandonedKanbanLock(directory, token), /another host/);
  await save(999999999);
  await assert.rejects(recoverAbandonedKanbanLock(directory, randomUUID()), /token changed/);
  await writeFile(lockPath, JSON.stringify({ pid: 999999999, token }));
  await assert.rejects(inspectKanbanLock(directory), /Invalid Kanban lock/);
  await rm(lockPath);
  const outside = join(root, "external-lock");
  await save(999999999);
  await link(lockPath, outside);
  await assert.rejects(recoverAbandonedKanbanLock(directory, token), /Unsafe Kanban lock/);
  await rm(outside);
  await rm(lockPath);
  await symlink(outside, lockPath);
  await assert.rejects(inspectKanbanLock(directory), /Unsafe Kanban lock/);
  await rm(lockPath);
  await save(999999999);
  const originalKill = process.kill;
  process.kill = (() => {
    const replacement = `${lockPath}.replacement`;
    writeFileSync(replacement, JSON.stringify({ pid: 999999999, host: hostname(), token }));
    renameSync(replacement, lockPath);
    throw Object.assign(new Error("dead"), { code: "ESRCH" });
  }) as typeof process.kill;
  try { await assert.rejects(recoverAbandonedKanbanLock(directory, token), /changed during recovery/); }
  finally { process.kill = originalKill; }
  assert.ok(await inspectKanbanLock(directory));
  assert.equal(await recoverAbandonedKanbanLock(directory, token), true);
  assert.equal(await inspectKanbanLock(directory), undefined);
  assert.equal((await board.list("beta")).length, 1);
});
