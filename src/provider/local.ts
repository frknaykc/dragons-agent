import type { AgentModel, AgentRequest, AgentResponse, AgentTextDeltaHandler } from "../agent.js";
import { ProviderCompatibilityError, providerCompatibilityError } from "./compatibility.js";
import { createOpenRouterAgentModel } from "./openrouter.js";

/** Ollama's documented OpenAI-compatible endpoint; vLLM-compatible HTTPS endpoints are also supported. */
export const LOCAL_MODEL_API_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:7b";

export type LocalAgentModelOptions = {
  fetchImpl?: typeof fetch;
  model?: string;
  /** HTTP is permitted only for literal loopback endpoints; remote endpoints require HTTPS. */
  baseUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localContinuationForRequest(value: AgentRequest["continuationState"]): AgentRequest["continuationState"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.kind !== "local-chat-completions" || value.adapterVersion !== 1 || !Array.isArray(value.messages)) {
    throw providerCompatibilityError("local", "protocol_drift");
  }
  return { ...value, kind: "openrouter-chat-completions" } as AgentRequest["continuationState"];
}

function localContinuationForResponse(value: AgentResponse["continuationState"]): AgentResponse["continuationState"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.kind !== "openrouter-chat-completions" || value.adapterVersion !== 1 || !Array.isArray(value.messages)) {
    throw providerCompatibilityError("local", "malformed_response");
  }
  return { ...value, kind: "local-chat-completions" } as AgentResponse["continuationState"];
}

/**
 * A credential-free OpenAI-compatible local-runtime adapter. It intentionally
 * reuses the proven chat-completions stream and tool transcript boundary while
 * never forwarding an Authorization header to either local or remote endpoints.
 */
export function createLocalAgentModel(options: LocalAgentModelOptions = {}): AgentModel {
  const model = createOpenRouterAgentModel({
    fetchImpl: options.fetchImpl,
    model: options.model ?? DEFAULT_LOCAL_MODEL,
    baseUrl: options.baseUrl ?? LOCAL_MODEL_API_BASE_URL,
    sendAuthorization: false,
    allowInsecureLoopback: true,
  });

  return {
    async respond(request: AgentRequest, onTextDelta?: AgentTextDeltaHandler): Promise<AgentResponse> {
      try {
        const response = await model.respond({
          ...request,
          continuationState: localContinuationForRequest(request.continuationState),
        }, onTextDelta);
        return {
          ...response,
          ...(response.continuationState === undefined ? {} : { continuationState: localContinuationForResponse(response.continuationState) }),
        };
      } catch (error: unknown) {
        if (error instanceof ProviderCompatibilityError) {
          throw providerCompatibilityError("local", error.compatibilityKind, error.status);
        }
        throw error;
      }
    },
  };
}
