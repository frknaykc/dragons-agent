import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { main as runCli } from "./cli.js";

const FIXTURE_PREFIX = "dragons-agent-live-smoke-";
const FIXTURE_SOURCE = "export function add(left, right) {\n  return left - right;\n}\n";
const FIXED_FIXTURE_SOURCE = "export function add(left, right) {\n  return left + right;\n}\n";
const FIXTURE_TEST = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './calculator.js';\n\ntest('adds numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n";
const AUTOMATED_APPROVALS = Array.from({ length: 20 }, () => "yes\n");

export type FixtureVerification = {
  sourceIsFixed: boolean;
  testIsUnchanged: boolean;
  testPassed: boolean;
  success: boolean;
  testOutput: string;
};

export type LiveSmokeResult = FixtureVerification & {
  workspace: string;
  inspected: boolean;
  mutated: boolean;
  executedTest: boolean;
  approvalRequested: boolean;
  finalReportRendered: boolean;
};

async function runFixtureTest(workingDirectory: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "calculator.test.js"], {
      cwd: workingDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, output }));
  });
}

export async function createLiveSmokeFixture(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), FIXTURE_PREFIX));
  await writeFile(join(workspace, "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(join(workspace, "calculator.js"), FIXTURE_SOURCE, "utf8");
  await writeFile(join(workspace, "calculator.test.js"), FIXTURE_TEST, "utf8");
  return workspace;
}

export async function removeLiveSmokeFixture(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });

  try {
    await access(workspace);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(`Live smoke fixture cleanup failed: ${workspace}`);
}

export async function verifyLiveSmokeFixture(workspace: string): Promise<FixtureVerification> {
  const [source, testSource, test] = await Promise.all([
    readFile(join(workspace, "calculator.js"), "utf8"),
    readFile(join(workspace, "calculator.test.js"), "utf8"),
    runFixtureTest(workspace),
  ]);
  const sourceIsFixed = source === FIXED_FIXTURE_SOURCE;
  const testIsUnchanged = testSource === FIXTURE_TEST;
  const testPassed = test.code === 0;

  return {
    sourceIsFixed,
    testIsUnchanged,
    testPassed,
    success: sourceIsFixed && testIsUnchanged && testPassed,
    testOutput: test.output,
  };
}

function hasToolStart(transcript: string, names: string[]): boolean {
  return names.some((name) => transcript.includes(`• ${name}\n`));
}

function hasFinalReport(transcript: string): boolean {
  const lastToolStart = transcript.lastIndexOf("• ");
  if (lastToolStart < 0) {
    return false;
  }

  const afterToolName = transcript.indexOf("\n", lastToolStart);
  return afterToolName >= 0 && transcript.slice(afterToolName + 1).trim().length > 0;
}

function requireLiveOptIn(arguments_: string[]): void {
  if (!arguments_.includes("--live")) {
    throw new Error("Live smoke is opt-in. Run: pnpm smoke:live -- --live");
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required. Run: OPENAI_API_KEY=... pnpm smoke:live -- --live");
  }
}

export async function runLiveSmoke(arguments_ = process.argv.slice(2)): Promise<LiveSmokeResult> {
  requireLiveOptIn(arguments_);

  const workspace = await createLiveSmokeFixture();
  const output: string[] = [];

  try {
    const before = await verifyLiveSmokeFixture(workspace);
    if (before.success || before.testPassed) {
      throw new Error("Live smoke fixture must begin with its deterministic failing test.");
    }

    await runCli([
      "Inspect this temporary fixture before changing it. Find and fix the addition bug in calculator.js. Use the provided tools to inspect/read the project, modify only calculator.js, run `node --test calculator.test.js`, observe the passing result, and then give a concise final report. Do not modify calculator.test.js or package.json.",
    ], {
      workingDirectory: workspace,
      // This opt-in harness supplies one-time yes answers only to the existing CLI authorizer.
      // The tools themselves remain project-root-bound to this temporary fixture.
      input: Readable.from(AUTOMATED_APPROVALS),
      write: (text) => {
        output.push(text);
        process.stdout.write(text);
      },
    });

    const verification = await verifyLiveSmokeFixture(workspace);
    const transcript = output.join("");
    const result: LiveSmokeResult = {
      ...verification,
      workspace,
      inspected: hasToolStart(transcript, ["list_directory", "read_file", "search_files"]),
      mutated: hasToolStart(transcript, ["write_file", "edit_file"]),
      executedTest: hasToolStart(transcript, ["shell"]),
      approvalRequested: transcript.includes("? Allow WRITE") || transcript.includes("? Allow EXECUTE"),
      finalReportRendered: hasFinalReport(transcript),
    };

    if (!result.success || !result.inspected || !result.mutated || !result.executedTest
      || !result.approvalRequested || !result.finalReportRendered) {
      throw new Error("Live smoke did not complete the required inspect → modify → test → report workflow.");
    }

    return result;
  } finally {
    await removeLiveSmokeFixture(workspace);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runLiveSmoke().then(() => {
    process.stdout.write("\nLive smoke passed: fixture state and test outcome were verified.\n");
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected live smoke error.";
    process.stderr.write(`Live smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
