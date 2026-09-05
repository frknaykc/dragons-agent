import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { BackgroundTaskManager } from "./background-tasks.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

test("M71 dispose aborts its owned background task without persisting a completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-background-dispose-"));
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  let signal: AbortSignal | undefined;
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return {
        async respond(request) {
          signal = request.signal;
          started();
          await new Promise<never>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
          throw new Error("Cancelled background work must not complete.");
        },
      };
    },
  };
  const providers = createProviderRegistry([provider]);
  const manager = new BackgroundTaskManager();
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [],
    backgroundTasks: manager,
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const task = await runtime.startBackgroundTask({ sessionId: session.id, prompt: "Wait in the background." });
    await modelStarted;
    await runtime.dispose();
    assert.equal(signal?.aborted, true);
    assert.equal(manager.show(task.id)?.state, "cancelled");
    assert.equal(manager.show(task.id)?.report, undefined);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
