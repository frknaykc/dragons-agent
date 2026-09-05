import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentModel } from "./agent.js";
import { DesktopBridge, type DesktopBridgeReply } from "./desktop/bridge.js";
import { createMemoryStore } from "./memory.js";
import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime, type DragonsRuntime, type RuntimeEvent, type RuntimeRunHandle, type RuntimeSession, type RuntimeStatus } from "./runtime.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function value<T>(reply: DesktopBridgeReply): T {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  if (!reply.ok) throw new Error("Expected success.");
  return reply.value as T;
}

function failure(reply: DesktopBridgeReply, code: string): void {
  assert.equal(reply.ok, false);
  if (reply.ok) throw new Error("Expected failure.");
  assert.equal(reply.error.code, code);
  assert.ok(reply.error.message.length < 120);
}

function eventLog() {
  const events: RuntimeEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    events,
    emit(event: RuntimeEvent) {
      events.push(event);
      for (const listener of listeners) listener();
    },
    wait<T extends RuntimeEvent["type"]>(type: T, runId?: string): Promise<Extract<RuntimeEvent, { type: T }>> {
      return new Promise((resolve) => {
        const check = () => {
          const event = events.find((entry) => entry.type === type && (runId === undefined || entry.runId === runId));
          if (event) {
            listeners.delete(check);
            resolve(event as Extract<RuntimeEvent, { type: T }>);
          }
        };
        listeners.add(check);
        check();
      });
    },
  };
}

const finalModel = (): AgentModel => ({
  async respond(_request, delta) {
    delta?.("Desktop ");
    delta?.("answer.");
    return { responseId: "fixture-final", text: "Desktop answer.", textWasStreamed: true, toolCalls: [] };
  },
});

async function fixture(t: TestContext, options: {
  createModel?: () => AgentModel;
  tools?: AgentTool[];
  wrapStore?: (store: SessionStore) => SessionStore;
  wrapRuntime?: (runtime: DragonsRuntime) => DragonsRuntime;
  emit?: (event: RuntimeEvent) => void;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-desktop-")));
  const registry = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: options.createModel ?? finalModel,
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: registry.ids() });
  const memory = createMemoryStore(join(root, "memory"));
  const runtime = await createDragonsRuntime({
    workingDirectory: root, providerRegistry: registry,
    sessionStore: options.wrapStore?.(store) ?? store, memoryStore: memory,
    skillsDirectory: join(root, "skills"), tools: options.tools ?? [],
  });
  const log = eventLog();
  const bridge = new DesktopBridge(options.wrapRuntime?.(runtime) ?? runtime, (event) => {
    log.emit(event);
    options.emit?.(event);
  });
  t.after(async () => {
    await bridge.close();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, bridge, runtime, store, memory, log };
}

async function create(bridge: DesktopBridge): Promise<RuntimeSession> {
  return value<RuntimeSession>(await bridge.request({ type: "create", provider: "fixture", model: "fixture-1" }));
}

async function send(bridge: DesktopBridge): Promise<{ runId: string; sessionId: string }> {
  return value(await bridge.request({ type: "send", content: "A deterministic desktop request." }));
}

test("M73 creates a session, streams runtime events, completes and resumes persisted context", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const providers = value<Array<{ id: string }>>(await f.bridge.request({ type: "providers" }));
  assert.deepEqual(providers.map((entry) => entry.id), ["fixture"]);
  const session = await create(f.bridge);
  const run = await send(f.bridge);
  assert.equal(run.sessionId, session.id);
  const completed = await f.log.wait("run_completed", run.runId);
  assert.equal(completed.result.finalText, "Desktop answer.");
  assert.equal(f.log.events.filter((event) => event.type === "assistant_delta").map((event) => event.text).join(""), "Desktop answer.");
  assert.ok(f.log.events.every((event) => event.sessionId === session.id && event.runId === run.runId));
  const status = value<RuntimeStatus>(await f.bridge.request({ type: "status" }));
  assert.equal(status.activeRunId, undefined);
  assert.equal(status.session?.messageCount, 2);
  assert.equal("continuation" in (status.session ?? {}), false);

  const other = await create(f.bridge);
  assert.notEqual(other.id, session.id);
  failure(await f.bridge.request({ type: "send", sessionId: session.id, content: "Stale UI send" }), "STALE_SESSION");
  const resumed = value<RuntimeSession>(await f.bridge.request({ type: "resume", sessionId: session.id }));
  assert.equal(resumed.id, session.id);
  assert.equal(resumed.hasContinuation, true);
  const again = await send(f.bridge);
  await f.log.wait("run_completed", again.runId);
  assert.equal((await f.store.load(session.id))?.messages.length, 4);
});

