import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync, ftruncateSync, fchmodSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentModel } from "./agent.js";
import type { AgentTool, ToolResult } from "./tools.js";
import { RuntimeTextRedactor } from "./runtime-redaction.js";
import { CheckpointStructuralFs, StructuralMutationFailure, reverseStructural, type StructuralSnapshot, type StructuralReceipt } from "./checkpoint-structural-fs.js";
import { safeCheckpointIoAvailable } from "./checkpoint-win32.js";

// 256 KiB per image; at most 2 MiB per admitted batch and retained history.
// Capture can coexist with history (4 MiB image payload total), plus one
// bounded verification image and transient UTF-8/redaction/JSON allocations.
// Legacy diff is capped at 60,000 bytes; explicit pages inspect bounded UTF-8 slices.
const MAX_FILE = 262_144;
const READ_CHUNK = 65_536;
const MAX_BYTES = 2_097_152;
const MAX_CHECKPOINTS = 32;
const DIFF_SLICE = 4096;
// JSON already escapes C0; also neutralize terminal C1 and bidi/line controls.
const safeJson = (value: unknown): string => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const imagePages = (bytes: Buffer | null): number => Math.max(1, Math.ceil((bytes?.length ?? 0) / DIFF_SLICE));
const redactPath = (path: string): string => { const redactor = new RuntimeTextRedactor(); return redactor.push(path) + redactor.finish(); };
type Image = { bytes: Buffer | null; mode: number; dev?: number; ino?: number; fileId?: string };
class MutationFailure extends Error {
  constructor(message: string, readonly changedPaths: string[]) { super(message); }
}
function mutationFailureOutput(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  if (!(error instanceof MutationFailure) || !error.changedPaths.length) return message;
  const paths = error.changedPaths.slice(0, 32).map((path) => path.slice(0, 512));
  return `${message} Uncertain changed paths: ${JSON.stringify(paths)} (at most 32 paths, 512 characters per path).`;
}
type Entry = { path: string; before: Image; after: Image; snapshot?: StructuralSnapshot; receipt?: StructuralReceipt };
type Checkpoint = { id: string; entries: Entry[] };
export type CaptureEligibility =
  | { kind: "covered" }
  | { kind: "unsupported"; reason: "structural" | "nested" | "platform" }
  | { kind: "rejected"; result: ToolResult };
export type FileMutation = { path: string; content: string | null; expected?: string | null };
const digest = (bytes: Buffer | null) => bytes === null ? "absent" : createHash("sha256").update(bytes).digest("hex");
const same = (a: Image, b: Image) => a.mode === b.mode && digest(a.bytes) === digest(b.bytes)
  && (a.dev === undefined || b.dev === undefined || (a.dev === b.dev
    && (a.fileId || b.fileId ? a.fileId !== undefined && a.fileId === b.fileId : a.ino === b.ino)));
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
/** Conservative lexical exclusions over bounded UTF-8 images, not a secret detector.
 * Recognizes literal ASCII assignment keys containing password/secret/token and
 * literal scheme://authority userinfo, alongside known paths/redactor patterns.
 * Encoded/escaped keys or whole URLs, arbitrary names and unlabelled values can
 * evade this policy; benign matching names/userinfo may also be refused.
 */
