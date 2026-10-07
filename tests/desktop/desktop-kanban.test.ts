import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveDragonsConfig } from "../../dist/config.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import type { DesktopLocalControls } from "../../dist/desktop/bridge.js";
import { createDesktopRuntime, desktopLocalControls } from "../../dist/desktop/host.js";
import { createFileKanbanBoard, inspectKanbanLaneLock, inspectKanbanLock,
  kanbanWorkspaceDirectory } from "../../dist/kanban.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

const idPattern = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i;

async function text(bridge: DesktopBridge, content: string): Promise<string> {
  const reply = await bridge.request({ type: "slash", content });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  if (!reply.ok) throw new Error("Missing reply.");
  const value = reply.value as { kind: string; text: string };
  assert.equal(value.kind, "text");
  return value.text;
}

test("Desktop Kanban shares a workspace board but binds writes to each host profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-kanban-"));
  const workspace = await realpath(root);
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const bridges: DesktopBridge[] = [];
  const controls: DesktopLocalControls[] = [];
  try {
    for (const name of ["alpha", "beta"]) {
      const profile = await profiles.create(name);
      await saveDragonsConfig({ provider: "local", model: "fixture" }, profile.configPath);
      const runtime = await createDesktopRuntime(workspace, { configPath, profileName: name });
      const local = desktopLocalControls(runtime);
      assert.ok(local);
      controls.push(local);
      bridges.push(new DesktopBridge(runtime, () => assert.fail("Board operations must not run a model."), local));
    }
    const [alpha, beta] = bridges as [DesktopBridge, DesktopBridge];
    assert.match(await text(alpha, "/help kanban"), /\/kanban/);
    const choices = await alpha.request({ type: "choices", content: "/kan" });
    assert.equal(choices.ok, true);
    assert.match(JSON.stringify(choices), /\/kanban/);
    assert.equal(await text(alpha, "/kanban list"), "No Kanban tasks in this workspace.");
    assert.deepEqual(await alpha.request({ type: "kanban_board" }), { ok: true, value: [] });
    assert.equal((await alpha.request({ type: "kanban_board", actor: "beta" })).ok, false);
    assert.match(await text(alpha, "/kanban add INVALID -- Title"), /Usage: \/kanban/);
    const handoffCreated = await text(alpha, "/kanban add alpha -- Hand off");
    const handoffId = handoffCreated.match(idPattern)?.[0];
    assert.ok(handoffId);
    assert.match(await text(alpha, `/kanban handoff offer ${handoffId} 0 beta`), /handoff offered to beta/);
    assert.equal((await alpha.request({ type: "slash", content: `/kanban handoff accept ${handoffId} 1` })).ok, false);
    assert.match(await text(beta, `/kanban handoff accept ${handoffId} 1`), /revision 2/);
    const created = await text(alpha, "/kanban add beta -- Review changes");
    const id = created.match(idPattern)?.[0];
    assert.ok(id);
    const snapshot = await beta.request({ type: "kanban_board" });
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.ok && (snapshot.value as { title: string; assignee: string; revision: number }[])
      .map(({ title, assignee, revision }) => ({ title, assignee, revision })),
    [{ title: "Hand off", assignee: "beta", revision: 2 }, { title: "Review changes", assignee: "beta", revision: 0 }]);
    assert.match(await text(beta, "/kanban list"), new RegExp(id));
    assert.match(await text(beta, `/kanban status ${id}`), /Creator: alpha/);
    assert.deepEqual(await beta.request({ type: "slash", content: `/kanban assign ${id} 0 alpha` }),
      { ok: false, error: { code: "RUNTIME_ERROR", message: "Desktop runtime request failed." } });
    assert.match(await text(beta, `/kanban progress ${id} 0 doing 25`), /revision 1 doing 25% assignee beta/);
    assert.deepEqual(await alpha.request({ type: "slash", content: `/kanban progress ${id} 1 done 100` }),
      { ok: false, error: { code: "RUNTIME_ERROR", message: "Desktop runtime request failed." } });
    assert.deepEqual(await alpha.request({ type: "slash", content: `/kanban assign ${id} 1 alpha` }),
      { ok: false, error: { code: "RUNTIME_ERROR", message: "Desktop runtime request failed." } });
    assert.match(await text(beta, `/kanban status ${id}`), /revision 1 doing 25% assignee beta/);
    assert.match(await text(beta, `/kanban progress ${id} 1 done 100`), /revision 2 done 100%/);
    const idle = await text(alpha, "/kanban add beta -- Idle reassignment");
    const idleId = idle.match(idPattern)?.[0];
    assert.ok(idleId);
    assert.match(await text(alpha, `/kanban assign ${idleId} 0 alpha`), /revision 1/);
    assert.match(await text(beta, "/kanban list"), /done 100%/);
    const closed = await alpha.close();
    assert.equal(closed, undefined);
    await assert.rejects(controls[0]!.kanban!({ action: "list" }), /closed/);
    assert.deepEqual(await alpha.request({ type: "slash", content: "/kanban list" }),
      { ok: false, error: { code: "CLOSED", message: "Desktop bridge is closed." } });
    assert.equal((await alpha.request({ type: "kanban_board" })).ok, false);
  } finally {
    await Promise.all(bridges.map((bridge) => bridge.close()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop exposes worker ownership metadata without claim credentials or progress bypass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-kanban-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const profile = await profiles.create("alpha");
  await saveDragonsConfig({ provider: "local", model: "fixture" }, profile.configPath);
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, workspace), profiles);
  const task = await board.create("alpha", "Owned", "alpha", []);
  const claim = await board.claimWorker("alpha", task.id, 0);
  const runtime = await createDesktopRuntime(workspace, { configPath, profileName: "alpha" });
  const bridge = new DesktopBridge(runtime, () => assert.fail("Board must not invoke model."), desktopLocalControls(runtime));
  try {
    const snapshot = await bridge.request({ type: "kanban_board" });
    assert.equal(snapshot.ok, true);
    assert.equal(JSON.stringify(snapshot).includes(claim.token), false);
    assert.equal(JSON.stringify(snapshot).includes("workerClaim"), false);
    assert.match(JSON.stringify(snapshot), /"worker":\{"profile":"alpha"/);
    assert.equal((await bridge.request({ type: "slash", content: `/kanban progress ${task.id} 1 done 100` })).ok, false);
    assert.match(await text(bridge, `/kanban worker recover ${task.id} 1 ${process.pid}`), /confirm RECOVER/);
    assert.equal((await bridge.request({ type: "slash", content: "/kanban worker confirm RECOVER" })).ok, false);
    assert.equal((await board.get("alpha", task.id))?.status, "doing");
    await board.releaseWorker("alpha", task.id, claim.task.revision, claim.token);
    assert.match(await text(bridge, `/kanban status ${task.id}`), /blocked/);
  } finally { await bridge.close(); }
});

