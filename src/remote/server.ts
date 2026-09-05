import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { DesktopBridge, type DesktopBridgeReply } from "../desktop/bridge.js";
import type { DragonsRuntime, RuntimeEvent } from "../runtime.js";

export type RemoteServerOptions = {
  /** Trusted host supplies cryptographically random, unique bearer tokens (>=32 characters). */
  principals: Array<{ id: string; token: string; sessionIds?: string[] }>;
  createRuntime: (principalId: string, connectionId: string) => Promise<DragonsRuntime>;
  /** Opt-in shared hosts may admit up to eight independently owned clients per principal. */
  maxConnectionsPerPrincipal?: number;
  port?: number;
  allowedOrigins?: string[];
};
export type RemoteServer = { url: string; close(): Promise<void> };

const BODY_LIMIT = 256 * 1024;
const EVENT_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT = 10_000;
const IDLE_TIMEOUT = 10_000;
const CLEANUP_TIMEOUT = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Principal = { id: string; digest: Buffer; sessions: Set<string>; pendingCreates: number; inFlight: number; tokens: number; last: number; connections: Map<string, Connection> };
type Connection = { id: string; principal: Principal; closed: boolean; sequence: number; bridge?: DesktopBridge; factory?: Promise<DragonsRuntime>; stream?: ServerResponse; idle?: NodeJS.Timeout; heartbeat?: NodeJS.Timeout; closing?: Promise<void> };
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super("Remote request rejected."); }
}
const errorReply = (code: string) => ({ ok: false, error: { code, message: "Remote request rejected." } });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

async function bounded(work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, CLEANUP_TIMEOUT); })]);
  if (timer) clearTimeout(timer);
}

/**
 * Loopback-only protocol: Bearer on EVERY request, exact Host and optional allowlisted Origin.
 * POST /connect {} => {ok:true,value:{connectionId}}. All subsequent requests require
 * x-dragons-connection. GET /events opens one SSE stream (data: <RuntimeEvent>\n\n).
 * POST /command {sequence,command}: sequence starts at 1, exact-next, consumed before await;
 * returns DesktopBridgeReply. Transport failures use the same error envelope + non-2xx status.
 * DELETE /connection => {ok:true,value:true}. Stream loss is also an explicit disconnect.
 * An unauthenticated OPTIONS exception exposes fixed preflight metadata only for exact
 * allowedOrigins. Operational endpoints always require Bearer authentication.
 * Limits: 32 principals/connections/factories, 64 sockets/requests, 8 requests per principal,
 * 8KiB/32 headers, 256KiB JSON, 64KiB SSE frames; backpressure closes rather than buffers.
 * Token buckets: principal burst120/refill2 per second, global burst240/refill4 per second.
 * Headers 5s, requests/no-stream idle 10s; SSE heartbeat 5s. Transport close waits at most
 * 1s for cleanup, but a principal stays reserved until its real factory/disposal settles.
 * No event replay: reconnect, open a new stream, resume an owned session, then send.
 */
