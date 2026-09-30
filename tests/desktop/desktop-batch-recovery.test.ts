import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { batchWorkspaceDirectory, createFileBatchQueue } from "../../dist/batch-queue.js";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import { createDesktopBatchService } from "../../dist/desktop/batch-service.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-batch-recovery-"));
  const providers = createProviderRegistry([{
    id: "alpha", label: "alpha", defaultModel: "a1", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond() { throw new Error("A recovery must not start a model."); } }),
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), tools: [] });
  const service = createDesktopBatchService({ providers, configPath: join(root, "config.json"), workingDirectory: root, tools: [] });
  const bridge = new DesktopBridge(runtime, () => assert.fail("Recovery must not enter the agent loop."),
    { batch: service.command, close: service.close } as unknown as DesktopLocalControls);
  const directory = batchWorkspaceDirectory(join(root, "batches"), root);
  const queue = createFileBatchQueue(directory, root);
  async function slash(content: string) {
    const result = await bridge.request({ type: "slash", content });
    assert.equal(result.ok, true, JSON.stringify(result));
    return JSON.stringify(result);
  }
  return { bridge, queue, directory, slash, async close() { await bridge.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Desktop reservation recovery requires explicit same-session confirmation and a stopped owner", async () => {
  const f = await fixture();
  try {
    await f.bridge.request({ type: "create", provider: "alpha" });
    const batch = await f.queue.create(["first", "second"], 2);
    const running = (await f.queue.reserve(batch.id, batch.revision))!;
    const token = running.tasks[0]!.owner!.token;
    assert.match(await f.slash(`/batch status ${batch.id}`), /PID/);
    assert.match(await f.slash("/batch confirm RECOVER"), /not pending/);
    assert.match(await f.slash(`/batch recover ${batch.id} ${batch.revision}`), /revision changed/);
    assert.match(await f.slash(`/batch recover ${batch.id} ${running.revision}`), /\/batch confirm RECOVER/);
    assert.doesNotMatch(await f.slash("/batch confirm NO"), new RegExp(token));
    assert.equal((await f.bridge.request({ type: "slash", content: "/batch confirm RECOVER" })).ok, false);
    assert.equal((await f.queue.load(batch.id))?.tasks[0]?.state, "running");
    const orphan = structuredClone(running);
    orphan.tasks[0]!.owner!.pid = 999999999;
    await writeFile(join(f.directory, `${batch.id}.json`), `${JSON.stringify(orphan)}\n`);
    await f.slash(`/batch recover ${batch.id} ${running.revision}`);
    assert.match(await f.slash("/batch confirm RECOVER"), /task marked interrupted/);
    assert.match(await f.slash("/batch confirm RECOVER"), /not pending/);
    const saved = (await f.queue.load(batch.id))!;
    assert.deepEqual(saved.tasks.map((entry) => entry.state), ["interrupted", "queued"]);
    assert.equal(saved.runsUsed, 1);
  } finally { await f.close(); }
});

test("Desktop reservation recovery rejects changed and unverifiable ownership without touching the checkpoint", async () => {
  const f = await fixture();
  try {
    await f.bridge.request({ type: "create", provider: "alpha" });
    const batch = await f.queue.create(["first"], 1);
    const running = (await f.queue.reserve(batch.id, batch.revision))!;
    const original = running.tasks[0]!.owner!.token;
    const orphan = structuredClone(running);
    orphan.tasks[0]!.owner!.pid = 999999999;
    await writeFile(join(f.directory, `${batch.id}.json`), `${JSON.stringify(orphan)}\n`);
    await f.slash(`/batch recover ${batch.id} ${running.revision}`);
    orphan.tasks[0]!.owner!.token = batch.id;
    await writeFile(join(f.directory, `${batch.id}.json`), `${JSON.stringify(orphan)}\n`);
    assert.equal((await f.bridge.request({ type: "slash", content: "/batch confirm RECOVER" })).ok, false);
    assert.equal((await f.queue.load(batch.id))?.tasks[0]?.state, "running");
    orphan.tasks[0]!.owner!.token = original;
    orphan.tasks[0]!.owner!.host = "other-host";
    await writeFile(join(f.directory, `${batch.id}.json`), `${JSON.stringify(orphan)}\n`);
    await f.slash(`/batch recover ${batch.id} ${running.revision}`);
    assert.equal((await f.bridge.request({ type: "slash", content: "/batch confirm RECOVER" })).ok, false);
    delete orphan.tasks[0]!.owner;
    await writeFile(join(f.directory, `${batch.id}.json`), `${JSON.stringify(orphan)}\n`);
    assert.match(await f.slash(`/batch status ${batch.id}`), /legacy owner unknown/);
    assert.match(await f.slash(`/batch recover ${batch.id} ${running.revision}`), /No verifiable running/);
    assert.equal((await f.queue.load(batch.id))?.runsUsed, 1);
  } finally { await f.close(); }
});

test("Desktop reservation recovery invalidates pending confirmation on session/model changes", async () => {
  const f = await fixture();
  try {
    await f.bridge.request({ type: "create", provider: "alpha" });
    const batch = await f.queue.create(["first"], 1);
    const running = (await f.queue.reserve(batch.id, batch.revision))!;
    const orphan = structuredClone(running);
    orphan.tasks[0]!.owner!.pid = 999999999;
    await writeFile(join(f.directory, `${batch.id}.json`), `${JSON.stringify(orphan)}\n`);
    await f.slash(`/batch recover ${batch.id} ${running.revision}`);
    await f.bridge.request({ type: "create", provider: "alpha", model: "a2" });
    assert.match(await f.slash("/batch confirm RECOVER"), /not pending|selection changed/);
    await f.slash(`/batch recover ${batch.id} ${running.revision}`);
    await f.bridge.request({ type: "create", provider: "alpha" });
    assert.match(await f.slash("/batch confirm RECOVER"), /not pending/);
    assert.equal((await f.queue.load(batch.id))?.tasks[0]?.state, "running");
  } finally { await f.close(); }
});
