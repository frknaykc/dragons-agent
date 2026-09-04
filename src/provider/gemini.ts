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

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const MAX_CONVERSATION_ITEMS = 256;
const MAX_CONVERSATION_CHARACTERS = 256_000;
const MAX_FUNCTION_ARGUMENT_CHARACTERS = 64_000;
const MAX_CURRENT_TURN_CHARACTERS = 48_000;
const MAX_MODEL_PARTS = 64;

type GeminiFunctionCall = { id?: string; name: string; args: Record<string, unknown> };
type GeminiFunctionResponse = { id?: string; name: string; response: Record<string, unknown> };
type GeminiPart = { text?: string; functionCall?: GeminiFunctionCall; functionResponse?: GeminiFunctionResponse; thoughtSignature?: string };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiContinuationState = { kind: "gemini-generate-content"; adapterVersion: 1; contents: GeminiContent[] };
type PendingFunctionCall = { callId: string; name: string; providerCallId?: string };

export type GeminiAgentModelOptions = {
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

function resolveApiKey(value: string | undefined): string {
  const apiKey = value?.trim() ?? process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Export it before running Dragons Agent.");
  return apiKey;
}

function toTool(tool: AgentTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function recordProviderDiagnostic(request: AgentRequest, kind: ProviderCompatibilityKind): void {
  if (kind !== "cancelled" && kind !== "invalid_request") request.onProviderDiagnostic?.(kind);
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function serializedCharacterCount(value: unknown): number {
  return JSON.stringify(value).length;
}

function isGeminiFunctionCall(value: unknown): value is GeminiFunctionCall {
  if (!isRecord(value) || !boundedNonEmptyString(value.name) || !isRecord(value.args)) return false;
  return value.id === undefined || boundedNonEmptyString(value.id);
}

function isGeminiFunctionResponse(value: unknown): value is GeminiFunctionResponse {
  if (!isRecord(value) || !boundedNonEmptyString(value.name) || !isRecord(value.response)) return false;
  return value.id === undefined || boundedNonEmptyString(value.id);
}

function partKind(part: GeminiPart): "text" | "functionCall" | "functionResponse" | undefined {
  const kinds = [part.text !== undefined ? "text" : undefined, part.functionCall !== undefined ? "functionCall" : undefined, part.functionResponse !== undefined ? "functionResponse" : undefined]
    .filter((kind): kind is "text" | "functionCall" | "functionResponse" => kind !== undefined);
  return kinds.length === 1 ? kinds[0] : undefined;
}

function isGeminiPart(value: unknown): value is GeminiPart {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !["text", "functionCall", "functionResponse", "thoughtSignature"].includes(key))) return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  if (value.functionCall !== undefined && !isGeminiFunctionCall(value.functionCall)) return false;
  if (value.functionResponse !== undefined && !isGeminiFunctionResponse(value.functionResponse)) return false;
  if (value.thoughtSignature !== undefined
    && (!boundedNonEmptyString(value.thoughtSignature, MAX_FUNCTION_ARGUMENT_CHARACTERS)
      || (value.functionCall === undefined && value.text === undefined))) return false;
  return partKind(value as GeminiPart) !== undefined;
}

function isGeminiContent(value: unknown): value is GeminiContent {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "model") || !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 64 || !value.parts.every(isGeminiPart)) return false;
  const kinds = (value.parts as GeminiPart[]).map(partKind);
  return value.role === "user"
    ? kinds.every((kind) => kind === "text" || kind === "functionResponse") && !(value.parts as GeminiPart[]).some((part) => part.thoughtSignature !== undefined)
    : kinds.every((kind) => kind === "text" || kind === "functionCall");
}

