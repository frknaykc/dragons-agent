import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentModel } from "./agent.js";
import type { DesktopCommand, DesktopBridgeReply } from "./desktop/bridge.js";
import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime, type DragonsRuntime, type RuntimeEvent, type RuntimeSession } from "./runtime.js";
import { startRemoteServer, type RemoteServerOptions } from "./remote/server.js";
import { createSessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function value<T>(reply: DesktopBridgeReply): T {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  if (!reply.ok) throw new Error("Expected successful reply");
  return reply.value as T;
}
async function fixture(t: TestContext, options: { model?: () => AgentModel; tools?: AgentTool[]; wrap?: (runtime: DragonsRuntime) => DragonsRuntime; factoryGate?: () => Promise<void>; origins?: string[] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-remote-")));
  const registry = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: options.model ?? (() => ({ async respond(_request, delta) { delta?.("Remote answer."); return { responseId: "done", text: "Remote answer.", textWasStreamed: true, toolCalls: [] }; } })),
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: registry.ids() });
  const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  let disposals = 0;
  let creations = 0;
  const server = await startRemoteServer({ principals: tokens.map((token, i) => ({ id: `p${i}`, token })), allowedOrigins: options.origins,
    async createRuntime() {
      creations += 1;
      const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: registry, sessionStore: store,
        memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"), tools: options.tools ?? [] });
      await options.factoryGate?.();
      const wrapped = options.wrap?.(runtime) ?? runtime;
      return { ...wrapped, dispose() { disposals += 1; return wrapped.dispose(); } };
    },
  });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (path: string, method = "POST", input: unknown = {}, principal = 0, connectionId?: string, extra: Record<string, string> = {}) => {
    const response = await fetch(server.url + path, { method, headers: { authorization: `Bearer ${tokens[principal]}`, "content-type": "application/json", ...(connectionId ? { "x-dragons-connection": connectionId } : {}), ...extra }, ...(method === "POST" ? { body: typeof input === "string" ? input : JSON.stringify(input) } : {}) });
    return { status: response.status, reply: await response.json() as DesktopBridgeReply };
  };
  const connect = async (principal = 0) => value<{ connectionId: string }>((await call("/connect", "POST", {}, principal)).reply).connectionId;
  const peer = (id: string, principal = 0) => {
    let sequence = 0;
    return { id, command: (command: DesktopCommand) => call("/command", "POST", { sequence: ++sequence, command }, principal, id),
      async events() {
        const abort = new AbortController();
        const response = await fetch(server.url + "/events", { headers: { authorization: `Bearer ${tokens[principal]}`, "x-dragons-connection": id }, signal: abort.signal });
        assert.equal(response.status, 200);
        const events: RuntimeEvent[] = [];
        const listeners = new Set<() => void>();
        const reader = response.body!.getReader();
        const consumed = (async () => {
          let pending = "";
          const decoder = new TextDecoder();
          while (true) {
            const part = await reader.read(); if (part.done) return;
            pending += decoder.decode(part.value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, end); pending = pending.slice(end + 2);
              if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as RuntimeEvent);
              for (const listener of listeners) listener();
            }
          }
        })().catch(() => {});
        t.after(async () => { abort.abort(); await consumed; });
        return { events, abort: () => abort.abort(), consumed,
          wait<T extends RuntimeEvent["type"]>(type: T): Promise<Extract<RuntimeEvent, { type: T }>> {
            return new Promise((resolve) => { const check = () => { const event = events.find((entry) => entry.type === type); if (event) { listeners.delete(check); resolve(event as Extract<RuntimeEvent, { type: T }>); } }; listeners.add(check); check(); });
          },
        };
      },
    };
  };
  return { root, server, tokens, store, call, connect, peer, disposals: () => disposals, creations: () => creations };
}

