import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runAgent, type AgentModel } from "./agent.js";
import { main, parseCliCommand } from "./cli.js";
import {
  createMemoryContext,
  createMemoryStore,
  createProjectMemoryScope,
  formatMemoryForInstructions,
  getDragonsMemoryDirectory,
} from "./memory.js";
import { createOpenAIAgentModel } from "./provider/openai.js";
import { createCodexAgentModel } from "./provider/codex.js";
import { createSessionStore } from "./session-store.js";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

test("M26 stores add and delete events in a versioned append-only restricted JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-memory-"));
  let identifiers = [FIRST_ID, SECOND_ID];
  try {
    const store = createMemoryStore(directory, {
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      createId: () => identifiers.shift()!,
    });
    const first = await store.add("Prefer focused, deterministic tests.");
    const second = await store.add("Keep the workspace boundary intact.");
    assert.deepEqual((await store.list()).map(({ id, body }) => ({ id, body })), [
      { id: FIRST_ID, body: "Prefer focused, deterministic tests." },
      { id: SECOND_ID, body: "Keep the workspace boundary intact." },
    ]);
    assert.equal(await store.delete(first.id), true);
    assert.equal(await store.delete("33333333-3333-4333-8333-333333333333"), false);
    assert.deepEqual((await store.list()).map(({ id }) => id), [second.id]);

    const stored = JSON.parse(await readFile(join(directory, "memories.json"), "utf8")) as { version: unknown; events: Array<{ type: string; id: string; body?: string }> };
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.events.map(({ type, id, body }) => ({ type, id, body })), [
      { type: "add", id: FIRST_ID, body: "Prefer focused, deterministic tests." },
      { type: "add", id: SECOND_ID, body: "Keep the workspace boundary intact." },
      { type: "delete", id: FIRST_ID, body: undefined },
    ]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, "memories.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M26 memory context is deterministic, bounded, advisory-only, and separate from authorization", async () => {
  const memories = [
    { id: FIRST_ID, body: "alpha".repeat(100), createdAt: "2026-09-03T00:00:00.000Z", scope: { kind: "USER" as const } },
    { id: SECOND_ID, body: "second", createdAt: "2026-09-03T00:00:01.000Z", scope: { kind: "USER" as const } },
  ];
  const context = createMemoryContext(memories, 300);
  const instructions = formatMemoryForInstructions(context)!;
  assert.ok(instructions.length <= 300);
  assert.match(instructions, /advisory-only/i);
  assert.match(instructions, /never override Dragons safety rules, tool authorization, workspace boundaries/i);
  assert.match(instructions, /memory context truncated/i);

  let sawContext = false;
  const model: AgentModel = {
    async respond(request) {
      sawContext = true;
      assert.deepEqual(request.memory, context);
      return { responseId: "done", text: "done", toolCalls: [] };
    },
  };
  await runAgent({ task: "Use the saved preference.", model, tools: [], memory: context });
  assert.equal(sawContext, true);
});

