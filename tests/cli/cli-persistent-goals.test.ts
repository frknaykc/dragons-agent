import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { main } from "../../dist/cli.js";
import { parseInteractiveGoalCommand } from "../../dist/cli/goal-commands.js";
import { createFilePersistentGoalStore, goalWorkspaceDirectory, inspectPersistentGoalLock } from "../../dist/persistent-goal-store.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createSessionStore } from "../../dist/session-store.js";
import type { AgentRequest } from "../../dist/agent.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

test("CLI goal parser rejects malformed arguments without sending them to the model", () => {
  assert.equal(parseInteractiveGoalCommand("/goal", SESSION)?.action, "list");
  for (const command of ["/goal run wrong", "/goal list extra", "/goal add 0 2027-01-01 -- a -- b",
    "/goal add 1 2027-01-01 -- a", "/goal add 1 2027-01-01 -- a\nb -- c"]) {
    assert.equal(parseInteractiveGoalCommand(command, SESSION), undefined);
  }
});

test("CLI goal is durable and session-bound; a READ-only run hands continuation back to foreground", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-goal-"));
  const input = new PassThrough();
  const output: string[] = [];
  const requests: AgentRequest[] = [];
  let goalId: string | undefined;
  let resolveCreated!: () => void;
  let resolveRun!: () => void;
  const created = new Promise<void>((resolve) => { resolveCreated = resolve; });
  const ran = new Promise<void>((resolve) => { resolveRun = resolve; });
  const store = createSessionStore(join(root, "sessions"), { providerIds: ["local"] });
  const registry = createProviderRegistry([{
    id: "local", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      requests.push(request);
      return { responseId: `turn-${requests.length}`, text: `answer-${requests.length}`, toolCalls: [] };
    } }),
  }]);
  const options = {
    workingDirectory: root, configPath: join(root, "config.json"), sessionStore: store,
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
    providerRegistry: registry, tools: [],
  };
  const timeout = new AbortController();
  const within = async (promise: Promise<void>) => Promise.race([promise, delay(6_000, undefined, { signal: timeout.signal }).then(() => {
    throw new Error(`Goal command timed out: ${output.join("")}`);
  })]);
  try {
    const run = main(["--provider", "local"], { ...options, input, write: (text) => {
      output.push(text);
      goalId ??= /Goal created: ([0-9a-f-]{36})/.exec(text)?.[1];
      if (goalId) resolveCreated();
      if (text.includes("report: answer-2")) resolveRun();
    } });
    input.write(`first\n/goal add 2 ${new Date(Date.now() + 86_400_000).toISOString()} -- inspect workspace -- verified by user\n`);
    await within(created);
    assert.ok(goalId);
    input.write(`/goal run ${goalId}\n`);
    await within(ran);
    input.end("second\n/exit\n");
    await run;
    assert.equal(requests[0]?.task, "first");
    assert.match(requests[1]!.task, /Objective: inspect workspace\nCompletion criterion: verified by user/);
    assert.equal(requests[2]?.task, "second");
    assert.ok(requests[1]!.tools.length > 0 && requests[1]!.tools.every((tool) => tool.operation === "READ"));
    assert.equal(requests[1]!.conversationResponseId, "turn-1");
    assert.equal(requests[2]!.conversationResponseId, "turn-2");
    const [session] = await store.list();
    const goals = createFilePersistentGoalStore(goalWorkspaceDirectory(join(root, "goals"), await realpath(root)));
    const goal = await goals.load(goalId);
    assert.equal(goal?.state, "ready");
    assert.equal(goal?.turnsUsed, 1);
    assert.equal(goal?.sessionId, session?.id);
    assert.equal((await store.load(session!.id))?.continuation?.responseId, "turn-3");
    assert.doesNotMatch(JSON.stringify(goal), /answer-2/);
    const again: string[] = [];
    await main(["session", "resume", session!.id], { ...options,
      input: PassThrough.from([`/goal status ${goalId}\n/goal complete ${goalId}\n/new\n/goal status ${goalId}\n/goal list\n/exit\n`]), write: (text) => again.push(text),
    });
    assert.match(again.join(""), /criterion: verified by user/);
    assert.match(again.join(""), /not found in this session/);
    assert.match(again.join(""), /No goals for this session/);
    assert.equal((await goals.load(goalId))?.state, "completed");
    assert.equal(requests.length, 3);
  } finally { timeout.abort(); input.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("Ctrl-C cancels a CLI goal and leaves its reservation interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-goal-cancel-"));
  const input = new PassThrough();
  const output: string[] = [];
  const store = createSessionStore(join(root, "sessions"), { providerIds: ["local"] });
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const registry = createProviderRegistry([{
    id: "local", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      started();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("cancelled");
    } }),
  }]);
  const timeout = new AbortController();
  try {
    let goalId = "";
    let created!: () => void;
    const goalCreated = new Promise<void>((resolve) => { created = resolve; });
    const run = main(["--provider", "local"], {
      input, write: (text) => {
        output.push(text);
        const id = /Goal created: ([0-9a-f-]{36})/.exec(text)?.[1];
        if (id) { goalId = id; created(); }
      },
      workingDirectory: root, configPath: join(root, "config.json"), sessionStore: store,
      memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"), providerRegistry: registry, tools: [],
    });
    const within = async (promise: Promise<void>) => Promise.race([promise, delay(5_000, undefined, { signal: timeout.signal }).then(() => {
      throw new Error(`Goal cancellation timed out: ${output.join("")}`);
    })]);
    input.write(`/goal add 2 ${new Date(Date.now() + 86_400_000).toISOString()} -- inspect -- verified\n`);
    await within(goalCreated);
    input.write(`/goal run ${goalId}\n`);
    await within(running);
    process.emit("SIGINT");
    input.end("/exit\n");
    await run;
    const goals = createFilePersistentGoalStore(goalWorkspaceDirectory(join(root, "goals"), await realpath(root)));
    assert.equal((await goals.load(goalId))?.state, "interrupted");
    assert.equal((await goals.load(goalId))?.turnsUsed, 1);
    assert.match(output.join(""), /Goal command cancelled/);
  } finally { timeout.abort(); input.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("CLI lock recovery requires an explicit confirmation and refuses a live owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-goal-lock-"));
  const store = createSessionStore(join(root, "sessions"), { providerIds: ["local"] });
  const directory = goalWorkspaceDirectory(join(root, "goals"), await realpath(root));
  const lock = join(directory, ".persistent-goals.lock");
  const token = "33333333-3333-4333-8333-333333333333";
  try {
    await mkdir(directory, { recursive: true });
    const otherDirectory = goalWorkspaceDirectory(join(root, "goals"), join(await realpath(root), "different-workspace"));
    await mkdir(otherDirectory, { recursive: true });
    await writeFile(join(otherDirectory, ".persistent-goals.lock"), JSON.stringify({ pid: process.pid, host: hostname(), token }));
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token }));
    const output: string[] = [];
    const options = { workingDirectory: root, configPath: join(root, "config.json"), sessionStore: store,
      memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"), write: (text: string) => output.push(text) };
    await main(["--provider", "local"], { ...options, input: PassThrough.from(["/goal lock status\n/goal lock recover\nRECOVER\n/exit\n"]) });
    assert.match(output.join(""), /owner is still active/);
    assert.doesNotMatch(output.join(""), new RegExp(token));
    await writeFile(lock, JSON.stringify({ pid: 2147483647, host: hostname(), token }));
    output.length = 0;
    await main(["--provider", "local"], { ...options, input: PassThrough.from(["/goal lock recover\nNO\n/goal lock status\n/exit\n"]) });
    assert.match(output.join(""), /not confirmed/);
    assert.match(output.join(""), /Lock owner:/);
    output.length = 0;
    await main(["--provider", "local"], { ...options, input: PassThrough.from(["/goal lock recover\nRECOVER\n/goal lock status\n/exit\n"]) });
    assert.match(output.join(""), /Abandoned goal lock removed/);
    assert.match(output.join(""), /No goal lock for this workspace/);
    assert.deepEqual(await inspectPersistentGoalLock(otherDirectory), { pid: process.pid, host: hostname(), token });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI lock recovery refuses a changed lock after confirmation is requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-goal-lock-race-"));
  const directory = goalWorkspaceDirectory(join(root, "goals"), await realpath(root));
  const lock = join(directory, ".persistent-goals.lock");
  const first = "33333333-3333-4333-8333-333333333333";
  const next = "44444444-4444-4444-8444-444444444444";
  const input = new PassThrough();
  const output: string[] = [];
  let prompt!: () => void;
  const awaitingConfirmation = new Promise<void>((resolve) => { prompt = resolve; });
  const timeout = new AbortController();
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: 2147483647, host: hostname(), token: first }));
    const run = main(["--provider", "local"], { input, write: (text) => {
      output.push(text);
      if (text.includes("Type RECOVER to confirm")) prompt();
    }, workingDirectory: root, configPath: join(root, "config.json"),
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
    input.write("/goal lock recover\n");
    await Promise.race([awaitingConfirmation, delay(5_000, undefined, { signal: timeout.signal }).then(() => {
      throw new Error(`Recovery prompt timed out: ${output.join("")}`);
    })]);
    await writeFile(lock, JSON.stringify({ pid: 2147483647, host: hostname(), token: next }));
    input.end("RECOVER\n/exit\n");
    await run;
    assert.match(output.join(""), /token changed/);
    assert.deepEqual(await inspectPersistentGoalLock(directory), { pid: 2147483647, host: hostname(), token: next });
    assert.doesNotMatch(output.join(""), new RegExp(first));
    assert.doesNotMatch(output.join(""), new RegExp(next));
  } finally { timeout.abort(); input.destroy(); await rm(root, { recursive: true, force: true }); }
});
