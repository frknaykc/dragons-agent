import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { isSafeProfileName } from "./profiles.js";

export type LaunchKanbanWorkerOptions = {
  /** Host-owned paths and actor only; task text and provider credentials never enter argv. */
  workingDirectory: string;
  configPath: string;
  profile: string;
  id: string;
  revision: number;
  signal?: AbortSignal;
  maxRunMs?: number;
};

/** Explicit, one-shot child launch. A failed/terminated claim is left for inspected recovery, never replayed. */
export async function launchKanbanWorker(options: LaunchKanbanWorkerOptions): Promise<void> {
  const maxRunMs = options.maxRunMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 3_600_000
    || !isSafeProfileName(options.profile) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.id)
    || !Number.isSafeInteger(options.revision) || options.revision < 0 || !isAbsolute(options.configPath)
    || !isAbsolute(options.workingDirectory)) throw new Error("Invalid Kanban worker launch.");
  if (options.signal?.aborted) throw new Error("Kanban worker launch cancelled.");
  const root = await realpath(options.workingDirectory);
  if (root !== options.workingDirectory) throw new Error("Kanban worker requires a canonical workspace.");
  if (options.signal?.aborted) throw new Error("Kanban worker launch cancelled.");
  const script = fileURLToPath(new URL("./kanban-worker-entry.js", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    // Do not inherit provider keys, Node flags or an interactive stdio channel. Windows needs SystemRoot to resolve system DLLs.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    // Electron's packaged executable needs to behave as Node for this fixed child entry.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    const child = spawn(process.execPath, [script, root, options.configPath, options.profile,
      options.id, String(options.revision), String(maxRunMs)], { stdio: "ignore", env, windowsHide: true });
    let stopping = false;
    let escalation: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    // Child has its own deadline; the parent forcibly bounds an uncooperative model.
    const timeout = setTimeout(stop, maxRunMs + 2_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", () => finish(new Error("Kanban worker process failed to start.")));
    child.once("close", (code) => finish(code === 0 && !stopping ? undefined : new Error("Kanban worker process failed or was cancelled; inspect the task before recovery.")));
  });
}
