import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { main } from "../../dist/cli.js";
import { parseInteractiveBatchCommand } from "../../dist/cli/batch-commands.js";
import { batchWorkspaceDirectory, createFileBatchQueue } from "../../dist/batch-queue.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

const id = "129d85f4-3959-4553-b632-461030edc785";
test("batch CLI parses only bounded explicit commands", () => {
  assert.deepEqual(parseInteractiveBatchCommand("/batch add 2 -- First -- Second"), { action: "add", maxRuns: 2, prompts: ["First", "Second"] });
  assert.deepEqual(parseInteractiveBatchCommand(`/batch run ${id} 0`), { action: "run", id, revision: 0 });
  assert.deepEqual(parseInteractiveBatchCommand(`/batch recover ${id} 1`), { action: "recover", id, revision: 1 });
  assert.deepEqual(parseInteractiveBatchCommand(`/batch status ${id}`), { action: "status", id });
  for (const bad of ["/batch list x", `/batch run ${id} 00`, `/batch run ${id} -1`, `/batch recover ${id} 01`, "/batch add 3 -- First -- Second",
    "/batch add 9 -- First", "/batch add 1 -- ", "/batch add 1 -- bad\u001b[31m", `/batch add 1 -- ${"x".repeat(1_001)}`])
    assert.equal(parseInteractiveBatchCommand(bad), undefined);
});

async function fixture(t: import("node:test").TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-cli-batch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  await profiles.select("alpha");
  const queue = (profile: string) => createFileBatchQueue(batchWorkspaceDirectory(join(dirname(profiles.paths(profile).configPath), "batches"), root), root);
  const run = async (lines: string[], modelFactory: NonNullable<Parameters<typeof main>[1]>["modelFactory"], profile = "alpha") => {
    await profiles.select(profile);
    const output: string[] = [];
    await main([], { configPath, profileStore: profiles, workingDirectory: root, config: { provider: "local", models: { local: "fixture" } },
      modelFactory, tools: [], input: Readable.from([...lines.map((line) => `${line}\n`), "/exit\n"]), write: (text) => output.push(text) });
    return output.join("");
  };
  return { root, queue, run, directory: (profile: string) => batchWorkspaceDirectory(join(dirname(profiles.paths(profile).configPath), "batches"), root) };
}

test("CLI batch creation is profile-bound, does not run on rejection, and requires current revision", async (t) => {
  const f = await fixture(t);
  let created = 0;
  const modelFactory = () => { created++; return { async respond() { throw new Error("unconfirmed"); } }; };
  const output = await f.run(["/batch add 2 -- Read A -- Read B", "/batch list"], modelFactory);
  assert.match(output, /created \(revision 0, 2 tasks, 2 runs\)/);
  const [batch] = await f.queue("alpha").list();
  assert.ok(batch);
  assert.equal((await f.queue("beta").list()).length, 0);
  const rejected = await f.run([`/batch run ${batch.id} 1`, `/batch run ${batch.id} 0`, "NO", `/batch status ${batch.id}`], modelFactory);
  assert.match(rejected, /revision changed/);
  assert.match(rejected, /not confirmed/);
  assert.match(rejected, /queued/);
  assert.equal(created, 0);
  assert.equal((await f.queue("alpha").load(batch.id))?.revision, 0);
});

test("CLI batch runs sequential isolated READ-only models and checkpoints results", async (t) => {
  const f = await fixture(t);
  const queue = f.queue("alpha");
  const batch = await queue.create(["First", "Second"], 2);
  const requests: string[] = [];
  const output = await f.run([`/batch run ${batch.id} 0`, "RUN", `/batch status ${batch.id}`], (provider, model) => {
    assert.equal(provider, "local");
    assert.equal(model, "fixture");
    return { async respond(request) {
      requests.push(request.task);
      assert.ok(request.tools.every((tool) => tool.operation === "READ"));
      assert.equal(request.conversationResponseId, undefined);
      assert.equal(request.continuationState, undefined);
      return { responseId: "fixture", text: `Report ${request.task}`, toolCalls: [] };
    } };
  });
  assert.deepEqual(requests, ["First", "Second"]);
  assert.match(output, /completed, completed/);
  assert.match(output, /revision 4/);
  assert.deepEqual((await queue.load(batch.id))?.tasks.map((task) => task.result), ["Report First", "Report Second"]);
});

test("CLI batch stops on provider error and never restarts a failed checkpoint", async (t) => {
  const f = await fixture(t);
  const queue = f.queue("alpha");
  const batch = await queue.create(["First", "Second"], 2);
  let calls = 0;
  const factory = () => ({ async respond() { calls++; throw new Error("private provider failure"); } });
  const output = await f.run([`/batch run ${batch.id} 0`, "RUN", `/batch run ${batch.id} 2`], factory);
  assert.equal(calls, 1);
  assert.match(output, /failed/);
  assert.doesNotMatch(output, /private provider failure/);
  assert.deepEqual((await queue.load(batch.id))?.tasks.map((task) => task.state), ["failed", "queued"]);
});

test("CLI batch lock status is inert and recovery requires RECOVER for an abandoned owner", async (t) => {
  const f = await fixture(t);
  await f.queue("alpha").create(["Read"], 1);
  const token = randomUUID();
  const lockPath = join(f.directory("alpha"), ".batch.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 2147483647, host: hostname(), token }), { flag: "wx" });
  const factory = () => { throw new Error("model must not start"); };
  const status = await f.run(["/batch lock status", "/batch lock recover", "NO"], factory);
  assert.match(status, /PID 2147483647/);
  assert.match(status, /not confirmed/);
  assert.match(await f.run(["/batch lock recover", "RECOVER"], factory), /Abandoned batch lock removed/);
  assert.match(await f.run(["/batch lock status"], factory), /No batch lock/);
  assert.equal((await f.queue("alpha").list()).length, 1);
});

test("CLI batch reservation recovery requires a stopped owner, matching revision and explicit RECOVER", async (t) => {
  const f = await fixture(t);
  const queue = f.queue("alpha");
  const batch = await queue.create(["First", "Second"], 2);
  const running = (await queue.reserve(batch.id, 0))!;
  const factory = () => { throw new Error("model must not start"); };
  const live = await f.run([`/batch status ${batch.id}`, `/batch recover ${batch.id} 0`, `/batch recover ${batch.id} 1`, "RECOVER"], factory);
  assert.match(live, /revision changed/);
  assert.match(live, /Batch command failed/);
  assert.doesNotMatch(live, new RegExp(running.tasks[0]!.owner!.token));
  assert.equal((await queue.load(batch.id))?.tasks[0]?.state, "running");
  const orphan = structuredClone(running);
  orphan.tasks[0]!.owner!.pid = 2147483647;
  await writeFile(join(f.directory("alpha"), `${batch.id}.json`), `${JSON.stringify(orphan)}\n`);
  const rejected = await f.run([`/batch recover ${batch.id} 1`, "NO"], factory);
  assert.match(rejected, /not confirmed/);
  assert.equal((await queue.load(batch.id))?.revision, 1);
  const result = await f.run([`/batch recover ${batch.id} 1`, "RECOVER", `/batch status ${batch.id}`], factory);
  assert.match(result, /task marked interrupted; no task was started or retried/);
  assert.deepEqual((await queue.load(batch.id))?.tasks.map((entry) => entry.state), ["interrupted", "queued"]);
  assert.doesNotMatch(result, new RegExp(orphan.tasks[0]!.owner!.token));
});
