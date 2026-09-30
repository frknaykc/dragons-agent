import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime, type RuntimeRunHandle } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createCodingTools } from "../../dist/tools.js";

import { supportedCheckpointTest } from "../checkpoint/checkpoint-support.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dragons-checkpoint-eviction-"));
  let next = { path: "file-0.txt", content: "changed" };
  let factories = 0;
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => {
      factories++;
      const args = JSON.stringify(next);
      let first = true;
      return { async respond(request) {
        const toolCalls = first ? [{ callId: "write", name: "write_file", arguments: args }] : [];
        first = false;
        return { responseId: "fixture", text: toolCalls.length ? "" : request.toolOutputs.map((output) => output.output).join("\n"), toolCalls };
      } };
    },
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const gates = new Map<string, Promise<void>>();
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: { ...store, async acquireExecution(id) { await gates.get(id); return store.acquireExecution!(id); } },
    tools: await createCodingTools(root), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  const sessions: string[] = [];
  for (let i = 0; i < 17; i++) {
    sessions.push((await runtime.createSession()).id);
    await writeFile(join(root, `file-${i}.txt`), "seed");
  }
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  async function send(index: number, content: string) {
    const run = await runtime.sendUserInput({ sessionId: sessions[index]!, content });
    void run.result.catch(() => {});
    for await (const event of run.events) {
      if (event.type === "approval_requested") runtime.resolveAuthorization({ runId: run.id, approvalId: event.approvalId, decision: "allow_once" });
    }
    return (await run.result).finalText;
  }
  async function startWrite(index: number, content: string) {
    next = { path: `file-${index}.txt`, content };
    const run = await runtime.sendUserInput({ sessionId: sessions[index]!, content: "write" });
    void run.result.catch(() => {});
    const events = run.events[Symbol.asyncIterator]();
    while (true) {
      const event = await events.next();
      assert.equal(event.done, false, "write must pause for approval");
      if (event.value.type === "approval_requested") return { run, approvalId: event.value.approvalId };
    }
  }
  async function approve(pending: { run: RuntimeRunHandle; approvalId: string }) {
    assert.equal(runtime.resolveAuthorization({ runId: pending.run.id, approvalId: pending.approvalId, decision: "allow_once" }), true);
    return (await pending.run.result).finalText;
  }
  return { root, runtime, sessions, gates, send, startWrite, approve, factories: () => factories };
}

function idFrom(output: string): string {
  const match = /Checkpoint (cp-[^\s:]+):/.exec(output);
  assert.ok(match, output);
  return match[1]!;
}

supportedCheckpointTest("17th session fails closed while all 16 histories have active writes awaiting approval", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const prior = idFrom(await f.approve(await f.startWrite(0, "prior")));
  const busy = [];
  for (let i = 0; i < 16; i++) busy.push(await f.startWrite(i, "latest"));
  const factories = f.factories();
  await assert.rejects(f.runtime.sendUserInput({ sessionId: f.sessions[16]!, content: "write" }), /checkpoint history.*limit|checkpoint histor.*busy/i);
  assert.equal(f.factories(), factories, "rejected admission must not create a provider or write");
  assert.equal(await readFile(join(f.root, "file-16.txt"), "utf8"), "seed");
  const newest: string[] = [];
  for (const pending of busy) newest.push(idFrom(await f.approve(pending)));
  assert.match(await f.send(0, `/checkpoint diff ${prior}`), /"before": "seed"/);
  for (let i = 0; i < 16; i++) {
    assert.ok((await f.send(i, "/checkpoint list")).includes(newest[i]!), "every approved mutation must remain reachable from its session");
  }
  assert.match(await f.send(0, `/rollback ${newest[0]}`), /Rolled back/);
  assert.equal(await readFile(join(f.root, "file-0.txt"), "utf8"), "prior");
  assert.match(await f.send(0, `/rollback ${prior}`), /Rolled back/);
  assert.equal(await readFile(join(f.root, "file-0.txt"), "utf8"), "seed");
  assert.match(await f.send(16, "/checkpoint list"), /No checkpoints/, "failed admission releases its session reservation");
});

supportedCheckpointTest("pending admissions pin existing histories before storage completes", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const ids: string[] = [];
  for (let i = 0; i < 16; i++) ids.push(idFrom(await f.approve(await f.startWrite(i, "prior"))));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  for (let i = 0; i < 16; i++) f.gates.set(f.sessions[i]!, gate);
  const pending = f.sessions.slice(0, 16).map((sessionId) => f.runtime.sendUserInput({ sessionId, content: "/checkpoint list" }));
  try {
    await assert.rejects(f.runtime.sendUserInput({ sessionId: f.sessions[16]!, content: "/checkpoint list" }), /checkpoint history.*limit|checkpoint histor.*busy/i);
  } finally {
    release();
    const runs = await Promise.all(pending);
    const results = await Promise.all(runs.map((run) => run.result));
    results.forEach((result, index) => assert.ok(result.finalText.includes(ids[index]!)));
  }
});

supportedCheckpointTest("capacity evicts the oldest idle history, not an active or newly admitted history; expired IDs fail explicitly", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const prior = idFrom(await f.approve(await f.startWrite(0, "prior")));
  const active = await f.startWrite(0, "latest");
  const expired = idFrom(await f.approve(await f.startWrite(1, "idle")));
  for (let i = 2; i < 16; i++) await f.send(i, "/checkpoint list");
  const admitted = idFrom(await f.approve(await f.startWrite(16, "admitted")));
  assert.ok((await f.send(16, "/checkpoint list")).includes(admitted), "new history cannot evict itself");
  const newest = idFrom(await f.approve(active));
  assert.ok((await f.send(0, "/checkpoint list")).includes(prior));
  assert.ok((await f.send(0, "/checkpoint list")).includes(newest));
  assert.match(await f.send(1, "/checkpoint list"), /No checkpoints/);
  assert.match(await f.send(1, `/checkpoint diff ${expired}`), /not found in this session/);
  assert.match(await f.send(1, `/rollback ${expired}`), /not found in this session/);
  assert.equal(await readFile(join(f.root, "file-1.txt"), "utf8"), "idle");
  assert.ok((await f.send(16, "/checkpoint list")).includes(admitted));
});
