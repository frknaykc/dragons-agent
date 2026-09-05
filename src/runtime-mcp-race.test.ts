import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpClientManager } from "./mcp-client.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

const fixture = fileURLToPath(new URL("./mcp-mock-server.js", import.meta.url));

for (const shared of [false, true]) {
test(`M71 disposal settles pending MCP ownership (${shared ? "shared manager" : "single runtime"})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-mcp-race-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  class DelayedManager extends McpClientManager {
    override async connect(...args: Parameters<McpClientManager["connect"]>) {
      entered();
      await gate;
      return super.connect(...args);
    }
  }
  const manager = new DelayedManager([{ id: "fixture", command: process.execPath, args: [fixture] }]);
  const options = {
    workingDirectory: root,
    sessionStore: createSessionStore(join(root, "sessions")),
    tools: [],
    mcpManager: manager,
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  };
  const runtime = await createDragonsRuntime(options);
  const other = shared ? await createDragonsRuntime(options) : undefined;
  try {
    const connection = runtime.connectMcp("fixture");
    const rejected = assert.rejects(connection, /disposed/);
    await started;
    const otherConnection = other?.connectMcp("fixture");
    const disposal = runtime.dispose();
    assert.equal(runtime.dispose(), disposal, "concurrent callers share the cleanup completion");
    release();
    await Promise.all([disposal, rejected, otherConnection]);
    assert.equal(manager.status()[0]?.state, shared ? "connected" : "disconnected");
    await other?.dispose();
    assert.equal(manager.status()[0]?.state, "disconnected");
    await assert.rejects(runtime.connectMcp("fixture"), /disposed/);
  } finally {
    release();
    await runtime.dispose();
    await other?.dispose();
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
}
