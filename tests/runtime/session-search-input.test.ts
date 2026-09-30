import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { main } from "../../dist/cli.js";
import type { AgentModel } from "../../dist/agent.js";
import { createSessionSearchTools } from "../../dist/session-search.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { DesktopBridge, type DesktopBridgeReply } from "../../dist/desktop/bridge.js";

async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "dragons-search-input-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = createSessionStore(join(path, "sessions"));
  const old = await store.create({ workingDirectory: path, provider: "openai-api", model: "fixture" });
  old.messages = [{ role: "user", content: "orchid historical decision", createdAt: old.createdAt }];
  await store.save(old);
  let calls = 0;
  const model: AgentModel = { async respond(request) {
    calls++;
    assert.equal(request.tools.find(t => t.name === "session_search")?.operation, "READ");
    assert.equal(request.tools.find(t => t.name === "session_read")?.operation, "READ");
    if (calls === 1) return { responseId: "search", text: "", toolCalls: [{ callId: "s", name: "session_search", arguments: JSON.stringify({ query: "orchid" }) }] };
    if (calls === 2) {
      const found = JSON.parse(request.toolOutputs[0]!.output).results[0]; assert.equal(found.sessionId, old.id);
      return { responseId: "read", text: "", toolCalls: [{ callId: "r", name: "session_read", arguments: JSON.stringify({ sessionId: found.sessionId, revision: found.revision }) }] };
    }
    if (calls === 3) {
      assert.match(request.toolOutputs[0]!.output, /orchid historical decision/);
      return { responseId: "observe", text: "", toolCalls: [{ callId: "o", name: "fixture_read", arguments: "{}" }] };
    }
    assert.match(request.toolOutputs[0]!.output, /observedfixture/);
    return { responseId: "done", text: "completed", toolCalls: [] };
  } };
  const tools = [{ name: "fixture_read", operation: "READ" as const, description: "fixture", inputSchema: { type: "object" as const }, async execute() { return { ok: true, output: 'observedfixture LSP: EXECUTE denied; diagnostics skipped. {"cookie":"syntheticcookiemarker","id_token":"syntheticidmarker"} password=fixturecredential' }; } }];
  return { path, store, old, model, tools, calls: () => calls };
}

for (const interactive of [false, true]) test(`CLI ${interactive ? "interactive" : "one-shot"} model searches and reads through runAgent`, async t => {
  const f = await fixture(t);
  await main(interactive ? [] : ["find old decision"], {
    workingDirectory: f.path, configPath: join(f.path, "config.json"), sessionDirectory: join(f.path, "sessions"), memoryDirectory: join(f.path, "memory"), skillsDirectory: join(f.path, "skills"), config: {}, tools: f.tools,
    input: Readable.from(interactive ? ["find old decision\n/exit\n"] : []), write() {}, model: f.model,
  });
  assert.equal(f.calls(), 4);
  const sessions = await f.store.list(); assert.equal(sessions.length, interactive ? 2 : 1);
  if (interactive) {
    const active = sessions.find(s => s.id !== f.old.id)!;
    assert.equal(active.toolHistory?.length, 1); assert.equal(active.toolHistory[0]!.name, "fixture_read");
    await assertSafeHistory(f, active.id);
  }
});

test("interactive clear removes observations and failed turns never persist them", async t => {
  for (const clear of [true, false]) {
    const f = await fixture(t); let calls = 0;
    const model: AgentModel = clear ? f.model : { async respond() {
      if (++calls === 1) return { responseId: "tool", text: "", toolCalls: [{ callId: "o", name: "fixture_read", arguments: "{}" }] };
      throw new Error("fixture failure");
    } };
    await main([], { workingDirectory: f.path, configPath: join(f.path, "config.json"), sessionDirectory: join(f.path, "sessions"), memoryDirectory: join(f.path, "memory"), skillsDirectory: join(f.path, "skills"), config: {}, tools: f.tools, model,
      input: Readable.from([`find old decision\n${clear ? "/clear\n" : ""}/exit\n`]), write() {} });
    const active = (await f.store.list()).find(s => s.id !== f.old.id)!;
    assert.equal(active.messages.length, 0); assert.equal(active.toolHistory?.length ?? 0, 0);
  }
});

async function assertSafeHistory(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const raw = await readFile(join(f.path, "sessions", `${id}.json`), "utf8");
  assert.doesNotMatch(raw, /fixturecredential|syntheticcookiemarker|syntheticidmarker/);
  const [search, read] = createSessionSearchTools(f.store, f.path);
  for (const query of ["fixturecredential", "syntheticcookiemarker", "syntheticidmarker"]) {
    assert.equal(JSON.parse((await search!.execute({ query })).output).results.length, 0);
  }
  const projection = (await read!.execute({ sessionId: id })).output;
  assert.match(projection, /observedfixture/);
  // Ordinary observed text is not an approval event, even when it quotes identical wording.
  assert.match(projection, /LSP: EXECUTE denied; diagnostics skipped\./);
  assert.doesNotMatch(projection, /fixturecredential|syntheticcookiemarker|syntheticidmarker/);
}

function value<T>(reply: DesktopBridgeReply): T { assert.equal(reply.ok, true); if (!reply.ok) throw new Error("failed"); return reply.value as T; }
test("Desktop bridge reaches shared search/read authority and persists safe tool observations", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const registry = createProviderRegistry([{ id: "openai-api", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel: () => f.model }]);
  const runtime = await createDragonsRuntime({ workingDirectory: f.path, providerRegistry: registry, sessionStore: f.store, memoryDirectory: join(f.path, "memory"), skillsDirectory: join(f.path, "skills"), tools: f.tools });
  let finish!: () => void; const completed = new Promise<void>(resolve => { finish = resolve; }); const events: RuntimeEvent[] = [];
  const bridge = new DesktopBridge(runtime, event => { events.push(event); if (event.type === "run_completed" || event.type === "run_failed") finish(); });
  t.after(async () => { await bridge.close(); await runtime.dispose(); });
  const active = value<{ id: string }>(await bridge.request({ type: "create", provider: "openai-api", model: "fixture" }));
  value(await bridge.request({ type: "send", content: "find old decision" })); await completed;
  assert.equal(f.calls(), 4); assert.ok(events.some(e => e.type === "run_completed"));
  assert.ok(!events.some(e => e.type === "approval_requested"));
  assert.equal((await f.store.load(active.id))?.toolHistory?.[0]?.name, "fixture_read");
  assert.doesNotMatch(JSON.stringify(events), /fixturecredential|syntheticcookiemarker|syntheticidmarker/);
  await assertSafeHistory(f, active.id);
});
