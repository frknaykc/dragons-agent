import { AgentRunCancelledError, type AgentModel } from "./agent.js";
import type { MemoryContext } from "./memory.js";
import { runnablePlanTasks, type DragonsPlan, type DragonsPlanTask, type PlanStore } from "./plan.js";
import type { ProjectContext } from "./project-context.js";
import { createParallelSubagentTool } from "./parallel-subagents.js";
import type { SkillsContext } from "./skills.js";
import { createSubagentTool } from "./subagents.js";
import type { AgentTool, ToolExecutionOptions, ToolResult } from "./tools.js";

export const DEFAULT_MAX_ORCHESTRATION_SUBAGENTS = 4;
export const DEFAULT_MAX_ORCHESTRATION_PARALLELISM = 2;
export const DEFAULT_MAX_ORCHESTRATION_BACKGROUND_JOBS = 2;
export const DEFAULT_MAX_ORCHESTRATION_RECORDS = 32;
export const DEFAULT_MAX_ORCHESTRATION_DURATION_MS = 300_000;
export const DEFAULT_MAX_ORCHESTRATION_SUMMARY_CHARS = 2_000;

export type OrchestrationStrategy = "LOCAL" | "DELEGATED_READ" | "PARALLEL_READ" | "PERSISTENT_READ" | "EFFECTFUL_BACKGROUND";
export type OrchestrationStatus = "COMPLETED" | "FAILED" | "DETACHED" | "CANCELLED";

/** Bounded runtime-only execution evidence. It deliberately excludes prompts, tool arguments, and transcripts. */
export type OrchestrationResult = {
  taskId: string;
  strategy: OrchestrationStrategy;
  status: OrchestrationStatus;
  summary: string;
};

export type OrchestrationRequest = {
  taskId: string;
  /** Absent strategy is deterministic: local for one selected step, parallel read-only for multiple independent steps. */
  strategy?: OrchestrationStrategy;
};

export type OrchestrationExecutor = {
  local?: (task: DragonsPlanTask, signal: AbortSignal) => Promise<OrchestrationResult>;
  /** A single fresh read-only child; it cannot inherit WRITE/EXECUTE authority. */
  delegate?: (task: DragonsPlanTask, signal: AbortSignal) => Promise<OrchestrationResult>;
  /** Must run only read-only, independent child work and return results in the supplied order. */
  parallel?: (tasks: readonly DragonsPlanTask[], signal: AbortSignal) => Promise<OrchestrationResult[]>;
  /** Starts an explicitly detached persistent read-only job. It must not imply effect authorization. */
  background?: (task: DragonsPlanTask, signal: AbortSignal) => Promise<OrchestrationResult>;
  /** Effectful work is optional and must enforce the supplied M61 grant inside the executor. */
  effectfulBackground?: (task: DragonsPlanTask, grant: unknown, signal: AbortSignal) => Promise<OrchestrationResult>;
  /** Re-reads authoritative durable job state; it must never replay a detached task. */
  reconcileBackground?: (task: DragonsPlanTask, signal: AbortSignal) => Promise<OrchestrationResult>;
};

export type PlanOrchestratorOptions = {
  store: PlanStore;
  executor: OrchestrationExecutor;
  signal?: AbortSignal;
  /** Opaque M61 grant: orchestration only requires its explicit presence and never persists it. */
  effectfulGrant?: unknown;
  maxSubagents?: number;
  maxParallelism?: number;
  maxBackgroundJobs?: number;
  maxRecords?: number;
  maxDurationMs?: number;
  maxSummaryCharacters?: number;
};

type Limits = Required<Omit<PlanOrchestratorOptions, "store" | "executor" | "signal" | "effectfulGrant">>;

const CREDENTIAL_SHAPED_TEXT = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*(?:[:=]\s*)?[^\s,;]*/gi;

function boundedSummary(value: string, maximum: number): string {
  const safe = value.replace(CREDENTIAL_SHAPED_TEXT, "[REDACTED]");
  if (safe.length <= maximum) return safe;
  const marker = `[orchestration summary truncated; omitted ${safe.length - maximum} characters]`;
  return marker.length >= maximum ? safe.slice(0, maximum) : `${safe.slice(0, maximum - marker.length)}${marker}`;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return resolved;
}

