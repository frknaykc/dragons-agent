import type {
  AgentModel,
  AgentRequest,
  AgentResponse,
  AgentTextDeltaHandler,
  ToolCall,
} from "../agent.js";
import { formatAdvisoryContextForInstructions } from "../advisory-context.js";
import type { AgentTool } from "../tools.js";
import type { CodexCredentials } from "./codex-auth.js";
import { retryProviderRequest } from "../retry.js";
import { DEFAULT_CONTEXT_BUDGET_CHARS } from "../context-budget.js";
import {
  classifyProviderHttpFailure,
  providerCompatibilityError,
  ProviderCompatibilityError,
  type ProviderCompatibilityKind,
} from "./compatibility.js";

export const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-terra";
export const CODEX_ADAPTER_COMPATIBILITY_VERSION = "2026-09";
const DEFAULT_INSTRUCTIONS = "You are Dragons Agent. Use the supplied tools when needed to complete the user's task.";
const MAX_RESTORED_CONVERSATION_ITEMS = 256;
const MAX_RESTORED_CONVERSATION_CHARACTERS = 256_000;

type CodexCredentialsResolver = {
  getValidCredentials(): Promise<CodexCredentials>;
};

type CodexInputItem = Record<string, unknown>;

export type CodexStreamDiagnostic = {
  index: number;
  type: string;
  itemType?: string;
  itemStatus?: string;
  responseStatus?: string;
  hasCallId: boolean;
  hasToolName: boolean;
  decision: "handled" | "ignored" | "waiting" | "critical";
};

export type CodexAgentModelOptions = {
  credentials: CodexCredentialsResolver;
  fetchImpl?: typeof fetch;
  model?: string;
  baseUrl?: string;
  instructions?: string;
  /** Explicit opt-in safe event-shape trace; event bodies and values are never retained. */
  onStreamDiagnostic?: (entry: CodexStreamDiagnostic) => void;
};

export class CodexFirstPartyIdentityRequiredError extends Error {
  constructor(status: number) {
    super(`M9A_BLOCKED_FIRST_PARTY_IDENTITY_REQUIRED: Codex Responses returned HTTP ${status} for Dragons-specific identity headers.`);
    this.name = "CodexFirstPartyIdentityRequiredError";
  }
}

function toFunctionTool(tool: AgentTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function firstPartyIdentityRequired(status: number, body: string): boolean {
  if (status !== 403) return false;
  const lower = body.toLowerCase();
  return (lower.includes("originator") || lower.includes("user-agent"))
    && (lower.includes("codex_cli") || lower.includes("first-party") || lower.includes("first party"));
}

function recordProviderDiagnostic(request: AgentRequest, kind: ProviderCompatibilityKind): void {
  if (kind === "cancelled" || kind === "invalid_request") return;
  request.onProviderDiagnostic?.(kind);
}

function isIgnorableStreamEvent(type: string): boolean {
  return type === "response.created"
    || type === "response.in_progress"
    || type === "response.output_item.added"
    || type === "response.function_call_arguments.delta"
    || type === "response.function_call_arguments.done"
    || type === "response.output_text.done"
    || type.startsWith("response.reasoning.")
    || type.startsWith("response.content_part.");
}

function isCriticalUnknownStreamEvent(type: string): boolean {
  return /(?:completed|function_call|tool_call|output_item\.done)/.test(type);
}

function boundedLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

function streamDiagnostic(index: number, event: Record<string, unknown>, decision: CodexStreamDiagnostic["decision"]): CodexStreamDiagnostic {
  const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
    ? event.item as Record<string, unknown> : undefined;
  const response = event.response && typeof event.response === "object" && !Array.isArray(event.response)
    ? event.response as Record<string, unknown> : undefined;
  return {
    index,
    type: boundedLabel(event.type) ?? "[invalid]",
    ...(boundedLabel(item?.type) ? { itemType: boundedLabel(item?.type) } : {}),
    ...(boundedLabel(item?.status) ? { itemStatus: boundedLabel(item?.status) } : {}),
    ...(boundedLabel(response?.status) ? { responseStatus: boundedLabel(response?.status) } : {}),
    hasCallId: typeof item?.call_id === "string" || typeof event.call_id === "string",
    hasToolName: typeof item?.name === "string" || typeof event.name === "string",
    decision,
  };
}

async function parseSse(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("Codex Responses stream did not include a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const consume = (block: string): void => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new Error("Codex Responses stream contained invalid JSON.");
    }
    if (event && typeof event === "object" && !Array.isArray(event)) onEvent(event as Record<string, unknown>);
  };

  const cancelReader = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
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

function completedFunctionCall(event: Record<string, unknown>): ToolCall | undefined {
  if (event.type !== "response.output_item.done") return undefined;
  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  if (record.type !== "function_call") return undefined;
  if (record.status === "in_progress" || record.status === "queued") return undefined;
  if (record.status !== "completed") throw providerCompatibilityError("chatgpt", "malformed_response");
  const callId = record.call_id;
  const name = record.name;
  const rawArguments = record.arguments;
  if (typeof callId !== "string" || !callId || typeof name !== "string" || !name || typeof rawArguments !== "string") {
    throw providerCompatibilityError("chatgpt", "malformed_response");
  }
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid tool arguments");
  } catch {
    throw providerCompatibilityError("chatgpt", "malformed_response");
  }
  return {
    callId,
    name,
    arguments: rawArguments,
  };
}

