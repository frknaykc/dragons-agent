import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { AgentRunCancelledError } from "../../dist/agent.js";
import { main } from "../../dist/cli.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createCodingTools } from "../../dist/tools.js";

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}
class Output extends Writable {
  isTTY = true;
  columns = 120;
  rows = 30;
  text = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString(); callback();
  }
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
async function until(check: () => boolean | Promise<boolean>, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Coding flow timeout: ${diagnostic().slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const tui of [false, true]) {
  test(`CT03 ${tui ? "TUI" : "CLI"} real coding tools, approvals, cancellation and persisted resume`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons coding 世界-"));
    const results = new Map<string, string>();
    const tasks: string[] = [];
    let modelWaiting = false;
    let modelCancelled = false;
    let resumedFrom: string | undefined;
    const store = createSessionStore(join(root, "sessions"), { providerIds: ["fixture"] });
    const providers = createProviderRegistry([{
      id: "fixture", label: "Offline coding fixture", defaultModel: "initial-model", credentialRequirement: "none",
      capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
      createModel: () => ({ async respond(request, delta) {
        const task = request.task;
        if (request.toolOutputs.length === 0) {
          tasks.push(task);
          if (task === "wait-model") {
            modelWaiting = true;
            return new Promise<never>((_resolve, reject) => {
              const cancel = (): void => { modelCancelled = true; reject(new AgentRunCancelledError()); };
              if (request.signal?.aborted) cancel(); else request.signal?.addEventListener("abort", cancel, { once: true });
            });
          }
          if (task === "resume-check") resumedFrom = request.conversationResponseId;
          const call = task === "read" ? { name: "read_file", input: { path: "source 世界.txt" } }
            : task.startsWith("write-") ? { name: "write_file", input: { path: `${task}.txt`, content: "approved change" } }
            : task.startsWith("shell-") ? { name: "shell", input: { command: `"${process.execPath}" "command fixture.cjs" ${task}` } }
            : undefined;
          if (call) return { responseId: `call-${task}`, text: "", toolCalls: [{ callId: task, name: call.name, arguments: JSON.stringify(call.input) }] };
        } else {
          results.set(task, request.toolOutputs.map((entry) => entry.output).join("\n"));
        }
        const text = `DONE ${task}`;
        delta?.(text);
        return { responseId: `done-${task}`, text, textWasStreamed: true, toolCalls: [] };
      } }),
    }]);
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const initialListeners = signals.map((signal) => process.listenerCount(signal));
    const tools = (await createCodingTools(root, { shellTimeoutMilliseconds: 15_000 }))
      .filter((tool) => ["read_file", "write_file", "shell"].includes(tool.name));
    await writeFile(join(root, "source 世界.txt"), "fixture source content\n");
    await writeFile(join(root, "command fixture.cjs"), [
      'const fs = require("node:fs");',
      'const mode = process.argv[2];',
      'if (mode === "shell-fail") { process.stderr.write("FIXTURE_FAILURE"); process.exitCode = 7; }',
      'else if (mode === "shell-wait") { fs.writeFileSync("shell-started.txt", "started"); setInterval(() => {}, 1000); }',
      'else { fs.writeFileSync(mode + ".txt", "executed"); process.stdout.write("SHELL_OK"); }',
    ].join("\n"));
    const open = (resume?: string) => {
      const input = new Input();
      const output = new Output();
      let closed = false;
      const arguments_ = tui ? ["--tui", ...(resume ? ["--resume", resume] : [])] : resume ? ["session", "resume", resume] : [];
      const running = main(arguments_, {
        workingDirectory: root, configPath: join(root, "config.json"),
        config: { provider: "fixture", maxTurns: 5 }, providerRegistry: providers, sessionStore: store, tools,
        input, tuiOutput: output, write: (text) => { output.text += text; },
        terminal: { inputIsTTY: false, outputIsTTY: false, color: false },
        memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"), backgroundJobsDirectory: join(root, "jobs"),
      });
      void running.catch(() => {});
      return { input, output, running,
        send(text: string) {
          output.text = "";
          // Request a complete frame: the production renderer otherwise writes only changed rows.
          if (tui) output.emit("resize");
          input.write(text + (tui ? "\r" : "\n"));
        },
        async wait(text: string, ready = false) {
          await until(() => output.text.includes(text) && (!ready || !tui || output.text.includes(" | READY")), () => output.text);
        },
        cancel() { if (tui) input.write("\x03"); else process.emit("SIGINT"); },
        async close() {
          if (closed) return;
          closed = true;
          if (tui) input.write("\x04"); else input.write("/exit\n");
          input.end();
          try { await running; } finally { input.destroy(); output.destroy(); }
        },
      };
    };
    let client = open();
    try {
      if (tui) await client.wait("fixture / initial-model | READY");
      // Completed arguments include the space added by the local slash picker.
      client.send("/provider fixture ");
      await client.wait(tui ? "New session started with the selected provider/model." : "Provider changed.", true);
      client.send("/model coding-model");
      await client.wait(tui ? "fixture / coding-model | READY" : "Model changed.", true);
      assert.deepEqual(tasks, [], "local selectors must not invoke a provider");
      client.send("read");
      await client.wait("DONE read", true);
      assert.match(results.get("read")!, /fixture source content/);
      assert.doesNotMatch(client.output.text, /PERMISSION:|\? Allow/);
      for (const task of ["write-deny", "write-allow", "shell-deny", "shell-allow", "shell-fail", "shell-wait"]) {
        const name = task.startsWith("write-") ? "write_file" : "shell";
        const operation = name === "shell" ? "EXECUTE" : "WRITE";
        client.send(task);
        await client.wait(tui ? `PERMISSION: ${operation} ${name}` : `? Allow ${operation} ${name}`);
        assert.equal(await exists(join(root, `${task}.txt`)), false, "no mutation before approval");
        if (task === "shell-wait") assert.equal(await exists(join(root, "shell-started.txt")), false);
        const allow = !task.endsWith("deny");
        client.input.write(tui ? (allow ? "\t\r" : "\r") : (allow ? "yes\n" : "\n"));
        if (task === "shell-wait") {
          await until(() => exists(join(root, "shell-started.txt")), () => client.output.text);
          client.cancel();
          await client.wait(tui ? "Run cancelled." : "Cancelled.", true);
          assert.equal(results.has(task), false, "cancelled shell must not continue to another model turn");
        } else {
          await client.wait(`DONE ${task}`, true);
          if (!allow) {
            assert.match(results.get(task)!, /Authorization denied/);
            assert.equal(await exists(join(root, `${task}.txt`)), false);
          } else if (task === "shell-fail") assert.match(results.get(task)!, /FIXTURE_FAILURE/);
          else assert.equal(await readFile(join(root, `${task}.txt`), "utf8"), name === "shell" ? "executed" : "approved change");
        }
      }
      client.send("wait-model");
      await until(() => modelWaiting, () => client.output.text);
      client.cancel();
      await client.wait(tui ? "Run cancelled." : "Cancelled.", true);
      assert.equal(modelCancelled, true);
      client.send("after-cancel");
      await client.wait("DONE after-cancel", true);
      await client.close();
      assert.equal(client.input.isRaw, false);
      assert.deepEqual(tools.map((tool) => tool.name), ["read_file", "write_file", "shell"], "client-owned tools must not leak into caller bindings");
      if (tui) assert.ok(client.output.text.includes("\x1b[?1049l"));
      const session = (await store.list()).find((entry) => entry.continuation?.responseId === "done-after-cancel");
      assert.ok(session, "the successful turn must be persisted");
      assert.equal(session.model, "coding-model");
      client = open(session.id);
      if (tui) await client.wait("fixture / coding-model | READY");
      client.send("resume-check");
      await client.wait("DONE resume-check", true);
      assert.equal(resumedFrom, "done-after-cancel");
      await client.close();
      assert.equal(client.input.isRaw, false);
      assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), initialListeners);
    } finally {
      await client.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
