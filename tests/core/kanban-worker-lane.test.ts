import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runKanbanWorkerLane } from "../../dist/kanban-worker-lane.js";
import { createFileKanbanBoard, inspectKanbanLaneLock, kanbanWorkspaceDirectory,
  recoverAbandonedKanbanLaneLock } from "../../dist/kanban.js";
import { runKanbanWorker } from "../../dist/kanban-worker.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-kanban-lane-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  await profiles.create("beta");
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, root), profiles);
  const first = await board.create("alpha", "First", "alpha", []);
  const second = await board.create("alpha", "Second", "alpha", []);
  const run = async ({ id, revision, signal }: { id: string; revision: number; signal?: AbortSignal }) => {
    await runKanbanWorker({ board, actor: "alpha", id, revision, signal, run: async () => "PRIVATE REPORT" });
  };
  const base = { board, profile: "alpha", workingDirectory: root, configPath, run };
  return { board, profiles, first, second, base };
}

test("default lane launches two separate Local children and persists no model responses", async (t) => {
  const { board, profiles, first, second, base } = await fixture(t);
  const dependent = await board.addDependency("alpha", second.id, 0, first.id);
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, undefined);
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk as Uint8Array);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { content: string }[]; tools: { function: { name: string } }[] };
    assert.equal(input.messages.at(-1)?.content, requests === 1 ? "First" : "Second");
    assert.ok(input.tools.every((tool) => !/write|execute|shell|patch/.test(tool.function.name)));
    if (requests === 2) assert.equal((await board.get("alpha", first.id))?.status, "done");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"lane-test","choices":[{"index":0,"delta":{"content":"PRIVATE MODEL RESPONSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(profiles.paths("alpha").configPath, JSON.stringify({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }));
  const completed = await runKanbanWorkerLane({ board, workingDirectory: base.workingDirectory,
    configPath: base.configPath, profile: "alpha", tasks: [{ id: first.id, revision: 0 }, { id: second.id, revision: dependent.revision }] });
  assert.deepEqual(completed, [first.id, second.id]);
  assert.equal(requests, 2);
  const contents = await readFile(join(kanbanWorkspaceDirectory(base.configPath, base.workingDirectory), "board.json"), "utf8");
  assert.doesNotMatch(contents, /PRIVATE MODEL RESPONSE|lane-test/);
});

test("explicit lane runs selected tasks serially in order, including dependencies, and returns IDs only", async (t) => {
  const { board, first, second, base } = await fixture(t);
  await board.addDependency("alpha", second.id, second.revision, first.id);
  const refreshed = await board.get("alpha", second.id);
  assert.ok(refreshed);
  const active: string[] = [];
  const result = await runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }, { id: second.id, revision: refreshed.revision }],
    run: async (request) => {
      assert.equal(active.length, 0);
      active.push(request.id);
      await base.run(request);
      active.pop();
    },
  });
  assert.deepEqual(result, [first.id, second.id]);
  assert.equal((await board.get("alpha", first.id))?.status, "done");
  assert.equal((await board.get("alpha", second.id))?.status, "done");
});

test("invalid or out-of-order plans do not launch any worker", async (t) => {
  const { board, first, second, base } = await fixture(t);
  await board.addDependency("alpha", second.id, second.revision, first.id);
  const refreshed = await board.get("alpha", second.id);
  assert.ok(refreshed);
  let launches = 0;
  const options = { ...base, run: async () => { launches++; } };
  for (const tasks of [
    [], [{ id: first.id, revision: 0 }, { id: first.id, revision: 0 }],
    [{ id: second.id, revision: refreshed.revision }, { id: first.id, revision: 0 }],
    [{ id: first.id, revision: 1 }], [{ id: "bad", revision: 0 }],
    Array.from({ length: 9 }, () => ({ id: first.id, revision: 0 })),
  ]) await assert.rejects(runKanbanWorkerLane({ ...options, tasks }), /lane/i);
  const foreign = await board.create("alpha", "Foreign", "beta", []);
  await assert.rejects(runKanbanWorkerLane({ ...options, tasks: [{ id: foreign.id, revision: 0 }] }), /lane/i);
  assert.equal(launches, 0);
});

test("lane stops on failure, cancellation or external revision change without replaying later tasks", async (t) => {
  const { board, first, second, base } = await fixture(t);
  const tasks = [{ id: first.id, revision: 0 }, { id: second.id, revision: 0 }];
  let calls = 0;
  await assert.rejects(runKanbanWorkerLane({ ...base, tasks, run: async (request) => {
    calls++;
    await runKanbanWorker({ board, actor: "alpha", id: request.id, revision: request.revision,
      run: async () => { throw new Error("private provider content"); } });
  } }), /lane/i);
  assert.equal(calls, 1);
  assert.equal((await board.get("alpha", first.id))?.status, "blocked");
  assert.equal((await board.get("alpha", second.id))?.status, "todo");

  const third = await board.create("alpha", "Third", "alpha", []);
  const fourth = await board.create("alpha", "Fourth", "alpha", []);
  const stop = new AbortController();
  await assert.rejects(runKanbanWorkerLane({ ...base, signal: stop.signal,
    tasks: [{ id: third.id, revision: 0 }, { id: fourth.id, revision: 0 }],
    run: async (request) => { await base.run(request); stop.abort(); },
  }), /lane/i);
  assert.equal((await board.get("alpha", fourth.id))?.status, "todo");

  const fifth = await board.create("alpha", "Fifth", "alpha", []);
  const sixth = await board.create("alpha", "Sixth", "alpha", []);
  await assert.rejects(runKanbanWorkerLane({ ...base,
    tasks: [{ id: fifth.id, revision: 0 }, { id: sixth.id, revision: 0 }],
    run: async (request) => { await base.run(request); await board.assign("alpha", sixth.id, 0, "beta"); },
  }), /lane/i);
  assert.equal((await board.get("alpha", sixth.id))?.assignee, "beta");
  assert.equal((await board.get("alpha", sixth.id))?.status, "todo");
});

