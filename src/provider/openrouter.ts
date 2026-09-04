import type {
  AgentModel,
  AgentRequest,
  AgentResponse,
  AgentTextDeltaHandler,
  AgentUsage,
  ToolCall,
} from "../agent.js";
import { formatAdvisoryContextForInstructions } from "../advisory-context.js";
import { classifyProviderError, retryProviderRequest } from "../retry.js";
import type { AgentTool } from "../tools.js";
import {
  classifyProviderHttpFailure,
  providerCompatibilityError,
  ProviderCompatibilityError,
  type ProviderCompatibilityKind,
} from "./compatibility.js";

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4.1-mini";
const MAX_CONVERSATION_ITEMS = 256;
const MAX_CONVERSATION_CHARACTERS = 256_000;
const MAX_CURRENT_TURN_CHARACTERS = 48_000;
const MAX_TOOL_ARGUMENT_CHARACTERS = 64_000;
const MAX_TOOL_CALLS_PER_RESPONSE = 64;
const MAX_ERROR_BODY_CHARACTERS = 8_192;
const MAX_ERROR_BODY_BYTES = MAX_ERROR_BODY_CHARACTERS * 4;
const MAX_SSE_FRAME_CHARACTERS = 64_000;
const MAX_SSE_CHUNK_BYTES = 256_000;

type OpenRouterFunction = { name: string; arguments: string };
type OpenRouterToolCall = { id: string; type: "function"; function: OpenRouterFunction };
type OpenRouterMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
};
type OpenRouterContinuationState = {
  kind: "openrouter-chat-completions";
  adapterVersion: 1;
  messages: OpenRouterMessage[];
};
type PendingToolCall = { callId: string; name: string };
type PartialToolCall = { id?: string; type?: string; name?: string; arguments: string };

export type OpenRouterAgentModelOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedNonEmptyString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function serializedCharacterCount(value: unknown): number {
  return JSON.stringify(value).length;
}

function resolveApiKey(value: string | undefined): string {
  const apiKey = value?.trim() ?? process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set. Export it before running Dragons Agent.");
  return apiKey;
}

function toTool(tool: AgentTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function recordProviderDiagnostic(request: AgentRequest, kind: ProviderCompatibilityKind): void {
  if (kind !== "cancelled" && kind !== "invalid_request") request.onProviderDiagnostic?.(kind);
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isToolCall(value: unknown): value is OpenRouterToolCall {
  if (!isRecord(value) || !boundedNonEmptyString(value.id) || value.type !== "function" || !isRecord(value.function)) return false;
  return Reflect.ownKeys(value).every((key) => key === "id" || key === "type" || key === "function")
    && Reflect.ownKeys(value.function).every((key) => key === "name" || key === "arguments")
    && boundedNonEmptyString(value.function.name)
    && typeof value.function.arguments === "string"
    && value.function.arguments.length <= MAX_TOOL_ARGUMENT_CHARACTERS;
}

function isMessage(value: unknown): value is OpenRouterMessage {
  if (!isRecord(value) || !["user", "assistant", "tool"].includes(value.role as string) || typeof value.content !== "string") return false;
  if (Reflect.ownKeys(value).some((key) => key !== "role" && key !== "content" && key !== "tool_calls" && key !== "tool_call_id")) return false;
  if (value.tool_calls !== undefined && (!Array.isArray(value.tool_calls) || value.tool_calls.length < 1 || value.tool_calls.length > MAX_TOOL_CALLS_PER_RESPONSE || !value.tool_calls.every(isToolCall))) return false;
  if (value.tool_call_id !== undefined && !boundedNonEmptyString(value.tool_call_id)) return false;
  if (value.role === "assistant") return value.tool_call_id === undefined;
  if (value.role === "tool") return value.tool_calls === undefined && value.tool_call_id !== undefined;
  return value.tool_calls === undefined && value.tool_call_id === undefined;
}

function parsedArguments(arguments_: string): boolean {
  try {
    const parsed = JSON.parse(arguments_) as unknown;
    return isRecord(parsed);
  } catch {
    return false;
  }
}

function hasValidConversation(messages: readonly OpenRouterMessage[]): boolean {
  let priorRole: OpenRouterMessage["role"] | undefined;
  let pending: OpenRouterToolCall[] | undefined;
  let responseIndex = 0;
  for (const message of messages) {
    if (message.role === "user") {
      if (priorRole !== undefined && (priorRole !== "assistant" || pending)) return false;
    } else if (message.role === "assistant") {
      if (priorRole !== "user" && priorRole !== "tool") return false;
      const calls = message.tool_calls ?? [];
      const ids = new Set<string>();
      if (calls.some((call) => ids.has(call.id) || !parsedArguments(call.function.arguments) || (ids.add(call.id), false))) return false;
      pending = calls.length === 0 ? undefined : calls;
      responseIndex = 0;
    } else {
      if ((priorRole !== "assistant" && priorRole !== "tool") || !pending || message.tool_call_id !== pending[responseIndex]?.id) return false;
      responseIndex += 1;
      if (responseIndex === pending.length) pending = undefined;
    }
    priorRole = message.role;
  }
  return messages.length > 0 && priorRole === "assistant" && pending === undefined;
}

function restoreConversation(value: AgentRequest["continuationState"]): OpenRouterMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.kind !== "openrouter-chat-completions" || value.adapterVersion !== 1 || !Array.isArray(value.messages)
    || value.messages.length > MAX_CONVERSATION_ITEMS || !value.messages.every(isMessage) || !hasValidConversation(value.messages as OpenRouterMessage[])) {
    throw providerCompatibilityError("openrouter", "protocol_drift");
  }
  try {
    const serialized = JSON.stringify(value.messages);
    if (serialized.length > MAX_CONVERSATION_CHARACTERS) throw new Error("conversation is too large");
    return JSON.parse(serialized) as OpenRouterMessage[];
  } catch {
    throw providerCompatibilityError("openrouter", "malformed_response");
  }
}