for (const decision of ["allow_once", "deny"] as const) {
  test(`M74 real HTTP/SSE WRITE ${decision}, ownership and final result`, { timeout: 10_000 }, async (t) => {
    let executions = 0;
    let outputPath = "";
    const tool: AgentTool = { name: "write_fixture", description: "Temp fixture write", operation: "WRITE", inputSchema: { type: "object" },
      async execute() { executions += 1; await writeFile(outputPath, "written"); return { ok: true, output: "written" }; } };
    const f = await fixture(t, { tools: [tool], model: () => { let turn = 0; return { async respond() { return ++turn === 1
      ? { responseId: "write", text: "", toolCalls: [{ callId: "write-1", name: tool.name, arguments: "{}" }] }
      : { responseId: "done", text: "Decision completed.", toolCalls: [] }; } }; } });
    outputPath = join(f.root, "result.txt");
    const a = f.peer(await f.connect()); const b = f.peer(await f.connect(1), 1);
    const session = value<RuntimeSession>((await a.command({ type: "create" })).reply);
    const foreign = value<RuntimeSession>((await b.command({ type: "create" })).reply);
    assert.equal((await b.command({ type: "resume", sessionId: session.id })).status, 403);
    const stream = await a.events();
    const run = value<{ runId: string }>((await a.command({ type: "send", content: "Write fixture" })).reply);
    const pending = await stream.wait("approval_requested");
    assert.equal(executions, 0);
    const command = { type: "approve", sessionId: session.id, runId: run.runId, approvalId: pending.approvalId, decision } as const;
    assert.equal((await b.command({ ...command, sessionId: foreign.id })).reply.ok, false);
    assert.equal((await a.command({ ...command, decision: "allow_session" } as unknown as DesktopCommand)).reply.ok, false);
    assert.equal(value((await a.command(command)).reply), true);
    assert.equal((await a.command(command)).reply.ok, false);
    assert.equal((await stream.wait("run_completed")).result.finalText, "Decision completed.");
    assert.equal(executions, decision === "allow_once" ? 1 : 0);
    if (decision === "allow_once") assert.equal(await readFile(outputPath, "utf8"), "written");
    assert.ok(stream.events.some((event) => event.type === "tool_activity" && event.phase === "authorization_completed" && event.allowed === (decision === "allow_once")));
    assert.ok(stream.events.every((event) => event.sessionId === session.id));
  });
}

test("M74 cancel, stream abort disposes, reconnect resumes only saved owned session", { timeout: 10_000 }, async (t) => {
  const started = deferred<AbortSignal>();
  const f = await fixture(t, { model: () => ({ async respond(request) {
    started.resolve(request.signal!);
    await new Promise<void>((resolve) => { if (request.signal!.aborted) resolve(); else request.signal!.addEventListener("abort", () => resolve(), { once: true }); });
    throw new Error("fixture-private-error");
  } }) });
  const a = f.peer(await f.connect());
  const session = value<RuntimeSession>((await a.command({ type: "create" })).reply);
  const stream = await a.events();
  assert.equal((await f.call("/events", "GET", {}, 0, a.id)).status, 409);
  const run = value<{ runId: string }>((await a.command({ type: "send", content: "Wait" })).reply);
  const signal = await started.promise;
  assert.equal(value((await a.command({ type: "cancel", runId: run.runId })).reply), true);
  await stream.wait("run_cancelled"); assert.equal(signal.aborted, true);
  stream.abort(); await stream.consumed;
  // Explicit disconnect is the synchronization barrier for reconnect after transport abort.
  await f.call("/connection", "DELETE", {}, 0, a.id);
  const b = f.peer(await f.connect());
  assert.equal(value<RuntimeSession>((await b.command({ type: "resume", sessionId: session.id })).reply).id, session.id);
  assert.equal(f.disposals(), 1);
  assert.doesNotMatch(JSON.stringify(stream.events), /fixture-private-error/);
  await f.server.close(); await f.server.close(); assert.equal(f.disposals(), 2);
});

