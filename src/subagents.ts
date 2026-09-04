import {
  AgentRunCancelledError,
  runAgent,
  type AgentModel,
  type ToolAuthorizationDecision,
} from "./agent.js";
import type { MemoryContext } from "./memory.js";
import type { DragonsPlan } from "./plan.js";
import type { ProjectContext } from "./project-context.js";
import type { SkillsContext } from "./skills.js";
import type { AgentTool, ToolExecutionOptions, ToolResult } from "./tools.js";

export const SUBAGENT_TOOL_NAME = "delegate_subagent";
export const DEFAULT_MAX_SUBAGENT_TASK_CHARS = 4_000;
export const DEFAULT_MAX_SUBAGENT_REPORT_CHARS = 8_000;
/** Lower than the parent agent's default cap of 20 turns. */
export const DEFAULT_MAX_SUBAGENT_TURNS = 8;

export type CreateSubagentToolOptions = {
  /** Must create a new provider/model instance for every child invocation. */
  createModel: () => AgentModel;
  /** Parent tool snapshot. Only READ tools are retained for the child. */
  tools: readonly AgentTool[];
  projectContext?: ProjectContext;
  skills?: SkillsContext;
  memory?: MemoryContext;
  plan?: DragonsPlan;
  /** Reads the current parent plan exactly once immediately before child creation. */
  getPlan?: () => Promise<DragonsPlan | undefined>;
  maxTurns?: number;
  maxTaskCharacters?: number;
  maxReportCharacters?: number;
  /** Maximum child depth including the first delegated child; defaults to one. */
  maxDepth?: number;
  /** Explicit approval seam for each nested delegation; absent means nesting is unavailable. */
  authorizeNested?: (request: { name: string; task: string; depth: number }) => ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
  signal?: AbortSignal;
};

function boundedText(value: string, maximum: number, kind: string): string {
  if (value.length <= maximum) return value;
  const marker = `[${kind} truncated; omitted ${value.length - maximum} characters]`;
  if (marker.length >= maximum) return value.slice(0, maximum);
  return `${value.slice(0, maximum - marker.length)}${marker}`;
}

function toolFailure(error: unknown, maximum: number): ToolResult {
  const message = error instanceof Error ? error.message : "Subagent failed.";
  return { ok: false, output: boundedText(`Subagent failed: ${message}`, maximum, "subagent failure") };
}

function validTask(input: unknown, maximum: number): string | ToolResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, output: "Expected a subagent input object with only task." };
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.task !== "string" || !record.task.trim()) {
    return { ok: false, output: "Expected a non-empty task and no other subagent input fields." };
  }
  if (record.task.length > maximum) return { ok: false, output: `Subagent task must be no longer than ${maximum} characters.` };
  return record.task;
}

function cloneSnapshot<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Creates one approval-gated parent tool that runs an isolated, advisory-only child.
 * The child starts with a new model and no parent continuation, transcript, or approvals.
 */
export function createSubagentTool(options: CreateSubagentToolOptions): AgentTool {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_SUBAGENT_TURNS;
  const maxTaskCharacters = options.maxTaskCharacters ?? DEFAULT_MAX_SUBAGENT_TASK_CHARS;
  const maxReportCharacters = options.maxReportCharacters ?? DEFAULT_MAX_SUBAGENT_REPORT_CHARS;
  const maxDepth = options.maxDepth ?? 1;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > DEFAULT_MAX_SUBAGENT_TURNS) throw new Error(`Subagent maxTurns must be an integer from 1 to ${DEFAULT_MAX_SUBAGENT_TURNS}.`);
  if (!Number.isSafeInteger(maxTaskCharacters) || maxTaskCharacters < 1) throw new Error("Subagent task character limit must be a positive integer.");
  if (!Number.isSafeInteger(maxReportCharacters) || maxReportCharacters < 1) throw new Error("Subagent report character limit must be a positive integer.");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 2) throw new Error("Subagent maximum depth must be an integer from 1 to 2.");

  const createAtDepth = (depth: number): AgentTool => ({
    name: SUBAGENT_TOOL_NAME,
    operation: "EXECUTE",
    description: depth < maxDepth && options.authorizeNested
      ? "Delegate a bounded advisory investigation to one fresh, read-only in-process subagent. One explicitly authorized nested advisory delegation is available."
      : "Delegate a bounded advisory investigation to one fresh, read-only in-process subagent. The subagent cannot modify files, run shell commands, or delegate further.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The focused investigation to delegate." } },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input: unknown, executionOptions?: ToolExecutionOptions): Promise<ToolResult> {
      const task = validTask(input, maxTaskCharacters);
      if (typeof task !== "string") return task;
      const signal = executionOptions?.signal ?? options.signal;
      // The plan is passed as a static advisory snapshot, never as a live plan tool.
      const childTools = options.tools.filter((tool) => tool.operation === "READ" && tool.name !== SUBAGENT_TOOL_NAME && !tool.name.startsWith("plan_"));
      if (depth < maxDepth && options.authorizeNested) childTools.push(createAtDepth(depth + 1));
      try {
        const plan = options.getPlan ? await options.getPlan() : options.plan;
        const result = await runAgent({
          task,
          model: options.createModel(),
          tools: childTools,
          projectContext: cloneSnapshot(options.projectContext),
          skills: cloneSnapshot(options.skills),
          memory: cloneSnapshot(options.memory),
          plan: cloneSnapshot(plan),
          maxTurns,
          signal,
          authorize: options.authorizeNested
            ? async (request) => request.name === SUBAGENT_TOOL_NAME && await options.authorizeNested!({ name: request.name, task: request.arguments, depth })
            : undefined,
        });
        return { ok: true, output: boundedText(`Subagent report:\n${result.finalText}`, maxReportCharacters, "subagent report") };
      } catch (error: unknown) {
        if (error instanceof AgentRunCancelledError || signal?.aborted) throw error;
        return toolFailure(error, maxReportCharacters);
      }
    },
  });

  return createAtDepth(1);
}
