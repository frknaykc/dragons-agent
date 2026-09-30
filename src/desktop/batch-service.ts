import { dirname, join } from "node:path";

import { batchWorkspaceDirectory, createFileBatchQueue, inspectBatchLock, recoverAbandonedBatchLock } from "../batch-queue.js";
import { runBatch } from "../batch-runner.js";
import type { InteractiveBatchCommand } from "../cli/batch-commands.js";
import type { ProviderRegistry } from "../provider/registry.js";
import { createCodingTools, type AgentTool } from "../tools.js";

export type DesktopBatchCommand =
  | { action: "request"; sessionId: string; provider: string; model: string; request: InteractiveBatchCommand }
  | { action: "confirm"; sessionId: string; provider: string; model: string }
  | { action: "recover_confirm"; sessionId: string; provider: string; model: string }
  | { action: "lock_status"; sessionId: string; provider: string; model: string }
  | { action: "lock_recover"; sessionId: string; provider: string; model: string }
  | { action: "lock_confirm"; sessionId: string; provider: string; model: string };

/** Host-owned, profile/workspace-bound queue. Confirmation never survives a session or selection change. */
export function createDesktopBatchService(options: {
  providers: ProviderRegistry;
  configPath: string;
  workingDirectory: string;
  /** Trusted test-host override only; production creates a fresh built-in tool set. */
  tools?: AgentTool[];
}) {
  const directory = batchWorkspaceDirectory(join(dirname(options.configPath), "batches"), options.workingDirectory);
  const queue = createFileBatchQueue(directory, options.workingDirectory);
  let closed = false;
  let active: AbortController | undefined;
  let pending: { sessionId: string; provider: string; model: string; id: string; revision: number; expiresAt: number } | undefined;
  let pendingLock: { sessionId: string; provider: string; model: string; token: string; expiresAt: number } | undefined;
  let pendingRecovery: { sessionId: string; provider: string; model: string; id: string; taskId: string;
    revision: number; token: string; expiresAt: number } | undefined;
  const inFlight = new Set<Promise<string>>();

  async function perform(command: DesktopBatchCommand): Promise<string> {
    if (active) throw new Error("Batch already running.");
    if (command.action === "lock_status" || command.action === "lock_recover") {
      pending = undefined;
      pendingLock = undefined;
      pendingRecovery = undefined;
      const lock = await inspectBatchLock(directory);
      if (closed) throw new Error("Desktop batch is closed.");
      if (!lock) return "No batch lock for this profile and workspace.";
      const owner = `Batch lock owner: PID ${lock.pid} on ${JSON.stringify(lock.host)}.`;
      if (command.action === "lock_status") return `${owner} No recovery attempted.`;
      pendingLock = { sessionId: command.sessionId, provider: command.provider, model: command.model,
        token: lock.token, expiresAt: Date.now() + 60_000 };
      return `${owner} Only recover if this process has stopped. Type /batch lock confirm RECOVER within 60 seconds to confirm.`;
    }
    if (command.action === "lock_confirm") {
      const candidate = pendingLock;
      pendingLock = undefined;
      pendingRecovery = undefined;
      if (!candidate || candidate.sessionId !== command.sessionId || Date.now() > candidate.expiresAt)
        return "Batch lock recovery not pending; run /batch lock recover first.";
      if (candidate.provider !== command.provider || candidate.model !== command.model)
        throw new Error("Batch selection changed; inspect the lock again.");
      return await recoverAbandonedBatchLock(directory, candidate.token)
        ? "Abandoned batch lock removed; no task was started or retried." : "No batch lock for this profile and workspace.";
    }
    pendingLock = undefined;
    if (command.action === "recover_confirm") {
      const candidate = pendingRecovery;
      pendingRecovery = undefined;
      pending = undefined;
      if (!candidate || candidate.sessionId !== command.sessionId || Date.now() > candidate.expiresAt)
        return "Batch recovery not pending; run /batch recover first.";
      if (candidate.provider !== command.provider || candidate.model !== command.model)
        throw new Error("Batch selection changed; inspect reservation again.");
      if (closed) throw new Error("Desktop batch is closed.");
      const done = await queue.recover(candidate.id, candidate.taskId, candidate.revision, candidate.token);
      return `Batch ${done.id} revision ${done.revision}: task marked interrupted; no task was started or retried.`;
    }
    pendingRecovery = undefined;
    if (command.action === "confirm") {
      const selection = pending;
      pending = undefined;
      if (!selection || selection.sessionId !== command.sessionId || Date.now() > selection.expiresAt)
        return "Batch confirmation not pending; run /batch run first.";
      if (selection.provider !== command.provider || selection.model !== command.model)
        throw new Error("Batch provider or model changed; inspect and select again.");
      const batch = await queue.load(selection.id);
      if (!batch || batch.revision !== selection.revision || batch.tasks.some((task) => task.state !== "queued" && task.state !== "completed") || batch.runsUsed >= batch.maxRuns)
        throw new Error("Batch changed; inspect status before running.");
      if (closed) throw new Error("Desktop batch is closed.");
      const controller = new AbortController();
      active = controller;
      try {
        const tools = options.tools ?? await createCodingTools(options.workingDirectory);
        controller.signal.throwIfAborted();
        const done = await runBatch({ queue, id: batch.id, revision: batch.revision, tools,
          createModel: () => options.providers.createModel(selection.provider, { model: selection.model }), signal: controller.signal });
        if (closed || controller.signal.aborted) throw new Error("Desktop batch is closed.");
        return `Batch ${done.id} checkpointed at revision ${done.revision}: ${done.tasks.map((task) => task.state).join(", ")}.`;
      } finally { if (active === controller) active = undefined; }
    }
    pending = undefined;
    const request = command.request;
    if (request.action === "add") {
      const batch = await queue.create(request.prompts, request.maxRuns);
      return `Batch ${batch.id} created (revision ${batch.revision}, ${batch.tasks.length} tasks, ${batch.maxRuns} runs).`;
    }
    if (request.action === "list") {
      const batches = await queue.list();
      return batches.length ? batches.map((batch) => `${batch.id} revision ${batch.revision}: ${batch.runsUsed}/${batch.maxRuns} runs, ${batch.tasks.map((task) => task.state).join(", ")}`).join("\n")
        : "No batches for this profile and workspace.";
    }
    const batch = await queue.load(request.id);
    if (!batch) return "Batch not found for this profile and workspace.";
    if (request.action === "status") return `Batch ${batch.id} revision ${batch.revision}: ${batch.runsUsed}/${batch.maxRuns} runs.\n${batch.tasks.map((task) => `${task.id}: ${task.state}${task.state === "running" ? task.owner
      ? ` (PID ${task.owner.pid} on ${JSON.stringify(task.owner.host)})` : " (legacy owner unknown; cannot recover safely)" : ""}`).join("\n")}`;
    if (request.action === "recover") {
      if (batch.revision !== request.revision) return "Batch revision changed; inspect current status before recovery.";
      const running = batch.tasks.find((task) => task.state === "running");
      if (!running?.owner) return "No verifiable running batch reservation; no recovery attempted.";
      if (closed) throw new Error("Desktop batch is closed.");
      pendingRecovery = { sessionId: command.sessionId, provider: command.provider, model: command.model,
        id: batch.id, taskId: running.id, revision: batch.revision, token: running.owner.token, expiresAt: Date.now() + 60_000 };
      return `Batch ${batch.id} revision ${batch.revision}: task ${running.id} owned by PID ${running.owner.pid} on ${JSON.stringify(running.owner.host)}. Only mark interrupted if this process has stopped. Type /batch confirm RECOVER within 60 seconds to confirm.`;
    }
    if (batch.revision !== request.revision) return "Batch revision changed; inspect current status before running.";
    if (batch.tasks.some((task) => task.state !== "queued" && task.state !== "completed") || batch.runsUsed >= batch.maxRuns)
      return "Batch cannot run: inspect task states and budget first.";
    if (!options.providers.ids().includes(command.provider)) throw new Error("Unknown batch provider.");
    if (closed) throw new Error("Desktop batch is closed.");
    pending = { sessionId: command.sessionId, provider: command.provider, model: command.model,
      id: batch.id, revision: batch.revision, expiresAt: Date.now() + 60_000 };
    return `Batch ${batch.id} revision ${batch.revision}: up to ${batch.maxRuns - batch.runsUsed} new READ-only runs on ${command.provider}:${command.model} in ${options.workingDirectory}. Type /batch confirm RUN within 60 seconds to confirm.`;
  }

  return {
    command(input: DesktopBatchCommand): Promise<string> {
      if (closed) return Promise.reject(new Error("Desktop batch is closed."));
      const task = perform(input);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task), () => inFlight.delete(task));
      return task;
    },
    async close(): Promise<void> {
      closed = true;
      pending = undefined;
      pendingLock = undefined;
      pendingRecovery = undefined;
      active?.abort();
      await Promise.allSettled([...inFlight]);
    },
  };
}
