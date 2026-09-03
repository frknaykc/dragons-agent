import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, type AgentModel, type AgentRequest } from "./agent.js";
import type { AgentTool } from "./tools.js";

type ProjectAwareRequest = AgentRequest & {
  projectContext?: {
    instructions?: { path: string; content: string };
    git?: { isRepository: boolean };
  };
};

const readFileTool: AgentTool = {
  name: "read_file",
  operation: "READ",
  description: "Read a file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "A project-relative path." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    assert.deepEqual(input, { path: "README.md" });
    return { ok: true, output: "# Fixture\n" };
  },
};

test("agent loop executes tool calls and returns the final answer on a later model turn", async () => {
  const requests: AgentRequest[] = [];
  const events: string[] = [];
  const model: AgentModel = {
    async respond(request) {
      requests.push(request);

      if (requests.length === 1) {
        return {
          responseId: "response-1",
          text: "I will inspect the project.",
          toolCalls: [
            {
              callId: "call-1",
              name: "read_file",
              arguments: '{"path":"README.md"}',
            },
          ],
        };
      }

      return {
        responseId: "response-2",
        text: "The README is present. Investigation is complete.",
        toolCalls: [],
      };
    },
  };

  const result = await runAgent({
    task: "Inspect the fixture.",
    model,
    tools: [readFileTool],
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(result.finalText, "The README is present. Investigation is complete.");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.toolOutputs, [
    { callId: "call-1", output: "# Fixture\n" },
  ]);
  assert.deepEqual(events, [
    "agent_started",
    "message_delta",
    "authorization_requested",
    "authorization_completed",
    "tool_started",
    "tool_completed",
    "message_delta",
    "agent_completed",
  ]);
});

test("agent loop stops at the configured turn limit", async () => {
  const model: AgentModel = {
    async respond() {
      return {
        responseId: "response-1",
        text: "Still working.",
        toolCalls: [
          {
            callId: "call-1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      };
    },
  };
  const events: string[] = [];

  await assert.rejects(
    runAgent({
      task: "Inspect the fixture.",
      model,
      tools: [readFileTool],
      maxTurns: 1,
      onEvent: (event) => events.push(event.type),
    }),
    /maximum of 1 model turns/,
  );

  assert.deepEqual(events, [
    "agent_started",
    "message_delta",
    "authorization_requested",
    "authorization_completed",
    "tool_started",
    "tool_completed",
    "agent_error",
  ]);
});

test("agent loop authorizes a read tool before it executes", async () => {
  let executed = false;
  let turn = 0;
  const events: string[] = [];
  const requests: Array<{ name: string; operation: string; arguments: string }> = [];
  const readTool = {
    ...readFileTool,
    operation: "READ" as const,
    async execute(input: unknown) {
      assert.equal(executed, false);
      executed = true;
      return readFileTool.execute(input);
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
        };
      }

      assert.deepEqual(request.toolOutputs, [{ callId: "call-1", output: "# Fixture\n" }]);
      return { responseId: "response-2", text: "Done.", toolCalls: [] };
    },
  };

  await runAgent({
    task: "Inspect the fixture.",
    model,
    tools: [readTool],
    onEvent: (event: { type: string }) => events.push(event.type),
    authorize: async (request: { name: string; operation: string; arguments: string }) => {
      requests.push(request);
      return true;
    },
  } as never);

  assert.equal(executed, true);
  assert.deepEqual(requests, [
    { name: "read_file", operation: "READ", arguments: '{"path":"README.md"}' },
  ]);
  assert.deepEqual(events, [
    "agent_started",
    "authorization_requested",
    "authorization_completed",
    "tool_started",
    "tool_completed",
    "message_delta",
    "agent_completed",
  ]);
});

test("agent loop returns a denied write authorization without executing the tool", async () => {
  let executions = 0;
  let turn = 0;
  const events: string[] = [];
  const writeTool = {
    name: "write_file",
    operation: "WRITE" as const,
    description: "Write a file.",
    inputSchema: readFileTool.inputSchema,
    async execute() {
      executions += 1;
      return { ok: true, output: "Wrote file" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "write_file", arguments: '{"path":"README.md"}' }],
        };
      }

      assert.deepEqual(request.toolOutputs, [
        { callId: "call-1", output: "Authorization denied for write_file." },
      ]);
      return { responseId: "response-2", text: "Write denied.", toolCalls: [] };
    },
  };

  await runAgent({
    task: "Do not write.",
    model,
    tools: [writeTool],
    onEvent: (event: { type: string }) => events.push(event.type),
    authorize: () => false,
  } as never);

  assert.equal(executions, 0);
  assert.deepEqual(events, [
    "agent_started",
    "authorization_requested",
    "authorization_completed",
    "tool_completed",
    "message_delta",
    "agent_completed",
  ]);
});

