import type { DragonsRuntime, RuntimeRunHandle } from "./runtime.js";

/** Optional read-only active-run observation; the handle must not transfer execution ownership. */
export type ObservableRuntime = DragonsRuntime & {
  observeRun(sessionId: string): RuntimeRunHandle | undefined;
};

export function observeRuntimeRun(runtime: DragonsRuntime, sessionId: string): RuntimeRunHandle | undefined {
  const candidate = runtime as Partial<ObservableRuntime>;
  return typeof candidate.observeRun === "function" ? candidate.observeRun(sessionId) : undefined;
}
