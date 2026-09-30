import { randomUUID } from "node:crypto";

import { nextCronOccurrence, parseCronSchedule } from "./cron-schedule.js";

export type CronTask = {
  version: 1;
  id: string;
  workingDirectory: string;
  prompt: string;
  /** Pinned advisory skill context, resolved again on every run. */
  skill?: { id: string; scope: "USER" | "PROJECT"; digest: string };
  skillId?: string;
  schedule: { kind: "once"; at: string } | { kind: "cron"; expression: string };
  state: "active" | "paused" | "finished";
  nextRunAt?: string;
  lastRunAt?: string;
  revision: number;
};

export type CronTaskStore = {
  list(): Promise<CronTask[]>;
  load(id: string): Promise<CronTask | undefined>;
  save(task: CronTask, expectedRevision?: number): Promise<CronTask>;
  delete(id: string, expectedRevision: number): Promise<boolean>;
};

export type CronSchedulerOptions = {
  store: CronTaskStore;
  /** Trusted host must route any agent tools through runAgent; scheduled WRITE/EXECUTE is not authorized by this callback. */
  run(task: Readonly<CronTask>, signal: AbortSignal): Promise<void>;
  now?: () => Date;
  createId?: () => string;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TASKS = 128;
const MAX_PROMPT = 4_000;
const MAX_OVERDUE_MS = 24 * 60 * 60 * 1_000;
const CREDENTIAL = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\s*[:=]\s*\S+|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i;

function timestamp(value: string): number {
  const date = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(date) || new Date(date).toISOString() !== value) throw new Error("Invalid cron timestamp.");
  return date;
}

export function validateCronTask(value: unknown): asserts value is CronTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cron task.");
  const task = value as Record<string, unknown>;
  if (Object.keys(task).some((key) => !["version", "id", "workingDirectory", "prompt", "skill", "skillId", "schedule", "state", "nextRunAt", "lastRunAt", "revision"].includes(key))
    || task.version !== 1 || typeof task.id !== "string" || !ID.test(task.id)
    || typeof task.workingDirectory !== "string" || !task.workingDirectory.trim() || task.workingDirectory.length > 4_096
    || typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > MAX_PROMPT || CREDENTIAL.test(task.prompt)
    || (task.skillId !== undefined && (typeof task.skillId !== "string" || !SKILL_ID.test(task.skillId)))
    || !Number.isSafeInteger(task.revision) || (task.revision as number) < 0
    || !["active", "paused", "finished"].includes(task.state as string)) throw new Error("Invalid cron task.");
  if (task.skill !== undefined) {
    if (!task.skill || typeof task.skill !== "object" || Array.isArray(task.skill) || task.skillId !== undefined) throw new Error("Invalid cron skill binding.");
    const skill = task.skill as Record<string, unknown>;
    if (Object.keys(skill).some((key) => !["id", "scope", "digest"].includes(key))
      || typeof skill.id !== "string" || !SKILL_ID.test(skill.id)
      || !["USER", "PROJECT"].includes(skill.scope as string)
      || typeof skill.digest !== "string" || !/^[a-f0-9]{64}$/.test(skill.digest)) throw new Error("Invalid cron skill binding.");
  }
  if (!task.schedule || typeof task.schedule !== "object" || Array.isArray(task.schedule)) throw new Error("Invalid cron schedule.");
  const schedule = task.schedule as Record<string, unknown>;
  if (schedule.kind === "once") {
    if (Object.keys(schedule).some((key) => !["kind", "at"].includes(key))) throw new Error("Invalid cron schedule.");
    timestamp(schedule.at as string);
  } else if (schedule.kind === "cron") {
    if (Object.keys(schedule).some((key) => !["kind", "expression"].includes(key)) || typeof schedule.expression !== "string") throw new Error("Invalid cron schedule.");
    parseCronSchedule(schedule.expression);
  } else throw new Error("Invalid cron schedule.");
  if (task.nextRunAt !== undefined) timestamp(task.nextRunAt as string);
  if (task.lastRunAt !== undefined) timestamp(task.lastRunAt as string);
  if ((task.state === "active") !== (task.nextRunAt !== undefined)) throw new Error("Invalid cron task state.");
  if (task.state === "finished" && schedule.kind !== "once") throw new Error("Invalid cron task state.");
}

function copy(task: CronTask): CronTask { return structuredClone(task); }

/** Opt-in scheduler; due runs reserve their slot durably before invoking the host. No replay after restart. */
export class CronScheduler {
  private readonly store: CronTaskStore;
  private readonly run: CronSchedulerOptions["run"];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly active = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopping = false;
  private inFlight = 0;

