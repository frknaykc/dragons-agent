import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve, posix } from "node:path";
import { activationMode, verifyUpdateManifest, type UpdatePolicy } from "./update.js";

import { decodeMacOSZip, readMacOSBundleIdentity } from "./update-macos-decode.js";

const BUNDLE = "Dragons Agent.app";
const MAX_ENTRIES = 30_000;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

function reject(): never { throw new Error("Unsafe macOS update candidate."); }

/** A trusted decoder must account for every ZIP record, reject encrypted/ambiguous
 * local-vs-central headers and bound decompression BEFORE allocating entry bytes.
 * It has no destination path: only this module writes extracted files.
 * Default decoding uses Node zlib and the bounded macOS system plist parser.
 */
export interface MacOSArchiveEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  bytes: Uint8Array;
  mode?: number;
}

export interface MacOSValidationDependencies {
  decodeZip(bytes: Uint8Array, limits: { maxEntries: number; maxExpandedBytes: number; maxFileBytes: number }, signal: AbortSignal): AsyncIterable<MacOSArchiveEntry>;
  readBundleIdentity(plist: Uint8Array, signal?: AbortSignal): { bundleIdentifier: string; version: string; executable: string } | Promise<{ bundleIdentifier: string; version: string; executable: string }>;
}

export interface MacOSValidationOptions {
  stage: string;
  /** Existing private host-owned root, outside workspaces and installed apps. */
  root: string;
  policy: UpdatePolicy;
  signal: AbortSignal;
}

export const macOSActivationSupport = Object.freeze({
  supported: false as const,
  reason: "Bundle signing policy, exited-host ownership and native recovery acceptance are not implemented.",
});

/** Deliberately cannot call activateStagedCandidate/confirmActivatedUpdate or the
 * health worker: their slot and child-exit guarantees do not establish macOS app
 * ownership, code-signing identity, or data-safe native installation/relaunch.
 */
export async function activateVerifiedMacOSUpdate(): Promise<never> {
  throw new Error(`macOS activation unsupported: ${macOSActivationSupport.reason}`);
}

async function regularFile(path: string, maximum: number): Promise<Buffer> {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > maximum) reject();
  const bytes = await readFile(path);
  if (bytes.length !== state.size || bytes.length > maximum) reject();
  return bytes;
}

function entryPath(path: string): string[] {
  // Conservative portable subset: reject normalization/case aliases, ADS, drive
  // paths, backslashes and Unicode normalization ambiguity rather than repair it.
  if (typeof path !== "string" || path.length > 1024 || !/^[\x20-\x7e]+$/.test(path) || path.includes("\\") || path.includes(":")) reject();
  const parts = path.split("/");
  if (parts.length > 32 || parts[0] !== BUNDLE || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) reject();
  return parts;
}

/** Validation-only staging: all records/paths/links are checked before extraction.
 * Framework links are created last and must resolve to existing internal entries.
 * ZIP64, fat Mach-O, non-ASCII paths and native activation remain unsupported.
 * No installed application/user data is touched; this is not a signing verdict. */
