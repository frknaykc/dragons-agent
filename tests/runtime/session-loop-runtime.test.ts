import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createRuntimeSessionLoop } from "../../dist/session-loop-runtime.js";

test("session timer continues the real runtime session with built-in READ tools and a bounded run", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-session-timer-"));
  let turn = 0;
  let activeSignal: AbortSignal | undefined;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "model", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      turn++;
      if (turn === 1) return { responseId: "first", text: "Earlier context", toolCalls: [] };
      assert.equal(request.conversationResponseId, "first");
      assert.ok(request.tools.length > 0 && request.tools.every((tool) => tool.operation === "READ"));
      assert.equal(request.tools.some((tool) => tool.name === "write_fixture"), false);
      activeSignal = request.signal;
      return { responseId: "second", text: "Continued", toolCalls: [] };
    } }),
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [{ name: "write_fixture", operation: "WRITE", description: "Fixture", inputSchema: { type: "object", properties: {} }, async execute() { assert.fail("Write reached unattended turn"); } }],
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const foreground = await runtime.sendUserInput({ sessionId: session.id, content: "Initial" });
    for await (const _event of foreground.events) { /* drain */ }
    await foreground.result;
    const reports: string[] = [];
    const loop = createRuntimeSessionLoop({ runtime, config: { sessionId: session.id, prompt: "Check", intervalMs: 1_000, maxRuns: 1 },
      onResult: (_id, text) => reports.push(text), onError(error) { throw error; } });
    loop.start();
    assert.equal(await loop.tick(), true);
    assert.deepEqual(reports, ["Continued"]);
    assert.equal(loop.status().running, false);
    assert.equal(loop.status().completed, 1);
    assert.equal((await runtime.resumeSession(session.id)).messageCount, 4);
    assert.equal(activeSignal?.aborted, false);
    await loop.stop();
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("session timer aborts an active model on stop without publishing a result", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-session-stop-"));
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let wasAborted = false;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "model", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      started();
      await new Promise<never>((_resolve, reject) => request.signal?.addEventListener("abort", () => { wasAborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true }));
      throw new Error("Unreachable");
    } }),
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const reports: string[] = [];
    const loop = createRuntimeSessionLoop({ runtime, config: { sessionId: session.id, prompt: "Check", intervalMs: 1_000, maxRuns: 1 },
      onResult: (_id, text) => reports.push(text), onError(error) { throw error; } });
    loop.start();
    const pending = loop.tick();
    await entered;
    await loop.stop();
    assert.equal(await pending, false);
    assert.equal(wasAborted, true);
    assert.deepEqual(reports, []);
    assert.equal((await runtime.resumeSession(session.id)).messageCount, 0);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
