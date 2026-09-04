import type {
  AgentModel,
  AgentRequest,
  AgentResponse,
  AgentTextDeltaHandler,
  AgentUsage,
  ToolCall,
} from "../agent.js";
import { formatAdvisoryContextForInstructions } from "../advisory-context.js";
import { retryProviderRequest } from "../retry.js";
import type { AgentTool } from "../tools.js";
import {
  classifyProviderHttpFailure,
  providerCompatibilityError,
  ProviderCompatibilityError,
  type ProviderCompatibilityKind,
} from "./compatibility.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4_096;
const MAX_CONVERSATION_ITEMS = 256;
const MAX_CONVERSATION_CHARACTERS = 256_000;
const MAX_TOOL_INPUT_CHARACTERS = 64_000;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };
type AnthropicContinuationState = { kind: "anthropic-messages"; adapterVersion: 1; messages: AnthropicMessage[] };
type ActiveBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; initialInput: Record<string, unknown>; partialInput: string };

export type AnthropicAgentModelOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
};

function boundedNonEmptyString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveApiKey(value: string | undefined): string {
  const apiKey = value?.trim() ?? process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Export it before running Dragons Agent.");
  return apiKey;
}

function toTool(tool: AgentTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function recordProviderDiagnostic(request: AgentRequest, kind: ProviderCompatibilityKind): void {
  if (kind !== "cancelled" && kind !== "invalid_request") request.onProviderDiagnostic?.(kind);
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isContentBlock(value: unknown): value is AnthropicContentBlock {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "tool_result") return boundedNonEmptyString(value.tool_use_id) && typeof value.content === "string";
  return value.type === "tool_use" && boundedNonEmptyString(value.id) && boundedNonEmptyString(value.name) && isRecord(value.input);
}

function isMessage(value: unknown): value is AnthropicMessage {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return false;
  if (value.role === "user") {
    return typeof value.content === "string"
      || (Array.isArray(value.content) && value.content.every((block) => isContentBlock(block) && block.type === "tool_result"));
  }
  return Array.isArray(value.content)
    && value.content.every((block) => isContentBlock(block) && block.type !== "tool_result");
}

function hasValidConversation(messages: readonly AnthropicMessage[]): boolean {
  let priorRole: AnthropicMessage["role"] | undefined;
  let pendingToolResults: Set<string> | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        if (pendingToolResults || (priorRole !== undefined && priorRole !== "assistant")) return false;
      } else {
        if (priorRole !== "assistant" || !pendingToolResults || message.content.length !== pendingToolResults.size) return false;
        const resultIds = new Set<string>();
        for (const block of message.content) {
          if (block.type !== "tool_result") return false;
          if (!pendingToolResults.has(block.tool_use_id) || resultIds.has(block.tool_use_id)) return false;
          resultIds.add(block.tool_use_id);
        }
        if (resultIds.size !== pendingToolResults.size) return false;
        pendingToolResults = undefined;
      }
    } else {
      if (priorRole !== "user" || pendingToolResults) return false;
      if (typeof message.content === "string") return false;
      const toolIds = new Set<string>();
      for (const block of message.content) {
        if (block.type === "tool_use") {
          if (toolIds.has(block.id)) return false;
          toolIds.add(block.id);
        }
      }
      pendingToolResults = toolIds.size === 0 ? undefined : toolIds;
    }
    priorRole = message.role;
  }
  return messages.length > 0 && priorRole === "assistant" && pendingToolResults === undefined;
}

function restoreConversation(value: AgentRequest["continuationState"]): AnthropicMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.kind !== "anthropic-messages" || value.adapterVersion !== 1 || !Array.isArray(value.messages)
    || value.messages.length > MAX_CONVERSATION_ITEMS || !value.messages.every(isMessage) || !hasValidConversation(value.messages)) {
    throw providerCompatibilityError("anthropic", "protocol_drift");
  }
  try {
    const serialized = JSON.stringify(value.messages);
    if (serialized.length > MAX_CONVERSATION_CHARACTERS) throw new Error("conversation is too large");
    return JSON.parse(serialized) as AnthropicMessage[];
  } catch {
    throw providerCompatibilityError("anthropic", "malformed_response");
  }
}

function boundConversation(messages: readonly AnthropicMessage[]): AnthropicMessage[] {
  let bounded = [...messages];
  while (bounded.length > MAX_CONVERSATION_ITEMS || JSON.stringify(bounded).length > MAX_CONVERSATION_CHARACTERS) {
    const completedTurn = bounded.findIndex((message) => message.role === "assistant"
      && Array.isArray(message.content)
      && !message.content.some((block) => block.type === "tool_use"));
    if (completedTurn < 0 || completedTurn === bounded.length - 1) {
      throw providerCompatibilityError("anthropic", "malformed_response");
    }
    bounded = bounded.slice(completedTurn + 1);
  }
  return bounded;
}

