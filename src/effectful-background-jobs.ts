import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import { AgentRunCancelledError, runAgent, type AgentModel, type ToolAuthorizationRequest } from "./agent.js";
import type { PersistentBackgroundJob, PersistentBackgroundJobStore } from "./persistent-background-jobs.js";
import type { AgentTool, ToolOperation } from "./tools.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFECT_OPERATIONS = new Set<ToolOperation>(["WRITE", "EXECUTE"]);
const EFFECTFUL_GRANT = Symbol("dragons.effectfulBackgroundGrant");

export type EffectfulBackgroundCall = { name: string; operation: "WRITE" | "EXECUTE"; arguments: string };
export type EffectfulBackgroundGrantOptions = {
  jobId: string;
  sessionId: string;
  workspace: string;
  calls: readonly EffectfulBackgroundCall[];
  expiresAt?: string;
};

type EffectfulBackgroundGrantRecord = EffectfulBackgroundGrantOptions & {
  readonly [EFFECTFUL_GRANT]: true;
  consumed: boolean;
};

/** Process-local capability. It has no JSON representation and cannot survive a restart. */
export type EffectfulBackgroundGrant = EffectfulBackgroundGrantRecord;

export type EffectfulBackgroundJob = {
  id: string;
  sessionId: string;
  workspace: string;
  prompt: string;
  state: "completed" | "failed" | "cancelled";
  error?: string;
};

export type EffectfulBackgroundJobManagerOptions = { createId?: () => string; now?: () => Date; maxTurns?: number; maxDurationMs?: number };
export type StartEffectfulBackgroundJobOptions = {
  sessionId: string;
  workspace: string;
  prompt: string;
  grant?: EffectfulBackgroundGrant;
  createModel: () => AgentModel;
  tools: readonly AgentTool[];
  signal?: AbortSignal;
};

function exactCallKey(call: EffectfulBackgroundCall): string {
  return JSON.stringify([call.operation, call.name, call.arguments]);
}

function requireUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new Error(`Effectful background ${name} is invalid.`);
}

function validGrantCall(call: EffectfulBackgroundCall): void {
  if (!call.name || !EFFECT_OPERATIONS.has(call.operation) || !call.arguments) throw new Error("Effectful background grant contains an invalid call.");
}

export function createEffectfulBackgroundGrant(options: EffectfulBackgroundGrantOptions): EffectfulBackgroundGrant {
  requireUuid(options.jobId, "job ID");
  requireUuid(options.sessionId, "session ID");
  if (!options.workspace || options.calls.length === 0) throw new Error("Effectful background grants require a workspace and at least one exact effect.");
  for (const call of options.calls) validGrantCall(call);
  if (options.expiresAt !== undefined && !Number.isFinite(Date.parse(options.expiresAt))) throw new Error("Effectful background grant expiration is invalid.");
  return { ...options, calls: options.calls.map((call) => ({ ...call })), consumed: false, [EFFECTFUL_GRANT]: true };
}

/**
 * Process-local exact-call executor for M61. It intentionally accepts neither a foreground
 * authorizer nor session approvals: each non-READ call must match an unexpired opaque grant.
 */
