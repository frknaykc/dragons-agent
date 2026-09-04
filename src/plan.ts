import { randomUUID } from "node:crypto";

import type { AgentTool, ToolResult } from "./tools.js";

export const PLAN_STORAGE_VERSION = 1;
export const DEFAULT_MAX_PLAN_TASKS = 100;
export const DEFAULT_MAX_PLAN_TITLE_CHARS = 200;
export const DEFAULT_MAX_PLAN_DESCRIPTION_CHARS = 4_000;
export const DEFAULT_MAX_PLAN_BLOCKED_REASON_CHARS = 1_000;
export const DEFAULT_MAX_PLAN_REPLANS = 3;
export const DEFAULT_MAX_PLAN_HISTORY = 32;

const PLAN_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_STATUSES = new Set<PlanTaskStatus>(["TODO", "IN_PROGRESS", "DONE", "BLOCKED"]);

export type PlanTaskStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED";

export type DragonsPlanTask = {
  id: string;
  title: string;
  description: string;
  parentId?: string;
  dependsOn?: string[];
  status: PlanTaskStatus;
  blockedReason?: string;
  claimToken?: string;
};

export type DragonsPlan = {
  version: 1;
  tasks: DragonsPlanTask[];
  history?: PlanHistoryEvent[];
};

export type PlanMutationSource = "DEPENDENCY_COMPLETED" | "PLAN_REVISION" | "USER_INPUT" | "CONDITION_RESOLVED";

export type PlanHistoryEvent = {
  taskId: string;
  previousStatus: PlanTaskStatus;
  nextStatus: PlanTaskStatus;
  reason: string;
  source: PlanMutationSource;
  createdAt: string;
  replacementTaskId?: string;
};

export type PlanReplanInput = {
  reason: string;
  replacement: PlanTaskInput;
};

export type PlanTaskInput = {
  title: string;
  description: string;
  parentId?: string;
  dependsOn?: string[];
};

export type PlanTaskUpdate = {
  title?: string;
  description?: string;
  /** Use null to explicitly remove an existing parent. */
  parentId?: string | null;
  /** Use null to explicitly remove existing dependencies. */
  dependsOn?: string[] | null;
};

export type PlanStore = {
  list(): Promise<DragonsPlanTask[]>;
  get(id: string): Promise<DragonsPlanTask | undefined>;
  /** Atomically claim current runnable work before dispatching an executor. */
  claimRunnable(ids: readonly string[]): Promise<DragonsPlanTask[]>;
  /** Atomically complete a task only while its orchestration claim remains active. */
  completeClaim(id: string, claimToken: string): Promise<DragonsPlanTask | undefined>;
  /** Atomically block a task only while its orchestration claim remains active. */
  blockClaim(id: string, claimToken: string, blockedReason: string): Promise<DragonsPlanTask | undefined>;
  add(input: PlanTaskInput): Promise<DragonsPlanTask>;
  update(id: string, input: PlanTaskUpdate): Promise<DragonsPlanTask>;
  setStatus(id: string, status: PlanTaskStatus, blockedReason?: string): Promise<DragonsPlanTask>;
  recoverBlocked(id: string, recoveryNote: string, source: Exclude<PlanMutationSource, "PLAN_REVISION">): Promise<DragonsPlanTask>;
  replan(id: string, input: PlanReplanInput): Promise<DragonsPlanTask>;
  history(): Promise<PlanHistoryEvent[]>;
  remove(id: string): Promise<boolean>;
};

export type SessionPlanStoreOptions = {
  now?: () => Date;
  createId?: () => string;
  maxTasks?: number;
  maxTitleCharacters?: number;
  maxDescriptionCharacters?: number;
  maxBlockedReasonCharacters?: number;
  maxReplans?: number;
  maxHistory?: number;
};

type PlanSession = {
  id: string;
  updatedAt: string;
  plan?: DragonsPlan;
};

type PlanSessionStore = {
  load(id: string): Promise<PlanSession | undefined>;
  save(session: PlanSession): Promise<void>;
  /** Optional durable session-store mutation seam for cross-process plan claims. */
  mutate?(id: string, operation: (session: PlanSession) => PlanSession | Promise<PlanSession>): Promise<PlanSession | undefined>;
};

/** Process-local serialization prevents concurrent root runs from dispatching the same session task twice. */
const planMutationQueues = new WeakMap<PlanSessionStore, Map<string, Promise<void>>>();

function serializePlanMutation<T>(sessionStore: PlanSessionStore, sessionId: string, operation: () => Promise<T>): Promise<T> {
  let queues = planMutationQueues.get(sessionStore);
  if (!queues) {
    queues = new Map();
    planMutationQueues.set(sessionStore, queues);
  }
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(sessionId, tail);
  void tail.finally(() => { if (queues!.get(sessionId) === tail) queues!.delete(sessionId); });
  return result;
}

