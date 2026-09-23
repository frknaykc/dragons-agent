import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, writeFile, rm, symlink, link, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { runAgent, type AgentModel, type ToolCall } from "../../dist/agent.js";
import { SessionCheckpoints, checkpointCommand } from "../../dist/checkpoint.js";
import { CheckpointStructuralFs } from "../../dist/checkpoint-structural-fs.js";
import { createCodingTools, type AgentTool } from "../../dist/tools.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createSessionStore } from "../../dist/session-store.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { main } from "../../dist/cli.js";

const checkpointId = (history: SessionCheckpoints, ordinal?: number): string => {
  const ids = history.list().split("\n").map((line) => line.split(":")[0]!);
  return ids.find((id) => ordinal === undefined || id.endsWith(`-${ordinal}`))!;
};
const call = (name: string, args: unknown): ToolCall => ({ callId: "fixture-call", name, arguments: JSON.stringify(args) });
function modelFor(calls: ToolCall[], count = () => {}): AgentModel {
  let first = true;
  return { async respond(request) { count(); const toolCalls = first ? calls : []; first = false;
    return { responseId: "fixture", text: toolCalls.length ? "" : request.toolOutputs.map((item) => item.output).join("\n"), toolCalls };
  } };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dragons-checkpoint-"));
  let calls: ToolCall[] = []; let requests = 0; let factories = 0;
  const ids = new Map<number, string>();
  await writeFile(join(root, "a.txt"), "seed");
  await writeFile(join(root, "desktop.txt"), "seed");
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => { factories++; return modelFor(calls, () => { requests++; }); },
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers, sessionStore: store,
    tools: await createCodingTools(root), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  const session = await runtime.createSession({ provider: "fixture" });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  async function send(content: string, allow = true, sessionId = session.id) {
    const run = await runtime.sendUserInput({ sessionId, content });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "approval_requested") {
        assert.equal(runtime.resolveAuthorization({ runId: "wrong-run", approvalId: event.approvalId, decision: "allow_once" }), false);
        assert.equal(runtime.resolveAuthorization({ runId: run.id, approvalId: event.approvalId, decision: allow ? "allow_once" : "deny" }), true);
      }
    }
    const result = await run.result;
    const captured = /Checkpoint (cp-[0-9a-f-]+-(\d+)):/.exec(result.finalText);
    if (captured) ids.set(Number(captured[2]), captured[1]!);
    return { result, events };
  }
  return { root, runtime, store, session, send, id: (n = 1) => ids.get(n) ?? `unknown-${n}`, queue: (next: ToolCall[]) => { calls = next; }, counts: () => [requests, factories] };
}

test("runtime denies file writes without capture; approved write and rollback share runAgent authorization and never call provider locally", async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, "a.txt"), "before");
  f.queue([call("write_file", { path: "a.txt", content: "after" })]);
  await f.send("write", false);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "before");
  assert.match((await f.send("/checkpoint")).result.finalText, /No checkpoints/);
  await f.send("write");
  const counts = f.counts(); const persisted = await f.store.load(f.session.id);
  assert.match((await f.send("/checkpoint list")).result.finalText, /cp-[0-9a-f-]+-1: a.txt/);
  assert.match((await f.send(`/checkpoint diff ${f.id(1)} a.txt`)).result.finalText, /"before": "before"/);
  const denied = await f.send(`/rollback ${f.id(1)} a.txt`, false);
  assert.ok(denied.events.some((event) => event.type === "approval_requested"));
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "after");
  assert.match((await f.send(`/rollback ${f.id(1)} a.txt`)).result.finalText, /Rolled back cp-/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "before");
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(await f.store.load(f.session.id), persisted, "local history and diff bodies must not persist or replace provider continuation");
});

