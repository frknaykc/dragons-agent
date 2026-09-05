import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentModel } from "./agent.js";
import { McpClientManager } from "./mcp-client.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

const mcpFixture = fileURLToPath(new URL("./mcp-mock-server.js", import.meta.url));

test("M71 cannot disconnect an MCP connection that its runtime did not open", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-mcp-ownership-"));
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return { async respond() { return { responseId: "unused", text: "unused", toolCalls: [] }; } };
    },
  };
  const providers = createProviderRegistry([provider]);
  const manager = new McpClientManager([{ id: "fixture", command: process.execPath, args: [mcpFixture] }]);
  await manager.connect("fixture");
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [],
    mcpManager: manager,
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    await assert.rejects(runtime.disconnectMcp("fixture"), /not owned by this runtime/);
    assert.equal(manager.status()[0]?.state, "connected");
    await runtime.dispose();
    assert.equal(manager.status()[0]?.state, "connected");
  } finally {
    await runtime.dispose();
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 keeps a shared MCP connection alive until every runtime-owned lease is released", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-mcp-lease-"));
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return { async respond() { return { responseId: "unused", text: "unused", toolCalls: [] }; } };
    },
  };
  const providers = createProviderRegistry([provider]);
  const manager = new McpClientManager([{ id: "fixture", command: process.execPath, args: [mcpFixture] }]);
  const first = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "first-sessions"), { providerIds: providers.ids() }),
    tools: [],
    mcpManager: manager,
    memoryDirectory: join(root, "first-memory"),
    skillsDirectory: join(root, "skills"),
  });
  const second = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "second-sessions"), { providerIds: providers.ids() }),
    tools: [],
    mcpManager: manager,
    memoryDirectory: join(root, "second-memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    await Promise.all([first.connectMcp("fixture"), second.connectMcp("fixture")]);
    await first.dispose();
    assert.equal(manager.status()[0]?.state, "connected");
    await second.disconnectMcp("fixture");
    assert.equal(manager.status()[0]?.state, "disconnected");
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("M71 leases a runtime-owned MCP connection to a later runtime client", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-mcp-later-lease-"));
  const provider: ProviderDescriptor = {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return { async respond() { return { responseId: "unused", text: "unused", toolCalls: [] }; } };
    },
  };
  const providers = createProviderRegistry([provider]);
  const manager = new McpClientManager([{ id: "fixture", command: process.execPath, args: [mcpFixture] }]);
  const first = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "first-sessions"), { providerIds: providers.ids() }),
    tools: [],
    mcpManager: manager,
    memoryDirectory: join(root, "first-memory"),
    skillsDirectory: join(root, "skills"),
  });
  const second = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "second-sessions"), { providerIds: providers.ids() }),
    tools: [],
    mcpManager: manager,
    memoryDirectory: join(root, "second-memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    await first.connectMcp("fixture");
    await second.connectMcp("fixture");
    await first.dispose();
    assert.equal(manager.status()[0]?.state, "connected");
    await second.disconnectMcp("fixture");
    assert.equal(manager.status()[0]?.state, "disconnected");
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
