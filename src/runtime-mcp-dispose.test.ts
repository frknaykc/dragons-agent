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

test("M71 dispose closes MCP connections opened through its runtime API", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-mcp-dispose-"));
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
    await runtime.connectMcp("fixture");
    assert.equal(manager.status()[0]?.state, "connected");
    await runtime.dispose();
    assert.equal(manager.status()[0]?.state, "disconnected");
  } finally {
    await runtime.dispose();
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
