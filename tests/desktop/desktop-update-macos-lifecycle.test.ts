import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHmac, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DisposableMacOSLifecycle, macOSLifecycleSupport, type MacOSHostHandoff } from "../../dist/desktop/update-macos-lifecycle.js";

const supported = process.platform !== "win32";
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const key = randomBytes(32), lifecycle = await DisposableMacOSLifecycle.create(key);
  t.after(() => rm(lifecycle.root, { recursive: true, force: true }));
  for (const [name, text] of [["active.app", "old"], ["candidate.app", "new"]]) {
    await mkdir(join(lifecycle.root, name!));
    await writeFile(join(lifecycle.root, name!, "binary"), text!);
  }
  return { key, lifecycle, handoff: lifecycle.handoff() };
}
async function offline(root: string, key: Buffer, handoff: MacOSHostHandoff) {
  // Test fixture only: caller has stopped the former owner. Production has no
  // automatic stale-lock deletion API or PID/boolean host-exit substitute.
  await rmdir(join(root, ".macos-lifecycle-owner"));
  return DisposableMacOSLifecycle.resume(root, key, handoff);
}
async function binary(root: string, slot = "active.app") { return readFile(join(root, slot, "binary"), "utf8"); }

test("macOS coordinator is explicitly unsupported for production", () => {
  assert.equal(macOSLifecycleSupport.production, false);
});

test("real directory activation, confirmation and durable release ordering", { skip: !supported }, async (t) => {
  const { lifecycle } = await setup(t);
  await lifecycle.activatePreparedDirectories();
  assert.equal(await binary(lifecycle.root), "new");
  assert.equal(await binary(lifecycle.root, "previous.app"), "old");
  await lifecycle.probeAndConfirm(async (bundle) => { assert.equal(bundle, join(lifecycle.root, "active.app")); });
  await lifecycle.releaseDataAccess(async () => {
    const envelope = JSON.parse(await readFile(join(lifecycle.root, "macos-lifecycle.json"), "utf8"));
    assert.equal(JSON.parse(envelope.payload).state, "data-released");
  });
  await assert.rejects(lifecycle.recoverBeforeDataRelease(), /automatic rollback/);
  assert.equal(await binary(lifecycle.root), "new");
});

test("exclusive ownership spans health await and blocks second update/resume", { skip: !supported }, async (t) => {
  const { lifecycle, key, handoff } = await setup(t);
  await lifecycle.activatePreparedDirectories();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const confirming = lifecycle.probeAndConfirm(async () => held);
  await assert.rejects(lifecycle.activatePreparedDirectories(), /Unsafe/);
  await assert.rejects(DisposableMacOSLifecycle.resume(lifecycle.root, key, handoff), { code: "EEXIST" });
  finish();
  await confirming;
  await lifecycle.releaseDataAccess(async () => {});
  await assert.rejects(DisposableMacOSLifecycle.resume(lifecycle.root, key, handoff), { code: "EEXIST" });
});

test("handoff rejects wrong key, altered contract and cross-root replay", { skip: !supported }, async (t) => {
  const first = await setup(t), second = await setup(t);
  for (const [root, key, handoff] of [
    [first.lifecycle.root, randomBytes(32), first.handoff],
    [second.lifecycle.root, first.key, first.handoff],
    [first.lifecycle.root, first.key, { ...first.handoff, payload: first.handoff.payload + " " }],
  ] as const) await assert.rejects(DisposableMacOSLifecycle.resume(root, key, handoff), /Unsafe/);
});

test("unknown authenticated state and tampered journal retain all slots and lock", { skip: !supported }, async (t) => {
  for (const tamper of [false, true]) {
    const { lifecycle, key, handoff } = await setup(t);
    const path = join(lifecycle.root, "macos-lifecycle.json");
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.payload = JSON.stringify({ ...JSON.parse(envelope.payload), state: "future-state" });
    if (!tamper) envelope.mac = createHmac("sha256", key).update("dragons:macos-disposable-lifecycle:v1\n").update(envelope.payload).digest("hex");
    await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(offline(lifecycle.root, key, handoff), /Unsafe/);
    assert.equal(await binary(lifecycle.root), "old");
    assert.ok((await lstat(join(lifecycle.root, ".macos-lifecycle-owner"))).isDirectory());
  }
});

test("replaced ownership directory fences old coordinator", { skip: !supported }, async (t) => {
  const { lifecycle } = await setup(t);
  await rename(join(lifecycle.root, ".macos-lifecycle-owner"), join(lifecycle.root, "old-owner"));
  await mkdir(join(lifecycle.root, ".macos-lifecycle-owner"));
  await assert.rejects(lifecycle.activatePreparedDirectories(), /Unsafe/);
  assert.equal(await binary(lifecycle.root), "old");
});

