import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

async function createFixtureRuntime(root: string) {
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return {
        async respond() {
          return { responseId: "fixture", text: "unused", toolCalls: [] };
        },
      };
    },
  };
  const providers = createProviderRegistry([provider]);
  return createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });
}

test("M71 rejects a non-object createSession request with a client-safe error", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-input-"));
  const runtime = await createFixtureRuntime(root);

  try {
    await assert.rejects(
      runtime.createSession(null as never),
      { message: "Runtime session options must be an object." },
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 rejects a non-string runtime model with a client-safe error", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-input-"));
  const runtime = await createFixtureRuntime(root);

  try {
    await assert.rejects(
      runtime.createSession({ model: 42 } as never),
      { message: "Runtime model must be a bounded non-empty string." },
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 rejects a non-string runtime provider with a client-safe error", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-input-"));
  const runtime = await createFixtureRuntime(root);

  try {
    await assert.rejects(
      runtime.createSession({ provider: 42 } as never),
      { message: "Runtime provider ID must be a string." },
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 rejects an unavailable provider without reflecting client input", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-input-"));
  const runtime = await createFixtureRuntime(root);
  const marker = "fixture-invalid-provider-secret";

  try {
    await assert.rejects(
      runtime.createSession({ provider: `api_key=${marker}` } as never),
      (error: unknown) => error instanceof Error
        && error.message === "Runtime provider is unavailable."
        && !error.message.includes(marker),
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 rejects a non-object status request with a client-safe error", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-input-"));
  const runtime = await createFixtureRuntime(root);

  try {
    await assert.rejects(
      runtime.status(null as never),
      { message: "Runtime status options must be an object." },
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 rejects a non-string status session ID with a client-safe error", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-input-"));
  const runtime = await createFixtureRuntime(root);

  try {
    await assert.rejects(
      runtime.status({ sessionId: 42 } as never),
      { message: "Runtime session ID must be a string." },
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
