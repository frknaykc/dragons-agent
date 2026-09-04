import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { AgentRunCancelledError, runAgent } from "./agent.js";
import { main } from "./cli.js";
import { createPlanOrchestrationTools, createPlanOrchestrator, executePlanQueue, type OrchestrationExecutor, type OrchestrationResult } from "./orchestration.js";
import { createSessionPlanStore, type DragonsPlanTask } from "./plan.js";
import { createSessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

type StoredSession = { id: string; updatedAt: string; plan?: unknown };

const SESSION = "11111111-1111-4111-8111-111111111111";
const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
];

function planStore() {
  let session: StoredSession = { id: SESSION, updatedAt: "2026-09-04T00:00:00.000Z" };
  let index = 0;
  const store = createSessionPlanStore({
    async load(id) { return id === SESSION ? structuredClone(session) as never : undefined; },
    async save(next) { session = structuredClone(next) as StoredSession; },
  }, SESSION, { createId: () => IDS[index++]! });
  return { store, session: () => structuredClone(session) };
}

function success(taskId: string, strategy: OrchestrationResult["strategy"]): OrchestrationResult {
  return { taskId, strategy, status: "COMPLETED", summary: "safe bounded result" };
}

test("M65 executes dependency-ready work in deterministic local then parallel order and records bounded provenance", async () => {
  const { store } = planStore();
  const a = await store.add({ title: "Inspect", description: "Inspect safely." });
  const b = await store.add({ title: "Research one", description: "Read one.", dependsOn: [a.id] });
  const c = await store.add({ title: "Research two", description: "Read two.", dependsOn: [a.id] });
  const d = await store.add({ title: "Aggregate", description: "Aggregate findings.", dependsOn: [b.id, c.id] });
  const calls: string[] = [];
  const executor: OrchestrationExecutor = {
    async local(task) { calls.push(`local:${task.id}`); return success(task.id, "LOCAL"); },
    async parallel(tasks) { calls.push(`parallel:${tasks.map((task) => task.id).join(",")}`); return tasks.map((task) => success(task.id, "PARALLEL_READ")); },
  };
  const orchestrator = createPlanOrchestrator({ store, executor, maxSubagents: 2, maxParallelism: 2 });

  assert.deepEqual((await orchestrator.execute([{ taskId: a.id }])).map((result) => result.status), ["COMPLETED"]);
  assert.deepEqual(await store.list().then((tasks) => tasks.filter((task) => task.status === "TODO").map((task) => task.id)), [b.id, c.id, d.id]);
  assert.deepEqual((await orchestrator.execute([{ taskId: c.id }, { taskId: b.id }])).map((result) => result.taskId), [b.id, c.id]);
  assert.deepEqual(await orchestrator.execute([{ taskId: d.id }]), [success(d.id, "LOCAL")]);
  assert.deepEqual(calls, [`local:${a.id}`, `parallel:${b.id},${c.id}`, `local:${d.id}`]);
  assert.deepEqual((await store.list()).map((task) => task.status), ["DONE", "DONE", "DONE", "DONE"]);
  assert.deepEqual(orchestrator.records().map((record) => ({ taskId: record.taskId, strategy: record.strategy, status: record.status })), [
    { taskId: a.id, strategy: "LOCAL", status: "COMPLETED" },
    { taskId: b.id, strategy: "PARALLEL_READ", status: "COMPLETED" },
    { taskId: c.id, strategy: "PARALLEL_READ", status: "COMPLETED" },
    { taskId: d.id, strategy: "LOCAL", status: "COMPLETED" },
  ]);
});

