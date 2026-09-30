import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "../../dist/agent.js";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import { createDesktopSessionLoopService } from "../../dist/desktop/session-loop-service.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

async function fixture(model: AgentModel) {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-loop-"));
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => model,
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), tools: [] });
  const service = createDesktopSessionLoopService(runtime);
  const events: string[] = [];
  const local = { loop: service.command, loopActivity: service.markActivity, close: service.close } as DesktopLocalControls;
  const bridge = new DesktopBridge(runtime, (event) => events.push(event.type), local);
  return { bridge, runtime, service, events, async close() { await bridge.close(); await rm(root, { recursive: true, force: true }); } };
}

async function slash(bridge: DesktopBridge, content: string): Promise<string> {
  const result = await bridge.request({ type: "slash", content });
  assert.equal(result.ok, true, JSON.stringify(result));
  return JSON.stringify(result);
}

test("Desktop slash starts a bounded READ-only session loop; status never reveals its prompt", { timeout: 10_000 }, async () => {
  const calls: string[] = [];
  const f = await fixture({ async respond(request) {
    calls.push(request.task);
    assert.ok(request.tools.length > 0 && request.tools.every((tool) => tool.operation === "READ"));
    return { responseId: "loop-response", text: "private report", toolCalls: [] };
  } });
  try {
    assert.equal((await f.bridge.request({ type: "slash", content: "/loop status" })).ok, false);
    const session = await f.bridge.request({ type: "create", provider: "fixture" });
    assert.equal(session.ok, true);
    if (!session.ok) throw new Error("Missing session.");
    assert.match(await slash(f.bridge, "/help loop"), /\/loop/);
    assert.match(await slash(f.bridge, "/loop start 0 1 -- invalid"), /Usage: \/loop/);
    assert.match(await slash(f.bridge, "/loop start 1 1 -- inspect private workspace"), /Loop started/);
    assert.doesNotMatch(await slash(f.bridge, "/loop status"), /inspect private workspace/);
    for (let i = 0; i < 200 && !((await slash(f.bridge, "/loop status")).includes("completed: 1")); i += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, ["inspect private workspace"]);
    assert.match(await slash(f.bridge, "/loop status"), /stopped.*completed: 1.*private report/);
    assert.equal((await f.runtime.status({ sessionId: (session.value as { id: string }).id })).session?.messageCount, 2);
    assert.deepEqual(f.events, [], "unattended run events must not be presented as an interactive run");
    assert.match(await slash(f.bridge, "/heartbeat start 1 2 1 -- read again"), /Heartbeat started/);
    assert.match(await slash(f.bridge, "/heartbeat stop"), /stopped/);
    assert.match(await slash(f.bridge, "/loop status"), /No Loop/);
  } finally { await f.close(); }
});

test("Desktop session switch and shutdown abort an active timer; no late report crosses sessions", { timeout: 10_000 }, async () => {
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  const f = await fixture({ async respond(request) {
    entered();
    await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    throw new DOMException("Aborted", "AbortError");
  } });
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "fixture" })).ok, true);
    await slash(f.bridge, "/loop start 1 1 -- read status");
    await running;
    assert.match(await slash(f.bridge, "/loop status"), /active: true/);
    const changed = await f.bridge.request({ type: "create", provider: "fixture" });
    assert.equal(changed.ok, true);
    assert.equal(aborted, true);
    assert.match(await slash(f.bridge, "/loop status"), /No Loop/);
    assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
