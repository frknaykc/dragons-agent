import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

import { isSafeProfileName, type DragonsProfileStore } from "./profiles.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TASKS = 128;
const MAX_DEPENDENCIES = 16;
const MAX_BOARD_BYTES = 128_000;
const BOARD_FILE = "board.json";
const LOCK_FILE = ".kanban.lock";
const MAX_LOCK_BYTES = 512;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type KanbanStatus = "todo" | "doing" | "blocked" | "done";
export type KanbanTask = {
  id: string;
  title: string;
  createdBy: string;
  assignee: string;
  dependsOn: string[];
  status: KanbanStatus;
  progress: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** An explicit, unaccepted transfer request; legacy board records omit this field. */
  handoffTo?: string;
  /** Public metadata only; the claim credential is never returned in board views. */
  worker?: { profile: string; host: string; pid: number };
};

type StoredTask = Omit<KanbanTask, "worker"> & {
  workerClaim?: { profile: string; host: string; pid: number; digest: string };
};

export type KanbanBoard = {
  list(actor: string): Promise<KanbanTask[]>;
  get(actor: string, id: string): Promise<KanbanTask | undefined>;
  create(actor: string, title: string, assignee: string, dependsOn: string[]): Promise<KanbanTask>;
  assign(actor: string, id: string, expectedRevision: number, assignee: string): Promise<KanbanTask>;
  addDependency(actor: string, id: string, expectedRevision: number, dependencyId: string): Promise<KanbanTask>;
  updateProgress(actor: string, id: string, expectedRevision: number, status: KanbanStatus, progress: number): Promise<KanbanTask>;
  offerHandoff(actor: string, id: string, expectedRevision: number, target: string): Promise<KanbanTask>;
  acceptHandoff(actor: string, id: string, expectedRevision: number): Promise<KanbanTask>;
  cancelHandoff(actor: string, id: string, expectedRevision: number): Promise<KanbanTask>;
  /** Trusted worker process only. This reserves metadata, not tool authorization or execution. */
  claimWorker(actor: string, id: string, expectedRevision: number): Promise<{ task: KanbanTask; token: string }>;
  finishWorker(actor: string, id: string, expectedRevision: number, token: string): Promise<KanbanTask>;
  releaseWorker(actor: string, id: string, expectedRevision: number, token: string): Promise<KanbanTask>;
  /** Explicit local recovery only; never resumes execution or authorizes tools. */
  recoverWorker(actor: string, id: string, expectedRevision: number, expectedPid: number): Promise<KanbanTask>;
};

