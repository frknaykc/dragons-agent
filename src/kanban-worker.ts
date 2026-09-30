import type { KanbanBoard, KanbanTask } from "./kanban.js";

export type KanbanWorkerRunOptions = {
  board: KanbanBoard;
  /** Trusted host identity, never parsed from the task title or model output. */
  actor: string;
  id: string;
  revision: number;
  /** Trusted host callback. It must enforce its own model/tool authorization boundary. */
  run: (task: KanbanTask, signal: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  maxRunMs?: number;
};

/** One claim and one execution in this process; no retries, transcripts, approvals or worker launch. */
export async function runKanbanWorker(options: KanbanWorkerRunOptions): Promise<KanbanTask> {
  const maxRunMs = options.maxRunMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 3_600_000)
    throw new Error("Invalid Kanban worker deadline.");
  if (options.signal?.aborted) throw new Error("Kanban worker run cancelled.");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), maxRunMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const check = (): void => {
    if (deadline.signal.aborted) throw new Error("Kanban worker run timed out.");
    if (signal.aborted) throw new Error("Kanban worker run cancelled.");
  };
  try {
    check();
    const { task, token } = await options.board.claimWorker(options.actor, options.id, options.revision);
    try {
      check();
      await options.run(task, signal);
      check();
      return await options.board.finishWorker(options.actor, options.id, task.revision, token);
    } catch (error: unknown) {
      try {
        await options.board.releaseWorker(options.actor, options.id, task.revision, token);
      } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], "Kanban worker claim cleanup failed; inspect ownership before recovery.");
      }
      check();
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}
