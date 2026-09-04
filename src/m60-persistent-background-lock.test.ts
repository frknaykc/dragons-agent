import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PersistentBackgroundJobManager, createPersistentBackgroundJobStore } from "./persistent-background-jobs.js";
import type { AgentTool } from "./tools.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

const readTool: AgentTool = {
  name: "read_fixture",
  operation: "READ",
  description: "Read deterministic data.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { ok: true, output: "fixture" }; },
};

async function waitForState(manager: PersistentBackgroundJobManager, state: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (manager.show(JOB_ID)?.state === state) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Job did not reach ${state}.`);
}

test("M60 uses a durable exclusive claim so two reloaded managers cannot resume one job twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m60-claim-"));
  let executions = 0;
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    await writeFile(join(directory, `${JOB_ID}.json`), JSON.stringify({
      version: 1, id: JOB_ID, sessionId: SESSION_ID, workingDirectory: directory, prompt: "Read only.", executionPolicy: "READ_ONLY_MANUAL_RESUME", provenance: "INTERACTIVE_COMMAND", state: "interrupted", createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.000Z", revision: 0, executionAttempts: 1, transcript: "", error: "prior exit",
    }));
    const first = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory) });
    const second = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory) });
    await Promise.all([first.initialize(), second.initialize()]);
    const launch = () => ({ createModel: () => ({ async respond() { executions += 1; await pending; return { responseId: "done", text: "done", toolCalls: [] }; } }), tools: [readTool] });
    const outcomes = await Promise.allSettled([first.resume(JOB_ID, launch()), second.resume(JOB_ID, launch())]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    await waitForState(first, "running").catch(() => waitForState(second, "running"));
    for (let attempt = 0; executions === 0 && attempt < 30; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(executions, 1);
  } finally {
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await rm(directory, { recursive: true, force: true });
  }
});
