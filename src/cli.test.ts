import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { main, parseCliCommand } from "./cli.js";
import type { AgentTool } from "./tools.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

function runCli(arguments_: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...environment },
  });
}

test("CLI accepts no prompt as an interactive command", () => {
  assert.deepEqual(parseCliCommand([]), {
    kind: "run",
    provider: "openai-api",
    model: undefined,
    prompt: undefined,
  });
});

test("CLI reports a missing OpenAI API key", () => {
  const result = runCli(["Say hello"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY is not set/);
});

test("CLI reports that ChatGPT Subscription login is required without falling back to an API key", async () => {
  const output: string[] = [];
  await assert.rejects(main(["--provider", "chatgpt", "Say hello"], {
    chatgptAuth: {
      credentials: {
        async getValidCredentials() {
          throw new Error("ChatGPT Subscription login is required. Run dragons auth login --provider chatgpt.");
        },
      },
      async login() {},
      async status() { return { authenticated: false }; },
      async logout() {},
    },
    tools: [],
    input: Readable.from([]),
    write: (text: string) => output.push(text),
  }), /ChatGPT Subscription login is required/);

  assert.doesNotMatch(output.join(""), /OPENAI_API_KEY/);
});

const inputSchema = {
  type: "object" as const,
  properties: {},
  additionalProperties: false as const,
};

test("CLI allows grep read tools without an approval prompt", async () => {
  let executed = false;
  let turn = 0;
  const output: string[] = [];
  const tool: AgentTool = {
    name: "grep",
    operation: "READ",
    description: "Search files.",
    inputSchema,
    async execute() {
      executed = true;
      return { ok: true, output: "Read fixture" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "grep", arguments: "{}" }],
        };
      }

      assert.deepEqual(request.toolOutputs, [{ callId: "call-1", output: "Read fixture" }]);
      return { responseId: "response-2", text: "Done.", toolCalls: [] };
    },
  };

  await main(["Read the fixture."], {
    model,
    tools: [tool],
    input: Readable.from(["yes\n"]),
    write: (text: string) => output.push(text),
  });

  assert.equal(executed, true);
  assert.doesNotMatch(output.join(""), /\? Allow/);
});

test("CLI discovers project context from its active working directory without printing it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-agent-cli-context-"));
  await writeFile(join(workspace, "AGENTS.md"), "Use CLI fixtures.\n", "utf8");
  const output: string[] = [];
  const model: AgentModel = {
    async respond(request) {
      assert.deepEqual(request.projectContext?.instructions, {
        path: "AGENTS.md",
        content: "Use CLI fixtures.\n",
      });
      assert.deepEqual(request.projectContext?.git, { isRepository: false });
      return { responseId: "response-1", text: "Done.", toolCalls: [] };
    },
  };

  try {
    await main(["Inspect the fixture."], {
      workingDirectory: workspace,
      model,
      tools: [],
      input: Readable.from([]),
      write: (text: string) => output.push(text),
    });
    assert.doesNotMatch(output.join(""), /Use CLI fixtures/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CLI approves each mutating tool call only once", async () => {
  let executions = 0;
  let turn = 0;
  const output: string[] = [];
  const tool: AgentTool = {
    name: "write_file",
    operation: "WRITE",
    description: "Write a file.",
    inputSchema,
    async execute() {
      executions += 1;
      return { ok: true, output: "Wrote fixture" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "write_file", arguments: "{}" }],
        };
      }
      if (turn === 2) {
        assert.deepEqual(request.toolOutputs, [{ callId: "call-1", output: "Wrote fixture" }]);
        return {
          responseId: "response-2",
          text: "",
          toolCalls: [{ callId: "call-2", name: "write_file", arguments: "{}" }],
        };
      }

      assert.deepEqual(request.toolOutputs, [
        { callId: "call-2", output: "Authorization denied for write_file." },
      ]);
      return { responseId: "response-3", text: "Second write denied.", toolCalls: [] };
    },
  };

  await main(["Write twice."], {
    model,
    tools: [tool],
    input: Readable.from(["yes\n", "\n"]),
    write: (text: string) => output.push(text),
  });

  assert.equal(executions, 1);
  assert.equal(output.join("").match(/\? Allow WRITE write_file/g)?.length, 2);
});

