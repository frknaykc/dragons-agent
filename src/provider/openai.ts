import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseInputItem,
} from "openai/resources/responses/responses.js";

import type {
  AgentModel,
  AgentRequest,
  AgentResponse,
  AgentTextDeltaHandler,
} from "../agent.js";
import { formatAdvisoryContextForInstructions } from "../advisory-context.js";
import type { AgentTool } from "../tools.js";
import { classifyProviderError, retryProviderRequest } from "../retry.js";
import {
  providerCompatibilityError,
  ProviderCompatibilityError,
  type ProviderCompatibilityKind,
} from "./compatibility.js";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

function createClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Export it before running Dragons Agent.",
    );
  }

  // Dragons owns the single bounded pre-stream retry policy; SDK retries would
  // otherwise be invisible to M22/M33 accounting and can multiply attempts.
  return new OpenAI({ apiKey, maxRetries: 0 });
}

function toFunctionTool(tool: AgentTool): FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    // Valid MCP schemas need not satisfy OpenAI's stricter additionalProperties contract.
    strict: false,
  };
}

function toolOutputInput(request: AgentRequest): ResponseInputItem[] {
  return request.toolOutputs.map(({ callId, output }) => ({
    type: "function_call_output",
    call_id: callId,
    output,
  }));
}

function continuationResponseId(state: AgentRequest["continuationState"]): string | undefined {
  if (!state) return undefined;
  if (state.kind !== "openai-responses" || typeof state.previousResponseId !== "string" || !state.previousResponseId) {
    throw providerCompatibilityError("openai", "protocol_drift");
  }
  return state.previousResponseId;
}

function recordProviderDiagnostic(request: AgentRequest, kind: ProviderCompatibilityKind): void {
  if (kind === "cancelled" || kind === "invalid_request") return;
  request.onProviderDiagnostic?.(kind);
}

function safeProviderError(request: AgentRequest, error: unknown): ProviderCompatibilityError {
  if (error instanceof ProviderCompatibilityError) {
    recordProviderDiagnostic(request, error.compatibilityKind);
    return error;
  }
  const kind = classifyProviderError(error);
  recordProviderDiagnostic(request, kind);
  return providerCompatibilityError("openai", kind);
}

function validatedToolCall(callId: string, name: string, arguments_: string): AgentResponse["toolCalls"][number] {
  if (!callId || !name) throw providerCompatibilityError("openai", "malformed_response");
  try {
    const parsed = JSON.parse(arguments_) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid tool arguments");
  } catch {
    throw providerCompatibilityError("openai", "malformed_response");
  }
  return { callId, name, arguments: arguments_ };
}

function isIgnorableOpenAIStreamEvent(type: string): boolean {
  return type === "response.created"
    || type === "response.in_progress"
    || type === "response.output_item.added"
    || type === "response.function_call_arguments.delta"
    || type === "response.function_call_arguments.done"
    || type.startsWith("response.reasoning.")
    || type.startsWith("response.content_part.")
    || type.startsWith("response.output_text.");
}

function isCriticalUnknownOpenAIStreamEvent(type: string): boolean {
  return /(?:completed|function_call|tool_call|output_item\.done)/.test(type);
}

export function createOpenAIAgentModel(model = DEFAULT_OPENAI_MODEL): AgentModel {
  const client = createClient();

  return {
    async respond(
      request: AgentRequest,
      onTextDelta?: AgentTextDeltaHandler,
    ): Promise<AgentResponse> {
      const previousResponseId = request.previousResponseId
        ?? continuationResponseId(request.continuationState)
        ?? request.conversationResponseId;
      let stream;
      try {
        stream = await retryProviderRequest(() => client.responses.create({
          model,
          input: request.previousResponseId ? toolOutputInput(request) : request.task,
          instructions: formatAdvisoryContextForInstructions(request),
          previous_response_id: previousResponseId,
          tools: request.tools.map(toFunctionTool),
          // M11 requires ordered authorization and execution.
          parallel_tool_calls: false,
          stream: true,
        }, { signal: request.signal }), { signal: request.signal, onRetry: request.onProviderRetry });
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        throw safeProviderError(request, error);
      }
      const toolCalls: AgentResponse["toolCalls"] = [];
      const completedCallIds = new Set<string>();
      let responseId = "";
      let text = "";

      try {
        for await (const event of stream) {
          if (request.signal?.aborted) throw new DOMException("Aborted", "AbortError");
          if (event.type === "response.output_text.delta") {
            text += event.delta;
            onTextDelta?.(event.delta);
            continue;
          }
          if (event.type === "response.output_item.done" && event.item.type === "function_call") {
            const call = validatedToolCall(event.item.call_id, event.item.name, event.item.arguments);
            if (completedCallIds.has(call.callId)) throw providerCompatibilityError("openai", "protocol_drift");
            completedCallIds.add(call.callId);
            toolCalls.push(call);
            continue;
          }
          if (event.type === "response.completed") {
            responseId = event.response.id;
            continue;
          }
          if (event.type === "response.failed") throw providerCompatibilityError("openai", "transient");
          if (isIgnorableOpenAIStreamEvent(event.type)) continue;
          if (isCriticalUnknownOpenAIStreamEvent(event.type)) throw providerCompatibilityError("openai", "protocol_drift");
          recordProviderDiagnostic(request, "protocol_drift");
        }
      } catch (error: unknown) {
        if (request.signal?.aborted) throw error;
        throw safeProviderError(request, error);
      }

      if (!responseId) {
        recordProviderDiagnostic(request, "malformed_response");
        throw providerCompatibilityError("openai", "malformed_response");
      }

      return {
        responseId,
        text,
        textWasStreamed: true,
        toolCalls,
        continuationState: { kind: "openai-responses", previousResponseId: responseId },
      };
    },
  };
}

export async function* streamOpenAIResponse(
  prompt: string,
): AsyncGenerator<string> {
  const client = createClient();
  const stream = await client.responses.create({
    model: DEFAULT_OPENAI_MODEL,
    input: prompt,
    stream: true,
  });

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      yield event.delta;
    }
  }
}
