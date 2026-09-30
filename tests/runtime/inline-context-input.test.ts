import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { main } from "../../dist/cli.js";
import { DesktopBridge, type DesktopBridgeReply } from "../../dist/desktop/bridge.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import type { AgentModel } from "../../dist/agent.js";

async function root(t: TestContext) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dragons-inline-input-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, "note.txt"), "Selected fixture context.");
  return path;
}
function value<T>(reply: DesktopBridgeReply): T { assert.equal(reply.ok, true); if (!reply.ok) throw new Error("failed"); return reply.value as T; }

for (const interactive of [false, true]) test(`CLI ${interactive ? "interactive" : "one-shot"} input reaches shared inline resolver`, async (t) => {
  const path = await root(t); let calls = 0; const output: string[] = [];
  await main(interactive ? [] : ["Explain @file(note.txt)"], {
    workingDirectory: path, configPath: join(path, "config.json"), sessionDirectory: join(path, "sessions"), memoryDirectory: join(path, "memory"), skillsDirectory: join(path, "skills"), config: {}, tools: [],
    input: Readable.from(interactive ? ["Explain @file(note.txt)\n/exit\n"] : []), write: text => output.push(text),
    model: { async respond(request) { calls++; assert.match(request.task, /Selected fixture context/); assert.match(request.task, /untrusted advisory/); return { responseId: "fixture", text: "done", toolCalls: [] }; } },
  });
  assert.equal(calls, 1); assert.doesNotMatch(output.join(""), /Selected fixture context/);
});

test("CLI URL denial shows exact network destination and fails without provider/network invocation", async (t) => {
  const path = await root(t); const output: string[] = [];
  await assert.rejects(main(["@url(https://www.wikipedia.org/guide)"], {
    workingDirectory: path, configPath: join(path, "config.json"), config: {}, memoryDirectory: join(path, "memory"), tools: [], input: Readable.from(["n\n"]), write: text => output.push(text),
    model: { async respond() { assert.fail("denied input must not reach provider"); } },
  }), /approval denied/);
  assert.match(output.join(""), /EXECUTE inline_context_url/); assert.match(output.join(""), /https:\/\/www.wikipedia.org\/guide/);
});

for (const ending of ["deadline", "cancel"] as const) test(`CLI URL ${ending} releases approval ownership: the first follow-up reaches the model`, { timeout: 10000 }, async (t) => {
  const path = await root(t);
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => milliseconds === 60_000 ? deadline.signal : timeout(milliseconds));
  const input = new PassThrough();
  t.after(() => input.destroy());
  const tasks: string[] = [];
  let expired = false;
  let submitted = false;
  const running = main([], {
    workingDirectory: path, configPath: join(path, "config.json"), sessionDirectory: join(path, "sessions"), memoryDirectory: join(path, "memory"), skillsDirectory: join(path, "skills"), config: {}, tools: [], input,
    write(text) {
      if (!expired && text.includes("EXECUTE inline_context_url")) {
        expired = true;
        queueMicrotask(() => { if (ending === "deadline") deadline.abort(); else process.emit("SIGINT"); });
      }
      if (!submitted && (ending === "deadline" ? text.includes("resolution deadline exceeded") : text.includes("Cancelled."))) {
        submitted = true;
        queueMicrotask(() => input.end("first ordinary follow-up\n/exit\n"));
      }
    },
    model: { async respond(request) { tasks.push(request.task); return { responseId: "fixture", text: "done", toolCalls: [] }; } },
  });
  input.write("@url(https://www.wikipedia.org/guide)\n");
  await running;
  assert.equal(expired, true);
  assert.equal(submitted, true);
  assert.deepEqual(tasks, ["first ordinary follow-up"]);
});

async function desktop(t: TestContext, model: AgentModel) {
  const path = await root(t);
  const registry = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel: () => model }]);
  const store = createSessionStore(join(path, "sessions"), { providerIds: registry.ids() });
  const runtime = await createDragonsRuntime({ workingDirectory: path, providerRegistry: registry, sessionStore: store, memoryDirectory: join(path, "memory"), skillsDirectory: join(path, "skills"), tools: [] });
  const events: RuntimeEvent[] = []; const listeners = new Set<() => void>();
  const bridge = new DesktopBridge(runtime, event => { events.push(event); for (const listener of listeners) listener(); });
  t.after(async () => { await bridge.close(); await runtime.dispose(); });
  const session = value<{ id: string }>(await bridge.request({ type: "create", provider: "fixture", model: "fixture" }));
  const wait = (type: RuntimeEvent["type"], runId: string): Promise<RuntimeEvent> => new Promise(resolve => {
    const check = () => { const found = events.find(e => e.type === type && e.runId === runId); if (found) { listeners.delete(check); resolve(found); } };
    listeners.add(check); check();
  });
  return { path, runtime, bridge, store, session, events, wait };
}

test("Desktop bridge resolves selected context, persists literal submission, and resume does not reopen it", { timeout: 10000 }, async (t) => {
  let calls = 0;
  const f = await desktop(t, { async respond(request) {
    calls++; if (calls === 1) assert.match(request.task, /Selected fixture context/); else assert.equal(request.task, "ordinary follow-up");
    return { responseId: `fixture-${calls}`, text: "done", toolCalls: [] };
  } });
  const first = value<{ runId: string }>(await f.bridge.request({ type: "send", content: "@file(note.txt)" })); await f.wait("run_completed", first.runId);
  const saved = await f.store.load(f.session.id); assert.equal(saved?.messages[0]?.content, "@file(note.txt)");
  assert.doesNotMatch(JSON.stringify(f.events), /Selected fixture context/);
  await rm(join(f.path, "note.txt"));
  value(await f.bridge.request({ type: "resume", sessionId: f.session.id }));
  const next = value<{ runId: string }>(await f.bridge.request({ type: "send", content: "ordinary follow-up" })); await f.wait("run_completed", next.runId);
  assert.equal(calls, 2);
});

for (const decision of ["deny", "cancel", "timeout"] as const) test(`Desktop URL ${decision} closes pending consent without model execution`, { timeout: 10000 }, async (t) => {
  const deadline = new AbortController();
  if (decision === "timeout") {
    const timeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => milliseconds === 60_000 ? deadline.signal : timeout(milliseconds));
  }
  const f = await desktop(t, { async respond() { assert.fail("no model after denial/cancel"); } });
  const run = value<{ runId: string }>(await f.bridge.request({ type: "send", content: "@url(https://www.wikipedia.org/guide)" }));
  const approval = await f.wait("approval_requested", run.runId);
  assert.equal(approval.type, "approval_requested"); if (approval.type !== "approval_requested") return;
  assert.equal(approval.contextUrl, "https://www.wikipedia.org/guide"); assert.equal(approval.operation, "EXECUTE");
  if (decision === "deny") value(await f.bridge.request({ type: "approve", sessionId: f.session.id, runId: run.runId, approvalId: approval.approvalId, decision: "deny" }));
  else if (decision === "cancel") value(await f.bridge.request({ type: "cancel", runId: run.runId }));
  else deadline.abort();
  if (decision === "timeout") assert.equal(f.runtime.resolveAuthorization({ runId: run.runId, approvalId: approval.approvalId, decision: "allow_once" }), false);
  await f.wait(decision === "cancel" ? "run_cancelled" : "run_failed", run.runId);
  assert.equal(f.runtime.resolveAuthorization({ runId: run.runId, approvalId: approval.approvalId, decision: "allow_once" }), false);
  assert.equal((await f.store.load(f.session.id))?.messages.length, 0);
});
