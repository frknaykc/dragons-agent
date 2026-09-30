import type { DragonsRuntime } from "./runtime.js";
import { createFilePersistentGoalStore, goalWorkspaceDirectory } from "./persistent-goal-store.js";
import { createRuntimePersistentGoalManager } from "./persistent-goals-runtime.js";
import type { PersistentGoal } from "./persistent-goals.js";

export type PersistentGoalCommand =
  | { action: "add"; sessionId: string; objective: string; criterion: string; maxTurns: number; deadlineAt: string }
  | { action: "list"; sessionId: string }
  | { action: "status" | "run" | "pause" | "resume" | "complete" | "interrupt"; sessionId: string; id: string };

/** Host-owned goals only; callers cannot select a store root or grant model authority. */
export function createPersistentGoalService(runtime: DragonsRuntime, profileGoalRoot: string, workingDirectory: string) {
  let report: string | undefined;
  let closed = false;
  let controller: AbortController | undefined;
  let pending: Promise<string> | undefined;
  const store = createFilePersistentGoalStore(goalWorkspaceDirectory(profileGoalRoot, workingDirectory));
  // A model response alone cannot complete a goal; the user must explicitly verify it.
  const manager = createRuntimePersistentGoalManager({ runtime, store,
    evaluateCompletion: (_goal, result) => { report = result.finalText.slice(0, 8_000); return false; } });
  const summary = (goal: PersistentGoal) => `${goal.id}: ${goal.state}; turns: ${goal.turnsUsed}/${goal.maxTurns}; deadline: ${goal.deadlineAt}`;
  const owned = async (id: string, sessionId: string) => {
    const goal = await manager.load(id);
    return goal?.sessionId === sessionId && goal.workingDirectory === workingDirectory ? goal : undefined;
  };
  return {
    async command(command: PersistentGoalCommand): Promise<string> {
      if (closed) throw new Error("Persistent goals are closed.");
      const status = await runtime.status({ sessionId: command.sessionId });
      if (closed || !status.session || status.session.id !== command.sessionId || status.session.workingDirectory !== workingDirectory)
        throw new Error("Persistent goal session is unavailable or belongs to another workspace.");
      if (command.action === "add") {
        const goal = await manager.create({ sessionId: command.sessionId, workingDirectory, objective: command.objective,
          criterion: command.criterion, maxTurns: command.maxTurns, deadlineAt: command.deadlineAt });
        return `Goal created: ${summary(goal)}. No run is scheduled.`;
      }
      if (command.action === "list") {
        const goals = (await manager.list()).filter((goal) => goal.sessionId === command.sessionId && goal.workingDirectory === workingDirectory);
        return goals.length ? goals.map(summary).join("\n") : "No goals for this session.";
      }
      const goal = await owned(command.id, command.sessionId);
      if (!goal) return "Goal not found in this session.";
      if (command.action === "status") return `${summary(goal)}; criterion: ${goal.criterion}`;
      if (command.action === "run") {
        if (pending) throw new Error("A persistent goal turn is already running.");
        controller = new AbortController();
        report = undefined;
        const current = controller;
        const operation = (async () => {
          const next = await manager.advance(goal.id, current.signal);
          if (closed) throw new Error("Persistent goals are closed.");
          return next ? `${summary(next)}; report: ${report ?? "none"}. Verify the criterion yourself before /goal complete.` : "Goal is not ready to run.";
        })();
        pending = operation;
        try { return await operation; }
        finally { if (pending === operation) pending = undefined; if (controller === current) controller = undefined; }
      }
      const next = command.action === "pause" ? await manager.pause(goal.id)
        : command.action === "resume" ? await manager.resume(goal.id)
        : command.action === "complete" ? await manager.complete(goal.id)
        : await manager.markInterrupted(goal.id);
      return next ? summary(next) : "Goal cannot make that transition.";
    },
    async close(): Promise<void> {
      closed = true;
      controller?.abort();
      try { await pending; } catch { /* Cancellation and runtime errors stay private. */ }
    },
  };
}
