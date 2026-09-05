import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createDragonsRuntime, type RuntimeEvent, type RuntimeSession, type DragonsRuntime } from "./runtime.js";
import { AgentRunCancelledError } from "./agent.js";
import { createProviderRegistry } from "./provider/registry.js";
import { createSharedRuntimeHost } from "./shared-runtime.js";
import { connectRemoteRuntime } from "./remote/runtime.js";
import { RemoteClient } from "./remote/client.js";
import { startRemoteServer } from "./remote/server.js";
import { DesktopBridge } from "./desktop/bridge.js";
import { TuiController } from "./tui/controller.js";
import { createSessionStore } from "./session-store.js";

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Expected shared client state was not reached.");
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dragons-shared-clients-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "test.txt"), "original");
  let waiting = 0;
  const registry = createProviderRegistry([{ id: "fixture", label: "Shared fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ respond: async (request, delta) => {
      if (request.toolOutputs.length) return { responseId: "completed", text: "shared completion", toolCalls: [] };
      if (request.task === "wait") {
        waiting++;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { waiting--; reject(new AgentRunCancelledError()); };
          if (request.signal?.aborted) abort(); else request.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (request.task === "write") return { responseId: "write", text: "", toolCalls: [{ callId: "write", name: "fixture_write", arguments: "{}" }] };
      delta?.("shared hello");
      return { responseId: "hello", text: "shared hello", textWasStreamed: true, toolCalls: [] };
    } }),
  }]);
  const core = await createDragonsRuntime({ workingDirectory: root, providerRegistry: registry, defaultProvider: "fixture",
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: registry.ids() }),
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
    tools: [{ name: "fixture_write", description: "Shared sentinel", operation: "WRITE", inputSchema: { type: "object", properties: {} },
      execute: async () => { await writeFile(join(root, "test.txt"), "approved"); return { ok: true, output: "done" }; } }],
  });
  const host = createSharedRuntimeHost(core); t.after(() => host.close());
  const token = randomBytes(32).toString("base64url");
  const server = await startRemoteServer({ principals: [{ id: "owner", token }], maxConnectionsPerPrincipal: 8,
    createRuntime: async (_principal, id) => host.connect(id) });
  t.after(() => server.close());
  const connect = async () => {
    const runtime = await connectRemoteRuntime({ url: server.url, token }); t.after(() => runtime.dispose()); return runtime;
  };
  return { root, core, host, token, server, connect, waiting: () => waiting };
}

test("M75 CLI/TUI owner and desktop observer share state without transferring cancel authority", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const cli = new TuiController(await f.connect()); t.after(() => cli.close()); await cli.initialize();
  const desktop = new DesktopBridge(await f.connect(), (event) => events.push(event)); t.after(() => desktop.close());
  const events: RuntimeEvent[] = [];
  const id = cli.state.session!.id;
  const running = cli.submit("wait"); await until(() => f.waiting() === 1);
  assert.equal((await desktop.request({ type: "resume", sessionId: id })).ok, true);
  await until(() => events.some((event) => event.type === "run_started"));
  const status = await desktop.request({ type: "status" }); assert.equal(status.ok, true);
  if (status.ok) assert.equal((status.value as { session: RuntimeSession }).session.id, id);
  const runId = events.find((event) => event.type === "run_started")!.runId;
  assert.deepEqual(await desktop.request({ type: "cancel", runId }), { ok: true, value: false });
  assert.equal(f.waiting(), 1);
  await desktop.close(); assert.equal(f.waiting(), 1);
  assert.equal(cli.cancel(), true); await running; assert.equal(f.waiting(), 0);
  const reattached = await f.connect(); await reattached.resumeSession(id);
  assert.equal((await reattached.status()).session!.id, id);
});

test("M75 shared write approval belongs to owner; observers cannot inherit authority or write stale revisions", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const owner = await f.connect(); const session = await owner.createSession();
  const observer = await f.connect(); await observer.resumeSession(session.id);
  const run = await owner.sendUserInput({ sessionId: session.id, content: "write" });
  const ownerEvents: RuntimeEvent[] = [];
  const drained = (async () => { for await (const event of run.events) ownerEvents.push(event); })();
  await until(() => ownerEvents.some((event) => event.type === "approval_requested"));
  const approval = ownerEvents.find((event) => event.type === "approval_requested")!;
  if (approval.type !== "approval_requested") assert.fail();
  assert.equal(observer.resolveAuthorization({ runId: run.id, approvalId: approval.approvalId, decision: "allow_once" }), false);
  assert.equal(await readFile(join(f.root, "test.txt"), "utf8"), "original");
  assert.equal(owner.resolveAuthorization({ runId: run.id, approvalId: approval.approvalId, decision: "allow_once" }), true);
  assert.equal(owner.resolveAuthorization({ runId: run.id, approvalId: approval.approvalId, decision: "allow_once" }), false);
  await run.result; await drained;
  assert.equal(await readFile(join(f.root, "test.txt"), "utf8"), "approved");
  await assert.rejects(observer.sendUserInput({ sessionId: session.id, content: "hello" }), /rejected/);
  await observer.status();
  const next = await observer.sendUserInput({ sessionId: session.id, content: "hello" });
  for await (const _event of next.events) { /* Drain the real stream. */ }
  assert.equal((await next.result).finalText, "shared hello");
});

test("M75 TUI observation detaches without awaiting or cancelling an unrelated owner's active run", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const owner = await f.connect(); const session = await owner.createSession();
  const run = await owner.sendUserInput({ sessionId: session.id, content: "wait" });
  void run.result.catch(() => {});
  const drained = (async () => { for await (const _event of run.events) { /* Owner keeps consuming. */ } })();
  const viewer = new TuiController(await f.connect()); t.after(() => viewer.close());
  await viewer.initialize({ resume: session.id });
  await until(() => viewer.state.busy && f.waiting() === 1);
  assert.equal(viewer.cancel(), false);
  await viewer.close(); assert.equal(f.waiting(), 1);
  await owner.dispose(); await assert.rejects(run.result); await drained;
  assert.equal(f.waiting(), 0);
});

test("M75 shared remote principal session cap reserves concurrent creations before await", { timeout: 10000 }, async (t) => {
  const token = randomBytes(32).toString("base64url");
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); t.after(release);
  let entered = 0;
  const server = await startRemoteServer({ principals: [{ id: "owner", token, sessionIds: Array.from({ length: 127 }, () => randomUUID()) }], maxConnectionsPerPrincipal: 2,
    createRuntime: async () => ({ providers: () => [], dispose: async () => {}, createSession: async () => {
      entered++; await gate; return { id: randomUUID(), provider: "fixture", model: "fixture" } as RuntimeSession;
    } }) as unknown as DragonsRuntime });
  t.after(() => server.close());
  const a = await RemoteClient.connect({ url: server.url, token, onEvent: () => {} }); t.after(() => a.close());
  const b = await RemoteClient.connect({ url: server.url, token, onEvent: () => {} }); t.after(() => b.close());
  const first = a.request({ type: "create" }); await until(() => entered === 1);
  await assert.rejects(b.request({ type: "create" })); assert.equal(entered, 1);
  release(); assert.equal((await first).ok, true);
});
