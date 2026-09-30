import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileKanbanBoard, kanbanWorkspaceDirectory } from "../../dist/kanban.js";
import { launchKanbanWorker } from "../../dist/kanban-worker-process.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-worker-process-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  await profiles.create("alpha");
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, workspace), profiles);
  const task = await board.create("alpha", "Inspect project", "alpha", []);
  return { root, workspace, configPath, profiles, board, task };
}

test("separate trusted local-model process claims and finishes one READ-only task", async (t) => {
  const f = await fixture(t);
  let seen = 0;
  const server = createServer(async (request, response) => {
    seen++;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, undefined);
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk as Uint8Array);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { content: string }[]; tools: { function: { name: string } }[] };
    assert.equal(input.messages.at(-1)?.content, "Inspect project");
    assert.ok(input.tools.every((tool) => !/write|execute|shell|patch/.test(tool.function.name)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"worker-test","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }));
  await launchKanbanWorker({ workingDirectory: f.workspace, configPath: f.configPath, profile: "alpha", id: f.task.id, revision: f.task.revision });
  assert.equal(seen, 1);
  const done = await f.board.get("alpha", f.task.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.worker, undefined);
  const contents = await readFile(join(kanbanWorkspaceDirectory(f.configPath, f.workspace), "board.json"), "utf8");
  assert.doesNotMatch(contents, /Done|worker-test/);
});

test("process refuses a non-local profile and leaves task idle", async (t) => {
  const f = await fixture(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({ provider: "openai" }));
  await assert.rejects(launchKanbanWorker({ workingDirectory: f.workspace, configPath: f.configPath, profile: "alpha", id: f.task.id, revision: f.task.revision }), /failed/);
  assert.equal((await f.board.get("alpha", f.task.id))?.status, "todo");
});

test("provider failure blocks the child-owned task without persisting a response", async (t) => {
  const f = await fixture(t);
  let claimedPid: number | undefined;
  const server = createServer(async (_request, response) => {
    let claimed;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { claimed = (await f.board.get("alpha", f.task.id))?.worker; }
      catch (error: unknown) {
        if (!(error instanceof Error) || !/changed during read/.test(error.message)) throw error;
      }
      if (claimed) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    claimedPid = claimed?.pid;
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("sensitive provider failure");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }));
  await assert.rejects(launchKanbanWorker({ workingDirectory: f.workspace, configPath: f.configPath, profile: "alpha", id: f.task.id, revision: f.task.revision }), /failed/);
  assert.ok(claimedPid && claimedPid !== process.pid);
  assert.equal((await f.board.get("alpha", f.task.id))?.status, "blocked");
  const contents = await readFile(join(kanbanWorkspaceDirectory(f.configPath, f.workspace), "board.json"), "utf8");
  assert.doesNotMatch(contents, /sensitive provider failure/);
});

test("aborted process stops without automatic retry or claim recovery", async (t) => {
  const f = await fixture(t);
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": waiting\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }));
  const stop = new AbortController();
  t.after(() => stop.abort());
  const pending = launchKanbanWorker({ workingDirectory: f.workspace, configPath: f.configPath, profile: "alpha", id: f.task.id, revision: f.task.revision, signal: stop.signal, maxRunMs: 3_000 });
  void pending.catch(() => undefined);
  let owner;
  for (let i = 0; i < 100; i++) {
    try { owner = (await f.board.get("alpha", f.task.id))?.worker; }
    catch (error: unknown) {
      if (!(error instanceof Error) || !/changed during read/.test(error.message)) throw error;
    }
    if (owner) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  stop.abort();
  await assert.rejects(pending, /failed|cancelled/);
  assert.ok(owner);
  const task = await f.board.get("alpha", f.task.id);
  assert.notEqual(task?.status, "done");
});