import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Readable } from "node:stream";

import { main, parseCliCommand } from "./cli.js";
import {
  DEFAULT_MAX_MCP_SERVERS,
  McpClientManager,
  parseMcpServerConfigs,
  type StdioMcpServerConfig,
} from "./mcp-client.js";

const mockServer = fileURLToPath(new URL("./mcp-mock-server.js", import.meta.url));

function fixture(id: string, mode = "normal"): StdioMcpServerConfig {
  return { id, command: process.execPath, args: mode === "normal" ? [mockServer] : [mockServer, mode] };
}

test("M52 connects configured MCP servers together with isolated namespaces", async () => {
  const manager = new McpClientManager([fixture("alpha"), fixture("beta")]);
  try {
    const result = await manager.connectAll();
    assert.deepEqual(result, { connected: ["alpha", "beta"], failed: [] });

    const tools = manager.tools();
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp__alpha__inspect", "mcp__beta__inspect"]);
    assert.deepEqual(await tools[0]!.execute({ nested: { query: "alpha" } }), {
      ok: true,
      output: "[{\"type\":\"text\",\"text\":\"result:alpha\"}]",
    });
    assert.deepEqual(await tools[1]!.execute({ nested: { query: "beta" } }), {
      ok: true,
      output: "[{\"type\":\"text\",\"text\":\"result:beta\"}]",
    });
    assert.deepEqual(manager.status().map(({ id, state, toolCount }) => ({ id, state, toolCount })), [
      { id: "alpha", state: "connected", toolCount: 1 },
      { id: "beta", state: "connected", toolCount: 1 },
    ]);
  } finally {
    await manager.closeAll();
  }
});

test("M52 bounds configured server count before any connection starts", () => {
  const configs = Array.from({ length: DEFAULT_MAX_MCP_SERVERS + 1 }, (_, index) => fixture(`server-${index}`));
  assert.throws(() => parseMcpServerConfigs(configs), /at most .* MCP servers/i);
});

test("M52 rejects non-finite connection and discovery bounds", () => {
  assert.throws(() => new McpClientManager([], { maxConcurrentConnections: Number.NaN }), /finite positive integer/i);
  assert.throws(() => new McpClientManager([], { maxTotalTools: Number.POSITIVE_INFINITY }), /finite positive integer/i);
});

test("M52 keeps delimiter-bearing server and tool identifiers collision-safe", async () => {
  const manager = new McpClientManager([fixture("a", "collision-left"), fixture("a__b", "collision-right")]);
  try {
    assert.deepEqual(await manager.connectAll(), { connected: ["a", "a__b"], failed: [] });
    const names = manager.tools().map((tool) => tool.name);
    assert.equal(new Set(names).size, 2);
  } finally {
    await manager.closeAll();
  }
});

test("M52 applies the connection bound to direct concurrent connects", async () => {
  const manager = new McpClientManager([
    fixture("first", "slow-list"),
    fixture("second", "slow-list"),
    fixture("third", "slow-list"),
  ]);
  try {
    const startedAt = Date.now();
    await Promise.all([manager.connect("first"), manager.connect("second"), manager.connect("third")]);
    assert.ok(Date.now() - startedAt >= 150, "direct connections must run in bounded waves");
  } finally {
    await manager.closeAll();
  }
});

test("M52 cancels a direct connection while it waits for a connection slot", async () => {
  const manager = new McpClientManager([
    fixture("first", "slow-list"),
    fixture("second", "slow-list"),
    fixture("queued"),
  ]);
  const controller = new AbortController();
  try {
    const active = [manager.connect("first"), manager.connect("second")];
    const queued = manager.connect("queued", [], controller.signal);
    controller.abort();
    await assert.rejects(queued, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    await Promise.all(active);
    assert.deepEqual(manager.status().map(({ id, state }) => ({ id, state })), [
      { id: "first", state: "connected" },
      { id: "second", state: "connected" },
      { id: "queued", state: "disconnected" },
    ]);
  } finally {
    await manager.closeAll();
  }
});

test("M52 exposes a bounded connect-all command without reserving server IDs", async () => {
  assert.deepEqual(parseCliCommand(["mcp", "connect-all"]), { kind: "mcp", action: "connect-all" });
  assert.deepEqual(parseCliCommand(["mcp", "connect", "all"]), { kind: "mcp", action: "connect", id: "all" });

  const output: string[] = [];
  await main(["mcp", "connect-all"], {
    config: { mcpServers: [fixture("alpha"), fixture("beta")] },
    write: (text) => output.push(text),
  });
  assert.equal(output.join(""), "Connected MCP servers: alpha, beta\n");

  const interactiveOutput: string[] = [];
  await main([], {
    config: { mcpServers: [fixture("alpha"), fixture("beta")] },
    input: Readable.from(["/mcp connect-all\n", "/exit\n"]),
    tools: [],
    write: (text) => interactiveOutput.push(text),
    model: { async respond() { throw new Error("The connect-all command must not invoke the model."); } },
  });
  assert.match(interactiveOutput.join(""), /Connected MCP servers: alpha, beta/);
});

test("M52 bulk connection isolates failed servers and applies aggregate tool bounds", async () => {
  const manager = new McpClientManager([
    fixture("first"),
    fixture("broken", "list-error"),
    fixture("second"),
  ], { maxConcurrentConnections: 2, maxTotalTools: 1 });
  try {
    const result = await manager.connectAll();
    assert.equal(result.connected.length, 1);
    assert.ok(["first", "second"].includes(result.connected[0]!));
    assert.equal(result.failed.length, 2);
    assert.ok(result.failed.includes("broken"));
    assert.deepEqual(manager.tools().map((tool) => tool.name), [`mcp__${result.connected[0]}__inspect`]);
    const statuses = manager.status().map(({ id, state, lastError, lastFailureCategory }) => ({ id, state, lastError, lastFailureCategory }));
    assert.deepEqual(statuses.find(({ id }) => id === result.connected[0]), {
      id: result.connected[0], state: "connected", lastError: undefined, lastFailureCategory: undefined,
    });
    assert.deepEqual(statuses.find(({ id }) => id === "broken"), {
      id: "broken", state: "disconnected", lastError: "MCP connection or discovery failed.", lastFailureCategory: "discovery",
    });
    assert.equal(JSON.stringify({ result, status: manager.status() }).includes("server-secret-marker"), false);
  } finally {
    await manager.closeAll();
  }
});

test("M52 bulk connection honors cancellation before scheduling servers", async () => {
  const manager = new McpClientManager([fixture("first"), fixture("second")]);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(manager.connectAll([], controller.signal), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    assert.deepEqual(manager.status().map(({ state }) => state), ["disconnected", "disconnected"]);
  } finally {
    await manager.closeAll();
  }
});
