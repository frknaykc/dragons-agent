import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, AgentRunCancelledError, type AgentModel, type AgentRequest } from "../../dist/agent.js";
import { ToolCatalog, TOOL_SEARCH_THRESHOLD } from "../../dist/tool-catalog.js";
import type { AgentTool } from "../../dist/tools.js";

function fixture(count = 65) {
  const executions: string[] = [];
  const tools: AgentTool[] = Array.from({ length: count }, (_, index) => ({
    name: `catalog_${String(index).padStart(3, "0")}`, operation: index === 42 ? "WRITE" : "READ",
    description: `Fixture capability ${index === 42 ? "special orchid" : "ordinary"} ${index}`,
    inputSchema: { type: "object", properties: { value: { type: "string", description: "value" } }, additionalProperties: false },
    async execute() { executions.push(String(index)); return { ok: true, output: `executed ${index}` }; },
  }));
  return { tools, executions };
}
const call = (id: string, name: string, input: unknown) => ({ callId: id, name, arguments: JSON.stringify(input) });

test("large catalog searches bounded metadata, describes only discovered names, and activates on the next model turn", async () => {
  const f = fixture(); const requests: AgentRequest[] = []; const approvals: string[] = [];
  const model: AgentModel = { async respond(request) {
    requests.push(request); const turn = requests.length;
    if (turn === 1) {
      assert.deepEqual(request.tools.map(t => t.name), ["tool_search", "tool_describe", "execute_program"]);
      return { responseId: "first", text: "", toolCalls: [call("guess", "catalog_042", {}), call("describe-guess", "tool_describe", { names: ["catalog_042"] }), call("search", "tool_search", { query: "special orchid" })] };
    }
    if (turn === 2) {
      assert.match(request.toolOutputs[0]!.output, /Unknown tool/);
      assert.match(request.toolOutputs[1]!.output, /not been discovered/);
      const search = JSON.parse(request.toolOutputs[2]!.output);
      assert.deepEqual(search.results.map((item: { name: string }) => item.name), ["catalog_042"]);
      assert.ok(!request.toolOutputs[2]!.output.includes("inputSchema"));
      assert.ok(!request.tools.some(t => t.name === "catalog_042"));
      return { responseId: "second", text: "", toolCalls: [call("describe", "tool_describe", { names: ["catalog_042"] }), call("same-turn", "catalog_042", {})] };
    }
    if (turn === 3) {
      assert.match(request.toolOutputs[0]!.output, /"inputSchema"/);
      assert.match(request.toolOutputs[1]!.output, /Unknown tool/);
      assert.equal(request.tools.find(t => t.name === "catalog_042")?.operation, "WRITE");
      return { responseId: "third", text: "", toolCalls: [call("execute", "catalog_042", {})] };
    }
    assert.match(request.toolOutputs[0]!.output, /executed 42/);
    return { responseId: "done", text: "done", toolCalls: [] };
  } };
  await runAgent({ task: "fixture", model, tools: f.tools, authorize: request => { approvals.push(request.operation); return true; } });
  assert.deepEqual(f.executions, ["42"]);
  assert.deepEqual(approvals.filter(op => op === "WRITE"), ["WRITE"]);
  assert.equal(requests.length, 4);
});

test("catalog pagination, invalid batches and oversize schemas fail atomically with bounded output", () => {
  const f = fixture(); const catalog = new ToolCatalog(f.tools);
  const first = JSON.parse(catalog.search({ query: "ordinary" }).output);
  assert.equal(first.results.length, 10); assert.equal(first.nextOffset, 10);
  assert.ok(Buffer.byteLength(catalog.search({ query: "ordinary" }).output) < 4096);
  assert.equal(JSON.parse(catalog.search({ query: "ordinary", offset: 10 }).output).results.length, 10);
  const longCatalog = new ToolCatalog(fixture(1_100).tools);
  const penultimate = JSON.parse(longCatalog.search({ query: "ordinary", offset: 1_000 }).output);
  assert.equal(penultimate.nextOffset, 1_010);
  const next = longCatalog.search({ query: "ordinary", offset: penultimate.nextOffset });
  assert.equal(next.ok, true);
  assert.equal(JSON.parse(next.output).results.length, 10);
  const maximumCatalog = new ToolCatalog(fixture(2_048).tools);
  const lastPage = JSON.parse(maximumCatalog.search({ query: "ordinary", offset: 2_040 }).output);
  assert.equal(lastPage.results.length, 7); // The special tool is excluded from this query.
  assert.equal(lastPage.nextOffset, null);
  assert.equal(maximumCatalog.search({ query: "ordinary", offset: 2_048 }).ok, false);
  assert.equal(catalog.search({ query: "", offset: 0 }).ok, false);
  assert.equal(catalog.describe({ names: ["catalog_042"] }).result.ok, false);
  assert.equal(catalog.describe({ names: ["catalog_000", "catalog_042"] }).result.ok, false);
  assert.equal(catalog.describe({ names: ["catalog_000", "catalog_001"] }).result.ok, true);
  const mcpSized = fixture(TOOL_SEARCH_THRESHOLD + 1).tools;
  mcpSized[0]!.inputSchema = { type: "object", description: "x".repeat(9_000) };
  const compatible = new ToolCatalog(mcpSized);
  compatible.search({ query: "ordinary" });
  assert.equal(compatible.describe({ names: ["catalog_000"] }).result.ok, true);
  const huge = fixture(TOOL_SEARCH_THRESHOLD + 1).tools;
  huge[0]!.inputSchema = { type: "object", description: "x".repeat(20_000) };
  const oversized = new ToolCatalog(huge);
  oversized.search({ query: "ordinary" });
  assert.equal(oversized.describe({ names: ["catalog_000", "catalog_001"] }).result.ok, false);
  assert.equal(JSON.parse(oversized.search({ query: "ordinary" }).output).results[0].activated, false);
});

