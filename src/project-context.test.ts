import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverProjectContext } from "./project-context.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dragons-agent-project-context-"));
}

function git(directory: string, arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: directory, encoding: "utf8" }).trim();
}

async function initializeRepository(): Promise<string> {
  const directory = await workspace();
  git(directory, ["init"]);
  git(directory, ["config", "user.name", "Dragons Test"]);
  git(directory, ["config", "user.email", "dragons-test@example.invalid"]);
  await writeFile(join(directory, "tracked.txt"), "clean\n", "utf8");
  git(directory, ["add", "tracked.txt"]);
  git(directory, ["commit", "-m", "Initial fixture"]);
  return directory;
}

test("project instruction discovery uses the first root-local file in priority order", async () => {
  const directory = await workspace();
  try {
    await Promise.all([
      writeFile(join(directory, ".hermes.md"), "Hermes instructions", "utf8"),
      writeFile(join(directory, "AGENTS.md"), "Agents instructions", "utf8"),
      writeFile(join(directory, "CLAUDE.md"), "Claude instructions", "utf8"),
      writeFile(join(directory, ".cursorrules"), "Cursor instructions", "utf8"),
    ]);

    const context = await discoverProjectContext(directory);

    assert.deepEqual(context.instructions, {
      path: ".hermes.md",
      content: "Hermes instructions",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project instruction discovery falls back to AGENTS.md and tolerates no instruction file", async () => {
  const withAgents = await workspace();
  const withoutInstructions = await workspace();
  try {
    await writeFile(join(withAgents, "AGENTS.md"), "Follow local conventions.", "utf8");

    assert.deepEqual((await discoverProjectContext(withAgents)).instructions, {
      path: "AGENTS.md",
      content: "Follow local conventions.",
    });
    assert.equal((await discoverProjectContext(withoutInstructions)).instructions, undefined);
  } finally {
    await Promise.all([
      rm(withAgents, { recursive: true, force: true }),
      rm(withoutInstructions, { recursive: true, force: true }),
    ]);
  }
});

test("project instruction discovery stays in the active root and rejects escaping symlinks", async () => {
  const parent = await workspace();
  const nested = join(parent, "nested");
  const outside = await workspace();
  await mkdir(nested);
  await writeFile(join(parent, ".hermes.md"), "Parent instructions", "utf8");
  await writeFile(join(outside, ".hermes.md"), "Outside instructions", "utf8");
  await writeFile(join(nested, "AGENTS.md"), "Nested instructions", "utf8");
  await symlink(join(outside, ".hermes.md"), join(nested, ".hermes.md"));

  try {
    assert.deepEqual((await discoverProjectContext(nested)).instructions, {
      path: "AGENTS.md",
      content: "Nested instructions",
    });
  } finally {
    await Promise.all([
      rm(parent, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("project context reports non-git, clean, dirty, and detached repository states without mutation", async () => {
  const nonGitDirectory = await workspace();
  const repository = await initializeRepository();
  try {
    assert.deepEqual((await discoverProjectContext(nonGitDirectory)).git, { isRepository: false });

    const branch = git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const repositoryRoot = await realpath(repository);
    const clean = await discoverProjectContext(repository);
    assert.deepEqual(clean.git, {
      isRepository: true,
      repositoryRoot,
      branch,
      dirty: false,
      changedFiles: [],
      changedFileCount: 0,
    });

    await writeFile(join(repository, "tracked.txt"), "dirty\n", "utf8");
    const dirty = await discoverProjectContext(repository);
    assert.equal(dirty.git?.dirty, true);
    assert.deepEqual(dirty.git?.changedFiles, ["tracked.txt"]);
    assert.equal(dirty.git?.changedFileCount, 1);

    git(repository, ["checkout", "--detach"]);
    const detached = await discoverProjectContext(repository);
    assert.equal(detached.git?.isRepository, true);
    assert.equal(detached.git?.branch, undefined);
  } finally {
    await Promise.all([
      rm(nonGitDirectory, { recursive: true, force: true }),
      rm(repository, { recursive: true, force: true }),
    ]);
  }
});
