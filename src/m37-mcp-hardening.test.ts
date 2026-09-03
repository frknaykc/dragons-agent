import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { McpClientManager } from "./mcp-client.js";

const server = fileURLToPath(new URL("./mcp-official-sdk-server.js", import.meta.url));

test("M37 records negotiated protocol metadata and bounded call outcomes without server payloads", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m37-mcp-"));
  const manager = new McpClientManager([{ id: "compat", command: process.execPath, args: [server, "normal", join(directory, "pids")] }]);
  try {
    const [tool] = await manager.connect("compat");
    const connected = manager.status()[0]!;
    assert.equal(connected.state, "connected");
    assert.match(connected.protocolVersion ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(connected.toolCount, 1);
    assert.equal(connected.callCount, 0);
    assert.equal(connected.capabilities.tools, true);
    assert.equal((await tool!.execute({ nested: { query: "safe" } })).ok, true);
    const after = manager.status()[0]!;
    assert.equal(after.callCount, 1);
    assert.equal(after.failureCount, 0);
    assert.equal(JSON.stringify(after).includes("result:safe"), false);
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("M37 deduplicates simultaneous stdio connection attempts and closes the sole child", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m37-mcp-concurrent-"));
  const pidFile = join(directory, "pids");
  const manager = new McpClientManager([{ id: "compat", command: process.execPath, args: [server, "normal", pidFile] }]);
  try {
    const [first, second] = await Promise.all([manager.connect("compat"), manager.connect("compat")]);
    assert.equal(first.length, 1);
    assert.deepEqual(second.map((tool) => tool.name), first.map((tool) => tool.name));
    await manager.closeAll();
    assert.equal((await readFile(pidFile, "utf8")).trim().split("\n").filter(Boolean).length, 1);
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("M37 closeAll waits for an in-flight connection before completing shutdown", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m37-mcp-close-"));
  const manager = new McpClientManager([{ id: "compat", command: process.execPath, args: [server, "normal", join(directory, "pids")] }]);
  try {
    const pending = manager.connect("compat");
    await manager.closeAll();
    await pending;
    assert.equal(manager.status()[0]?.state, "disconnected");
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
