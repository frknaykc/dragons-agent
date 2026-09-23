import type { AgentModel, AgentRequest } from "../agent.js";
import { getProviderRequestFailure, isAbortError } from "./compatibility.js";

export type ProviderFallbackTarget = Readonly<{ provider: string; model: string }>;
export type ProviderFallbackConfiguration = Readonly<{
  enabled: boolean;
  targets: readonly ProviderFallbackTarget[];
}>;

/** The host must atomically adopt this identity for session state, diagnostics and
 * subsequent model construction BEFORE resolving true. No hook means fail closed.
 * Never persist a fallback response under the originally selected identity.
 */
export type AdoptFallbackIdentity = (target: ProviderFallbackTarget) => Promise<boolean>;

function fresh(request: AgentRequest): boolean {
  return request.conversationResponseId === undefined && request.previousResponseId === undefined
    && request.continuationState === undefined && request.toolOutputs.length === 0;
}

/** One wrapper per model lifetime; retries only the first respond, never runAgent. */
export function createFallbackModel(primary: AgentModel, targets: readonly ProviderFallbackTarget[],
  create: (target: ProviderFallbackTarget) => AgentModel, adopt?: AdoptFallbackIdentity,
  outputStarted: () => boolean = () => false): AgentModel {
  let selected = primary;
  let called = false;
  let busy = false;
  let blocked = false;
  return {
    async respond(request, onTextDelta) {
      if (busy || blocked) throw new Error("Fallback model cannot be reused after an incomplete identity transition or concurrently.");
      const eligible = !called && fresh(request);
      called = true;
      busy = true;
      let streamed = false;
      const delta = (text: string) => { streamed = true; onTextDelta?.(text); };
      let next = 0;
      try {
        while (true) {
          try {
            return await selected.respond(request, delta);
          } catch (error) {
            const failure = getProviderRequestFailure(error);
            if (!eligible || streamed || outputStarted() || request.signal?.aborted || isAbortError(error)
              || failure?.phase !== "pre-stream" || failure.source !== "http" || !failure.httpRetryable
              || next >= targets.length) throw error;
            // Recheck because adapters receive the request object by reference.
            if (!fresh(request)) throw error;
            if (!adopt) throw new Error("Provider fallback requires host identity adoption; session persistence is not fallback-safe.");
            blocked = true;
            const target = targets[next++]!;
            if (await adopt(target) !== true) throw new Error("Provider fallback identity adoption was denied.");
            if (request.signal?.aborted) throw error;
            selected = create(target);
            blocked = false;
          }
        }
      } finally {
        busy = false;
      }
    },
  };
}
