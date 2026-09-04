import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PersistentBackgroundJobManager, createPersistentBackgroundJobStore } from "./persistent-background-jobs.js";
import type { AgentTool } from "./tools.js";

const ID = "33333333-3333-4333-8333-333333333333";
const SESSION = "11111111-1111-4111-8111-111111111111";
const readTool: AgentTool = { name: "read_fixture", operation: "READ", description: "Read.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { ok: true, output: "ok" }; } };

test("M60 propagates a durable cancellation to the owning runtime without completion overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m60-cancel-"));
  let abortSeen = false;
  try {
    await writeFile(join(directory, `${ID}.json`), JSON.stringify({ version: 1, id: ID, sessionId: SESSION, workingDirectory: directory, prompt: "Read only.", executionPolicy: "READ_ONLY_MANUAL_RESUME", provenance: "INTERACTIVE_COMMAND", state: "interrupted", createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.000Z", revision: 0, executionAttempts: 1, transcript: "", error: "prior exit" }));
    const owner = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory) });
    const manager = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(directory) });
    await Promise.all([owner.initialize(), manager.initialize()]);
    await owner.resume(ID, { createModel: () => ({ async respond({ signal }: { signal?: AbortSignal }) { await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => { abortSeen = true; reject(new Error("aborted")); }, { once: true })); return { responseId: "never", text: "never", toolCalls: [] }; } }), tools: [readTool] });
    for (let i = 0; owner.show(ID)?.state !== "running" && i < 30; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(await manager.cancel(ID), true);
    for (let i = 0; !abortSeen && i < 30; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(abortSeen, true);
    assert.equal((await createPersistentBackgroundJobStore(directory).load(ID))?.state, "cancelled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
