import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import type { ToolCall } from "../../dist/agent.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createCodingTools } from "../../dist/tools.js";

import { supportedCheckpointTest } from "../checkpoint/checkpoint-support.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-diff-"));
  let calls: ToolCall[] = [];
  let requests = 0, factories = 0;
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => {
      factories++;
      let first = true;
      return { async respond(request) {
        requests++;
        const toolCalls = first ? calls : [];
        first = false;
        return { responseId: "fixture", toolCalls, text: toolCalls.length ? "" : request.toolOutputs.map(item => item.output).join("\n") };
      } };
    },
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers, sessionStore: store,
    tools: await createCodingTools(root), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  const session = await runtime.createSession({ provider: "fixture" });
  const pending: RuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  const bridge = new DesktopBridge(runtime, event => { pending.push(event); wake?.(); });
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await bridge.request({ type: "resume", sessionId: session.id })).ok, true);
  async function send(content: string, decision?: "allow_once" | "deny", beforeApproval?: () => Promise<void>) {
    assert.equal(pending.length, 0);
    const admission = await bridge.request({ type: content.startsWith("/") ? "slash" : "send", content });
    assert.equal(admission.ok, true, JSON.stringify(admission));
    const events: RuntimeEvent[] = [];
    for (;;) {
      if (!pending.length) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      const event = pending.shift()!;
      events.push(event);
      assert.equal(event.sessionId, session.id);
      if (event.type === "approval_requested") {
        assert.equal(event.operation, "WRITE");
        assert.ok(decision, "read-only local commands must not request approval");
        await beforeApproval?.();
        assert.equal((await bridge.request({ type: "approve", sessionId: session.id, runId: event.runId,
          approvalId: event.approvalId, decision })).ok, true);
      }
      if (event.type === "run_failed" || event.type === "run_cancelled") assert.fail(JSON.stringify(event));
      if (event.type === "run_completed") return { text: event.result.finalText, events };
    }
  }
  return { root, store, session, send, counts: () => [requests, factories],
    queue: (name: string, args: unknown) => { calls = [{ callId: "fixture-call", name, arguments: JSON.stringify(args) }]; } };
}

function capturedId(text: string): string {
  const match = /Checkpoint (cp-[0-9a-f-]+-1):/.exec(text);
  assert.ok(match, text);
  return match[1]!;
}

supportedCheckpointTest("Desktop exact JSON-quoted paths select one image and WRITE-gated rollback from a multi-file checkpoint", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const paths = ["a  b.txt", "a b.txt"];
  for (const [i, path] of paths.entries()) await writeFile(join(f.root, path), `before ${i}\n`);
  f.queue("apply_patch", { patch: paths.map((path, i) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before ${i}\n+after ${i}\n`).join("") });
  const written = await f.send("write both fixture files", "allow_once");
  const id = capturedId(written.text);
  assert.match(written.text, /: 2/);
  const counts = f.counts();
  assert.deepEqual(counts, [2, 1]);
  const persisted = await f.store.load(f.session.id);
  const bothAfter = async () => {
    for (const [i, path] of paths.entries()) assert.equal(await readFile(join(f.root, path), "utf8"), `after ${i}\n`);
  };
  await bothAfter();
  const listing = await f.send("/checkpoint list");
  assert.equal(listing.text.split("\n").filter(line => line.startsWith("cp-")).length, 1);
  for (const [i, path] of paths.entries()) {
    const diff = await f.send(`/checkpoint diff ${id} ${JSON.stringify(path)}`);
    assert.deepEqual(JSON.parse(diff.text), [{ path, before: `before ${i}\n`, after: `after ${i}\n` }]);
    assert.equal(diff.events.some(event => event.type === "approval_requested"), false);
  }
  const command = `/rollback ${id} ${JSON.stringify(paths[0])}`;
  const denied = await f.send(command, "deny", bothAfter);
  assert.equal(denied.events.filter(event => event.type === "approval_requested").length, 1);
  await bothAfter();
  const allowed = await f.send(command, "allow_once", bothAfter);
  assert.equal(allowed.events.filter(event => event.type === "approval_requested").length, 1);
  assert.match(allowed.text, /Rolled back cp-/);
  assert.equal(await readFile(join(f.root, paths[0]!), "utf8"), "before 0\n");
  assert.equal(await readFile(join(f.root, paths[1]!), "utf8"), "after 1\n");
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(await f.store.load(f.session.id), persisted, "local diffs and rollback must not persist checkpoint images or alter continuation");
});

supportedCheckpointTest("Desktop follows bounded UTF-8 diff next commands read-only without provider calls or session persistence", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const path = "a  b.txt";
  const before = "😀é\r\n".repeat(10000) + "before-end";
  const after = "界🙂\r\n".repeat(10000) + "after-end";
  assert.ok(Buffer.byteLength(JSON.stringify([{ path, before, after }])) > 60000);
  await writeFile(join(f.root, path), before);
  f.queue("write_file", { path, content: after });
  const id = capturedId((await f.send("write large fixture file", "allow_once")).text);
  assert.equal(await readFile(join(f.root, path), "utf8"), after);
  const counts = f.counts();
  assert.deepEqual(counts, [2, 1]);
  const persisted = await f.store.load(f.session.id);
  assert.doesNotMatch(JSON.stringify(persisted), /before-end|"before"|"after"/);
  const images = { before: "", after: "" };
  let next: string | null = `/checkpoint diff ${id} ${JSON.stringify(path)}`;
  let pages = 0;
  const commands = new Set<string>();
  while (next !== null) {
    assert.ok(pages < 100, "next commands must terminate");
    assert.equal(commands.has(next), false, "next command must advance");
    commands.add(next);
    const result = await f.send(next);
    assert.ok(Buffer.byteLength(result.text) < 30000, "each bridge result stays below transport/output bounds");
    assert.equal(result.events.some(event => event.type === "approval_requested"), false);
    const page = JSON.parse(result.text);
    assert.equal(page.path, path);
    assert.equal(page.page, ++pages);
    assert.ok(page.side === "before" || page.side === "after");
    const side: "before" | "after" = page.side;
    assert.equal(page.offset, Buffer.byteLength(images[side]));
    assert.ok(page.end - page.offset <= 4099);
    assert.equal(page.end - page.offset, Buffer.byteLength(page.text));
    images[side] += page.text;
    assert.ok(page.next === null || typeof page.next === "string");
    next = page.next;
    assert.equal(await readFile(join(f.root, path), "utf8"), after, "every diff page is read-only");
    assert.deepEqual(f.counts(), counts);
    assert.deepEqual(await f.store.load(f.session.id), persisted, "page bodies and image snapshots stay out of persisted session");
  }
  assert.ok(pages > 2);
  assert.deepEqual(images, { before, after }, "bridge pagination reconstructs exact UTF-8 including astral characters and CRLF");
});