function completedAssistant(messages: readonly OpenRouterMessage[]): number {
  return messages.findIndex((message) => message.role === "assistant" && message.tool_calls === undefined);
}

function boundConversation(messages: readonly OpenRouterMessage[], reserve = 0): OpenRouterMessage[] {
  let bounded = [...messages];
  while (bounded.length > MAX_CONVERSATION_ITEMS || serializedCharacterCount(bounded) + reserve > MAX_CONVERSATION_CHARACTERS) {
    const complete = completedAssistant(bounded);
    if (complete < 0 || complete === bounded.length - 1) throw providerCompatibilityError("openrouter", reserve ? "invalid_request" : "malformed_response");
    bounded = bounded.slice(complete + 1);
  }
  return bounded;
}

function continuationState(messages: readonly OpenRouterMessage[]): OpenRouterContinuationState {
  return { kind: "openrouter-chat-completions", adapterVersion: 1, messages: structuredClone([...messages]) };
}

async function parseSse(response: Response, onChunk: (chunk: Record<string, unknown>) => void, signal?: AbortSignal): Promise<boolean> {
  if (!response.body) throw providerCompatibilityError("openrouter", "malformed_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sawDone = false;
  const cancelReader = (): void => { void reader.cancel(); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const consume = (block: string): void => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      if (sawDone) throw providerCompatibilityError("openrouter", "protocol_drift");
      sawDone = true;
      return;
    }
    if (sawDone) throw providerCompatibilityError("openrouter", "protocol_drift");
    try {
      const chunk = JSON.parse(data) as unknown;
      if (!isRecord(chunk)) throw new Error("invalid stream chunk");
      onChunk(chunk);
    } catch (error: unknown) {
      if (error instanceof ProviderCompatibilityError) throw error;
      throw providerCompatibilityError("openrouter", "malformed_response");
    }
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (!value) {
        if (done) break;
        throw providerCompatibilityError("openrouter", "malformed_response");
      }
      if (value.byteLength > MAX_SSE_CHUNK_BYTES) throw providerCompatibilityError("openrouter", "malformed_response");
      const decoded = decoder.decode(value, { stream: !done });
      if (buffered.length + decoded.length > MAX_SSE_FRAME_CHARACTERS) throw providerCompatibilityError("openrouter", "malformed_response");
      buffered += decoded;
      const blocks = buffered.split(/\r?\n\r?\n/);
      buffered = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
      if (done) break;
    }
    if (buffered.trim()) consume(buffered);
    return sawDone;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
  }
}

