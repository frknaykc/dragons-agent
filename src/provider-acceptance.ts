import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { main as runDragonsCli, type CliDependencies } from "./cli.js";
import {
  createLiveSmokeFixture,
  removeLiveSmokeFixture,
  verifyLiveSmokeFixture,
  type FixtureVerification,
} from "./live-smoke.js";
import { createChatGPTAuthService, type ChatGPTAuthService } from "./provider/codex-auth.js";

const AUTOMATED_APPROVALS = Array.from({ length: 20 }, () => "yes\n");
const FIXTURE_STATE_DIRECTORY = ".dragons-provider-acceptance";
const ACCEPTANCE_PROMPT = "Inspect this temporary coding fixture before changing it. Find and fix the addition bug in calculator.js. Use the provided tools to inspect/read the project, modify only calculator.js, run `node --test calculator.test.js`, observe the passing result, and then give a concise final report. Do not modify calculator.test.js or package.json.";

export type ProviderAcceptanceProvider = "openai-api" | "chatgpt";

export type ProviderAcceptanceFixture = {
  workspace: string;
  sessionsDirectory: string;
  skillsDirectory: string;
  memoryDirectory: string;
};

export type ProviderAcceptanceResult = FixtureVerification & {
  provider: ProviderAcceptanceProvider;
  workspace: string;
  inspected: boolean;
  mutated: boolean;
  executedTest: boolean;
  writeApprovalRequested: boolean;
  executeApprovalRequested: boolean;
  toolResultsRendered: boolean;
  streamedFinalResponseRendered: boolean;
};

export type ProviderAcceptanceDependencies = {
  /** Test-only overrides keep all M31 safety tests deterministic and credential-free. */
  environment?: NodeJS.ProcessEnv;
  createFixture?: () => Promise<ProviderAcceptanceFixture>;
  removeFixture?: (fixture: ProviderAcceptanceFixture) => Promise<void>;
  verifyFixture?: (fixture: ProviderAcceptanceFixture) => Promise<FixtureVerification>;
  runCli?: (arguments_: string[], dependencies: CliDependencies) => Promise<void>;
  createChatGPTAuthService?: () => Pick<ChatGPTAuthService, "status">;
  write?: (text: string) => void;
};

