import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { main } from "./cli.js";
import { createSessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

const writeTool: AgentTool = {
  name: "write_fixture",
  operation: "WRITE",
  description: "Write a fixture.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { ok: true, output: "wrote" }; },
};

test("M36 interactive /resume recreates the model and clears session-scoped approvals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m36-resume-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m36-workspace-"));
  const store = createSessionStore(directory);
  const first = await store.create({ workingDirectory: workspace, provider: "chatgpt", model: "fixture-model" });
  const second = await store.create({ workingDirectory: workspace, provider: "chatgpt", model: "fixture-model" });
  const firstContinuation = { kind: "chatgpt-codex", conversation: [{ role: "user", content: [{ type: "input_text", text: "first history" }] }] };
  const secondContinuation = { kind: "chatgpt-codex", conversation: [{ role: "user", content: [{ type: "input_text", text: "second history" }] }] };
  await store.save({
    ...first,
    continuation: { responseId: "first-response", providerState: firstContinuation },
  });
  await store.save({
    ...second,
    continuation: { responseId: "second-response", providerState: secondContinuation },
  });

  const requests: Array<Array<Record<string, unknown> | undefined>> = [];
  const output: string[] = [];
  let executions = 0;
  writeTool.execute = async () => { executions += 1; return { ok: true, output: "wrote" }; };
  const modelFactory = (): AgentModel => {
    const instanceRequests: Array<Record<string, unknown> | undefined> = [];
    requests.push(instanceRequests);
    let turn = 0;
    return {
      async respond(request) {
        instanceRequests.push(request.continuationState);
        turn += 1;
        if (turn === 1) return { responseId: `response-${requests.length}-tool`, text: "", toolCalls: [{ callId: `call-${requests.length}`, name: "write_fixture", arguments: "{}" }] };
        return { responseId: `response-${requests.length}-done`, text: "done", toolCalls: [] };
      },
    };
  };

  try {
    await main(["session", "resume", first.id], {
      workingDirectory: workspace,
      sessionStore: store,
      modelFactory,
      tools: [writeTool],
      input: Readable.from(["first task\n", "session\n", `/resume ${second.id}\n`, "second task\n", "no\n", "/exit\n"]),
      write: (text: string) => output.push(text),
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.[0], firstContinuation);
    assert.deepEqual(requests[1]?.[0], secondContinuation);
    assert.equal(executions, 1);
    assert.equal(output.join("").match(/Allow WRITE write_fixture/g)?.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
