import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPlanTools, createSessionPlanStore, formatRunnablePlan, isDragonsPlan, runnablePlanTasks, type DragonsPlanTask } from "./plan.js";
import { createSessionStore } from "./session-store.js";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const INDEPENDENT_ID = "22222222-2222-4222-8222-222222222222";
const DEPENDENT_ID = "33333333-3333-4333-8333-333333333333";

test("M64 calculates runnable TODO tasks deterministically from completed dependencies", () => {
  const tasks: DragonsPlanTask[] = [
    { id: ROOT_ID, title: "Prepare", description: "Create the prerequisite.", status: "TODO" },
    { id: INDEPENDENT_ID, title: "Review", description: "Independent work.", status: "TODO" },
    { id: DEPENDENT_ID, title: "Deploy", description: "Requires preparation.", status: "TODO", dependsOn: [ROOT_ID] },
  ];
  assert.deepEqual(runnablePlanTasks(tasks).map(({ id }) => id), [ROOT_ID, INDEPENDENT_ID]);
  tasks[0]!.status = "DONE";
  assert.deepEqual(runnablePlanTasks(tasks).map(({ id }) => id), [INDEPENDENT_ID, DEPENDENT_ID]);
  assert.match(formatRunnablePlan(tasks), /Deploy/);
  const nested: DragonsPlanTask[] = [
    { id: ROOT_ID, title: "Parent", description: "Complete parent.", status: "DONE" },
    { id: DEPENDENT_ID, title: "Child", description: "Runnable child.", parentId: ROOT_ID, status: "TODO" },
  ];
  assert.match(formatRunnablePlan(nested), /^  1\.1\. \[TODO\] Child/m);
});

test("M64 rejects self, missing, and cyclic dependencies before plan state is accepted", () => {
  const task = (id: string, dependsOn?: string[]): DragonsPlanTask => ({ id, title: "Task", description: "Focused work.", status: "TODO", ...(dependsOn === undefined ? {} : { dependsOn }) });
  assert.equal(isDragonsPlan({ version: 1, tasks: [task(ROOT_ID, [ROOT_ID])] }), false);
  assert.equal(isDragonsPlan({ version: 1, tasks: [task(ROOT_ID, [DEPENDENT_ID])] }), false);
  assert.equal(isDragonsPlan({ version: 1, tasks: [task(ROOT_ID, [DEPENDENT_ID]), task(DEPENDENT_ID, [ROOT_ID])] }), false);
  assert.equal(isDragonsPlan({ version: 1, tasks: [{ ...task(ROOT_ID), status: "TODO" }, { ...task(DEPENDENT_ID, [ROOT_ID]), status: "DONE" }] }), false);
  assert.equal(isDragonsPlan({ version: 1, tasks: [task(ROOT_ID)], history: [{ taskId: DEPENDENT_ID, previousStatus: "BLOCKED", nextStatus: "TODO", reason: "Invalid reference.", source: "USER_INPUT", createdAt: "2026-09-04T12:00:00.000Z" }] }), false);
  assert.equal(isDragonsPlan({ version: 1, tasks: [task(ROOT_ID)], history: [{ taskId: ROOT_ID, previousStatus: "TODO", nextStatus: "DONE", reason: "Invalid transition.", source: "PLAN_REVISION", createdAt: "2026-09-04T12:00:00.000Z" }] }), false);
});

