import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel } from "../../dist/agent.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";
import type { AgentTool } from "../../dist/tools.js";

test("an unattended read-only turn preserves context without inheriting session WRITE approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-read-only-input-"));
  let invoked = 0;
  let turn = 0;
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) return { responseId: "first", text: "", toolCalls: [{ callId: "one", name: "write_fixture", arguments: "{}" }] };
      if (turn === 2) {
        assert.deepEqual(request.toolOutputs, [{ callId: "one", output: "wrote" }]);
        return { responseId: "prior-turn", text: "Approved.", toolCalls: [] };
      }
      if (turn === 3) {
        assert.equal(request.conversationResponseId, "prior-turn");
        assert.ok(request.tools.every((tool) => tool.operation === "READ"));
        assert.equal(request.tools.some((tool) => tool.name === "write_fixture"), false);
        assert.equal(request.tools.some((tool) => tool.name === "untrusted_read"), false);
        assert.equal(request.tools.some((tool) => tool.name === "read_file"), true);
        return { responseId: "restricted", text: "", toolCalls: [{ callId: "two", name: "write_fixture", arguments: "{}" }] };
      }
      assert.match(request.toolOutputs?.[0]?.output ?? "", /Unknown tool: write_fixture/);
      return { responseId: "restricted-final", text: "Read-only.", toolCalls: [] };
    },
  };
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "model", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => model,
  }]);
  const writeTool: AgentTool = { name: "write_fixture", operation: "WRITE", description: "Fixture write", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { invoked += 1; return { ok: true, output: "wrote" }; } };
  const untrustedRead: AgentTool = { name: "untrusted_read", operation: "READ", description: "Host-supplied read", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { invoked += 1; return { ok: true, output: "untrusted" }; } };
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [writeTool, untrustedRead], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession({ provider: "fixture" });
    const first = await runtime.sendUserInput({ sessionId: session.id, content: "First turn" });
    for await (const event of first.events) {
      if (event.type === "approval_requested") assert.equal(runtime.resolveAuthorization({ runId: first.id, approvalId: event.approvalId, decision: "allow_session" }), true);
    }
    await first.result;
    assert.equal(invoked, 1);
    const restrictedInput = { sessionId: session.id, content: "Keep checking", readOnly: true };
    const restricted = await runtime.sendUserInput(restrictedInput);
    let requested = 0;
    for await (const event of restricted.events) if (event.type === "approval_requested") requested += 1;
    assert.equal((await restricted.result).finalText, "Read-only.");
    assert.equal(requested, 0);
    assert.equal(invoked, 1);
    assert.equal((await runtime.resumeSession(session.id)).messageCount, 4);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