test("agent loop returns a denied shell authorization without executing the command", async () => {
  let executions = 0;
  let turn = 0;
  const shellTool = {
    name: "shell",
    operation: "EXECUTE" as const,
    description: "Run a command.",
    inputSchema: readFileTool.inputSchema,
    async execute() {
      executions += 1;
      return { ok: true, output: "Command ran" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "shell", arguments: '{"path":"README.md"}' }],
        };
      }

      assert.deepEqual(request.toolOutputs, [
        { callId: "call-1", output: "Authorization denied for shell." },
      ]);
      return { responseId: "response-2", text: "Shell denied.", toolCalls: [] };
    },
  };

  await runAgent({
    task: "Do not run a command.",
    model,
    tools: [shellTool],
    authorize: () => false,
  } as never);

  assert.equal(executions, 0);
});

test("agent loop emits streamed text chunks in order without duplicating the completed text", async () => {
  const events: Array<{ type: string; text?: string; finalText?: string }> = [];
  const model: AgentModel = {
    async respond(_request, onTextDelta) {
      onTextDelta?.("First ");
      onTextDelta?.("second.");
      return {
        responseId: "response-1",
        text: "First second.",
        textWasStreamed: true,
        toolCalls: [],
      };
    },
  };

  const result = await runAgent({
    task: "Stream a response.",
    model,
    tools: [],
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.finalText, "First second.");
  assert.deepEqual(events, [
    { type: "agent_started", task: "Stream a response." },
    { type: "message_delta", text: "First " },
    { type: "message_delta", text: "second." },
    { type: "agent_completed", finalText: "First second." },
  ]);
});

test("streamed completed calls use authorization before execution and continue to streamed final text", async () => {
  let executions = 0;
  let turn = 0;
  const events: string[] = [];
  const tool = {
    name: "write_file",
    operation: "WRITE" as const,
    description: "Write a fixture.",
    inputSchema: readFileTool.inputSchema,
    async execute(input: unknown) {
      executions += 1;
      assert.deepEqual(input, { path: "fixture.txt", content: "fixed" });
      return { ok: true, output: "Wrote fixture" };
    },
  };
  const model: AgentModel = {
    async respond(request, onTextDelta) {
      turn += 1;
      if (turn === 1) {
        onTextDelta?.("Applying fix. ");
        return {
          responseId: "response-1",
          text: "Applying fix. ",
          textWasStreamed: true,
          toolCalls: [{
            callId: "call-1",
            name: "write_file",
            arguments: '{"path":"fixture.txt","content":"fixed"}',
          }],
        };
      }

      assert.deepEqual(request.toolOutputs, [{ callId: "call-1", output: "Wrote fixture" }]);
      onTextDelta?.("Fix verified.");
      return {
        responseId: "response-2",
        text: "Fix verified.",
        textWasStreamed: true,
        toolCalls: [],
      };
    },
  };

  const result = await runAgent({
    task: "Fix the fixture.",
    model,
    tools: [tool],
    authorize: () => true,
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(executions, 1);
  assert.equal(result.finalText, "Fix verified.");
  assert.deepEqual(events, [
    "agent_started",
    "message_delta",
    "authorization_requested",
    "authorization_completed",
    "tool_started",
    "tool_completed",
    "message_delta",
    "agent_completed",
  ]);
});

test("agent discovers root-local project context once and sends it on every model turn", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-agent-context-runtime-"));
  await writeFile(join(workspace, ".hermes.md"), "Use the fixture convention.\n", "utf8");
  const requests: ProjectAwareRequest[] = [];
  let turn = 0;
  const model: AgentModel = {
    async respond(request) {
      requests.push(request as ProjectAwareRequest);
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
        };
      }
      return { responseId: "response-2", text: "Done.", toolCalls: [] };
    },
  };

  try {
    await runAgent({
      task: "Inspect the fixture.",
      model,
      tools: [readFileTool],
      workingDirectory: workspace,
    } as never);

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.projectContext?.instructions), [
      { path: ".hermes.md", content: "Use the fixture convention.\n" },
      { path: ".hermes.md", content: "Use the fixture convention.\n" },
    ]);
    assert.deepEqual(requests.map((request) => request.projectContext?.git), [
      { isRepository: false },
      { isRepository: false },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
