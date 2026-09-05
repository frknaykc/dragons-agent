import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { AgentModel } from "./agent.js";
import { main } from "./cli.js";
import { createSessionPlanStore } from "./plan.js";
import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime, RuntimeRunError, DEFAULT_MAX_RUNTIME_EVENT_TEXT_BYTES, type DragonsRuntimeOptions, type RuntimeEvent } from "./runtime.js";
import { createSessionStore, type SessionStore } from "./session-store.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function fixture(model: AgentModel) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-execution-lease-")));
  let factories = 0;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => { factories += 1; return model; },
  }]);
  const directory = join(root, "sessions");
  const store = () => createSessionStore(directory, { providerIds: providers.ids() });
  const disk = store();
  const options: DragonsRuntimeOptions = { workingDirectory: root, providerRegistry: providers, sessionStore: disk, tools: [], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") };
  const first = await createDragonsRuntime(options);
  const second = await createDragonsRuntime({ ...options, sessionStore: store() });
  const session = await first.createSession();
  return { root, directory, providers, disk, options, first, second, session, factories: () => factories,
    async close() { await Promise.all([first.dispose(), second.dispose()]); await rm(root, { recursive: true, force: true }); } };
}

const answer = { responseId: "answer", text: "Done.", toolCalls: [] };

test("M75 cleanup failure is sanitized and produces failure, never an early successful terminal event", async () => {
  const f = await fixture({ async respond() { return answer; } });
  const raw = new Error("cleanup " + "x".repeat(10000), { cause: { privateFixture: true } });
  const runtime = await createDragonsRuntime({ ...f.options, sessionStore: {
    ...f.disk, async acquireExecution(id) { const release = await f.disk.acquireExecution!(id); return async () => { await release(); throw raw; }; },
  } });
  try {
    const run = await runtime.sendUserInput({ sessionId: f.session.id, content: "cleanup" });
    const rejected = assert.rejects(run.result, (error: unknown) => {
      assert.ok(error instanceof RuntimeRunError); assert.notEqual(error, raw);
      assert.equal(error.cause, undefined); assert.ok(Buffer.byteLength(error.message) <= DEFAULT_MAX_RUNTIME_EVENT_TEXT_BYTES); return true;
    });
    const events: RuntimeEvent[] = []; for await (const event of run.events) events.push(event);
    await rejected;
    assert.equal(events.some((event) => event.type === "run_completed"), false);
    assert.equal(events.filter((event) => event.type === "run_failed").length, 1);
  } finally { await runtime.dispose(); await f.close(); }
});

test("M75 real runtimes reject shared-disk competition before provider and hold through durable save", async () => {
  const entered = gate();
  const finish = gate();
  const f = await fixture({ async respond() { entered.open(); await finish.promise; return answer; } });
  const saving = gate();
  const saved = gate();
  const store: SessionStore = { ...f.disk, async mutate(id, operation) { saving.open(); await saved.promise; return f.disk.mutate!(id, operation); } };
  const runtime = await createDragonsRuntime({ ...f.options, sessionStore: store });
  try {
    const run = await runtime.sendUserInput({ sessionId: f.session.id, content: "first" });
    await entered.promise;
    await assert.rejects(f.second.sendUserInput({ sessionId: f.session.id, content: "loser" }), /busy/);
    assert.equal(f.factories(), 1);
    const task = await createSessionPlanStore(f.disk, f.session.id).add({ title: "Plan still works", description: "Independent mutation lock" });
    assert.equal(task.title, "Plan still works");
    finish.open();
    await saving.promise;
    await assert.rejects(f.second.sendUserInput({ sessionId: f.session.id, content: "still busy" }), /busy/);
    saved.open();
    await run.result;
    const next = await f.second.sendUserInput({ sessionId: f.session.id, content: "next" });
    await next.result;
    assert.equal((await f.disk.load(f.session.id))?.messages.length, 4);
    assert.equal((await createSessionPlanStore(f.disk, f.session.id).list()).length, 1);
  } finally { finish.open(); saved.open(); await runtime.dispose(); await f.close(); }
});

test("M75 cancellation retains lease until provider unwinds, then permits another runtime", async () => {
  const entered = gate(); const unwind = gate(); let calls = 0;
  const f = await fixture({ async respond() { if (++calls === 1) { entered.open(); await unwind.promise; } return answer; } });
  try {
    const run = await f.first.sendUserInput({ sessionId: f.session.id, content: "cancel" });
    const cancelled = assert.rejects(run.result, /cancelled/);
    await entered.promise;
    assert.equal(run.cancel(), true);
    await assert.rejects(f.second.sendUserInput({ sessionId: f.session.id, content: "too soon" }), /busy/);
    unwind.open(); await cancelled;
    await (await f.second.sendUserInput({ sessionId: f.session.id, content: "now" })).result;
  } finally { unwind.open(); await f.close(); }
});

test("M75 stale execution locks fail closed, validate UUIDs, and preserve replacement ownership", async () => {
  const f = await fixture({ async respond() { return answer; } });
  const path = join(f.directory, `.${f.session.id}.execution.lock`);
  try {
    await assert.rejects(f.disk.acquireExecution!("../invalid"), /Invalid/);
    const release = await f.disk.acquireExecution!(f.session.id);
    const replacement = JSON.stringify({ version: 1, pid: -1, token: "different-owner" });
    await writeFile(path, replacement);
    await release();
    assert.equal(await readFile(path, "utf8"), replacement);
    await assert.rejects(f.second.sendUserInput({ sessionId: f.session.id, content: "stale" }), /busy/);
    assert.equal(f.factories(), 0);
  } finally { await rm(path, { force: true }); await f.close(); }
});

