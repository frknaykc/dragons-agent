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

test("Desktop close aborts a lane child without starting its next task", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-desktop-worker-lane-stop-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "settings", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const profile = await profiles.create("alpha");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": waiting\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await saveDragonsConfig({ provider: "local", localEndpoint: `http://127.0.0.1:${address.port}/v1` }, profile.configPath);
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, root), profiles);
  const first = await board.create("alpha", "Wait", "alpha", []);
  const second = await board.create("alpha", "Never start", "alpha", []);
  const dependent = await board.addDependency("alpha", second.id, 0, first.id);
  const runtime = await createDesktopRuntime(root, { configPath, profileName: "alpha" });
  const bridge = new DesktopBridge(runtime, () => assert.fail("Lane must not use interactive model."), desktopLocalControls(runtime));
  t.after(() => bridge.close());
  const pending = bridge.request({ type: "slash", content: `/kanban worker lane ${first.id}:0 ${second.id}:${dependent.revision}` });
  let claimed = false;
  for (let i = 0; i < 100; i++) {
    try { claimed = (await board.get("alpha", first.id))?.worker !== undefined; }
    catch (error: unknown) { if (!(error instanceof Error) || !/changed during read/.test(error.message)) throw error; }
    if (claimed) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(claimed, true);
  await bridge.close();
  assert.equal((await pending).ok, false);
  assert.notEqual((await board.get("alpha", first.id))?.status, "done");
  assert.equal((await board.get("alpha", second.id))?.status, "todo");
  assert.ok(requests <= 1);
});