export function createEffectfulBackgroundJobManager(options: EffectfulBackgroundJobManagerOptions = {}) {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const maxTurns = options.maxTurns ?? 8;
  const maxDurationMs = options.maxDurationMs ?? 300_000;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 8) throw new Error("Effectful background turn limit must be an integer from 1 to 8.");
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 300_000) throw new Error("Effectful background duration limit must be an integer from 1 to 300000ms.");

  return {
    async start(input: StartEffectfulBackgroundJobOptions): Promise<EffectfulBackgroundJob> {
      requireUuid(input.sessionId, "session ID");
      if (!input.prompt.trim()) throw new Error("Effectful background prompt must be non-empty.");
      const grant = input.grant;
      if (!grant || grant[EFFECTFUL_GRANT] !== true) throw new Error("Effectful background work requires an explicit pre-authorized grant.");
      if (grant.consumed) throw new Error("Effectful background grant has already been consumed.");
      if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now().getTime()) throw new Error("Effectful background grant has expired.");
      const id = grant.jobId;
      requireUuid(id, "job ID");
      if (grant.sessionId !== input.sessionId) throw new Error("Effectful background grant does not match this job scope.");
      const [workspace, grantWorkspace] = await Promise.all([realpath(input.workspace), realpath(grant.workspace)]);
      if (workspace !== grantWorkspace) throw new Error("Effectful background grant does not match this workspace.");
      grant.consumed = true;
      const allowed = new Set(grant.calls.map(exactCallKey));
      const remaining = new Set(allowed);
      let denied = false;
      const controller = new AbortController();
      let timedOut = false;
      const abort = (): void => controller.abort();
      if (input.signal?.aborted) controller.abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      const durationTimer = setTimeout(() => { timedOut = true; controller.abort(); }, maxDurationMs);
      try {
        const result = await runAgent({
          task: input.prompt,
          model: input.createModel(),
          tools: [...input.tools],
          workingDirectory: workspace,
          maxTurns,
          signal: controller.signal,
          sessionApprovals: new Set(),
          authorize: (request: ToolAuthorizationRequest) => {
            if (request.operation === "READ") return true;
            const key = exactCallKey({ operation: request.operation as "WRITE" | "EXECUTE", name: request.name, arguments: request.arguments });
            const permitted = EFFECT_OPERATIONS.has(request.operation) && remaining.delete(key);
            if (!permitted) denied = true;
            return permitted;
          },
        });
        if (denied) return { id, sessionId: input.sessionId, workspace, prompt: input.prompt, state: "failed", error: "Effectful background call was not pre-authorized." };
        return { id, sessionId: input.sessionId, workspace, prompt: input.prompt, state: "completed" };
      } catch (error: unknown) {
        if (timedOut) return { id, sessionId: input.sessionId, workspace, prompt: input.prompt, state: "failed", error: `Effectful background job exceeded its ${maxDurationMs}ms duration limit.` };
        if (error instanceof AgentRunCancelledError || input.signal?.aborted) return { id, sessionId: input.sessionId, workspace, prompt: input.prompt, state: "cancelled" };
        return { id, sessionId: input.sessionId, workspace, prompt: input.prompt, state: "failed", error: error instanceof Error ? error.message : "Effectful background job failed." };
      } finally {
        clearTimeout(durationTimer);
        input.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export type PersistentEffectfulBackgroundJobManagerOptions = { store: PersistentBackgroundJobStore; createId?: () => string; now?: () => Date };
export type PreparePersistentEffectfulBackgroundJobOptions = { sessionId: string; workspace: string; prompt: string };
export type ResumePersistentEffectfulBackgroundJobOptions = Omit<StartEffectfulBackgroundJobOptions, "prompt" | "grant"> & { grant?: EffectfulBackgroundGrant };

/** Durable metadata with restart-safe reauthorization. The grant remains process-local. */
export function createPersistentEffectfulBackgroundJobManager(options: PersistentEffectfulBackgroundJobManagerOptions) {
  const jobs = new Map<string, PersistentBackgroundJob>();
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return {
    async initialize(): Promise<void> {
      jobs.clear();
      for (const loaded of await options.store.list()) {
        if (loaded.executionPolicy !== "EFFECTFUL_REAUTH_REQUIRED") continue;
        const job = { ...loaded };
        if ((job.state === "queued" || job.state === "running") && !await options.store.hasActiveClaim(job.id)) {
          const timestamp = now().toISOString();
          Object.assign(job, await options.store.save({ ...job, state: "interrupted", updatedAt: timestamp, completedAt: timestamp, error: "Effectful background work was interrupted and requires fresh authorization." }, job.revision));
        }
        jobs.set(job.id, job);
      }
    },
    async prepare(input: PreparePersistentEffectfulBackgroundJobOptions): Promise<PersistentBackgroundJob> {
      requireUuid(input.sessionId, "session ID");
      if (!input.prompt.trim()) throw new Error("Effectful background prompt must be non-empty.");
      const id = createId();
      requireUuid(id, "job ID");
      const workspace = await realpath(input.workspace);
      const timestamp = now().toISOString();
      const job: PersistentBackgroundJob = { version: 1, id, sessionId: input.sessionId, workingDirectory: workspace, prompt: input.prompt, executionPolicy: "EFFECTFUL_REAUTH_REQUIRED", provenance: "INTERACTIVE_COMMAND", state: "queued", createdAt: timestamp, updatedAt: timestamp, revision: 0, executionAttempts: 0, transcript: "" };
      Object.assign(job, await options.store.save(job));
      jobs.set(id, job);
      return { ...job };
    },
    show(id: string, sessionId?: string): PersistentBackgroundJob | undefined {
      const job = jobs.get(id);
      return job && (sessionId === undefined || job.sessionId === sessionId) ? { ...job } : undefined;
    },
    async cancel(id: string, sessionId?: string): Promise<boolean> {
      const job = jobs.get(id);
      if (!job || (sessionId !== undefined && job.sessionId !== sessionId) || job.executionPolicy !== "EFFECTFUL_REAUTH_REQUIRED" || job.state === "completed" || job.state === "failed" || job.state === "cancelled") return false;
      const latest = await options.store.load(id);
      if (!latest || latest.sessionId !== job.sessionId || latest.executionPolicy !== "EFFECTFUL_REAUTH_REQUIRED" || latest.state === "completed" || latest.state === "failed" || latest.state === "cancelled") return false;
      const timestamp = now().toISOString();
      Object.assign(job, await options.store.save({ ...latest, state: "cancelled", updatedAt: timestamp, completedAt: timestamp, error: "Effectful background job cancelled." }, latest.revision));
      return true;
    },
    async resume(id: string, input: ResumePersistentEffectfulBackgroundJobOptions): Promise<PersistentBackgroundJob> {
      const job = jobs.get(id);
      if (!job || job.sessionId !== input.sessionId || job.executionPolicy !== "EFFECTFUL_REAUTH_REQUIRED") throw new Error("Effectful background job was not found.");
      if (job.state !== "interrupted") throw new Error("Effectful background job is not interrupted.");
      if (!input.grant) throw new Error("Effectful background job requires a fresh explicit grant.");
      if (input.grant.jobId !== job.id || input.grant.sessionId !== job.sessionId) throw new Error("Effectful background grant does not match this job scope.");
      const workspace = await realpath(input.workspace);
      if (workspace !== job.workingDirectory) throw new Error("Effectful background workspace does not match the job scope.");
      const release = await options.store.claim(id);
      const controller = new AbortController();
      const cancellationPoller = setInterval(() => {
        void options.store.load(id).then((latest) => {
          if (latest?.state === "cancelled") controller.abort();
        }).catch(() => undefined);
      }, 50);
      try {
        const startedAt = now().toISOString();
        Object.assign(job, await options.store.save({ ...job, state: "running", updatedAt: startedAt, startedAt, completedAt: undefined, error: undefined, executionAttempts: job.executionAttempts + 1 }, job.revision));
        const result = await createEffectfulBackgroundJobManager({ now }).start({ ...input, workspace, prompt: job.prompt, grant: input.grant, signal: controller.signal });
        const latest = await options.store.load(id);
        if (latest?.state === "cancelled") {
          Object.assign(job, latest);
          return { ...job };
        }
        const completedAt = now().toISOString();
        Object.assign(job, await options.store.save({ ...job, state: result.state, updatedAt: completedAt, completedAt, error: result.error }, job.revision));
        return { ...job };
      } finally {
        clearInterval(cancellationPoller);
        await release();
      }
    },
  };
}
