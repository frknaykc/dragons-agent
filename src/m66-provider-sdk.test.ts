import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runAgent, type AgentModel } from "./agent.js";
import { main } from "./cli.js";
import { loadDragonsConfig } from "./config.js";
import { createSessionStore } from "./session-store.js";
import { createProviderRegistry, type ProviderDescriptor } from "./provider/registry.js";
import type { AgentTool } from "./tools.js";

function fixtureProvider(createModel: ProviderDescriptor["createModel"]): ProviderDescriptor {
  return {
    id: "fixture",
    label: "Fixture Provider",
    defaultModel: "fixture-1",
    credentialRequirement: "none",
    capabilities: {
      streaming: true,
      toolCalls: true,
      toolResultContinuation: true,
      usageMetadata: false,
    },
    createModel,
  };
}

test("M66 registry exposes immutable capability metadata and creates isolated model instances", () => {
  let created = 0;
  const registry = createProviderRegistry([fixtureProvider(() => {
    created += 1;
    return { async respond() { return { responseId: `response-${created}`, text: "ok", toolCalls: [] }; } };
  })]);

  const descriptor = registry.get("fixture");
  assert.deepEqual(registry.ids(), ["fixture"]);
  assert.equal(descriptor.capabilities.toolResultContinuation, true);
  assert.throws(() => registry.register(fixtureProvider(() => ({ async respond() { return { responseId: "duplicate", text: "", toolCalls: [] }; } }))), /already registered/);
  assert.notEqual(registry.createModel("fixture"), registry.createModel("fixture"));
  assert.equal(created, 2);
  assert.throws(() => registry.get("missing"), /Unknown provider/);

  const credentialBearingPlugin = Object.assign(fixtureProvider(() => ({
    async respond() { return { responseId: "unexpected", text: "", toolCalls: [] }; },
  })), { secret: "synthetic-provider-credential" });
  assert.throws(() => createProviderRegistry([credentialBearingPlugin]), /unexpected properties/);
});

test("M66 registered provider uses the unchanged authorization-gated agent loop for tool continuation", async () => {
  let turn = 0;
  let writes = 0;
  const registry = createProviderRegistry([fixtureProvider((): AgentModel => ({
    async respond(request) {
      turn += 1;
      if (turn === 1) return { responseId: "provider-turn-1", text: "", toolCalls: [{ callId: "call-write", name: "write_fixture", arguments: "{}" }] };
      assert.deepEqual(request.toolOutputs, [{ callId: "call-write", output: "Authorization denied for write_fixture." }]);
      return { responseId: "provider-turn-2", text: "denied safely", toolCalls: [], usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
    },
  }))]);
  const tool: AgentTool = {
    name: "write_fixture",
    description: "Fixture write.",
    operation: "WRITE",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { writes += 1; return { ok: true, output: "should not run" }; },
  };

  const result = await runAgent({
    task: "try a write",
    model: registry.createModel("fixture"),
    tools: [tool],
    authorize: () => false,
  });

  assert.equal(result.finalText, "denied safely");
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(writes, 0);
  assert.equal(turn, 2);
});

test("M66 CLI discovers a registered provider and persists only its provider/model selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-m66-provider-"));
  const configPath = join(root, "config.json");
  const sessionDirectory = join(root, "sessions");
  const registry = createProviderRegistry([fixtureProvider(() => ({
    async respond() { return { responseId: "fixture-response", text: "fixture complete", toolCalls: [] }; },
  }))]);
  const output: string[] = [];
  try {
    await main(["config", "set-provider", "fixture"], { configPath, providerRegistry: registry, write: (text) => output.push(text) });
    assert.deepEqual(await loadDragonsConfig(configPath, registry.ids()), { version: 1, provider: "fixture" });

    await main([], {
      configPath,
      providerRegistry: registry,
      sessionDirectory,
      input: Readable.from([]),
      write: (text) => output.push(text),
      tools: [],
    });
    const [session] = await createSessionStore(sessionDirectory, { providerIds: registry.ids() }).list();
    assert.ok(session);
    assert.equal(session?.provider, "fixture");
    assert.equal(session?.model, "fixture-1");
    for (const providerState of [
      { apiKey: "synthetic-provider-credential" },
      { privateKey: "opaque-provider-state" },
      { token: "credential" },
      { idToken: "credential" },
      { cookie: "credential" },
      { note: "apiKey=synthetic-provider-credential" },
      { note: "Bearer synthetic-provider-credential" },
      { endpoint: "https://provider.invalid/v1?access_token=synthetic-provider-credential" },
      { opaque: "ghp_syntheticprovidercredentialvalue" },
    ]) {
      await assert.rejects(
        createSessionStore(sessionDirectory, { providerIds: registry.ids() }).save({
          ...session,
          continuation: { responseId: "fixture-response", providerState },
        }),
        /credential-bearing/,
      );
    }
    await assert.rejects(
      createSessionStore(sessionDirectory, { providerIds: registry.ids() }).save({
        ...session,
        continuation: { responseId: "sk-syntheticprovidercredentialvalue", providerState: { kind: "fixture" } },
      }),
      /credential-bearing/,
    );
    const privateKeyResponseId = ["-----BEGIN", " PRIVATE", " KEY-----"].join("");
    await assert.rejects(
      createSessionStore(sessionDirectory, { providerIds: registry.ids() }).save({
        ...session,
        continuation: { responseId: privateKeyResponseId, providerState: { kind: "fixture" } },
      }),
      /credential-bearing/,
    );
    assert.equal((await createSessionStore(sessionDirectory, { providerIds: registry.ids() }).load(session.id))?.continuation, undefined);
    assert.equal((await createSessionStore(sessionDirectory).list()).length, 0, "an unregistered provider session must fail closed");
    assert.doesNotMatch(output.join(""), /token|secret|authorization/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
