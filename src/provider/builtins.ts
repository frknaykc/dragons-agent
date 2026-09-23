import { BUILTIN_MODEL_CATALOGUES } from "./model-catalogue.js";
import type { AgentModel } from "../agent.js";
import { createApiKeyAuth, type ApiKeyAuth, type ApiKeyPoolAuth, type ApiKeyProvider } from "./api-key-auth.js";
import { OPENAI_REASONING_MODELS } from "./reasoning.js";
import { createChatGPTAuthService, type ChatGPTAuthService } from "./codex-auth.js";
import { createCodexAgentModel, DEFAULT_CODEX_MODEL } from "./codex.js";
import { createOpenAIAgentModel, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { createAnthropicAgentModel, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { createGeminiAgentModel, DEFAULT_GEMINI_MODEL } from "./gemini.js";
import { createOpenRouterAgentModel, DEFAULT_OPENROUTER_MODEL } from "./openrouter.js";
import { createLocalAgentModel, DEFAULT_LOCAL_MODEL } from "./local.js";
import { getProviderRequestFailure } from "./compatibility.js";
import { createProviderRegistry, type ProviderRegistry } from "./registry.js";

export type BuiltInProviderRegistryOptions = {
  /** false selects environment-only auth when no profile namespace is available. */
  apiKeyAuth?: Pick<ApiKeyAuth, "credentials"> & { forRun?: ApiKeyPoolAuth["forRun"] } | false;
  /** Credential-slot references selected before registry creation; secret values are never config data. */
  apiKeySlots?: Partial<Record<ApiKeyProvider, string>>;
  chatgptAuth?: Pick<ChatGPTAuthService, "credentials">;
  /** Explicit endpoint configuration for the credential-free local runtime. */
  localEndpoint?: string;
};

/** Registers built-in adapters without moving their wire protocols into the agent loop. */
export function createBuiltInProviderRegistry(options: BuiltInProviderRegistryOptions = {}): ProviderRegistry {
  const configuredAuth = options.apiKeyAuth ?? createApiKeyAuth("default");
  if (options.apiKeySlots && (configuredAuth === false || !configuredAuth.forRun)) {
    throw new Error("Configured API-key slots require a slot-aware credential service.");
  }
  const selection = options.apiKeySlots === undefined ? undefined : { ...options.apiKeySlots };
  const secured = (provider: ApiKeyProvider, factory: (key?: string) => AgentModel): AgentModel => {
    // A registry outlives runs. Pin credentials (and failures) only to this model.
    const auth = configuredAuth === false ? false : configuredAuth.forRun?.(selection) ?? configuredAuth;
    // Without a profile root there is no safe credential namespace to consult.
    // Preserve synchronous environment-key validation before local state setup.
    if (auth === false) return factory();
    let model: Promise<AgentModel> | undefined;
    return { async respond(request, delta) {
      request.signal?.throwIfAborted();
      model ??= auth.credentials(provider).then(factory);
      const adapter = await model;
      request.signal?.throwIfAborted();
      try { return await adapter.respond(request, delta); }
      catch (error) {
        const failure = getProviderRequestFailure(error);
        if (failure?.status === 429 && "reportRateLimit" in auth && typeof auth.reportRateLimit === "function") {
          auth.reportRateLimit(provider, failure.retryAfterMilliseconds);
        }
        throw error;
      }
    } };
  };
  return createProviderRegistry([
    {
      id: "openai-api",
      label: "OpenAI API",
      defaultModel: DEFAULT_OPENAI_MODEL,
      modelCatalogue: BUILTIN_MODEL_CATALOGUES["openai-api"]!,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: false,
      },
      reasoningModels: OPENAI_REASONING_MODELS,
      createModel: ({ model, reasoning }) => secured("openai-api", (key) => createOpenAIAgentModel(model ?? DEFAULT_OPENAI_MODEL, reasoning, key)),
    },
    {
      id: "chatgpt",
      label: "ChatGPT Subscription (Experimental)",
      defaultModel: DEFAULT_CODEX_MODEL,
      modelCatalogue: BUILTIN_MODEL_CATALOGUES["chatgpt"]!,
      credentialRequirement: "oauth",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: false,
      },
      reasoningModels: OPENAI_REASONING_MODELS,
      createModel: ({ model, write, reasoning }) => createCodexAgentModel({
        reasoning,
        credentials: options.chatgptAuth?.credentials ?? createChatGPTAuthService({ write }).credentials,
        model: model ?? DEFAULT_CODEX_MODEL,
      }),
    },
    {
      id: "anthropic",
      label: "Anthropic",
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
      modelCatalogue: BUILTIN_MODEL_CATALOGUES["anthropic"]!,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: true,
      },
      createModel: ({ model }) => secured("anthropic", (apiKey) => createAnthropicAgentModel({ model: model ?? DEFAULT_ANTHROPIC_MODEL, apiKey })),
    },
    {
      id: "gemini",
      label: "Google Gemini",
      defaultModel: DEFAULT_GEMINI_MODEL,
      modelCatalogue: BUILTIN_MODEL_CATALOGUES["gemini"]!,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: true,
      },
      createModel: ({ model }) => secured("gemini", (apiKey) => createGeminiAgentModel({ model: model ?? DEFAULT_GEMINI_MODEL, apiKey })),
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      defaultModel: DEFAULT_OPENROUTER_MODEL,
      modelCatalogue: BUILTIN_MODEL_CATALOGUES["openrouter"]!,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: true,
      },
      createModel: ({ model }) => secured("openrouter", (apiKey) => createOpenRouterAgentModel({ model: model ?? DEFAULT_OPENROUTER_MODEL, apiKey })),
    },
    {
      id: "local",
      label: "Local Model (OpenAI-compatible)",
      defaultModel: DEFAULT_LOCAL_MODEL,
      credentialRequirement: "none",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: false,
      },
      createModel: ({ model }) => createLocalAgentModel({
        model: model ?? DEFAULT_LOCAL_MODEL,
        ...(options.localEndpoint === undefined ? {} : { baseUrl: options.localEndpoint }),
      }),
    },
  ]);
}
