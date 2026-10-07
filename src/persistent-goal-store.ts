import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { GOAL_ID, type PersistentGoal, type PersistentGoalStore, validatePersistentGoal } from "./persistent-goals.js";

const MAX_RECORD_BYTES = 16_000;
const DEFAULT_MAX_GOALS = 128;
const LOCK_FILE = ".persistent-goals.lock";
const MAX_LOCK_BYTES = 256;

/** Call with an app-owned profile root and canonical workspace; no cross-workspace goal scan. */
export function goalWorkspaceDirectory(profileGoalRoot: string, canonicalWorkspace: string): string {
  return join(profileGoalRoot, createHash("sha256").update(canonicalWorkspace).digest("hex"));
}

async function directoryReady(directory: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Persistent goal directory must be a real directory.");
    return true;
  } catch (error: unknown) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRecord(path: string): Promise<PersistentGoal | undefined> {
  let handle;
  try {
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_RECORD_BYTES) throw new Error("Unsafe persistent goal file.");
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size > MAX_RECORD_BYTES) throw new Error("Unsafe persistent goal file.");
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_RECORD_BYTES) throw new Error("Oversized persistent goal file.");
    const value = JSON.parse(bytes.toString("utf8", 0, length)) as unknown;
    validatePersistentGoal(value);
    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

export type PersistentGoalLockIdentity = { pid: number; host: string; token: string };

/** Inspect without removing a lock. The token is for the host's same-lock comparison;
 * never render or log it in the user-facing recovery prompt.
 */
export async function inspectPersistentGoalLock(directory: string): Promise<PersistentGoalLockIdentity | undefined> {
  if (!await directoryReady(directory, false)) return undefined;
  const path = join(directory, LOCK_FILE);
  let named;
  try { named = await lstat(path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_LOCK_BYTES)
    throw new Error("Unsafe persistent goal lock.");
  const handle = await open(path, "r");
  let lock: unknown;
  try {
    const opened = await handle.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size > MAX_LOCK_BYTES)
      throw new Error("Persistent goal lock changed during recovery.");
    const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== named.size) throw new Error("Persistent goal lock changed during recovery.");
    try { lock = JSON.parse(bytes.toString("utf8", 0, bytesRead)) as unknown; }
    catch { throw new Error("Invalid persistent goal lock."); }
  } finally { await handle.close(); }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) throw new Error("Invalid persistent goal lock.");
  const record = lock as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || typeof record.token !== "string"
    || !GOAL_ID.test(record.token) || typeof record.host !== "string" || !record.host)
    throw new Error("Invalid persistent goal lock.");
  return { pid: record.pid as number, host: record.host, token: record.token };
}

/** Explicit trusted-host recovery only. Age never proves abandonment; the original
 * process must be confirmed absent on this host. Legacy locks lack host identity.
 */
export async function recoverAbandonedPersistentGoalLock(directory: string, expectedToken: string): Promise<boolean> {
  if (!await directoryReady(directory, false)) return false;
  const path = join(directory, LOCK_FILE);
  let named;
  try { named = await lstat(path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_LOCK_BYTES)
    throw new Error("Unsafe persistent goal lock.");
  const record = await inspectPersistentGoalLock(directory);
  if (!record) return false;
  if (record.token !== expectedToken) throw new Error("Persistent goal lock token changed.");
  if (record.host !== hostname()) throw new Error("Persistent goal lock belongs to another host.");
  try { process.kill(record.pid as number, 0); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Persistent goal lock owner cannot be verified as stopped.");
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== named.dev || current.ino !== named.ino
      || current.size !== named.size || current.mtimeMs !== named.mtimeMs || current.ctimeMs !== named.ctimeMs)
      throw new Error("Persistent goal lock changed during recovery.");
    await rm(path);
    return true;
  }
  throw new Error("Persistent goal lock owner is still active.");
}

/** App-owned store with atomic revisions; an abandoned lock requires explicit operator recovery. */
export function createFilePersistentGoalStore(directory: string, options: { maxGoals?: number } = {}): PersistentGoalStore {
  const maxGoals = options.maxGoals ?? DEFAULT_MAX_GOALS;
  if (!Number.isSafeInteger(maxGoals) || maxGoals < 1 || maxGoals > DEFAULT_MAX_GOALS) throw new Error("Invalid persistent goal storage limit.");

  async function list(): Promise<PersistentGoal[]> {
    if (!await directoryReady(directory, false)) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const names = entries.filter((entry) => entry.name.endsWith(".json") && GOAL_ID.test(entry.name.slice(0, -5)));
    if (names.length > maxGoals) throw new Error("Persistent goal storage limit exceeded.");
    const goals: PersistentGoal[] = [];
    for (const entry of names) {
      if (!entry.isFile()) continue;
      try {
        const goal = await readRecord(join(directory, entry.name));
        if (goal && `${goal.id}.json` === entry.name) goals.push(goal);
      } catch { /* Corrupt entries are never activated. */ }
    }
    return goals.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function load(id: string): Promise<PersistentGoal | undefined> {
    if (!GOAL_ID.test(id) || !await directoryReady(directory, false)) return undefined;
    const goal = await readRecord(join(directory, `${id}.json`));
    if (goal && goal.id !== id) throw new Error("Invalid persistent goal identity.");
    return goal;
  }

  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    await directoryReady(directory, true);
    const lockPath = join(directory, LOCK_FILE);
    const busy = "Persistent goal storage is busy; recover an abandoned lock explicitly.";
    // On Windows, exclusive open can follow a dangling link instead of reporting EEXIST.
    // Check the directory entry itself before opening; never interpret ENOENT via stat().
    try { await lstat(lockPath); throw new Error(busy); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(busy);
      throw error;
    }
    let identity: Awaited<ReturnType<typeof lock.stat>> | undefined;
    try {
      identity = await lock.stat();
      const named = await lstat(lockPath);
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== identity.dev || named.ino !== identity.ino)
        throw new Error(busy);
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }));
      return await operation();
    } finally {
      await lock.close();
      try {
        const current = await lstat(lockPath);
        if (identity && current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await rm(lockPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  return {
    list, load,
    async save(goal, expectedRevision) {
      validatePersistentGoal(goal);
      return locked(async () => {
        const path = join(directory, `${goal.id}.json`);
        const existing = await load(goal.id);
        if (existing ? expectedRevision !== existing.revision : expectedRevision !== undefined) throw new Error("Persistent goal changed before save.");
        if (!existing && (await list()).length >= maxGoals) throw new Error("Persistent goal storage limit reached.");
        const next: PersistentGoal = { ...structuredClone(goal), revision: existing ? existing.revision + 1 : 0 };
        const temporary = join(directory, `${randomUUID()}.tmp`);
        try {
          const serialized = `${JSON.stringify(next)}\n`;
          if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error("Persistent goal record is too large.");
          await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
        return next;
      });
    },
  };
}
