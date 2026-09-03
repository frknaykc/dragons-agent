import assert from "node:assert/strict";
import test from "node:test";

import { runAgent } from "./agent.js";

test("M36 rejects duplicate provider-visible tool names before model execution", async () => {
  let modelCalls = 0;
  const duplicate = {
    name: "ambiguous_tool",
    operation: "WRITE" as const,
    description: "Fixture.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false as const },
    async execute() { return { ok: true, output: "unused" }; },
  };

  await assert.rejects(runAgent({
    task: "fixture",
    tools: [duplicate, { ...duplicate, operation: "EXECUTE" }],
    model: { async respond() { modelCalls += 1; return { responseId: "unused", text: "", toolCalls: [] }; } },
  }), /Duplicate tool name/);
  assert.equal(modelCalls, 0);
});
