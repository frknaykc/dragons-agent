import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runAgent, type AgentModel } from "./agent.js";
import { compactContextText } from "./context-budget.js";
import { loadDragonsConfig } from "./config.js";
import { main, parseCliCommand } from "./cli.js";
import { createSessionStore } from "./session-store.js";
import { createReadTools } from "./tools.js";
import { classifyProviderError, retryProviderRequest } from "./retry.js";

function tool(name: string, operation: "READ" | "WRITE" | "EXECUTE", execute: () => Promise<{ ok: boolean; output: string }>) {
  return { name, operation, description: name, inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const }, execute };
}

test("M16 compacts oversized context while preserving the most recent content", () => {
  const result = compactContextText("old-".repeat(20) + "RECENT", 80);
  assert.match(result, /^\[context compacted; omitted \d+ characters\]\n/);
  assert.match(result, /RECENT$/);
  assert.ok(result.length <= 80);
});

test("M17 session show and delete are explicit commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m17-"));
  try {
    const store = createSessionStore(directory);
    const session = await store.create({ workingDirectory: "/workspace", provider: "openai-api", model: "gpt-4.1-mini" });
    assert.deepEqual(parseCliCommand(["session", "show", session.id]), { kind: "session", action: "show", id: session.id });
    const shown: string[] = [];
    await main(["session", "show", session.id], { sessionDirectory: directory, write: (text) => shown.push(text) });
    assert.match(shown.join(""), new RegExp(session.id));
    await main(["session", "delete", session.id], { sessionDirectory: directory, write: () => undefined });
    assert.equal(await store.load(session.id), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("M18 session approvals remain scoped to a matching mutable target and process", async () => {
  let executions = 0;
  let prompted = 0;
  const approvals = new Set<string>();
  const write = tool("write_file", "WRITE", async () => { executions += 1; return { ok: true, output: "ok" }; });
  const modelFor = (path: string): AgentModel => ({
    async respond(request) {
      return request.previousResponseId
        ? { responseId: "done", text: "done", toolCalls: [] }
        : { responseId: "call", text: "", toolCalls: [{ callId: path, name: "write_file", arguments: JSON.stringify({ path, content: "x" }) }] };
    },
  });
  const authorize = () => { prompted += 1; return prompted === 1 ? "session" : false; };
  await runAgent({ task: "x", model: modelFor("one.txt"), tools: [write], authorize, sessionApprovals: approvals });
  await runAgent({ task: "x", model: modelFor("one.txt"), tools: [write], authorize, sessionApprovals: approvals });
  await runAgent({ task: "x", model: modelFor("two.txt"), tools: [write], authorize, sessionApprovals: approvals });
  assert.equal(executions, 2);
  assert.equal(prompted, 2);
});

test("M19 git read tools expose bounded status without permitting git writes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m19-"));
  try {
    const tools = await createReadTools(workspace);
    const status = tools.find((candidate) => candidate.name === "git_status");
    const diff = tools.find((candidate) => candidate.name === "git_diff");
    assert.equal(status?.operation, "READ");
    assert.equal(diff?.operation, "READ");
    const result = await status!.execute({});
    assert.equal(result.ok, false);
    assert.match(result.output, /Git repository/i);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("M20 read_file supports bounded line ranges and output markers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m20-"));
  try {
    await writeFile(join(workspace, "lines.txt"), "one\ntwo\nthree\nfour\n");
    const file = (await createReadTools(workspace, { maxToolOutputBytes: 18 })).find((candidate) => candidate.name === "read_file")!;
    assert.deepEqual(await file.execute({ path: "lines.txt", startLine: 2, endLine: 3 }), { ok: true, output: "2:two\n3:three" });
    const bounded = await file.execute({ path: "lines.txt" });
    assert.match(bounded.output, /\[output truncated at 18 bytes\]$/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("M21 workspace config is validated and loaded without credential fields", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m21-"));
  try {
    await writeFile(join(workspace, "config.json"), JSON.stringify({ provider: "chatgpt", model: "fixture", maxTurns: 3, maxToolOutputBytes: 123 }));
    assert.deepEqual(await loadDragonsConfig(join(workspace, "config.json")), { provider: "chatgpt", model: "fixture", maxTurns: 3, maxToolOutputBytes: 123 });
    await writeFile(join(workspace, "config.json"), JSON.stringify({ apiKey: "never" }));
    await assert.rejects(loadDragonsConfig(join(workspace, "config.json")), /Unknown Dragons config key/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("M22 retries transient provider failures with bounded attempts and never retries aborts", async () => {
  let attempts = 0;
  const value = await retryProviderRequest(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("busy"), { status: 429 });
    return "ok";
  }, { maxAttempts: 3, delayMilliseconds: 0 });
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
  await assert.rejects(retryProviderRequest(async () => { throw new DOMException("aborted", "AbortError"); }, { maxAttempts: 3, delayMilliseconds: 0 }), /aborted/);
  assert.equal(classifyProviderError(Object.assign(new Error("bad credentials"), { status: 401 })), "authentication");
  assert.equal(classifyProviderError(Object.assign(new Error("busy"), { status: 429 })), "rate_limit");
  assert.equal(classifyProviderError(Object.assign(new Error("invalid"), { status: 400 })), "invalid_request");
});

test("M23 interactive slash commands are handled locally", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m23-"));
  try {
    const output: string[] = [];
    let calls = 0;
    await main([], {
      workingDirectory: workspace,
      sessionDirectory: join(workspace, "sessions"),
      input: Readable.from(["/help\n", "/status\n", "/exit\n"]),
      write: (text) => output.push(text),
      tools: [],
      model: { async respond() { calls += 1; return { responseId: "x", text: "unexpected", toolCalls: [] }; } },
    });
    assert.equal(calls, 0);
    assert.match(output.join(""), /\/help/);
    assert.match(output.join(""), /Session:/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
