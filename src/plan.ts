import { randomUUID } from "node:crypto";

import type { AgentTool, ToolResult } from "./tools.js";

export const PLAN_STORAGE_VERSION = 1;
export const DEFAULT_MAX_PLAN_TASKS = 100;
export const DEFAULT_MAX_PLAN_TITLE_CHARS = 200;
export const DEFAULT_MAX_PLAN_DESCRIPTION_CHARS = 4_000;
export const DEFAULT_MAX_PLAN_BLOCKED_REASON_CHARS = 1_000;

const PLAN_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_STATUSES = new Set<PlanTaskStatus>(["TODO", "IN_PROGRESS", "DONE", "BLOCKED"]);

export type PlanTaskStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED";

export type DragonsPlanTask = {
  id: string;
  title: string;
  description: string;
  parentId?: string;
  status: PlanTaskStatus;
  blockedReason?: string;
};

export type DragonsPlan = {
  version: 1;
  tasks: DragonsPlanTask[];
};

export type PlanTaskInput = {
  title: string;
  description: string;
  parentId?: string;
};

export type PlanTaskUpdate = {
  title?: string;
  description?: string;
  /** Use null to explicitly remove an existing parent. */
  parentId?: string | null;
};

export type PlanStore = {
  list(): Promise<DragonsPlanTask[]>;
  get(id: string): Promise<DragonsPlanTask | undefined>;
  add(input: PlanTaskInput): Promise<DragonsPlanTask>;
  update(id: string, input: PlanTaskUpdate): Promise<DragonsPlanTask>;
  setStatus(id: string, status: PlanTaskStatus, blockedReason?: string): Promise<DragonsPlanTask>;
  remove(id: string): Promise<boolean>;
};

export type SessionPlanStoreOptions = {
  now?: () => Date;
  createId?: () => string;
  maxTasks?: number;
  maxTitleCharacters?: number;
  maxDescriptionCharacters?: number;
  maxBlockedReasonCharacters?: number;
};

type PlanSession = {
  id: string;
  updatedAt: string;
  plan?: DragonsPlan;
};

type PlanSessionStore = {
  load(id: string): Promise<PlanSession | undefined>;
  save(session: PlanSession): Promise<void>;
};

type PlanLimits = Required<Pick<SessionPlanStoreOptions, "maxTasks" | "maxTitleCharacters" | "maxDescriptionCharacters" | "maxBlockedReasonCharacters">>;

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

