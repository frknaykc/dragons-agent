import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentModel } from "./agent.js";
import { createMemoryStore } from "./memory.js";
import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent, type RuntimeRunHandle } from "./runtime.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";
import { TuiController } from "./tui/controller.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(t: TestContext, createModel: () => AgentModel, options: {
  tools?: AgentTool[];
  wrapStore?: (store: SessionStore) => SessionStore;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "dragons-tui-controller-"));
  const registry = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel,
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: registry.ids() });
  const memory = createMemoryStore(join(root, "memory"));
  const runtime = await createDragonsRuntime({
    workingDirectory: root, providerRegistry: registry,
    sessionStore: options.wrapStore?.(store) ?? store, memoryStore: memory,
    tools: options.tools ?? [], skillsDirectory: join(root, "skills"),
  });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  // The public facade is frozen. A shallow forwarding wrapper permits targeted
  // transport faults/spies while every unmodified method still uses the real core.
  return { runtime: { ...runtime }, store, memory };
}

const answer = (): AgentModel => ({ async respond() {
  return { responseId: "answer", text: "Final answer.", toolCalls: [] };
} });

for (const operation of ["WRITE", "EXECUTE"] as const) {
for (const decision of ["allow_once", "allow_session", "deny"] as const) {
  test(`M72 explicit ${decision} gates real runtime ${operation} execution`, { timeout: 10_000 }, async (t) => {
    let executions = 0;
    let output = "";
    const approved = barrier();
    const { runtime } = await fixture(t, () => {
      let turn = 0;
      return { async respond(request) {
        if (turn++ === 0) return { responseId: "tool", text: "", toolCalls: [{ callId: "write", name: "fixture_write", arguments: "{}" }] };
        output = request.toolOutputs[0]?.output ?? "";
        return { responseId: "final", text: "Finished.", toolCalls: [] };
      } };
    }, { tools: [{
      name: "fixture_write", operation, description: "Synthetic operation counter.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { executions += 1; return { ok: true, output: "written" }; },
    }] });
    const controller = new TuiController(runtime, () => { if (controller.state.approval) approved.release(); });
    t.after(() => controller.close());
    await controller.initialize({ provider: "fixture", model: "fixture-custom" });
    assert.equal(controller.state.session?.model, "fixture-custom");
    const submission = controller.submit("Perform the synthetic write.");
    await approved.promise;
    assert.equal(executions, 0);
    assert.equal(controller.state.busy, true);
    assert.equal(controller.decide(decision), true);
    assert.equal(controller.decide(decision), false, "an approval cannot be replayed");
    await submission;
    assert.equal(executions, decision === "deny" ? 0 : 1);
    if (decision === "deny") assert.match(output, /denied/i);
    else assert.equal(output, "written");
    assert.equal(controller.state.approval, undefined);
    assert.equal(controller.state.busy, false);
  });
}

}

test("M72 streams into one assistant slot and reconciles the final result", { timeout: 10_000 }, async (t) => {
  const observed = barrier();
  const finish = barrier();
  const prefix = "An intermediate explanation. ".repeat(20);
  const { runtime } = await fixture(t, () => ({ async respond(_request, delta) {
    delta?.(prefix);
    await finish.promise;
    delta?.("Final answer.");
    return { responseId: "streamed", text: "Final answer.", textWasStreamed: true, toolCalls: [] };
  } }));
  const controller = new TuiController(runtime, () => {
    if (controller.state.messages.some((message) => message.role === "assistant" && message.text.length > 0)) observed.release();
  });
  t.after(() => { finish.release(); return controller.close(); });
  await controller.initialize();
  const submission = controller.submit("Stream a response.");
  await observed.promise;
  assert.equal(controller.state.busy, true);
  assert.equal(controller.state.messages.filter((message) => message.role === "assistant").length, 1);
  finish.release();
  await submission;
  assert.deepEqual(controller.state.messages, [
    { role: "user", text: "Stream a response." }, { role: "assistant", text: "Final answer." },
  ]);
  assert.equal(controller.state.status?.session?.messageCount, 2);
});

