import { createChatGPTAuthService, type ChatGPTAuthService } from "./codex-auth.js";
import { createCodexAgentModel, DEFAULT_CODEX_MODEL } from "./codex.js";
import { createOpenAIAgentModel, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { createProviderRegistry, type ProviderRegistry } from "./registry.js";

export type BuiltInProviderRegistryOptions = {
  chatgptAuth?: Pick<ChatGPTAuthService, "credentials">;
};

/** Registers the two pre-Phase-16 adapters without moving their wire protocols into the agent loop. */
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
  ]);
}
