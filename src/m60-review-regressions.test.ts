import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PersistentBackgroundJobManager, createPersistentBackgroundJobStore } from "./persistent-background-jobs.js";
import type { AgentTool } from "./tools.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const FIRST = "33333333-3333-4333-8333-333333333333";
const SECOND = "44444444-4444-4444-8444-444444444444";
const readTool: AgentTool = { name: "read_fixture", operation: "READ", description: "Read.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "ok" }; } };

async function eventually(assertion: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) { if (assertion()) return; await new Promise<void>((resolve) => setTimeout(resolve, 10)); }
  assert.fail(message);
}

function interrupted(id = FIRST) { return { version: 1, id, sessionId: SESSION, workingDirectory: "/workspace", prompt: "Read only.", executionPolicy: "READ_ONLY_MANUAL_RESUME", provenance: "INTERACTIVE_COMMAND", state: "interrupted", createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.000Z", revision: 0, executionAttempts: 1, transcript: "", error: "prior exit" }; }

test("M60 review regressions bound durable storage, reject raw secrets, and prevent stale replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m60-review-"));
  try {
    const limited = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory, { maxJobs: 1 }), createId: (() => { const ids = [FIRST, SECOND]; return () => ids.shift()!; })() });
    const model = () => ({ async respond() { return { responseId: "ok", text: "ok", toolCalls: [] }; } });
    await limited.start({ sessionId: SESSION, workingDirectory: directory, prompt: "First.", createModel: model, tools: [readTool] });
    await eventually(() => limited.show(FIRST)?.state === "completed", "first job did not finish");
    await assert.rejects(limited.start({ sessionId: SESSION, workingDirectory: directory, prompt: "Second.", createModel: model, tools: [readTool] }), /storage limit/i);
    await assert.rejects(limited.start({ sessionId: SESSION, workingDirectory: directory, prompt: "Use sk-proj-abcdefghijklmnopqrstuvwxyz0123456789.", createModel: model, tools: [readTool] }), /secret/i);

    const staleDirectory = await mkdtemp(join(tmpdir(), "dragons-m60-stale-"));
    try {
      await writeFile(join(staleDirectory, `${FIRST}.json`), JSON.stringify({ ...interrupted(), workingDirectory: staleDirectory }));
      let executions = 0;
      const a = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(staleDirectory) });
      const b = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(staleDirectory) });
      await Promise.all([a.initialize(), b.initialize()]);
      await a.resume(FIRST, { createModel: () => ({ async respond() { executions += 1; return { responseId: "one", text: "one", toolCalls: [] }; } }), tools: [readTool] });
      await eventually(() => a.show(FIRST)?.state === "completed", "first replay did not finish");
      await assert.rejects(b.resume(FIRST, { createModel: () => ({ async respond() { executions += 1; return { responseId: "two", text: "two", toolCalls: [] }; } }), tools: [readTool] }), /changed|not interrupted/i);
      assert.equal(executions, 1);
    } finally { await rm(staleDirectory, { recursive: true, force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
