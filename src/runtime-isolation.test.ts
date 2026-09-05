import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

function provider(id: "alpha" | "beta", models: string[]): ProviderDescriptor {
  return {
    id,
    label: `${id} fixture`,
    defaultModel: `${id}-default`,
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(options): AgentModel {
      const model = options.model ?? `${id}-default`;
      models.push(model);
      return {
        async respond() {
          return { responseId: `${id}-${model}`, text: `${id}:${model}`, toolCalls: [] };
        },
      };
    },
  };
}

test("M71 isolates provider, model, session, and diagnostics state across runtime instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-isolation-"));
  const alphaModels: string[] = [];
  const betaModels: string[] = [];
  const alphaRegistry = createProviderRegistry([provider("alpha", alphaModels)]);
  const betaRegistry = createProviderRegistry([provider("beta", betaModels)]);
  const sessionDirectory = join(root, "sessions");
  const alpha = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: alphaRegistry,
    sessionStore: createSessionStore(sessionDirectory, { providerIds: alphaRegistry.ids() }),
    tools: [],
    memoryDirectory: join(root, "alpha-memory"),
    skillsDirectory: join(root, "skills"),
  });
  const beta = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: betaRegistry,
    sessionStore: createSessionStore(sessionDirectory, { providerIds: betaRegistry.ids() }),
    tools: [],
    memoryDirectory: join(root, "beta-memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const alphaSession = await alpha.createSession({ provider: "alpha", model: "alpha-selected" });
    const betaSession = await beta.createSession({ provider: "beta", model: "beta-selected" });
    const [alphaRun, betaRun] = await Promise.all([
      alpha.sendUserInput({ sessionId: alphaSession.id, content: "Run alpha." }),
      beta.sendUserInput({ sessionId: betaSession.id, content: "Run beta." }),
    ]);
    await Promise.all([
      (async () => { for await (const _event of alphaRun.events) { /* Drain. */ } })(),
      (async () => { for await (const _event of betaRun.events) { /* Drain. */ } })(),
    ]);
    assert.equal((await alphaRun.result).finalText, "alpha:alpha-selected");
    assert.equal((await betaRun.result).finalText, "beta:beta-selected");
    assert.deepEqual(alphaModels, ["alpha-selected"]);
    assert.deepEqual(betaModels, ["beta-selected"]);
    assert.deepEqual(alpha.providers().map((entry) => entry.id), ["alpha"]);
    assert.deepEqual(beta.providers().map((entry) => entry.id), ["beta"]);
    await assert.rejects(beta.resumeSession(alphaSession.id), /not found|unreadable|different workspace/i);
    assert.deepEqual((await alpha.status({ sessionId: alphaSession.id })).recentDiagnostics.map((entry) => entry.provider), ["alpha"]);
    assert.deepEqual((await beta.status({ sessionId: betaSession.id })).recentDiagnostics.map((entry) => entry.provider), ["beta"]);
  } finally {
    await Promise.all([alpha.dispose(), beta.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});
