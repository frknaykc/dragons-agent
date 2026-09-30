import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SkillCurator } from "../../dist/skill-curator.js";
import { activateSkill, createSkillsContext, listSkills } from "../../dist/skills.js";

const document = "---\nname: Notes\ndescription: Concise summary.\n---\nOnly summarize supplied facts.\n";
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dragons-skill-curator-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("curator counts resolved skills only, persists bounded metadata and offers non-mutating recommendations", async () => fixture(async (root) => {
  const skills = join(root, "skills");
  for (const id of ["a", "b"]) { await mkdir(join(skills, id), { recursive: true }); await writeFile(join(skills, id, "SKILL.md"), document); }
  const active = await activateSkill(skills, [], "a");
  const curator = new SkillCurator(join(root, "state"));
  const initial = new Date("2026-01-01T00:00:00.000Z");
  const context = await createSkillsContext(skills, active);
  await curator.recordResolved(context.skills, initial);
  await curator.recordResolved(context.skills, new Date("2026-01-02T00:00:00.000Z"));
  assert.equal((await curator.usage())[0]?.count, 2);
  assert.deepEqual((await curator.suggest(await listSkills(skills), new Date("2026-08-01T00:00:00.000Z"))).map(({ kind, id, reason }) => ({ kind, id, reason })), [
    { kind: "archive", id: "a", reason: "stale" },
    { kind: "maintenance", id: "b", reason: "unused" },
    { kind: "merge", id: "b", reason: "duplicate" },
  ]);
  const stateText = await readFile(join(root, "state", "skill-curator.json"), "utf8");
  assert.equal(stateText.includes("Only summarize supplied facts"), false);
  assert.equal(stateText.includes("description"), false);
  const reloaded = new SkillCurator(join(root, "state"));
  assert.equal((await reloaded.usage())[0]?.count, 2);
  await writeFile(join(skills, "a", "SKILL.md"), document + "Changed.\n");
  assert.deepEqual((await reloaded.suggest(await listSkills(skills), new Date("2026-08-01T00:00:00.000Z"))).map(({ reason }) => reason), ["changed", "unused"]);
  assert.equal((await createSkillsContext(skills, active)).skills.length, 0);
}));

test("curator rejects corrupt state, invalid input and linked state without rewriting it", async () => fixture(async (root) => {
  const state = join(root, "state");
  await mkdir(state);
  const path = join(state, "skill-curator.json");
  await writeFile(path, '{"version":1,"records":[{"id":"../escape"}]}');
  const curator = new SkillCurator(state);
  await assert.rejects(curator.usage(), /Invalid/);
  await assert.rejects(curator.recordResolved([{ id: "a", digest: "a".repeat(64), order: 1, name: "a", description: "", body: "" }]), /Invalid/);
  assert.match(await readFile(path, "utf8"), /escape/);
  await assert.rejects(curator.suggest([{ id: "../escape", digest: "a".repeat(64), scope: "USER", name: "", description: "", body: "" }]), /Invalid/);
  const outside = join(root, "outside.json");
  await writeFile(outside, "private");
  await unlink(path);
  await symlink(outside, path);
  await assert.rejects(curator.usage());
  await assert.rejects(curator.recordResolved([{ id: "a", digest: "a".repeat(64), order: 1, name: "a", description: "", body: "" }]));
  assert.equal(await readFile(outside, "utf8"), "private");
}));