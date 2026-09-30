import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { macCronStartup } from "../../dist/cli/cron-startup.js";
import { parseCliCommand } from "../../dist/cli.js";
import { runCronCommand } from "../../dist/cli/cron-commands.js";

test("cron startup CLI requires explicit operation and refuses extra arguments", () => {
  assert.deepEqual(parseCliCommand(["cron", "startup", "install"]), { kind: "cron", action: "startup", operation: "install" });
  assert.deepEqual(parseCliCommand(["cron", "serve", "--profile", "review"]), { kind: "cron", action: "serve", profile: "review" });
  assert.deepEqual(parseCliCommand(["cron", "serve", "--profile", "review", "--workspace", "/project"]), { kind: "cron", action: "serve", profile: "review", workspace: "/project" });
  for (const args of [["cron", "startup"], ["cron", "startup", "install", "extra"], ["cron", "startup", "enable"], ["cron", "serve", "--profile", "../other"],
    ["cron", "serve", "--profile", "review", "--workspace", "relative"], ["cron", "serve", "--workspace", "/project"]]) {
    assert.throws(() => parseCliCommand(args), /Use dragons cron/);
  }
});

test("macOS login startup is opt-in, escapes paths, and stops a loaded agent on removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-startup-"));
  const workspace = join(root, "work & <project>");
  const calls: string[][] = [];
  try {
    await mkdir(workspace);
    const host = { platform: "darwin" as const, home: root, uid: 501, control: async (args: string[]) => {
      calls.push(args);
      return { stdout: "service found" };
    } };
    const args = { workspace, profile: "review", executable: "/usr/local/bin/node", cliPath: "/app/dist/cli.js", host };
    assert.match(await macCronStartup({ ...args, operation: "status" }), /not installed/);
    assert.match(await macCronStartup({ ...args, operation: "install" }), /sign out/i);
    const directory = join(root, "Library", "LaunchAgents");
    const entries = await readdir(directory);
    assert.equal(entries.length, 1);
    const plist = await readFile(join(directory, entries[0]!), "utf8");
    if (process.platform === "darwin") assert.match(execFileSync("plutil", ["-lint", join(directory, entries[0]!)], { encoding: "utf8" }), /OK/);
    assert.match(plist, /work &amp; &lt;project&gt;/);
    assert.match(plist, /<string>cron<\/string><string>serve<\/string><string>--profile<\/string><string>review<\/string>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.deepEqual(calls, []);
    assert.match(await macCronStartup({ ...args, operation: "status" }), /installed/);
    await assert.rejects(macCronStartup({ ...args, operation: "install" }), /already installed/);
    assert.match(await macCronStartup({ ...args, operation: "remove" }), /stopped and removed/);
    assert.equal(calls[0]?.[0], "print");
    assert.equal(calls[1]?.[0], "bootout");
    assert.match(await macCronStartup({ ...args, operation: "status" }), /not installed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cron startup refuses foreign entries and non-macOS platforms; failed bootout preserves registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-startup-fail-"));
  const workspace = join(root, "work");
  try {
    await mkdir(workspace);
    const host = { platform: "darwin" as const, home: root, uid: 501,
      control: async (args: string[]): Promise<{ stdout: string }> => {
        if (args[0] === "bootout") throw new Error("permission denied");
        return { stdout: "loaded" };
      } };
    const args = { workspace, profile: "default", executable: "/usr/local/bin/node", cliPath: "/app/dist/cli.js", host };
    await assert.rejects(macCronStartup({ ...args, operation: "install", host: { ...host, platform: "linux" } }), /only on macOS/);
    await macCronStartup({ ...args, operation: "install" });
    await assert.rejects(macCronStartup({ ...args, operation: "remove" }), /permission denied/);
    assert.match(await macCronStartup({ ...args, operation: "status" }), /installed/);
    const directory = join(root, "Library", "LaunchAgents");
    const entry = join(directory, (await readdir(directory))[0]!);
    await rm(entry);
    await symlink(workspace, entry);
    await assert.rejects(macCronStartup({ ...args, operation: "remove" }), /safe regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cron startup command canonicalizes workspace without creating a scheduler", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cron-startup-cli-"));
  const workspace = join(root, "work");
  const output: string[] = [];
  try {
    await mkdir(workspace);
    await runCronCommand({ command: { kind: "cron", action: "startup", operation: "status" }, directory: join(root, "cron"),
      workingDirectory: workspace, skillsDirectory: join(root, "skills"), createModel: () => { throw new Error("must not create model"); },
      startup: async (options) => {
        assert.equal(options.workspace, await realpath(workspace));
        assert.equal(options.profile, "default");
        assert.equal(options.operation, "status");
        return "not installed";
      }, write: (message) => output.push(message) });
    assert.deepEqual(output, ["not installed\n"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
