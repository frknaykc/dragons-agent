import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DATA_VOLUME = "/System/Volumes/Data";
const BUNDLE_ID = "com.dragonsagent.desktop";
export const macOSPreflightLimits = Object.freeze({ timeoutMs: 10_000, outputBytes: 65_536, pathBytes: 1024, ancestors: 32 });
type Command = "/usr/bin/codesign" | "/usr/sbin/diskutil" | "/usr/bin/plutil" | "/bin/ls";
export interface MacOSPreflightCommandResult { stdout: string; stderr: string }
export interface MacOSPreflightDependencies {
  platform: string;
  uid: number;
  home: string;
  lstat(path: string): Promise<Pick<Stats, "uid" | "mode" | "dev" | "isDirectory" | "isSymbolicLink">>;
  realpath(path: string): Promise<string>;
  access(path: string, mode: number): Promise<void>;
  run(command: Command, args: readonly string[], signal: AbortSignal, input?: string): Promise<MacOSPreflightCommandResult>;
}
function reject(reason: string): never { throw new Error(`macOS preflight rejected: ${reason}.`); }

/** Fixed system binaries, no shell/environment inheritance, aggregate output cap,
 * deadline/cancellation SIGKILL, and close/reaping barrier; no tree-sandbox claim.
 * Matches update-macos-decode's bounded native parser pattern. */
export async function runMacOSPreflightCommand(command: Command, args: readonly string[], signal: AbortSignal, input?: string): Promise<MacOSPreflightCommandResult> {
  if (process.platform !== "darwin") reject("unsupported host");
  if (!["/usr/bin/codesign", "/usr/sbin/diskutil", "/usr/bin/plutil", "/bin/ls"].includes(command) || args.length > 16 || args.some((arg) => arg.length > 4096 || arg.includes("\0")) || (input === undefined ? 0 : Buffer.byteLength(input)) > macOSPreflightLimits.outputBytes) reject("command bounds");
  const parser = command === "/usr/bin/plutil" && JSON.stringify(args) === JSON.stringify(["-convert", "json", "-o", "-", "--", "-"]);
  const path = args.at(-1);
  const reader = (command === "/bin/ls" && args.length === 2 && args[0] === "-ldneO") ||
    (command === "/usr/sbin/diskutil" && JSON.stringify(args) === JSON.stringify(["info", "-plist", DATA_VOLUME])) ||
    (command === "/usr/bin/codesign" && ((args.length === 3 && args[0] === "--display" && args[1] === "--verbose=4") ||
      (args.length === 6 && JSON.stringify(args.slice(0, 4)) === JSON.stringify(["--verify", "--deep", "--strict=all", "-R"]))));
  if ((!parser && (!reader || !path?.startsWith("/"))) || (input !== undefined && !parser)) reject("non-read-only command");
  signal.throwIfAborted();
  return new Promise((accept, fail) => {
    const child = spawn(command, [...args], { env: { PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    let failure = "", size = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const stop = (reason: string) => { failure ||= reason; child.kill("SIGKILL"); };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("deadline"), macOSPreflightLimits.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => stop("process error"));
    child.stdin.on("error", () => stop("input error"));
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) {
      stream.on("error", () => stop("output error"));
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > macOSPreflightLimits.outputBytes) stop("output limit");
        else chunks.push(chunk);
      });
    }
    child.once("close", (code) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure || code !== 0 || signal.aborted) fail(new Error(`macOS preflight command failed: ${failure || "nonzero exit"}.`));
      else accept({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    if (signal.aborted) abort();
    child.stdin.end(input);
  });
}

function nativeDependencies(): MacOSPreflightDependencies {
  return { platform: process.platform, uid: process.getuid?.() ?? -1, home: homedir(), lstat, realpath, access, run: runMacOSPreflightCommand };
}
function exactPath(path: string): void {
  if (typeof path !== "string" || Buffer.byteLength(path) > macOSPreflightLimits.pathBytes || !/^[\x20-\x7e]+$/.test(path) || !path.startsWith("/") || resolve(path) !== path || path.includes("\\")) reject("noncanonical path");
}

/** Internal HOST-ONLY composition. Never derive policy/dependencies from a feed,
 * manifest, renderer or provider. No production Team ID is supplied by this repo.
 * Sources: macOS codesign(1), -R/--strict/--deep; Apple's requirement language:
 * https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html
 * Developer ID certificate OIDs: Apple's Security policydb.cpp (Developer ID rules):
 * https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/policydb.cpp
 */