for (const decision of ["allow_once", "deny"] as const) {
  test(`M73 ${decision} is session/run/pending-ID bound and one-use`, { timeout: 10_000 }, async (t) => {
    let executions = 0;
    const tool: AgentTool = {
      name: "write_fixture", description: "Harmless deterministic write fixture.", operation: "WRITE",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { executions += 1; return { ok: true, output: "fixture written" }; },
    };
    const f = await fixture(t, { tools: [tool], createModel: () => {
      let turn = 0;
      return { async respond(request, delta) {
        if (++turn === 1) {
          delta?.("Before approval.");
          return { responseId: "first", text: "Before approval.", textWasStreamed: true,
            toolCalls: [{ callId: "write-1", name: tool.name, arguments: "{}" }] };
        }
        assert.match(request.toolOutputs[0]?.output ?? "", decision === "allow_once" ? /fixture written/ : /Authorization denied/);
        return { responseId: "last", text: "Decision completed.", toolCalls: [] };
      } };
    } });
    const foreign = await f.runtime.createSession();
    const session = await create(f.bridge);
    const run = await send(f.bridge);
    const pending = await f.log.wait("approval_requested", run.runId);
    assert.equal(executions, 0);
    const command = { type: "approve", sessionId: session.id, runId: run.runId, approvalId: pending.approvalId, decision };
    failure(await f.bridge.request({ ...command, sessionId: foreign.id }), "STALE_SESSION");
    failure(await f.bridge.request({ ...command, runId: "foreign-run" }), "NOT_OWNED");
    failure(await f.bridge.request({ ...command, approvalId: "unknown-approval" }), "NOT_PENDING");
    failure(await f.bridge.request({ ...command, decision: "allow_session" }), "INVALID_MESSAGE");
    failure(await f.bridge.request({ type: "cancel", runId: "foreign-run" }), "NOT_OWNED");
    failure(await f.bridge.request({ type: "create" }), "BUSY");
    failure(await f.bridge.request({ type: "resume", sessionId: foreign.id }), "BUSY");
    failure(await f.bridge.request({ type: "send", content: "overlap" }), "BUSY");
    assert.equal(value<RuntimeStatus>(await f.bridge.request({ type: "status" })).activeRunId, run.runId);
    const accepted = f.bridge.request(command);
    const replay = f.bridge.request(command);
    assert.equal(value(await accepted), true);
    failure(await replay, "NOT_PENDING");
    assert.equal((await f.log.wait("run_completed", run.runId)).result.finalText, "Decision completed.");
    assert.equal(executions, decision === "allow_once" ? 1 : 0);
    assert.ok(f.log.events.some((event) => event.type === "tool_activity" && event.phase === "authorization_completed" && event.allowed === (decision === "allow_once")));
    failure(await f.bridge.request(command), "NOT_OWNED");
  });
}

test("M73 cancellation remains available while the provider is busy", { timeout: 10_000 }, async (t) => {
  const started = deferred<AbortSignal>();
  const f = await fixture(t, { createModel: () => ({ async respond(request) {
    assert.ok(request.signal);
    started.resolve(request.signal);
    await new Promise((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new Error("private provider failure")), { once: true }));
    throw new Error("unreachable");
  } }) });
  const session = await create(f.bridge);
  const run = await send(f.bridge);
  const signal = await started.promise;
  assert.equal(value(await f.bridge.request({ type: "cancel", runId: run.runId })), true);
  assert.equal(signal.aborted, true);
  await f.log.wait("run_cancelled", run.runId);
  assert.equal((await f.store.load(session.id))?.messages.length, 0);
  assert.doesNotMatch(JSON.stringify(f.log.events), /private provider failure/);
});

