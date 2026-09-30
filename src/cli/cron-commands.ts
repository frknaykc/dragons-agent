import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { AgentModel } from "../agent.js";
import { createReadOnlyCronRunner } from "../cron-runner.js";
import { CronScheduler } from "../cron-scheduler.js";
import { createFileCronTaskStore, cronWorkspaceDirectory } from "../cron-store.js";
import { readProjectSkill, readSkill } from "../skills.js";
import { cronStartup } from "./cron-startup.js";
import type { CliCommand } from "./commands.js";

type CronCommand = Extract<CliCommand, { kind: "cron" }>;

export type CronCommandOptions = {
  command: CronCommand;
  directory: string;
  workingDirectory: string;
  skillsDirectory: string;
  createModel: () => AgentModel;
  write: (text: string) => void;
  /** Optional host shutdown signal. Without it, foreground serve listens for SIGINT/SIGTERM. */
  signal?: AbortSignal;
  startup?: typeof cronStartup;
  profileName?: string;
};

function shutdownWait(signal: AbortSignal | undefined, onShutdown: () => void): { wait: Promise<void>; dispose: () => void } {
  let resolve!: () => void;
  const wait = new Promise<void>((done) => { resolve = done; });
  const stop = (): void => { onShutdown(); resolve(); };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    return { wait, dispose: () => signal.removeEventListener("abort", stop) };
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { wait, dispose: () => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); } };
}

/** Cron records are profile-owned but divided by canonical workspace, so a host never reserves another workspace's slots. */
export async function runCronCommand(options: CronCommandOptions): Promise<void> {
  const workspace = await realpath(options.workingDirectory);
  if (options.command.action === "startup") {
    const result = await (options.startup ?? cronStartup)({ operation: options.command.operation, workspace, profile: options.profileName ?? "default",
      executable: process.execPath, cliPath: fileURLToPath(new URL("../cli.js", import.meta.url)) });
    options.write(`${result}\n`);
    return;
  }
  const directory = cronWorkspaceDirectory(options.directory, workspace);
  const scheduler = new CronScheduler({
    store: createFileCronTaskStore(directory),
    run: createReadOnlyCronRunner({ workingDirectory: workspace, skillsDirectory: options.skillsDirectory,
      createModel: options.createModel, onReport: (id, report) => options.write(`${id}: ${report}\n`) }),
  });
  const { command, write } = options;
  if (command.action === "list") {
    for (const task of await scheduler.list()) write(`${task.id} ${task.state} ${task.nextRunAt ?? "-"} ${task.schedule.kind}\n`);
    return;
  }
  if (command.action === "add" || command.action === "once") {
    const skill = command.skill === undefined ? undefined : command.skill.scope === "PROJECT"
      ? await readProjectSkill(workspace, command.skill.id)
      : await readSkill(options.skillsDirectory, command.skill.id);
    const created = await scheduler.create({ workingDirectory: workspace, prompt: command.prompt,
      schedule: command.action === "once" ? { kind: "once", at: command.expression } : { kind: "cron", expression: command.expression },
      ...(skill === undefined ? {} : { skill: { id: skill.id, scope: skill.scope, digest: skill.digest } }) });
    write(`Cron task created: ${created.id} (${created.nextRunAt})\n`);
    return;
  }
  if (command.action === "pause" || command.action === "resume") {
    const changed = command.action === "pause" ? await scheduler.pause(command.id) : await scheduler.resume(command.id);
    if (!changed) throw new Error("Cron task not found or already in the requested state.");
    write(`Cron task ${changed.id}: ${changed.state}\n`);
    return;
  }
  if (command.action === "remove") {
    if (!await scheduler.remove(command.id)) throw new Error("Cron task not found or currently running.");
    write(`Cron task removed: ${command.id}\n`);
    return;
  }
  if (command.action === "trigger") {
    if (!await scheduler.trigger(command.id)) throw new Error("Cron task not found or already finished.");
    return;
  }
  if (command.action !== "serve") return;
  if (options.signal?.aborted) return;
  const reportFailure = (): void => write("Cron run failed; inspect provider and task configuration.\n");
  scheduler.start(reportFailure);
  const shutdown = shutdownWait(options.signal, () => { void scheduler.stop().catch(() => write("Cron shutdown did not finish within its deadline.\n")); });
  try {
    await scheduler.tick(reportFailure);
    await shutdown.wait;
  } finally {
    shutdown.dispose();
    await scheduler.stop();
  }
}