function initialInput(task: string): CodexInputItem[] {
  return [{
    role: "user",
    content: [{ type: "input_text", text: task }],
  }];
}

function restoredConversation(state: AgentRequest["continuationState"]): CodexInputItem[] | undefined {
  if (!state) return undefined;
  if (state.kind !== "chatgpt-codex" || !Array.isArray(state.conversation)
    || (state.adapterVersion !== undefined && state.adapterVersion !== CODEX_ADAPTER_COMPATIBILITY_VERSION)) {
    throw providerCompatibilityError("chatgpt", "protocol_drift");
  }
  if (state.conversation.length > MAX_RESTORED_CONVERSATION_ITEMS
    || !state.conversation.every(isSupportedConversationItem)) {
    throw providerCompatibilityError("chatgpt", "malformed_response");
  }
  try {
    const serialized = JSON.stringify(state.conversation);
    if (serialized.length > MAX_RESTORED_CONVERSATION_CHARACTERS) throw new Error("too large");
    return JSON.parse(serialized) as CodexInputItem[];
  } catch {
    throw providerCompatibilityError("chatgpt", "malformed_response");
  }
}

function isSupportedConversationItem(item: unknown): item is CodexInputItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  if (record.type === "function_call") return typeof record.call_id === "string" && Boolean(record.call_id)
    && typeof record.name === "string" && Boolean(record.name) && typeof record.arguments === "string";
  if (record.type === "function_call_output") return typeof record.call_id === "string" && Boolean(record.call_id)
    && typeof record.output === "string";
  return (record.type === "message" || record.role === "user" || record.role === "assistant") && Array.isArray(record.content);
}

function continuationState(conversation: CodexInputItem[]): Record<string, unknown> {
  return { kind: "chatgpt-codex", adapterVersion: CODEX_ADAPTER_COMPATIBILITY_VERSION, conversation: structuredClone(conversation) };
}

function compactionNotice(omitted: number): CodexInputItem {
  return { role: "user", content: [{ type: "input_text", text: `[Earlier conversation compacted; omitted ${omitted} item(s).]` }] };
}

