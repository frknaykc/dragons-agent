import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activateVerifiedAppImage, type AppImageActivationOptions } from "../../dist/desktop/update-appimage.js";
import { recoverUnconfirmedActivation } from "../../dist/desktop/update-transaction.js";

async function fixture(root: string): Promise<AppImageActivationOptions> {
  const artifact = Buffer.from("#!/bin/sh\nprintf 'DRAGONS_UPDATE_HEALTH_OK\\n'\n");
  const signed = envelope(artifact);
  const slots = join(root, "slots");
  await mkdir(slots, { mode: 0o700 });
  await writeFile(join(slots, "active.AppImage"), "old-working");
  await writeFile(join(root, "manifest.json"), signed.text);
  await writeFile(join(root, "artifact"), artifact);
  return {
    stage: root, root: slots, active: "active.AppImage", candidate: "candidate.AppImage", backup: "previous.AppImage", failed: "failed.AppImage",
    policy: { trustedKeys: new Map([["test", signed.publicKey]]), platform: "linux", arch: "x64", currentVersion: "1.0.0", expectedVersion: "1.0.1", expectedArtifact: "Dragons-Agent-1.0.1-linux-x64.AppImage" },
    sourceEnvironment: process.env, timeoutMilliseconds: 2_000,
  };
}

