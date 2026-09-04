import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { AgentRunCancelledError, runAgent, type AgentModel, type AgentRequest } from "./agent.js";
import { main } from "./cli.js";
import { createSubagentTool } from "./subagents.js";
import type { AgentTool } from "./tools.js";

const inputSchema = { type: "object" as const, properties: {}, additionalProperties: false as const };
const PLAN_ID = "11111111-1111-4111-8111-111111111111";

function readTool(name = "read_file"): AgentTool {
  return {
    name,
    operation: "READ",
    description: "Read fixture data.",
    inputSchema,
    async execute() { return { ok: true, output: "read result" }; },
  };
}

function mutatingTool(name: string, operation: "WRITE" | "EXECUTE", executions: { value: number }): AgentTool {
  return {
    name,
    operation,
    description: "Must not be available to subagents.",
    inputSchema,
    async execute() {
      executions.value += 1;
      return { ok: true, output: "unexpected execution" };
    },
  };
}

test("M28 forwards a bounded child report with fresh model and advisory snapshots only", async () => {
  const childRequests: AgentRequest[] = [];
  let createdModels = 0;
  const tool = createSubagentTool({
    createModel: () => {
      createdModels += 1;
      return {
        async respond(request) {
          childRequests.push(request);
          return { responseId: "child-1", text: "Reviewed the implementation.", toolCalls: [] };
        },
      };
    },
    tools: [readTool()],
    projectContext: { instructions: { path: "AGENTS.md", content: "Review only." }, git: { isRepository: false } },
    skills: { skills: [], notices: ["active skill notice"] },
    memory: { memories: [], notices: ["memory notice"] },
    plan: { version: 1, tasks: [{ id: PLAN_ID, title: "Review", description: "Inspect only.", status: "TODO" }] },
  });

  const result = await tool.execute({ task: "Inspect the implementation." });

  assert.deepEqual(result, { ok: true, output: "Subagent report:\nReviewed the implementation." });
  assert.equal(createdModels, 1);
  assert.equal(childRequests.length, 1);
  const request = childRequests[0]!;
  assert.equal(request.task, "Inspect the implementation.");
  assert.equal(request.conversationResponseId, undefined);
  assert.equal(request.continuationState, undefined);
  assert.equal(request.previousResponseId, undefined);
  assert.deepEqual(request.toolOutputs, []);
  assert.deepEqual(request.projectContext?.instructions, { path: "AGENTS.md", content: "Review only." });
  assert.deepEqual(request.skills?.notices, ["active skill notice"]);
  assert.deepEqual(request.memory?.notices, ["memory notice"]);
  assert.deepEqual(request.plan, { version: 1, tasks: [{ id: PLAN_ID, title: "Review", description: "Inspect only.", status: "TODO" }] });
});

test("M62 permits one explicitly authorized nested read-only subagent and bounds further nesting", async () => {
  const childRequests: AgentRequest[] = [];
  let createdModels = 0;
  const tool = createSubagentTool({
    maxDepth: 2,
    authorizeNested: () => true,
    createModel: () => {
      createdModels += 1;
      const level = createdModels;
      return {
        async respond(request) {
          childRequests.push(request);
          if (level === 1 && request.toolOutputs.length === 0) return { responseId: "child", text: "", toolCalls: [{ callId: "grandchild", name: "delegate_subagent", arguments: '{"task":"Inspect a narrower question."}' }] };
          if (level === 1) {
            assert.deepEqual(request.toolOutputs, [{ callId: "grandchild", output: "Subagent report:\nNarrow evidence." }]);
            return { responseId: "child-final", text: "Parent evidence.", toolCalls: [] };
          }
          assert.deepEqual(request.tools.map((candidate) => candidate.name), ["read_file"]);
          return { responseId: "grandchild", text: "Narrow evidence.", toolCalls: [] };
        },
      };
    },
    tools: [readTool()],
  });

  const result = await tool.execute({ task: "Inspect the broad question." });

  assert.deepEqual(result, { ok: true, output: "Subagent report:\nParent evidence." });
  assert.equal(createdModels, 2);
  assert.deepEqual(childRequests[0]?.tools.map((candidate) => candidate.name), ["read_file", "delegate_subagent"]);
});

test("M28 supplies only READ tools and blocks nested, write, and shell calls structurally", async () => {
  const executions = { value: 0 };
  const childRequests: AgentRequest[] = [];
  let turn = 0;
  const tool = createSubagentTool({
    createModel: () => ({
      async respond(request) {
        childRequests.push(request);
        turn += 1;
        if (turn === 1) {
          return {
            responseId: "child-1",
            text: "",
            toolCalls: [
              { callId: "write", name: "write_file", arguments: "{}" },
              { callId: "shell", name: "shell", arguments: "{}" },
              { callId: "nested", name: "delegate_subagent", arguments: '{"task":"nested"}' },
            ],
          };
        }
        assert.deepEqual(request.toolOutputs, [
          { callId: "write", output: "Unknown tool: write_file" },
          { callId: "shell", output: "Unknown tool: shell" },
          { callId: "nested", output: "Unknown tool: delegate_subagent" },
        ]);
        return { responseId: "child-2", text: "Could not mutate the project.", toolCalls: [] };
      },
    }),
    tools: [readTool(), mutatingTool("write_file", "WRITE", executions), mutatingTool("shell", "EXECUTE", executions)],
  });

  const result = await tool.execute({ task: "Try all unavailable tools." });

  assert.equal(result.ok, true);
  assert.equal(executions.value, 0);
  assert.deepEqual(childRequests[0]?.tools.map(({ name, operation }) => ({ name, operation })), [{ name: "read_file", operation: "READ" }]);
});

