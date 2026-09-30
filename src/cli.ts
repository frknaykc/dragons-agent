#!/usr/bin/env node
import { createSessionHistoryRecorder, createSessionSearchTools } from "./session-search.js";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { realpath, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  AgentRunCancelledError,
  runAgent,
  type AgentEvent,
  type AgentModel,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from "./agent.js";
import {
  createChatGPTAuthService,
  type ChatGPTAuthService,
} from "./provider/codex-auth.js";
import { configureProfileReasoning } from "./reasoning-preferences.js";
import { readTerminalSecret, type SecretTerminalOutput } from "./cli/secret-input.js";
import { createApiKeyAuth, isApiKeyProvider, type ApiKeyAuth } from "./provider/api-key-auth.js";

import { createBuiltInProviderRegistry } from "./provider/builtins.js";
import { DEFAULT_PROVIDER_IDS, type ProviderRegistry } from "./provider/registry.js";
import { createCodingTools, type AgentTool } from "./tools.js";
import { discoverProjectContext } from "./project-context.js";
import { createSubagentTool } from "./subagents.js";
import { createParallelSubagentTool } from "./parallel-subagents.js";
import { BackgroundTaskManager, type BackgroundTask } from "./background-tasks.js";
import {
  PersistentBackgroundJobManager,
  createPersistentBackgroundJobStore,
  getDragonsPersistentBackgroundJobsDirectory,
  type PersistentBackgroundJob,
} from "./persistent-background-jobs.js";
import { McpClientManager } from "./mcp-client.js";
import { RuntimeDiagnosticsService, formatRuntimeDiagnostics, type RuntimeDiagnosticsRun } from "./diagnostics.js";
import { createTerminalRenderer, type TerminalRenderer } from "./terminal/renderer.js";
import { loadDragonsConfig, parseDragonsConfig, saveDragonsConfig, type DragonsConfig } from "./config.js";
import { createDragonsRuntime } from "./runtime.js";
import { createRuntimeSessionLoop } from "./session-loop-runtime.js";
import { createPersistentGoalService } from "./persistent-goal-service.js";
import { goalWorkspaceDirectory, inspectPersistentGoalLock, recoverAbandonedPersistentGoalLock } from "./persistent-goal-store.js";
import { GOAL_USAGE, parseInteractiveGoalCommand } from "./cli/goal-commands.js";
import { KANBAN_USAGE, parseKanbanWorkerLane, parseKanbanWorkerStart, parseInteractiveKanbanCommand, runInteractiveKanbanCommand } from "./cli/kanban-commands.js";
import { createFileKanbanBoard, inspectKanbanLock, kanbanWorkspaceDirectory, recoverAbandonedKanbanLock } from "./kanban.js";
import { launchKanbanWorker } from "./kanban-worker-process.js";
import { runKanbanWorkerLane } from "./kanban-worker-lane.js";
import { runMixtureOfAgents } from "./mixture-of-agents.js";
import { MIXTURE_USAGE, parseInteractiveMixtureCommand } from "./cli/mixture-commands.js";
import { batchWorkspaceDirectory, createFileBatchQueue, inspectBatchLock, recoverAbandonedBatchLock } from "./batch-queue.js";
import { runBatch } from "./batch-runner.js";
import { BATCH_USAGE, parseInteractiveBatchCommand } from "./cli/batch-commands.js";
import { DEFAULT_DRAGONS_PROFILE } from "./profiles.js";
import type { SessionLoop } from "./session-loop.js";
import type { DragonsRuntime } from "./runtime.js";
import { connectRemoteRuntime } from "./remote/runtime.js";
import { runTui, type TuiOutput } from "./tui/terminal.js";
import { createTuiLocalCommands } from "./tui/local-commands.js";
import { DRAGONS_VERSION } from "./version.js";
import {
  compactSessionMessages,
  createSessionStore,
  getDragonsSessionDirectory,
  type DragonsSession,
  type SessionStore,
} from "./session-store.js";
import {
  createSkillsContext,
  getProjectSkillsDirectory,
  getDragonsSkillsDirectory,
  type SkillReference,
} from "./skills.js";
import {
  createMemoryStore,
  createMemorySuggestionTool,
  getDragonsMemoryDirectory,
  type MemoryStore,
} from "./memory.js";
import {
  createPlanTools,
  createSessionPlanStore,
} from "./plan.js";
import { createPlanOrchestrationTools } from "./orchestration.js";
import { parseCliCommand as parseBaseCliCommand, providerFrom, type CliCommand, type ProviderName } from "./cli/commands.js";
import { formatMemorySuggestion, handleInteractiveMemoryCommand, memoryContextFor, runMemoryCommand } from "./cli/memory-commands.js";
import { handleInteractivePlanCommand, runPlanCommand } from "./cli/plan-commands.js";
import { runCronCommand } from "./cli/cron-commands.js";
import { handleInteractiveSkillsCommand, runSkillsCommand, writeActiveSkillNotices } from "./cli/skills-commands.js";
import { SessionCheckpoints, checkpointCommand, isCheckpointCommand } from "./checkpoint.js";
import { formatSlashHelp, SLASH_COMMANDS } from "./slash-commands.js";
import { slashChoices } from "./slash-choices.js";
import { createLineInput, type LineInput } from "./cli/line-input.js";
import { createIsolatedWorktree, selectIsolatedWorktree } from "./worktree.js";
import { createDragonsProfileStore, type DragonsProfileStore } from "./profiles.js";

type AuthCommand = Extract<CliCommand, { kind: "auth" }> & { provider?: string };

// Auth parsing belongs to this trusted host; keys are never accepted as arguments.
export function parseCliCommand(arguments_: string[], providerIds: readonly string[] = DEFAULT_PROVIDER_IDS): CliCommand | AuthCommand {
  const args = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (args[0] !== "auth") return parseBaseCliCommand(arguments_, providerIds);
  const action = args[1];
  const provider = args[3];
  if (!["login", "logout", "status"].includes(action ?? "") ||
      !(args.length === 2 && action === "status" || args.length === 4 && args[2] === "--provider" &&
        (provider === "chatgpt" || isApiKeyProvider(provider) || provider === "local"))) {
    throw new Error("Use dragons auth <login|status|logout> --provider <provider>. Never include credentials.");
  }
  return { kind: "auth", action: action as AuthCommand["action"], ...(provider && provider !== "chatgpt" ? { provider } : {}) };
}
export type { ProviderName } from "./cli/commands.js";

type ModelFactory = { create(provider: ProviderName, model?: string): AgentModel }["create"];

export type CliDependencies = {
  workingDirectory?: string;
  model?: AgentModel;
  /** Method-style callback retains compatibility with existing narrowed built-in-provider test doubles. */
  modelFactory?: ModelFactory;
  /** Registered adapters for this CLI process. Registry metadata never stores credentials or session state. */
  providerRegistry?: ProviderRegistry;
  apiKeyAuth?: ApiKeyAuth;
  /** Dedicated terminal output, never the general log/render callback. */
  secretOutput?: SecretTerminalOutput;
  chatgptAuth?: Pick<ChatGPTAuthService, "login" | "status" | "logout"> & Partial<Pick<ChatGPTAuthService, "credentials">>;
  tools?: AgentTool[];
  input?: NodeJS.ReadableStream;
  /** TUI-only writable terminal injection; existing plain write callbacks remain unchanged. */
  tuiOutput?: TuiOutput;
  write?: (text: string) => void;
  terminal?: {
    inputIsTTY?: boolean;
    outputIsTTY?: boolean;
    columns?: number;
    resizeSource?: NodeJS.EventEmitter & { columns?: number };
    color?: boolean;
  };
  sessionDirectory?: string;
  sessionStore?: SessionStore;
  configPath?: string;
  /** Active profile locator; injected only to preserve one profile root through an interactive run. */
  profileStore?: DragonsProfileStore;
  config?: DragonsConfig;
  /** Dragons-owned skills root. It is never inferred from the project workspace. */
  skillsDirectory?: string;
  /** Dragons-owned memory root. It is never inferred from the project workspace. */
  memoryDirectory?: string;
  /** App-owned durable M60 job state root; runtime handles and approvals are never stored here. */
  backgroundJobsDirectory?: string;
  /** Active profile's workspace-partitioned cron state root. */
  cronDirectory?: string;
  /** Host-injected stop signal for a foreground cron service. */
  cronSignal?: AbortSignal;
  /** Process-local MCP connections; dependency injection exists for deterministic tests only. */
  mcpManager?: McpClientManager;
  /** Process-local bounded diagnostics; never saved into Dragons session JSON. */
  diagnostics?: RuntimeDiagnosticsService;
};

type AnswerSource = {
  next: (signal?: AbortSignal) => Promise<IteratorResult<string>>;
};

/** Own the underlying read across sequential composer/approval consumers. Cancelling
 * a consumer cannot cancel readline.next(): retain that read for the next owner.
 */
function createAnswerSource(read: () => Promise<IteratorResult<string>>): AnswerSource {
  let pending: Promise<IteratorResult<string>> | undefined;
  return { next(signal) {
    if (signal?.aborted) return Promise.resolve({ done: true, value: undefined });
    pending ??= read();
    const current = pending;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => { settled = true; signal?.removeEventListener("abort", cancel); };
      const cancel = (): void => {
        if (settled) return;
        cleanup();
        // Do not consume/clear current: the composer must receive its first line.
        resolve({ done: true, value: undefined });
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void current.then((answer) => {
        if (settled) return;
        cleanup();
        pending = undefined;
        resolve(answer);
      }, (error: unknown) => {
        if (settled) return;
        cleanup();
        pending = undefined;
        reject(error);
      });
    });
  } };
}

function createAuthorizer(
  answers: AnswerSource,
  renderApproval: (request: ToolAuthorizationRequest) => void,
  signal?: AbortSignal,
): (request: ToolAuthorizationRequest, signal?: AbortSignal) => Promise<ToolAuthorizationDecision> {
  return async (request: ToolAuthorizationRequest, approvalSignal?: AbortSignal): Promise<ToolAuthorizationDecision> => {
    if (request.operation === "READ") return true;
    const lifetime = approvalSignal && signal ? AbortSignal.any([approvalSignal, signal]) : approvalSignal ?? signal;
    if (lifetime?.aborted) return false;
    renderApproval(request);
    const answer = await answers.next(lifetime);
    const response = answer.done ? "" : answer.value.trim().toLowerCase();
    if (response === "session" || response === "always" || response === "a") return "session";
    return response === "y" || response === "yes";
  };
}

function createCliAuthorizer(
  input: NodeJS.ReadableStream,
  renderer: TerminalRenderer,
  signal?: AbortSignal,
): { authorize: (request: ToolAuthorizationRequest, signal?: AbortSignal) => Promise<ToolAuthorizationDecision>; close: () => void } {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const answers = createAnswerSource(() => iterator.next());
  return {
    authorize: createAuthorizer(answers, (request) => renderer.renderApproval(request), signal),
    close: () => lines.close(),
  };
}

function renderEvent(
  event: AgentEvent,
  renderer: TerminalRenderer,
  operations: Map<string, AgentTool["operation"]>,
): void {
  if (event.type === "agent_started") renderer.startRun("thinking");
  if (event.type === "message_delta") renderer.renderMessage(event.text);
  if (event.type === "tool_started") {
    renderer.renderToolStarted({
      name: event.name,
      operation: operations.get(event.name) ?? "READ",
      arguments: event.arguments,
    });
  }
  if (event.type === "tool_completed") renderer.renderToolCompleted(event.name, event.result.ok, event.result.changedPaths, event.result.rollbackCoverage, event.result.lspDiagnostics);
  if (event.type === "agent_cancelled") renderer.renderCancelled();
  if (event.type === "agent_completed") renderer.finishRun();
}

