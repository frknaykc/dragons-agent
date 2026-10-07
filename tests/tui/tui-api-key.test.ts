import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { main } from "../../dist/cli.js";
import { createApiKeyAuth } from "../../dist/provider/api-key-auth.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(raw: boolean): this { this.isRaw = raw; return this; } }
class Output extends Writable {
  isTTY = true; columns = 120; rows = 24; text = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void { this.text += chunk.toString(); callback(); }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for masked UI"); await new Promise((r) => setTimeout(r, 10)); }
}
for (const outcome of ["save", "cancel", "store-error"] as const) test(`TUI masked API-key integration: ${outcome}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-api-key-"));
  const input = new Input(); const output = new Output();
  let saved: string | undefined; let prompts = 0;
  const auth = createApiKeyAuth("default", () => ({ async load() { return undefined; }, async remove() {}, async save(key) { prompts++; if (outcome === "store-error") throw new Error(key); saved = key; } }));
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture-model", credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel: () => ({ async respond() { throw new Error("Secret must never reach model"); } }) }]);
  const running = main(["--tui"], { workingDirectory: root, configPath: join(root, "config.json"), config: {}, providerRegistry: providers, apiKeyAuth: auth, input, tuiOutput: output, tools: [] });
  void running.catch(() => {});
  try {
    await until(() => output.text.includes("fixture / fixture-model | READY"));
    input.write("/login anthropic \r");
    await until(() => output.text.includes("API key (Enter saves"));
    input.write("synthetic-private-key");
    await until(() => output.text.includes("*****"));
    assert.ok(!output.text.includes("synthetic-private-key"));
    input.write(outcome === "cancel" ? "\x1b" : "\r");
    if (outcome === "save") { await running; assert.equal(saved, "synthetic-private-key"); }
    else {
      await until(() => output.text.includes(outcome === "cancel" ? "sign-in cancelled" : "Unable to complete local command"));
      assert.equal(saved, undefined);
      input.write("\x04"); await running;
    }
    assert.equal(prompts, outcome === "cancel" ? 0 : 1);
    assert.ok(!output.text.includes("synthetic-private-key"));
    const files = await readdir(root, { recursive: true });
    for (const file of files.filter((f) => f.endsWith(".json"))) assert.ok(!(await readFile(join(root, file), "utf8")).includes("synthetic-private-key"));
  } finally { input.end(); await running.catch(() => {}); input.destroy(); output.destroy(); await rm(root, { recursive: true, force: true }); }
});