/** Use the base config path (not the active profile's config path) and a canonical workspace. */
export function kanbanWorkspaceDirectory(baseConfigPath: string, canonicalWorkspace: string): string {
  return join(dirname(baseConfigPath), "kanban", createHash("sha256").update(canonicalWorkspace).digest("hex"));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateBoard(value: unknown): asserts value is { version: 1; tasks: StoredTask[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Kanban board.");
  const board = value as Record<string, unknown>;
  if (Object.keys(board).sort().join(",") !== "tasks,version" || board.version !== 1
    || !Array.isArray(board.tasks) || board.tasks.length > MAX_TASKS) throw new Error("Invalid Kanban board.");
  const byId = new Map<string, StoredTask>();
  for (const raw of board.tasks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Kanban task.");
    const task = raw as StoredTask;
    const keys = Object.keys(task).sort().join(",");
    if (keys !== "assignee,createdAt,createdBy,dependsOn,id,progress,revision,status,title,updatedAt"
      && keys !== "assignee,createdAt,createdBy,dependsOn,handoffTo,id,progress,revision,status,title,updatedAt"
      && keys !== "assignee,createdAt,createdBy,dependsOn,id,progress,revision,status,title,updatedAt,workerClaim")
      throw new Error("Invalid Kanban task.");
    const claim = task.workerClaim;
    if (claim !== undefined && (!claim || typeof claim !== "object" || Array.isArray(claim)
      || Object.keys(claim).sort().join(",") !== "digest,host,pid,profile"
      || typeof claim.profile !== "string" || !isSafeProfileName(claim.profile) || claim.profile !== task.assignee
      || typeof claim.host !== "string" || !claim.host || claim.host.length > 255 || CONTROL_CHARACTER.test(claim.host)
      || !Number.isSafeInteger(claim.pid) || claim.pid < 1
      || typeof claim.digest !== "string" || !/^[0-9a-f]{64}$/.test(claim.digest)
      || task.status !== "doing" || task.progress !== 0)) throw new Error("Invalid Kanban task.");
    if ((task.handoffTo !== undefined && (!isSafeProfileName(task.handoffTo) || task.handoffTo === task.assignee
      || task.status !== "todo" || task.progress !== 0))
      || typeof task.id !== "string" || !ID.test(task.id)
      || typeof task.title !== "string" || !task.title.trim() || CONTROL_CHARACTER.test(task.title)
      || Buffer.byteLength(task.title, "utf8") > 240
      || typeof task.createdBy !== "string" || !isSafeProfileName(task.createdBy)
      || typeof task.assignee !== "string" || !isSafeProfileName(task.assignee)
      || !Array.isArray(task.dependsOn) || task.dependsOn.length > MAX_DEPENDENCIES
      || task.dependsOn.some((id) => typeof id !== "string" || !ID.test(id))
      || new Set(task.dependsOn).size !== task.dependsOn.length
      || !["todo", "doing", "blocked", "done"].includes(task.status)
      || !Number.isSafeInteger(task.progress) || task.progress < 0 || task.progress > 100
      || (task.status === "done" ? task.progress !== 100 : task.progress === 100)
      || !Number.isSafeInteger(task.revision) || task.revision < 0
      || !validTimestamp(task.createdAt) || !validTimestamp(task.updatedAt) || task.updatedAt < task.createdAt
      || byId.has(task.id)) throw new Error("Invalid Kanban task.");
    byId.set(task.id, task);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const walk = (id: string): void => {
    if (visiting.has(id)) throw new Error("Kanban dependency cycle.");
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error("Invalid Kanban dependency.");
    visiting.add(id);
    for (const dependency of task.dependsOn) walk(dependency);
    visiting.delete(id);
    visited.add(id);
    if ((task.status === "doing" || task.status === "done")
      && task.dependsOn.some((dependency) => byId.get(dependency)?.status !== "done"))
      throw new Error("Kanban dependencies are not done.");
  };
  for (const id of byId.keys()) walk(id);
}

async function directoryReady(directory: string, create: boolean): Promise<boolean> {
  const root = dirname(directory);
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const parent = await lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe Kanban directory.");
  } catch (error: unknown) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe Kanban directory.");
    return true;
  } catch (error: unknown) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export type KanbanLockIdentity = { pid: number; host: string; token: string };

/** Inspect an app-owned lock without removing it. Never print its token in a user-facing prompt. */
export async function inspectKanbanLock(directory: string): Promise<KanbanLockIdentity | undefined> {
  if (!await directoryReady(directory, false)) return undefined;
  const path = join(directory, LOCK_FILE);
  let named;
  try { named = await lstat(path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_LOCK_BYTES)
    throw new Error("Unsafe Kanban lock.");
  const handle = await open(path, "r");
  let lock: unknown;
  try {
    const opened = await handle.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size !== named.size)
      throw new Error("Kanban lock changed during inspection.");
    const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const current = await handle.stat();
    if (bytesRead !== named.size || current.size !== named.size || current.mtimeMs !== named.mtimeMs || current.ctimeMs !== named.ctimeMs)
      throw new Error("Kanban lock changed during inspection.");
    try { lock = JSON.parse(bytes.toString("utf8", 0, bytesRead)) as unknown; }
    catch { throw new Error("Invalid Kanban lock."); }
  } finally { await handle.close(); }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) throw new Error("Invalid Kanban lock.");
  const record = lock as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "host,pid,token" || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1
    || typeof record.host !== "string" || !record.host || record.host.length > 255 || CONTROL_CHARACTER.test(record.host)
    || typeof record.token !== "string" || !ID.test(record.token)) throw new Error("Invalid Kanban lock.");
  return { pid: record.pid as number, host: record.host, token: record.token };
}

/** Explicit local operator action only: an old lock is not proof its owner has stopped. */
export async function recoverAbandonedKanbanLock(directory: string, expectedToken: string): Promise<boolean> {
  if (!await directoryReady(directory, false)) return false;
  const path = join(directory, LOCK_FILE);
  let named;
  try { named = await lstat(path); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_LOCK_BYTES)
    throw new Error("Unsafe Kanban lock.");
  const record = await inspectKanbanLock(directory);
  if (!record) throw new Error("Kanban lock changed during recovery.");
  if (record.token !== expectedToken) throw new Error("Kanban lock token changed.");
  if (record.host !== hostname()) throw new Error("Kanban lock belongs to another host.");
  try { process.kill(record.pid, 0); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Kanban lock owner cannot be verified as stopped.");
    let current;
    try { current = await lstat(path); }
    catch { throw new Error("Kanban lock changed during recovery."); }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== named.dev || current.ino !== named.ino
      || current.size !== named.size || current.mtimeMs !== named.mtimeMs || current.ctimeMs !== named.ctimeMs)
      throw new Error("Kanban lock changed during recovery.");
    await rm(path);
    return true;
  }
  throw new Error("Kanban lock owner is still active.");
}

