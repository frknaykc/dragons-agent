import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, type AgentEvent, type AgentModel, type ToolCall } from "./agent.js";
import { createCodingTools, type AgentTool, type CodingToolOptions, type ToolOperation } from "./tools.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tool(
  name: string,
  operation: ToolOperation,
  execute: (input: unknown) => Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string },
): AgentTool {
  return {
    name,
    operation,
    description: name,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(input) {
      return execute(input);
    },
  };
}

function modelWithCalls(
  calls: ToolCall[],
  verifyOutputs: (outputs: Array<{ callId: string; output: string }>) => void = () => undefined,
): AgentModel {
  let turn = 0;
  return {
    async respond(request) {
      turn += 1;
      if (turn === 1) return { responseId: "response-1", text: "", toolCalls: calls };
      verifyOutputs(request.toolOutputs);
      return { responseId: "response-2", text: "Done.", toolCalls: [] };
    },
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dragons-agent-m11-"));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function getShell(
  workingDirectory: string,
  options: CodingToolOptions,
): Promise<AgentTool> {
  const shell = (await createCodingTools(workingDirectory, options)).find((candidate) => candidate.name === "shell");
  assert.ok(shell);
  return shell;
}

test("tool calls, authorization, and tool outputs remain in model order", async () => {
  const authorizationStarted = deferred<void>();
  const releaseFirstAuthorization = deferred<void>();
  const trace: string[] = [];

  const run = runAgent({
    task: "Apply the ordered changes.",
    model: modelWithCalls([
      { callId: "write-call", name: "write_file", arguments: "{}" },
      { callId: "shell-call", name: "shell", arguments: "{}" },
    ], (outputs) => assert.deepEqual(outputs, [
      { callId: "write-call", output: "write complete" },
      { callId: "shell-call", output: "shell complete" },
    ])),
    tools: [
      tool("write_file", "WRITE", async () => {
        trace.push("execute:write");
        return { ok: true, output: "write complete" };
      }),
      tool("shell", "EXECUTE", async () => {
        trace.push("execute:shell");
        return { ok: true, output: "shell complete" };
      }),
    ],
    authorize: async (request) => {
      trace.push(`authorize:${request.name}`);
      if (request.name === "write_file") {
        authorizationStarted.resolve();
        await releaseFirstAuthorization.promise;
      }
      return true;
    },
  });

  await authorizationStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(trace, ["authorize:write_file"]);

  releaseFirstAuthorization.resolve();
  await run;
  assert.deepEqual(trace, [
    "authorize:write_file",
    "execute:write",
    "authorize:shell",
    "execute:shell",
  ]);
});

test("cancellation before tool execution prevents every side effect and emits cancellation", async () => {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  let executions = 0;
  const model: AgentModel = {
    async respond() {
      controller.abort();
      return {
        responseId: "response-1",
        text: "",
        toolCalls: [{ callId: "blocked", name: "write_file", arguments: "{}" }],
      };
    },
  };

  await assert.rejects(runAgent({
    task: "Do not write.",
    model,
    tools: [tool("write_file", "WRITE", async () => {
      executions += 1;
      return { ok: true, output: "wrote" };
    })],
    authorize: () => true,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  } as Parameters<typeof runAgent>[0]), { name: "AgentRunCancelledError" });

  assert.equal(executions, 0);
  assert.deepEqual(events.filter((event) => (event as { type: string }).type === "agent_cancelled"), [{
    type: "agent_cancelled",
    message: "Agent run cancelled.",
  }]);
  assert.equal(events.some((event) => event.type === "agent_completed"), false);
});

test("cancellation after one tool prevents later queued tool calls", async () => {
  const controller = new AbortController();
  let firstExecutions = 0;
  let laterExecutions = 0;

  await assert.rejects(runAgent({
    task: "Cancel the ordered tools.",
    model: modelWithCalls([
      { callId: "first", name: "write_file", arguments: "{}" },
      { callId: "later", name: "edit_file", arguments: "{}" },
    ]),
    tools: [
      tool("write_file", "WRITE", async () => {
        firstExecutions += 1;
        controller.abort();
        return { ok: true, output: "first wrote" };
      }),
      tool("edit_file", "WRITE", async () => {
        laterExecutions += 1;
        return { ok: true, output: "later wrote" };
      }),
    ],
    authorize: () => true,
    signal: controller.signal,
  } as Parameters<typeof runAgent>[0]), { name: "AgentRunCancelledError" });

  assert.equal(firstExecutions, 1);
  assert.equal(laterExecutions, 0);
});

test("cancellation during a shell command terminates it before its delayed side effect", async () => {
  const directory = await workspace();
  const controller = new AbortController();
  const started = join(directory, "started.txt");
  const delayed = join(directory, "delayed.txt");
  const command = "node -e \"const fs=require('node:fs'); fs.writeFileSync('started.txt','started'); setTimeout(() => fs.writeFileSync('delayed.txt','late'), 400)\"";

  try {
    const run = runAgent({
      task: "Run the long command.",
      model: modelWithCalls([{ callId: "shell-call", name: "shell", arguments: JSON.stringify({ command }) }]),
      tools: await createCodingTools(directory),
      authorize: () => true,
      signal: controller.signal,
    } as Parameters<typeof runAgent>[0]);

    await waitForFile(started);
    controller.abort();
    await assert.rejects(run, { name: "AgentRunCancelledError" });
    await assert.rejects(access(delayed), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation during a model request stops before returned tool calls can execute", async () => {
  const controller = new AbortController();
  const requestObserved = deferred<void>();
  let executions = 0;
  const model: AgentModel = {
    respond(request) {
      const signal = (request as typeof request & { signal?: AbortSignal }).signal;
      requestObserved.resolve();
      return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        setTimeout(() => resolve({
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "should-not-run", name: "write_file", arguments: "{}" }],
        }), 30);
      });
    },
  };

  const run = runAgent({
    task: "Cancel transport.",
    model,
    tools: [tool("write_file", "WRITE", async () => {
      executions += 1;
      return { ok: true, output: "wrote" };
    })],
    authorize: () => true,
    signal: controller.signal,
  } as Parameters<typeof runAgent>[0]);

  await requestObserved.promise;
  controller.abort();
  await assert.rejects(run, { name: "AgentRunCancelledError" });
  assert.equal(executions, 0);
});

