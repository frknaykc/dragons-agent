import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\s*[:=]\s*\S+|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b|\bBearer\s+\S+/i;
const MAX_BATCHES = 8;
const MAX_TASKS = 8;
const MAX_RECORD_BYTES = 32_000;
const LOCK_FILE = ".batch.lock";
const MAX_LOCK_BYTES = 256;

export type BatchTaskState = "queued" | "running" | "completed" | "failed" | "interrupted";
export type BatchRunOwner = { pid: number; host: string; token: string };
export type BatchTask = { id: string; prompt: string; state: BatchTaskState; result?: string; owner?: BatchRunOwner };
/** Credential-free queue/checkpoints only: no provider state, approvals, tools or transcript. */
export type BatchRecord = {
  version: 1;
  id: string;
  workingDirectory: string;
  tasks: BatchTask[];
  maxRuns: number;
  runsUsed: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= maximum && !SENSITIVE.test(value);
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateBatchRecord(value: unknown): asserts value is BatchRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid batch record.");
  const batch = value as Record<string, unknown>;
  const keys = ["version", "id", "workingDirectory", "tasks", "maxRuns", "runsUsed", "revision", "createdAt", "updatedAt"];
  if (Object.keys(batch).length !== keys.length || Object.keys(batch).some((key) => !keys.includes(key))
    || batch.version !== 1 || typeof batch.id !== "string" || !ID.test(batch.id)
    || typeof batch.workingDirectory !== "string" || !batch.workingDirectory.trim() || batch.workingDirectory.length > 4_096
    || !Array.isArray(batch.tasks) || batch.tasks.length < 1 || batch.tasks.length > MAX_TASKS
    || !Number.isSafeInteger(batch.maxRuns) || (batch.maxRuns as number) < 1 || (batch.maxRuns as number) > batch.tasks.length
    || !Number.isSafeInteger(batch.runsUsed) || (batch.runsUsed as number) < 0 || (batch.runsUsed as number) > (batch.maxRuns as number)
    || !Number.isSafeInteger(batch.revision) || (batch.revision as number) < 0
    || !validTime(batch.createdAt) || !validTime(batch.updatedAt) || Date.parse(batch.updatedAt) < Date.parse(batch.createdAt)) throw new Error("Invalid batch record.");
  const ids = new Set<string>();
  let started = 0;
  let running = 0;
  let stopped = false;
  for (const value of batch.tasks) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid batch task.");
    const task = value as Record<string, unknown>;
    const fields = task.state === "completed" ? ["id", "prompt", "state", "result"]
      : task.state === "running" && task.owner !== undefined ? ["id", "prompt", "state", "owner"] : ["id", "prompt", "state"];
    if (Object.keys(task).length !== fields.length || Object.keys(task).some((key) => !fields.includes(key))
      || typeof task.id !== "string" || !ID.test(task.id) || ids.has(task.id)
      || !validText(task.prompt, 1_000) || !["queued", "running", "completed", "failed", "interrupted"].includes(task.state as string)
      || (task.state === "completed" && !validText(task.result, 2_000))) throw new Error("Invalid batch task.");
    if (task.owner !== undefined && !validBatchOwner(task.owner)) throw new Error("Invalid batch owner.");
    ids.add(task.id);
    if (task.state !== "queued") {
      if (stopped) throw new Error("Invalid batch task order.");
      started++;
      if (task.state === "running") running++;
      if (task.state === "failed" || task.state === "interrupted") stopped = true;
    } else stopped = true;
  }
  if (running > 1 || started !== batch.runsUsed || (running && batch.tasks.some((task: BatchTask) => task.state === "failed" || task.state === "interrupted"))) throw new Error("Invalid batch budget.");
}

function validBatchOwner(value: unknown): value is BatchRunOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return Object.keys(owner).sort().join(",") === "host,pid,token"
    && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0
    && typeof owner.host === "string" && !!owner.host && owner.host.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(owner.host)
    && typeof owner.token === "string" && ID.test(owner.token);
}

/** The caller supplies its profile-owned root and canonical workspace. */
export function batchWorkspaceDirectory(profileBatchRoot: string, canonicalWorkspace: string): string {
  return join(profileBatchRoot, createHash("sha256").update(canonicalWorkspace).digest("hex"));
}

async function ready(directory: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe batch directory.");
    return true;
  } catch (error: unknown) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export type BatchLockIdentity = { pid: number; host: string; token: string };

