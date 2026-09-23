import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, readlink, lstat, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readMacOSBundleIdentity } from "../../dist/desktop/update-macos-decode.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageVerifiedUpdate, type UpdatePolicy } from "../../dist/desktop/update.js";
import { activateVerifiedMacOSUpdate, macOSActivationSupport, stageMacOSBundleForValidation, type MacOSArchiveEntry, type MacOSValidationDependencies } from "../../dist/desktop/update-macos.js";

const xmlPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.dragonsagent.desktop</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleExecutable</key><string>Dragons Agent</string>
</dict></plist>`;
const native = promisify(execFile);

test("native ZIP and XML/binary plist stage real framework links and executable modes", { skip: process.platform !== "darwin" }, async () => {
  const source = await mkdtemp(join(tmpdir(), "dragons-native-zip-"));
  try {
    const contents = join(source, base, "Contents");
    const framework = join(contents, "Frameworks", "Electron Framework.framework");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(join(framework, "Versions", "A", "Resources"), { recursive: true });
    await writeFile(join(contents, "MacOS", "Dragons Agent"), entries()[1]!.bytes, { mode: 0o755 });
    await writeFile(join(framework, "Versions", "A", "Electron Framework"), "local-framework-fixture", { mode: 0o755 });
    await writeFile(join(framework, "Versions", "A", "Resources", "data"), "resource");
    await symlink("A", join(framework, "Versions", "Current"));
    await symlink("Versions/Current/Electron Framework", join(framework, "Electron Framework"));
    await symlink("Versions/Current/Resources", join(framework, "Resources"));
    for (const format of ["xml1", "binary1"]) {
      const plist = join(contents, "Info.plist");
      await writeFile(plist, xmlPlist);
      await native("/usr/bin/plutil", ["-convert", format, "--", plist], { timeout: 5000, maxBuffer: 4096 });
      assert.deepEqual(await readMacOSBundleIdentity(await readFile(plist)), identity);
      const archive = join(source, `${format}.zip`);
      await native("/usr/bin/zip", ["-q", "-r", "-y", archive, base], { cwd: source, timeout: 10000, maxBuffer: 4096 });
      await fixture(async (options) => {
        const result = await stageMacOSBundleForValidation(options);
        const stagedFramework = join(result.bundle, "Contents", "Frameworks", "Electron Framework.framework");
        assert.equal(await readlink(join(stagedFramework, "Versions", "Current")), "A");
        assert.equal(await readFile(join(stagedFramework, "Resources", "data"), "utf8"), "resource");
        assert.equal(await readFile(join(stagedFramework, "Electron Framework"), "utf8"), "local-framework-fixture");
        assert.equal((await lstat(join(result.bundle, "Contents", "MacOS", "Dragons Agent"))).mode & 0o777, 0o700);
        assert.equal(result.activation, "unsupported");
      }, await readFile(archive));
    }
    const traversal = await readFile(join(source, "xml1.zip"));
    const escapedName = Buffer.from("../" + "x".repeat(Buffer.byteLength(base) - 3));
    for (let offset = traversal.indexOf(base); offset !== -1; offset = traversal.indexOf(base, offset + escapedName.length)) escapedName.copy(traversal, offset);
    await fixture(async (options) => {
      await assert.rejects(stageMacOSBundleForValidation(options), /Unsafe/);
      assert.deepEqual(await readdir(options.root), []);
    }, traversal);
    // Real signed ZIPs can still contain unsafe paths/links; signing is not a
    // replacement for extraction containment. No candidate launch takes place.
    for (const target of ["../../../../../../outside", "/tmp/outside", "missing", "cycle", "../Versions/Current/../../../../../../outside"]) {
      const link = join(framework, "cycle");
      await symlink(target, link);
      const archive = join(source, "bad.zip");
      await rm(archive, { force: true });
      await native("/usr/bin/zip", ["-q", "-r", "-y", archive, base], { cwd: source, timeout: 10000, maxBuffer: 4096 });
      await fixture(async (options) => {
        await assert.rejects(stageMacOSBundleForValidation(options), /Unsafe/);
        assert.deepEqual(await readdir(options.root), []);
      }, await readFile(archive));
      await rm(link);
    }
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("plist parser rejects malformed, wrong-typed, oversized and cancelled inputs", { skip: process.platform !== "darwin" }, async () => {
  for (const input of [Buffer.from("not a plist"), Buffer.from(xmlPlist.replace("<string>Dragons Agent</string>", "<integer>1</integer>")), Buffer.alloc(1024 * 1024 + 1)]) {
    await assert.rejects(readMacOSBundleIdentity(input));
  }
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(readMacOSBundleIdentity(Buffer.from(xmlPlist), controller.signal), /cancelled/);
  const running = new AbortController();
  const result = readMacOSBundleIdentity(Buffer.from(xmlPlist), running.signal);
  running.abort();
  await assert.rejects(result);
});

test("symlink cycles, aliases and normalization through links fail before any extraction", async () => {
  const link = (name: string, target: string): MacOSArchiveEntry => ({ path: `${base}/${name}`, kind: "symlink", bytes: Buffer.from(target) });
  const cases = [
    [link("x", "x")], [link("x", "y"), link("y", "x")],
    [link("x", "Contents/missing")], [link("x", "contents")],
    [link("x", "Contents/Info.plist/../MacOS")],
    [link("x", "Contents/../../outside")],
    [link("x", "Contents"), link("y", "x/../../outside")],
    Array.from({ length: 34 }, (_, i) => link(`link${i}`, i === 33 ? "Contents" : `link${i + 1}`)),
  ];
  for (const input of cases) await fixture(async (options) => {
    const deps = dependencies([...entries(), ...input]);
    const decode = deps.decodeZip;
    deps.decodeZip = async function* (...args) {
      for await (const entry of decode(...args)) {
        // Temporary private directory may exist; no bundle entry may be written
        // until the entire input including its final record has been checked.
        for (const name of await readdir(options.root)) assert.deepEqual(await readdir(join(options.root, name)), []);
        yield entry;
      }
    };
    await assert.rejects(stageMacOSBundleForValidation(options, deps), /Unsafe/);
    assert.deepEqual(await readdir(options.root), []);
  });
});

// Public deterministic test seed, NOT a production key. Neither ZIP nor Mach-O
// fixture bytes below are real distributable artifacts or native acceptance.
const key = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "42".repeat(32), "hex"), format: "der", type: "pkcs8" });
const zip = Buffer.from("synthetic ZIP decoder fixture");
const policy: UpdatePolicy = { trustedKeys: new Map([["fixture", createPublicKey(key).export({ type: "spki", format: "pem" }).toString()]]), platform: "darwin", arch: "arm64", currentVersion: "0.1.0", expectedVersion: "0.2.0", expectedArtifact: "Dragons-Agent-0.2.0-darwin-arm64.zip" };
const identity = { bundleIdentifier: "com.dragonsagent.desktop", version: "0.2.0", executable: "Dragons Agent" };
const base = "Dragons Agent.app";
function file(path: string, bytes = Buffer.from("fixture")): MacOSArchiveEntry { return { path, kind: "file", bytes }; }
function entries(): MacOSArchiveEntry[] {
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4); macho.writeUInt32LE(2, 12);
  return [file(`${base}/Contents/Info.plist`, Buffer.from(JSON.stringify(identity))), { ...file(`${base}/Contents/MacOS/Dragons Agent`, macho), mode: 0o100755 }];
}
function dependencies(input = entries()): MacOSValidationDependencies {
  return {
    async *decodeZip(bytes, limits) { assert.deepEqual(bytes, zip); assert.equal(limits.maxEntries, 30_000); yield* input; },
    readBundleIdentity(bytes) { return JSON.parse(Buffer.from(bytes).toString()); },
  };
}
async function fixture(run: (options: Parameters<typeof stageMacOSBundleForValidation>[0]) => Promise<void>, artifact = zip): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dragons-macos-test-"));
  try {
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, product: "dragons-agent", artifact: policy.expectedArtifact, platform: "darwin", arch: "arm64", version: "0.2.0", size: artifact.length, sha256: createHash("sha256").update(artifact).digest("hex") }));
    const envelope = JSON.stringify({ keyId: "fixture", payload: payload.toString("base64"), signature: sign(null, Buffer.concat([Buffer.from("dragons-agent:update-manifest:v1\n"), payload]), key).toString("base64") });
    const signal = new AbortController().signal;
    const stage = await stageVerifiedUpdate({ root, envelope, policy, signal, artifact: (async function* () { yield artifact; })() });
    const extraction = join(root, "extraction"); await mkdir(extraction);
    await writeFile(join(root, "user-data-sentinel"), "unchanged");
    await run({ root: extraction, stage: stage.directory, policy, signal });
    assert.equal(await readFile(join(root, "user-data-sentinel"), "utf8"), "unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("macOS validation stages inert fixture bundle; activation remains fail closed", async () => {
  await fixture(async (options) => {
    await assert.rejects(stageMacOSBundleForValidation(options), /Unsafe/);
    assert.deepEqual(await readdir(options.root), []);
    const result = await stageMacOSBundleForValidation(options, dependencies());
    assert.equal(result.activation, "unsupported");
    assert.equal(await readFile(join(result.bundle, "Contents", "Info.plist"), "utf8"), JSON.stringify(identity));
    assert.equal(macOSActivationSupport.supported, false);
    await assert.rejects(activateVerifiedMacOSUpdate(), /activation unsupported/);
    assert.deepEqual(await readdir(options.root), [result.directory.split(/[\\/]/).at(-1)]);
  });
});

test("macOS rejects traversal, aliases, duplicates, extra bundles and file-parent conflicts", async (t) => {
  const bad: MacOSArchiveEntry[][] = [
    [file("../escape")], [file("/tmp/escape")], [file(`${base}/../escape`)],
    [file(`${base}\\escape`)], [file(`${base}//escape`)], [file(`${base}/./escape`)],
    [file(`${base}/C:escape`)], [file(`${base}/trailing.`)], [file(`${base}/nul\0file`)],
    [file("Other.app/Contents/file")], [file(`${base}/é`) ],
    [file(`${base}/x`), file(`${base}/X`)], [file(`${base}/x`), file(`${base}/x`)],
    [file(`${base}/x`), file(`${base}/x/child`)],
    [file(`${base}/x/child`), file(`${base}/x`)],
    [{ path: `${base}/x`, kind: "directory", bytes: Buffer.from("unexpected") }],
  ];
  for (const [index, input] of bad.entries()) await t.test(`invalid archive ${index}`, async () => fixture(async (options) => {
    await assert.rejects(stageMacOSBundleForValidation(options, dependencies(input)), /Unsafe/);
    assert.deepEqual(await readdir(options.root), []);
  }));
});

