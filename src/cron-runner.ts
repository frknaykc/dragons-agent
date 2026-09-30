import { realpath } from "node:fs/promises";

import { runAgent, type AgentModel } from "./agent.js";
import { type CronSchedulerOptions, validateCronTask } from "./cron-scheduler.js";
import { createSkillsContext } from "./skills.js";
import { createReadTools } from "./tools.js";

export type ReadOnlyCronRunnerOptions = {
  /** One trusted workspace per runner; persisted task text cannot redirect access to another workspace. */
  workingDirectory: string;
  /** Resolved by the trusted host for each run; provider credentials are never persisted in cron records. */
  createModel: () => AgentModel;
  /** Trusted user-skill root, required for USER bindings. PROJECT bindings use the workspace. */
  skillsDirectory?: string;
  /** Optional, process-local observer; callers must treat report text as sensitive. */
  onReport?: (id: string, text: string) => void;
  /** Per-run cancellation deadline; cooperative models must honor the forwarded signal. */
  maxRunMs?: number;
};

/** Uses only built-in workspace-bounded READ tools. A skill ID cannot silently become an unpinned skill binding. */
export function createReadOnlyCronRunner(options: ReadOnlyCronRunnerOptions): CronSchedulerOptions["run"] {
  const maxRunMs = options.maxRunMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 3_600_000) throw new Error("Invalid cron run deadline.");
  return async (task, signal) => {
    validateCronTask(task);
    if (signal.aborted) return;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), maxRunMs);
    const runSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      if (task.skillId !== undefined) throw new Error("Unpinned cron skill binding; refusing to ignore the saved skill ID.");
      const root = await realpath(options.workingDirectory);
      if (await realpath(task.workingDirectory) !== root) throw new Error("Cron task workspace does not match the trusted runner workspace.");
      if (task.skill?.scope === "USER" && !options.skillsDirectory) throw new Error("Cron user skill directory is required.");
      const skills = task.skill === undefined ? undefined : await createSkillsContext(options.skillsDirectory ?? "", [{ ...task.skill, order: 1 }], root);
      if (task.skill && (skills?.skills.length !== 1 || skills.skills[0]?.digest !== task.skill.digest || skills.skills[0]?.scope !== task.skill.scope))
        throw new Error("Cron pinned skill is missing, changed or invalid; refusing to run.");
      runSignal.throwIfAborted();
      const tools = await createReadTools(root);
      runSignal.throwIfAborted();
      const result = await runAgent({
        task: task.prompt,
        model: options.createModel(),
        tools,
        ...(skills === undefined ? {} : { skills }),
        programmaticTools: false,
        inlineContextReferences: false,
        workingDirectory: root,
        maxTurns: 8,
        maxToolCalls: 16,
        signal: runSignal,
      });
      runSignal.throwIfAborted();
      options.onReport?.(task.id, result.finalText);
    } catch (error: unknown) {
      if (deadline.signal.aborted && !signal.aborted) throw new Error("Cron run timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
