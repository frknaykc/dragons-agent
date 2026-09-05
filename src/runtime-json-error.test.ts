import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

const marker = "json-runtime-error-secret";

test("M71 redacts JSON-shaped credentials from client-facing runtime failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-json-error-"));
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return {
        async respond() {
          throw new Error(`provider failed with {"access_token":"${marker}"}`);
        },
      };
    },
  };
  const providers = createProviderRegistry([provider]);
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Fail safely." });
    const result = assert.rejects(run.result, (error: unknown) => error instanceof Error && !error.message.includes(marker) && /\[REDACTED\]/.test(error.message));
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    const failure = events.find((event): event is Extract<RuntimeEvent, { type: "run_failed" }> => event.type === "run_failed");
    assert.equal(failure?.message.includes(marker), false);
    assert.match(failure?.message ?? "", /\[REDACTED\]/);
    await result;
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