/** Inspect an app-owned lock without removing it. Never display the token to users. */
export async function inspectBatchLock(directory: string): Promise<BatchLockIdentity | undefined> {
  if (!await ready(directory, false)) return undefined;
  const path = join(directory, LOCK_FILE);
  let named;
  try { named = await lstat(path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > MAX_LOCK_BYTES)
    throw new Error("Unsafe batch lock.");
  const handle = await open(path, "r");
  let value: unknown;
  try {
    const opened = await handle.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size !== named.size)
      throw new Error("Batch lock changed during inspection.");
    const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const current = await handle.stat();
    if (bytesRead !== named.size || current.size !== named.size || current.mtimeMs !== named.mtimeMs || current.ctimeMs !== named.ctimeMs)
      throw new Error("Batch lock changed during inspection.");
    try { value = JSON.parse(bytes.toString("utf8", 0, bytesRead)) as unknown; }
    catch { throw new Error("Invalid batch lock."); }
  } finally { await handle.close(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid batch lock.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "host,pid,token"
    || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1
    || typeof record.host !== "string" || !record.host || record.host.length > 255 || /[\u0000-\u001f\u007f]/u.test(record.host)
    || typeof record.token !== "string" || !ID.test(record.token)) throw new Error("Invalid batch lock.");
  return { pid: record.pid as number, host: record.host, token: record.token };
}

/** Explicit operator action; elapsed time cannot prove a process is gone. */
export async function recoverAbandonedBatchLock(directory: string, expectedToken: string): Promise<boolean> {
  if (!ID.test(expectedToken) || !await ready(directory, false)) return false;
  const path = join(directory, LOCK_FILE);
  let named;
  try { named = await lstat(path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > MAX_LOCK_BYTES)
    throw new Error("Unsafe batch lock.");
  const record = await inspectBatchLock(directory);
  if (!record || record.token !== expectedToken) throw new Error("Batch lock changed during recovery.");
  if (record.host !== hostname()) throw new Error("Batch lock belongs to another host.");
  try { process.kill(record.pid, 0); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Batch lock owner cannot be verified as stopped.");
    let current;
    try { current = await lstat(path); }
    catch { throw new Error("Batch lock changed during recovery."); }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== named.dev || current.ino !== named.ino
      || current.size !== named.size || current.mtimeMs !== named.mtimeMs || current.ctimeMs !== named.ctimeMs)
      throw new Error("Batch lock changed during recovery.");
    await rm(path);
    return true;
  }
  throw new Error("Batch lock owner is still active.");
}

async function readRecord(path: string): Promise<BatchRecord | undefined> {
  let handle;
  try {
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_RECORD_BYTES) throw new Error("Unsafe batch record.");
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size > MAX_RECORD_BYTES) throw new Error("Unsafe batch record.");
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_RECORD_BYTES) throw new Error("Unsafe batch record.");
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Unsafe batch record.");
    const batch: unknown = JSON.parse(bytes.toString("utf8", 0, size));
    validateBatchRecord(batch);
    return batch;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

