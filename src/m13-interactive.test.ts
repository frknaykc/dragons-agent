import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AgentModel, AgentRequest } from "./agent.js";
import { main } from "./cli.js";
import type { DragonsSession, SessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

function interactiveRequest(request: AgentRequest): AgentRequest & { conversationResponseId?: string } {
  return request as AgentRequest & { conversationResponseId?: string };
}

function ephemeralSessionStore(): SessionStore {
  const sessions = new Map<string, DragonsSession>();
  return {
    async create(metadata) {
      const timestamp = new Date().toISOString();
      const session: DragonsSession = { version: 1, id: randomUUID(), createdAt: timestamp, updatedAt: timestamp, messages: [], ...metadata };
      sessions.set(session.id, session);
      return session;
    },
    async load(id) { return sessions.get(id); },
    async save(session) { sessions.set(session.id, session); },
    async list() { return [...sessions.values()]; },
    async delete(id) { return sessions.delete(id); },
  };
}

test("interactive CLI keeps an in-process conversation across streamed user turns", async () => {
  const output: string[] = [];
  const requests: AgentRequest[] = [];
  let turn = 0;
  const model: AgentModel = {
    async respond(request, onTextDelta) {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        onTextDelta?.("Found the auth bug.");
        return {
          responseId: "interactive-response-1",
          text: "Found the auth bug.",
          textWasStreamed: true,
          toolCalls: [],
        };
      }
      assert.equal(interactiveRequest(request).conversationResponseId, "interactive-response-1");
      onTextDelta?.("Fixed it.");
      return {
        responseId: "interactive-response-2",
        text: "Fixed it.",
        textWasStreamed: true,
        toolCalls: [],
      };
    },
  };

  await main([], {
    sessionStore: ephemeralSessionStore(),
    model,
    tools: [],
    input: Readable.from(["Find the auth bug.\n", "Fix it.\n", "exit\n"]),
    write: (text: string) => output.push(text),
  });

  const rendered = output.join("");
  assert.equal(requests.length, 2);
  assert.doesNotMatch(rendered, /██████╗/);
  assert.equal((rendered.match(/> /g) ?? []).length, 3);
  assert.equal((rendered.match(/Found the auth bug\./g) ?? []).length, 1);
  assert.equal((rendered.match(/Fixed it\./g) ?? []).length, 1);
});

test("interactive CLI applies existing write approval before running an approved tool", async () => {
  const output: string[] = [];
  let executions = 0;
  let modelTurn = 0;
  const tool: AgentTool = {
    name: "edit_file",
    operation: "WRITE",
    description: "Edit one file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      executions += 1;
      return { ok: true, output: "Edited fixture" };
    },
  };
  const model: AgentModel = {
    async respond(request, onTextDelta) {
      modelTurn += 1;
      if (modelTurn === 1) {
        return {
          responseId: "tool-response-1",
          text: "",
          toolCalls: [{ callId: "edit-1", name: "edit_file", arguments: "{}" }],
        };
      }
      assert.deepEqual(request.toolOutputs, [{ callId: "edit-1", output: "Edited fixture" }]);
      onTextDelta?.("Edit complete.");
      return {
        responseId: "tool-response-2",
        text: "Edit complete.",
        textWasStreamed: true,
        toolCalls: [],
      };
    },
  };

  await main([], {
    sessionStore: ephemeralSessionStore(),
    model,
    tools: [tool],
    input: Readable.from(["Fix the fixture.\n", "yes\n", "quit\n"]),
    write: (text: string) => output.push(text),
  });

  const rendered = output.join("");
  assert.equal(executions, 1);
  assert.match(rendered, /\? Allow WRITE edit_file/);
  assert.match(rendered, /• edit_file/);
  assert.equal((rendered.match(/Edit complete\./g) ?? []).length, 1);
});

test("interactive CLI applies existing execute approval before running a shell tool", async () => {
  const output: string[] = [];
  let executions = 0;
  let modelTurn = 0;
  const tool: AgentTool = {
    name: "shell",
    operation: "EXECUTE",
    description: "Run a command.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      executions += 1;
      return { ok: true, output: "Command ran" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      modelTurn += 1;
      if (modelTurn === 1) {
        return {
          responseId: "shell-response-1",
          text: "",
          toolCalls: [{ callId: "shell-1", name: "shell", arguments: "{}" }],
        };
      }
      assert.deepEqual(request.toolOutputs, [{ callId: "shell-1", output: "Command ran" }]);
      return { responseId: "shell-response-2", text: "Done.", toolCalls: [] };
    },
  };

  await main([], {
    sessionStore: ephemeralSessionStore(),
    model,
    tools: [tool],
    input: Readable.from(["Run the check.\n", "yes\n", "exit\n"]),
    write: (text: string) => output.push(text),
  });

  assert.equal(executions, 1);
  assert.match(output.join(""), /\? Allow EXECUTE shell/);
});

test("interactive CLI preserves M12 project context on each user turn", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-agent-m13-context-"));
  await writeFile(join(workspace, "AGENTS.md"), "Use interactive fixtures.\n", "utf8");
  const contexts: AgentRequest["projectContext"][] = [];
  const model: AgentModel = {
    async respond(request) {
      contexts.push(request.projectContext);
      return { responseId: `context-${contexts.length}`, text: "Done.", toolCalls: [] };
    },
  };

  try {
    await main([], {
      sessionStore: ephemeralSessionStore(),
      workingDirectory: workspace,
      model,
      tools: [],
      input: Readable.from(["Inspect it.\n", "Inspect again.\n", "exit\n"]),
      write: () => undefined,
    });
    assert.deepEqual(contexts.map((context) => context?.instructions), [
      { path: "AGENTS.md", content: "Use interactive fixtures.\n" },
      { path: "AGENTS.md", content: "Use interactive fixtures.\n" },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("interactive CLI cancels only the active turn and returns to its prompt", async () => {
  const output: string[] = [];
  let modelCalls = 0;
  const model: AgentModel = {
    respond(request) {
      modelCalls += 1;
      return new Promise((_resolve, reject) => {
        const abort = (): void => reject(new DOMException("Aborted", "AbortError"));
        request.signal?.addEventListener("abort", abort, { once: true });
        process.nextTick(() => process.emit("SIGINT"));
      });
    },
  };

  await main([], {
    sessionStore: ephemeralSessionStore(),
    model,
    tools: [],
    input: Readable.from(["Cancel this turn.\n", "exit\n"]),
    write: (text: string) => output.push(text),
  });

  const rendered = output.join("");
  assert.equal(modelCalls, 1);
  assert.match(rendered, /Cancelled/);
  assert.ok((rendered.match(/> /g) ?? []).length >= 2);
});

test("interactive CLI exits cleanly on exit, quit, and EOF without invoking the model", async () => {
  let calls = 0;
  const model: AgentModel = {
    async respond() {
      calls += 1;
      return { responseId: "unexpected", text: "unexpected", toolCalls: [] };
    },
  };

  for (const input of [Readable.from(["exit\n"]), Readable.from(["quit\n"]), Readable.from([])]) {
    await main([], { sessionStore: ephemeralSessionStore(), model, tools: [], input, write: () => undefined });
  }

  assert.equal(calls, 0);
});