test("lane does not accept a callback that returns without its claimed worker completion", async (t) => {
  const { board, first, second, base } = await fixture(t);
  await assert.rejects(runKanbanWorkerLane({ ...base,
    tasks: [{ id: first.id, revision: 0 }, { id: second.id, revision: 0 }],
    run: async (request) => {
      await board.updateProgress("alpha", request.id, request.revision, "done", 100);
    },
  }), /lane/i);
  assert.equal((await board.get("alpha", first.id))?.status, "done");
  assert.equal((await board.get("alpha", second.id))?.status, "todo");
});

test("lane holds the workspace lock across children and rejects a competing profile without launch", async (t) => {
  const { board, first, second, base } = await fixture(t);
  const other = await board.create("beta", "Other", "beta", []);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const primary = runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }, { id: second.id, revision: 0 }],
    run: async (request) => {
      if (request.id === first.id) { entered(); await wait; }
      await base.run(request);
    },
  });
  t.after(() => release());
  await started;
  const directory = kanbanWorkspaceDirectory(base.configPath, base.workingDirectory);
  assert.ok(await inspectKanbanLaneLock(directory));
  let launched = false;
  await assert.rejects(runKanbanWorkerLane({ ...base, profile: "beta", tasks: [{ id: other.id, revision: 0 }],
    run: async () => { launched = true; } }), /lane is busy/i);
  assert.equal(launched, false);
  release();
  assert.deepEqual(await primary, [first.id, second.id]);
  assert.equal(await inspectKanbanLaneLock(directory), undefined);
});

test("lane lock is released after child failure and cancellation", async (t) => {
  const { first, second, base } = await fixture(t);
  const directory = kanbanWorkspaceDirectory(base.configPath, base.workingDirectory);
  await assert.rejects(runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }],
    run: async () => { throw new Error("secret error"); } }), /lane stopped/i);
  assert.equal(await inspectKanbanLaneLock(directory), undefined);
  const cancelled = new AbortController();
  await assert.rejects(runKanbanWorkerLane({ ...base, signal: cancelled.signal,
    tasks: [{ id: second.id, revision: 0 }], run: async (request) => {
      cancelled.abort();
      await base.run(request);
    } }), /lane/i);
  assert.equal(await inspectKanbanLaneLock(directory), undefined);
});

test("another process cannot enter a workspace lane while its owner is alive", async (t) => {
  const { base, first } = await fixture(t);
  const directory = kanbanWorkspaceDirectory(base.configPath, base.workingDirectory);
  const moduleUrl = new URL("../../dist/kanban.js", import.meta.url).href;
  const script = `import { withKanbanLaneLock } from ${JSON.stringify(moduleUrl)};
    await withKanbanLaneLock(process.argv[1], async () => {
      process.stdout.write("ready\\n");
      await new Promise(() => { setInterval(() => {}, 1000); });
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory],
    { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.ok(child.stdout);
  let timer!: ReturnType<typeof setTimeout>;
  const ready = await Promise.race([
    once(child.stdout, "data").then(([bytes]) => String(bytes)),
    once(child, "exit").then(() => { throw new Error("Lane owner exited before ready."); }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Lane owner did not start.")), 5_000); }),
  ]).finally(() => clearTimeout(timer));
  assert.match(ready, /ready/);
  let launched = false;
  await assert.rejects(runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }],
    run: async () => { launched = true; } }), /lane is busy/i);
  assert.equal(launched, false);
  const exited = once(child, "exit");
  child.kill();
  await exited;
  const lock = await inspectKanbanLaneLock(directory);
  assert.ok(lock);
  await assert.rejects(runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }] }), /lane is busy/i);
  assert.equal(await recoverAbandonedKanbanLaneLock(directory, lock.token), true);
  assert.deepEqual(await runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }] }), [first.id]);
});

test("abandoned lane lock requires explicit inspected-token recovery; unsafe and live locks fail closed", async (t) => {
  const { base, first } = await fixture(t);
  const directory = kanbanWorkspaceDirectory(base.configPath, base.workingDirectory);
  const path = join(directory, ".kanban-lane.lock");
  const target = join(base.workingDirectory, "outside");
  const token = randomUUID();
  await writeFile(target, "unmodified");
  await symlink(target, path);
  await assert.rejects(runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }] }), /lane is busy/i);
  await assert.rejects(inspectKanbanLaneLock(directory), /Unsafe Kanban lock/i);
  await rm(path);
  assert.equal(await readFile(target, "utf8"), "unmodified");
  await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), token }));
  await assert.rejects(recoverAbandonedKanbanLaneLock(directory, token), /still active/i);
  await writeFile(path, JSON.stringify({ pid: 2_147_483_647, host: hostname(), token }));
  assert.equal((await inspectKanbanLaneLock(directory))?.token, token);
  await assert.rejects(recoverAbandonedKanbanLaneLock(directory, "wrong-token"), /token changed/i);
  await assert.rejects(runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }] }), /lane is busy/i);
  assert.equal(await recoverAbandonedKanbanLaneLock(directory, token), true);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.deepEqual(await runKanbanWorkerLane({ ...base, tasks: [{ id: first.id, revision: 0 }] }), [first.id]);
});
