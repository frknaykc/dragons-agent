import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltInProviderRegistry } from "../../dist/provider/builtins.js";
import { OPENAI_REASONING_MODELS, openAIReasoning, parseReasoningPreferences, reasoningLevels, validateReasoning, type ReasoningLevel } from "../../dist/provider/reasoning.js";
import { loadDragonsConfig, saveDragonsConfig } from "../../dist/config.js";
import { configureProfileReasoning } from "../../dist/reasoning-preferences.js";
import { createTuiLocalCommands } from "../../dist/tui/local-commands.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { createSessionStore } from "../../dist/session-store.js";
import { main } from "../../dist/cli.js";
import { Readable } from "node:stream";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import type { DragonsRuntime } from "../../dist/runtime.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { slashChoices } from "../../dist/slash-choices.js";

const credentials = { getValidCredentials: async () => ({ accessToken: "fixture-token", refreshToken: "fixture-refresh", expiresAt: "2099-01-01T00:00:00.000Z", tokenType: "Bearer" as const }) };
const registry = () => createBuiltInProviderRegistry({ chatgptAuth: { credentials }, apiKeyAuth: false });

test("reasoning capabilities use exact model IDs and reject unsupported max/ultra", async () => {
  const providers = registry();
  for (const [model, levels] of Object.entries(OPENAI_REASONING_MODELS)) {
    for (const level of levels) assert.equal(validateReasoning(OPENAI_REASONING_MODELS, model, level), level);
    assert.throws(() => validateReasoning(OPENAI_REASONING_MODELS, model, "ultra"), /unsupported/);
    if (!levels.includes("max")) assert.throws(() => validateReasoning(OPENAI_REASONING_MODELS, model, "max"), /unsupported/);
  }
  for (const model of ["gpt-5-custom", "gpt-4.1-mini", "constructor", "__proto__"]) {
    assert.deepEqual(reasoningLevels(OPENAI_REASONING_MODELS, model), []);
    assert.throws(() => openAIReasoning(model, "high"), /unsupported/);
  }
  for (const id of ["anthropic", "gemini", "openrouter", "local"]) {
    assert.match(await providers.reasoning(id, providers.get(id).defaultModel), /unsupported/);
    assert.throws(() => providers.createModel(id, { reasoning: "high" }), /unsupported/);
  }
  await assert.rejects(providers.reasoning("openai-api", "gpt-5.4", "max"), /unsupported/);
  await assert.rejects(providers.reasoning("chatgpt", "gpt-5.4", "ultra"), /unsupported/);
});

test("reasoning config rejects malformed, unbounded and stale capability values", () => {
  for (const value of [[], null, { unknown: {} }, { chatgpt: { "gpt-5.4": "ultra" } }, { chatgpt: { "bad model": "high" } }, { chatgpt: JSON.parse('{"__proto__":"high"}') }, { chatgpt: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`m${i}`, "high"])) }]) {
    assert.throws(() => parseReasoningPreferences(value, registry().ids()));
  }
  const providers = registry();
  for (const reasoning of [{ chatgpt: { "gpt-5.4": "max" as const } }, { anthropic: { "gpt-5.4": "high" as const } }, { chatgpt: { unknown: "high" as const } }]) assert.throws(() => providers.configureReasoning(parseReasoningPreferences(reasoning, providers.ids())), /unsupported/);
});

test("reasoning choices expose only active model capabilities", () => {
  const providers = registry().list();
  const choices = slashChoices("/reasoning ", ["/reasoning"], providers, "chatgpt", "gpt-5.4").map((choice) => choice.value);
  assert.deepEqual(choices, ["default", "none", "low", "medium", "high", "xhigh"].map((level) => `/reasoning ${level}`));
  assert.deepEqual(slashChoices("/reasoning ", ["/reasoning"], providers, "chatgpt", "unknown"), []);
  assert.deepEqual(slashChoices("/reasoning ", ["/reasoning"], providers, "anthropic", "gpt-5.4"), []);
});

