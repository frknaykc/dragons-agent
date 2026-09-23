import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createCodingTools, createReadTools } from "../../dist/tools.js";
import { createSubagentTool } from "../../dist/subagents.js";
import { createPersistentBackgroundJobStore, PersistentBackgroundJobManager } from "../../dist/persistent-background-jobs.js";
import { RunChangeTracker } from "../../dist/change-review.js";
const exec = promisify(execFile);
const sessionId = "11111111-1111-4111-8111-111111111111";
const model = () => ({ async respond() { return { responseId: "done", text: "done", toolCalls: [] }; } });

for (const failure of ["claim", "save", "diagnostics"] as const) test(`job ${failure} failure releases admission and claim`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dragons-launch-failure-"));
  const store = createPersistentBackgroundJobStore(dir);
  let fail = true;
  let claimedId = "";
  const manager = new PersistentBackgroundJobManager({ maxActiveJobs: 1,
    onJobStarted: () => { if (failure === "diagnostics" && fail) { fail = false; throw new Error("diagnostics failed"); } return undefined; },
    store: { ...store,
      async claim(id) { claimedId = id; if (failure === "claim" && fail) { fail = false; throw new Error("claim failed"); } return store.claim(id); },
      async save(job, revision) { if (failure === "save" && fail) { fail = false; throw new Error("save failed"); } return store.save(job, revision); },
    },
  });
  const options = { sessionId, workingDirectory: dir, prompt: "Read", createModel: model, tools: [] };
  try {
    if (failure === "diagnostics") {
      const job = await manager.start(options);
      await manager.wait(job.id);
      assert.equal((await store.load(job.id))?.state, "failed");
    } else {
      await assert.rejects(manager.start(options), new RegExp(`${failure} failed`));
      assert.equal((await store.list()).length, 0);
      assert.equal(manager.list().length, 0);
    }
    assert.equal(await store.hasActiveClaim(claimedId), false);
    const retry = await manager.start(options);
    await manager.wait(retry.id);
    assert.equal(manager.show(retry.id)?.state, "completed");
  } finally {
    for (const job of manager.list()) await manager.wait(job.id);
    await rm(dir, { recursive: true, force: true });
  }
});

for (const helper of ["textconv", "fsmonitor", "clean", "process"]) test(`READ Git tools and automatic review never execute configured ${helper}`, { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dragons-git-read-"));
  const git = (...args: string[]) => exec("git", args, { cwd: dir });
  try {
    await git("init");
    await writeFile(join(dir, "file.txt"), "before\n");
    await git("add", "file.txt");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    await writeFile(join(dir, "file.txt"), "after\n");
    const marker = join(dir, "executed");
    const script = join(dir, "helper.sh");
    await writeFile(script, `#!/bin/sh\nprintf executed > '${marker}'\nprintf converted\n`, { mode: 0o700 });
    if (helper === "textconv") {
      await writeFile(join(dir, ".gitattributes"), "*.txt diff=fixture\n");
      await git("config", "diff.fixture.textconv", script);
    } else if (helper === "fsmonitor") await git("config", "core.fsmonitor", script);
    else {
      await writeFile(join(dir, ".gitattributes"), "*.txt filter=fixture\n");
      await git("config", `filter.fixture.${helper}`, script);
    }
    const indexBefore = await readFile(join(dir, ".git", "index"));
    const tracker = new RunChangeTracker(dir);
    await tracker.initialize();
    tracker.record(["file.txt"]);
    const review = await tracker.review();
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(review.gitAvailable, true);
    assert.ok(review.preExistingGitFiles.includes("file.txt"));
    assert.match(review.diffSummary, /file.txt/);
    const tools = await createReadTools(dir);
    for (const name of ["git_diff", "git_status", "git_log"]) {
      const result = await tools.find((tool) => tool.name === name)!.execute({});
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      if ((helper === "clean" || helper === "process") && name !== "git_log") {
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /filters disabled/i);
      } else assert.equal(result.ok, true, result.output);
    }
    assert.deepEqual(await readFile(join(dir, ".git", "index")), indexBefore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("checkpoint-less write rejects dangling final symlink but preserves ordinary writes", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dragons-dangling-"));
  try {
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const outside = join(dir, "outside.txt");
    await symlink(outside, join(workspace, "link.txt"));
    const tool = (await createCodingTools(workspace)).find((tool) => tool.name === "write_file")!;
    assert.equal((await tool.execute({ path: "link.txt", content: "escape" })).ok, false);
    await assert.rejects(readFile(outside), { code: "ENOENT" });
    assert.equal((await tool.execute({ path: "new.txt", content: "inside" })).ok, true);
    await symlink("new.txt", join(workspace, "safe.txt"));
    assert.equal((await tool.execute({ path: "safe.txt", content: "updated" })).ok, true);
    assert.equal(await readFile(join(workspace, "new.txt"), "utf8"), "updated");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const approved of [false, true]) test(`nested authorization preserves READ with delegation ${approved}`, async () => {
  let reads = 0, approvals = 0, models = 0;
  const tool = createSubagentTool({
    maxDepth: 2,
    authorizeNested: () => { approvals++; return approved; },
    tools: [{ name: "read_fixture", operation: "READ", description: "Read", inputSchema: { type: "object" }, async execute() { reads++; return { ok: true, output: "evidence" }; } }],
    createModel: () => {
      const depth = ++models;
      return { async respond(request) {
        if (!request.toolOutputs.length) return { responseId: "calls", text: "", toolCalls: [
          { callId: "read", name: "read_fixture", arguments: "{}" },
          ...(depth === 1 ? [{ callId: "nested", name: "delegate_subagent", arguments: '{"task":"Inspect"}' }] : []),
        ] };
        assert.equal(request.toolOutputs[0]?.output, "evidence");
        return { responseId: "done", text: "done", toolCalls: [] };
      } };
    },
  });
  assert.equal((await tool.execute({ task: "Inspect" })).ok, true);
  assert.equal(reads, approved ? 2 : 1);
  assert.equal(approvals, 1);
  assert.equal(models, approved ? 2 : 1);
});

test("concurrent start reserves capacity before durable save without ghost jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dragons-admission-"));
  const store = createPersistentBackgroundJobStore(dir);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => { entered = resolve; });
  let saves = 0;
  const manager = new PersistentBackgroundJobManager({ maxActiveJobs: 1, store: { ...store, async save(job, revision) {
    if (++saves === 1) { entered(); await blocked; }
    return store.save(job, revision);
  } } });
  const options = { sessionId, workingDirectory: dir, prompt: "Read", createModel: model, tools: [] };
  const first = manager.start(options);
  try {
    await saving;
    const second = manager.start(options);
    const rejection = assert.rejects(second, /concurrency limit/);
    release();
    await rejection;
    const job = await first;
    await manager.wait(job.id);
    assert.equal(manager.list().length, 1);
    assert.equal((await store.list()).length, 1);
  } finally {
    release();
    await first.catch(() => undefined);
    for (const job of manager.list()) await manager.wait(job.id);
    await rm(dir, { recursive: true, force: true });
  }
});
