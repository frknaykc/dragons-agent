import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAgent, type AgentModel } from "../../dist/agent.js";
import { PluginRegistry, discoverPlugins, readPluginManifest, validatePluginManifest } from "../../dist/plugins.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

const manifest = { apiVersion: 1, id: "fixture", version: "1.2.3", name: "Fixture", capabilities: ["tools"] } as const;

function fixtureTool(execute: () => Promise<{ ok: boolean; output: string }> = async () => ({ ok: true, output: "done" })) {
  return { name: "inspect", operation: "READ" as const, description: "Fixture inspection.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false }, execute };
}

test("plugin discovery validates bounded manifests, skips malformed files and never follows symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-plugin-"));
  const outside = await mkdtemp(join(tmpdir(), "dragons-plugin-outside-"));
  try {
    await mkdir(join(root, "fixture"));
    await writeFile(join(root, "fixture", "plugin.json"), JSON.stringify(manifest));
    await mkdir(join(root, "invalid"));
    await writeFile(join(root, "invalid", "plugin.json"), JSON.stringify({ ...manifest, id: "other" }));
    await mkdir(join(outside, "linked"));
    await writeFile(join(outside, "linked", "plugin.json"), JSON.stringify({ ...manifest, id: "linked" }));
    await symlink(join(outside, "linked"), join(root, "linked"));
    await mkdir(join(root, "file-link"));
    await symlink(join(outside, "linked", "plugin.json"), join(root, "file-link", "plugin.json"));
    await mkdir(join(root, "oversized"));
    await writeFile(join(root, "oversized", "plugin.json"), "x".repeat(16_385));
    assert.deepEqual((await discoverPlugins(root)).map((entry) => entry.id), ["fixture"]);
    await assert.rejects(readPluginManifest(root, "linked"), /real directory/);
    await assert.rejects(readPluginManifest(root, "file-link"));
    await assert.rejects(readPluginManifest(root, "oversized"), /bounded regular file/);
    await assert.rejects(readPluginManifest(root, "../outside"), /ID/);
    assert.throws(() => validatePluginManifest({ ...manifest, apiVersion: 2 }), /unsupported/);
    assert.throws(() => validatePluginManifest({ ...manifest, capabilities: ["tools", "filesystem"] }), /unsupported/);
    assert.throws(() => validatePluginManifest({ ...manifest, version: "1.x.0" }), /unsupported/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("trusted plugin registration isolates names and treats every tool as EXECUTE", async () => {
  const plugins = new PluginRegistry();
  let called = 0;
  plugins.register(manifest, () => [fixtureTool(async () => { called++; return { ok: true, output: "done" }; })]);
  assert.deepEqual(plugins.list(), [validatePluginManifest(manifest)]);
  assert.throws(() => plugins.register(manifest, () => []), /already registered/);
  const tools = plugins.tools();
  assert.equal(tools[0]?.name, "plugin_fixture_inspect");
  assert.equal(tools[0]?.operation, "EXECUTE");
  const model = (): AgentModel => {
    let turn = 0;
    return { async respond(request) {
      if (++turn === 1) return { responseId: "first", text: "", toolCalls: [{ callId: "one", name: "plugin_fixture_inspect", arguments: "{}" }] };
      assert.equal(request.toolOutputs.length, 1);
      return { responseId: "last", text: "done", toolCalls: [] };
    } };
  };
  await runAgent({ task: "test", model: model(), tools, programmaticTools: false });
  assert.equal(called, 0, "default EXECUTE authorization must deny the plugin");
  await runAgent({ task: "test", model: model(), tools, programmaticTools: false,
    authorize: (request) => { assert.equal(request.operation, "EXECUTE"); return true; } });
  assert.equal(called, 1);
  const result = await tools[0]!.execute({});
  assert.deepEqual(result, { ok: true, output: "done" });
});

test("plugin input schemas and results are bounded and cannot forge mutation metadata", async () => {
  const plugins = new PluginRegistry();
  plugins.register(manifest, () => [{ ...fixtureTool(),
    async execute() { return { ok: true, output: "x".repeat(20_000), changedPaths: ["outside"] }; } }]);
  const result = await plugins.tools()[0]!.execute({});
  assert.ok(Buffer.byteLength(result.output) <= 16_384);
  assert.equal(result.changedPaths, undefined);
  const invalid = new PluginRegistry();
  invalid.register(manifest, () => [{ ...fixtureTool(), inputSchema: { type: "object", description: "x".repeat(10_000) } }]);
  assert.throws(() => invalid.tools(), /byte limit/);
  const broken = new PluginRegistry();
  broken.register(manifest, () => { throw new Error("private factory detail"); });
  assert.throws(() => broken.tools(), /Plugin fixture factory failed/);
  const failing = new PluginRegistry();
  failing.register(manifest, () => [fixtureTool(async () => { throw new Error("private tool detail"); })]);
  assert.deepEqual(await failing.tools()[0]!.execute({}), { ok: false, output: "Plugin tool failed." });
});

test("programmatic runtime includes registered plugin tools without loading discovered code", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-plugin-runtime-"));
  const plugins = new PluginRegistry();
  let called = 0;
  plugins.register(manifest, () => [fixtureTool(async () => { called++; return { ok: true, output: "done" }; })]);
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture-1",
    credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: (): AgentModel => {
      let turn = 0;
      return { async respond(request) {
        if (++turn === 1) {
          assert.ok(request.tools.some((tool) => tool.name === "plugin_fixture_inspect"));
          return { responseId: "first", text: "", toolCalls: [{ callId: "one", name: "plugin_fixture_inspect", arguments: "{}" }] };
        }
        assert.equal(request.toolOutputs.length, 1);
        return { responseId: "last", text: "done", toolCalls: [] };
      } };
    } }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers, pluginRegistry: plugins,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), tools: [],
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession();
    const run = await runtime.sendUserInput({ sessionId: session.id, content: "test" });
    for await (const event of run.events) {
      if (event.type === "approval_requested") runtime.resolveAuthorization({ runId: run.id, approvalId: event.approvalId, decision: "deny" });
    }
    assert.equal((await run.result).finalText, "done");
    assert.equal(called, 0);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