test("M65 rejects blocked, over-budget, and effectful-parallel work before execution", async () => {
  const { store } = planStore();
  const prerequisite = await store.add({ title: "Prerequisite", description: "Finish first." });
  const blocked = await store.add({ title: "Blocked", description: "Must wait.", dependsOn: [prerequisite.id] });
  let calls = 0;
  const orchestrator = createPlanOrchestrator({
    store,
    executor: { async local(task) { calls += 1; return success(task.id, "LOCAL"); } },
    maxSubagents: 2,
    maxParallelism: 1,
  });

  await assert.rejects(orchestrator.execute([{ taskId: blocked.id }]), /not runnable/i);
  await assert.rejects(orchestrator.execute([{ taskId: prerequisite.id }, { taskId: blocked.id }]), /not runnable/i);
  assert.equal(calls, 0);

  await orchestrator.execute([{ taskId: prerequisite.id }]);
  await assert.rejects(orchestrator.execute([{ taskId: blocked.id, strategy: "PARALLEL_READ" }]), /parallel/i);
  assert.equal(calls, 1);

  const effectful = await store.add({ title: "Effectful", description: "Requires a grant." });
  let effectCalls = 0;
  const effectfulExecutor: OrchestrationExecutor = { async effectfulBackground(task: DragonsPlanTask) { effectCalls += 1; return success(task.id, "EFFECTFUL_BACKGROUND"); } };
  const effectfulOrchestrator = createPlanOrchestrator({
    store,
    executor: effectfulExecutor,
  });
  await assert.rejects(effectfulOrchestrator.execute([{ taskId: effectful.id, strategy: "EFFECTFUL_BACKGROUND" }]), /explicit M61 grant/i);
  assert.equal(effectCalls, 0);
});

test("M65 preserves failed/cancelled state without blind redispatch and reconciles detached persistent work", async () => {
  const { store } = planStore();
  const failed = await store.add({ title: "Failure", description: "May fail." });
  const detached = await store.add({ title: "Background", description: "Long-lived read-only research." });
  const cancelled = await store.add({ title: "Cancelled", description: "Will cancel." });
  let calls = 0;
  const orchestrator = createPlanOrchestrator({
    store,
    executor: {
      async local(task) {
        calls += 1;
        if (task.id === failed.id) return { taskId: task.id, strategy: "LOCAL", status: "FAILED", summary: "provider unavailable" };
        throw new AgentRunCancelledError();
      },
      async background(task) { return { taskId: task.id, strategy: "PERSISTENT_READ", status: "DETACHED", summary: "job: durable-job" }; },
      async reconcileBackground(task) { return success(task.id, "PERSISTENT_READ"); },
    },
  });

  assert.deepEqual(await orchestrator.execute([{ taskId: failed.id }]), [{ taskId: failed.id, strategy: "LOCAL", status: "FAILED", summary: "provider unavailable" }]);
  assert.equal((await store.get(failed.id))?.status, "BLOCKED");
  await assert.rejects(orchestrator.execute([{ taskId: failed.id }]), /not runnable/i);
  assert.equal(calls, 1);

  assert.deepEqual((await orchestrator.execute([{ taskId: detached.id, strategy: "PERSISTENT_READ" }])).map((result) => result.status), ["DETACHED"]);
  assert.equal((await store.get(detached.id))?.status, "IN_PROGRESS");
  assert.deepEqual((await orchestrator.reconcileBackground([detached.id])).map((result) => result.status), ["COMPLETED"]);
  assert.equal((await store.get(detached.id))?.status, "DONE");

  await assert.rejects(orchestrator.execute([{ taskId: cancelled.id }]), AgentRunCancelledError);
  assert.equal((await store.get(cancelled.id))?.status, "BLOCKED");
});