test("Desktop Kanban lock recovery needs an inspected lock and a separate typed confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-kanban-lock-"));
  const workspace = await realpath(root);
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  let bridge: DesktopBridge | undefined;
  try {
    const profile = await profiles.create("alpha");
    await saveDragonsConfig({ provider: "local", model: "fixture" }, profile.configPath);
    const runtime = await createDesktopRuntime(workspace, { configPath, profileName: "alpha" });
    bridge = new DesktopBridge(runtime, () => assert.fail("Lock commands must not run a model."), desktopLocalControls(runtime));
    const directory = kanbanWorkspaceDirectory(configPath, workspace);
    assert.match(await text(bridge, "/kanban lock status"), /No Kanban lock/);
    assert.match(await text(bridge, "/kanban lock confirm RECOVER"), /not pending/i);
    await text(bridge, "/kanban add alpha -- Seed board");
    const lockPath = join(directory, ".kanban.lock");
    const token = randomUUID();
    const save = (pid: number, host = hostname(), value = token) =>
      writeFile(lockPath, JSON.stringify({ pid, host, token: value }));
    await save(999999999);
    assert.match(await text(bridge, "/kanban lock status"), /PID 999999999/);
    assert.doesNotMatch(await text(bridge, "/kanban lock status"), new RegExp(token));
    assert.match(await text(bridge, "/kanban lock confirm RECOVER"), /not pending/i);
    assert.match(await text(bridge, "/kanban lock recover"), /\/kanban lock confirm RECOVER/);
    assert.match(await text(bridge, "/kanban lock confirm DENY"), /Usage: \/kanban lock/);
    assert.match(await text(bridge, "/kanban lock confirm RECOVER"), /recovered/i);
    assert.equal(await inspectKanbanLock(directory), undefined);
    assert.match(await text(bridge, "/kanban lock confirm RECOVER"), /not pending/i);

    await save(process.pid);
    assert.match(await text(bridge, "/kanban lock recover"), /PID/);
    assert.equal((await bridge.request({ type: "slash", content: "/kanban lock confirm RECOVER" })).ok, false);
    assert.ok(await inspectKanbanLock(directory));
    await save(999999999, "other-host");
    assert.match(await text(bridge, "/kanban lock recover"), /PID/);
    assert.equal((await bridge.request({ type: "slash", content: "/kanban lock confirm RECOVER" })).ok, false);
    assert.ok(await inspectKanbanLock(directory));
    await save(999999999);
    assert.match(await text(bridge, "/kanban lock recover"), /PID/);
    await save(999999999, hostname(), randomUUID());
    assert.equal((await bridge.request({ type: "slash", content: "/kanban lock confirm RECOVER" })).ok, false);
    assert.ok(await inspectKanbanLock(directory));
  } finally {
    await bridge?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop lane lock recovery is bounded, single-use, token-checked and distinct from board recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-kanban-lane-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const profile = await profiles.create("alpha");
  await saveDragonsConfig({ provider: "local", model: "fixture" }, profile.configPath);
  const runtime = await createDesktopRuntime(workspace, { configPath, profileName: "alpha" });
  const bridge = new DesktopBridge(runtime, () => assert.fail("Lock commands must not run a model."), desktopLocalControls(runtime));
  t.after(() => bridge.close());
  const directory = kanbanWorkspaceDirectory(configPath, workspace);
  await text(bridge, "/kanban add alpha -- Seed board");
  const lockPath = join(directory, ".kanban-lane.lock");
  const token = randomUUID();
  const save = (pid: number, host = hostname(), value = token) =>
    writeFile(lockPath, JSON.stringify({ pid, host, token: value }));
  assert.match(await text(bridge, "/kanban lane lock status"), /No Kanban lane lock/);
  assert.match(await text(bridge, "/kanban lane lock confirm RECOVER"), /not pending/);
  await save(999999999);
  const status = await text(bridge, "/kanban lane lock status");
  assert.match(status, /PID 999999999/);
  assert.doesNotMatch(status, new RegExp(token));
  assert.match(await text(bridge, "/kanban lane lock confirm NO"), /Usage: \/kanban lane lock/);
  assert.match(await text(bridge, "/kanban lane lock recover"), /confirm RECOVER within 60 seconds/);
  assert.match(await text(bridge, "/kanban lock confirm RECOVER"), /not pending/);
  assert.match(await text(bridge, "/kanban lane lock confirm RECOVER"), /recovered/);
  assert.equal(await inspectKanbanLaneLock(directory), undefined);
  assert.match(await text(bridge, "/kanban lane lock confirm RECOVER"), /not pending/);

  await save(999999999);
  await text(bridge, "/kanban lane lock recover");
  await text(bridge, "/kanban lane lock status");
  assert.match(await text(bridge, "/kanban lane lock confirm RECOVER"), /not pending/);
  await text(bridge, "/kanban lane lock recover");
  await save(999999999, hostname(), randomUUID());
  assert.equal((await bridge.request({ type: "slash", content: "/kanban lane lock confirm RECOVER" })).ok, false);
  assert.ok(await inspectKanbanLaneLock(directory));

  await save(999999999);
  await text(bridge, "/kanban lane lock recover");
  const clock = Date.now();
  const mockClock = t.mock.method(Date, "now", () => clock + 61_000);
  try {
    assert.match(await text(bridge, "/kanban lane lock confirm RECOVER"), /not pending/);
  } finally {
    mockClock.mock.restore();
  }
  assert.ok(await inspectKanbanLaneLock(directory));

  await save(process.pid);
  await text(bridge, "/kanban lane lock recover");
  assert.equal((await bridge.request({ type: "slash", content: "/kanban lane lock confirm RECOVER" })).ok, false);
  await save(999999999, "other-host");
  await text(bridge, "/kanban lane lock recover");
  assert.equal((await bridge.request({ type: "slash", content: "/kanban lane lock confirm RECOVER" })).ok, false);
  assert.ok(await inspectKanbanLaneLock(directory));
});