test("M74 authentication, Host/Origin, strict envelope, size, sequencing and stream admission", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  for (const path of ["/connect", "/events", "/command", "/connection", "/missing", "/connect?token=ignored"]) {
    const response = await fetch(f.server.url + path, { method: "POST", body: "{}", headers: { cookie: `token=${f.tokens[0]}`, "content-type": "application/json" } });
    assert.equal(response.status, 401); await response.body?.cancel();
  }
  assert.equal((await f.call("/connect", "POST", {}, 0, undefined, { origin: "https://untrusted.invalid" })).status, 403);
  const badHost = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(f.server.url + "/connect", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${f.tokens[0]}`, "content-type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode!); });
    request.on("error", reject); request.end("{}");
  });
  assert.equal(badHost, 403);
  assert.equal((await f.call("/connect", "POST", { extra: true })).status, 400);
  assert.equal((await f.call("/connect", "POST", "{")).status, 400);
  assert.equal((await f.call("/connect", "POST", "x".repeat(256 * 1024 + 1))).status, 413);
  const a = f.peer(await f.connect());
  assert.equal((await f.call("/connect")).status, 409);
  assert.equal((await f.call("/command", "POST", { sequence: 1, command: { type: "status" }, extra: true }, 0, a.id)).status, 400);
  assert.equal((await a.command({ type: "send", content: "No stream" })).status, 409);
  assert.equal((await f.call("/command", "POST", { sequence: 1, command: { type: "create" } }, 0, a.id)).status, 409);
  value((await a.command({ type: "create" })).reply);
  assert.equal((await a.command({ type: "shell", command: "never" } as unknown as DesktopCommand)).reply.ok, false);
  const stream = await a.events();
  value((await a.command({ type: "send", content: "Final" })).reply);
  await stream.wait("run_completed");
  assert.equal((await f.call("/command", "POST", { sequence: 4, command: { type: "send", content: "Replay" } }, 0, a.id)).status, 409);
  assert.equal(stream.events.filter((event) => event.type === "run_started").length, 1);
});

test("M74 concurrent connect reserved before runtime await and server close disposes late factory", { timeout: 10_000 }, async (t) => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { factoryGate: async () => { entered.resolve(); await release.promise; } });
  const first = f.call("/connect").catch(() => undefined);
  await entered.promise;
  assert.equal((await f.call("/connect")).status, 409);
  assert.equal(f.creations(), 1);
  await f.server.close();
  release.resolve(); await first;
  for (let i = 0; i < 20 && f.disposals() === 0; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.disposals(), 1);
});

test("M74 concurrent command admission consumes sequence before await and rejects replay", { timeout: 10_000 }, async (t) => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { wrap: (runtime) => ({ ...runtime, async createSession(options) { entered.resolve(); await release.promise; return runtime.createSession(options); } }) });
  const a = f.peer(await f.connect());
  const first = a.command({ type: "create" }); await entered.promise;
  const replay = await f.call("/command", "POST", { sequence: 1, command: { type: "create" } }, 0, a.id);
  assert.equal(replay.status, 409);
  const overlap = await a.command({ type: "create" });
  assert.equal(overlap.reply.ok, false);
  if (!overlap.reply.ok) assert.equal(overlap.reply.error.code, "BUSY");
  release.resolve(); value((await first).reply);
  value((await a.command({ type: "status" })).reply);
});

test("M74 reconnect remains fail-closed beyond bounded disposal wait", { timeout: 10_000 }, async (t) => {
  const release = deferred();
  const f = await fixture(t, { wrap: (runtime) => ({ ...runtime, async dispose() { await release.promise; await runtime.dispose(); } }) });
  const id = await f.connect();
  assert.equal((await f.call("/connection", "DELETE", {}, 0, id)).status, 200);
  assert.equal((await f.call("/connect")).status, 409);
  release.resolve();
  // The second DELETE is refused while disposal owns the old principal; wait for the
  // real disposal to complete using the underlying fixture's visible store-free status.
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(await f.connect());
});

test("M74 oversized SSE event closes stream and disposes rather than buffering", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { wrap: (runtime) => ({ ...runtime, async sendUserInput(input) {
    const run = await runtime.sendUserInput(input);
    return { ...run, events: (async function* () {
      yield { type: "assistant_delta" as const, runId: run.id, sessionId: run.sessionId, text: "x".repeat(65_536) };
      yield* run.events;
    })() };
  } }) });
  const a = f.peer(await f.connect());
  value((await a.command({ type: "create" })).reply);
  const stream = await a.events();
  await a.command({ type: "send", content: "Oversize fixture" });
  await stream.consumed;
  assert.equal(stream.events.length, 0);
  assert.equal(f.disposals(), 1);
});

test("M74 failed factory releases reservation without returning private details", { timeout: 10_000 }, async (t) => {
  let attempts = 0;
  const token = randomBytes(32).toString("base64url");
  const server = await startRemoteServer({ principals: [{ id: "fixture", token }], async createRuntime() { attempts += 1; throw new Error("fixture-private-factory-error"); } });
  t.after(() => server.close());
  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(server.url + "/connect", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /fixture-private/);
  }
  assert.equal(attempts, 2);
});

test("M74 trusted Origin preflight reveals metadata only; duplicate credentials rejected", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { origins: ["https://trusted.invalid"] });
  const response = await fetch(f.server.url + "/command", { method: "OPTIONS", headers: { origin: "https://trusted.invalid", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, x-dragons-connection" } });
  assert.equal(response.status, 204); assert.equal(response.headers.get("access-control-allow-origin"), "https://trusted.invalid");
  assert.equal(f.creations(), 0);
  const token = randomBytes(32).toString("base64url");
  const createRuntime: RemoteServerOptions["createRuntime"] = async () => { throw new Error("must not run"); };
  await assert.rejects(startRemoteServer({ principals: [{ id: "a", token }, { id: "b", token }], createRuntime }), /Duplicate/);
  await assert.rejects(startRemoteServer({ principals: [{ id: "a", token: "short" }], createRuntime }), /Invalid/);
  await assert.rejects(startRemoteServer({ principals: [{ id: "a", token }], allowedOrigins: ["*"], createRuntime }), /Invalid/);
});
