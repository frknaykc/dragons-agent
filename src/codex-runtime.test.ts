import assert from "node:assert/strict";
import test from "node:test";

import { runAgent, type AgentEvent } from "./agent.js";
import { createCodexAgentModel } from "./provider/codex.js";
import type { AgentTool } from "./tools.js";

function sse(events: object[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }));
}

const writeTool: AgentTool = {
  name: "write_file",
  operation: "WRITE",
  description: "Write a file.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path to write." } },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async () => ({ ok: true, output: "written" }),
};

function credentials() {
  return {
    getValidCredentials: async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer",
    }),
  };
}

test("subscription provider tool calls remain subject to Dragons WRITE authorization", async () => {
  let executions = 0;
  const bodies: Record<string, unknown>[] = [];
  const model = createCodexAgentModel({
    credentials: credentials(),
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? sse([
          { type: "response.output_item.done", item: { type: "function_call", call_id: "call_write", name: "write_file", arguments: "{\"path\":\"fixture.txt\"}", status: "completed" } },
          { type: "response.completed", response: { id: "resp_1" } },
        ])
        : sse([
          { type: "response.output_text.delta", delta: "Write denied." },
          { type: "response.completed", response: { id: "resp_2" } },
        ]);
    },
  });
  const events: AgentEvent[] = [];

  const result = await runAgent({
    task: "Change the fixture",
    model,
    tools: [{ ...writeTool, execute: async () => { executions += 1; return { ok: true, output: "written" }; } }],
    authorize: async () => false,
    onEvent: (event) => events.push(event),
  });

  assert.equal(executions, 0);
  assert.equal(result.finalText, "Write denied.");
  assert.deepEqual(events.filter((event) => event.type === "authorization_completed"), [{
    type: "authorization_completed",
    name: "write_file",
    operation: "WRITE",
    allowed: false,
  }]);
  assert.deepEqual((bodies[1]?.input as Array<{ type?: string; output?: string }>).at(-1), {
    type: "function_call_output",
    call_id: "call_write",
    output: "Authorization denied for write_file.",
  });
});

test("approved subscription provider tool calls execute once before continuation", async () => {
  let executions = 0;
  const model = createCodexAgentModel({
    credentials: credentials(),
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const isContinuation = Array.isArray(body.input) && body.input.some((item) => (
        typeof item === "object" && item !== null && (item as { type?: string }).type === "function_call_output"
      ));
      return isContinuation
        ? sse([
          { type: "response.output_text.delta", delta: "Write complete." },
          { type: "response.completed", response: { id: "resp_2" } },
        ])
        : sse([
          { type: "response.output_item.done", item: { type: "function_call", call_id: "call_write", name: "write_file", arguments: "{\"path\":\"fixture.txt\"}", status: "completed" } },
          { type: "response.completed", response: { id: "resp_1" } },
        ]);
    },
  });

  const result = await runAgent({
    task: "Change the fixture",
    model,
    tools: [{ ...writeTool, execute: async () => { executions += 1; return { ok: true, output: "written" }; } }],
    authorize: async () => true,
  });

  assert.equal(executions, 1);
  assert.equal(result.finalText, "Write complete.");
});
