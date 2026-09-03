import { randomUUID } from "node:crypto";

import { AgentRunCancelledError, runAgent, type AgentModel } from "./agent.js";
import type { MemoryContext } from "./memory.js";
import type { DragonsPlan } from "./plan.js";
import type { ProjectContext } from "./project-context.js";
import type { SkillsContext } from "./skills.js";
import type { AgentEvent } from "./agent.js";
import type { AgentTool } from "./tools.js";
import type { RuntimeDiagnosticsRun } from "./diagnostics.js";

export const DEFAULT_MAX_BACKGROUND_TASK_PROMPT_CHARS = 4_000;
export const DEFAULT_MAX_BACKGROUND_TASK_TRANSCRIPT_CHARS = 8_000;
export const DEFAULT_MAX_BACKGROUND_TASK_REPORT_CHARS = 8_000;
export const DEFAULT_MAX_BACKGROUND_TASK_ERROR_CHARS = 2_000;
export const DEFAULT_MAX_BACKGROUND_TASK_TURNS = 8;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_BACKGROUND_TOOL_NAMES = new Set([
  "delegate_subagent",
  "start_background_task",
  "background_task_start",
]);

export type BackgroundTaskState = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Serializable task status only. Runtime handles are deliberately never exposed or persisted. */
export type BackgroundTask = {
  id: string;
  sessionId: string;
  prompt: string;
  state: BackgroundTaskState;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  transcript: string;
  report?: string;
  error?: string;
};

export type StartBackgroundTaskOptions = {
  sessionId: string;
  prompt: string;
  /** Must create a fresh provider/model instance for this isolated task. */
  createModel: () => AgentModel;
  /** Current process-local tool snapshot; only safe READ tools are retained. */
  tools: readonly AgentTool[];
  workingDirectory?: string;
  projectContext?: ProjectContext;
  skills?: SkillsContext;
  memory?: MemoryContext;
  /** Advisory snapshot only; no plan tools are retained. */
  plan?: DragonsPlan;
};

export type BackgroundTaskManagerOptions = {
  now?: () => Date;
  createId?: () => string;
  maxPromptCharacters?: number;
  maxTranscriptCharacters?: number;
  maxReportCharacters?: number;
  maxErrorCharacters?: number;
  maxTurns?: number;
  /** Called only after a background task has been accepted and created; no module-global task accounting. */
  onTaskStarted?: (task: BackgroundTask) => RuntimeDiagnosticsRun | undefined;
};

type RuntimeTask = {
  controller: AbortController;
  promise: Promise<void>;
};

type Limits = Required<Omit<BackgroundTaskManagerOptions, "now" | "createId" | "onTaskStarted">>;

function boundedText(value: string, maximum: number, kind: string): string {
  if (value.length <= maximum) return value;
  const marker = `[${kind} truncated; omitted ${value.length - maximum} characters]`;
  if (marker.length >= maximum) return value.slice(0, maximum);
  return `${value.slice(0, maximum - marker.length)}${marker}`;
}

