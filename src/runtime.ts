import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

import {
  AgentRunCancelledError,
  runAgent,
  type AgentEvent,
  type AgentRunResult,
  type AgentUsage,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from "./agent.js";
import { BackgroundTaskManager, type BackgroundTask } from "./background-tasks.js";
import { DEFAULT_CONTEXT_BUDGET_CHARS } from "./context-budget.js";
import { RuntimeDiagnosticsService, type RuntimeDiagnosticsSummary } from "./diagnostics.js";
import { McpClientManager, type McpServerStatus } from "./mcp-client.js";
import {
  createMemoryContext,
  createMemorySuggestionTool,
  createMemoryStore,
  createProjectMemoryScope,
  getDragonsMemoryDirectory,
  retrieveRelevantMemories,
  type MemoryStore,
  type PendingMemorySuggestion,
} from "./memory.js";
import { createPlanTools, createSessionPlanStore, type DragonsPlan } from "./plan.js";
import { createPlanOrchestrationTools } from "./orchestration.js";
import { createParallelSubagentTool } from "./parallel-subagents.js";
import { discoverProjectContext } from "./project-context.js";
import { createBuiltInProviderRegistry } from "./provider/builtins.js";
import type { ProviderCapabilities, ProviderDescriptor, ProviderId, ProviderRegistry } from "./provider/registry.js";
import {
  compactSessionMessages,
  createSessionStore,
  getDragonsSessionDirectory,
  type DragonsSession,
  type SessionStore,
} from "./session-store.js";
import { createSkillsContext, getDragonsSkillsDirectory } from "./skills.js";
import { createSubagentTool } from "./subagents.js";
import { createCodingTools, type AgentTool } from "./tools.js";
import { RuntimeTextRedactor } from "./runtime-redaction.js";

const MAX_RUNTIME_INPUT_CHARACTERS = 64_000;
const MCP_SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
export const DEFAULT_MAX_RUNTIME_EVENT_TEXT_BYTES = 8_192;
export const DEFAULT_MAX_RUNTIME_QUEUED_EVENTS = 256;

/** Process-local leases let facades share one injected MCP manager without closing each other's connections. */
const runtimeMcpConnectionLeases = new WeakMap<McpClientManager, Map<string, number>>();

function hasRuntimeMcpConnectionLease(manager: McpClientManager, id: string): boolean {
  return (runtimeMcpConnectionLeases.get(manager)?.get(id) ?? 0) > 0;
}

function acquireRuntimeMcpConnectionLease(manager: McpClientManager, id: string): void {
  const leases = runtimeMcpConnectionLeases.get(manager) ?? new Map<string, number>();
  leases.set(id, (leases.get(id) ?? 0) + 1);
  runtimeMcpConnectionLeases.set(manager, leases);
}

/** Returns whether releasing this facade's lease also releases the physical MCP connection. */
function releaseRuntimeMcpConnectionLease(manager: McpClientManager, id: string): boolean {
  const leases = runtimeMcpConnectionLeases.get(manager);
  const count = leases?.get(id) ?? 0;
  if (count > 1) {
    leases!.set(id, count - 1);
    return false;
  }
  if (!leases) return false;
  leases.delete(id);
  if (leases.size === 0) runtimeMcpConnectionLeases.delete(manager);
  return count === 1;
}

function boundedClientText(value: string): string {
  const redactor = new RuntimeTextRedactor();
  return boundClientText(redactor.push(value) + redactor.finish());
}

function boundClientText(redacted: string): string {
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.length <= DEFAULT_MAX_RUNTIME_EVENT_TEXT_BYTES) return redacted;
  const marker = `[runtime event text truncated at ${DEFAULT_MAX_RUNTIME_EVENT_TEXT_BYTES} bytes]`;
  const available = Math.max(0, DEFAULT_MAX_RUNTIME_EVENT_TEXT_BYTES - Buffer.byteLength(`\n${marker}`));
  return `${bytes.subarray(0, available).toString("utf8")}\n${marker}`;
}

export type RuntimeProvider = {
  id: ProviderId;
  label: string;
  defaultModel: string;
  credentialRequirement: "api-key" | "oauth" | "none";
  capabilities: ProviderCapabilities;
};

/** A client-safe session summary. It never contains transcript bodies or provider continuation state. */
export type RuntimeSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  provider: ProviderId;
  model: string;
  messageCount: number;
  hasContinuation: boolean;
  planTaskCount: number;
};

export type RuntimeRunResult = {
  finalText: string;
  turns: number;
  responseId: string;
  usage?: AgentUsage;
};

/** A client-safe runtime failure. The original provider/tool error is deliberately not retained as a cause. */
export class RuntimeRunError extends Error {
  readonly code = "RUN_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeRunError";
  }
}

export type RuntimeApprovalDecision = "allow_once" | "allow_session" | "deny";

export type ResolveRuntimeAuthorization = {
  runId: string;
  approvalId: string;
  decision: RuntimeApprovalDecision;
};

export type AcknowledgeRuntimeMemorySuggestion = {
  runId: string;
  sessionId: string;
  suggestionId: string;
};

export type ResolveRuntimeMemorySuggestion = AcknowledgeRuntimeMemorySuggestion & {
  decision: "accept" | "reject";
};