function validOptionalBlockedReason(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || validText(value, maximum);
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

/** Strictly validates app-owned task state before it is persisted or reloaded. */
export function isDragonsPlan(value: unknown, options: SessionPlanStoreOptions = {}): value is DragonsPlan {
  const limits = planLimits(options);
  if (!isRecord(value) || value.version !== PLAN_STORAGE_VERSION || !Array.isArray(value.tasks) || value.tasks.length > limits.maxTasks) return false;
  const ids = new Set<string>();
  const tasks: DragonsPlanTask[] = [];
  for (const candidate of value.tasks) {
    if (!isRecord(candidate)
      || !validTaskId(candidate.id)
      || ids.has(candidate.id)
      || !validText(candidate.title, limits.maxTitleCharacters)
      || !validText(candidate.description, limits.maxDescriptionCharacters)
      || !validOptionalParent(candidate.parentId)
      || !isTaskStatus(candidate.status)
      || !validOptionalBlockedReason(candidate.blockedReason, limits.maxBlockedReasonCharacters)) return false;
    if ((candidate.status === "BLOCKED") !== (candidate.blockedReason !== undefined)) return false;
    ids.add(candidate.id);
    tasks.push(candidate as DragonsPlanTask);
  }
  if (tasks.some((task) => task.parentId !== undefined && !ids.has(task.parentId))) return false;
  return !hasCycle(tasks);
}

function cloneTask(task: DragonsPlanTask): DragonsPlanTask {
  return { ...task };
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
  }
  return lines.join("\n");
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

function toolFailure(error: unknown): ToolResult {
  return { ok: false, output: error instanceof Error ? error.message : "Unable to update plan." };
}

/** Stores plans exclusively as a validated field on the selected Dragons session. */
export function createSessionPlanStore(sessionStore: PlanSessionStore, sessionId: string, options: SessionPlanStoreOptions = {}): PlanStore {
  const limits = planLimits(options);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  const load = async (): Promise<PlanSession> => {
    const session = await sessionStore.load(sessionId);
    if (!session) throw new Error(`Active plan session was not found: ${sessionId}`);
    if (session.plan !== undefined && !isDragonsPlan(session.plan, limits)) throw new Error("Saved Dragons plan is invalid.");
    return session;
  };
  const currentPlan = (session: PlanSession): DragonsPlan => session.plan === undefined ? { version: 1, tasks: [] } : { version: 1, tasks: session.plan.tasks.map(cloneTask) };
  const save = async (session: PlanSession, plan: DragonsPlan): Promise<void> => {
    if (!isDragonsPlan(plan, limits)) throw new Error("Refusing to save an invalid Dragons plan.");
    await sessionStore.save({ ...session, updatedAt: now().toISOString(), plan });
  };
  const assertTaskId = (id: string): void => {
    if (!validTaskId(id)) throw new Error("Plan task ID is invalid.");
  };
  const assertInput = (input: PlanTaskInput): void => {
    if (!validText(input.title, limits.maxTitleCharacters)) throw new Error(`Plan task title must be non-empty and no longer than ${limits.maxTitleCharacters} characters.`);
    if (!validText(input.description, limits.maxDescriptionCharacters)) throw new Error(`Plan task description must be non-empty and no longer than ${limits.maxDescriptionCharacters} characters.`);
    if (input.parentId !== undefined && !validTaskId(input.parentId)) throw new Error("Plan parent task ID is invalid.");
  };

  return {
    async list(): Promise<DragonsPlanTask[]> {
      return orderedTasks(currentPlan(await load()).tasks);
    },
    async get(id): Promise<DragonsPlanTask | undefined> {
      if (!validTaskId(id)) return undefined;
      return (await this.list()).find((task) => task.id === id);
    },
    async add(input): Promise<DragonsPlanTask> {
      assertInput(input);
      const session = await load();
      const plan = currentPlan(session);
      if (plan.tasks.length >= limits.maxTasks) throw new Error(`Plan task limit of ${limits.maxTasks} reached.`);
      if (input.parentId !== undefined && !plan.tasks.some((task) => task.id === input.parentId)) throw new Error("Plan parent task was not found.");
      const id = createId();
      if (!validTaskId(id) || plan.tasks.some((task) => task.id === id)) throw new Error("Unable to create a unique Dragons plan task ID.");
      const task: DragonsPlanTask = { id, title: input.title, description: input.description, ...(input.parentId === undefined ? {} : { parentId: input.parentId }), status: "TODO" };
      await save(session, { version: 1, tasks: [...plan.tasks, task] });
      return cloneTask(task);
    },
    async update(id, input): Promise<DragonsPlanTask> {
      assertTaskId(id);
      if (input.title !== undefined && !validText(input.title, limits.maxTitleCharacters)) throw new Error(`Plan task title must be non-empty and no longer than ${limits.maxTitleCharacters} characters.`);
      if (input.description !== undefined && !validText(input.description, limits.maxDescriptionCharacters)) throw new Error(`Plan task description must be non-empty and no longer than ${limits.maxDescriptionCharacters} characters.`);
      if (input.parentId !== undefined && input.parentId !== null && !validTaskId(input.parentId)) throw new Error("Plan parent task ID is invalid.");
      if (input.title === undefined && input.description === undefined && input.parentId === undefined) throw new Error("Plan update must change title, description, or parent.");
      const session = await load();
      const plan = currentPlan(session);
      const current = plan.tasks.find((task) => task.id === id);
      if (!current) throw new Error("Plan task was not found.");
      const parentId = input.parentId === undefined ? current.parentId : input.parentId === null ? undefined : input.parentId;
      if (parentId !== undefined && !plan.tasks.some((task) => task.id === parentId)) throw new Error("Plan parent task was not found.");
      const updated: DragonsPlanTask = { ...current, ...(input.title === undefined ? {} : { title: input.title }), ...(input.description === undefined ? {} : { description: input.description }), ...(parentId === undefined ? {} : { parentId }) };
      if (parentId === undefined) delete updated.parentId;
      const tasks = plan.tasks.map((task) => task.id === id ? updated : task);
      if (hasCycle(tasks)) throw new Error("Plan parent update would create a cycle.");
      await save(session, { version: 1, tasks });
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
      const updated: DragonsPlanTask = { ...current, status, ...(status === "BLOCKED" ? { blockedReason } : {}) };
      if (status !== "BLOCKED") delete updated.blockedReason;
      await save(session, { version: 1, tasks: plan.tasks.map((task) => task.id === id ? updated : task) });
      return cloneTask(updated);
    },
    async remove(id): Promise<boolean> {
      if (!validTaskId(id)) return false;
      const session = await load();
      const plan = currentPlan(session);
      if (!plan.tasks.some((task) => task.id === id)) return false;
      if (plan.tasks.some((task) => task.parentId === id)) throw new Error("Plan task cannot be removed while it has child tasks.");
      await save(session, { version: 1, tasks: plan.tasks.filter((task) => task.id !== id) });
      return true;
    },
  };
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
        properties: { title: { type: "string" }, description: { type: "string" }, parentId: { type: "string" } },
        required: ["title", "description"],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        const title = requiredString(input, "title");
        const description = requiredString(input, "description");
        const parentId = optionalString(input, "parentId");
        if (typeof title !== "string") return title;
        if (typeof description !== "string") return description;
        if (parentId !== undefined && typeof parentId !== "string") return parentId;
        try { const task = await resolveStore().add({ title, description, ...(parentId === undefined ? {} : { parentId }) }); return { ok: true, output: `Added plan task: ${task.id}\n${formatPlan(await resolveStore().list())}` }; }
        catch (error: unknown) { return toolFailure(error); }
      },
    },
    {
      name: "plan_update",
      operation: "WRITE",
      description: "Update an existing current-session plan task title, description, or parent. Set parentId to null to make it a root task.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, parentId: { type: ["string", "null"] } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        const id = requiredString(input, "id");
        if (typeof id !== "string") return id;
        if (!isRecord(input)) return { ok: false, output: "Expected plan update input." };
        const { title, description, parentId } = input;
        if (title !== undefined && typeof title !== "string") return { ok: false, output: "Expected a string for title." };
        if (description !== undefined && typeof description !== "string") return { ok: false, output: "Expected a string for description." };
        if (parentId !== undefined && parentId !== null && typeof parentId !== "string") return { ok: false, output: "Expected a string or null for parentId." };
        try { const task = await resolveStore().update(id, { ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }), ...(parentId === undefined ? {} : { parentId }) }); return { ok: true, output: `Updated plan task: ${task.id}\n${formatPlan(await resolveStore().list())}` }; }
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