test("M64 persists explicit dependencies without changing legacy task creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m64-plan-"));
  try {
    const sessions = createSessionStore(directory);
    const session = await sessions.create({ workingDirectory: directory, provider: "openai-api", model: "gpt-test" });
    let ids = [ROOT_ID, DEPENDENT_ID];
    const plans = createSessionPlanStore(sessions, session.id, { createId: () => ids.shift()! });
    const prerequisite = await plans.add({ title: "Prepare", description: "Create prerequisite." });
    const dependent = await plans.add({ title: "Deploy", description: "Deploy after preparation.", dependsOn: [prerequisite.id] });
    assert.deepEqual((await plans.get(dependent.id))?.dependsOn, [prerequisite.id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M64 prevents dependency edits and prerequisite regression from bypassing active-task invariants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m64-dependency-status-"));
  try {
    const sessions = createSessionStore(directory);
    const session = await sessions.create({ workingDirectory: directory, provider: "openai-api", model: "gpt-test" });
    let ids = [ROOT_ID, DEPENDENT_ID, INDEPENDENT_ID];
    const plans = createSessionPlanStore(sessions, session.id, { createId: () => ids.shift()! });
    const prerequisite = await plans.add({ title: "Prerequisite", description: "Finish first." });
    const independent = await plans.add({ title: "Independent", description: "Initially independent." });
    await plans.setStatus(independent.id, "DONE");
    await assert.rejects(plans.update(independent.id, { dependsOn: [prerequisite.id] }), /invalidate/i);
    const dependent = await plans.add({ title: "Dependent", description: "Wait for prerequisite.", dependsOn: [prerequisite.id] });
    await plans.setStatus(dependent.id, "BLOCKED", "Waiting for prerequisite.");
    await assert.rejects(plans.update(dependent.id, { dependsOn: null }), /recovered or replanned/i);
    await plans.setStatus(prerequisite.id, "DONE");
    await plans.recoverBlocked(dependent.id, "Prerequisite completed.", "DEPENDENCY_COMPLETED");
    await plans.setStatus(dependent.id, "DONE");
    await assert.rejects(plans.setStatus(prerequisite.id, "TODO"), /dependencies are not complete/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M64 recovers blocked work only from a concrete state change and preserves bounded provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m64-recovery-"));
  try {
    const sessions = createSessionStore(directory);
    const session = await sessions.create({ workingDirectory: directory, provider: "openai-api", model: "test" });
    const plans = createSessionPlanStore(sessions, session.id, { now: () => new Date("2026-09-04T12:00:00.000Z") });
    const prerequisite = await plans.add({ title: "Prerequisite", description: "Finish first." });
    const blocked = await plans.add({ title: "Blocked", description: "Wait for prerequisite.", dependsOn: [prerequisite.id] });
    const standalone = await plans.add({ title: "Standalone", description: "Requires a non-dependency decision." });
    await plans.setStatus(blocked.id, "BLOCKED", "Waiting for prerequisite.");
    await plans.setStatus(standalone.id, "BLOCKED", "Waiting for a decision.");
    await assert.rejects(plans.recoverBlocked(standalone.id, "Decision received.", "USER_INPUT"), /dependency-aware/i);
    await assert.rejects(plans.recoverBlocked(blocked.id, "Not a recovery.", "PLAN_REVISION" as never), /source is invalid/i);
    await assert.rejects(plans.recoverBlocked(blocked.id, "Dependency completed.", "DEPENDENCY_COMPLETED"), /dependencies are not complete/i);
    await plans.setStatus(prerequisite.id, "DONE");
    assert.equal((await plans.recoverBlocked(blocked.id, "Dependency completed.", "DEPENDENCY_COMPLETED")).status, "TODO");
    const runnableResult = await createPlanTools(() => plans).find((tool) => tool.name === "plan_runnable")!.execute({});
    assert.equal(runnableResult.ok, true);
    assert.match(runnableResult.output, /Blocked/);
    assert.deepEqual(await plans.history(), [{ taskId: blocked.id, previousStatus: "BLOCKED", nextStatus: "TODO", reason: "Dependency completed.", source: "DEPENDENCY_COMPLETED", createdAt: "2026-09-04T12:00:00.000Z" }]);
    const resumed = createSessionPlanStore(sessions, session.id, { now: () => new Date("2026-09-04T12:00:00.000Z") });
    assert.equal((await resumed.get(blocked.id))?.status, "TODO");
    assert.deepEqual(await resumed.history(), await plans.history());
    await assert.rejects(plans.remove(blocked.id), /provenance/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M64 preserves blocked work while bounded replanning adds an explicit replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m64-replan-"));
  try {
    const sessions = createSessionStore(directory);
    const session = await sessions.create({ workingDirectory: directory, provider: "openai-api", model: "test" });
    const plans = createSessionPlanStore(sessions, session.id, { maxReplans: 1, now: () => new Date("2026-09-04T12:00:00.000Z") });
    const original = await plans.add({ title: "Original", description: "Cannot proceed." });
    await plans.setStatus(original.id, "BLOCKED", "Tool no longer exists.");
    const replacement = await plans.replan(original.id, { reason: "Use the supported tool instead.", replacement: { title: "Replacement", description: "Use the supported path." } });
    assert.equal(replacement.status, "TODO");
    assert.equal((await plans.get(original.id))?.status, "BLOCKED");
    assert.equal((await plans.history()).at(-1)?.replacementTaskId, replacement.id);
    await assert.rejects(plans.replan(original.id, { reason: "A second revision.", replacement: { title: "Another", description: "Must not be added." } }), /replan limit/i);
    assert.equal((await plans.list()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