function createLimits(options: PlanOrchestratorOptions): Limits {
  const maxSubagents = boundedPositiveInteger(options.maxSubagents, DEFAULT_MAX_ORCHESTRATION_SUBAGENTS, DEFAULT_MAX_ORCHESTRATION_SUBAGENTS, "Orchestration subagent limit");
  const maxParallelism = boundedPositiveInteger(options.maxParallelism, DEFAULT_MAX_ORCHESTRATION_PARALLELISM, DEFAULT_MAX_ORCHESTRATION_PARALLELISM, "Orchestration parallelism limit");
  if (maxParallelism > maxSubagents) throw new Error("Orchestration parallelism cannot exceed its subagent limit.");
  return {
    maxSubagents,
    maxParallelism,
    maxBackgroundJobs: boundedPositiveInteger(options.maxBackgroundJobs, DEFAULT_MAX_ORCHESTRATION_BACKGROUND_JOBS, DEFAULT_MAX_ORCHESTRATION_BACKGROUND_JOBS, "Orchestration background-job limit"),
    maxRecords: boundedPositiveInteger(options.maxRecords, DEFAULT_MAX_ORCHESTRATION_RECORDS, DEFAULT_MAX_ORCHESTRATION_RECORDS, "Orchestration record limit"),
    maxDurationMs: boundedPositiveInteger(options.maxDurationMs, DEFAULT_MAX_ORCHESTRATION_DURATION_MS, DEFAULT_MAX_ORCHESTRATION_DURATION_MS, "Orchestration duration limit"),
    maxSummaryCharacters: boundedPositiveInteger(options.maxSummaryCharacters, DEFAULT_MAX_ORCHESTRATION_SUMMARY_CHARS, DEFAULT_MAX_ORCHESTRATION_SUMMARY_CHARS, "Orchestration summary limit"),
  };
}

function taskMap(tasks: readonly DragonsPlanTask[]): Map<string, DragonsPlanTask> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function runnable(tasks: readonly DragonsPlanTask[]): DragonsPlanTask[] {
  const byId = taskMap(tasks);
  return tasks.filter((task) => task.status === "TODO" && task.dependsOn?.every((id) => byId.get(id)?.status === "DONE") !== false);
}

function resultFor(taskId: string, strategy: OrchestrationStrategy, status: OrchestrationStatus, summary: string, limits: Limits): OrchestrationResult {
  return { taskId, strategy, status, summary: boundedSummary(summary, limits.maxSummaryCharacters) };
}

function validResult(result: OrchestrationResult, taskId: string, strategy: OrchestrationStrategy): boolean {
  return result.taskId === taskId && result.strategy === strategy && typeof result.summary === "string";
}

/**
 * Coordinates only explicit, currently runnable plan steps. It owns no provider, shell, approval,
 * session, grant, or durable-job state: executors retain those existing authoritative seams.
 */
