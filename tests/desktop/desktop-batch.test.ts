import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { batchWorkspaceDirectory, createFileBatchQueue, inspectBatchLock } from "../../dist/batch-queue.js";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import { createDesktopBatchService } from "../../dist/desktop/batch-service.js";
import { createDesktopRuntime, desktopLocalControls } from "../../dist/desktop/host.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

async function setup(respond?: (signal?: AbortSignal) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-batch-"));
  const configPath = join(root, "config.json");
  const requests: string[] = [];
  const providers = createProviderRegistry([{
    id: "alpha", label: "alpha", defaultModel: "a1", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: ({ model }: { model?: string }) => ({ async respond(request: { task: string; tools: unknown[]; signal?: AbortSignal }) {
      requests.push(`${model}:${request.task}`);
      assert.deepEqual(request.tools, []);
      await respond?.(request.signal);
      return { responseId: "fake", text: "report", toolCalls: [] };
    } }),
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), tools: [] });
  const service = createDesktopBatchService({ providers, configPath, workingDirectory: root, tools: [] });
  const bridge = new DesktopBridge(runtime, () => assert.fail("Batch cannot enter interactive session."),
    { batch: service.command, close: service.close } as unknown as DesktopLocalControls);
  const queue = createFileBatchQueue(batchWorkspaceDirectory(join(root, "batches"), root), root);
  return { root, requests, bridge, queue, async close() { await bridge.close(); await rm(root, { recursive: true, force: true }); } };
}

async function slash(bridge: DesktopBridge, content: string): Promise<string> {
  const result = await bridge.request({ type: "slash", content });
  assert.equal(result.ok, true, JSON.stringify(result));
  return JSON.stringify(result);
}

test("Desktop batch requires a session, explicit single-use RUN, and checkpoints sequential READ-only tasks", async () => {
  const f = await setup();
  try {
    assert.equal((await f.bridge.request({ type: "slash", content: "/batch list" })).ok, false);
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    assert.match(await slash(f.bridge, "/help"), /\/batch/);
    assert.match(await slash(f.bridge, "/batch confirm NO"), /Usage: \/batch/);
    assert.match(await slash(f.bridge, "/batch confirm RUN"), /not pending/);
    assert.match(await slash(f.bridge, "/batch add 2 -- inspect A -- inspect B"), /created/);
    const [batch] = await f.queue.list();
    assert.ok(batch);
    assert.match(await slash(f.bridge, `/batch status ${batch.id}`), /queued/);
    assert.match(await slash(f.bridge, `/batch run ${batch.id} ${batch.revision}`), /alpha:a1.*RUN/);
    assert.deepEqual(f.requests, []);
    assert.match(await slash(f.bridge, "/batch confirm RUN"), /completed, completed/);
    assert.deepEqual(f.requests, ["a1:inspect A", "a1:inspect B"]);
    assert.equal((await f.queue.load(batch.id))?.revision, batch.revision + 4);
    assert.match(await slash(f.bridge, "/batch confirm RUN"), /not pending/);
    assert.match(await slash(f.bridge, `/batch run ${batch.id} ${batch.revision}`), /revision changed/);
  } finally { await f.close(); }
});

test("Desktop batch invalidates pending selection after a session or model change", async () => {
  const f = await setup();
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    const batch = await f.queue.create(["inspect"], 1);
    await slash(f.bridge, `/batch run ${batch.id} ${batch.revision}`);
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha", model: "a2" })).ok, true);
    assert.match(await slash(f.bridge, "/batch confirm RUN"), /not pending/);
    await slash(f.bridge, `/batch run ${batch.id} ${batch.revision}`);
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    assert.match(await slash(f.bridge, "/batch confirm RUN"), /not pending/);
    assert.deepEqual(f.requests, []);
    assert.equal((await f.queue.load(batch.id))?.revision, batch.revision);
  } finally { await f.close(); }
});

