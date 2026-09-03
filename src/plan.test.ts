import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runAgent, type AgentModel } from "./agent.js";
import { main, parseCliCommand } from "./cli.js";
import {
  createPlanTools,
  createSessionPlanStore,
  formatPlan,
  type PlanStore,
} from "./plan.js";
import { createSessionStore } from "./session-store.js";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

function deterministicStore(sessionDirectory: string) {
  const sessions = createSessionStore(sessionDirectory, {
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    createId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  let identifiers = [ROOT_ID, CHILD_ID, THIRD_ID];
  return { sessions, identifiers: () => identifiers.shift()! };
}

test("M27 creates stable ordered session tasks and validates parent/status transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-plan-store-"));
  try {
    const { sessions, identifiers } = deterministicStore(directory);
    const session = await sessions.create({ workingDirectory: "/workspace", provider: "openai-api", model: "gpt-test" });
    const plans = createSessionPlanStore(sessions, session.id, {
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      createId: identifiers,
      maxTasks: 2,
    });
    const root = await plans.add({ title: "Plan feature", description: "Define behavior." });
    const child = await plans.add({ title: "Test feature", description: "Verify behavior.", parentId: root.id });
    assert.deepEqual((await plans.list()).map(({ id, parentId, status }) => ({ id, parentId, status })), [
      { id: ROOT_ID, parentId: undefined, status: "TODO" },
      { id: CHILD_ID, parentId: ROOT_ID, status: "TODO" },
    ]);
    assert.match(formatPlan(await plans.list()), /1\. \[TODO\] Plan feature/);
    assert.match(formatPlan(await plans.list()), /  1\.1\. \[TODO\] Test feature/);

    await plans.setStatus(child.id, "BLOCKED", "Waiting for fixture");
    assert.equal((await plans.get(child.id))?.blockedReason, "Waiting for fixture");
    await plans.setStatus(child.id, "DONE");
    assert.deepEqual(await plans.get(child.id), {
      id: CHILD_ID,
      title: "Test feature",
      description: "Verify behavior.",
      parentId: ROOT_ID,
      status: "DONE",
    });
    await assert.rejects(plans.update(root.id, { parentId: child.id }), /cycle/i);
    await assert.rejects(plans.update(root.id, { parentId: THIRD_ID }), /parent task was not found/i);
    await assert.rejects(plans.remove(root.id), /child tasks/i);
    await assert.rejects(plans.add({ title: "Third", description: "Would exceed the cap." }), /task limit/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M27 plan tools use Dragons authorization and classify every mutation as WRITE", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-plan-tools-"));
  try {
    const { sessions, identifiers } = deterministicStore(directory);
    const session = await sessions.create({ workingDirectory: "/workspace", provider: "openai-api", model: "gpt-test" });
    const plans = createSessionPlanStore(sessions, session.id, { createId: identifiers });
    const tools = createPlanTools(() => plans);
    assert.equal(tools.find(({ name }) => name === "plan_list")?.operation, "READ");
    for (const name of ["plan_add", "plan_update", "plan_set_status", "plan_remove"]) {
      assert.equal(tools.find((tool) => tool.name === name)?.operation, "WRITE");
    }
    let turn = 0;
    let authorizations = 0;
    const model: AgentModel = {
      async respond(request) {
        turn += 1;
        if (turn === 1) return {
          responseId: "one",
          text: "",
          toolCalls: [{ callId: "add", name: "plan_add", arguments: '{"title":"Provider task","description":"Await approval."}' }],
        };
        assert.deepEqual(request.toolOutputs, [{ callId: "add", output: "Authorization denied for plan_add." }]);
        return { responseId: "two", text: "Denied.", toolCalls: [] };
      },
    };
    await runAgent({ task: "x", model, tools, authorize: () => { authorizations += 1; return false; } });
    assert.equal(authorizations, 1);
    assert.deepEqual(await plans.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M27 CLI and local slash plan commands stay local and persist only in the active session", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-plan-cli-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-plan-workspace-"));
  try {
    const { sessions } = deterministicStore(sessionDirectory);
    const session = await sessions.create({ workingDirectory: workspace, provider: "openai-api", model: "gpt-test" });
    assert.deepEqual(parseCliCommand(["plan", "list", "--session", session.id]), { kind: "plan", action: "list", sessionId: session.id });
    await main(["plan", "add", "CLI task", "CLI description", "--session", session.id], { sessionDirectory, write: () => undefined });
    const output: string[] = [];
    let modelCalls = 0;
    await main(["session", "resume", session.id], {
      workingDirectory: workspace,
      sessionDirectory,
      input: Readable.from(["/plan list\n", "/plan add Slash task --description Slash description\n", "Provider turn.\n", "/exit\n"]),
      tools: [],
      write: (text) => output.push(text),
      model: {
        async respond() {
          modelCalls += 1;
          return { responseId: "done", text: "done", toolCalls: [], continuationState: { provider: "opaque" } };
        },
      },
    });
    assert.equal(modelCalls, 1);
    assert.match(output.join(""), /CLI task/);
    assert.match(output.join(""), /Added plan task:/);
    const stored = await sessions.load(session.id);
    assert.ok(stored?.plan);
    assert.equal(stored.plan.tasks.length, 2);
    const serialized = await readFile(join(sessionDirectory, `${session.id}.json`), "utf8");
    const parsed = JSON.parse(serialized) as { continuation?: unknown; messages?: unknown; plan?: unknown };
    assert.equal(JSON.stringify(parsed.continuation), JSON.stringify({ responseId: "done", providerState: { provider: "opaque" } }));
    assert.doesNotMatch(JSON.stringify(parsed.continuation), /CLI task|Slash task/);
    assert.doesNotMatch(JSON.stringify(parsed.messages), /CLI task|Slash task/);
    assert.match(JSON.stringify(parsed.plan), /CLI task/);
  } finally {
    await Promise.all([rm(sessionDirectory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});

test("M27 rejects malformed plans, bounded strings, and invalid blocked reasons deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-plan-validation-"));
  try {
    const { sessions, identifiers } = deterministicStore(directory);
    const session = await sessions.create({ workingDirectory: "/workspace", provider: "openai-api", model: "gpt-test" });
    const plans: PlanStore = createSessionPlanStore(sessions, session.id, { createId: identifiers, maxTitleCharacters: 5, maxDescriptionCharacters: 8, maxBlockedReasonCharacters: 8 });
    await assert.rejects(plans.add({ title: "", description: "valid" }), /title/i);
    await assert.rejects(plans.add({ title: "title", description: "too long description" }), /description/i);
    const task = await plans.add({ title: "title", description: "valid" });
    await assert.rejects(plans.setStatus(task.id, "BLOCKED"), /blocked reason/i);
    await assert.rejects(plans.setStatus(task.id, "TODO", "not allowed"), /only allowed/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