test("M65 provider tools expose bounded runnable orchestration without granting child effects", async () => {
  const { store } = planStore();
  const first = await store.add({ title: "Research A", description: "Inspect A." });
  const second = await store.add({ title: "Research B", description: "Inspect B." });
  const read: AgentTool = { name: "read_fixture", operation: "READ", description: "Read.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "evidence" }; } };
  const write: AgentTool = { name: "write_fixture", operation: "WRITE", description: "Write.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { assert.fail("child must not receive WRITE"); } };
  const requests: string[][] = [];
  const tools = createPlanOrchestrationTools({
    resolveStore: () => store,
    tools: [read, write],
    createModel: () => ({ async respond(request) { requests.push(request.tools.map((tool) => tool.name)); return { responseId: "child", text: "research complete", toolCalls: [] }; } }),
  });

  const status = await tools.find((tool) => tool.name === "orchestration_status")!.execute({});
  assert.match(status.output, new RegExp(first.id));
  assert.match(status.output, /PARALLEL_READ/);
  const result = await tools.find((tool) => tool.name === "orchestrate_runnable")!.execute({ taskIds: [second.id, first.id] });
  assert.equal(result.ok, true);
  assert.deepEqual((await store.list()).map((task) => task.status), ["DONE", "DONE"]);
  assert.deepEqual(requests, [["read_fixture"], ["read_fixture"]]);
});

test("M65 rechecks the selected dependency queue after each completed batch without retrying failures", async () => {
  const { store } = planStore();
  const first = await store.add({ title: "First", description: "First" });
  const second = await store.add({ title: "Second", description: "Second", dependsOn: [first.id] });
  const calls: string[] = [];
  const executor: OrchestrationExecutor = {
    async local(task) { calls.push(task.id); return success(task.id, "LOCAL"); },
  };
  const orchestrator = createPlanOrchestrator({
    store,
    executor,
  });

  const results = await executePlanQueue(orchestrator, store, [{ taskId: second.id }, { taskId: first.id }]);
  assert.deepEqual(calls, [first.id, second.id]);
  assert.deepEqual(results.map((result) => result.taskId), [first.id, second.id]);
  assert.deepEqual((await store.list()).map((task) => task.status), ["DONE", "DONE"]);
});

test("M65 keeps the top-level EXECUTE authorization boundary ahead of every child model", async () => {
  const { store } = planStore();
  const task = await store.add({ title: "Research", description: "Inspect safely." });
  let childModels = 0;
  const tools = createPlanOrchestrationTools({
    resolveStore: () => store,
    tools: [],
    createModel: () => ({ async respond() { childModels += 1; return { responseId: "child", text: "done", toolCalls: [] }; } }),
  });
  let turn = 0;
  await runAgent({
    task: "Delegate only after approval.",
    tools,
    authorize: async (request) => request.operation !== "EXECUTE",
    model: {
      async respond() {
        turn += 1;
        return turn === 1
          ? { responseId: "parent", text: "", toolCalls: [{ callId: "orchestrate", name: "orchestrate_runnable", arguments: JSON.stringify({ taskIds: [task.id] }) }] }
          : { responseId: "final", text: "Denied.", toolCalls: [] };
      },
    },
  });
  assert.equal(childModels, 0);
  assert.equal((await store.get(task.id))?.status, "TODO");
});

test("M65 claims runnable work atomically so concurrent root runs cannot dispatch the same session task twice", async () => {
  let session: StoredSession = { id: SESSION, updatedAt: "2026-09-04T00:00:00.000Z" };
  let nextId = 0;
  const backing = {
    async load(id: string) { return id === SESSION ? structuredClone(session) as never : undefined; },
    async save(next: StoredSession) { session = structuredClone(next); },
  };
  const first = createSessionPlanStore(backing, SESSION, { createId: () => IDS[nextId++]! });
  const second = createSessionPlanStore(backing, SESSION, { createId: () => IDS[nextId++]! });
  const task = await first.add({ title: "Shared", description: "Exactly once." });
  let listCalls = 0;
  let releaseLists: (() => void) | undefined;
  const listsReady = new Promise<void>((resolve) => { releaseLists = resolve; });
  const raceList = async (store: typeof first) => {
    listCalls += 1;
    if (listCalls === 2) releaseLists!();
    await listsReady;
    return store.list();
  };
  const racingStore = (store: typeof first) => ({ ...store, list: () => raceList(store) });
  let dispatches = 0;
  const executor: OrchestrationExecutor = { async local(step: DragonsPlanTask) { dispatches += 1; return success(step.id, "LOCAL"); } };
  const outcomes = await Promise.allSettled([
    createPlanOrchestrator({ store: racingStore(first), executor }).execute([{ taskId: task.id }]),
    createPlanOrchestrator({ store: racingStore(second), executor }).execute([{ taskId: task.id }]),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(dispatches, 1);
  assert.equal((await first.get(task.id))?.status, "DONE");
});

test("M65 does not let a completed worker overwrite an intervening authoritative block", async () => {
  const { store } = planStore();
  const task = await store.add({ title: "Shared", description: "Operator state wins." });
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const executor: OrchestrationExecutor = { async local(step: DragonsPlanTask) { await started; return success(step.id, "LOCAL"); } };
  const run = createPlanOrchestrator({ store, executor }).execute([{ taskId: task.id }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const claimed = await store.get(task.id);
  await store.blockClaim(task.id, claimed!.claimToken!, "Operator intervention.");
  release!();
  const [result] = await run;
  assert.equal(result?.status, "FAILED");
  assert.equal((await store.get(task.id))?.status, "BLOCKED");
});

test("M65 prevents an active claim from leaving IN_PROGRESS through plan status updates", async () => {
  const { store } = planStore();
  const task = await store.add({ title: "Shared", description: "Only the active claim may complete." });
  const [first] = await store.claimRunnable([task.id]);
  assert.ok(first?.claimToken);
  await assert.rejects(() => store.setStatus(task.id, "TODO"), /only through its claim owner/);
  await assert.rejects(() => store.setStatus(task.id, "BLOCKED", "Manual rollback."), /only through its claim owner/);
  assert.equal((await store.get(task.id))?.claimToken, first?.claimToken);
  assert.equal((await store.completeClaim(task.id, first!.claimToken!))?.status, "DONE");
});

test("M65 rejects status rollback before another root run can re-dispatch active work", async () => {
  const { store } = planStore();
  const task = await store.add({ title: "Shared", description: "Old workers cannot block re-claimed work." });
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const executor: OrchestrationExecutor = { async local(step: DragonsPlanTask) { await started; return success(step.id, "LOCAL"); } };
  const run = createPlanOrchestrator({ store, executor }).execute([{ taskId: task.id }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(() => store.setStatus(task.id, "BLOCKED", "Manual rollback."), /only through its claim owner/);
  await assert.rejects(() => store.setStatus(task.id, "TODO"), /only through its claim owner/);
  release!();
  const [result] = await run;
  assert.equal(result?.status, "COMPLETED");
  assert.equal((await store.get(task.id))?.status, "DONE");
});

test("M65 uses the durable session claim seam so separate file-backed stores cannot claim a task twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m65-session-claim-"));
  try {
    const firstSessions = createSessionStore(directory);
    const session = await firstSessions.create({ workingDirectory: directory, provider: "openai-api", model: "test" });
    const first = createSessionPlanStore(firstSessions, session.id);
    const task = await first.add({ title: "Shared", description: "Exactly once across stores." });
    const second = createSessionPlanStore(createSessionStore(directory), session.id);

    const outcomes = await Promise.allSettled([first.claimRunnable([task.id]), second.claimRunnable([task.id])]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.equal((await first.get(task.id))?.status, "IN_PROGRESS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M65 serializes every durable plan mutation with runnable claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m65-plan-mutation-"));
  try {
    const sessions = createSessionStore(directory);
    const session = await sessions.create({ workingDirectory: directory, provider: "openai-api", model: "test" });
    const first = createSessionPlanStore(sessions, session.id, { createId: () => IDS[0]! });
    const task = await first.add({ title: "Shared", description: "Claim must survive a concurrent mutation." });
    let resolvePath: ((path: "load" | "mutate") => void) | undefined;
    const path = new Promise<"load" | "mutate">((resolve) => { resolvePath = resolve; });
    let releaseStaleLoad: (() => void) | undefined;
    const staleLoad = new Promise<void>((resolve) => { releaseStaleLoad = resolve; });
    const racingSessions: Parameters<typeof createSessionPlanStore>[0] = {
      async load(id: string) {
        const stale = await sessions.load(id);
        resolvePath!("load");
        await staleLoad;
        return stale;
      },
      async save(next) { await sessions.save(next as never); },
      async mutate(id, operation) {
        resolvePath!("mutate");
        return await sessions.mutate!(id, operation as never);
      },
    };
    const second = createSessionPlanStore(racingSessions, session.id, { createId: () => IDS[1]! });
    const add = second.add({ title: "Concurrent", description: "Must not restore TODO after a claim." });
    if (await path === "load") {
      await first.claimRunnable([task.id]);
      releaseStaleLoad!();
      await add;
    } else {
      await add;
      await first.claimRunnable([task.id]);
    }
    assert.equal((await first.get(task.id))?.status, "IN_PROGRESS");
    assert.equal((await first.list()).some((candidate) => candidate.title === "Concurrent"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M65 interactive turn persistence cannot overwrite a concurrent durable plan mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m65-cli-plan-"));
  try {
    const sessions = createSessionStore(directory);
    let injected = false;
    const racingSessions = {
      ...sessions,
      async mutate(id: string, operation: Parameters<NonNullable<typeof sessions.mutate>>[1]) {
        if (!injected) {
          injected = true;
          await sessions.mutate!(id, (current) => ({
            ...current,
            plan: { version: 1, tasks: [{ id: IDS[2]!, title: "Claimed", description: "Must survive turn persistence.", status: "IN_PROGRESS" }] },
          }));
        }
        return await sessions.mutate!(id, operation);
      },
    };
    await main(["--provider", "chatgpt"], {
      workingDirectory: directory,
      sessionDirectory: directory,
      sessionStore: racingSessions,
      input: Readable.from(["Keep plan state.\n", "exit\n"]),
      write: () => undefined,
      tools: [],
      model: { async respond() { return { responseId: "response-1", text: "done", toolCalls: [] }; } },
    });
    const [session] = await sessions.list();
    assert.equal(injected, true);
    assert.equal((session?.plan as { tasks?: Array<{ status?: string }> } | undefined)?.tasks?.[0]?.status, "IN_PROGRESS");
    assert.equal(session?.messages.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M65 interactive clear preserves a concurrent durable plan mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m65-cli-clear-"));
  try {
    const sessions = createSessionStore(directory);
    let injected = false;
    const racingSessions = {
      ...sessions,
      async mutate(id: string, operation: Parameters<NonNullable<typeof sessions.mutate>>[1]) {
        if (!injected) {
          injected = true;
          await sessions.mutate!(id, (current) => ({
            ...current,
            plan: { version: 1, tasks: [{ id: IDS[3]!, title: "Claimed", description: "Must survive clear.", status: "IN_PROGRESS" }] },
          }));
        }
        return await sessions.mutate!(id, operation);
      },
    };
    await main(["--provider", "chatgpt"], {
      workingDirectory: directory,
      sessionDirectory: directory,
      sessionStore: racingSessions,
      input: Readable.from(["/clear\n", "exit\n"]),
      write: () => undefined,
      tools: [],
    });
    const [session] = await sessions.list();
    assert.equal(injected, true);
    assert.equal((session?.plan as { tasks?: Array<{ status?: string }> } | undefined)?.tasks?.[0]?.status, "IN_PROGRESS");
    assert.deepEqual(session?.messages, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M65 fails closed on an orphaned session claim lock instead of racing its removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m65-stale-lock-"));
  try {
    const sessions = createSessionStore(directory);
    const session = await sessions.create({ workingDirectory: directory, provider: "openai-api", model: "test" });
    const plans = createSessionPlanStore(sessions, session.id);
    const task = await plans.add({ title: "Shared", description: "Must not double-dispatch." });
    await writeFile(join(directory, `.${session.id}.lock`), JSON.stringify({ version: 1, pid: 999_999, token: IDS[0] }), { mode: 0o600 });

    await assert.rejects(plans.claimRunnable([task.id]), /session is busy/i);
    assert.equal((await plans.get(task.id))?.status, "TODO");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