export function createPlanOrchestrator(options: PlanOrchestratorOptions) {
  const limits = createLimits(options);
  const controller = new AbortController();
  const parentAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", parentAbort, { once: true });
  const records: OrchestrationResult[] = [];
  let createdSubagents = 0;
  let launchedBackgroundJobs = 0;
  let finished = false;
  const timeout = setTimeout(() => controller.abort(), limits.maxDurationMs);
  timeout.unref();

  const throwIfCancelled = (): void => {
    if (controller.signal.aborted) throw new AgentRunCancelledError();
  };
  const record = (result: OrchestrationResult): OrchestrationResult => {
    const safe = resultFor(result.taskId, result.strategy, result.status, result.summary, limits);
    records.push(safe);
    if (records.length > limits.maxRecords) records.shift();
    return safe;
  };
  const complete = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", parentAbort);
  };
  const block = async (task: DragonsPlanTask, reason: string): Promise<void> => {
    if (task.claimToken !== undefined) await options.store.blockClaim(task.id, task.claimToken, boundedSummary(reason, limits.maxSummaryCharacters));
  };
  const applyResult = async (task: DragonsPlanTask, strategy: OrchestrationStrategy, raw: OrchestrationResult): Promise<OrchestrationResult> => {
    if (!validResult(raw, task.id, strategy)) throw new Error("Orchestration executor returned an invalid result.");
    let result = raw;
    if (result.status === "COMPLETED" && (task.claimToken === undefined || !await options.store.completeClaim(task.id, task.claimToken))) {
      result = resultFor(task.id, strategy, "FAILED", "Orchestration completion was superseded by a newer plan state.", limits);
    }
    result = record(result);
    if (result.status === "FAILED" || result.status === "CANCELLED") await block(task, result.summary);
    // DETACHED remains IN_PROGRESS until authoritative durable reconciliation reports a terminal state.
    return result;
  };

  const runSingle = async (task: DragonsPlanTask, strategy: OrchestrationStrategy): Promise<OrchestrationResult> => {
    let execute: ((step: DragonsPlanTask, signal: AbortSignal) => Promise<OrchestrationResult>) | undefined;
    if (strategy === "LOCAL") execute = options.executor.local;
    if (strategy === "DELEGATED_READ") execute = options.executor.delegate;
    if (strategy === "PERSISTENT_READ") execute = options.executor.background;
    if (strategy === "EFFECTFUL_BACKGROUND") {
      if (!options.executor.effectfulBackground || options.effectfulGrant === undefined) throw new Error("Effectful orchestration requires an explicit M61 grant.");
      execute = (step, signal) => options.executor.effectfulBackground!(step, options.effectfulGrant, signal);
    }
    if (!execute) throw new Error(`Orchestration executor is unavailable for ${strategy}.`);
    if ((strategy === "PERSISTENT_READ" || strategy === "EFFECTFUL_BACKGROUND") && launchedBackgroundJobs >= limits.maxBackgroundJobs) {
      throw new Error(`Orchestration background-job limit of ${limits.maxBackgroundJobs} reached.`);
    }
    if (strategy === "DELEGATED_READ") {
      if (createdSubagents >= limits.maxSubagents) throw new Error(`Orchestration subagent limit of ${limits.maxSubagents} reached.`);
      createdSubagents += 1;
    }
    if (strategy === "PERSISTENT_READ" || strategy === "EFFECTFUL_BACKGROUND") launchedBackgroundJobs += 1;
    const claimed = (await options.store.claimRunnable([task.id]))[0]!;
    try {
      throwIfCancelled();
      return await applyResult(claimed, strategy, await execute(claimed, controller.signal));
    } catch (error: unknown) {
      if (error instanceof AgentRunCancelledError || controller.signal.aborted) {
        await block(claimed, "Orchestration cancelled before the step completed.");
        throw new AgentRunCancelledError();
      }
      return await applyResult(claimed, strategy, resultFor(claimed.id, strategy, "FAILED", error instanceof Error ? error.message : "Orchestration step failed.", limits));
    }
  };

  return {
    /** Runtime-only bounded summaries; callers must not persist nested transcripts in session state. */
    records(): OrchestrationResult[] { return records.map((entry) => ({ ...entry })); },
    cancel(): void { controller.abort(); },
    /** Releases the root-run timer and inherited abort listener after terminal orchestration cleanup. */
    close(): void { complete(); },
    async execute(requests: readonly OrchestrationRequest[]): Promise<OrchestrationResult[]> {
      throwIfCancelled();
        if (!Array.isArray(requests) || requests.length === 0 || requests.length > limits.maxSubagents) throw new Error(`Orchestration requires 1 to ${limits.maxSubagents} requested plan steps.`);
        if (new Set(requests.map((request) => request.taskId)).size !== requests.length) throw new Error("Orchestration requests must not repeat a plan step.");
        const tasks = await options.store.list();
        const byId = taskMap(tasks);
        const ready = new Set(runnable(tasks).map((task) => task.id));
        const selected = requests.map((request) => {
          const task = byId.get(request.taskId);
          if (!task || !ready.has(request.taskId)) throw new Error(`Plan step is not runnable: ${request.taskId}`);
          return { task, requested: request.strategy };
        }).sort((left, right) => tasks.findIndex((task) => task.id === left.task.id) - tasks.findIndex((task) => task.id === right.task.id));
        const defaultStrategy: OrchestrationStrategy = selected.length === 1 ? "LOCAL" : "PARALLEL_READ";
        const strategies = selected.map(({ requested }) => requested ?? defaultStrategy);
        if (strategies.some((strategy) => strategy === "PARALLEL_READ") && (selected.length < 2 || strategies.some((strategy) => strategy !== "PARALLEL_READ"))) {
          throw new Error("Parallel orchestration requires at least two independent read-only steps and cannot mix effectful work.");
        }
        if (strategies.every((strategy) => strategy === "PARALLEL_READ")) {
          if (!options.executor.parallel) throw new Error("Orchestration parallel executor is unavailable.");
          if (selected.length > limits.maxParallelism || createdSubagents + selected.length > limits.maxSubagents) throw new Error(`Orchestration parallel subagent limit of ${limits.maxSubagents} reached.`);
          createdSubagents += selected.length;
          const claimedById = new Map((await options.store.claimRunnable(selected.map(({ task }) => task.id))).map((task) => [task.id, task]));
          const claimed = selected.map(({ task }) => claimedById.get(task.id)!);
          try {
            throwIfCancelled();
            const output = await options.executor.parallel(claimed, controller.signal);
            if (!Array.isArray(output) || output.length !== claimed.length) throw new Error("Orchestration parallel executor returned an invalid result set.");
            const results: OrchestrationResult[] = [];
            for (let index = 0; index < output.length; index += 1) {
              results.push(await applyResult(claimed[index]!, "PARALLEL_READ", output[index]!));
            }
            return results;
          } catch (error: unknown) {
            if (error instanceof AgentRunCancelledError || controller.signal.aborted) {
              for (const task of claimed) await block(task, "Orchestration cancelled before the parallel step completed.");
              throw new AgentRunCancelledError();
            }
            const failed: OrchestrationResult[] = [];
            for (const task of claimed) failed.push(await applyResult(task, "PARALLEL_READ", resultFor(task.id, "PARALLEL_READ", "FAILED", error instanceof Error ? error.message : "Parallel orchestration failed.", limits)));
            return failed;
          }
        }
        const results: OrchestrationResult[] = [];
        for (let index = 0; index < selected.length; index += 1) results.push(await runSingle(selected[index]!.task, strategies[index]!));
        return results;
    },
    async reconcileBackground(taskIds: readonly string[]): Promise<OrchestrationResult[]> {
      throwIfCancelled();
        if (!options.executor.reconcileBackground) throw new Error("Orchestration background reconciliation is unavailable.");
        if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > limits.maxBackgroundJobs || new Set(taskIds).size !== taskIds.length) throw new Error(`Orchestration requires 1 to ${limits.maxBackgroundJobs} unique background plan steps to reconcile.`);
        const tasks = await options.store.list();
        const byId = taskMap(tasks);
        const results: OrchestrationResult[] = [];
        for (const id of taskIds) {
          const task = byId.get(id);
          if (!task || task.status !== "IN_PROGRESS") throw new Error(`Persistent plan step is not active: ${id}`);
          const raw = await options.executor.reconcileBackground(task, controller.signal);
          if (raw.status === "DETACHED") throw new Error("Background reconciliation must return a terminal status.");
          results.push(await applyResult(task, "PERSISTENT_READ", raw));
        }
        return results;
    },
  };
}