test("M72 cancels an active model, clears approval, and permits a later run", { timeout: 10_000 }, async (t) => {
  const started = barrier();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const { runtime } = await fixture(t, () => ({ async respond(request) {
    if (calls++ > 0) return { responseId: "next", text: "Recovered.", toolCalls: [] };
    signal = request.signal;
    started.release();
    await new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    throw new Error("unreachable");
  } }));
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  await controller.initialize();
  const submission = controller.submit("Wait.");
  await started.promise;
  assert.equal(controller.cancel(), true);
  assert.equal(controller.cancel(), false);
  assert.equal(signal?.aborted, true);
  await submission;
  assert.equal(controller.state.busy, false);
  assert.equal(controller.state.error, undefined);
  assert.ok(controller.state.messages.some((message) => /cancelled/i.test(message.text)));
  assert.equal((await runtime.resumeSession(controller.state.session!.id)).messageCount, 0);
  await controller.submit("Try again.");
  assert.equal(controller.state.messages.at(-1)?.text, "Recovered.");
});

for (const action of ["cancel", "close"] as const) {
  test(`M72 ${action} during admission locks submit and prevents orphan runs`, { timeout: 10_000 }, async (t) => {
    const entered = barrier();
    const release = barrier();
    let hold = false;
    let calls = 0;
    const { runtime } = await fixture(t, () => ({ async respond() {
      calls += 1;
      return { responseId: "unexpected", text: "Unexpected.", toolCalls: [] };
    } }), { wrapStore: (store) => ({ ...store, async load(id) {
      if (hold) { hold = false; entered.release(); await release.promise; }
      return store.load(id);
    } }) });
    const controller = new TuiController(runtime);
    t.after(() => { release.release(); return controller.close(); });
    await controller.initialize();
    hold = true;
    const submission = controller.submit("First.");
    assert.equal(controller.state.busy, true, "lock precedes the first await");
    await controller.submit("Must not start.");
    await entered.promise;
    const closing = action === "close" ? controller.close() : undefined;
    if (action === "cancel") assert.equal(controller.cancel(), true);
    release.release();
    await submission;
    await closing;
    assert.equal(calls, 0);
    assert.equal(controller.state.busy, false);
    assert.equal(controller.state.messages.filter((message) => message.role === "user").length, 1);
    if (action === "close") await assert.rejects(runtime.createSession(), /disposed/);
    else assert.equal((await runtime.status({ sessionId: controller.state.session!.id })).activeRunId, undefined);
  });
}

test("M72 closes safely while session initialization is pending", { timeout: 10_000 }, async (t) => {
  const entered = barrier();
  const release = barrier();
  const { runtime } = await fixture(t, answer, { wrapStore: (store) => ({ ...store, async create(metadata) {
    entered.release();
    await release.promise;
    return store.create(metadata);
  } }) });
  const controller = new TuiController(runtime);
  t.after(() => { release.release(); return controller.close(); });
  const initialization = controller.initialize();
  await entered.promise;
  const closing = controller.close();
  release.release();
  await Promise.all([initialization, closing, controller.close()]);
  assert.equal(controller.state.session, undefined);
  assert.equal(controller.state.busy, false);
  await controller.submit("Never admitted.");
  await assert.rejects(runtime.createSession(), /disposed/);
});

test("M72 resumes only a runtime summary without inventing a prior transcript", async (t) => {
  const { runtime, store } = await fixture(t, answer);
  const session = await runtime.createSession();
  const run = await runtime.sendUserInput({ sessionId: session.id, content: "Prior private transcript." });
  for await (const _event of run.events) { /* Drain the real runtime. */ }
  await run.result;
  let creates = 0;
  const create = runtime.createSession.bind(runtime);
  runtime.createSession = async (options) => { creates += 1; return create(options); };
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  await controller.initialize({ resume: session.id, provider: "not-a-provider", model: "ignored" });
  assert.equal(creates, 0);
  assert.equal((await store.list()).length, 1);
  assert.equal(controller.state.session?.id, session.id);
  assert.equal(controller.state.session?.messageCount, 2);
  assert.equal(controller.state.session?.planTaskCount, 0);
  assert.deepEqual(controller.state.background, []);
  assert.equal(controller.state.messages.length, 1);
  assert.equal(controller.state.messages[0]?.role, "notice");
  assert.match(controller.state.messages[0]?.text ?? "", /prior transcript.*not available.*runtime/i);
  assert.doesNotMatch(JSON.stringify(controller.state), /Prior private transcript|Final answer/);
});