test("Desktop worker claim recovery is profile-bound, single-use and revision-checked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-kanban-worker-recover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const bridges: DesktopBridge[] = [];
  try {
    for (const name of ["alpha", "beta"]) {
      const profile = await profiles.create(name);
      await saveDragonsConfig({ provider: "local", model: "fixture" }, profile.configPath);
      const runtime = await createDesktopRuntime(workspace, { configPath, profileName: name });
      bridges.push(new DesktopBridge(runtime, () => assert.fail("Worker recovery must not run a model."), desktopLocalControls(runtime)));
    }
    const [alpha, beta] = bridges as [DesktopBridge, DesktopBridge];
    const directory = kanbanWorkspaceDirectory(configPath, workspace);
    const board = createFileKanbanBoard(directory, profiles);
    const task = await board.create("alpha", "Review after crash", "beta", []);
    const claim = await board.claimWorker("beta", task.id, task.revision);
    const recover = (pid: number, revision = claim.task.revision) => `/kanban worker recover ${task.id} ${revision} ${pid}`;
    assert.match(await text(beta, "/kanban worker confirm RECOVER"), /not pending/i);
    assert.equal((await alpha.request({ type: "slash", content: recover(process.pid) })).ok, false);
    assert.match(await text(beta, recover(process.pid)), /\/kanban worker confirm RECOVER within 60 seconds/);
    assert.match(await text(beta, "/kanban worker confirm DENY"), /Usage: \/kanban worker/);
    assert.equal((await beta.request({ type: "slash", content: "/kanban worker confirm RECOVER" })).ok, false);
    assert.match(await text(beta, "/kanban worker confirm RECOVER"), /not pending/i);
    assert.equal((await board.get("beta", task.id))?.status, "doing");
    assert.match(await text(beta, recover(process.pid)), /confirm RECOVER/);
    const clock = Date.now();
    const mockClock = t.mock.method(Date, "now", () => clock + 61_000);
    assert.match(await text(beta, "/kanban worker confirm RECOVER"), /not pending/i);
    mockClock.mock.restore();
    assert.equal((await board.get("beta", task.id))?.status, "doing");

    const boardPath = join(directory, "board.json");
    const persisted = JSON.parse(await readFile(boardPath, "utf8")) as { tasks: Array<{ workerClaim: { pid: number } }> };
    persisted.tasks[0]!.workerClaim.pid = 999999999;
    await writeFile(boardPath, JSON.stringify(persisted));
    assert.equal((await beta.request({ type: "slash", content: recover(process.pid) })).ok, false);
    assert.match(await text(beta, recover(999999999)), /PID 999999999/);
    persisted.tasks[0]!.workerClaim.pid = process.pid;
    await writeFile(boardPath, JSON.stringify(persisted));
    assert.equal((await beta.request({ type: "slash", content: "/kanban worker confirm RECOVER" })).ok, false);
    assert.match(await text(beta, "/kanban worker confirm RECOVER"), /not pending/i);
    persisted.tasks[0]!.workerClaim.pid = 999999999;
    await writeFile(boardPath, JSON.stringify(persisted));
    assert.match(await text(beta, recover(999999999)), /PID 999999999/);
    const confirmed = await text(beta, "/kanban worker confirm RECOVER");
    assert.match(confirmed, /blocked/);
    assert.doesNotMatch(confirmed, new RegExp(claim.token));
    assert.match(await text(beta, "/kanban worker confirm RECOVER"), /not pending/i);
    assert.equal((await board.get("beta", task.id))?.worker, undefined);
    assert.equal((await board.get("beta", task.id))?.revision, 2);
    assert.equal((await beta.request({ type: "slash", content: recover(999999999) })).ok, false);
  } finally { await Promise.all(bridges.map((bridge) => bridge.close())); }
});