  constructor(options: CronSchedulerOptions) {
    this.store = options.store;
    this.run = options.run;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async create(input: { workingDirectory: string; prompt: string; skillId?: string; skill?: CronTask["skill"]; schedule: CronTask["schedule"] }): Promise<CronTask> {
    if ((await this.store.list()).length >= MAX_TASKS) throw new Error("Cron task limit reached.");
    const id = this.createId();
    const now = this.now();
    const nextRunAt = input.schedule.kind === "once" ? input.schedule.at : nextCronOccurrence(input.schedule.expression, now).toISOString();
    const task: CronTask = { version: 1, id, workingDirectory: input.workingDirectory, prompt: input.prompt,
      ...(input.skillId === undefined ? {} : { skillId: input.skillId }), ...(input.skill === undefined ? {} : { skill: input.skill }), schedule: input.schedule, state: "active", nextRunAt, revision: 0 };
    validateCronTask(task);
    if (timestamp(nextRunAt) <= now.getTime()) throw new Error("Cron one-time task must be in the future.");
    return copy(await this.store.save(task));
  }

  async list(): Promise<CronTask[]> { return (await this.store.list()).map(copy); }

  async pause(id: string): Promise<CronTask | undefined> {
    const task = await this.store.load(id);
    if (!task || task.state !== "active") return undefined;
    const paused: CronTask = { ...task, state: "paused" };
    delete paused.nextRunAt;
    return copy(await this.store.save(paused, task.revision));
  }

  async resume(id: string): Promise<CronTask | undefined> {
    const task = await this.store.load(id);
    if (!task || task.state !== "paused") return undefined;
    const now = this.now();
    const nextRunAt = task.schedule.kind === "once" ? task.schedule.at : nextCronOccurrence(task.schedule.expression, now).toISOString();
    if (task.schedule.kind === "once" && timestamp(nextRunAt) <= now.getTime()) throw new Error("Past one-time tasks cannot be resumed; create a new task.");
    return copy(await this.store.save({ ...task, state: "active", nextRunAt }, task.revision));
  }

  async remove(id: string): Promise<boolean> {
    const task = await this.store.load(id);
    if (!task || this.active.has(id)) return false;
    return this.store.delete(id, task.revision);
  }

  private async execute(task: CronTask, due: boolean, onRunError?: (error: unknown) => void): Promise<boolean> {
    if (this.stopping || this.active.has(task.id)) return false;
    this.inFlight += 1;
    try {
      const latest = await this.store.load(task.id);
      if (this.stopping || !latest || latest.revision !== task.revision || (due && latest.state !== "active")) return false;
      const now = this.now();
      if (due && (latest.nextRunAt === undefined || timestamp(latest.nextRunAt) > now.getTime())) return false;
      const next: CronTask = { ...latest, lastRunAt: now.toISOString() };
      if (due && latest.schedule.kind === "once") {
        next.state = "finished";
        delete next.nextRunAt;
      } else if (due && latest.schedule.kind === "cron") {
        next.nextRunAt = nextCronOccurrence(latest.schedule.expression, now).toISOString();
      }
      if (this.stopping) return false;
      // A failed reservation cannot start a second run. Manual triggers leave the schedule unchanged.
      const reserved = await this.store.save(next, latest.revision);
      if (this.stopping) return false;
      const controller = new AbortController();
      this.active.set(task.id, controller);
      try { await this.run(copy(reserved), controller.signal); }
      catch (error: unknown) {
        if (this.stopping && controller.signal.aborted) return false;
        if (!onRunError) throw error;
        onRunError(error);
        return false;
      }
      finally { this.active.delete(task.id); }
      if (controller.signal.aborted) return false;
      return true;
    } finally { this.inFlight -= 1; }
  }

  async trigger(id: string): Promise<boolean> {
    const task = await this.store.load(id);
    if (!task || task.state === "finished") return false;
    return this.execute(task, false);
  }

  async tick(onRunError?: (error: unknown) => void): Promise<number> {
    if (this.ticking || this.stopping) return 0;
    this.ticking = true;
    try {
      let started = 0;
      const now = this.now().getTime();
      for (const task of await this.store.list()) {
        if (this.stopping) break;
        if (task.state !== "active" || !task.nextRunAt || timestamp(task.nextRunAt) > now) continue;
        // Old missed invocations are skipped rather than silently replayed after a long downtime.
        if (now - timestamp(task.nextRunAt) > MAX_OVERDUE_MS) {
          const next: CronTask = { ...task };
          if (next.schedule.kind === "once") { next.state = "finished"; delete next.nextRunAt; }
          else next.nextRunAt = nextCronOccurrence(next.schedule.expression, this.now()).toISOString();
          if (this.stopping) break;
          await this.store.save(next, task.revision);
          continue;
        }
        if (await this.execute(task, true, onRunError)) started += 1;
      }
      return started;
    } finally { this.ticking = false; }
  }

  start(onError: (error: unknown) => void, intervalMs = 60_000): void {
    if (typeof onError !== "function") throw new Error("Cron scheduler requires an error handler.");
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000 || this.timer || this.ticking || this.inFlight) throw new Error("Invalid cron polling interval or scheduler already running.");
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick(onError).catch(onError); }, intervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    const deadline = Date.now() + 5_000;
    while (this.active.size || this.ticking || this.inFlight) {
      if (Date.now() >= deadline) throw new Error("Cron scheduler shutdown timed out; an in-flight operation did not stop.");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}
