import assert from "node:assert/strict";
import test from "node:test";

import { runAgent, type AgentRequest } from "./agent.js";
import {
  assertProviderAcceptanceContract,
  runChatGPTAcceptance,
  runOpenAIAcceptance,
  type ProviderAcceptanceDependencies,
} from "./provider-acceptance.js";

function dependencies(overrides: Partial<ProviderAcceptanceDependencies> = {}): ProviderAcceptanceDependencies {
  return {
    environment: {},
    createFixture: async () => ({ workspace: "/tmp/m31-fixture", sessionsDirectory: "/tmp/m31-fixture/state/sessions", skillsDirectory: "/tmp/m31-fixture/state/skills", memoryDirectory: "/tmp/m31-fixture/state/memory" }),
    removeFixture: async () => undefined,
    verifyFixture: async () => ({ sourceIsFixed: false, testIsUnchanged: true, testPassed: false, success: false, testOutput: "not run" }),
    runCli: async () => undefined,
    write: () => undefined,
    ...overrides,
  };
}

test("M31 OpenAI acceptance rejects omitted opt-in before fixture, CLI, or network work", async () => {
  let fixtures = 0;
  let cliRuns = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not run");
  };

  try {
    await assert.rejects(runOpenAIAcceptance([], dependencies({
      createFixture: async () => { fixtures += 1; throw new Error("fixture must not be created"); },
      runCli: async () => { cliRuns += 1; },
    })), /--live/);
    assert.equal(fixtures, 0);
    assert.equal(cliRuns, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("M31 OpenAI acceptance rejects a missing API key before fixture, CLI, or network work", async () => {
  let fixtures = 0;
  let cliRuns = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not run");
  };

  try {
    await assert.rejects(runOpenAIAcceptance(["--live"], dependencies({
      createFixture: async () => { fixtures += 1; throw new Error("fixture must not be created"); },
      runCli: async () => { cliRuns += 1; },
    })), /OPENAI_API_KEY/);
    assert.equal(fixtures, 0);
    assert.equal(cliRuns, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("M31 ChatGPT acceptance rejects an unauthenticated Dragons auth state before fixture or provider work", async () => {
  let statusCalls = 0;
  let fixtures = 0;
  let cliRuns = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not run");
  };

  try {
    await assert.rejects(runChatGPTAcceptance(["--live"], dependencies({
      createFixture: async () => { fixtures += 1; throw new Error("fixture must not be created"); },
      runCli: async () => { cliRuns += 1; },
      createChatGPTAuthService: () => ({
        credentials: { getValidCredentials: async () => { throw new Error("must not resolve credentials"); } },
        login: async () => undefined,
        logout: async () => undefined,
        status: async () => { statusCalls += 1; return { authenticated: false }; },
      }),
    })), /not signed in/);
    assert.equal(statusCalls, 1);
    assert.equal(fixtures, 0);
    assert.equal(cliRuns, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("M31 acceptance cleans its isolated fixture and redacts configured credentials on a provider error", async () => {
  const secret = "M31_TEST_SECRET_VALUE";
  let cleaned = 0;
  let cliDependencies: Parameters<NonNullable<ProviderAcceptanceDependencies["runCli"]>>[1] | undefined;

  await assert.rejects(runOpenAIAcceptance(["--live"], dependencies({
    environment: { OPENAI_API_KEY: secret },
    removeFixture: async () => { cleaned += 1; },
    runCli: async (_arguments, suppliedDependencies) => {
      cliDependencies = suppliedDependencies;
      throw new Error(`provider rejected Authorization: Bearer ${secret}`);
    },
  })), (error: unknown) => {
    assert.match(error instanceof Error ? error.message : "", /Provider acceptance failed/);
    assert.doesNotMatch(error instanceof Error ? error.message : "", new RegExp(secret));
    return true;
  });

  assert.equal(cleaned, 1);
  assert.equal(cliDependencies?.workingDirectory, "/tmp/m31-fixture");
  assert.equal(cliDependencies?.sessionDirectory, "/tmp/m31-fixture/state/sessions");
  assert.equal(cliDependencies?.skillsDirectory, "/tmp/m31-fixture/state/skills");
  assert.equal(cliDependencies?.memoryDirectory, "/tmp/m31-fixture/state/memory");
});

test("M31 acceptance contract requires an isolated verified inspect, approved mutation, approved shell test, tool results, and streamed final response", () => {
  const verification = { sourceIsFixed: true, testIsUnchanged: true, testPassed: true, success: true, testOutput: "pass" };
  const transcript = [
    "\n• read_file\n",
    "\n• write_file\n",
    "\n? Allow WRITE write_file with {}? [y/N] ",
    "\n✓ write_file\n",
    "\n• shell\n",
    "\n? Allow EXECUTE shell with {}? [y/N] ",
    "\n✓ shell\n",
    "Fixed calculator.js and verified the test passes.",
  ].join("");

  assert.doesNotThrow(() => assertProviderAcceptanceContract(verification, transcript));
  assert.throws(() => assertProviderAcceptanceContract(verification, transcript.replace("✓ shell", "✗ shell")), /tool result/i);
  assert.throws(() => assertProviderAcceptanceContract(verification, transcript.replace("Fixed calculator.js and verified the test passes.", "")), /streamed final response/i);
});

test("M31 keeps explicit Skills, bounded Memory, and a Plan deterministic without provider transport", async () => {
  let received: AgentRequest | undefined;
  await runAgent({
    task: "Use the advisory context.",
    tools: [],
    skills: {
      skills: [{ id: "fixture-skill", digest: "a".repeat(64), order: 1, name: "Fixture skill", description: "A deterministic acceptance fixture.", body: "Use the fixture convention." }],
      notices: [],
    },
    memory: {
      memories: [{ id: "11111111-1111-4111-8111-111111111111", body: "Keep changes bounded.", createdAt: "2026-09-03T00:00:00.000Z", scope: { kind: "USER" } }],
      notices: [],
    },
    plan: {
      version: 1,
      tasks: [{ id: "22222222-2222-4222-8222-222222222222", title: "Verify fixture", description: "Run the local acceptance contract.", status: "TODO" }],
    },
    model: {
      async respond(request) {
        received = request;
        return { responseId: "m31-deterministic", text: "Context received.", toolCalls: [] };
      },
    },
  });

  assert.equal(received?.skills?.skills[0]?.body, "Use the fixture convention.");
  assert.equal(received?.memory?.memories[0]?.body, "Keep changes bounded.");
  assert.equal(received?.plan?.tasks[0]?.title, "Verify fixture");
});
