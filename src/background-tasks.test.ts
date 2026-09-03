import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { AgentRunCancelledError, type AgentModel, type AgentRequest } from "./agent.js";
import { BackgroundTaskManager } from "./background-tasks.js";
import { main } from "./cli.js";
import { createSessionStore } from "./session-store.js";
import type { AgentTool } from "./tools.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const inputSchema = { type: "object" as const, properties: {}, additionalProperties: false as const };

function readTool(name = "read_file"): AgentTool {
  return {
    name,
    operation: "READ",
    description: "Read fixture data.",
    inputSchema,
    async execute() { return { ok: true, output: "read result" }; },
  };
}

function tool(name: string, operation: "READ" | "WRITE" | "EXECUTE", calls: string[]): AgentTool {
  return {
    name,
    operation,
    description: "Fixture tool.",
    inputSchema,
    async execute() { calls.push(name); return { ok: true, output: `${name} ran` }; },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForState(manager: BackgroundTaskManager, id: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.show(id)?.state === state) return;
    await nextTurn();
  }
  assert.fail(`Task ${id} did not reach ${state}.`);
}

test("M29 starts process-local tasks with deterministic status and bounded report", async () => {
  const requests: AgentRequest[] = [];
  const manager = new BackgroundTaskManager({ maxTranscriptCharacters: 8, maxReportCharacters: 8 });
  const task = manager.start({
    sessionId: SESSION_ID,
    prompt: "Inspect this.",
    createModel: () => ({
      async respond(request) {
        requests.push(request);
        return { responseId: "task-1", text: "A long final report.", toolCalls: [] };
      },
    }),
    tools: [readTool()],
  });

  assert.match(task.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(task.state, "queued");
  await waitForState(manager, task.id, "completed");

  const completed = manager.show(task.id)!;
  assert.equal(completed.sessionId, SESSION_ID);
  assert.equal(completed.report, "A long f");
  assert.equal(completed.transcript, "A long f");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.conversationResponseId, undefined);
  assert.equal(requests[0]?.continuationState, undefined);
  assert.deepEqual(requests[0]?.toolOutputs, []);
  assert.deepEqual(manager.list(SESSION_ID).map(({ id, state }) => ({ id, state })), [{ id: task.id, state: "completed" }]);
});

test("M29 exposes only a read-only non-delegating registry to background models", async () => {
  const calls: string[] = [];
  const requests: AgentRequest[] = [];
  const manager = new BackgroundTaskManager();
  const task = manager.start({
    sessionId: SESSION_ID,
    prompt: "Inspect safely.",
    createModel: () => ({
      async respond(request) {
        requests.push(request);
        if (request.toolOutputs.length === 0) {
          return {
            responseId: "task-1",
            text: "",
            toolCalls: [
              { callId: "write", name: "write_file", arguments: "{}" },
              { callId: "shell", name: "shell", arguments: "{}" },
              { callId: "delegate", name: "delegate_subagent", arguments: "{}" },
              { callId: "plan", name: "plan_add", arguments: "{}" },
            ],
          };
        }
        assert.deepEqual(request.toolOutputs, [
          { callId: "write", output: "Unknown tool: write_file" },
          { callId: "shell", output: "Unknown tool: shell" },
          { callId: "delegate", output: "Unknown tool: delegate_subagent" },
          { callId: "plan", output: "Unknown tool: plan_add" },
        ]);
        return { responseId: "task-2", text: "Read-only report.", toolCalls: [] };
      },
    }),
    tools: [readTool(), tool("write_file", "WRITE", calls), tool("shell", "EXECUTE", calls), tool("delegate_subagent", "READ", calls), tool("plan_add", "READ", calls)],
  });

  await waitForState(manager, task.id, "completed");
  assert.deepEqual(requests[0]?.tools.map(({ name, operation }) => ({ name, operation })), [{ name: "read_file", operation: "READ" }]);
  assert.deepEqual(calls, []);
});

