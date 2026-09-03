import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";

import { McpServer, WebStandardStreamableHTTPServerTransport, fromJsonSchema } from "@modelcontextprotocol/server";

import { runAgent, type AgentModel } from "./agent.js";
import { McpClientManager, parseMcpServerConfig } from "./mcp-client.js";

type FixtureMode = "normal" | "large-result" | "oversized-response" | "oversized-chunked-response" | "secret-result" | "json-secret-result" | "wait" | "initialization-failure" | "redirect" | "stall-connect" | "sessionful";
const HTTP_M50_TEST_SECRET = "HTTP_M50_TEST_SECRET";
const JSON_M50_TEST_SECRET = "JSON_M50_TEST_SECRET";

type HttpFixture = {
  url: string;
  releaseWait(): void;
  waitForRequestStart(): Promise<void>;
  waitForRequestClose(): Promise<void>;
  waitForSessionTermination(): Promise<void>;
  close(): Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function toRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  return new Request(`http://127.0.0.1${request.url ?? "/"}`, {
    method: request.method,
    headers,
    ...(body && body.length > 0 ? { body: body.toString("utf8") } : {}),
  });
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    target.end();
    return;
  }
  for await (const chunk of response.body) target.write(Buffer.from(chunk));
  target.end();
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function settlesWithin(operation: Promise<void>, milliseconds: number, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createHttpFixture(mode: FixtureMode): Promise<HttpFixture> {
  let releaseWait = (): void => undefined;
  let requestStarted = (): void => undefined;
  let requestClosed = (): void => undefined;
  let sessionTerminated = (): void => undefined;
  const requestStartedPromise = new Promise<void>((resolve) => { requestStarted = resolve; });
  const requestClosedPromise = new Promise<void>((resolve) => { requestClosed = resolve; });
  const sessionTerminatedPromise = new Promise<void>((resolve) => { sessionTerminated = resolve; });
  const mcp = new McpServer({ name: "dragons-m50-http-fixture", version: "1.0.0" });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: mode === "sessionful" ? () => "m50-http-session" : undefined,
    enableJsonResponse: mode !== "sessionful",
  });
  mcp.registerTool(
    "inspect",
    {
      description: "Inspect a nested value through the official MCP Streamable HTTP server.",
      inputSchema: fromJsonSchema<{ nested: { query: string } }>({
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
        required: ["nested"],
        additionalProperties: false,
      }),
    },
    async ({ nested }) => {
      if (mode === "wait") {
        await new Promise<void>((resolve) => { releaseWait = resolve; });
      }
      const text = mode === "large-result" ? "x".repeat(1_000)
        : mode === "secret-result" ? `remote Authorization: Bearer ${HTTP_M50_TEST_SECRET}`
          : mode === "json-secret-result" ? `{"api_key":"${JSON_M50_TEST_SECRET}","password":"${JSON_M50_TEST_SECRET}"}`
          : `http-result:${nested.query}`;
      return { content: [{ type: "text" as const, text }] };
    },
  );
  await mcp.connect(transport);

  const nodeServer = createServer(async (request, response) => {
    try {
      if (mode === "stall-connect") {
        requestStarted();
        response.once("close", requestClosed);
        return;
      }
      if (mode === "sessionful" && request.method === "DELETE" && request.headers["mcp-session-id"] === "m50-http-session") {
        sessionTerminated();
      }
      if (mode === "initialization-failure") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "server-secret-marker" }));
        return;
      }
      if (mode === "redirect") {
        response.writeHead(302, { location: "/mcp" });
        response.end();
        return;
      }
      if (mode === "oversized-response") {
        const body = "x".repeat(1_048_577);
        response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body, "utf8")) });
        response.end(body);
        return;
      }
      if (mode === "oversized-chunked-response") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("x".repeat(1_048_577));
        response.end();
        return;
      }
      await writeResponse(await transport.handleRequest(await toRequest(request)), response);
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture failure" }));
    }
  });
  const port = await listen(nodeServer);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    releaseWait,
    waitForRequestStart: () => requestStartedPromise,
    waitForRequestClose: () => requestClosedPromise,
    waitForSessionTermination: () => sessionTerminatedPromise,
    async close() {
      releaseWait();
      await Promise.allSettled([transport.close(), mcp.close()]);
      await new Promise<void>((resolve, reject) => nodeServer.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function scriptedModel(toolName: string, expectedToolOutput = /http-result:approved/, finalText = "HTTP tool result observed."): AgentModel {
  let turns = 0;
  return {
    async respond(request) {
      turns += 1;
      if (turns === 1) {
        return {
          responseId: "m50-call",
          text: "",
          toolCalls: [{ callId: "m50-tool-call", name: toolName, arguments: "{\"nested\":{\"query\":\"approved\"}}" }],
        };
      }
      assert.match(request.toolOutputs[0]?.output ?? "", expectedToolOutput);
      return { responseId: "m50-complete", text: finalText, toolCalls: [] };
    },
  };
}

test("M50 validates explicit Streamable HTTP configuration without changing legacy stdio configuration", () => {
  assert.deepEqual(parseMcpServerConfig({ id: "legacy", command: "node", args: [] }), {
    id: "legacy",
    command: "node",
    args: [],
  });
  assert.deepEqual(parseMcpServerConfig({ id: "explicit-stdio", transport: "stdio", command: "node", args: [] }), {
    id: "explicit-stdio",
    transport: "stdio",
    command: "node",
    args: [],
  });
  assert.throws(() => parseMcpServerConfig({ id: "remote", transport: "http", url: "not a URL" }), /URL/i);
  assert.throws(() => parseMcpServerConfig({ id: "remote", transport: "http", url: "https://user:password@example.test/mcp" }), /credentials/i);
  assert.throws(() => parseMcpServerConfig({ id: "remote", transport: "http", url: "https://example.test/mcp?token=secret" }), /query parameters/i);
  assert.throws(() => parseMcpServerConfig({ id: "remote", transport: "http", url: "https://example.test/mcp?mode=readonly" }), /query parameters/i);
  assert.throws(() => parseMcpServerConfig({ id: "remote", transport: "http", url: `https://example.test/mcp?foo=sk-${"test".repeat(8)}` }), /query parameters/i);
  assert.throws(() => parseMcpServerConfig({ id: "remote", transport: "http", url: `https://example.test/mcp?foo=Bearer%20${"test".repeat(8)}` }), /query parameters/i);
  assert.throws(() => parseMcpServerConfig({ id: "remote", transport: "http", url: `https://example.test/mcp?foo=token%3D${"test".repeat(8)}` }), /query parameters/i);
  assert.throws(() => parseMcpServerConfig({ id: "remote", url: "https://example.test/mcp" }), /transport/i);
});

test("M50 discovers, authorizes, invokes, bounds, cancels, and closes an official Streamable HTTP MCP server", { timeout: 15_000 }, async () => {
  const fixture = await createHttpFixture("normal");
  const manager = new McpClientManager([{ id: "http", transport: "http", url: fixture.url }], { toolTimeoutMilliseconds: 500 });
  try {
    const [tool] = await manager.connect("http", []);
    assert.equal(tool?.name, "mcp__http__inspect");
    assert.equal(tool?.operation, "EXECUTE");
    assert.deepEqual(await tool!.execute({ nested: { query: "direct" } }), {
      ok: true,
      output: "[{\"type\":\"text\",\"text\":\"http-result:direct\"}]",
    });
    const status = manager.status()[0];
    assert.equal(status?.transport, "http");
    assert.equal(status?.state, "connected");
    assert.equal(typeof status?.connectDurationMilliseconds, "number");
    assert.equal(typeof status?.discoveryDurationMilliseconds, "number");
    assert.equal(typeof status?.lastInvocationDurationMilliseconds, "number");

    const denied = await runAgent({ task: "deny", model: scriptedModel(tool!.name, /Authorization denied for mcp__http__inspect/, "Denied safely."), tools: [tool!] });
    assert.equal(denied.finalText, "Denied safely.");
    const allowed = await runAgent({
      task: "allow",
      model: scriptedModel(tool!.name),
      tools: [tool!],
      authorize: (request) => request.operation === "EXECUTE",
    });
    assert.equal(allowed.finalText, "HTTP tool result observed.");
  } finally {
    await manager.closeAll();
    await fixture.close();
  }

  const cappedFixture = await createHttpFixture("large-result");
  const capped = new McpClientManager([{ id: "capped", transport: "http", url: cappedFixture.url }], { maxOutputBytes: 180 });
  try {
    const [tool] = await capped.connect("capped", []);
    const result = await tool!.execute({ nested: { query: "large" } });
    assert.equal(result.ok, true);
    assert.match(result.output, /\[MCP output truncated at 180 bytes\]$/);
  } finally {
    await capped.closeAll();
    await cappedFixture.close();
  }

  const secretFixture = await createHttpFixture("secret-result");
  const secretManager = new McpClientManager([{ id: "secret", transport: "http", url: secretFixture.url }]);
  try {
    const [tool] = await secretManager.connect("secret", []);
    const result = await tool!.execute({ nested: { query: "secret" } });
    assert.doesNotMatch(result.output, /HTTP_M50_TEST_SECRET/);
    assert.match(result.output, /\[REDACTED\]/);
  } finally {
    await secretManager.closeAll();
    await secretFixture.close();
  }

  const jsonSecretFixture = await createHttpFixture("json-secret-result");
  const jsonSecretManager = new McpClientManager([{ id: "json-secret", transport: "http", url: jsonSecretFixture.url }]);
  try {
    const [tool] = await jsonSecretManager.connect("json-secret", []);
    const result = await tool!.execute({ nested: { query: "json-secret" } });
    assert.doesNotMatch(result.output, /JSON_M50_TEST_SECRET/);
    assert.match(result.output, /\[REDACTED\]/);
  } finally {
    await jsonSecretManager.closeAll();
    await jsonSecretFixture.close();
  }

  const waitingFixture = await createHttpFixture("wait");
  const waiting = new McpClientManager([{ id: "waiting", transport: "http", url: waitingFixture.url }], { toolTimeoutMilliseconds: 50 });
  try {
    const [tool] = await waiting.connect("waiting", []);
    assert.deepEqual(await tool!.execute({ nested: { query: "timeout" } }), {
      ok: false,
      output: "MCP tool call timed out after 50ms.",
    });
    assert.equal(waiting.status()[0]?.state, "disconnected");
  } finally {
    await waiting.closeAll();
    await waitingFixture.close();
  }

  const cancellationFixture = await createHttpFixture("wait");
  const cancellation = new McpClientManager([{ id: "cancel", transport: "http", url: cancellationFixture.url }], { toolTimeoutMilliseconds: 5_000 });
  try {
    const [tool] = await cancellation.connect("cancel", []);
    const controller = new AbortController();
    const pending = tool!.execute({ nested: { query: "cancel" } }, { signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, { ok: false, output: "MCP tool call cancelled." });
    assert.equal(cancellation.status()[0]?.state, "disconnected");
  } finally {
    await cancellation.closeAll();
    await cancellationFixture.close();
  }
});

test("M50 terminates a sessionful HTTP MCP session on explicit disconnect", { timeout: 10_000 }, async () => {
  const fixture = await createHttpFixture("sessionful");
  const manager = new McpClientManager([{ id: "sessionful", transport: "http", url: fixture.url }]);
  try {
    await manager.connect("sessionful", []);
    await manager.disconnect("sessionful");
    await settlesWithin(fixture.waitForSessionTermination(), 500, "Expected the HTTP MCP session to be terminated.");
    assert.equal(manager.status()[0]?.state, "disconnected");
  } finally {
    await manager.closeAll();
    await fixture.close();
  }
});

test("M50 rejects unreachable, initialization-failed, redirecting, and oversized HTTP endpoints without leaking server content", { timeout: 10_000 }, async () => {
  const unreachable = new McpClientManager([{ id: "unreachable", transport: "http", url: "http://127.0.0.1:1/mcp" }], { connectTimeoutMilliseconds: 100 });
  await assert.rejects(unreachable.connect("unreachable"));
  assert.equal(unreachable.status()[0]?.lastError, "MCP connection or discovery failed.");
  assert.equal(unreachable.status()[0]?.lastFailureCategory, "connection");
  await unreachable.closeAll();

  const failedFixture = await createHttpFixture("initialization-failure");
  const failed = new McpClientManager([{ id: "failed", transport: "http", url: failedFixture.url }]);
  try {
    await assert.rejects(failed.connect("failed"));
    assert.equal(JSON.stringify(failed.status()).includes("server-secret-marker"), false);
  } finally {
    await failed.closeAll();
    await failedFixture.close();
  }

  const redirectFixture = await createHttpFixture("redirect");
  const redirect = new McpClientManager([{ id: "redirect", transport: "http", url: redirectFixture.url }]);
  try {
    await assert.rejects(redirect.connect("redirect"));
    assert.equal(redirect.status()[0]?.state, "disconnected");
  } finally {
    await redirect.closeAll();
    await redirectFixture.close();
  }

  const oversizedFixture = await createHttpFixture("oversized-response");
  const oversized = new McpClientManager([{ id: "oversized", transport: "http", url: oversizedFixture.url }]);
  try {
    await assert.rejects(oversized.connect("oversized"), /MCP HTTP response exceeds the 1048576-byte limit/);
    assert.equal(oversized.status()[0]?.state, "disconnected");
  } finally {
    await oversized.closeAll();
    await oversizedFixture.close();
  }

  const oversizedChunkedFixture = await createHttpFixture("oversized-chunked-response");
  const oversizedChunked = new McpClientManager([{ id: "oversizedchunked", transport: "http", url: oversizedChunkedFixture.url }]);
  try {
    await assert.rejects(oversizedChunked.connect("oversizedchunked"), /MCP HTTP response exceeds the 1048576-byte limit/);
    assert.equal(oversizedChunked.status()[0]?.state, "disconnected");
  } finally {
    await oversizedChunked.closeAll();
    await oversizedChunkedFixture.close();
  }
});

test("M50 aborts an in-flight HTTP connection request after a connection timeout", { timeout: 10_000 }, async () => {
  const fixture = await createHttpFixture("stall-connect");
  const manager = new McpClientManager([{ id: "stall", transport: "http", url: fixture.url }], { connectTimeoutMilliseconds: 100 });
  try {
    const pending = manager.connect("stall", []);
    await fixture.waitForRequestStart();
    await assert.rejects(pending, /connection timed out/i);
    await fixture.waitForRequestClose();
    const status = manager.status()[0];
    assert.equal(status?.state, "disconnected");
    assert.equal(status?.lastFailureCategory, "timeout");
  } finally {
    await manager.closeAll();
    await fixture.close();
  }
});