export async function stageMacOSBundleForValidation(options: MacOSValidationOptions, dependencies?: MacOSValidationDependencies): Promise<{ directory: string; bundle: string; activation: "unsupported" }> {
  options.signal.throwIfAborted();
  dependencies ??= { decodeZip: decodeMacOSZip, readBundleIdentity: readMacOSBundleIdentity };
  const stage = resolve(options.stage);
  const root = resolve(options.root);
  for (const path of [stage, root]) {
    const state = await lstat(path);
    if (!state.isDirectory() || state.isSymbolicLink()) reject();
  }
  const receipt = await regularFile(join(stage, "manifest.json"), 16_384);
  const manifest = verifyUpdateManifest(receipt.toString("utf8"), options.policy);
  if (manifest.platform !== "darwin" || activationMode(manifest) !== "transactional") reject();
  const zip = await regularFile(join(stage, "artifact"), manifest.size);
  if (zip.length !== manifest.size || createHash("sha256").update(zip).digest("hex") !== manifest.sha256) reject();
  options.signal.throwIfAborted();
  const directory = await mkdtemp(join(root, "macos-validation-"));
  try {
    const known = new Map<string, { path: string; kind: MacOSArchiveEntry["kind"]; explicit: boolean }>();
    const entries: MacOSArchiveEntry[] = [];
    let count = 0;
    let expanded = 0;
    for await (const entry of dependencies.decodeZip(zip, { maxEntries: MAX_ENTRIES, maxExpandedBytes: MAX_EXPANDED_BYTES, maxFileBytes: MAX_FILE_BYTES }, options.signal)) {
      options.signal.throwIfAborted();
      if (++count > MAX_ENTRIES || (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symlink") || !(entry.bytes instanceof Uint8Array)) reject();
      const parts = entryPath(entry.path);
      if (entry.kind === "directory" && entry.bytes.byteLength !== 0) reject();
      if (entry.bytes.byteLength > MAX_FILE_BYTES || entry.bytes.byteLength > MAX_EXPANDED_BYTES - expanded) reject();
      expanded += entry.bytes.byteLength;
      for (let index = 1; index <= parts.length; index++) {
        const path = parts.slice(0, index).join("/");
        const key = path.toLowerCase();
        const last = index === parts.length;
        const kind = last ? entry.kind : "directory";
        const previous = known.get(key);
        if (previous && (previous.path !== path || previous.kind !== kind || (last && previous.explicit))) reject();
        if (previous) { if (last) previous.explicit = true; continue; }
        if (known.size >= MAX_ENTRIES) reject();
        known.set(key, { path, kind, explicit: last });
      }
      entries.push({ ...entry, bytes: Buffer.from(entry.bytes) });
    }
    const links = new Map<string, string>();
    for (const entry of entries) if (entry.kind === "symlink") {
      const target = Buffer.from(entry.bytes).toString("utf8");
      if (!target || target.length > 1024 || !/^[\x20-\x7e]+$/.test(target) || target.startsWith("/") || target.includes("\\") || target.includes(":")) reject();
      // Validate each lexical hop, not just the final normalized destination.
      let path = posix.dirname(entry.path);
      for (const part of target.split("/")) {
        if (!part || part === ".") reject();
        path = part === ".." ? posix.dirname(path) : `${path}/${part}`;
        entryPath(path);
      }
      links.set(entry.path, target);
    }
    let resolutionSteps = 0;
    const resolveLink = (path: string, visiting = new Set<string>()): string => {
      if (++resolutionSteps > 1_000_000) reject();
      const parts = path.split("/");
      for (let index = 1; index <= parts.length; index++) {
        const prefix = parts.slice(0, index).join("/");
        const target = links.get(prefix);
        if (target !== undefined) {
          if (visiting.has(prefix) || visiting.size >= 32) reject();
          const next = new Set(visiting); next.add(prefix);
          // Resolve the target BEFORE appending the suffix: '..' must not be
          // normalized across an unresolved symlink component.
          let resolved = posix.dirname(prefix);
          for (const part of target.split("/")) {
            if (known.get(resolved.toLowerCase())?.kind !== "directory") reject();
            resolved = part === ".." ? posix.dirname(resolved) : resolveLink(`${resolved}/${part}`, next);
            entryPath(resolved);
          }
          return resolveLink([resolved, ...parts.slice(index)].join("/"), next);
        }
      }
      const record = known.get(path.toLowerCase());
      if (!record || record.path !== path) reject();
      return path;
    };
    for (const path of links.keys()) resolveLink(path);
    // No archive entry may descend through a symlink; parents were checked above.
    for (const record of known.values()) if (record.kind === "directory") {
      options.signal.throwIfAborted();
      await mkdir(join(directory, record.path), { mode: 0o700 });
    }
    for (const entry of entries) if (entry.kind === "file") {
      options.signal.throwIfAborted();
      const handle = await open(join(directory, entry.path), "wx", entry.mode && (entry.mode & 0o111) ? 0o700 : 0o600);
      try { await handle.writeFile(entry.bytes); await handle.sync(); }
      finally { await handle.close(); }
    }
    for (const [path, target] of links) {
      options.signal.throwIfAborted();
      await symlink(target, join(directory, path));
    }
    options.signal.throwIfAborted();
    const bundle = join(directory, BUNDLE);
    const identity = await dependencies.readBundleIdentity(await regularFile(join(bundle, "Contents", "Info.plist"), 1024 * 1024), options.signal);
    if (identity.bundleIdentifier !== "com.dragonsagent.desktop" || identity.version !== manifest.version || identity.executable !== "Dragons Agent") reject();
    const executablePath = join(bundle, "Contents", "MacOS", identity.executable);
    // A Mach-O header alone does not make a runnable bundle. Inspect the staged
    // mode as well so missing archive execute bits (or a restrictive umask)
    // cannot produce a successful validation of a non-executable main binary.
    const executableEntry = entries.find((entry) => entry.path === `${BUNDLE}/Contents/MacOS/${identity.executable}`);
    if (!((executableEntry?.mode ?? 0) & 0o111)) reject();
    if (process.platform !== "win32" && !((await lstat(executablePath)).mode & 0o100)) reject();
    const executable = await regularFile(executablePath, MAX_FILE_BYTES);
    // Thin 64-bit little-endian Mach-O only; metadata cannot assert architecture.
    if (executable.length < 32 || executable.readUInt32LE(0) !== 0xfeedfacf || executable.readUInt32LE(4) !== (manifest.arch === "arm64" ? 0x0100000c : 0x01000007) || executable.readUInt32LE(12) !== 2) reject();
    options.signal.throwIfAborted();
    return { directory, bundle, activation: "unsupported" };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