export function createMacOSPreflight(hostPolicy: { teamIdentifier: string; bundleIdentifier: string }, dependencies: MacOSPreflightDependencies = nativeDependencies()) {
  const team = hostPolicy.teamIdentifier;
  if (!/^[A-Z0-9]{10}$/.test(team) || hostPolicy.bundleIdentifier !== BUNDLE_ID) reject("missing host-pinned production identity");
  const d = { ...dependencies };
  const requireHost = (signal: AbortSignal) => { signal.throwIfAborted(); if (d.platform !== "darwin" || !Number.isSafeInteger(d.uid) || d.uid <= 0) reject("unsupported host or root helper"); };
  const run = async (command: Command, args: readonly string[], signal: AbortSignal, input?: string) => {
    signal.throwIfAborted();
    const result = await d.run(command, args, signal, input);
    signal.throwIfAborted();
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > macOSPreflightLimits.outputBytes) reject("output limit");
    return result;
  };
  return Object.freeze({
    /** OS cryptographic verification only; neither notarization nor activation
     * authorization. Future helper must verify again under its ownership lock. */
    async verifySignature(bundle: string, signal: AbortSignal) {
      requireHost(signal); exactPath(bundle);
      const state = await d.lstat(bundle);
      if (!state.isDirectory() || state.isSymbolicLink() || await d.realpath(bundle) !== bundle) reject("signature path alias");
      const requirement = `anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "${team}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict=all", "-R", requirement, bundle], signal);
      const display = await run("/usr/bin/codesign", ["--display", "--verbose=4", bundle], signal);
      const text = `${display.stdout}\n${display.stderr}`;
      const field = (name: string) => {
        const values = text.split(/\r?\n/).filter((line) => line.startsWith(`${name}=`));
        if (values.length !== 1) reject("ambiguous signature metadata");
        return values[0]!.slice(name.length + 1);
      };
      if (/^Signature=adhoc\s*$/mi.test(text) || /flags=.*\badhoc\b/i.test(text) || field("TeamIdentifier") !== team || field("Identifier") !== BUNDLE_ID) reject("untrusted production signature");
      return Object.freeze({ signature: "developer-id-verified" as const, teamIdentifier: team, bundleIdentifier: BUNDLE_ID, notarization: "not-assessed" as const, activation: "unsupported" as const });
    },
    /** Conservative existing per-user install only. diskutil(8) info -plist takes
     * a mount point, not an arbitrary directory. stat.dev binds the target and
     * staging directory to the inspected Data volume. Missing keys fail closed.
     * ls(1) -e/-O exposes ACLs/flags; all ACLs/flags are unsupported, not evaluated.
     * No mkdir, chmod, xattr, signing, replacement, or installed-app mutation. */
    async inspectInstallTarget(target: string, stagingDirectory: string, signal: AbortSignal) {
      requireHost(signal); exactPath(target); exactPath(stagingDirectory); exactPath(d.home);
      if (!/^\/Users\/[^/]+$/.test(d.home) || target !== join(d.home, "Applications", "Dragons Agent.app")) reject("unsupported install location");
      const parent = dirname(target);
      if (stagingDirectory === target || stagingDirectory.startsWith(`${parent}/`) || target.startsWith(`${stagingDirectory}/`)) reject("staging overlaps install location");
      for (const path of [target, stagingDirectory]) {
        let current = path, depth = 0;
        while (true) {
          signal.throwIfAborted();
          if (++depth > macOSPreflightLimits.ancestors) reject("ancestor limit");
          const state = await d.lstat(current);
          if (!state.isDirectory() || state.isSymbolicLink() || (state.uid !== 0 && state.uid !== d.uid) || (state.mode & 0o022) !== 0 || await d.realpath(current) !== current) reject("unsafe ancestor");
          if ((current === path || current === parent) && (state.uid !== d.uid || (state.mode & 0o300) !== 0o300)) reject("nonowned or unwritable target");
          if (current === stagingDirectory && (state.mode & 0o077) !== 0) reject("staging is not private");
          const listing = await run("/bin/ls", ["-ldneO", current], signal);
          const lines = listing.stdout.trimEnd().split("\n");
          const columns = lines[0]?.trim().split(/\s+/);
          if (listing.stderr || lines.length !== 1 || !columns || !/^d[rwxstST-]{9}[@]?$/.test(columns[0] ?? "") || columns[4] !== "-") reject("ACL or file flags unsupported or unproven");
          if (current === "/") break;
          current = dirname(current);
        }
        await d.access(path, constants.W_OK | constants.X_OK);
      }
      await d.access(parent, constants.W_OK | constants.X_OK);
      const volumeState = await d.lstat(DATA_VOLUME);
      if (!volumeState.isDirectory() || volumeState.isSymbolicLink() || volumeState.uid !== 0 || await d.realpath(DATA_VOLUME) !== DATA_VOLUME) reject("unproven Data volume");
      for (const path of [target, parent, stagingDirectory]) if ((await d.lstat(path)).dev !== volumeState.dev) reject("cross-volume install unsupported");
      const plist = await run("/usr/sbin/diskutil", ["info", "-plist", DATA_VOLUME], signal);
      const json = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], signal, plist.stdout);
      const volume: unknown = JSON.parse(json.stdout);
      if (!volume || typeof volume !== "object" || Array.isArray(volume)) reject("unproven volume");
      const v = volume as Record<string, unknown>;
      if (v.Error !== undefined || v.MountPoint !== DATA_VOLUME || v.FilesystemType !== "apfs" || v.Internal !== true || v.Writable !== true || v.WritableVolume !== true || v.GlobalPermissionsEnabled !== true || v.Removable !== false || v.Ejectable !== false || v.SystemImage !== false || v.APFSSnapshot !== false || v.Locked !== false) reject("unsupported or unproven volume");
      signal.throwIfAborted();
      return Object.freeze({ target, stagingDirectory, observation: "conservative-target-checks-passed" as const, activation: "unsupported" as const, reason: "Path observations are not race-free native ownership, atomic replacement, exited-host, or recovery proof." });
    },
  });
}