test("M75 disposal during acquire rejects admission and releases without loading continuation", async () => {
  const f = await fixture({ async respond() { return answer; } });
  const acquired = gate(); const proceed = gate(); let loads = 0;
  const runtime = await createDragonsRuntime({ ...f.options, sessionStore: {
    ...f.disk,
    async acquireExecution(id) { const release = await f.disk.acquireExecution!(id); acquired.open(); await proceed.promise; return release; },
    async load(id) { loads += 1; return f.disk.load(id); },
  } });
  try {
    const admission = runtime.sendUserInput({ sessionId: f.session.id, content: "race" });
    const rejected = assert.rejects(admission, /disposed/);
    await acquired.promise;
    await assert.rejects(runtime.sendUserInput({ sessionId: f.session.id, content: "duplicate" }), /active run/);
    const disposal = runtime.dispose();
    proceed.open(); await rejected; await disposal;
    assert.equal(loads, 0); assert.equal(f.factories(), 0);
    await (await f.second.sendUserInput({ sessionId: f.session.id, content: "released" })).result;
  } finally { proceed.open(); await runtime.dispose(); await f.close(); }
});

test("M75 duplicate run IDs and load exceptions release admission leases", async () => {
  const entered = gate(); const finish = gate();
  const f = await fixture({ async respond() { entered.open(); await finish.promise; return answer; } });
  const runtime = await createDragonsRuntime({ ...f.options, createRunId: () => "duplicate" });
  try {
    const run = await runtime.sendUserInput({ sessionId: f.session.id, content: "first" }); await entered.promise;
    const other = await runtime.createSession();
    await assert.rejects(runtime.sendUserInput({ sessionId: other.id, content: "duplicate" }), /unique/);
    await (await f.disk.acquireExecution!(other.id))();
    const failing = await createDragonsRuntime({ ...f.options, sessionStore: { ...f.disk, async load() { throw new Error("load failed"); } } });
    try { await assert.rejects(failing.sendUserInput({ sessionId: other.id, content: "load" }), /load failed/); }
    finally { await failing.dispose(); }
    await (await f.disk.acquireExecution!(other.id))();
    finish.open(); await run.result;
  } finally { finish.open(); await runtime.dispose(); await f.close(); }
});

test("M75 save failure releases execution and a throwing releaser does not poison local admission", async () => {
  const f = await fixture({ async respond() { return answer; } });
  let failSave = true;
  const runtime = await createDragonsRuntime({ ...f.options, sessionStore: {
    ...f.disk,
    async mutate(id, operation) { if (failSave) throw new Error("save failed"); return f.disk.mutate!(id, operation); },
    async acquireExecution(id) { const release = await f.disk.acquireExecution!(id); return async () => { await release(); throw new Error("release cleanup failed"); }; },
  } });
  try {
    await assert.rejects((await runtime.sendUserInput({ sessionId: f.session.id, content: "fails" })).result, /release cleanup failed/);
    failSave = false;
    await assert.rejects((await runtime.sendUserInput({ sessionId: f.session.id, content: "retries" })).result, /release cleanup failed/);
    await (await f.second.sendUserInput({ sessionId: f.session.id, content: "another owner" })).result;
  } finally { await runtime.dispose(); await f.close(); }
});

test("M75 dispose during the final continuation load cannot admit a provider run", async () => {
  const f = await fixture({ async respond() { return answer; } });
  const loading = gate(); const proceed = gate();
  const runtime = await createDragonsRuntime({ ...f.options, sessionStore: {
    ...f.disk,
    async load(id) { const session = await f.disk.load(id); loading.open(); await proceed.promise; return session; },
  } });
  try {
    const admission = assert.rejects(runtime.sendUserInput({ sessionId: f.session.id, content: "race" }), /disposed/);
    await loading.promise;
    const disposal = runtime.dispose();
    proceed.open(); await admission; await disposal;
    assert.equal(f.factories(), 0);
    await (await f.disk.acquireExecution!(f.session.id))();
  } finally { proceed.open(); await runtime.dispose(); await f.close(); }
});

test("M75 CLI resume uses the disk execution lease and reloads continuation after acquire", async () => {
  let previous: string | undefined;
  const f = await fixture({ async respond(request) { previous = request.conversationResponseId; return answer; } });
  let output = "";
  const cli = (sessionStore: SessionStore) => main(["session", "resume", f.session.id], {
    workingDirectory: f.root, providerRegistry: f.providers, sessionStore, tools: [], config: {},
    memoryDirectory: join(f.root, "memory"), skillsDirectory: join(f.root, "skills"),
    input: Readable.from(["hello\n/exit\n"]), write: (text) => { output += text; },
  });
  try {
    const release = await f.disk.acquireExecution!(f.session.id);
    await cli(f.disk);
    assert.match(output, /busy/); assert.equal(f.factories(), 0);
    await release();
    await cli({ ...f.disk, async acquireExecution(id) {
      const unlock = await f.disk.acquireExecution!(id);
      await f.disk.mutate!(id, (current) => ({ ...current, continuation: { responseId: "fresh-continuation" } }));
      return unlock;
    } });
    assert.equal(previous, "fresh-continuation");
    assert.equal((await f.disk.load(f.session.id))?.messages.length, 2);
    await (await f.disk.acquireExecution!(f.session.id))();
  } finally { await f.close(); }
});