export type PlanOrchestrator = {
  execute(requests: readonly OrchestrationRequest[]): Promise<OrchestrationResult[]>;
  records(): OrchestrationResult[];
  cancel(): void;
  close(): void;
  reconcileBackground(taskIds: readonly string[]): Promise<OrchestrationResult[]>;
};

/** Re-evaluates the selected queue after each finished batch; it never retries a blocked or failed task. */
export async function executePlanQueue(orchestrator: PlanOrchestrator, store: PlanStore, requests: readonly OrchestrationRequest[]): Promise<OrchestrationResult[]> {
  const initial = await store.list();
  const initialIds = new Set(initial.map((task) => task.id));
  const seen = new Set<string>();
  for (const request of requests) {
    if (!request || typeof request.taskId !== "string" || !initialIds.has(request.taskId)) throw new Error("Orchestration queue task is invalid.");
    if (seen.has(request.taskId)) throw new Error("Orchestration queue contains duplicate task IDs.");
    seen.add(request.taskId);
  }
  const pending = [...requests].sort((left, right) => initial.findIndex((task) => task.id === left.taskId) - initial.findIndex((task) => task.id === right.taskId));
  const results: OrchestrationResult[] = [];
  while (pending.length > 0) {
    const readyIds = new Set(runnablePlanTasks(await store.list()).map((task) => task.id));
    const ready = pending.filter((request) => readyIds.has(request.taskId));
    if (ready.length === 0) throw new Error("Selected orchestration queue has no runnable work.");
    const batch = await orchestrator.execute(ready);
    results.push(...batch);
    const settled = new Set(batch.map((result) => result.taskId));
    for (let index = pending.length - 1; index >= 0; index -= 1) if (settled.has(pending[index]!.taskId)) pending.splice(index, 1);
  }
  return results;
}

export type CreatePlanOrchestrationToolsOptions = {
  resolveStore: () => PlanStore;
  createModel: () => AgentModel;
  tools: readonly AgentTool[];
  projectContext?: ProjectContext;
  skills?: SkillsContext;
  memory?: MemoryContext;
  getPlan?: () => Promise<DragonsPlan | undefined>;
  maxSubagents?: number;
  maxParallelism?: number;
};

