import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AgentRunCancelledError, runAgent, type AgentEvent, type AgentModel } from "./agent.js";
import type { RuntimeDiagnosticsRun } from "./diagnostics.js";
import type { MemoryContext } from "./memory.js";
import type { DragonsPlan } from "./plan.js";
import type { ProjectContext } from "./project-context.js";
import type { SkillsContext } from "./skills.js";
import type { AgentTool } from "./tools.js";
import { joinPlatformPath } from "./platform-path.js";

export const PERSISTENT_BACKGROUND_JOB_VERSION = 1;
export const DEFAULT_MAX_PERSISTENT_BACKGROUND_JOBS = 128;
export const DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_PROMPT_CHARS = 4_000;
export const DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_TRANSCRIPT_CHARS = 8_000;
export const DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_REPORT_CHARS = 8_000;
export const DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_ERROR_CHARS = 2_000;
export const DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_TURNS = 8;
export const DEFAULT_MAX_ACTIVE_PERSISTENT_BACKGROUND_JOBS = 8;
export const DEFAULT_PERSISTENT_BACKGROUND_JOB_DURATION_MS = 300_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_STATES = new Set<PersistentBackgroundJobState>(["queued", "running", "completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_JOB_STATES = new Set<PersistentBackgroundJobState>(["completed", "failed", "cancelled", "interrupted"]);
const SENSITIVE_VALUE_PATTERN = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\s*[:=]\s*["']?)[^\s,"'}\]]+/gi;
const SENSITIVE_TOKEN_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export type PersistentBackgroundJobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** Minimal durable record. It intentionally excludes models, tools, controllers, approvals, and provider continuation. */
export type PersistentBackgroundJob = {
  version: 1;
  id: string;
  sessionId: string;
  workingDirectory: string;
  prompt: string;
  executionPolicy: "READ_ONLY_MANUAL_RESUME";
  provenance: "INTERACTIVE_COMMAND";
  state: PersistentBackgroundJobState;
  createdAt: string;
  updatedAt: string;
  revision: number;
  startedAt?: string;
  completedAt?: string;
  executionAttempts: number;
  transcript: string;
  report?: string;
  error?: string;
};

export type PersistentBackgroundJobStore = {
  list(): Promise<PersistentBackgroundJob[]>;
  load(id: string): Promise<PersistentBackgroundJob | undefined>;
  save(job: PersistentBackgroundJob, expectedRevision?: number): Promise<PersistentBackgroundJob>;
  delete(id: string): Promise<boolean>;
  claim(id: string): Promise<() => Promise<void>>;
  hasActiveClaim(id: string): Promise<boolean>;
};

export type PersistentBackgroundJobStoreOptions = {
  maxJobs?: number;
};

export type PersistentBackgroundJobManagerOptions = {
  store: PersistentBackgroundJobStore;
  now?: () => Date;
  createId?: () => string;
  maxPromptCharacters?: number;
  maxTranscriptCharacters?: number;
  maxReportCharacters?: number;
  maxErrorCharacters?: number;
  maxTurns?: number;
  maxActiveJobs?: number;
  maxDurationMs?: number;
  onJobStarted?: (job: PersistentBackgroundJob) => RuntimeDiagnosticsRun | undefined;
};

export type StartPersistentBackgroundJobOptions = {
  sessionId: string;
  workingDirectory: string;
  prompt: string;
  createModel: () => AgentModel;
  tools: readonly AgentTool[];
  projectContext?: ProjectContext;
  skills?: SkillsContext;
  memory?: MemoryContext;
  plan?: DragonsPlan;
};

export type ResumePersistentBackgroundJobOptions = Omit<StartPersistentBackgroundJobOptions, "sessionId" | "workingDirectory" | "prompt">;

type RuntimeJob = {
  controller: AbortController;
  promise: Promise<void>;
};

type Limits = Required<Omit<PersistentBackgroundJobManagerOptions, "store" | "now" | "createId" | "onJobStarted">>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function requiredPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer.`);
  return resolved;
}

function boundedText(value: string, maximum: number, kind: string): string {
  if (value.length <= maximum) return value;
  const marker = `[${kind} truncated; omitted ${value.length - maximum} characters]`;
  return marker.length >= maximum ? value.slice(0, maximum) : `${value.slice(0, maximum - marker.length)}${marker}`;
}

function redactPersistentText(value: string): string {
  return value.replace(BEARER_PATTERN, "$1[REDACTED]").replace(SENSITIVE_VALUE_PATTERN, "$1[REDACTED]").replace(SENSITIVE_TOKEN_PATTERN, "[REDACTED]");
}

function cloneSnapshot<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function cloneJob(job: PersistentBackgroundJob): PersistentBackgroundJob {
  return { ...job };
}

function readOnlyTaskTools(tools: readonly AgentTool[]): AgentTool[] {
  return tools.filter((tool) => tool.operation === "READ" && tool.name !== "delegate_subagent" && !tool.name.startsWith("plan_") && tool.name !== "start_background_task" && tool.name !== "background_task_start");
}

function isPersistentBackgroundJob(value: unknown, maxPromptCharacters = DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_PROMPT_CHARS): value is PersistentBackgroundJob {
  const state = isRecord(value) ? value.state : undefined;
  const executionAttempts = isRecord(value) ? value.executionAttempts : undefined;
  const revision = isRecord(value) ? value.revision : undefined;
  if (!isRecord(value)
    || value.version !== PERSISTENT_BACKGROUND_JOB_VERSION
    || !isSafeUuid(value.id)
    || !isSafeUuid(value.sessionId)
    || !validText(value.workingDirectory, 4_096)
    || !validText(value.prompt, maxPromptCharacters)
    || redactPersistentText(value.prompt) !== value.prompt
    || value.executionPolicy !== "READ_ONLY_MANUAL_RESUME"
    || value.provenance !== "INTERACTIVE_COMMAND"
    || typeof state !== "string" || !JOB_STATES.has(state as PersistentBackgroundJobState)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || !Number.isSafeInteger(revision) || (revision as number) < 0
    || !Number.isSafeInteger(executionAttempts) || (executionAttempts as number) < 0
    || typeof value.transcript !== "string" || value.transcript.length > DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_TRANSCRIPT_CHARS
    || (value.report !== undefined && (typeof value.report !== "string" || value.report.length > DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_REPORT_CHARS))
    || (value.error !== undefined && (typeof value.error !== "string" || value.error.length > DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_ERROR_CHARS))
    || (value.startedAt !== undefined && !validTimestamp(value.startedAt))
    || (value.completedAt !== undefined && !validTimestamp(value.completedAt))) return false;
  if ((state === "queued" || state === "running") && value.completedAt !== undefined) return false;
  if (TERMINAL_JOB_STATES.has(state as PersistentBackgroundJobState) && value.completedAt === undefined) return false;
  return true;
}

function jobPath(directory: string, id: string): string {
  if (!isSafeUuid(id)) throw new Error("Persistent background job ID is invalid.");
  return join(directory, `${id}.json`);
}

function jobLockPath(directory: string, id: string): string {
  if (!isSafeUuid(id)) throw new Error("Persistent background job ID is invalid.");
  return join(directory, `${id}.lock`);
}

function owningProcessIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeJob(filePath: string, job: PersistentBackgroundJob): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function ensureJobDirectory(directory: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Persistent background job directory must be a real directory, not a symlink.");
    if (create) await chmod(directory, 0o700);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return false;
    throw error;
  }
}

async function regularJobFile(filePath: string): Promise<boolean> {
  try {
    const entry = await lstat(filePath);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readVerifiedRegularFile(filePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const [opened, named] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (!named.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) return undefined;
    return await handle.readFile("utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function acquireStoreLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, ".persistent-background-jobs.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify({ version: 1, pid: process.pid, token }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return async () => {
        const serialized = await readVerifiedRegularFile(path);
        if (serialized === undefined) return;
        const lock = JSON.parse(serialized) as unknown;
        if (isRecord(lock) && lock.token === token) await rm(path, { force: true });
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw new Error("Persistent background job storage is busy.");
      const serialized = await readVerifiedRegularFile(path);
      const lock = serialized === undefined ? undefined : JSON.parse(serialized) as unknown;
      if (!isRecord(lock) || lock.version !== 1 || !Number.isSafeInteger(lock.pid) || !isSafeUuid(lock.token) || owningProcessIsActive(lock.pid as number)) {
        throw new Error("Persistent background job storage is busy.");
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Persistent background job storage is busy.");
}

export function getDragonsPersistentBackgroundJobsDirectory(options: { platform?: NodeJS.Platform; homeDirectory?: string; xdgConfigHome?: string; appData?: string } = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE;
  if (!homeDirectory) throw new Error("Unable to determine a home directory for persistent Dragons jobs.");
  if (platform === "darwin") return joinPlatformPath(platform, homeDirectory, "Library", "Application Support", "Dragons Agent", "jobs");
  if (platform === "win32") return joinPlatformPath(platform, options.appData ?? process.env.APPDATA ?? homeDirectory, "Dragons Agent", "jobs");
  return joinPlatformPath(platform, options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? joinPlatformPath(platform, homeDirectory, ".config"), "dragons-agent", "jobs");
}

/** App-owned, bounded per-job files. Corrupted entries are ignored rather than executed or exposed. */
export function createPersistentBackgroundJobStore(directory: string, options: PersistentBackgroundJobStoreOptions = {}): PersistentBackgroundJobStore {
  const maxJobs = requiredPositiveInteger(options.maxJobs, DEFAULT_MAX_PERSISTENT_BACKGROUND_JOBS, "Persistent background job storage limit");
  return {
    async list(): Promise<PersistentBackgroundJob[]> {
      if (!await ensureJobDirectory(directory, false)) return [];
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error("Unable to list persistent background jobs.");
      }
      const names = entries.filter((entry) => entry.isFile() && UUID_PATTERN.test(entry.name.slice(0, -".json".length)) && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort()
        .slice(0, maxJobs);
      const jobs = await Promise.all(names.map(async (name) => {
        try {
          const filePath = join(directory, name);
          const serialized = await readVerifiedRegularFile(filePath);
          if (serialized === undefined) return undefined;
          const value = JSON.parse(serialized) as unknown;
          return isPersistentBackgroundJob(value) ? value : undefined;
        } catch {
          return undefined;
        }
      }));
      return jobs.filter((job): job is PersistentBackgroundJob => job !== undefined).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    },
    async load(id): Promise<PersistentBackgroundJob | undefined> {
      let path: string;
      try { path = jobPath(directory, id); } catch { return undefined; }
      try {
        if (!await ensureJobDirectory(directory, false)) return undefined;
        const serialized = await readVerifiedRegularFile(path);
        if (serialized === undefined) return undefined;
        const value = JSON.parse(serialized) as unknown;
        return isPersistentBackgroundJob(value) ? value : undefined;
      } catch { return undefined; }
    },
    async save(job, expectedRevision): Promise<PersistentBackgroundJob> {
      if (!isPersistentBackgroundJob(job)) throw new Error("Refusing to save an invalid or credential-bearing persistent background job.");
      await ensureJobDirectory(directory, true);
      const releaseStoreLock = await acquireStoreLock(directory);
      try {
        const path = jobPath(directory, job.id);
        const serialized = await readVerifiedRegularFile(path);
        const existing = serialized === undefined ? undefined : JSON.parse(serialized) as unknown;
        const existingJob = isPersistentBackgroundJob(existing) ? existing : undefined;
        if (serialized !== undefined && existingJob === undefined) throw new Error("Persistent background job file is invalid or unsafe.");
        if (existingJob === undefined) {
          if (expectedRevision !== undefined) throw new Error("Persistent background job changed before it could be saved.");
          const entries = await readdir(directory, { withFileTypes: true });
          const count = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && UUID_PATTERN.test(entry.name.slice(0, -5))).length;
          if (count >= maxJobs) throw new Error(`Persistent background job storage limit reached (${maxJobs}).`);
        } else if (expectedRevision === undefined || existingJob.revision !== expectedRevision) {
          throw new Error("Persistent background job changed before it could be saved.");
        }
        const next: PersistentBackgroundJob = { ...job, revision: existingJob === undefined ? 0 : existingJob.revision + 1 };
        await writeJob(path, next);
        return next;
      } finally {
        await releaseStoreLock();
      }
    },
    async delete(id): Promise<boolean> {
      try {
        if (!await ensureJobDirectory(directory, false)) return false;
        const path = jobPath(directory, id);
        if (!await regularJobFile(path)) return false;
        await rm(path);
        return true;
      } catch { return false; }
    },
    async claim(id): Promise<() => Promise<void>> {
      await ensureJobDirectory(directory, true);
      const path = jobLockPath(directory, id);
      const token = randomUUID();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await writeFile(path, JSON.stringify({ version: 1, pid: process.pid, token }), { encoding: "utf8", mode: 0o600, flag: "wx" });
          await chmod(path, 0o600);
          return async () => {
            try {
              if (!await regularJobFile(path)) return;
              const serialized = await readVerifiedRegularFile(path);
              if (serialized === undefined) return;
              const lock = JSON.parse(serialized) as unknown;
              if (!isRecord(lock) || lock.token !== token) return;
              await rm(path);
            } catch { /* A lost or replaced lock must not delete another owner's claim. */ }
          };
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw new Error("Persistent background job is already owned by another runtime.");
          try {
            if (!await regularJobFile(path)) throw new Error("Persistent background job lock is invalid.");
            const serialized = await readVerifiedRegularFile(path);
            if (serialized === undefined) throw new Error("Persistent background job lock is invalid.");
            const lock = JSON.parse(serialized) as unknown;
            if (!isRecord(lock) || lock.version !== 1 || !Number.isSafeInteger(lock.pid) || !isSafeUuid(lock.token) || owningProcessIsActive(lock.pid as number)) {
              throw new Error("Persistent background job is already owned by another runtime.");
            }
            await rm(path);
          } catch (lockError: unknown) {
            throw lockError instanceof Error && lockError.message === "Persistent background job is already owned by another runtime."
              ? lockError
              : new Error("Persistent background job is already owned by another runtime.");
          }
        }
      }
      throw new Error("Persistent background job is already owned by another runtime.");
    },
    async hasActiveClaim(id): Promise<boolean> {
      try {
        const path = jobLockPath(directory, id);
        if (!await ensureJobDirectory(directory, false) || !await regularJobFile(path)) return false;
        const serialized = await readVerifiedRegularFile(path);
        if (serialized === undefined) return false;
        const lock = JSON.parse(serialized) as unknown;
        return isRecord(lock) && lock.version === 1 && Number.isSafeInteger(lock.pid) && isSafeUuid(lock.token) && owningProcessIsActive(lock.pid as number);
      } catch { return false; }
    },
  };
}

/**
 * Durable state plus strictly process-local execution handles. Restart reconciliation marks ambiguity as interrupted;
 * it never auto-replays even read-only work, so a user must explicitly resume an interrupted job.
 */
export class PersistentBackgroundJobManager {
  private readonly jobs = new Map<string, PersistentBackgroundJob>();
  private readonly runtimes = new Map<string, RuntimeJob>();
  private readonly launching = new Set<string>();
  private readonly store: PersistentBackgroundJobStore;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly limits: Limits;
  private readonly onJobStarted?: (job: PersistentBackgroundJob) => RuntimeDiagnosticsRun | undefined;

  constructor(options: PersistentBackgroundJobManagerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.onJobStarted = options.onJobStarted;
    this.limits = {
      maxPromptCharacters: requiredPositiveInteger(options.maxPromptCharacters, DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_PROMPT_CHARS, "Persistent background job prompt limit"),
      maxTranscriptCharacters: requiredPositiveInteger(options.maxTranscriptCharacters, DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_TRANSCRIPT_CHARS, "Persistent background job transcript limit"),
      maxReportCharacters: requiredPositiveInteger(options.maxReportCharacters, DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_REPORT_CHARS, "Persistent background job report limit"),
      maxErrorCharacters: requiredPositiveInteger(options.maxErrorCharacters, DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_ERROR_CHARS, "Persistent background job error limit"),
      maxTurns: requiredPositiveInteger(options.maxTurns, DEFAULT_MAX_PERSISTENT_BACKGROUND_JOB_TURNS, "Persistent background job turn limit"),
      maxActiveJobs: requiredPositiveInteger(options.maxActiveJobs, DEFAULT_MAX_ACTIVE_PERSISTENT_BACKGROUND_JOBS, "Persistent active background job limit"),
      maxDurationMs: requiredPositiveInteger(options.maxDurationMs, DEFAULT_PERSISTENT_BACKGROUND_JOB_DURATION_MS, "Persistent background job duration limit"),
    };
  }

  async initialize(): Promise<{ loaded: number; reconciled: number }> {
    const loaded = await this.store.list();
    this.jobs.clear();
    for (const job of loaded) this.jobs.set(job.id, cloneJob(job));
    let reconciled = 0;
    for (const job of this.jobs.values()) {
      if (job.state !== "queued" && job.state !== "running") continue;
      if (await this.store.hasActiveClaim(job.id)) continue;
      const timestamp = this.now().toISOString();
      job.state = "interrupted";
      job.updatedAt = timestamp;
      job.completedAt = timestamp;
      job.error = boundedText(redactPersistentText("Job was interrupted by a prior process exit and was not automatically retried."), this.limits.maxErrorCharacters, "persistent job error");
      Object.assign(job, await this.store.save(job, job.revision));
      reconciled += 1;
    }
    return { loaded: this.jobs.size, reconciled };
  }

  private async transition(job: PersistentBackgroundJob, changes: Partial<PersistentBackgroundJob>): Promise<void> {
    const next = { ...job, ...changes, updatedAt: this.now().toISOString() };
    Object.assign(job, await this.store.save(next, job.revision));
  }

  private assertCapacity(): void {
    if (this.runtimes.size + this.launching.size >= this.limits.maxActiveJobs) {
      throw new Error(`Persistent background job concurrency limit reached (${this.limits.maxActiveJobs}).`);
    }
  }

  private async launch(job: PersistentBackgroundJob, options: ResumePersistentBackgroundJobOptions): Promise<void> {
    if (this.runtimes.has(job.id) || this.launching.has(job.id)) throw new Error("Persistent background job is already executing.");
    this.assertCapacity();
    this.launching.add(job.id);
    let releaseClaim: () => Promise<void>;
    try {
      releaseClaim = await this.store.claim(job.id);
    } catch (error) {
      this.launching.delete(job.id);
      throw error;
    }
    const controller = new AbortController();
    let timedOut = false;
    const durationTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.maxDurationMs);
    const cancellationPoller = setInterval(() => {
      void this.store.load(job.id).then((latest) => {
        if (latest?.state === "cancelled") controller.abort();
      }).catch(() => undefined);
    }, 50);
    const diagnostics = this.onJobStarted?.(cloneJob(job));
    const runtime: RuntimeJob = {
      controller,
      promise: Promise.resolve().then(async () => {
        if (controller.signal.aborted || job.state === "cancelled") return;
        await this.transition(job, {
          state: "running",
          startedAt: this.now().toISOString(),
          executionAttempts: job.executionAttempts + 1,
        });
        if (controller.signal.aborted) {
          const latest = await this.store.load(job.id);
          if (latest?.state === "cancelled") Object.assign(job, latest);
          return;
        }
        try {
          const result = await runAgent({
            task: job.prompt,
            model: options.createModel(),
            tools: readOnlyTaskTools(options.tools),
            workingDirectory: job.workingDirectory,
            projectContext: cloneSnapshot(options.projectContext),
            skills: cloneSnapshot(options.skills),
            memory: cloneSnapshot(options.memory),
            plan: cloneSnapshot(options.plan),
            maxTurns: this.limits.maxTurns,
            signal: controller.signal,
            diagnostics,
            onEvent: (event: AgentEvent) => {
              if (event.type === "message_delta" && !controller.signal.aborted) {
                job.transcript = boundedText(redactPersistentText(`${job.transcript}${event.text}`), this.limits.maxTranscriptCharacters, "persistent background transcript");
              }
            },
          });
          if (controller.signal.aborted) {
            if (timedOut && this.jobs.get(job.id)?.state !== "cancelled") await this.transition(job, {
              error: `Persistent background job exceeded its ${this.limits.maxDurationMs}ms duration limit.`,
              state: "failed",
              completedAt: this.now().toISOString(),
            });
            return;
          }
          await this.transition(job, {
            report: boundedText(redactPersistentText(result.finalText), this.limits.maxReportCharacters, "persistent background report"),
            state: "completed",
            completedAt: this.now().toISOString(),
          });
        } catch (error: unknown) {
          const latest = await this.store.load(job.id);
          if (latest?.state === "cancelled") {
            Object.assign(job, latest);
            controller.abort();
            return;
          }
          if (error instanceof AgentRunCancelledError || controller.signal.aborted) {
            if (timedOut && this.jobs.get(job.id)?.state !== "cancelled") await this.transition(job, {
              error: `Persistent background job exceeded its ${this.limits.maxDurationMs}ms duration limit.`,
              state: "failed",
              completedAt: this.now().toISOString(),
            });
            return;
          }
          await this.transition(job, {
            error: boundedText(redactPersistentText(error instanceof Error ? error.message : "Persistent background job failed."), this.limits.maxErrorCharacters, "persistent background error"),
            state: "failed",
            completedAt: this.now().toISOString(),
          });
        }
      }),
    };
    runtime.promise = runtime.promise.finally(async () => {
      this.runtimes.delete(job.id);
      this.launching.delete(job.id);
      clearTimeout(durationTimer);
      clearInterval(cancellationPoller);
      await releaseClaim();
    });
    this.runtimes.set(job.id, runtime);
    this.launching.delete(job.id);
  }

  async start(options: StartPersistentBackgroundJobOptions): Promise<PersistentBackgroundJob> {
    if (!isSafeUuid(options.sessionId)) throw new Error("Persistent background job session ID is invalid.");
    if (!validText(options.workingDirectory, 4_096)) throw new Error("Persistent background job workspace is invalid.");
    if (!validText(options.prompt, this.limits.maxPromptCharacters)) throw new Error(`Persistent background job prompt must be non-empty and no longer than ${this.limits.maxPromptCharacters} characters.`);
    if (redactPersistentText(options.prompt) !== options.prompt) throw new Error("Persistent background job prompt appears to contain a secret and was not saved.");
    this.assertCapacity();
    const id = this.createId();
    if (!isSafeUuid(id) || this.jobs.has(id)) throw new Error("Unable to create a unique persistent background job ID.");
    const timestamp = this.now().toISOString();
    const job: PersistentBackgroundJob = {
      version: 1,
      id,
      sessionId: options.sessionId,
      workingDirectory: options.workingDirectory,
      prompt: options.prompt,
      executionPolicy: "READ_ONLY_MANUAL_RESUME",
      provenance: "INTERACTIVE_COMMAND",
      state: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
      executionAttempts: 0,
      transcript: "",
    };
    Object.assign(job, await this.store.save(job));
    this.jobs.set(id, job);
    await this.launch(job, options);
    return cloneJob(job);
  }

  async resume(id: string, options: ResumePersistentBackgroundJobOptions, sessionId?: string): Promise<PersistentBackgroundJob> {
    const job = this.jobs.get(id);
    if (!job || (sessionId !== undefined && job.sessionId !== sessionId)) throw new Error("Persistent background job was not found.");
    if (job.state !== "interrupted") throw new Error("Persistent background job is not interrupted and cannot be resumed.");
    if (this.runtimes.has(id)) throw new Error("Persistent background job is already executing.");
    this.assertCapacity();
    const resumed: PersistentBackgroundJob = { ...job, state: "queued", updatedAt: this.now().toISOString() };
    delete resumed.completedAt;
    delete resumed.error;
    Object.assign(resumed, await this.store.save(resumed, job.revision));
    this.jobs.set(id, resumed);
    await this.launch(resumed, options);
    return cloneJob(resumed);
  }

  list(sessionId?: string): PersistentBackgroundJob[] {
    if (sessionId !== undefined && !isSafeUuid(sessionId)) return [];
    return [...this.jobs.values()].filter((job) => sessionId === undefined || job.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).map(cloneJob);
  }

  show(id: string, sessionId?: string): PersistentBackgroundJob | undefined {
    const job = isSafeUuid(id) ? this.jobs.get(id) : undefined;
    return job && (sessionId === undefined || job.sessionId === sessionId) ? cloneJob(job) : undefined;
  }

  async cancel(id: string, sessionId?: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || (sessionId !== undefined && job.sessionId !== sessionId)) return false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.store.load(id);
      if (!current) {
        if (attempt === 9) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (current.sessionId !== job.sessionId || TERMINAL_JOB_STATES.has(current.state)) return false;
      Object.assign(job, current);
      try {
        await this.transition(job, { state: "cancelled", completedAt: this.now().toISOString() });
        this.runtimes.get(id)?.controller.abort();
        return true;
      } catch {
        if (attempt === 9) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    return false;
  }

  async cancelForSession(sessionId: string): Promise<number> {
    if (!isSafeUuid(sessionId)) return 0;
    let cancelled = 0;
    for (const job of this.list(sessionId)) if (await this.cancel(job.id)) cancelled += 1;
    return cancelled;
  }

  async cleanup(options: { sessionId?: string; limit?: number } = {}): Promise<number> {
    const limit = requiredPositiveInteger(options.limit, DEFAULT_MAX_PERSISTENT_BACKGROUND_JOBS, "Persistent background job cleanup limit");
    let removed = 0;
    const terminal = this.list(options.sessionId).filter((job) => TERMINAL_JOB_STATES.has(job.state)).sort((left, right) => (left.completedAt ?? left.createdAt).localeCompare(right.completedAt ?? right.createdAt));
    for (const job of terminal) {
      if (removed >= limit) break;
      if (await this.store.delete(job.id)) {
        this.jobs.delete(job.id);
        removed += 1;
      }
    }
    return removed;
  }
}
