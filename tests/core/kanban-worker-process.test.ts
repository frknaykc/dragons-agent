import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileKanbanBoard, kanbanWorkspaceDirectory } from "../../dist/kanban.js";
import { runKanbanWorkerEntry } from "../../dist/kanban-worker-entry.js";
import { launchKanbanWorker } from "../../dist/kanban-worker-process.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { createApiKeyAuth } from "../../dist/provider/api-key-auth.js";

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

test("process refuses an invalid provider and leaves task idle", async (t) => {
  const f = await fixture(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({ provider: "openai" }));
  await assert.rejects(launchKanbanWorker({ workingDirectory: f.workspace, configPath: f.configPath, profile: "alpha", id: f.task.id, revision: f.task.revision }), /failed/);
  assert.equal((await f.board.get("alpha", f.task.id))?.status, "todo");
});

test("authenticated built-in worker uses profile slot, selected model and READ tools without persisting secrets", async (t) => {
  const f = await fixture(t);
  const key = "fixture-worker-key-not-for-storage";
  const selected: string[] = [];
  const auth = createApiKeyAuth("alpha", (_provider, slot) => ({
    async load() { selected.push(slot ?? "default"); return key; },
    async save() { assert.fail("Worker must not write credentials."); },
    async remove() { assert.fail("Worker must not delete credentials."); },
    async recover() { selected.push(`recover:${slot}`); return key; },
  }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({
    provider: "openai-api", models: { "openai-api": "gpt-4.1-mini" },
    apiKeySlots: { "openai-api": "audit" },
  }));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.match(String(input), /^https:\/\//);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    const body = JSON.parse(String(init?.body)) as { model: string; input: Array<{ content: unknown }>; tools: Array<{ name: string }> };
    assert.equal(body.model, "gpt-4.1-mini");
    assert.match(JSON.stringify(body.input), /Inspect project/);
    assert.ok(body.tools.length > 0);
    assert.ok(body.tools.every(({ name }) => !/write|execute|shell|patch/.test(name)));
    return new Response('data: {"type":"response.output_text.delta","delta":"private worker report"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_worker"}}\n\n',
    { headers: { "content-type": "text/event-stream" } });
  };
  try {
    await runKanbanWorkerEntry([f.workspace, f.configPath, "alpha", f.task.id,
      String(f.task.revision), "15000"], new AbortController().signal, auth);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(requests, 1);
  assert.ok(selected.includes("audit") || selected.includes("recover:audit"));
  assert.equal((await f.board.get("alpha", f.task.id))?.status, "done");
  const contents = await readFile(join(kanbanWorkspaceDirectory(f.configPath, f.workspace), "board.json"), "utf8");
  assert.doesNotMatch(contents, /fixture-worker-key|private worker report|resp_worker/);
});

test("failed authenticated worker blocks only its claimed task without falling back or persisting auth errors", async (t) => {
  const f = await fixture(t);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({
    provider: "openai-api", fallback: { enabled: true, consent: "allow-context-sharing",
      targets: [{ provider: "anthropic", model: "claude-sonnet-4-20250514" }] },
  }));
  const auth = createApiKeyAuth("alpha", () => ({
    async load(): Promise<string | undefined> { throw new Error("private credential failure"); },
    async save() { assert.fail("Worker must not write credentials."); },
    async remove() { assert.fail("Worker must not delete credentials."); },
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail("No provider should be contacted without credentials."); };
  try {
    await assert.rejects(runKanbanWorkerEntry([f.workspace, f.configPath, "alpha", f.task.id,
      String(f.task.revision), "15000"], new AbortController().signal, auth));
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await f.board.get("alpha", f.task.id))?.status, "blocked");
  const contents = await readFile(join(kanbanWorkspaceDirectory(f.configPath, f.workspace), "board.json"), "utf8");
  assert.doesNotMatch(contents, /credential failure/);
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
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": waiting\n\n");
    markStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.profiles.paths("alpha").configPath, JSON.stringify({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }));
  const stop = new AbortController();
  t.after(() => stop.abort());
  const pending = launchKanbanWorker({ workingDirectory: f.workspace, configPath: f.configPath, profile: "alpha", id: f.task.id, revision: f.task.revision, signal: stop.signal, maxRunMs: 15_000 });
  void pending.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([started, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Worker did not reach the Local model.")), 10_000);
    })]);
  } finally { clearTimeout(timeout); }
  const owner = (await f.board.get("alpha", f.task.id))?.worker;
  stop.abort();
  await assert.rejects(pending, /failed|cancelled/);
  assert.ok(owner);
  const task = await f.board.get("alpha", f.task.id);
  assert.notEqual(task?.status, "done");
});