for (const state of ["pending", "preparing", "malformed"] as const) {
  test(`activation rejection preserves candidate and ${state} journal evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
    try {
      const options = await fixture(root);
      const journal = state === "malformed" ? "not-json" : JSON.stringify({ schemaVersion: 1, state, active: options.active, candidate: options.candidate, backup: options.backup, failed: options.failed });
      await writeFile(join(options.root, "activation.json"), journal);
      await assert.rejects(activateVerifiedAppImage(options), /Unsafe update activation state/);
      assert.equal(await readFile(join(options.root, options.candidate), "utf8"), await readFile(join(root, "artifact"), "utf8"));
      assert.equal(await readFile(join(options.root, "activation.json"), "utf8"), journal);
      assert.equal(await readFile(join(options.root, options.active), "utf8"), "old-working");
      if (state === "pending") assert.equal(await recoverUnconfirmedActivation(options.root), "rolled-back");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const checkpoint of [1, 2]) {
  test(`interruption after transaction rename ${checkpoint} preserves journal-owned candidate for recovery`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
    const original = fs.rename;
    try {
      const options = await fixture(root);
      let renames = 0;
      const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await original(...args);
        if (++renames === checkpoint) throw new Error("injected interruption");
      });
      syncBuiltinESMExports();
      await assert.rejects(activateVerifiedAppImage(options), /injected interruption/);
      fault.mock.restore();
      syncBuiltinESMExports();
      assert.equal(await readFile(join(options.root, options.candidate), "utf8"), await readFile(join(root, "artifact"), "utf8"));
      assert.equal(JSON.parse(await readFile(join(options.root, "activation.json"), "utf8")).state, "pending");
      assert.equal(await readFile(join(options.root, checkpoint === 1 ? options.active : options.backup), "utf8"), "old-working");
      assert.equal(await recoverUnconfirmedActivation(options.root), "rolled-back");
      assert.equal(await readFile(join(options.root, options.active), "utf8"), "old-working");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("cancellation during slot switching completes the transaction then recovers without health execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
  const original = fs.rename;
  try {
    const options = await fixture(root);
    const controller = new AbortController();
    options.signal = controller.signal;
    let healthAdmissions = 0;
    Object.defineProperty(options, "sourceEnvironment", { get() { healthAdmissions++; return process.env; } });
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      await original(...args);
      if (args[0] === join(options.root, options.active)) controller.abort();
    });
    syncBuiltinESMExports();
    await assert.rejects(activateVerifiedAppImage(options), { name: "AbortError" });
    assert.equal(healthAdmissions, 0);
    assert.equal(await readFile(join(options.root, options.active), "utf8"), "old-working");
    assert.equal(await readFile(join(options.root, options.failed), "utf8"), await readFile(join(root, "artifact"), "utf8"));
    await assert.rejects(readFile(join(options.root, "activation.json")), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

for (const name of ["activation.json", "activation.json.tmp", ".activation.lock", ".activation.retired"]) {
  test(`reserved candidate name ${name} is rejected before copying`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
    try {
      const options = await fixture(root);
      options.candidate = name;
      await assert.rejects(activateVerifiedAppImage(options), /Unsafe AppImage/);
      await assert.rejects(readFile(join(options.root, name)), { code: "ENOENT" });
      assert.equal(await readFile(join(options.root, options.active), "utf8"), "old-working");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const boundary of ["before-start", "manifest-verification"] as const) {
  test(`cancellation at ${boundary} performs no activation or execution`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
    try {
      const options = await fixture(root);
      const controller = new AbortController();
      options.signal = controller.signal;
      if (boundary === "before-start") controller.abort();
      else {
        const keys = options.policy.trustedKeys;
        options.policy = { ...options.policy, trustedKeys: new class extends Map<string, string> {
          override get(key: string): string | undefined {
            controller.abort();
            return keys.get(key);
          }
        }() };
      }
      await assert.rejects(activateVerifiedAppImage(options), { name: "AbortError" });
      assert.equal(controller.signal.aborted, true);
      assert.equal(await readFile(join(options.root, options.active), "utf8"), "old-working");
      for (const name of [options.candidate, options.backup, options.failed, "activation.json"]) {
        await assert.rejects(readFile(join(options.root, name)), { code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("cancellation at health admission is forwarded and rolls back without executing", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
  try {
    const options = await fixture(root);
    const controller = new AbortController();
    options.signal = controller.signal;
    const marker = join(root, "executed");
    const artifact = Buffer.from(`#!/bin/sh\nprintf executed > '${marker.replaceAll("'", "'\\''")}'\nprintf 'DRAGONS_UPDATE_HEALTH_OK\\n'\n`);
    const signed = envelope(artifact);
    await writeFile(join(root, "artifact"), artifact);
    await writeFile(join(root, "manifest.json"), signed.text);
    options.policy = { ...options.policy, trustedKeys: new Map([["test", signed.publicKey]]) };
    // Causal admission gate: abort after the transaction completes, while the
    // caller constructs health options. Only signal forwarding prevents spawn.
    let admissions = 0;
    Object.defineProperty(options, "sourceEnvironment", { get() {
      admissions++;
      controller.abort();
      return process.env;
    } });
    await assert.rejects(activateVerifiedAppImage(options), /Update health probe failed/);
    assert.equal(admissions, 1);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(await readFile(join(options.root, options.active), "utf8"), "old-working");
    assert.equal(await readFile(join(options.root, options.failed), "utf8"), artifact.toString());
    await assert.rejects(readFile(join(options.root, "activation.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

function envelope(bytes: Buffer): { text: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, product: "dragons-agent", artifact: "Dragons-Agent-1.0.1-linux-x64.AppImage", platform: "linux", arch: "x64", version: "1.0.1", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  return {
    text: JSON.stringify({ keyId: "test", payload: payload.toString("base64"), signature: sign(null, Buffer.concat([Buffer.from("dragons-agent:update-manifest:v1\n"), payload]), privateKey).toString("base64") }),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("AppImage worker re-verifies, activates, probes and confirms without reading user data", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
  try {
    const artifact = Buffer.from("#!/bin/sh\nprintf 'DRAGONS_UPDATE_HEALTH_OK\\n'\n");
    const signed = envelope(artifact);
    const slots = join(root, "slots");
    await mkdir(slots, { mode: 0o700 });
    await writeFile(join(root, "user-data"), "must-not-change");
    await writeFile(join(slots, "active.AppImage"), "old-working");
    await writeFile(join(root, "manifest.json"), signed.text);
    await writeFile(join(root, "artifact"), artifact);
    await chmod(join(root, "artifact"), 0o700);
    await activateVerifiedAppImage({
      stage: root,
      root: slots,
      active: "active.AppImage",
      candidate: "candidate.AppImage",
      backup: "previous.AppImage",
      failed: "failed.AppImage",
      policy: { trustedKeys: new Map([["test", signed.publicKey]]), platform: "linux", arch: "x64", currentVersion: "1.0.0", expectedVersion: "1.0.1", expectedArtifact: "Dragons-Agent-1.0.1-linux-x64.AppImage" },
      sourceEnvironment: { PATH: process.env.PATH, HOME: "/real-home", OPENAI_API_KEY: "secret" },
      timeoutMilliseconds: 2_000,
    });
    assert.equal(await readFile(join(slots, "active.AppImage"), "utf8"), artifact.toString());
    assert.equal(await readFile(join(slots, "previous.AppImage"), "utf8"), "old-working");
    assert.match(await readFile(join(slots, "activation.json"), "utf8"), /"confirmed"/);
    assert.equal(await readFile(join(root, "user-data"), "utf8"), "must-not-change");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AppImage worker rejects tampering before it changes the active slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
  try {
    const signed = envelope(Buffer.from("verified"));
    const slots = join(root, "slots");
    await writeFile(join(root, "manifest.json"), signed.text);
    await writeFile(join(root, "artifact"), "tampered");
    await assert.rejects(activateVerifiedAppImage({
      stage: root, root: slots, active: "active.AppImage", candidate: "candidate.AppImage", backup: "previous.AppImage", failed: "failed.AppImage",
      policy: { trustedKeys: new Map([["test", signed.publicKey]]), platform: "linux", arch: "x64", currentVersion: "1.0.0", expectedVersion: "1.0.1", expectedArtifact: "Dragons-Agent-1.0.1-linux-x64.AppImage" }, sourceEnvironment: process.env, timeoutMilliseconds: 2_000,
    }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unhealthy AppImage is rolled back before the worker returns failure", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-appimage-update-"));
  try {
    const artifact = Buffer.from("#!/bin/sh\nexit 1\n");
    const signed = envelope(artifact);
    const slots = join(root, "slots");
    await mkdir(slots, { mode: 0o700 });
    await writeFile(join(slots, "active.AppImage"), "old-working");
    await writeFile(join(root, "manifest.json"), signed.text);
    await writeFile(join(root, "artifact"), artifact);
    await chmod(join(root, "artifact"), 0o700);
    await assert.rejects(activateVerifiedAppImage({
      stage: root, root: slots, active: "active.AppImage", candidate: "candidate.AppImage", backup: "previous.AppImage", failed: "failed.AppImage",
      policy: { trustedKeys: new Map([["test", signed.publicKey]]), platform: "linux", arch: "x64", currentVersion: "1.0.0", expectedVersion: "1.0.1", expectedArtifact: "Dragons-Agent-1.0.1-linux-x64.AppImage" }, sourceEnvironment: process.env, timeoutMilliseconds: 2_000,
    }), /Update health probe failed/);
    assert.equal(await readFile(join(slots, "active.AppImage"), "utf8"), "old-working");
    assert.equal(await readFile(join(slots, "failed.AppImage"), "utf8"), artifact.toString());
  } finally { await rm(root, { recursive: true, force: true }); }
});