test("runtime multi-file edits support selective rollback and modes; structural patches capture selective rollback", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "old\n"); await writeFile(join(f.root, "b.txt"), "old\n", { mode: 0o640 });
  f.queue([call("apply_patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old\n+new\n" })]);
  assert.match((await f.send("patch")).result.finalText, /Checkpoint cp-.*: 2/);
  const diff = (await f.send(`/checkpoint diff ${f.id()} b.txt`)).result.finalText;
  assert.match(diff, /"before": "old\\n"/); assert.doesNotMatch(diff, /a.txt/);
  await f.send(`/rollback ${f.id()} b.txt`);
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "old\n");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "new\n");
  await f.send(`/rollback ${f.id()}`);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "old\n");
  assert.equal((await stat(join(f.root, "b.txt"))).mode & 0o777, 0o640);
  for (const suffix of ["--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n", "--- a/b.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"]) {
    f.queue([call("apply_patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" + suffix })]);
    const captured = (await f.send("patch")).result.finalText;
    assert.match(captured, /Checkpoint cp-/);
    const id = /Checkpoint (cp-[0-9a-f-]+-\d+):/.exec(captured)![1]!;
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "new\n");
    if (suffix.includes("+++ /dev/null")) await assert.rejects(readFile(join(f.root, "b.txt")), { code: "ENOENT" });
    else assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "created\n");
    const selected = suffix.includes("+++ /dev/null") ? "b.txt" : "new.txt";
    assert.match((await f.send(`/rollback ${id} ${selected}`)).result.finalText, /Rolled back/);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "new\n");
    await f.send(`/rollback ${id}`);
  }
  assert.match((await f.send("/checkpoint")).result.finalText, /No checkpoints/);
});

test("runtime edit_file captures exact CRLF and no-final-newline text; external edit blocks whole rollback before any write", async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, "a.txt"), "old\r\nend"); await writeFile(join(f.root, "b.txt"), "old\n");
  f.queue([call("edit_file", { path: "a.txt", oldText: "old", newText: "new" })]); await f.send("edit");
  assert.match((await f.send(`/checkpoint diff ${f.id(1)}`)).result.finalText, /old\\r\\nend/);
  await f.send(`/rollback ${f.id(1)}`); assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "old\r\nend");
  await writeFile(join(f.root, "c.txt"), "old\n");
  f.queue([call("apply_patch", { patch: "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-old\n+created\n" })]); await f.send("patch");
  await writeFile(join(f.root, "c.txt"), "external");
  assert.match((await f.send(`/rollback ${f.id(2)}`)).result.finalText, /conflict/);
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(f.root, "c.txt"), "utf8"), "external");
  assert.match((await f.send("/checkpoint")).result.finalText, /cp-/);
});

test("runtime excludes traversal, links, sensitive paths/content and binary text without capturing or changing targets", async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, "a.txt"), "unchanged");
  await symlink("a.txt", join(f.root, "sym.txt")); await link(join(f.root, "a.txt"), join(f.root, "hard.txt"));
  await mkdir(join(f.root, "nested")); await symlink("nested", join(f.root, "dirlink"));
  const candidates = ["../escape.txt", "nested/../escape.txt", "sym.txt", "hard.txt", "dirlink/a.txt", ".env", "credentials.json", "private.key", "nested/.env.local"];
  for (const path of candidates) { f.queue([call("write_file", { path, content: "blocked" })]); await f.send("write"); }
  for (const content of ["abc\0def", "-----BEGIN PRIVATE KEY-----\nsynthetic\n", "ghp_abcdefghijklmnop"]) {
    f.queue([call("write_file", { path: "sensitive.txt", content })]); await f.send("write");
  }
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "unchanged");
  for (const path of ["escape.txt", ".env", "credentials.json", "private.key", "nested/.env.local", "sensitive.txt", "nested/a.txt"]) await assert.rejects(readFile(join(f.root, path)), { code: "ENOENT" });
  assert.match((await f.send("/checkpoint")).result.finalText, /No checkpoints/);
});

test("runtime rejects invalid multi-file patch and oversized files before any write, then accepts a valid write", async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, "a.txt"), "old\n");
  f.queue([call("apply_patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-old\n+new\n" })]); await f.send("patch");
  f.queue([call("write_file", { path: "large.txt", content: "x".repeat(262145) })]); await f.send("large");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "old\n");
  await assert.rejects(readFile(join(f.root, "large.txt")), { code: "ENOENT" });
  assert.match((await f.send("/checkpoint")).result.finalText, /No checkpoints/);
  f.queue([call("write_file", { path: "a.txt", content: "new" })]);
  assert.match((await f.send("write")).result.finalText, /cp-/);
});

test("runtime histories are session-isolated, never restored from persisted session, and bounded to 16 sessions", async (t) => {
  const f = await fixture(t); f.queue([call("write_file", { path: "a.txt", content: "new" })]); await f.send("write");
  const other = await f.runtime.createSession({ provider: "fixture" });
  assert.match((await f.send("/checkpoint", true, other.id)).result.finalText, /No checkpoints/);
  assert.match((await f.send(`/rollback ${f.id(1)}`, true, other.id)).result.finalText, /not found/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "new");
  for (let index = 0; index < 15; index++) { const session = await f.runtime.createSession({ provider: "fixture" }); await f.send("/checkpoint", true, session.id); }
  assert.match((await f.send("/checkpoint")).result.finalText, /No checkpoints/);
  assert.doesNotMatch(JSON.stringify(await f.store.load(f.session.id)), /"before"|"after"|entries/);
});