test("CLI denies an edit without changing the fixture or executing the tool", async () => {
  const originalSource = "return left - right;";
  let source = originalSource;
  let executions = 0;
  let turn = 0;
  const output: string[] = [];
  const tool: AgentTool = {
    name: "edit_file",
    operation: "WRITE",
    description: "Edit a file.",
    inputSchema,
    async execute() {
      executions += 1;
      source = "return left + right;";
      return { ok: true, output: "Edited fixture" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{
            callId: "call-1",
            name: "edit_file",
            arguments: '{"path":"calculator.js","oldText":"return left - right;","newText":"return left + right;"}',
          }],
        };
      }

      assert.deepEqual(request.toolOutputs, [
        { callId: "call-1", output: "Authorization denied for edit_file." },
      ]);
      return { responseId: "response-2", text: "Edit denied.", toolCalls: [] };
    },
  };

  await main(["Fix the fixture."], {
    model,
    tools: [tool],
    input: Readable.from(["no\n"]),
    write: (text: string) => output.push(text),
  });

  assert.equal(executions, 0);
  assert.equal(source, originalSource);
  assert.match(output.join(""), /\? Allow WRITE edit_file with \{"path":"calculator\.js"/);
});

test("CLI denies an explicit non-allow response without executing a shell tool", async () => {
  let executed = false;
  let turn = 0;
  const output: string[] = [];
  const tool: AgentTool = {
    name: "shell",
    operation: "EXECUTE",
    description: "Run a command.",
    inputSchema,
    async execute() {
      executed = true;
      return { ok: true, output: "Command ran" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "shell", arguments: "{}" }],
        };
      }

      assert.deepEqual(request.toolOutputs, [
        { callId: "call-1", output: "Authorization denied for shell." },
      ]);
      return { responseId: "response-2", text: "Shell denied.", toolCalls: [] };
    },
  };

  await main(["Run a command."], {
    model,
    tools: [tool],
    input: Readable.from(["no\n"]),
    write: (text: string) => output.push(text),
  });

  assert.equal(executed, false);
  assert.match(output.join(""), /\? Allow EXECUTE shell with \{\}\? \[y\/N\]/);
});

test("CLI denies an EOF approval response without executing a shell tool", async () => {
  let executed = false;
  let turn = 0;
  const tool: AgentTool = {
    name: "shell",
    operation: "EXECUTE",
    description: "Run a command.",
    inputSchema,
    async execute() {
      executed = true;
      return { ok: true, output: "Command ran" };
    },
  };
  const model: AgentModel = {
    async respond(request) {
      turn += 1;
      if (turn === 1) {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "call-1", name: "shell", arguments: "{}" }],
        };
      }

      assert.deepEqual(request.toolOutputs, [
        { callId: "call-1", output: "Authorization denied for shell." },
      ]);
      return { responseId: "response-2", text: "Shell denied.", toolCalls: [] };
    },
  };

  await main(["Run a command."], {
    model,
    tools: [tool],
    input: Readable.from([]),
    write: () => undefined,
  });

  assert.equal(executed, false);
});

test("CLI selects the experimental ChatGPT provider without changing the API-key default", async () => {
  const selected: string[] = [];
  const output: string[] = [];
  const model: AgentModel = {
    async respond() {
      return { responseId: "response-1", text: "Hello.", toolCalls: [] };
    },
  };
  const dependencies = {
    modelFactory: (provider: "openai-api" | "chatgpt", _model?: string) => {
      selected.push(provider);
      return model;
    },
    tools: [],
    input: Readable.from([]),
    write: (text: string) => output.push(text),
  };

  await main(["Hello"], dependencies);
  await main(["--provider", "chatgpt", "Hello"], dependencies);

  assert.deepEqual(selected, ["openai-api", "chatgpt"]);
  assert.match(output.join(""), /Hello\./);
});