type PlanLimits = Required<Pick<SessionPlanStoreOptions, "maxTasks" | "maxTitleCharacters" | "maxDescriptionCharacters" | "maxBlockedReasonCharacters" | "maxReplans" | "maxHistory">>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTaskId(value: unknown): value is string {
  return typeof value === "string" && PLAN_TASK_ID_PATTERN.test(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function validOptionalParent(value: unknown): value is string | undefined {
  return value === undefined || validTaskId(value);
}

function validOptionalDependencies(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(validTaskId) && new Set(value).size === value.length);
}

function validOptionalBlockedReason(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || validText(value, maximum);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPlanMutationSource(value: unknown): value is PlanMutationSource {
  return value === "DEPENDENCY_COMPLETED" || value === "PLAN_REVISION" || value === "USER_INPUT" || value === "CONDITION_RESOLVED";
}

function validHistory(value: unknown, limits: PlanLimits): value is PlanHistoryEvent[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= limits.maxHistory && value.every((event) => isRecord(event)
    && validTaskId(event.taskId)
    && isTaskStatus(event.previousStatus)
    && isTaskStatus(event.nextStatus)
    && validText(event.reason, limits.maxBlockedReasonCharacters)
    && isPlanMutationSource(event.source)
    && validTimestamp(event.createdAt)
    && (event.replacementTaskId === undefined || validTaskId(event.replacementTaskId))));
}

function validHistorySemantics(history: readonly PlanHistoryEvent[] | undefined, taskIds: ReadonlySet<string>): boolean {
  return (history ?? []).every((event) => {
    if (!taskIds.has(event.taskId) || (event.replacementTaskId !== undefined && !taskIds.has(event.replacementTaskId))) return false;
    if (event.source === "PLAN_REVISION") return event.previousStatus === "BLOCKED" && event.nextStatus === "BLOCKED" && event.replacementTaskId !== undefined;
    return event.previousStatus === "BLOCKED" && event.nextStatus === "TODO" && event.replacementTaskId === undefined;
  });
}

function isTaskStatus(value: unknown): value is PlanTaskStatus {
  return typeof value === "string" && TASK_STATUSES.has(value as PlanTaskStatus);
}

function planLimits(options: SessionPlanStoreOptions = {}): PlanLimits {
  const limits = {
    maxTasks: options.maxTasks ?? DEFAULT_MAX_PLAN_TASKS,
    maxTitleCharacters: options.maxTitleCharacters ?? DEFAULT_MAX_PLAN_TITLE_CHARS,
    maxDescriptionCharacters: options.maxDescriptionCharacters ?? DEFAULT_MAX_PLAN_DESCRIPTION_CHARS,
    maxBlockedReasonCharacters: options.maxBlockedReasonCharacters ?? DEFAULT_MAX_PLAN_BLOCKED_REASON_CHARS,
    maxReplans: options.maxReplans ?? DEFAULT_MAX_PLAN_REPLANS,
    maxHistory: options.maxHistory ?? DEFAULT_MAX_PLAN_HISTORY,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  }
  return limits;
}

function hasCycle(tasks: readonly DragonsPlanTask[]): boolean {
  const parents = new Map(tasks.map((task) => [task.id, task.parentId]));
  for (const task of tasks) {
    const visited = new Set<string>();
    let current: string | undefined = task.id;
    while (current !== undefined) {
      if (visited.has(current)) return true;
      visited.add(current);
      current = parents.get(current);
    }
  }
  return false;
}

function hasDependencyCycle(tasks: readonly DragonsPlanTask[]): boolean {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of dependencies.get(id) ?? []) if (visit(dependencyId)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function taskStatusesRespectDependencies(tasks: readonly DragonsPlanTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.every((task) => (task.status !== "IN_PROGRESS" && task.status !== "DONE") || task.dependsOn?.every((dependencyId) => byId.get(dependencyId)?.status === "DONE") !== false);
}

/** Strictly validates app-owned task state before it is persisted or reloaded. */
export function isDragonsPlan(value: unknown, options: SessionPlanStoreOptions = {}): value is DragonsPlan {
  const limits = planLimits(options);
  if (!isRecord(value) || value.version !== PLAN_STORAGE_VERSION || !Array.isArray(value.tasks) || value.tasks.length > limits.maxTasks || !validHistory(value.history, limits)) return false;
  const ids = new Set<string>();
  const tasks: DragonsPlanTask[] = [];
  for (const candidate of value.tasks) {
    if (!isRecord(candidate)
      || !validTaskId(candidate.id)
      || ids.has(candidate.id)
      || !validText(candidate.title, limits.maxTitleCharacters)
      || !validText(candidate.description, limits.maxDescriptionCharacters)
      || !validOptionalParent(candidate.parentId)
      || !validOptionalDependencies(candidate.dependsOn)
      || !isTaskStatus(candidate.status)
      || (candidate.claimToken !== undefined && !validTaskId(candidate.claimToken))
      || !validOptionalBlockedReason(candidate.blockedReason, limits.maxBlockedReasonCharacters)) return false;
    if ((candidate.status === "BLOCKED") !== (candidate.blockedReason !== undefined)) return false;
    ids.add(candidate.id);
    tasks.push(candidate as DragonsPlanTask);
  }
  if (tasks.some((task) => task.parentId !== undefined && !ids.has(task.parentId))) return false;
  if (tasks.some((task) => task.dependsOn?.some((dependencyId) => dependencyId === task.id || !ids.has(dependencyId)))) return false;
  return !hasCycle(tasks) && !hasDependencyCycle(tasks) && taskStatusesRespectDependencies(tasks) && validHistorySemantics(value.history, ids) && (value.history?.filter((event) => event.source === "PLAN_REVISION").length ?? 0) <= limits.maxReplans;
}

function cloneTask(task: DragonsPlanTask): DragonsPlanTask {
  return { ...task, ...(task.dependsOn === undefined ? {} : { dependsOn: [...task.dependsOn] }) };
}

function cloneHistoryEvent(event: PlanHistoryEvent): PlanHistoryEvent {
  return { ...event };
}

function orderedTasks(tasks: readonly DragonsPlanTask[]): DragonsPlanTask[] {
  const children = new Map<string | undefined, DragonsPlanTask[]>();
  for (const task of tasks) {
    const bucket = children.get(task.parentId) ?? [];
    bucket.push(task);
    children.set(task.parentId, bucket);
  }
  const ordered: DragonsPlanTask[] = [];
  const visit = (parentId: string | undefined): void => {
    for (const child of children.get(parentId) ?? []) {
      ordered.push(cloneTask(child));
      visit(child.id);
    }
  };
  visit(undefined);
  return ordered;
}

/** Produces deterministic depth-first task order using insertion order among siblings. */
export function orderPlanTasks(tasks: readonly DragonsPlanTask[]): DragonsPlanTask[] {
  if (!isDragonsPlan({ version: 1, tasks: [...tasks] })) throw new Error("Plan is invalid.");
  return orderedTasks(tasks);
}

/** Returns TODO tasks whose explicit prerequisites are all complete, in stable plan order. */
export function runnablePlanTasks(tasks: readonly DragonsPlanTask[]): DragonsPlanTask[] {
  if (!isDragonsPlan({ version: 1, tasks: [...tasks] })) throw new Error("Plan is invalid.");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return orderedTasks(tasks).filter((task) => task.status === "TODO" && task.dependsOn?.every((dependencyId) => byId.get(dependencyId)?.status === "DONE") !== false);
}

function taskOutline(tasks: readonly DragonsPlanTask[]): Array<{ task: DragonsPlanTask; number: string; depth: number }> {
  const children = new Map<string | undefined, DragonsPlanTask[]>();
  for (const task of tasks) {
    const bucket = children.get(task.parentId) ?? [];
    bucket.push(task);
    children.set(task.parentId, bucket);
  }
  const result: Array<{ task: DragonsPlanTask; number: string; depth: number }> = [];
  const visit = (parentId: string | undefined, prefix: number[], depth: number): void => {
    const siblings = children.get(parentId) ?? [];
    siblings.forEach((task, index) => {
      const position = [...prefix, index + 1];
      result.push({ task, number: `${position.join(".")}.`, depth });
      visit(task.id, position, depth + 1);
    });
  };
  visit(undefined, [], 0);
  return result;
}

/** Human-readable, deterministic local and provider tool output. */
export function formatPlan(tasks: readonly DragonsPlanTask[]): string {
  if (tasks.length === 0) return "No plan tasks.";
  if (!isDragonsPlan({ version: 1, tasks: [...tasks] })) throw new Error("Plan is invalid.");
  const lines: string[] = [];
  for (const { task, number, depth } of taskOutline(tasks)) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${number} [${task.status}] ${task.title} (${task.id})`);
    lines.push(`${indent}   Description: ${task.description}`);
    if (task.blockedReason) lines.push(`${indent}   Blocked reason: ${task.blockedReason}`);
    if (task.dependsOn?.length) lines.push(`${indent}   Depends on: ${task.dependsOn.join(", ")}`);
  }
  return lines.join("\n");
}

/** Renders runnable TODO tasks with their original outline path and hierarchy context. */
export function formatRunnablePlan(tasks: readonly DragonsPlanTask[]): string {
  if (tasks.length === 0) return "No runnable plan tasks.";
  if (!isDragonsPlan({ version: 1, tasks: [...tasks] })) throw new Error("Plan is invalid.");
  const runnable = new Set(runnablePlanTasks(tasks).map((task) => task.id));
  const lines: string[] = [];
  for (const { task, number, depth } of taskOutline(tasks)) {
    if (!runnable.has(task.id)) continue;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${number} [${task.status}] ${task.title} (${task.id})`);
    lines.push(`${indent}   Description: ${task.description}`);
    if (task.dependsOn?.length) lines.push(`${indent}   Depends on: ${task.dependsOn.join(", ")}`);
  }
  return lines.join("\n");
}

