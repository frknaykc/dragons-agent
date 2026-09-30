import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { main as runCli, type CliDependencies } from "../../dist/cli.js";
import type { AgentModel } from "../../dist/agent.js";
import { createChatGPTAuthService } from "../../dist/provider/codex-auth.js";
import { createBuiltInProviderRegistry } from "../../dist/provider/builtins.js";
import { createSessionStore } from "../../dist/session-store.js";
import type { AgentTool } from "../../dist/tools.js";

export const PHASE2_CASES = ["inline", "session", "catalog", "program"] as const;
export type Phase2Case = typeof PHASE2_CASES[number];
type RunCli = (args: string[], dependencies: CliDependencies) => Promise<void>;

function observed(transcript: string, name: string): boolean {
  return transcript.includes(`• ${name}\n`) && transcript.includes(`✓ ${name}\n`);
}

/** Classify known interpreter errors without printing provider output or dynamic tool arguments. */
export function programFailureCategory(output: string): string | undefined {
  const categories: [RegExp, string][] = [
    [/^Invalid JSON tool arguments\.$/, "invalid JSON arguments"],
    [/^Expected 1-16 program steps\.$/, "invalid steps shape"],
    [/^Invalid or excessive program variable\.$/, "invalid program variable"],
    [/^Unknown program step operation\.$/, "unknown step operation"],
    [/^Unknown program variable:/, "unknown variable"],
    [/^Program reference path not found\.$/, "missing reference path"],
    [/^Filter requires a bounded array and field\.$/, "invalid filter source"],
    [/^Aggregate requires a bounded array\.$/, "invalid aggregate source"],
    [/^Invalid aggregate operation\.$/, "invalid aggregate operation"],
    [/^Nested tool /, "nested tool failed"],
    [/^Unknown tool:/, "unknown tool"],
    [/^Authorization denied for /, "authorization denied"],
  ];
  return categories.find(([pattern]) => pattern.test(output))?.[1];
}

/** Fail closed on missing tool evidence; model prose alone never establishes a tool flow. */
export function assertPhase2Observation(caseName: Phase2Case, transcript: string, marker: string, programDiagnostic?: string): void {
  const required: Record<Phase2Case, string[]> = {
    inline: [], session: ["session_search", "session_read"],
    catalog: ["tool_search", "tool_describe", "fixture_lantern_probe"],
    program: ["execute_program", "fixture_inventory"],
  };
  const attempted = [...transcript.matchAll(/• ([A-Za-z0-9_]+)\n/g)].map(match => match[1]);
  assert.ok(!transcript.includes("? Allow WRITE") && !transcript.includes("? Allow EXECUTE"), "Live fixture requested WRITE/EXECUTE approval.");
  const failed = [...transcript.matchAll(/✗ ([A-Za-z0-9_]+)\n/g)].map(match => match[1]);
  const failedNames = failed.map(name => required[caseName].includes(name!) ? name : "other");
  assert.ok(failed.length === 0, `Tool failed: ${failedNames.join(", ")}${caseName === "program" && programDiagnostic ? ` (${programDiagnostic})` : ""}`);
  assert.ok(transcript.includes(marker), "Fixture marker was not returned.");
  assert.ok(attempted.every(name => required[caseName].includes(name!)), "Unexpected tool invocation in live fixture.");
  for (const name of required[caseName]) assert.ok(observed(transcript, name), `Required tool did not complete: ${name}`);
  if (caseName === "catalog") {
    const starts = required.catalog.map((name) => transcript.indexOf(`• ${name}\n`));
    assert.ok(starts[0]! < starts[1]! && starts[1]! < starts[2]!, "Discovery, activation and execution must be ordered.");
  }
}