export async function startRemoteServer(options: RemoteServerOptions): Promise<RemoteServer> {
  if (!options || !Array.isArray(options.principals) || options.principals.length < 1 || options.principals.length > 32
    || typeof options.createRuntime !== "function" || (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535))) {
    throw new Error("Invalid remote server configuration.");
  }
  const ids = new Set<string>();
  const perPrincipal = options.maxConnectionsPerPrincipal ?? 1;
  if (!Number.isSafeInteger(perPrincipal) || perPrincipal < 1 || perPrincipal > 8) throw new Error("Invalid remote connection limit.");
  const digests = new Set<string>();
  const principals: Principal[] = options.principals.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.id)
      || typeof entry.token !== "string" || !/^[\x21-\x7e]{32,512}$/.test(entry.token)
      || ids.has(entry.id) || (entry.sessionIds !== undefined && (!Array.isArray(entry.sessionIds)
        || entry.sessionIds.length > 128 || entry.sessionIds.some((id) => typeof id !== "string" || !UUID.test(id))))) {
      throw new Error("Invalid remote principal configuration.");
    }
    const digest = createHash("sha256").update(entry.token).digest();
    const key = digest.toString("hex");
    if (digests.has(key)) throw new Error("Duplicate remote principal credential.");
    digests.add(key); ids.add(entry.id);
    return { id: entry.id, digest, sessions: new Set(entry.sessionIds ?? []), pendingCreates: 0, inFlight: 0, tokens: 120, last: Date.now(), connections: new Map() };
  });
  if (options.allowedOrigins !== undefined && (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length > 32)) throw new Error("Invalid remote origins.");
  const origins = new Set(options.allowedOrigins ?? []);
  for (const origin of origins) {
    let valid = false;
    try { const url = new URL(origin); valid = ["http:", "https:"].includes(url.protocol) && url.origin === origin; } catch { /* Fail closed. */ }
    if (!valid) throw new Error("Invalid remote origin.");
  }
  const factory = options.createRuntime;
  const sockets = new Set<Socket>();
  const connections = new Set<Connection>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let host = "";
  let inFlight = 0;
  let creating = 0;
  let globalTokens = 240;
  let globalLast = Date.now();

  function disconnect(connection: Connection): Promise<void> {
    if (connection.closing) return bounded(connection.closing);
    connection.closed = true;
    clearTimeout(connection.idle);
    clearInterval(connection.heartbeat);
    connection.stream?.destroy();
    // Transport cleanup is bounded; ownership is NOT released until actual disposal.
    connection.closing = Promise.resolve().then(async () => {
      if (connection.bridge) await connection.bridge.close();
      else if (connection.factory) { const runtime = await connection.factory; await runtime.dispose(); }
    }).catch(() => {}).finally(() => {
      connections.delete(connection);
      connection.principal.connections.delete(connection.id);
    });
    return bounded(connection.closing);
  }
  function emit(connection: Connection, event: RuntimeEvent): void {
    if (connection.closed) return;
    const stream = connection.stream;
    if (!stream || stream.destroyed) { void disconnect(connection); return; }
    try {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      if (Buffer.byteLength(frame) > EVENT_LIMIT || !stream.write(frame)) void disconnect(connection);
    } catch { void disconnect(connection); }
  }
  function respond(response: ServerResponse, status: number, body: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > BODY_LIMIT) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify(errorReply("RUNTIME_ERROR"))); return; }
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
    response.end(encoded);
  }
  async function body(request: IncomingMessage): Promise<unknown> {
    if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"] !== undefined) throw new HttpFailure(400, "INVALID_MESSAGE");
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) throw new HttpFailure(413, "TOO_LARGE");
    const chunks: Buffer[] = [];
    let size = 0;
    // Event listeners, not an async iterator: early rejection must still send a bounded 413.
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted); };
      const failed = () => { cleanup(); reject(new HttpFailure(400, "INVALID_MESSAGE")); };
      const aborted = () => failed();
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_LIMIT) { cleanup(); request.pause(); reject(new HttpFailure(413, "TOO_LARGE")); }
        else chunks.push(chunk);
      };
      const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
      request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
    });
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown; }
    catch { throw new HttpFailure(400, "INVALID_MESSAGE"); }
  }

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: REQUEST_TIMEOUT, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 }, (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("connection", "close");
    const now = Date.now();
    globalTokens = Math.min(240, globalTokens + (now - globalLast) * 4 / 1000); globalLast = now;
    if (closing || inFlight >= 64 || globalTokens < 1) { respond(response, 503, errorReply("BUSY")); return; }
    globalTokens -= 1;
    inFlight += 1;
    let principal: Principal | undefined;
    let owned: Connection | undefined;
    const timer = setTimeout(() => { if (owned) void disconnect(owned); response.destroy(); request.destroy(); }, REQUEST_TIMEOUT);
    const dropped = () => { if (!response.writableFinished && owned) void disconnect(owned); };
    response.once("close", dropped);
    void (async () => {
      // Reject duplicate security headers rather than accepting Node's first/joined value.
      if (request.rawHeaders.length > 64) throw new HttpFailure(431, "INVALID_MESSAGE");
      const seen = new Set<string>();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const key = request.rawHeaders[i]!.toLowerCase();
        if (["authorization", "host", "origin", "x-dragons-connection"].includes(key)) {
          if (seen.has(key)) throw new HttpFailure(400, "INVALID_MESSAGE");
          seen.add(key);
        }
      }
      // Browser preflight carries no bearer. It exposes only fixed protocol metadata,
      // never runtime access, and is available solely to an exact trusted web origin.
      if (request.method === "OPTIONS" && ["/connect", "/command", "/events", "/connection"].includes(request.url ?? "")) {
        const origin = request.headers.origin;
        const method = request.headers["access-control-request-method"];
        const requested = request.headers["access-control-request-headers"];
        if (request.headers.host !== host || typeof origin !== "string" || !origins.has(origin)
          || typeof method !== "string" || !["GET", "POST", "DELETE"].includes(method)
          || (requested !== undefined && (typeof requested !== "string" || requested.split(",").some((header) => !["authorization", "content-type", "x-dragons-connection"].includes(header.trim().toLowerCase()))))) throw new HttpFailure(403, "FORBIDDEN");
        response.writeHead(204, { "access-control-allow-origin": origin, "vary": "Origin", "access-control-allow-methods": "GET, POST, DELETE", "access-control-allow-headers": "authorization, content-type, x-dragons-connection" });
        response.end(); return;
      }
      const authorization = request.headers.authorization;
      if (typeof authorization !== "string" || !/^Bearer [\x21-\x7e]{32,512}$/.test(authorization)) throw new HttpFailure(401, "UNAUTHORIZED");
      const candidate = createHash("sha256").update(authorization.slice(7)).digest();
      let authenticated: Principal | undefined;
      for (const entry of principals) if (timingSafeEqual(candidate, entry.digest)) authenticated = entry;
      if (!authenticated) throw new HttpFailure(401, "UNAUTHORIZED");
      if (request.headers.host !== host) throw new HttpFailure(403, "FORBIDDEN");
      const origin = request.headers.origin;
      if (origin !== undefined && (typeof origin !== "string" || !origins.has(origin))) throw new HttpFailure(403, "FORBIDDEN");
      if (origin !== undefined) { response.setHeader("access-control-allow-origin", origin); response.setHeader("vary", "Origin"); }
      authenticated.tokens = Math.min(120, authenticated.tokens + (now - authenticated.last) * 2 / 1000); authenticated.last = now;
      if (authenticated.tokens < 1 || authenticated.inFlight >= 8) throw new HttpFailure(429, "RATE_LIMITED");
      authenticated.tokens -= 1; authenticated.inFlight += 1; principal = authenticated;
      if (request.method === "POST" && request.url === "/connect") {
        // Reserve before body I/O and before factory invocation.
        if (principal.connections.size >= perPrincipal || connections.size >= 32 || creating >= 32) throw new HttpFailure(409, "CONFLICT");
        owned = { id: randomUUID(), principal, sequence: 0, closed: false };
        principal.connections.set(owned.id, owned); connections.add(owned);
        const connection = owned;
        const input = await body(request);
        if (!object(input) || Object.keys(input).length !== 0) throw new HttpFailure(400, "INVALID_MESSAGE");
        if (connection.closed || closing || response.destroyed) throw new HttpFailure(409, "CLOSED");
        creating += 1;
        let runtime: DragonsRuntime;
        connection.factory = Promise.resolve().then(() => factory(principal!.id, connection.id));
        try { runtime = await connection.factory; } finally { creating -= 1; }
        if (connection.closed || closing || response.destroyed) { await disconnect(connection); throw new HttpFailure(409, "CLOSED"); }
        connection.bridge = new DesktopBridge(runtime, (event) => emit(connection, event));
        connection.idle = setTimeout(() => { void disconnect(connection); }, IDLE_TIMEOUT);
        respond(response, 200, { ok: true, value: { connectionId: connection.id } });
        return;
      }
      const connectionId = request.headers["x-dragons-connection"];
      const connection = typeof connectionId === "string" ? principal.connections.get(connectionId) : undefined;
      if (!connection || connection.closed || !connection.bridge || request.headers["x-dragons-connection"] !== connection.id) throw new HttpFailure(403, "NOT_OWNED");
      owned = connection;
      if (request.method === "GET" && request.url === "/events") {
        if (connection.stream) throw new HttpFailure(409, "CONFLICT");
        if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) throw new HttpFailure(400, "INVALID_MESSAGE");
        clearTimeout(connection.idle);
        connection.stream = response;
        request.socket.setTimeout(0);
        response.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
        response.flushHeaders();
        connection.heartbeat = setInterval(() => {
          if (response.destroyed || !response.write(": heartbeat\n\n")) void disconnect(connection);
        }, 5_000);
        connection.heartbeat.unref();
        response.once("close", () => { void disconnect(connection); });
        return;
      }
      if (request.method === "DELETE" && request.url === "/connection") {
        await disconnect(connection);
        respond(response, 200, { ok: true, value: true }); return;
      }
      if (request.method !== "POST" || request.url !== "/command") throw new HttpFailure(404, "INVALID_MESSAGE");
      const input = await body(request);
      if (!object(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "sequence") || !Object.hasOwn(input, "command")
        || !Number.isSafeInteger(input.sequence) || (input.sequence as number) <= 0 || !object(input.command)) throw new HttpFailure(400, "INVALID_MESSAGE");
      if (connection.closed || closing || response.destroyed) throw new HttpFailure(409, "CLOSED");
      if (input.sequence !== connection.sequence + 1) throw new HttpFailure(409, "REPLAY");
      connection.sequence = input.sequence as number;
      const command = input.command;
      if (command.type === "send" && (!connection.stream || connection.stream.destroyed)) throw new HttpFailure(409, "STREAM_REQUIRED");
      if (command.type === "resume" && (typeof command.sessionId !== "string" || !principal.sessions.has(command.sessionId))) throw new HttpFailure(403, "NOT_OWNED");
      if (command.type === "create" && principal.sessions.size + principal.pendingCreates >= 128) throw new HttpFailure(409, "BUSY");
      if (command.type === "create") principal.pendingCreates++;
      let reply: DesktopBridgeReply;
      try { reply = await connection.bridge.request(command); }
      finally { if (command.type === "create") principal.pendingCreates--; }
      if (command.type === "create" && reply.ok && object(reply.value) && typeof reply.value.id === "string") principal.sessions.add(reply.value.id);
      respond(response, 200, reply);
    })().catch(async (error: unknown) => {
      if (request.url === "/connect" && owned) await disconnect(owned);
      const failure = error instanceof HttpFailure ? error : new HttpFailure(500, "RUNTIME_ERROR");
      respond(response, failure.status, errorReply(failure.code));
    }).finally(() => {
      clearTimeout(timer);
      inFlight -= 1;
      if (principal) principal.inFlight -= 1;
    });
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(15_000, (socket) => { socket.destroy(); });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Remote listener unavailable.");
  host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${host}`,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const stopped = new Promise<void>((resolve) => { server.close(() => resolve()); });
        await Promise.all([...connections].map(disconnect));
        for (const socket of sockets) socket.destroy();
        await bounded(stopped);
      })();
      return closePromise;
    },
  };
}