function formatBackgroundTask(task: BackgroundTask): string {
  const lines = [
    `${task.id}  [${task.state}]  ${task.createdAt}`,
    `Prompt: ${task.prompt}`,
  ];
  if (task.startedAt) lines.push(`Started: ${task.startedAt}`);
  if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);
  if (task.transcript) lines.push(`Transcript:\n${task.transcript}`);
  if (task.report) lines.push(`Report:\n${task.report}`);
  if (task.error) lines.push(`Error:\n${task.error}`);
  return lines.join("\n");
}

function formatBackgroundTaskList(tasks: readonly BackgroundTask[]): string {
  if (tasks.length === 0) return "No background tasks for this session.";
  return tasks.map((task) => `${task.id}  [${task.state}]  ${task.prompt}`).join("\n");
}

function formatPersistentBackgroundJob(job: PersistentBackgroundJob): string {
  const lines = [
    `${job.id}  [${job.state}]  ${job.createdAt}`,
    `Prompt: ${job.prompt}`,
    `Policy: ${job.executionPolicy}`,
    `Attempts: ${job.executionAttempts}`,
  ];
  if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
  if (job.completedAt) lines.push(`Completed: ${job.completedAt}`);
  if (job.transcript) lines.push(`Transcript:\n${job.transcript}`);
  if (job.report) lines.push(`Report:\n${job.report}`);
  if (job.error) lines.push(`Error:\n${job.error}`);
  return lines.join("\n");
}

function formatPersistentBackgroundJobList(jobs: readonly PersistentBackgroundJob[]): string {
  if (jobs.length === 0) return "No persistent background jobs for this session.";
  return jobs.map((job) => `${job.id}  [${job.state}]  ${job.prompt}`).join("\n");
}