test("checkpoint limits bound count, total images, selected diff, unique paths and mutation size", async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root);
  for (let index = 0; index < 34; index++) assert.equal(history.mutate([{ path: "a.txt", content: String(index) }]).ok, true);
  assert.equal(history.list().split("\n").length, 32); assert.doesNotMatch(history.list(), /-1:|-2:/);
  assert.equal(history.mutate(Array.from({ length: 33 }, (_, i) => ({ path: `${i}.txt`, content: "" }))).ok, false);
  assert.equal(history.mutate([{ path: "x.txt", content: "a" }, { path: "x.txt", content: "b" }]).ok, false);
  history.clear();
  for (let i = 0; i < 32; i++) await writeFile(join(f.root, `${i}.txt`), "");
  const mutations = Array.from({ length: 32 }, (_, i) => ({ path: `${i}.txt`, content: "x\n".repeat(8192) }));
  assert.equal(history.mutate(mutations).ok, true);
  assert.equal(history.mutate(mutations.map((item) => ({ ...item, content: "y\n".repeat(8192) }))).ok, true);
  assert.equal(history.mutate(mutations).ok, true);
  assert.equal(history.list().split("\n").length, 2, "oldest image pairs evicted at 2 MiB");
  assert.throws(() => history.diff(checkpointId(history, 36)), /display bound/);
  assert.match(history.diff(checkpointId(history, 36), "0.txt"), /"path": "0.txt"/);
});

test("runAgent never hands checkpoint write capability to untrusted READ, EXECUTE or same-named custom tools", async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root); let executions = 0;
  for (const operation of ["READ", "WRITE", "EXECUTE"] as const) {
    const tool: AgentTool = { name: "write_file", operation, description: "Untrusted fixture", inputSchema: { type: "object" }, async execute(_input, options) {
      executions++; assert.equal(options?.checkpoints, undefined); return { ok: true, output: "safe" };
    } };
    await runAgent({ task: "test", workingDirectory: f.root, checkpoints: history, tools: [tool], model: modelFor([call(tool.name, {})]), authorize: async () => true });
  }
  assert.equal(executions, 3); assert.match(history.list(), /No checkpoints/);
  const local = checkpointCommand(`/rollback ${f.id(1)}`, history);
  let executed = false; const original = local.tools[0]!.execute; local.tools[0]!.execute = async (...args) => { executed = true; return original(...args); };
  await runAgent({ task: `/rollback ${f.id(1)}`, ...local, workingDirectory: f.root });
  assert.equal(executed, false, "local command cannot bypass missing authorizer");
});

test("CLI interactive writes and local rollback use existing approval and clear history on new session without model requests", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t); let requests = 0; let output = "";
  let resolveId!: (id: string) => void;
  const checkpointReady = new Promise<string>((resolve) => { resolveId = resolve; });
  await writeFile(join(f.root, "cli.txt"), "before");
  await main([], { workingDirectory: f.root, configPath: join(f.root, "config.json"), config: {}, sessionDirectory: join(f.root, "cli-sessions"),
    memoryDirectory: join(f.root, "cli-memory"), skillsDirectory: join(f.root, "skills"), tools: await createCodingTools(f.root),
    model: modelFor([call("write_file", { path: "cli.txt", content: "after" })], () => { requests++; }),
    input: Readable.from((async function* () {
      yield "write\ny\n";
      const id = await checkpointReady;
      yield `/checkpoint diff ${id} cli.txt\n/rollback ${id}\nn\n/rollback ${id}\ny\n/new\n/checkpoint\n/exit\n`;
    })(), { highWaterMark: 0 }),
    write: (text) => {
      output += text; const id = /Checkpoint (cp-[0-9a-f-]+-1):/.exec(output)?.[1];
      if (id) resolveId(id);
    }, terminal: { inputIsTTY: false, outputIsTTY: false },
  });
  assert.equal(requests, 2); assert.equal(await readFile(join(f.root, "cli.txt"), "utf8"), "before");
  assert.match(output, /Rolled back cp-/); assert.match(output, /No checkpoints/); assert.match(output, /"before": "before"/);
});