export async function createProviderAcceptanceFixture(): Promise<ProviderAcceptanceFixture> {
  const workspace = await createLiveSmokeFixture();
  const stateDirectory = join(workspace, FIXTURE_STATE_DIRECTORY);
  const fixture: ProviderAcceptanceFixture = {
    workspace,
    sessionsDirectory: join(stateDirectory, "sessions"),
    skillsDirectory: join(stateDirectory, "skills"),
    memoryDirectory: join(stateDirectory, "memory"),
  };
  await Promise.all([
    mkdir(fixture.sessionsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(fixture.skillsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(fixture.memoryDirectory, { recursive: true, mode: 0o700 }),
  ]);
  return fixture;
}

export async function removeProviderAcceptanceFixture(fixture: ProviderAcceptanceFixture): Promise<void> {
  await removeLiveSmokeFixture(fixture.workspace);
}

export async function verifyProviderAcceptanceFixture(fixture: ProviderAcceptanceFixture): Promise<FixtureVerification> {
  return verifyLiveSmokeFixture(fixture.workspace);
}

function hasToolStart(transcript: string, names: string[]): boolean {
  return names.some((name) => transcript.includes(`• ${name}\n`));
}

function hasToolResult(transcript: string, names: string[]): boolean {
  return names.some((name) => transcript.includes(`✓ ${name}\n`));
}

function hasStreamedFinalResponse(transcript: string): boolean {
  const lastToolResult = transcript.lastIndexOf("✓ ");
  if (lastToolResult < 0) return false;
  const afterResult = transcript.indexOf("\n", lastToolResult);
  return afterResult >= 0 && transcript.slice(afterResult + 1).trim().length > 0;
}

/** Verifies the observable live-run contract independently of provider-side claims. */
export function assertProviderAcceptanceContract(verification: FixtureVerification, transcript: string): Omit<ProviderAcceptanceResult, keyof FixtureVerification | "provider" | "workspace"> {
  const inspected = hasToolStart(transcript, ["list_directory", "read_file", "search_files"]);
  const mutated = hasToolStart(transcript, ["write_file", "edit_file"]);
  const executedTest = hasToolStart(transcript, ["shell"]);
  const writeApprovalRequested = transcript.includes("? Allow WRITE");
  const executeApprovalRequested = transcript.includes("? Allow EXECUTE");
  const toolResultsRendered = hasToolResult(transcript, ["write_file", "edit_file"])
    && hasToolResult(transcript, ["shell"]);
  const streamedFinalResponseRendered = hasStreamedFinalResponse(transcript);

  if (!verification.success) throw new Error("Provider acceptance failed independent fixture verification.");
  if (!inspected) throw new Error("Provider acceptance did not inspect/read the fixture.");
  if (!mutated) throw new Error("Provider acceptance did not request an approved fixture mutation.");
  if (!executedTest) throw new Error("Provider acceptance did not request an approved shell test.");
  if (!writeApprovalRequested || !executeApprovalRequested) throw new Error("Provider acceptance did not use both existing CLI approval paths.");
  if (!toolResultsRendered) throw new Error("Provider acceptance did not render successful mutation and shell tool results.");
  if (!streamedFinalResponseRendered) throw new Error("Provider acceptance did not render a streamed final response.");

  return {
    inspected,
    mutated,
    executedTest,
    writeApprovalRequested,
    executeApprovalRequested,
    toolResultsRendered,
    streamedFinalResponseRendered,
  };
}

function requireLiveOptIn(arguments_: string[], provider: ProviderAcceptanceProvider): void {
  if (!arguments_.includes("--live")) {
    throw new Error(`Provider acceptance is opt-in. Run: pnpm acceptance:${provider === "openai-api" ? "openai" : "chatgpt"} -- --live`);
  }
}

async function requireProviderReadiness(provider: ProviderAcceptanceProvider, dependencies: ProviderAcceptanceDependencies): Promise<void> {
  if (provider === "openai-api") {
    if (!dependencies.environment?.OPENAI_API_KEY?.trim()) {
      throw new Error("OPENAI_API_KEY is required before OpenAI provider acceptance can start.");
    }
    return;
  }

  // This is intentionally Dragons-owned auth only; no Hermes or Codex credential source is consulted.
  const auth = dependencies.createChatGPTAuthService?.() ?? createChatGPTAuthService();
  const status = await auth.status();
  if (!status.authenticated) {
    throw new Error("ChatGPT provider acceptance is not signed in with Dragons ChatGPT auth. Run dragons auth login --provider chatgpt.");
  }
}

function redactProviderError(error: unknown, environment: NodeJS.ProcessEnv): Error {
  const message = error instanceof Error ? error.message : "Unexpected provider acceptance error.";
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const redactedApiKey = apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message;
  const redactedBearer = redactedApiKey.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  const redactedFields = redactedBearer.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*["']?)[^\s,"'}\]]+/gi, "$1[REDACTED]");
  return new Error(`Provider acceptance failed: ${redactedFields}`);
}

async function runProviderAcceptance(
  provider: ProviderAcceptanceProvider,
  arguments_: string[],
  dependencies: ProviderAcceptanceDependencies = {},
): Promise<ProviderAcceptanceResult> {
  const environment = dependencies.environment ?? process.env;
  requireLiveOptIn(arguments_, provider);
  await requireProviderReadiness(provider, { ...dependencies, environment });

  const createFixture = dependencies.createFixture ?? createProviderAcceptanceFixture;
  const removeFixture = dependencies.removeFixture ?? removeProviderAcceptanceFixture;
  const verifyFixture = dependencies.verifyFixture ?? verifyProviderAcceptanceFixture;
  const invokeCli = dependencies.runCli ?? runDragonsCli;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const fixture = await createFixture();
  const output: string[] = [];

  try {
    const before = await verifyFixture(fixture);
    if (before.success || before.testPassed) throw new Error("Provider acceptance fixture must begin with its deterministic failing test.");

    await invokeCli(["--provider", provider, ACCEPTANCE_PROMPT], {
      workingDirectory: fixture.workspace,
      sessionDirectory: fixture.sessionsDirectory,
      skillsDirectory: fixture.skillsDirectory,
      memoryDirectory: fixture.memoryDirectory,
      input: Readable.from(AUTOMATED_APPROVALS),
      // Approval answers are consumed only by the existing CLI authorizer.
      write: (text) => {
        output.push(text);
        write(text);
      },
    });

    const verification = await verifyFixture(fixture);
    const contract = assertProviderAcceptanceContract(verification, output.join(""));
    return { ...verification, ...contract, provider, workspace: fixture.workspace };
  } catch (error: unknown) {
    throw redactProviderError(error, environment);
  } finally {
    await removeFixture(fixture);
  }
}

export async function runOpenAIAcceptance(
  arguments_ = process.argv.slice(2),
  dependencies: ProviderAcceptanceDependencies = {},
): Promise<ProviderAcceptanceResult> {
  return runProviderAcceptance("openai-api", arguments_, dependencies);
}

export async function runChatGPTAcceptance(
  arguments_ = process.argv.slice(2),
  dependencies: ProviderAcceptanceDependencies = {},
): Promise<ProviderAcceptanceResult> {
  return runProviderAcceptance("chatgpt", arguments_, dependencies);
}

export function formatProviderAcceptanceError(error: unknown): string {
  return error instanceof Error ? error.message : "Provider acceptance failed: Unexpected provider acceptance error.";
}