/** Client-facing events are structured and deliberately exclude tool arguments and continuation state. */
export type RuntimeEvent =
  | { type: "run_started"; runId: string; sessionId: string; provider: ProviderId; model: string }
  | { type: "assistant_delta"; runId: string; sessionId: string; text: string }
  | {
    type: "tool_activity";
    runId: string;
    sessionId: string;
    toolName: string;
    operation?: "READ" | "WRITE" | "EXECUTE";
    phase: "authorization_requested" | "authorization_completed" | "started" | "completed";
    allowed?: boolean;
    ok?: boolean;
    output?: string;
  }
  | { type: "approval_requested"; runId: string; sessionId: string; approvalId: string; toolName: string; operation: "WRITE" | "EXECUTE" }
  | { type: "memory_suggestion"; runId: string; sessionId: string; suggestionId: string; scope: "USER" | "PROJECT"; body: string; reason?: string }
  | { type: "event_stream_truncated"; runId: string; sessionId: string }
  | { type: "run_completed"; runId: string; sessionId: string; result: RuntimeRunResult }
  | { type: "run_failed"; runId: string; sessionId: string; message: string }
  | { type: "run_cancelled"; runId: string; sessionId: string };

export type RuntimeRunHandle = {
  id: string;
  sessionId: string;
  events: AsyncIterable<RuntimeEvent>;
  result: Promise<RuntimeRunResult>;
  cancel(): boolean;
};

export type SendUserInput = {
  sessionId: string;
  content: string;
};

export type CreateRuntimeSession = {
  provider?: ProviderId;
  model?: string;
};

export type RuntimeStatusOptions = {
  sessionId?: string;
};

/** Bounded client status. Transcript content, provider continuation, and model objects stay private. */
export type RuntimeStatus = {
  session?: RuntimeSession;
  activeRunId?: string;
  contextCharacters: number;
  contextBudgetChars: number;
  recentDiagnostics: RuntimeDiagnosticsSummary[];
};

/** Safe MCP lifecycle metadata; URLs, credential IDs, errors, and remote descriptions stay private. */
export type RuntimeMcpServer = {
  id: string;
  transport: "stdio" | "http";
  authentication: "none" | "bearer";
  state: "disconnected" | "connected";
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  protocolVersion?: string;
  capabilities: { tools: boolean };
  callCount: number;
  failureCount: number;
  cancellationCount: number;
};

export type RuntimeMcpConnection = {
  id: string;
  toolCount: number;
};

/** Client-safe process-local background task state. Prompt bodies are never re-exposed. */
export type RuntimeBackgroundTask = {
  id: string;
  sessionId: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  report?: string;
  error?: string;
};

export type StartRuntimeBackgroundTask = {
  sessionId: string;
  prompt: string;
};

export type CancelRuntimeBackgroundTask = {
  sessionId: string;
  taskId: string;
};

/** Trusted-host dependencies; none are returned from the client-facing runtime surface. */
export type DragonsRuntimeOptions = {
  workingDirectory: string;
  providerRegistry?: ProviderRegistry;
  sessionStore?: SessionStore;
  tools?: AgentTool[];
  mcpManager?: McpClientManager;
  backgroundTasks?: BackgroundTaskManager;
  memoryStore?: MemoryStore;
  diagnostics?: RuntimeDiagnosticsService;
  memoryDirectory?: string;
  skillsDirectory?: string;
  defaultProvider?: ProviderId;
  defaultModel?: string;
  maxTurns?: number;
  contextBudgetChars?: number;
  createRunId?: () => string;
};

export type DragonsRuntime = {
  providers(): RuntimeProvider[];
  createSession(options?: CreateRuntimeSession): Promise<RuntimeSession>;
  resumeSession(id: string): Promise<RuntimeSession>;
  status(options?: RuntimeStatusOptions): Promise<RuntimeStatus>;
  mcpStatus(): RuntimeMcpServer[];
  connectMcp(id: string): Promise<RuntimeMcpConnection>;
  disconnectMcp(id: string): Promise<void>;
  startBackgroundTask(input: StartRuntimeBackgroundTask): Promise<RuntimeBackgroundTask>;
  listBackgroundTasks(sessionId: string): Promise<RuntimeBackgroundTask[]>;
  cancelBackgroundTask(input: CancelRuntimeBackgroundTask): Promise<boolean>;
  sendUserInput(input: SendUserInput): Promise<RuntimeRunHandle>;
  resolveAuthorization(input: ResolveRuntimeAuthorization): boolean;
  acknowledgeMemorySuggestion(input: AcknowledgeRuntimeMemorySuggestion): boolean;
  resolveMemorySuggestion(input: ResolveRuntimeMemorySuggestion): Promise<boolean>;
  cancelRun(runId: string): boolean;
  dispose(): Promise<void>;
};

type ActiveRun = {
  controller: AbortController;
  queue: AsyncEventQueue<RuntimeEvent>;
  pendingApprovals: Map<string, PendingAuthorization>;
  completion: Promise<RuntimeRunResult>;
  eventStreamTruncated: boolean;
  textRedactor: RuntimeTextRedactor;
};

type PendingAuthorization = {
  resolve(decision: ToolAuthorizationDecision): void;
};

