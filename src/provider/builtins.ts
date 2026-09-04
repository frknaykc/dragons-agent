import { createChatGPTAuthService, type ChatGPTAuthService } from "./codex-auth.js";
import { createCodexAgentModel, DEFAULT_CODEX_MODEL } from "./codex.js";
import { createOpenAIAgentModel, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { createAnthropicAgentModel, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { createGeminiAgentModel, DEFAULT_GEMINI_MODEL } from "./gemini.js";
import { createProviderRegistry, type ProviderRegistry } from "./registry.js";

export type BuiltInProviderRegistryOptions = {
  chatgptAuth?: Pick<ChatGPTAuthService, "credentials">;
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
  ]);
}
