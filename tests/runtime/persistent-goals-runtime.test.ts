import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFilePersistentGoalStore } from "../../dist/persistent-goal-store.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createRuntimePersistentGoalManager } from "../../dist/persistent-goals-runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

test("goal adapter uses only the real runtime READ path, bound session, and host-owned completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-goal-runtime-"));
  let calls = 0;
  let hostVerified = false;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "model", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      calls++;
      if (calls === 1) return { responseId: "before", text: "Earlier context", toolCalls: [] };
      assert.equal(request.conversationResponseId, calls === 2 ? "before" : "goal-1");
      assert.ok(request.tools.length > 0 && request.tools.every((tool) => tool.operation === "READ"));
      assert.equal(request.tools.some((tool) => tool.name === "write_fixture"), false);
      assert.match(request.task, /Review open tasks/);
      return { responseId: `goal-${calls - 1}`, text: calls === 2 ? "not done" : "done", toolCalls: [] };
    } }),
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [{ name: "write_fixture", operation: "WRITE", description: "Fixture", inputSchema: { type: "object", properties: {} }, async execute() { assert.fail("WRITE reached unattended goal"); } }],
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const foreground = await runtime.sendUserInput({ sessionId: session.id, content: "Initial" });
    for await (const _event of foreground.events) { /* drain */ }
    await foreground.result;
    const store = createFilePersistentGoalStore(join(root, "goals"));
    const manager = createRuntimePersistentGoalManager({ runtime, store, evaluateCompletion: () => hostVerified });
    const goal = await manager.create({ sessionId: session.id, workingDirectory: session.workingDirectory, objective: "Review open tasks", criterion: "All reviewed", maxTurns: 3, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal((await manager.advance(goal.id))?.state, "ready");
    hostVerified = true;
    assert.equal((await manager.advance(goal.id))?.state, "completed");
    assert.equal(calls, 3);
    assert.equal((await runtime.resumeSession(session.id)).messageCount, 6);
    assert.equal((await store.load(goal.id))?.state, "completed");
    assert.equal((await manager.advance(goal.id)), undefined);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("goal adapter rejects a persisted cross-workspace session before asking runtime for a model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-goal-scope-"));
  let calls = 0;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "model", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond() { calls++; return { responseId: "reply", text: "done", toolCalls: [] }; } }),
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const manager = createRuntimePersistentGoalManager({ runtime, store: createFilePersistentGoalStore(join(root, "goals")), evaluateCompletion: () => true });
    const goal = await manager.create({ sessionId: session.id, workingDirectory: "/not-the-runtime-workspace", objective: "Read", criterion: "Done", maxTurns: 2, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    await assert.rejects(manager.advance(goal.id), /workspace/);
    assert.equal(calls, 0);
    assert.equal((await manager.load(goal.id))?.state, "interrupted");
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("goal adapter denies unexpected approvals and fails closed without claiming completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-goal-approval-"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let cancelled = false;
  const denied: string[] = [];
  const runtime = {
    async status() { return { session: { id: sessionId, workingDirectory: root }, activeRunId: undefined }; },
    async sendUserInput(input: { sessionId: string; content: string; readOnly?: boolean }) {
      assert.equal(input.readOnly, true);
      return { id: "run-1", cancel: () => { cancelled = true; return true; },
        events: (async function* () { yield { type: "approval_requested" as const, approvalId: "bad", runId: "run-1", sessionId, toolName: "write", operation: "WRITE" as const }; })(),
        result: new Promise<never>(() => {}) };
    },
    resolveAuthorization(input: { runId: string; approvalId: string; decision: string }) { denied.push(input.decision); return true; },
  };
  // A deterministic fake probes the adapter's defensive event boundary; a real runtime never emits approvals in READ-only mode.
  const manager = createRuntimePersistentGoalManager({ runtime: runtime as unknown as Parameters<typeof createRuntimePersistentGoalManager>[0]["runtime"],
    store: createFilePersistentGoalStore(join(root, "goals")), evaluateCompletion: () => true });
  try {
    const goal = await manager.create({ sessionId, workingDirectory: root, objective: "Read", criterion: "Done", maxTurns: 2, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    await assert.rejects(manager.advance(goal.id), /approval/);
    assert.deepEqual(denied, ["deny"]);
    assert.equal(cancelled, true);
    assert.equal((await manager.load(goal.id))?.state, "interrupted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("goal adapter cancels tool activity whose READ classification cannot be established", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-goal-unknown-tool-"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let cancelled = false;
  let evaluated = false;
  const runtime = {
    async status() { return { session: { id: sessionId, workingDirectory: root }, activeRunId: undefined }; },
    async sendUserInput() {
      return { id: "run-1", cancel: () => { cancelled = true; return true; },
        events: (async function* () { yield { type: "tool_activity" as const, runId: "run-1", sessionId, toolName: "unknown", phase: "started" as const }; })(),
        result: Promise.resolve({ finalText: "I finished everything", responseId: "r1", turns: 1 }) };
    },
    resolveAuthorization() { assert.fail("no approval was requested"); },
  };
  const manager = createRuntimePersistentGoalManager({ runtime: runtime as unknown as Parameters<typeof createRuntimePersistentGoalManager>[0]["runtime"],
    store: createFilePersistentGoalStore(join(root, "goals")), evaluateCompletion: () => { evaluated = true; return true; } });
  try {
    const goal = await manager.create({ sessionId, workingDirectory: root, objective: "Read", criterion: "Done", maxTurns: 2, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    await assert.rejects(manager.advance(goal.id), /effectful tool/);
    assert.equal(cancelled, true);
    assert.equal(evaluated, false);
    assert.equal((await manager.load(goal.id))?.state, "interrupted");
  } finally { await rm(root, { recursive: true, force: true }); }
});
