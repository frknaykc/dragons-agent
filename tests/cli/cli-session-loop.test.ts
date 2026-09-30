import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { main } from "../../dist/cli.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createSessionStore, type SessionStore } from "../../dist/session-store.js";
import type { AgentRequest } from "../../dist/agent.js";

test("CLI Loop persists a timed READ-only turn and hands its continuation back to foreground input", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-loop-"));
  const input = new PassThrough();
  const output: string[] = [];
  const requests: AgentRequest[] = [];
  let calls = 0;
  let completed!: () => void;
  const saved = new Promise<void>((resolve) => { completed = resolve; });
  const base = createSessionStore(join(root, "sessions"), { providerIds: ["local"] });
  const store: SessionStore = { ...base, async mutate(id, operation) {
    const next = await base.mutate!(id, operation);
    if (next && next.messages.length >= 4) completed();
    return next;
  } };
  const registry = createProviderRegistry([{
    id: "local", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      requests.push(request);
      calls++;
      return { responseId: `turn-${calls}`, text: `answer-${calls}`, toolCalls: [] };
    } }),
  }]);
  try {
    const run = main(["--provider", "local"], {
      workingDirectory: root, configPath: join(root, "config.json"), sessionStore: store,
      memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
      backgroundJobsDirectory: join(root, "jobs"), providerRegistry: registry, tools: [], input,
      write: (text) => { output.push(text); },
    });
    input.write("first\n/loop start 1 1 -- inspect workspace\n");
    const timeout = new AbortController();
    try {
      await Promise.race([saved, delay(6_000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(`Timed turn did not persist: ${output.join("")}`);
      })]);
    } finally { timeout.abort(); }
    await delay(75); // Persistence precedes the runtime's completion event and timer bookkeeping.
    input.write("/loop status\nthird\n/exit\n");
    input.end();
    await run;
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.task), ["first", "inspect workspace", "third"]);
    assert.equal(requests[1]!.conversationResponseId, "turn-1");
    assert.equal(requests[2]!.conversationResponseId, "turn-2");
    assert.ok(requests[1]!.tools.every((tool) => tool.operation === "READ"));
    assert.ok(requests[1]!.tools.length > 0);
    assert.match(output.join(""), /Loop\/Heartbeat: stopped; completed: 1; active: false; failures: 0; last report: answer-2/);
    const [session] = await store.list();
    assert.equal(session!.messages.length, 6);
    assert.equal(session!.continuation?.responseId, "turn-3");
  } finally { input.destroy(); await rm(root, { recursive: true, force: true }); }
});

test("CLI rejects malformed Loop commands and cancels a pending Heartbeat on foreground input", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-loop-cancel-"));
  const output: string[] = [];
  let calls = 0;
  const registry = createProviderRegistry([{
    id: "local", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond() { calls++; return { responseId: "unexpected", text: "unexpected", toolCalls: [] }; } }),
  }]);
  try {
    await main(["--provider", "local"], {
      workingDirectory: root, configPath: join(root, "config.json"),
      sessionDirectory: join(root, "sessions"), memoryDirectory: join(root, "memory"),
      skillsDirectory: join(root, "skills"), backgroundJobsDirectory: join(root, "jobs"),
      providerRegistry: registry, tools: [],
      input: PassThrough.from(["/loop start 0 1 -- wrong\n/heartbeat start 1 3 2 -- inspect\n/new\n/loop status\n/exit\n"]),
      write: (text) => { output.push(text); },
    });
    assert.equal(calls, 0);
    assert.match(output.join(""), /Usage: \/loop/);
    assert.match(output.join(""), /Heartbeat started/);
    assert.match(output.join(""), /stopped for interactive input/);
    assert.match(output.join(""), /No Loop\/Heartbeat for this session/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI exit cancels an in-flight unattended turn without saving an answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cli-loop-abort-"));
  const input = new PassThrough();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = false;
  const store = createSessionStore(join(root, "sessions"), { providerIds: ["local"] });
  const registry = createProviderRegistry([{
    id: "local", label: "Fixture", defaultModel: "fixture", credentialRequirement: "none",
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request) {
      started();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
      });
    } }),
  }]);
  try {
    const run = main(["--provider", "local"], {
      workingDirectory: root, configPath: join(root, "config.json"), config: {}, sessionStore: store,
      memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
      providerRegistry: registry, tools: [], input, write: () => {},
    });
    input.write("/loop start 1 1 -- inspect workspace\n");
    const timeout = new AbortController();
    try {
      await Promise.race([running, delay(4_000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error("Timed turn did not start.");
      })]);
    } finally { timeout.abort(); }
    input.end("/exit\n");
    await run;
    assert.equal(cancelled, true);
    const [session] = await store.list();
    assert.deepEqual(session!.messages, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
