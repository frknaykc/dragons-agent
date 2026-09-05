import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { createMemoryStore } from "./memory.js";
import { createSessionPlanStore } from "./plan.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "./runtime.js";
import { createSessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

function fixtureProvider(createModel: ProviderDescriptor["createModel"]): ProviderDescriptor {
  return {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: {
      streaming: true,
      toolCalls: true,
      toolResultContinuation: true,
      usageMetadata: false,
    },
    createModel,
  };
}

test("M71 runs a programmatic session through structured runtime events", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-api-"));
  const sessions = join(root, "sessions");
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond() {
      return { responseId: "fixture-response", text: "Programmatic answer.", toolCalls: [] };
    },
  }))]);
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(sessions, { providerIds: providers.ids() }),
    tools: [],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    assert.deepEqual(runtime.providers(), [{
      id: "fixture",
      label: "Fixture Provider",
      defaultModel: "fixture-1",
      credentialRequirement: "none",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: false,
      },
    }]);

    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Inspect safely." });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    const result = await run.result;

    assert.equal(result.finalText, "Programmatic answer.");
    assert.deepEqual(events.filter((event) => event.type !== "assistant_delta").map((event) => event.type), ["run_started", "run_completed"]);
    assert.equal(events.flatMap((event) => event.type === "assistant_delta" ? [event.text] : []).join(""), result.finalText);
    assert.deepEqual(await runtime.resumeSession(session.id), {
      ...session,
      updatedAt: (await runtime.resumeSession(session.id)).updatedAt,
      messageCount: 2,
      hasContinuation: true,
      planTaskCount: 0,
    });
    assert.doesNotMatch(JSON.stringify(events), /terminal|authorization|credential|secret/i);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 binds client approval to the pending runtime run before a write executes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-approval-"));
  const sessions = join(root, "sessions");
  let toolExecuted = false;
  let turn = 0;
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "approval-first",
          text: "",
          toolCalls: [{ callId: "write-1", name: "write_fixture", arguments: "{\"path\":\"safe.txt\"}" }],
        };
      }
      assert.deepEqual(request.toolOutputs, [{ callId: "write-1", output: "write completed" }]);
      return { responseId: "approval-final", text: "Write approved.", toolCalls: [] };
    },
  }))]);
  const writeTool: AgentTool = {
    name: "write_fixture",
    operation: "WRITE",
    description: "Fixture write.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(input) {
      assert.deepEqual(input, { path: "safe.txt" });
      toolExecuted = true;
      return { ok: true, output: "write completed" };
    },
  };
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(sessions, { providerIds: providers.ids() }),
    tools: [writeTool],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Write a safe fixture." });
    const iterator = run.events[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "run_started");
    const authorizationStarted = await iterator.next();
    assert.equal(authorizationStarted.value?.type, "tool_activity");
    if (authorizationStarted.value?.type !== "tool_activity") throw new Error("Expected structured tool authorization activity.");
    assert.deepEqual(authorizationStarted.value, {
      type: "tool_activity",
      runId: run.id,
      sessionId: session.id,
      toolName: "write_fixture",
      operation: "WRITE",
      phase: "authorization_requested",
    });
    const pending = await iterator.next();
    assert.equal(pending.done, false);
    assert.equal(pending.value?.type, "approval_requested");
    if (pending.value?.type !== "approval_requested") throw new Error("Expected a structured approval event.");
    assert.equal(toolExecuted, false, "the existing authorizer must gate the write before execution");
    assert.equal(runtime.resolveAuthorization({
      runId: "different-run",
      approvalId: pending.value.approvalId,
      decision: "allow_once",
    }), false);
    assert.equal(toolExecuted, false);
    assert.equal(runtime.resolveAuthorization({
      runId: run.id,
      approvalId: pending.value.approvalId,
      decision: "allow_once",
    }), true);

    const remaining: RuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    const result = await run.result;
    assert.equal(result.finalText, "Write approved.");
    assert.equal(toolExecuted, true);
    assert.deepEqual(remaining.filter((event) => event.type !== "assistant_delta").map((event) => event.type), ["tool_activity", "tool_activity", "tool_activity", "run_completed"]);
    assert.equal(remaining.flatMap((event) => event.type === "assistant_delta" ? [event.text] : []).join(""), result.finalText);
    assert.deepEqual(remaining.slice(0, 3).map((event) => event.type === "tool_activity" ? event.phase : undefined), [
      "authorization_completed",
      "started",
      "completed",
    ]);
    assert.equal("arguments" in pending.value, false, "raw tool arguments must not enter client events");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 exposes session context and bounded diagnostics without transcript internals", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-status-"));
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond() {
      return { responseId: "status-response", text: "Status answer.", toolCalls: [] };
    },
  }))]);
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Show runtime status." });
    for await (const _event of run.events) { /* Drain the client stream before inspecting completed diagnostics. */ }
    await run.result;

    const status = await runtime.status({ sessionId: session.id });
    assert.equal(status.session?.id, session.id);
    assert.equal(status.activeRunId, undefined);
    assert.equal(status.contextBudgetChars > 0, true);
    assert.equal(status.contextCharacters > 0, true);
    assert.equal(status.recentDiagnostics.length, 1);
    assert.equal(status.recentDiagnostics[0]?.status, "success");
    assert.doesNotMatch(JSON.stringify(status), /Show runtime status|Status answer/i);
    assert.equal("continuation" in (status.session ?? {}), false);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 cancellation reaches an active model and leaves the session at its last completed turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-cancel-"));
  let signalFromModel: AbortSignal | undefined;
  let startedModel!: () => void;
  const modelStarted = new Promise<void>((resolve) => { startedModel = resolve; });
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond(request) {
      signalFromModel = request.signal;
      startedModel();
      await new Promise<never>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      throw new Error("The cancelled model must not complete.");
    },
  }))]);
  const sessions = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: sessions,
    tools: [],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Wait for cancellation." });
    await modelStarted;
    assert.equal(run.cancel(), true);
    assert.equal(signalFromModel?.aborted, true);
    const cancelledResult = assert.rejects(run.result, { name: "AgentRunCancelledError" });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    await cancelledResult;
    assert.deepEqual(events.map((event) => event.type), ["run_started", "run_cancelled"]);
    assert.equal((await runtime.resumeSession(session.id)).messageCount, 0);
    assert.equal((await runtime.status({ sessionId: session.id })).recentDiagnostics[0]?.status, "cancelled");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 redacts and bounds model and tool text before it reaches client events", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-redaction-"));
  let turn = 0;
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "redaction-first",
          text: "",
          toolCalls: [{ callId: "read-1", name: "read_fixture", arguments: "{}" }],
        };
      }
      assert.match(request.toolOutputs[0]?.output ?? "", /fixture-tool-token/);
      return { responseId: "redaction-final", text: "api_key=fixture-model-secret-1234567890", toolCalls: [] };
    },
  }))]);
  const readTool: AgentTool = {
    name: "read_fixture",
    operation: "READ",
    description: "Fixture read.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { ok: true, output: `Bearer fixture-tool-token-1234567890 ${"x".repeat(12_000)}` };
    },
  };
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [readTool],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Read a fixture." });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    await run.result;

    const completed = events.find((event): event is Extract<RuntimeEvent, { type: "tool_activity" }> => event.type === "tool_activity" && event.phase === "completed");
    const delta = events.find((event): event is Extract<RuntimeEvent, { type: "assistant_delta" }> => event.type === "assistant_delta");
    assert.ok(completed?.output);
    assert.match(completed.output, /\[REDACTED\]/);
    assert.match(completed.output, /truncated/);
    assert.ok(completed.output.length < 9_000);
    assert.match(delta?.text ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(events), /fixture-tool-token|fixture-model-secret/);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 composes existing memory, plans, and bounded delegation tools into a runtime run", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-composition-"));
  const memoryStore = createMemoryStore(join(root, "memory"));
  await memoryStore.add({ body: "fixture guidance for planning", scope: { kind: "USER" } });
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond(request) {
      assert.deepEqual(request.memory?.memories.map((memory) => memory.body), ["fixture guidance for planning"]);
      assert.equal(request.plan?.tasks.length, 1);
      const names = new Set(request.tools.map((tool) => tool.name));
      for (const name of ["plan_list", "plan_add", "suggest_memory", "delegate_subagent", "delegate_parallel_subagents", "orchestrate_runnable"]) {
        assert.equal(names.has(name), true, `missing existing core tool ${name}`);
      }
      return { responseId: "composition-response", text: "Composed safely.", toolCalls: [] };
    },
  }))]);
  const sessions = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: sessions,
    tools: [],
    memoryStore,
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    await createSessionPlanStore(sessions, session.id).add({ title: "Inspect", description: "Inspect the fixture safely." });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Use fixture guidance for planning." });
    for await (const _event of run.events) { /* Consume the structured client stream. */ }
    assert.equal((await run.result).finalText, "Composed safely.");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 binds an explicit memory suggestion to its runtime session before it can be accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-memory-suggestion-"));
  const memoryStore = createMemoryStore(join(root, "memory"));
  let turn = 0;
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond() {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "suggestion-first",
          text: "",
          toolCalls: [{
            callId: "suggestion-1",
            name: "suggest_memory",
            arguments: "{\"body\":\"User prefers deterministic fixtures.\",\"scope\":\"user\",\"reason\":\"Stable testing preference.\"}",
          }],
        };
      }
      return { responseId: "suggestion-final", text: "Suggestion is waiting for review.", toolCalls: [] };
    },
  }))]);
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [],
    memoryStore,
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Remember my testing preference." });
    const events: RuntimeEvent[] = [];
    const iterator = run.events[Symbol.asyncIterator]();
    let suggestion: Extract<RuntimeEvent, { type: "memory_suggestion" }> | undefined;
    while (!suggestion) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      if (next.done) throw new Error("Runtime ended before displaying a memory suggestion.");
      events.push(next.value);
      if (next.value.type === "memory_suggestion") suggestion = next.value;
    }
    assert.equal(suggestion.body, "User prefers deterministic fixtures.");
    assert.equal(runtime.acknowledgeMemorySuggestion({
      runId: "wrong-run",
      sessionId: session.id,
      suggestionId: suggestion.suggestionId,
    }), false);
    assert.equal(runtime.acknowledgeMemorySuggestion({
      runId: run.id,
      sessionId: session.id,
      suggestionId: suggestion.suggestionId,
    }), true);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    await run.result;
    assert.equal(await runtime.resolveMemorySuggestion({
      runId: "wrong-run",
      sessionId: session.id,
      suggestionId: suggestion.suggestionId,
      decision: "accept",
    }), false);
    assert.deepEqual(await memoryStore.list(), []);
    assert.equal(await runtime.resolveMemorySuggestion({
      runId: run.id,
      sessionId: session.id,
      suggestionId: suggestion.suggestionId,
      decision: "accept",
    }), true);
    assert.deepEqual((await memoryStore.list()).map((memory) => memory.body), ["User prefers deterministic fixtures."]);
    assert.equal(await runtime.resolveMemorySuggestion({
      runId: run.id,
      sessionId: session.id,
      suggestionId: suggestion.suggestionId,
      decision: "accept",
    }), false);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