test("Desktop slash routes into real runtime; stale approval cannot rollback, owned approval can, with zero provider requests", async (t) => {
  const f = await fixture(t); f.queue([call("write_file", { path: "desktop.txt", content: "created" })]); await f.send("write");
  const counts = f.counts(); const events: RuntimeEvent[] = [];
  let signal!: () => void; let notification = new Promise<void>((resolve) => { signal = resolve; });
  const bridge = new DesktopBridge(f.runtime, (event) => { events.push(event); signal(); }); t.after(() => bridge.close());
  assert.equal((await bridge.request({ type: "resume", sessionId: f.session.id })).ok, true);
  assert.equal((await bridge.request({ type: "slash", content: `/rollback ${f.id(1)} desktop.txt` })).ok, true);
  async function waitFor(type: RuntimeEvent["type"]) {
    for (let i = 0; i < 50; i++) {
      const found = events.find((event) => event.type === type); if (found) return found;
      await notification; notification = new Promise<void>((resolve) => { signal = resolve; });
    }
    throw new Error(`Missing ${type}`);
  }
  const approval = await waitFor("approval_requested"); if (approval.type !== "approval_requested") throw new Error("approval missing");
  assert.equal(await readFile(join(f.root, "desktop.txt"), "utf8"), "created");
  const args = { type: "approve", runId: approval.runId, sessionId: f.session.id, approvalId: approval.approvalId, decision: "allow_once" };
  assert.equal((await bridge.request({ ...args, sessionId: "12345678-1234-1234-1234-123456789012" })).ok, false);
  assert.equal(await readFile(join(f.root, "desktop.txt"), "utf8"), "created");
  assert.equal((await bridge.request(args)).ok, true);
  await waitFor("run_completed");
  assert.equal(await readFile(join(f.root, "desktop.txt"), "utf8"), "seed"); assert.deepEqual(f.counts(), counts);
});

for (const rollback of [false, true]) test(`partial write failure reports uncertain paths, compensates only verified prefix and never captures external images (rollback=${rollback})`, async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root);
  await writeFile(join(f.root, "a.txt"), "old-a"); await writeFile(join(f.root, "b.txt"), "old-b");
  if (rollback) assert.equal(history.mutate([{ path: "a.txt", content: "new-a" }, { path: "b.txt", content: "new-b" }]).ok, true);
  const id = checkpointId(history);
  const original = fs.writeSync; let writes = 0;
  const mocked = t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
    if (++writes === 2) { original(fd, Buffer.from("PART"), 0, 4, 0); throw new Error("Synthetic partial failure"); }
    return original(fd, bytes, offset, length, position);
  }); syncBuiltinESMExports();
  try {
    const result = rollback ? history.rollback(id) : history.mutate([{ path: "a.txt", content: "new-a" }, { path: "b.txt", content: "new-b" }]);
    assert.equal(result.ok, false); assert.match(result.output, /uncertain.*Recovery incomplete/);
    assert.deepEqual(result.changedPaths, ["b.txt"]);
    assert.match(result.output, /Uncertain changed paths: \["b\.txt"\]/);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), rollback ? "new-a" : "old-a");
    assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "PARTb");
    if (!rollback) assert.match(history.list(), /No checkpoints/);
    else {
      assert.doesNotMatch(history.diff(id), /PART/);
      assert.equal(history.rollback(id).ok, false);
    }
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("failed compensation reports all uncertain paths without retaining attacker postimages", async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root);
  await writeFile(join(f.root, "b.txt"), "old-b");
  const original = fs.writeSync; let writes = 0;
  const mocked = t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
    if (++writes === 2) {
      fs.writeFileSync(join(f.root, "a.txt"), "external-a");
      fs.writeFileSync(join(f.root, "b.txt"), "external-b");
      throw new Error("Synthetic external interference");
    }
    return original(fd, bytes, offset, length, position);
  }); syncBuiltinESMExports();
  try {
    const result = history.mutate([{ path: "a.txt", content: "new-a" }, { path: "b.txt", content: "new-b" }]);
    assert.equal(result.ok, false); assert.deepEqual(new Set(result.changedPaths), new Set(["a.txt", "b.txt"]));
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "external-a");
    assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "external-b");
    assert.match(history.list(), /No checkpoints/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("runtime rollback rejects a symlink swap and mode conflict; cancellation invalidates approval before any write", async (t) => {
  const f = await fixture(t); f.queue([call("write_file", { path: "a.txt", content: "after" })]); await f.send("write");
  await writeFile(join(f.root, "external.txt"), "external"); await rm(join(f.root, "a.txt")); await symlink("external.txt", join(f.root, "a.txt"));
  assert.match((await f.send(`/rollback ${f.id(1)}`)).result.finalText, /symlinks/);
  assert.equal(await readFile(join(f.root, "external.txt"), "utf8"), "external");
  await rm(join(f.root, "a.txt")); await writeFile(join(f.root, "a.txt"), "after", { mode: 0o600 });
  assert.match((await f.send(`/rollback ${f.id(1)}`)).result.finalText, /conflict/);
  fs.chmodSync(join(f.root, "a.txt"), 0o644);
  const counts = f.counts(); const run = await f.runtime.sendUserInput({ sessionId: f.session.id, content: `/rollback ${f.id(1)}` });
  const result = run.result.then(() => "completed", () => "cancelled");
  for await (const event of run.events) if (event.type === "approval_requested") {
    run.cancel();
    assert.equal(f.runtime.resolveAuthorization({ runId: run.id, approvalId: event.approvalId, decision: "allow_once" }), false);
  }
  assert.equal(await result, "cancelled");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "after"); assert.deepEqual(f.counts(), counts);
});

