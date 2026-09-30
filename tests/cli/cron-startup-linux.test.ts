import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cronStartup } from "../../dist/cli/cron-startup.js";
import { linuxCronStartup } from "../../dist/cli/cron-startup-linux.js";

test("Linux cron startup installs a profile/workspace-scoped user unit without starting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-linux-"));
  const workspace = join(root, "work $HOME %i & notes");
  const calls: string[][] = [];
  try {
    await mkdir(workspace);
    const host = { platform: "linux" as const, home: root, uid: 1000, control: async (args: string[]) => {
      calls.push(args);
      return { stdout: "enabled\n" };
    } };
    const options = { workspace, profile: "review", executable: "/opt/node", cliPath: "/opt/app $HOME/dist/cli.js", host };
    assert.match(await cronStartup({ ...options, operation: "status" }), /not installed/);
    assert.match(await cronStartup({ ...options, operation: "install" }), /sign out/i);
    assert.deepEqual(calls, [["--user", "enable", (await readdir(join(root, ".config", "systemd", "user")))[0]!]]);
    const name = calls[0]![2]!;
    const unit = await readFile(join(root, ".config", "systemd", "user", name), "utf8");
    assert.match(unit, /^# Dragons Agent cron startup v1\n/);
    assert.match(unit, /WorkingDirectory=".*work \$HOME %%i & notes"/);
    assert.match(unit, /ExecStart="\/opt\/node" "\/opt\/app \$\$HOME\/dist\/cli.js" cron serve --profile review/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /WantedBy=default.target/);
    assert.match(await cronStartup({ ...options, operation: "status" }), /enabled/);
    assert.match(await cronStartup({ ...options, operation: "status", host: { ...host, control: async () => {
      throw Object.assign(new Error("disabled"), { stdout: "disabled\n" });
    } } }), /not enabled/);
    await assert.rejects(cronStartup({ ...options, operation: "install" }), /already registered/);
    assert.match(await cronStartup({ ...options, operation: "remove" }), /stopped and removed/);
    assert.deepEqual(calls.slice(-2), [["--user", "disable", "--now", name], ["--user", "daemon-reload"]]);
    assert.match(await cronStartup({ ...options, operation: "status" }), /not installed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux startup preserves registration when manager stop fails and refuses foreign or linked unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-linux-fail-"));
  const workspace = join(root, "work");
  try {
    await mkdir(workspace);
    const host = { platform: "linux" as const, home: root, uid: 1000,
      control: async (args: string[]) => {
        if (args.includes("disable")) throw new Error("systemd user manager unavailable");
        return { stdout: "enabled\n" };
      } };
    const options = { workspace, profile: "default", executable: "/opt/node", cliPath: "/opt/dist/cli.js", host };
    await assert.rejects(linuxCronStartup({ ...options, operation: "install", host: { ...host, platform: "win32" } }), /requires a systemd user session/);
    await linuxCronStartup({ ...options, operation: "install" });
    await assert.rejects(linuxCronStartup({ ...options, operation: "remove" }), /unavailable/);
    assert.match(await linuxCronStartup({ ...options, operation: "status" }), /enabled/);
    const directory = join(root, ".config", "systemd", "user");
    const entry = join(directory, (await readdir(directory))[0]!);
    await rm(entry);
    await symlink(workspace, entry);
    await assert.rejects(linuxCronStartup({ ...options, operation: "remove" }), /safe regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux startup rejects control-character paths and surfaces enable failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-linux-path-"));
  try {
    const host = { platform: "linux" as const, home: root, uid: 1000,
      control: async () => { throw new Error("enable failed"); } };
    const options = { profile: "default", workspace: "/work\nunsafe", executable: "/opt/node", cliPath: "/opt/dist/cli.js", host };
    await assert.rejects(linuxCronStartup({ ...options, operation: "install" }), /control characters/);
    await assert.rejects(linuxCronStartup({ ...options, operation: "install", workspace: root }), /enable failed/);
    assert.equal((await readdir(join(root, ".config", "systemd", "user"))).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