async function boundedErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;
  try {
    while (body.length < MAX_ERROR_BODY_CHARACTERS && bytesRead < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) break;
      if (bytesRead + value.byteLength > MAX_ERROR_BODY_BYTES) break;
      bytesRead += value.byteLength;
      const decoded = decoder.decode(value, { stream: true });
      body += decoded.slice(0, MAX_ERROR_BODY_CHARACTERS - body.length);
    }
    if (body.length < MAX_ERROR_BODY_CHARACTERS) body += decoder.decode().slice(0, MAX_ERROR_BODY_CHARACTERS - body.length);
    return body;
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function openRouterFailureKind(status: number, body: string): ProviderCompatibilityKind {
  if (status === 400 && /(?:tool|function).{0,80}(?:unsupported|not supported|does not support|unavailable)|(?:unsupported|not supported|does not support|unavailable).{0,80}(?:tool|function)/i.test(body)) {
    return "tool_unsupported";
  }
  return classifyProviderHttpFailure(status, body);
}

function safeProviderError(request: AgentRequest, error: unknown): ProviderCompatibilityError {
  const compatibility = error instanceof ProviderCompatibilityError
    ? error
    : providerCompatibilityError("openrouter", classifyProviderError(error));
  recordProviderDiagnostic(request, compatibility.compatibilityKind);
  return compatibility;
}

function endpointFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export function createOpenRouterAgentModel(options: OpenRouterAgentModelOptions = {}): AgentModel {
  const apiKey = resolveApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_OPENROUTER_MODEL;
  const baseUrl = options.baseUrl ?? OPENROUTER_API_BASE_URL;
  if (!boundedNonEmptyString(model, 256)) throw new Error("OpenRouter model must be a bounded non-empty string.");
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("OpenRouter API base URL must be a valid HTTPS URL.");
  }
  if (parsedBaseUrl.protocol !== "https:" || parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new Error("OpenRouter API base URL must be a credential-free HTTPS URL.");
  }

  const messages: OpenRouterMessage[] = [];
  let lastToolCalls: PendingToolCall[] = [];
  let lastResponseId: string | undefined;
  let initialized = false;
  let hasUncommittedRestoredConversation = false;

  return {
    async respond(request: AgentRequest, onTextDelta?: AgentTextDeltaHandler): Promise<AgentResponse> {
      let resumed = false;
      if (!initialized) {
        const restored = restoreConversation(request.continuationState);
        if (restored) {
          messages.splice(0, messages.length, ...restored);
          resumed = true;
          hasUncommittedRestoredConversation = true;
        }
        initialized = true;
      }

      let nextMessages = [...messages];
      if (request.previousResponseId) {
        if (!lastResponseId || request.previousResponseId !== lastResponseId || lastToolCalls.length === 0
          || request.toolOutputs.length !== lastToolCalls.length
          || new Set(request.toolOutputs.map((output) => output.callId)).size !== request.toolOutputs.length) {
          throw providerCompatibilityError("openrouter", "protocol_drift");
        }
        const expected = new Map(lastToolCalls.map((call) => [call.callId, call]));
        if (request.toolOutputs.some((output) => !expected.has(output.callId))) throw providerCompatibilityError("openrouter", "protocol_drift");
        const toolMessages = request.toolOutputs.map((output) => ({
          role: "tool" as const,
          tool_call_id: output.callId,
          content: output.output,
        }));
        if (serializedCharacterCount(toolMessages) > MAX_CURRENT_TURN_CHARACTERS) throw providerCompatibilityError("openrouter", "invalid_request");
        nextMessages.push(...toolMessages);
      } else {
        if (serializedCharacterCount(request.task) > MAX_CURRENT_TURN_CHARACTERS) throw providerCompatibilityError("openrouter", "invalid_request");
        const message = { role: "user" as const, content: request.task };
        if (request.conversationResponseId || resumed || hasUncommittedRestoredConversation) nextMessages.push(message);
        else nextMessages = [message];
      }
      nextMessages = boundConversation(nextMessages, MAX_CURRENT_TURN_CHARACTERS);

      const body: Record<string, unknown> = {
        model,
        messages: nextMessages,
        stream: true,
        stream_options: { include_usage: true },
        parallel_tool_calls: false,
      };
      if (request.tools.length > 0) body.tools = request.tools.map(toTool);
      const instructions = formatAdvisoryContextForInstructions(request);
      if (instructions) body.messages = [{ role: "system", content: instructions }, ...nextMessages];

      let response: Response;
      try {
        response = await retryProviderRequest(async () => {
          const candidate = await fetchImpl(endpointFor(parsedBaseUrl.toString()), {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: request.signal,
          });
          if (candidate.status === 429 || candidate.status >= 500 || candidate.status === 408 || candidate.status === 409 || candidate.status === 425) {
            await candidate.body?.cancel();
            throw providerCompatibilityError("openrouter", classifyProviderHttpFailure(candidate.status), candidate.status);
          }
          return candidate;
        }, { signal: request.signal, onRetry: request.onProviderRetry });
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        throw safeProviderError(request, error);
      }
      if (!response.ok) {
        const kind = openRouterFailureKind(response.status, await boundedErrorBody(response));
        recordProviderDiagnostic(request, kind);
        throw providerCompatibilityError("openrouter", kind, response.status);
      }

      let responseId = "";
      let text = "";
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let totalTokens: number | undefined;
      let finished = false;
      let finishReason = "";
      let sawChoice = false;
      let modelTurnCharacters = 0;
      let toolArgumentCharacters = 0;
      const partialCalls = new Map<number, PartialToolCall>();
      try {
        const sawDone = await parseSse(response, (chunk) => {
          const usage = chunk.usage;
          if (usage !== undefined) {
            if (!isRecord(usage)) throw providerCompatibilityError("openrouter", "malformed_response");
            inputTokens = usageNumber(usage.prompt_tokens) ?? inputTokens;
            outputTokens = usageNumber(usage.completion_tokens) ?? outputTokens;
            totalTokens = usageNumber(usage.total_tokens) ?? totalTokens;
          }
          const choices = chunk.choices;
          if (finished) {
            if (choices === undefined || (Array.isArray(choices) && choices.length === 0)) return;
            throw providerCompatibilityError("openrouter", "protocol_drift");
          }
          if (!Array.isArray(choices) || choices.length !== 1 || !isRecord(choices[0])) throw providerCompatibilityError("openrouter", "malformed_response");
          const choice = choices[0];
          if (choice.index !== 0 || !isRecord(choice.delta)) throw providerCompatibilityError("openrouter", "malformed_response");
          const id = chunk.id;
          if (!boundedNonEmptyString(id)) throw providerCompatibilityError("openrouter", "malformed_response");
          if (responseId && responseId !== id) throw providerCompatibilityError("openrouter", "protocol_drift");
          responseId = id;
          sawChoice = true;
          if (choice.delta.content !== undefined && choice.delta.content !== null) {
            if (typeof choice.delta.content !== "string") throw providerCompatibilityError("openrouter", "malformed_response");
            const length = serializedCharacterCount({ content: choice.delta.content });
            if (modelTurnCharacters + length > MAX_CURRENT_TURN_CHARACTERS) throw providerCompatibilityError("openrouter", "malformed_response");
            modelTurnCharacters += length;
            text += choice.delta.content;
            onTextDelta?.(choice.delta.content);
          }
          if (choice.delta.tool_calls !== undefined) {
            if (!Array.isArray(choice.delta.tool_calls) || choice.delta.tool_calls.length > MAX_TOOL_CALLS_PER_RESPONSE) throw providerCompatibilityError("openrouter", "malformed_response");
            for (const rawCall of choice.delta.tool_calls) {
              if (!isRecord(rawCall)) throw providerCompatibilityError("openrouter", "malformed_response");
              const index = rawCall.index;
              if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= MAX_TOOL_CALLS_PER_RESPONSE) throw providerCompatibilityError("openrouter", "malformed_response");
              const partial = partialCalls.get(index) ?? { arguments: "" };
              if (rawCall.id !== undefined) {
                if (!boundedNonEmptyString(rawCall.id) || (partial.id !== undefined && partial.id !== rawCall.id)) throw providerCompatibilityError("openrouter", "protocol_drift");
                partial.id = rawCall.id;
              }
              if (rawCall.type !== undefined) {
                if (rawCall.type !== "function" || (partial.type !== undefined && partial.type !== rawCall.type)) throw providerCompatibilityError("openrouter", "protocol_drift");
                partial.type = rawCall.type;
              }
              if (rawCall.function !== undefined) {
                if (!isRecord(rawCall.function)) throw providerCompatibilityError("openrouter", "malformed_response");
                if (rawCall.function.name !== undefined) {
                  if (!boundedNonEmptyString(rawCall.function.name) || (partial.name !== undefined && partial.name !== rawCall.function.name)) throw providerCompatibilityError("openrouter", "protocol_drift");
                  partial.name = rawCall.function.name;
                }
                if (rawCall.function.arguments !== undefined) {
                  if (typeof rawCall.function.arguments !== "string" || partial.arguments.length + rawCall.function.arguments.length > MAX_TOOL_ARGUMENT_CHARACTERS) throw providerCompatibilityError("openrouter", "malformed_response");
                  if (modelTurnCharacters + toolArgumentCharacters + rawCall.function.arguments.length > MAX_CURRENT_TURN_CHARACTERS) throw providerCompatibilityError("openrouter", "malformed_response");
                  partial.arguments += rawCall.function.arguments;
                  toolArgumentCharacters += rawCall.function.arguments.length;
                }
              }
              partialCalls.set(index, partial);
            }
          }
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            if (!boundedNonEmptyString(choice.finish_reason)) throw providerCompatibilityError("openrouter", "malformed_response");
            finishReason = choice.finish_reason;
            finished = true;
          }
        }, request.signal);
        if (!sawDone) throw providerCompatibilityError("openrouter", "malformed_response");
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        throw safeProviderError(request, error);
      }

      if (!sawChoice || !finished || !responseId) {
        recordProviderDiagnostic(request, "malformed_response");
        throw providerCompatibilityError("openrouter", "malformed_response");
      }
      const toolCalls: ToolCall[] = [];
      const persistedToolCalls: OpenRouterToolCall[] = [];
      const pendingCalls: PendingToolCall[] = [];
      for (const [index, partial] of [...partialCalls.entries()].sort(([left], [right]) => left - right)) {
        if (!partial.id || partial.type !== "function" || !partial.name || !parsedArguments(partial.arguments)) throw providerCompatibilityError("openrouter", "malformed_response");
        if (pendingCalls.some((call) => call.callId === partial.id)) throw providerCompatibilityError("openrouter", "protocol_drift");
        const toolCall = { id: partial.id, type: "function" as const, function: { name: partial.name, arguments: partial.arguments } };
        const length = serializedCharacterCount(toolCall);
        if (modelTurnCharacters + length > MAX_CURRENT_TURN_CHARACTERS) throw providerCompatibilityError("openrouter", "malformed_response");
        modelTurnCharacters += length;
        persistedToolCalls.push(toolCall);
        pendingCalls.push({ callId: partial.id, name: partial.name });
        toolCalls.push({ callId: partial.id, name: partial.name, arguments: partial.arguments });
      }
      if ((toolCalls.length > 0 && finishReason !== "tool_calls")
        || (toolCalls.length === 0 && finishReason === "tool_calls")) {
        throw providerCompatibilityError("openrouter", "protocol_drift");
      }

      nextMessages.push({
        role: "assistant",
        content: text,
        ...(persistedToolCalls.length === 0 ? {} : { tool_calls: persistedToolCalls }),
      });
      const persistedMessages = boundConversation(nextMessages);
      messages.splice(0, messages.length, ...persistedMessages);
      hasUncommittedRestoredConversation = false;
      lastToolCalls = pendingCalls;
      lastResponseId = responseId;
      const usage: AgentUsage = {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
      };
      return {
        responseId,
        text,
        textWasStreamed: true,
        toolCalls,
        ...(Object.keys(usage).length === 0 ? {} : { usage }),
        continuationState: continuationState(persistedMessages),
      };
    },
  };
}
