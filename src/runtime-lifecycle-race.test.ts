import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

for (const kind of ["foreground", "background"] as const) {
  for (const boundary of ["store", "caller"] as const) {
  test(`M71 rejects ${kind} admission after disposal at the ${boundary} boundary`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-runtime-admission-"));
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const loading = new Promise<void>((resolve) => { entered = resolve; });
    let modelCalls = 0;
    const providers = createProviderRegistry([{
      id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
      capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
      createModel: () => ({ async respond() {
        modelCalls += 1;
        return { responseId: "fixture", text: "Finished", toolCalls: [] };
      } }),
    }]);
    const store = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
    let disposeAtLookup = false;
    let scheduleDisposal = (): void => {};
    const getProvider = providers.get.bind(providers);
    providers.get = (id) => {
      const provider = getProvider(id);
      if (disposeAtLookup) { disposeAtLookup = false; scheduleDisposal(); }
      return provider;
    };
    const runtime = await createDragonsRuntime({
      workingDirectory: root, providerRegistry: providers,
      sessionStore: { ...store, async load(id) {
        const session = await store.load(id);
        entered();
        await barrier;
        return session;
      } },
      tools: [], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
    });
    scheduleDisposal = () => { queueMicrotask(() => { void runtime.dispose(); }); };
    try {
      const session = await runtime.createSession();
      disposeAtLookup = boundary === "caller";
      const admission = kind === "foreground"
        ? runtime.sendUserInput({ sessionId: session.id, content: "Fixture request" })
        : runtime.startBackgroundTask({ sessionId: session.id, prompt: "Fixture request" });
      const outcome = admission.then(async (result) => {
        if ("result" in result) await result.result;
        return undefined;
      }, (error: unknown) => error);
      await loading;
      if (boundary === "store") await runtime.dispose();
      release();
      const error = await outcome;
      assert.ok(error instanceof Error && /disposed/.test(error.message));
      assert.equal(modelCalls, 0);
    } finally {
      release();
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  }
}