function compactConversation(items: readonly CodexInputItem[], budget: number): CodexInputItem[] {
  let used = 0;
  const retained: CodexInputItem[] = [];
  let omitted = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const size = JSON.stringify(item).length;
    if (retained.length > 0 && used + size > budget) { omitted = index + 1; break; }
    retained.unshift(item);
    used += size;
  }
  const allOutputIds = new Set(items
    .filter((item): item is CodexInputItem & { type: "function_call_output"; call_id: string } => item.type === "function_call_output")
    .map((item) => (item as { call_id: string }).call_id));
  const retainedCallIds = new Set(retained
    .filter((item): item is CodexInputItem & { type: "function_call"; call_id: string } => item.type === "function_call")
    .map((item) => (item as { call_id: string }).call_id));
  const retainedOutputIds = new Set(retained
    .filter((item): item is CodexInputItem & { type: "function_call_output"; call_id: string } => item.type === "function_call_output")
    .map((item) => (item as { call_id: string }).call_id));
  const paired = retained.filter((item) => {
    const record = item as { type?: string; call_id?: string };
    if (record.type === "function_call_output") return retainedCallIds.has(record.call_id ?? "");
    if (record.type === "function_call" && allOutputIds.has(record.call_id ?? "")) return retainedOutputIds.has(record.call_id ?? "");
    return true;
  });
  return omitted > 0 || paired.length !== retained.length ? [compactionNotice(omitted), ...paired] : paired;
}