test("reasoning profile persistence reloads, isolates profiles/models and preserves newer config", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-reasoning-"));
  try {
    const path = join(root, "one", "config.json");
    const otherPath = join(root, "two", "config.json");
    await saveDragonsConfig({ provider: "chatgpt", maxTurns: 2 }, path);
    const config = await loadDragonsConfig(path);
    const providers = registry();
    configureProfileReasoning(providers, config, path);
    await saveDragonsConfig({ provider: "openai-api", maxTurns: 7 }, path);
    await providers.reasoning("chatgpt", "gpt-5.4", "high");
    await providers.reasoning("openai-api", "gpt-5", "low");
    const saved = await loadDragonsConfig(path);
    assert.equal(saved.provider, "openai-api");
    assert.equal(saved.maxTurns, 7);
    assert.equal(saved.reasoning?.chatgpt?.["gpt-5.4"], "high");
    assert.equal(saved.reasoning?.["openai-api"]?.["gpt-5"], "low");
    const reopened = registry();
    configureProfileReasoning(reopened, saved, path);
    assert.match(await reopened.reasoning("chatgpt", "gpt-5.4"), /Reasoning: high/);
    assert.match(await reopened.reasoning("chatgpt", "gpt-5"), /provider decides/);
    const other = registry();
    configureProfileReasoning(other, await loadDragonsConfig(otherPath), otherPath);
    assert.match(await other.reasoning("chatgpt", "gpt-5.4"), /provider decides/);
    await reopened.reasoning("chatgpt", "gpt-5.4", "default");
    assert.equal((await loadDragonsConfig(path)).reasoning?.chatgpt?.["gpt-5.4"], undefined);
    assert.equal((await loadDragonsConfig(path)).reasoning?.["openai-api"]?.["gpt-5"], "low");
    assert.deepEqual(await loadDragonsConfig(otherPath), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed reasoning persistence leaves previous selection effective", async () => {
  const providers = registry();
  providers.configureReasoning({ chatgpt: { "gpt-5.4": "low" } }, async () => { throw new Error("fixture disk failure"); });
  await assert.rejects(providers.reasoning("chatgpt", "gpt-5.4", "high"), /fixture disk failure/);
  assert.match(await providers.reasoning("chatgpt", "gpt-5.4"), /Reasoning: low/);
});

for (const id of ["openai-api", "chatgpt"]) {
  test(`${id} registry selection reaches actual request and default omits effort`, async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    const bodies: Record<string, unknown>[] = [];
    process.env.OPENAI_API_KEY = "fixture-key";
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      bodies.push(await request.json() as Record<string, unknown>);
      return new Response('data: {"type":"response.completed","response":{"id":"fixture-response"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const providers = registry();
      await providers.reasoning(id, "gpt-5.4", "high");
      const model = providers.createModel(id, { model: "gpt-5.4" });
      await providers.reasoning(id, "gpt-5.4", "default");
      await model.respond({ task: "fixture", tools: [], toolOutputs: [] });
      await providers.createModel(id, { model: "gpt-5.4" }).respond({ task: "fixture", tools: [], toolOutputs: [] });
      await providers.createModel(id, { model: "gpt-5.4", reasoning: "none" }).respond({ task: "fixture", tools: [], toolOutputs: [] });
      assert.deepEqual(bodies.map((body) => body.reasoning), [{ effort: "high" }, undefined, { effort: "none" }]);
      assert.ok(bodies.every((body) => body.model === "gpt-5.4"));
      for (const effort of ["max", "ultra"]) assert.throws(() => providers.createModel(id, { model: "gpt-5.4", reasoning: effort as ReasoningLevel }), /unsupported/);
      assert.equal(bodies.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    }
  });
}


test("CLI composition loads saved profile reasoning before creating its provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-cli-"));
  try {
    const path = join(root, "config.json");
    await saveDragonsConfig({ provider: "chatgpt", models: { chatgpt: "gpt-5.4" }, reasoning: { chatgpt: { "gpt-5.4": "high" } } }, path);
    const selected: unknown[] = [];
    const providers = createProviderRegistry([{ ...registry().get("chatgpt"), createModel: (context) => {
      selected.push(context.reasoning);
      return { respond: async () => ({ responseId: "fixture-response", text: "fixture", toolCalls: [] }) };
    } }]);
    await main(["fixture"], { providerRegistry: providers, configPath: path, workingDirectory: root, tools: [], input: Readable.from([]), write: () => {} });
    assert.ok(selected.length > 0);
    assert.ok(selected.every((effort) => effort === "high"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop reasoning completion and selection use host-owned active model", async () => {
  const providers = registry();
  const session = { id: "12345678-1234-1234-1234-123456789012", provider: "chatgpt", model: "gpt-5.4" };
  const runtime = { providers: () => providers.list(), createSession: async () => session, status: async () => ({ session }), dispose: async () => {} } as unknown as DragonsRuntime;
  const local = { reasoning: providers.reasoning.bind(providers), close: async () => {} } as DesktopLocalControls;
  const bridge = new DesktopBridge(runtime, () => {}, local);
  try {
    assert.equal((await bridge.request({ type: "create" })).ok, true);
    const choices = await bridge.request({ type: "choices", content: "/reasoning ", provider: "anthropic" });
    assert.equal(choices.ok, true);
    if (!choices.ok) return;
    assert.deepEqual((choices.value as { value: string }[]).map((choice) => choice.value), ["default", "none", "low", "medium", "high", "xhigh"].map((level) => `/reasoning ${level}`));
    const reply = await bridge.request({ type: "slash", content: "/reasoning high" });
    assert.equal(reply.ok, true);
    assert.match(await providers.reasoning("chatgpt", "gpt-5.4"), /Reasoning: high/);
  } finally { await bridge.close(); }
});

test("desktop permits an exact custom model ID but keeps reasoning fail-closed until metadata matches", async () => {
  const providers = registry();
  let session = { id: "12345678-1234-1234-1234-123456789012", provider: "chatgpt", model: "gpt-5.4" };
  const runtime = {
    providers: () => providers.list(),
    createSession: async (options?: { provider?: string; model?: string }) => {
      session = { ...session, provider: options?.provider ?? session.provider, model: options?.model ?? providers.get(options?.provider ?? session.provider).defaultModel };
      return session;
    },
    status: async () => ({ session }),
    dispose: async () => {},
  } as unknown as DragonsRuntime;
  const local = { reasoning: providers.reasoning.bind(providers), close: async () => {} } as DesktopLocalControls;
  const bridge = new DesktopBridge(runtime, () => {}, local);
  try {
    assert.equal((await bridge.request({ type: "create" })).ok, true);
    const custom = await bridge.request({ type: "slash", content: "/model gpt-5-private-custom" });
    assert.equal(custom.ok, true);
    const choices = await bridge.request({ type: "choices", content: "/reasoning " });
    assert.equal(choices.ok, true);
    if (choices.ok) assert.deepEqual(choices.value, []);
    const rejected = await bridge.request({ type: "slash", content: "/reasoning high" });
    assert.equal(rejected.ok, true);
    if (rejected.ok) assert.match((rejected.value as { text: string }).text, /unsupported or unverified.*no effort is sent/i);
    assert.equal((await bridge.request({ type: "slash", content: "/model gpt-5.4" })).ok, true);
    const known = await bridge.request({ type: "slash", content: "/reasoning high" });
    assert.equal(known.ok, true);
    if (known.ok) assert.match((known.value as { text: string }).text, /Reasoning: high/);
  } finally { await bridge.close(); }
});

test("plain CLI reasoning slash saves selection and recreates next run only", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-slash-"));
  try {
    const path = join(root, "config.json");
    const efforts: unknown[] = [];
    const tasks: string[] = [];
    const providers = createProviderRegistry([{ ...registry().get("chatgpt"), createModel: (context) => {
      const effort = context.reasoning;
      return { respond: async (request) => { efforts.push(effort); tasks.push(request.task); return { responseId: "fixture-response", text: "fixture", toolCalls: [] }; } };
    } }]);
    await saveDragonsConfig({ provider: "chatgpt", models: { chatgpt: "gpt-5.4" } }, path);
    const output: string[] = [];
    await main([], { providerRegistry: providers, configPath: path, workingDirectory: root, tools: [], input: Readable.from(["first\n/reasoning high\nsecond\n/reasoning ultra\n/reasoning high extra\n/exit\n"]), write: (text) => output.push(text) });
    assert.deepEqual(efforts, [undefined, "high"]);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((task) => !task.includes("/reasoning")));
    assert.equal((await loadDragonsConfig(path)).reasoning?.chatgpt?.["gpt-5.4"], "high");
    assert.match(output.join(""), /Unable to set reasoning/);
    assert.match(output.join(""), /Usage: \/reasoning/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TUI local reasoning validates session, arity, cancellation and saves valid choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "reasoning-tui-"));
  try {
    const path = join(root, "config.json");
    const providers = registry();
    configureProfileReasoning(providers, {}, path);
    const commands = createTuiLocalCommands({ reasoning: providers.reasoning.bind(providers), profiles: createDragonsProfileStore({ configPath: path }), sessions: createSessionStore(join(root, "sessions")), auth: { login: async () => {}, status: async () => ({ authenticated: false }), logout: async () => {} } });
    assert.ok(commands.names.includes("/reasoning"));
    const notices: string[] = [];
    const context = { notice: (text: string) => notices.push(text), signal: new AbortController().signal, session: { provider: "chatgpt", model: "gpt-5.4" } };
    await commands.execute("/reasoning high", { ...context, session: undefined });
    assert.match(notices.pop()!, /session first/);
    await commands.execute("/reasoning high extra", context);
    assert.match(notices.pop()!, /Usage/);
    await commands.execute("/reasoning ultra", context);
    assert.match(notices.pop()!, /Unable to set reasoning/);
    await commands.execute("/reasoning high", { ...context, signal: AbortSignal.abort() });
    assert.deepEqual(await loadDragonsConfig(path), {});
    await commands.execute("/reasoning high", context);
    assert.equal((await loadDragonsConfig(path)).reasoning?.chatgpt?.["gpt-5.4"], "high");
  } finally { await rm(root, { recursive: true, force: true }); }
});