for (const operation of ["create", "delete", "nested"] as const) test(`runtime pending structural ${operation} approval cancellation has zero mutation and no snapshot`, async (t) => {
  const f = await fixture(t);
  const captures = t.mock.method(CheckpointStructuralFs.prototype, "capture");
  await mkdir(join(f.root, "nested"));
  await writeFile(join(f.root, "nested/a.txt"), "old");
  f.queue([operation === "delete" ? call("apply_patch", { patch: "--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-seed\n" })
    : call("write_file", { path: operation === "create" ? "created.txt" : "nested/a.txt", content: "new" })]);
  const run = await f.runtime.sendUserInput({ sessionId: f.session.id, content: "change" });
  const result = run.result.then(() => "completed", () => "cancelled");
  let approvals = 0;
  for await (const event of run.events) if (event.type === "approval_requested") {
    approvals++;
    run.cancel();
    assert.equal(f.runtime.resolveAuthorization({ runId: run.id, approvalId: event.approvalId, decision: "allow_once" }), false);
  }
  assert.equal(approvals, 1);
  assert.equal(await result, "cancelled");
  assert.equal(captures.mock.callCount(), 0, "approval cancellation must not even capture a structural preimage");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "seed");
  assert.equal(await readFile(join(f.root, "nested/a.txt"), "utf8"), "old");
  await assert.rejects(readFile(join(f.root, "created.txt")), { code: "ENOENT" });
  assert.match((await f.send("/checkpoint")).result.finalText, /No checkpoints/);
});

test("runtime recreation resumes transcript but never restores old checkpoint images or calls provider for local commands", async (t) => {
  const f = await fixture(t); f.queue([call("write_file", { path: "a.txt", content: "after" })]); await f.send("write");
  await f.runtime.dispose();
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel() { assert.fail("local commands must not instantiate a provider model"); },
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: f.root, sessionStore: f.store, providerRegistry: providers, tools: await createCodingTools(f.root),
    memoryDirectory: join(f.root, "memory"), skillsDirectory: join(f.root, "skills") });
  t.after(() => runtime.dispose()); await runtime.resumeSession(f.session.id);
  const run = await runtime.sendUserInput({ sessionId: f.session.id, content: "/checkpoint" });
  for await (const event of run.events) assert.notEqual(event.type, "approval_requested");
  assert.match((await run.result).finalText, /No checkpoints/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "after");
});

test("creation patch refuses an existing target and malformed new-line counts before mutation", async (t) => {
  const f = await fixture(t); await writeFile(join(f.root, "a.txt"), "existing\n");
  f.queue([call("apply_patch", { patch: "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+new\n" })]);
  assert.match((await f.send("patch")).result.finalText, /already exists/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "existing\n");
  f.queue([call("apply_patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n-existing\n+new\n" })]);
  assert.match((await f.send("patch")).result.finalText, /count/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "existing\n");
  assert.match((await f.send("/checkpoint")).result.finalText, /No checkpoints/);
});

