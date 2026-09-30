import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type CronTask, type CronTaskStore, validateCronTask } from "./cron-scheduler.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 12_000;
const MAX_RECORDS = 128;

/** Call with a canonical workspace path; isolates multiple workspaces within the active profile. */
export function cronWorkspaceDirectory(profileCronRoot: string, canonicalWorkspace: string): string {
  return join(profileCronRoot, createHash("sha256").update(canonicalWorkspace).digest("hex"));
}

async function directoryReady(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Cron task directory must be a real directory.");
    return true;
  } catch (error: unknown) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRecord(path: string): Promise<CronTask | undefined> {
  let handle;
  try {
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_RECORD_BYTES) throw new Error("Unsafe cron task file.");
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size > MAX_RECORD_BYTES) throw new Error("Cron task file changed during read.");
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    validateCronTask(value);
    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

/** App-owned, single-writer storage. A leftover lock after a crash requires explicit operator recovery. */
export function createFileCronTaskStore(directory: string): CronTaskStore {
  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    await directoryReady(directory, true);
    const lockPath = join(directory, ".cron-store.lock");
    try {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: randomUUID() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Cron task storage is busy; an abandoned lock needs manual recovery.");
      throw error;
    }
    try { return await operation(); }
    finally { await rm(lockPath, { force: true }); }
  }

  async function load(id: string): Promise<CronTask | undefined> {
    if (!ID.test(id) || !await directoryReady(directory, false)) return undefined;
    return readRecord(join(directory, `${id}.json`));
  }

  async function list(): Promise<CronTask[]> {
    if (!await directoryReady(directory, false)) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const names = entries.filter((entry) => entry.name.endsWith(".json") && ID.test(entry.name.slice(0, -5)));
    if (names.length > MAX_RECORDS) throw new Error("Cron task storage limit exceeded.");
    const tasks: CronTask[] = [];
    for (const entry of names) {
      if (!entry.isFile()) continue;
      try {
        const task = await readRecord(join(directory, entry.name));
        if (task && `${task.id}.json` === entry.name) tasks.push(task);
      } catch { /* Corrupt or unsafe entries are never activated. */ }
    }
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    list, load,
    async save(task, expectedRevision) {
      validateCronTask(task);
      return locked(async () => {
        const path = join(directory, `${task.id}.json`);
        const existing = await load(task.id);
        if (existing ? expectedRevision !== existing.revision : expectedRevision !== undefined) throw new Error("Cron task changed before save.");
        if (!existing && (await list()).length >= MAX_RECORDS) throw new Error("Cron task storage limit reached.");
        const next: CronTask = { ...structuredClone(task), revision: existing ? existing.revision + 1 : 0 };
        const temporary = join(directory, `${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
          await chmod(temporary, 0o600);
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
        return next;
      });
    },
    async delete(id, expectedRevision) {
      if (!ID.test(id)) return false;
      return locked(async () => {
        const existing = await load(id);
        if (!existing || existing.revision !== expectedRevision) return false;
        await rm(join(directory, `${id}.json`));
        return true;
      });
    },
  };
}