type PendingRuntimeMemorySuggestion = {
  runId: string;
  sessionId: string;
  awaitingPresentation: boolean;
  acknowledge(): void;
  reject(): void;
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly maximumValues: number) {}

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    if (this.values.length >= this.maximumValues) return false;
    this.values.push(value);
    return true;
  }

  replaceFirst(value: T, predicate: (queued: T) => boolean): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    const index = this.values.findIndex(predicate);
    if (index < 0) return false;
    this.values.splice(index, 1);
    this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ done: true, value: undefined as never });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    // Do not interpose an async generator: its own next-request queue is unbounded.
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined as never });
    if (this.waiters.length >= this.maximumValues) return Promise.resolve({ done: true, value: undefined as never });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function publicProvider(provider: ProviderDescriptor): RuntimeProvider {
  return {
    id: provider.id,
    label: provider.label,
    defaultModel: provider.defaultModel,
    credentialRequirement: provider.credentialRequirement,
    capabilities: {
      streaming: provider.capabilities.streaming,
      toolCalls: provider.capabilities.toolCalls,
      toolResultContinuation: provider.capabilities.toolResultContinuation,
      usageMetadata: provider.capabilities.usageMetadata,
    },
  };
}

function publicSession(session: DragonsSession): RuntimeSession {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workingDirectory: session.workingDirectory,
    provider: session.provider,
    model: session.model,
    messageCount: session.messages.length,
    hasContinuation: session.continuation !== undefined,
    planTaskCount: session.plan?.tasks.length ?? 0,
  };
}

function publicMcpStatus(status: McpServerStatus): RuntimeMcpServer {
  return {
    id: status.id,
    transport: status.transport,
    authentication: status.authentication,
    state: status.state,
    toolCount: status.toolCount,
    resourceCount: status.resourceCount,
    promptCount: status.promptCount,
    ...(status.protocolVersion === undefined ? {} : { protocolVersion: status.protocolVersion }),
    capabilities: { tools: status.capabilities.tools },
    callCount: status.callCount,
    failureCount: status.failureCount,
    cancellationCount: status.cancellationCount,
  };
}

function publicBackgroundTask(task: BackgroundTask): RuntimeBackgroundTask {
  return {
    id: task.id,
    sessionId: task.sessionId,
    state: task.state,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(task.report === undefined ? {} : { report: boundedClientText(task.report) }),
    ...(task.error === undefined ? {} : { error: boundedClientText(task.error) }),
  };
}

function publicResult(result: AgentRunResult): RuntimeRunResult {
  return {
    finalText: boundedClientText(result.finalText),
    turns: result.turns,
    responseId: result.responseId,
    ...(result.usage === undefined ? {} : { usage: { ...result.usage } }),
  };
}

function checkedInput(input: SendUserInput): string {
  if (!input || typeof input.sessionId !== "string" || !input.sessionId) throw new Error("A runtime session ID is required.");
  if (typeof input.content !== "string") throw new Error("Runtime user input must be a string.");
  const content = input.content.trim();
  if (!content) throw new Error("Runtime user input must not be empty.");
  if (content.length > MAX_RUNTIME_INPUT_CHARACTERS) throw new Error(`Runtime user input exceeds the ${MAX_RUNTIME_INPUT_CHARACTERS}-character limit.`);
  return content;
}

function selectedModel(provider: ProviderDescriptor, candidate: string | undefined): string {
  const model = candidate ?? provider.defaultModel;
  if (typeof model !== "string" || !model.trim() || model.length > 256) throw new Error("Runtime model must be a bounded non-empty string.");
  return model.trim();
}

