import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentModel } from "./agent.js";
import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "./runtime.js";
import { createSharedRuntimeHost } from "./shared-runtime.js";
import { createSessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function fixture(createModel: () => AgentModel, tools: AgentTool[] = []) {
  const root = await mkdtemp(join(tmpdir(), "dragons-shared-"));
  const registry = createProviderRegistry(["fixture", "other"].map((id) => ({
    id, label: id, defaultModel: `${id}-1`, credentialRequirement: "none" as const,
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel,
  })));
  const store = createSessionStore(join(root, "sessions"), { providerIds: registry.ids() });
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: registry,
    sessionStore: store, tools, memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  const host = createSharedRuntimeHost(runtime);
  return { host, runtime, store, async cleanup() { await host.close(); await rm(root, { recursive: true, force: true }); } };
}
async function collect(events: AsyncIterable<RuntimeEvent>) {
  const result: RuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
const answer = { responseId: "fixture", text: "A safe answer.", toolCalls: [] };

test("shared active attachment fans out copies and requires explicit revision refresh", { timeout: 5000 }, async () => {
  const gate = deferred();
  const f = await fixture(() => ({ async respond() { await gate.promise; return answer; } }));
  try {
    const a = f.host.connect("owner"), b = f.host.connect("observer");
    const session = await a.createSession(); await b.resumeSession(session.id);
    const admission = a.sendUserInput({ sessionId: session.id, content: "first" });
    await assert.rejects(b.sendUserInput({ sessionId: session.id, content: "compete" }), /active owner/);
    const run = await admission;
    await assert.rejects(a.createSession(), /owned active/);
    const observer = b.observeRun(session.id)!;
    assert.ok(observer);
    assert.equal(observer.cancel(), false); assert.equal(b.cancelRun(run.id), false);
    const ownerEvents = collect(run.events), observerEvents = collect(observer.events);
    gate.resolve();
    assert.equal((await run.result).finalText, answer.text);
    const [owned, observed] = await Promise.all([ownerEvents, observerEvents]);
    assert.deepEqual(observed.slice(0, 2).map((e) => e.type), ["run_started", "event_stream_truncated"]);
    assert.ok(observed.some((e) => e.type === "run_completed"));
    const oe = owned.find((e) => e.type === "run_completed");
    const be = observed.find((e) => e.type === "run_completed");
    assert.notEqual(oe, be);
    await assert.rejects(a.sendUserInput({ sessionId: session.id, content: "stale owner" }), /stale/);
    await assert.rejects(b.sendUserInput({ sessionId: session.id, content: "stale observer" }), /stale/);
    assert.equal((await b.status()).shared.ownerClientId, undefined);
    const next = await b.sendUserInput({ sessionId: session.id, content: "fresh" });
    await collect(next.events); await next.result;
    assert.equal((await f.store.load(session.id))?.messages.length, 4);
    await a.dispose();
    const reconnect = f.host.connect("owner");
    assert.equal((await reconnect.resumeSession(session.id)).messageCount, 4);
  } finally { gate.resolve(); await f.cleanup(); }
});

test("shared approval is owner-only, one-shot, and never visible to observers", { timeout: 5000 }, async () => {
  let executed = 0;
  const gate = deferred();
  const tool: AgentTool = { name: "fixture_write", operation: "WRITE", description: "Fixture", inputSchema: { type: "object", properties: {} },
    async execute() { executed++; return { ok: true, output: "done" }; } };
  const f = await fixture(() => { let turn = 0; return { async respond() {
    await gate.promise;
    return turn++ === 0 ? { responseId: "tool", text: "", toolCalls: [{ callId: "one", name: tool.name, arguments: "{}" }] } : answer;
  } }; }, [tool]);
  try {
    const a = f.host.connect("a"), b = f.host.connect("b");
    const session = await a.createSession(); await b.resumeSession(session.id);
    const run = await a.sendUserInput({ sessionId: session.id, content: "write" });
    const observation = collect(b.observeRun(session.id)!.events);
    gate.resolve();
    for await (const event of run.events) {
      if (event.type !== "approval_requested") continue;
      const request = { runId: run.id, approvalId: event.approvalId, decision: "allow_once" as const };
      assert.equal(b.resolveAuthorization(request), false);
      assert.equal(a.resolveAuthorization({ ...request, decision: "allow_session" }), false);
      assert.equal(executed, 0);
      assert.equal(a.resolveAuthorization(request), true);
      assert.equal(a.resolveAuthorization(request), false);
    }
    await run.result;
    assert.equal(executed, 1);
    assert.ok(!(await observation).some((e) => e.type === "approval_requested" || e.type === "memory_suggestion"));
  } finally { gate.resolve(); await f.cleanup(); }
});

for (const ownerDisconnect of [false, true]) {
  test(`shared ${ownerDisconnect ? "owner" : "observer"} disconnect cancellation isolation`, { timeout: 5000 }, async () => {
    const entered = deferred(), gate = deferred();
    const f = await fixture(() => ({ async respond(request) {
      entered.resolve();
      await Promise.race([gate.promise, new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve(); else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      })]);
      return answer;
    } }));
    try {
      const a = f.host.connect("a"), b = f.host.connect("b");
      const session = await a.createSession(); await b.resumeSession(session.id);
      const run = await a.sendUserInput({ sessionId: session.id, content: "wait" });
      const observer = b.observeRun(session.id)!; await entered.promise;
      if (ownerDisconnect) { await a.dispose(); await assert.rejects(run.result, /cancel/i); }
      else { await b.dispose(); await assert.rejects(observer.result, /cancel/i); gate.resolve(); assert.equal((await run.result).finalText, answer.text); }
      assert.ok(await (ownerDisconnect ? b : a).status());
    } finally { gate.resolve(); await f.cleanup(); }
  });
}

