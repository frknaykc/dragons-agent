import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { runAgent } from "../agent.js";
import { main } from "../cli.js";
import { loadDragonsConfig, parseDragonsConfig } from "../config.js";
import type { AgentTool } from "../tools.js";
import { createBuiltInProviderRegistry } from "./builtins.js";
import { createLocalAgentModel } from "./local.js";
import { createOpenRouterAgentModel } from "./openrouter.js";

function sse(chunks: readonly Record<string, unknown>[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(
  id: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return { id, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

test("Local Model is a credential-free built-in provider with explicit endpoint configuration", () => {
  const provider = createBuiltInProviderRegistry({ localEndpoint: "http://127.0.0.1:11434/v1" }).get("local");

  assert.equal(provider.label, "Local Model (OpenAI-compatible)");
  assert.equal(provider.credentialRequirement, "none");
  assert.deepEqual(provider.capabilities, {
    streaming: true,
    toolCalls: true,
    toolResultContinuation: true,
    usageMetadata: false,
  });
  assert.deepEqual(parseDragonsConfig({
    provider: "local",
    localEndpoint: "http://127.0.0.1:11434/v1",
  }).localEndpoint, "http://127.0.0.1:11434/v1");
});

test("Local Model CLI uses the explicit local endpoint configuration without adding authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-local-provider-"));
  const configPath = join(root, "config.json");
  const originalFetch = globalThis.fetch;
  let url = "";
  let headers: Headers | undefined;
  try {
    await main(["config", "set-local-endpoint", "http://127.0.0.1:12435/v1"], {
      configPath,
      write: () => undefined,
    });
    assert.equal((await loadDragonsConfig(configPath)).localEndpoint, "http://127.0.0.1:12435/v1");
    globalThis.fetch = async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      return sse([chunk("local-cli", { content: "Configured locally." }, "stop")]);
    };

    await main(["--provider", "local", "Respond."], {
      configPath,
      input: Readable.from([]),
      tools: [],
      write: () => undefined,
    });

    assert.equal(url, "http://127.0.0.1:12435/v1/chat/completions");
    assert.equal(headers?.get("authorization"), null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Model factories isolate conversation state between runs", async () => {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sse([chunk(`local-isolated-${requests.length}`, { content: "ok" }, "stop")]);
  };
  const first = createLocalAgentModel({ fetchImpl });
  const second = createLocalAgentModel({ fetchImpl });

  await first.respond({ task: "First private task.", tools: [], toolOutputs: [] });
  await second.respond({ task: "Second private task.", tools: [], toolOutputs: [] });

  assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "First private task." }]);
  assert.deepEqual(requests[1]?.messages, [{ role: "user", content: "Second private task." }]);
});

test("Local Model serializes provider-local continuation state and rejects a foreign provider state", async () => {
  const requests: Record<string, unknown>[] = [];
  const origin = createLocalAgentModel({
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([chunk("local-state-1", { content: "First answer." }, "stop")]);
    },
  });
  const first = await origin.respond({ task: "First task.", tools: [], toolOutputs: [] });
  assert.equal((first.continuationState as { kind?: unknown })?.kind, "local-chat-completions");

  const resumed = createLocalAgentModel({
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([chunk("local-state-2", { content: "Second answer." }, "stop")]);
    },
  });
  await resumed.respond({ task: "Second task.", continuationState: first.continuationState, tools: [], toolOutputs: [] });
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", content: "First task." },
    { role: "assistant", content: "First answer." },
    { role: "user", content: "Second task." },
  ]);

  await assert.rejects(
    createLocalAgentModel().respond({
      task: "Reject foreign state.",
      continuationState: { kind: "openrouter-chat-completions", adapterVersion: 1, messages: [] },
      tools: [],
      toolOutputs: [],
    }),
    /incompatible/i,
  );
});