test("M72 acknowledges and rejects memory suggestions without hanging or accepting", { timeout: 10_000 }, async (t) => {
  const { runtime, memory } = await fixture(t, () => {
    let turn = 0;
    return { async respond() {
      if (turn++ === 0) return { responseId: "suggest", text: "", toolCalls: [{
        callId: "memory", name: "suggest_memory", arguments: JSON.stringify({ scope: "user", body: "Prefer deterministic fixtures." }),
      }] };
      return { responseId: "done", text: "Done.", toolCalls: [] };
    } };
  });
  const resolutions: string[] = [];
  const acknowledge = runtime.acknowledgeMemorySuggestion.bind(runtime);
  const resolve = runtime.resolveMemorySuggestion.bind(runtime);
  runtime.acknowledgeMemorySuggestion = (input) => { resolutions.push("acknowledge"); return acknowledge(input); };
  runtime.resolveMemorySuggestion = (input) => { resolutions.push(input.decision); return resolve(input); };
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  await controller.initialize();
  await controller.submit("Suggest a memory.");
  assert.deepEqual(resolutions, ["acknowledge", "reject"]);
  assert.deepEqual(await memory.list(), []);
  assert.deepEqual(await memory.listSuggestions(), []);
  assert.ok(controller.state.messages.some((message) => message.role === "notice" && /memory suggestion rejected/i.test(message.text)));
});

test("M72 bounds retained messages and tool activity on real runtime runs", { timeout: 20_000 }, async (t) => {
  const { runtime } = await fixture(t, () => {
    let turn = 0;
    return { async respond(_request, delta) {
      if (turn++ === 0) return { responseId: "read", text: "", toolCalls: [{ callId: "read", name: "fixture_read", arguments: "{}" }] };
      for (let index = 0; index < 12; index += 1) delta?.("text ".repeat(1000));
      return { responseId: "bounded", text: "end ".repeat(6000), textWasStreamed: true, toolCalls: [] };
    } };
  }, { tools: [{
    name: "fixture_read", operation: "READ", description: "Synthetic output.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { ok: true, output: "output ".repeat(3000) }; },
  }] });
  let maxText = 0;
  let exceededBounds = false;
  const controller = new TuiController(runtime, () => {
    for (const message of controller.state.messages) maxText = Math.max(maxText, message.text.length);
    exceededBounds ||= controller.state.messages.length > 100
      || controller.state.activity.length > 50
      || controller.state.activity.some((entry) => entry.length > 2000);
  });
  t.after(() => controller.close());
  await controller.initialize();
  for (let index = 0; index < 52; index += 1) await controller.submit(`${index} ${"input ".repeat(3000)}`);
  assert.equal(controller.state.messages.length, 100);
  assert.equal(controller.state.activity.length, 50);
  assert.equal(maxText, 16_000);
  assert.equal(exceededBounds, false);
  assert.ok(controller.state.messages.every((message) => message.text.length <= 16_000));
});