test("shared host validates connections, session/provider isolation and host-only privileges", async () => {
  const f = await fixture(() => ({ async respond() { return answer; } }));
  try {
    assert.throws(() => f.host.connect("../bad"), /Invalid/);
    const a = f.host.connect("a"), b = f.host.connect("b");
    assert.throws(() => f.host.connect("a"), /already/);
    const sa = await a.createSession({ provider: "fixture", model: "custom" });
    const sb = await b.createSession({ provider: "other" });
    assert.equal((await a.status()).session?.model, "custom");
    assert.equal((await b.status()).session?.provider, "other");
    await assert.rejects(a.sendUserInput({ sessionId: sb.id, content: "wrong" }), /Attach/);
    await assert.rejects(a.connectMcp("x"), /host-only/);
    await assert.rejects(a.disconnectMcp("x"), /host-only/);
    assert.notEqual(sa.id, sb.id);
    for (let i = 0; i < 30; i++) f.host.connect(`extra-${i}`);
    assert.throws(() => f.host.connect("overflow"), /limit/);
    const first = f.host.close(); assert.equal(f.host.close(), first); await first;
  } finally { await f.cleanup(); }
});

test("shared background work remains visible after its client detaches", { timeout: 5000 }, async () => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(() => ({ async respond() { entered.resolve(); await gate.promise; return answer; } }));
  try {
    const a = f.host.connect("a"), b = f.host.connect("b");
    const session = await a.createSession(); await b.resumeSession(session.id);
    const task = await a.startBackgroundTask({ sessionId: session.id, prompt: "read only" });
    await entered.promise;
    assert.equal(await b.cancelBackgroundTask({ sessionId: session.id, taskId: task.id }), false);
    await a.dispose();
    assert.equal((await b.listBackgroundTasks(session.id))[0]?.state, "running");
    gate.resolve();
  } finally { gate.resolve(); await f.cleanup(); }
});

for (const overflowOwner of [false, true]) {
  test(`shared bounded pending next overflow detaches ${overflowOwner ? "owner" : "observer"}`, { timeout: 5000 }, async () => {
    const gate = deferred(), entered = deferred();
    const f = await fixture(() => ({ async respond(request) {
      entered.resolve();
      await Promise.race([gate.promise, new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve(); else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      })]);
      return answer;
    } }));
    try {
      const a = f.host.connect("a"), b = f.host.connect("b");
      const session = await a.createSession(); await b.resumeSession(session.id);
      const run = await a.sendUserInput({ sessionId: session.id, content: "wait" });
      const observer = b.observeRun(session.id)!; await entered.promise;
      const iterator = (overflowOwner ? run : observer).events[Symbol.asyncIterator]();
      const pending = Array.from({ length: 140 }, () => iterator.next());
      await Promise.all(pending);
      if (overflowOwner) await assert.rejects(run.result, /cancel/i);
      else { await assert.rejects(observer.result, /cancel/i); gate.resolve(); await run.result; }
    } finally { gate.resolve(); await f.cleanup(); }
  });
}

test("shared late foreground admission is cancelled after client disposal", { timeout: 5000 }, async () => {
  const f = await fixture(() => ({ async respond() { return answer; } }));
  const admitted = deferred(), release = deferred();
  const host = createSharedRuntimeHost({ ...f.runtime, async sendUserInput(input) {
    admitted.resolve(); await release.promise; return f.runtime.sendUserInput(input);
  } });
  try {
    const a = host.connect("a"); const session = await a.createSession();
    const pending = a.sendUserInput({ sessionId: session.id, content: "late" });
    await admitted.promise;
    const disposal = a.dispose(); release.resolve();
    const run = await pending;
    await assert.rejects(run.result, /cancel/i); await disposal;
    assert.equal((await run.events[Symbol.asyncIterator]().next()).done, true);
  } finally { release.resolve(); await host.close(); await f.cleanup(); }
});
