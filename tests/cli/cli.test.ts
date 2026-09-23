import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AgentModel } from "../../dist/agent.js";
import { main, parseCliCommand } from "../../dist/cli.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import type { AgentTool } from "../../dist/tools.js";
import { readTerminalSecret } from "../../dist/cli/secret-input.js";
import { createApiKeyAuth, type ApiKeyProvider } from "../../dist/provider/api-key-auth.js";
import { createSessionStore } from "../../dist/session-store.js";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

test("interactive composer follows model and provider changes without calling a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-identity-"));
  const output: string[] = [];
  try {
    await main([], {
      workingDirectory: root, configPath: join(root, "config.json"), config: {}, sessionDirectory: join(root, "sessions"),
      model: { async respond() { assert.fail("local commands must not call a model"); } }, tools: [],
      input: Readable.from(["/model fixture-model\n/provider chatgpt\n/exit\n"]),
      terminal: { inputIsTTY: true, outputIsTTY: true, color: false, columns: 160 },
      write: (text) => { output.push(text); },
    });
    const transcript = output.join("");
    assert.match(transcript.split("Model changed.")[1]!.split("Provider changed.")[0]!, /⚕ fixture-model │/);
    assert.match(transcript.split("Provider changed.")[1]!, /⚕ \S+ │/);
    assert.doesNotMatch(transcript.split("Provider changed.")[1]!, /⚕ (fixture-model|gpt-4\.1-mini) │/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("CLI reports a missing OpenAI API key even without a home directory", () => {
  const result = runCli(["Say hello"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY is not set/);
});

test("home-less CLI with an environment key proceeds to required local state without consulting secure storage", () => {
  const result = runCli(["Say hello"], { OPENAI_API_KEY: "synthetic-offline-test-key" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to determine a home directory for Dragons memories/);
  assert.doesNotMatch(result.stderr, /credential storage|OPENAI_API_KEY is not set/);
});

test("home-less profile commands still require a profile root", () => {
  const result = runCli(["profile", "list"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to determine a home directory/);
  assert.doesNotMatch(result.stderr, /OPENAI_API_KEY/);
});

test("CLI fails closed on invalid active profile state before model creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-profile-"));
  try {
    const configPath = join(root, "config.json");
    const profiles = createDragonsProfileStore({ configPath });
    await profiles.active();
    await writeFile(join(root, "profiles", "active.json"), '{"version":1,"profile":"../outside"}');
    let modelCreated = false;
    await assert.rejects(main(["Say hello"], {
      configPath,
      modelFactory: () => { modelCreated = true; throw new Error("Must not create a model"); },
      write: () => {},
    }), /Active Dragons profile state is invalid/);
    assert.equal(modelCreated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI does not swallow profile lookup failures resembling missing-home errors", async () => {
  const profiles = createDragonsProfileStore({ configPath: join(tmpdir(), "unused-dragons-profile", "config.json") });
  await assert.rejects(main(["Say hello"], {
    profileStore: { ...profiles, async active() { throw new Error("Unable to determine a home directory: injected lookup failure"); } },
    write: () => {},
  }), /injected lookup failure/);
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
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 1_000)),
  ]);
  input.end();

  assert.equal((result as Error).name, "AgentRunCancelledError");
  assert.equal(executions, 0);
  assert.match(output.join(""), /\? Allow WRITE write_file/);
  assert.match(output.join(""), /Cancelled/);
});

