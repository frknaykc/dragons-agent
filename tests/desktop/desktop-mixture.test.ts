import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveDragonsConfig } from "../../dist/config.js";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import { createDesktopRuntime, desktopLocalControls } from "../../dist/desktop/host.js";
import { createDesktopMixtureService } from "../../dist/desktop/mixture-service.js";
import { createBuiltInProviderRegistry } from "../../dist/provider/builtins.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

function registry(requests: string[], respond?: (id: string, signal?: AbortSignal) => Promise<void>) {
  return createProviderRegistry(["alpha", "beta", "gamma"].map((id) => ({
    id, label: id, defaultModel: `${id}-default`, credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: ({ model }: { model?: string }) => ({ async respond(request: { task: string; tools: unknown[]; continuationState?: unknown; signal?: AbortSignal }) {
      requests.push(`${id}:${model}:${request.task}`);
      assert.equal(request.continuationState, undefined);
      assert.deepEqual(request.tools, []);
      await respond?.(id, request.signal);
      return { responseId: id, text: `${id} report`, toolCalls: [] };
    } }),
  })));
}

const command = "/moa duo alpha beta --aggregate gamma -- Inspect this workspace";

async function setup(respond?: (id: string, signal?: AbortSignal) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-mixture-"));
  const configPath = join(root, "config.json");
  await saveDragonsConfig({ provider: "alpha", models: { alpha: "a1", beta: "b1", gamma: "g1" } }, configPath, ["alpha", "beta", "gamma"]);
  const requests: string[] = [];
  const providers = registry(requests, respond);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), tools: [] });
  const service = createDesktopMixtureService({ providers, configPath, workingDirectory: root, tools: [] });
  const controls = { mixture: service.command, close: service.close } as unknown as DesktopLocalControls;
  const bridge = new DesktopBridge(runtime, () => assert.fail("MoA cannot run in interactive session."), controls);
  return { root, configPath, requests, bridge, async close() { await bridge.close(); await rm(root, { recursive: true, force: true }); } };
}

async function slash(bridge: DesktopBridge, content: string): Promise<string> {
  const result = await bridge.request({ type: "slash", content });
  assert.equal(result.ok, true, JSON.stringify(result));
  return JSON.stringify(result);
}

test("Desktop MoA requires a session and single-use SHARE for explicit profile models", async () => {
  const f = await setup();
  try {
    assert.equal((await f.bridge.request({ type: "slash", content: command })).ok, false);
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    assert.match(await slash(f.bridge, "/moa confirm SHARE"), /not pending/);
    assert.match(await slash(f.bridge, command.replace(" --aggregate", " alpha --aggregate")), /Usage: \/moa/);
    assert.match(await slash(f.bridge, command), /alpha:a1.*beta:b1.*gamma:g1.*SHARE/);
    assert.equal(f.requests.length, 0);
    assert.match(await slash(f.bridge, "/moa confirm NO"), /Usage: \/moa/);
    assert.match(await slash(f.bridge, "/moa confirm SHARE"), /gamma report/);
    assert.deepEqual(f.requests.map((request) => request.split(":").slice(0, 2).join(":")), ["alpha:a1", "beta:b1", "gamma:g1"]);
    assert.match(f.requests[2], /alpha report[\s\S]*beta report/);
    assert.match(await slash(f.bridge, "/moa confirm SHARE"), /not pending/);
    assert.equal((await f.bridge.request({ type: "status" })).ok, true);
    assert.equal(f.requests.length, 3);
  } finally { await f.close(); }
});

test("Desktop MoA invalidates a pending confirmation when selected models change", async () => {
  const f = await setup();
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    await slash(f.bridge, command);
    await saveDragonsConfig({ provider: "alpha", models: { alpha: "a2", beta: "b1", gamma: "g1" } }, f.configPath, ["alpha", "beta", "gamma"]);
    assert.equal((await f.bridge.request({ type: "slash", content: "/moa confirm SHARE" })).ok, false);
    assert.equal(f.requests.length, 0);
    assert.match(await slash(f.bridge, "/moa confirm SHARE"), /not pending/);
  } finally { await f.close(); }
});