test("macOS rejects extraction through symlinks even when their targets are internal", async () => {
  for (const target of ["../../outside", "/tmp/outside", "Versions/A"]) await fixture(async (options) => {
    await assert.rejects(stageMacOSBundleForValidation(options, dependencies([{ path: `${base}/Contents/link`, kind: "symlink", bytes: Buffer.from(target) }, file(`${base}/Contents/link/escape`)])), /Unsafe/);
    assert.deepEqual(await readdir(options.root), []);
  });
});

test("macOS identity, executable architecture and Mach-O type are independently checked", async () => {
  for (const change of [{ bundleIdentifier: "other" }, { version: "0.3.0" }, { executable: "../../outside" }]) await fixture(async (options) => {
    const input = entries(); input[0] = file(input[0]!.path, Buffer.from(JSON.stringify({ ...identity, ...change })));
    await assert.rejects(stageMacOSBundleForValidation(options, dependencies(input)), /Unsafe/);
    assert.deepEqual(await readdir(options.root), []);
  });
  for (const [offset, value] of [[0, 0xcafebabe], [4, 0x01000007], [12, 6]]) await fixture(async (options) => {
    const input = entries(); Buffer.from(input[1]!.bytes.buffer).writeUInt32LE(value!, offset!);
    await assert.rejects(stageMacOSBundleForValidation(options, dependencies(input)), /Unsafe/);
  });
});

