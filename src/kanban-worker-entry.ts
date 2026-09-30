import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "./agent.js";
import { loadDragonsConfig } from "./config.js";
import { createFileKanbanBoard, kanbanWorkspaceDirectory } from "./kanban.js";
import { runKanbanWorker } from "./kanban-worker.js";
import { createLocalAgentModel } from "./provider/local.js";
import { createDragonsProfileStore, isSafeProfileName } from "./profiles.js";
import { createReadTools } from "./tools.js";

/** Fixed child entry: no executable, provider secret, prompt or permission arrives from board/argv. */
export async function runKanbanWorkerEntry(args: string[], signal: AbortSignal): Promise<void> {
  if (args.length !== 6) throw new Error("Invalid Kanban worker arguments.");
  const [workspace, configPath, profile, id, revisionText, maxRunText] = args as [string, string, string, string, string, string];
  if (!isAbsolute(workspace) || !isAbsolute(configPath) || !isSafeProfileName(profile)
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    || !/^(?:0|[1-9][0-9]*)$/.test(revisionText) || !/^[1-9][0-9]*$/.test(maxRunText))
    throw new Error("Invalid Kanban worker arguments.");
  const revision = Number(revisionText);
  const maxRunMs = Number(maxRunText);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(maxRunMs) || maxRunMs > 3_600_000)
    throw new Error("Invalid Kanban worker arguments.");
  if (await realpath(workspace) !== workspace) throw new Error("Kanban worker requires a canonical workspace.");
  const profiles = createDragonsProfileStore({ configPath });
  if (!(await profiles.list()).includes(profile)) throw new Error("Kanban worker profile not found.");
  const config = await loadDragonsConfig(profiles.paths(profile).configPath);
  // The first process slice supports only credential-free Local. Other providers need an explicit host-owned credential composer.
  if (config.provider !== "local") throw new Error("Kanban worker requires an explicitly configured Local provider.");
  const board = createFileKanbanBoard(kanbanWorkspaceDirectory(configPath, workspace), profiles);
  await runKanbanWorker({ board, actor: profile, id, revision, signal, maxRunMs, run: async (task, runSignal) => {
    const tools = await createReadTools(workspace);
    runSignal.throwIfAborted();
    await runAgent({ task: task.title, model: createLocalAgentModel({
      ...(config.localEndpoint === undefined ? {} : { baseUrl: config.localEndpoint }),
      model: config.models?.local ?? config.model,
    }), tools, workingDirectory: workspace, signal: runSignal, maxTurns: 8, maxToolCalls: 16,
    programmaticTools: false, inlineContextReferences: false });
  } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stopped = new AbortController();
  process.once("SIGTERM", () => stopped.abort());
  process.once("SIGINT", () => stopped.abort());
  void runKanbanWorkerEntry(process.argv.slice(2), stopped.signal).catch(() => {
    // No reports, credentials, prompts or exception messages flow through stdio or persistent state.
    process.exitCode = 1;
  });
}
