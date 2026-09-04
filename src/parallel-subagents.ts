import {
  AgentRunCancelledError,
  runAgent,
  type AgentModel,
} from "./agent.js";
import type { MemoryContext } from "./memory.js";
import type { DragonsPlan } from "./plan.js";
import type { ProjectContext } from "./project-context.js";
import type { SkillsContext } from "./skills.js";
import type { AgentTool, ToolExecutionOptions, ToolResult } from "./tools.js";

export const PARALLEL_SUBAGENT_TOOL_NAME = "delegate_parallel_subagents";
export const DEFAULT_MAX_PARALLEL_SUBAGENTS = 4;
export const DEFAULT_MAX_PARALLEL_SUBAGENT_CONCURRENCY = 2;
export const DEFAULT_MAX_PARALLEL_SUBAGENT_TASK_CHARS = 4_000;
export const DEFAULT_MAX_PARALLEL_SUBAGENT_REPORT_CHARS = 4_000;
export const DEFAULT_MAX_PARALLEL_SUBAGENT_OUTPUT_CHARS = 8_000;
export const DEFAULT_MAX_PARALLEL_SUBAGENT_TURNS = 8;
export const DEFAULT_MAX_PARALLEL_SUBAGENT_TOOL_CALLS = 16;

export type CreateParallelSubagentToolOptions = {
  createModel: () => AgentModel;
  tools: readonly AgentTool[];
  projectContext?: ProjectContext;
  skills?: SkillsContext;
  memory?: MemoryContext;
  plan?: DragonsPlan;
  getPlan?: () => Promise<DragonsPlan | undefined>;
  maxChildren?: number;
  maxConcurrency?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  maxTaskCharacters?: number;
  maxReportCharacters?: number;
  maxOutputCharacters?: number;
  signal?: AbortSignal;
};

type Limits = Required<Omit<CreateParallelSubagentToolOptions, "createModel" | "tools" | "projectContext" | "skills" | "memory" | "plan" | "getPlan" | "signal">>;

function boundedText(value: string, maximum: number, kind: string): string {
  if (value.length <= maximum) return value;
  const marker = `[${kind} truncated; omitted ${value.length - maximum} characters]`;
  return marker.length >= maximum ? value.slice(0, maximum) : `${value.slice(0, maximum - marker.length)}${marker}`;
}

function cloneSnapshot<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function requiredInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return resolved;
}

function validTasks(input: unknown, limits: Limits): string[] | ToolResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, output: "Expected a parallel subagent input object with only tasks." };
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.tasks) || record.tasks.length === 0 || record.tasks.length > limits.maxChildren) {
    return { ok: false, output: `Expected tasks as an array containing 1 to ${limits.maxChildren} focused tasks.` };
  }
  if (record.tasks.some((task) => typeof task !== "string" || !task.trim() || task.length > limits.maxTaskCharacters)) {
    return { ok: false, output: `Every parallel subagent task must be non-empty and no longer than ${limits.maxTaskCharacters} characters.` };
  }
  return [...record.tasks] as string[];
}

function formatReports(reports: readonly string[]): string {
  return `Parallel subagent reports:\n${reports.map((report, index) => `[${index + 1}] ${report}`).join("\n\n")}`;
}

function toolFailure(error: unknown, maximum: number): ToolResult {
  const message = error instanceof Error ? error.message : "Unknown failure.";
  return { ok: false, output: boundedText(`Parallel subagents failed: ${message}`, maximum, "parallel subagent failure") };
}

/**
 * Approval-gated bounded fan-out. Each child receives a fresh model and advisory snapshots,
 * but only READ tools. Reports preserve input order regardless of completion order.
 */
