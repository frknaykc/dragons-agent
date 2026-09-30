import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { promisify } from "node:util";

import type { CronStartupOptions } from "./cron-startup.js";

const exec = promisify(execFile);
const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function absoluteWindowsPath(value: string): boolean {
  return (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\") && win32.parse(value).root !== "\\")
    && win32.isAbsolute(value) && !/["%\u0000-\u001f\u007f]/.test(value);
}

function argument(value: string): string {
  // Quote for the Windows argv parser, not for cmd.exe; no shell is launched.
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/\\+$/g, (slashes) => slashes + slashes)}"`;
}

/** Opt-in HKCU Run entry: no admin rights, stored prompts, shell, or immediate execution. */
export async function windowsCronStartup(options: CronStartupOptions): Promise<string> {
  const host = options.host ?? { platform: process.platform,
    control: (args: string[]) => exec("powershell.exe", args, { timeout: 10_000, maxBuffer: 4096 }) };
  if (host.platform !== "win32") throw new Error("Windows cron login startup requires Windows.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(options.profile)) throw new Error("Invalid cron startup profile.");
  if (![options.workspace, options.executable, options.cliPath].every(absoluteWindowsPath)) throw new Error("Cron startup requires absolute Windows paths without quotes, percent expansion or control characters.");
  const name = `DragonsAgentCron_${createHash("sha256").update(options.profile).update("\0").update(options.workspace.toLowerCase()).digest("hex").slice(0, 32)}`;
  const command = `${argument(options.executable)} ${argument(options.cliPath)} cron serve --profile ${options.profile} --workspace ${argument(options.workspace)}`;
  // The HKCU Run command line has a documented 260-character limit.
  if (command.length > 260) throw new Error("Cron startup command exceeds the Windows Run key's 260-character limit.");
  const payload = Buffer.from(JSON.stringify({ name, command, operation: options.operation }), "utf8").toString("base64");
  const script = `$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${RUN_KEY}', $true)
if ($null -eq $k) { throw 'Windows user Run key is unavailable.' }
try {
  $v = $k.GetValue($p.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -ne $v -and ($k.GetValueKind($p.name) -ne [Microsoft.Win32.RegistryValueKind]::String -or $v -cne $p.command)) { throw 'Cron startup entry is foreign or changed.' }
  if ($p.operation -eq 'status') {
    if ($null -eq $v) { 'Cron login startup not installed.' } else { 'Cron login startup installed (takes effect at next login).' }
  } elseif ($p.operation -eq 'install') {
    if ($null -ne $v) { throw 'Cron login startup already installed; remove it before reinstalling.' }
    $k.SetValue($p.name, $p.command, [Microsoft.Win32.RegistryValueKind]::String)
    'Cron login startup installed; sign out and back in to start the service.'
  } elseif ($p.operation -eq 'remove') {
    if ($null -eq $v) { 'Cron login startup not installed.' } else {
      $k.DeleteValue($p.name)
      'Cron login startup removed; an already-running service must be stopped separately.'
    }
  } else { throw 'Invalid cron startup operation.' }
} finally { $k.Dispose() }
`;
  const result = await host.control(["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  return result.stdout.trim();
}
