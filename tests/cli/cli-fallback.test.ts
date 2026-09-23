import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { main, type CliDependencies } from "../../dist/cli.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { ProviderRequestFailureBoundary } from "../../dist/provider/compatibility.js";
import { createSessionStore, type SessionStore } from "../../dist/session-store.js";
import type { AgentRequest } from "../../dist/agent.js";
import { RuntimeDiagnosticsService } from "../../dist/diagnostics.js";

function unavailable(): Error {
  const boundary = new ProviderRequestFailureBoundary();
  boundary.httpFailure(503, null);
  return boundary.finish(new Error("fixture unavailable"));
}

async function fixture(mode: "success" | "adoption-failure" | "target-failure" | "cancel" = "success") {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-fallback-"));
  const diagnostics = new RuntimeDiagnosticsService();
  const output: string[] = [];
  const requests: AgentRequest[] = [];
  let primaryCalls = 0;
  let targetCalls = 0;
  let transitions = 0;
  const store = createSessionStore(join(root, "sessions"), { providerIds: ["openai-api", "local"] });
  const sessionStore: SessionStore = { ...store, async mutate(id, operation) {
    return store.mutate!(id, async (current) => {
      const next = await operation(current);
      if (next.provider !== current.provider) {
        transitions++;
        if (mode === "adoption-failure" && transitions === 1) throw new Error("fixture adoption failure");
      }
      return next;
    }).then((saved) => {
      if (mode === "cancel" && transitions === 1) { transitions++; process.emit("SIGINT"); }
      return saved;
    });
  } };
  const capabilities = { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false };
  const registry = createProviderRegistry([
    { id: "openai-api", label: "Primary", defaultModel: "primary-model", credentialRequirement: "none", capabilities,
      createModel: () => ({ async respond() { primaryCalls++; throw unavailable(); } }) },
    { id: "local", label: "Target", defaultModel: "target-model", credentialRequirement: "none", capabilities,
      createModel: () => ({ async respond(request) {
        targetCalls++;
        requests.push(request);
        assert.match(output.join(""), /Provider fallback: local · target-model/);
        const sessions = await store.list();
        if (sessions.length) {
          assert.equal(sessions[0]!.provider, "local");
          assert.equal(sessions[0]!.model, "target-model");
        }
        if (mode === "target-failure" && targetCalls === 1) throw new Error("fixture target failure");
        return { responseId: `target-${targetCalls}`, text: "target answer", toolCalls: [] };
      } }) },
  ]);
  const dependencies: CliDependencies = {
    workingDirectory: root, configPath: join(root, "config.json"), tools: [], sessionStore,
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"), backgroundJobsDirectory: join(root, "jobs"),
    providerRegistry: registry, diagnostics,
    config: { fallback: { enabled: true, consent: "allow-context-sharing", targets: [{ provider: "local", model: "target-model" }] } },
    write: (text) => { output.push(text); },
  };
  return { root, store, diagnostics, dependencies, output, requests, counts: () => ({ primaryCalls, targetCalls }),
    run: (lines: string, args: string[] = []) => main(args, { ...dependencies, tools: [], input: Readable.from([lines]) }),
    close: () => rm(root, { recursive: true, force: true }) };
}

test("CLI fallback persists target before call, saves and resumes with target continuation", async () => {
  const f = await fixture();
  try {
    await f.run("hello\n/session\n/exit\n");
    assert.equal(f.diagnostics.recent()[0]!.provider, "local");
    assert.equal(f.diagnostics.recent()[0]!.model, "target-model");
    const [saved] = await f.store.list();
    assert.equal(saved!.provider, "local");
    assert.equal(saved!.continuation!.responseId, "target-1");
    assert.equal(saved!.messages.length, 2);
    await f.run("again\n/exit\n", ["session", "resume", saved!.id]);
    assert.equal(f.requests.length, 2, f.output.join(""));
    assert.equal(f.requests[1]!.conversationResponseId, "target-1");
    assert.deepEqual(f.counts(), { primaryCalls: 1, targetCalls: 2 });
    assert.equal((await f.store.load(saved!.id))!.continuation!.responseId, "target-2");
  } finally { await f.close(); }
});

for (const mode of ["adoption-failure", "target-failure", "cancel"] as const) {
  test(`CLI ${mode} does not reuse a stale fallback wrapper`, async () => {
    const f = await fixture(mode);
    try {
      await f.run("first\nsecond\n/exit\n");
      const first = f.diagnostics.recent().at(-1)!;
      assert.equal(first.provider, mode === "adoption-failure" ? "openai-api" : "local");
      assert.equal(first.model, mode === "adoption-failure" ? "primary-model" : "target-model");
      assert.equal(first.status, mode === "cancel" ? "cancelled" : "failed");
      assert.deepEqual(f.counts(), { primaryCalls: mode === "adoption-failure" ? 2 : 1, targetCalls: mode === "target-failure" ? 2 : 1 });
      const [saved] = await f.store.list();
      assert.equal(saved!.provider, "local");
      assert.equal(saved!.messages.length, 2);
      assert.doesNotMatch(f.output.join(""), /cannot be reused|Active session workspace, provider, or model changed/);
    } finally { await f.close(); }
  });
}

test("plain CLI announces fallback before target call without creating a session", async () => {
  const f = await fixture();
  try {
    await f.run("", ["hello"]);
    assert.deepEqual(f.counts(), { primaryCalls: 1, targetCalls: 1 });
    assert.deepEqual(await f.store.list(), []);
    assert.equal(f.diagnostics.recent()[0]!.provider, "local");
    assert.equal(f.diagnostics.recent()[0]!.model, "target-model");
  } finally { await f.close(); }
});

for (const mode of ["target-failure", "cancel"] as const) {
  test(`plain CLI ${mode} reports adopted diagnostics identity`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(main(["hello"], { ...f.dependencies, input: Readable.from([]),
        write: (text) => {
          f.output.push(text);
          if (mode === "cancel" && text.startsWith("Provider fallback:")) process.emit("SIGINT");
        },
      }));
      const [summary] = f.diagnostics.recent();
      assert.equal(summary!.provider, "local");
      assert.equal(summary!.model, "target-model");
      assert.equal(summary!.status, mode === "cancel" ? "cancelled" : "failed");
      assert.equal(f.counts().targetCalls, mode === "cancel" ? 0 : 1);
      assert.doesNotMatch(JSON.stringify(summary), /fixture|hello|context sharing/);
    } finally { await f.close(); }
  });
}

test("injected CLI model bypasses registry fallback", async () => {
  const f = await fixture();
  try {
    await main(["hello"], { ...f.dependencies, input: Readable.from([]),
      model: { async respond() { return { responseId: "injected", text: "injected", toolCalls: [] }; } } });
    assert.deepEqual(f.counts(), { primaryCalls: 0, targetCalls: 0 });
    assert.doesNotMatch(f.output.join(""), /Provider fallback/);
  } finally { await f.close(); }
});
