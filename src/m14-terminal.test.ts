import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { main } from "./cli.js";
import type { DragonsSession, SessionStore } from "./session-store.js";
import {
  createTerminalRenderer,
  formatApproval,
  formatElapsedTime,
  formatStatusLine,
  formatToolEvent,
  formatSeparator,
} from "./terminal/renderer.js";

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
import { DRAGONS_BANNER } from "./terminal/banner.js";

test("M14 banner and composer render the active TTY identity", () => {
  const output: string[] = [];
  let now = 0;
  const renderer = createTerminalRenderer({
    write: (text) => output.push(text),
    isTTY: true,
    color: false,
    width: 120,
    now: () => now,
  });

  renderer.renderStartup({
    provider: "ChatGPT Subscription (Experimental)",
    model: "gpt-5.6-terra",
    workingDirectory: "/work/dragons",
  });
  now = 44_000;
  renderer.renderComposer();

  const rendered = output.join("");
  assert.match(DRAGONS_BANNER, /𓆩 -- we are the recall\. not born\. remembered\. -- 𓆪/);
  assert.match(rendered, /██████╗ ██████╗/);
  assert.match(rendered, /ChatGPT Subscription \(Experimental\) · gpt-5\.6-terra/);
  assert.match(rendered, /\/work\/dragons/);
  assert.match(rendered, /⚕ gpt-5\.6-terra │ ctx -- │ \[░░░░░░░░░░\] idle │ 44s │ ⏲ 0s/);
  assert.match(rendered, /𓆩 DRAGON 𓆪 Ask anything, or type \/ for commands…/);
});