/** Renders bounded, deterministic plan recovery and revision provenance. */
export function formatPlanHistory(events: readonly PlanHistoryEvent[]): string {
  if (events.length === 0) return "No plan recovery or revision history.";
  return events.map((event) => `${event.createdAt} ${event.source} ${event.taskId}: ${event.previousStatus} -> ${event.nextStatus}; ${event.reason}${event.replacementTaskId === undefined ? "" : `; replacement: ${event.replacementTaskId}`}`).join("\n");
}

/** Renders only a supplied immutable plan snapshot; it never grants plan mutation authority. */
export function formatPlanForInstructions(plan: DragonsPlan | undefined): string | undefined {
  if (!plan) return undefined;
  if (!isDragonsPlan(plan)) return "[Active Dragons plan snapshot was invalid and was not applied.]";
  return `Active Dragons plan snapshot (advisory-only; do not modify it):\n${formatPlan(plan.tasks)}`;
}

function requiredString(input: unknown, key: string): string | ToolResult {
  if (!isRecord(input) || typeof input[key] !== "string" || !input[key].trim()) return { ok: false, output: `Expected a non-empty string for ${key}.` };
  return input[key];
}

function optionalString(input: unknown, key: string): string | undefined | ToolResult {
  if (!isRecord(input) || input[key] === undefined) return undefined;
  return typeof input[key] === "string" ? input[key] : { ok: false, output: `Expected a string for ${key}.` };
}

