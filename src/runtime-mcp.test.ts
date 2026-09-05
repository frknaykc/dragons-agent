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

function fixtureProvider(): ProviderDescriptor {
  return {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel(): AgentModel {
      return {
        async respond(request) {
          assert.equal(request.tools.some((tool) => tool.name.startsWith("mcp__") && tool.operation === "EXECUTE"), true);
          return { responseId: "mcp-runtime", text: "MCP is available through the runtime.", toolCalls: [] };
        },
      };
    },
  };
}

test("M71 connects existing MCP tools through a safe runtime lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-mcp-"));
  const providers = createProviderRegistry([fixtureProvider()]);
  const manager = new McpClientManager([{ id: "fixture", command: process.execPath, args: [mcpFixture, "secret-metadata"] }]);
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
    assert.deepEqual(runtime.mcpStatus().map((entry) => ({ id: entry.id, state: entry.state, authentication: entry.authentication })), [
      { id: "fixture", state: "disconnected", authentication: "none" },
    ]);
    const connected = await runtime.connectMcp("fixture");
    assert.deepEqual(connected, { id: "fixture", toolCount: 1 });
    assert.doesNotMatch(JSON.stringify(runtime.mcpStatus()), /fixture-private-marker/);
    const session = await runtime.createSession({ provider: "fixture" });
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "Use MCP safely." });
    for await (const _event of run.events) { /* Drain. */ }
    assert.equal((await run.result).finalText, "MCP is available through the runtime.");
    await runtime.disconnectMcp("fixture");
    assert.equal(runtime.mcpStatus()[0]?.state, "disconnected");
  } finally {
    await runtime.dispose();
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
