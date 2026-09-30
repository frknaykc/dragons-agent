import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { runAgent, AgentRunCancelledError, type AgentEvent, type AgentModel } from "../../dist/agent.js";
import { main } from "../../dist/cli.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createCodingTools, type AgentTool } from "../../dist/tools.js";

const call = (steps: unknown[], result?: string) => ({ callId: "program-1", name: "execute_program", arguments: JSON.stringify({ steps, ...(result ? { return: result } : {}) }) });
const step = (tool: string, args: unknown = {}) => ({ op: "call", as: "result", tool, args });
function model(calls: ReturnType<typeof call>[], inspect?: (output: string) => void): AgentModel {
  let turn = 0;
  return { async respond(request) {
    if (turn++ === 0) { assert.ok(request.tools.some(tool => tool.name === "execute_program")); return { responseId: "1", text: "", toolCalls: calls }; }
    inspect?.(request.toolOutputs[0]!.output);
    return { responseId: "2", text: "done", toolCalls: [] };
  } };
}
const tool = (name: string, operation: AgentTool["operation"], execute: AgentTool["execute"]): AgentTool =>
  ({ name, operation, description: name, inputSchema: { type: "object" }, execute });

test("READ/WRITE/EXECUTE nested calls pass through authorization, denial stops program", async () => {
  for (const operation of ["READ", "WRITE", "EXECUTE"] as const) {
    let invoked = 0;
    const events: AgentEvent[] = [];
    const requests: string[] = [];
    await runAgent({ task: "deny", model: model([call([step("target"), step("target")])], output => assert.match(output, /Authorization denied/)),
      tools: [tool("target", operation, async () => { invoked++; return { ok: true, output: "secret" }; })],
      authorize: request => { requests.push(`${request.name}:${request.operation}`); return request.name !== "target"; },
      onEvent: event => events.push(event), });
    assert.equal(invoked, 0); assert.deepEqual(requests, ["execute_program:READ", `target:${operation}`]);
    assert.equal(events.filter(event => event.type === "tool_completed" && event.name === "target").length, 1);
  }
});

