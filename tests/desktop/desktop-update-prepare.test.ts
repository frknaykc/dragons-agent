import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopUpdateController } from "../../dist/desktop/update-controller.js";
import type { MacOSPreflightDependencies } from "../../dist/desktop/update-macos-preflight.js";

const key = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "43".repeat(32), "hex"), format: "der", type: "pkcs8" });
const tick = () => new Promise<void>((yes) => setImmediate(yes));
async function settled(c: DesktopUpdateController) {
  for (let i = 0; i < 10000 && !c.status().canCheck; i++) await tick();
  assert.equal(c.status().canCheck, true);
}
for (const mode of ["success", "candidate-cleanup", "candidate-close-failure", "identity", "target", "signature", "cancel", "close", "deadline"] as const) test(`actual controller prepare: ${mode}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-prepare-test-"));
  const sentinel = join(root, "active-data"); await writeFile(sentinel, "unchanged");
  let calls = 0, release!: () => void, entered!: () => void;
  let cleanupAttempts = 0;
  const nativeEntered = new Promise<void>((yes) => { entered = yes; });
  const blocked = new Promise<void>((yes) => { release = yes; });
  const zip = Buffer.from("synthetic decoder fixture");
  const artifact = "Dragons-Agent-0.2.0-darwin-arm64.zip";
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, product: "dragons-agent", artifact, platform: "darwin", arch: "arm64", version: "0.2.0", size: zip.length, sha256: createHash("sha256").update(zip).digest("hex") }));
  const envelope = JSON.stringify({ keyId: "fixture", payload: payload.toString("base64"), signature: sign(null, Buffer.concat([Buffer.from("dragons-agent:update-manifest:v1\n"), payload]), key).toString("base64") });
  const deps: MacOSPreflightDependencies = {
    platform: "darwin", uid: 501, home: "/Users/test",
    lstat: async (path) => ({ uid: path === "/System/Volumes/Data" ? 0 : 501, mode: 0o40700, dev: 42, isDirectory: () => true, isSymbolicLink: () => false }),
    realpath: async (path) => path, access: async () => {},
    run: async (command, args) => {
      if (command === "/usr/bin/codesign" && args[0] === "--verify") {
        entered();
        if (["cancel", "close", "deadline"].includes(mode)) await blocked;
        if (mode === "signature") throw new Error("invalid signature");
      }
      if (command === "/bin/ls") return { stdout: "drwx------ 2 501 20 - 64 date fixture\n", stderr: "" };
      if (command === "/usr/bin/plutil") return { stdout: JSON.stringify({ MountPoint: "/System/Volumes/Data", FilesystemType: "apfs", Internal: true, Writable: true, WritableVolume: true, GlobalPermissionsEnabled: true, Removable: false, Ejectable: false, SystemImage: false, APFSSnapshot: false, Locked: false }), stderr: "" };
      return { stdout: "", stderr: command === "/usr/bin/codesign" && args[0] === "--display" ? "Identifier=com.dragonsagent.desktop\nTeamIdentifier=ABCDE12345\n" : "" };
    },
  };
  if (mode === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = new DesktopUpdateController({
    source: { manifestUrl: "https://updates.example.test/manifest.json" }, timeoutMs: 1000,
    policy: { trustedKeys: new Map([["fixture", createPublicKey(key).export({ type: "spki", format: "pem" }).toString()]]), platform: "darwin", arch: "arm64", currentVersion: "0.1.0", expectedVersion: "0.2.0", expectedArtifact: artifact },
    fetch: async (_url, init) => { assert.equal(init?.redirect, "error"); return new Response(++calls === 1 ? envelope : zip); },
    macOS: {
      root, target: mode === "target" ? "/Applications/Dragons Agent.app" : "/Users/test/Applications/Dragons Agent.app",
      identity: { teamIdentifier: "ABCDE12345", bundleIdentifier: "com.dragonsagent.desktop" }, preflightDependencies: deps,
      validationDependencies: {
        async *decodeZip(bytes) {
          assert.deepEqual(bytes, zip);
          yield { path: "Dragons Agent.app/Contents/Info.plist", kind: "file", bytes: Buffer.from("fixture") };
          const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4); macho.writeUInt32LE(2, 12);
          yield { path: "Dragons Agent.app/Contents/MacOS/Dragons Agent", kind: "file", bytes: macho, mode: 0o755 };
        },
        readBundleIdentity: () => ({ bundleIdentifier: mode === "identity" ? "wrong" : "com.dragonsagent.desktop", version: "0.2.0", executable: "Dragons Agent" }),
      },
    },
  }, async (path, options) => {
    cleanupAttempts++;
    if (mode.startsWith("candidate-") && cleanupAttempts === 1) throw new Error("private candidate path");
    await rm(path, options);
  });
  try {
    assert.equal(c.prepare().state, "preparing"); c.prepare(); c.check();
    if (["cancel", "close", "deadline"].includes(mode)) {
      await nativeEntered;
      let closing: Promise<void> | undefined;
      if (mode === "close") closing = c.close();
      else if (mode === "deadline") t.mock.timers.tick(1000);
      else c.cancel();
      release();
      if (closing) await closing; else await settled(c);
      assert.equal(c.status().state, mode === "close" ? "closed" : mode === "cancel" ? "cancelled" : "unavailable");
    } else {
      await settled(c);
      assert.equal(c.status().state, mode === "success" || mode.startsWith("candidate-") ? "prepared" : "unavailable");
    }
    assert.equal(calls, 2); assert.equal(c.status().canInstall, false);
    assert.ok(!JSON.stringify(c.status()).includes(root));
    if (mode.startsWith("candidate-")) {
      if (mode === "candidate-cleanup") {
        c.check(); await settled(c);
        assert.equal(c.status().state, "unavailable");
        assert.equal(calls, 2, "failed discard must prevent the next fetch");
      }
      const closing = c.close(); assert.equal(c.close(), closing);
      await assert.rejects(closing, { message: "Desktop update cleanup failed." });
      assert.equal(cleanupAttempts, mode === "candidate-cleanup" ? 2 : 1);
      assert.equal((await readdir(root)).length, mode === "candidate-cleanup" ? 1 : 2);
      assert.equal(await readFile(sentinel, "utf8"), "unchanged");
      return;
    }
    await c.close(); await c.close();
    assert.deepEqual(await readdir(root), ["active-data"]);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  } finally { release(); await c.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
