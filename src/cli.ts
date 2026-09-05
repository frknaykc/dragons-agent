#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stat } from "node:fs/promises";
import { realpathSync } from "node:fs";

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
import { runTui, type TuiOutput } from "./tui/terminal.js";
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
import { parseCliCommand, providerFrom, type CliCommand, type ProviderName } from "./cli/commands.js";
import { formatMemorySuggestion, handleInteractiveMemoryCommand, memoryContextFor, runMemoryCommand } from "./cli/memory-commands.js";
import { handleInteractivePlanCommand, runPlanCommand } from "./cli/plan-commands.js";
import { handleInteractiveSkillsCommand, runSkillsCommand, writeActiveSkillNotices } from "./cli/skills-commands.js";

export { parseCliCommand } from "./cli/commands.js";
export type { ProviderName } from "./cli/commands.js";

type ModelFactory = { create(provider: ProviderName, model?: string): AgentModel }["create"];

export type CliDependencies = {
  workingDirectory?: string;
  model?: AgentModel;
  /** Method-style callback retains compatibility with existing narrowed built-in-provider test doubles. */
  modelFactory?: ModelFactory;
  /** Registered adapters for this CLI process. Registry metadata never stores credentials or session state. */
  providerRegistry?: ProviderRegistry;
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
    color?: boolean;
  };
  sessionDirectory?: string;
  sessionStore?: SessionStore;
  configPath?: string;
  config?: DragonsConfig;
  /** Dragons-owned skills root. It is never inferred from the project workspace. */
  skillsDirectory?: string;
  /** Dragons-owned memory root. It is never inferred from the project workspace. */
  memoryDirectory?: string;
  /** App-owned durable M60 job state root; runtime handles and approvals are never stored here. */
  backgroundJobsDirectory?: string;
  /** Process-local MCP connections; dependency injection exists for deterministic tests only. */
  mcpManager?: McpClientManager;
  /** Process-local bounded diagnostics; never saved into Dragons session JSON. */
  diagnostics?: RuntimeDiagnosticsService;
};

type AnswerSource = {
  next: () => Promise<IteratorResult<string>>;
};

function cancellationAwareAnswer(
  answers: AnswerSource,
  signal?: AbortSignal,
): Promise<IteratorResult<string>> {
  if (!signal) return answers.next();
  if (signal.aborted) return Promise.resolve({ done: true, value: undefined as never });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: IteratorResult<string>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      resolve(answer);
    };
    const cancel = (): void => finish({ done: true, value: undefined as never });
    signal.addEventListener("abort", cancel, { once: true });
    void answers.next().then(finish);
  });
}

