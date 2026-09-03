import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Readable } from "node:stream";

import { runAgent, type AgentModel } from "./agent.js";
import { main, parseCliCommand } from "./cli.js";
import { parseDragonsConfig } from "./config.js";
import { createSessionStore } from "./session-store.js";
import { createOpenAIAgentModel } from "./provider/openai.js";
import { createCodexAgentModel } from "./provider/codex.js";
import {
  DEFAULT_MAX_MCP_SCHEMA_BYTES,
  McpClientManager,
  parseMcpServerConfig,
  type McpServerConfig,
} from "./mcp-client.js";

const mockServer = fileURLToPath(new URL("./mcp-mock-server.js", import.meta.url));

function fixture(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "fixture",
    command: process.execPath,
    args: [mockServer],
    ...overrides,
  };
}

async function connected(overrides: Partial<McpServerConfig> = {}) {
  const manager = new McpClientManager([fixture(overrides)]);
  await manager.connect("fixture", []);
  return manager;
}

test("M25 explicitly connects through the official SDK, discovers nested schemas, and maps names", async () => {
  const manager = await connected();
  try {
    const tools = manager.tools();
    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert.equal(tool?.name, "mcp__fixture__inspect");
    assert.match(tool!.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(tool?.operation, "EXECUTE");
    assert.deepEqual(tool?.inputSchema, {
      type: "object",
      properties: {
        nested: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      required: ["nested"],
    });
    assert.deepEqual(await tool!.execute({ nested: { query: "ok" } }), {
      ok: true,
      output: "[{\"type\":\"text\",\"text\":\"result:ok\"}]",
    });
  } finally {
    await manager.closeAll();
  }
});

test("M25 rejects duplicate mapped names and unsafe config secrets before processes start", async () => {
  assert.throws(() => parseMcpServerConfig({ id: "fixture", command: "node", args: [], env: { API_TOKEN: "nope" } }), /safe environment/i);
  assert.throws(() => parseMcpServerConfig({ id: "fixture", command: "node", args: ["--token", "secret-value"] }), /credential-like argument/i);
  const manager = new McpClientManager([fixture({ args: [mockServer, "duplicate"] })]);
  await assert.rejects(manager.connect("fixture", []), /duplicate MCP tool name/i);
  await manager.closeAll();
});

test("M25 caps individual schemas and leaves the server disconnected on discovery failure", async () => {
  const manager = new McpClientManager([fixture({ args: [mockServer, "large-schema"] })], {
    maxSchemaBytes: DEFAULT_MAX_MCP_SCHEMA_BYTES,
  });
  await assert.rejects(manager.connect("fixture", []), /schema exceeds/i);
  assert.equal(manager.status()[0]?.state, "disconnected");
  await manager.closeAll();
});

test("M37 status never retains server-controlled protocol error text", async () => {
  const manager = new McpClientManager([fixture({ args: [mockServer, "list-error"] })]);
  try {
    await assert.rejects(manager.connect("fixture"));
    const status = manager.status()[0]!;
    assert.equal(status.state, "disconnected");
    assert.equal(JSON.stringify(status).includes("server-secret-marker"), false);
    assert.equal(status.lastError, "MCP connection or discovery failed.");
  } finally {
    await manager.closeAll();
  }
});

test("M37 rejects oversized server tool identities and descriptions before exposing tools", async () => {
  const nameManager = new McpClientManager([fixture({ args: [mockServer, "large-name"] })]);
  const descriptionManager = new McpClientManager([fixture({ args: [mockServer, "large-description"] })]);
  try {
    await assert.rejects(nameManager.connect("fixture"), /tool name exceeds/i);
    await assert.rejects(descriptionManager.connect("fixture"), /description exceeds/i);
    assert.deepEqual(nameManager.tools(), []);
    assert.deepEqual(descriptionManager.tools(), []);
  } finally {
    await Promise.all([nameManager.closeAll(), descriptionManager.closeAll()]);
  }
});

test("M25 routes server exits, malformed protocol, cancellation, and result bounds as recoverable tool results", async () => {
  const exitManager = await connected({ args: [mockServer, "exit-on-call"] });
  const malformedManager = new McpClientManager([fixture({ args: [mockServer, "malformed"] })], { connectTimeoutMilliseconds: 200 });
  const cancelManager = await connected({ args: [mockServer, "wait"] });
  const cappedManager = await connected({ args: [mockServer, "large-result"] });
  try {
    const exitResult = await exitManager.tools()[0]!.execute({ nested: { query: "x" } });
    assert.equal(exitResult.ok, false);
    assert.match(exitResult.output, /MCP tool .* failed|MCP server .* disconnected/i);

    await assert.rejects(malformedManager.connect("fixture", []));

    const controller = new AbortController();
    const pending = cancelManager.tools()[0]!.execute({ nested: { query: "x" } }, { signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, { ok: false, output: "MCP tool call cancelled." });

    const capped = await cappedManager.tools()[0]!.execute({ nested: { query: "x" } });
    assert.equal(capped.ok, true);
    assert.match(capped.output, /\[MCP output truncated at 65536 bytes\]$/);
  } finally {
    await Promise.all([exitManager.closeAll(), malformedManager.closeAll(), cancelManager.closeAll(), cappedManager.closeAll()]);
  }
});


test("M25 config and CLI/slash lifecycle remain explicit and process-local", async () => {
  const config = parseDragonsConfig({ mcpServers: [fixture()] });
  assert.deepEqual(parseCliCommand(["mcp", "list"]), { kind: "mcp", action: "list" });
  assert.deepEqual(parseCliCommand(["mcp", "connect", "fixture"]), { kind: "mcp", action: "connect", id: "fixture" });
  assert.deepEqual(parseCliCommand(["mcp", "status"]), { kind: "mcp", action: "status" });
  assert.deepEqual(parseCliCommand(["mcp", "disconnect", "fixture"]), { kind: "mcp", action: "disconnect", id: "fixture" });

  const listed: string[] = [];
  await main(["mcp", "list"], { config, write: (text) => listed.push(text) });
  assert.match(listed.join(""), /fixture/);
  assert.doesNotMatch(listed.join(""), new RegExp(mockServer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  let calls = 0;
  const output: string[] = [];
  await main([], {
    config,
    tools: [],
    input: Readable.from(["/mcp list\n", "/mcp connect fixture\n", "/mcp status\n", "/mcp disconnect fixture\n", "/exit\n"]),
    write: (text) => output.push(text),
    model: { async respond() { calls += 1; return { responseId: "unexpected", text: "unexpected", toolCalls: [] }; } },
  });
  assert.equal(calls, 0);
  assert.match(output.join(""), /Connected MCP server fixture \(1 tool\)/);
  assert.match(output.join(""), /fixture: connected \(1 tool\)/);
  assert.match(output.join(""), /Disconnected MCP server fixture/);
});

test("M25 MCP tools accept empty JSON-serializable object arguments and retain M10 authorization", async () => {
  const manager = await connected();
  try {
    const tool = manager.tools()[0]!;
    assert.deepEqual(await tool.execute({}), {
      ok: true,
      output: "[{\"type\":\"text\",\"text\":\"result:\"}]",
    });
    assert.deepEqual(await tool.execute({ nested: undefined }), { ok: false, output: "MCP tool arguments must be a JSON-serializable object." });

    let invoked = false;
    const model: AgentModel = {
      async respond(request) {
        if (!request.previousResponseId) return { responseId: "call", text: "", toolCalls: [{ callId: "mcp-call", name: tool.name, arguments: "{\"nested\":{\"query\":\"x\"}}" }] };
        invoked = true;
        assert.match(request.toolOutputs[0]?.output ?? "", /Authorization denied/);
        return { responseId: "done", text: "done", toolCalls: [] };
      },
    };
    await runAgent({ task: "x", model, tools: [tool] });
    assert.equal(invoked, true);
  } finally {
    await manager.closeAll();
  }
});

test("M25 caps total schemas and shutdown drops process-local MCP tools", async () => {
  const manager = new McpClientManager([fixture({ args: [mockServer, "two-schemas"] })], { maxTotalSchemaBytes: 200 });
  try {
    await assert.rejects(manager.connect("fixture", []), /schemas exceed/i);
  } finally {
    await manager.closeAll();
  }

  const connectedManager = await connected();
  assert.equal(connectedManager.tools().length, 1);
  await connectedManager.closeAll();
  assert.deepEqual(connectedManager.tools(), []);
  assert.equal(connectedManager.status()[0]?.state, "disconnected");
});

test("M25 does not restore MCP connections when a session resumes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-mcp-resume-workspace-"));
  const sessions = await mkdtemp(join(tmpdir(), "dragons-mcp-resume-sessions-"));
  try {
    const session = await createSessionStore(sessions).create({ workingDirectory: workspace, provider: "openai-api", model: "fixture" });
    const output: string[] = [];
    let calls = 0;
    await main(["session", "resume", session.id], {
      config: parseDragonsConfig({ mcpServers: [fixture()] }),
      sessionDirectory: sessions,
      input: Readable.from(["/mcp status\n", "/exit\n"]),
      tools: [],
      write: (text) => output.push(text),
      model: { async respond() { calls += 1; return { responseId: "unexpected", text: "unexpected", toolCalls: [] }; } },
    });
    assert.equal(calls, 0);
    assert.match(output.join(""), /fixture: disconnected \(0 tools\)/);
  } finally {
    await Promise.all([rm(workspace, { recursive: true, force: true }), rm(sessions, { recursive: true, force: true })]);
  }
});

test("M25 nested MCP schemas reach OpenAI and Codex provider adapters unchanged", async () => {
  const manager = await connected();
  const tool = manager.tools()[0]!;
  const openaiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    bodies.push(await new Request(input, init).json() as Record<string, unknown>);
    return new Response("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"response\"}}\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  try {
    await createOpenAIAgentModel().respond({ task: "x", tools: [tool], toolOutputs: [] });
    await createCodexAgentModel({
      credentials: { getValidCredentials: async () => ({ accessToken: "token", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z", tokenType: "Bearer" }) },
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"response\"}}\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    }).respond({ task: "x", tools: [tool], toolOutputs: [] });
    const expected = tool.inputSchema;
    assert.deepEqual((bodies[0]?.tools as Array<{ parameters: unknown }>)[0]?.parameters, expected);
    assert.deepEqual((bodies[1]?.tools as Array<{ parameters: unknown }>)[0]?.parameters, expected);
    assert.equal((bodies[0]?.tools as Array<{ name: string; strict: boolean }>)[0]?.name, tool.name);
    assert.equal((bodies[0]?.tools as Array<{ name: string; strict: boolean }>)[0]?.strict, false);
  } finally {
    await manager.closeAll();
    globalThis.fetch = originalFetch;
    if (openaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = openaiKey;
  }
});