test("Desktop batch closes an active run and checkpoints interruption without launching the next task", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const f = await setup(async (signal) => {
    started();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    const batch = await f.queue.create(["inspect A", "inspect B"], 2);
    await slash(f.bridge, `/batch run ${batch.id} ${batch.revision}`);
    const running = f.bridge.request({ type: "slash", content: "/batch confirm RUN" });
    await entered;
    await f.bridge.close();
    const result = await running;
    assert.equal(result.ok, false);
    assert.deepEqual(f.requests, ["a1:inspect A"]);
    assert.deepEqual((await f.queue.load(batch.id))?.tasks.map((task) => task.state), ["interrupted", "queued"]);
  } finally { await f.close(); }
});

test("Desktop host binds batch commands to its startup profile and workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-batch-host-"));
  const configPath = join(root, "settings", "config.json");
  const runtime = await createDesktopRuntime(root, { configPath, profileName: "fixture" });
  const bridge = new DesktopBridge(runtime, () => assert.fail("No batch model should start."), desktopLocalControls(runtime));
  try {
    assert.equal((await bridge.request({ type: "create", provider: "local" })).ok, true);
    assert.match(await slash(bridge, "/batch add 1 -- inspect workspace"), /created/);
    assert.match(await slash(bridge, "/batch list"), /queued/);
    const other = createFileBatchQueue(batchWorkspaceDirectory(join(root, "batches"), root), root);
    assert.deepEqual(await other.list(), []);
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

test("Desktop batch lock recovery requires a same-session, single-use confirmation and a stopped owner", async () => {
  const f = await setup();
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    assert.match(await slash(f.bridge, "/batch lock status"), /No batch lock/);
    assert.match(await slash(f.bridge, "/batch lock confirm RECOVER"), /not pending/);
    const batch = await f.queue.create(["Read"], 1);
    const directory = batchWorkspaceDirectory(join(f.root, "batches"), f.root);
    const lockPath = join(directory, ".batch.lock");
    const token = randomUUID();
    const save = (pid: number, host = hostname(), value = token) =>
      writeFile(lockPath, JSON.stringify({ pid, host, token: value }));
    await save(999999999);
    assert.match(await slash(f.bridge, "/batch lock status"), /PID 999999999/);
    assert.match(await slash(f.bridge, "/batch lock confirm RECOVER"), /not pending/);
    assert.match(await slash(f.bridge, "/batch lock recover"), /\/batch lock confirm RECOVER/);
    assert.match(await slash(f.bridge, "/batch lock confirm NO"), /Usage: \/batch/);
    assert.match(await slash(f.bridge, "/batch lock confirm RECOVER"), /Abandoned batch lock removed/);
    assert.equal(await inspectBatchLock(directory), undefined);
    assert.match(await slash(f.bridge, "/batch lock confirm RECOVER"), /not pending/);
    assert.equal((await f.queue.load(batch.id))?.revision, 0);
    assert.deepEqual(f.requests, []);

    await save(process.pid);
    await slash(f.bridge, "/batch lock recover");
    assert.equal((await f.bridge.request({ type: "slash", content: "/batch lock confirm RECOVER" })).ok, false);
    assert.ok(await inspectBatchLock(directory));
    await save(999999999, "other-host");
    await slash(f.bridge, "/batch lock recover");
    assert.equal((await f.bridge.request({ type: "slash", content: "/batch lock confirm RECOVER" })).ok, false);
    await save(999999999);
    await slash(f.bridge, "/batch lock recover");
    await save(999999999, hostname(), randomUUID());
    assert.equal((await f.bridge.request({ type: "slash", content: "/batch lock confirm RECOVER" })).ok, false);
    assert.ok(await inspectBatchLock(directory));
  } finally { await f.close(); }
});

test("Desktop batch lock confirmation is discarded after a model selection change", async () => {
  const f = await setup();
  try {
    await f.bridge.request({ type: "create", provider: "alpha" });
    await f.queue.create(["Read"], 1);
    const directory = batchWorkspaceDirectory(join(f.root, "batches"), f.root);
    await writeFile(join(directory, ".batch.lock"), JSON.stringify({ pid: 999999999, host: hostname(), token: randomUUID() }));
    await slash(f.bridge, "/batch lock recover");
    await f.bridge.request({ type: "create", provider: "alpha", model: "a2" });
    assert.match(await slash(f.bridge, "/batch lock confirm RECOVER"), /not pending|selection changed/);
    assert.ok(await inspectBatchLock(directory));
  } finally { await f.close(); }
});
