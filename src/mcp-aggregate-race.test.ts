import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { McpClientManager } from "./mcp-client.js";

// Local synthetic servers only. The barrier aligns discovery completion rather
// than relying on process scheduling to exercise aggregate admission.
test("MCP aggregate tool limit is rechecked after concurrent capability discovery", { timeout: 10_000 }, async (t) => {
  const mockServer = fileURLToPath(new URL("./mcp-mock-server.js", import.meta.url));
  const manager = new McpClientManager(["first", "second"].map((id) => ({ id, command: process.execPath, args: [mockServer] })),
    { maxConcurrentConnections: 2, maxTotalTools: 1 });
  const original = Client.prototype.listResources;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let arrived = 0;
  t.mock.method(Client.prototype, "listResources", async function (this: Client, ...args: Parameters<typeof original>) {
    const resources = await original.apply(this, args);
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    return resources;
  });
  t.after(async () => { release(); await manager.closeAll(); });
  const results = await Promise.allSettled([manager.connect("first"), manager.connect("second")]);
  assert.equal(arrived, 2, "both tool lists were admitted before capability discovery completed");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(manager.tools().length, 1);
  assert.equal(manager.status().filter((status) => status.state === "connected").length, 1);
});