test("M29 cancellation aborts running tasks and cancels every task for a switched session", async () => {
  const started: AbortSignal[] = [];
  const manager = new BackgroundTaskManager();
  const createModel = (): AgentModel => ({
    respond(request) {
      started.push(request.signal!);
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  });
  const first = manager.start({ sessionId: SESSION_ID, prompt: "Wait.", createModel, tools: [readTool()] });
  const second = manager.start({ sessionId: SESSION_ID, prompt: "Wait too.", createModel, tools: [readTool()] });
  const other = manager.start({ sessionId: OTHER_SESSION_ID, prompt: "Other session.", createModel, tools: [readTool()] });

  await waitForState(manager, first.id, "running");
  await waitForState(manager, second.id, "running");
  assert.equal(manager.cancel(first.id), true);
  assert.equal(started[0]?.aborted, true);
  assert.equal(manager.cancelForSession(SESSION_ID), 1);
  await waitForState(manager, first.id, "cancelled");
  await waitForState(manager, second.id, "cancelled");
  assert.equal(manager.show(other.id)?.state, "running");
  assert.equal(manager.cancelForSession(OTHER_SESSION_ID), 1);
  await waitForState(manager, other.id, "cancelled");
});

test("M29 failures are recoverable and bounded", async () => {
  const manager = new BackgroundTaskManager({ maxErrorCharacters: 12 });
  const task = manager.start({
    sessionId: SESSION_ID,
    prompt: "Fail safely.",
    createModel: () => ({ async respond() { throw new Error("A provider error that is too long."); } }),
    tools: [],
  });

  await waitForState(manager, task.id, "failed");
  const failed = manager.show(task.id)!;
  assert.equal(failed.error, "A provider e");
  assert.equal(failed.error?.length, 12);
});

test("M29 background completion cannot overwrite a concurrent foreground session save", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-background-race-sessions-"));
  const started = deferred<void>();
  const response = deferred<{ responseId: string; text: string; toolCalls: [] }>();
  try {
    const store = createSessionStore(sessionDirectory);
    const session = await store.create({ workingDirectory: "/workspace", provider: "openai-api", model: "test-model" });
    const manager = new BackgroundTaskManager();
    const task = manager.start({
      sessionId: session.id,
      prompt: "Read only.",
      createModel: () => ({
        async respond() {
          started.resolve();
          return response.promise;
        },
      }),
      tools: [readTool()],
    });
    await started.promise;
    const foreground = {
      ...session,
      updatedAt: "2026-09-03T00:00:01.000Z",
      messages: [{ role: "user" as const, content: "Foreground turn wins.", createdAt: "2026-09-03T00:00:01.000Z" }],
    };
    await store.save(foreground);
    response.resolve({ responseId: "background", text: "Background report.", toolCalls: [] });
    await waitForState(manager, task.id, "completed");

    assert.deepEqual(await store.load(session.id), foreground);
  } finally {
    await rm(sessionDirectory, { recursive: true, force: true });
  }
});

test("M29 interactive session switches and exit abort every active background run", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-background-switch-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-background-switch-workspace-"));
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const signals: AbortSignal[] = [];
  let run = 0;
  try {
    async function* input(): AsyncGenerator<string> {
      yield "/tasks start First task.\n";
      await firstStarted.promise;
      yield "/new\n";
      yield "/tasks start Second task.\n";
      await secondStarted.promise;
      yield "/exit\n";
    }
    await main([], {
      workingDirectory: workspace,
      sessionDirectory,
      input: Readable.from(input()),
      write: () => undefined,
      modelFactory: () => ({
        respond(request) {
          run += 1;
          signals.push(request.signal!);
          (run === 1 ? firstStarted : secondStarted).resolve();
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        },
      }),
    });

    assert.equal(signals.length, 2);
    assert.equal(signals.every((signal) => signal.aborted), true);
  } finally {
    await Promise.all([rm(sessionDirectory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});

test("M29 interactive tasks are explicit-only and never persist or resume through session JSON", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-background-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-background-workspace-"));
  const completed = deferred<void>();
  const output: string[] = [];
  try {
    async function* input(): AsyncGenerator<string> {
      yield "/tasks start Read the workspace.\n";
      await completed.promise;
      await Promise.resolve();
      yield "/exit\n";
    }
    await main([], {
      workingDirectory: workspace,
      sessionDirectory,
      tools: [readTool()],
      input: Readable.from(input()),
      write: (text) => output.push(text),
      modelFactory: () => ({
        async respond(request) {
          assert.equal(request.task, "Read the workspace.");
          assert.deepEqual(request.tools.map((entry) => entry.name), ["read_file"]);
          completed.resolve();
          return { responseId: "background", text: "Finished without session mutation.", toolCalls: [] };
        },
      }),
    });

    const sessions = await createSessionStore(sessionDirectory).list();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]?.messages, []);
    assert.equal(sessions[0]?.continuation, undefined);
    assert.equal("backgroundTasks" in (sessions[0] ?? {}), false);
    assert.match(output.join(""), /Background task started: [0-9a-f-]{36}/i);

    const resumedOutput: string[] = [];
    await main(["session", "resume", sessions[0]!.id], {
      sessionDirectory,
      input: Readable.from(["/tasks\n", "/exit\n"]),
      write: (text) => resumedOutput.push(text),
      model: { async respond() { assert.fail("Persisted background work must never resume."); } },
    });
    assert.match(resumedOutput.join(""), /No background tasks for this session\./);
  } finally {
    await Promise.all([rm(sessionDirectory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});
