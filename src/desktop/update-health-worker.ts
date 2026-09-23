import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HEALTH_PROBE_ARGUMENT, healthProbeEnvironment } from "./update-health.js";

const HEALTH_OK = "DRAGONS_UPDATE_HEALTH_OK";
const MAX_HEALTH_OUTPUT_BYTES = 1024;
const TERMINATION_GRACE_MILLISECONDS = 250;

export interface IsolatedHealthProbeOptions {
  executable: string;
  arguments?: readonly string[];
  root: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
  signal?: AbortSignal;
}

function failed(): never { throw new Error("Update health probe failed."); }

/**
 * Starts an already-verified candidate only in its explicit, profile-free health mode.
 * This is not an OS sandbox: the candidate remains trusted signed application code.
 * The direct child's exit is a cleanup barrier. If the OS cannot terminate it even
 * after SIGKILL, remain pending rather than deleting its profile or permitting rollback.
 * Descendant-process containment requires a platform sandbox/job and is not provided here.
 */
export async function runIsolatedHealthProbe(options: IsolatedHealthProbeOptions, dependencies: { spawn?: typeof spawn } = {}): Promise<void> {
  if (!Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1 || options.timeoutMilliseconds > 60_000 || options.signal?.aborted) failed();
  const root = resolve(options.root);
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) failed();
  const home = await mkdtemp(join(tmpdir(), "dragons-update-health-"));
  try {
    if (options.signal?.aborted) failed();
    await new Promise<void>((resolveProbe, rejectProbe) => {
      let settled = false;
      let stopping = false;
      let exited = false;
      let output = "";
      let outputBytes = 0;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let child: ReturnType<typeof spawn>;
      try {
        child = (dependencies.spawn ?? spawn)(options.executable, [...(options.arguments ?? []), HEALTH_PROBE_ARGUMENT], {
          cwd: home,
          env: healthProbeEnvironment(options.sourceEnvironment, home),
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch { failed(); }
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(escalation);
        options.signal?.removeEventListener("abort", stop);
        if (error) rejectProbe(error); else resolveProbe();
      };
      const signalChild = (signal: NodeJS.Signals) => {
        // kill() acceptance (or an error) is not evidence of process death.
        try { child.kill(signal); } catch { /* still await exit and escalate */ }
      };
      const stop = () => {
        if (settled || stopping) return;
        stopping = true;
        if (exited) { finish(new Error("Update health probe failed.")); return; }
        escalation = setTimeout(() => {
          if (!settled && !exited) signalChild("SIGKILL");
        }, TERMINATION_GRACE_MILLISECONDS);
        signalChild("SIGTERM");
      };
      const timeout = setTimeout(stop, options.timeoutMilliseconds);
      child.stdout!.on("data", (chunk: Buffer) => {
        if (stopping || settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_HEALTH_OUTPUT_BYTES) { stop(); return; }
        output += chunk.toString("utf8");
      });
      child.stdout!.on("error", stop);
      child.on("error", () => {
        // A failed spawn has no process to reap; post-spawn errors do not prove exit.
        if (child.pid === undefined) finish(new Error("Update health probe failed."));
        else stop();
      });
      child.once("exit", (code, signal) => {
        exited = true;
        clearTimeout(escalation);
        if (stopping || code !== 0 || signal !== null) finish(new Error("Update health probe failed."));
      });
      child.once("close", (code, signal) => {
        // close follows exit (or spawn failure) and drains stdout before success.
        exited = true;
        if (stopping || code !== 0 || signal !== null || output.trim() !== HEALTH_OK) finish(new Error("Update health probe failed."));
        else finish();
      });
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