test("small catalog stays compatible; activation never persists into another run", async () => {
  const f = fixture(1); const model: AgentModel = { async respond(request) {
    assert.deepEqual(request.tools.map(t => t.name), ["catalog_000", "execute_program"]);
    return { responseId: "done", text: "done", toolCalls: [] };
  } };
  await runAgent({ task: "small", model, tools: f.tools });
  const large = fixture();
  const searchModel: AgentModel = { async respond(request) {
    assert.deepEqual(request.tools.map(t => t.name), ["tool_search", "tool_describe", "execute_program"]);
    return { responseId: "done", text: "done", toolCalls: [] };
  } };
  await runAgent({ task: "fresh", model: searchModel, tools: large.tools });
});

test("large catalogs keep the existing suggestion tool advertised without weakening hidden tools", async () => {
  const f = fixture();
  f.tools.push({ ...f.tools[0]!, name: "suggest_memory" });
  const model: AgentModel = { async respond(request) {
    assert.ok(request.tools.some(tool => tool.name === "suggest_memory"));
    assert.ok(!request.tools.some(tool => tool.name === "catalog_042"));
    return { responseId: "done", text: "done", toolCalls: [] };
  } };
  await runAgent({ task: "compatibility", model, tools: f.tools });
});

test("cancellation during discovery halts without activation or execution", async () => {
  const f = fixture(); const controller = new AbortController(); let turns = 0;
  const model: AgentModel = { async respond() {
    turns++;
    return { responseId: "cancel", text: "", toolCalls: [call("search", "tool_search", { query: "orchid" }), call("describe", "tool_describe", { names: ["catalog_042"] })] };
  } };
  await assert.rejects(runAgent({ task: "cancel", model, tools: f.tools, signal: controller.signal,
    onEvent: event => { if (event.type === "tool_completed" && event.name === "tool_search") controller.abort(); },
  }), AgentRunCancelledError);
  assert.equal(turns, 1); assert.deepEqual(f.executions, []);
});

test("turn and tool-call limits still bound discovery", async () => {
  const f = fixture(); let turns = 0;
  const model: AgentModel = { async respond() {
    turns++; return { responseId: `turn-${turns}`, text: "", toolCalls: [call(`search-${turns}`, "tool_search", { query: "ordinary" })] };
  } };
  await assert.rejects(runAgent({ task: "limit", model, tools: f.tools, maxTurns: 2 }), /maximum of 2 model turns/);
  assert.equal(turns, 2); assert.deepEqual(f.executions, []);
  turns = 0;
  await assert.rejects(runAgent({ task: "limit", model, tools: f.tools, maxToolCalls: 1 }), /maximum of 1 tool calls/);
  assert.equal(turns, 2); assert.deepEqual(f.executions, []);
});

test("describing an activated WRITE tool never grants approval", async () => {
  const f = fixture(); let turn = 0; const requests: string[] = [];
  const model: AgentModel = { async respond(request) {
    turn++;
    if (turn === 1) return { responseId: "s", text: "", toolCalls: [call("s", "tool_search", { query: "special orchid" })] };
    if (turn === 2) return { responseId: "d", text: "", toolCalls: [call("d", "tool_describe", { names: ["catalog_042"] })] };
    if (turn === 3) return { responseId: "e", text: "", toolCalls: [call("e", "catalog_042", {})] };
    assert.match(request.toolOutputs[0]!.output, /Authorization denied/);
    return { responseId: "done", text: "done", toolCalls: [] };
  } };
  await runAgent({ task: "approval", tools: f.tools, model, authorize: request => {
    requests.push(`${request.name}:${request.operation}`);
    return request.operation === "READ";
  } });
  assert.deepEqual(f.executions, []);
  assert.ok(requests.includes("catalog_042:WRITE"));
});
