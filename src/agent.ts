import { InlineContextError, parseInlineReferences, resolveInlineContext } from "./inline-context.js";
import { INLINE_URL_TOOL } from "./inline-context-url.js";
import { lspApprovalFromArguments } from "./lsp-approval.js";
import { collectLspDiagnostics, lspMatches, parseLspConfig, type LspConfig } from "./lsp-diagnostics.js";
import { isCheckpointFileTool, type AgentTool, type ToolOperation, type ToolResult } from "./tools.js";
import { discoverProjectContext, type ProjectContext } from "./project-context.js";
import { compactContextText, DEFAULT_CONTEXT_BUDGET_CHARS } from "./context-budget.js";
import type { SkillsContext } from "./skills.js";
import type { MemoryContext } from "./memory.js";
import type { DragonsPlan } from "./plan.js";
import type { ProviderDiagnosticKind, RuntimeDiagnosticsRun } from "./diagnostics.js";
import { SessionCheckpoints } from "./checkpoint.js";
import { RunChangeTracker } from "./change-review.js";
import { ToolCatalog, TOOL_DESCRIBE_NAME, TOOL_SEARCH_THRESHOLD } from "./tool-catalog.js";
import { createProgramTool, PROGRAM_TOOL_NAME, runProgram } from "./programmatic-tool.js";
import { prepareLifecycleHooks, type LifecycleEvent, type LifecycleHook } from "./lifecycle-hooks.js";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/** Optional normalized provider-reported usage; absent means the adapter did not expose it. */
export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

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
  usage?: AgentUsage;
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
  | { type: "authorization_requested"; name: string; operation: ToolOperation; arguments: string; origin?: "lifecycle" }
  | { type: "authorization_completed"; name: string; operation: ToolOperation; allowed: boolean; origin?: "lifecycle" }
  | { type: "tool_started"; name: string; arguments: string; origin?: "lifecycle" }
  | { type: "tool_completed"; name: string; result: ToolResult;
      origin?: "lifecycle";
      /** Authority-owned durable projection, before approval presentation is appended. Null excludes denied calls. */
      observationOutput?: string | null }
  | { type: "agent_error"; message: string }
  | { type: "agent_cancelled"; message: string }
  | { type: "agent_completed"; finalText: string };

