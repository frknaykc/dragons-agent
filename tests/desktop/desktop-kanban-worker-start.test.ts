import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveDragonsConfig } from "../../dist/config.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { createDesktopRuntime, desktopLocalControls } from "../../dist/desktop/host.js";
import { createFileKanbanBoard, kanbanWorkspaceDirectory } from "../../dist/kanban.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";

test("Desktop explicitly launches one Local worker for its bound profile", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-desktop-worker-start-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, undefined);
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk as Uint8Array);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
    assert.equal(input.messages.at(-1)?.content, "Inspect project");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"desktop-worker","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridges: DesktopBridge[] = [];
  try {
    for (const name of ["alpha", "beta"]) {
      const profile = await profiles.create(name);
      await saveDragonsConfig({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }, profile.configPath);
      const runtime = await createDesktopRuntime(root, { configPath, profileName: name });
      bridges.push(new DesktopBridge(runtime, () => assert.fail("Worker command must not use interactive model."), desktopLocalControls(runtime)));
    }
    const [alpha, beta] = bridges as [DesktopBridge, DesktopBridge];
    const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, root), profiles);
    const task = await board.create("alpha", "Inspect project", "alpha", []);
    const start = `/kanban worker start ${task.id} 0`;
    assert.equal((await beta.request({ type: "slash", content: start })).ok, false);
    assert.equal((await board.get("alpha", task.id))?.status, "todo");
    assert.match(JSON.stringify(await alpha.request({ type: "slash", content: `${start} extra` })), /Usage: \/kanban worker/);
    assert.match(JSON.stringify(await alpha.request({ type: "slash", content: start })), /worker completed/);
    assert.equal(requests, 1);
    assert.equal((await board.get("alpha", task.id))?.status, "done");
    assert.equal((await alpha.request({ type: "slash", content: start })).ok, false);
  } finally { await Promise.all(bridges.map((bridge) => bridge.close())); }
});

test("Desktop close aborts an active worker before disposal finishes", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-desktop-worker-stop-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const profile = await profiles.create("alpha");
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": waiting\n\n");
    markStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await saveDragonsConfig({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }, profile.configPath);
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, root), profiles);
  const task = await board.create("alpha", "Wait", "alpha", []);
  const runtime = await createDesktopRuntime(root, { configPath, profileName: "alpha" });
  const bridge = new DesktopBridge(runtime, () => assert.fail("Worker must not run interactive model."), desktopLocalControls(runtime));
  t.after(() => bridge.close());
  const pending = bridge.request({ type: "slash", content: `/kanban worker start ${task.id} 0` });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([started, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Worker did not reach the Local model.")), 10_000);
    })]);
  } finally { clearTimeout(timeout); }
  assert.notEqual((await board.get("alpha", task.id))?.worker, undefined);
  await bridge.close();
  assert.equal((await pending).ok, false);
  assert.notEqual((await board.get("alpha", task.id))?.status, "done");
});

test("Desktop lane validates bound profile and dependency order before running two Local children", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-desktop-worker-lane-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk as Uint8Array);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
    requests.push(input.messages.at(-1)?.content ?? "missing");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"desktop-lane","choices":[{"index":0,"delta":{"content":"PRIVATE RESPONSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridges: DesktopBridge[] = [];
  try {
    for (const name of ["alpha", "beta"]) {
      const profile = await profiles.create(name);
      await saveDragonsConfig({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }, profile.configPath);
      const runtime = await createDesktopRuntime(root, { configPath, profileName: name });
      bridges.push(new DesktopBridge(runtime, () => assert.fail("Lane must not use interactive model."), desktopLocalControls(runtime)));
    }
    const [alpha, beta] = bridges as [DesktopBridge, DesktopBridge];
    const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, root), profiles);
    const first = await board.create("alpha", "First", "alpha", []);
    const next = await board.create("alpha", "Next", "alpha", []);
    const dependent = await board.addDependency("alpha", next.id, 0, first.id);
    const lane = (items: string) => `/kanban worker lane ${items}`;
    const selected = lane(`${first.id}:0 ${next.id}:${dependent.revision}`);
    assert.equal((await beta.request({ type: "slash", content: selected })).ok, false);
    assert.equal((await alpha.request({ type: "slash", content: lane(`${next.id}:${dependent.revision} ${first.id}:0`) })).ok, false);
    assert.match(JSON.stringify(await alpha.request({ type: "slash", content: lane(`${first.id}:0 ${first.id}:0`) })), /Usage: \/kanban worker/);
    assert.match(JSON.stringify(await alpha.request({ type: "slash", content: lane(`${first.id}:00`) })), /Usage: \/kanban worker/);
    assert.equal(requests.length, 0);
    const result = await alpha.request({ type: "slash", content: selected });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /worker lane completed 2 tasks/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE RESPONSE|desktop-lane/);
    assert.deepEqual(requests, ["First", "Next"]);
    assert.equal((await board.get("alpha", first.id))?.status, "done");
    assert.equal((await board.get("alpha", next.id))?.status, "done");
    assert.equal((await alpha.request({ type: "slash", content: selected })).ok, false);
    assert.equal(requests.length, 2);
  } finally { await Promise.all(bridges.map((bridge) => bridge.close())); }
});
