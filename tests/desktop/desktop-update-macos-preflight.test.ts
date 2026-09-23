import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacOSPreflight, runMacOSPreflightCommand, type MacOSPreflightDependencies } from "../../dist/desktop/update-macos-preflight.js";

const policy = { teamIdentifier: "ABCDE12345", bundleIdentifier: "com.dragonsagent.desktop" };
const signal = () => new AbortController().signal;
const target = "/Users/test/Applications/Dragons Agent.app";
const staging = "/Users/test/private/staging";
const volume = { MountPoint: "/System/Volumes/Data", FilesystemType: "apfs", Internal: true, Writable: true, WritableVolume: true, GlobalPermissionsEnabled: true, Removable: false, Ejectable: false, SystemImage: false, APFSSnapshot: false, Locked: false };
function fixture() {
  const calls: { command: string; args: readonly string[] }[] = [];
  const states = new Map<string, Partial<{ uid: number; mode: number; dev: number; isSymbolicLink(): boolean; isDirectory(): boolean }>>();
  const outputs = new Map<string, string>();
  const d: MacOSPreflightDependencies = {
    platform: "darwin", uid: 501, home: "/Users/test",
    lstat: (async (path: string) => ({ uid: path === "/System/Volumes/Data" || path === "/" || path === "/Users" ? 0 : 501, mode: 0o40700, dev: 42, isDirectory: () => true, isSymbolicLink: () => false, ...states.get(path) })) as MacOSPreflightDependencies["lstat"],
    realpath: (async (path: string) => path) as MacOSPreflightDependencies["realpath"],
    access: async () => {},
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "/bin/ls") return { stdout: outputs.get(args[1]!) ?? "drwx------ 2 501 20 - 64 Sep 11 12:00 fixture\n", stderr: "" };
      if (command === "/usr/bin/plutil") return { stdout: outputs.get("volume") ?? JSON.stringify(volume), stderr: "" };
      if (command === "/usr/sbin/diskutil") return { stdout: "<plist/>", stderr: "" };
      return { stdout: "", stderr: args[0] === "--display" ? outputs.get("signature") ?? "Identifier=com.dragonsagent.desktop\nTeamIdentifier=ABCDE12345\nSignature size=9000\n" : "" };
    },
  };
  return { d, calls, states, outputs };
}

test("host identity must be pinned, exact, injection-safe and captured before async work", async () => {
  for (const teamIdentifier of ["", "adhoc", 'ABCDE12345" or true', "ABCDE123456"]) assert.throws(() => createMacOSPreflight({ ...policy, teamIdentifier }), /host-pinned/);
  assert.throws(() => createMacOSPreflight({ ...policy, bundleIdentifier: "other.app" }), /host-pinned/);
  const f = fixture(); const mutable = { ...policy }; const verifier = createMacOSPreflight(mutable, f.d);
  mutable.teamIdentifier = "ZZZZZ99999";
  const result = await verifier.verifySignature(target, signal());
  assert.equal(result.signature, "developer-id-verified");
  assert.equal(result.notarization, "not-assessed"); assert.equal(result.activation, "unsupported");
  assert.equal(f.calls[0]?.command, "/usr/bin/codesign");
  assert.deepEqual(f.calls[0]?.args.slice(0, 4), ["--verify", "--deep", "--strict=all", "-R"]);
  assert.match(f.calls[0]!.args[4]!, /anchor apple generic.*ABCDE12345.*100\.6\.2\.6.*100\.6\.1\.13/);
});

test("OS failure is authoritative, not display metadata", async () => {
  const f = fixture(); f.d.run = async () => { throw new Error("native rejected"); };
  await assert.rejects(createMacOSPreflight(policy, f.d).verifySignature(target, signal()), /native rejected/);
});

test("ad-hoc, wrong, missing, duplicated and oversized OS metadata fail closed", async () => {
  for (const metadata of [
    "Identifier=com.dragonsagent.desktop\nTeamIdentifier=ABCDE12345\nSignature=adhoc\n",
    "Identifier=com.dragonsagent.desktop\nTeamIdentifier=ABCDE12345\nCodeDirectory flags=0x2(adhoc)\n",
    "Identifier=com.dragonsagent.desktop\nTeamIdentifier=ZZZZZ99999\n",
    "Identifier=other.app\nTeamIdentifier=ABCDE12345\n",
    "Identifier=com.dragonsagent.desktop\n",
    "Identifier=com.dragonsagent.desktop\nTeamIdentifier=ABCDE12345\nTeamIdentifier=ABCDE12345\n",
    "x".repeat(65_537),
  ]) {
    const f = fixture(); f.outputs.set("signature", metadata);
    await assert.rejects(createMacOSPreflight(policy, f.d).verifySignature(target, signal()), /preflight rejected/);
  }
});

