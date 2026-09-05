import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

function fixtureProvider(createModel: ProviderDescriptor["createModel"]): ProviderDescriptor {
  return {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel,
  };
}

test("M71 redacts provider failures before they reach a runtime client", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-error-"));
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond() {
      throw new Error("api_key=fixture-provider-error-secret-1234567890");
    },
  }))]);
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
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Trigger the fixture error." });
    const failureResult = assert.rejects(run.result, (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).name, "RuntimeRunError");
      assert.match((error as Error).message, /\[REDACTED\]/);
      assert.doesNotMatch((error as Error).message, /fixture-provider-error-secret/);
      assert.equal("cause" in (error as object), false);
      return true;
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    const failure = events.find((event): event is Extract<RuntimeEvent, { type: "run_failed" }> => event.type === "run_failed");
    assert.ok(failure);
    assert.match(failure.message, /\[REDACTED\]/);
    assert.doesNotMatch(failure.message, /fixture-provider-error-secret/);
    await failureResult;
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 redacts Basic authorization credentials before they reach a runtime client", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-error-"));
  const credentialPayload = "Zml4dHVyZS11c2VyOmZpeHR1cmUtc2VjcmV0";
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond() {
      throw new Error(`Authorization: Basic ${credentialPayload}`);
    },
  }))]);
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
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Trigger the fixture error." });
    const failureResult = assert.rejects(run.result, (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).name, "RuntimeRunError");
      assert.equal((error as Error).message.includes(credentialPayload), false);
      return true;
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    const failure = events.find((event): event is Extract<RuntimeEvent, { type: "run_failed" }> => event.type === "run_failed");
    assert.ok(failure);
    assert.equal(failure.message.includes(credentialPayload), false);
    await failureResult;
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 redacts quoted JSON Basic authorization credentials before they reach a runtime client", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-error-"));
  const credentialPayload = "cXVvdGVkLXVzZXI6Zml4dHVyZS1zZWNyZXQ=";
  const providers = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond() {
      throw new Error(`provider failed with {"authorization":"Basic ${credentialPayload}"}`);
    },
  }))]);
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
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Trigger the fixture error." });
    const failureResult = assert.rejects(run.result, (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).name, "RuntimeRunError");
      assert.equal((error as Error).message.includes(credentialPayload), false);
      return true;
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    const failure = events.find((event): event is Extract<RuntimeEvent, { type: "run_failed" }> => event.type === "run_failed");
    assert.ok(failure);
    assert.equal(failure.message.includes(credentialPayload), false);
    await failureResult;
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
