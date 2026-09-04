import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryContext,
  createProjectMemoryScope,
  formatMemoryForInstructions,
  retrieveRelevantMemories,
  type DragonsMemory,
} from "./memory.js";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-866666666666",
  "77777777-7777-4777-877777777777",
  "88888888-8888-4888-888888888888",
  "99999999-9999-4999-899999999999",
] as const;

function memory(id: string, body: string, createdAt: string, scope: DragonsMemory["scope"] = { kind: "USER" }): DragonsMemory {
  return { id, body, createdAt, scope };
}

test("M58 retrieves only deterministic lexical matches from USER and current PROJECT scope", async () => {
  const currentProject = await createProjectMemoryScope(process.cwd());
  const otherProject = { kind: "PROJECT" as const, workspaceId: "a".repeat(64) };
  const memories = [
    memory(IDS[0], "Postgres migrations must be applied before verification.", "2026-09-01T00:00:00.000Z"),
    memory(IDS[1], "The garden watering schedule is on Saturday.", "2026-09-01T00:00:01.000Z"),
    memory(IDS[2], "Project database migrations run before UI verification.", "2026-09-01T00:00:02.000Z", currentProject),
    memory(IDS[3], "Other workspace database migration guidance.", "2026-09-01T00:00:03.000Z", otherProject),
  ];

  const result = retrieveRelevantMemories(memories, "Verify database migrations", currentProject);
  assert.deepEqual(result.map((entry) => entry.id), [IDS[2], IDS[0]]);
  assert.deepEqual(retrieveRelevantMemories(memories, "unrelated astronomy question", currentProject), []);
});

test("M58 ranking ties, result count, content cap, and advisory context are deterministic and bounded", async () => {
  const currentProject = await createProjectMemoryScope(process.cwd());
  const memories = IDS.map((id, index) => memory(id, `deploy service-${index} ${"x".repeat(32)}`, `2026-09-01T00:00:0${index}.000Z`));
  const first = retrieveRelevantMemories(memories, "deploy", currentProject, { maxRecords: 3, maxCharacters: 100 });
  const second = retrieveRelevantMemories([...memories].reverse(), "deploy", currentProject, { maxRecords: 3, maxCharacters: 100 });

  assert.deepEqual(first.map((entry) => entry.id), [IDS[0], IDS[1]]);
  assert.deepEqual(second.map((entry) => entry.id), [IDS[0], IDS[1]]);
  assert.ok(first.length <= 3);
  assert.ok(first.reduce((total, entry) => total + entry.body.length, 0) <= 100);
  const instructions = formatMemoryForInstructions(createMemoryContext(first, 800))!;
  assert.match(instructions, /advisory-only/i);
  assert.doesNotMatch(instructions, /service-2/);
});

test("M58 rejects invalid retrieval limits without changing stored memory", async () => {
  const currentProject = await createProjectMemoryScope(process.cwd());
  const memories = [memory(IDS[0], "deploy safely", "2026-09-01T00:00:00.000Z")];
  assert.throws(() => retrieveRelevantMemories(memories, "deploy", currentProject, { maxRecords: 0 }), /positive integer/i);
  assert.throws(() => retrieveRelevantMemories(memories, "deploy", currentProject, { maxCharacters: 0 }), /positive integer/i);
  assert.deepEqual(memories.map((entry) => entry.id), [IDS[0]]);
});

test("M58 excludes common-word-only false positives with host-independent normalization", async () => {
  const currentProject = await createProjectMemoryScope(process.cwd());
  const memories = [
    memory(IDS[0], "Keep the notes for the future.", "2026-09-01T00:00:00.000Z"),
    memory(IDS[1], "Deploy database migrations before release.", "2026-09-01T00:00:01.000Z"),
  ];
  assert.deepEqual(retrieveRelevantMemories(memories, "Prepare the release", currentProject).map((entry) => entry.id), [IDS[1]]);
});

test("M58 excludes uppercase Turkish stopwords without locale-dependent token splits", async () => {
  const currentProject = await createProjectMemoryScope(process.cwd());
  const uppercase = [memory(IDS[0], "İÇİN", "2026-09-01T00:00:00.000Z")];
  const lowercase = [memory(IDS[1], "için", "2026-09-01T00:00:01.000Z")];
  assert.deepEqual(retrieveRelevantMemories(uppercase, "İÇİN", currentProject), []);
  assert.deepEqual(retrieveRelevantMemories(lowercase, "için", currentProject), []);
});