test("macOS rejects a non-executable main binary and strips special permission bits", async () => {
  for (const mode of [undefined, 0o100644, 0o104600]) await fixture(async (options) => {
    const input = entries(); input[1]!.mode = mode;
    await assert.rejects(stageMacOSBundleForValidation(options, dependencies(input)), /Unsafe/);
    assert.deepEqual(await readdir(options.root), []);
  });
  await fixture(async (options) => {
    const input = entries(); input[1]!.mode = 0o107777;
    const result = await stageMacOSBundleForValidation(options, dependencies(input));
    if (process.platform !== "win32") assert.equal((await lstat(join(result.bundle, "Contents", "MacOS", "Dragons Agent"))).mode & 0o7777, 0o700);
  });
});

test("macOS re-verifies receipt and bytes before invoking decoder", async () => {
  for (const target of ["manifest.json", "artifact"]) await fixture(async (options) => {
    await writeFile(join(options.stage, target), target === "artifact" ? Buffer.alloc(zip.length, 0x78) : "tampered");
    let called = false;
    await assert.rejects(stageMacOSBundleForValidation(options, { ...dependencies(), async *decodeZip() { called = true; yield* entries(); } }));
    assert.equal(called, false);
    assert.deepEqual(await readdir(options.root), []);
  });
});

test("macOS staged symlink and non-darwin policy fail before extraction", async () => {
  await fixture(async (options) => {
    const artifact = join(options.stage, "artifact");
    await rm(artifact); await symlink(join(options.stage, "manifest.json"), artifact);
    await assert.rejects(stageMacOSBundleForValidation(options, dependencies()), /Unsafe/);
  });
  await fixture(async (options) => {
    await assert.rejects(stageMacOSBundleForValidation({ ...options, policy: { ...policy, platform: "linux" } }, dependencies()), /Update rejected/);
  });
});

test("macOS decoding failures, cancellation and entry limits clean only disposable staging", async () => {
  await fixture(async (options) => {
    await assert.rejects(stageMacOSBundleForValidation(options, { ...dependencies(), async *decodeZip() { yield entries()[0]!; throw new Error("decode failure"); } }), /decode failure/);
    assert.deepEqual(await readdir(options.root), []);
    const controller = new AbortController();
    await assert.rejects(stageMacOSBundleForValidation({ ...options, signal: controller.signal }, { ...dependencies(), async *decodeZip() { yield entries()[0]!; controller.abort(new Error("cancelled")); yield entries()[1]!; } }), /cancelled/);
    assert.deepEqual(await readdir(options.root), []);
    await assert.rejects(stageMacOSBundleForValidation({ ...options, signal: controller.signal }, dependencies()), /cancelled/);
    await assert.rejects(stageMacOSBundleForValidation(options, { ...dependencies(), async *decodeZip() { for (let i = 0; i < 30_001; i++) yield { path: `${base}/d${i}`, kind: "directory", bytes: Buffer.alloc(0) }; } }), /Unsafe/);
    assert.deepEqual(await readdir(options.root), []);
  });
});
