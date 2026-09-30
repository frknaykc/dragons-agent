import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { CronStartupOptions } from "./cron-startup.js";

const exec = promisify(execFile);
const MARKER = "# Dragons Agent cron startup v1";

function unitArgument(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Cron startup paths cannot contain control characters.");
  // systemd parses quotes and backslash escapes, then expands % specifiers and $ variables in ExecStart.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%").replace(/\$/g, () => "$$")}"`;
}

function unitDirectory(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Cron startup paths cannot contain control characters.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}

/** Register a per-user systemd service for the next login; never start it during installation. */
export async function linuxCronStartup(options: CronStartupOptions): Promise<string> {
  const host = options.host ?? { platform: process.platform, home: homedir(), uid: process.getuid?.() ?? -1,
    control: (args: string[]) => exec("systemctl", args, { timeout: 10_000, maxBuffer: 4096 }) };
  if (host.platform !== "linux" || host.uid < 0) throw new Error("Linux cron login startup requires a systemd user session.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(options.profile)) throw new Error("Invalid cron startup profile.");
  if (![options.workspace, options.executable, options.cliPath, host.home].every(isAbsolute)) throw new Error("Cron startup requires absolute paths.");
  const name = `dragons-agent-cron-${createHash("sha256").update(options.profile).update("\0").update(options.workspace).digest("hex").slice(0, 32)}.service`;
  const directory = join(host.home, ".config", "systemd", "user");
  const path = join(directory, name);
  const content = `${MARKER}\n[Unit]\nDescription=Dragons Agent read-only cron service\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n[Service]\nType=simple\nWorkingDirectory=${unitDirectory(options.workspace)}\nExecStart=${unitArgument(options.executable)} ${unitArgument(options.cliPath)} cron serve --profile ${options.profile}\nRestart=on-failure\nRestartSec=30\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n`;
  async function owned(): Promise<boolean> {
    let entry;
    try { entry = await lstat(path); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 8192) throw new Error("Cron startup entry is not a safe regular file.");
    const text = await readFile(path, "utf8");
    if (!text.startsWith(`${MARKER}\n`) || !text.includes(`ExecStart=${unitArgument(options.executable)} ${unitArgument(options.cliPath)} cron serve --profile ${options.profile}\n`)) {
      throw new Error("Cron startup entry is not owned by Dragons Agent or has changed.");
    }
    return true;
  }
  if (options.operation === "status") {
    if (!await owned()) return "Cron login startup not installed.";
    let status: string;
    try { status = (await host.control(["--user", "is-enabled", name])).stdout.trim(); }
    catch (error: unknown) {
      if (typeof error !== "object" || error === null || !("stdout" in error) || typeof error.stdout !== "string" || error.stdout.trim() !== "disabled") throw error;
      status = "disabled";
    }
    return status === "enabled" ? "Cron login startup enabled (takes effect at next login)." : "Cron login startup unit exists but is not enabled.";
  }
  if (options.operation === "install") {
    if (await owned()) throw new Error("Cron login startup already registered; remove it before reinstalling.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Systemd user directory must be a real directory.");
    await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // If enable fails, keep the unit for inspection/recovery; never claim registration succeeded.
    await host.control(["--user", "enable", name]);
    return "Cron login startup enabled; sign out and back in to start the service.";
  }
  if (!await owned()) return "Cron login startup not installed.";
  // A failed disable/stop must not erase the unit, or an already-running service could outlive removal.
  await host.control(["--user", "disable", "--now", name]);
  await rm(path);
  await host.control(["--user", "daemon-reload"]);
  return "Cron login startup stopped and removed.";
}
