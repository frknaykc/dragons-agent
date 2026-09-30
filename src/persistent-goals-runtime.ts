import { PersistentGoalManager, type PersistentGoal, type PersistentGoalManagerOptions, type PersistentGoalStore } from "./persistent-goals.js";
import type { DragonsRuntime, RuntimeRunHandle, RuntimeRunResult } from "./runtime.js";

export type RuntimePersistentGoalOptions = {
  runtime: Pick<DragonsRuntime, "status" | "sendUserInput" | "resolveAuthorization">;
  store: PersistentGoalStore;
  /** Independent trusted-host verdict. Model claims in finalText are untrusted data. */
  evaluateCompletion: (goal: Readonly<PersistentGoal>, result: RuntimeRunResult, signal: AbortSignal) => boolean | Promise<boolean>;
  now?: PersistentGoalManagerOptions["now"];
  createId?: PersistentGoalManagerOptions["createId"];
};

/** Bind explicit goal turns to the runtime's authoritative built-in READ-only path. */
export function createRuntimePersistentGoalManager(options: RuntimePersistentGoalOptions): PersistentGoalManager {
  if (!options || typeof options.evaluateCompletion !== "function") throw new Error("A trusted goal evaluator is required.");
  return new PersistentGoalManager({
    store: options.store, now: options.now, createId: options.createId,
    evaluateCompletion: (goal, result, signal) => options.evaluateCompletion(goal, result as RuntimeRunResult, signal),
    async runReadOnly(goal, signal): Promise<RuntimeRunResult> {
      signal.throwIfAborted();
      const status = await options.runtime.status({ sessionId: goal.sessionId });
      signal.throwIfAborted();
      if (!status.session || status.session.id !== goal.sessionId || status.session.workingDirectory !== goal.workingDirectory)
        throw new Error("Persistent goal session belongs to a different workspace.");
      if (status.activeRunId) throw new Error("Persistent goal session already has an active run.");
      let handle: RuntimeRunHandle | undefined;
      const cancel = () => handle?.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        handle = await options.runtime.sendUserInput({ sessionId: goal.sessionId,
          content: `Work toward the user's goal using only READ operations.\nObjective: ${goal.objective}\nCompletion criterion: ${goal.criterion}`,
          readOnly: true });
        if (signal.aborted) handle.cancel();
        const events = (async () => {
          for await (const event of handle.events) {
            if (event.type === "approval_requested") {
              options.runtime.resolveAuthorization({ runId: handle.id, approvalId: event.approvalId, decision: "deny" });
              throw new Error("Unexpected authorization approval in a persistent goal run.");
            }
            if (event.type === "tool_activity" && event.operation !== "READ")
              throw new Error("Unexpected effectful tool in a persistent goal run.");
          }
        })();
        const [result] = await Promise.all([handle.result, events]);
        signal.throwIfAborted();
        return result;
      } catch (error: unknown) {
        handle?.cancel();
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  });
}
