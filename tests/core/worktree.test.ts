import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedWorktree, selectIsolatedWorktree } from "../../dist/worktree.js";

async function fixture(run: (repo: string, base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "dragons-worktree-"));
  const repo = join(base, "project");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "file.txt"), "committed\n");
    git("add", "file.txt"); git("commit", "-qm", "fixture");
    await run(repo, base);
  } finally { await rm(base, { recursive: true, force: true }); }
}

test("isolated checkout preserves dirty source and switches only registered sibling", async () => fixture(async (repo, base) => {
  await writeFile(join(repo, "file.txt"), "dirty\n");
  await writeFile(join(repo, "untracked.txt"), "keep\n");
  const target = await createIsolatedWorktree(repo, "feature_one");
  assert.equal(target, await realpath(join(base, "project-worktrees", "feature_one")));
  assert.equal(await readFile(join(target, "file.txt"), "utf8"), "committed\n");
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "dirty\n");
  assert.equal(await readFile(join(repo, "untracked.txt"), "utf8"), "keep\n");
  assert.equal(await selectIsolatedWorktree(target, "feature_one"), target);
  await assert.rejects(createIsolatedWorktree(repo, "feature_one"));
  for (const bad of ["../escape", "-bad", "a.b", "x/y", "a b", "é", ""]) {
    await assert.rejects(createIsolatedWorktree(repo, bad));
    await assert.rejects(selectIsolatedWorktree(repo, bad));
  }
}));

test("rejects unrelated and symlink worktree paths", async () => fixture(async (repo, base) => {
  const parent = join(base, "project-worktrees");
  await mkdir(parent);
  await mkdir(join(parent, "unrelated"));
  await assert.rejects(selectIsolatedWorktree(repo, "unrelated"));
  await symlink(repo, join(parent, "alias"));
  await assert.rejects(selectIsolatedWorktree(repo, "alias"));
  await assert.rejects(createIsolatedWorktree(repo, "alias"));
  assert.equal((await lstat(join(parent, "alias"))).isSymbolicLink(), true);
}));

test("refuses symlinked parent without mutating source", async () => fixture(async (repo, base) => {
  await symlink(repo, join(base, "project-worktrees"));
  await assert.rejects(createIsolatedWorktree(repo, "unsafe"));
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "committed\n");
}));

test("configured checkout smudge filters do not execute", async () => fixture(async (repo, base) => {
  const marker = join(base, "executed");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  await writeFile(join(repo, ".gitattributes"), "file.txt filter=trap\n");
  git("add", ".gitattributes"); git("commit", "-qm", "attributes");
  git("config", "filter.trap.smudge", `touch ${marker}`);
  git("config", "filter.trap.required", "true");
  const target = await createIsolatedWorktree(repo, "no_filter");
  assert.equal(await readFile(join(target, "file.txt"), "utf8"), "committed\n");
  await assert.rejects(lstat(marker), { code: "ENOENT" });
}));

test("worktree-specific includeIf smudge filters never run during checkout", async () => fixture(async (repo, base) => {
  const marker = join(base, "executed");
  const target = join(base, "project-worktrees", "conditional");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  await writeFile(join(repo, ".gitattributes"), "file.txt filter=trap\n");
  git("add", ".gitattributes"); git("commit", "-qm", "attributes");
  const included = join(base, "conditional.gitconfig");
  await writeFile(included, `[filter "trap"]\n\tsmudge = touch ${marker.replaceAll("\\", "/")}\n\trequired = true\n`);
  git("config", `includeIf.gitdir:**/worktrees/conditional.path`, included);
  assert.equal(await createIsolatedWorktree(repo, "conditional"), await realpath(target));
  assert.equal(await readFile(join(target, "file.txt"), "utf8"), "committed\n");
  await assert.rejects(lstat(marker), { code: "ENOENT" });
}));
