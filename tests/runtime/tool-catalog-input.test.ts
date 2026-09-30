import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { main } from "../../dist/cli.js";
import type { AgentModel } from "../../dist/agent.js";
import type { AgentTool } from "../../dist/tools.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";

async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "dragons-tool-catalog-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = createSessionStore(join(path, "sessions"));
  let executions = 0; let turns = 0;
  const tools: AgentTool[] = Array.from({ length: 30 }, (_, index) => ({
    name: `fixture_catalog_${index}`, operation: "READ", description: index === 13 ? "rare telescope instrument" : `ordinary instrument ${index}`,
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
    async execute() { executions++; return { ok: true, output: "instrument observation" }; },
  }));
  const model: AgentModel = { async respond(request) {
    turns++;
    if (turns === 1) {
      assert.ok(request.tools.some(tool => tool.name === "tool_search"));
      assert.ok(!request.tools.some(tool => tool.name === "fixture_catalog_13"));
      return { responseId: "s", text: "", toolCalls: [{ callId: "s", name: "tool_search", arguments: '{"query":"rare telescope"}' }] };
    }
    if (turns === 2) {
      assert.match(request.toolOutputs[0]!.output, /fixture_catalog_13/);
      return { responseId: "d", text: "", toolCalls: [{ callId: "d", name: "tool_describe", arguments: '{"names":["fixture_catalog_13"]}' }] };
    }
    if (turns === 3) {
      assert.match(request.toolOutputs[0]!.output, /inputSchema/);
      assert.ok(request.tools.some(tool => tool.name === "fixture_catalog_13"));
      return { responseId: "e", text: "", toolCalls: [{ callId: "e", name: "fixture_catalog_13", arguments: '{"target":"fixture"}' }] };
    }
    assert.match(request.toolOutputs[0]!.output, /instrument observation/);
    return { responseId: "done", text: "observed", toolCalls: [] };
  } };
  return { path, store, tools, model, executions: () => executions, turns: () => turns };
}

test("CLI one-shot composition discovers and activates a hidden tool", async t => {
  const f = await fixture(t);
  await main(["inspect instrument"], { workingDirectory: f.path, configPath: join(f.path, "config.json"), sessionDirectory: join(f.path, "sessions"), memoryDirectory: join(f.path, "memory"), skillsDirectory: join(f.path, "skills"), config: {}, tools: f.tools, model: f.model, input: Readable.from([]), write() {} });
  assert.equal(f.turns(), 4); assert.equal(f.executions(), 1);
});

test("Desktop bridge composition discovers and activates a hidden tool", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const registry = createProviderRegistry([{ id: "openai-api", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel: () => f.model }]);
  const runtime = await createDragonsRuntime({ workingDirectory: f.path, providerRegistry: registry, sessionStore: f.store, memoryDirectory: join(f.path, "memory"), skillsDirectory: join(f.path, "skills"), tools: f.tools });
  let finish!: () => void; const completed = new Promise<void>(resolve => { finish = resolve; }); const events: RuntimeEvent[] = [];
  const bridge = new DesktopBridge(runtime, event => { events.push(event); if (event.type === "run_completed" || event.type === "run_failed") finish(); });
  t.after(async () => { await bridge.close(); await runtime.dispose(); });
  assert.equal((await bridge.request({ type: "create", provider: "openai-api", model: "fixture" })).ok, true);
  assert.equal((await bridge.request({ type: "send", content: "inspect instrument" })).ok, true);
  await completed;
  assert.ok(events.some(event => event.type === "run_completed"), JSON.stringify(events.filter(event => event.type === "run_failed")));
  assert.equal(f.turns(), 4); assert.equal(f.executions(), 1);
});
