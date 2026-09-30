import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTrustedDesktopWorkspaceArg, selectDesktopWorkspace } from "../../dist/desktop/workspace.js";

test("M77 packaged workspace requires native selection and never falls back to launch cwd", async () => {
  let selected = 0;
  const result = await selectDesktopWorkspace({ packaged: true, workingDirectory: process.cwd(),
    selectDirectory: async () => { selected++; return undefined; } });
  assert.equal(result, undefined);
  assert.equal(selected, 1);
});

test("M77 workspace accepts selected directories, rejects files, preserves development cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-workspace-"));
  try {
    const file = join(root, "not-a-directory");
    await writeFile(file, "fixture");
    assert.equal(await selectDesktopWorkspace({ packaged: true, workingDirectory: "/not-used",
      selectDirectory: async () => root }), await realpath(root));
    await assert.rejects(selectDesktopWorkspace({ packaged: true, workingDirectory: root,
      selectDirectory: async () => file }), /must be a directory/);
    assert.equal(await selectDesktopWorkspace({ packaged: false, workingDirectory: root,
      selectDirectory: async () => { throw new Error("Development should not prompt"); } }), await realpath(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("packaged launch accepts only one explicit absolute host workspace without opening the native dialog", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-trusted-workspace-"));
  try {
    assert.equal(parseTrustedDesktopWorkspaceArg([]), undefined);
    assert.equal(parseTrustedDesktopWorkspaceArg([`--workspace=${root}`]), root);
    assert.throws(() => parseTrustedDesktopWorkspaceArg(["--workspace=relative"]), /absolute/);
    assert.throws(() => parseTrustedDesktopWorkspaceArg(["--workspace"]), /absolute/);
    assert.throws(() => parseTrustedDesktopWorkspaceArg([`--workspace=${root}`, `--workspace=${root}`]), /one/);
    assert.throws(() => parseTrustedDesktopWorkspaceArg(["--workspace=../sibling"]), /absolute/);
    const trustedWorkspace = parseTrustedDesktopWorkspaceArg([`--workspace=${root}`]);
    assert.equal(await selectDesktopWorkspace({ packaged: true, workingDirectory: resolve(root, "wrong"), trustedWorkspace,
      selectDirectory: async () => { throw new Error("Trusted host path must not open a dialog"); } }), await realpath(root));
    await assert.rejects(selectDesktopWorkspace({ packaged: true, workingDirectory: root, trustedWorkspace: join(root, "missing"),
      selectDirectory: async () => root }), /ENOENT/);
    await assert.rejects(selectDesktopWorkspace({ packaged: true, workingDirectory: root, trustedWorkspace: "relative",
      selectDirectory: async () => root }), /absolute/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