function optionalStringArray(input: unknown, key: string): string[] | undefined | ToolResult {
  if (!isRecord(input) || input[key] === undefined) return undefined;
  return Array.isArray(input[key]) && input[key].every((value) => typeof value === "string") ? [...input[key]] : { ok: false, output: `Expected an array of strings for ${key}.` };
}

function toolFailure(error: unknown): ToolResult {
  return { ok: false, output: error instanceof Error ? error.message : "Unable to update plan." };
}

/** Stores plans exclusively as a validated field on the selected Dragons session. */
export function createSessionPlanStore(sessionStore: PlanSessionStore, sessionId: string, options: SessionPlanStoreOptions = {}): PlanStore {
  const limits = planLimits(options);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  let activeMutationSession: PlanSession | undefined;

  const load = async (): Promise<PlanSession> => {
    const session = activeMutationSession ?? await sessionStore.load(sessionId);
    if (!session) throw new Error(`Active plan session was not found: ${sessionId}`);
    if (session.plan !== undefined && !isDragonsPlan(session.plan, limits)) throw new Error("Saved Dragons plan is invalid.");
    return session;
  };
  const currentPlan = (session: PlanSession): DragonsPlan => session.plan === undefined
    ? { version: 1, tasks: [] }
    : { version: 1, tasks: session.plan.tasks.map(cloneTask), ...(session.plan.history === undefined ? {} : { history: session.plan.history.map(cloneHistoryEvent) }) };
  const save = async (session: PlanSession, plan: DragonsPlan): Promise<void> => {
    if (!isDragonsPlan(plan, limits)) throw new Error("Refusing to save an invalid Dragons plan.");
    const next = { ...session, updatedAt: now().toISOString(), plan };
    if (activeMutationSession !== undefined) {
      activeMutationSession = next;
      return;
    }
    await sessionStore.save(next);
  };
  const assertTaskId = (id: string): void => {
    if (!validTaskId(id)) throw new Error("Plan task ID is invalid.");
  };
  const assertInput = (input: PlanTaskInput): void => {
    if (!validText(input.title, limits.maxTitleCharacters)) throw new Error(`Plan task title must be non-empty and no longer than ${limits.maxTitleCharacters} characters.`);
    if (!validText(input.description, limits.maxDescriptionCharacters)) throw new Error(`Plan task description must be non-empty and no longer than ${limits.maxDescriptionCharacters} characters.`);
    if (input.parentId !== undefined && !validTaskId(input.parentId)) throw new Error("Plan parent task ID is invalid.");
    if (!validOptionalDependencies(input.dependsOn)) throw new Error("Plan task dependencies are invalid.");
  };
  const dependenciesAreComplete = (plan: DragonsPlan, task: DragonsPlanTask): boolean => {
    const byId = new Map(plan.tasks.map((candidate) => [candidate.id, candidate]));
    return task.dependsOn?.every((dependencyId) => byId.get(dependencyId)?.status === "DONE") !== false;
  };
  const appendHistory = (plan: DragonsPlan, event: PlanHistoryEvent): PlanHistoryEvent[] => {
    const history = [...(plan.history ?? []), event];
    if (history.length > limits.maxHistory) throw new Error(`Plan history limit of ${limits.maxHistory} reached.`);
    return history;
  };
  const claim = (session: PlanSession, ids: readonly string[]): { session: PlanSession; tasks: DragonsPlanTask[] } => {
    if (session.plan !== undefined && !isDragonsPlan(session.plan, limits)) throw new Error("Saved Dragons plan is invalid.");
    const plan = currentPlan(session);
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const selected = ids.map((id) => byId.get(id));
    if (selected.some((task) => !task || task.status !== "TODO" || !dependenciesAreComplete(plan, task))) {
      throw new Error("Plan step is not runnable.");
    }
    const claimed = new Set(ids);
    const tasks = plan.tasks.map((task) => claimed.has(task.id) ? { ...task, status: "IN_PROGRESS" as const, claimToken: randomUUID() } : task);
    const nextPlan: DragonsPlan = { version: 1, tasks, ...(plan.history === undefined ? {} : { history: plan.history }) };
    if (!isDragonsPlan(nextPlan, limits)) throw new Error("Refusing to save an invalid Dragons plan.");
    return {
      session: { ...session, updatedAt: now().toISOString(), plan: nextPlan },
      tasks: ids.map((id) => cloneTask(tasks.find((task) => task.id === id)!)),
    };
  };

  const store: PlanStore = {
    async list(): Promise<DragonsPlanTask[]> {
      return orderedTasks(currentPlan(await load()).tasks);
    },
    async get(id): Promise<DragonsPlanTask | undefined> {
      if (!validTaskId(id)) return undefined;
      return (await this.list()).find((task) => task.id === id);
    },
    async claimRunnable(ids): Promise<DragonsPlanTask[]> {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > limits.maxTasks || ids.some((id) => !validTaskId(id)) || new Set(ids).size !== ids.length) {
        throw new Error("Runnable plan claim IDs are invalid.");
      }
      if (sessionStore.mutate) {
        let claimed: DragonsPlanTask[] | undefined;
        const session = await sessionStore.mutate(sessionId, (current) => {
          const next = claim(current, ids);
          claimed = next.tasks;
          return next.session;
        });
        if (!session || !claimed) throw new Error(`Active plan session was not found: ${sessionId}`);
        return claimed;
      }
      return await serializePlanMutation(sessionStore, sessionId, async () => {
        const next = claim(await load(), ids);
        await save(next.session, next.session.plan!);
        return next.tasks;
      });
    },
    async completeClaim(id, claimToken): Promise<DragonsPlanTask | undefined> {
      assertTaskId(id);
      if (!validTaskId(claimToken)) throw new Error("Plan claim token is invalid.");
      const session = await load();
      const plan = currentPlan(session);
      const current = plan.tasks.find((task) => task.id === id);
      if (!current || current.status !== "IN_PROGRESS" || current.claimToken !== claimToken) return undefined;
      const updated: DragonsPlanTask = { ...current, status: "DONE" };
      delete updated.claimToken;
      const tasks = plan.tasks.map((task) => task.id === id ? updated : task);
      if (!taskStatusesRespectDependencies(tasks)) throw new Error("Plan task dependencies are not complete.");
      await save(session, { version: 1, tasks, ...(plan.history === undefined ? {} : { history: plan.history }) });
      return cloneTask(updated);
    },
    async blockClaim(id, claimToken, blockedReason): Promise<DragonsPlanTask | undefined> {
      assertTaskId(id);
      if (!validTaskId(claimToken)) throw new Error("Plan claim token is invalid.");
      if (!validText(blockedReason, limits.maxBlockedReasonCharacters)) throw new Error(`Blocked reason is required for BLOCKED status and must be no longer than ${limits.maxBlockedReasonCharacters} characters.`);
      const session = await load();
      const plan = currentPlan(session);
      const current = plan.tasks.find((task) => task.id === id);
      if (!current || current.status !== "IN_PROGRESS" || current.claimToken !== claimToken) return undefined;
      const updated: DragonsPlanTask = { ...current, status: "BLOCKED", blockedReason };
      delete updated.claimToken;
      await save(session, { version: 1, tasks: plan.tasks.map((task) => task.id === id ? updated : task), ...(plan.history === undefined ? {} : { history: plan.history }) });
      return cloneTask(updated);
    },
    async add(input): Promise<DragonsPlanTask> {
      assertInput(input);
      const session = await load();
      const plan = currentPlan(session);
      if (plan.tasks.length >= limits.maxTasks) throw new Error(`Plan task limit of ${limits.maxTasks} reached.`);
      if (input.parentId !== undefined && !plan.tasks.some((task) => task.id === input.parentId)) throw new Error("Plan parent task was not found.");
      if (input.dependsOn?.some((dependencyId) => !plan.tasks.some((task) => task.id === dependencyId))) throw new Error("Plan dependency task was not found.");
      const id = createId();
      if (!validTaskId(id) || plan.tasks.some((task) => task.id === id)) throw new Error("Unable to create a unique Dragons plan task ID.");
      if (input.dependsOn?.includes(id)) throw new Error("Plan task cannot depend on itself.");
      const task: DragonsPlanTask = { id, title: input.title, description: input.description, ...(input.parentId === undefined ? {} : { parentId: input.parentId }), ...(input.dependsOn === undefined ? {} : { dependsOn: [...input.dependsOn] }), status: "TODO" };
      await save(session, { version: 1, tasks: [...plan.tasks, task], ...(plan.history === undefined ? {} : { history: plan.history }) });
      return cloneTask(task);
    },
    async update(id, input): Promise<DragonsPlanTask> {
      assertTaskId(id);
      if (input.title !== undefined && !validText(input.title, limits.maxTitleCharacters)) throw new Error(`Plan task title must be non-empty and no longer than ${limits.maxTitleCharacters} characters.`);
      if (input.description !== undefined && !validText(input.description, limits.maxDescriptionCharacters)) throw new Error(`Plan task description must be non-empty and no longer than ${limits.maxDescriptionCharacters} characters.`);
      if (input.parentId !== undefined && input.parentId !== null && !validTaskId(input.parentId)) throw new Error("Plan parent task ID is invalid.");
      if (input.dependsOn !== undefined && input.dependsOn !== null && !validOptionalDependencies(input.dependsOn)) throw new Error("Plan task dependencies are invalid.");
      if (input.title === undefined && input.description === undefined && input.parentId === undefined && input.dependsOn === undefined) throw new Error("Plan update must change title, description, parent, or dependencies.");
      const session = await load();
      const plan = currentPlan(session);
      const current = plan.tasks.find((task) => task.id === id);
      if (!current) throw new Error("Plan task was not found.");
      if (current.status === "BLOCKED" && current.dependsOn?.length && input.dependsOn !== undefined) throw new Error("Blocked dependency-aware plan tasks must be recovered or replanned before dependencies change.");
      const parentId = input.parentId === undefined ? current.parentId : input.parentId === null ? undefined : input.parentId;
      const dependsOn = input.dependsOn === undefined ? current.dependsOn : input.dependsOn === null ? undefined : input.dependsOn;
      if (parentId !== undefined && !plan.tasks.some((task) => task.id === parentId)) throw new Error("Plan parent task was not found.");
      if (dependsOn?.some((dependencyId) => dependencyId === id || !plan.tasks.some((task) => task.id === dependencyId))) throw new Error("Plan dependency task was not found.");
      const updated: DragonsPlanTask = { ...current, ...(input.title === undefined ? {} : { title: input.title }), ...(input.description === undefined ? {} : { description: input.description }), ...(parentId === undefined ? {} : { parentId }), ...(dependsOn === undefined ? {} : { dependsOn: [...dependsOn] }) };
      if (parentId === undefined) delete updated.parentId;
      if (dependsOn === undefined) delete updated.dependsOn;
      const tasks = plan.tasks.map((task) => task.id === id ? updated : task);
      if (hasCycle(tasks)) throw new Error("Plan parent update would create a cycle.");
      if (hasDependencyCycle(tasks)) throw new Error("Plan dependency update would create a cycle.");
      if (!taskStatusesRespectDependencies(tasks)) throw new Error("Plan dependency update would invalidate an active or completed task.");
      await save(session, { version: 1, tasks, ...(plan.history === undefined ? {} : { history: plan.history }) });
      return cloneTask(updated);
    },
    async setStatus(id, status, blockedReason): Promise<DragonsPlanTask> {
      assertTaskId(id);
      if (!isTaskStatus(status)) throw new Error("Plan task status is invalid.");
      if (status === "BLOCKED" && !validText(blockedReason, limits.maxBlockedReasonCharacters)) throw new Error(`Blocked reason is required for BLOCKED status and must be no longer than ${limits.maxBlockedReasonCharacters} characters.`);
      if (status !== "BLOCKED" && blockedReason !== undefined) throw new Error("Blocked reason is only allowed when status is BLOCKED.");
      const session = await load();
      const plan = currentPlan(session);
      const current = plan.tasks.find((task) => task.id === id);
      if (!current) throw new Error("Plan task was not found.");
      if (current.status === "BLOCKED" && current.dependsOn?.length && status !== "BLOCKED") throw new Error("Blocked dependency-aware plan tasks require explicit recovery.");
      const updated: DragonsPlanTask = { ...current, status, ...(status === "BLOCKED" ? { blockedReason } : {}) };
      if (status !== "BLOCKED") delete updated.blockedReason;
      if (status !== "IN_PROGRESS") delete updated.claimToken;
      const tasks = plan.tasks.map((task) => task.id === id ? updated : task);
      if (!taskStatusesRespectDependencies(tasks)) throw new Error("Plan task dependencies are not complete.");
      await save(session, { version: 1, tasks, ...(plan.history === undefined ? {} : { history: plan.history }) });
      return cloneTask(updated);
    },
    async recoverBlocked(id, recoveryNote, source): Promise<DragonsPlanTask> {
      assertTaskId(id);
      if (!validText(recoveryNote, limits.maxBlockedReasonCharacters)) throw new Error(`Plan recovery note must be non-empty and no longer than ${limits.maxBlockedReasonCharacters} characters.`);
      if (!isPlanMutationSource(source) || (source as PlanMutationSource) === "PLAN_REVISION") throw new Error("Plan recovery source is invalid.");
      const session = await load();
      const plan = currentPlan(session);
      const current = plan.tasks.find((task) => task.id === id);
      if (!current) throw new Error("Plan task was not found.");
      if (current.status !== "BLOCKED") throw new Error("Only blocked plan tasks can be recovered.");
      if (!current.dependsOn?.length) throw new Error("Only dependency-aware blocked plan tasks can be recovered.");
      if (!dependenciesAreComplete(plan, current)) throw new Error("Plan task dependencies are not complete.");
      const updated: DragonsPlanTask = { ...current, status: "TODO" };
      delete updated.blockedReason;
      const history = appendHistory(plan, { taskId: id, previousStatus: "BLOCKED", nextStatus: "TODO", reason: recoveryNote, source, createdAt: now().toISOString() });
      await save(session, { version: 1, tasks: plan.tasks.map((task) => task.id === id ? updated : task), history });
      return cloneTask(updated);
    },
    async replan(id, input): Promise<DragonsPlanTask> {
      assertTaskId(id);
      if (!isRecord(input) || !validText(input.reason, limits.maxBlockedReasonCharacters)) throw new Error(`Plan replan reason must be non-empty and no longer than ${limits.maxBlockedReasonCharacters} characters.`);
      assertInput(input.replacement);
      const session = await load();
      const plan = currentPlan(session);
      if ((plan.history?.filter((event) => event.source === "PLAN_REVISION").length ?? 0) >= limits.maxReplans) throw new Error(`Plan replan limit of ${limits.maxReplans} reached.`);
      if (plan.tasks.length >= limits.maxTasks) throw new Error(`Plan task limit of ${limits.maxTasks} reached.`);
      const current = plan.tasks.find((task) => task.id === id);
      if (!current) throw new Error("Plan task was not found.");
      if (current.status !== "BLOCKED") throw new Error("Only blocked plan tasks can be replanned.");
      const replacement = input.replacement;
      if (replacement.parentId !== undefined && !plan.tasks.some((task) => task.id === replacement.parentId)) throw new Error("Plan parent task was not found.");
      if (replacement.dependsOn?.some((dependencyId) => !plan.tasks.some((task) => task.id === dependencyId))) throw new Error("Plan dependency task was not found.");
      const replacementId = createId();
      if (!validTaskId(replacementId) || plan.tasks.some((task) => task.id === replacementId)) throw new Error("Unable to create a unique Dragons plan task ID.");
      if (replacement.dependsOn?.includes(replacementId)) throw new Error("Plan task cannot depend on itself.");
      const task: DragonsPlanTask = { id: replacementId, title: replacement.title, description: replacement.description, ...(replacement.parentId === undefined ? {} : { parentId: replacement.parentId }), ...(replacement.dependsOn === undefined ? {} : { dependsOn: [...replacement.dependsOn] }), status: "TODO" };
      const history = appendHistory(plan, { taskId: id, previousStatus: current.status, nextStatus: current.status, reason: input.reason, source: "PLAN_REVISION", createdAt: now().toISOString(), replacementTaskId: replacementId });
      await save(session, { version: 1, tasks: [...plan.tasks, task], history });
      return cloneTask(task);
    },
    async history(): Promise<PlanHistoryEvent[]> {
      return (currentPlan(await load()).history ?? []).map(cloneHistoryEvent);
    },
    async remove(id: string): Promise<boolean> {
      if (!validTaskId(id)) return false;
      const session = await load();
      const plan = currentPlan(session);
      if (!plan.tasks.some((task) => task.id === id)) return false;
      if (plan.tasks.some((task) => task.parentId === id)) throw new Error("Plan task cannot be removed while it has child tasks.");
      if (plan.tasks.some((task) => task.dependsOn?.includes(id))) throw new Error("Plan task cannot be removed while another task depends on it.");
      if (plan.history?.some((event) => event.taskId === id || event.replacementTaskId === id)) throw new Error("Plan task cannot be removed while plan provenance references it.");
      await save(session, { version: 1, tasks: plan.tasks.filter((task) => task.id !== id), ...(plan.history === undefined ? {} : { history: plan.history }) });
      return true;
    },
  };
  const add = store.add.bind(store);
  const completeClaim = store.completeClaim.bind(store);
  const blockClaim = store.blockClaim.bind(store);
  const update = store.update.bind(store);
  const setStatus = store.setStatus.bind(store);
  const recoverBlocked = store.recoverBlocked.bind(store);
  const replan = store.replan.bind(store);
  const remove = store.remove.bind(store);
  const mutatePlan = async <T>(operation: () => Promise<T>): Promise<T> => await serializePlanMutation(sessionStore, sessionId, async () => {
    if (!sessionStore.mutate) return await operation();
    let result: T | undefined;
    let completed = false;
    const session = await sessionStore.mutate(sessionId, async (current) => {
      activeMutationSession = current;
      try {
        result = await operation();
        completed = true;
        return activeMutationSession!;
      } finally {
        activeMutationSession = undefined;
      }
    });
    if (!session || !completed) throw new Error(`Active plan session was not found: ${sessionId}`);
    return result!;
  });
  store.completeClaim = (id, claimToken) => mutatePlan(() => completeClaim(id, claimToken));
  store.blockClaim = (id, claimToken, blockedReason) => mutatePlan(() => blockClaim(id, claimToken, blockedReason));
  store.add = (input) => mutatePlan(() => add(input));
  store.update = (id, input) => mutatePlan(() => update(id, input));
  store.setStatus = (id, status, blockedReason) => mutatePlan(() => setStatus(id, status, blockedReason));
  store.recoverBlocked = (id, recoveryNote, source) => mutatePlan(() => recoverBlocked(id, recoveryNote, source));
  store.replan = (id, input) => mutatePlan(() => replan(id, input));
  store.remove = (id) => mutatePlan(() => remove(id));
  return store;
}