export type AgentRunOptions = {
  task: string;
  /** Trusted entry points opt in only for a newly submitted user message; never restored/model text. */
  inlineContextReferences?: boolean;
  model: AgentModel;
  tools: AgentTool[];
  /** Isolated child/background runs opt out; foreground CLI/Desktop expose the interpreter. */
  programmaticTools?: boolean;
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
  /** Optional hard cap on provider-requested tool calls for this run. */
  maxToolCalls?: number;
  contextBudgetChars?: number;
  /** Runtime-only interactive approval state. It must never be persisted. */
  sessionApprovals?: Set<string>;
  /** The optional signal bounds this approval, which may end before the run does. */
  authorize?: (request: ToolAuthorizationRequest, signal?: AbortSignal) => ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Runtime-only recorder; callers own its in-memory lifecycle and persistence is forbidden. */
  diagnostics?: RuntimeDiagnosticsRun;
  /** Process-local session history; never provider-visible or persisted. */
  checkpoints?: SessionCheckpoints;
  /** Explicit host configuration; each process requires separate EXECUTE approval. */
  lsp?: LspConfig;
  /** Trusted-host declarative bindings; effects remain inside the same tool authority path. */
  lifecycleHooks?: readonly LifecycleHook[];
  /** Emit session_started on the first user run of a session, never during passive creation. */
  sessionStarting?: boolean;
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
  usage?: AgentUsage;
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

function normalizedUsage(usage: AgentUsage | undefined): AgentUsage | undefined {
  if (!usage) return undefined;
  const normalized: AgentUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
  catalog?: ToolCatalog,
  visibleAtTurn?: Set<string>,
  nested?: (input: unknown) => Promise<ToolResult>,
  lifecycle?: { started(name: string): Promise<void>; completed(name: string, result: ToolResult): Promise<void> },
): Promise<ToolOutput & { result: ToolResult }> {
  const diagnosticCall = options.diagnostics?.recordToolCallStarted(toolCall.name);
  let timeoutEvidence = false;
  try {
    throwIfCancelled(options);
    const tool = visibleAtTurn?.has(toolCall.name) === false ? undefined : tools.get(toolCall.name);
    let result: ToolResult;
    let observationOutput: string | null = null;

    if (!tool) {
      emit(options, {
        type: "tool_started",
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
      result = { ok: false, output: `Unknown tool: ${toolCall.name}` };
      observationOutput = result.output;
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
        ? await options.authorize(request, options.signal)
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
      await lifecycle?.started(tool.name);
      const input = parseToolCallArguments(toolCall.arguments);
      if (typeof input === "object" && input !== null && "ok" in input) result = input as ToolResult;
      else if (tool.name === PROGRAM_TOOL_NAME && nested) result = await nested(input);
      else if (catalog && tool.name === TOOL_DESCRIBE_NAME) {
        const description = catalog.describe(input);
        result = description.result;
        throwIfCancelled(options);
        for (const activated of description.activated) tools.set(activated.name, activated);
      } else result = await tool.execute(input, { signal: options.signal, onTimeout: () => { timeoutEvidence = true; }, changeTracker, checkpoints: tool.operation === "WRITE" && isCheckpointFileTool(tool) ? options.checkpoints : undefined });
      // Nested tools record their own safe observations. Do not duplicate nested
      // presentation text here: it may include an LSP approval denial.
      observationOutput = tool.name === PROGRAM_TOOL_NAME ? null : result.output;
      changeTracker?.record(result.changedPaths);
      if (result.ok && isCheckpointFileTool(tool) && options.lsp && options.workingDirectory) {
        const reports: string[] = [];
        const observationReports: string[] = [];
        const paths = [...new Set(result.changedPaths ?? [])].filter((path) => lspMatches(options.lsp!, path));
        for (const path of paths.slice(0, 4)) {
          throwIfCancelled(options);
          const startup: ToolAuthorizationRequest = { name: "lsp_diagnostics_start", operation: "EXECUTE",
            arguments: JSON.stringify({ command: options.lsp.command, args: options.lsp.args, path }) };
          if (!lspApprovalFromArguments(startup.arguments)) {
            reports.push("LSP: approval scope cannot be safely displayed; diagnostics skipped.");
            continue;
          }
          emit(options, { type: "authorization_requested", ...startup });
          // Deliberately do not reuse WRITE or session approvals. One approval, one process.
          const approval = await options.authorize?.(startup, options.signal);
          throwIfCancelled(options);
          const permitted = approval === true || approval === "session";
          emit(options, { type: "authorization_completed", name: startup.name, operation: "EXECUTE", allowed: permitted });
          if (permitted) {
            const report = await collectLspDiagnostics(options.lsp, options.workingDirectory, path, options.signal);
            reports.push(report);
            observationReports.push(report);
          } else reports.push("LSP: EXECUTE denied; diagnostics skipped.");
        }
        if (paths.length > 4) reports.push("LSP: additional changed documents skipped (4 document limit).");
        // Keep approval decisions in model/UI presentation, never in durable observations.
        if (observationReports.length) observationOutput += `\n${observationReports.join("\n").slice(0, 16384)}`;
        if (reports.length) { const lspDiagnostics = reports.join("\n").slice(0, 16384); result = { ...result, lspDiagnostics, output: `${result.output}\n${lspDiagnostics}` }; }
      }
      throwIfCancelled(options);
    }
    }
    emit(options, { type: "tool_completed", name: toolCall.name, result, observationOutput });
    if (tool) await lifecycle?.completed(tool.name, result);
    return { callId: toolCall.callId, output: result.output, result };
  } finally {
    if (diagnosticCall !== undefined) options.diagnostics?.recordToolCallCompleted(diagnosticCall, timeoutEvidence);
  }
}

function waitForInlineContext<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new InlineContextError("cancelled or 60-second resolution deadline exceeded."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  options = { ...options, ...(options.lsp ? { lsp: parseLspConfig(options.lsp) } : {}), checkpoints: options.checkpoints ?? (options.workingDirectory ? new SessionCheckpoints(options.workingDirectory) : undefined) };
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxToolCalls = options.maxToolCalls;
  if (maxToolCalls !== undefined && (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1)) throw new Error("Agent maxToolCalls must be a positive integer.");
  const names = new Set(options.tools.map((tool) => tool.name));
  if (names.size !== options.tools.length) throw new Error("Duplicate tool name in active tool registry.");
  if (names.has(PROGRAM_TOOL_NAME)) throw new Error("Reserved program tool name collision.");
  const lifecycleHooks = prepareLifecycleHooks(options.lifecycleHooks, options.tools);
  const hookTools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const catalog = options.tools.length > TOOL_SEARCH_THRESHOLD ? new ToolCatalog(options.tools) : undefined;
  const programTools = options.programmaticTools === false ? [] : [createProgramTool()];
  const initialTools = catalog ? [...catalog.initial, catalog.searchTool, catalog.describeTool, ...programTools] : [...options.tools, ...programTools];
  const tools = new Map(initialTools.map((tool) => [tool.name, tool]));
  let projectContext: ProjectContext | undefined;
  let previousResponseId: string | undefined;
  let continuationState = options.continuationState;
  let toolOutputs: ToolOutput[] = [];
  let toolCallCount = 0;
  let usage: AgentUsage | undefined;
  const completedToolCallIds = new Set<string>();
  const sessionApprovals = options.sessionApprovals ?? new Set<string>();
  const contextBudgetChars = options.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;
  const changeTracker = options.workingDirectory ? new RunChangeTracker(options.workingDirectory) : undefined;
  let hookCalls = 0;
  let hookLimitReported = false;
  const lifecycleOptions: AgentRunOptions = { ...options, onEvent: (event) => {
    if (event.type === "authorization_requested" || event.type === "authorization_completed" || event.type === "tool_started" || event.type === "tool_completed") {
      options.onEvent?.({ ...event, origin: "lifecycle" });
    } else options.onEvent?.(event);
  } };
  const runHooks = async (event: LifecycleEvent): Promise<void> => {
    for (const hook of lifecycleHooks) {
      if (hook.on !== event.type) continue;
      throwIfCancelled(options);
      if (hookCalls >= 64) {
        if (!hookLimitReported) {
          emit(options, { type: "agent_error", message: "Lifecycle hook limit reached; further hooks skipped." });
          hookLimitReported = true;
        }
        return;
      }
      hookCalls += 1;
      const argumentsText = JSON.stringify({ ...hook.arguments, event });
      try {
        // Fresh approval scope for EACH trigger, even if the user chose session approval.
        // Hook calls never recursively trigger hooks and are not forged provider tool results.
        await executeToolCall({ callId: `lifecycle:${hookCalls}`, name: hook.toolName, arguments: argumentsText },
          hookTools, lifecycleOptions, new Set<string>(), changeTracker);
      } catch {
        throwIfCancelled(options);
        throw new Error("Lifecycle hook execution failed.");
      }
    }
  };
  const lifecycle = lifecycleHooks.length === 0 ? undefined : {
    started: (toolName: string) => runHooks({ type: "tool_started", toolName }),
    completed: async (toolName: string, result: ToolResult): Promise<void> => {
      await runHooks({ type: "tool_completed", toolName, ok: result.ok });
      if (!result.ok || !options.workingDirectory) return;
      const paths = Array.isArray(result.changedPaths) ? result.changedPaths.slice(0, 32) : [];
      for (const path of [...new Set(paths)].slice(0, 8)) {
        if (typeof path !== "string" || path.includes("\0") || path.length > 1024) continue;
        const local = relative(options.workingDirectory, resolve(options.workingDirectory, path));
        if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) continue;
        await runHooks({ type: "file_changed", path: local, toolName });
      }
    },
  };

  try {
    throwIfCancelled(options);
    let resolvedTask = options.task;
    if (options.inlineContextReferences) {
      const refs = parseInlineReferences(options.task);
      if (refs.length) {
        if (!options.workingDirectory) throw new Error("Inline context requires a workspace.");
        const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(60_000)]);
        resolvedTask = await waitForInlineContext(signal, resolveInlineContext(options.task, options.workingDirectory, refs, signal, async (url) => {
          const request: ToolAuthorizationRequest = { name: INLINE_URL_TOOL, operation: "EXECUTE", arguments: JSON.stringify({ url }) };
          emit(options, { type: "authorization_requested", ...request });
          // A URL selection does not grant network consent. Never reuse session/tool approvals.
          const decision = await options.authorize?.(request, signal);
          signal.throwIfAborted();
          const allowed = decision === true || decision === "session";
          emit(options, { type: "authorization_completed", name: request.name, operation: "EXECUTE", allowed });
          return allowed;
        }, Math.max(0, contextBudgetChars - options.task.length - 256)));
      }
    }
    projectContext = options.projectContext ?? (options.workingDirectory
      ? await discoverProjectContext(options.workingDirectory)
      : undefined);
    if (changeTracker) await changeTracker.initialize();
    emit(options, { type: "agent_started", task: options.task });
    if (options.sessionStarting) await runHooks({ type: "session_started" });
    for (let turns = 1; turns <= maxTurns; turns += 1) {
      throwIfCancelled(options);
      await runHooks({ type: "turn_started" });
      // The hook boundary yields even when no hooks are registered; cancellation
      // may arrive before the model attaches its abort listener.
      throwIfCancelled(options);
      let response: AgentResponse;

      try {
        options.diagnostics?.recordModelTurn();
        response = await options.model.respond({
          task: resolvedTask,
          projectContext,
          skills: options.skills,
          memory: options.memory,
          plan: options.plan,
          tools: [...tools.values()],
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
      usage = normalizedUsage(response.usage);
      if (response.continuationState !== undefined) continuationState = response.continuationState;

      if (response.text && !response.textWasStreamed) {
        emit(options, { type: "message_delta", text: response.text });
      }

      if (response.toolCalls.length === 0) {
        await runHooks({ type: "turn_completed" });
        emit(options, { type: "agent_completed", finalText: response.text });
        options.diagnostics?.complete("success");
        return {
          finalText: response.text,
          turns,
          responseId: response.responseId,
          ...(usage === undefined ? {} : { usage }),
          continuationState,
        };
      }

      if (maxToolCalls !== undefined && toolCallCount + response.toolCalls.length > maxToolCalls) {
        throw new Error(`Agent reached the maximum of ${maxToolCalls} tool calls.`);
      }

      toolOutputs = [];
      // A response may call only tools advertised when that response began. Schema activation
      // applies on the next model turn, never to a guessed call in the same batch.
      const visibleAtTurn = new Set(tools.keys());
      for (const toolCall of response.toolCalls) {
        throwIfCancelled(options);
        if (completedToolCallIds.has(toolCall.callId)) {
          toolOutputs.push({ callId: toolCall.callId, output: `Duplicate tool call ID rejected: ${toolCall.callId}.` });
          continue;
        }
        if (maxToolCalls !== undefined && toolCallCount >= maxToolCalls) {
          throw new Error(`Agent reached the maximum of ${maxToolCalls} tool calls.`);
        }
        completedToolCallIds.add(toolCall.callId);
        toolCallCount += 1;
        const nested = async (input: unknown): Promise<ToolResult> => runProgram(input, async (name, args) => {
          throwIfCancelled(options);
          // Nested calls count against the same run cap and cannot gain newly activated
          // tools within this provider response. They use exactly the outer authority path.
          if (maxToolCalls !== undefined && toolCallCount >= maxToolCalls) return { ok: false, output: `Agent reached the maximum of ${maxToolCalls} tool calls.` };
          toolCallCount += 1;
          const output = await executeToolCall({ callId: `${toolCall.callId}:nested:${toolCallCount}`, name, arguments: args },
            tools, options, sessionApprovals, changeTracker, catalog, visibleAtTurn, undefined, lifecycle);
          return output.result;
        }, options.signal);
        const output = await executeToolCall(toolCall, tools, options, sessionApprovals, changeTracker, catalog, visibleAtTurn, nested, lifecycle);
        toolOutputs.push({ callId: output.callId, output: output.output });
        throwIfCancelled(options);
      }
      await runHooks({ type: "turn_completed" });
    }
  } catch (error: unknown) {
    if (error instanceof AgentRunCancelledError || options.signal?.aborted) {
      emit(options, { type: "agent_cancelled", message: "Agent run cancelled." });
      options.diagnostics?.complete("cancelled");
      throw new AgentRunCancelledError();
    }
    if (error instanceof InlineContextError) {
      emit(options, { type: "tool_completed", name: "inline_context", result: { ok: false, output: error.message } });
    }
    options.diagnostics?.complete("failed");
    throw error;
  }

  const message = `Agent reached the maximum of ${maxTurns} model turns.`;
  emit(options, { type: "agent_error", message });
  options.diagnostics?.complete("failed");
  throw new Error(message);
}
