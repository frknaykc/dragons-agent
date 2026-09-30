import { realpath } from "node:fs/promises";

import type { AgentModel } from "../agent.js";
import { createReadOnlyCronRunner } from "../cron-runner.js";
import { CronScheduler } from "../cron-scheduler.js";
import { createFileCronTaskStore, cronWorkspaceDirectory } from "../cron-store.js";
import { readProjectSkill, readSkill } from "../skills.js";

export type DesktopCronCommand =
  | { action: "list" | "status" }
  | { action: "pause" | "resume" | "trigger" | "remove"; id: string }
  | { action: "add" | "once"; expression: string; prompt: string; skill?: { scope: "USER" | "PROJECT"; id: string } };

export type DesktopCronService = {
  command(command: DesktopCronCommand): Promise<string>;
  close(): Promise<void>;
};

/** Main-process-owned scheduler. No paths, model factories, or approvals originate from the renderer. */
export async function createDesktopCronService(options: {
  profileCronRoot: string;
  workingDirectory: string;
  skillsDirectory: string;
  createModel: () => AgentModel;
  now?: () => Date;
  intervalMs?: number;
}): Promise<DesktopCronService> {
  const workspace = await realpath(options.workingDirectory);
  let closed = false;
  let failures = 0;
  let lastReport: string | undefined;
  const recordFailure = (): void => { if (!closed) failures += 1; };
  const scheduler = new CronScheduler({
    store: createFileCronTaskStore(cronWorkspaceDirectory(options.profileCronRoot, workspace)),
    run: createReadOnlyCronRunner({ workingDirectory: workspace, skillsDirectory: options.skillsDirectory,
      createModel: options.createModel, onReport: (id, report) => { if (!closed) lastReport = `${id}: ${report.slice(0, 8_000)}`; } }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  scheduler.start(recordFailure, options.intervalMs);
  const initialTick = Promise.resolve().then(() => scheduler.tick(recordFailure)).catch(recordFailure);
  let closing: Promise<void> | undefined;
  return {
    async command(command) {
      if (closed) throw new Error("Desktop cron service is closed.");
      const { action } = command;
      if (action === "status") return `Cron: running in this workspace. Failures: ${failures}. Last report: ${lastReport ?? "none"}`;
      if (action === "list") {
        const tasks = await scheduler.list();
        return tasks.length ? tasks.map((task) => `${task.id} [${task.state}] ${task.nextRunAt ?? "-"} ${task.schedule.kind}`).join("\n") : "No cron tasks in this workspace.";
      }
      if (action === "add" || action === "once") {
        const selected = command.skill === undefined ? undefined : command.skill.scope === "PROJECT"
          ? await readProjectSkill(workspace, command.skill.id)
          : await readSkill(options.skillsDirectory, command.skill.id);
        if (closed) throw new Error("Desktop cron service is closed.");
        const schedule = action === "add" ? { kind: "cron" as const, expression: command.expression }
          : { kind: "once" as const, at: command.expression };
        const task = await scheduler.create({ workingDirectory: workspace, prompt: command.prompt, schedule,
          ...(selected === undefined ? {} : { skill: { id: selected.id, scope: selected.scope, digest: selected.digest } }) });
        return `Cron task created: ${task.id} (${task.nextRunAt})`;
      }
      if (!("id" in command)) throw new Error("Cron task ID is required.");
      const { id } = command;
      if (action === "trigger") return await scheduler.trigger(id) ? `Cron task triggered: ${id}` : "Cron task not found or finished.";
      if (action === "remove") return await scheduler.remove(id) ? `Cron task removed: ${id}` : "Cron task not found or running.";
      const changed = action === "pause" ? await scheduler.pause(id) : await scheduler.resume(id);
      return changed ? `Cron task ${changed.id}: ${changed.state}` : "Cron task not found or already in the requested state.";
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = Promise.resolve().then(async () => {
        try { await scheduler.stop(); } finally { await initialTick; }
      });
      return closing;
    },
  };
}