export function createCodexAgentModel(options: CodexAgentModelOptions): AgentModel {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? CODEX_RESPONSES_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? DEFAULT_CODEX_MODEL;
  const instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;
  const conversation: CodexInputItem[] = [];
  let lastToolCalls: ToolCall[] = [];
  let initialized = false;

  return {
    async respond(request: AgentRequest, onTextDelta?: AgentTextDeltaHandler): Promise<AgentResponse> {
      let resumed = false;
      if (!initialized) {
        const savedConversation = restoredConversation(request.continuationState);
        if (savedConversation) {
          conversation.splice(0, conversation.length, ...savedConversation);
          lastToolCalls = [];
          resumed = true;
        }
        initialized = true;
      }
      if (request.previousResponseId) {
        const expectedCallIds = new Set(lastToolCalls.map((call) => call.callId));
        if (request.toolOutputs.length !== lastToolCalls.length
          || request.toolOutputs.some((output) => !expectedCallIds.has(output.callId))
          || new Set(request.toolOutputs.map((output) => output.callId)).size !== request.toolOutputs.length) {
          recordProviderDiagnostic(request, "protocol_drift");
          throw providerCompatibilityError("chatgpt", "protocol_drift");
        }
        for (const call of lastToolCalls) {
          conversation.push({
            type: "function_call",
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments,
          });
        }
        for (const output of request.toolOutputs) {
          conversation.push({ type: "function_call_output", call_id: output.callId, output: output.output });
        }
      } else if (request.conversationResponseId || resumed) {
        conversation.push(...initialInput(request.task));
        lastToolCalls = [];
      } else {
        conversation.splice(0, conversation.length, ...initialInput(request.task));
        lastToolCalls = [];
      }
      const boundedConversation = compactConversation(conversation, request.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS);
      conversation.splice(0, conversation.length, ...boundedConversation);

      const credentials = await options.credentials.getValidCredentials();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": "DragonsAgent/0.1.0 (ChatGPT Subscription Experimental)",
        originator: "dragons-agent",
      };
      if (credentials.accountId) headers["ChatGPT-Account-ID"] = credentials.accountId;

      let response: Response;
      try {
        response = await retryProviderRequest(async () => {
          const candidate = await fetchImpl(`${baseUrl}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              instructions: [instructions, formatAdvisoryContextForInstructions(request)]
                .filter((value): value is string => Boolean(value))
                .join("\n\n"),
              input: conversation,
              tools: request.tools.map(toFunctionTool),
              tool_choice: "auto",
              // M11 serializes authorization and execution in model order.
              parallel_tool_calls: false,
              store: false,
              stream: true,
            }),
            signal: request.signal,
          });
          // No response body has been processed yet, so retries here cannot replay tools.
          if (candidate.status === 429 || candidate.status === 408 || candidate.status === 409 || candidate.status === 425 || candidate.status >= 500) {
            await candidate.body?.cancel();
            throw providerCompatibilityError("chatgpt", classifyProviderHttpFailure(candidate.status), candidate.status);
          }
          return candidate;
        }, { signal: request.signal, onRetry: request.onProviderRetry });
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        const compatibility = error instanceof ProviderCompatibilityError
          ? error
          : providerCompatibilityError("chatgpt", "transient");
        recordProviderDiagnostic(request, compatibility.compatibilityKind);
        throw compatibility;
      }
      if (!response.ok) {
        const errorBody = await response.text();
        if (firstPartyIdentityRequired(response.status, errorBody)) {
          recordProviderDiagnostic(request, "first_party_identity");
          throw new CodexFirstPartyIdentityRequiredError(response.status);
        }
        const kind = classifyProviderHttpFailure(response.status, errorBody);
        recordProviderDiagnostic(request, kind);
        throw providerCompatibilityError("chatgpt", kind, response.status);
      }

      let text = "";
      let responseId = "";
      const toolCalls: ToolCall[] = [];
      const completedCallIds = new Set<string>();
      let streamEventIndex = 0;
      try {
        await parseSse(response, (event) => {
          const index = streamEventIndex;
          streamEventIndex += 1;
          const trace = (decision: CodexStreamDiagnostic["decision"]): void => options.onStreamDiagnostic?.(streamDiagnostic(index, event, decision));
          const type = event.type;
          if (typeof type !== "string") { trace("critical"); throw providerCompatibilityError("chatgpt", "malformed_response"); }
          if (type === "response.output_text.delta") {
            if (typeof event.delta !== "string") { trace("critical"); throw providerCompatibilityError("chatgpt", "malformed_response"); }
            text += event.delta;
            onTextDelta?.(event.delta);
            trace("handled");
            return;
          }
          if (type === "response.output_item.done") {
            const item = event.item;
            if (item && typeof item === "object" && !Array.isArray(item)
              && (["reasoning", "message"] as const).includes((item as Record<string, unknown>).type as "reasoning" | "message")) {
              trace("ignored");
              return;
            }
          }
          const toolCall = completedFunctionCall(event);
          if (toolCall) {
            if (completedCallIds.has(toolCall.callId)) { trace("critical"); throw providerCompatibilityError("chatgpt", "protocol_drift"); }
            completedCallIds.add(toolCall.callId);
            toolCalls.push(toolCall);
            trace("handled");
            return;
          }
          if (type === "response.completed") {
            const completed = event.response;
            if (!completed || typeof completed !== "object" || Array.isArray(completed)
              || typeof (completed as Record<string, unknown>).id !== "string") { trace("critical"); throw providerCompatibilityError("chatgpt", "malformed_response"); }
            responseId = (completed as Record<string, unknown>).id as string;
            trace("handled");
            return;
          }
          if (type === "response.failed") { trace("critical"); throw providerCompatibilityError("chatgpt", "transient"); }
          if (isIgnorableStreamEvent(type)) { trace(type === "response.output_item.added" ? "waiting" : "ignored"); return; }
          if (isCriticalUnknownStreamEvent(type)) { trace("critical"); throw providerCompatibilityError("chatgpt", "protocol_drift"); }
          trace("ignored");
          recordProviderDiagnostic(request, "protocol_drift");
        }, request.signal);
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        const compatibility = error instanceof ProviderCompatibilityError
          ? error
          : providerCompatibilityError("chatgpt", "malformed_response");
        recordProviderDiagnostic(request, compatibility.compatibilityKind);
        throw compatibility;
      }
      if (!responseId) {
        recordProviderDiagnostic(request, "malformed_response");
        throw providerCompatibilityError("chatgpt", "malformed_response");
      }
      if (text) {
        conversation.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      lastToolCalls = toolCalls;
      return {
        responseId,
        text,
        textWasStreamed: true,
        toolCalls,
        continuationState: continuationState(compactConversation(conversation, request.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS)),
      };
    },
  };
}
