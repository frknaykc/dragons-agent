import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runAgent, type AgentModel, type ToolCall } from "../../dist/agent.js";
import { SessionCheckpoints } from "../../dist/checkpoint.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createCodingTools } from "../../dist/tools.js";

function modelFor(call: ToolCall): AgentModel {
  let first = true;
  return { async respond(request) {
    const toolCalls = first ? [call] : [];
    first = false;
    return { responseId: "coverage-fixture", text: request.toolOutputs.map((item) => item.output).join("\n"), toolCalls };
  } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dragons-coverage-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "edit.txt"), "before\n");
  await writeFile(join(root, "delete.txt"), "before\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("classification is nonmutating and structural capture remains nonmutating and rejects unsafe batch members", async (t) => {
  const root = await fixture(t);
  const history = new SessionCheckpoints(root);
  assert.deepEqual(history.classify([{ path: "new.txt", content: "safe" }]), { kind: "covered" });
  assert.deepEqual(history.classify([{ path: "nested/edit.txt", content: "safe" }]), { kind: "covered" });
  for (const mutation of [
    { path: ".env", content: "safe" },
    { path: "delete.txt", content: "api_token=synthetic-fixture" },
    { path: "delete.txt", content: "after", expected: "stale" },
    { path: "delete.txt", content: "x".repeat(262145) },
    { path: "delete.txt", content: "binary\0text" },
    { path: "../escape", content: "safe" },
  ]) {
    const result = history.classify([{ path: "new.txt", content: "safe" }, mutation]);
    assert.equal(result.kind, "rejected");
  }
  assert.equal(history.classify([{ path: "new.txt", content: "a" }, { path: "new.txt", content: "b" }]).kind, "rejected");
  await assertContent(root, "new.txt", null);
  await assertContent(root, "delete.txt", "before\n");
  assert.match(history.list(), /No checkpoints/);
});

for (const conflict of [false, true]) {
  test(`approved mixed structural patch rejects ${conflict ? "source conflict" : "credential"} without partial writes`, async (t) => {
    const root = await fixture(t);
    const history = new SessionCheckpoints(root);
    const classify = history.classify.bind(history);
    // Simulate a stale expected source at the public preflight boundary, after
    // patch preparation; no filesystem race or hostile-writer isolation claim.
    if (conflict) history.classify = (batch) => classify(batch.map((item) => item.path === "delete.txt" ? { ...item, expected: "stale" } : item));
    let approvals = 0;
    const patch = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n--- a/delete.txt\n+++ b/delete.txt\n@@ -1 +1 @@\n-before\n+" + (conflict ? "after" : "api_token=synthetic-fixture") + "\n";
    const result = await runAgent({
      task: "Apply fixture patch", workingDirectory: root, checkpoints: history,
      tools: await createCodingTools(root),
      model: modelFor({ callId: "mixed", name: "apply_patch", arguments: JSON.stringify({ patch }) }),
      authorize: () => { approvals++; return true; },
    });
    assert.equal(approvals, 1);
    assert.match(result.finalText, conflict ? /conflict/ : /sensitive/);
    assert.doesNotMatch(result.finalText, /outside rollback coverage/);
    await assertContent(root, "new.txt", null);
    await assertContent(root, "delete.txt", "before\n");
    assert.match(history.list(), /No checkpoints/);
  });
}

const scenarios = [
  { name: "new file", tool: "write_file", args: { path: "new.txt", content: "created\n" }, path: "new.txt", before: null, after: "created\n" },
  { name: "nested edit", tool: "edit_file", args: { path: "nested/edit.txt", oldText: "before", newText: "after" }, path: "nested/edit.txt", before: "before\n", after: "after\n" },
  { name: "patch deletion", tool: "apply_patch", args: { patch: "--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\n" }, path: "delete.txt", before: "before\n", after: null },
] as const;

