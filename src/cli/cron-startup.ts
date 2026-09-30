import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { linuxCronStartup } from "./cron-startup-linux.js";
import { windowsCronStartup } from "./cron-startup-windows.js";

const exec = promisify(execFile);
const MARKER = "<!-- Dragons Agent cron startup v1 -->";

function xml(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Cron startup paths cannot contain control characters.");
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export type CronStartupOptions = {
  operation: "install" | "remove" | "status";
  workspace: string;
  executable: string;
  cliPath: string;
  profile: string;
  /** Test-only host overrides; never read from the renderer or model. */
  host?: { platform: NodeJS.Platform; home: string; uid: number; control: (args: string[]) => Promise<{ stdout: string }> };
};

export async function cronStartup(options: CronStartupOptions): Promise<string> {
  const platform = options.host?.platform ?? process.platform;
  if (platform === "darwin") return macCronStartup(options);
  if (platform === "linux") return linuxCronStartup(options);
  if (platform === "win32") return windowsCronStartup(options);
  throw new Error("Cron login startup is supported only on macOS, Linux with systemd user services, or Windows.");
}

/** Opt-in login startup; no shell, elevated daemon or automatic execution at install time. */
export async function macCronStartup(options: CronStartupOptions): Promise<string> {
  const host = options.host ?? { platform: process.platform, home: homedir(), uid: process.getuid?.() ?? -1,
    control: (args: string[]) => exec("launchctl", args, { timeout: 10_000, maxBuffer: 4096 }) };
  if (host.platform !== "darwin" || host.uid < 0) throw new Error("Cron login startup is currently supported only on macOS.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(options.profile)) throw new Error("Invalid cron startup profile.");
  if (![options.workspace, options.executable, options.cliPath, host.home].every(isAbsolute)) throw new Error("Cron startup requires absolute paths.");
  const label = `com.dragons-agent.cron.${createHash("sha256").update(options.profile).update("\0").update(options.workspace).digest("hex").slice(0, 32)}`;
  const directory = join(host.home, "Library", "LaunchAgents");
  const path = join(directory, `${label}.plist`);
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n${MARKER}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${xml(options.executable)}</string><string>${xml(options.cliPath)}</string><string>cron</string><string>serve</string><string>--profile</string><string>${xml(options.profile)}</string></array>\n<key>WorkingDirectory</key><string>${xml(options.workspace)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n`;
  async function owned(): Promise<boolean> {
    let entry;
    try { entry = await lstat(path); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 8192) throw new Error("Cron startup entry is not a safe regular file.");
    const text = await readFile(path, "utf8");
    if (!text.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n${MARKER}\n`) || !text.includes(`<string>${label}</string>`)) throw new Error("Cron startup entry is not owned by Dragons Agent.");
    return true;
  }
  if (options.operation === "status") return await owned() ? "Cron login startup installed (takes effect at next login)." : "Cron login startup not installed.";
  if (options.operation === "install") {
    if (await owned()) throw new Error("Cron login startup already installed; remove it before reinstalling.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("LaunchAgents directory must be a real directory.");
    await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return "Cron login startup installed; sign out and back in to start the service.";
  }
  if (!await owned()) return "Cron login startup not installed.";
  // bootout is required before removing a loaded agent, otherwise it keeps running until logout.
  try { await host.control(["print", `gui/${host.uid}/${label}`]); }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" && /Could not find service|service not found/i.test(error.stderr)) {
      await rm(path);
      return "Cron login startup removed.";
    }
    throw error;
  }
  await host.control(["bootout", `gui/${host.uid}/${label}`]);
  await rm(path);
  return "Cron login startup stopped and removed.";
}