export function createFileBatchQueue(directory: string, canonicalWorkspace: string) {
  if (typeof canonicalWorkspace !== "string" || !canonicalWorkspace.trim() || canonicalWorkspace.length > 4_096) throw new Error("Invalid batch workspace.");
  async function load(id: string): Promise<BatchRecord | undefined> {
    if (!ID.test(id) || !await ready(directory, false)) return undefined;
    const batch = await readRecord(join(directory, `${id}.json`));
    if (batch && (batch.id !== id || batch.workingDirectory !== canonicalWorkspace)) throw new Error("Batch workspace or identity mismatch.");
    return batch;
  }
  async function list(): Promise<BatchRecord[]> {
    if (!await ready(directory, false)) return [];
    const names = (await readdir(directory)).filter((name) => ID.test(name.slice(0, -5)) && name.endsWith(".json"));
    if (names.length > MAX_BATCHES) throw new Error("Batch storage limit exceeded.");
    const entries: BatchRecord[] = [];
    for (const name of names) {
      const batch = await load(name.slice(0, -5));
      if (!batch) throw new Error("Batch changed during listing.");
      entries.push(batch);
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }
  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    await ready(directory, true);
    const path = join(directory, LOCK_FILE);
    let lock;
    try { lock = await open(path, "wx", 0o600); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Batch storage is busy; recover an abandoned lock explicitly.");
      throw error;
    }
    const identity = await lock.stat();
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }));
      return await operation();
    } finally {
      await lock.close();
      try {
        const current = await lstat(path);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await rm(path);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  async function save(batch: BatchRecord, expected?: number): Promise<BatchRecord> {
    validateBatchRecord(batch);
    if (batch.workingDirectory !== canonicalWorkspace) throw new Error("Batch workspace mismatch.");
    return locked(async () => {
      const current = await load(batch.id);
      if (current ? current.revision !== expected : expected !== undefined) throw new Error("Batch changed before save.");
      if (!current && (await list()).length >= MAX_BATCHES) throw new Error("Batch storage limit reached.");
      const next = { ...structuredClone(batch), revision: current ? current.revision + 1 : 0 };
      const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
      if (bytes.length > MAX_RECORD_BYTES) throw new Error("Batch record too large.");
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, join(directory, `${batch.id}.json`));
      } finally { await rm(temporary, { force: true }); }
      return next;
    });
  }
  return {
    load, list,
    async create(prompts: readonly string[], maxRuns: number): Promise<BatchRecord> {
      if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > MAX_TASKS || prompts.some((prompt) => !validText(prompt, 1_000))) throw new Error("Invalid batch tasks or prompt.");
      if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > prompts.length) throw new Error("Invalid batch run budget.");
      const now = new Date().toISOString();
      return save({ version: 1, id: randomUUID(), workingDirectory: canonicalWorkspace,
        tasks: prompts.map((prompt) => ({ id: randomUUID(), prompt, state: "queued" })), maxRuns, runsUsed: 0, revision: 0,
        createdAt: now, updatedAt: now });
    },
    async reserve(id: string, expected: number): Promise<BatchRecord | undefined> {
      const batch = await load(id);
      if (!batch || batch.revision !== expected) throw new Error("Batch changed before reservation.");
      if (batch.runsUsed >= batch.maxRuns || batch.tasks.some((task) => task.state === "running" || task.state === "failed" || task.state === "interrupted")) return undefined;
      const index = batch.tasks.findIndex((task) => task.state === "queued");
      if (index < 0) return undefined;
      const next = structuredClone(batch);
      next.tasks[index]!.state = "running";
      next.tasks[index]!.owner = { pid: process.pid, host: hostname(), token: randomUUID() };
      next.runsUsed++;
      next.updatedAt = new Date().toISOString();
      return save(next, expected);
    },
    async finish(id: string, taskId: string, expected: number, state: "completed" | "failed" | "interrupted", result?: string, ownerToken?: string): Promise<BatchRecord> {
      const batch = await load(id);
      if (!batch || batch.revision !== expected) throw new Error("Batch changed before finish.");
      const task = batch.tasks.find((entry) => entry.id === taskId);
      if (!task || task.state !== "running") throw new Error("Batch task is not running.");
      if (task.owner && task.owner.token !== ownerToken) throw new Error("Batch reservation owner mismatch.");
      if (state === "completed" ? !validText(result, 2_000) : result !== undefined) throw new Error("Invalid batch result.");
      const next = structuredClone(batch);
      const target = next.tasks.find((entry) => entry.id === taskId)!;
      target.state = state;
      delete target.owner;
      if (state === "completed") target.result = result;
      next.updatedAt = new Date().toISOString();
      return save(next, expected);
    },
    /** Explicit operator decision after inspecting an orphaned reservation; never resume a model. */
    async recover(id: string, taskId: string, expected: number, ownerToken: string): Promise<BatchRecord> {
      const batch = await load(id);
      if (!batch || batch.revision !== expected) throw new Error("Batch changed before recovery.");
      const task = batch.tasks.find((entry) => entry.id === taskId);
      if (!task || task.state !== "running" || !task.owner || task.owner.token !== ownerToken)
        throw new Error("Batch reservation owner changed or cannot be verified.");
      if (task.owner.host !== hostname()) throw new Error("Batch reservation belongs to another host.");
      try { process.kill(task.owner.pid, 0); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Batch reservation owner cannot be verified as stopped.");
        const next = structuredClone(batch);
        const target = next.tasks.find((entry) => entry.id === taskId)!;
        target.state = "interrupted";
        delete target.owner;
        next.updatedAt = new Date().toISOString();
        return save(next, expected);
      }
      throw new Error("Batch reservation owner is still active.");
    },
  };
}