for (const withHistory of [false]) for (const toolName of ["write_file", "edit_file", "apply_patch"]) {
  test(`legacy ${toolName} partial failure retains attempted paths (history=${withHistory})`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "nested", "second.txt"), "before\n");
    await writeFile(join(root, "nested", "third.txt"), "before\n");
    const original = fsPromises.writeFile;
    const attempts: string[] = [];
    const mocked = t.mock.method(fsPromises, "writeFile", async (...args: Parameters<typeof writeFile>) => {
      attempts.push(String(args[0]));
      if (toolName !== "apply_patch" || attempts.length === 2) {
        await original(args[0], "PART", "utf8");
        throw new Error("Synthetic legacy failure");
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const tools = await createCodingTools(root);
    const patchText = ["edit", "second", "third"].map(name => `--- a/nested/${name}.txt\n+++ b/nested/${name}.txt\n@@ -1 +1 @@\n-before\n+after\n`).join("");
    const input = toolName === "apply_patch" ? { patch: patchText } : toolName === "edit_file"
      ? { path: "nested/edit.txt", oldText: "before", newText: "after" } : { path: "nested/edit.txt", content: "after\n" };
    const result = await tools.find(tool => tool.name === toolName)!.execute(input, { checkpoints: withHistory ? new SessionCheckpoints(root) : undefined });
    assert.equal(result.ok, false);
    assert.deepEqual(result.changedPaths, toolName === "apply_patch" ? ["nested/edit.txt", "nested/second.txt"] : ["nested/edit.txt"]);
    assert.match(result.output, /outside rollback coverage/);
    assert.match(result.output, /Synthetic legacy failure/);
    assert.deepEqual(result.rollbackCoverage, { kind: "unsupported", reason: withHistory ? "nested" : "unavailable" });
    assert.equal(attempts.length, toolName === "apply_patch" ? 2 : 1);
    await assertContent(root, "nested/edit.txt", toolName === "apply_patch" ? "after\n" : "PART");
    await assertContent(root, "nested/third.txt", "before\n");
  });
}

for (const toolName of ["write_file", "edit_file", "apply_patch"]) test(`structural ${toolName} partial failure uses actual backend and retains only completed receipts`, async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "nested/second.txt"), "before\n");
  const history = new SessionCheckpoints(root);
  const original = fs.writeSync;
  let writes = 0;
  const mock = t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
    if (++writes === (toolName === "apply_patch" ? 2 : 1)) {
      original(fd, Buffer.from("PART"), 0, 4, 0);
      throw new Error("Synthetic structural failure");
    }
    return original(fd, bytes, offset, length, position);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const input = toolName === "apply_patch" ? { patch: ["edit", "second"].map(name => `--- a/nested/${name}.txt\n+++ b/nested/${name}.txt\n@@ -1 +1 @@\n-before\n+after\n`).join("") }
    : toolName === "edit_file" ? { path: "nested/edit.txt", oldText: "before", newText: "after" } : { path: "nested/edit.txt", content: "after\n" };
  const tools = await createCodingTools(root);
  const result = await tools.find(tool => tool.name === toolName)!.execute(input, { checkpoints: history });
  assert.equal(result.ok, false);
  assert.equal(writes, toolName === "apply_patch" ? 2 : 1);
  assert.match(result.output, /Synthetic structural failure/);
  assert.doesNotMatch(result.output, /outside rollback coverage/);
  assert.deepEqual(result.changedPaths, toolName === "apply_patch" ? ["nested/edit.txt", "nested/second.txt"] : ["nested/edit.txt"]);
  await assertContent(root, toolName === "apply_patch" ? "nested/second.txt" : "nested/edit.txt", "PARTre\n");
  if (toolName === "apply_patch") {
    const id = history.list().split(":")[0]!;
    assert.doesNotMatch(history.diff(id), /PART|second/);
    assert.equal(history.rollback(id, "nested/edit.txt").ok, true);
    await assertContent(root, "nested/edit.txt", "before\n");
    await assertContent(root, "nested/second.txt", "PARTre\n");
  } else assert.match(history.list(), /No checkpoints/);
});

