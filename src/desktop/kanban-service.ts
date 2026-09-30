import { runInteractiveKanbanCommand, type InteractiveKanbanCommand } from "../cli/kanban-commands.js";
import { inspectKanbanLock, recoverAbandonedKanbanLock, type KanbanBoard, type KanbanTask } from "../kanban.js";
import { launchKanbanWorker } from "../kanban-worker-process.js";
import { runKanbanWorkerLane, type KanbanLaneTask } from "../kanban-worker-lane.js";

export type DesktopKanbanCommand = InteractiveKanbanCommand
  | { action: "lock_status" }
  | { action: "lock_recover" }
  | { action: "lock_confirm" }
  | { action: "worker_start"; id: string; revision: number }
  | { action: "worker_lane"; tasks: KanbanLaneTask[] }
  | { action: "worker_confirm" };

/** Host-owned confirmation state; the renderer never receives claim credentials or selects an actor/path. */
export function createDesktopKanbanService(board: KanbanBoard, actor: string, directory: string,
  workingDirectory: string, configPath: string) {
  let closed = false;
  let activeWorker: AbortController | undefined;
  let pending: { token: string; expiresAt: number } | undefined;
  let pendingWorker: { id: string; revision: number; pid: number; expiresAt: number } | undefined;
  const inFlight = new Set<Promise<string>>();

  async function perform(command: DesktopKanbanCommand): Promise<string> {
    if (command.action === "worker_start" || command.action === "worker_lane") {
      if (activeWorker) throw new Error("A Kanban worker is already running in this Desktop host.");
      const controller = new AbortController();
      activeWorker = controller;
      try {
        if (command.action === "worker_lane") {
          const done = await runKanbanWorkerLane({ board, workingDirectory, configPath, profile: actor,
            tasks: command.tasks, signal: controller.signal });
          if (closed) throw new Error("Desktop Kanban is closed.");
          return `Kanban worker lane completed ${done.length} tasks: ${done.join(", ")}.`;
        }
        const task = await board.get(actor, command.id);
        if (closed || controller.signal.aborted) throw new Error("Desktop Kanban is closed.");
        if (!task || task.assignee !== actor || task.revision !== command.revision
          || task.status !== "todo" || task.progress !== 0 || task.worker || task.handoffTo)
          throw new Error("Kanban task is not idle, assigned to this profile or has changed.");
        await launchKanbanWorker({ workingDirectory, configPath, profile: actor, id: command.id,
          revision: command.revision, signal: controller.signal });
        if (closed) throw new Error("Desktop Kanban is closed.");
        return `Kanban worker completed task ${command.id}; inspect /kanban status ${command.id}.`;
      } finally { if (activeWorker === controller) activeWorker = undefined; }
    }
    if (command.action === "lock_status" || command.action === "lock_recover") {
      pending = undefined;
      const lock = await inspectKanbanLock(directory);
      if (closed) throw new Error("Desktop Kanban is closed.");
      if (!lock) return "No Kanban lock for this workspace.";
      const owner = `Kanban lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}.`;
      if (command.action === "lock_status") return `${owner} No recovery attempted.`;
      pending = { token: lock.token, expiresAt: Date.now() + 60_000 };
      return `${owner} Only recover if this process has stopped. Type /kanban lock confirm RECOVER within 60 seconds to confirm.`;
    }
    if (command.action === "lock_confirm") {
      const candidate = pending;
      pending = undefined;
      if (!candidate || Date.now() > candidate.expiresAt) return "Kanban lock recovery not pending; run /kanban lock recover first.";
      return await recoverAbandonedKanbanLock(directory, candidate.token)
        ? "Kanban lock recovered." : "No Kanban lock for this workspace.";
    }
    if (command.action === "worker_recover") {
      pendingWorker = undefined;
      const task = await board.get(actor, command.id);
      if (closed) throw new Error("Desktop Kanban is closed.");
      if (!task || task.assignee !== actor || task.revision !== command.revision
        || !task.worker || task.worker.pid !== command.pid)
        throw new Error("Kanban worker claim is not assigned to this profile or has changed.");
      pendingWorker = { id: command.id, revision: command.revision, pid: command.pid, expiresAt: Date.now() + 60_000 };
      return `Kanban worker claim: task ${task.id} revision ${task.revision}, PID ${task.worker.pid} on ${JSON.stringify(task.worker.host)}. Only recover if this process has stopped. Type /kanban worker confirm RECOVER within 60 seconds to confirm.`;
    }
    if (command.action === "worker_confirm") {
      const candidate = pendingWorker;
      pendingWorker = undefined;
      if (!candidate || Date.now() > candidate.expiresAt)
        return "Kanban worker recovery not pending; run /kanban worker recover first.";
      const task = await board.recoverWorker(actor, candidate.id, candidate.revision, candidate.pid);
      return `Kanban task ${task.id} revision ${task.revision} blocked; worker claim recovered. No work resumed.`;
    }
    return runInteractiveKanbanCommand(board, actor, command);
  }

  return {
    list(): Promise<KanbanTask[]> {
      if (closed) return Promise.reject(new Error("Desktop Kanban is closed."));
      const task = board.list(actor);
      // Track reads as well as writes so host disposal does not leave a board request in flight.
      const read = task.then(() => "", () => "");
      inFlight.add(read);
      void read.then(() => inFlight.delete(read));
      return task;
    },
    command(input: DesktopKanbanCommand): Promise<string> {
      if (closed) return Promise.reject(new Error("Desktop Kanban is closed."));
      const task = perform(input);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task), () => inFlight.delete(task));
      return task;
    },
    async close(): Promise<void> {
      closed = true;
      activeWorker?.abort();
      pending = undefined;
      pendingWorker = undefined;
      await Promise.allSettled([...inFlight]);
      pending = undefined;
      pendingWorker = undefined;
    },
  };
}
