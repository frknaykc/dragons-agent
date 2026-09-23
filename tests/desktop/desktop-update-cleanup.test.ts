import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopBridge, type DesktopLocalControls } from "../../dist/desktop/bridge.js";
import { DesktopUpdateController } from "../../dist/desktop/update-controller.js";
import type { DragonsRuntime } from "../../dist/runtime.js";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const mode of ["reject", "throw", "pending"] as const) test(`bridge updater cleanup ${mode} cannot bypass sibling shutdown`, async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => { reject = no; });
  const calls: string[] = [];
  let host!: DesktopBridge;
  let reentrant: Promise<void> | undefined;
  const updates = new DesktopUpdateController();
  let entered = false;
  updates.close = () => {
    if (!entered) { entered = true; reentrant = host.close(); }
    if (mode === "throw") throw new Error("secret /private/update");
    return mode === "pending" ? pending : Promise.reject(new Error("secret /private/update"));
  };
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const runtime = {
    createSession: async () => ({ id: sessionId }),
    sendUserInput: async () => ({ id: "run", sessionId, result: new Promise(() => {}),
      events: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } },
      cancel() { calls.push("cancel"); throw new Error("private cancel"); } }),
    dispose: async () => { calls.push("dispose"); },
  } as unknown as DragonsRuntime;
  host = new DesktopBridge(runtime, () => {}, { close: async () => { calls.push("auth"); throw new Error("private auth"); } } as unknown as DesktopLocalControls, updates);
  assert.equal((await host.request({ type: "create" })).ok, true);
  assert.equal((await host.request({ type: "send", content: "fixture" })).ok, true);
  const closing = host.close();
  const checked = assert.rejects(closing, { message: "Desktop update cleanup failed." });
  assert.equal(host.close(), closing);
  await tick();
  assert.deepEqual(calls, ["cancel", "auth", "dispose"]);
  assert.equal(reentrant, closing);
  if (mode === "pending") reject(new Error("secret /private/update"));
  await checked;
});

for (const duringClose of [false, true]) test(`temporary cleanup retains ownership, duringClose=${duringClose}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cleanup-"));
  let attempts = 0;
  let entered!: () => void;
  let release!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const c = new DesktopUpdateController({
    source: { manifestUrl: "https://updates.example.test/manifest.json" },
    policy: { trustedKeys: new Map(), platform: "darwin", arch: "arm64", currentVersion: "0.1.0", expectedVersion: "0.2.0", expectedArtifact: "Dragons-Agent-0.2.0-darwin-arm64.zip" },
    fetch: async () => { throw new Error("synthetic transport failure"); },
    macOS: { root, target: "/unused", identity: { teamIdentifier: "ABCDE12345", bundleIdentifier: "com.dragonsagent.desktop" } },
  }, async (path, options) => {
    attempts++;
    if (attempts === 1) { entered(); if (duringClose) await blocked; throw new Error("private cleanup path"); }
    await rm(path, options);
  });
  try {
    c.prepare(); await cleanupEntered;
    let closing: Promise<void>;
    if (duringClose) { closing = c.close(); release(); }
    else { for (let i = 0; i < 1000 && !c.status().canCheck; i++) await tick(); closing = c.close(); }
    assert.equal(c.close(), closing);
    await assert.rejects(closing, { message: "Desktop update cleanup failed." });
    assert.equal(attempts, 2);
    assert.deepEqual(await readdir(root), []);
    assert.equal(c.status().canInstall, false);
    await assert.rejects(c.close(), { message: "Desktop update cleanup failed." });
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});
