import { randomUUID } from "node:crypto";

export type PersistentGoalState = "ready" | "running" | "paused" | "interrupted" | "completed" | "exhausted";

/** Credential-free goal intent and budget; no provider state, tool authority, or transcript. */
export type PersistentGoal = {
  version: 1;
  id: string;
  sessionId: string;
  workingDirectory: string;
  objective: string;
  criterion: string;
  state: PersistentGoalState;
  maxTurns: number;
  turnsUsed: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  revision: number;
};

export type PersistentGoalStore = {
  list(): Promise<PersistentGoal[]>;
  load(id: string): Promise<PersistentGoal | undefined>;
  save(goal: PersistentGoal, expectedRevision?: number): Promise<PersistentGoal>;
};

export const GOAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\s*[:=]\s*\S+|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i;
const FIELDS = ["version", "id", "sessionId", "workingDirectory", "objective", "criterion", "state", "maxTurns", "turnsUsed", "createdAt", "updatedAt", "deadlineAt", "revision"];

function timestamp(value: unknown): number {
  if (typeof value !== "string") throw new Error("Invalid persistent goal timestamp.");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("Invalid persistent goal timestamp.");
  return time;
}

/** Strict validation on both trusted host input and every durable read. */
export function validatePersistentGoal(value: unknown): asserts value is PersistentGoal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid persistent goal.");
  const goal = value as Record<string, unknown>;
  if (Object.keys(goal).length !== FIELDS.length || Object.keys(goal).some((key) => !FIELDS.includes(key))
    || goal.version !== 1 || typeof goal.id !== "string" || !GOAL_ID.test(goal.id)
    || typeof goal.sessionId !== "string" || !GOAL_ID.test(goal.sessionId)
    || typeof goal.workingDirectory !== "string" || !goal.workingDirectory.trim() || goal.workingDirectory.length > 4_096
    || typeof goal.objective !== "string" || !goal.objective.trim() || goal.objective.length > 4_000 || CREDENTIAL.test(goal.objective)
    || typeof goal.criterion !== "string" || !goal.criterion.trim() || goal.criterion.length > 1_000 || CREDENTIAL.test(goal.criterion)
    || !["ready", "running", "paused", "interrupted", "completed", "exhausted"].includes(goal.state as string)
    || !Number.isSafeInteger(goal.maxTurns) || (goal.maxTurns as number) < 1 || (goal.maxTurns as number) > 64
    || !Number.isSafeInteger(goal.turnsUsed) || (goal.turnsUsed as number) < 0 || (goal.turnsUsed as number) > (goal.maxTurns as number)
    || !Number.isSafeInteger(goal.revision) || (goal.revision as number) < 0
    || (goal.state === "ready" && goal.turnsUsed === goal.maxTurns)
    || (["running", "interrupted", "completed"].includes(goal.state as string) && goal.turnsUsed === 0)) throw new Error("Invalid persistent goal.");
  try {
    const created = timestamp(goal.createdAt);
    const updated = timestamp(goal.updatedAt);
    const deadline = timestamp(goal.deadlineAt);
    if (updated < created || deadline <= created || deadline - created > 30 * 86_400_000) throw new Error("Invalid persistent goal timeline.");
  } catch { throw new Error("Invalid persistent goal."); }
}

export type CreatePersistentGoal = Pick<PersistentGoal, "sessionId" | "workingDirectory" | "objective" | "criterion" | "maxTurns" | "deadlineAt">;

export type PersistentGoalManagerOptions = {
  store: PersistentGoalStore;
  /** The host must supply a READ-only run; the goal record carries no tool authority. */
  runReadOnly: (goal: Readonly<PersistentGoal>, signal: AbortSignal) => Promise<unknown>;
  /** Trusted host policy only; model text is data, not a completion verdict. */
  evaluateCompletion: (goal: Readonly<PersistentGoal>, result: unknown, signal: AbortSignal) => boolean | Promise<boolean>;
  now?: () => Date;
  createId?: () => string;
};

