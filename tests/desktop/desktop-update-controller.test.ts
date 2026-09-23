import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import test from "node:test";
import { DesktopUpdateController, type DesktopUpdateConfiguration } from "../../dist/desktop/update-controller.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import type { DragonsRuntime } from "../../dist/runtime.js";

const key = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "43".repeat(32), "hex"), format: "der", type: "pkcs8" });
const manifest = { schemaVersion: 1, product: "dragons-agent", artifact: "Dragons-Agent-0.2.0-darwin-arm64.zip", platform: "darwin", arch: "arm64", version: "0.2.0", size: 1, sha256: "a".repeat(64) };
function configuration(fetch: typeof globalThis.fetch): DesktopUpdateConfiguration {
  return { source: { manifestUrl: "https://updates.example.test/manifest.json" }, policy: { trustedKeys: new Map([["fixture", createPublicKey(key).export({ type: "spki", format: "pem" }).toString()]]), platform: "darwin", arch: "arm64", currentVersion: "0.1.0", expectedVersion: "0.2.0", expectedArtifact: manifest.artifact }, fetch };
}
function envelope(): string {
  const payload = Buffer.from(JSON.stringify(manifest));
  return JSON.stringify({ keyId: "fixture", payload: payload.toString("base64"), signature: sign(null, Buffer.concat([Buffer.from("dragons-agent:update-manifest:v1\n"), payload]), key).toString("base64") });
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function bridge(controller = new DesktopUpdateController()) {
  let disposed = false;
  return { controller, host: new DesktopBridge({ dispose: async () => { disposed = true; } } as unknown as DragonsRuntime, () => {}, undefined, controller), disposed: () => disposed };
}

test("M78 production bridge reports disabled, rejects privileged input and never installs", async () => {
  const f = bridge();
  for (const type of ["update_status", "update_check", "update_prepare", "update_cancel"]) {
    assert.deepEqual(await f.host.request({ type }), { ok: true, value: { state: "disabled", canCheck: false, canPrepare: false, canCancel: false, canInstall: false } });
    for (const field of ["url", "manifestUrl", "trustedKeys", "artifact", "path", "command", "policy"]) assert.equal((await f.host.request({ type, [field]: "untrusted" })).ok, false);
  }
  assert.equal((await f.host.request({ type: "update_install" })).ok, false);
  await f.host.close(); assert.equal(f.disposed(), true);
  assert.equal((await f.host.request({ type: "update_check" })).ok, false);
});

test("M78 host-injected check verifies signed metadata only and owns immutable configuration", async () => {
  const calls: string[] = [];
  const config = configuration(async (url, init) => { calls.push(String(url)); assert.equal(init?.redirect, "error"); return new Response(envelope()); });
  const controller = new DesktopUpdateController(config);
  config.source.manifestUrl = "http://untrusted.invalid"; (config.policy.trustedKeys as Map<string, string>).clear();
  const f = bridge(controller);
  assert.equal((await f.host.request({ type: "update_check" })).ok, true);
  controller.check(); // duplicate is coalesced
  await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0], "https://updates.example.test/manifest.json");
  assert.deepEqual(controller.status(), { state: "available", canCheck: true, canPrepare: false, canCancel: false, canInstall: false, version: "0.2.0" });
  assert.ok(!JSON.stringify(await f.host.request({ type: "update_status" })).includes("manifest.json"));
  await f.host.close();
});

test("M78 rejected signature, transport and insecure source become sanitized unavailable", async () => {
  for (const mode of ["signature", "transport", "source"]) {
    const config = configuration(async () => { if (mode === "transport") throw new Error("secret /private/token"); return new Response("{}"); });
    if (mode === "source") config.source = { manifestUrl: "http://untrusted.invalid" };
    const c = new DesktopUpdateController(config); c.check(); await tick();
    assert.deepEqual(c.status(), { state: "unavailable", canCheck: true, canPrepare: false, canCancel: false, canInstall: false });
    await c.close();
  }
});

test("M78 cancel aborts hung fetch, discards late metadata, and bridge close releases lifecycle", async () => {
  let resolve!: (response: Response) => void; let signal: AbortSignal | undefined;
  const c = new DesktopUpdateController(configuration(async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>((yes) => { resolve = yes; }); }));
  const f = bridge(c); c.check(); await tick();
  assert.equal(c.cancel().state, "cancelled"); assert.equal(signal?.aborted, true);
  await tick(); assert.equal(c.status().canCheck, true);
  resolve(new Response(envelope())); await tick(); assert.equal(c.status().state, "cancelled");
  c.check(); await tick(); await f.host.close();
  assert.equal(signal?.aborted, true); assert.equal(c.status().state, "closed"); assert.equal(f.disposed(), true);
  resolve(new Response(envelope())); await tick(); assert.equal(c.status().state, "closed");
});

test("M78 bounded deadline aborts stalled body and cancels its reader", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const c = new DesktopUpdateController({ ...configuration(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))), timeoutMs: 100 });
  c.check(); await tick(); t.mock.timers.tick(100); await tick();
  assert.equal(c.status().state, "unavailable"); assert.equal(cancelled, true);
  await c.close();
});
