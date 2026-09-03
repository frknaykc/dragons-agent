import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";

import { McpServer, WebStandardStreamableHTTPServerTransport, fromJsonSchema } from "@modelcontextprotocol/server";

import {
  McpClientManager,
  parseMcpServerConfig,
  type McpBearerTokenStore,
  type McpCredentialScope,
} from "./mcp-client.js";
import { createNativeMcpBearerTokenStore, type NativeMcpCredentialEntry } from "./mcp-credential-store.js";
import { parseDragonsConfig } from "./config.js";
import { main } from "./cli.js";

const AUTH_TOKEN = ["m51", "fixture", "token"].join("-");
const REFLECTED_TOKEN = "!m51-reflected-opaque";

type AuthFixture = {
  url: string;
  authorizations(): readonly string[];
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
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
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
  if (response.body) for await (const chunk of response.body) target.write(Buffer.from(chunk));
  target.end();
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function createAuthenticatedFixture(requiredToken = AUTH_TOKEN, toolError?: string): Promise<AuthFixture> {
  const authorizations: string[] = [];
  const mcp = new McpServer({ name: "dragons-m51-auth-fixture", version: "1.0.0" });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  mcp.registerTool(
    "inspect",
    { inputSchema: fromJsonSchema<{ value: string }>({ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }) },
    async ({ value }) => toolError
      ? { isError: true, content: [{ type: "text" as const, text: toolError }] }
      : { content: [{ type: "text" as const, text: `authenticated:${value}` }] },
  );
  await mcp.connect(transport);
  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization;
    if (typeof authorization === "string") authorizations.push(authorization);
    if (authorization !== `Bearer ${requiredToken}`) {
      response.writeHead(401, { "www-authenticate": "Bearer", "content-type": "application/json" });
      response.end(JSON.stringify({ error: `rejected:${authorization ?? "missing"}` }));
      return;
    }
    await writeResponse(await transport.handleRequest(await toRequest(request)), response);
  });
  const origin = await listen(server);
  return {
    url: `${origin}/mcp`,
    authorizations: () => [...authorizations],
    close: () => closeServer(server),
  };
}

async function createReflectedHttpFailureFixture(reflectedText: string, status = 500, headers: Record<string, string> = {}): Promise<AuthFixture> {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    if (typeof request.headers.authorization === "string") authorizations.push(request.headers.authorization);
    response.writeHead(status, { "content-type": "text/plain", ...headers });
    response.end(reflectedText);
  });
  const origin = await listen(server);
  return { url: `${origin}/mcp`, authorizations: () => [...authorizations], close: () => closeServer(server) };
}

function scopedStore(resolveToken: (scope: McpCredentialScope) => string | undefined): Pick<McpBearerTokenStore, "load"> {
  return { load: async (scope) => resolveToken(scope) };
}

test("M51 authenticates HTTP MCP with a scoped native-store bearer provider without placing tokens in config", async () => {
  const fixture = await createAuthenticatedFixture();
  assert.match(JSON.stringify(parseDragonsConfig({ mcpServers: [{ id: "authenticated", transport: "http", url: fixture.url, auth: { type: "bearer", credentialId: "fixture" } }] })), /"credentialId":"fixture"/);
  const statusOutput: string[] = [];
  await main(["mcp", "status"], {
    mcpManager: new McpClientManager([{ id: "authenticated", transport: "http", url: fixture.url, auth: { type: "bearer", credentialId: "fixture" } }], { credentialStore: scopedStore(() => AUTH_TOKEN) }),
    write: (text) => statusOutput.push(text),
  });
  assert.match(statusOutput.join(""), /auth bearer/);
  assert.doesNotMatch(statusOutput.join(""), new RegExp(AUTH_TOKEN));
  const scopes: McpCredentialScope[] = [];
  const manager = new McpClientManager([
    { id: "authenticated", transport: "http", url: fixture.url, auth: { type: "bearer", credentialId: "fixture" } },
  ], {
    credentialStore: scopedStore((scope) => {
      scopes.push(structuredClone(scope));
      return scope.serverId === "authenticated" && scope.credentialId === "fixture" ? AUTH_TOKEN : undefined;
    }),
  });
  try {
    const [tool] = await manager.connect("authenticated", []);
    assert.deepEqual(await tool!.execute({ value: "ok" }), { ok: true, output: "[{\"type\":\"text\",\"text\":\"authenticated:ok\"}]" });
    assert.ok(scopes.length >= 2);
    assert.deepEqual(scopes[0], { serverId: "authenticated", origin: new URL(fixture.url).origin, credentialId: "fixture" });
    assert.ok(fixture.authorizations().every((value) => value === `Bearer ${AUTH_TOKEN}`));
    assert.doesNotMatch(JSON.stringify({ config: manager.list(), status: manager.status() }), new RegExp(AUTH_TOKEN));
  } finally {
    await manager.closeAll();
    await fixture.close();
  }
});

