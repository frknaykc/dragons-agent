import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { main } from "../../dist/cli.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { formatSlashHelp } from "../../dist/slash-commands.js";

test("slash help lists local controls and filters commands", () => {
  assert.match(formatSlashHelp(), /\/login/);
  assert.match(formatSlashHelp("login"), /\/login/);
  assert.doesNotMatch(formatSlashHelp("login"), /\/sessions/);
  assert.match(formatSlashHelp("not-a-command"), /No slash commands match/);
});

test("interactive auth slash commands are local", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-slash-auth-"));
  try {
    const output: string[] = [];
    const calls: string[] = [];
    await main(["--provider", "chatgpt"], {
      workingDirectory: workspace,
      configPath: join(workspace, "config.json"),
      sessionDirectory: join(workspace, "sessions"),
      input: Readable.from(["/login\n", "/auth\n", "/logout\n", "/exit\n"]),
      write: (text) => output.push(text),
      tools: [],
      chatgptAuth: {
        async login() { calls.push("login"); },
        async logout() { calls.push("logout"); },
        async status() { calls.push("status"); return { authenticated: false }; },
      },
      model: { async respond() { throw new Error("slash commands must not reach the model"); } },
    });
    assert.deepEqual(calls, ["login", "status", "logout"]);
    assert.match(output.join(""), /not signed in/);
    assert.match(output.join(""), /signed out/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("interactive profile commands select an isolated profile without reaching the model", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-slash-profile-"));
  try {
    const output: string[] = [];
    const configPath = join(workspace, "config.json");
    await main([], {
      workingDirectory: workspace,
      configPath,
      input: Readable.from(["/profile create work\n", "/profile select work\n"]),
      write: (text) => output.push(text),
      tools: [],
      model: { async respond() { throw new Error("slash commands must not reach the model"); } },
    });
    assert.equal(await createDragonsProfileStore({ configPath }).active(), "work");
    assert.match(output.join(""), /Profile created: work/);
    assert.match(output.join(""), /Active profile: work/);
    await main([], {
      workingDirectory: workspace,
      configPath,
      input: Readable.from(["/exit\n"]),
      write: () => {},
      tools: [],
      model: { async respond() { throw new Error("no model call expected"); } },
    });
    assert.equal((await lstat(join(workspace, "profiles", "work", "sessions"))).isDirectory(), true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
