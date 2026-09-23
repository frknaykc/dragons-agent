import fs from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const STRUCTURAL_MAX_FILE = 262_144;
export const STRUCTURAL_MAX_BYTES = 2_097_152;
type Identity = { dev: number; ino: number };
type Directory = Identity & { path: string };
export type StructuralImage =
  | { kind: "absent"; bytes: null; mode: 0 }
  | ({ kind: "present"; bytes: Buffer; mode: number } & Identity);
export type StructuralSnapshot = { path: string; image: StructuralImage; directories: readonly Directory[] };
export type StructuralMutation = { expected: StructuralSnapshot; desired: { bytes: Buffer | null; mode: number } };
export type StructuralReceipt = { before: StructuralSnapshot; after: StructuralSnapshot };
export class StructuralMutationFailure extends Error {
  constructor(message: string, readonly completed: StructuralReceipt[], readonly uncertainPaths: string[]) {
    super(message);
  }
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const identity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const absent = (): StructuralImage => ({ kind: "absent", bytes: null, mode: 0 });
const conflict = (): never => { throw new Error("Checkpoint conflict: topology, identity, content or mode changed."); };
const same = (a: StructuralImage, b: StructuralImage): boolean => a.kind === b.kind && a.mode === b.mode
  && (a.kind === "absent" || (b.kind === "present" && identity(a, b) && a.bytes.equals(b.bytes)));

/** Internal memory-only filesystem primitive, NOT authorization or sensitive-text policy.
 * Normal development-workspace concurrency boundary: observable changes are refused.
 * Node pathname operations are NOT dirfd-relative or atomic compare-and-swap: a hostile
 * concurrent rename/link/content writer can race the final check and syscall. Callers
 * must accept that residual race; no sandbox guarantee, retries, backups or recovery.
 * Missing directories are rejected, never created. Requires O_NOFOLLOW support.
 */
export class CheckpointStructuralFs {
  readonly #root: string;
  readonly #ancestors: readonly Directory[];
  constructor(workspace: string) {
    if (!fs.constants.O_NOFOLLOW) throw new Error("Checkpoint structural filesystem requires O_NOFOLLOW.");
    this.#root = fs.realpathSync(workspace);
    const paths: string[] = [];
    for (let path = this.#root;; path = dirname(path)) {
      paths.unshift(path);
      if (dirname(path) === path) break;
    }
    this.#ancestors = paths.map((path) => this.#directory(path));
  }
  #directory(path: string): Directory {
    const info = fs.lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || fs.realpathSync(path) !== path) conflict();
    return { path, dev: info.dev, ino: info.ino };
  }
  #target(path: string): string {
    if (!path || path.length > 4096 || isAbsolute(path) || path.includes("\\") || path.includes("\0")
      || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Checkpoint path must be an exact workspace-relative path without traversal.");
    }
    const target = resolve(this.#root, path), rel = relative(this.#root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) conflict();
    return target;
  }
  #directories(path: string): Directory[] {
    this.#target(path);
    const directories = this.#ancestors.map((entry) => {
      const current = this.#directory(entry.path);
      if (!identity(entry, current)) conflict();
      return current;
    });
    let parent = this.#root;
    for (const part of path.split("/").slice(0, -1)) {
      parent = resolve(parent, part);
      directories.push(this.#directory(parent));
    }
    return directories;
  }
  #topology(snapshot: StructuralSnapshot): void {
    const current = this.#directories(snapshot.path);
    if (current.length !== snapshot.directories.length || current.some((entry, index) => {
      const expected = snapshot.directories[index]!;
      return entry.path !== expected.path || !identity(entry, expected);
    })) conflict();
  }
  #descriptor(fd: number, budget = STRUCTURAL_MAX_FILE): StructuralImage & { kind: "present" } {
    const start = fs.fstatSync(fd);
    if (!start.isFile() || start.nlink !== 1 || !Number.isSafeInteger(start.size) || start.size < 0
      || start.size > STRUCTURAL_MAX_FILE || start.size > budget) throw new Error("Checkpoint bounded regular-file image limit exceeded or hardlink refused.");
    const bytes = Buffer.alloc(start.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, Math.min(65_536, bytes.length - offset), offset);
      if (count <= 0) conflict();
      offset += count;
    }
    const extra = fs.readSync(fd, Buffer.alloc(1), 0, 1, offset), end = fs.fstatSync(fd);
    if (extra || !end.isFile() || end.nlink !== 1 || !identity(start, end) || start.size !== end.size
      || start.mode !== end.mode || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs) conflict();
    return { kind: "present", bytes, mode: start.mode & 0o7777, dev: start.dev, ino: start.ino };
  }
  #named(snapshot: StructuralSnapshot, image: StructuralImage): void {
    this.#topology(snapshot);
    let info: fs.Stats;
    try { info = fs.lstatSync(this.#target(snapshot.path)); }
    catch (error) { if (missing(error) && image.kind === "absent") return; throw error; }
    if (image.kind === "absent" || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || !identity(info, image) || (info.mode & 0o7777) !== image.mode || info.size !== image.bytes.length) conflict();
  }
  capture(path: string, budget = STRUCTURAL_MAX_FILE): StructuralSnapshot {
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > STRUCTURAL_MAX_BYTES) throw new Error("Invalid checkpoint read budget.");
    const snapshot: StructuralSnapshot = { path, image: absent(), directories: this.#directories(path) };
    const target = this.#target(path);
    try {
      const info = fs.lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) conflict();
    } catch (error) {
      if (!missing(error)) throw error;
      this.#named(snapshot, snapshot.image);
      return snapshot;
    }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { snapshot.image = this.#descriptor(fd, budget); this.#named(snapshot, snapshot.image); return snapshot; }
    finally { fs.closeSync(fd); }
  }
  #verify(snapshot: StructuralSnapshot): void {
    this.#topology(snapshot);
    const current = this.capture(snapshot.path);
    if (!same(snapshot.image, current.image)) conflict();
    this.#topology(snapshot);
  }
  #mutate(mutation: StructuralMutation): StructuralReceipt {
    const { expected, desired } = mutation, target = this.#target(expected.path);
    let fd: number | undefined, started = false;
    let receipt: StructuralReceipt | undefined, failure: unknown;
    try {
      this.#verify(expected);
      if (expected.image.kind === "absent") {
        // O_CREAT | O_EXCL is wx semantics; also nofollow, and read/write so the
        // receipt is verified on the SAME descriptor that exclusively created it.
        if (desired.bytes === null) return { before: expected, after: expected };
        this.#named(expected, expected.image);
        started = true;
        try {
          fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, desired.mode);
        } catch (error) {
          // EEXIST proves the exclusive creation did not acquire this name.
          if ((error as NodeJS.ErrnoException)?.code === "EEXIST") started = false;
          throw error;
        }
        const created = this.#descriptor(fd);
        if (created.bytes.length !== 0) conflict();
        this.#named(expected, created);
      } else {
        fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        if (!same(this.#descriptor(fd), expected.image)) conflict();
        this.#named(expected, expected.image);
      }
      if (desired.bytes === null) {
        // Unlink has no portable descriptor-relative compare-and-delete in Node.
        // Revalidate content/mode/identity immediately before the pathname syscall.
        if (!same(this.#descriptor(fd!), expected.image)) conflict();
        this.#named(expected, expected.image);
        started = true;
        fs.unlinkSync(target);
        const image = absent();
        this.#named(expected, image);
        receipt = { before: expected, after: { ...expected, image } };
      } else {
        started = true;
        let offset = 0;
        while (offset < desired.bytes.length) {
          const count = fs.writeSync(fd!, desired.bytes, offset, desired.bytes.length - offset, offset);
          if (count <= 0) throw new Error("Checkpoint write made no progress.");
          offset += count;
        }
        fs.ftruncateSync(fd!, desired.bytes.length);
        fs.fchmodSync(fd!, desired.mode);
        const image = this.#descriptor(fd!);
        if (!image.bytes.equals(desired.bytes) || image.mode !== desired.mode) conflict();
        this.#named(expected, image);
        receipt = { before: expected, after: { ...expected, image } };
      }
    } catch (error) { failure = error; }
    finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (error) { failure = error; }
    }
    if (failure) throw new StructuralMutationFailure(failure instanceof Error ? failure.message : "Checkpoint mutation failed.", [], started ? [expected.path] : []);
    return receipt!;
  }
  /** All selected expectations preflight before any writes, then each is checked
   * again at use. Failure exposes verified completed receipts and uncertain paths;
   * it never automatically reverses, retries, or adopts an unrelated postimage.
   */
  apply(mutations: readonly StructuralMutation[]): StructuralReceipt[] {
    const completed: StructuralReceipt[] = [];
    try {
      if (!mutations.length || mutations.length > 32 || new Set(mutations.map((entry) => entry.expected.path)).size !== mutations.length) {
        throw new Error("Checkpoint requires 1–32 unique paths.");
      }
      let size = 0;
      for (const { expected, desired } of mutations) {
        if (!Number.isInteger(desired.mode) || desired.mode < 0 || desired.mode > 0o7777
          || (desired.bytes === null && desired.mode !== 0)) throw new Error("Invalid checkpoint desired mode.");
        for (const bytes of [expected.image.bytes, desired.bytes]) {
          if (bytes && bytes.length > STRUCTURAL_MAX_FILE) throw new Error("Checkpoint file image limit exceeded.");
          size += bytes?.length ?? 0;
        }
        if (size > STRUCTURAL_MAX_BYTES) throw new Error("Checkpoint aggregate image limit exceeded.");
        this.#verify(expected);
      }
      for (const mutation of mutations) completed.push(this.#mutate(mutation));
      return completed;
    } catch (error) {
      throw new StructuralMutationFailure(error instanceof Error ? error.message : "Checkpoint mutation failed.", completed,
        error instanceof StructuralMutationFailure ? error.uncertainPaths : []);
    }
  }
}

/** Select receipts before calling this helper for selective rollback. A restored
 * deletion gets a NEW inode; retain the returned receipt, never reuse old identity.
 */
export function reverseStructural(receipts: readonly StructuralReceipt[]): StructuralMutation[] {
  return [...receipts].reverse().map(({ before, after }) => ({ expected: after,
    desired: { bytes: before.image.bytes, mode: before.image.mode } }));
}
