import { createChatGPTAuthService, type ChatGPTAuthService } from "./codex-auth.js";
import { createCodexAgentModel, DEFAULT_CODEX_MODEL } from "./codex.js";
import { createOpenAIAgentModel, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { createAnthropicAgentModel, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { createGeminiAgentModel, DEFAULT_GEMINI_MODEL } from "./gemini.js";
import { createOpenRouterAgentModel, DEFAULT_OPENROUTER_MODEL } from "./openrouter.js";
import { createLocalAgentModel, DEFAULT_LOCAL_MODEL } from "./local.js";
import { createProviderRegistry, type ProviderRegistry } from "./registry.js";

export type BuiltInProviderRegistryOptions = {
  chatgptAuth?: Pick<ChatGPTAuthService, "credentials">;
  /** Explicit endpoint configuration for the credential-free local runtime. */
  localEndpoint?: string;
};

/** Registers built-in adapters without moving their wire protocols into the agent loop. */
export function createBuiltInProviderRegistry(options: BuiltInProviderRegistryOptions = {}): ProviderRegistry {
  return createProviderRegistry([
    {
      id: "openai-api",
      label: "OpenAI API",
      defaultModel: DEFAULT_OPENAI_MODEL,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: false,
      },
      createModel: ({ model }) => createOpenAIAgentModel(model ?? DEFAULT_OPENAI_MODEL),
    },
    {
      id: "chatgpt",
      label: "ChatGPT Subscription (Experimental)",
      defaultModel: DEFAULT_CODEX_MODEL,
      credentialRequirement: "oauth",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: false,
      },
      createModel: ({ model, write }) => createCodexAgentModel({
        credentials: options.chatgptAuth?.credentials ?? createChatGPTAuthService({ write }).credentials,
        model: model ?? DEFAULT_CODEX_MODEL,
      }),
    },
    {
      id: "anthropic",
      label: "Anthropic",
      defaultModel: DEFAULT_ANTHROPIC_MODEL,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: true,
      },
      createModel: ({ model }) => createAnthropicAgentModel({ model: model ?? DEFAULT_ANTHROPIC_MODEL }),
    },
    {
      id: "gemini",
      label: "Google Gemini",
      defaultModel: DEFAULT_GEMINI_MODEL,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: true,
      },
      createModel: ({ model }) => createGeminiAgentModel({ model: model ?? DEFAULT_GEMINI_MODEL }),
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      defaultModel: DEFAULT_OPENROUTER_MODEL,
      credentialRequirement: "api-key",
      capabilities: {
        streaming: true,
        toolCalls: true,
        toolResultContinuation: true,
        usageMetadata: true,
      },
      createModel: ({ model }) => createOpenRouterAgentModel({ model: model ?? DEFAULT_OPENROUTER_MODEL }),
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
