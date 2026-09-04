import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PersistentBackgroundJobManager, createPersistentBackgroundJobStore } from "./persistent-background-jobs.js";
import type { AgentTool } from "./tools.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ID = "44444444-4444-4444-8444-444444444444";
const readTool: AgentTool = { name: "read_fixture", operation: "READ", description: "Read.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "ok" }; } };

async function waitFor(manager: PersistentBackgroundJobManager, id: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) { if (manager.show(id)?.state === state) return; await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
  assert.fail(`Job ${id} did not reach ${state}.`);
}

test("M60 enforces bounded active jobs and converts duration exhaustion into a terminal failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m60-bounds-"));
  const ids = [FIRST_ID, SECOND_ID];
  try {
    const manager = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory), createId: () => ids.shift()!, maxActiveJobs: 1, maxDurationMs: 20 });
    const blockingModel = () => ({ async respond({ signal }: { signal?: AbortSignal }) { await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); return { responseId: "never", text: "never", toolCalls: [] }; } });
    await manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Bounded read.", createModel: blockingModel, tools: [readTool] });
    await waitFor(manager, FIRST_ID, "running");
    await assert.rejects(manager.start({ sessionId: SESSION_ID, workingDirectory: directory, prompt: "Second bounded read.", createModel: blockingModel, tools: [readTool] }), /concurrency limit/i);
    await waitFor(manager, FIRST_ID, "failed");
    assert.match(manager.show(FIRST_ID)?.error ?? "", /duration limit/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
