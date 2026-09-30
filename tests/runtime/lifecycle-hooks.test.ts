import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import type { AgentTool } from "../../dist/tools.js";

test("runtime defers first-session hook to an active run and asks for real per-trigger approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-hooks-"));
  let invoked = 0;
  let modelTurns = 0;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      modelTurns += 1;
      assert.deepEqual(request.toolOutputs, []);
      return { responseId: `r-${modelTurns}`, text: "done", toolCalls: [] };
    } }),
  }]);
  const tool: AgentTool = { name: "hook_fixture", description: "fixture", operation: "EXECUTE", inputSchema: { type: "object" }, async execute(input) {
    assert.deepEqual(input, { event: { type: "session_started" } });
    invoked += 1;
    return { ok: true, output: "hook output" };
  } };
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [tool], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
    lifecycleHooks: [{ on: "session_started", toolName: "hook_fixture" }],
  });
  try {
    const session = await runtime.createSession();
    assert.equal(invoked, 0, "passive session creation cannot execute an unapproved hook");
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "first" });
    const iterator = run.events[Symbol.asyncIterator]();
    let pending;
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      if (next.value?.type === "approval_requested") { pending = next.value; break; }
    }
    assert.equal(pending.toolName, "hook_fixture");
    assert.equal(modelTurns, 0);
    assert.equal(invoked, 0);
    assert.equal(runtime.resolveAuthorization({ runId: run.id, approvalId: pending.approvalId, decision: "allow_once" }), true);
    for await (const _ of { [Symbol.asyncIterator]: () => iterator }) { /* drain */ }
    assert.equal((await run.result).finalText, "done");
    assert.equal(invoked, 1);
    const second = await runtime.sendUserInput({ sessionId: session.id, content: "second" });
    for await (const _ of second.events) { /* drain */ }
    assert.equal((await second.result).finalText, "done");
    assert.equal(invoked, 1, "session_started occurs only on the first committed session turn");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