test("M73 rejects malformed, non-JSON, oversized and authority-expanding messages", async (t) => {
  let calls = 0;
  const f = await fixture(t, { wrapRuntime: (runtime) => ({ ...runtime, providers() { calls += 1; return runtime.providers(); } }) });
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "type", { enumerable: true, get() { getterCalls += 1; return "providers"; } });
  const malformed: unknown[] = [
    null, undefined, [], "{\"type\":\"providers\"}", 1, {}, { type: "unknown" },
    { type: "providers", extra: true }, { type: "status", sessionId: "another-session" },
    { type: "send", content: " " }, { type: "send", content: "x".repeat(64_001) },
    { type: "send", content: "😀".repeat(32_000) + "x" },
    { type: "send", content: "\u0000".repeat(64_000) },
    { type: "send", content: { nested: "object" } }, { type: "send", content: 10n },
    { type: "create", provider: "../fixture" }, { type: "create", model: "x".repeat(257) },
    { type: "create", model: "\nmodel" }, { type: "create", workingDirectory: "/" },
    { type: "resume", sessionId: "../sessions" }, { type: "resume", sessionId: "x".repeat(1000) },
    { type: "cancel", runId: " run " }, { type: "cancel" },
    { type: "approve", sessionId: "bad", runId: "run", approvalId: "id", decision: "allow_once" },
    { type: "memory", decision: "accept" }, { type: "shell", command: "ignored" },
    Object.assign(Object.create({ inherited: true }), { type: "providers" }),
    { type: "providers", [Symbol("extra")]: "x" }, accessor,
  ];
  const circular: Record<string, unknown> = { type: "send" };
  circular.content = circular;
  malformed.push(circular);
  for (const command of malformed) failure(await f.bridge.request(command), "INVALID_MESSAGE");
  assert.equal(getterCalls, 0);
  assert.equal(calls, 0);
  failure(await f.bridge.request({ type: "send", content: "No session" }), "NO_SESSION");
  failure(await f.bridge.request({ type: "create", provider: "unregistered" }), "RUNTIME_ERROR");
  await create(f.bridge);
});

test("M73 reserves admission before awaiting store work and releases it after failure", async (t) => {
  const entered = deferred();
  const release = deferred();
  let creates = 0;
  const f = await fixture(t, { wrapStore: (store) => ({ ...store, async create(options) {
    creates += 1;
    if (creates === 1) { entered.resolve(); await release.promise; throw new Error("fixture-sensitive-store-detail"); }
    return store.create(options);
  } }) });
  const first = f.bridge.request({ type: "create" });
  await entered.promise;
  failure(await f.bridge.request({ type: "create" }), "BUSY");
  failure(await f.bridge.request({ type: "status" }), "BUSY");
  release.resolve();
  const reply = await first;
  failure(reply, "RUNTIME_ERROR");
  assert.doesNotMatch(JSON.stringify(reply), /fixture-sensitive/);
  assert.equal(creates, 1);
  await create(f.bridge);
});

test("M73 terminal callbacks can immediately admit the next send", { timeout: 10_000 }, async (t) => {
  let bridge!: DesktopBridge;
  const next = deferred<DesktopBridgeReply>();
  let completed = 0;
  const f = await fixture(t, { emit(event) {
    if (event.type === "run_completed" && ++completed === 1) next.resolve(bridge.request({ type: "send", content: "Next turn from terminal callback" }));
  } });
  bridge = f.bridge;
  await create(bridge);
  await send(bridge);
  const run = value<{ runId: string }>(await next.promise);
  await f.log.wait("run_completed", run.runId);
  assert.equal(completed, 2);
});

