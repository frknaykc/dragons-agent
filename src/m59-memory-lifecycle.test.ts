import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryStore, createProjectMemoryScope, retrieveRelevantMemories } from "./memory.js";
import { parseCliCommand } from "./cli/commands.js";
import { runMemoryCommand } from "./cli/memory-commands.js";

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

test("M59 preserves identity/provenance across update and excludes explicitly expired memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m59-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m59-workspace-"));
  let now = new Date("2026-09-04T00:00:00.000Z");
  try {
    const store = createMemoryStore(directory, { now: () => now, createId: () => IDS.shift()! });
    const project = await createProjectMemoryScope(workspace);
    const manual = await store.add({ body: "Deploy migration carefully", scope: project });
    assert.equal(manual.provenance, "MANUAL");
    assert.deepEqual(retrieveRelevantMemories([{ ...manual, expiresAt: "2000-01-01T00:00:00.000Z" }], "migration", project), []);
    const updated = await store.update(manual.id, { body: "Deploy database migration safely" }, project);
    assert.equal(updated?.id, manual.id);
    assert.equal(updated?.provenance, "MANUAL");
    assert.equal(updated?.body, "Deploy database migration safely");
    assert.deepEqual(retrieveRelevantMemories(await store.list(project), "database migration", project).map((entry) => entry.id), [manual.id]);
    assert.equal(await store.expire(manual.id, "2026-09-04T00:00:01.000Z", project), true);
    now = new Date("2026-09-04T00:00:02.000Z");
    assert.deepEqual(await store.list(project), []);
    assert.deepEqual(retrieveRelevantMemories(await store.list(project), "database migration", project), []);
    assert.equal((await store.cleanup(project)).removed, 1);
    assert.equal((await store.cleanup(project)).removed, 0);

    const suggested = await store.suggest({ body: "Keep database migration provenance", scope: project });
    const accepted = await store.acceptSuggestion(suggested.id);
    assert.equal(accepted?.provenance, "ACCEPTED_SUGGESTION");
    const events = (JSON.parse(await readFile(join(directory, "memories.json"), "utf8")) as { events: Array<{ id: string; type: string; provenance?: string }> }).events.filter((event) => event.id === accepted?.id);
    assert.deepEqual(events.map(({ type, provenance }) => ({ type, provenance })), [{ type: "add", provenance: "ACCEPTED_SUGGESTION" }]);
  } finally {
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});

test("M59 parses explicit, scope-safe lifecycle CLI commands", () => {
  assert.deepEqual(parseCliCommand(["memory", "update", "11111111-1111-4111-8111-111111111111", "project", "updated", "body"]), { kind: "memory", action: "update", id: "11111111-1111-4111-8111-111111111111", body: "updated body", scope: "project" });
  assert.deepEqual(parseCliCommand(["memory", "expire", "11111111-1111-4111-8111-111111111111", "2027-01-01T00:00:00.000Z", "project"]), { kind: "memory", action: "expire", id: "11111111-1111-4111-8111-111111111111", expiresAt: "2027-01-01T00:00:00.000Z", scope: "project" });
  assert.deepEqual(parseCliCommand(["memory", "cleanup", "project"]), { kind: "memory", action: "cleanup", scope: "project" });
});

test("M59 keeps legacy events compatible and cleanup is bounded to its explicit scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m59-legacy-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m59-legacy-workspace-"));
  let now = new Date("2026-09-04T00:00:02.000Z");
  const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
  try {
    const project = await createProjectMemoryScope(workspace);
    await writeFile(join(directory, "memories.json"), JSON.stringify({ version: 1, events: [{ type: "add", id: ids[0], body: "legacy database guidance", createdAt: "2026-09-01T00:00:00.000Z", scope: { kind: "USER" } }] }));
    const store = createMemoryStore(directory, { now: () => now, createId: () => ids[1]! });
    assert.equal((await store.list())[0]?.provenance, undefined);
    const projectMemory = await store.add({ body: "project database guidance", scope: project });
    assert.equal(await store.expire(ids[0]!, "not-a-date", { kind: "USER" }), false);
    assert.equal(await store.expire(ids[0]!, "2026-09-04T00:00:01.000Z", { kind: "USER" }), true);
    assert.equal(await store.expire(projectMemory.id, "2026-09-04T00:00:01.000Z", project), true);
    assert.equal((await store.cleanup(project)).removed, 1);
    assert.equal((await store.get(ids[0]!, { kind: "USER" }))?.id, undefined);
    assert.equal((await store.cleanup({ kind: "USER" })).removed, 1);
  } finally {
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});

test("M59 lifecycle CLI command executes only in the chosen scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m59-cli-"));
  const workspace = await mkdtemp(join(tmpdir(), "dragons-m59-cli-workspace-"));
  try {
    const store = createMemoryStore(directory, { createId: () => "55555555-5555-4555-8555-555555555555" });
    const memory = await store.add("user memory");
    const output: string[] = [];
    await runMemoryCommand({ command: { kind: "memory", action: "update", id: memory.id, body: "updated user memory", scope: "project" }, store, workingDirectory: workspace, write: (text) => output.push(text) });
    assert.match(output.join(""), /not found/);
    assert.equal((await store.get(memory.id))?.body, "user memory");
  } finally {
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  }
});
