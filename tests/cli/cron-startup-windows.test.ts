import assert from "node:assert/strict";
import test from "node:test";

import { cronStartup } from "../../dist/cli/cron-startup.js";
import { windowsCronStartup } from "../../dist/cli/cron-startup-windows.js";

type Payload = { name: string; command: string; operation: "install" | "remove" | "status" };

function registryHost() {
  const entries = new Map<string, string>();
  const calls: Payload[] = [];
  const host = { platform: "win32" as const, home: "C:\\Users\\owner", uid: -1,
    control: async (args: string[]) => {
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      const script = Buffer.from(args[3]!, "base64").toString("utf16le");
      assert.match(script, /Registry\]::CurrentUser\.OpenSubKey/);
      assert.match(script, /RegistryValueKind\]::String/);
      assert.match(script, /\$k\.DeleteValue\(\$p\.name\)/);
      const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      assert.ok(encoded);
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Payload;
      calls.push(payload);
      const current = entries.get(payload.name);
      if (current !== undefined && current !== payload.command) throw new Error("Cron startup entry is foreign or changed.");
      if (payload.operation === "status") return { stdout: current === undefined ? "Cron login startup not installed.\n" : "Cron login startup installed.\n" };
      if (payload.operation === "install") {
        if (current !== undefined) throw new Error("already installed");
        entries.set(payload.name, payload.command);
        return { stdout: "Cron login startup installed; sign out and back in.\n" };
      }
      if (current === undefined) return { stdout: "Cron login startup not installed.\n" };
      entries.delete(payload.name);
      return { stdout: "Cron login startup removed; an already-running service must be stopped separately.\n" };
    } };
  return { host, entries, calls };
}

test("Windows login startup is per-user, scoped, Unicode-safe and opt-in", async () => {
  const { host, entries, calls } = registryHost();
  const options = { host, workspace: "C:\\Users\\Aykaç\\work & notes", executable: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Program Files\\Dragons\\dist\\cli.js", profile: "review" };
  assert.match(await cronStartup({ ...options, operation: "status" }), /not installed/);
  assert.match(await cronStartup({ ...options, operation: "install" }), /sign out/);
  assert.equal(entries.size, 1);
  assert.match(calls[1]!.name, /^DragonsAgentCron_[a-f0-9]{32}$/);
  assert.equal(calls[1]!.command, `"${options.executable}" "${options.cliPath}" cron serve --profile review --workspace "${options.workspace}"`);
  assert.match(await cronStartup({ ...options, operation: "status" }), /installed/);
  await assert.rejects(cronStartup({ ...options, operation: "install" }), /already installed/);
  assert.match(await cronStartup({ ...options, operation: "remove" }), /already-running service must be stopped separately/);
  assert.equal(entries.size, 0);
  assert.match(await cronStartup({ ...options, operation: "remove" }), /not installed/);
});

test("Windows startup rejects unsafe paths, long Run values and changed registrations without deleting them", async () => {
  const { host, entries, calls } = registryHost();
  const options = { host, workspace: "C:\\work", executable: "C:\\node.exe", cliPath: "C:\\app\\cli.js", profile: "default" };
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", workspace: "\\work" }), /absolute Windows paths/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", executable: "node.exe" }), /absolute Windows paths/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", workspace: "C:\\evil\" quote" }), /without quotes/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", workspace: "C:\\%TEMP%\\work" }), /percent expansion/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", cliPath: "C:\\bad\npath" }), /control characters/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", workspace: `C:\\${"a".repeat(240)}` }), /260-character limit/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", profile: "../other" }), /Invalid cron startup profile/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "install", host: { ...host, platform: "linux" } }), /requires Windows/);
  assert.equal(calls.length, 0);
  await windowsCronStartup({ ...options, operation: "install" });
  const name = calls[0]!.name;
  entries.set(name, "foreign command");
  await assert.rejects(windowsCronStartup({ ...options, operation: "status" }), /foreign or changed/);
  await assert.rejects(windowsCronStartup({ ...options, operation: "remove" }), /foreign or changed/);
  assert.equal(entries.get(name), "foreign command");
});