test("M72 ignores cross-run and cross-session events before processing approvals or text", async (t) => {
  const { runtime } = await fixture(t, answer);
  const send = runtime.sendUserInput.bind(runtime);
  runtime.sendUserInput = async (input): Promise<RuntimeRunHandle> => {
    const handle = await send(input);
    return { ...handle, events: (async function* () {
      const foreign = [
        { runId: "another-run", sessionId: handle.sessionId },
        { runId: handle.id, sessionId: "another-session" },
      ];
      for (const ids of foreign) {
        yield { type: "assistant_delta", ...ids, text: "Foreign text" } satisfies RuntimeEvent;
        yield { type: "approval_requested", ...ids, approvalId: "foreign", toolName: "foreign", operation: "WRITE" } satisfies RuntimeEvent;
        yield { type: "memory_suggestion", ...ids, suggestionId: "foreign", scope: "USER", body: "Foreign memory" } satisfies RuntimeEvent;
        yield { type: "run_failed", ...ids, message: "Foreign failure" } satisfies RuntimeEvent;
      }
      yield* handle.events;
    })() };
  };
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  await controller.initialize();
  await controller.submit("Owned input.");
  assert.doesNotMatch(JSON.stringify(controller.state), /foreign/i);
  assert.equal(controller.state.messages.at(-1)?.text, "Final answer.");
  assert.equal(controller.decide("allow_once"), false);
});

test("M72 contains arbitrary admission, initialization, and refresh errors", async (t) => {
  const { runtime } = await fixture(t, answer);
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  const create = runtime.createSession.bind(runtime);
  runtime.createSession = async () => { throw new Error("arbitrary-private-create-value"); };
  await controller.initialize();
  assert.match(controller.state.error ?? "", /session/i);
  assert.doesNotMatch(JSON.stringify(controller.state), /arbitrary-private/);
  runtime.createSession = create;
  await controller.initialize();
  runtime.sendUserInput = async () => { throw new Error("arbitrary-private-admission-value"); };
  await controller.submit("Fail safely.");
  assert.match(controller.state.error ?? "", /run/i);
  runtime.status = async () => { throw new Error("arbitrary-private-status-value"); };
  await controller.refresh();
  assert.match(controller.state.error ?? "", /status/i);
  assert.doesNotMatch(JSON.stringify(controller.state), /arbitrary-private/);
  assert.equal(controller.state.busy, false);
});

test("M72 immediately handles result rejection while consuming a failing real run", { timeout: 10_000 }, async (t) => {
  const { runtime } = await fixture(t, () => ({ async respond() { throw new Error("Synthetic provider failure."); } }));
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  await controller.initialize();
  await controller.submit("Fail.");
  assert.equal(controller.state.busy, false);
  assert.match(controller.state.error ?? "", /failure|failed/i);
  assert.equal(controller.state.approval, undefined);
});

for (const action of ["cancel", "close"] as const) {
  test(`M72 ${action} cancels a real handle delivered after startup`, { timeout: 10_000 }, async (t) => {
    const started = barrier();
    const release = barrier();
    let signal: AbortSignal | undefined;
    const { runtime } = await fixture(t, () => ({ async respond(request) {
      signal = request.signal;
      started.release();
      await new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      throw new Error("unreachable");
    } }));
    const send = runtime.sendUserInput.bind(runtime);
    let cancelCalls = 0;
    runtime.sendUserInput = async (input) => {
      const handle = await send(input);
      await release.promise;
      return { ...handle, cancel() { cancelCalls += 1; return handle.cancel(); } };
    };
    const controller = new TuiController(runtime);
    t.after(() => { release.release(); return controller.close(); });
    await controller.initialize();
    const submission = controller.submit("Hold at the caller boundary.");
    await started.promise;
    const closing = action === "close" ? controller.close() : undefined;
    if (action === "cancel") assert.equal(controller.cancel(), true);
    release.release();
    await Promise.all([submission, closing]);
    assert.equal(signal?.aborted, true);
    assert.equal(cancelCalls, 1, "even a handle delivered after cancellation must be cancelled");
    assert.equal(controller.state.busy, false);
    assert.equal(controller.state.approval, undefined);
  });
}

