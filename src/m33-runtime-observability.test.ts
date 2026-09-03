import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { AgentRunCancelledError, runAgent, type AgentModel } from "./agent.js";
import { BackgroundTaskManager } from "./background-tasks.js";
import { RuntimeDiagnosticsService } from "./diagnostics.js";
import { main } from "./cli.js";
import type { AgentTool } from "./tools.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const schema = { type: "object" as const, properties: {}, additionalProperties: false as const };

function diagnostics(): RuntimeDiagnosticsService {
  let run = 0;
  let wall = 0;
  let monotonic = 0;
  return new RuntimeDiagnosticsService({
    createRunId: () => `run-${++run}`,
    now: () => new Date(`2026-09-03T00:00:0${++wall}.000Z`),
    monotonicNow: () => (monotonic += 5),
  });
}

function tool(name: string, execute: () => Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string }): AgentTool {
  return { name, operation: "READ", description: name, inputSchema: schema, async execute() { return execute(); } };
}

test("M33 records a provider-neutral successful run with safe tool timing fields only", async () => {
  const service = diagnostics();
  const record = service.start({ sessionId: SESSION_ID, provider: "fixture-provider", model: "fixture-model" });
  let turn = 0;
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) return {
        responseId: "response-1",
        text: "",
        toolCalls: [{ callId: "call-1", name: "inspect_fixture", arguments: '{"credential":"never-store-this"}' }],
      };
      assert.deepEqual(request.toolOutputs, [{ callId: "call-1", output: "secret-output-never-store-this" }]);
      return { responseId: "response-2", text: "Done.", toolCalls: [] };
    },
  };

  await runAgent({
    task: "also-never-store-this",
    model,
    tools: [tool("inspect_fixture", () => ({ ok: true, output: "secret-output-never-store-this" }))],
    diagnostics: record,
  });

  const summary = service.recent()[0]!;
  assert.deepEqual(summary, {
    runId: "run-1",
    sessionId: SESSION_ID,
    provider: "fixture-provider",
    model: "fixture-model",
    startedAt: "2026-09-03T00:00:01.000Z",
    endedAt: "2026-09-03T00:00:02.000Z",
    durationMilliseconds: 15,
    modelTurnCount: 2,
    toolCallCount: 1,
    toolCalls: [{ name: "inspect_fixture", durationMilliseconds: 5 }],
    providerRetryCount: 0,
    providerDiagnosticCounts: {},
    cancellationCount: 0,
    cancellationState: "not_cancelled",
    timeoutCount: 0,
    mcpCallCount: 0,
    subagentCount: 0,
    backgroundTaskCount: 0,
    status: "success",
  });
  assert.doesNotMatch(JSON.stringify(summary), /never-store-this|credential|secret-output/i);
});

test("M33 records failed and cancelled final statuses", async () => {
  const service = diagnostics();
  const failed = service.start();
  await assert.rejects(runAgent({
    task: "fail",
    model: { async respond() { throw new Error("provider failed"); } },
    tools: [],
    diagnostics: failed,
  }));
  const controller = new AbortController();
  const cancelled = service.start();
  await assert.rejects(runAgent({
    task: "cancel",
    model: { async respond() { controller.abort(); return { responseId: "x", text: "", toolCalls: [] }; } },
    tools: [],
    signal: controller.signal,
    diagnostics: cancelled,
  }), AgentRunCancelledError);

  assert.equal(service.recent()[1]?.status, "failed");
  assert.deepEqual(service.recent()[0] && {
    status: service.recent()[0].status,
    cancellationCount: service.recent()[0].cancellationCount,
    cancellationState: service.recent()[0].cancellationState,
  }, { status: "cancelled", cancellationCount: 1, cancellationState: "cancelled" });
});

test("M33 counts provider retry callbacks and tool classifications without provider coupling", async () => {
  const service = diagnostics();
  const record = service.start();
  let turn = 0;
  await runAgent({
    task: "observe",
    model: {
      async respond(request) {
        request.onProviderRetry?.();
        turn += 1;
        if (turn === 1) return {
          responseId: "first",
          text: "",
          toolCalls: [
            { callId: "mcp", name: "mcp__fixture__read", arguments: "{}" },
            { callId: "subagent", name: "delegate_subagent", arguments: "{}" },
          ],
        };
        return { responseId: "last", text: "done", toolCalls: [] };
      },
    },
    tools: [tool("mcp__fixture__read", () => ({ ok: true, output: "mcp evidence" })), tool("delegate_subagent", () => ({ ok: true, output: "subagent evidence" }))],
    diagnostics: record,
  });

  const summary = service.recent()[0]!;
  assert.equal(summary.providerRetryCount, 2);
  assert.equal(summary.mcpCallCount, 1);
  assert.equal(summary.subagentCount, 1);
});

test("M33 tracks shell timeout through lifecycle metadata without retaining shell output", async () => {
  const service = diagnostics();
  const record = service.start();
  let turn = 0;
  await runAgent({
    task: "timeout",
    model: {
      async respond(request) {
        turn += 1;
        if (turn === 1) return { responseId: "first", text: "", toolCalls: [{ callId: "shell", name: "shell", arguments: '{"command":"never-store"}' }] };
        assert.match(request.toolOutputs[0]?.output ?? "", /timed out/);
        return { responseId: "last", text: "done", toolCalls: [] };
      },
    },
    tools: [{
      ...tool("shell", () => ({ ok: false, output: "Command timed out after 5ms. secret-shell-output" })),
      async execute(_input, executionOptions) {
        executionOptions?.onTimeout?.();
        return { ok: false, output: "Command timed out after 5ms. secret-shell-output" };
      },
    }],
    diagnostics: record,
  });
  const summary = service.recent()[0]!;
  assert.equal(summary.timeoutCount, 1);
  assert.doesNotMatch(JSON.stringify(summary), /never-store|secret-shell-output/);
});

test("M33 uses a real background-task start hook and does not use global state", async () => {
  const service = diagnostics();
  const manager = new BackgroundTaskManager({
    createId: () => "22222222-2222-4222-8222-222222222222",
    onTaskStarted: (task) => {
      const record = service.start({ sessionId: task.sessionId, provider: "fixture-provider", model: "fixture-model" });
      record.recordBackgroundTaskStarted();
      return record;
    },
  });
  const task = manager.start({
    sessionId: SESSION_ID,
    prompt: "Background evidence.",
    createModel: () => ({ async respond() { return { responseId: "background", text: "done", toolCalls: [] }; } }),
    tools: [],
  });
  for (let attempt = 0; attempt < 20 && manager.show(task.id)?.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.show(task.id)?.state, "completed");
  assert.equal(service.recent()[0]?.backgroundTaskCount, 1);
  assert.equal(service.recent()[0]?.status, "success");
});

test("M33 /diagnostics is local, concise, and does not invoke the model", async () => {
  const service = new RuntimeDiagnosticsService({
    createRunId: () => "cli-run",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    monotonicNow: (() => { let value = 0; return () => ++value; })(),
  });
  const output: string[] = [];
  let calls = 0;
  await main([], {
    input: Readable.from(["Inspect locally.\n", "/diagnostics\n", "/exit\n"]),
    tools: [],
    diagnostics: service,
    write: (text) => output.push(text),
    model: { async respond() { calls += 1; return { responseId: "response", text: "Done.", toolCalls: [] }; } },
  });

  assert.equal(calls, 1);
  assert.match(output.join(""), /Run cli-run \[success\].*turns 1.*tools 0/s);
  assert.doesNotMatch(output.join(""), /Inspect locally/);
});