test("M51 never forwards an opaque bearer token reflected by an authenticated HTTP server", async () => {
  const connectionFailure = await createReflectedHttpFailureFixture(REFLECTED_TOKEN);
  const connection = new McpClientManager([
    { id: "connection-reflection", transport: "http", url: connectionFailure.url, auth: { type: "bearer" } },
  ], { credentialStore: scopedStore(() => REFLECTED_TOKEN) });
  try {
    await assert.rejects(connection.connect("connection-reflection", []), (error: Error) => {
      assert.equal(error.message, "MCP connection or discovery failed.");
      assert.doesNotMatch(error.message, new RegExp(REFLECTED_TOKEN));
      return true;
    });
    assert.doesNotMatch(JSON.stringify(connection.status()), new RegExp(REFLECTED_TOKEN));
  } finally {
    await connection.closeAll();
    await connectionFailure.close();
  }

  const insufficientScope = await createReflectedHttpFailureFixture(REFLECTED_TOKEN, 403, { "www-authenticate": `Bearer scope="${REFLECTED_TOKEN}"` });
  const insufficient = new McpClientManager([
    { id: "insufficient-scope", transport: "http", url: insufficientScope.url, auth: { type: "bearer" } },
  ], { credentialStore: scopedStore(() => REFLECTED_TOKEN) });
  try {
    await assert.rejects(insufficient.connect("insufficient-scope", []), /authentication required or rejected/i);
    assert.equal(insufficient.status()[0]?.lastFailureCategory, "authentication");
    assert.doesNotMatch(JSON.stringify(insufficient.status()), new RegExp(REFLECTED_TOKEN));
  } finally {
    await insufficient.closeAll();
    await insufficientScope.close();
  }

  const toolFailure = await createAuthenticatedFixture(REFLECTED_TOKEN, REFLECTED_TOKEN);
  const manager = new McpClientManager([
    { id: "tool-reflection", transport: "http", url: toolFailure.url, auth: { type: "bearer" } },
  ], { credentialStore: scopedStore(() => REFLECTED_TOKEN) });
  try {
    const [tool] = await manager.connect("tool-reflection", []);
    const result = await tool!.execute({ value: "ignored" });
    assert.deepEqual(result, { ok: false, output: "MCP tool reported failure." });
    assert.doesNotMatch(JSON.stringify({ result, status: manager.status() }), new RegExp(REFLECTED_TOKEN));
  } finally {
    await manager.closeAll();
    await toolFailure.close();
  }
});

test("M51 rejects plaintext credentials in config and isolates missing or invalid bearer credentials without disclosure", async () => {
  assert.throws(
    () => parseMcpServerConfig({ id: "remote", transport: "http", url: "https://example.test/mcp", auth: { type: "bearer", token: AUTH_TOKEN } }),
    /unknown MCP auth config key/i,
  );
  assert.throws(
    () => parseMcpServerConfig({ id: "remote", transport: "http", url: "http://example.test/mcp", auth: { type: "bearer" } }),
    /HTTPS or loopback HTTP/i,
  );
  assert.throws(
    () => parseMcpServerConfig({ id: "remote", transport: "http", url: "https://example.test/mcp", headers: { authorization: `Bearer ${AUTH_TOKEN}` } }),
    /unknown MCP server config key/i,
  );
  assert.throws(
    () => parseMcpServerConfig({ id: "remote", transport: "http", url: "https://example.test/mcp", token: AUTH_TOKEN }),
    /unknown MCP server config key/i,
  );
  assert.throws(
    () => parseMcpServerConfig({ id: "stdio", command: "node", auth: { type: "bearer" } }),
    /HTTP auth/i,
  );

  const fixture = await createAuthenticatedFixture();
  const manager = new McpClientManager([
    { id: "missing", transport: "http", url: fixture.url, auth: { type: "bearer" } },
  ], { credentialStore: scopedStore(() => undefined) });
  try {
    await assert.rejects(manager.connect("missing", []), /authentication required or rejected/i);
    const safe = JSON.stringify(manager.status());
    assert.doesNotMatch(safe, /rejected:|Bearer m51-fixture-token/i);
    assert.equal(manager.status()[0]?.lastFailureCategory, "authentication");
  } finally {
    await manager.closeAll();
    await fixture.close();
  }

  const invalidFixture = await createAuthenticatedFixture();
  const invalid = new McpClientManager([
    { id: "invalid", transport: "http", url: invalidFixture.url, auth: { type: "bearer" } },
  ], { credentialStore: scopedStore(() => "wrong-token") });
  try {
    await assert.rejects(invalid.connect("invalid", []), /authentication required or rejected/i);
    assert.ok(invalidFixture.authorizations().every((value) => value === "Bearer wrong-token"));
    assert.doesNotMatch(JSON.stringify(invalid.status()), /wrong-token|rejected:/i);
  } finally {
    await invalid.closeAll();
    await invalidFixture.close();
  }
});

