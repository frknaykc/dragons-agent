import type { AgentTool, ToolOperation, ToolResult } from "./tools.js";
import { discoverProjectContext, type ProjectContext } from "./project-context.js";
import { compactContextText, DEFAULT_CONTEXT_BUDGET_CHARS } from "./context-budget.js";
import type { SkillsContext } from "./skills.js";
import type { MemoryContext } from "./memory.js";
import type { DragonsPlan } from "./plan.js";
import type { ProviderDiagnosticKind, RuntimeDiagnosticsRun } from "./diagnostics.js";
import { RunChangeTracker } from "./change-review.js";

export type ToolCall = {
  callId: string;
  name: string;
  arguments: string;
};

export type ToolOutput = {
  callId: string;
  output: string;
};

export type SerializableConversationState = Record<string, unknown>;

export type AgentRequest = {
  task: string;
  projectContext?: ProjectContext;
  /** Explicitly activated Dragons skills; distinct from project and provider continuation context. */
  skills?: SkillsContext;
  /** Explicit user-authored advisory memories; never session or continuation state. */
  memory?: MemoryContext;
  /** Read-only snapshot of the active session plan, if one was explicitly supplied. */
  plan?: DragonsPlan;
  tools: AgentTool[];
  conversationResponseId?: string;
  continuationState?: SerializableConversationState;
  previousResponseId?: string;
  toolOutputs: ToolOutput[];
  /** Conservative provider-neutral character budget; never an asserted token count. */
  contextBudgetChars?: number;
  signal?: AbortSignal;
  /** Provider-neutral pre-stream retry seam. It never receives an error, headers, or request data. */
  onProviderRetry?: () => void;
  /** Safe provider compatibility category only; never raw provider response or request data. */
  onProviderDiagnostic?: (kind: ProviderDiagnosticKind) => void;
};

export type AgentResponse = {
  responseId: string;
  text: string;
  textWasStreamed?: boolean;
  toolCalls: ToolCall[];
  continuationState?: SerializableConversationState;
};

export type AgentTextDeltaHandler = (text: string) => void;

export type AgentModel = {
  respond(
    request: AgentRequest,
    onTextDelta?: AgentTextDeltaHandler,
  ): Promise<AgentResponse>;
};

export type AgentEvent =
  | { type: "agent_started"; task: string }
  | { type: "message_delta"; text: string }
  | { type: "authorization_requested"; name: string; operation: ToolOperation; arguments: string }
  | { type: "authorization_completed"; name: string; operation: ToolOperation; allowed: boolean }
  | { type: "tool_started"; name: string; arguments: string }
  | { type: "tool_completed"; name: string; result: ToolResult }
  | { type: "agent_error"; message: string }
  | { type: "agent_cancelled"; message: string }
  | { type: "agent_completed"; finalText: string };

export type AgentRunOptions = {
  task: string;
  model: AgentModel;
  tools: AgentTool[];
  workingDirectory?: string;
  projectContext?: ProjectContext;
  skills?: SkillsContext;
  /** Explicit user-authored advisory memories; never session or continuation state. */
  memory?: MemoryContext;
  /** Read-only plan snapshot for an isolated child or explicitly plan-aware caller. */
  plan?: DragonsPlan;
  conversationResponseId?: string;
  continuationState?: SerializableConversationState;
  maxTurns?: number;
  contextBudgetChars?: number;
  /** Runtime-only interactive approval state. It must never be persisted. */
  sessionApprovals?: Set<string>;
  authorize?: (request: ToolAuthorizationRequest) => ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Runtime-only recorder; callers own its in-memory lifecycle and persistence is forbidden. */
  diagnostics?: RuntimeDiagnosticsRun;
};

export type ToolAuthorizationRequest = {
  name: string;
  operation: ToolOperation;
  arguments: string;
};

export type ToolAuthorizationDecision = boolean | "session";

export type AgentRunResult = {
  finalText: string;
  turns: number;
  responseId: string;
  continuationState?: SerializableConversationState;
};

const DEFAULT_MAX_TURNS = 20;

export class AgentRunCancelledError extends Error {
  constructor() {
    super("Agent run cancelled.");
    this.name = "AgentRunCancelledError";
  }
}

function emit(options: AgentRunOptions, event: AgentEvent): void {
  options.onEvent?.(event);
}

function throwIfCancelled(options: AgentRunOptions): void {
  if (options.signal?.aborted) throw new AgentRunCancelledError();
}

/** Parses provider ToolCall arguments before any local tool receives them. */
export function parseToolCallArguments(serializedArguments: string): unknown | ToolResult {
  try {
    return JSON.parse(serializedArguments) as unknown;
  } catch {
    return { ok: false, output: "Invalid JSON tool arguments." };
  }
}

function approvalScopeKey(tool: AgentTool, serializedArguments: string): string {
  const parsed = parseToolCallArguments(serializedArguments);
  if (!parsed || typeof parsed !== "object" || "ok" in parsed) return `${tool.operation}:${tool.name}:${serializedArguments}`;
  const input = parsed as Record<string, unknown>;
  // A write approval applies to one tool and one project-relative target only.
  if (tool.operation === "WRITE" && typeof input.path === "string") return `${tool.operation}:${tool.name}:path=${input.path}`;
  // Never turn one shell approval into general shell authority.
  if (tool.operation === "EXECUTE" && typeof input.command === "string") return `${tool.operation}:${tool.name}:command=${input.command}`;
  return `${tool.operation}:${tool.name}:${serializedArguments}`;
}