function hasValidConversation(contents: readonly GeminiContent[]): boolean {
  let priorRole: GeminiContent["role"] | undefined;
  let pending: GeminiFunctionCall[] | undefined;
  for (const content of contents) {
    if (content.role === "user") {
      const hasResponses = content.parts.some((part) => part.functionResponse !== undefined);
      if (hasResponses) {
        if (priorRole !== "model" || !pending || content.parts.length !== pending.length || !content.parts.every((part) => part.functionResponse !== undefined)) return false;
        const responseIds = new Set<string>();
        for (let index = 0; index < pending.length; index += 1) {
          const call = pending[index]!;
          const response = content.parts[index]!.functionResponse!;
          if (response.name !== call.name || response.id !== call.id || (response.id !== undefined && responseIds.has(response.id))) return false;
          if (response.id !== undefined) responseIds.add(response.id);
        }
        pending = undefined;
      } else if (pending || (priorRole !== undefined && priorRole !== "model") || !content.parts.every((part) => part.text !== undefined)) {
        return false;
      }
    } else {
      if (priorRole !== "user" || pending) return false;
      const calls = content.parts.flatMap((part) => part.functionCall === undefined ? [] : [part.functionCall]);
      const ids = new Set<string>();
      const anonymousNames = new Set<string>();
      for (const call of calls) {
        if ((call.id !== undefined && ids.has(call.id)) || (call.id === undefined && anonymousNames.has(call.name))) return false;
        if (call.id !== undefined) ids.add(call.id);
        else anonymousNames.add(call.name);
      }
      pending = calls.length === 0 ? undefined : calls;
    }
    priorRole = content.role;
  }
  return contents.length > 0 && priorRole === "model" && pending === undefined;
}

function restoreConversation(value: AgentRequest["continuationState"]): GeminiContent[] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.kind !== "gemini-generate-content" || value.adapterVersion !== 1 || !Array.isArray(value.contents)
    || value.contents.length > MAX_CONVERSATION_ITEMS || !value.contents.every(isGeminiContent) || !hasValidConversation(value.contents as GeminiContent[])) {
    throw providerCompatibilityError("gemini", "protocol_drift");
  }
  try {
    const serialized = JSON.stringify(value.contents);
    if (serialized.length > MAX_CONVERSATION_CHARACTERS) throw new Error("conversation is too large");
    return JSON.parse(serialized) as GeminiContent[];
  } catch {
    throw providerCompatibilityError("gemini", "malformed_response");
  }
}

function boundConversation(contents: readonly GeminiContent[]): GeminiContent[] {
  let bounded = [...contents];
  while (bounded.length > MAX_CONVERSATION_ITEMS || serializedCharacterCount(bounded) > MAX_CONVERSATION_CHARACTERS) {
    const completedTurn = bounded.findIndex((content) => content.role === "model" && !content.parts.some((part) => part.functionCall !== undefined));
    if (completedTurn < 0 || completedTurn === bounded.length - 1) throw providerCompatibilityError("gemini", "malformed_response");
    bounded = bounded.slice(completedTurn + 1);
  }
  return bounded;
}

function reserveConversationSpace(contents: readonly GeminiContent[]): GeminiContent[] {
  let bounded = [...contents];
  while (bounded.length > MAX_CONVERSATION_ITEMS || serializedCharacterCount(bounded) + MAX_CURRENT_TURN_CHARACTERS > MAX_CONVERSATION_CHARACTERS) {
    const completedTurn = bounded.findIndex((content) => content.role === "model" && !content.parts.some((part) => part.functionCall !== undefined));
    if (completedTurn < 0 || completedTurn === bounded.length - 1) throw providerCompatibilityError("gemini", "invalid_request");
    bounded = bounded.slice(completedTurn + 1);
  }
  return bounded;
}

function continuationState(contents: readonly GeminiContent[]): GeminiContinuationState {
  return { kind: "gemini-generate-content", adapterVersion: 1, contents: structuredClone([...contents]) };
}