function cloneSnapshot<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function isSafeUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function requiredPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer.`);
  return resolved;
}

function readOnlyTaskTools(tools: readonly AgentTool[]): AgentTool[] {
  return tools.filter((tool) => (
    tool.operation === "READ"
    && !FORBIDDEN_BACKGROUND_TOOL_NAMES.has(tool.name)
    && !tool.name.startsWith("plan_")
  ));
}

function cloneTask(task: BackgroundTask): BackgroundTask {
  return { ...task };
}

/**
 * Process-local explicit background work. It has no persistence API: tasks, abort handles,
 * transcripts, reports, and continuation are intentionally lost on process exit.
 */
export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly runtimes = new Map<string, RuntimeTask>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly limits: Limits;
  private readonly onTaskStarted?: (task: BackgroundTask) => RuntimeDiagnosticsRun | undefined;

  constructor(options: BackgroundTaskManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.onTaskStarted = options.onTaskStarted;
    this.limits = {
      maxPromptCharacters: requiredPositiveInteger(options.maxPromptCharacters, DEFAULT_MAX_BACKGROUND_TASK_PROMPT_CHARS, "Background task prompt limit"),
      maxTranscriptCharacters: requiredPositiveInteger(options.maxTranscriptCharacters, DEFAULT_MAX_BACKGROUND_TASK_TRANSCRIPT_CHARS, "Background task transcript limit"),
      maxReportCharacters: requiredPositiveInteger(options.maxReportCharacters, DEFAULT_MAX_BACKGROUND_TASK_REPORT_CHARS, "Background task report limit"),
      maxErrorCharacters: requiredPositiveInteger(options.maxErrorCharacters, DEFAULT_MAX_BACKGROUND_TASK_ERROR_CHARS, "Background task error limit"),
      maxTurns: requiredPositiveInteger(options.maxTurns, DEFAULT_MAX_BACKGROUND_TASK_TURNS, "Background task turn limit"),
    };
  }

  start(options: StartBackgroundTaskOptions): BackgroundTask {
    if (!isSafeUuid(options.sessionId)) throw new Error("Background task session ID is invalid.");
    if (typeof options.prompt !== "string" || !options.prompt.trim()) throw new Error("Background task prompt must be non-empty.");
    if (options.prompt.length > this.limits.maxPromptCharacters) throw new Error(`Background task prompt must be no longer than ${this.limits.maxPromptCharacters} characters.`);
    const id = this.createId();
    if (!isSafeUuid(id) || this.tasks.has(id)) throw new Error("Unable to create a unique background task ID.");

    const task: BackgroundTask = {
      id,
      sessionId: options.sessionId,
      prompt: options.prompt,
      state: "queued",
      createdAt: this.now().toISOString(),
      transcript: "",
    };
    const controller = new AbortController();
    this.tasks.set(id, task);
    const diagnostics = this.onTaskStarted?.(cloneTask(task));

    const runtime: RuntimeTask = {
      controller,
      promise: Promise.resolve().then(async () => {
        if (controller.signal.aborted || task.state === "cancelled") return;
        task.state = "running";
        task.startedAt = this.now().toISOString();
        try {
          const result = await runAgent({
            task: options.prompt,
            model: options.createModel(),
            tools: readOnlyTaskTools(options.tools),
            workingDirectory: options.workingDirectory,
            projectContext: cloneSnapshot(options.projectContext),
            skills: cloneSnapshot(options.skills),
            memory: cloneSnapshot(options.memory),
            plan: cloneSnapshot(options.plan),
            maxTurns: this.limits.maxTurns,
            signal: controller.signal,
            diagnostics,
            onEvent: (event: AgentEvent) => {
              if (event.type === "message_delta" && !controller.signal.aborted) {
                task.transcript = boundedText(`${task.transcript}${event.text}`, this.limits.maxTranscriptCharacters, "background transcript");
              }
            },
          });
          if (controller.signal.aborted) return;
          task.report = boundedText(result.finalText, this.limits.maxReportCharacters, "background report");
          task.state = "completed";
          task.completedAt = this.now().toISOString();
        } catch (error: unknown) {
          if (error instanceof AgentRunCancelledError || controller.signal.aborted) return;
          task.error = boundedText(error instanceof Error ? error.message : "Background task failed.", this.limits.maxErrorCharacters, "background error");
          task.state = "failed";
          task.completedAt = this.now().toISOString();
        }
      }),
    };
    runtime.promise = runtime.promise.finally(() => this.runtimes.delete(id));
    this.runtimes.set(id, runtime);
    return cloneTask(task);
  }

  list(sessionId?: string): BackgroundTask[] {
    if (sessionId !== undefined && !isSafeUuid(sessionId)) return [];
    return [...this.tasks.values()]
      .filter((task) => sessionId === undefined || task.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map(cloneTask);
  }

  show(id: string): BackgroundTask | undefined {
    return isSafeUuid(id) ? (this.tasks.has(id) ? cloneTask(this.tasks.get(id)!) : undefined) : undefined;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.state === "completed" || task.state === "failed" || task.state === "cancelled") return false;
    task.state = "cancelled";
    task.completedAt = this.now().toISOString();
    this.runtimes.get(id)?.controller.abort();
    return true;
  }

  cancelForSession(sessionId: string): number {
    if (!isSafeUuid(sessionId)) return 0;
    return this.list(sessionId).reduce((count, task) => count + (this.cancel(task.id) ? 1 : 0), 0);
  }
}