async function git(directory: string, ...args: string[]): Promise<void> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: directory, env: environment, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Temporary Git fixture failed (${args[0]}).`)));
  });
}

/** One scenario per opt-in invocation; only synthetic, disposable fixture data reaches the provider. */
export async function runPhase2Case(caseName: Phase2Case, options: { model: AgentModel; invoke?: RunCli; baseDirectory?: string }): Promise<void> {
  const directory = await mkdtemp(join(options.baseDirectory ?? tmpdir(), "dragons-phase2-live-"));
  const sessions = join(directory, ".sessions");
  const memory = join(directory, ".memory");
  const skills = join(directory, ".skills");
  const nonce = randomUUID().slice(0, 12);
  const marker = `P2-${nonce}`;
  const transcript: string[] = [];
  let providerTurns = 0;
  let fixtureCalls = 0;
  let programDiagnostic: string | undefined;
  let expectedProgram: object | undefined;
  let programMatches = 0;
  let programMismatches = 0;
  const pendingProgramCalls = new Set<string>();
  const tools: AgentTool[] = [];
  let prompt = "";
  try {
    await Promise.all([mkdir(sessions), mkdir(memory), mkdir(skills)]);
    if (caseName === "inline") {
      await writeFile(join(directory, "note.txt"), `File marker: ${marker}-FILE\n`, "utf8");
      await git(directory, "init", "-q");
      await writeFile(join(directory, "change.txt"), "Original line\n", "utf8");
      await git(directory, "add", "change.txt");
      await git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
      await writeFile(join(directory, "change.txt"), `Changed line: ${marker}-DIFF\n`, "utf8");
      prompt = "From the supplied inline references only, report the exact FILE and DIFF markers. Do not call tools. @file(note.txt) @diff";
    } else if (caseName === "session") {
      const store = createSessionStore(sessions);
      const session = await store.create({ workingDirectory: directory, provider: "chatgpt", model: "fixture" });
      session.messages.push({ role: "user", content: `amber orbit observation ${marker}`, createdAt: new Date().toISOString() });
      await store.save(session);
      prompt = "Use session_search for 'amber orbit observation', then session_read the matching saved session. Report its exact P2 marker. Do not infer the marker.";
    } else if (caseName === "catalog") {
      for (let index = 0; index < 27; index += 1) tools.push({
        name: index === 13 ? "fixture_lantern_probe" : `fixture_other_${index}`,
        description: index === 13 ? "quartz lantern observation" : `unrelated fixture item ${index}`,
        operation: "READ", inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => { if (index === 13) fixtureCalls++; return { ok: true, output: index === 13 ? marker : "other" }; },
      });
      prompt = "Use tool_search to find the quartz lantern observation tool, tool_describe its exact name, then invoke that tool on a later model turn. Report only the P2 marker it returns. Do not guess.";
    } else {
      tools.push({ name: "fixture_inventory", description: "Returns a small JSON array of active/inactive inventory entries", operation: "READ",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => { fixtureCalls++; return { ok: true, output: JSON.stringify([{ label: marker, active: true }, { label: "ignore", active: false }]) }; },
      });
      const program = { steps: [
        { op: "call", as: "inventory", tool: "fixture_inventory", args: {} },
        { op: "filter", as: "chosen", from: "inventory.data", field: "active", equals: true },
        { op: "aggregate", as: "labels", from: "chosen", kind: "collect", field: "label" },
      ], return: "labels" };
      expectedProgram = program;
      prompt = `Call execute_program once using exactly this declarative JSON input, without adding or renaming steps. PROGRAM_INPUT_JSON: ${JSON.stringify(program)}\nReport the exact P2 marker in the result. Do not call fixture_inventory directly.`;
    }
    const boundedModel: AgentModel = { async respond(request, delta) {
      if (++providerTurns > 8) throw new Error("Live case exceeded eight provider turns.");
      for (const output of request.toolOutputs) {
        if (pendingProgramCalls.delete(output.callId)) programDiagnostic = programFailureCategory(output.output) ?? programDiagnostic;
      }
      const response = await options.model.respond(request, delta);
      if (caseName === "program") {
        for (const call of response.toolCalls) {
          if (call.name !== "execute_program") continue;
          pendingProgramCalls.add(call.callId);
          try {
            if (isDeepStrictEqual(JSON.parse(call.arguments), expectedProgram)) programMatches++;
            else programMismatches++;
          } catch {
            programMismatches++;
          }
        }
      }
      return response;
    } };
    await (options.invoke ?? runCli)(["--provider", "chatgpt", prompt], {
      workingDirectory: directory, sessionDirectory: sessions, skillsDirectory: skills, memoryDirectory: memory,
      configPath: join(directory, ".config.json"), config: {}, tools, model: boundedModel,
      input: Readable.from([]), write: text => { transcript.push(text); },
    });
    const output = transcript.join("");
    assertPhase2Observation(caseName, output, marker, programDiagnostic);
    if (caseName === "program") assert.ok(programMatches === 1 && programMismatches === 0, "Sent program input differs from the fixture.");
    if (caseName === "inline") assert.ok(output.includes(`${marker}-FILE`) && output.includes(`${marker}-DIFF`), "Both inline references must be returned.");
    if (caseName === "catalog" || caseName === "program") assert.equal(fixtureCalls, 1, "Fixture tool must execute exactly once.");
    if (caseName === "inline") assert.equal(await readFile(join(directory, "change.txt"), "utf8"), `Changed line: ${marker}-DIFF\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void (async () => {
    const args = process.argv.slice(2).filter(arg => arg !== "--");
    const caseName = args[1];
    if (args.length !== 2 || args[0] !== "--live" || !PHASE2_CASES.includes(caseName as Phase2Case)) {
      throw new Error("Opt-in required: --live <inline|session|catalog|program> (one case per run).");
    }
    if (!(await createChatGPTAuthService().status()).authenticated) throw new Error("Dragons ChatGPT is not signed in.");
    const model = createBuiltInProviderRegistry().createModel("chatgpt", { write: () => {} });
    await runPhase2Case(caseName as Phase2Case, { model });
    process.stdout.write(`Phase 2 live ${caseName} acceptance passed (synthetic fixture cleaned).\n`);
  })().catch((error: unknown) => {
    const classification = error instanceof Error && error.name === "AssertionError" ? error.message : "provider, fixture or runtime error";
    process.stderr.write(`Phase 2 live acceptance failed (${classification}); no pass recorded.\n`);
    process.exitCode = 1;
  });
}
