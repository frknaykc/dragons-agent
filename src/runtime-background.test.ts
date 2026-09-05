import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

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
          assert.equal(request.tools.some((tool) => tool.name === "write_fixture"), false);
          assert.equal(request.tools.some((tool) => tool.name === "read_fixture"), true);
          return { responseId: "background-response", text: "Bearer fixture-background-secret-1234567890", toolCalls: [] };
        },
      };
    },
  };
}

async function waitForTerminalTask(
  list: () => Promise<readonly { state: string }[]>,
): Promise<readonly { state: string; report?: string }[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tasks = await list();
    if (tasks[0]?.state === "completed" || tasks[0]?.state === "failed" || tasks[0]?.state === "cancelled") return tasks;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Background task did not finish in time.");
}

test("M71 exposes explicit session-bound read-only background task lifecycle safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-background-"));
  const providers = createProviderRegistry([fixtureProvider()]);
  const readTool: AgentTool = {
    name: "read_fixture",
    operation: "READ",
    description: "Read fixture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { ok: true, output: "read" }; },
  };
  const writeTool: AgentTool = {
    name: "write_fixture",
    operation: "WRITE",
    description: "Write fixture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { ok: true, output: "write" }; },
  };
  const runtime = await createDragonsRuntime({
    workingDirectory: root,
    providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [readTool, writeTool],
    memoryDirectory: join(root, "memory"),
    skillsDirectory: join(root, "skills"),
  });

  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const started = await runtime.startBackgroundTask({ sessionId: session.id, prompt: "Inspect safely in background." });
    assert.equal(started.sessionId, session.id);
    assert.equal(started.state === "queued" || started.state === "running", true);
    assert.equal("prompt" in started, false);
    assert.equal("transcript" in started, false);
    assert.deepEqual(await runtime.listBackgroundTasks("different-session"), []);
    const completed = await waitForTerminalTask(() => runtime.listBackgroundTasks(session.id));
    assert.equal(completed[0]?.state, "completed");
    assert.equal("transcript" in (completed[0] ?? {}), false);
    assert.match(completed[0]?.report ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(completed), /fixture-background-secret/);
    assert.equal(await runtime.cancelBackgroundTask({ sessionId: "different-session", taskId: started.id }), false);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