function requestedTaskIds(input: unknown): string[] | ToolResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, output: "Expected an orchestration input object with only taskIds." };
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.taskIds) || record.taskIds.length === 0 || record.taskIds.some((id) => typeof id !== "string" || !id)) return { ok: false, output: "Expected one or more non-empty plan task IDs." };
  return [...record.taskIds] as string[];
}

function toolFailure(error: unknown): ToolResult {
  return { ok: false, output: error instanceof Error ? error.message : "Orchestration failed." };
}

function formatOrchestrationStatus(tasks: readonly DragonsPlanTask[]): string {
  const ready = runnable(tasks);
  if (ready.length === 0) return "No runnable plan steps for orchestration.";
  const strategy: OrchestrationStrategy = ready.length === 1 ? "DELEGATED_READ" : "PARALLEL_READ";
  return ready.map((task) => `${task.id} [${task.status}] ${strategy} ${task.title}`).join("\n");
}

/** Provider-visible orchestration remains approval-gated, bounded, and read-only below its own EXECUTE boundary. */
export function createPlanOrchestrationTools(options: CreatePlanOrchestrationToolsOptions): AgentTool[] {
  const limits = createLimits({ store: options.resolveStore(), executor: {}, maxSubagents: options.maxSubagents, maxParallelism: options.maxParallelism });
  return [{
    name: "orchestration_status",
    operation: "READ",
    description: "List deterministic currently runnable plan steps and their conservative read-only orchestration strategy. This does not execute work or grant permission.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(): Promise<ToolResult> {
      try { return { ok: true, output: formatOrchestrationStatus(await options.resolveStore().list()) }; }
      catch (error: unknown) { return toolFailure(error); }
    },
  }, {
    name: "orchestrate_runnable",
    operation: "EXECUTE",
    description: "Execute selected independent runnable plan steps as bounded fresh read-only delegated research. It never authorizes WRITE, EXECUTE child tools, MCP effects, or background effects.",
    inputSchema: { type: "object", properties: { taskIds: { type: "array", items: { type: "string" } } }, required: ["taskIds"], additionalProperties: false },
    async execute(input: unknown, executionOptions?: ToolExecutionOptions): Promise<ToolResult> {
      const taskIds = requestedTaskIds(input);
      if (!Array.isArray(taskIds)) return taskIds;
      const store = options.resolveStore();
      const single = createSubagentTool({ createModel: options.createModel, tools: options.tools, projectContext: options.projectContext, skills: options.skills, memory: options.memory, getPlan: options.getPlan, maxDepth: 1, signal: executionOptions?.signal });
      const parallel = createParallelSubagentTool({ createModel: options.createModel, tools: options.tools, projectContext: options.projectContext, skills: options.skills, memory: options.memory, getPlan: options.getPlan, maxChildren: limits.maxSubagents, maxConcurrency: limits.maxParallelism, signal: executionOptions?.signal });
      const orchestrator = createPlanOrchestrator({
        store,
        signal: executionOptions?.signal,
        maxSubagents: limits.maxSubagents,
        maxParallelism: limits.maxParallelism,
        executor: {
          async delegate(task, signal) {
            const result = await single.execute({ task: task.description }, { signal });
            return result.ok
              ? { taskId: task.id, strategy: "DELEGATED_READ", status: "COMPLETED", summary: "Read-only delegated investigation completed." }
              : { taskId: task.id, strategy: "DELEGATED_READ", status: "FAILED", summary: "Read-only delegated investigation failed." };
          },
          async parallel(tasks, signal) {
            const result = await parallel.execute({ tasks: tasks.map((task) => task.description) }, { signal });
            const failed = !result.ok || /Subagent failed:/i.test(result.output);
            return tasks.map((task) => failed
              ? { taskId: task.id, strategy: "PARALLEL_READ" as const, status: "FAILED" as const, summary: "Parallel read-only investigation failed." }
              : { taskId: task.id, strategy: "PARALLEL_READ" as const, status: "COMPLETED" as const, summary: "Parallel read-only investigation completed." });
          },
        },
      });
      try {
        const strategy: OrchestrationStrategy = taskIds.length === 1 ? "DELEGATED_READ" : "PARALLEL_READ";
        const results = await orchestrator.execute(taskIds.map((taskId) => ({ taskId, strategy })));
        return { ok: results.every((result) => result.status === "COMPLETED"), output: results.map((result) => `${result.taskId} ${result.strategy} ${result.status}`).join("\n") };
      } catch (error: unknown) {
        if (error instanceof AgentRunCancelledError || executionOptions?.signal?.aborted) throw error;
        return toolFailure(error);
      } finally {
        orchestrator.close();
      }
    },
  }];
}