function terminalRenderer(
  dependencies: CliDependencies,
  input: NodeJS.ReadableStream,
  write: (text: string) => void,
  interactive: boolean,
): TerminalRenderer {
  const inputIsTTY = dependencies.terminal?.inputIsTTY
    ?? Boolean((input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY ?? process.stdin.isTTY);
  const outputIsTTY = dependencies.terminal?.outputIsTTY ?? Boolean(process.stdout.isTTY);
  const isTTY = interactive && inputIsTTY && outputIsTTY;
  const configuredWidth = dependencies.terminal?.columns ?? process.stdout.columns ?? 80;
  const width = Number.isFinite(configuredWidth) && configuredWidth > 0
    ? Math.max(1, Math.floor(configuredWidth))
    : 80;
  const color = isTTY && !Object.hasOwn(process.env, "NO_COLOR") && (dependencies.terminal?.color ?? true);
  const resizeSource = dependencies.terminal?.resizeSource ?? (dependencies.terminal?.columns === undefined ? process.stdout : undefined);
  return createTerminalRenderer({ write, isTTY, color, width, resizeSource });
}

function providerRegistryFor(dependencies: CliDependencies, localEndpoint?: string, environmentOnly = false, apiKeySlots?: Partial<Record<import("./provider/api-key-auth.js").ApiKeyProvider, string>>): ProviderRegistry {
  return dependencies.providerRegistry ?? createBuiltInProviderRegistry({
    apiKeyAuth: dependencies.apiKeyAuth ?? (environmentOnly ? false : undefined),
    ...(apiKeySlots === undefined ? {} : { apiKeySlots }),
    ...(dependencies.chatgptAuth?.credentials ? { chatgptAuth: { credentials: dependencies.chatgptAuth.credentials } } : {}),
    ...(localEndpoint === undefined ? {} : { localEndpoint }),
  });
}

function defaultModel(
  providers: ProviderRegistry,
  provider: ProviderName,
  model: string | undefined,
  write: (text: string) => void,
): AgentModel {
  return providers.createModel(provider, { model, write });
}

/** Children/background jobs have no adoption hook: fallback fails closed without isolated identity ownership. */
function createFreshSubagentModel(dependencies: CliDependencies, providers: ProviderRegistry, provider: ProviderName, model: string | undefined, write: (text: string) => void): AgentModel {
  return dependencies.modelFactory?.(provider, model) ?? defaultModel(
    providers,
    provider,
    model,
    write,
  );
}

async function runAuthCommand(command: AuthCommand, dependencies: CliDependencies, write: (text: string) => void, signal = new AbortController().signal): Promise<void> {
  const provider = command.provider ?? "chatgpt";
  if (provider === "local") { write("Local: no authentication required.\n"); return; }
  if (isApiKeyProvider(provider)) {
    const auth = dependencies.apiKeyAuth;
    if (!auth) { write("API-key authentication requires an active profile.\n"); return; }
    try {
      if (command.action === "login") {
        const input = dependencies.input ?? process.stdin;
        const output = dependencies.secretOutput ?? process.stdout;
        if (!(input as { isTTY?: boolean }).isTTY || !output.isTTY || !(input as { setRawMode?: unknown }).setRawMode) {
          write("API-key entry requires a dedicated TTY on stdin and stdout. Never pass keys as arguments or chat text.\n");
          return;
        }
        const saved = await auth.login(provider, (abort) => readTerminalSecret(input, output, abort), signal);
        write(saved ? `${provider}: API key saved in OS credential storage. Restart Dragons to use the new key; the current runtime is unchanged.\n` : `${provider}: sign-in cancelled.\n`);
      } else if (command.action === "logout") {
        await auth.logout(provider);
        write(`${provider}: saved API key removed. Environment credentials are unchanged. Restart Dragons to clear credentials held by the current runtime.\n`);
      } else {
        const saved = Boolean(await auth.credentials(provider));
        write(`${provider}: ${saved ? "saved API key present in OS credential storage" : "no saved API key"}. Environment credentials are separate; this does not verify provider access.\n`);
      }
    } catch {
      write(`${provider}: API-key ${command.action} failed. Check terminal input and OS credential storage.\n`);
    }
    return;
  }
  if (provider !== "chatgpt") { write("Unknown authentication provider. Never include credentials.\n"); return; }
  const auth = dependencies.chatgptAuth ?? createChatGPTAuthService({ write });
  if (command.action === "login") {
    await auth.login({ signal });
    return;
  }
  if (command.action === "logout") {
    await auth.logout();
    write("ChatGPT Subscription (Experimental): signed out\n");
    return;
  }
  const status = await auth.status();
  if (!status.authenticated) {
    write(`ChatGPT Subscription (Experimental): not signed in${status.storage ? `\nCredential storage: ${status.storage}` : ""}\nRun dragons auth login --provider chatgpt.\n`);
    return;
  }
  write(`ChatGPT Subscription (Experimental): signed in${status.expiresAt ? ` (expires ${status.expiresAt})` : ""}${status.storage ? `\nCredential storage: ${status.storage}` : ""}\n`);
}

function providerLabel(providers: ProviderRegistry, provider: ProviderName): string {
  return providers.get(provider).label;
}

function selectedModel(providers: ProviderRegistry, provider: ProviderName, model: string | undefined): string {
  return model ?? providers.get(provider).defaultModel;
}

function sessionStoreFor(dependencies: CliDependencies, providers: ProviderRegistry): SessionStore {
  return dependencies.sessionStore ?? createSessionStore(dependencies.sessionDirectory ?? getDragonsSessionDirectory(), { providerIds: providers.ids() });
}

function skillsDirectoryFor(dependencies: CliDependencies): string {
  return dependencies.skillsDirectory ?? getDragonsSkillsDirectory();
}

function memoryStoreFor(dependencies: CliDependencies): MemoryStore {
  return createMemoryStore(dependencies.memoryDirectory ?? getDragonsMemoryDirectory());
}

function persistentBackgroundJobsFor(
  dependencies: CliDependencies,
  onJobStarted?: (job: PersistentBackgroundJob) => RuntimeDiagnosticsRun | undefined,
): PersistentBackgroundJobManager {
  return new PersistentBackgroundJobManager({
    store: createPersistentBackgroundJobStore(dependencies.backgroundJobsDirectory ?? getDragonsPersistentBackgroundJobsDirectory()),
    onJobStarted,
  });
}

function sessionPreview(session: DragonsSession): string | undefined {
  const message = session.messages.find(({ role }) => role === "user")?.content.replace(/\s+/g, " ").trim();
  if (!message) return undefined;
  return message.length > 72 ? `${message.slice(0, 71)}…` : message;
}

async function listSessions(store: SessionStore, write: (text: string) => void): Promise<void> {
  const sessions = await store.list();
  if (sessions.length === 0) {
    write("No saved Dragons sessions.\n");
    return;
  }
  for (const session of sessions) {
    const preview = sessionPreview(session);
    write(`${session.id}  ${session.updatedAt}  ${session.provider} · ${session.model}  ${session.workingDirectory}${preview ? `  — ${preview}` : ""}\n`);
  }
}

function writeMcpList(manager: McpClientManager, write: (text: string) => void): void {
  const servers = manager.list();
  if (servers.length === 0) { write("No MCP servers are configured.\n"); return; }
  for (const server of servers) write(`${server.id}  ${server.transport === "http" ? "http" : "stdio"}\n`);
}

function writeMcpStatus(manager: McpClientManager, write: (text: string) => void): void {
  const servers = manager.status();
  if (servers.length === 0) { write("No MCP servers are configured.\n"); return; }
  for (const server of servers) {
    const metadata = [
      server.transport,
      server.authentication === "bearer" ? "auth bearer" : undefined,
      server.protocolVersion ? `MCP ${server.protocolVersion}` : undefined,
      server.connectDurationMilliseconds !== undefined ? `connect ${server.connectDurationMilliseconds}ms` : undefined,
      server.discoveryDurationMilliseconds !== undefined ? `discover ${server.discoveryDurationMilliseconds}ms` : undefined,
      server.lastInvocationDurationMilliseconds !== undefined ? `last call ${server.lastInvocationDurationMilliseconds}ms` : undefined,
      server.callCount > 0 ? `${server.callCount} call${server.callCount === 1 ? "" : "s"}` : undefined,
      server.failureCount > 0 ? `${server.failureCount} failure${server.failureCount === 1 ? "" : "s"}` : undefined,
      server.lastFailureCategory ? `last failure ${server.lastFailureCategory}` : undefined,
    ].filter(Boolean).join(", ");
    const counts = `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    const inventory = `${server.resourceCount} resource${server.resourceCount === 1 ? "" : "s"}, ${server.promptCount} prompt${server.promptCount === 1 ? "" : "s"}`;
    const names = server.toolNames.length > 0 ? ` — tools ${server.toolNames.join(", ")}` : "";
    write(`${server.id}: ${server.state} (${counts}) — ${inventory}${names}${metadata ? ` — ${metadata}` : ""}${server.lastError ? ` — ${server.lastError}` : ""}\n`);
  }
}

async function connectMcp(manager: McpClientManager, id: string, tools: AgentTool[], operations: Map<string, AgentTool["operation"]>, write: (text: string) => void): Promise<void> {
  const connected = await manager.connect(id, tools);
  for (const tool of connected) { if (!tools.some((candidate) => candidate.name === tool.name)) tools.push(tool); operations.set(tool.name, tool.operation); }
  write(`Connected MCP server ${id} (${connected.length} tool${connected.length === 1 ? "" : "s"})\n`);
}

async function connectAllMcp(manager: McpClientManager, tools: AgentTool[], operations: Map<string, AgentTool["operation"]>, write: (text: string) => void): Promise<void> {
  const result = await manager.connectAll(tools);
  for (const id of result.connected) {
    for (const tool of manager.toolsFor(id)) {
      if (!tools.some((candidate) => candidate.name === tool.name)) tools.push(tool);
      operations.set(tool.name, tool.operation);
    }
  }
  if (result.connected.length === 0 && result.failed.length === 0) { write("No MCP servers are configured.\n"); return; }
  if (result.connected.length > 0) write(`Connected MCP servers: ${result.connected.join(", ")}\n`);
  if (result.failed.length > 0) write(`Failed MCP servers: ${result.failed.join(", ")}\n`);
}

async function disconnectMcp(manager: McpClientManager, id: string, tools: AgentTool[], operations: Map<string, AgentTool["operation"]>, write: (text: string) => void): Promise<void> {
  const names = new Set(manager.toolsFor(id).map((tool) => tool.name));
  await manager.disconnect(id);
  for (let index = tools.length - 1; index >= 0; index -= 1) if (names.has(tools[index]!.name)) tools.splice(index, 1);
  for (const name of names) operations.delete(name);
  write(`Disconnected MCP server ${id}\n`);
}

async function requireSessionWorkspace(workingDirectory: string): Promise<void> {
  try {
    if ((await stat(workingDirectory)).isDirectory()) return;
  } catch {
    // The error below gives the user a stable remediation message.
  }
  throw new Error(`Saved session workspace is unavailable: ${workingDirectory}`);
}

async function runInteractiveConversation(
  command: Extract<CliCommand, { kind: "run" }>,
  dependencies: CliDependencies,
  providers: ProviderRegistry,
  write: (text: string) => void,
  model: AgentModel | undefined,
  tools: AgentTool[],
  workingDirectory: string,
  skillsDirectory: string,
  memoryStore: MemoryStore,
  sessionStore: SessionStore,
  initialSession: DragonsSession,
  resumed: boolean,
  mcp: McpClientManager,
  diagnostics: RuntimeDiagnosticsService,
  profileName?: string,
): Promise<void> {
  const input = dependencies.input ?? process.stdin;
  const renderer = terminalRenderer(dependencies, input, write, true);
  const operations = new Map(tools.map((tool) => [tool.name, tool.operation]));
  let lines: LineInput;
  const answers = createAnswerSource(() => lines.next());
  let activeController: AbortController | undefined;
  let session = initialSession;
  let sessionLoop: SessionLoop | undefined;
  let loopRuntime: DragonsRuntime | undefined;
  let goalRuntime: DragonsRuntime | undefined;
  let goalService: ReturnType<typeof createPersistentGoalService> | undefined;
  let lastLoopReport: string | undefined;
  let loopFailures = 0;
  const stopSessionLoop = async (): Promise<void> => {
    const previous = sessionLoop;
    sessionLoop = undefined;
    await previous?.stop();
  };
  // Plan tools resolve the currently selected session at execution time; no plan is injected into provider continuation or transcript state.
  const planTools = createPlanTools(() => createSessionPlanStore(sessionStore, session.id));
  tools.push(...planTools);
  for (const tool of planTools) operations.set(tool.name, tool.operation);
  let conversationResponseId = session.continuation?.responseId;
  let continuationState = session.continuation?.providerState;
  let activeProvider = command.provider;
  let activeModelName = selectedModel(providers, command.provider, command.model);
  let activeModelInput = command.model;
  let activeModel = model;
  let activeRunDiagnostics: RuntimeDiagnosticsRun | undefined;
  const createInteractiveModel = (modelInput: string | undefined): AgentModel =>
    dependencies.modelFactory?.(activeProvider, modelInput) ?? dependencies.model
    ?? providers.createModel(activeProvider, { model: activeModelName, write }, async (target) => {
      // Invalidate before awaiting persistence: failed/cancelled adoption poisons the wrapper.
      activeModel = undefined;
      if (!activeController || activeController.signal.aborted) return false;
      const adopt = (current: DragonsSession): DragonsSession => {
        if (activeController?.signal.aborted) throw new Error("Fallback identity adoption cancelled.");
        if (current.workingDirectory !== workingDirectory || current.provider !== activeProvider
          || current.model !== activeModelName || current.continuation !== undefined) {
          throw new Error("Fallback identity adoption requires an unchanged fresh session.");
        }
        return { ...current, provider: target.provider, model: target.model, continuation: undefined, updatedAt: new Date().toISOString() };
      };
      const saved = sessionStore.mutate
        ? await sessionStore.mutate(session.id, adopt)
        : await (async () => { const next = adopt(session); await sessionStore.save(next); return next; })();
      if (!saved) throw new Error("Fallback session disappeared before identity adoption.");
      session = saved;
      activeProvider = saved.provider;
      activeModelName = saved.model;
      activeModelInput = saved.model;
      activeRunDiagnostics?.recordIdentityTransition({ provider: saved.provider, model: saved.model });
      conversationResponseId = undefined;
      continuationState = undefined;
      write(`Provider fallback: ${activeProvider} · ${activeModelName} (context sharing explicitly enabled).\n`);
      return !activeController.signal.aborted;
    });
  let activeSkillReferences: SkillReference[] = session.skills ?? [];
  // Process-local only: intentionally discarded on resume and process exit.
  let checkpoints = new SessionCheckpoints(workingDirectory);
  const sessionApprovals = new Set<string>();
  // Tasks and all runtime handles are deliberately process-local, never session state.
  const backgroundTasks = new BackgroundTaskManager({
    onTaskStarted: (task) => {
      const record = diagnostics.start({ sessionId: task.sessionId, provider: activeProvider, model: activeModelName });
      record.recordBackgroundTaskStarted();
      return record;
    },
  });
  const persistentJobs = persistentBackgroundJobsFor(dependencies, (job) => {
    const record = diagnostics.start({ sessionId: job.sessionId, provider: activeProvider, model: activeModelName });
    record.recordBackgroundTaskStarted();
    return record;
  });
  await persistentJobs.initialize();
  const persistentJobOptions = async (prompt: string) => ({
    createModel: () => createFreshSubagentModel(dependencies, providers, activeProvider, activeModelName, write),
    tools,
    projectContext: await discoverProjectContext(workingDirectory),
    skills: await createSkillsContext(skillsDirectory, activeSkillReferences, workingDirectory),
    memory: await memoryContextFor(memoryStore, workingDirectory, prompt),
    plan: { version: 1 as const, tasks: await createSessionPlanStore(sessionStore, session.id).list() },
  });
  const cancel = (): void => {
    if (activeController) activeController.abort();
    else lines.close();
  };

  const openInput = (): LineInput => createLineInput({
    input, write,
    terminal: (dependencies.terminal?.inputIsTTY ?? Boolean((input as { isTTY?: boolean }).isTTY)) &&
      (dependencies.terminal?.outputIsTTY ?? Boolean(process.stdout.isTTY)),
    columns: dependencies.terminal?.columns ?? process.stdout.columns,
    resizeSource: dependencies.terminal?.resizeSource ?? (dependencies.terminal?.columns === undefined ? process.stdout : undefined),
    interrupt: cancel,
    choices: (line) => slashChoices(line, SLASH_COMMANDS.map(({ name }) => name),
      providers.ids().map((id) => providers.get(id)), activeProvider, activeModelName)
      .filter(({ value }) => !value.startsWith("/auth status "))
      .map((choice) => choice.value.startsWith("/login ") && isApiKeyProvider(choice.value.slice(7))
        ? { ...choice, description: "Masked CLI entry · OS secure store" } : choice),
  });

  renderer.renderStartup({
    provider: providerLabel(providers, activeProvider),
    model: activeModelName,
    workingDirectory,
  });
  write(`${resumed ? "Resumed session" : "Session"}: ${session.id}\n`);
  await writeActiveSkillNotices(skillsDirectory, activeSkillReferences, write, workingDirectory);
  lines = openInput();
  process.on("SIGINT", cancel);
  try {
    for (;;) {
      renderer.renderComposer(activeModelName);
      lines.composer();
      const answer = await answers.next();
      renderer.finishComposer();
      if (answer.done) {
        backgroundTasks.cancelForSession(session.id);
        return;
      }
      const task = answer.value.trim();
      if (!task) continue;
      if (/^\/(loop|heartbeat)(?:\s|$)/.test(task)) {
        const name = task.startsWith("/loop") ? "/loop" : "/heartbeat";
        const usage = name === "/loop" ? "Usage: /loop [status|stop|start <interval-seconds> <max-runs> -- <prompt>].\n"
          : "Usage: /heartbeat [status|stop|start <interval-seconds> <idle-seconds> <max-runs> -- <prompt>].\n";
        const parts = task.split(/\s+/);
        const action = parts[1] ?? "status";
        if ((action === "status" || action === "stop") && parts.length <= 2) {
          if (!sessionLoop) { write("No Loop/Heartbeat for this session.\n"); continue; }
          if (action === "stop") { await stopSessionLoop(); write("Loop/Heartbeat stopped.\n"); }
          else {
            const state = sessionLoop.status();
            write(`Loop/Heartbeat: ${state.running ? "running" : "stopped"}; completed: ${state.completed}; active: ${state.active}; failures: ${loopFailures}; last report: ${lastLoopReport ?? "none"}\n`);
          }
          continue;
        }
        const marker = task.indexOf(" -- ");
        const fields = marker === -1 ? [] : task.slice(0, marker).trim().split(/\s+/).slice(2);
        const prompt = marker === -1 ? "" : task.slice(marker + 4).trim();
        if (action !== "start" || fields.length !== (name === "/loop" ? 2 : 3)
          || fields.some((field) => !/^[1-9][0-9]{0,5}$/.test(field))
          || !prompt || prompt.length > 4_000 || /[\u0000-\u001f\u007f]/.test(prompt)) { write(usage); continue; }
        if (sessionLoop?.status().running) { write("Session loop already running.\n"); continue; }
        if (dependencies.model || dependencies.modelFactory) { write("Loop requires a registry-backed provider model.\n"); continue; }
        try {
          await stopSessionLoop();
          if (await realpath(workingDirectory) !== workingDirectory)
            throw new Error("Loop requires a canonical session workspace; start a new session from this directory.");
          loopRuntime ??= await createDragonsRuntime({ workingDirectory, providerRegistry: providers, sessionStore,
            tools: [], memoryStore, skillsDirectory, maxTurns: dependencies.config?.maxTurns,
            contextBudgetChars: dependencies.config?.contextBudgetChars });
          const values = fields.map(Number);
          const loop = createRuntimeSessionLoop({ runtime: loopRuntime,
            config: { sessionId: session.id, prompt, intervalMs: values[0]! * 1_000,
              maxRuns: values[name === "/loop" ? 1 : 2]!,
              ...(name === "/heartbeat" ? { idleMs: values[1]! * 1_000 } : {}) },
            onResult: (id, text) => {
              if (sessionLoop === loop && session.id === id) {
                lastLoopReport = text.slice(0, 8_000);
                // The unattended runtime owns the persisted continuation; do not reuse a stale CLI adapter.
                activeModel = undefined;
              }
            },
            onError: () => { if (sessionLoop === loop) loopFailures += 1; },
          });
          sessionLoop = loop;
          lastLoopReport = undefined;
          loopFailures = 0;
          loop.start();
          write(name === "/loop" ? "Loop started (READ-only; current session).\n" : "Heartbeat started (READ-only; current session).\n");
        } catch (error: unknown) { write(`${error instanceof Error ? error.message : "Unable to start session loop."}\n`); }
        continue;
      }
      // A foreground command takes ownership of this session before doing any work.
      // Stop and cancel the unattended turn rather than letting two hosts race over state.
      if (sessionLoop) {
        await stopSessionLoop();
        write("Loop/Heartbeat stopped for interactive input.\n");
        const updated = await sessionStore.load(session.id);
        if (!updated || updated.workingDirectory !== workingDirectory) throw new Error("Session loop changed or lost its workspace.");
        if (updated.provider !== activeProvider || updated.model !== activeModelName) {
          providers.get(updated.provider);
          activeProvider = updated.provider;
          activeModelName = updated.model;
          activeModelInput = updated.model;
          activeModel = undefined;
          write(`Provider fallback: ${activeProvider} · ${activeModelName} (context sharing explicitly enabled).\n`);
        }
        session = updated;
        conversationResponseId = updated.continuation?.responseId;
        continuationState = updated.continuation?.providerState;
      }
      if (task === "exit" || task === "quit" || task === "/exit") {
        backgroundTasks.cancelForSession(session.id);
        return;
      }
      if (task === "/worktree" || task.startsWith("/worktree ")) {
        const parts = task.split(/\s+/);
        if (parts.length !== 3 || !["create", "select"].includes(parts[1]!)) {
          write("Usage: /worktree create <name> | /worktree select <name>\n");
          continue;
        }
        if ([...backgroundTasks.list(session.id), ...persistentJobs.list(session.id)].some((job) => job.state === "running" || job.state === "queued")) {
          write("Finish or cancel background tasks before changing workspace.\n");
          continue;
        }
        if (mcp.status().some((server) => server.state === "connected")) {
          write("Disconnect MCP servers before changing workspace.\n");
          continue;
        }
        try {
          if (dependencies.tools) throw new Error("Custom tool bindings cannot be switched; start a new CLI in the worktree.");
          const target = parts[1] === "create"
            ? await createIsolatedWorktree(workingDirectory, parts[2]!)
            : await selectIsolatedWorktree(workingDirectory, parts[2]!);
          const replacementTools = await createCodingTools(target, {
            maxToolOutputBytes: dependencies.config?.maxToolOutputBytes,
            shellTimeoutMilliseconds: dependencies.config?.shellTimeoutMilliseconds,
          });
          const replacementCheckpoints = new SessionCheckpoints(target);
          const next = await sessionStore.create({ workingDirectory: target, provider: activeProvider, model: activeModelName });
          // Rebind all workspace resources between turns; never switch during runAgent.
          await loopRuntime?.dispose();
          loopRuntime = undefined;
          await goalService?.close();
          goalService = undefined;
          await goalRuntime?.dispose();
          goalRuntime = undefined;
          workingDirectory = target;
          session = next;
          tools.splice(0, tools.length, ...replacementTools, ...planTools);
          operations.clear();
          for (const tool of tools) operations.set(tool.name, tool.operation);
          checkpoints = replacementCheckpoints;
          sessionApprovals.clear();
          activeSkillReferences = [];
          conversationResponseId = undefined;
          continuationState = undefined;
          activeModel = undefined;
          write(`Workspace: ${target}\nSession: ${session.id}\n`);
        } catch (error) { write(`Worktree switch failed: ${error instanceof Error ? error.message : "unknown error"}\n`); }
        continue;
      }
      if (task === "/help" || task.startsWith("/help ")) {
        write(formatSlashHelp(task.slice("/help".length), SLASH_COMMANDS.map(({ name }) => name)));
        continue;
      }
      if (/^\/batch(?:\s|$)/u.test(task)) {
        if (task.startsWith("/batch lock")) {
          if (task !== "/batch lock status" && task !== "/batch lock recover") {
            write("Usage: /batch lock status | /batch lock recover.\n");
            continue;
          }
          activeController = new AbortController();
          try {
            if (!dependencies.configPath || !profileName) throw new Error("Batch requires a local profile.");
            if (await realpath(workingDirectory) !== workingDirectory)
              throw new Error("Batch requires a canonical session workspace; start a new session from this directory.");
            const directory = batchWorkspaceDirectory(join(dirname(dependencies.configPath), "batches"), workingDirectory);
            const lock = await inspectBatchLock(directory);
            if (!lock) write("No batch lock for this profile and workspace.\n");
            else if (task === "/batch lock status") write(`Batch lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}. No recovery attempted.\n`);
            else {
              write(`Batch lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}. Only recover if this process has stopped. Type RECOVER to confirm: `);
              const answer = await answers.next(activeController.signal);
              if (answer.done || answer.value.trim() !== "RECOVER") write("Batch lock recovery not confirmed.\n");
              else {
                activeController.signal.throwIfAborted();
                write(await recoverAbandonedBatchLock(directory, lock.token)
                  ? "Abandoned batch lock removed; no task was started or retried.\n"
                  : "No batch lock for this profile and workspace.\n");
              }
            }
          } catch (error: unknown) {
            write(activeController.signal.aborted ? "Batch lock recovery cancelled.\n"
              : `${error instanceof Error ? error.message : "Unable to inspect batch lock."}\n`);
          } finally { activeController = undefined; }
          continue;
        }
        const request = parseInteractiveBatchCommand(task);
        if (!request) { write(`${BATCH_USAGE}\n`); continue; }
        try {
          if (!dependencies.configPath || !profileName) throw new Error("Batch requires a local profile.");
          if (await realpath(workingDirectory) !== workingDirectory)
            throw new Error("Batch requires a canonical session workspace; start a new session from this directory.");
          const queue = createFileBatchQueue(batchWorkspaceDirectory(join(dirname(dependencies.configPath), "batches"), workingDirectory), workingDirectory);
          if (request.action === "add") {
            const batch = await queue.create(request.prompts, request.maxRuns);
            write(`Batch ${batch.id} created (revision ${batch.revision}, ${batch.tasks.length} tasks, ${batch.maxRuns} runs).\n`);
          } else if (request.action === "list") {
            const batches = await queue.list();
            if (!batches.length) write("No batches for this profile and workspace.\n");
            for (const batch of batches) write(`${batch.id} revision ${batch.revision}: ${batch.runsUsed}/${batch.maxRuns} runs, ${batch.tasks.map((entry) => entry.state).join(", ")}\n`);
          } else {
            const batch = await queue.load(request.id);
            if (!batch) { write("Batch not found for this profile and workspace.\n"); continue; }
            if (request.action === "status") {
              write(`Batch ${batch.id} revision ${batch.revision}: ${batch.runsUsed}/${batch.maxRuns} runs.\n`);
              for (const entry of batch.tasks) write(`${entry.id}: ${entry.state}${entry.state === "running" ? entry.owner
                ? ` (PID ${entry.owner.pid} on ${JSON.stringify(entry.owner.host)})` : " (legacy owner unknown; cannot recover safely)" : ""}\n`);
              continue;
            }
            if (request.action === "recover") {
              if (batch.revision !== request.revision) { write("Batch revision changed; inspect current status before recovery.\n"); continue; }
              const running = batch.tasks.find((entry) => entry.state === "running");
              if (!running?.owner) { write("No verifiable running batch reservation; no recovery attempted.\n"); continue; }
              activeController = new AbortController();
              try {
                write(`Batch ${batch.id} revision ${batch.revision}: task ${running.id} owned by PID ${running.owner.pid} on ${JSON.stringify(running.owner.host)}. Only mark interrupted if this process has stopped. Type RECOVER to confirm: `);
                const answer = await answers.next(activeController.signal);
                if (answer.done || answer.value.trim() !== "RECOVER") write("Batch reservation recovery not confirmed.\n");
                else {
                  activeController.signal.throwIfAborted();
                  const done = await queue.recover(batch.id, running.id, batch.revision, running.owner.token);
                  write(`Batch ${done.id} revision ${done.revision}: task marked interrupted; no task was started or retried.\n`);
                }
              } finally { activeController = undefined; }
              continue;
            }
            if (batch.revision !== request.revision) { write("Batch revision changed; inspect current status before running.\n"); continue; }
            if (batch.tasks.some((entry) => entry.state !== "queued" && entry.state !== "completed") || batch.runsUsed >= batch.maxRuns) {
              write("Batch cannot run: inspect task states and budget first.\n"); continue;
            }
            if (dependencies.model && !dependencies.modelFactory) { write("Batch run requires fresh registry-backed provider models.\n"); continue; }
            activeController = new AbortController();
            try {
              write(`Batch ${batch.id} revision ${batch.revision}: up to ${batch.maxRuns - batch.runsUsed} new READ-only runs on ${activeProvider}:${activeModelName} in ${workingDirectory}. Type RUN to confirm: `);
              const answer = await answers.next(activeController.signal);
              if (answer.done || answer.value.trim() !== "RUN") { write("Batch not confirmed; no model started.\n"); continue; }
              activeController.signal.throwIfAborted();
              const batchTools = await createCodingTools(workingDirectory, {
                maxToolOutputBytes: dependencies.config?.maxToolOutputBytes,
                shellTimeoutMilliseconds: dependencies.config?.shellTimeoutMilliseconds,
              });
              const done = await runBatch({ queue, id: batch.id, revision: batch.revision, tools: batchTools,
                createModel: () => createFreshSubagentModel(dependencies, providers, activeProvider, activeModelName, write),
                signal: activeController.signal });
              write(`Batch ${done.id} checkpointed at revision ${done.revision}: ${done.tasks.map((entry) => entry.state).join(", ")}.\n`);
            } finally { activeController = undefined; }
          }
        } catch (error: unknown) {
          write(`Batch command failed${error instanceof AgentRunCancelledError || activeController?.signal.aborted ? " or was cancelled" : ""}; inspect status before retrying.\n`);
        }
        continue;
      }
      if (/^\/moa(?:\s|$)/u.test(task)) {
        const mixture = parseInteractiveMixtureCommand(task, providers.ids());
        if (!mixture) { write(`${MIXTURE_USAGE}\n`); continue; }
        if (dependencies.model && !dependencies.modelFactory) {
          write("MoA requires fresh registry-backed provider models.\n");
          continue;
        }
        activeController = new AbortController();
        try {
          const modelFor = (provider: string): string => dependencies.config?.models?.[provider]
            ?? dependencies.config?.model ?? providers.get(provider).defaultModel;
          write(`MoA sends this question to ${mixture.providers.map((provider) => `${provider}:${modelFor(provider)}`).join(", ")} and sends their reports to ${mixture.aggregator}:${modelFor(mixture.aggregator)}. Type SHARE to confirm: `);
          const answer = await answers.next(activeController.signal);
          if (answer.done || answer.value.trim() !== "SHARE") { write("MoA not confirmed; no model started.\n"); continue; }
          activeController.signal.throwIfAborted();
          const mixtureTools = dependencies.tools ?? await createCodingTools(workingDirectory, {
            maxToolOutputBytes: dependencies.config?.maxToolOutputBytes,
            shellTimeoutMilliseconds: dependencies.config?.shellTimeoutMilliseconds,
          });
          const result = await runMixtureOfAgents({
            task: mixture.question, preset: mixture.preset,
            candidates: mixture.providers.map((provider) => ({ id: provider,
              createModel: () => createFreshSubagentModel(dependencies, providers, provider, modelFor(provider), write) })),
            createAggregatorModel: () => createFreshSubagentModel(dependencies, providers, mixture.aggregator, modelFor(mixture.aggregator), write),
            tools: mixtureTools, signal: activeController.signal,
          });
          write(`${result.finalText}\n`);
        } catch {
          write("MoA failed or was cancelled; no synthesis was saved.\n");
        } finally { activeController = undefined; }
        continue;
      }
      if (/^\/kanban(?:\s|$)/u.test(task)) {
        if (task.startsWith("/kanban worker lane")) {
          const tasks = parseKanbanWorkerLane(task);
          if (!tasks) { write("Usage: /kanban worker lane <id>:<revision> [<id>:<revision> ...] (up to 8).\n"); continue; }
          activeController = new AbortController();
          try {
            if (!profileName || !dependencies.profileStore) throw new Error("Kanban requires a local profile store.");
            if (await realpath(workingDirectory) !== workingDirectory)
              throw new Error("Kanban requires a canonical session workspace; start a new session from this directory.");
            const baseConfigPath = dependencies.profileStore.paths(DEFAULT_DRAGONS_PROFILE).configPath;
            const board = createFileKanbanBoard(kanbanWorkspaceDirectory(baseConfigPath, workingDirectory), dependencies.profileStore);
            const done = await runKanbanWorkerLane({ board, workingDirectory, configPath: baseConfigPath,
              profile: profileName, tasks, signal: activeController.signal });
            write(`Kanban worker lane completed ${done.length} tasks: ${done.join(", ")}.\n`);
          } catch {
            write("Kanban worker lane failed or was cancelled; inspect task statuses before retrying.\n");
          } finally { activeController = undefined; }
          continue;
        }
        if (task.startsWith("/kanban worker start")) {
          const start = parseKanbanWorkerStart(task);
          if (!start) { write("Usage: /kanban worker start <id> <revision>.\n"); continue; }
          activeController = new AbortController();
          try {
            if (!profileName || !dependencies.profileStore) throw new Error("Kanban requires a local profile store.");
            const baseConfigPath = dependencies.profileStore.paths(DEFAULT_DRAGONS_PROFILE).configPath;
            await launchKanbanWorker({ workingDirectory, configPath: baseConfigPath, profile: profileName,
              id: start.id, revision: start.revision, signal: activeController.signal });
            write(`Kanban worker completed task ${start.id}; inspect /kanban status ${start.id}.\n`);
          } catch (error: unknown) {
            write(`Kanban worker failed: ${error instanceof Error ? error.message : "Unknown error."}\n`);
          } finally { activeController = undefined; }
          continue;
        }
        if (task.startsWith("/kanban lock")) {
          if (task !== "/kanban lock status" && task !== "/kanban lock recover") {
            write("Usage: /kanban lock status | /kanban lock recover.\n");
            continue;
          }
          activeController = new AbortController();
          try {
            if (!profileName || !dependencies.profileStore) throw new Error("Kanban requires a local profile store.");
            if (await realpath(workingDirectory) !== workingDirectory)
              throw new Error("Kanban requires a canonical session workspace; start a new session from this directory.");
            const directory = kanbanWorkspaceDirectory(dependencies.profileStore.paths(DEFAULT_DRAGONS_PROFILE).configPath, workingDirectory);
            const lock = await inspectKanbanLock(directory);
            if (!lock) write("No Kanban lock for this workspace.\n");
            else if (task === "/kanban lock status") write(`Kanban lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}. No recovery attempted.\n`);
            else {
              write(`Kanban lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}. Only recover if this process has stopped. Type RECOVER to confirm: `);
              const answer = await answers.next(activeController.signal);
              if (answer.done || answer.value.trim() !== "RECOVER") write("Kanban lock recovery not confirmed.\n");
              else {
                activeController.signal.throwIfAborted();
                write(await recoverAbandonedKanbanLock(directory, lock.token)
                  ? "Abandoned Kanban lock removed; no worker was stopped or started.\n"
                  : "No Kanban lock for this workspace.\n");
              }
            }
          } catch (error: unknown) {
            write(activeController.signal.aborted ? "Kanban lock recovery cancelled.\n"
              : `${error instanceof Error ? error.message : "Unable to inspect Kanban lock."}\n`);
          } finally { activeController = undefined; }
          continue;
        }
        const command = parseInteractiveKanbanCommand(task);
        if (!command) write(`${KANBAN_USAGE}\n`);
        else if (!profileName || !dependencies.profileStore) write("Kanban requires a local profile store.\n");
        else {
          try {
            // The board root is shared across profiles; the actor is bound at CLI startup, not read from user text.
            if (await realpath(workingDirectory) !== workingDirectory)
              throw new Error("Kanban requires a canonical session workspace; start a new session from this directory.");
            const baseConfigPath = dependencies.profileStore.paths(DEFAULT_DRAGONS_PROFILE).configPath;
            const board = createFileKanbanBoard(kanbanWorkspaceDirectory(baseConfigPath, workingDirectory), dependencies.profileStore);
            if (command.action === "worker_recover") {
              activeController = new AbortController();
              try {
                const current = await board.get(profileName, command.id);
                if (!current) throw new Error("Kanban task not found.");
                if (current.assignee !== profileName) throw new Error("Only the task assignee can recover worker ownership.");
                if (current.revision !== command.revision) throw new Error("Kanban task revision changed.");
                if (!current.worker) throw new Error("No Kanban worker claim to recover.");
                if (current.worker.pid !== command.pid) throw new Error("Kanban worker claim changed.");
                write(`Kanban worker PID ${command.pid} on ${JSON.stringify(current.worker.host)} for task ${command.id}. Only recover if this process has stopped. Type RECOVER to confirm: `);
                const answer = await answers.next(activeController.signal);
                if (answer.done || answer.value.trim() !== "RECOVER") write("Kanban worker recovery not confirmed.\n");
                else {
                  activeController.signal.throwIfAborted();
                  const recovered = await board.recoverWorker(profileName, command.id, command.revision, command.pid);
                  write(`Kanban task ${recovered.id} revision ${recovered.revision} blocked; no worker was stopped or started.\n`);
                }
              } finally { activeController = undefined; }
            } else write(`${await runInteractiveKanbanCommand(board, profileName, command)}\n`);
          } catch (error: unknown) {
            write(`Kanban command failed: ${error instanceof Error ? error.message : "Unknown error."}\n`);
          }
        }
        continue;
      }
      if (/^\/goal(?:\s|$)/.test(task)) {
        if (task.startsWith("/goal lock")) {
          if (task !== "/goal lock status" && task !== "/goal lock recover") {
            write("Usage: /goal lock status | /goal lock recover.\n");
            continue;
          }
          activeController = new AbortController();
          try {
            if (!dependencies.configPath) throw new Error("Goal commands require a local profile.");
            if (await realpath(workingDirectory) !== workingDirectory)
              throw new Error("Goal commands require a canonical session workspace; start a new session from this directory.");
            const directory = goalWorkspaceDirectory(join(dirname(dependencies.configPath), "goals"), workingDirectory);
            const lock = await inspectPersistentGoalLock(directory);
            if (!lock) write("No goal lock for this workspace.\n");
            else if (task === "/goal lock status") write(`Lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}. No recovery attempted.\n`);
            else {
              write(`Lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}. Only recover if this process has stopped. Type RECOVER to confirm: `);
              const answer = await answers.next(activeController.signal);
              if (answer.done || answer.value.trim() !== "RECOVER") write("Goal lock recovery not confirmed.\n");
              else {
                activeController.signal.throwIfAborted();
                write(await recoverAbandonedPersistentGoalLock(directory, lock.token)
                  ? "Abandoned goal lock removed. A stranded goal run is not stopped or replayed.\n"
                  : "No goal lock for this workspace.\n");
              }
            }
          } catch (error: unknown) {
            write(activeController.signal.aborted ? "Goal lock recovery cancelled.\n"
              : `${error instanceof Error ? error.message : "Unable to inspect goal lock."}\n`);
          } finally { activeController = undefined; }
          continue;
        }
        const goalCommand = parseInteractiveGoalCommand(task, session.id);
        if (!goalCommand) { write(`${GOAL_USAGE}\n`); continue; }
        if (goalCommand.action === "run" && (dependencies.model || dependencies.modelFactory)) {
          write("Goal run requires a registry-backed provider model.\n");
          continue;
        }
        activeController = new AbortController();
        try {
          if (!dependencies.configPath) throw new Error("Goal commands require a local profile.");
          if (await realpath(workingDirectory) !== workingDirectory)
            throw new Error("Goal commands require a canonical session workspace; start a new session from this directory.");
          goalRuntime ??= await createDragonsRuntime({ workingDirectory, providerRegistry: providers, sessionStore,
            tools: [], memoryStore, skillsDirectory, maxTurns: dependencies.config?.maxTurns,
            contextBudgetChars: dependencies.config?.contextBudgetChars });
          goalService ??= createPersistentGoalService(goalRuntime, join(dirname(dependencies.configPath), "goals"), workingDirectory);
          const current = goalService;
          const cancelGoal = (): void => { void current.close(); };
          activeController.signal.addEventListener("abort", cancelGoal, { once: true });
          try { write(`${await current.command(goalCommand)}\n`); }
          finally { activeController.signal.removeEventListener("abort", cancelGoal); }
        } catch (error: unknown) {
          write(activeController.signal.aborted ? "Goal command cancelled.\n"
            : error instanceof Error && /^(Goal commands require|Persistent goal session is unavailable)/.test(error.message)
              ? `${error.message}\n` : "Goal command failed. Check session, budget, and goal state.\n");
        } finally {
          if (goalCommand.action === "run") {
            const updated = await sessionStore.load(session.id);
            if (updated && updated.workingDirectory === workingDirectory) {
              session = updated;
              conversationResponseId = updated.continuation?.responseId;
              continuationState = updated.continuation?.providerState;
              activeModel = undefined;
              if (updated.provider !== activeProvider || updated.model !== activeModelName) {
                providers.get(updated.provider);
                activeProvider = updated.provider;
                activeModelName = updated.model;
                activeModelInput = updated.model;
              }
            }
          }
          if (activeController.signal.aborted) {
            await goalService?.close();
            goalService = undefined;
            await goalRuntime?.dispose();
            goalRuntime = undefined;
          }
          activeController = undefined;
        }
        continue;
      }
      if (/^\/(login|logout|auth)(?:\s|$)/.test(task)) {
        const [name, requested, ...extra] = task.split(/\s+/);
        const provider = requested ?? activeProvider;
        if (extra.length || !(provider === "chatgpt" || provider === "local" || isApiKeyProvider(provider))) {
          write("Usage: /login, /logout, or /auth [provider]. Never include credentials.\n");
          continue;
        }
        const action = name === "/login" ? "login" : name === "/logout" ? "logout" : "status";
        const secretEntry = action === "login" && isApiKeyProvider(provider) &&
          Boolean((input as { isTTY?: boolean }).isTTY) && Boolean((input as { setRawMode?: unknown }).setRawMode) && Boolean((dependencies.secretOutput ?? process.stdout).isTTY);
        activeController = new AbortController();
        // Closing (not just pausing) detaches readline's data listener and drops queued answers.
        if (secretEntry) lines.close();
        try { await runAuthCommand({ kind: "auth", action, provider }, dependencies, write, activeController.signal); }
        catch {
          // Authentication failures are local command outcomes, not chat or fatal loop errors.
          // Never reflect an OAuth/backend exception that may contain private details.
          write(activeController.signal.aborted
            ? `${provider}: authentication cancelled.\n`
            : `${provider}: authentication ${action} failed. Check sign-in and OS credential storage.\n`);
        }
        finally {
          activeController = undefined;
          if (secretEntry && !(input as { readableEnded?: boolean; destroyed?: boolean }).readableEnded && !(input as { destroyed?: boolean }).destroyed) {
            lines = openInput();
          }
        }
        // Refused piped login must not turn subsequent credential-looking lines into chat.
        if (action === "login" && isApiKeyProvider(provider) && !secretEntry) return;
        if (secretEntry && ((input as { readableEnded?: boolean }).readableEnded || (input as { destroyed?: boolean }).destroyed)) return;
        continue;
      }
      if (task === "/profile" || task === "/profile list") {
        const profiles = dependencies.profileStore ?? createDragonsProfileStore({ configPath: dependencies.configPath });
        const active = await profiles.active();
        const names = await profiles.list();
        write(`Active profile: ${active}\nProfiles: ${names.join(", ")}\n`);
        continue;
      }
      if (task.startsWith("/profile create ")) {
        const profiles = dependencies.profileStore ?? createDragonsProfileStore({ configPath: dependencies.configPath });
        const name = task.slice("/profile create ".length).trim();
        try {
          await profiles.create(name);
          write(`Profile created: ${name}\n`);
        } catch (error: unknown) {
          write(`${error instanceof Error ? error.message : "Unable to create profile."}\n`);
        }
        continue;
      }
      if (task.startsWith("/profile select ")) {
        const profiles = dependencies.profileStore ?? createDragonsProfileStore({ configPath: dependencies.configPath });
        const name = task.slice("/profile select ".length).trim();
        try {
          const selected = await profiles.select(name);
          write(`Active profile: ${selected.name}. Restart Dragons to open its isolated config, sessions, skills, memory, and credentials.\n`);
          return;
        } catch (error: unknown) {
          write(`${error instanceof Error ? error.message : "Unable to select profile."}\n`);
        }
        continue;
      }
      if (task === "/profile create" || task === "/profile select" || task.startsWith("/profile")) {
        write("Use /profile, /profile list, /profile create <name>, or /profile select <name>.\n");
        continue;
      }
      if (task === "/status" || task === "/session") {
        write(`Session: ${session.id}\nProvider: ${activeProvider}\nModel: ${activeModelName}\nWorkspace: ${workingDirectory}\n`);
        continue;
      }
      if (task === "/diagnostics") {
        write(`${formatRuntimeDiagnostics(diagnostics.recent()[0])}\n`);
        continue;
      }
      if (task === "/sessions") {
        await listSessions(sessionStore, write);
        continue;
      }
      if (task === "/new") {
        backgroundTasks.cancelForSession(session.id);
        await memoryStore.clearSuggestions();
        session = await sessionStore.create({ workingDirectory, provider: activeProvider, model: activeModelName });
        activeSkillReferences = [];
        conversationResponseId = undefined;
        continuationState = undefined;
        sessionApprovals.clear();
        checkpoints.clear();
        write(`Session: ${session.id}\n`);
        continue;
      }
      if (task === "/clear") {
        const clearedAt = new Date().toISOString();
        const clearedSession = sessionStore.mutate
          ? await sessionStore.mutate(session.id, (current) => ({ ...current, updatedAt: clearedAt, messages: [], toolHistory: [], continuation: undefined }))
          : await (async () => {
            const next = { ...session, updatedAt: clearedAt, messages: [], toolHistory: [], continuation: undefined };
            await sessionStore.save(next);
            return next;
          })();
        if (!clearedSession) throw new Error(`Active session was not found: ${session.id}`);
        session = clearedSession;
        conversationResponseId = undefined;
        continuationState = undefined;
        write("Current conversation cleared.\n");
        continue;
      }
      if (task.startsWith("/resume ")) {
        const id = task.slice("/resume ".length).trim();
        const saved = await sessionStore.load(id);
        if (!saved) { write(`Saved session was not found or is unreadable: ${id}\n`); continue; }
        if (saved.workingDirectory !== workingDirectory || saved.provider !== activeProvider || saved.model !== activeModelName) {
          write("/resume only switches to a session with the active workspace, provider, and model. Use dragons session resume <id> otherwise.\n");
          continue;
        }
        backgroundTasks.cancelForSession(session.id);
        session = saved;
        conversationResponseId = saved.continuation?.responseId;
        continuationState = saved.continuation?.providerState;
        activeSkillReferences = saved.skills ?? [];
        // Provider adapters can retain process-local continuation state. A resumed
        // session must receive a fresh adapter before its serialized state is applied.
        activeModel = createInteractiveModel(activeModelName);
        await memoryStore.clearSuggestions();
        sessionApprovals.clear();
        checkpoints.clear();
        write(`Resumed session: ${session.id}\n`);
        await writeActiveSkillNotices(skillsDirectory, activeSkillReferences, write, workingDirectory);
        continue;
      }
      if (task === "/jobs") {
        write(`${formatPersistentBackgroundJobList(persistentJobs.list(session.id))}\n`);
        continue;
      }
      if (task.startsWith("/jobs start ")) {
        const prompt = task.slice("/jobs start ".length).trim();
        try {
          const job = await persistentJobs.start({
            sessionId: session.id,
            workingDirectory,
            prompt,
            ...await persistentJobOptions(prompt),
          });
          write(`Persistent background job started: ${job.id}\n`);
        } catch (error: unknown) {
          write(`${error instanceof Error ? error.message : "Unable to start persistent background job."}\n`);
        }
        continue;
      }
      if (task.startsWith("/jobs show ")) {
        const id = task.slice("/jobs show ".length).trim();
        const job = persistentJobs.show(id, session.id);
        if (!job || job.sessionId !== session.id || job.workingDirectory !== workingDirectory) write(`Persistent background job was not found: ${id}\n`);
        else write(`${formatPersistentBackgroundJob(job)}\n`);
        continue;
      }
      if (task.startsWith("/jobs cancel ")) {
        const id = task.slice("/jobs cancel ".length).trim();
        const job = persistentJobs.show(id, session.id);
        if (!job || job.sessionId !== session.id || job.workingDirectory !== workingDirectory) write(`Persistent background job was not found: ${id}\n`);
        else if (await persistentJobs.cancel(id, session.id)) write(`Persistent background job cancelled: ${id}\n`);
        else write(`Persistent background job is already ${job.state}: ${id}\n`);
        continue;
      }
      if (task.startsWith("/jobs resume ")) {
        const id = task.slice("/jobs resume ".length).trim();
        const job = persistentJobs.show(id, session.id);
        if (!job || job.sessionId !== session.id || job.workingDirectory !== workingDirectory) write(`Persistent background job was not found: ${id}\n`);
        else {
          try {
            await persistentJobs.resume(id, await persistentJobOptions(job.prompt), session.id);
            write(`Persistent background job resumed: ${id}\n`);
          } catch (error: unknown) {
            write(`${error instanceof Error ? error.message : "Unable to resume persistent background job."}\n`);
          }
        }
        continue;
      }
      if (task === "/jobs cleanup") {
        write(`Cleaned persistent background jobs: ${await persistentJobs.cleanup({ sessionId: session.id })}\n`);
        continue;
      }
      if (task === "/jobs start" || task === "/jobs show" || task === "/jobs cancel" || task === "/jobs resume" || task.startsWith("/jobs")) {
        write("Use /jobs, /jobs start <prompt>, /jobs show <id>, /jobs cancel <id>, /jobs resume <id>, or /jobs cleanup. Persistent jobs are read-only and never automatically retried after restart.\n");
        continue;
      }
      if (task === "/tasks") {
        write(`${formatBackgroundTaskList(backgroundTasks.list(session.id))}\n`);
        continue;
      }
      if (task.startsWith("/tasks start ")) {
        const prompt = task.slice("/tasks start ".length).trim();
        try {
          const skills = await createSkillsContext(skillsDirectory, activeSkillReferences, workingDirectory);
          const memory = await memoryContextFor(memoryStore, workingDirectory, prompt);
          const projectContext = await discoverProjectContext(workingDirectory);
          const plan = { version: 1 as const, tasks: await createSessionPlanStore(sessionStore, session.id).list() };
          const background = backgroundTasks.start({
            sessionId: session.id,
            prompt,
            createModel: () => createFreshSubagentModel(dependencies, providers, activeProvider, activeModelName, write),
            tools,
            workingDirectory,
            projectContext,
            skills,
            memory,
            plan,
          });
          write(`Background task started: ${background.id}\n`);
        } catch (error: unknown) {
          write(`${error instanceof Error ? error.message : "Unable to start background task."}\n`);
        }
        continue;
      }
      if (task.startsWith("/tasks show ")) {
        const id = task.slice("/tasks show ".length).trim();
        const background = backgroundTasks.show(id);
        if (!background || background.sessionId !== session.id) write(`Background task was not found: ${id}\n`);
        else write(`${formatBackgroundTask(background)}\n`);
        continue;
      }
      if (task.startsWith("/tasks cancel ")) {
        const id = task.slice("/tasks cancel ".length).trim();
        const background = backgroundTasks.show(id);
        if (!background || background.sessionId !== session.id) write(`Background task was not found: ${id}\n`);
        else if (backgroundTasks.cancel(id)) write(`Background task cancelled: ${id}\n`);
        else write(`Background task is already ${background.state}: ${id}\n`);
        continue;
      }
      if (task === "/tasks start" || task === "/tasks show" || task === "/tasks cancel" || task.startsWith("/tasks")) {
        write("Use /tasks, /tasks start <prompt>, /tasks show <id>, or /tasks cancel <id>.\n");
        continue;
      }
      if (await handleInteractivePlanCommand({ task, sessionId: session.id, sessionStore, write })) continue;
      if (await handleInteractiveMemoryCommand({ task, store: memoryStore, workingDirectory, write })) continue;
      const skillsCommand = await handleInteractiveSkillsCommand({
        task,
        directory: skillsDirectory,
        workingDirectory,
        activeSkillReferences,
        session,
        sessionStore,
        write,
      });
      if (skillsCommand.handled) {
        activeSkillReferences = skillsCommand.activeSkillReferences ?? activeSkillReferences;
        session = skillsCommand.session ?? session;
        continue;
      }
      if (task === "/reasoning" || task.startsWith("/reasoning ")) {
        const args = task.split(/\s+/).slice(1);
        if (args.length > 1) { write("Usage: /reasoning [default|level]\n"); continue; }
        try {
          write(`${await providers.reasoning(activeProvider, activeModelName, args[0])}\n`);
          // Keep serialized continuation, but construct the next run with its new effort.
          if (args.length) activeModel = undefined;
        } catch { write("Unable to set reasoning: unsupported level or profile could not be saved.\n"); }
        continue;
      }
      if (task === "/model") {
        write(`Model: ${activeModelName}\nUse /model <name> to start a new conversation with that model.\n`);
        continue;
      }
      if (task.startsWith("/model ")) {
        const nextModel = task.slice("/model ".length).trim();
        if (!nextModel) { write("Usage: /model <name>\n"); continue; }
        const nextConfig: DragonsConfig = { ...(dependencies.config ?? {}), version: 1, models: { ...(dependencies.config?.models ?? {}), [activeProvider]: nextModel } };
        await saveDragonsConfig(nextConfig, dependencies.configPath, providers.ids());
        dependencies.config = nextConfig;
        backgroundTasks.cancelForSession(session.id);
        activeModelName = nextModel;
        activeModelInput = nextModel;
        activeModel = createInteractiveModel(nextModel);
        await memoryStore.clearSuggestions();
        session = await sessionStore.create({ workingDirectory, provider: activeProvider, model: activeModelName });
        activeSkillReferences = [];
        conversationResponseId = undefined;
        continuationState = undefined;
        sessionApprovals.clear();
        checkpoints.clear();
        write(`Model changed. Started new session: ${session.id}\n`);
        continue;
      }
      if (task === "/provider") {
        write(`Provider: ${activeProvider}\nUse /provider <${providers.ids().join("|")}> to start a new conversation with that provider.\n`);
        continue;
      }
      if (task.startsWith("/provider ")) {
        let nextProvider: ProviderName;
        try { nextProvider = providerFrom(task.slice("/provider ".length).trim(), providers.ids()); }
        catch (error: unknown) { write(`${error instanceof Error ? error.message : "Invalid provider."}\n`); continue; }
        const configuredModel = dependencies.config?.models?.[nextProvider] ?? dependencies.config?.model;
        const nextModel = selectedModel(providers, nextProvider, configuredModel);
        const nextConfig: DragonsConfig = { ...(dependencies.config ?? {}), version: 1, provider: nextProvider };
        await saveDragonsConfig(nextConfig, dependencies.configPath, providers.ids());
        dependencies.config = nextConfig;
        backgroundTasks.cancelForSession(session.id);
        activeProvider = nextProvider;
        activeModelName = nextModel;
        activeModelInput = configuredModel;
        activeModel = createInteractiveModel(nextModel);
        await memoryStore.clearSuggestions();
        session = await sessionStore.create({ workingDirectory, provider: activeProvider, model: activeModelName });
        activeSkillReferences = [];
        conversationResponseId = undefined;
        continuationState = undefined;
        sessionApprovals.clear();
        checkpoints.clear();
        write(`Provider changed. Started new session: ${session.id}\n`);
        continue;
      }
      if (task === "/context") {
        const budget = dependencies.config?.contextBudgetChars ?? 120_000;
        const continuationCharacters = continuationState ? JSON.stringify(continuationState).length : 0;
        const conversationCharacters = session.messages.reduce((total, message) => total + message.content.length, 0) + continuationCharacters;
        write(`Session context estimate: ~${conversationCharacters} / ~${budget} characters (conservative estimate; exact provider tokens unavailable). Current project and Git context are added per request.\n`);
        continue;
      }
      if (task === "/mcp list") { writeMcpList(mcp, write); continue; }
      if (task === "/mcp status") { writeMcpStatus(mcp, write); continue; }
      if (task === "/mcp connect-all") {
        await connectAllMcp(mcp, tools, operations, write);
        continue;
      }
      if (task.startsWith("/mcp connect ")) {
        const id = task.slice("/mcp connect ".length).trim();
        try { await connectMcp(mcp, id, tools, operations, write); }
        catch (error: unknown) { write(`${error instanceof Error ? error.message : "Unable to connect MCP server."}\n`); }
        continue;
      }
      if (task.startsWith("/mcp disconnect ")) {
        const id = task.slice("/mcp disconnect ".length).trim();
        try { await disconnectMcp(mcp, id, tools, operations, write); }
        catch (error: unknown) { write(`${error instanceof Error ? error.message : "Unable to disconnect MCP server."}\n`); }
        continue;
      }
      if (task.startsWith("/") && !isCheckpointCommand(task)) {
        write(`Unknown slash command: ${task}. Run /help.\n`);
        continue;
      }

      const controller = new AbortController();
      activeController = controller;
      let releaseExecution: (() => Promise<void>) | undefined;
      try {
        releaseExecution = await sessionStore.acquireExecution?.(session.id);
        const current = await sessionStore.load(session.id);
        if (!current) throw new Error(`Active session was not found: ${session.id}`);
        if (current.workingDirectory !== workingDirectory || current.provider !== activeProvider || current.model !== activeModelName) {
          throw new Error("Active session workspace, provider, or model changed.");
        }
        session = current;
        conversationResponseId = current.continuation?.responseId;
        continuationState = current.continuation?.providerState;
        activeSkillReferences = current.skills ?? [];
        if (isCheckpointCommand(task)) {
          const local = checkpointCommand(task, checkpoints);
          for (const tool of local.tools) operations.set(tool.name, tool.operation);
          await runAgent({ task, ...local, workingDirectory, checkpoints, maxTurns: 2, signal: controller.signal,
            authorize: createAuthorizer(answers, (request) => { lines.approval(); renderer.renderApproval(request); }, controller.signal),
            onEvent: (event) => renderEvent(event, renderer, operations),
          });
          continue;
        }
        const skills = await createSkillsContext(skillsDirectory, activeSkillReferences, workingDirectory);
        const memory = await memoryContextFor(memoryStore, workingDirectory, task);
        const projectContext = await discoverProjectContext(workingDirectory);
        // The parent receives one immutable current-session plan snapshot; mutations remain AgentTool calls behind M10.
        const plan = { version: 1 as const, tasks: await createSessionPlanStore(sessionStore, session.id).list() };
        const suggestionTool = createMemorySuggestionTool({
          store: memoryStore,
          workingDirectory,
          onSuggestion: (suggestion) => { write(formatMemorySuggestion(suggestion, true)); return true; },
        });
        const authorize = createAuthorizer(answers, (request) => { lines.approval(); renderer.renderApproval(request); }, controller.signal);
        const subagent = createSubagentTool({
          createModel: () => createFreshSubagentModel(dependencies, providers, activeProvider, activeModelName, write),
          tools: [...tools, suggestionTool],
          projectContext,
          skills,
          memory,
          getPlan: async () => ({ version: 1, tasks: await createSessionPlanStore(sessionStore, session.id).list() }),
          maxDepth: 2,
          authorizeNested: ({ name, task }) => authorize({ name, operation: "EXECUTE", arguments: task }),
        });
        const parallelSubagents = createParallelSubagentTool({
          createModel: () => createFreshSubagentModel(dependencies, providers, activeProvider, activeModelName, write),
          tools: [...tools, suggestionTool],
          projectContext,
          skills,
          memory,
          getPlan: async () => ({ version: 1, tasks: await createSessionPlanStore(sessionStore, session.id).list() }),
        });
        const orchestrationTools = createPlanOrchestrationTools({
          resolveStore: () => createSessionPlanStore(sessionStore, session.id),
          createModel: () => createFreshSubagentModel(dependencies, providers, activeProvider, activeModelName, write),
          tools: [...tools, suggestionTool],
          projectContext,
          skills,
          memory,
          getPlan: async () => ({ version: 1, tasks: await createSessionPlanStore(sessionStore, session.id).list() }),
        });
        const historyRecorder = createSessionHistoryRecorder();
        const searchTools = createSessionSearchTools(sessionStore, workingDirectory);
        for (const tool of searchTools) operations.set(tool.name, tool.operation);
        const runTools = [...tools, ...searchTools, suggestionTool, subagent, parallelSubagents, ...orchestrationTools];
        operations.set(suggestionTool.name, suggestionTool.operation);
        operations.set(subagent.name, subagent.operation);
        operations.set(parallelSubagents.name, parallelSubagents.operation);
        for (const tool of orchestrationTools) operations.set(tool.name, tool.operation);
        activeModel ??= createInteractiveModel(activeModelInput);
        const runDiagnostics = diagnostics.start({ sessionId: session.id, provider: activeProvider, model: activeModelName });
        activeRunDiagnostics = runDiagnostics;
        const result = await runAgent({
          task,
          inlineContextReferences: true,
          model: activeModel,
          tools: runTools,
          lsp: dependencies.config?.lsp,
          workingDirectory,
          projectContext,
          skills,
          memory,
          plan,
          conversationResponseId,
          continuationState,
          sessionApprovals,
          checkpoints,
          authorize,
          onEvent: (event) => { historyRecorder.observe(event); renderEvent(event, renderer, operations); },
          maxTurns: dependencies.config?.maxTurns,
          contextBudgetChars: dependencies.config?.contextBudgetChars,
          signal: controller.signal,
          diagnostics: runDiagnostics,
        });
        conversationResponseId = result.responseId;
        continuationState = result.continuationState;
        const completedAt = new Date().toISOString();
        const updateSession = (current: DragonsSession): DragonsSession => {
          const messages = compactSessionMessages([
            ...current.messages,
            { role: "user", content: task, createdAt: completedAt },
            { role: "assistant", content: result.finalText, createdAt: completedAt },
          ], Math.max(1, Math.floor((dependencies.config?.contextBudgetChars ?? 120_000) / 2)));
          return {
            ...current,
            updatedAt: completedAt,
            messages,
            toolHistory: historyRecorder.merge(current),
            continuation: {
              responseId: result.responseId,
              ...(result.continuationState === undefined ? {} : { providerState: result.continuationState }),
            },
          };
        };
        const savedSession = sessionStore.mutate
          ? await sessionStore.mutate(session.id, updateSession)
          : await (async () => {
            const next = updateSession(session);
            await sessionStore.save(next);
            return next;
          })();
        if (!savedSession) throw new Error(`Active session was not found: ${session.id}`);
        session = savedSession;
      } catch (error: unknown) {
        if (!(error instanceof AgentRunCancelledError)) {
          const message = error instanceof Error ? error.message : "Unexpected error.";
          renderer.renderError(message);
        }
      } finally {
        try {
          activeController = undefined;
          renderer.finishRun();
        } finally {
          await releaseExecution?.();
        }
      }
      write("\n");
    }
  } finally {
    backgroundTasks.cancelForSession(session.id);
    process.removeListener("SIGINT", cancel);
    lines.close();
    try { await stopSessionLoop(); } finally { await loopRuntime?.dispose(); }
    try { await goalService?.close(); } finally { await goalRuntime?.dispose(); }
    await mcp.closeAll();
    renderer.dispose();
  }
}

export async function main(
  arguments_ = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<void> {
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const configuredProviderIds = dependencies.providerRegistry?.ids() ?? DEFAULT_PROVIDER_IDS;
  if (arguments_.length === 1 && arguments_[0] === "--version") {
    write(`dragons ${DRAGONS_VERSION}\n`);
    return;
  }
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    write(`Usage: dragons [--provider ${configuredProviderIds.join("|")}] [--model <model>] [task]\n\nRun without a task for interactive mode. Use --tui for the full-screen runtime client; --tui --resume <id> continues a saved session. Commands: auth, profile, config, session, skills, memory, plan, cron, mcp.\n`);
    return;
  }
  const initialCommand = parseCliCommand(arguments_, configuredProviderIds);
  if (initialCommand.kind === "profile") {
    const profiles = createDragonsProfileStore({ configPath: dependencies.configPath });
    if (initialCommand.action === "show") {
      const name = await profiles.active();
      write(`Active profile: ${name}\n`);
      return;
    }
    if (initialCommand.action === "list") {
      const active = await profiles.active();
      for (const name of await profiles.list()) write(`${name === active ? "*" : " "} ${name}\n`);
      return;
    }
    if (!("name" in initialCommand)) throw new Error("Invalid profile command.");
    const paths = initialCommand.action === "select" ? await profiles.select(initialCommand.name) : await profiles.create(initialCommand.name);
    write(initialCommand.action === "select" ? `Active profile: ${paths.name}\n` : `Created profile: ${paths.name}\n`);
    return;
  }
  let profiles = dependencies.profileStore;
  if (!profiles) {
    try { profiles = createDragonsProfileStore({ configPath: dependencies.configPath }); }
    catch (error: unknown) {
      // Preserve headless missing-key diagnostics when no state root is available.
      // Only path discovery is optional: active-profile reads below must fail closed.
      if (!(error instanceof Error) || error.message !== "Unable to determine a home directory for Dragons config.") throw error;
    }
  }
  let tuiAuthNotice: ((text: string) => void) | undefined;
  let tuiAuthSignal: AbortSignal | undefined;
  let cronProfileName: string | undefined;
  if (profiles) {
    const requestedCronProfile = initialCommand.kind === "cron" && initialCommand.action === "serve" ? initialCommand.profile : undefined;
    if (requestedCronProfile && !(await profiles.list()).includes(requestedCronProfile)) throw new Error("Cron profile does not exist.");
    const profile = profiles.paths(requestedCronProfile ?? await profiles.active());
    cronProfileName = profile.name;
    dependencies = {
      ...dependencies,
      apiKeyAuth: dependencies.apiKeyAuth ?? createApiKeyAuth(profile.name),
      configPath: profile.configPath,
      sessionDirectory: dependencies.sessionDirectory ?? profile.sessionDirectory,
      skillsDirectory: dependencies.skillsDirectory ?? profile.skillsDirectory,
      memoryDirectory: dependencies.memoryDirectory ?? profile.memoryDirectory,
      backgroundJobsDirectory: dependencies.backgroundJobsDirectory ?? profile.backgroundJobsDirectory,
      cronDirectory: dependencies.cronDirectory ?? join(dirname(profile.configPath), "cron"),
      chatgptAuth: dependencies.chatgptAuth ?? createChatGPTAuthService({
        write: initialCommand.kind === "tui" ? (text) => tuiAuthNotice?.(text) : write,
        credentialPath: join(dirname(profile.configPath), "auth.json"),
        nativeCredentialAccount: profile.credentialAccount,
        ...(initialCommand.kind === "tui" ? {
          fetchImpl: ((input, init) => fetch(input, {
            ...init,
            signal: tuiAuthSignal && init?.signal ? AbortSignal.any([tuiAuthSignal, init.signal]) : tuiAuthSignal ?? init?.signal,
          })) as typeof fetch,
          sleep: async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: tuiAuthSignal }); },
        } : {}),
      }),
      profileStore: profiles,
    };
  }
  let config = dependencies.config ? parseDragonsConfig(dependencies.config, configuredProviderIds) : {};
  if (!dependencies.config) {
    try { config = await loadDragonsConfig(dependencies.configPath, configuredProviderIds); }
    catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.startsWith("Unable to determine a home directory")) throw error;
    }
  }
  const providers = providerRegistryFor(dependencies, config.localEndpoint, !profiles, config.apiKeySlots);
  configureProfileReasoning(providers, config, dependencies.configPath);
  let parsedCommand = initialCommand;
  if (parsedCommand.kind === "run") {
    const providerExplicit = arguments_.includes("--provider");
    const modelExplicit = arguments_.includes("--model");
    parsedCommand = {
      ...parsedCommand,
      provider: providerExplicit ? parsedCommand.provider : config.provider ?? parsedCommand.provider,
      model: modelExplicit ? parsedCommand.model : config.models?.[providerExplicit ? parsedCommand.provider : config.provider ?? parsedCommand.provider] ?? config.model ?? parsedCommand.model,
    };
  }
  if (parsedCommand.kind === "tui") {
    const input = dependencies.input ?? process.stdin;
    const output = dependencies.tuiOutput ?? process.stdout;
    if (!(input as { isTTY?: boolean }).isTTY || !output.isTTY) {
      throw new Error("TUI requires a TTY on stdin and stdout. Use dragons without --tui for plain/headless mode.");
    }
    const provider = parsedCommand.provider ?? config.provider ?? providers.ids()[0]!;
    const model = parsedCommand.model ?? config.models?.[provider] ?? config.model;
    const workingDirectory = dependencies.workingDirectory ?? process.cwd();
    try {
      if (process.env.DRAGONS_RUNTIME_URL) {
        const remote = await connectRemoteRuntime({ url: process.env.DRAGONS_RUNTIME_URL, token: process.env.DRAGONS_REMOTE_TOKEN ?? "" });
        // Explicit CLI selectors override the shared host, never local configured defaults.
        await runTui(remote, { input, output, ...(parsedCommand.resume ? { resume: parsedCommand.resume } : { provider: parsedCommand.provider, model: parsedCommand.model }) });
        return;
      }
      const runtime = await createDragonsRuntime({
        workingDirectory,
        providerRegistry: providers,
        sessionStore: sessionStoreFor(dependencies, providers),
        tools: dependencies.tools ?? await createCodingTools(workingDirectory, {
          maxToolOutputBytes: config.maxToolOutputBytes,
          shellTimeoutMilliseconds: config.shellTimeoutMilliseconds,
        }),
        mcpManager: dependencies.mcpManager ?? new McpClientManager(config.mcpServers ?? []),
        lsp: config.lsp,
        diagnostics: dependencies.diagnostics,
        memoryStore: memoryStoreFor(dependencies),
        skillsDirectory: skillsDirectoryFor(dependencies),
        defaultProvider: provider,
        defaultModel: model,
        maxTurns: config.maxTurns,
        contextBudgetChars: config.contextBudgetChars,
      });
      await runTui(runtime, { input, output,
        localCommands: createTuiLocalCommands({
          apiKeyAuth: dependencies.apiKeyAuth,
          reasoning: providers.reasoning.bind(providers),
          auth: dependencies.chatgptAuth!, profiles: profiles ?? createDragonsProfileStore({ configPath: dependencies.configPath }),
          sessions: sessionStoreFor(dependencies, providers),
          authNotices: (notice, signal) => { tuiAuthNotice = notice; tuiAuthSignal = signal; },
        }),
        ...(parsedCommand.resume ? { resume: parsedCommand.resume } : { provider, model }),
      });
    } catch {
      // Boot errors can contain host paths/provider credentials. Never print arbitrary exceptions.
      throw new Error("Unable to open TUI. Check provider configuration, session ID/workspace, and terminal availability.");
    }
    return;
  }
  const mcp = dependencies.mcpManager ?? new McpClientManager(config.mcpServers ?? []);
  const diagnostics = dependencies.diagnostics ?? new RuntimeDiagnosticsService();
  if (parsedCommand.kind === "mcp") {
    try {
      if (parsedCommand.action === "list") { writeMcpList(mcp, write); return; }
      if (parsedCommand.action === "status") { writeMcpStatus(mcp, write); return; }
      if (parsedCommand.action === "connect-all") {
        const result = await mcp.connectAll();
        if (result.connected.length === 0 && result.failed.length === 0) write("No MCP servers are configured.\n");
        else {
          if (result.connected.length > 0) write(`Connected MCP servers: ${result.connected.join(", ")}\n`);
          if (result.failed.length > 0) write(`Failed MCP servers: ${result.failed.join(", ")}\n`);
        }
        return;
      }
      if (parsedCommand.action === "connect") {
        const tools = await mcp.connect(parsedCommand.id, []);
        write(`Connected MCP server ${parsedCommand.id} (${tools.length} tool${tools.length === 1 ? "" : "s"})\n`);
        return;
      }
      await mcp.disconnect(parsedCommand.id);
      write(`Disconnected MCP server ${parsedCommand.id}\n`);
      return;
    } finally {
      await mcp.closeAll();
    }
  }
  if (parsedCommand.kind === "config") {
    if (parsedCommand.action === "show") {
      write(`${JSON.stringify(config, null, 2)}\n`);
      return;
    }
    const next: DragonsConfig = { ...config, version: 1 };
    if (parsedCommand.action === "set-provider") next.provider = parsedCommand.provider;
    if (parsedCommand.action === "set-model") next.models = { ...next.models, [parsedCommand.provider]: parsedCommand.model };
    if (parsedCommand.action === "set-local-endpoint") next.localEndpoint = parsedCommand.endpoint;
    if (parsedCommand.action === "reset" && parsedCommand.target === "provider") delete next.provider;
    if (parsedCommand.action === "reset" && parsedCommand.target === "model") { delete next.model; delete next.models; }
    await saveDragonsConfig(next, dependencies.configPath, providers.ids());
    write("Dragons configuration updated.\n");
    return;
  }
  if (parsedCommand.kind === "auth") {
    await runAuthCommand(parsedCommand, dependencies, write);
    return;
  }
  if (parsedCommand.kind === "plan") {
    await runPlanCommand(parsedCommand, sessionStoreFor(dependencies, providers), write);
    return;
  }
  if (parsedCommand.kind === "cron") {
    if (!dependencies.cronDirectory) throw new Error("Cron requires an active Dragons profile state root.");
    if (parsedCommand.action === "serve" && parsedCommand.workspace && dependencies.workingDirectory
      && await realpath(parsedCommand.workspace) !== await realpath(dependencies.workingDirectory)) throw new Error("Cron workspace cannot override the host workspace.");
    const provider = config.provider ?? providers.ids()[0];
    if (!provider) throw new Error("Cron requires a configured provider.");
    await runCronCommand({ command: parsedCommand, directory: dependencies.cronDirectory,
      workingDirectory: parsedCommand.action === "serve" && parsedCommand.workspace ? parsedCommand.workspace : dependencies.workingDirectory ?? process.cwd(), skillsDirectory: skillsDirectoryFor(dependencies),
      ...(cronProfileName ? { profileName: cronProfileName } : {}),
      createModel: () => createFreshSubagentModel(dependencies, providers, provider, config.models?.[provider] ?? config.model, write),
      write, ...(dependencies.cronSignal === undefined ? {} : { signal: dependencies.cronSignal }) });
    return;
  }
  if (parsedCommand.kind === "memory") {
    await runMemoryCommand({
      command: parsedCommand,
      store: memoryStoreFor(dependencies),
      workingDirectory: dependencies.workingDirectory ?? process.cwd(),
      write,
    });
    return;
  }
  if (parsedCommand.kind === "skills") {
    await runSkillsCommand({
      command: parsedCommand,
      directory: skillsDirectoryFor(dependencies),
      workingDirectory: dependencies.workingDirectory ?? process.cwd(),
      sessionStore: sessionStoreFor(dependencies, providers),
      write,
    });
    return;
  }

  let sessions: SessionStore | undefined;
  let command: Extract<CliCommand, { kind: "run" }>;
  let resumedSession: DragonsSession | undefined;
  if (parsedCommand.kind === "session") {
    sessions = sessionStoreFor(dependencies, providers);
    if (parsedCommand.action === "list") {
      await listSessions(sessions, write);
      return;
    }
    const selectedSession = await sessions.load(parsedCommand.id);
    if (!selectedSession) throw new Error(`Saved session was not found or is unreadable: ${parsedCommand.id}`);
    if (parsedCommand.action === "show") {
      write(`${JSON.stringify(selectedSession, null, 2)}\n`);
      return;
    }
    if (parsedCommand.action === "delete") {
      await sessions.delete(parsedCommand.id);
      write(`Deleted session: ${parsedCommand.id}\n`);
      return;
    }
    resumedSession = selectedSession;
    await requireSessionWorkspace(resumedSession.workingDirectory);
    command = {
      kind: "run",
      provider: resumedSession.provider,
      model: resumedSession.model,
    };
  } else {
    command = parsedCommand;
  }

  // Runtime-owned unattended turns compare exact canonical workspace identities.
  const workingDirectory = resumedSession?.workingDirectory ?? await realpath(dependencies.workingDirectory ?? process.cwd());
  const tools = dependencies.tools ?? await createCodingTools(workingDirectory, {
    maxToolOutputBytes: config.maxToolOutputBytes,
    shellTimeoutMilliseconds: config.shellTimeoutMilliseconds,
  });
  if (!command.prompt) {
    const store = sessions ?? sessionStoreFor(dependencies, providers);
    const session = resumedSession ?? await store.create({
      workingDirectory,
      provider: command.provider,
      model: selectedModel(providers, command.provider, command.model),
    });
    await runInteractiveConversation(command, { ...dependencies, config }, providers, write, dependencies.model, tools, workingDirectory, skillsDirectoryFor(dependencies), memoryStoreFor(dependencies), store, session, Boolean(resumedSession), mcp, diagnostics, cronProfileName);
    return;
  }
  let plainRunDiagnostics: RuntimeDiagnosticsRun | undefined;
  // Plain runs have no saved session; adopt their process-local identity before target I/O.
  const createPlainModel = (): AgentModel => dependencies.model
    ?? dependencies.modelFactory?.(command.provider, command.model)
    ?? providers.createModel(command.provider, { model: command.model, write }, async (target) => {
      if (controller.signal.aborted) return false;
      command = { ...command, provider: target.provider, model: target.model };
      plainRunDiagnostics?.recordIdentityTransition(target);
      write(`Provider fallback: ${target.provider} · ${target.model} (context sharing explicitly enabled).\n`);
      return !controller.signal.aborted;
    });
  const model = createPlainModel();
  if (command.provider === "chatgpt") write("ChatGPT Subscription (Experimental)\n");
  const input = dependencies.input ?? process.stdin;
  const renderer = terminalRenderer(dependencies, input, write, false);
  const operations = new Map(tools.map((tool) => [tool.name, tool.operation]));
  const controller = new AbortController();
  const authorizer = createCliAuthorizer(input, renderer, controller.signal);
  const cancelRun = (): void => controller.abort();
  process.once("SIGINT", cancelRun);
  try {
    const memoryStore = memoryStoreFor(dependencies);
    const memory = await memoryContextFor(memoryStore, workingDirectory, command.prompt);
    const projectContext = await discoverProjectContext(workingDirectory);
    const suggestionTool = createMemorySuggestionTool({
      store: memoryStore,
      workingDirectory,
      onSuggestion: (suggestion) => { write(formatMemorySuggestion(suggestion, false)); return true; },
    });
    const subagent = createSubagentTool({
      createModel: () => createFreshSubagentModel(dependencies, providers, command.provider, command.model, write),
      tools: [...tools, suggestionTool],
      projectContext,
      memory,
    });
    const parallelSubagents = createParallelSubagentTool({
      createModel: () => createFreshSubagentModel(dependencies, providers, command.provider, command.model, write),
      tools: [...tools, suggestionTool],
      projectContext,
      memory,
    });
    const searchTools = createSessionSearchTools(sessions ?? sessionStoreFor(dependencies, providers), workingDirectory);
    for (const tool of searchTools) operations.set(tool.name, tool.operation);
    const runTools = [...tools, ...searchTools, suggestionTool, subagent, parallelSubagents];
    operations.set(suggestionTool.name, suggestionTool.operation);
    operations.set(subagent.name, subagent.operation);
    operations.set(parallelSubagents.name, parallelSubagents.operation);
    const runDiagnostics = diagnostics.start({ provider: command.provider, model: selectedModel(providers, command.provider, command.model) });
    plainRunDiagnostics = runDiagnostics;
    await runAgent({
      task: command.prompt,
      inlineContextReferences: true,
      model,
      tools: runTools,
      lsp: config.lsp,
      workingDirectory,
      projectContext,
      memory,
      authorize: authorizer.authorize,
      onEvent: (event) => renderEvent(event, renderer, operations),
      signal: controller.signal,
      diagnostics: runDiagnostics,
    });
  } finally {
    process.removeListener("SIGINT", cancelRun);
    authorizer.close();
    renderer.dispose();
  }
  write("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  void main().catch((error: unknown) => {
    if (error instanceof AgentRunCancelledError) {
      process.exitCode = 130;
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
