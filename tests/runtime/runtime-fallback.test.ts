import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { RuntimeDiagnosticsService } from "../../dist/diagnostics.js";
import { createSessionStore } from "../../dist/session-store.js";
import { parseDragonsConfig, saveDragonsConfig, loadDragonsConfig } from "../../dist/config.js";
import { configureProfileReasoning } from "../../dist/reasoning-preferences.js";
import { createProviderRegistry, type ProviderDescriptor } from "../../dist/provider/registry.js";
import { ProviderRequestFailureBoundary } from "../../dist/provider/compatibility.js";

const fallback = { enabled: true, consent: "allow-context-sharing" as const, targets: [{ provider: "target", model: "target-exact" }] };
function failure() { const b = new ProviderRequestFailureBoundary(); b.httpFailure(503, null); return b.finish(new Error("fixture unavailable")); }
const descriptor = (id: string, createModel: ProviderDescriptor["createModel"]): ProviderDescriptor => ({ id, label: id, defaultModel: `${id}-exact`, credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel });

test("persisted fallback requires bounded explicit consent", () => {
  assert.throws(() => parseDragonsConfig({ fallback: { ...fallback, consent: undefined } }, ["target"]), /consent/);
  assert.throws(() => parseDragonsConfig({ fallback: { ...fallback, targets: Array(4).fill(fallback.targets[0]) } }, ["target"]), /three targets/);
  assert.throws(() => parseDragonsConfig({ fallback }, ["local"]), /registered/);
  assert.deepEqual(parseDragonsConfig({}, ["local"]), {});
});

for (const mode of ["success", "target-failure", "adoption-failure", "cancel-during-adoption", "cancel-after-adoption", "cancel", "continuation", "stream"] as const) test(`runtime fallback persistence ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-fallback-runtime-"));
  const diagnostics = new RuntimeDiagnosticsService();
  let targetCalls = 0;
  let resumed = false;
  const store = createSessionStore(join(root, "sessions"), { providerIds: ["primary", "target"] });
  let sessionId = "";
  let adoptionStarted!: () => void;
  let releaseAdoption!: () => void;
  let cancelAfterAdoption: (() => boolean) | undefined;
  const adopting = new Promise<void>(resolve => { adoptionStarted = resolve; });
  const released = new Promise<void>(resolve => { releaseAdoption = resolve; });
  const providers = createProviderRegistry([
    descriptor("primary", () => ({ async respond(request, delta) {
      if (mode === "cancel") { const e = new Error("cancelled"); e.name = "AbortError"; throw e; }
      if (mode === "stream") delta?.("partial");
      throw failure();
    } })),
    descriptor("target", () => ({ async respond(request) {
      targetCalls++;
      const durable = await store.load(sessionId);
      assert.equal(durable?.provider, "target");
      assert.equal(durable?.model, "target-exact");
      assert.equal(request.conversationResponseId, resumed ? "target-response" : undefined);
      assert.deepEqual(request.continuationState, resumed ? { owner: "target" } : undefined);
      if (mode === "target-failure") throw new Error("target request failed");
      return { responseId: "target-response", text: "done", toolCalls: [], continuationState: { owner: "target" } };
    } })),
  ]);
  const path = join(root, "config.json");
  await saveDragonsConfig({ fallback }, path, providers.ids());
  configureProfileReasoning(providers, await loadDragonsConfig(path, providers.ids()), path);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers, diagnostics,
    sessionStore: mode === "adoption-failure" ? { ...store, mutate: async () => { throw new Error("fixture save denied"); } }
      : mode === "cancel-during-adoption" ? { ...store, mutate: async (id, update) => {
        adoptionStarted();
        await released;
        return store.mutate!(id, update);
      } } : mode === "cancel-after-adoption" ? { ...store, mutate: async (id, update) => {
        const saved = await store.mutate!(id, update);
        cancelAfterAdoption?.();
        return saved;
      } } : store,
    tools: [], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession({ provider: "primary" }); sessionId = session.id;
    if (mode === "continuation") { const s = (await store.load(sessionId))!; await store.save({ ...s, continuation: { responseId: "old" } }); }
    const run = await runtime.sendUserInput({ sessionId, content: "hello" });
    cancelAfterAdoption = () => run.cancel();
    if (mode === "cancel-during-adoption") {
      await adopting;
      assert.equal(run.cancel(), true);
      releaseAdoption();
    }
    if (mode === "target-failure") {
      await assert.rejects(run.result, /target request failed/);
      assert.equal(targetCalls, 1);
      const durable = (await store.load(sessionId))!;
      assert.equal(durable.provider, "target");
      assert.equal(durable.model, "target-exact");
      assert.equal(durable.continuation, undefined);
      assert.equal((await runtime.resumeSession(sessionId)).provider, "target");
    } else if (mode === "cancel-after-adoption") {
      await assert.rejects(run.result);
      assert.equal(targetCalls, 0);
      assert.equal((await store.load(sessionId))?.provider, "target");
      assert.equal(diagnostics.recent()[0]!.status, "cancelled");
    } else if (mode !== "success") {
      await assert.rejects(run.result);
      assert.equal(targetCalls, 0);
      assert.equal((await store.load(sessionId))?.provider, "primary");
    } else {
      const events = []; for await (const event of run.events) events.push(event);
      await run.result;
      assert.equal(diagnostics.recent()[0]!.provider, "target");
      assert.equal(diagnostics.recent()[0]!.model, "target-exact");
      assert.deepEqual(diagnostics.recent()[0]!.initialIdentity, { provider: "primary", model: "primary-exact" });
      assert.ok(events.some((e) => e.type === "assistant_delta" && e.text.includes("Provider fallback: target")));
      assert.equal((await runtime.resumeSession(sessionId)).provider, "target");
      resumed = true;
      await (await runtime.sendUserInput({ sessionId, content: "again" })).result;
      assert.equal(targetCalls, 2);
      assert.equal((await store.load(sessionId))?.continuation?.responseId, "target-response");
      assert.equal((await runtime.createSession({ provider: "primary" })).provider, "primary");
    }
    const first = diagnostics.recent().at(-1)!;
    const adopted = mode === "success" || mode === "target-failure" || mode === "cancel-after-adoption";
    assert.equal(first.provider, adopted ? "target" : "primary");
    assert.equal(first.model, adopted ? "target-exact" : "primary-exact");
    assert.equal(first.sessionId, sessionId);
    assert.doesNotMatch(JSON.stringify(first), /fixture|hello|target request failed/);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