test("M73 explicitly rejects memory suggestions without publishing an unsupported approval UI", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { createModel: () => {
    let turn = 0;
    return { async respond() {
      if (++turn === 1) return { responseId: "memory-first", text: "", toolCalls: [{ callId: "memory-1", name: "suggest_memory", arguments: JSON.stringify({ scope: "user", body: "Prefer deterministic tests." }) }] };
      return { responseId: "memory-last", text: "Done.", toolCalls: [] };
    } };
  } });
  await create(f.bridge);
  const run = await send(f.bridge);
  await f.log.wait("run_completed", run.runId);
  assert.equal(f.log.events.some((event) => event.type === "memory_suggestion"), false);
  assert.deepEqual(await f.memory.list(), []);
  assert.deepEqual(await f.memory.listSuggestions(), []);
});

test("M73 close is idempotent, cancels an owned run, disposes and discards subsequent events", { timeout: 10_000 }, async (t) => {
  const started = deferred<AbortSignal>();
  let disposals = 0;
  const f = await fixture(t, {
    createModel: () => ({ async respond(request) {
      assert.ok(request.signal);
      started.resolve(request.signal);
      await new Promise((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new Error("private cancellation")), { once: true }));
      throw new Error("unreachable");
    } }),
    wrapRuntime: (runtime) => ({ ...runtime, dispose() { disposals += 1; return runtime.dispose(); } }),
  });
  await create(f.bridge);
  await send(f.bridge);
  const signal = await started.promise;
  const count = f.log.events.length;
  const closing = f.bridge.close();
  const again = f.bridge.close();
  assert.equal(closing, again);
  failure(await f.bridge.request({ type: "providers" }), "CLOSED");
  await closing;
  assert.equal(signal.aborted, true);
  assert.equal(disposals, 1);
  assert.equal(f.log.events.length, count);
  assert.throws(() => f.runtime.providers(), /disposed/);
});

for (const command of ["create", "resume", "send", "status"] as const) {
  test(`M73 close discards late ${command} admission`, { timeout: 10_000 }, async (t) => {
    const entered = deferred();
    const release = deferred();
    let block = false;
    const f = await fixture(t, { wrapStore: (store) => ({ ...store,
      async create(options) {
        const session = await store.create(options);
        if (block && command === "create") { entered.resolve(); await release.promise; }
        return session;
      },
      async load(id) {
        const session = await store.load(id);
        if (block && command !== "create") { entered.resolve(); await release.promise; }
        return session;
      },
    }) });
    const session = await create(f.bridge);
    block = true;
    const request = f.bridge.request(command === "resume" ? { type: command, sessionId: session.id }
      : command === "send" ? { type: command, content: "Late admission" } : { type: command });
    await entered.promise;
    await f.bridge.close();
    release.resolve();
    failure(await request, "CLOSED");
    assert.deepEqual(f.log.events, []);
  });
}

test("M73 reserves send admission before awaiting the session store", { timeout: 10_000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  let block = false;
  const f = await fixture(t, { wrapStore: (store) => ({ ...store, async load(id) {
    const session = await store.load(id);
    if (block) { entered.resolve(); await release.promise; }
    return session;
  } }) });
  const session = await create(f.bridge);
  block = true;
  const admission = send(f.bridge);
  await entered.promise;
  failure(await f.bridge.request({ type: "send", content: "Concurrent send" }), "BUSY");
  failure(await f.bridge.request({ type: "resume", sessionId: session.id }), "BUSY");
  block = false;
  release.resolve();
  const run = await admission;
  await f.log.wait("run_completed", run.runId);
  assert.equal((await f.store.load(session.id))?.messages.length, 2);
});