function continuationState(messages: readonly AnthropicMessage[]): AnthropicContinuationState {
  return { kind: "anthropic-messages", adapterVersion: 1, messages: structuredClone([...messages]) };
}

function parsedToolInput(block: Extract<ActiveBlock, { type: "tool_use" }>): Record<string, unknown> {
  const source = block.partialInput || JSON.stringify(block.initialInput);
  if (source.length > MAX_TOOL_INPUT_CHARACTERS) throw providerCompatibilityError("anthropic", "malformed_response");
  try {
    const input = JSON.parse(source) as unknown;
    if (!isRecord(input)) throw new Error("tool input must be an object");
    return input;
  } catch {
    throw providerCompatibilityError("anthropic", "malformed_response");
  }
}

async function parseSse(response: Response, onEvent: (event: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw providerCompatibilityError("anthropic", "malformed_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const cancelReader = (): void => { void reader.cancel(); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const consume = (block: string): void => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const event = JSON.parse(data) as unknown;
      if (!isRecord(event)) throw new Error("invalid event");
      onEvent(event);
    } catch (error: unknown) {
      if (error instanceof ProviderCompatibilityError) throw error;
      throw providerCompatibilityError("anthropic", "malformed_response");
    }
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      buffered += decoder.decode(value, { stream: !done });
      const blocks = buffered.split(/\r?\n\r?\n/);
      buffered = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
      if (done) break;
    }
    if (buffered.trim()) consume(buffered);
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
}

function safeProviderError(request: AgentRequest, error: unknown): ProviderCompatibilityError {
  const compatibility = error instanceof ProviderCompatibilityError
    ? error
    : providerCompatibilityError("anthropic", "malformed_response");
  recordProviderDiagnostic(request, compatibility.compatibilityKind);
  return compatibility;
}

function streamedErrorKind(error: unknown): ProviderCompatibilityKind {
  if (!isRecord(error) || typeof error.type !== "string") return "malformed_response";
  if (error.type === "rate_limit_error") return "rate_limit";
  if (error.type === "overloaded_error" || error.type === "api_error") return "transient";
  if (error.type === "authentication_error" || error.type === "permission_error") return "authentication";
  if (error.type === "not_found_error") return "model_unavailable";
  if (error.type === "invalid_request_error") return "invalid_request";
  return "protocol_drift";
}

