import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDragonsRuntime } from "./runtime.js";
import { createProviderRegistry } from "./provider/registry.js";
import { createSessionStore } from "./session-store.js";

test("M75 runtime bounds pending execution admissions before invoking slow storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-admission-cap-"));
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => { throw new Error("Provider must not start."); } }]);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let acquired = 0;
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: { ...createSessionStore(join(root, "sessions")), acquireExecution: async () => { acquired++; await gate; return async () => {}; } },
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"), tools: [],
  });
  const admissions: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 129; i++) admissions.push(runtime.sendUserInput({ sessionId: randomUUID(), content: "test" }).catch(() => {}));
    assert.equal(acquired, 128);
  } finally { await runtime.dispose(); release(); await Promise.all(admissions); await rm(root, { recursive: true, force: true }); }
});