async function assertContent(root: string, path: string, expected: string | null) {
  if (expected === null) await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
  else assert.equal(await readFile(join(root, path), "utf8"), expected);
}

for (const scenario of scenarios) {
  for (const allow of [false, true]) {
    test(`runtime ${allow ? "approved" : "denied"} ${scenario.name} preserves tool behavior and single approval`, async (t) => {
      const root = await fixture(t);
      const call: ToolCall = { callId: "coverage-call", name: scenario.tool, arguments: JSON.stringify(scenario.args) };
      const providers = createProviderRegistry([{
        id: "coverage", label: "Coverage fixture", defaultModel: "fixture", credentialRequirement: "none",
        capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
        createModel: () => modelFor(call),
      }]);
      const runtime = await createDragonsRuntime({
        workingDirectory: root, providerRegistry: providers,
        sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
        tools: await createCodingTools(root), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
      });
      try {
        const session = await runtime.createSession({ provider: "coverage" });
        const run = await runtime.sendUserInput({ sessionId: session.id, content: "Perform the fixture file change." });
        const events: RuntimeEvent[] = [];
        for await (const event of run.events) {
          events.push(event);
          if (event.type === "approval_requested") assert.equal(runtime.resolveAuthorization({
            runId: run.id, approvalId: event.approvalId, decision: allow ? "allow_once" : "deny",
          }), true);
        }
        const result = await run.result;
        assert.equal(events.filter((event) => event.type === "approval_requested").length, 1);
        await assertContent(root, scenario.path, allow ? scenario.after : scenario.before);
        if (allow) {
          assert.match(result.finalText, /Checkpoint cp-/);
          assert.ok(Buffer.byteLength(result.finalText) < 1024, "coverage warning must be bounded");
          assert.doesNotMatch(result.finalText, /outside rollback coverage/);
          const id = /Checkpoint (cp-[0-9a-f-]+-\d+):/.exec(result.finalText)![1];
          const rollback = await runtime.sendUserInput({ sessionId: session.id, content: `/rollback ${id} ${scenario.path}` });
          let rollbackApprovals = 0;
          for await (const event of rollback.events) if (event.type === "approval_requested") {
            rollbackApprovals++;
            runtime.resolveAuthorization({ runId: rollback.id, approvalId: event.approvalId, decision: "allow_once" });
          }
          assert.match((await rollback.result).finalText, /Rolled back/);
          assert.equal(rollbackApprovals, 1);
          await assertContent(root, scenario.path, scenario.before);
        } else assert.doesNotMatch(result.finalText, /outside rollback coverage/i);
      } finally { await runtime.dispose(); }
    });
  }
}

for (const output of [
  "Checkpoint conflict: patch/edit source changed.",
  "Checkpoint write failed; state is uncertain.",
  "Checkpoint unsupported operation/topology: injected mutation error must not trigger retry.",
  "Checkpoint excludes credential paths, sensitive content and binary files; write refused.",
]) {
  test(`runAgent never retries a checkpoint mutation error through legacy writes: ${output}`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "existing.txt"), "before");
    const history = new SessionCheckpoints(root);
    let mutations = 0;
    let approvals = 0;
    history.mutate = () => { mutations++; return { ok: false, output }; };
    const result = await runAgent({
      task: "Attempt the approved write.", workingDirectory: root, checkpoints: history,
      tools: await createCodingTools(root),
      model: modelFor({ callId: "no-retry", name: "write_file", arguments: JSON.stringify({ path: "existing.txt", content: "after" }) }),
      authorize: () => { approvals++; return true; },
    });
    assert.equal(approvals, 1);
    assert.equal(mutations, 1);
    assert.equal(result.finalText, output);
    assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "before");
    assert.match(history.list(), /No checkpoints/);
  });
}
