export type RunStatus = "success" | "failed" | "cancelled";
export type CancellationState = "not_cancelled" | "cancelled";
export type ProviderDiagnosticKind = "authentication" | "entitlement" | "model_unavailable" | "rate_limit" | "transient" | "malformed_response" | "protocol_drift" | "first_party_identity";

export type RuntimeToolCallDiagnostic = {
  /** Safe tool identifier only; never arguments or result content. */
  name?: string;
  durationMilliseconds: number;
};

/** A bounded final summary. It deliberately contains no prompts, arguments, results, headers, credentials, or provider objects. */
export type RuntimeDiagnosticsSummary = {
  runId: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  startedAt: string;
  endedAt: string;
  durationMilliseconds: number;
  modelTurnCount: number;
  toolCallCount: number;
  toolCalls: RuntimeToolCallDiagnostic[];
  providerRetryCount: number;
  /** Safe category counts only; never response bodies, headers, requests, or credentials. */
  providerDiagnosticCounts: Partial<Record<ProviderDiagnosticKind, number>>;
  cancellationCount: number;
  cancellationState: CancellationState;
  timeoutCount: number;
  mcpCallCount: number;
  subagentCount: number;
  backgroundTaskCount: number;
  /** Top-level bounded plan orchestration calls; no task IDs, arguments, or output. */
  orchestrationCount: number;
  status: RunStatus;
};

export type RuntimeDiagnosticsRunOptions = {
  sessionId?: string;
  provider?: string;
  model?: string;
};

export type RuntimeDiagnosticsServiceOptions = {
  /** Bounded in-memory recent summaries; no diagnostics are persisted. */
  maxRecentRuns?: number;
  createRunId?: () => string;
  now?: () => Date;
  /** Monotonic time source used only for durations. */
  monotonicNow?: () => number;
};

const DEFAULT_MAX_RECENT_RUNS = 20;
const SAFE_LABEL = /^[A-Za-z0-9._:/-]{1,128}$/;
const SENSITIVE_LABEL = /(?:secret|token|password|credential|authorization|api[_-]?key|bearer)/i;

function safeLabel(value: string | undefined): string | undefined {
  return value && SAFE_LABEL.test(value) && !SENSITIVE_LABEL.test(value) ? value : undefined;
}

function requiredPositiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error("Runtime diagnostics recent-run limit must be a positive integer.");
  return resolved;
}

function boundedDuration(start: number, end: number): number {
  return Number.isFinite(end) && end >= start ? Math.floor(end - start) : 0;
}

export class RuntimeDiagnosticsRun {
  private readonly startedAt: string;
  private readonly startedMonotonic: number;
  private readonly toolStarts = new Map<number, { name?: string; startedMonotonic: number }>();
  private readonly summary: Omit<RuntimeDiagnosticsSummary, "endedAt" | "durationMilliseconds" | "status">;
  private nextToolCall = 0;
  private finalSummary: RuntimeDiagnosticsSummary | undefined;

  constructor(
    options: RuntimeDiagnosticsRunOptions,
    private readonly runId: string,
    private readonly now: () => Date,
    private readonly monotonicNow: () => number,
    private readonly onFinalized: (summary: RuntimeDiagnosticsSummary) => void,
  ) {
    this.startedAt = now().toISOString();
    this.startedMonotonic = monotonicNow();
    this.summary = {
      runId,
      ...(safeLabel(options.sessionId) ? { sessionId: safeLabel(options.sessionId) } : {}),
      ...(safeLabel(options.provider) ? { provider: safeLabel(options.provider) } : {}),
      ...(safeLabel(options.model) ? { model: safeLabel(options.model) } : {}),
      startedAt: this.startedAt,
      modelTurnCount: 0,
      toolCallCount: 0,
      toolCalls: [],
      providerRetryCount: 0,
      providerDiagnosticCounts: {},
      cancellationCount: 0,
      cancellationState: "not_cancelled",
      timeoutCount: 0,
      mcpCallCount: 0,
      subagentCount: 0,
      backgroundTaskCount: 0,
      orchestrationCount: 0,
    };
  }

  recordModelTurn(): void { if (!this.finalSummary) this.summary.modelTurnCount += 1; }
  recordProviderRetry(): void { if (!this.finalSummary) this.summary.providerRetryCount += 1; }
  recordProviderDiagnostic(kind: ProviderDiagnosticKind): void {
    if (!this.finalSummary) this.summary.providerDiagnosticCounts[kind] = (this.summary.providerDiagnosticCounts[kind] ?? 0) + 1;
  }
  recordBackgroundTaskStarted(): void { if (!this.finalSummary) this.summary.backgroundTaskCount += 1; }