function createAuthorizer(
  answers: AnswerSource,
  renderApproval: (request: ToolAuthorizationRequest) => void,
  signal?: AbortSignal,
): (request: ToolAuthorizationRequest) => Promise<ToolAuthorizationDecision> {
  return async (request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision> => {
    if (request.operation === "READ") return true;
    renderApproval(request);
    const answer = await cancellationAwareAnswer(answers, signal);
    const response = answer.done ? "" : answer.value.trim().toLowerCase();
    if (response === "session" || response === "always" || response === "a") return "session";
    return response === "y" || response === "yes";
  };
}

function createCliAuthorizer(
  input: NodeJS.ReadableStream,
  renderer: TerminalRenderer,
  signal?: AbortSignal,
): { authorize: (request: ToolAuthorizationRequest) => Promise<ToolAuthorizationDecision>; close: () => void } {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const answers = lines[Symbol.asyncIterator]();
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
  if (event.type === "tool_completed") renderer.renderToolCompleted(event.name, event.result.ok);
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
  return createTerminalRenderer({ write, isTTY, color, width });
}

function providerRegistryFor(dependencies: CliDependencies, localEndpoint?: string): ProviderRegistry {
  return dependencies.providerRegistry ?? createBuiltInProviderRegistry({
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

/** Child delegation intentionally never reuses the parent model instance or continuation. */
function createFreshSubagentModel(dependencies: CliDependencies, providers: ProviderRegistry, provider: ProviderName, model: string | undefined, write: (text: string) => void): AgentModel {
  return dependencies.modelFactory?.(provider, model) ?? defaultModel(
    providers,
    provider,
    model,
    write,
  );
}

async function runAuthCommand(command: Extract<CliCommand, { kind: "auth" }>, dependencies: CliDependencies, write: (text: string) => void): Promise<void> {
  const auth = dependencies.chatgptAuth ?? createChatGPTAuthService({ write });
  if (command.action === "login") {
    await auth.login();
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
): Promise<void> {
  const input = dependencies.input ?? process.stdin;
  const renderer = terminalRenderer(dependencies, input, write, true);
  const operations = new Map(tools.map((tool) => [tool.name, tool.operation]));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const answers = lines[Symbol.asyncIterator]();
  let activeController: AbortController | undefined;
  let session = initialSession;
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
  let activeSkillReferences: SkillReference[] = session.skills ?? [];
  // Process-local only: intentionally discarded on resume and process exit.
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

  renderer.renderStartup({
    provider: providerLabel(providers, activeProvider),
    model: activeModelName,
    workingDirectory,
  });
  write(`${resumed ? "Resumed session" : "Session"}: ${session.id}\n`);
  await writeActiveSkillNotices(skillsDirectory, activeSkillReferences, write, workingDirectory);
  process.on("SIGINT", cancel);
  try {
    for (;;) {
      renderer.renderComposer();
      const answer = await answers.next();
      if (answer.done) {
        backgroundTasks.cancelForSession(session.id);
        return;
      }
      const task = answer.value.trim();
      if (!task) continue;
      if (task === "exit" || task === "quit" || task === "/exit") {
        backgroundTasks.cancelForSession(session.id);
        return;
      }
      if (task === "/help") {
        write("Slash commands: /help, /status, /diagnostics, /new, /sessions, /resume <id>, /model, /provider, /tasks start <prompt>|show <id>|cancel <id>, /tasks, /jobs start <prompt>|show <id>|cancel <id>|resume <id>|cleanup, /jobs, /skills, /skills list|show|activate|deactivate, /memory list|add|delete, /plan [list|add|update|status|remove], /mcp list|connect|connect-all|status|disconnect, /context, /clear, /exit\n");
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
        write(`Session: ${session.id}\n`);
        continue;
      }
      if (task === "/clear") {
        const clearedAt = new Date().toISOString();
        const clearedSession = sessionStore.mutate
          ? await sessionStore.mutate(session.id, (current) => ({ ...current, updatedAt: clearedAt, messages: [], continuation: undefined }))
          : await (async () => {
            const next = { ...session, updatedAt: clearedAt, messages: [], continuation: undefined };
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
        activeModel = dependencies.modelFactory?.(activeProvider, activeModelName)
          ?? dependencies.model
          ?? defaultModel(providers, activeProvider, activeModelName, write);
        await memoryStore.clearSuggestions();
        sessionApprovals.clear();
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
      if (task === "/model") {
        write(`Model: ${activeModelName}\nUse /model <name> to start a new conversation with that model.\n`);
        continue;
      }
      if (task.startsWith("/model ")) {
        const nextModel = task.slice("/model ".length).trim();
        if (!nextModel) { write("Usage: /model <name>\n"); continue; }
        const nextConfig: DragonsConfig = { ...(dependencies.config ?? {}), version: 1, models: { ...(dependencies.config?.models ?? {}), [activeProvider]: nextModel } };
        await saveDragonsConfig(nextConfig, dependencies.configPath, providers.ids());
        backgroundTasks.cancelForSession(session.id);
        activeModelName = nextModel;
        activeModelInput = nextModel;
        activeModel = dependencies.modelFactory?.(activeProvider, nextModel) ?? dependencies.model ?? defaultModel(providers, activeProvider, nextModel, write);
        await memoryStore.clearSuggestions();
        session = await sessionStore.create({ workingDirectory, provider: activeProvider, model: activeModelName });
        activeSkillReferences = [];
        conversationResponseId = undefined;
        continuationState = undefined;
        sessionApprovals.clear();
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
        backgroundTasks.cancelForSession(session.id);
        activeProvider = nextProvider;
        activeModelName = nextModel;
        activeModelInput = configuredModel;
        activeModel = dependencies.modelFactory?.(activeProvider, nextModel) ?? dependencies.model ?? defaultModel(providers, activeProvider, nextModel, write);
        await memoryStore.clearSuggestions();
        session = await sessionStore.create({ workingDirectory, provider: activeProvider, model: activeModelName });
        activeSkillReferences = [];
        conversationResponseId = undefined;
        continuationState = undefined;
        sessionApprovals.clear();
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
      if (task.startsWith("/")) {
        write(`Unknown slash command: ${task}. Run /help.\n`);
        continue;
      }

      const controller = new AbortController();
      activeController = controller;
      try {
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
        const authorize = createAuthorizer(answers, (request) => renderer.renderApproval(request), controller.signal);
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
        const runTools = [...tools, suggestionTool, subagent, parallelSubagents, ...orchestrationTools];
        operations.set(suggestionTool.name, suggestionTool.operation);
        operations.set(subagent.name, subagent.operation);
        operations.set(parallelSubagents.name, parallelSubagents.operation);
        for (const tool of orchestrationTools) operations.set(tool.name, tool.operation);
        activeModel ??= dependencies.modelFactory?.(activeProvider, activeModelInput) ?? dependencies.model ?? defaultModel(providers, activeProvider, activeModelName, write);
        const runDiagnostics = diagnostics.start({ sessionId: session.id, provider: activeProvider, model: activeModelName });
        const result = await runAgent({
          task,
          model: activeModel,
          tools: runTools,
          workingDirectory,
          projectContext,
          skills,
          memory,
          plan,
          conversationResponseId,
          continuationState,
          sessionApprovals,
          authorize,
          onEvent: (event) => renderEvent(event, renderer, operations),
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
        activeController = undefined;
        renderer.finishRun();
      }
      write("\n");
    }
  } finally {
    backgroundTasks.cancelForSession(session.id);
    process.removeListener("SIGINT", cancel);
    lines.close();
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
    write(`Usage: dragons [--provider ${configuredProviderIds.join("|")}] [--model <model>] [task]\n\nRun without a task for interactive mode. Use --tui for the full-screen runtime client; --tui --resume <id> continues a saved session. Commands: auth, config, session, skills, memory, plan, mcp.\n`);
    return;
  }
  let config = dependencies.config ? parseDragonsConfig(dependencies.config, configuredProviderIds) : {};
  if (!dependencies.config) {
    try { config = await loadDragonsConfig(dependencies.configPath, configuredProviderIds); }
    catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.startsWith("Unable to determine a home directory")) throw error;
    }
  }
  const providers = providerRegistryFor(dependencies, config.localEndpoint);
  let parsedCommand = parseCliCommand(arguments_, providers.ids());
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
      const runtime = await createDragonsRuntime({
        workingDirectory,
        providerRegistry: providers,
        sessionStore: sessionStoreFor(dependencies, providers),
        tools: dependencies.tools ?? await createCodingTools(workingDirectory, {
          maxToolOutputBytes: config.maxToolOutputBytes,
          shellTimeoutMilliseconds: config.shellTimeoutMilliseconds,
        }),
        mcpManager: dependencies.mcpManager ?? new McpClientManager(config.mcpServers ?? []),
        diagnostics: dependencies.diagnostics,
        memoryStore: memoryStoreFor(dependencies),
        skillsDirectory: skillsDirectoryFor(dependencies),
        defaultProvider: provider,
        defaultModel: model,
        maxTurns: config.maxTurns,
        contextBudgetChars: config.contextBudgetChars,
      });
      await runTui(runtime, { input, output, ...(parsedCommand.resume ? { resume: parsedCommand.resume } : { provider, model }) });
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

  const workingDirectory = resumedSession?.workingDirectory ?? dependencies.workingDirectory ?? process.cwd();
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
    await runInteractiveConversation(command, { ...dependencies, config }, providers, write, dependencies.model, tools, workingDirectory, skillsDirectoryFor(dependencies), memoryStoreFor(dependencies), store, session, Boolean(resumedSession), mcp, diagnostics);
    return;
  }
  const model = dependencies.model
    ?? dependencies.modelFactory?.(command.provider, command.model)
    ?? defaultModel(
      providers,
      command.provider,
      command.model,
      write,
    );
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
    const runTools = [...tools, suggestionTool, subagent, parallelSubagents];
    operations.set(suggestionTool.name, suggestionTool.operation);
    operations.set(subagent.name, subagent.operation);
    operations.set(parallelSubagents.name, parallelSubagents.operation);
    const runDiagnostics = diagnostics.start({ provider: command.provider, model: selectedModel(providers, command.provider, command.model) });
    await runAgent({
      task: command.prompt,
      model,
      tools: runTools,
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