export function createParallelSubagentTool(options: CreateParallelSubagentToolOptions): AgentTool {
  const limits: Limits = {
    maxChildren: requiredInteger(options.maxChildren, DEFAULT_MAX_PARALLEL_SUBAGENTS, DEFAULT_MAX_PARALLEL_SUBAGENTS, "Parallel subagent child limit"),
    maxConcurrency: requiredInteger(options.maxConcurrency, DEFAULT_MAX_PARALLEL_SUBAGENT_CONCURRENCY, DEFAULT_MAX_PARALLEL_SUBAGENTS, "Parallel subagent concurrency limit"),
    maxTurns: requiredInteger(options.maxTurns, DEFAULT_MAX_PARALLEL_SUBAGENT_TURNS, DEFAULT_MAX_PARALLEL_SUBAGENT_TURNS, "Parallel subagent turn limit"),
    maxToolCalls: requiredInteger(options.maxToolCalls, DEFAULT_MAX_PARALLEL_SUBAGENT_TOOL_CALLS, DEFAULT_MAX_PARALLEL_SUBAGENT_TOOL_CALLS, "Parallel subagent tool-call limit"),
    maxTaskCharacters: requiredInteger(options.maxTaskCharacters, DEFAULT_MAX_PARALLEL_SUBAGENT_TASK_CHARS, DEFAULT_MAX_PARALLEL_SUBAGENT_TASK_CHARS, "Parallel subagent task limit"),
    maxReportCharacters: requiredInteger(options.maxReportCharacters, DEFAULT_MAX_PARALLEL_SUBAGENT_REPORT_CHARS, DEFAULT_MAX_PARALLEL_SUBAGENT_REPORT_CHARS, "Parallel subagent report limit"),
    maxOutputCharacters: requiredInteger(options.maxOutputCharacters, DEFAULT_MAX_PARALLEL_SUBAGENT_OUTPUT_CHARS, DEFAULT_MAX_PARALLEL_SUBAGENT_OUTPUT_CHARS, "Parallel subagent output limit"),
  };
  if (limits.maxConcurrency > limits.maxChildren) throw new Error("Parallel subagent concurrency limit cannot exceed its child limit.");

  return {
    name: PARALLEL_SUBAGENT_TOOL_NAME,
    operation: "EXECUTE",
    description: "Delegate up to four independent advisory investigations to fresh read-only subagents with a concurrency limit of two. Each delegation remains subject to explicit authorization.",
    inputSchema: {
      type: "object",
      properties: { tasks: { type: "array", items: { type: "string" }, description: "Independent focused investigations, reported in this order." } },
      required: ["tasks"],
      additionalProperties: false,
    },
    async execute(input: unknown, executionOptions?: ToolExecutionOptions): Promise<ToolResult> {
      const tasks = validTasks(input, limits);
      if (!Array.isArray(tasks)) return tasks;
      const signal = executionOptions?.signal ?? options.signal;
      const childTools = options.tools.filter((tool) => tool.operation === "READ" && tool.name !== PARALLEL_SUBAGENT_TOOL_NAME && tool.name !== "delegate_subagent" && !tool.name.startsWith("plan_"));
      try {
        const plan = options.getPlan ? await options.getPlan() : options.plan;
        const reports = new Array<string>(tasks.length);
        let nextIndex = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            if (signal?.aborted) throw new AgentRunCancelledError();
            const index = nextIndex;
            nextIndex += 1;
            if (index >= tasks.length) return;
            try {
              const result = await runAgent({
                task: tasks[index]!,
                model: options.createModel(),
                tools: childTools,
                projectContext: cloneSnapshot(options.projectContext),
                skills: cloneSnapshot(options.skills),
                memory: cloneSnapshot(options.memory),
                plan: cloneSnapshot(plan),
                maxTurns: limits.maxTurns,
                maxToolCalls: limits.maxToolCalls,
                signal,
              });
              reports[index] = boundedText(result.finalText, limits.maxReportCharacters, "parallel subagent report");
            } catch (error: unknown) {
              if (error instanceof AgentRunCancelledError || signal?.aborted) throw new AgentRunCancelledError();
              reports[index] = boundedText(`Subagent failed: ${error instanceof Error ? error.message : "Unknown failure."}`, limits.maxReportCharacters, "parallel subagent failure");
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(limits.maxConcurrency, tasks.length) }, worker));
        return { ok: true, output: boundedText(formatReports(reports), limits.maxOutputCharacters, "parallel subagent reports") };
      } catch (error: unknown) {
        if (error instanceof AgentRunCancelledError || signal?.aborted) throw new AgentRunCancelledError();
        return toolFailure(error, limits.maxOutputCharacters);
      }
    },
  };
}
