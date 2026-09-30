import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, type AgentModel } from "../../dist/agent.js";
import { prepareLifecycleHooks, type LifecycleEventName } from "../../dist/lifecycle-hooks.js";
import type { AgentTool } from "../../dist/tools.js";

test("lifecycle bindings validate tools and reject mutable/oversized arguments", () => {
  const tool: AgentTool = { name: "hook", description: "fixture", operation: "EXECUTE", inputSchema: { type: "object" }, async execute() { return { ok: true, output: "done" }; } };
  assert.throws(() => prepareLifecycleHooks([{ on: "turn_started", toolName: "missing" }], [tool]), /unavailable tool/);
  assert.throws(() => prepareLifecycleHooks([{ on: "turn_started", toolName: "hook", arguments: { event: {} } }], [tool]), /reserve the event key/);
  assert.throws(() => prepareLifecycleHooks([{ on: "turn_started", toolName: "hook", arguments: { body: "x".repeat(4096) } }], [tool]), /exceed the limit/);
  const input = { marker: "before" };
  const prepared = prepareLifecycleHooks([{ on: "turn_started", toolName: "hook", arguments: input }], [tool]);
  input.marker = "after";
  assert.equal(prepared[0]!.arguments.marker, "before");
});

test("lifecycle actions run in model order under fresh per-trigger approvals, without model-visible forged outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-lifecycle-"));
  const sequence: string[] = [];
  let turns = 0;
  const model: AgentModel = { async respond(request) {
    sequence.push(`model:${++turns}`);
    if (turns === 1) return { responseId: "first", text: "", toolCalls: [{ callId: "write", name: "write_fixture", arguments: "{}" }] };
    assert.deepEqual(request.toolOutputs, [{ callId: "write", output: "written" }]);
    return { responseId: "final", text: "done", toolCalls: [] };
  } };
  const tools: AgentTool[] = [
    { name: "write_fixture", description: "fixture", operation: "WRITE", inputSchema: { type: "object" }, async execute() {
      sequence.push("write");
      return { ok: true, output: "written", changedPaths: [join(root, "file.txt"), join(root, "..", "outside.txt")] };
    } },
    { name: "hook_fixture", description: "fixture", operation: "EXECUTE", inputSchema: { type: "object" }, async execute(input) {
      const event = (input as { event: { type: LifecycleEventName; path?: string } }).event;
      sequence.push(`hook:${event.type}${event.path ? `:${event.path}` : ""}`);
      return { ok: true, output: "hook executed" };
    } },
  ];
  const events: LifecycleEventName[] = ["session_started", "turn_started", "turn_completed", "tool_started", "tool_completed", "file_changed"];
  let hookApprovals = 0;
  try {
    const result = await runAgent({ task: "fixture", model, tools, workingDirectory: root, sessionStarting: true,
      lifecycleHooks: events.map((on) => ({ on, toolName: "hook_fixture" })),
      authorize: (request) => {
        if (request.name === "hook_fixture") { hookApprovals += 1; return "session"; }
        return true;
      },
    });
    assert.equal(result.finalText, "done");
    assert.equal(hookApprovals, 8); // session + two turn starts/completions + tool start/complete + file
    assert.deepEqual(sequence, [
      "hook:session_started", "hook:turn_started", "model:1", "hook:tool_started", "write",
      "hook:tool_completed", "hook:file_changed:file.txt", "hook:turn_completed",
      "hook:turn_started", "model:2", "hook:turn_completed",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a denied lifecycle action never executes and cannot gain a model tool result", async () => {
  let invoked = 0;
  const tool: AgentTool = { name: "hook_fixture", description: "fixture", operation: "EXECUTE", inputSchema: { type: "object" }, async execute() { invoked += 1; return { ok: true, output: "done" }; } };
  const model: AgentModel = { async respond(request) { assert.deepEqual(request.toolOutputs, []); return { responseId: "done", text: "ok", toolCalls: [] }; } };
  const events: string[] = [];
  const result = await runAgent({ task: "fixture", model, tools: [tool],
    lifecycleHooks: [{ on: "turn_started", toolName: "hook_fixture" }],
    authorize: () => false,
    onEvent: (event) => { if (event.type === "authorization_completed") events.push(`${event.name}:${event.allowed}`); },
  });
  assert.equal(result.finalText, "ok");
  assert.equal(invoked, 0);
  assert.deepEqual(events, ["hook_fixture:false"]);
});

test("cancellation during a hook approval prevents execution and the model turn", async () => {
  const controller = new AbortController();
  let invoked = false;
  const tool: AgentTool = { name: "hook_fixture", description: "fixture", operation: "WRITE", inputSchema: { type: "object" }, async execute() {
    invoked = true;
    return { ok: true, output: "done" };
  } };
  const model: AgentModel = { async respond() { throw new Error("Model must not start after cancellation."); } };
  await assert.rejects(runAgent({ task: "fixture", model, tools: [tool], signal: controller.signal,
    lifecycleHooks: [{ on: "turn_started", toolName: "hook_fixture" }],
    authorize: () => { controller.abort(); return true; },
  }), /Agent run cancelled/);
  assert.equal(invoked, false);
});
