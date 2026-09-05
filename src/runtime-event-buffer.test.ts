import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime, DEFAULT_MAX_RUNTIME_QUEUED_EVENTS, type RuntimeEvent } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

test("M71 bounds a slow client's queued runtime events and reports truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-events-"));
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return {
        async respond(_request, onTextDelta) {
          for (let index = 0; index < DEFAULT_MAX_RUNTIME_QUEUED_EVENTS * 4; index += 1) onTextDelta?.(`delta-${index} `);
          return { responseId: "overflow", text: "complete", textWasStreamed: true, toolCalls: [] };
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
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Stream enough output to overflow a slow client." });
    await run.result;
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    assert.ok(events.length <= DEFAULT_MAX_RUNTIME_QUEUED_EVENTS);
    assert.equal(events.some((event) => event.type === "event_stream_truncated"), true);
    assert.equal(events.at(-1)?.type, "run_completed");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

for (const sharedIterator of [false, true]) {
test(`M71 bounds concurrent runtime event waiters (${sharedIterator ? "one iterator" : "distinct iterators"})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-waiters-"));
  let releaseModel!: () => void;
  const modelRelease = new Promise<void>((resolve) => { releaseModel = resolve; });
  let modelStarted!: () => void;
  const modelStartedPromise = new Promise<void>((resolve) => { modelStarted = resolve; });
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return {
        async respond(_request, onTextDelta) {
          modelStarted();
          await modelRelease;
          for (let index = 0; index < DEFAULT_MAX_RUNTIME_QUEUED_EVENTS; index += 1) onTextDelta?.(`delta-${index} `);
          return { responseId: "waiter-cap", text: "complete", textWasStreamed: true, toolCalls: [] };
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
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Hold until the waiter cap is exercised." });
    const first = await run.events[Symbol.asyncIterator]().next();
    assert.equal(first.value?.type, "run_started");
    await modelStartedPromise;
    const iterator = run.events[Symbol.asyncIterator]();
    const pending = Array.from(
      { length: DEFAULT_MAX_RUNTIME_QUEUED_EVENTS + 1 },
      () => (sharedIterator ? iterator : run.events[Symbol.asyncIterator]()).next(),
    );
    releaseModel();
    const settled = await Promise.all(pending);
    assert.equal(settled.slice(0, DEFAULT_MAX_RUNTIME_QUEUED_EVENTS).every((result) => result.done === false), true);
    assert.equal(settled.at(-1)?.done, true);
    await run.result;
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
}
