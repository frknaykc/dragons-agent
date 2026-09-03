import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, type AgentEvent, type AgentModel, type ToolCall, type ToolOutput } from "./agent.js";
import { createCodingTools } from "./tools.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-agent-m10-"));
  await writeFile(join(workspace, "source.txt"), "original\n", "utf8");
  return workspace;
}

function modelForToolCall(
  toolCall: ToolCall,
  verifyOutput: (outputs: ToolOutput[]) => void,
): AgentModel {
  let turn = 0;
  return {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        assert.equal(request.previousResponseId, undefined);
        return { responseId: "response-1", text: "", toolCalls: [toolCall] };
      }
      verifyOutput(request.toolOutputs);
      return { responseId: "response-2", text: "Continuation completed.", toolCalls: [] };
    },
  };
}

function authorizationEvents(events: AgentEvent[]) {
  return events.filter((event) => event.type === "authorization_requested" || event.type === "authorization_completed");
}

test("runtime intentionally allows READ without an authorization callback", async () => {
  const workspace = await createWorkspace();
  const events: AgentEvent[] = [];
  try {
    await runAgent({
      task: "Read the source.",
      model: modelForToolCall(
        { callId: "read-default", name: "read_file", arguments: '{"path":"source.txt"}' },
        (outputs) => assert.deepEqual(outputs, [{ callId: "read-default", output: "original\n" }]),
      ),
      tools: await createCodingTools(workspace),
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(authorizationEvents(events), [
      { type: "authorization_requested", name: "read_file", operation: "READ", arguments: '{"path":"source.txt"}' },
      { type: "authorization_completed", name: "read_file", operation: "READ", allowed: true },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime denies WRITE without an authorization callback and continues with the original call ID", async () => {
  const workspace = await createWorkspace();
  const events: AgentEvent[] = [];
  try {
    await runAgent({
      task: "Write a file.",
      model: modelForToolCall(
        { callId: "write-default", name: "write_file", arguments: '{"path":"blocked.txt","content":"should not exist"}' },
        (outputs) => assert.deepEqual(outputs, [{
          callId: "write-default",
          output: "Authorization denied for write_file.",
        }]),
      ),
      tools: await createCodingTools(workspace),
      onEvent: (event) => events.push(event),
    });

    await assert.rejects(access(join(workspace, "blocked.txt")), { code: "ENOENT" });
    assert.deepEqual(authorizationEvents(events), [
      { type: "authorization_requested", name: "write_file", operation: "WRITE", arguments: '{"path":"blocked.txt","content":"should not exist"}' },
      { type: "authorization_completed", name: "write_file", operation: "WRITE", allowed: false },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime denies EXECUTE without an authorization callback and creates no shell side effect", async () => {
  const workspace = await createWorkspace();
  const events: AgentEvent[] = [];
  const command = "node -e \"require('node:fs').writeFileSync('shell-side-effect.txt', 'ran')\"";
  try {
    await runAgent({
      task: "Run a command.",
      model: modelForToolCall(
        { callId: "shell-default", name: "shell", arguments: JSON.stringify({ command }) },
        (outputs) => assert.deepEqual(outputs, [{
          callId: "shell-default",
          output: "Authorization denied for shell.",
        }]),
      ),
      tools: await createCodingTools(workspace),
      onEvent: (event) => events.push(event),
    });

    await assert.rejects(access(join(workspace, "shell-side-effect.txt")), { code: "ENOENT" });
    assert.deepEqual(authorizationEvents(events), [
      { type: "authorization_requested", name: "shell", operation: "EXECUTE", arguments: JSON.stringify({ command }) },
      { type: "authorization_completed", name: "shell", operation: "EXECUTE", allowed: false },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("explicit authorization executes WRITE exactly once", async () => {
  const workspace = await createWorkspace();
  let authorizationCalls = 0;
  try {
    await runAgent({
      task: "Write a file.",
      model: modelForToolCall(
        { callId: "write-allowed", name: "write_file", arguments: '{"path":"allowed.txt","content":"written once"}' },
        (outputs) => assert.deepEqual(outputs, [{ callId: "write-allowed", output: "Wrote allowed.txt" }]),
      ),
      tools: await createCodingTools(workspace),
      authorize: (request) => {
        authorizationCalls += 1;
        assert.equal(request.operation, "WRITE");
        return true;
      },
    });

    assert.equal(authorizationCalls, 1);
    assert.equal(await readFile(join(workspace, "allowed.txt"), "utf8"), "written once");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("explicit authorization executes EXECUTE exactly once", async () => {
  const workspace = await createWorkspace();
  let authorizationCalls = 0;
  const command = "node -e \"require('node:fs').writeFileSync('allowed-shell.txt', 'ran')\"";
  try {
    await runAgent({
      task: "Run a command.",
      model: modelForToolCall(
        { callId: "shell-allowed", name: "shell", arguments: JSON.stringify({ command }) },
        (outputs) => {
          assert.equal(outputs.length, 1);
          assert.equal(outputs[0]?.callId, "shell-allowed");
          assert.match(outputs[0]?.output ?? "", /Command exited with code 0/);
        },
      ),
      tools: await createCodingTools(workspace),
      authorize: (request) => {
        authorizationCalls += 1;
        assert.equal(request.operation, "EXECUTE");
        return true;
      },
    });

    assert.equal(authorizationCalls, 1);
    assert.equal(await readFile(join(workspace, "allowed-shell.txt"), "utf8"), "ran");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("explicit denial prevents an edit side effect and remains recoverable", async () => {
  const workspace = await createWorkspace();
  try {
    await runAgent({
      task: "Edit the source.",
      model: modelForToolCall(
        { callId: "edit-denied", name: "edit_file", arguments: '{"path":"source.txt","oldText":"original","newText":"changed"}' },
        (outputs) => assert.deepEqual(outputs, [{
          callId: "edit-denied",
          output: "Authorization denied for edit_file.",
        }]),
      ),
      tools: await createCodingTools(workspace),
      authorize: () => false,
    });

    assert.equal(await readFile(join(workspace, "source.txt"), "utf8"), "original\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
