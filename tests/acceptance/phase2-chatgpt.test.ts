import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModel } from "../../dist/agent.js";
import { assertPhase2Observation, PHASE2_CASES, programFailureCategory, runPhase2Case } from "./phase2-chatgpt.js";

for (const caseName of PHASE2_CASES) {
  test(`Phase 2 ${caseName} acceptance uses real CLI composition with a deterministic model`, async () => {
    let turn = 0;
    const model: AgentModel = { async respond(request) {
      turn++;
      const call = (name: string, args: object) => ({ responseId: String(turn), text: "", toolCalls: [{ callId: String(turn), name, arguments: JSON.stringify(args) }] });
      const done = (text: string) => ({ responseId: String(turn), text, toolCalls: [] });
      if (caseName === "inline") {
        assert.equal(turn, 1);
        assert.ok(request.task.includes("-FILE") && request.task.includes("-DIFF"));
        const markers = request.task.match(/P2-[a-f0-9-]{12}-(?:FILE|DIFF)/g) ?? [];
        return done(markers.join(" "));
      }
      if (caseName === "session") {
        if (turn === 1) return call("session_search", { query: "amber orbit observation" });
        if (turn === 2) {
          const result = JSON.parse(request.toolOutputs[0]!.output) as { results: { sessionId: string; revision: string }[] };
          assert.equal(result.results.length, 1);
          return call("session_read", { sessionId: result.results[0]!.sessionId, revision: result.results[0]!.revision });
        }
        assert.match(request.toolOutputs[0]!.output, /P2-/, "session_read must return the seeded marker");
        return done(request.toolOutputs[0]!.output.match(/P2-[a-f0-9-]{12}/)?.[0] ?? "missing");
      }
      if (caseName === "catalog") {
        if (turn === 1) { assert.ok(request.tools.some(tool => tool.name === "tool_search")); return call("tool_search", { query: "quartz lantern" }); }
        if (turn === 2) return call("tool_describe", { names: ["fixture_lantern_probe"] });
        if (turn === 3) { assert.ok(request.tools.some(tool => tool.name === "fixture_lantern_probe")); return call("fixture_lantern_probe", {}); }
        return done(request.toolOutputs[0]!.output);
      }
      if (turn === 1) {
        const input = request.task.match(/PROGRAM_INPUT_JSON: (\{[^\n]+\})/);
        assert.ok(input, "The live prompt must provide a complete program input object.");
        return call("execute_program", JSON.parse(input[1]!) as object);
      }
      assert.ok(request.toolOutputs[0]!.output.includes("P2-"));
      return done(request.toolOutputs[0]!.output);
    } };
    await runPhase2Case(caseName, { model });
    assert.ok(turn > 0);
  });
}

test("program acceptance rejects a different program even if the fixture marker is returned", async () => {
  let turns = 0;
  const model: AgentModel = { async respond(request) {
    turns++;
    if (turns === 1) return { responseId: "1", text: "", toolCalls: [{ callId: "p1", name: "execute_program", arguments: JSON.stringify({ steps: [
      { op: "call", as: "inventory", tool: "fixture_inventory", args: {} },
    ], return: "inventory.data" }) }] };
    return { responseId: "2", text: request.toolOutputs[0]!.output, toolCalls: [] };
  } };
  await assert.rejects(runPhase2Case("program", { model }), /program input differs from the fixture/);
  assert.equal(turns, 2);
});

test("failed live program classifies only allowlisted interpreter errors", async () => {
  let turns = 0;
  const model: AgentModel = { async respond(request) {
    turns++;
    if (turns === 1) return { responseId: "1", text: "", toolCalls: [{ callId: "program-1", name: "execute_program", arguments: JSON.stringify({ steps: [
      { op: "call", as: "inventory", tool: "fixture_inventory", args: {} },
      { op: "filter", as: "chosen", from: "inventory.missing", field: "active", equals: true },
    ] }) }] };
    assert.equal(request.toolOutputs[0]!.output, "Program reference path not found.");
    return { responseId: "2", text: "done", toolCalls: [] };
  } };
  await assert.rejects(runPhase2Case("program", { model }), /Tool failed: execute_program \(missing reference path\)/);
  assert.equal(turns, 2);
  assert.equal(programFailureCategory("Nested tool secret-name failed: private response"), "nested tool failed");
  assert.equal(programFailureCategory("private response"), undefined);
});

test("Phase 2 evidence rejects marker-only prose, missing calls and wrong catalog order", () => {
  for (const caseName of ["session", "catalog", "program"] as const) {
    assert.throws(() => assertPhase2Observation(caseName, "P2-abc", "P2-abc"), /Required tool/);
  }
  assert.throws(() => assertPhase2Observation("program", "P2-abc\n• execute_program\n✗ execute_program\n", "P2-abc"), /Tool failed: execute_program/);
  assert.throws(() => assertPhase2Observation("program", "P2-abc\n? Allow EXECUTE shell\n", "P2-abc"), /WRITE\/EXECUTE approval/);
  assert.throws(() => assertPhase2Observation("program", "P2-abc\n• shell\n✗ shell\n", "P2-abc"), /Tool failed: other/);
  assert.throws(() => assertPhase2Observation("inline", "P2-abc\n• read_file\n✓ read_file\n", "P2-abc"), /Unexpected tool/);
  assert.throws(() => assertPhase2Observation("catalog", "P2-abc\n• fixture_lantern_probe\n✓ fixture_lantern_probe\n• tool_search\n✓ tool_search\n• tool_describe\n✓ tool_describe\n", "P2-abc"), /ordered/);
});