test("M73 approve and cancel bypass a pending status admission", { timeout: 10_000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  let block = false;
  let executions = 0;
  const f = await fixture(t, {
    wrapStore: (store) => ({ ...store, async load(id) {
      const session = await store.load(id);
      if (block) { entered.resolve(); await release.promise; }
      return session;
    } }),
    tools: [{ name: "write_fixture", description: "Fixture", operation: "WRITE", inputSchema: { type: "object" },
      async execute() { executions += 1; return { ok: true, output: "written" }; } }],
    createModel: () => ({ async respond() {
      return { responseId: "write", text: "", toolCalls: [{ callId: "w", name: "write_fixture", arguments: "{}" }] };
    } }),
  });
  const session = await create(f.bridge);
  const run = await send(f.bridge);
  const pending = await f.log.wait("approval_requested", run.runId);
  block = true;
  const status = f.bridge.request({ type: "status" });
  await entered.promise;
  const approval = f.bridge.request({ type: "approve", sessionId: session.id, runId: run.runId, approvalId: pending.approvalId, decision: "allow_once" });
  const cancel = f.bridge.request({ type: "cancel", runId: run.runId });
  assert.equal(value(await approval), true);
  assert.equal(value(await cancel), true);
  block = false;
  release.resolve();
  assert.equal(value<RuntimeStatus>(await status).session?.id, session.id);
  await f.log.wait("run_cancelled", run.runId);
  assert.equal(executions, 0);
});

test("M73 cancellation clears pending approval and never grants it afterwards", { timeout: 10_000 }, async (t) => {
  let executions = 0;
  const f = await fixture(t, {
    tools: [{ name: "write_fixture", description: "Fixture", operation: "WRITE", inputSchema: { type: "object" },
      async execute() { executions += 1; return { ok: true, output: "written" }; } }],
    createModel: () => ({ async respond() {
      return { responseId: "write", text: "", toolCalls: [{ callId: "w", name: "write_fixture", arguments: "{}" }] };
    } }),
  });
  const session = await create(f.bridge);
  const run = await send(f.bridge);
  const pending = await f.log.wait("approval_requested", run.runId);
  const cancelled = f.bridge.request({ type: "cancel", runId: run.runId });
  const approval = f.bridge.request({ type: "approve", sessionId: session.id, runId: run.runId, approvalId: pending.approvalId, decision: "allow_once" });
  assert.equal(value(await cancelled), true);
  failure(await approval, "NOT_PENDING");
  await f.log.wait("run_cancelled", run.runId);
  assert.equal(executions, 0);
});

test("M73 ignores foreign runtime events and cannot resolve another session's actual pending approval", { timeout: 10_000 }, async (t) => {
  const foreignEvents: RuntimeEvent[] = [];
  let executions = 0;
  const f = await fixture(t, {
    tools: [{ name: "write_fixture", description: "Fixture", operation: "WRITE", inputSchema: { type: "object" },
      async execute() { executions += 1; return { ok: true, output: "written" }; } }],
    createModel: () => {
      let turn = 0;
      return { async respond() {
        return ++turn === 1
          ? { responseId: "write", text: "", toolCalls: [{ callId: "w", name: "write_fixture", arguments: "{}" }] }
          : { responseId: "done", text: "Done.", toolCalls: [] };
      } };
    },
    wrapRuntime: (runtime) => ({ ...runtime, async sendUserInput(input) {
      const handle = await runtime.sendUserInput(input);
      return { ...handle, events: (async function* () {
        yield* foreignEvents;
        yield* handle.events;
      })() };
    } }),
  });
  const foreignSession = await f.runtime.createSession();
  const foreign = await f.runtime.sendUserInput({ sessionId: foreignSession.id, content: "Foreign run" });
  void foreign.result.catch(() => {});
  let pending!: Extract<RuntimeEvent, { type: "approval_requested" }>;
  for await (const event of foreign.events) {
    foreignEvents.push(event);
    if (event.type === "approval_requested") { pending = event; break; }
  }
  const session = await create(f.bridge);
  const run = await send(f.bridge);
  const ownedApproval = await f.log.wait("approval_requested", run.runId);
  assert.ok(f.log.events.every((event) => event.sessionId === session.id && event.runId === run.runId));
  failure(await f.bridge.request({ type: "approve", sessionId: foreignSession.id, runId: foreign.id, approvalId: pending.approvalId, decision: "allow_once" }), "STALE_SESSION");
  failure(await f.bridge.request({ type: "approve", sessionId: session.id, runId: foreign.id, approvalId: pending.approvalId, decision: "allow_once" }), "NOT_OWNED");
  failure(await f.bridge.request({ type: "approve", sessionId: session.id, runId: run.runId, approvalId: pending.approvalId, decision: "allow_once" }), "NOT_PENDING");
  assert.equal(value(await f.bridge.request({ type: "approve", sessionId: session.id, runId: run.runId, approvalId: ownedApproval.approvalId, decision: "deny" })), true);
  await f.log.wait("run_completed", run.runId);
  assert.equal(executions, 0);
  assert.equal(f.runtime.resolveAuthorization({ runId: foreign.id, approvalId: pending.approvalId, decision: "deny" }), true, "foreign approval must still be pending");
  await foreign.result;
});