test("M51 scopes stored bearer tokens to the configured server and origin", async () => {
  const first = await createAuthenticatedFixture();
  const second = await createAuthenticatedFixture();
  const seen: McpCredentialScope[] = [];
  const manager = new McpClientManager([
    { id: "first", transport: "http", url: first.url, auth: { type: "bearer", credentialId: "shared" } },
    { id: "second", transport: "http", url: second.url, auth: { type: "bearer", credentialId: "shared" } },
  ], {
    credentialStore: scopedStore((scope) => {
      seen.push(structuredClone(scope));
      return scope.serverId === "first" && scope.origin === new URL(first.url).origin ? AUTH_TOKEN : undefined;
    }),
  });
  try {
    await manager.connect("first", []);
    await assert.rejects(manager.connect("second", []), /authentication required or rejected/i);
    assert.ok(seen.some((scope) => scope.serverId === "first" && scope.origin === new URL(first.url).origin));
    assert.ok(seen.some((scope) => scope.serverId === "second" && scope.origin === new URL(second.url).origin));
    assert.deepEqual(second.authorizations(), []);
  } finally {
    await manager.closeAll();
    await Promise.all([first.close(), second.close()]);
  }
});

test("M51 rejects authenticated HTTP redirects before a bearer token can reach another origin", async () => {
  const targetAuthorizations: string[] = [];
  const target = createServer((request, response) => {
    if (typeof request.headers.authorization === "string") targetAuthorizations.push(request.headers.authorization);
    response.writeHead(500);
    response.end();
  });
  const targetOrigin = await listen(target);
  const redirectAuthorizations: string[] = [];
  const redirect = createServer((request, response) => {
    if (typeof request.headers.authorization === "string") redirectAuthorizations.push(request.headers.authorization);
    response.writeHead(302, { location: `${targetOrigin}/mcp` });
    response.end();
  });
  const redirectOrigin = await listen(redirect);
  const manager = new McpClientManager([
    { id: "redirect", transport: "http", url: `${redirectOrigin}/mcp`, auth: { type: "bearer" } },
  ], { credentialStore: scopedStore(() => AUTH_TOKEN) });
  try {
    await assert.rejects(manager.connect("redirect", []));
    assert.ok(redirectAuthorizations.every((value) => value === `Bearer ${AUTH_TOKEN}`));
    assert.deepEqual(targetAuthorizations, []);
  } finally {
    await manager.closeAll();
    await Promise.all([closeServer(redirect), closeServer(target)]);
  }
});

test("M51 native MCP credential storage verifies server/origin scope before returning a token", async () => {
  let payload: string | undefined;
  const entry: NativeMcpCredentialEntry = {
    getPassword: async () => payload,
    setPassword: async (next) => { payload = next; },
    deletePassword: async () => { payload = undefined; return true; },
  };
  const store = createNativeMcpBearerTokenStore({ entry, platform: "darwin" });
  const scope = { serverId: "remote", origin: "https://example.test", credentialId: "fixture" };
  await store.save(scope, AUTH_TOKEN);
  assert.equal(await store.load(scope), AUTH_TOKEN);
  assert.equal(await store.load({ ...scope, origin: "https://other.test" }), undefined);
  assert.equal(await store.storageDescription(), "macOS Keychain");
  assert.ok(payload);
});