for (const race of ["replacement", "hardlink"] as const) test(`writable descriptor rejects ${race} injected between capture and open`, async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root);
  const original = fs.openSync; let injected = false;
  const mocked = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[1] === "number" && (args[1] & fs.constants.O_RDWR)) {
      injected = true;
      if (race === "replacement") {
        fs.renameSync(join(f.root, "a.txt"), join(f.root, "captured.txt"));
        fs.writeFileSync(join(f.root, "a.txt"), "seed");
      } else fs.linkSync(join(f.root, "a.txt"), join(f.root, "alias.txt"));
    }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    const result = history.mutate([{ path: "a.txt", content: "overwrite" }]);
    assert.equal(injected, true); assert.equal(result.ok, false); assert.match(result.output, /conflict/);
    assert.deepEqual(result.changedPaths, []);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "seed");
    assert.match(history.list(), /No checkpoints/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

for (const race of ["replacement", "symlink"] as const) test(`nested topology ${race} at writable open is refused; IDs are not reused`, async (t) => {
  const f = await fixture(t); await mkdir(join(f.root, "nested")); await writeFile(join(f.root, "nested/a.txt"), "old");
  const history = new SessionCheckpoints(f.root); const original = fs.openSync; let writable = 0;
  const mocked = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[1] === "number" && (args[1] & (fs.constants.O_RDWR | fs.constants.O_WRONLY)) && writable++ === 0) {
      fs.renameSync(join(f.root, "nested"), join(f.root, "saved"));
      if (race === "symlink") fs.symlinkSync("saved", join(f.root, "nested"));
      else { fs.mkdirSync(join(f.root, "nested")); fs.writeFileSync(join(f.root, "nested/a.txt"), "old"); }
    }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    const result = history.mutate([{ path: "nested/a.txt", content: "new" }]);
    assert.equal(result.ok, false);
    assert.match(result.output, /conflict/);
    assert.deepEqual(result.changedPaths, []);
    assert.equal(writable, 1);
    assert.equal(await readFile(join(f.root, "nested/a.txt"), "utf8"), "old");
    assert.equal(await readFile(join(f.root, "saved/a.txt"), "utf8"), "old");
    assert.match(history.list(), /No checkpoints/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(history.mutate([{ path: "a.txt", content: "one" }]).ok, true);
  const oldId = checkpointId(history); history.clear();
  const recreated = new SessionCheckpoints(f.root);
  assert.equal(recreated.mutate([{ path: "a.txt", content: "two" }]).ok, true);
  assert.notEqual(checkpointId(recreated), oldId); assert.equal(recreated.rollback(oldId).ok, false);
});

for (const field of ["client_secret", "clientSecret", "aws_secret_access_key", "DATABASE_URL", "connection_string"]) test(`sensitive shared field ${field} excludes both preimage and postimage`, async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root);
  const secret = JSON.stringify({ [field]: "private-value" });
  assert.match(history.mutate([{ path: "a.txt", content: secret }]).output, /sensitive/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "seed");
  await writeFile(join(f.root, "a.txt"), secret);
  assert.match(history.mutate([{ path: "a.txt", content: "safe" }]).output, /sensitive/);
  assert.match(history.list(), /No checkpoints/);
});


test("workspace replacement injected at writable open cannot overwrite replacement tree", async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root); const moved = `${f.root}-moved`;
  const original = fs.openSync; let injected = false;
  const mocked = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (!injected && typeof args[1] === "number" && (args[1] & fs.constants.O_RDWR)) {
      injected = true; fs.renameSync(f.root, moved); fs.mkdirSync(f.root); fs.writeFileSync(join(f.root, "a.txt"), "seed");
    }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    const result = history.mutate([{ path: "a.txt", content: "overwrite" }]);
    assert.equal(injected, true); assert.equal(result.ok, false); assert.match(result.output, /conflict/);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "seed");
    assert.equal(await readFile(join(moved, "a.txt"), "utf8"), "seed");
    assert.match(history.mutate([{ path: "a.txt", content: "retry" }]).output, /topology.*changed/);
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
    if (injected) { await rm(f.root, { recursive: true }); fs.renameSync(moved, f.root); }
  }
});

test("descriptor close failure after a write reports the changed path without creating recovery history", async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root);
  const original = fs.closeSync; let closes = 0;
  const mocked = t.mock.method(fs, "closeSync", (fd: number) => {
    original(fd); if (++closes === 2) throw new Error("Synthetic close error");
  }); syncBuiltinESMExports();
  try {
    const result = history.mutate([{ path: "a.txt", content: "new" }]);
    assert.equal(result.ok, false); assert.match(result.output, /close failed.*Recovery incomplete/);
    assert.deepEqual(result.changedPaths, ["a.txt"]); assert.match(history.list(), /No checkpoints/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "new");
});
