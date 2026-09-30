import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SkillHub } from "../../dist/skill-hub.js";
import { activateSkill, createSkillsContext } from "../../dist/skills.js";

const withRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "dragons-hub-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test("bundled skill hub discovers, installs, updates and removes advisory documents", async () => {
  await withRoot(async (root) => {
    const dir = join(root, "skills");
    const hub = new SkillHub(dir);
    assert.deepEqual(hub.listSources(), ["bundled"]);
    assert.deepEqual(hub.list().map((entry) => entry.version), ["1.0.0", "1.1.0"]);
    assert.deepEqual(await hub.listInstalled(), []);
    const original = await hub.install("bundled", "quick-notes", "1.0.0");
    assert.equal(original.scope, "USER");
    assert.equal(original.name, "Quick Notes");
    let active = await activateSkill(dir, [], "quick-notes");
    assert.equal(active[0]?.digest, original.digest);
    await assert.rejects(hub.install("bundled", "quick-notes", "1.1.0"), /EEXIST/);
    const updated = await hub.update("bundled", "quick-notes", "1.1.0");
    assert.notEqual(updated.digest, original.digest);
    assert.deepEqual((await hub.listInstalled()).map(({ version }) => version), ["1.1.0"]);
    const stale = await createSkillsContext(dir, active);
    assert.equal(stale.skills.length, 0);
    assert.ok(stale.notices.length > 0);
    active = await activateSkill(dir, active, "quick-notes");
    assert.equal(active[0]?.digest, updated.digest);
    await assert.rejects(hub.update("bundled", "quick-notes", "1.0.0"), /cannot downgrade/);
    await hub.remove("quick-notes");
    assert.deepEqual(await hub.listInstalled(), []);
  });
});

test("skill hub rejects malformed source, tampered install, symlinks, hardlinks and foreign files", async () => {
  await withRoot(async (root) => {
    const dir = join(root, "skills");
    const hub = new SkillHub(dir);
    await assert.rejects(hub.install("bundled", "../bad", "1.0.0"), /not found/);
    await hub.install("bundled", "quick-notes", "1.0.0");
    const path = join(dir, "quick-notes", "SKILL.md");
    const original = await readFile(path);
    await writeFile(path, "tampered");
    await assert.rejects(hub.update("bundled", "quick-notes", "1.1.0"), /unchanged hub-managed/);
    await assert.rejects(hub.remove("quick-notes"), /unchanged hub-managed/);
    assert.equal(await readFile(path, "utf8"), "tampered");
    await writeFile(path, original);
    await writeFile(join(dir, "quick-notes", "user.txt"), "keep");
    await assert.rejects(hub.update("bundled", "quick-notes", "1.1.0"), /other files/);
    await assert.rejects(hub.remove("quick-notes"), /other files/);
    assert.equal(await readFile(join(dir, "quick-notes", "user.txt"), "utf8"), "keep");
    const outside = join(root, "outside");
    await writeFile(outside, original);
    await unlink(path);
    await link(outside, path);
    await assert.rejects(hub.remove("quick-notes"), /unlinked regular file/);
    await unlink(path);
    await symlink(outside, path);
    await assert.rejects(hub.update("bundled", "quick-notes", "1.1.0"));
    assert.deepEqual(await readFile(outside), original);
  });
});

test("skill hub accepts a host-registered local source only with pinned digest and validated content", async () => {
  await withRoot(async (root) => {
    const directory = join(root, "source");
    await mkdir(join(directory, "local-notes", "1.0.0"), { recursive: true });
    const bytes = Buffer.from("---\nname: Local Notes\ndescription: Keep local notes brief.\n---\nSummarize.\n");
    const file = join(directory, "local-notes", "1.0.0", "SKILL.md");
    await writeFile(file, bytes);
    const record = { source: "local", id: "local-notes", version: "1.0.0", sha256: createHash("sha256").update(bytes).digest("hex") };
    const hub = new SkillHub(join(root, "skills"), [{ id: "local", directory, entries: [record] }]);
    assert.equal((await hub.install("local", "local-notes", "1.0.0")).name, "Local Notes");
    await hub.remove("local-notes");
    await writeFile(file, "changed");
    await assert.rejects(hub.install("local", "local-notes", "1.0.0"), /pinned record/);
    await writeFile(file, bytes);
    await unlink(file);
    await symlink(join(root, "missing"), file);
    await assert.rejects(hub.install("local", "local-notes", "1.0.0"));
  });
});
