import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pnpmInvocation } from "../../scripts/release-check.mjs";
import { command, commandWithInput, isolatedPackageEnvironment } from "../../scripts/verify-package.mjs";

const exec = promisify(execFile);
const releaseCheck = fileURLToPath(new URL("../../scripts/release-check.mjs", import.meta.url));

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "dragons-cmd & spaces-"));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("Windows pnpm uses a shell-free JS or native entrypoint, never a .cmd shim", () => {
  const script = "C:\\some & path\\pnpm.cjs";
  assert.deepEqual(pnpmInvocation("win32", script), [process.execPath, [script]]);
  assert.deepEqual(pnpmInvocation("win32", "C:\\pnpm.exe"), ["C:\\pnpm.exe", []]);
  assert.throws(() => pnpmInvocation("win32", "C:\\pnpm.cmd"), /npm_execpath/);
  assert.throws(() => pnpmInvocation("win32", ""), /npm_execpath/);
  assert.deepEqual(pnpmInvocation("darwin", undefined), ["pnpm", []]);
});

test("release gate invokes the pnpm JS entrypoint without shell interpretation and stops on failure", async () => fixture(async (directory) => {
  const pnpm = join(directory, "pnpm & gates.cjs");
  const platform = join(directory, "windows-platform.cjs");
  const log = join(directory, "calls.jsonl");
  await writeFile(platform, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
  await writeFile(pnpm, `const fs = require('node:fs');
fs.appendFileSync(process.env.GATE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'build') process.exitCode = 23;
`);
  try {
    await exec(process.execPath, ["--require", platform, releaseCheck], {
      env: { ...process.env, npm_execpath: pnpm, GATE_LOG: log },
    });
    assert.fail("release gate should fail on build");
  } catch (error) {
    assert.equal(error.code, 23);
    assert.match(error.stderr, /RELEASE_CHECK_FAILED: pnpm build \(exit 23\)/);
  }
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [["test"], ["typecheck"], ["build"]]);
}));

test("package commands pass metacharacters literally and pipe input without a shell", async () => fixture(async (directory) => {
  const cli = join(directory, "dragons & literal.cjs");
  await writeFile(cli, `const finish = input => process.stdout.write(JSON.stringify({args: process.argv.slice(process.argv[2] === '--pipe' ? 3 : 2), input, notifier: process.env.NO_UPDATE_NOTIFIER}));
if (process.argv[2] === '--pipe') {
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => finish(input));
} else finish('');
`);
  const argument = "literal & | % ! ^ quoted \" value";
  const result = await command(process.execPath, [cli, argument], directory);
  assert.deepEqual(JSON.parse(result), { args: [argument], input: "", notifier: "1" });
  const piped = await commandWithInput(process.execPath, [cli, "--pipe", argument], directory, process.env, "exit\n");
  assert.deepEqual(JSON.parse(piped), { args: [argument], input: "exit\n", notifier: "1" });
}));

test("package acceptance isolates Windows AppData and home from inherited user state", async () => fixture(async (directory) => {
  const inherited = {
    USERPROFILE: "C:\\Users\\someone",
    APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    OPENAI_API_KEY: "fixture-secret",
  };
  const env = isolatedPackageEnvironment(directory, inherited);
  const home = join(directory, "home");
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.APPDATA, join(home, "AppData", "Roaming"));
  assert.equal(env.LOCALAPPDATA, join(home, "AppData", "Local"));
  assert.equal(env.XDG_CONFIG_HOME, join(home, ".config"));
  assert.equal(env.OPENAI_API_KEY, undefined);
}));