test("CLI exposes ChatGPT Subscription experimental auth status and logout", async () => {
  const output: string[] = [];
  let loggedOut = false;
  const chatgptAuth = {
    async login() {},
    async status() { return { authenticated: true, expiresAt: "2026-09-04T00:00:00.000Z", storage: "macOS Keychain" }; },
    async logout() { loggedOut = true; },
  };

  await main(["auth", "status"], { chatgptAuth, write: (text: string) => output.push(text) });
  await main(["auth", "logout", "--provider", "chatgpt"], { chatgptAuth, write: (text: string) => output.push(text) });

  assert.match(output.join(""), /ChatGPT Subscription \(Experimental\): signed in/);
  assert.match(output.join(""), /Credential storage: macOS Keychain/);
  assert.match(output.join(""), /ChatGPT Subscription \(Experimental\): signed out/);
  assert.equal(loggedOut, true);
});

test("CLI accepts pnpm's forwarded separator before auth commands", async () => {
  const output: string[] = [];
  await main(["--", "auth", "status"], {
    chatgptAuth: {
      async login() {},
      async status() { return { authenticated: false }; },
      async logout() {},
    },
    write: (text: string) => output.push(text),
  });

  assert.match(output.join(""), /ChatGPT Subscription \(Experimental\): not signed in/);
});

test("CLI Ctrl+C cancels an active model request without rendering completion", async () => {
  const output: string[] = [];
  let executions = 0;
  const model: AgentModel = {
    respond(request) {
      const signal = request.signal;
      return new Promise((resolve, reject) => {
        const abort = (): void => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        process.nextTick(() => process.emit("SIGINT"));
        setTimeout(() => resolve({
          responseId: "response-1",
          text: "Should not complete.",
          toolCalls: [{ callId: "blocked", name: "write_file", arguments: "{}" }],
        }), 30);
      });
    },
  };

  await assert.rejects(main(["Cancel the request."], {
    model,
    tools: [{
      name: "write_file",
      operation: "WRITE",
      description: "Write a file.",
      inputSchema,
      async execute() {
        executions += 1;
        return { ok: true, output: "Wrote fixture" };
      },
    }],
    input: Readable.from([]),
    write: (text: string) => output.push(text),
  }), { name: "AgentRunCancelledError" });

  assert.equal(executions, 0);
  assert.deepEqual(output, ["\nCancelled.\n"]);
});

test("CLI Ctrl+C cancels an outstanding approval prompt without waiting for input", async () => {
  const output: string[] = [];
  const input = new PassThrough();
  let executions = 0;
  const run = main(["Cancel the approval."], {
    model: {
      async respond() {
        return {
          responseId: "response-1",
          text: "",
          toolCalls: [{ callId: "blocked", name: "write_file", arguments: "{}" }],
        };
      },
    },
    tools: [{
      name: "write_file",
      operation: "WRITE",
      description: "Write a file.",
      inputSchema,
      async execute() {
        executions += 1;
        return { ok: true, output: "Wrote fixture" };
      },
    }],
    input,
    write: (text: string) => {
      output.push(text);
      if (text.includes("? Allow")) process.nextTick(() => process.emit("SIGINT"));
    },
  });

  const result = await Promise.race([
    run.then(() => "completed", (error: unknown) => error),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ]);
  input.end();

  assert.equal((result as Error).name, "AgentRunCancelledError");
  assert.equal(executions, 0);
  assert.match(output.join(""), /\? Allow WRITE write_file/);
  assert.match(output.join(""), /Cancelled/);
});
