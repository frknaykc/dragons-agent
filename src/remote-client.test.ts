import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { RemoteClient } from "./remote/client.js";
import type { RuntimeEvent } from "./runtime.js";

async function transportFixture(t: TestContext) {
  const token = randomBytes(32).toString("base64url");
  const sequences: number[] = [];
  let stream: ServerResponse | undefined;
  let drop = false;
  let rejectStatus = 0;
  let calls = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const reply = (value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, value })); };
    if (req.url === "/connect") { reply({ connectionId: "fixture-connection" }); return; }
    assert.equal(req.headers["x-dragons-connection"], "fixture-connection");
    if (req.url === "/events") { stream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); return; }
    if (req.url === "/connection") { stream?.end(); reply(true); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    sequences.push(message.sequence); calls++;
    if (rejectStatus) { res.writeHead(rejectStatus, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: { code: "BUSY", message: "Rejected before sequence admission." } })); return; }
    if (drop) { req.socket.destroy(); return; }
    reply({ command: message.command.type });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { stream?.end(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { token, url: `http://127.0.0.1:${address.port}`, sequences, emit: (text: string) => stream!.write(text), drop: () => { drop = true; }, reject: (status: number) => { rejectStatus = status; }, calls: () => calls };
}

test("M74 fetch client orders commands, streams structured events and disposes its connection", { timeout: 10000 }, async (t) => {
  const host = await transportFixture(t); const events: RuntimeEvent[] = [];
  const client = await RemoteClient.connect({ url: host.url, token: host.token, onEvent: (event) => events.push(event) });
  t.after(() => client.close());
  await Promise.all([client.request({ type: "providers" }), client.request({ type: "status" })]);
  assert.deepEqual(host.sequences, [1, 2]);
  host.emit('data: {"type":"assistant_delta","runId":"run","sessionId":"session","text":"hello"}\n\n');
  for (let i = 0; i < 100 && !events.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events, [{ type: "assistant_delta", runId: "run", sessionId: "session", text: "hello" }]);
  assert.doesNotMatch(JSON.stringify(client), new RegExp(host.token));
  const close = client.close(); assert.equal(client.close(), close); await close; await client.disconnected;
  await assert.rejects(client.request({ type: "status" }));
});

test("M74 lost reply closes the client without replaying a possibly admitted effect", { timeout: 10000 }, async (t) => {
  const host = await transportFixture(t);
  const client = await RemoteClient.connect({ url: host.url, token: host.token, onEvent() {} });
  t.after(() => client.close()); host.drop();
  await assert.rejects(client.request({ type: "send", content: "fixture" }), /outcome unavailable/);
  await assert.rejects(client.request({ type: "send", content: "fixture" }));
  assert.equal(host.calls(), 1);
});

test("M74 malformed and oversized event frames disconnect bounded clients", { timeout: 10000 }, async (t) => {
  const host = await transportFixture(t);
  const client = await RemoteClient.connect({ url: host.url, token: host.token, onEvent() { assert.fail("Malformed frame must not be published"); } });
  t.after(() => client.close()); host.emit("data: " + "x".repeat(530000));
  await client.disconnected;
  await assert.rejects(client.request({ type: "status" }));
});

test("M74 client rejects insecure/credential-bearing endpoints before connecting", async () => {
  for (const url of ["http://example.com", "http://localhost:8080", "http://127.0.0.1/path", "https://user:password@example.com", "https://example.com/?token=x"]) {
    await assert.rejects(RemoteClient.connect({ url, token: "a".repeat(40), onEvent() {} }), /Invalid remote endpoint/);
  }
});

test("M74 HTTP refusal before sequence admission disconnects rather than desynchronizing", { timeout: 10000 }, async (t) => {
  for (const status of [429, 503]) {
    const host = await transportFixture(t);
    const client = await RemoteClient.connect({ url: host.url, token: host.token, onEvent() {} });
    t.after(() => client.close()); host.reject(status);
    await assert.rejects(client.request({ type: "status" }), /outcome unavailable/);
    await client.disconnected;
    await assert.rejects(client.request({ type: "status" }));
    assert.equal(host.calls(), 1);
  }
});