test("M73 observes rejected results before a stalled event consumer proceeds", { timeout: 10_000 }, async (t) => {
  const failed = deferred();
  const release = deferred();
  let handle!: RuntimeRunHandle;
  const f = await fixture(t, {
    createModel: () => ({ async respond() { failed.resolve(); throw new Error("fixture-private-rejection"); } }),
    wrapRuntime: (runtime) => ({ ...runtime, async sendUserInput(input) {
      handle = await runtime.sendUserInput(input);
      return { ...handle, events: (async function* () { await release.promise; yield* handle.events; })() };
    } }),
  });
  await create(f.bridge);
  const run = await send(f.bridge);
  await failed.promise;
  // A full event-loop checkpoint exposes unhandled rejections to node:test; do not attach
  // a test-side catch to the result until after this checkpoint.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(handle.result, /fixture-private-rejection/);
  release.resolve();
  assert.equal((await f.log.wait("run_failed", run.runId)).message, "Desktop run failed.");
});

test("M73 cancels a handle admitted at the caller-side close microtask boundary", { timeout: 10_000 }, async (t) => {
  let bridge!: DesktopBridge;
  let lateCancellations = 0;
  let disposals = 0;
  const f = await fixture(t, { wrapRuntime: (runtime) => ({ ...runtime,
    async sendUserInput(input) {
      const handle = await runtime.sendUserInput(input);
      queueMicrotask(() => { void bridge.close(); });
      return { ...handle, cancel() { lateCancellations += 1; return handle.cancel(); } };
    },
    dispose() { disposals += 1; return runtime.dispose(); },
  }) });
  bridge = f.bridge;
  await create(bridge);
  failure(await bridge.request({ type: "send", content: "Late handle" }), "CLOSED");
  await bridge.close();
  assert.equal(lateCancellations, 1);
  assert.equal(disposals, 1);
  assert.deepEqual(f.log.events, []);
});

test("M73 a failing event sink cancels and disposes without leaking its exception", { timeout: 10_000 }, async (t) => {
  const disposed = deferred();
  let deliveries = 0;
  const f = await fixture(t, {
    emit() { deliveries += 1; throw new Error("fixture-private-renderer-detail"); },
    wrapRuntime: (runtime) => ({ ...runtime, async dispose() { await runtime.dispose(); disposed.resolve(); } }),
  });
  await create(f.bridge);
  await send(f.bridge);
  await disposed.promise;
  failure(await f.bridge.request({ type: "status" }), "CLOSED");
  assert.equal(deliveries, 1);
});

test("M73 provider failures emit a generic error and consume result rejection", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { createModel: () => ({ async respond() { throw new Error("fixture-private-provider-detail api_key=fixture-secret-value"); } }) });
  await create(f.bridge);
  const run = await send(f.bridge);
  const failed = await f.log.wait("run_failed", run.runId);
  assert.equal(failed.message, "Desktop run failed.");
  assert.doesNotMatch(JSON.stringify(f.log.events), /fixture-private|fixture-secret/);
  const next = await send(f.bridge);
  await f.log.wait("run_failed", next.runId);
});