test("M14 renders one warm-colored interactive input surface", () => {
  const output: string[] = [];
  const renderer = createTerminalRenderer({
    write: (text) => output.push(text),
    isTTY: true,
    color: true,
    width: 100,
    now: () => 0,
  });

  renderer.renderStartup({ provider: "OpenAI API", model: "gpt-4.1-mini", workingDirectory: "." });
  renderer.renderComposer();

  const rendered = output.join("");
  const plain = rendered.replace(/\x1b\[[0-9;]*m/gu, "");
  assert.equal((plain.match(/𓆩 DRAGON 𓆪/gu) ?? []).length, 1);
  assert.match(plain, /𓆩 DRAGON 𓆪 Ask anything, or type \/ for commands… › /u);
  assert.match(rendered, /\x1b\[31m/);
  assert.match(rendered, /\x1b\[33m/);
  assert.match(rendered, /\x1b\[93m/);
  assert.doesNotMatch(rendered, /\x1b\[35m/);

  const noColorOutput: string[] = [];
  const noColorRenderer = createTerminalRenderer({
    write: (text) => noColorOutput.push(text),
    isTTY: true,
    color: false,
    width: 100,
    now: () => 0,
  });
  noColorRenderer.renderStartup({ provider: "OpenAI API", model: "gpt-4.1-mini", workingDirectory: "." });
  noColorRenderer.renderComposer();
  assert.doesNotMatch(noColorOutput.join(""), /\x1b\[/);
});

test("M14 presentation formatters retain real values and concise distinctions", () => {
  assert.equal(formatElapsedTime(0), "0s");
  assert.equal(formatElapsedTime(44_000), "44s");
  assert.equal(formatElapsedTime(65_000), "1m 05s");
  assert.equal(formatStatusLine({
    model: "gpt-5.6-terra",
    context: undefined,
    state: "idle",
    frame: 0,
    sessionElapsedMs: 44_000,
    runElapsedMs: undefined,
  }), "⚕ gpt-5.6-terra │ ctx -- │ [░░░░░░░░░░] idle │ 44s │ ⏲ 0s");
  assert.equal(formatToolEvent({ name: "read_file", operation: "READ", arguments: '{"path":"src/agent.ts"}' }), "◇ read_file  src/agent.ts");
  assert.equal(formatToolEvent({ name: "edit_file", operation: "WRITE", arguments: '{"path":"src/agent.ts"}' }), "◆ edit_file  src/agent.ts");
  assert.equal(formatToolEvent({ name: "shell", operation: "EXECUTE", arguments: '{"command":"pnpm test"}' }), "▶ shell  pnpm test");
  assert.match(formatApproval({ name: "edit_file", operation: "WRITE", arguments: '{"path":"src/agent.ts"}' }, 44), /WRITE · edit_file/);
  assert.match(formatApproval({ name: "shell", operation: "EXECUTE", arguments: '{"command":"pnpm test"}' }, 44), /pnpm test/);
});

test("M14 separators fit width and non-TTY output has no terminal control sequences", () => {
  assert.equal(formatSeparator(5), "─────");
  assert.equal(formatSeparator(0), "─");
  const output: string[] = [];
  const renderer = createTerminalRenderer({
    write: (text) => output.push(text),
    isTTY: false,
    color: false,
    width: 20,
    now: () => 0,
  });

  renderer.renderStartup({ provider: "OpenAI API", model: "gpt-4.1-mini", workingDirectory: "/work" });
  renderer.startRun("thinking");
  renderer.renderMessage("plain streamed text");
  renderer.finishRun();

  renderer.renderToolCompleted("shell", true);

  assert.equal(output.join(""), "plain streamed text\n✓ shell\n");
  assert.doesNotMatch(output.join(""), /\x1b\[/);
});

test("M14 renders a transient TTY activity line and clears it before streamed text", () => {
  const output: string[] = [];
  const renderer = createTerminalRenderer({
    write: (text) => output.push(text),
    isTTY: true,
    color: false,
    width: 100,
    now: () => 0,
  });
  renderer.renderStartup({ provider: "OpenAI API", model: "gpt-4.1-mini", workingDirectory: "/work" });
  renderer.startRun("thinking");
  renderer.renderMessage("Streamed text.");
  renderer.finishRun();

  const rendered = output.join("");
  assert.match(rendered, /\[▓░░░░░░░░░\] ⠋ thinking/);
  assert.match(rendered, /\x1b\[2KStreamed text\./);
});

test("M14 shows the banner only for interactive TTY conversations and preserves one-shot output", async () => {
  const model: AgentModel = {
    async respond(_request, onTextDelta) {
      onTextDelta?.("Streamed once.");
      return { responseId: "response-1", text: "Streamed once.", textWasStreamed: true, toolCalls: [] };
    },
  };
  const interactiveOutput: string[] = [];

  await main(["--provider", "chatgpt", "--model", "gpt-5.6-terra"], {
    sessionStore: ephemeralSessionStore(),
    model,
    tools: [],
    input: Readable.from(["Hello\n", "exit\n"]),
    write: (text) => interactiveOutput.push(text),
    terminal: { inputIsTTY: true, outputIsTTY: true, columns: 100, color: false },
  });

  const interactive = interactiveOutput.join("");
  assert.match(interactive, /██████╗ ██████╗/);
  assert.match(interactive, /ChatGPT Subscription \(Experimental\) · gpt-5\.6-terra/);
  assert.match(interactive, /𓆩 DRAGON 𓆪 Ask anything, or type \/ for commands…/);
  assert.equal((interactive.match(/Streamed once\./g) ?? []).length, 1);

  const oneShotOutput: string[] = [];
  await main(["Explain this project"], {
    model,
    tools: [],
    input: Readable.from([]),
    write: (text) => oneShotOutput.push(text),
    terminal: { inputIsTTY: true, outputIsTTY: true, columns: 100, color: false },
  });

  assert.doesNotMatch(oneShotOutput.join(""), /██████╗/);
  assert.doesNotMatch(oneShotOutput.join(""), /\x1b\[/);
});

test("M14 uses its terminal-width fallback when a TTY reports zero columns", async () => {
  const output: string[] = [];
  await main([], {
    sessionStore: ephemeralSessionStore(),
    model: { async respond() { throw new Error("model should not run"); } },
    tools: [],
    input: Readable.from(["exit\n"]),
    write: (text) => output.push(text),
    terminal: { inputIsTTY: true, outputIsTTY: true, columns: 0, color: false },
  });

  assert.match(output.join(""), new RegExp(`\\n${"─".repeat(80)}\\n`));
});
