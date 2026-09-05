import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { McpClientManager } from "./mcp-client.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

const marker = "runtime-client-secret";

test("M71 rejects malformed client MCP IDs without echoing their content", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-mcp-security-"));
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
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [],
    mcpManager: new McpClientManager(),
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    await assert.rejects(
      runtime.connectMcp(`fixture-token=${marker}`),
      (error: unknown) => error instanceof Error && error.message === "MCP server ID is invalid." && !error.message.includes(marker),
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