async function executeToolCall(
  toolCall: ToolCall,
  tools: Map<string, AgentTool>,
  options: AgentRunOptions,
  sessionApprovals: Set<string>,
  changeTracker: RunChangeTracker | undefined,
): Promise<ToolOutput> {
  const diagnosticCall = options.diagnostics?.recordToolCallStarted(toolCall.name);
  let timeoutEvidence = false;
  try {
    throwIfCancelled(options);
    const tool = tools.get(toolCall.name);
    let result: ToolResult;

    if (!tool) {
      emit(options, {
        type: "tool_started",
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
      result = { ok: false, output: `Unknown tool: ${toolCall.name}` };
    } else {
    const request: ToolAuthorizationRequest = {
      name: tool.name,
      operation: tool.operation,
      arguments: toolCall.arguments,
    };
    emit(options, { type: "authorization_requested", ...request });
    const approvalKey = approvalScopeKey(tool, toolCall.arguments);
    const decision: ToolAuthorizationDecision = sessionApprovals.has(approvalKey)
      ? true
      : options.authorize
        ? await options.authorize(request)
        : tool.operation === "READ";
    const allowed = decision === true || decision === "session";
    if (decision === "session") sessionApprovals.add(approvalKey);
    throwIfCancelled(options);
    emit(options, {
      type: "authorization_completed",
      name: tool.name,
      operation: tool.operation,
      allowed,
    });

    if (!allowed) {
      result = { ok: false, output: `Authorization denied for ${tool.name}.` };
    } else {
      emit(options, {
        type: "tool_started",
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
      const input = parseToolCallArguments(toolCall.arguments);
      result = typeof input === "object" && input !== null && "ok" in input
        ? (input as ToolResult)
        : await tool.execute(input, { signal: options.signal, onTimeout: () => { timeoutEvidence = true; }, changeTracker });
      changeTracker?.record(result.changedPaths);
      throwIfCancelled(options);
    }
    }
    emit(options, { type: "tool_completed", name: toolCall.name, result });
    return { callId: toolCall.callId, output: result.output };
  } finally {
    if (diagnosticCall !== undefined) options.diagnostics?.recordToolCallCompleted(diagnosticCall, timeoutEvidence);
  }
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (tools.size !== options.tools.length) throw new Error("Duplicate tool name in active tool registry.");
  let projectContext: ProjectContext | undefined;
  let previousResponseId: string | undefined;
  let continuationState = options.continuationState;
  let toolOutputs: ToolOutput[] = [];
  const completedToolCallIds = new Set<string>();
  const sessionApprovals = options.sessionApprovals ?? new Set<string>();
  const contextBudgetChars = options.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;
  const changeTracker = options.workingDirectory ? new RunChangeTracker(options.workingDirectory) : undefined;

  try {
    projectContext = options.projectContext ?? (options.workingDirectory
      ? await discoverProjectContext(options.workingDirectory)
      : undefined);
    if (changeTracker) await changeTracker.initialize();
    emit(options, { type: "agent_started", task: options.task });
    for (let turns = 1; turns <= maxTurns; turns += 1) {
      throwIfCancelled(options);
      let response: AgentResponse;

      try {
        options.diagnostics?.recordModelTurn();
        response = await options.model.respond({
          task: options.task,
          projectContext,
          skills: options.skills,
          memory: options.memory,
          plan: options.plan,
          tools: options.tools,
          conversationResponseId: options.conversationResponseId,
          continuationState,
          previousResponseId,
          toolOutputs: toolOutputs.map((output) => ({ ...output, output: compactContextText(output.output, contextBudgetChars) })),
          contextBudgetChars,
          signal: options.signal,
          onProviderRetry: () => options.diagnostics?.recordProviderRetry(),
          onProviderDiagnostic: (kind) => options.diagnostics?.recordProviderDiagnostic(kind),
        }, (text) => emit(options, { type: "message_delta", text }));
      } catch (error: unknown) {
        if (options.signal?.aborted) throw new AgentRunCancelledError();
        const message = error instanceof Error ? error.message : "Model request failed.";
        emit(options, { type: "agent_error", message });
        throw error;
      }
      throwIfCancelled(options);

      previousResponseId = response.responseId;
      if (response.continuationState !== undefined) continuationState = response.continuationState;

      if (response.text && !response.textWasStreamed) {
        emit(options, { type: "message_delta", text: response.text });
      }

      if (response.toolCalls.length === 0) {
        emit(options, { type: "agent_completed", finalText: response.text });
        options.diagnostics?.complete("success");
        return {
          finalText: response.text,
          turns,
          responseId: response.responseId,
          continuationState,
        };
      }

      toolOutputs = [];
      for (const toolCall of response.toolCalls) {
        throwIfCancelled(options);
        if (completedToolCallIds.has(toolCall.callId)) {
          toolOutputs.push({ callId: toolCall.callId, output: `Duplicate tool call ID rejected: ${toolCall.callId}.` });
          continue;
        }
        completedToolCallIds.add(toolCall.callId);
        toolOutputs.push(await executeToolCall(toolCall, tools, options, sessionApprovals, changeTracker));
        throwIfCancelled(options);
      }
    }
  } catch (error: unknown) {
    if (error instanceof AgentRunCancelledError || options.signal?.aborted) {
      emit(options, { type: "agent_cancelled", message: "Agent run cancelled." });
      options.diagnostics?.complete("cancelled");
      throw new AgentRunCancelledError();
    }
    options.diagnostics?.complete("failed");
    throw error;
  }

  const message = `Agent reached the maximum of ${maxTurns} model turns.`;
  emit(options, { type: "agent_error", message });
  options.diagnostics?.complete("failed");
  throw new Error(message);
}
