import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "../../dist/agent.js";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import { createDesktopPersistentGoalService } from "../../dist/desktop/persistent-goal-service.js";
import { createFilePersistentGoalStore, goalWorkspaceDirectory } from "../../dist/persistent-goal-store.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

async function fixture(model: AgentModel) {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-goals-"));
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "model", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => model,
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), tools: [] });
  const workspace = await realpath(root);
  const goalRoot = join(root, "profile", "goals");
  const service = createDesktopPersistentGoalService(runtime, goalRoot, workspace);
  const bridge = new DesktopBridge(runtime, () => assert.fail("Unattended events must not appear as interactive events."),
    { goal: service.command, close: service.close } as DesktopLocalControls);
  return { root, runtime, goalRoot, workspace, service, bridge, async close() { await bridge.close(); await rm(root, { recursive: true, force: true }); } };
}

async function slash(bridge: DesktopBridge, content: string) {
  const result = await bridge.request({ type: "slash", content });
  assert.equal(result.ok, true, JSON.stringify(result));
  const value = result.ok ? result.value as { kind: string; text: string } : undefined;
  if (value?.kind !== "text") throw new Error("Expected text response.");
  return value.text;
}

const deadline = () => new Date(Date.now() + 60_000).toISOString();

test("Desktop goals are session-bound and durable; only explicit user confirmation completes a model turn", async () => {
  let calls = 0;
  const f = await fixture({ async respond(request) {
    calls++;
    assert.ok(request.tools.length > 0 && request.tools.every((tool) => tool.operation === "READ"));
    return { responseId: `r-${calls}`, text: "Model claims completion", toolCalls: [] };
  } });
  try {
    assert.equal((await f.bridge.request({ type: "slash", content: "/goal list" })).ok, false);
    const created = await f.bridge.request({ type: "create", provider: "fixture" });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("Missing session.");
    assert.match(await slash(f.bridge, "/help goal"), /\/goal/);
    assert.match(await slash(f.bridge, "/goal add nope"), /Usage: \/goal/);
    const added = await slash(f.bridge, `/goal add 2 ${deadline()} -- Review outstanding items -- User confirms review`);
    const id = added.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i)?.[0];
    assert.ok(id);
    assert.match(await slash(f.bridge, "/goal list"), new RegExp(id));
    assert.doesNotMatch(await slash(f.bridge, "/goal list"), /Review outstanding items|User confirms review/);
    assert.match(await slash(f.bridge, `/goal status ${id}`), /User confirms review/);
    assert.match(await slash(f.bridge, `/goal complete ${id}`), /cannot make that transition/);
    assert.match(await slash(f.bridge, `/goal run ${id}`), /ready.*Model claims completion/);
    assert.match(await slash(f.bridge, `/goal run ${id}`), /exhausted.*Model claims completion/);
    assert.equal(calls, 2);
    assert.match(await slash(f.bridge, `/goal complete ${id}`), /completed/);
    assert.match(await slash(f.bridge, `/goal run ${id}`), /not ready/);
    const persisted = createFilePersistentGoalStore(goalWorkspaceDirectory(f.goalRoot, f.workspace));
    assert.equal((await persisted.load(id))?.turnsUsed, 2);
    assert.equal((await persisted.load(id))?.state, "completed");
    const reopened = createDesktopPersistentGoalService(f.runtime, f.goalRoot, f.workspace);
    assert.match(await reopened.command({ action: "list", sessionId: (created.value as { id: string }).id }), new RegExp(id));
    await reopened.close();
    assert.equal((await f.bridge.request({ type: "create", provider: "fixture" })).ok, true);
    assert.equal(await slash(f.bridge, "/goal list"), "No goals for this session.");
    assert.equal(await slash(f.bridge, `/goal status ${id}`), "Goal not found in this session.");
  } finally { await f.close(); }
});

test("Desktop shutdown aborts a goal run and seals its reserved turn as interrupted", { timeout: 10_000 }, async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  const f = await fixture({ async respond(request) {
    entered();
    await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    throw new DOMException("Aborted", "AbortError");
  } });
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "fixture" })).ok, true);
    const added = await slash(f.bridge, `/goal add 2 ${deadline()} -- Review -- User confirms`);
    const id = added.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i)?.[0];
    assert.ok(id);
    const run = f.bridge.request({ type: "slash", content: `/goal run ${id}` });
    await started;
    assert.equal((await f.bridge.request({ type: "create", provider: "fixture" })).ok, false);
    await f.bridge.close();
    assert.equal((await run).ok, false);
    assert.equal(aborted, true);
    const persisted = createFilePersistentGoalStore(goalWorkspaceDirectory(f.goalRoot, f.workspace));
    assert.equal((await persisted.load(id))?.state, "interrupted");
    assert.equal((await persisted.load(id))?.turnsUsed, 1);
  } finally { await f.close(); }
});