test("failed probe requires offline recovery and rolls directory bundle back", { skip: !supported }, async (t) => {
  const { lifecycle, key, handoff } = await setup(t);
  await lifecycle.activatePreparedDirectories();
  await assert.rejects(lifecycle.probeAndConfirm(async () => { throw new Error("unhealthy"); }), /unhealthy/);
  await assert.rejects(lifecycle.releaseDataAccess(async () => assert.fail()), /Unsafe/);
  const recovered = await offline(lifecycle.root, key, handoff);
  assert.equal(await recovered.recoverBeforeDataRelease(), "rolled-back");
  assert.equal(await binary(lifecycle.root), "old");
  assert.equal(await binary(lifecycle.root, "failed.app"), "new");
});

test("release callback throwing never authorizes rollback after restart", { skip: !supported }, async (t) => {
  const { lifecycle, key, handoff } = await setup(t);
  await lifecycle.activatePreparedDirectories();
  await lifecycle.probeAndConfirm(async () => {});
  await assert.rejects(lifecycle.releaseDataAccess(async () => {
    await writeFile(join(lifecycle.root, "synthetic-data"), "new-schema");
    throw new Error("crash after write");
  }), /crash/);
  const recovered = await offline(lifecycle.root, key, handoff);
  assert.equal(recovered.state, "data-released");
  await assert.rejects(recovered.recoverBeforeDataRelease(), /automatic rollback/);
  assert.equal(await binary(lifecycle.root), "new");
  assert.equal(await readFile(join(lifecycle.root, "synthetic-data"), "utf8"), "new-schema");
});

for (const targetState of ["activating", "pending", "healthy", "data-released"]) {
  test(`journal rename failure at ${targetState} retains recovery evidence and blocks release`, { skip: !supported }, async (t) => {
    const { lifecycle, key, handoff } = await setup(t);
    if (["healthy", "data-released"].includes(targetState)) await lifecycle.activatePreparedDirectories();
    if (targetState === "data-released") await lifecycle.probeAndConfirm(async () => {});
    const original = fs.rename;
    const patch = t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (String(to) === join(lifecycle.root, "macos-lifecycle.json")) {
        const envelope = JSON.parse(await readFile(from, "utf8"));
        if (JSON.parse(envelope.payload).state === targetState) throw new Error("injected journal failure");
      }
      return original(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(targetState === "data-released"
        ? lifecycle.releaseDataAccess(async () => assert.fail("data release before durability"))
        : targetState === "healthy" ? lifecycle.probeAndConfirm(async () => {})
        : lifecycle.activatePreparedDirectories(), /injected journal failure/);
    } finally { patch.mock.restore(); syncBuiltinESMExports(); }
    const recovered = await offline(lifecycle.root, key, handoff);
    const preserve = ["healthy", "data-released"].includes(targetState);
    assert.equal(await recovered.recoverBeforeDataRelease(), preserve ? "preserved" : "rolled-back");
    assert.equal(await binary(lifecycle.root), preserve ? "new" : "old");
  });
}

for (const phase of ["prepared", "pending", "healthy", "data-released"]) {
  test(`actual killed owner at ${phase}: stale lock denied, explicit offline recovery is data-safe`, { skip: !supported, timeout: 15_000 }, async (t) => {
    const key = randomBytes(32);
    // This is an actual disposable child owner, not proof that an Electron host
    // or its descendants exited. No native helper/bootstrap acceptance claimed.
    const source = `
      import { DisposableMacOSLifecycle } from ${JSON.stringify(new URL("../../dist/desktop/update-macos-lifecycle.js", import.meta.url).href)};
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const hostKey = await new Promise(resolve => process.once('message', resolve));
      const c = await DisposableMacOSLifecycle.create(Buffer.from(hostKey, 'hex'));
      for (const [slot, value] of [['active.app','old'],['candidate.app','new']]) {
        await mkdir(join(c.root, slot)); await writeFile(join(c.root, slot, 'binary'), value);
      }
      if ('${phase}' !== 'prepared') await c.activatePreparedDirectories();
      if (['healthy','data-released'].includes('${phase}')) await c.probeAndConfirm(async () => {});
      if ('${phase}' === 'data-released') await c.releaseDataAccess(async () => {});
      process.send({root:c.root,handoff:c.handoff()});
      setInterval(() => {}, 1000);
    `;
    const child = fork("--eval", [source], { execArgv: ["--input-type=module"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.after(() => { child.kill("SIGKILL"); });
    const ready = once(child, "message");
    child.send(key.toString("hex"));
    const [message] = await ready as [{ root: string; handoff: MacOSHostHandoff }];
    t.after(() => rm(message.root, { recursive: true, force: true }));
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await assert.rejects(DisposableMacOSLifecycle.resume(message.root, key, message.handoff), { code: "EEXIST" });
    const recovered = await offline(message.root, key, message.handoff);
    if (phase === "data-released") await assert.rejects(recovered.recoverBeforeDataRelease(), /automatic rollback/);
    else assert.equal(await recovered.recoverBeforeDataRelease(), phase === "healthy" ? "preserved" : "rolled-back");
    assert.equal(await binary(message.root), ["healthy", "data-released"].includes(phase) ? "new" : "old");
  });
}