export function createAnthropicAgentModel(options: AnthropicAgentModelOptions = {}): AgentModel {
  const apiKey = resolveApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const baseUrl = (options.baseUrl ?? ANTHROPIC_MESSAGES_URL).replace(/\/$/, "");
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!boundedNonEmptyString(model, 256)) throw new Error("Anthropic model must be a bounded non-empty string.");
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("Anthropic maxTokens must be a positive integer.");
  const messages: AnthropicMessage[] = [];
  let lastToolCalls: ToolCall[] = [];
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
      const nextMessages = [...messages];
      if (request.previousResponseId) {
        const expected = new Set(lastToolCalls.map((call) => call.callId));
        if (request.toolOutputs.length !== lastToolCalls.length
          || request.toolOutputs.some((output) => !expected.has(output.callId))
          || new Set(request.toolOutputs.map((output) => output.callId)).size !== request.toolOutputs.length) {
          throw providerCompatibilityError("anthropic", "protocol_drift");
        }
        nextMessages.push({ role: "user", content: request.toolOutputs.map((output) => ({ type: "tool_result", tool_use_id: output.callId, content: output.output })) });
      } else if (request.conversationResponseId || resumed || hasUncommittedRestoredConversation) {
        nextMessages.push({ role: "user", content: request.task });
      } else {
        nextMessages.splice(0, nextMessages.length, { role: "user", content: request.task });
      }

      const instructions = formatAdvisoryContextForInstructions(request);
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: nextMessages,
        tools: request.tools.map(toTool),
        stream: true,
      };
      if (instructions) body.system = instructions;
      let response: Response;
      try {
        response = await retryProviderRequest(async () => {
          const candidate = await fetchImpl(baseUrl, {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: request.signal,
          });
          const kind = classifyProviderHttpFailure(candidate.status);
          if (kind === "rate_limit" || kind === "transient") {
            await candidate.body?.cancel();
            throw providerCompatibilityError("anthropic", kind, candidate.status);
          }
          return candidate;
        }, { signal: request.signal, onRetry: request.onProviderRetry });
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        throw safeProviderError(request, error);
      }
      if (!response.ok) {
        const kind = classifyProviderHttpFailure(response.status);
        recordProviderDiagnostic(request, kind);
        throw providerCompatibilityError("anthropic", kind, response.status);
      }

      let responseId = "";
      let text = "";
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let stopReason: string | undefined;
      let stopped = false;
      let messageStarted = false;
      const blocks = new Map<number, ActiveBlock>();
      const orderedBlocks: AnthropicContentBlock[] = [];
      const toolCalls: ToolCall[] = [];
      const callIds = new Set<string>();
      try {
        await parseSse(response, (event) => {
          const type = event.type;
          if (type === "ping") return;
          if (stopped) throw providerCompatibilityError("anthropic", "protocol_drift");
          if (type === "error") throw providerCompatibilityError("anthropic", streamedErrorKind(event.error));
          if (type === "message_start") {
            if (messageStarted) throw providerCompatibilityError("anthropic", "protocol_drift");
            const message = event.message;
            if (!isRecord(message) || !boundedNonEmptyString(message.id)) throw providerCompatibilityError("anthropic", "malformed_response");
            responseId = message.id;
            inputTokens = usageNumber(isRecord(message.usage) ? message.usage.input_tokens : undefined);
            messageStarted = true;
            return;
          }
          if (!messageStarted) throw providerCompatibilityError("anthropic", "protocol_drift");
          if (type === "content_block_start") {
            const index = event.index;
            const content = event.content_block;
            if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= 64 || !isRecord(content) || blocks.has(index as number)) {
              throw providerCompatibilityError("anthropic", "malformed_response");
            }
            if (content.type === "text") {
              blocks.set(index as number, { type: "text", text: typeof content.text === "string" ? content.text : "" });
              return;
            }
            if (content.type === "tool_use" && boundedNonEmptyString(content.id) && boundedNonEmptyString(content.name) && isRecord(content.input)) {
              blocks.set(index as number, { type: "tool_use", id: content.id, name: content.name, initialInput: content.input, partialInput: "" });
              return;
            }
            throw providerCompatibilityError("anthropic", "protocol_drift");
          }
          if (type === "content_block_delta") {
            const index = event.index;
            const delta = event.delta;
            const block = typeof index === "number" ? blocks.get(index) : undefined;
            if (!block || !isRecord(delta)) throw providerCompatibilityError("anthropic", "malformed_response");
            if (block.type === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
              block.text += delta.text;
              text += delta.text;
              onTextDelta?.(delta.text);
              return;
            }
            if (block.type === "tool_use" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              block.partialInput += delta.partial_json;
              if (block.partialInput.length > MAX_TOOL_INPUT_CHARACTERS) throw providerCompatibilityError("anthropic", "malformed_response");
              return;
            }
            throw providerCompatibilityError("anthropic", "protocol_drift");
          }
          if (type === "content_block_stop") {
            const index = event.index;
            const block = typeof index === "number" ? blocks.get(index) : undefined;
            if (!block) throw providerCompatibilityError("anthropic", "malformed_response");
            blocks.delete(index as number);
            if (block.type === "text") {
              orderedBlocks.push({ type: "text", text: block.text });
              return;
            }
            const input = parsedToolInput(block);
            if (callIds.has(block.id)) throw providerCompatibilityError("anthropic", "protocol_drift");
            callIds.add(block.id);
            orderedBlocks.push({ type: "tool_use", id: block.id, name: block.name, input });
            toolCalls.push({ callId: block.id, name: block.name, arguments: JSON.stringify(input) });
            return;
          }
          if (type === "message_delta") {
            if (!isRecord(event.delta) || (event.delta.stop_reason !== "end_turn" && event.delta.stop_reason !== "tool_use")) {
              throw providerCompatibilityError("anthropic", "malformed_response");
            }
            stopReason = event.delta.stop_reason;
            outputTokens = usageNumber(isRecord(event.usage) ? event.usage.output_tokens : undefined);
            return;
          }
          if (type === "message_stop") { stopped = true; return; }
          throw providerCompatibilityError("anthropic", "protocol_drift");
        }, request.signal);
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        throw safeProviderError(request, error);
      }
      if (!responseId || !stopped || blocks.size > 0 || !stopReason || (toolCalls.length > 0 && stopReason !== "tool_use") || (toolCalls.length === 0 && stopReason === "tool_use")) {
        recordProviderDiagnostic(request, "malformed_response");
        throw providerCompatibilityError("anthropic", "malformed_response");
      }
      nextMessages.push({ role: "assistant", content: orderedBlocks });
      const persistedMessages = boundConversation(nextMessages);
      messages.splice(0, messages.length, ...persistedMessages);
      hasUncommittedRestoredConversation = false;
      lastToolCalls = toolCalls;
      const usage: AgentUsage = {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
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
