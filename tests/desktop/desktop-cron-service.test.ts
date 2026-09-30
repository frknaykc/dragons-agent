import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "../../dist/agent.js";
import { CronScheduler } from "../../dist/cron-scheduler.js";
import { createFileCronTaskStore, cronWorkspaceDirectory } from "../../dist/cron-store.js";
import { createDesktopCronService } from "../../dist/desktop/cron-service.js";

test("Desktop cron binds the active workspace, runs due READ work, and closes idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-cron-"));
  let service: Awaited<ReturnType<typeof createDesktopCronService>> | undefined;
  try {
    const workspace = join(root, "workspace");
    const other = join(root, "other");
    await mkdir(workspace);
    await mkdir(other);
    const cronRoot = join(root, "cron");
    const canonical = await realpath(workspace);
    const now = new Date("2027-01-01T00:00:00.000Z");
    const store = createFileCronTaskStore(cronWorkspaceDirectory(cronRoot, canonical));
    const creator = new CronScheduler({ store, run: async () => {}, now: () => now });
    const due = await creator.create({ workingDirectory: canonical, prompt: "Read status", schedule: { kind: "once", at: "2027-01-01T01:00:00.000Z" } });
    const otherStore = createFileCronTaskStore(cronWorkspaceDirectory(cronRoot, await realpath(other)));
    await new CronScheduler({ store: otherStore, run: async () => {}, now: () => now }).create({ workingDirectory: await realpath(other), prompt: "Other", schedule: { kind: "once", at: "2027-01-01T01:00:00.000Z" } });
    let calls = 0;
    const model: AgentModel = { async respond(request) {
      calls += 1;
      assert.ok(request.tools.every((tool) => tool.operation === "READ"));
      return { responseId: "done", text: "read-only result", toolCalls: [] };
    } };
    service = await createDesktopCronService({ profileCronRoot: cronRoot, workingDirectory: workspace, skillsDirectory: join(root, "skills"),
      createModel: () => model, now: () => new Date("2027-01-01T01:00:01.000Z") });
    // A timer is not needed for the startup tick. Wait only for the synchronous fake provider to settle.
    for (let attempt = 0; attempt < 100 && !(await service.command({ action: "status" })).includes("read-only result"); attempt += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    assert.match(await service.command({ action: "status" }), /read-only result/);
    assert.match(await service.command({ action: "list" }), new RegExp(due.id));
    assert.doesNotMatch(await service.command({ action: "list" }), /Other/);
    assert.equal((await store.load(due.id))?.state, "finished");
    await service.close();
    await service.close();
    await assert.rejects(service.command({ action: "list" }), /closed/);
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Desktop cron shutdown aborts an in-flight model and suppresses its late report", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-cron-stop-"));
  let service: Awaited<ReturnType<typeof createDesktopCronService>> | undefined;
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    const cronRoot = join(root, "cron");
    const now = new Date("2027-01-01T00:00:00.000Z");
    const store = createFileCronTaskStore(cronWorkspaceDirectory(cronRoot, canonical));
    await new CronScheduler({ store, run: async () => {}, now: () => now }).create({ workingDirectory: canonical, prompt: "Read status", schedule: { kind: "once", at: "2027-01-01T00:01:00.000Z" } });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let cancelled = false;
    service = await createDesktopCronService({ profileCronRoot: cronRoot, workingDirectory: workspace, skillsDirectory: join(root, "skills"),
      now: () => new Date("2027-01-01T00:01:01.000Z"), createModel: () => ({ async respond(request) {
        entered();
        await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
        return { responseId: "late", text: "must not surface", toolCalls: [] };
      } }) });
    await started;
    await service.close();
    assert.equal(cancelled, true);
    await assert.rejects(service.command({ action: "status" }), /closed/);
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Desktop startup keeps processing due jobs after one model fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-cron-failure-"));
  let service: Awaited<ReturnType<typeof createDesktopCronService>> | undefined;
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    const store = createFileCronTaskStore(cronWorkspaceDirectory(join(root, "cron"), canonical));
    const creator = new CronScheduler({ store, run: async () => {}, now: () => new Date("2027-01-01T00:00:00.000Z") });
    const tasks = [];
    for (const prompt of ["First", "Second"]) tasks.push(await creator.create({
      workingDirectory: canonical, prompt, schedule: { kind: "once", at: "2027-01-01T00:01:00.000Z" },
    }));
    let calls = 0;
    service = await createDesktopCronService({ profileCronRoot: join(root, "cron"), workingDirectory: workspace,
      skillsDirectory: join(root, "skills"), now: () => new Date("2027-01-01T00:01:01.000Z"),
      createModel: () => ({ async respond() {
        calls += 1;
        if (calls === 1) throw new Error("private provider failure");
        return { responseId: "done", text: "second finished", toolCalls: [] };
      } }),
    });
    for (let attempt = 0; attempt < 100 && !(await service.command({ action: "status" })).includes("second finished"); attempt += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const status = await service.command({ action: "status" });
    assert.equal(calls, 2);
    assert.match(status, /Failures: 1.*second finished/);
    assert.doesNotMatch(status, /private provider failure/);
    for (const task of tasks) assert.equal((await store.load(task.id))?.state, "finished");
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});
