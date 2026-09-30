import type { DragonsRuntime, RuntimeRunHandle } from "./runtime.js";
import { SessionLoop, type SessionLoopConfig } from "./session-loop.js";

export type RuntimeSessionLoopOptions = {
  runtime: Pick<DragonsRuntime, "status" | "sendUserInput" | "resolveAuthorization">;
  config: SessionLoopConfig;
  /** Process-local output; a renderer must not receive an unbounded transcript. */
  onResult?: (sessionId: string, text: string) => void;
  onError: (error: unknown) => void;
  maxRunMs?: number;
  now?: () => number;
};

/** Bind a session-local timer to the runtime's restricted, context-preserving run path. */
export function createRuntimeSessionLoop(options: RuntimeSessionLoopOptions): SessionLoop {
  const maxRunMs = options.maxRunMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 3_600_000)
    throw new Error("Invalid session loop run deadline.");
  return new SessionLoop({
    config: options.config,
    onError: options.onError,
    now: options.now,
    isBusy: async (sessionId) => (await options.runtime.status({ sessionId })).activeRunId !== undefined,
    run: async (sessionId, prompt, signal) => {
      signal.throwIfAborted();
      let handle: RuntimeRunHandle | undefined;
      let expired = false;
      const cancel = () => handle?.cancel();
      const timer = setTimeout(() => { expired = true; cancel(); }, maxRunMs);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        handle = await options.runtime.sendUserInput({ sessionId, content: prompt, readOnly: true });
        if (signal.aborted || expired) handle.cancel();
        // Drain the bounded event queue even when the caller only wants a final result.
        // Any unexpected approval is denied, not left pending in an unattended run.
        const events = (async () => {
          for await (const event of handle.events) {
            if (event.type === "approval_requested") options.runtime.resolveAuthorization({ runId: handle.id, approvalId: event.approvalId, decision: "deny" });
          }
        })();
        const [result] = await Promise.all([handle.result, events]);
        if (expired) throw new Error("Session loop run timed out.");
        signal.throwIfAborted();
        options.onResult?.(sessionId, result.finalText);
      } catch (error: unknown) {
        handle?.cancel();
        if (expired && !signal.aborted) throw new Error("Session loop run timed out.");
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    },
  });
}