test("M72 cancellation rejects a pending approval without executing its tool", { timeout: 10_000 }, async (t) => {
  const approval = barrier();
  let executions = 0;
  const { runtime } = await fixture(t, () => ({ async respond() {
    return { responseId: "pending", text: "", toolCalls: [{ callId: "pending", name: "pending_write", arguments: "{}" }] };
  } }), { tools: [{
    name: "pending_write", operation: "WRITE", description: "Synthetic pending write.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { executions += 1; return { ok: true, output: "unexpected" }; },
  }] });
  const controller = new TuiController(runtime, () => { if (controller.state.approval) approval.release(); });
  t.after(() => controller.close());
  await controller.initialize();
  const submission = controller.submit("Ask, then cancel.");
  await approval.promise;
  assert.equal(controller.cancel(), true);
  assert.equal(controller.decide("allow_once"), false);
  await submission;
  assert.equal(executions, 0);
  assert.equal(controller.state.approval, undefined);
  assert.equal(controller.state.busy, false);
});

test("M72 refresh reads real background summaries and ignores stale status responses", { timeout: 10_000 }, async (t) => {
  const started = barrier();
  const release = barrier();
  const { runtime } = await fixture(t, () => ({ async respond(request) {
    started.release();
    await new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    throw new Error("unreachable");
  } }));
  const controller = new TuiController(runtime);
  t.after(() => { release.release(); return controller.close(); });
  await controller.initialize();
  const task = await runtime.startBackgroundTask({ sessionId: controller.state.session!.id, prompt: "Private background prompt." });
  await started.promise;
  await controller.refresh();
  assert.deepEqual(controller.state.background.map((item) => [item.id, item.state]), [[task.id, "running"]]);
  assert.doesNotMatch(JSON.stringify(controller.state), /Private background prompt/);
  const status = runtime.status.bind(runtime);
  let delay = true;
  const entered = barrier();
  runtime.status = async (options) => {
    const result = await status(options);
    if (delay) { delay = false; entered.release(); await release.promise; return { ...result, contextCharacters: 12345 }; }
    return result;
  };
  const stale = controller.refresh();
  await entered.promise;
  await controller.refresh();
  release.release();
  await stale;
  assert.equal(controller.state.status?.contextCharacters, 0);
});

test("M72 retains the final assistant slot after notices evict earlier messages", { timeout: 20_000 }, async (t) => {
  const { runtime, memory } = await fixture(t, () => {
    let turn = 0;
    return { async respond() {
      if (turn++ === 0) return {
        responseId: "many-suggestions", text: "Intermediate text. ".repeat(40),
        toolCalls: Array.from({ length: 102 }, (_, index) => ({
          callId: `memory-${index}`, name: "suggest_memory",
          arguments: JSON.stringify({ scope: "user", body: `Synthetic preference ${index}.` }),
        })),
      };
      return { responseId: "final-after-notices", text: "Final answer survives.", toolCalls: [] };
    } };
  });
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  await controller.initialize();
  await controller.submit("Exercise bounded memory notices.");
  assert.equal(controller.state.error, undefined);
  assert.equal(controller.state.messages.length, 100);
  assert.deepEqual(controller.state.messages.filter((message) => message.role === "assistant"), [
    { role: "assistant", text: "Final answer survives." },
  ]);
  assert.deepEqual(await memory.list(), []);
  assert.deepEqual(await memory.listSuggestions(), []);
});

test("M72 handles result rejection before a deliberately delayed event consumer", { timeout: 10_000 }, async (t) => {
  const { runtime } = await fixture(t, () => ({ async respond() { throw new Error("Synthetic early failure."); } }));
  const send = runtime.sendUserInput.bind(runtime);
  runtime.sendUserInput = async (input) => {
    const handle = await send(input);
    return { ...handle, events: (async function* () {
      // Give Node an event-loop turn to detect any unhandled result rejection.
      // Only the controller, not this transport wrapper, observes handle.result.
      const events: RuntimeEvent[] = [];
      for await (const event of handle.events) events.push(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
      yield* events;
    })() };
  };
  const controller = new TuiController(runtime);
  t.after(() => controller.close());
  await controller.initialize();
  await controller.submit("Fail before event consumption.");
  assert.equal(controller.state.busy, false);
  assert.match(controller.state.error ?? "", /failure|failed/i);
});