for (const action of ["login", "status", "logout"] as const) {
  test(`interactive ChatGPT ${action} failure stays local and leaves the composer usable`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-cli-oauth-error-"));
    const output: string[] = [];
    let calls = 0;
    const fail = async () => { calls += 1; throw new Error("synthetic-private-auth-detail"); };
    try {
      await main([], {
        workingDirectory: root, configPath: join(root, "config.json"), config: {},
        model: { async respond() { assert.fail("auth commands must not become model input"); } }, tools: [],
        chatgptAuth: { login: fail, status: fail, logout: fail },
        input: Readable.from([`/${action === "status" ? "auth" : action} chatgpt\n/profile\n/exit\n`]),
        write: (text) => output.push(text),
      });
      assert.equal(calls, 1);
      assert.match(output.join(""), /authentication .* failed/);
      assert.match(output.join(""), /Active profile: default/);
      assert.doesNotMatch(output.join(""), /synthetic-private-auth-detail|signed in|signed out/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("interactive ChatGPT login forwards cancellation and resumes local commands", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-oauth-cancel-"));
  const output: string[] = [];
  let aborted = false;
  try {
    await main([], {
      workingDirectory: root, configPath: join(root, "config.json"), config: {},
      model: { async respond() { assert.fail("cancelled login must not call the model"); } }, tools: [],
      chatgptAuth: {
        async login(options) {
          assert.ok(options?.signal, "the interactive controller must reach OAuth");
          process.emit("SIGINT");
          aborted = options.signal.aborted;
          options.signal.throwIfAborted();
        },
        async status() { return { authenticated: false }; },
        async logout() { assert.fail("cancellation must not log out"); },
      },
      input: Readable.from(["/login chatgpt\n/profile\n/exit\n"]),
      write: (text) => output.push(text),
    });
    assert.equal(aborted, true);
    assert.match(output.join(""), /authentication cancelled/);
    assert.match(output.join(""), /Active profile: default/);
    assert.doesNotMatch(output.join(""), /signed in|authentication login failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

class SecretTTY extends PassThrough {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  setRawMode(enabled: boolean): this { this.isRaw = enabled; this.rawModes.push(enabled); return this; }
}

function secretOutput(onWrite: (text: string) => void = () => {}) {
  return { isTTY: true, write(chunk: unknown) { onWrite(String(chunk)); return true; } };
}

// Only synthetic values and in-memory stores: never the machine's credential store.
const fakeSecret = "fixture-only-secret";

test("dedicated secret reader masks edits, drops trailing input and restores terminal/listeners", async () => {
  const input = new SecretTTY();
  input.pause();
  const output: string[] = [];
  const pending = readTerminalSecret(input, secretOutput((text) => output.push(text)), new AbortController().signal);
  input.write("fixture-only-secrex");
  input.write("\u007ft");
  input.write("\rSHOULD-NOT-BECOME-CHAT\n");
  assert.equal(await pending, fakeSecret);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.isPaused(), true);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.doesNotMatch(output.join(""), /fixture|SHOULD/);
  assert.match(output.join(""), /\*+/);
  input.destroy();
});

for (const mode of ["escape", "ctrl-c", "ctrl-d", "eof", "close", "abort", "error", "overflow", "invalid"] as const) {
  test(`dedicated secret reader ${mode} cleans up without returning a key`, async () => {
    const input = new SecretTTY();
    input.isRaw = true;
    const controller = new AbortController();
    const output: string[] = [];
    const pending = readTerminalSecret(input, secretOutput((text) => output.push(text)), controller.signal);
    input.write(fakeSecret);
    if (mode === "eof") input.end();
    else if (mode === "close") input.destroy();
    else if (mode === "abort") controller.abort();
    else if (mode === "error") input.emit("error", new Error(fakeSecret));
    else input.write({ escape: "\u001b", "ctrl-c": "\u0003", "ctrl-d": "\u0004", overflow: "a".repeat(8193), invalid: " " }[mode]);
    if (mode === "error") await assert.rejects(pending, /^Error: Secure terminal input failed\.$/);
    else assert.equal(await pending, undefined);
    assert.equal(input.isRaw, true);
    assert.equal(input.listenerCount("data"), 0);
    assert.doesNotMatch(output.join(""), /fixture-only/);
    input.destroy();
  });
}

test("dedicated secret reader refuses redirected streams and restores raw mode on output failure", async () => {
  const input = new SecretTTY();
  await assert.rejects(readTerminalSecret(input, { ...secretOutput(), isTTY: false }, new AbortController().signal), /requires a dedicated TTY/);
  assert.deepEqual(input.rawModes, []);
  await assert.rejects(readTerminalSecret(input, secretOutput(() => { throw new Error(fakeSecret); }), new AbortController().signal), /^Error: Secure terminal input failed\.$/);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
  input.destroy();
});

test("CLI API-key auth is provider-specific, masked, redacted, and refuses non-TTY login", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-secret-"));
  const input = new SecretTTY();
  const output: string[] = [];
  const terminal: string[] = [];
  const saved = new Map<ApiKeyProvider, string>();
  const apiKeyAuth = createApiKeyAuth("default", (provider) => ({
    async load() { return saved.get(provider); },
    async save(key) { saved.set(provider, key); },
    async remove() { saved.delete(provider); },
  }));
  const dependencies = {
    configPath: join(root, "config.json"), config: {}, apiKeyAuth, input,
    write: (text: string) => output.push(text),
    secretOutput: secretOutput((text) => {
      terminal.push(text);
      if (text === "API key (Enter saves; Esc cancels): ") setImmediate(() => input.write(fakeSecret + "\r"));
    }),
    chatgptAuth: { async login() { assert.fail("wrong provider"); }, async status() { assert.fail("wrong provider"); }, async logout() { assert.fail("wrong provider"); } },
  };
  try {
    for (const provider of ["openai-api", "anthropic", "gemini", "openrouter"] as const) {
      await main(["auth", "login", "--provider", provider], dependencies);
      assert.equal(saved.get(provider), fakeSecret);
      await main(["auth", "status", "--provider", provider], dependencies);
      assert.match(output.join(""), new RegExp(`${provider}: saved API key present`));
      await main(["auth", "logout", "--provider", provider], dependencies);
      assert.equal(saved.has(provider), false);
      await main(["auth", "status", "--provider", provider], dependencies);
      assert.match(output.join(""), new RegExp(`${provider}: no saved API key`));
    }
    await main(["auth", "login", "--provider", "gemini"], { ...dependencies, input: Readable.from([fakeSecret + "\n"]) });
    assert.equal(saved.size, 0);
    assert.match(output.join(""), /requires a dedicated TTY/);
    await main(["auth", "status", "--provider", "gemini"], { ...dependencies, apiKeyAuth: { ...apiKeyAuth, async credentials() { throw new Error(fakeSecret); } } });
    assert.match(output.join(""), /API-key status failed/);
    assert.match(output.join(""), /Restart Dragons/);
    assert.doesNotMatch([...output, ...terminal].join(""), /fixture-only/);
  } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("CLI auth parser rejects inline credentials without reflecting their value", () => {
  for (const args of [
    ["auth", "login", "--provider", "gemini", fakeSecret],
    ["auth", "status", "--provider", fakeSecret],
    ["auth", "logout", "--provider", "chatgpt", fakeSecret],
  ]) assert.throws(() => parseCliCommand(args), (error: unknown) => error instanceof Error && !error.message.includes(fakeSecret));
});

test("plain non-TTY login refuses without sending subsequent piped input to the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-piped-secret-"));
  const output: string[] = [];
  try {
    await main([], {
      workingDirectory: root, configPath: join(root, "config.json"), config: {}, sessionDirectory: join(root, "sessions"),
      model: { async respond() { assert.fail("piped secret must not become chat"); } }, tools: [],
      input: Readable.from(["/login gemini\n", fakeSecret + "\n"]), write: (text) => output.push(text),
      apiKeyAuth: {
        async credentials() { assert.fail("no store access"); }, async logout() { assert.fail("no store access"); },
        async login() { assert.fail("no login callback on non-TTY"); },
      },
    });
    assert.match(output.join(""), /requires a dedicated TTY/);
    assert.doesNotMatch(output.join(""), /fixture-only/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["escape", "eof", "store-error"] as const) {
  test(`plain interactive login ${mode} preserves credentials and restores terminal`, { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-cli-cancel-secret-"));
    const input = new SecretTTY();
    const output: string[] = [];
    let requested = false;
    const apiKeyAuth = createApiKeyAuth("default", () => ({
      async load() { return "previous-fixture"; },
      async save() { if (mode !== "store-error") assert.fail("cancel must not save"); throw new Error(fakeSecret); },
      async remove() { assert.fail("must not remove"); },
    }));
    try {
      await main([], {
        workingDirectory: root, configPath: join(root, "config.json"), config: {}, sessionDirectory: join(root, "sessions"),
        model: { async respond() { assert.fail("no model calls"); } }, tools: [], input, apiKeyAuth,
        terminal: { inputIsTTY: false, outputIsTTY: false },
        secretOutput: secretOutput((text) => {
          if (text === "API key (Enter saves; Esc cancels): ") setImmediate(() => {
            input.write(fakeSecret);
            if (mode === "eof") input.end();
            else input.write(mode === "escape" ? "\u001b" : "\r");
          });
        }),
        write(text) {
          output.push(text);
          if (!requested && text.includes("Session:")) { requested = true; setImmediate(() => input.write("/login gemini\n")); }
          if (mode !== "eof" && /sign-in cancelled|API-key login failed/.test(text)) setImmediate(() => input.write("/exit\n"));
        },
      });
      assert.equal(await apiKeyAuth.credentials("gemini"), "previous-fixture");
      assert.match(output.join(""), mode === "store-error" ? /API-key login failed/ : /sign-in cancelled/);
      assert.doesNotMatch(output.join(""), /fixture-only/);
      assert.equal(input.isRaw, false);
      assert.equal(input.listenerCount("data"), 0);
    } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
  });
}

test("plain interactive API login detaches readline, keeps secrets out of sessions/model/logs and resumes commands", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-interactive-secret-"));
  const input = new SecretTTY();
  const output: string[] = [];
  let stored: string | undefined;
  let requested = false;
  let modelCalls = 0;
  const store = createSessionStore(join(root, "sessions"));
  const apiKeyAuth = createApiKeyAuth("default", () => ({
    async load() { return stored; }, async save(key) { stored = key; }, async remove() { stored = undefined; },
  }));
  try {
    await main([], {
      workingDirectory: root, configPath: join(root, "config.json"), config: {}, sessionStore: store,
      model: { async respond() { modelCalls += 1; throw new Error("No chat should run"); } }, tools: [], input, apiKeyAuth,
      terminal: { inputIsTTY: false, outputIsTTY: false },
      secretOutput: secretOutput((text) => {
        assert.ok(!text.includes(fakeSecret));
        if (text === "API key (Enter saves; Esc cancels): ") {
          assert.equal(input.listenerCount("data"), 1, "readline must be detached");
          setImmediate(() => input.write(fakeSecret + "\rdiscard-this-tail\n"));
        }
      }),
      write(text) {
        output.push(text);
        if (!requested && text.includes("Session:")) { requested = true; setImmediate(() => input.write("/login gemini\n")); }
        if (text.includes("API key saved")) setImmediate(() => input.write("/auth gemini\n/logout gemini\n/auth gemini\n/exit\n"));
      },
    });
    assert.equal(modelCalls, 0);
    assert.equal(stored, undefined);
    assert.match(output.join(""), /gemini: saved API key present/);
    assert.match(output.join(""), /gemini: no saved API key/);
    assert.doesNotMatch(output.join(""), /fixture-only|discard-this-tail/);
    for (const summary of await store.list()) {
      const session = await store.load(summary.id);
      assert.ok(session);
      assert.equal(session.messages.length, 0);
      assert.ok(!JSON.stringify(session).includes(fakeSecret));
    }
    assert.equal(input.isRaw, false);
  } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
});