test("supported target observations never authorize activation; native volume command uses mount point", async () => {
  const f = fixture();
  const result = await createMacOSPreflight(policy, f.d).inspectInstallTarget(target, staging, signal());
  assert.equal(result.observation, "conservative-target-checks-passed"); assert.equal(result.activation, "unsupported");
  assert.match(result.reason, /not race-free/);
  assert.deepEqual(f.calls.find((call) => call.command === "/usr/sbin/diskutil")?.args, ["info", "-plist", "/System/Volumes/Data"]);
});

test("reject unsupported locations, lexical aliases, unsafe ancestors and targets", async () => {
  for (const path of ["/Applications/Dragons Agent.app", "/Volumes/Test/Dragons Agent.app", "/Users/test/Applications/../Applications/Dragons Agent.app", target + "/", target + "\0"]) {
    const f = fixture(); await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(path, staging, signal())); assert.equal(f.calls.length, 0);
  }
  for (const [path, state] of [
    ["/Users/test", { uid: 999 }], ["/Users/test", { mode: 0o40720 }],
    ["/Users/test", { isSymbolicLink: () => true }], [target, { uid: 0 }],
    [target, { mode: 0o40500 }], [target, { isDirectory: () => false }],
    [staging, { uid: 999 }], [staging, { mode: 0o40755 }], [staging, { dev: 99 }], [target, { dev: 99 }],
  ] as const) {
    const f = fixture(); f.states.set(path, state);
    await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(target, staging, signal()));
  }
  for (const overlap of [target, "/Users/test/Applications", `${target}/staging`, "/Users/test"]) {
    const f = fixture();
    await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(target, overlap, signal()), /overlaps/);
  }
  const f = fixture(); f.d.realpath = (async () => "/aliased") as MacOSPreflightDependencies["realpath"];
  await assert.rejects(createMacOSPreflight(policy, f.d).verifySignature(target, signal()), /alias/);
});

test("ACLs, flags, unknown listing format and failed effective access are unsupported", async () => {
  for (const listing of ["drwx------+ 2 501 20 - 64 date fixture\n 0: group:everyone allow delete\n", "drwx------ 2 501 20 uchg 64 date fixture\n", "", "unexpected"]) {
    const f = fixture(); f.outputs.set("/Users/test", listing);
    await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(target, staging, signal()), /ACL or file flags/);
  }
  const f = fixture(); f.d.access = async () => { throw new Error("EACCES"); };
  await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(target, staging, signal()), /EACCES/);
});

test("every required volume proof must be present and match; removable/read-only/image/network fail closed", async () => {
  for (const key of Object.keys(volume)) {
    const f = fixture(); const incomplete = { ...volume } as Record<string, unknown>; delete incomplete[key];
    f.outputs.set("volume", JSON.stringify(incomplete));
    await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(target, staging, signal()), /volume/);
  }
  for (const change of [{ Internal: false }, { Writable: false }, { GlobalPermissionsEnabled: false }, { FilesystemType: "nfs" }, { Removable: true }, { SystemImage: true }, { APFSSnapshot: true }, { Error: true }]) {
    const f = fixture(); f.outputs.set("volume", JSON.stringify({ ...volume, ...change }));
    await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(target, staging, signal()), /volume/);
  }
});

test("wrong hosts, root helpers, pre-abort and cancellation after command fail closed", async () => {
  for (const change of [{ platform: "linux" }, { platform: "win32" }, { uid: 0 }]) {
    const f = fixture(); Object.assign(f.d, change);
    await assert.rejects(createMacOSPreflight(policy, f.d).verifySignature(target, signal()), /unsupported/); assert.equal(f.calls.length, 0);
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(createMacOSPreflight(policy, f.d).inspectInstallTarget(target, staging, controller.signal)); assert.equal(f.calls.length, 0);
  const g = fixture(), later = new AbortController(); g.d.run = async () => { later.abort(); return { stdout: "", stderr: "" }; };
  await assert.rejects(createMacOSPreflight(policy, g.d).verifySignature(target, later.signal));
});

test("native macOS: disposable unsigned bundle is rejected by real codesign, parser is bounded", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-preflight-")));
  try {
    const bundle = join(root, "Fixture.app");
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(bundle, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.dragonsagent.desktop</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>');
    await writeFile(join(bundle, "Contents", "MacOS", "fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await assert.rejects(createMacOSPreflight(policy).verifySignature(bundle, signal()), /command failed/);
    const parsed = await runMacOSPreflightCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], signal(), '<plist version="1.0"><dict><key>proof</key><true/></dict></plist>');
    assert.deepEqual(JSON.parse(parsed.stdout), { proof: true });
    await assert.rejects(runMacOSPreflightCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], signal(), "x".repeat(65_537)), /bounds/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runMacOSPreflightCommand("/usr/bin/codesign", ["--display", "--verbose=4", bundle], controller.signal), { name: "AbortError" });
    await assert.rejects(runMacOSPreflightCommand("/usr/bin/codesign", ["--sign", "-", bundle], signal()), /non-read-only/);
    await assert.rejects(createMacOSPreflight(policy).inspectInstallTarget(bundle, root, signal()), /unsupported install location/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