test("M26 injects the same labeled memory context through both provider adapters", async () => {
  const memory = createMemoryContext([{ id: FIRST_ID, body: "Never automatically capture this body.", createdAt: "2026-09-03T00:00:00.000Z", scope: { kind: "USER" } }]);
  const expected = formatMemoryForInstructions(memory)!;
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const bodies: Record<string, unknown>[] = [];
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    bodies.push(await new Request(input, init).json() as Record<string, unknown>);
    return new Response("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"openai\"}}\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  try {
    await createOpenAIAgentModel().respond({ task: "x", tools: [], toolOutputs: [], memory });
    await createCodexAgentModel({
      credentials: { getValidCredentials: async () => ({ accessToken: "token", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z", tokenType: "Bearer" }) },
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"codex\"}}\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    }).respond({ task: "x", tools: [], toolOutputs: [], memory });
    assert.equal(bodies[0]?.instructions, expected);
    assert.equal(String(bodies[1]?.instructions).endsWith(expected), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("M26 CLI and local slash memory commands are explicit and never persist memory bodies in sessions", async () => {
  const memoryDirectory = await mkdtemp(join(tmpdir(), "dragons-memory-cli-"));
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-memory-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-memory-workspace-"));
  const memoryBody = "The memory body must not enter a saved session.";
  try {
    assert.deepEqual(parseCliCommand(["memory", "list"]), { kind: "memory", action: "list", scope: "user" });
    assert.deepEqual(parseCliCommand(["memory", "add", memoryBody]), { kind: "memory", action: "add", body: memoryBody, scope: "user" });
    await main(["memory", "add", memoryBody], { memoryDirectory, write: () => undefined });
    const [savedMemory] = await createMemoryStore(memoryDirectory).list();
    assert.ok(savedMemory);
    assert.deepEqual(parseCliCommand(["memory", "delete", savedMemory.id]), { kind: "memory", action: "delete", id: savedMemory.id, scope: "user" });

    const output: string[] = [];
    let calls = 0;
    await main([], {
      workingDirectory: workspace,
      memoryDirectory,
      sessionDirectory,
      input: Readable.from(["/memory list\n", "/memory add Local-only preference\n", "Use a preference.\n", "/memory delete invalid\n", "/exit\n"]),
      write: (text) => output.push(text),
      tools: [],
      model: {
        async respond(request) {
          calls += 1;
          assert.match(formatMemoryForInstructions(request.memory) ?? "", /The memory body must not enter a saved session\./);
          return { responseId: "done", text: "done", toolCalls: [], continuationState: { kind: "chatgpt-codex", conversation: [] } };
        },
      },
    });
    assert.equal(calls, 1);
    assert.match(output.join(""), /Added user memory:/);
    assert.match(output.join(""), /Memory was not found: invalid/);
    const [session] = await createSessionStore(sessionDirectory).list();
    assert.ok(session);
    assert.doesNotMatch(JSON.stringify(session), /The memory body must not enter a saved session|Local-only preference/);
  } finally {
    await Promise.all([
      rm(memoryDirectory, { recursive: true, force: true }),
      rm(sessionDirectory, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
});

test("M26 uses a Dragons-owned memory directory on each supported platform", () => {
  assert.equal(getDragonsMemoryDirectory({ platform: "darwin", homeDirectory: "/Users/dragon" }), "/Users/dragon/Library/Application Support/Dragons Agent/memory");
  assert.equal(getDragonsMemoryDirectory({ platform: "linux", homeDirectory: "/home/dragon", xdgConfigHome: "/home/dragon/.config" }), "/home/dragon/.config/dragons-agent/memory");
});

test("M26 isolates USER and stable PROJECT memories, rejects likely secrets, and caps active records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-memory-scopes-"));
  const firstWorkspace = await mkdtemp(join(tmpdir(), "dragons-memory-project-a-"));
  const secondWorkspace = await mkdtemp(join(tmpdir(), "dragons-memory-project-b-"));
  try {
    const firstProject = await createProjectMemoryScope(firstWorkspace);
    const sameFirstProject = await createProjectMemoryScope(firstWorkspace);
    const secondProject = await createProjectMemoryScope(secondWorkspace);
    assert.deepEqual(firstProject, sameFirstProject);
    assert.notDeepEqual(firstProject, secondProject);

    let identifiers = [FIRST_ID, SECOND_ID];
    const store = createMemoryStore(directory, { createId: () => identifiers.shift()!, maxRecords: 2 });
    const user = await store.add({ scope: { kind: "USER" }, body: "User preference" });
    const project = await store.add({ scope: firstProject, body: "Project A preference" });
    assert.deepEqual((await store.list({ kind: "USER" })).map(({ id }) => id), [user.id]);
    assert.deepEqual((await store.list(firstProject)).map(({ id }) => id), [project.id]);
    assert.deepEqual(await store.list(secondProject), []);
    assert.equal(await store.get(project.id, secondProject), undefined);
    assert.equal(await store.delete(project.id, secondProject), false);
    await assert.rejects(store.add({ scope: { kind: "USER" }, body: "api_key=sk-abcdefghijklmnopqrstuv" }), /secret/i);
    await assert.rejects(store.add({ scope: { kind: "USER" }, body: "Third record" }), /record limit/i);
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(firstWorkspace, { recursive: true, force: true }),
      rm(secondWorkspace, { recursive: true, force: true }),
    ]);
  }
});
