import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const runner = new URL("../../scripts/run-tests.mjs", import.meta.url);
const terminalFiles = [
  ".test-build/cli/basic.test.js",
  ".test-build/tui/basic.test.js",
  ".test-build/runtime/shared-clients.test.js",
  ".test-build/integration/lsp-presentation.test.js",
  ".test-build/acceptance/deterministic.test.js",
  "tests/scripts/nested & spaced/check.test.mjs",
];
const desktopFiles = [
  ".test-build/desktop/host.test.js",
  ".test-build/integration/remote-dashboard.test.js",
  "tests/desktop/layout.test.mjs",
  "tests/integration/personal-browser-adapter.test.mjs",
  "tests/integration/personal-browser-extension.test.mjs",
  "tests/integration/personal-browser-page.test.mjs",
];

async function fixture(run, files = [...terminalFiles, ...desktopFiles]) {
  const directory = await mkdtemp(join(tmpdir(), "dragons-test-suites & spaces-"));
  try {
    for (const name of ["scripts", ".test-build", "tests"]) await mkdir(join(directory, name));
    await copyFile(runner, join(directory, "scripts/run-tests.mjs"));
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    for (const file of files) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(join(directory, file), `import { test } from 'node:test';\ntest(${JSON.stringify(file)}, () => { console.log(${JSON.stringify(`RAN:${file}`)}); });\n`);
    }
    // A suffix filter must never accidentally execute fixtures or live entrypoints.
    for (const file of [".test-build/server.js", "tests/live.mjs", "tests/native.test.ps1"]) {
      await writeFile(join(directory, file), "throw new Error('fixture must not run');\n");
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    await run({
      directory,
      invoke: (...args) => exec(process.execPath, [join(directory, "scripts/run-tests.mjs"), ...args], {
        cwd: directory, env, timeout: 20000, maxBuffer: 1024 * 1024,
      }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function executed(output) {
  return [...output.matchAll(/RAN:([^\r\n]+)/g)].map((match) => match[1]).sort();
}

function listed(output) {
  const result = JSON.parse(output);
  return [...result.compiled, ...result.scripts].sort();
}

test("terminal suite executes CLI, TUI and shared checks without Desktop/Web-only tests", async () => fixture(async ({ invoke }) => {
  const { stdout } = await invoke("--suite=terminal");
  assert.deepEqual(executed(stdout), [...terminalFiles].sort());
  assert.match(stdout, /TEST_DISCOVERY suite=terminal compiled=5 scripts=1/);
}));

test("desktop suite executes Desktop and Web-only checks", async () => fixture(async ({ invoke }) => {
  const { stdout } = await invoke("--suite=desktop");
  assert.deepEqual(executed(stdout), [...desktopFiles].sort());
}));

test("default test runner still executes every discovered test", async () => fixture(async ({ invoke }) => {
  const { stdout } = await invoke();
  assert.deepEqual(executed(stdout), [...terminalFiles, ...desktopFiles].sort());
}));

test("listed suites form a complete non-overlapping partition without executing tests", async () => fixture(async ({ invoke }) => {
  const all = listed((await invoke("--list")).stdout);
  const terminal = listed((await invoke("--suite=terminal", "--list")).stdout);
  const desktop = listed((await invoke("--suite=desktop", "--list")).stdout);
  assert.deepEqual([...terminal, ...desktop].sort(), all);
  assert.equal(new Set([...terminal, ...desktop]).size, all.length);
  assert.deepEqual(all, [...terminalFiles, ...desktopFiles].sort());
}));

test("test runner rejects unknown, duplicate and misspelled options rather than passing silently", async () => fixture(async ({ invoke }) => {
  for (const args of [["--suite=termnal"], ["--suite="], ["--suite=terminal", "--suite=desktop"], ["--typo"], ["--list", "--list"]]) {
    await assert.rejects(invoke(...args), (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /Invalid test runner arguments/);
      assert.deepEqual(executed(error.stdout), []);
      return true;
    });
  }
}));

test("selected empty suite is a failure, not a green zero-test job", async () => fixture(async ({ invoke }) => {
  await assert.rejects(invoke("--suite=desktop"), /No tests found for suite desktop/);
}, terminalFiles));

test("selected suite propagates test failure without running the other suite", async () => fixture(async ({ invoke, directory }) => {
  await writeFile(join(directory, terminalFiles[0]), "import { test } from 'node:test'; test('expected fixture failure', () => { throw new Error('fixture failure'); });\n");
  await assert.rejects(invoke("--suite=terminal"), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /fixture failure/);
    assert.equal(executed(error.stdout).some((file) => desktopFiles.includes(file)), false);
    return true;
  });
}));

test("missing compiled tests still require a build even for a source-only selection", async () => fixture(async ({ invoke }) => {
  await assert.rejects(invoke("--suite=desktop"), /No compiled tests found; run pnpm build:tests/);
}, ["tests/desktop/layout.test.mjs"]));