export function sensitiveContext(path: string, bytes: Buffer | null): boolean {
  // Do not retain credential-bearing filenames: redacted labels cannot safely
  // act as exact selectors (they may name a different real file).
  if (redactPath(path) !== path) return true;
  if (/(?:^|[\\/])(?:\.env[^\\/]*|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.dragons|\.hermes|credentials?[^\\/]*|auth\.json|secrets?[^\\/]*|id_rsa[^\\/]*|id_ed25519[^\\/]*|\.npmrc|\.netrc)(?:[\\/]|$)|\.(?:pem|key|p12|pfx|keystore)$/i.test(path)) return true;
  if (!bytes) return false;
  const text = bytes.toString("utf8");
  const redactor = new RuntimeTextRedactor();
  return !Buffer.from(text).equals(bytes) || text.includes("\0") || redactor.push(text) + redactor.finish() !== text
    || /(?:^|[\s"'`{,;\[(])(?:[a-z0-9_$.-]*(?:password|secret|token)[a-z0-9_$.-]*)["'`\s]*[:=]/i.test(text)
    || /[a-z][a-z0-9+.-]*:\/\/[^\s/\\?#@"'`<>]+@/i.test(text)
    || /(?:^|[\s"'`{,])(?:client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|database[_-]?url|connection[_-]?string)["'`\s]*[:=]/i.test(text)
    || /-----BEGIN .*PRIVATE KEY-----|(?:gh[pousr]_|github_pat_|AKIA|AIza)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(text);
}

/** Bounded, process-memory-only session history. Never serialize this object or its images.
 * Only built-in file tools call mutate after runAgent authorization. EXECUTE/MCP are not covered.
 * File create/delete and edits in existing directories. Workspace ancestors and inode link/content
 * ownership must not be changed concurrently by an untrusted OS process. Node
 * cannot atomically compare-and-write or prevent links/renames after fstat; these
 * checks are conflict detection, not a sandbox against hostile filesystem writers.
 */
export class SessionCheckpoints {
  #items: Checkpoint[] = [];
  #next = 1;
  readonly #namespace = randomUUID();
  #busy = false;
  #structural?: CheckpointStructuralFs;
  #backend(): CheckpointStructuralFs { return this.#structural ??= new CheckpointStructuralFs(this.#root); }
  readText(path: string): string {
    const image = safeCheckpointIoAvailable ? this.#backend().capture(path).image : this.#read(path);
    if (image.bytes === null) throw Object.assign(new Error("File not found."), { code: "ENOENT" });
    if (sensitiveContext(path, image.bytes)) throw new Error("Checkpoint excludes sensitive or binary text.");
    return image.bytes.toString("utf8");
  }
  readonly #root: string;
  readonly #rootIdentity: { dev: number; ino: number };
  constructor(workspace: string) { this.#root = realpathSync(workspace); this.#rootIdentity = lstatSync(this.#root); }
  clear(): void { this.#items = []; }
  #path(path: string): string {
    const root = lstatSync(this.#root);
    if (!root.isDirectory() || root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino || realpathSync(this.#root) !== this.#root) {
      throw new Error("Checkpoint workspace topology changed; operation refused.");
    }
    if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error("Checkpoint path must be workspace-relative without traversal.");
    const target = resolve(this.#root, path);
    const rel = relative(this.#root, target);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Checkpoint path escapes workspace.");
    let parent = this.#root;
    const parts = rel.split(sep);
    for (let i = 0; i < parts.length; i++) {
      parent = resolve(parent, parts[i]!);
      try {
        const info = lstatSync(parent);
        if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory()) || (i === parts.length - 1 && (!info.isFile() || info.nlink !== 1))) throw new Error("Checkpoint rejects symlinks, hardlinks and non-regular files.");
      } catch (error) { if (!(missing(error) && i === parts.length - 1)) throw error; }
    }
    return target;
  }
  #readDescriptor(fd: number, budget = MAX_FILE): Image {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE) {
      throw new Error("Checkpoint target is not a bounded regular text file (256 KiB maximum).");
    }
    if (info.size > budget) throw new Error("Checkpoint aggregate batch image limit exceeded (2 MiB).");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, Math.min(READ_CHUNK, bytes.length - offset), offset);
      if (count <= 0) throw new Error("Checkpoint conflict: file shrank during bounded read.");
      offset += count;
    }
    // Never read an unbounded tail even if the file grows after initial fstat.
    const extra = readSync(fd, Buffer.alloc(1), 0, 1, offset);
    const final = fstatSync(fd);
    if (extra !== 0 || !final.isFile() || final.nlink !== 1 || final.size !== info.size
      || final.dev !== info.dev || final.ino !== info.ino || final.mode !== info.mode
      || final.mtimeMs !== info.mtimeMs || final.ctimeMs !== info.ctimeMs) {
      throw new Error("Checkpoint conflict: file changed during bounded read.");
    }
    return { bytes, mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  }
  #read(path: string, budget = MAX_FILE): Image {
    const target = this.#path(path);
    let fd: number;
    try { fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) { if (missing(error)) return { bytes: null, mode: 0 }; throw error; }
    try {
      return this.#readDescriptor(fd, budget);
    } finally { closeSync(fd); }
  }
  #supported(path: string, before: Image, after: Image): void {
    // Node has no portable dirfd-relative open/unlink. Do not pretend that
    // check-then-create/delete or walking mutable ancestors is race-safe.
    if (path.includes("/") || before.bytes === null || after.bytes === null || !constants.O_NOFOLLOW) {
      throw new Error("Checkpoint unsupported operation/topology: only existing top-level regular-file edits are supported; creation, deletion and nested paths require native directory-relative containment.");
    }
  }
  #verify(fd: number, target: string, expected: Image): void {
    const info = fstatSync(fd);
    const named = lstatSync(target);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE || named.isSymbolicLink()
      || info.dev !== expected.dev || info.ino !== expected.ino || named.dev !== info.dev || named.ino !== info.ino
      || !same(this.#readDescriptor(fd), expected)) {
      throw new Error("Checkpoint conflict: descriptor or file changed externally; no overwrite allowed.");
    }
  }
  #write(path: string, expected: Image, desired: Image): void {
    this.#supported(path, expected, desired);
    const target = this.#path(path);
    // Never truncate/open for write on a separate, unverified descriptor.
    const fd = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    let started = false;
    try {
      this.#verify(fd, target, expected);
      // Verification reads to EOF; use explicit offsets for the write.
      const put = (bytes: Buffer): void => {
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (written <= 0) throw new Error("Checkpoint write made no progress.");
          offset += written;
        }
      };
      started = true;
      try {
        put(desired.bytes!);
        ftruncateSync(fd, desired.bytes!.length);
        fchmodSync(fd, desired.mode);
      } catch {
        // A failed syscall can have changed bytes. We cannot infer a safe
        // postimage, nor overwrite a concurrent writer while compensating.
        throw new MutationFailure("Checkpoint write failed; state is uncertain. Inspect reported paths; no automatic recovery image was captured.", [path]);
      }
    } catch (error) {
      if (started && !(error instanceof MutationFailure)) throw new MutationFailure("Checkpoint write failed; inspect reported paths.", [path]);
      throw error;
    } finally {
      try { closeSync(fd); }
      catch { throw new MutationFailure("Checkpoint descriptor close failed; inspect reported paths.", started ? [path] : []); }
    }
  }
  #apply(entries: Entry[]): void {
    const completed: Entry[] = [];
    try {
      for (const entry of entries) { this.#write(entry.path, entry.before, entry.after); completed.push(entry); }
    } catch (error) {
      const changed = new Set(error instanceof MutationFailure ? error.changedPaths : []);
      for (const entry of completed.reverse()) {
        try { this.#write(entry.path, entry.after, entry.before); }
        catch { changed.add(entry.path); }
      }
      const message = error instanceof Error ? error.message : "Checkpoint operation failed.";
      throw new MutationFailure(changed.size ? `${message} Recovery incomplete; inspect reported paths before continuing.` : message, [...changed]);
    }
  }
  #inspect(mutations: FileMutation[]): Entry[] {
    if (!mutations.length || mutations.length > 32 || new Set(mutations.map((m) => m.path)).size !== mutations.length) throw new Error("Checkpoint requires 1–32 unique file paths.");
    let remaining = MAX_BYTES;
    return mutations.map((mutation): Entry => {
      // Admission precedes allocation and all writes: a successful checkpoint
      // must fit by itself, rather than immediately evicting its own recovery.
      const length = mutation.content === null ? 0 : Buffer.byteLength(mutation.content);
      if (length > MAX_FILE) throw new Error("Checkpoint file limit exceeded (256 KiB).");
      if (length > remaining) throw new Error("Checkpoint aggregate batch image limit exceeded (2 MiB).");
      remaining -= length;
      const snapshot = safeCheckpointIoAvailable ? this.#backend().capture(mutation.path, remaining) : undefined;
      const before = snapshot?.image ?? this.#read(mutation.path, remaining);
      remaining -= before.bytes?.length ?? 0;
      const bytes = mutation.content === null ? null : Buffer.from(mutation.content);
      if (sensitiveContext(mutation.path, before.bytes) || sensitiveContext(mutation.path, bytes)) throw new Error("Checkpoint excludes credential paths, sensitive content and binary files; write refused.");
      if (mutation.expected !== undefined && (before.bytes === null ? null : before.bytes.toString("utf8")) !== mutation.expected) throw new Error("Checkpoint conflict: patch/edit source changed.");
      return { path: mutation.path, snapshot, before, after: { ...before, bytes, mode: bytes === null ? 0 : before.mode || 0o600 } };
    });
  }
  /** Nonmutating preflight, not authorization or a lease against filesystem changes.
   * Inspect the entire batch before deciding that capture is unsupported. Oversize
   * images cannot be safely inspected by this bounded policy and remain rejected.
   */
  classify(mutations: FileMutation[]): CaptureEligibility {
    if (this.#busy) return { kind: "rejected", result: { ok: false, output: "Checkpoint mutation already active." } };
    try {
      this.#inspect(mutations);
      // Structural captures include existing parent directory identities.
      if (!safeCheckpointIoAvailable) return { kind: "unsupported", reason: "platform" };
      return { kind: "covered" };
    } catch (error) {
      return { kind: "rejected", result: { ok: false, output: error instanceof Error ? error.message : "Checkpoint inspection failed." } };
    }
  }
  mutate(mutations: FileMutation[]): ToolResult {
    if (this.#busy) return { ok: false, output: "Checkpoint mutation already active." };
    this.#busy = true;
    try {
      const entries = this.#inspect(mutations);
      if (!safeCheckpointIoAvailable) throw new Error("Checkpoint platform unsupported.");
      const checkpoint: Checkpoint = { id: `cp-${this.#namespace}-${this.#next++}`, entries: [] };
      this.#items.push(checkpoint);
      try {
        if (constants.O_NOFOLLOW && entries.every((entry) => !entry.path.includes("/") && entry.before.bytes !== null && entry.after.bytes !== null)) {
          this.#apply(entries);
          checkpoint.entries = entries;
        } else {
          const receipts = this.#backend().apply(entries.map((entry) => ({ expected: entry.snapshot!, desired: entry.after })));
          checkpoint.entries = receipts.map((receipt) => ({ path: receipt.before.path, before: receipt.before.image, after: receipt.after.image, receipt }));
        }
      } catch (error) {
        if (error instanceof StructuralMutationFailure) {
          checkpoint.entries = error.completed.map((receipt) => ({ path: receipt.before.path, before: receipt.before.image, after: receipt.after.image, receipt }));
          const changedPaths = [...error.completed.map((receipt) => receipt.after.path), ...error.uncertainPaths];
          return { ok: false, output: `${error.message} Completed changes retained in ${checkpoint.id}; uncertain paths: ${safeJson(error.uncertainPaths)}. Inspect before retrying.`, changedPaths };
        }
        // Never adopt a fresh pathname read as our postimage: it may belong
        // entirely to an external writer. Uncertain effects are inspection-only.
        return { ok: false, output: mutationFailureOutput(error, "Checkpoint mutation failed."),
          changedPaths: error instanceof MutationFailure ? error.changedPaths : [] };
      } finally {
        if (!checkpoint.entries.length) this.#items.pop();
        while (this.#items.length > MAX_CHECKPOINTS || this.#size() > MAX_BYTES) this.#items.shift();
      }
      return { ok: true, output: `Checkpoint ${checkpoint.id}: ${entries.length} file(s) changed (session memory only).`, changedPaths: entries.map((entry) => entry.path) };
    } catch (error) { return { ok: false, output: error instanceof Error ? error.message : "Checkpoint mutation failed." }; }
    finally { this.#busy = false; }
  }
  #size(): number { return this.#items.reduce((sum, item) => sum + item.entries.reduce((n, entry) => n + (entry.before.bytes?.length ?? 0) + (entry.after.bytes?.length ?? 0), 0), 0); }
  list(): string { return this.#items.map((item) => `${item.id}: ${item.entries.map((entry) => /^[a-zA-Z0-9_.-]+$/.test(entry.path) ? entry.path : safeJson(redactPath(entry.path))).join(", ")}`).join("\n") || "No checkpoints in this process/session. Shell, MCP and arbitrary EXECUTE effects are not covered."; }
  #select(id: string, path?: string): Entry[] {
    const entries = this.#items.find((item) => item.id === id)?.entries.filter((entry) => path === undefined || entry.path === path);
    if (!entries?.length) throw new Error("Checkpoint or selected path not found in this session.");
    return entries;
  }
  diff(id: string, path?: string, page?: number): string {
    const entries = this.#select(id, path);
    if (page !== undefined) {
      const totalPages = entries.reduce((n, entry) => n + imagePages(entry.before.bytes) + imagePages(entry.after.bytes), 0);
      if (!Number.isSafeInteger(page) || page < 1 || page > totalPages) throw new Error(`Diff page must be an integer from 1 to ${totalPages}.`);
      let index = page - 1;
      for (const entry of entries) for (const side of ["before", "after"] as const) {
        const bytes = entry[side].bytes;
        const count = imagePages(bytes);
        if (index >= count) { index -= count; continue; }
        // Fixed byte windows, rounded forward to a UTF-8 code point boundary.
        // Adjacent windows meet exactly; never split a surrogate or JSON escape.
        const boundary = (offset: number): number => {
          let end = Math.min(offset, bytes?.length ?? 0);
          while (bytes && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
          return end;
        };
        const offset = boundary(index * DIFF_SLICE), end = boundary((index + 1) * DIFF_SLICE);
        const text = bytes?.subarray(offset, end).toString("utf8") ?? null;
        const output = safeJson({ checkpoint: id, page, totalPages, path: entry.path, side,
          offset, end, byteLength: bytes?.length ?? null, text,
          next: page < totalPages ? `/checkpoint diff ${id} --page ${page + 1}${path === undefined ? "" : ` ${JSON.stringify(path)}`}` : null });
        // A slice can begin inside a harmless word and look like a credential
        // to downstream streaming redactors. JSON Unicode escapes preserve the
        // exact text without reinterpreting fragment boundaries as secret keys.
        const encoded = text && /^[A-Za-z0-9]/.test(text)
          ? `"\\u${text.charCodeAt(0).toString(16).padStart(4, "0")}${safeJson(text).slice(2)}`
          : safeJson(text);
        return output.replace(`"text": ${safeJson(text)}`, () => `"text": ${encoded}`);
      }
      throw new Error("Diff page unavailable.");
    }
    // Bound legacy work before decoding: raw text alone cannot fit above this size.
    if (entries.reduce((n, entry) => n + (entry.before.bytes?.length ?? 0) + (entry.after.bytes?.length ?? 0), 0) > 60_000) {
      throw new Error("Diff exceeds display bound (60,000 bytes); use --page 1 before the optional path.");
    }
    const output = safeJson(entries.map((entry) => ({ path: entry.path, before: entry.before.bytes?.toString("utf8") ?? null, after: entry.after.bytes?.toString("utf8") ?? null })));
    if (Buffer.byteLength(output) > 60_000) throw new Error("Diff exceeds display bound (60,000 bytes); use --page 1 before the optional path.");
    return output;
  }
  #entrySnapshot(entry: Entry, side: "before" | "after"): StructuralSnapshot | undefined {
    if (entry.receipt) return entry.receipt[side];
    if (!entry.snapshot) return undefined;
    const image = entry[side];
    if (image.bytes !== null && (image.dev === undefined || image.ino === undefined)) return undefined;
    return { ...entry.snapshot, image: image.bytes === null ? { kind: "absent", bytes: null, mode: 0 }
      : { kind: "present", bytes: image.bytes, mode: image.mode, dev: image.dev!, ino: image.ino!, fileId: image.fileId } };
  }
  #rebindRestored(id: string, selected: Entry[], completed: StructuralReceipt[]): void {
    const topology = (a: StructuralSnapshot, b: StructuralSnapshot): boolean => a.path === b.path
      && a.directories.length === b.directories.length && a.directories.every((directory, i) => {
        const other = b.directories[i]!;
        return directory.path === other.path && directory.dev === other.dev
          && (directory.fileId || other.fileId ? directory.fileId !== undefined && directory.fileId === other.fileId : directory.ino === other.ino);
      });
    const exact = (a: StructuralSnapshot, b: StructuralSnapshot): boolean => topology(a, b)
      && a.image.kind === b.image.kind && a.image.mode === b.image.mode
      && (a.image.kind === "absent" || (b.image.kind === "present"
        && a.image.dev === b.image.dev
        && (a.image.fileId || b.image.fileId ? a.image.fileId !== undefined && a.image.fileId === b.image.fileId : a.image.ino === b.image.ino)
        && a.image.bytes.equals(b.image.bytes)));
    // Only the verified rollback receipt can establish the new identity. Never
    // reread a pathname or equate unrelated generations merely by their bytes.
    const prior = this.#items.slice(0, this.#items.findIndex((item) => item.id === id));
    for (const receipt of completed) {
      const source = selected.find((entry) => {
        const after = this.#entrySnapshot(entry, "after");
        return after && exact(after, receipt.before);
      });
      const old = source && this.#entrySnapshot(source, "before");
      if (!old || !topology(old, receipt.after) || old.image.mode !== receipt.after.image.mode
        || digest(old.image.bytes) !== digest(receipt.after.image.bytes)) continue;
      for (const item of prior) for (const entry of item.entries) {
        for (const side of ["before", "after"] as const) {
          const expected = this.#entrySnapshot(entry, side);
          if (!expected || !exact(expected, old)) continue;
          entry[side] = receipt.after.image;
          if (entry.receipt) entry.receipt = { ...entry.receipt, [side]: receipt.after };
          if (side === "before" && entry.snapshot) entry.snapshot = receipt.after;
        }
      }
    }
  }
  rollback(id: string, path?: string): ToolResult {
    try {
      const entries = this.#select(id, path);
      // Check every selected file before the first mutation, including exclusions and path topology.
      for (const entry of entries) {
        const current = entry.receipt ? this.#backend().capture(entry.path).image : this.#read(entry.path);
        if (!same(current, entry.after)) throw new Error("Checkpoint conflict: file changed since checkpoint; rollback refused.");
        if (sensitiveContext(entry.path, current.bytes) || sensitiveContext(entry.path, entry.before.bytes)) throw new Error("Sensitive checkpoint excluded.");
      }
      try {
        if (entries.every((entry) => entry.receipt)) {
          const completed = this.#backend().apply(reverseStructural(entries.map((entry) => entry.receipt!)));
          this.#rebindRestored(id, entries, completed);
        }
        // Legacy root overwrites retain their model-order prefix compensation
        // contract; only structural receipts require reverse-order rollback.
        else {
          this.#apply(entries.map((entry) => ({ path: entry.path, before: entry.after, after: entry.before })));
          // Successful descriptor overwrites keep the verified expected inode;
          // desired historical images can still name its pre-recreation inode.
          const completed = entries.flatMap((entry): StructuralReceipt[] => {
            const before = this.#entrySnapshot(entry, "after");
            const desired = this.#entrySnapshot(entry, "before");
            if (!before || !desired || before.image.kind !== "present" || desired.image.kind !== "present") return [];
            return [{ before, after: { ...desired, image: { ...desired.image, dev: before.image.dev, ino: before.image.ino } } }];
          });
          this.#rebindRestored(id, entries, completed);
        }
      } catch (error) {
        if (error instanceof StructuralMutationFailure) {
          this.#rebindRestored(id, entries, error.completed);
          const completed = new Set(error.completed.map((receipt) => receipt.after.path));
          const item = this.#items.find((item) => item.id === id)!;
          item.entries = item.entries.filter((entry) => !completed.has(entry.path));
          this.#items = this.#items.filter((item) => item.entries.length);
          return { ok: false, output: `${error.message} Uncertain paths: ${safeJson(error.uncertainPaths)}.`, changedPaths: [...completed, ...error.uncertainPaths] };
        }
        throw error;
      }
      const item = this.#items.find((item) => item.id === id)!;
      item.entries = item.entries.filter((candidate) => !entries.includes(candidate));
      this.#items = this.#items.filter((item) => item.entries.length);
      return { ok: true, output: `Rolled back ${id}: ${entries.length} file(s).`, changedPaths: entries.map((entry) => entry.path) };
    } catch (error) { return { ok: false, output: mutationFailureOutput(error, "Rollback failed."),
      changedPaths: error instanceof MutationFailure ? error.changedPaths : [] }; }
  }
}

export function isCheckpointCommand(content: string): boolean { return /^\/(?:checkpoint|rollback)(?:\s|$)/.test(content.trim()); }
/** Deterministic local command adapter; no provider call or second tool authority. */
export function checkpointCommand(content: string, history: SessionCheckpoints): { model: AgentModel; tools: AgentTool[] } {
  const usage = "Usage: /checkpoint [list|diff <id> [--page <1-based-number>] [path or JSON-quoted path]] or /rollback <id> [path or JSON-quoted path]";
  const match = /^\/(checkpoint|rollback)(?:[ \t]+([\s\S]*))?$/.exec(content.trimStart());
  const rollback = match?.[1] === "rollback";
  let tail = match?.[2] ?? "";
  const token = (): string | undefined => {
    const next = /^(\S+)(?:[ \t]+|$)/.exec(tail);
    if (!next) return undefined;
    tail = tail.slice(next[0].length);
    return next[1];
  };
  const action = token();
  const id = rollback ? action : action === "diff" ? token() : undefined;
  let path: string | undefined, page: number | undefined, invalid = !match || content.length > 4096;
  try {
    if (!rollback && action === "diff" && tail.startsWith("--page")) {
      if (token() !== "--page") throw new Error();
      const value = token();
      if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error();
      page = Number(value);
      if (!Number.isSafeInteger(page)) throw new Error();
    }
    if (tail) {
      if (tail.startsWith('"')) {
        const decoded: unknown = JSON.parse(tail);
        if (typeof decoded !== "string" || !decoded) throw new Error();
        path = decoded;
      } else {
        // Whitespace-bearing names must be quoted; never normalize one name
        // into another or silently interpret unknown flags as path arguments.
        if (/\s/.test(tail) || tail.startsWith("--")) throw new Error();
        path = tail;
      }
    }
    if (!rollback && action !== "diff" && (path !== undefined || (action && action !== "list"))) invalid = true;
  } catch { invalid = true; }
  const tool: AgentTool = {
    name: rollback ? "rollback_checkpoint" : "inspect_checkpoint", operation: rollback ? "WRITE" : "READ",
    description: "Local session checkpoint command.", inputSchema: { type: "object", properties: {} },
    async execute() {
      try {
        if (invalid) return { ok: false, output: usage };
        if (rollback && id) return history.rollback(id, path);
        if (!rollback && (!action || action === "list") && !id) return { ok: true, output: history.list() };
        if (!rollback && action === "diff" && id) {
          try { return { ok: true, output: history.diff(id, path, page) }; }
          catch (error) {
            if (page === undefined && error instanceof Error && error.message.includes("display bound")) return { ok: true, output: history.diff(id, path, 1) };
            throw error;
          }
        }
        return { ok: false, output: usage };
      } catch (error) { return { ok: false, output: error instanceof Error ? error.message : "Checkpoint unavailable." }; }
    },
  };
  let called = false;
  return { tools: [tool], model: { async respond(request) {
    if (called) return { responseId: "local-checkpoint", text: request.toolOutputs[0]?.output ?? "", toolCalls: [] };
    called = true;
    return { responseId: "local-checkpoint", text: "", toolCalls: [{ callId: "local-checkpoint", name: tool.name, arguments: JSON.stringify({ checkpoint: id, selectedPath: path }) }] };
  } } };
}
