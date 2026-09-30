import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { main } from "../../dist/cli.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createCodingTools } from "../../dist/tools.js";
import { supportedCheckpointTest as checkpointTest } from "./checkpoint-support.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("dispose rejects admission suspended in acquireExecution and releases its late lease exactly once", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-admission-lifecycle-"));
  const entered = barrier();
  const gate = barrier();
  let releases = 0;
  let factories = 0;
  let mutations = 0;
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel() { factories++; assert.fail("disposed admission cannot construct a provider"); },
  }]);
  const store = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: { ...store,
      async acquireExecution(id) {
        const release = await store.acquireExecution!(id);
        entered.release();
        await gate.promise;
        return async () => { releases++; await release(); };
      },
      async save(session) { mutations++; await store.save(session); },
      async mutate(id, operation) { mutations++; return store.mutate!(id, operation); },
    }, tools: await createCodingTools(root), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  t.after(async () => { gate.release(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "file.txt"), "before");
  const session = await runtime.createSession();
  const before = await store.load(session.id);
  mutations = 0;
  const admission = runtime.sendUserInput({ sessionId: session.id, content: "Overwrite file.txt" });
  const rejected = assert.rejects(admission, /disposed/i);
  await entered.promise;
  await runtime.dispose();
  assert.equal(releases, 0, "lease is still hidden behind the acquisition barrier");
  gate.release();
  await rejected;
  await runtime.dispose();
  assert.equal(releases, 1);
  assert.equal(factories, 0);
  assert.equal(mutations, 0);
  assert.deepEqual(await store.load(session.id), before);
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "before");
  const release = await store.acquireExecution!(session.id);
  await release(); // Prove the real durable lease was released, not merely counted.
});

// Existing CLI contract: /clear resets conversation/continuation only. It does
// not start a new session, discard checkpoints, or bypass WRITE authorization.
// /new and /resume have separate history-reset coverage in checkpoint.test.ts.
checkpointTest("CLI /clear retains same-session checkpoint; selective rollback still requires WRITE approval without provider calls", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-clear-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "old-a\n");
  await writeFile(join(root, "b.txt"), "old-b\n");
  const store = createSessionStore(join(root, "sessions"));
  let requests = 0;
  let output = "";
  const checkpointReady = barrier();
  const cleared = barrier();
  const denied = barrier();
  let checkpointId = "";
  let sessionId = "";
  const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old-a\n+new-a\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old-b\n+new-b\n";
  await main([], { workingDirectory: root, configPath: join(root, "config.json"), config: {}, sessionStore: store,
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"), backgroundJobsDirectory: join(root, "jobs"),
    tools: await createCodingTools(root),
    model: { async respond(request) {
      requests++;
      assert.ok(requests <= 2, "local clear/list/rollback must never call the provider");
      return { responseId: `fixture-${requests}`, text: request.toolOutputs.map((item) => item.output).join("\n"),
        toolCalls: requests === 1 ? [{ callId: "patch", name: "apply_patch", arguments: JSON.stringify({ patch }) }] : [] };
    } },
    input: Readable.from((async function* () {
      yield "patch\ny\n";
      await checkpointReady.promise;
      const [before] = await store.list();
      assert.ok(before);
      sessionId = before.id;
      yield "/clear\n";
      await cleared.promise;
      const after = await store.load(sessionId);
      assert.deepEqual(after?.messages, []);
      assert.equal(after?.continuation, undefined);
      assert.equal((await store.list()).length, 1);
      yield `/checkpoint list\n/rollback ${checkpointId} a.txt\nn\n`;
      await denied.promise;
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "new-a\n");
      assert.equal(await readFile(join(root, "b.txt"), "utf8"), "new-b\n");
      assert.equal(requests, 2);
      yield `/rollback ${checkpointId} a.txt\ny\n/exit\n`;
    })(), { highWaterMark: 0 }),
    write(text) {
      output += text;
      const id = /Checkpoint (cp-[^\s:]+):/.exec(output)?.[1];
      if (id) { checkpointId = id; checkpointReady.release(); }
      if (output.includes("Current conversation cleared.")) cleared.release();
      if (output.includes("Authorization denied for")) denied.release();
    }, terminal: { inputIsTTY: false, outputIsTTY: false },
  });
  assert.equal(requests, 2);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "old-a\n");
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "new-b\n", "selective rollback must preserve the unselected file");
  const afterClear = output.split("Current conversation cleared.")[1]!;
  assert.ok(afterClear.split("? Allow WRITE")[0]!.includes(checkpointId), "list must expose the retained checkpoint before rollback approval");
  assert.doesNotMatch(afterClear, /No checkpoints|not found in this session/);
  assert.match(afterClear, /Authorization denied for/);
  assert.match(afterClear, /Rolled back cp-/);
  assert.equal((afterClear.match(/Allow WRITE /g) ?? []).length, 2, "denied and allowed rollback both require WRITE approval");
  assert.equal((await store.list())[0]!.id, sessionId);
});