test("shell timeout is recoverable and completes within its configured bound", async () => {
  const directory = await workspace();
  try {
    const shell = await getShell(directory, { shellTimeoutMilliseconds: 50 });
    const delayed = join(directory, "delayed-after-timeout.txt");
    const before = Date.now();
    const result = await shell.execute({
      command: "node -e \"setTimeout(() => require('node:fs').writeFileSync('delayed-after-timeout.txt', 'late'), 250)\"",
    });
    const elapsed = Date.now() - before;

    assert.deepEqual(result, { ok: false, output: "Command timed out after 50ms." });
    assert.ok(elapsed < 1_000, `timeout took ${elapsed}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await assert.rejects(access(delayed), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shell output capture is bounded and marks truncation", async () => {
  const directory = await workspace();
  try {
    const shell = await getShell(directory, { maxShellOutputBytes: 32 });
    const result = await shell.execute({
      command: "node -e \"process.stdout.write('x'.repeat(256)); process.stderr.write('y'.repeat(256))\"",
    });

    assert.equal(result.ok, true);
    assert.match(result.output, /\[output truncated at 32 bytes\]/);
    assert.ok(Buffer.byteLength(result.output) < 128);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("small shell output remains unchanged", async () => {
  const directory = await workspace();
  try {
    const shell = await getShell(directory, { maxShellOutputBytes: 32 });
    assert.deepEqual(await shell.execute({ command: "node -e \"process.stdout.write('small')\"" }), {
      ok: true,
      output: "small",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeout returns a recoverable tool output with its original call ID", async () => {
  const directory = await workspace();
  try {
    const timeoutShell = await getShell(directory, { shellTimeoutMilliseconds: 50 });
    await runAgent({
      task: "Run the bounded command.",
      model: modelWithCalls([
        { callId: "timed-out-call", name: "shell", arguments: '{"command":"node -e \\\"setTimeout(() => {}, 250)\\\""}' },
      ], (outputs) => assert.deepEqual(outputs, [{
        callId: "timed-out-call",
        output: "Command timed out after 50ms.",
      }])),
      tools: [timeoutShell],
      authorize: () => true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation leaves files created before the active command but not after it", async () => {
  const directory = await workspace();
  const controller = new AbortController();
  await writeFile(join(directory, "preexisting.txt"), "keep", "utf8");
  try {
    const command = "node -e \"const fs=require('node:fs'); fs.writeFileSync('active.txt','started'); setTimeout(() => fs.writeFileSync('late.txt','late'), 400)\"";
    const run = runAgent({
      task: "Run and cancel.",
      model: modelWithCalls([{ callId: "shell-call", name: "shell", arguments: JSON.stringify({ command }) }]),
      tools: await createCodingTools(directory),
      authorize: () => true,
      signal: controller.signal,
    } as Parameters<typeof runAgent>[0]);
    await waitForFile(join(directory, "active.txt"));
    controller.abort();
    await assert.rejects(run, { name: "AgentRunCancelledError" });
    assert.equal(await readFile(join(directory, "preexisting.txt"), "utf8"), "keep");
    await assert.rejects(access(join(directory, "late.txt")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