/** Explicit single-turn advancement only. Nothing automatically resumes or executes after restart. */
export class PersistentGoalManager {
  private readonly store: PersistentGoalStore;
  private readonly runReadOnly: PersistentGoalManagerOptions["runReadOnly"];
  private readonly evaluateCompletion: PersistentGoalManagerOptions["evaluateCompletion"];
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: PersistentGoalManagerOptions) {
    if (!options?.store || typeof options.runReadOnly !== "function" || typeof options.evaluateCompletion !== "function") throw new Error("Invalid persistent goal manager.");
    this.store = options.store;
    this.runReadOnly = options.runReadOnly;
    this.evaluateCompletion = options.evaluateCompletion;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  list(): Promise<PersistentGoal[]> { return this.store.list(); }
  load(id: string): Promise<PersistentGoal | undefined> { return this.store.load(id); }

  async create(input: CreatePersistentGoal): Promise<PersistentGoal> {
    const createdAt = this.now().toISOString();
    const goal: PersistentGoal = { ...input, version: 1, id: this.createId(), state: "ready", turnsUsed: 0, createdAt, updatedAt: createdAt, revision: 0 };
    validatePersistentGoal(goal);
    return this.store.save(goal);
  }

  async pause(id: string): Promise<PersistentGoal | undefined> {
    const goal = await this.store.load(id);
    if (goal?.state !== "ready") return undefined;
    return this.store.save({ ...goal, state: "paused", updatedAt: this.now().toISOString() }, goal.revision);
  }

  async resume(id: string): Promise<PersistentGoal | undefined> {
    const goal = await this.store.load(id);
    // A stranded 'running' record is never recovered by a second host: it might still be executing.
    if (goal?.state !== "paused") return undefined;
    const state = goal.turnsUsed >= goal.maxTurns || this.now().getTime() >= Date.parse(goal.deadlineAt) ? "exhausted" : "ready";
    return this.store.save({ ...goal, state, updatedAt: this.now().toISOString() }, goal.revision);
  }

  /** Explicitly seal a stranded reservation; never claim the old process was stopped or replay it. */
  async markInterrupted(id: string): Promise<PersistentGoal | undefined> {
    const goal = await this.store.load(id);
    if (goal?.state !== "running") return undefined;
    return this.store.save({ ...goal, state: "interrupted", updatedAt: this.now().toISOString() }, goal.revision);
  }

  /** Explicit trusted-host verdict after reviewing a settled turn, never a model claim. */
  async complete(id: string): Promise<PersistentGoal | undefined> {
    const goal = await this.store.load(id);
    if (!goal || !["ready", "paused", "exhausted"].includes(goal.state) || goal.turnsUsed === 0
      || this.now().getTime() >= Date.parse(goal.deadlineAt)) return undefined;
    return this.store.save({ ...goal, state: "completed", updatedAt: this.now().toISOString() }, goal.revision);
  }

  /** Reserve the budget durably before running; a failure pauses instead of replaying. */
  async advance(id: string, signal?: AbortSignal): Promise<PersistentGoal | undefined> {
    signal?.throwIfAborted();
    const goal = await this.store.load(id);
    if (goal?.state !== "ready") return undefined;
    if (goal.turnsUsed >= goal.maxTurns || this.now().getTime() >= Date.parse(goal.deadlineAt))
      return this.store.save({ ...goal, state: "exhausted", updatedAt: this.now().toISOString() }, goal.revision);
    let reserved: PersistentGoal;
    try {
      reserved = await this.store.save({ ...goal, state: "running", turnsUsed: goal.turnsUsed + 1, updatedAt: this.now().toISOString() }, goal.revision);
    } catch (error: unknown) {
      if (error instanceof Error && /Persistent goal changed before save/.test(error.message)) return undefined;
      throw error;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const remaining = Date.parse(reserved.deadlineAt) - this.now().getTime();
    const timer = setTimeout(abort, Math.max(1, Math.min(remaining, 600_000)));
    let runFinished = false;
    try {
      if (signal?.aborted) controller.abort();
      controller.signal.throwIfAborted();
      const result = await this.runReadOnly(reserved, controller.signal);
      controller.signal.throwIfAborted();
      runFinished = true;
      const current = await this.store.load(id);
      if (current?.state !== "running" || current.revision !== reserved.revision) throw new Error("Persistent goal changed before evaluation.");
      const done = await this.evaluateCompletion(reserved, result, controller.signal);
      controller.signal.throwIfAborted();
      if (typeof done !== "boolean") throw new Error("Persistent goal evaluator must return a boolean.");
      const state: PersistentGoalState = this.now().getTime() >= Date.parse(reserved.deadlineAt) ? "exhausted" : done ? "completed" : reserved.turnsUsed >= reserved.maxTurns ? "exhausted" : "ready";
      return await this.store.save({ ...reserved, state, updatedAt: this.now().toISOString() }, reserved.revision);
    } catch (error: unknown) {
      // No model text or error body is persisted. A failed turn still consumes its reservation.
      // A run with uncertain termination must never be explicitly resumed while it may still execute.
      const state = this.now().getTime() >= Date.parse(reserved.deadlineAt) ? "exhausted" : !runFinished || controller.signal.aborted ? "interrupted" : "paused";
      try {
        await this.store.save({ ...reserved, state, updatedAt: this.now().toISOString() }, reserved.revision);
      } catch (saveError: unknown) {
        if (!(saveError instanceof Error && /Persistent goal changed before save/.test(saveError.message))) throw saveError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