async function parseSse(response: Response, onChunk: (chunk: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw providerCompatibilityError("gemini", "malformed_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const cancelReader = (): void => { void reader.cancel(); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const consume = (block: string): void => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data) as unknown;
      if (!isRecord(chunk)) throw new Error("invalid stream chunk");
      onChunk(chunk);
    } catch (error: unknown) {
      if (error instanceof ProviderCompatibilityError) throw error;
      throw providerCompatibilityError("gemini", "malformed_response");
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
    : providerCompatibilityError("gemini", classifyProviderError(error));
  recordProviderDiagnostic(request, compatibility.compatibilityKind);
  return compatibility;
}

function streamedErrorKind(value: unknown): ProviderCompatibilityKind {
  if (!isRecord(value) || typeof value.code !== "number") return "malformed_response";
  return classifyProviderHttpFailure(value.code);
}

function endpointFor(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function createGeminiAgentModel(options: GeminiAgentModelOptions = {}): AgentModel {
  const apiKey = resolveApiKey(options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const baseUrl = options.baseUrl ?? GEMINI_API_BASE_URL;
  if (!boundedNonEmptyString(model, 256)) throw new Error("Gemini model must be a bounded non-empty string.");
  if (!boundedNonEmptyString(baseUrl, 1_024)) throw new Error("Gemini API base URL must be a bounded non-empty string.");
  const contents: GeminiContent[] = [];
  let lastToolCalls: PendingFunctionCall[] = [];
  let initialized = false;
  let hasUncommittedRestoredConversation = false;
  let responseSequence = 0;

  return {
    async respond(request: AgentRequest, onTextDelta?: AgentTextDeltaHandler): Promise<AgentResponse> {
      let resumed = false;
      if (!initialized) {
        const restored = restoreConversation(request.continuationState);
        if (restored) {
          contents.splice(0, contents.length, ...restored);
          resumed = true;
          hasUncommittedRestoredConversation = true;
        }
        initialized = true;
      }
      let nextContents = [...contents];
      if (request.previousResponseId) {
        if (lastToolCalls.length === 0 || request.previousResponseId !== `gemini-${responseSequence}`) {
          throw providerCompatibilityError("gemini", "protocol_drift");
        }
        const expected = new Map(lastToolCalls.map((call) => [call.callId, call]));
        if (request.toolOutputs.length !== lastToolCalls.length
          || request.toolOutputs.some((output) => !expected.has(output.callId))
          || new Set(request.toolOutputs.map((output) => output.callId)).size !== request.toolOutputs.length) {
          throw providerCompatibilityError("gemini", "protocol_drift");
        }
        const responseParts = request.toolOutputs.map((output) => {
          const call = expected.get(output.callId)!;
          return {
            functionResponse: {
              ...(call.providerCallId === undefined ? {} : { id: call.providerCallId }),
              name: call.name,
              response: { output: output.output },
            },
          };
        });
        if (serializedCharacterCount(responseParts) > MAX_CURRENT_TURN_CHARACTERS) {
          throw providerCompatibilityError("gemini", "invalid_request");
        }
        nextContents.push({
          role: "user",
          parts: responseParts,
        });
      } else if (request.conversationResponseId || resumed || hasUncommittedRestoredConversation) {
        if (serializedCharacterCount(request.task) > MAX_CURRENT_TURN_CHARACTERS) throw providerCompatibilityError("gemini", "invalid_request");
        nextContents.push({ role: "user", parts: [{ text: request.task }] });
      } else {
        if (serializedCharacterCount(request.task) > MAX_CURRENT_TURN_CHARACTERS) throw providerCompatibilityError("gemini", "invalid_request");
        nextContents.splice(0, nextContents.length, { role: "user", parts: [{ text: request.task }] });
      }
      nextContents = reserveConversationSpace(nextContents);

      const body: Record<string, unknown> = {
        contents: nextContents,
        tools: [{ functionDeclarations: request.tools.map(toTool) }],
      };
      const instructions = formatAdvisoryContextForInstructions(request);
      if (instructions) body.systemInstruction = { parts: [{ text: instructions }] };
      let response: Response;
      try {
        response = await retryProviderRequest(async () => {
          const candidate = await fetchImpl(endpointFor(baseUrl, model), {
            method: "POST",
            headers: {
              "x-goog-api-key": apiKey,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: request.signal,
          });
          const kind = classifyProviderHttpFailure(candidate.status);
          if (kind === "rate_limit" || kind === "transient") {
            await candidate.body?.cancel();
            throw providerCompatibilityError("gemini", kind, candidate.status);
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
        throw providerCompatibilityError("gemini", kind, response.status);
      }

      let text = "";
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let totalTokens: number | undefined;
      let finished = false;
      let sawCandidate = false;
      const modelParts: GeminiPart[] = [];
      const toolCalls: ToolCall[] = [];
      const pendingCalls: PendingFunctionCall[] = [];
      const providerCallIds = new Set<string>();
      const anonymousFunctionNames = new Set<string>();
      let modelTurnCharacters = 0;
      try {
        await parseSse(response, (chunk) => {
          if (finished) throw providerCompatibilityError("gemini", "protocol_drift");
          if (chunk.error !== undefined) throw providerCompatibilityError("gemini", streamedErrorKind(chunk.error));
          const usage = chunk.usageMetadata;
          if (usage !== undefined) {
            if (!isRecord(usage)) throw providerCompatibilityError("gemini", "malformed_response");
            inputTokens = usageNumber(usage.promptTokenCount) ?? inputTokens;
            outputTokens = usageNumber(usage.candidatesTokenCount) ?? outputTokens;
            totalTokens = usageNumber(usage.totalTokenCount) ?? totalTokens;
          }
          if (chunk.candidates === undefined) return;
          if (!Array.isArray(chunk.candidates) || chunk.candidates.length !== 1 || !isRecord(chunk.candidates[0])) throw providerCompatibilityError("gemini", "malformed_response");
          const candidate = chunk.candidates[0];
          if (candidate.index !== undefined && candidate.index !== 0) throw providerCompatibilityError("gemini", "protocol_drift");
          sawCandidate = true;
          if (candidate.finishReason !== undefined) {
            if (!boundedNonEmptyString(candidate.finishReason)) throw providerCompatibilityError("gemini", "malformed_response");
            finished = true;
          }
          if (candidate.content === undefined) return;
          if (!isGeminiContent(candidate.content) || candidate.content.role !== "model") throw providerCompatibilityError("gemini", "malformed_response");
          for (const part of candidate.content.parts) {
            const partCharacters = serializedCharacterCount(part);
            if (modelParts.length >= MAX_MODEL_PARTS || modelTurnCharacters + partCharacters > MAX_CURRENT_TURN_CHARACTERS) {
              throw providerCompatibilityError("gemini", "malformed_response");
            }
            if (part.text !== undefined) {
              text += part.text;
              onTextDelta?.(part.text);
              modelParts.push(structuredClone(part));
              modelTurnCharacters += partCharacters;
              continue;
            }
            const call = part.functionCall;
            if (!call) throw providerCompatibilityError("gemini", "protocol_drift");
            const serializedArguments = JSON.stringify(call.args);
            if (serializedArguments.length > MAX_FUNCTION_ARGUMENT_CHARACTERS) throw providerCompatibilityError("gemini", "malformed_response");
            if ((call.id !== undefined && providerCallIds.has(call.id)) || (call.id === undefined && anonymousFunctionNames.has(call.name))) {
              throw providerCompatibilityError("gemini", "protocol_drift");
            }
            if (call.id !== undefined) providerCallIds.add(call.id);
            else anonymousFunctionNames.add(call.name);
            const callId = call.id ?? `gemini-call-${responseSequence + 1}-${toolCalls.length + 1}`;
            modelParts.push(structuredClone(part));
            modelTurnCharacters += partCharacters;
            toolCalls.push({ callId, name: call.name, arguments: serializedArguments });
            pendingCalls.push({ callId, name: call.name, ...(call.id === undefined ? {} : { providerCallId: call.id }) });
          }
        }, request.signal);
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        throw safeProviderError(request, error);
      }
      if (!sawCandidate || !finished || modelParts.length === 0) {
        recordProviderDiagnostic(request, "malformed_response");
        throw providerCompatibilityError("gemini", "malformed_response");
      }

      nextContents.push({ role: "model", parts: modelParts });
      const persistedContents = boundConversation(nextContents);
      contents.splice(0, contents.length, ...persistedContents);
      hasUncommittedRestoredConversation = false;
      lastToolCalls = pendingCalls;
      responseSequence += 1;
      const usage: AgentUsage = {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
      };
      return {
        responseId: `gemini-${responseSequence}`,
        text,
        textWasStreamed: true,
        toolCalls,
        ...(Object.keys(usage).length === 0 ? {} : { usage }),
        continuationState: continuationState(persistedContents),
      };
    },
  };
}