test("Desktop MoA confirmation cannot cross sessions", async () => {
  const f = await setup();
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    await slash(f.bridge, command);
    assert.equal((await f.bridge.request({ type: "create", provider: "beta" })).ok, true);
    assert.match(await slash(f.bridge, "/moa confirm SHARE"), /not pending/);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("Desktop close cancels an active MoA and suppresses its report", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const f = await setup(async (_id, signal) => {
    started();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    throw new DOMException("Aborted", "AbortError");
  });
  try {
    assert.equal((await f.bridge.request({ type: "create", provider: "alpha" })).ok, true);
    await slash(f.bridge, command);
    const pending = f.bridge.request({ type: "slash", content: "/moa confirm SHARE" });
    await entered;
    await f.bridge.close();
    assert.equal((await pending).ok, false);
    assert.equal(aborted, true);
    assert.equal(f.requests.some((request) => request.startsWith("gamma:")), false);
  } finally { await f.close(); }
});

test("Desktop host exposes only host-composed MoA controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-moa-host-"));
  const configPath = join(root, "settings", "config.json");
  const runtime = await createDesktopRuntime(root, { configPath, profileName: "fixture" });
  const bridge = new DesktopBridge(runtime, () => assert.fail("No model should start before confirmation."), desktopLocalControls(runtime));
  try {
    assert.equal((await bridge.request({ type: "create", provider: "local" })).ok, true);
    assert.match(await slash(bridge, "/moa duo local openai-api --aggregate local -- Inspect"), /Type \/moa confirm SHARE/);
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

test("Desktop MoA synthesizes across Local and OpenAI wire adapters after SHARE only", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-desktop-moa-wire-"));
  const previousFetch = globalThis.fetch;
  const previousEndpoint = process.env.OPENAI_BASE_URL;
  const calls: string[] = [];
  try {
    process.env.OPENAI_BASE_URL = "https://fixture.invalid/v1";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.ok(url === "http://127.0.0.1:11434/v1/chat/completions" || url === "https://fixture.invalid/v1/responses", "Unexpected endpoint");
      const body = JSON.parse(String(init?.body)) as { input?: string; model: string; messages?: { content: string }[]; tools?: unknown[] };
      if (url.endsWith("/responses")) {
        assert.equal(body.model, "fixture-remote");
        assert.equal(body.input, "Inspect this workspace");
        calls.push("remote");
        return new Response('data: {"type":"response.output_text.delta","delta":"remote report"}\n\ndata: {"type":"response.completed","response":{"id":"remote-id"}}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
      }
      assert.equal(body.model, "fixture-local");
      if (body.messages?.some((message) => message.content?.includes("remote report"))) {
        assert.match(JSON.stringify(body.messages), /\[local\] local report.*\[openai-api\] remote report/s);
        assert.equal(body.tools, undefined);
        calls.push("aggregate");
      } else {
        assert.ok(!body.tools?.length);
        calls.push("local");
      }
      const content = calls.at(-1) === "aggregate" ? "combined answer" : "local report";
      return new Response(`data: ${JSON.stringify({ id: "local-id", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    };
    const configPath = join(root, "config.json");
    await saveDragonsConfig({ provider: "local", models: { local: "fixture-local", "openai-api": "fixture-remote" } }, configPath);
    const providers = createBuiltInProviderRegistry({
      apiKeyAuth: { credentials: async () => randomBytes(24).toString("hex") },
      localEndpoint: "http://127.0.0.1:11434/v1",
    });
    const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
      sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), tools: [] });
    const service = createDesktopMixtureService({ providers, configPath, workingDirectory: root, tools: [] });
    const bridge = new DesktopBridge(runtime, () => assert.fail("Interactive model must not run."),
      { mixture: service.command, close: service.close } as unknown as DesktopLocalControls);
    try {
      assert.equal((await bridge.request({ type: "create", provider: "local" })).ok, true);
      assert.match(await slash(bridge, "/moa duo local openai-api --aggregate local -- Inspect this workspace"), /SHARE/);
      assert.deepEqual(calls, []);
      assert.match(await slash(bridge, "/moa confirm SHARE"), /combined answer/);
      assert.deepEqual(calls.slice(0, 2).sort(), ["local", "remote"]);
      assert.equal(calls[2], "aggregate");
    } finally { await bridge.close(); }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEndpoint === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousEndpoint;
    await rm(root, { recursive: true, force: true });
  }
});