  recordToolCallStarted(name: string): number {
    const id = this.nextToolCall++;
    if (this.finalSummary) return id;
    const safeName = safeLabel(name);
    this.summary.toolCallCount += 1;
    if (name.startsWith("mcp__")) this.summary.mcpCallCount += 1;
    if (name === "delegate_subagent") this.summary.subagentCount += 1;
    if (name === "orchestrate_runnable") this.summary.orchestrationCount += 1;
    this.toolStarts.set(id, { ...(safeName ? { name: safeName } : {}), startedMonotonic: this.monotonicNow() });
    return id;
  }

  recordToolCallCompleted(id: number, timeoutEvidence = false): void {
    if (this.finalSummary) return;
    const start = this.toolStarts.get(id);
    if (!start) return;
    this.toolStarts.delete(id);
    this.summary.toolCalls.push({ ...(start.name ? { name: start.name } : {}), durationMilliseconds: boundedDuration(start.startedMonotonic, this.monotonicNow()) });
    if (timeoutEvidence) this.summary.timeoutCount += 1;
  }

  complete(status: RunStatus): RuntimeDiagnosticsSummary {
    if (this.finalSummary) return structuredClone(this.finalSummary);
    if (status === "cancelled") {
      this.summary.cancellationCount += 1;
      this.summary.cancellationState = "cancelled";
    }
    const endedAt = this.now().toISOString();
    const finalSummary: RuntimeDiagnosticsSummary = {
      ...this.summary,
      toolCalls: this.summary.toolCalls.map((tool) => ({ ...tool })),
      endedAt,
      durationMilliseconds: boundedDuration(this.startedMonotonic, this.monotonicNow()),
      status,
    };
    this.finalSummary = finalSummary;
    this.onFinalized(structuredClone(finalSummary));
    return structuredClone(finalSummary);
  }
}

/** Process-local bounded recent summaries. Callers own service lifetime; there is no module-global diagnostic state. */
export class RuntimeDiagnosticsService {
  private readonly maxRecentRuns: number;
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly completed: RuntimeDiagnosticsSummary[] = [];

  constructor(options: RuntimeDiagnosticsServiceOptions = {}) {
    this.maxRecentRuns = requiredPositiveInteger(options.maxRecentRuns, DEFAULT_MAX_RECENT_RUNS);
    this.createRunId = options.createRunId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  start(options: RuntimeDiagnosticsRunOptions = {}): RuntimeDiagnosticsRun {
    const runId = safeLabel(this.createRunId());
    if (!runId) throw new Error("Runtime diagnostics run ID is invalid.");
    return new RuntimeDiagnosticsRun(options, runId, this.now, this.monotonicNow, (summary) => {
      this.completed.unshift(summary);
      if (this.completed.length > this.maxRecentRuns) this.completed.length = this.maxRecentRuns;
    });
  }

  recent(): RuntimeDiagnosticsSummary[] { return this.completed.map((summary) => structuredClone(summary)); }
}

export function formatRuntimeDiagnostics(summary: RuntimeDiagnosticsSummary | undefined): string {
  if (!summary) return "No completed runtime diagnostics.\n";
  const identity = [summary.provider, summary.model].filter((value): value is string => Boolean(value)).join("/");
  const tools = summary.toolCalls.length === 0
    ? "none"
    : summary.toolCalls.map((tool) => `${tool.name ?? "tool"}:${tool.durationMilliseconds}ms`).join(", ");
  const providerDiagnostics = Object.entries(summary.providerDiagnosticCounts)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(", ");
  return [
    `Run ${summary.runId} [${summary.status}]${identity ? ` ${identity}` : ""}`,
    `duration ${summary.durationMilliseconds}ms · turns ${summary.modelTurnCount} · tools ${summary.toolCallCount} (${tools}) · retries ${summary.providerRetryCount} · timeouts ${summary.timeoutCount}${providerDiagnostics ? ` · provider ${providerDiagnostics}` : ""}`,
    `MCP ${summary.mcpCallCount} · subagents ${summary.subagentCount} · orchestration ${summary.orchestrationCount} · background ${summary.backgroundTaskCount} · cancellation ${summary.cancellationState}${summary.sessionId ? ` · session ${summary.sessionId}` : ""}`,
  ].join("\n");
}
