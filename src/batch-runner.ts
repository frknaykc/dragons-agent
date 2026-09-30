import { AgentRunCancelledError, runAgent, type AgentModel } from "./agent.js";
import type { BatchRecord } from "./batch-queue.js";
import type { AgentTool } from "./tools.js";

export type BatchQueue = Pick<ReturnType<typeof import("./batch-queue.js").createFileBatchQueue>, "load" | "reserve" | "finish">;

export type BatchRunOptions = {
  queue: BatchQueue;
  id: string;
  revision: number;
  /** A trusted host supplies a fresh model for each task; no provider/session continuation is reused. */
  createModel: () => AgentModel;
  /** Only trusted, built-in READ tools should be supplied. Never pass MCP/plugin tools here. */
  tools: readonly AgentTool[];
  signal?: AbortSignal;
  maxRunMs?: number;
};

function check(signal: AbortSignal, timeout: AbortSignal): void {
  if (timeout.aborted) throw new Error("Batch run timed out.");
  if (signal.aborted) throw new AgentRunCancelledError();
}

function boundedReport(text: string): string {
  if (text.length <= 2_000) return text;
  const marker = `[truncated; omitted ${text.length - 2_000} characters]`;
  return `${text.slice(0, 2_000 - marker.length)}${marker}`;
}

/** Explicit, sequential batch execution; queue checkpoints are durable but no automatic resume is attempted. */
export async function runBatch(options: BatchRunOptions): Promise<BatchRecord> {
  if (!options || !options.queue || typeof options.createModel !== "function" || !Array.isArray(options.tools)
    || !Number.isSafeInteger(options.revision) || options.revision < 0) throw new Error("Invalid batch runner options.");
  const maxRunMs = options.maxRunMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 3_600_000) throw new Error("Invalid batch run deadline.");
  if (options.signal?.aborted) throw new AgentRunCancelledError();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), maxRunMs);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const tools = options.tools.filter((tool) => tool.operation === "READ" && !tool.name.startsWith("plan_") && tool.name !== "delegate_subagent" && tool.name !== "delegate_parallel_subagents");
  try {
    check(signal, deadline.signal);
    let current = await options.queue.load(options.id);
    if (!current || current.revision !== options.revision) throw new Error("Batch changed before run.");
    if (current.tasks.some((task) => task.state === "running")) throw new Error("Batch has a running task; inspect before recovery.");
    for (;;) {
      check(signal, deadline.signal);
      const claimed = await options.queue.reserve(current.id, current.revision);
      if (!claimed) return current;
      const task = claimed.tasks.find((entry) => entry.state === "running");
      if (!task) throw new Error("Batch reservation has no running task.");
      try {
        check(signal, deadline.signal);
        const result = await runAgent({
          task: task.prompt,
          model: options.createModel(),
          tools,
          programmaticTools: false,
          maxTurns: 4,
          maxToolCalls: 8,
          signal,
        });
        check(signal, deadline.signal);
        current = await options.queue.finish(claimed.id, task.id, claimed.revision, "completed", boundedReport(result.finalText), task.owner?.token);
      } catch (error: unknown) {
        const state = signal.aborted ? "interrupted" : "failed";
        try { await options.queue.finish(claimed.id, task.id, claimed.revision, state, undefined, task.owner?.token); }
        catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], "Batch checkpoint cleanup failed; inspect state before recovery.");
        }
        check(signal, deadline.signal);
        throw error;
      }
    }
  } finally { clearTimeout(timer); }
}
