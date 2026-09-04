import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpClientManager } from "./mcp-client.js";

const fixture = fileURLToPath(new URL("./mcp-mock-server.js", import.meta.url));

test("M54 retains bounded MCP provenance and removes it on disconnect", async () => {
  const manager = new McpClientManager([{ id: "fixture", command: process.execPath, args: [fixture] }]);
  try {
    await manager.connect("fixture");
    const capabilities = manager.capabilities();
    assert.deepEqual(capabilities.map(({ type, originalName, serverId, transport, state }) => ({ type, originalName, serverId, transport, state })), [
      { type: "tool", originalName: "inspect", serverId: "fixture", transport: "stdio", state: "connected" },
      { type: "resource", originalName: "Note", serverId: "fixture", transport: "stdio", state: "connected" },
      { type: "prompt", originalName: "fixture-prompt", serverId: "fixture", transport: "stdio", state: "connected" },
    ]);
    const tool = capabilities.find((capability) => capability.type === "tool");
    assert.deepEqual(tool && { name: tool.name, operation: tool.operation }, { name: "mcp__fixture__inspect", operation: "EXECUTE" });
    assert.deepEqual(manager.status().map(({ toolCount, resourceCount, promptCount, toolNames }) => ({ toolCount, resourceCount, promptCount, toolNames })), [{ toolCount: 1, resourceCount: 1, promptCount: 1, toolNames: ["mcp__fixture__inspect"] }]);
    await manager.disconnect("fixture");
    assert.deepEqual(manager.capabilities(), []);
    assert.deepEqual(manager.status().map(({ toolCount, resourceCount, promptCount, toolNames }) => ({ toolCount, resourceCount, promptCount, toolNames })), [{ toolCount: 0, resourceCount: 0, promptCount: 0, toolNames: [] }]);
  } finally { await manager.closeAll(); }
});

test("M54 redacts server-controlled credential-shaped metadata before management exposure", async () => {
  const manager = new McpClientManager([{ id: "fixture", command: process.execPath, args: [fixture, "secret-metadata"] }]);
  try {
    await manager.connect("fixture");
    const managementOutput = JSON.stringify({ capabilities: manager.capabilities(), status: manager.status() });
    assert.doesNotMatch(managementOutput, /fixture-private-marker/);
    assert.match(managementOutput, /\[REDACTED\]/);
  } finally { await manager.closeAll(); }
});
