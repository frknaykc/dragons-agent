import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activationMode, productionUpdatePolicy, stageVerifiedUpdate, verifyUpdateManifest, type UpdateManifest, type UpdatePolicy } from "../../dist/desktop/update.js";

// Public deterministic TEST seed; never a production trust root.
const privateKey = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "42".repeat(32), "hex"), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
const artifact = Buffer.from("synthetic development artifact, not an executable");
const manifest: UpdateManifest = {
  schemaVersion: 1, product: "dragons-agent", artifact: "Dragons-Agent-0.2.0-darwin-arm64.zip",
  platform: "darwin", arch: "arm64", version: "0.2.0", size: artifact.length,
  sha256: createHash("sha256").update(artifact).digest("hex"),
};
const policy: UpdatePolicy = {
  trustedKeys: new Map([["fixture", publicKey]]), platform: "darwin", arch: "arm64",
  currentVersion: "0.1.0", expectedVersion: "0.2.0", expectedArtifact: manifest.artifact,
};
function envelope(value: unknown = manifest): string {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({ keyId: "fixture", payload: payload.toString("base64"), signature: sign(null, Buffer.concat([Buffer.from("dragons-agent:update-manifest:v1\n"), payload]), privateKey).toString("base64") });
}
async function* chunks(bytes = artifact): AsyncGenerator<Uint8Array> {
  yield bytes.subarray(0, 7);
  yield bytes.subarray(7);
}

test("update manifest verifies a pinned Ed25519 signer and is immutable; production remains disabled", () => {
  const verified = verifyUpdateManifest(envelope(), policy);
  assert.deepEqual(verified, manifest);
  assert.ok(Object.isFrozen(verified));
  assert.equal(productionUpdatePolicy.enabled, false);
});

test("update rejects modified manifest/signature, unknown signer and empty trust roots", () => {
  const signed = JSON.parse(envelope());
  for (const changed of [
    { ...signed, keyId: "unknown" },
    { ...signed, payload: Buffer.from(JSON.stringify({ ...manifest, version: "0.3.0" })).toString("base64") },
    { ...signed, signature: Buffer.alloc(64).toString("base64") },
    { ...signed, publicKey },
    { ...signed, payload: signed.payload + "=" },
  ]) assert.throws(() => verifyUpdateManifest(JSON.stringify(changed), policy), /Update rejected/);
  assert.throws(() => verifyUpdateManifest(envelope(), { ...policy, trustedKeys: new Map() }), /Update rejected/);
});

test("update rejects signed wrong identity/platform/architecture/version and invalid metadata", () => {
  for (const change of [
    { product: "other" }, { platform: "win32" }, { arch: "x64" }, { version: "0.3.0" },
    { artifact: "other.zip" }, { artifact: "../escape.zip" }, { schemaVersion: 2 },
    { size: 0 }, { size: -1 }, { size: 1.5 }, { size: 512 * 1024 * 1024 + 1 },
    { sha256: "a".repeat(63) }, { url: "https://untrusted.invalid/update" },
  ]) assert.throws(() => verifyUpdateManifest(envelope({ ...manifest, ...change }), policy), /Update rejected/);
  for (const currentVersion of ["0.2.0", "0.3.0", "1.0.0", "invalid"]) {
    assert.throws(() => verifyUpdateManifest(envelope(), { ...policy, currentVersion }), /Update rejected/);
  }
  for (const candidate of ["0.1.0", "0.0.9", "0.2.0-beta", "01.2.0"]) {
    assert.throws(() => verifyUpdateManifest(envelope({ ...manifest, version: candidate }), { ...policy, expectedVersion: candidate }), /Update rejected/);
  }
});

test("manifest input is bounded and malformed envelopes fail closed", () => {
  for (const input of ["null", "[]", "{}", "{", " ".repeat(16_385)]) {
    assert.throws(() => verifyUpdateManifest(input, policy), /Update rejected/);
  }
});

test("verified staging persists exact bytes and signed receipt without modifying active app or user data", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-"));
  try {
    await writeFile(join(root, "active"), "working version");
    await writeFile(join(root, "userdata"), "config/session/Memory sentinel");
    const signed = envelope();
    const staged = await stageVerifiedUpdate({ envelope: signed, policy, root: join(root, "staging"), artifact: chunks(), signal: new AbortController().signal });
    assert.deepEqual(await readFile(join(staged.directory, "artifact")), artifact);
    assert.equal(await readFile(join(staged.directory, "manifest.json"), "utf8"), signed);
    assert.equal(await readFile(join(root, "active"), "utf8"), "working version");
    assert.equal(await readFile(join(root, "userdata"), "utf8"), "config/session/Memory sentinel");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tampered, truncated, oversized and interrupted downloads remove candidates and preserve active bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-"));
  try {
    await writeFile(join(root, "active"), "working version");
    const staging = join(root, "staging");
    async function* interrupted() { yield artifact.subarray(0, 7); throw new Error("transport interrupted"); }
    for (const source of [chunks(Buffer.alloc(artifact.length)), chunks(artifact.subarray(1)), chunks(Buffer.concat([artifact, Buffer.from("x")])), interrupted()]) {
      await assert.rejects(stageVerifiedUpdate({ envelope: envelope(), policy, root: staging, artifact: source, signal: new AbortController().signal }));
      assert.deepEqual(await readdir(staging), []);
      assert.equal(await readFile(join(root, "active"), "utf8"), "working version");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid signature never consumes a source or creates staging; cancellation removes partial bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-"));
  try {
    let consumed = false;
    async function* untrusted() { consumed = true; yield artifact; }
    await assert.rejects(stageVerifiedUpdate({ envelope: "{}", policy, root: join(root, "absent"), artifact: untrusted(), signal: new AbortController().signal }));
    assert.equal(consumed, false);
    assert.deepEqual(await readdir(root), []);
    const controller = new AbortController();
    async function* cancelled() { yield artifact.subarray(0, 7); controller.abort(); yield artifact.subarray(7); }
    await assert.rejects(stageVerifiedUpdate({ envelope: envelope(), policy, root, artifact: cancelled(), signal: controller.signal }));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancellation does not wait for a stalled source or its return method", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-"));
  const controller = new AbortController();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() { notifyStarted(); return new Promise(() => {}); },
        return() { return new Promise(() => {}); },
      };
    },
  };
  const deadline = setTimeout(() => controller.abort(new Error("test deadline")), 2000);
  try {
    const staging = stageVerifiedUpdate({ envelope: envelope(), policy, root, artifact: source, signal: controller.signal });
    await started;
    controller.abort(new Error("cancel stalled source"));
    await assert.rejects(staging, /cancel stalled source/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    clearTimeout(deadline);
    await rm(root, { recursive: true, force: true });
  }
});

test("activation policy permits only the selected transactional targets and leaves DEB to its package manager", () => {
  assert.equal(activationMode(manifest), "transactional");
  assert.equal(activationMode({ ...manifest, platform: "linux", artifact: "Dragons-Agent-0.2.0-linux-x64.AppImage" }), "transactional");
  assert.equal(activationMode({ ...manifest, platform: "linux", artifact: "dragons-agent_0.2.0_amd64.deb" }), "external-package-manager");
});