test("default nested WRITE and EXECUTE denial; approved built-in write keeps mutation evidence", async t => {
  const path = await mkdtemp(join(tmpdir(), "dragons-program-write-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const tools = await createCodingTools(path);
  const write = call([{ op: "call", as: "written", tool: "write_file", args: { path: "sample.txt", content: "bounded" } }]);
  await runAgent({ task: "denied", model: model([write], output => assert.match(output, /Authorization denied/)), tools });
  await assert.rejects(readFile(join(path, "sample.txt")), { code: "ENOENT" });
  const events: AgentEvent[] = [];
  await runAgent({ task: "approved", model: model([write], output => assert.match(output,
    /Checkpoint.*1 file/)),
    tools, workingDirectory: path, authorize: request => request.operation !== "EXECUTE", onEvent: event => events.push(event) });
  assert.equal(await readFile(join(path, "sample.txt"), "utf8"), "bounded");
  assert.ok(events.some(event => event.type === "tool_completed" && event.name === "write_file" && event.result.changedPaths?.length));
  const execute = call([{ op: "call", as: "attempt", tool: "shell", args: { command: "printf prohibited" } }]);
  await runAgent({ task: "denied", model: model([execute], output => assert.match(output, /Authorization denied/)), tools });
});

test("filter, loop, sum and collect consume ordered tool output under bounded state", async () => {
  const seen: number[] = [];
  const steps = [
    { op: "call", as: "list", tool: "items" },
    { op: "filter", as: "selected", from: "list.data", field: "active", equals: true },
    { op: "each", as: "observations", from: "selected", item: "item", steps: [
      { op: "call", as: "entry", tool: "measure", args: { id: { $ref: "item.id" } } },
    ] },
    { op: "aggregate", as: "ids", from: "selected", kind: "collect", field: "id" },
    { op: "aggregate", as: "total", from: "selected", kind: "sum", field: "id" },
  ];
  await runAgent({ task: "calculate", model: model([call(steps, "total")], output => assert.equal(output, "4")), tools: [
    tool("items", "READ", async () => ({ ok: true, output: JSON.stringify([{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: true }]) })),
    tool("measure", "READ", async input => { seen.push((input as { id: number }).id); return { ok: true, output: "ok" }; }),
  ] });
  assert.deepEqual(seen, [1, 3]);
});

test("discovery and same-turn activation do not bypass visibility", async () => {
  let executed = 0;
  const tools = Array.from({ length: 27 }, (_, index) => tool(`hidden_${index}`, "READ", async () => { executed++; return { ok: true, output: "yes" }; }));
  let turn = 0;
  const program = (steps: unknown[]) => ({ callId: `p${turn}`, name: "execute_program", arguments: JSON.stringify({ steps }) });
  await runAgent({ task: "catalog", tools, model: { async respond(request) {
    turn++;
    if (turn === 1) return { responseId: "1", text: "", toolCalls: [program([step("hidden_1")])] };
    if (turn === 2) { assert.match(request.toolOutputs[0]!.output, /Unknown tool/); return { responseId: "2", text: "", toolCalls: [program([step("tool_search", { query: "hidden_1" })])] }; }
    if (turn === 3) { assert.match(request.toolOutputs[0]!.output, /hidden_1/); return { responseId: "3", text: "", toolCalls: [program([step("tool_describe", { names: ["hidden_1"] }), { op: "call", as: "next", tool: "hidden_1" }])] }; }
    if (turn === 4) { assert.match(request.toolOutputs[0]!.output, /Unknown tool/); assert.ok(request.tools.some(tool => tool.name === "hidden_1")); return { responseId: "4", text: "", toolCalls: [program([step("hidden_1")])] }; }
    assert.match(request.toolOutputs[0]!.output, /yes/);
    return { responseId: "done", text: "done", toolCalls: [] };
  } } });
  assert.equal(executed, 1);
});

test("cancellation stops remaining nested calls and does not complete", async () => {
  const controller = new AbortController(); const events: AgentEvent[] = []; let invoked = 0;
  await assert.rejects(runAgent({ task: "cancel", signal: controller.signal,
    model: model([call([step("stop"), step("later")])]), tools: [
      tool("stop", "READ", async () => { controller.abort(); return { ok: true, output: "stopped" }; }),
      tool("later", "READ", async () => { invoked++; return { ok: true, output: "later" }; }),
    ], onEvent: event => events.push(event) }), AgentRunCancelledError);
  assert.equal(invoked, 0); assert.ok(events.some(event => event.type === "agent_cancelled"));
  assert.ok(!events.some(event => event.type === "agent_completed"));
});

test("step, item, tool-call and result size limits, malformed input, and tool failures are bounded", async () => {
  const cases: { input: unknown; match: RegExp; maxToolCalls?: number }[] = [
    { input: { steps: [{ op: "each", as: "loop", from: "list.data", item: "item", steps: [step("noop")] }] }, match: /Unknown program variable/ },
    { input: { steps: Array.from({ length: 17 }, () => step("noop")) }, match: /1-16 program steps/ },
    { input: { steps: [step("items"), { op: "each", as: "loop", from: "list.data", item: "item", steps: [step("noop")] }] }, match: /Unknown program variable/ },
    { input: { steps: [step("items"), { op: "each", as: "loop", from: "result.data", item: "item", steps: [step("noop")] }] }, match: /bounded array/ },
    { input: { steps: [step("noop"), step("noop")] }, match: /maximum of 2 tool calls/, maxToolCalls: 2 },
    { input: { steps: [step("failure"), step("noop")] }, match: /Nested tool failure failed/ },
    { input: { steps: [step("execute_program")] }, match: /Invalid nested tool/ },
    { input: { steps: [step("noop", { value: "x".repeat(17_000) })] }, match: /size limit/ },
  ];
  let noopCount = 0;
  for (const [index, entry] of cases.entries()) {
    const events: AgentEvent[] = [];
    await runAgent({ task: "bad program", maxToolCalls: entry.maxToolCalls,
      model: model([{ callId: String(index), name: "execute_program", arguments: JSON.stringify(entry.input) }], output => assert.match(output, entry.match)),
      tools: [tool("items", "READ", async () => ({ ok: true, output: JSON.stringify(Array.from({ length: 21 }, (_, id) => ({ id }))) })),
        tool("noop", "READ", async () => { noopCount++; return { ok: true, output: "ok" }; }),
        tool("failure", "READ", async () => ({ ok: false, output: "failed" }))], onEvent: event => events.push(event) });
    const completed = events.filter(event => event.type === "tool_completed" && event.name === "execute_program");
    assert.equal(completed.length, 1);
    assert.equal((completed[0] as Extract<AgentEvent, { type: "tool_completed" }>).result.ok, false);
  }
  assert.equal(noopCount, 1);
});

async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "dragons-program-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  let count = 0;
  const tools = [tool("fixture_read", "READ", async () => { count++; return { ok: true, output: JSON.stringify([{ id: 5, active: true }, { id: 7, active: false }]) }; })];
  const program = call([step("fixture_read"), { op: "filter", as: "selected", from: "result.data", field: "active", equals: true }, { op: "aggregate", as: "count", from: "selected", kind: "count" }], "count");
  return { path, tools, program, count: () => count };
}

test("executed step and nested call budgets stop loops before later effects", async () => {
  let invocations = 0;
  const tools = [
    tool("items", "READ", async () => ({ ok: true, output: JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id }))) })),
    tool("noop", "READ", async () => { invocations++; return { ok: true, output: "ok" }; }),
  ];
  const program = (body: unknown[]) => call([step("items"), { op: "each", as: "loop", from: "result.data", item: "item", steps: body }]);
  await runAgent({ task: "bound steps", model: model([program([
    { op: "aggregate", as: "count", from: "result.data", kind: "count" },
    { op: "aggregate", as: "count2", from: "result.data", kind: "count" },
    { op: "aggregate", as: "count3", from: "result.data", kind: "count" },
    { op: "aggregate", as: "count4", from: "result.data", kind: "count" },
  ])], output => assert.match(output, /step limit exceeded/)), tools });
  await runAgent({ task: "bound calls", model: model([program([
    { op: "call", as: "first", tool: "noop" }, { op: "call", as: "second", tool: "noop" },
  ])], output => assert.match(output, /tool call limit exceeded/)), tools });
  assert.equal(invocations, 23); // The inventory call consumes the first of 24 nested calls.
});

