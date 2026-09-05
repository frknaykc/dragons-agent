import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { main } from "./cli.js";
import { createProviderRegistry } from "./provider/registry.js";

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}
class Output extends Writable {
  isTTY = true;
  columns = 100;
  rows = 24;
  text = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { this.text += chunk.toString(); callback(); }
}
async function until(check: () => boolean, diagnostic: () => string): Promise<void> {
  const limit = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= limit) throw new Error(`TUI state timeout: ${diagnostic().slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("M72 real CLI/TUI composition preserves draft on resize and restores terminal on exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-tui-terminal-"));
  const input = new Input();
  const output = new Output();
  const tasks: string[] = [];
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-model", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request, delta) {
      tasks.push(request.task);
      delta?.("Streamed answer");
      return { responseId: "fixture", text: "Streamed answer", textWasStreamed: true, toolCalls: [] };
    } }),
  }]);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map((signal) => process.listenerCount(signal));
  const running = main(["--tui"], { workingDirectory: root, providerRegistry: providers, config: {}, tools: [], input, tuiOutput: output,
    sessionDirectory: join(root, "sessions"), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  const observed = running.catch((error: unknown) => { throw error; });
  try {
    await until(() => output.text.includes("fixture-model"), () => output.text);
    input.write("Merhaba 世界");
    await until(() => output.text.includes("Merhaba 世界"), () => output.text);
    output.columns = 1; output.rows = 1; output.emit("resize");
    await new Promise((resolve) => setTimeout(resolve, 60));
    output.columns = 80; output.rows = 24; output.text = ""; output.emit("resize");
    await until(() => output.text.includes("Merhaba 世界"), () => output.text);
    input.write("\r");
    await until(() => output.text.includes("Dragon: Streamed answer"), () => output.text);
    assert.deepEqual(tasks, ["Merhaba 世界"]);
    input.write("\x04");
    await observed;
    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
    for (const sequence of ["\x1b[?2004l", "\x1b[?25h", "\x1b[?1049l"]) assert.ok(output.text.includes(sequence));
    assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), listeners);
    assert.equal(input.listenerCount("data"), 0);
  } finally {
    input.write("\x04"); input.end();
    await running.catch(() => {});
    input.destroy(); output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("M72 TUI honors configured provider/model, context budget and maximum turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-tui-config-"));
  const input = new Input();
  const output = new Output();
  let calls = 0;
  let budget: number | undefined;
  let model: string | undefined;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "default-model", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: (options) => {
      model = options.model;
      return { async respond(request) {
        calls += 1; budget = request.contextBudgetChars;
        return { responseId: `turn-${calls}`, text: "", toolCalls: [{ callId: `read-${calls}`, name: "fixture_read", arguments: "{}" }] };
      } };
    },
  }]);
  const running = main(["--tui"], { workingDirectory: root, providerRegistry: providers,
    config: { provider: "fixture", models: { fixture: "configured-model" }, maxTurns: 1, contextBudgetChars: 2000 },
    tools: [{ name: "fixture_read", description: "Synthetic read", operation: "READ", inputSchema: { type: "object", properties: {} }, execute: async () => ({ ok: true, output: "read" }) }],
    input, tuiOutput: output, sessionDirectory: join(root, "sessions"), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  void running.catch(() => {});
  try {
    await until(() => output.text.includes("configured-model"), () => output.text);
    output.text = "";
    input.write("read repeatedly\r");
    await until(() => calls > 0 && output.text.includes("Error:"), () => output.text);
    assert.equal(budget, 2000);
    assert.equal(calls, 1);
    assert.equal(model, "configured-model");
  } finally {
    input.write("\x04"); input.end();
    await running.catch(() => {});
    input.destroy(); output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("M72 --tui non-TTY fails with a plain actionable error before creating a session", async () => {
  let writes = "";
  await assert.rejects(main(["--tui"], { config: {}, input: new PassThrough(), write: (text) => { writes += text; } }), /requires a TTY.*plain\/headless/);
  assert.equal(writes, "");
});
