import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { main } from "./cli.js";
import { AgentRunCancelledError } from "./agent.js";
import { createSessionStore } from "./session-store.js";

test("M15 creates a versioned persistent session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m15-"));
  try {
    const store = createSessionStore(directory, {
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    const created = await store.create({
      workingDirectory: "/workspace",
      provider: "chatgpt",
      model: "gpt-5.6-terra",
    });

    const loaded = await store.load(created.id);
    assert.deepEqual(loaded, {
      version: 1,
      id: created.id,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      workingDirectory: "/workspace",
      provider: "chatgpt",
      model: "gpt-5.6-terra",
      messages: [],
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("M15 persists a completed interactive turn in a new session", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-m15-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m15-workspace-"));
  try {
    const output: string[] = [];
    await main(["--provider", "chatgpt"], {
      workingDirectory: workspace,
      sessionDirectory,
      input: Readable.from(["Find the authentication bug.\n", "exit\n"]),
      write: (text) => output.push(text),
      model: {
        async respond() {
          return {
            responseId: "response-1",
            text: "The bug is in auth.ts.",
            toolCalls: [],
            continuationState: { kind: "chatgpt-codex", conversation: [] },
          };
        },
      },
      tools: [],
    });

    const sessions = await createSessionStore(sessionDirectory).list();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]?.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "Find the authentication bug." },
      { role: "assistant", content: "The bug is in auth.ts." },
    ]);
    assert.deepEqual(sessions[0]?.continuation, {
      responseId: "response-1",
      providerState: { kind: "chatgpt-codex", conversation: [] },
    });
    assert.match(output.join(""), /Session:/);
  } finally {
    await rm(sessionDirectory, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  }
});

test("M15 resumes a saved session with current project instructions and provider continuity", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "dragons-m15-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m15-workspace-"));
  try {
    await writeFile(join(workspace, ".hermes.md"), "Use the original instructions.\n");
    await main(["--provider", "chatgpt", "--model", "fixture-model"], {
      workingDirectory: workspace,
      sessionDirectory,
      input: Readable.from(["Find the authentication bug.\n", "exit\n"]),
      write: () => undefined,
      tools: [],
      model: {
        async respond() {
          return {
            responseId: "response-1",
            text: "The bug is in auth.ts.",
            toolCalls: [],
            continuationState: { kind: "chatgpt-codex", conversation: [{ role: "user" }] },
          };
        },
      },
    });
    const session = (await createSessionStore(sessionDirectory).list())[0];
    assert.ok(session);
    await writeFile(join(workspace, ".hermes.md"), "Use the refreshed instructions.\n");

    const output: string[] = [];
    await main(["session", "resume", session.id], {
      sessionDirectory,
      workingDirectory: "/ignored-by-resume",
      input: Readable.from(["Fix it.\n", "exit\n"]),
      write: (text) => output.push(text),
      tools: [],
      modelFactory: (provider, model) => {
        assert.equal(provider, "chatgpt");
        assert.equal(model, "fixture-model");
        return {
          async respond(request) {
            assert.equal(request.conversationResponseId, "response-1");
            assert.deepEqual(request.continuationState, { kind: "chatgpt-codex", conversation: [{ role: "user" }] });
            assert.equal(request.projectContext?.instructions?.content, "Use the refreshed instructions.\n");
            return {
              responseId: "response-2",
              text: "Fixed auth.ts.",
              toolCalls: [],
              continuationState: { kind: "chatgpt-codex", conversation: [{ role: "assistant" }] },
            };
          },
        };
      },
    });

    const resumed = await createSessionStore(sessionDirectory).load(session.id);
    assert.equal(resumed?.workingDirectory, workspace);
    assert.equal(resumed?.provider, "chatgpt");
    assert.equal(resumed?.model, "fixture-model");
    assert.equal(resumed?.messages.length, 4);
    assert.match(output.join(""), new RegExp(`Resumed session: ${session.id}`));
  } finally {
    await rm(sessionDirectory, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  }
});

test("M15 session list skips corrupted files and displays saved sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m15-sessions-"));
  try {
    const store = createSessionStore(directory);
    const session = await store.create({ workingDirectory: "/workspace", provider: "openai-api", model: "gpt-4.1-mini" });
    await writeFile(join(directory, "corrupted.json"), "not json");
    const output: string[] = [];
    await main(["session", "list"], { sessionDirectory: directory, write: (text) => output.push(text) });
    assert.match(output.join(""), new RegExp(session.id));
    assert.match(output.join(""), /openai-api · gpt-4\.1-mini/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("M15 resume rejects a missing saved workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m15-sessions-"));
  try {
    const store = createSessionStore(directory);
    const session = await store.create({
      workingDirectory: join(directory, "missing-workspace"),
      provider: "chatgpt",
      model: "gpt-5.6-terra",
    });
    await assert.rejects(main(["session", "resume", session.id], { sessionDirectory: directory }), /workspace is unavailable/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("M15 does not persist a cancelled interactive turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m15-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m15-workspace-"));
  try {
    await main([], {
      workingDirectory: workspace,
      sessionDirectory: directory,
      input: Readable.from(["Investigate auth.\n", "exit\n"]),
      write: () => undefined,
      tools: [],
      model: { async respond() { throw new AgentRunCancelledError(); } },
    });
    const [session] = await createSessionStore(directory).list();
    assert.deepEqual(session?.messages, []);
    assert.equal(session?.continuation, undefined);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  }
});

test("M15 never persists approval decisions or provider credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m15-sessions-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m15-workspace-"));
  const writeTool = {
    name: "write_file",
    description: "Write a file.",
    operation: "WRITE" as const,
    inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
    async execute() { return { ok: true, output: "unexpected" }; },
  };
  try {
    let calls = 0;
    await main([], {
      workingDirectory: workspace,
      sessionDirectory: directory,
      input: Readable.from(["Change auth.\n", "n\n", "exit\n"]),
      write: () => undefined,
      tools: [writeTool],
      model: {
        async respond() {
          calls += 1;
          if (calls === 1) {
            return { responseId: "response-1", text: "", toolCalls: [{ callId: "call-1", name: "write_file", arguments: "{}" }] };
          }
          return { responseId: "response-2", text: "Write was denied.", toolCalls: [] };
        },
      },
    });
    const [session] = await createSessionStore(directory).list();
    assert.ok(session);
    const serialized = await readFile(join(directory, `${session.id}.json`), "utf8");
    assert.doesNotMatch(serialized, /"allowed"|access-token|refresh-token|authorization/i);
    await assert.rejects(createSessionStore(directory).save({
      ...session,
      continuation: { responseId: "response-2", providerState: { access_token: "must-not-be-saved" } },
    }), /credential-bearing/);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  }
});
