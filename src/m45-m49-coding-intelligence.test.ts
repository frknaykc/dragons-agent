import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, type AgentModel } from "./agent.js";
import { discoverRepositoryInfo } from "./repository-intelligence.js";
import { createCodingTools } from "./tools.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dragons-coding-intelligence-"));
}

function tool(tools: Awaited<ReturnType<typeof createCodingTools>>, name: string) {
  const candidate = tools.find((item) => item.name === name);
  assert.ok(candidate, `expected ${name} tool`);
  return candidate;
}

function git(directory: string, arguments_: string[]): void {
  execFileSync("git", arguments_, { cwd: directory, stdio: "ignore" });
}

test("M45 discovers bounded package, workspace, command, and non-Git repository evidence", async () => {
  const directory = await workspace();
  try {
    await Promise.all([
      mkdir(join(directory, "src")),
      mkdir(join(directory, "tests")),
      mkdir(join(directory, "packages")),
      writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      writeFile(join(directory, "package-lock.json"), "{}\n"),
      writeFile(join(directory, "package.json"), JSON.stringify({
        name: "fixture",
        type: "module",
        engines: { node: ">=22" },
        workspaces: ["packages/*"],
        scripts: { test: "node --test", typecheck: "tsc --noEmit", build: "tsc", lint: "eslint ." },
      })),
    ]);
    await mkdir(join(directory, "packages", "core"));
    await writeFile(join(directory, "packages", "core", "package.json"), '{"name":"@fixture/core"}');

    const info = await discoverRepositoryInfo(directory);
    assert.equal(info.packageManager, undefined);
    assert.deepEqual(info.packageManagerIndicators, ["package-lock.json", "pnpm-lock.yaml"]);
    assert.equal(info.node?.name, "fixture");
    assert.equal(info.node?.type, "module");
    assert.deepEqual(info.sourceDirectories, ["src"]);
    assert.deepEqual(info.testDirectories, ["tests"]);
    assert.deepEqual(info.workspacePackages, [{ name: "@fixture/core", root: "packages/core" }]);
    assert.deepEqual(info.commands, { test: "node --test", typecheck: "tsc --noEmit", build: "tsc", lint: "eslint ." });
    assert.equal(info.git.isRepository, false);
    assert.match((await tool(await createCodingTools(directory), "project_info").execute({})).output, /conflicting lockfiles/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M45 identifies unambiguous pnpm/npm evidence and safely tolerates absent metadata", async () => {
  const pnpm = await workspace();
  const npm = await workspace();
  const empty = await workspace();
  try {
    await Promise.all([writeFile(join(pnpm, "pnpm-lock.yaml"), "lockfileVersion: '9.0'"), writeFile(join(npm, "package-lock.json"), "{}")]);
    assert.equal((await discoverRepositoryInfo(pnpm)).packageManager, "pnpm");
    assert.equal((await discoverRepositoryInfo(npm)).packageManager, "npm");
    const noMetadata = await discoverRepositoryInfo(empty);
    assert.equal(noMetadata.node, undefined);
    assert.deepEqual(noMetadata.commands, {});
    assert.deepEqual(noMetadata.workspacePackages, []);
  } finally { await Promise.all([rm(pnpm, { recursive: true, force: true }), rm(npm, { recursive: true, force: true }), rm(empty, { recursive: true, force: true })]); }
});

test("M46 symbol navigation is lexical, bounded, path-safe, and excludes generated dependencies", async () => {
  const directory = await workspace();
  const outside = await workspace();
  try {
    await Promise.all([mkdir(join(directory, "src")), mkdir(join(directory, "node_modules"))]);
    await Promise.all([
      writeFile(join(directory, "src", "api.ts"), [
        "export interface User { id: string }",
        "export type Token = string;",
        "export class Service {",
        "  greet(user: User) { return user.id; }",
        "}",
        "export function greet(user: User) { return user.id; }",
        "function nested() { return greet({ id: 'ok' }); }",
      ].join("\n")),
      writeFile(join(directory, "node_modules", "ignored.ts"), "export function greet() {}\n"),
      writeFile(join(outside, "outside.ts"), "export function outside() {}\n"),
    ]);
    await symlink(join(outside, "outside.ts"), join(directory, "src", "outside.ts"));
    const tools = await createCodingTools(directory, { maxToolOutputBytes: 400 });
    const listed = await tool(tools, "list_symbols").execute({ path: "src/api.ts" });
    const definitions = await tool(tools, "find_symbol").execute({ name: "greet" });
    const references = await tool(tools, "find_references").execute({ name: "greet" });
    assert.match(listed.output, /interface User/);
    assert.match(listed.output, /class Service/);
    assert.match(definitions.output, /src\/api.ts:4:method greet/);
    assert.match(definitions.output, /src\/api.ts:6:function greet/);
    assert.match(references.output, /Syntactic references/);
    assert.doesNotMatch(references.output, /node_modules|outside\.ts/);
    assert.deepEqual(await tool(tools, "list_symbols").execute({ path: "../outside.ts" }), { ok: false, output: "Path must stay within the working directory." });
  } finally {
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("M47 applies atomic bounded unified patches and preserves exact files on rejected input", async () => {
  const directory = await workspace();
  try {
    await mkdir(join(directory, "src"));
    await Promise.all([
      writeFile(join(directory, "src", "one.ts"), "export const one = 1;\n"),
      writeFile(join(directory, "src", "two.ts"), "export const two = 2;\n"),
    ]);
    const apply = tool(await createCodingTools(directory), "apply_patch");
    const success = await apply.execute({ patch: [
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1 +1 @@",
      "-export const one = 1;",
      "+export const one = 10;",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -1 +1 @@",
      "-export const two = 2;",
      "+export const two = 20;",
    ].join("\n") });
    assert.deepEqual(success, { ok: true, output: "Applied patch: 2 files changed, 2 hunks applied.", changedPaths: ["src/one.ts", "src/two.ts"] });
    assert.equal(await readFile(join(directory, "src", "one.ts"), "utf8"), "export const one = 10;\n");
    const stale = await apply.execute({ patch: "--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1 @@\n-export const one = 1;\n+export const one = 3;" });
    assert.deepEqual(stale, { ok: false, output: "Patch context did not match src/one.ts at line 1." });
    assert.equal(await readFile(join(directory, "src", "one.ts"), "utf8"), "export const one = 10;\n");
    const created = await apply.execute({ patch: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const created = true;" });
    assert.deepEqual(created, { ok: true, output: "Applied patch: 1 files changed, 1 hunks applied.", changedPaths: ["src/new.ts"] });
    assert.equal(await readFile(join(directory, "src", "new.ts"), "utf8"), "export const created = true;\n");
    assert.deepEqual(await apply.execute({ patch: "--- a/../escape.ts\n+++ b/../escape.ts\n@@ -0,0 +1 @@\n+x" }), { ok: false, output: "Path must stay within the working directory." });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M47 stays on the existing WRITE authorization boundary", async () => {
  const directory = await workspace();
  try {
    await writeFile(join(directory, "value.js"), "export const value = 1;\n");
    let turn = 0;
    const model: AgentModel = { async respond() {
      return turn++ === 0
        ? { responseId: "patch", text: "", toolCalls: [{ callId: "patch", name: "apply_patch", arguments: '{"patch":"--- a/value.js\\n+++ b/value.js\\n@@ -1 +1 @@\\n-export const value = 1;\\n+export const value = 2;"}' }] }
        : { responseId: "done", text: "denied", toolCalls: [] };
    } };
    await runAgent({ task: "change", model, tools: await createCodingTools(directory), workingDirectory: directory });
    assert.equal(await readFile(join(directory, "value.js"), "utf8"), "export const value = 1;\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("M48 recommends only bounded local conventions without running a shell", async () => {
  const directory = await workspace();
  try {
    await mkdir(join(directory, "src"));
    await Promise.all([
      writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc --noEmit", build: "tsc" } })),
      writeFile(join(directory, "src", "auth.ts"), "export const auth = true;\n"),
      writeFile(join(directory, "src", "auth.test.ts"), "import test from 'node:test';\ntest('auth', () => {});\n"),
    ]);
    const result = await tool(await createCodingTools(directory), "suggest_tests").execute({ paths: ["src/auth.ts"] });
    assert.match(result.output, /focused: pnpm test -- src\/auth\.test\.ts/);
    assert.match(result.output, /package: pnpm test/);
    assert.match(result.output, /full: pnpm test && pnpm run typecheck && pnpm run build/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M49 integrated coding workflow tracks run-local changes, preserves authorization, tests, and reviews a Git fixture", async () => {
  const directory = await workspace();
  try {
    await Promise.all([
      writeFile(join(directory, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n'),
      writeFile(join(directory, "calculator.js"), "export function add(left, right) { return left - right; }\n"),
      writeFile(join(directory, "calculator.test.js"), "import assert from 'node:assert/strict'; import test from 'node:test'; import { add } from './calculator.js'; test('add', () => assert.equal(add(2, 3), 5));\n"),
      writeFile(join(directory, "notes.txt"), "user change\n"),
    ]);
    git(directory, ["init"]); git(directory, ["config", "user.name", "Fixture"]); git(directory, ["config", "user.email", "fixture@example.invalid"]); git(directory, ["add", "."]); git(directory, ["commit", "-m", "initial"]);
    await writeFile(join(directory, "notes.txt"), "user change retained\n");
    const calls = [
      ["project_info", "{}"],
      ["find_symbol", '{"name":"add"}'],
      ["apply_patch", '{"patch":"--- a/calculator.js\\n+++ b/calculator.js\\n@@ -1 +1 @@\\n-export function add(left, right) { return left - right; }\\n+export function add(left, right) { return left + right; }"}'],
      ["suggest_tests", "{}"],
      ["shell", '{"command":"node --test calculator.test.js"}'],
      ["review_changes", "{}"],
    ] as const;
    let turn = 0;
    const model: AgentModel = { async respond(request) {
      if (turn < calls.length) {
        const [name, arguments_] = calls[turn++]!;
        return { responseId: `r-${turn}`, text: "", toolCalls: [{ callId: `c-${turn}`, name, arguments: arguments_ }] };
      }
      assert.match(request.toolOutputs[0]?.output ?? "", /run-local files: calculator\.js/);
      return { responseId: "done", text: "Fixed and reviewed.", toolCalls: [] };
    } };
    const result = await runAgent({ task: "Fix calculator", model, tools: await createCodingTools(directory), workingDirectory: directory, authorize: () => true });
    assert.equal(result.finalText, "Fixed and reviewed.");
    assert.match(await readFile(join(directory, "calculator.js"), "utf8"), /left \+ right/);
    assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), "user change retained\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
