import type { KanbanBoard, KanbanTask } from "./kanban.js";
import { launchKanbanWorker, type LaunchKanbanWorkerOptions } from "./kanban-worker-process.js";
import { isSafeProfileName } from "./profiles.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KanbanLaneTask = { id: string; revision: number };
export type KanbanWorkerLaneOptions = Omit<LaunchKanbanWorkerOptions, "id" | "revision"> & {
  board: KanbanBoard;
  /** Host-selected order, never selected or expanded from model output. */
  tasks: readonly KanbanLaneTask[];
  /** Trusted host seam for deterministic tests; production uses the separate Local child. */
  run?: (request: LaunchKanbanWorkerOptions) => Promise<void>;
};

function ready(task: KanbanTask | undefined, actor: string, revision: number): task is KanbanTask {
  return task !== undefined && task.assignee === actor && task.revision === revision
    && task.status === "todo" && task.progress === 0 && !task.handoffTo && !task.worker;
}

/** Explicit, bounded, sequential lane. The board remains the authority for each atomic child claim. */
export async function runKanbanWorkerLane(options: KanbanWorkerLaneOptions): Promise<string[]> {
  const { tasks, board, profile, signal } = options;
  if (!isSafeProfileName(profile) || !Array.isArray(tasks) || tasks.length < 1 || tasks.length > 8)
    throw new Error("Invalid Kanban worker lane plan.");
  const ids = new Set<string>();
  for (const item of tasks) {
    if (!item || typeof item.id !== "string" || !ID.test(item.id)
      || !Number.isSafeInteger(item.revision) || item.revision < 0 || ids.has(item.id))
      throw new Error("Invalid Kanban worker lane plan.");
    ids.add(item.id);
  }
  if (signal?.aborted) throw new Error("Kanban worker lane cancelled.");
  // Check the whole requested order before launching anything; do not discover or auto-run unrelated tasks.
  const snapshot = new Map((await board.list(profile)).map((task) => [task.id, task]));
  const earlier = new Set<string>();
  for (const item of tasks) {
    const task = snapshot.get(item.id);
    if (!ready(task, profile, item.revision)
      || task.dependsOn.some((id) => snapshot.get(id)?.status !== "done" && !earlier.has(id)))
      throw new Error("Kanban worker lane plan is stale or not ready.");
    earlier.add(item.id);
  }
  const completed: string[] = [];
  for (const item of tasks) {
    if (signal?.aborted) throw new Error("Kanban worker lane cancelled; inspect remaining tasks.");
    // Recheck immediately before each child, including dependencies resolved by earlier children.
    const current = new Map((await board.list(profile)).map((task) => [task.id, task]));
    const task = current.get(item.id);
    if (!ready(task, profile, item.revision) || task.dependsOn.some((id) => current.get(id)?.status !== "done"))
      throw new Error("Kanban worker lane changed; inspect remaining tasks.");
    try {
      await (options.run ?? launchKanbanWorker)({ workingDirectory: options.workingDirectory,
        configPath: options.configPath, profile, id: item.id, revision: item.revision,
        ...(signal ? { signal } : {}), ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }) });
    } catch {
      // A child might be blocked or still claimed after termination. Never replay or expose provider errors.
      throw new Error("Kanban worker lane stopped; inspect the task and remaining plan before recovery.");
    }
    const settled = await board.get(profile, item.id);
    if (settled?.status !== "done" || settled.progress !== 100 || settled.worker
      || settled.revision !== item.revision + 2)
      throw new Error("Kanban worker lane stopped without a completed task; inspect ownership.");
    completed.push(item.id);
  }
  return completed;
}