/** Shared, data-only board. The trusted host supplies the active actor; tasks never run tools. */
export function createFileKanbanBoard(directory: string, profiles: DragonsProfileStore): KanbanBoard {
  const boardPath = join(directory, BOARD_FILE);
  const lockPath = join(directory, LOCK_FILE);

  async function readBoard(): Promise<{ version: 1; tasks: StoredTask[] }> {
    if (!await directoryReady(directory, false)) return { version: 1, tasks: [] };
    let named;
    try { named = await lstat(boardPath); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: [] };
      throw error;
    }
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_BOARD_BYTES)
      throw new Error("Unsafe Kanban board file.");
    const handle = await open(boardPath, "r");
    try {
      const opened = await handle.stat();
      if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size !== named.size)
        throw new Error("Kanban board changed during read.");
      const bytes = Buffer.alloc(MAX_BOARD_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BOARD_BYTES || length !== named.size) throw new Error("Kanban board changed during read.");
      const current = await handle.stat();
      if (current.size !== named.size || current.mtimeMs !== named.mtimeMs || current.ctimeMs !== named.ctimeMs)
        throw new Error("Kanban board changed during read.");
      let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8", 0, length)) as unknown; }
      catch { throw new Error("Invalid Kanban board."); }
      validateBoard(value);
      return value;
    } finally { await handle.close(); }
  }

  async function requireProfile(name: string): Promise<void> {
    if (!isSafeProfileName(name) || !(await profiles.list()).includes(name)) throw new Error("Kanban profile does not exist.");
  }

  function view(task: StoredTask): KanbanTask {
    const { workerClaim, ...metadata } = task;
    return { ...structuredClone(metadata), ...(workerClaim ? { worker: {
      profile: workerClaim.profile, host: workerClaim.host, pid: workerClaim.pid,
    } } : {}) };
  }

  async function mutate(operation: (tasks: StoredTask[]) => StoredTask): Promise<KanbanTask> {
    await directoryReady(directory, true);
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Kanban board is busy; recover an abandoned lock explicitly.");
      throw error;
    }
    let identity: Awaited<ReturnType<typeof lock.stat>> | undefined;
    try {
      identity = await lock.stat();
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }));
      const board = await readBoard();
      const changed = operation(board.tasks);
      validateBoard(board);
      const content = `${JSON.stringify(board)}\n`;
      if (Buffer.byteLength(content) > MAX_BOARD_BYTES) throw new Error("Kanban board is too large.");
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(content); }
        finally { await file.close(); }
        await rename(temporary, boardPath);
      } finally { await rm(temporary, { force: true }); }
      return view(changed);
    } finally {
      await lock.close();
      if (identity) {
        try {
          const current = await lstat(lockPath);
          if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino)
            await rm(lockPath);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }

  function find(tasks: StoredTask[], id: string, revision: number): StoredTask {
    const task = tasks.find((entry) => entry.id === id);
    if (!task) throw new Error("Kanban task does not exist.");
    if (task.revision !== revision) throw new Error("Kanban task revision changed.");
    return task;
  }

  function ownedClaim(task: StoredTask, actor: string, token: string): void {
    const claim = task.workerClaim;
    if (!claim || claim.profile !== actor || claim.host !== hostname() || claim.pid !== process.pid
      || typeof token !== "string" || !ID.test(token)
      || !timingSafeEqual(Buffer.from(claim.digest, "hex"), Buffer.from(createHash("sha256").update(token).digest("hex"), "hex")))
      throw new Error("Invalid or stale Kanban worker claim.");
  }

  return {
    async list(actor) {
      await requireProfile(actor);
      return (await readBoard()).tasks.map(view);
    },
    async get(actor, id) {
      await requireProfile(actor);
      if (!ID.test(id)) return undefined;
      const task = (await readBoard()).tasks.find((entry) => entry.id === id);
      return task ? view(task) : undefined;
    },
    async create(actor, title, assignee, dependsOn) {
      await requireProfile(actor);
      await requireProfile(assignee);
      if (typeof title !== "string" || !title.trim() || CONTROL_CHARACTER.test(title)
        || Buffer.byteLength(title, "utf8") > 240)
        throw new Error("Invalid Kanban title.");
      if (!Array.isArray(dependsOn) || dependsOn.length > MAX_DEPENDENCIES) throw new Error("Invalid Kanban dependencies.");
      return mutate((tasks) => {
        if (tasks.length >= MAX_TASKS) throw new Error("Kanban board task limit reached.");
        const timestamp = new Date().toISOString();
        const task: StoredTask = { id: randomUUID(), title, createdBy: actor, assignee,
          dependsOn: [...dependsOn], status: "todo", progress: 0, revision: 0, createdAt: timestamp, updatedAt: timestamp };
        tasks.push(task);
        return task;
      });
    },
    async assign(actor, id, expectedRevision, assignee) {
      await requireProfile(actor);
      await requireProfile(assignee);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (task.createdBy !== actor) throw new Error("Only the task creator can change its assignee.");
        if (task.status === "done") throw new Error("A done Kanban task cannot be reassigned.");
        if (task.status !== "todo" || task.progress !== 0)
          throw new Error("Only an idle Kanban task can be reassigned.");
        task.assignee = assignee;
        delete task.handoffTo;
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async addDependency(actor, id, expectedRevision, dependencyId) {
      await requireProfile(actor);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (task.createdBy !== actor) throw new Error("Only the task creator can change dependencies.");
        if (task.handoffTo) throw new Error("Cancel the pending Kanban handoff before changing dependencies.");
        if (task.status === "done" || task.status === "doing") throw new Error("Cannot add dependencies to an active or done task.");
        if (!tasks.some((entry) => entry.id === dependencyId)) throw new Error("Kanban dependency does not exist.");
        task.dependsOn.push(dependencyId);
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async updateProgress(actor, id, expectedRevision, status, progress) {
      await requireProfile(actor);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (task.assignee !== actor) throw new Error("Only the task assignee can update progress.");
        if (task.workerClaim) throw new Error("An active worker claim owns Kanban progress.");
        if (task.handoffTo) throw new Error("Cancel the pending Kanban handoff before updating progress.");
        if (task.status === "done") throw new Error("A done Kanban task cannot be reopened.");
        if (status === "done" && progress !== 100) throw new Error("Done Kanban tasks require 100 percent progress.");
        task.status = status;
        task.progress = progress;
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async offerHandoff(actor, id, expectedRevision, target) {
      await requireProfile(actor);
      await requireProfile(target);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (task.assignee !== actor) throw new Error("Only the task assignee can offer a handoff.");
        if (task.status !== "todo" || task.progress !== 0) throw new Error("Only an idle Kanban task can be handed off.");
        if (target === actor) throw new Error("Kanban handoff target must be different.");
        if (task.handoffTo) throw new Error("Cancel the pending Kanban handoff first.");
        task.handoffTo = target;
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async acceptHandoff(actor, id, expectedRevision) {
      await requireProfile(actor);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (!task.handoffTo || task.handoffTo !== actor) throw new Error("Only the handoff target can accept it.");
        task.assignee = actor;
        delete task.handoffTo;
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async cancelHandoff(actor, id, expectedRevision) {
      await requireProfile(actor);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (!task.handoffTo) throw new Error("No pending Kanban handoff.");
        if (task.assignee !== actor && task.createdBy !== actor && task.handoffTo !== actor)
          throw new Error("Only the task assignee, creator or target can cancel a handoff.");
        delete task.handoffTo;
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async claimWorker(actor, id, expectedRevision) {
      await requireProfile(actor);
      const token = randomUUID();
      const task = await mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (task.assignee !== actor) throw new Error("Only the task assignee can claim worker ownership.");
        if (task.status !== "todo" || task.progress !== 0 || task.workerClaim)
          throw new Error("Only an idle Kanban task can be claimed by a worker.");
        if (task.handoffTo) throw new Error("Cancel the pending Kanban handoff before claiming work.");
        task.workerClaim = { profile: actor, host: hostname(), pid: process.pid,
          digest: createHash("sha256").update(token).digest("hex") };
        task.status = "doing";
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
      return { task, token };
    },
    async finishWorker(actor, id, expectedRevision, token) {
      await requireProfile(actor);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        ownedClaim(task, actor, token);
        delete task.workerClaim;
        task.status = "done";
        task.progress = 100;
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async releaseWorker(actor, id, expectedRevision, token) {
      await requireProfile(actor);
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        ownedClaim(task, actor, token);
        delete task.workerClaim;
        task.status = "blocked";
        task.progress = 0;
        task.revision++;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    async recoverWorker(actor, id, expectedRevision, expectedPid) {
      await requireProfile(actor);
      if (!Number.isSafeInteger(expectedPid) || expectedPid < 1) throw new Error("Invalid Kanban worker PID.");
      return mutate((tasks) => {
        const task = find(tasks, id, expectedRevision);
        if (task.assignee !== actor) throw new Error("Only the task assignee can recover worker ownership.");
        const claim = task.workerClaim;
        if (!claim) throw new Error("No Kanban worker claim to recover.");
        if (claim.host !== hostname()) throw new Error("Kanban worker claim belongs to another host.");
        if (claim.pid !== expectedPid) throw new Error("Kanban worker claim changed.");
        try { process.kill(claim.pid, 0); }
        catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            throw new Error("Kanban worker owner cannot be verified as stopped.");
          delete task.workerClaim;
          task.status = "blocked";
          task.progress = 0;
          task.revision++;
          task.updatedAt = new Date().toISOString();
          return task;
        }
        throw new Error("Kanban worker owner is still active.");
      });
    },
  };
}