/** Provider-callable plan operations; mutations deliberately stay behind AgentTool WRITE authorization. */
export function createPlanTools(resolveStore: () => PlanStore): AgentTool[] {
  return [
    {
      name: "plan_list",
      operation: "READ",
      description: "List the current Dragons session plan in deterministic task order.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> {
        try { return { ok: true, output: formatPlan(await resolveStore().list()) }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_add",
      operation: "WRITE",
      description: "Add an explicit task to the current Dragons session plan. Never use this automatically; task creation requires an explicit request.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, description: { type: "string" }, parentId: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } } },
        required: ["title", "description"],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        const title = requiredString(input, "title");
        const description = requiredString(input, "description");
        const parentId = optionalString(input, "parentId");
        const dependsOn = optionalStringArray(input, "dependsOn");
        if (typeof title !== "string") return title;
        if (typeof description !== "string") return description;
        if (parentId !== undefined && typeof parentId !== "string") return parentId;
        if (dependsOn !== undefined && !Array.isArray(dependsOn)) return dependsOn;
        try { const task = await resolveStore().add({ title, description, ...(parentId === undefined ? {} : { parentId }), ...(dependsOn === undefined ? {} : { dependsOn }) }); return { ok: true, output: `Added plan task: ${task.id}\n${formatPlan(await resolveStore().list())}` }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_runnable",
      operation: "READ",
      description: "List TODO plan tasks whose explicit dependencies are all complete, in deterministic order.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> {
        try { return { ok: true, output: formatRunnablePlan(await resolveStore().list()) }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_history",
      operation: "READ",
      description: "List bounded recovery and replan provenance for the current session plan.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> {
        try { return { ok: true, output: formatPlanHistory(await resolveStore().history()) }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_update",
      operation: "WRITE",
      description: "Update an existing current-session plan task title, description, parent, or dependencies. Set parentId or dependsOn to null to remove it.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, parentId: { type: ["string", "null"] }, dependsOn: { type: ["array", "null"], items: { type: "string" } } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        const id = requiredString(input, "id");
        if (typeof id !== "string") return id;
        if (!isRecord(input)) return { ok: false, output: "Expected plan update input." };
        const { title, description, parentId, dependsOn } = input;
        if (title !== undefined && typeof title !== "string") return { ok: false, output: "Expected a string for title." };
        if (description !== undefined && typeof description !== "string") return { ok: false, output: "Expected a string for description." };
        if (parentId !== undefined && parentId !== null && typeof parentId !== "string") return { ok: false, output: "Expected a string or null for parentId." };
        if (dependsOn !== undefined && dependsOn !== null && (!Array.isArray(dependsOn) || !dependsOn.every((value) => typeof value === "string"))) return { ok: false, output: "Expected an array of strings or null for dependsOn." };
        try { const task = await resolveStore().update(id, { ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }), ...(parentId === undefined ? {} : { parentId }), ...(dependsOn === undefined ? {} : { dependsOn }) }); return { ok: true, output: `Updated plan task: ${task.id}\n${formatPlan(await resolveStore().list())}` }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_set_status",
      operation: "WRITE",
      description: "Set a current-session plan task status. BLOCKED requires blockedReason; other statuses clear it.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE", "BLOCKED"] }, blockedReason: { type: "string" } },
        required: ["id", "status"],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        const id = requiredString(input, "id");
        const status = requiredString(input, "status");
        const blockedReason = optionalString(input, "blockedReason");
        if (typeof id !== "string") return id;
        if (typeof status !== "string") return status;
        if (blockedReason !== undefined && typeof blockedReason !== "string") return blockedReason;
        try { const task = await resolveStore().setStatus(id, status as PlanTaskStatus, blockedReason); return { ok: true, output: `Updated plan task status: ${task.id}\n${formatPlan(await resolveStore().list())}` }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_recover",
      operation: "WRITE",
      description: "Recover a blocked dependency-aware plan task after a concrete, recorded state change.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, recoveryNote: { type: "string" }, source: { type: "string", enum: ["DEPENDENCY_COMPLETED", "USER_INPUT", "CONDITION_RESOLVED"] } },
        required: ["id", "recoveryNote", "source"],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        const id = requiredString(input, "id");
        const recoveryNote = requiredString(input, "recoveryNote");
        const source = requiredString(input, "source");
        if (typeof id !== "string") return id;
        if (typeof recoveryNote !== "string") return recoveryNote;
        if (typeof source !== "string") return source;
        try { const task = await resolveStore().recoverBlocked(id, recoveryNote, source as Exclude<PlanMutationSource, "PLAN_REVISION">); return { ok: true, output: `Recovered plan task: ${task.id}\n${formatPlan(await resolveStore().list())}` }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_replan",
      operation: "WRITE",
      description: "Create one explicit replacement for a blocked plan task, preserving the blocked original and bounded provenance.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }, reason: { type: "string" },
          replacement: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, parentId: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } } }, required: ["title", "description"], additionalProperties: false },
        },
        required: ["id", "reason", "replacement"],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        const id = requiredString(input, "id");
        const reason = requiredString(input, "reason");
        if (typeof id !== "string") return id;
        if (typeof reason !== "string") return reason;
        if (!isRecord(input) || !isRecord(input.replacement)) return { ok: false, output: "Expected a replacement plan task." };
        const { title, description, parentId, dependsOn } = input.replacement;
        if (typeof title !== "string" || typeof description !== "string") return { ok: false, output: "Replacement title and description must be strings." };
        if (parentId !== undefined && typeof parentId !== "string") return { ok: false, output: "Expected a string for replacement parentId." };
        if (dependsOn !== undefined && (!Array.isArray(dependsOn) || !dependsOn.every((value) => typeof value === "string"))) return { ok: false, output: "Expected an array of strings for replacement dependsOn." };
        try { const task = await resolveStore().replan(id, { reason, replacement: { title, description, ...(parentId === undefined ? {} : { parentId }), ...(dependsOn === undefined ? {} : { dependsOn }) } }); return { ok: true, output: `Replanned task: ${task.id}\n${formatPlan(await resolveStore().list())}` }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_remove",
      operation: "WRITE",
      description: "Remove a leaf task from the current Dragons session plan.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      async execute(input): Promise<ToolResult> {
        const id = requiredString(input, "id");
        if (typeof id !== "string") return id;
        try { return await resolveStore().remove(id) ? { ok: true, output: `Removed plan task: ${id}\n${formatPlan(await resolveStore().list())}` } : { ok: false, output: `Plan task was not found: ${id}` }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
  ];
}
