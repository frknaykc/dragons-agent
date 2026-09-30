import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import vm from "node:vm";
import test from "node:test";
import { main } from "../../dist/cli.js";
import { createCodingTools } from "../../dist/tools.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createSessionStore } from "../../dist/session-store.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { toolMutationWarning } from "../../dist/tool-mutation-warning.js";
import { checkpointIo } from "../../dist/checkpoint-win32.js";

import { supportedCheckpointTest } from "../checkpoint/checkpoint-support.js";

function model() {
  let first = true;
  return { async respond() {
    const toolCalls = first ? [{ callId: "write", name: "write_file", arguments: JSON.stringify({ path: "affected.txt", content: "replacement" }) }] : [];
    first = false;
    return { responseId: "fixture", text: toolCalls.length ? "" : "Done.", toolCalls };
  } };
}

for (const product of ["CLI", "Desktop"] as const) supportedCheckpointTest(`${product} shows actual injected partial-write path without model repetition`, { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-partial-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "affected.txt"), "original");
  const windows = process.platform === "win32";
  const original = windows ? checkpointIo.write : fs.writeSync;
  let injected = false;
  const inject = (fd: number | object, bytes: Buffer, offset: number, length: number, position: number) => {
    if (!injected) { injected = true; (original as typeof checkpointIo.write)(fd as never, Buffer.from("PART"), 0, 4, 0); throw new Error("Synthetic partial failure"); }
    return (original as typeof checkpointIo.write)(fd as never, bytes, offset, length, position);
  };
  const mocked = windows ? t.mock.method(checkpointIo, "write", inject) : t.mock.method(fs, "writeSync", inject);
  if (!windows) syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); if (!windows) syncBuiltinESMExports(); });
  const tools = await createCodingTools(root);
  let visible = "";
  if (product === "CLI") {
    await main(["write"], { workingDirectory: root, configPath: join(root, "config.json"), config: {},
      sessionDirectory: join(root, "sessions"), model: model(), tools, input: Readable.from(["y\n"]),
      terminal: { inputIsTTY: false, outputIsTTY: false, color: false, columns: 100 }, write: text => { visible += text; } });
  } else {
    const nodes = new Map<string, any>();
    const element = (id: string): any => {
      if (!nodes.has(id)) nodes.set(id, { textContent: "", value: "", disabled: false, hidden: true, children: [],
        setAttribute() {}, focus() {}, append(n: any) { this.children.push(n); }, replaceChildren() { this.children = []; },
        get childElementCount() { return this.children.length; } });
      return nodes.get(id);
    };
    const context = vm.createContext({ document: { getElementById: element, createElement: () => element(`node-${nodes.size}`) },
      window: { addEventListener() {}, dragons: { events: () => new Promise(() => {}), request: async () => ({ ok: true, value: [] }) } }, setTimeout, Error, Promise });
    vm.runInContext(await readFile(new URL("../../desktop/renderer.js", import.meta.url), "utf8"), context);
    const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
      capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel: model }]);
    const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers, tools,
      sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
    t.after(() => runtime.dispose());
    let done!: () => void;
    const finished = new Promise<void>(resolve => { done = resolve; });
    const bridge = new DesktopBridge(runtime, event => {
      vm.runInContext(`receive(${JSON.stringify(event)})`, context);
      if (event.type === "approval_requested") void bridge.request({ type: "approve", sessionId: event.sessionId, runId: event.runId, approvalId: event.approvalId, decision: "allow_once" });
      if (event.type === "run_completed" || event.type === "run_failed") done();
    });
    t.after(() => bridge.close());
    const created = await bridge.request({ type: "create", provider: "fixture" });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("Session creation failed");
    vm.runInContext(`session=${JSON.stringify(created.value)};controls();`, context);
    assert.equal((await bridge.request({ type: "send", content: "write" })).ok, true);
    await finished;
    visible = element("activity").textContent;
  }
  assert.equal(injected, true);
  assert.match(await readFile(join(root, "affected.txt"), "utf8"), /^PART/);
  assert.match(visible, /Warning: write failed;.*uncertain: \["affected\.txt"\]/);
});

test("CLI successful new file is captured without an outside-coverage warning when model only says Done", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-coverage-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let visible = "";
  await main(["write"], { workingDirectory: root, configPath: join(root, "config.json"), config: {},
    sessionDirectory: join(root, "sessions"), model: model(), tools: await createCodingTools(root), input: Readable.from(["y\n"]),
    terminal: { inputIsTTY: false, outputIsTTY: false, color: false, columns: 100 }, write: text => { visible += text; } });
  assert.equal(await readFile(join(root, "affected.txt"), "utf8"), "replacement");
  assert.match(visible, /Done\./);
  assert.doesNotMatch(visible, /outside rollback coverage|no checkpoint captured/);
});

test("mutation presentation is bounded, escaped and credential-redacted", () => {
  const warning = toolMutationWarning({ ok: false, changedPaths: ["token=synthetic-private", "evil\u001b[2J\nname", ...Array(30).fill("x".repeat(1000))] })!;
  assert.doesNotMatch(warning, /synthetic-private|\u001b|\n/);
  assert.match(warning, /REDACTED/);
  assert.match(warning, /Additional paths omitted/);
  assert.ok(warning.length < 5000);
  assert.equal(toolMutationWarning({ ok: true, changedPaths: ["a"] }), undefined);
});