class DragonsRuntimeCore implements DragonsRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeRunIdsBySession = new Map<string, string>();
  private readonly pendingMemorySuggestions = new Map<string, PendingRuntimeMemorySuggestion>();
  private readonly backgroundTaskIds = new Set<string>();
  private readonly runtimeMcpConnectionIds = new Set<string>();
  private readonly pendingMcpConnections = new Set<Promise<RuntimeMcpConnection>>();
  private disposalCompletion?: Promise<void>;
  /** Process-local only: `runAgent()` owns the scope keys and never persists this set. */
  private readonly sessionApprovalsBySession = new Map<string, Set<string>>();
  private disposed = false;

  constructor(
    private readonly workingDirectory: string,
    private readonly providerRegistry: ProviderRegistry,
    private readonly sessionStore: SessionStore,
    private readonly tools: AgentTool[],
    private readonly mcpManager: McpClientManager | undefined,
    private readonly backgroundTasks: BackgroundTaskManager,
    private readonly memoryStore: MemoryStore,
    private readonly diagnostics: RuntimeDiagnosticsService,
    private readonly skillsDirectory: string,
    private readonly defaultProvider: ProviderId,
    private readonly defaultModel: string | undefined,
    private readonly maxTurns: number | undefined,
    private readonly contextBudgetChars: number | undefined,
    private readonly createRunId: () => string,
  ) {}

  providers(): RuntimeProvider[] {
    this.assertOpen();
    return this.providerRegistry.list().map(publicProvider);
  }

  async createSession(options: CreateRuntimeSession = {}): Promise<RuntimeSession> {
    this.assertOpen();
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Runtime session options must be an object.");
    if (options.provider !== undefined && typeof options.provider !== "string") throw new Error("Runtime provider ID must be a string.");
    const providerId = options.provider ?? this.defaultProvider;
    if (!this.providerRegistry.ids().includes(providerId)) throw new Error("Runtime provider is unavailable.");
    const provider = this.providerRegistry.get(providerId);
    const model = selectedModel(provider, options.model ?? (providerId === this.defaultProvider ? this.defaultModel : undefined));
    const session = await this.sessionStore.create({
      workingDirectory: this.workingDirectory,
      provider: provider.id,
      model,
    });
    return publicSession(session);
  }

  async resumeSession(id: string): Promise<RuntimeSession> {
    this.assertOpen();
    const session = await this.loadOwnedSession(id);
    return publicSession(session);
  }

  async status(options: RuntimeStatusOptions = {}): Promise<RuntimeStatus> {
    this.assertOpen();
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Runtime status options must be an object.");
    if (options.sessionId !== undefined && typeof options.sessionId !== "string") throw new Error("Runtime session ID must be a string.");
    const session = options.sessionId === undefined ? undefined : await this.loadOwnedSession(options.sessionId);
    const continuationCharacters = session?.continuation === undefined ? 0 : JSON.stringify(session.continuation).length;
    return {
      ...(session === undefined ? {} : { session: publicSession(session) }),
      activeRunId: session === undefined ? undefined : this.activeRunIdsBySession.get(session.id),
      contextCharacters: (session?.messages.reduce((total, message) => total + message.content.length, 0) ?? 0) + continuationCharacters,
      contextBudgetChars: this.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS,
      recentDiagnostics: this.diagnostics.recent(),
    };
  }

  mcpStatus(): RuntimeMcpServer[] {
    this.assertOpen();
    return this.mcpManager?.status().map(publicMcpStatus) ?? [];
  }

  async connectMcp(id: string): Promise<RuntimeMcpConnection> {
    this.assertOpen();
    if (typeof id !== "string" || !MCP_SERVER_ID_PATTERN.test(id)) throw new Error("MCP server ID is invalid.");
    if (!this.mcpManager) throw new Error("This runtime has no configured MCP manager.");
    const manager = this.mcpManager;
    const connection = (async (): Promise<RuntimeMcpConnection> => {
      const wasConnected = manager.status().some((server) => server.id === id && server.state === "connected");
      const runtimeOwned = hasRuntimeMcpConnectionLease(manager, id);
      let provisionalLease = !wasConnected || runtimeOwned;
      // Reserve ownership before awaiting: another facade may dispose while we connect.
      if (provisionalLease) acquireRuntimeMcpConnectionLease(manager, id);
      try {
        const tools = await manager.connect(id, [...this.tools, ...manager.tools()]);
        this.assertOpen();
        if (provisionalLease && !this.runtimeMcpConnectionIds.has(id)) {
          this.runtimeMcpConnectionIds.add(id);
          provisionalLease = false; // Transfer this reservation into the facade's owned lease.
        }
        return { id, toolCount: tools.length };
      } finally {
        if (provisionalLease && releaseRuntimeMcpConnectionLease(manager, id)) {
          await manager.disconnect(id);
        }
      }
    })();
    this.pendingMcpConnections.add(connection);
    try {
      return await connection;
    } finally {
      this.pendingMcpConnections.delete(connection);
    }
  }

  async disconnectMcp(id: string): Promise<void> {
    this.assertOpen();
    if (typeof id !== "string" || !MCP_SERVER_ID_PATTERN.test(id)) throw new Error("MCP server ID is invalid.");
    if (!this.mcpManager) throw new Error("This runtime has no configured MCP manager.");
    if (!this.runtimeMcpConnectionIds.has(id)) throw new Error("MCP connection is not owned by this runtime.");
    await this.releaseMcpConnection(id);
  }

  async startBackgroundTask(input: StartRuntimeBackgroundTask): Promise<RuntimeBackgroundTask> {
    this.assertOpen();
    const prompt = checkedInput({ sessionId: input?.sessionId, content: input?.prompt });
    const session = await this.loadOwnedSession(input.sessionId);
    if (this.activeRunIdsBySession.has(session.id)) throw new Error("Cannot start a background task while this session has an active foreground run.");
    const planStore = createSessionPlanStore(this.sessionStore, session.id);
    const [skills, projectContext, projectScope, planTasks] = await Promise.all([
      createSkillsContext(this.skillsDirectory, session.skills ?? [], this.workingDirectory),
      discoverProjectContext(this.workingDirectory),
      createProjectMemoryScope(this.workingDirectory),
      planStore.list(),
    ]);
    const memory = createMemoryContext(retrieveRelevantMemories(await this.memoryStore.list(), prompt, projectScope));
    const provider = this.providerRegistry.get(session.provider);
    this.assertOpen();
    const task = this.backgroundTasks.start({
      sessionId: session.id,
      prompt,
      createModel: () => this.providerRegistry.createModel(provider.id, { model: session.model }),
      tools: [...this.tools, ...(this.mcpManager?.tools() ?? [])],
      workingDirectory: this.workingDirectory,
      projectContext,
      skills,
      memory,
      plan: { version: 1, tasks: planTasks },
    });
    this.backgroundTaskIds.add(task.id);
    return publicBackgroundTask(task);
  }

  async listBackgroundTasks(sessionId: string): Promise<RuntimeBackgroundTask[]> {
    this.assertOpen();
    try {
      const session = await this.loadOwnedSession(sessionId);
      return this.backgroundTasks.list(session.id)
        .filter((task) => this.backgroundTaskIds.has(task.id))
        .map(publicBackgroundTask);
    } catch {
      return [];
    }
  }

  async cancelBackgroundTask(input: CancelRuntimeBackgroundTask): Promise<boolean> {
    this.assertOpen();
    if (!input || typeof input.sessionId !== "string" || typeof input.taskId !== "string") return false;
    try {
      await this.loadOwnedSession(input.sessionId);
    } catch {
      return false;
    }
    const task = this.backgroundTasks.show(input.taskId);
    return task?.sessionId === input.sessionId
      && this.backgroundTaskIds.has(task.id)
      && this.backgroundTasks.cancel(task.id);
  }

  async sendUserInput(input: SendUserInput): Promise<RuntimeRunHandle> {
    this.assertOpen();
    const content = checkedInput(input);
    const session = await this.loadOwnedSession(input.sessionId);
    this.assertOpen();
    if (this.activeRunIdsBySession.has(session.id)) throw new Error("This Dragons session already has an active run.");

    const runId = this.createRunId();
    if (!runId || this.activeRuns.has(runId)) throw new Error("Unable to allocate a unique runtime run ID.");
    const queue = new AsyncEventQueue<RuntimeEvent>(DEFAULT_MAX_RUNTIME_QUEUED_EVENTS);
    const controller = new AbortController();
    const active: ActiveRun = { controller, queue, pendingApprovals: new Map(), completion: Promise.resolve(undefined as never), eventStreamTruncated: false, textRedactor: new RuntimeTextRedactor() };
    this.activeRuns.set(runId, active);
    this.activeRunIdsBySession.set(session.id, runId);
    this.enqueueRuntimeEvent(active, { type: "run_started", runId, sessionId: session.id, provider: session.provider, model: session.model });

    active.completion = this.executeRun(runId, session, content, controller.signal, active)
      .then((result) => {
        this.flushAssistantText(active, runId, session.id);
        this.enqueueRuntimeEvent(active, { type: "run_completed", runId, sessionId: session.id, result });
        return result;
      })
      .catch(async (error: unknown) => {
        this.flushAssistantText(active, runId, session.id);
        await this.rejectPendingMemorySuggestions(runId);
        if (error instanceof AgentRunCancelledError || controller.signal.aborted) {
          this.enqueueRuntimeEvent(active, { type: "run_cancelled", runId, sessionId: session.id });
          throw new AgentRunCancelledError();
        }
        const message = boundedClientText(error instanceof Error ? error.message : "Unexpected runtime error.");
        this.enqueueRuntimeEvent(active, { type: "run_failed", runId, sessionId: session.id, message });
        throw new RuntimeRunError(message);
      })
      .finally(() => {
        this.denyPendingAuthorizations(active);
        queue.close();
        if (this.activeRuns.get(runId) === active) this.activeRuns.delete(runId);
        if (this.activeRunIdsBySession.get(session.id) === runId) this.activeRunIdsBySession.delete(session.id);
      });

    return {
      id: runId,
      sessionId: session.id,
      events: queue,
      result: active.completion,
      cancel: () => this.cancelRun(runId),
    };
  }

  cancelRun(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (!active || active.controller.signal.aborted) return false;
    active.controller.abort();
    return true;
  }

  resolveAuthorization(input: ResolveRuntimeAuthorization): boolean {
    if (this.disposed) return false;
    if (!input || typeof input.runId !== "string" || typeof input.approvalId !== "string") return false;
    const active = this.activeRuns.get(input.runId);
    const pending = active?.pendingApprovals.get(input.approvalId);
    if (!pending) return false;
    if (input.decision === "allow_once") pending.resolve(true);
    else if (input.decision === "allow_session") pending.resolve("session");
    else if (input.decision === "deny") pending.resolve(false);
    else return false;
    return true;
  }

  acknowledgeMemorySuggestion(input: AcknowledgeRuntimeMemorySuggestion): boolean {
    if (!input || typeof input.runId !== "string" || typeof input.sessionId !== "string" || typeof input.suggestionId !== "string") return false;
    const pending = this.pendingMemorySuggestions.get(input.suggestionId);
    if (!pending || !pending.awaitingPresentation || pending.runId !== input.runId || pending.sessionId !== input.sessionId) return false;
    pending.acknowledge();
    return true;
  }

  async resolveMemorySuggestion(input: ResolveRuntimeMemorySuggestion): Promise<boolean> {
    if (!input || typeof input.runId !== "string" || typeof input.sessionId !== "string" || typeof input.suggestionId !== "string") return false;
    if (input.decision !== "accept" && input.decision !== "reject") return false;
    const pending = this.pendingMemorySuggestions.get(input.suggestionId);
    if (!pending || pending.awaitingPresentation || pending.runId !== input.runId || pending.sessionId !== input.sessionId) return false;
    if (input.decision === "accept") {
      const accepted = await this.memoryStore.acceptSuggestion(input.suggestionId);
      this.pendingMemorySuggestions.delete(input.suggestionId);
      return accepted !== undefined;
    }
    const rejected = await this.memoryStore.rejectSuggestion(input.suggestionId);
    this.pendingMemorySuggestions.delete(input.suggestionId);
    return rejected;
  }

  dispose(): Promise<void> {
    if (this.disposalCompletion) return this.disposalCompletion;
    this.disposed = true;
    this.disposalCompletion = this.disposeOwnedResources();
    return this.disposalCompletion;
  }

  private async disposeOwnedResources(): Promise<void> {
    const active = [...this.activeRuns.values()];
    for (const run of active) {
      run.controller.abort();
      this.denyPendingAuthorizations(run);
    }
    await Promise.allSettled([...this.pendingMcpConnections]);
    await Promise.allSettled(active.map((run) => run.completion));
    for (const taskId of this.backgroundTaskIds) this.backgroundTasks.cancel(taskId);
    this.backgroundTaskIds.clear();
    if (this.mcpManager) await Promise.allSettled([...this.runtimeMcpConnectionIds].map((id) => this.releaseMcpConnection(id)));
    await this.rejectPendingMemorySuggestions();
    this.sessionApprovalsBySession.clear();
  }

  private async executeRun(
    runId: string,
    session: DragonsSession,
    content: string,
    signal: AbortSignal,
    active: ActiveRun,
  ): Promise<RuntimeRunResult> {
    const planStore = createSessionPlanStore(this.sessionStore, session.id);
    const [skills, projectContext, projectScope, planTasks] = await Promise.all([
      createSkillsContext(this.skillsDirectory, session.skills ?? [], this.workingDirectory),
      discoverProjectContext(this.workingDirectory),
      createProjectMemoryScope(this.workingDirectory),
      planStore.list(),
    ]);
    const memories = await this.memoryStore.list();
    const memory = createMemoryContext(retrieveRelevantMemories(memories, content, projectScope));
    const provider = this.providerRegistry.get(session.provider);
    const plan: DragonsPlan = { version: 1, tasks: planTasks };
    const createModel = () => this.providerRegistry.createModel(provider.id, { model: session.model });
    const memorySuggestionTool = createMemorySuggestionTool({
      store: this.memoryStore,
      workingDirectory: this.workingDirectory,
      onSuggestion: (suggestion) => this.presentMemorySuggestion(runId, session.id, suggestion, signal, active),
    });
    const advisoryTools = [...this.tools, ...(this.mcpManager?.tools() ?? []), memorySuggestionTool];
    const getPlan = async (): Promise<DragonsPlan> => ({ version: 1, tasks: await planStore.list() });
    const authorizeNested = (request: { name: string; task: string }) => this.requestAuthorization(runId, session.id, {
      name: request.name,
      operation: "EXECUTE",
      arguments: request.task,
    }, signal, active);
    const subagentTool = createSubagentTool({
      createModel,
      tools: advisoryTools,
      projectContext,
      skills,
      memory,
      plan,
      getPlan,
      maxDepth: 2,
      authorizeNested,
      signal,
    });
    const parallelSubagentTool = createParallelSubagentTool({
      createModel,
      tools: advisoryTools,
      projectContext,
      skills,
      memory,
      plan,
      getPlan,
      signal,
    });
    const orchestrationTools = createPlanOrchestrationTools({
      resolveStore: () => planStore,
      createModel,
      tools: advisoryTools,
      projectContext,
      skills,
      memory,
      getPlan,
    });
    const runTools = [
      ...advisoryTools,
      ...createPlanTools(() => planStore),
      subagentTool,
      parallelSubagentTool,
      ...orchestrationTools,
    ];
    const toolOperations = new Map(runTools.map((tool) => [tool.name, tool.operation]));
    const sessionApprovals = this.sessionApprovalsBySession.get(session.id) ?? new Set<string>();
    this.sessionApprovalsBySession.set(session.id, sessionApprovals);
    const runDiagnostics = this.diagnostics.start({ sessionId: session.id, provider: session.provider, model: session.model });
    const result = await runAgent({
      task: content,
      model: createModel(),
      tools: runTools,
      workingDirectory: this.workingDirectory,
      projectContext,
      skills,
      memory,
      plan,
      conversationResponseId: session.continuation?.responseId,
      continuationState: session.continuation?.providerState,
      maxTurns: this.maxTurns,
      contextBudgetChars: this.contextBudgetChars,
      signal,
      sessionApprovals,
      authorize: (request) => this.requestAuthorization(runId, session.id, request, signal, active),
      onEvent: (event) => this.forwardAgentEvent(event, runId, session.id, active, toolOperations),
      diagnostics: runDiagnostics,
    });
    const completedAt = new Date().toISOString();
    const updateSession = (current: DragonsSession): DragonsSession => ({
      ...current,
      updatedAt: completedAt,
      messages: compactSessionMessages([
        ...current.messages,
        { role: "user", content, createdAt: completedAt },
        { role: "assistant", content: result.finalText, createdAt: completedAt },
      ], Math.max(1, Math.floor((this.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS) / 2))),
      continuation: {
        responseId: result.responseId,
        ...(result.continuationState === undefined ? {} : { providerState: result.continuationState }),
      },
    });
    const saved = this.sessionStore.mutate
      ? await this.sessionStore.mutate(session.id, updateSession)
      : await (async () => {
        const next = updateSession(session);
        await this.sessionStore.save(next);
        return next;
      })();
    if (!saved) throw new Error(`Runtime session was not found: ${session.id}`);
    return publicResult(result);
  }

  private async presentMemorySuggestion(
    runId: string,
    sessionId: string,
    suggestion: PendingMemorySuggestion,
    signal: AbortSignal,
    active: ActiveRun,
  ): Promise<boolean> {
    if (this.disposed || signal.aborted || this.pendingMemorySuggestions.has(suggestion.id)) return false;
    const body = boundedClientText(suggestion.body);
    const reason = suggestion.reason === undefined ? undefined : boundedClientText(suggestion.reason);
    // A client must see exactly the durable candidate it may later accept; redaction/truncation fails closed.
    if (body !== suggestion.body || reason !== suggestion.reason) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (acknowledged: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        const pending = this.pendingMemorySuggestions.get(suggestion.id);
        if (pending) {
          pending.awaitingPresentation = false;
          if (!acknowledged) this.pendingMemorySuggestions.delete(suggestion.id);
        }
        resolve(acknowledged);
      };
      const abort = (): void => settle(false);
      const pending: PendingRuntimeMemorySuggestion = {
        runId,
        sessionId,
        awaitingPresentation: true,
        acknowledge: () => settle(true),
        reject: () => {
          if (settled) this.pendingMemorySuggestions.delete(suggestion.id);
          else settle(false);
        },
      };
      this.pendingMemorySuggestions.set(suggestion.id, pending);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        settle(false);
        return;
      }
      this.enqueueRuntimeEvent(active, {
        type: "memory_suggestion",
        runId,
        sessionId,
        suggestionId: suggestion.id,
        scope: suggestion.scope.kind,
        body: suggestion.body,
        ...(suggestion.reason === undefined ? {} : { reason: suggestion.reason }),
      });
    });
  }

  /**
   * A client that stops consuming events must not make a run retain unbounded output.
   * Prefer retaining interactive and terminal lifecycle events over streamed presentation text.
   */
  private enqueueRuntimeEvent(active: ActiveRun, event: RuntimeEvent): void {
    if (active.queue.push(event)) return;

    if (!active.eventStreamTruncated) {
      active.eventStreamTruncated = true;
      active.queue.replaceFirst(
        { type: "event_stream_truncated", runId: event.runId, sessionId: event.sessionId },
        (queued) => queued.type === "assistant_delta" || queued.type === "tool_activity",
      );
    }
    if (event.type === "assistant_delta") return;

    const replaced = active.queue.replaceFirst(event, (queued) => queued.type === "assistant_delta")
      || active.queue.replaceFirst(event, (queued) => queued.type === "tool_activity")
      || active.queue.replaceFirst(event, (queued) => (
        queued.type !== "run_started"
        && queued.type !== "approval_requested"
        && queued.type !== "memory_suggestion"
        && queued.type !== "event_stream_truncated"
      ));
    if (!replaced) active.queue.replaceFirst(event, (queued) => queued.type !== "run_started");
  }

  private flushAssistantText(active: ActiveRun, runId: string, sessionId: string): void {
    const text = active.textRedactor.finish();
    if (text) this.enqueueRuntimeEvent(active, { type: "assistant_delta", runId, sessionId, text: boundClientText(text) });
  }

  private forwardAgentEvent(
    event: AgentEvent,
    runId: string,
    sessionId: string,
    active: ActiveRun,
    toolOperations: ReadonlyMap<string, "READ" | "WRITE" | "EXECUTE">,
  ): void {
    if (event.type === "message_delta") {
      const text = active.textRedactor.push(event.text);
      if (text) this.enqueueRuntimeEvent(active, { type: "assistant_delta", runId, sessionId, text: boundClientText(text) });
      return;
    }
    if (event.type === "authorization_requested" || event.type === "tool_started") this.flushAssistantText(active, runId, sessionId);
    if (event.type === "authorization_requested") {
      this.enqueueRuntimeEvent(active, { type: "tool_activity", runId, sessionId, toolName: event.name, operation: event.operation, phase: "authorization_requested" });
      return;
    }
    if (event.type === "authorization_completed") {
      this.enqueueRuntimeEvent(active, { type: "tool_activity", runId, sessionId, toolName: event.name, operation: event.operation, phase: "authorization_completed", allowed: event.allowed });
      return;
    }
    if (event.type === "tool_started") {
      this.enqueueRuntimeEvent(active, { type: "tool_activity", runId, sessionId, toolName: event.name, operation: toolOperations.get(event.name), phase: "started" });
      return;
    }
    if (event.type === "tool_completed") {
      this.enqueueRuntimeEvent(active, {
        type: "tool_activity",
        runId,
        sessionId,
        toolName: event.name,
        operation: toolOperations.get(event.name),
        phase: "completed",
        ok: event.result.ok,
        output: boundedClientText(event.result.output),
      });
    }
  }

  private requestAuthorization(
    runId: string,
    sessionId: string,
    request: ToolAuthorizationRequest,
    signal: AbortSignal,
    active: ActiveRun,
  ): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision> {
    const operation = request.operation;
    if (operation === "READ") return true;
    if (signal.aborted) return false;
    const approvalId = randomUUID();
    return new Promise<ToolAuthorizationDecision>((resolve) => {
      const settle = (decision: ToolAuthorizationDecision): void => {
        const pending = active.pendingApprovals.get(approvalId);
        if (!pending) return;
        active.pendingApprovals.delete(approvalId);
        signal.removeEventListener("abort", abort);
        resolve(decision);
      };
      const abort = (): void => settle(false);
      active.pendingApprovals.set(approvalId, { resolve: settle });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        settle(false);
        return;
      }
      this.enqueueRuntimeEvent(active, {
        type: "approval_requested",
        runId,
        sessionId,
        approvalId,
        toolName: request.name,
        operation,
      });
    });
  }

  private denyPendingAuthorizations(active: ActiveRun): void {
    for (const pending of [...active.pendingApprovals.values()]) pending.resolve(false);
  }

  private async rejectPendingMemorySuggestions(runId?: string): Promise<void> {
    const pending = [...this.pendingMemorySuggestions.entries()]
      .filter(([, suggestion]) => runId === undefined || suggestion.runId === runId);
    await Promise.allSettled(pending.map(async ([suggestionId, suggestion]) => {
      suggestion.reject();
      await this.memoryStore.rejectSuggestion(suggestionId);
    }));
  }

  private async releaseMcpConnection(id: string): Promise<void> {
    if (!this.mcpManager || !this.runtimeMcpConnectionIds.delete(id)) return;
    if (releaseRuntimeMcpConnectionLease(this.mcpManager, id)) await this.mcpManager.disconnect(id);
  }

  private async loadOwnedSession(id: string): Promise<DragonsSession> {
    const session = await this.sessionStore.load(id);
    this.assertOpen();
    if (!session) throw new Error("Runtime session was not found or is unreadable.");
    if (session.workingDirectory !== this.workingDirectory) throw new Error("Runtime session belongs to a different workspace.");
    this.providerRegistry.get(session.provider);
    return session;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Dragons runtime has been disposed.");
  }
}

