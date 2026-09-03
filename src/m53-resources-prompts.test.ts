import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpClientManager } from "./mcp-client.js";

const fixture = fileURLToPath(new URL("./mcp-mock-server.js", import.meta.url));

test("M53 exposes bounded resource and prompt operations through the connected server", async () => {
  const manager = new McpClientManager([{ id: "fixture", command: process.execPath, args: [fixture] }]);
  try {
    await manager.connect("fixture");
    assert.deepEqual(await manager.listResources("fixture"), [{ uri: "fixture://note", name: "Note", mimeType: "text/plain" }]);
    assert.deepEqual(await manager.readResource("fixture", "fixture://note"), [{ uri: "fixture://note", text: "fixture resource" }]);
    assert.deepEqual(await manager.listPrompts("fixture"), [{ name: "fixture-prompt", description: "Fixture prompt" }]);
    assert.deepEqual(await manager.getPrompt("fixture", "fixture-prompt"), [{ role: "user", content: { type: "text", text: "fixture prompt body" } }]);
  } finally { await manager.closeAll(); }
});