test("oversize successful tool output is rejected, not silently truncated", async () => {
  await runAgent({ task: "large", model: model([call([step("large")])], output => assert.match(output, /output exceeds program value limit/)),
    tools: [tool("large", "READ", async () => ({ ok: true, output: "a".repeat(16_385) }))] });
});

test("CLI one-shot composition exposes program tool", async t => {
  const f = await fixture(t);
  await main(["count"], { workingDirectory: f.path, configPath: join(f.path, "config.json"), sessionDirectory: join(f.path, "sessions"), memoryDirectory: join(f.path, "memory"), skillsDirectory: join(f.path, "skills"), config: {}, tools: f.tools,
    model: model([f.program], output => assert.equal(output, "1")), input: Readable.from([]), write() {} });
  assert.equal(f.count(), 1);
});

test("Desktop bridge composition exposes program tool", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const agentModel = model([f.program], output => assert.equal(output, "1"));
  const registry = createProviderRegistry([{ id: "openai-api", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel: () => agentModel }]);
  const runtime = await createDragonsRuntime({ workingDirectory: f.path, providerRegistry: registry, sessionStore: createSessionStore(join(f.path, "sessions")), memoryDirectory: join(f.path, "memory"), skillsDirectory: join(f.path, "skills"), tools: f.tools });
  let finish!: () => void; const completed = new Promise<void>(resolve => { finish = resolve; }); const events: RuntimeEvent[] = [];
  const bridge = new DesktopBridge(runtime, event => { events.push(event); if (event.type === "run_completed" || event.type === "run_failed") finish(); });
  t.after(async () => { await bridge.close(); await runtime.dispose(); });
  assert.equal((await bridge.request({ type: "create", provider: "openai-api", model: "fixture" })).ok, true);
  assert.equal((await bridge.request({ type: "send", content: "count" })).ok, true);
  await completed;
  assert.ok(events.some(event => event.type === "run_completed"), JSON.stringify(events.filter(event => event.type === "run_failed")));
  assert.equal(f.count(), 1);
});