/**
 * Creates a trusted, programmatic facade over the existing `runAgent()` security boundary.
 * Client-facing methods return copies/summaries only; models, tools, stores, and credentials stay private.
 */
export async function createDragonsRuntime(options: DragonsRuntimeOptions): Promise<DragonsRuntime> {
  if (!options || typeof options.workingDirectory !== "string" || !options.workingDirectory) throw new Error("A runtime working directory is required.");
  const workingDirectory = await realpath(options.workingDirectory);
  if (!(await stat(workingDirectory)).isDirectory()) throw new Error("Runtime working directory must be a directory.");
  const providerRegistry = options.providerRegistry ?? createBuiltInProviderRegistry();
  const providerIds = providerRegistry.ids();
  if (providerIds.length === 0) throw new Error("A runtime requires at least one provider.");
  const defaultProvider = options.defaultProvider ?? providerIds[0]!;
  providerRegistry.get(defaultProvider);
  const sessionStore = options.sessionStore ?? createSessionStore(getDragonsSessionDirectory(), { providerIds });
  const tools = options.tools ? [...options.tools] : await createCodingTools(workingDirectory);
  const backgroundTasks = options.backgroundTasks ?? new BackgroundTaskManager();
  const memoryStore = options.memoryStore ?? createMemoryStore(options.memoryDirectory ?? getDragonsMemoryDirectory());
  const diagnostics = options.diagnostics ?? new RuntimeDiagnosticsService();
  const core = new DragonsRuntimeCore(
    workingDirectory,
    providerRegistry,
    sessionStore,
    tools,
    options.mcpManager,
    backgroundTasks,
    memoryStore,
    diagnostics,
    options.skillsDirectory ?? getDragonsSkillsDirectory(),
    defaultProvider,
    options.defaultModel,
    options.maxTurns,
    options.contextBudgetChars,
    options.createRunId ?? randomUUID,
  );
  // TypeScript private fields are ordinary JS properties: never return the core instance.
  return Object.freeze({
    providers: core.providers.bind(core),
    createSession: core.createSession.bind(core),
    resumeSession: core.resumeSession.bind(core),
    status: core.status.bind(core),
    mcpStatus: core.mcpStatus.bind(core),
    connectMcp: core.connectMcp.bind(core),
    disconnectMcp: core.disconnectMcp.bind(core),
    startBackgroundTask: core.startBackgroundTask.bind(core),
    listBackgroundTasks: core.listBackgroundTasks.bind(core),
    cancelBackgroundTask: core.cancelBackgroundTask.bind(core),
    sendUserInput: core.sendUserInput.bind(core),
    resolveAuthorization: core.resolveAuthorization.bind(core),
    acknowledgeMemorySuggestion: core.acknowledgeMemorySuggestion.bind(core),
    resolveMemorySuggestion: core.resolveMemorySuggestion.bind(core),
    cancelRun: core.cancelRun.bind(core),
    dispose: core.dispose.bind(core),
  });
}
