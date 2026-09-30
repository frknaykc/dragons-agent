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
import { createCodingTools, type AgentTool } from "../../dist/tools.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createSessionStore } from "../../dist/session-store.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { main } from "../../dist/cli.js";
import { supportedCheckpointTest as checkpointTest } from "./checkpoint-support.js";

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
const mixed = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n--- a/nested/edit.txt\n+++ b/nested/edit.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
checkpointTest("runtime mixed structural batch and selected rollback retain unrelated receipts; local commands do not call provider", async (t) => {
  const f = await fixture(t); await mkdir(join(f.root, "nested"));
  await writeFile(join(f.root, "nested/edit.txt"), "old\n"); await writeFile(join(f.root, "delete.txt"), "old\n");
  f.queue([call("apply_patch", { patch: mixed })]);
  await f.send("patch", false); await assert.rejects(readFile(join(f.root, "new.txt")));
  assert.match((await f.send("patch")).result.finalText, /Checkpoint/);
  const counts = f.counts();
  assert.equal(await readFile(join(f.root, "nested/edit.txt"), "utf8"), "new\n");
  await assert.rejects(readFile(join(f.root, "delete.txt")));
  assert.match((await f.send(`/rollback ${f.id()} nested/edit.txt`)).result.finalText, /Rolled back/);
  assert.equal(await readFile(join(f.root, "nested/edit.txt"), "utf8"), "old\n");
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "created\n");
  assert.match((await f.send(`/rollback ${f.id()}`)).result.finalText, /Rolled back/);
  await assert.rejects(readFile(join(f.root, "new.txt")));
  assert.equal(await readFile(join(f.root, "delete.txt"), "utf8"), "old\n");
  assert.deepEqual(f.counts(), counts);
});
for (const conflict of ["created", "replaced", "edited"]) checkpointTest(`structural whole-selection preflight refuses external ${conflict}`, async (t) => {
  const f = await fixture(t); const history = new SessionCheckpoints(f.root);
  await mkdir(join(f.root, "nested")); await writeFile(join(f.root, "nested/a"), "old");
  await writeFile(join(f.root, "gone"), "old");
  assert.equal(history.mutate([{ path: "new", content: "new", expected: null }, { path: "nested/a", content: "new" }, { path: "gone", content: null }]).ok, true);
  const id = checkpointId(history);
  if (conflict === "created") await writeFile(join(f.root, "gone"), "external");
  if (conflict === "edited") await writeFile(join(f.root, "new"), "external");
  if (conflict === "replaced") { await fs.promises.rename(join(f.root, "new"), join(f.root, "original")); await writeFile(join(f.root, "new"), "new"); }
  assert.equal(history.rollback(id).ok, false);
  assert.equal(await readFile(join(f.root, "nested/a"), "utf8"), "new");
});
test("mixed credential postimage and oversized preparation reject before writes", async (t) => {
  const f = await fixture(t); await mkdir(join(f.root, "nested"));
  await writeFile(join(f.root, "nested/edit.txt"), "old\n"); await writeFile(join(f.root, "delete.txt"), "old\n");
  f.queue([call("apply_patch", { patch: mixed.replace("+created", "+password=synthetic") })]); await f.send("patch");
  await assert.rejects(readFile(join(f.root, "new.txt")));
  assert.equal(await readFile(join(f.root, "nested/edit.txt"), "utf8"), "old\n");
  await writeFile(join(f.root, "big"), "x".repeat(262145));
  const tool = (await createCodingTools(f.root)).find((tool) => tool.name === "edit_file")!;
  assert.equal((await tool.execute({ path: "big", oldText: "x", newText: "y" })).ok, false);
  assert.equal((await fs.promises.stat(join(f.root, "big"))).size, 262145);
});