test("Local Model completes an OpenAI-compatible tool loop without forwarding authorization or endpoint configuration", async () => {
  const requests: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];
  let executions = 0;
  const model = createLocalAgentModel({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture-local",
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      headers.push(new Headers(init?.headers));
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return sse([
          chunk("local-first", { content: "Inspecting. " }),
          chunk("local-first", {
            tool_calls: [{ index: 0, id: "call_local_1", type: "function", function: { name: "read_fixture", arguments: "{}" } }],
          }, "tool_calls"),
        ]);
      }
      return sse([chunk("local-second", { content: "Completed locally." }, "stop")]);
    },
  });
  const tool: AgentTool = {
    name: "read_fixture",
    operation: "READ",
    description: "Read deterministic fixture data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      executions += 1;
      return { ok: true, output: "fixture result" };
    },
  };

  const result = await runAgent({ task: "Inspect safely.", model, tools: [tool] });

  assert.equal(result.finalText, "Completed locally.");
  assert.equal(executions, 1);
  assert.equal(requests.length, 2);
  assert.equal(urls[0], "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(headers[0]?.get("authorization"), null);
  assert.doesNotMatch(JSON.stringify(requests[0]), /127\.0\.0\.1|localEndpoint|authorization/i);
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", content: "Inspect safely." },
    { role: "assistant", content: "Inspecting. ", tool_calls: [{ id: "call_local_1", type: "function", function: { name: "read_fixture", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_local_1", content: "fixture result" },
  ]);
});

test("Local Model rejects insecure remote endpoints, does not weaken HTTPS remotes, and reports unsupported tools safely", async () => {
  assert.throws(
    () => createLocalAgentModel({ baseUrl: "http://remote.example.invalid/v1" }),
    /HTTPS|loopback/i,
  );
  assert.throws(
    () => createLocalAgentModel({ baseUrl: "http://127.0.0.1:11434/v1?api_key=not-allowed" }),
    /credential-free/i,
  );
  assert.throws(
    () => createOpenRouterAgentModel({
      apiKey: "test-openrouter-key",
      baseUrl: "http://127.0.0.1:11434/v1",
      allowInsecureLoopback: true,
    }),
    /HTTPS/i,
  );

  let headers: Headers | undefined;
  const remote = createLocalAgentModel({
    baseUrl: "https://local-gateway.example.invalid/v1",
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response('{"error":{"message":"selected model does not support tool calling; authorization=do-not-expose"}}', { status: 400 });
    },
  });
  const diagnostics: string[] = [];

  await assert.rejects(
    remote.respond({
      task: "Use tool.",
      tools: [{ name: "read_fixture", operation: "READ", description: "Read fixture.", inputSchema: { type: "object" }, async execute() { return { ok: true, output: "unused" }; } }],
      toolOutputs: [],
      onProviderDiagnostic: (kind: string) => diagnostics.push(kind),
    }),
    (error: unknown) => error instanceof Error && /Local Model selected model does not support tool calls/i.test(error.message) && !/do-not-expose/i.test(error.message),
  );
  assert.equal(headers?.get("authorization"), null);
  assert.deepEqual(diagnostics, ["tool_unsupported"]);
});

test("Local Model rejects malformed tool calls before WRITE execution and forwards cancellation", async () => {
  let executions = 0;
  const tool: AgentTool = {
    name: "write_fixture",
    operation: "WRITE",
    description: "Write fixture.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { executions += 1; return { ok: true, output: "unexpected" }; },
  };
  const malformed = createLocalAgentModel({
    fetchImpl: async () => sse([
      chunk("local-bad", { tool_calls: [{ index: 0, id: "call_bad", type: "function", function: { name: "write_fixture", arguments: "[]" } }] }, "tool_calls"),
    ]),
  });
  await assert.rejects(runAgent({ task: "Do not execute malformed output.", model: malformed, tools: [tool], authorize: () => true }), /malformed|incompatible/i);
  assert.equal(executions, 0);

  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const cancellable = createLocalAgentModel({
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  });
  const pending = cancellable.respond({ task: "Cancel.", tools: [], toolOutputs: [], signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(observedSignal, controller.signal);
});
