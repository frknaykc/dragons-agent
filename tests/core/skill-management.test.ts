import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAgent, type AgentModel } from "../../dist/agent.js";
import { SkillManager, createSkillManagementTools } from "../../dist/skill-management.js";
import { listSkills } from "../../dist/skills.js";

const first = "---\nname: Note\ndescription: Write concise notes.\n---\nKeep facts separate from guesses.\n";
const second = "---\nname: Note\ndescription: Write concise notes.\n---\nKeep facts separate from guesses and quote evidence.\n";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dragons-skill-management-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("skill manager validates, creates, edits with digest, archives and deletes without affecting archived copies", async () => withRoot(async (root) => {
  const manager = new SkillManager(root);
  assert.equal((await manager.validate("note", first)).name, "Note");
  const created = await manager.create("note", first);
  assert.equal(created.id, "note");
  await assert.rejects(manager.create("note", first));
  await assert.rejects(manager.edit("note", second, "0".repeat(64)), /changed/);
  const updated = await manager.edit("note", second, created.digest);
  assert.notEqual(updated.digest, created.digest);
  assert.equal((await manager.validate("note")).digest, updated.digest);
  const archiveId = await manager.archive("note", updated.digest);
  assert.equal((await readFile(join(root, ".archive", "note", archiveId, "SKILL.md"), "utf8")), second);
  assert.equal((await listSkills(root)).length, 0);
  const replacement = await manager.create("note", first);
  await manager.delete("note", replacement.digest);
  assert.equal((await listSkills(root)).length, 0);
  assert.equal((await readFile(join(root, ".archive", "note", archiveId, "SKILL.md"), "utf8")), second);
}));

test("skill manager rejects traversal, invalid documents, foreign files and linked skills", async () => withRoot(async (root) => {
  const manager = new SkillManager(root);
  await assert.rejects(manager.create("../escape", first), /Invalid/);
  await assert.rejects(manager.create("note", "missing metadata"), /invalid metadata/);
  await assert.rejects(manager.create("note", first + "x".repeat(17_000)), /size/);
  const skill = await manager.create("note", first);
  await writeFile(join(root, "note", "other.txt"), "keep");
  await assert.rejects(manager.edit("note", second, skill.digest), /other files/);
  await assert.rejects(manager.archive("note", skill.digest), /other files/);
  await assert.rejects(manager.delete("note", skill.digest), /other files/);
  await mkdir(join(root, "linked"));
  await symlink(join(root, "note", "SKILL.md"), join(root, "linked", "SKILL.md"));
  await assert.rejects(manager.validate("linked"));
  await mkdir(join(root, "hardlinked"));
  await link(join(root, "note", "SKILL.md"), join(root, "hardlinked", "SKILL.md"));
  await assert.rejects(manager.validate("hardlinked"));
  assert.equal((await readFile(join(root, "note", "other.txt"), "utf8")), "keep");
}));

test("skill management tools are opt-in and run under runAgent WRITE approval", async () => withRoot(async (root) => {
  const tools = createSkillManagementTools(root);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.operation]), [
    ["skill_create", "WRITE"], ["skill_edit", "WRITE"], ["skill_validate", "READ"],
    ["skill_archive", "WRITE"], ["skill_delete", "WRITE"],
  ]);
  const model: AgentModel = { async respond(request) {
    if (!request.toolOutputs.length) return { responseId: "first", text: "", toolCalls: [{ callId: "create", name: "skill_create", arguments: JSON.stringify({ id: "note", content: first }) }] };
    return { responseId: "end", text: "done", toolCalls: [] };
  } };
  const denied = await runAgent({ task: "fixture", model, tools, workingDirectory: root, authorize: () => false });
  assert.equal(denied.finalText, "done");
  assert.deepEqual(await readdir(root), []);
  let approvals = 0;
  const accepted = await runAgent({ task: "fixture", model, tools, workingDirectory: root, authorize: ({ operation }) => { approvals++; assert.equal(operation, "WRITE"); return true; } });
  assert.equal(accepted.finalText, "done");
  assert.equal(approvals, 1);
  const result = await tools.find((tool) => tool.name === "skill_validate")!.execute({ id: "note" });
  assert.match(result.output, /digest: [a-f0-9]{64}/);
  assert.equal((await lstat(join(root, "note", "SKILL.md"))).isFile(), true);
}));