test("M28 parent authorization denial prevents child model creation", async () => {
  let createdModels = 0;
  let turn = 0;
  const delegate = createSubagentTool({
    createModel: () => {
      createdModels += 1;
      throw new Error("Child model must not be created when delegation is denied.");
    },
    tools: [readTool()],
  });
  const parent: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) return {
        responseId: "parent-1",
        text: "",
        toolCalls: [{ callId: "delegate", name: delegate.name, arguments: '{"task":"Inspect"}' }],
      };
      assert.deepEqual(request.toolOutputs, [{ callId: "delegate", output: "Authorization denied for delegate_subagent." }]);
      return { responseId: "parent-2", text: "Delegation denied.", toolCalls: [] };
    },
  };

  await runAgent({ task: "Delegate.", model: parent, tools: [delegate], authorize: () => false });

  assert.equal(delegate.operation, "EXECUTE");
  assert.equal(createdModels, 0);
});

test("M28 converts ordinary child failures to bounded tool results", async () => {
  const tool = createSubagentTool({
    createModel: () => ({
      async respond() { throw new Error("Provider unavailable"); },
    }),
    tools: [readTool()],
  });

  assert.deepEqual(await tool.execute({ task: "Inspect." }), {
    ok: false,
    output: "Subagent failed: Provider unavailable",
  });
});

test("M28 bounds a child report even when the configured cap is smaller than its marker", async () => {
  const tool = createSubagentTool({
    createModel: () => ({
      async respond() { return { responseId: "child", text: "A long advisory report.", toolCalls: [] }; },
    }),
    tools: [readTool()],
    maxReportCharacters: 4,
  });

  const result = await tool.execute({ task: "Inspect." });
  assert.equal(result.output.length, 4);
  assert.equal(result.output, "Suba");
});

test("M28 propagates the parent abort signal into the child run", async () => {
  let childSawSignal = false;
  const controller = new AbortController();
  const tool = createSubagentTool({
    createModel: () => ({
      respond(request) {
        childSawSignal = request.signal === controller.signal;
        return new Promise((_resolve, reject) => {
          const abort = (): void => reject(new DOMException("Aborted", "AbortError"));
          request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    }),
    tools: [readTool()],
  });

  const run = tool.execute({ task: "Wait for cancellation." }, { signal: controller.signal });
  controller.abort();

  await assert.rejects(run, AgentRunCancelledError);
  assert.equal(childSawSignal, true);
});

test("M28 refreshes the child model factory after interactive model and provider changes", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-subagent-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-subagent-workspace-"));
  const configPath = join(sessionDirectory, "config.json");
  const created: Array<{ provider: string; model?: string }> = [];
  try {
    await main([], {
      workingDirectory: workspace,
      sessionDirectory,
      configPath,
      tools: [],
      input: Readable.from([
        "First parent turn.\n",
        "yes\n",
        "/model gpt-custom\n",
        "Second parent turn.\n",
        "yes\n",
        "/provider chatgpt\n",
        "Third parent turn.\n",
        "yes\n",
        "/exit\n",
      ]),
      write: () => undefined,
      modelFactory: (provider, model) => {
        created.push({ provider, model });
        return {
          async respond(request) {
            if (request.task.startsWith("Inspect")) return { responseId: "child", text: "Child report.", toolCalls: [] };
            if (request.toolOutputs.length > 0) return { responseId: "parent-final", text: "Parent received report.", toolCalls: [] };
            return {
              responseId: "parent",
              text: "",
              toolCalls: [{ callId: "delegate", name: "delegate_subagent", arguments: '{"task":"Inspect the current model."}' }],
            };
          },
        };
      },
    });

    assert.deepEqual(created, [
      { provider: "openai-api", model: undefined },
      { provider: "openai-api", model: "gpt-4.1-mini" },
      { provider: "openai-api", model: "gpt-custom" },
      { provider: "openai-api", model: "gpt-custom" },
      { provider: "chatgpt", model: "gpt-5.6-terra" },
      { provider: "chatgpt", model: "gpt-5.6-terra" },
    ]);
  } finally {
    await Promise.all([rm(sessionDirectory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});

test("M62 interactive nesting asks for a separate nested approval and never exposes a third level", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-m62-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m62-workspace-"));
  let models = 0;
  try {
    await main([], {
      workingDirectory: workspace,
      sessionDirectory,
      input: Readable.from(["Investigate hierarchy.\n", "yes\n", "yes\n", "/exit\n"]),
      write: () => undefined,
      tools: [readTool()],
      modelFactory: () => {
        models += 1;
        return {
          async respond(request) {
            if (request.task === "Grandchild question.") {
              assert.deepEqual(request.tools.map((tool) => tool.name), ["read_file"]);
              return { responseId: "grandchild", text: "Narrow evidence.", toolCalls: [] };
            }
            if (request.task === "Child question.") {
              if (request.toolOutputs.length === 0) return { responseId: "child", text: "", toolCalls: [{ callId: "nested", name: "delegate_subagent", arguments: '{"task":"Grandchild question."}' }] };
              return { responseId: "child-final", text: "Child evidence.", toolCalls: [] };
            }
            if (request.toolOutputs.length === 0) return { responseId: "parent", text: "", toolCalls: [{ callId: "child", name: "delegate_subagent", arguments: '{"task":"Child question."}' }] };
            return { responseId: "parent-final", text: "Parent received evidence.", toolCalls: [] };
          },
        };
      },
    });
    assert.equal(models, 3);
  } finally {
    await Promise.all([rm(sessionDirectory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});
