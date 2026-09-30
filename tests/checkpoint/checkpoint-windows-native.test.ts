import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCheckpoints } from "../../dist/checkpoint.js";
import { closeCheckpoint, directoryNoFollow, openCheckpoint, safeCheckpointIoAvailable, statCheckpoint } from "../../dist/checkpoint-win32.js";

test("Windows checkpoint captures, changes, and restores disposable files", { skip: process.platform !== "win32" }, (t) => {
  assert.equal(safeCheckpointIoAvailable, true, "Windows native binding must load in the build");
  const root = fs.mkdtempSync(join(tmpdir(), "dragons-win-checkpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, "nested"));
  fs.writeFileSync(join(root, "nested", "edit.txt"), "before");
  const history = new SessionCheckpoints(root);
  const result = history.mutate([
    { path: "nested/edit.txt", content: "after" },
    { path: "new.txt", content: "created" },
  ]);
  assert.equal(result.ok, true, result.output);
  assert.equal(fs.readFileSync(join(root, "nested", "edit.txt"), "utf8"), "after");
  const id = /Checkpoint (cp-[\w-]+):/.exec(result.output)?.[1];
  assert.ok(id);
  const undone = history.rollback(id);
  assert.equal(undone.ok, true, undone.output);
  assert.equal(fs.readFileSync(join(root, "nested", "edit.txt"), "utf8"), "before");
  assert.equal(fs.existsSync(join(root, "new.txt")), false);
});

test("Windows checkpoint refuses junctions and replacement before write", { skip: process.platform !== "win32" }, (t) => {
  assert.equal(safeCheckpointIoAvailable, true, "Windows native binding must load in the build");
  const root = fs.mkdtempSync(join(tmpdir(), "dragons-win-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = fs.mkdtempSync(join(tmpdir(), "dragons-win-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(join(outside, "untouched.txt"), "outside");
  fs.symlinkSync(outside, join(root, "junction"), "junction");
  const history = new SessionCheckpoints(root);
  const refused = history.mutate([{ path: "junction/untouched.txt", content: "unsafe" }]);
  assert.equal(refused.ok, false);
  assert.equal(fs.readFileSync(join(outside, "untouched.txt"), "utf8"), "outside");
  assert.equal(history.list().startsWith("No checkpoints"), true);
  fs.writeFileSync(join(root, "item.txt"), "before");
  const first = history.mutate([{ path: "item.txt", content: "after" }]);
  assert.equal(first.ok, true, first.output);
  fs.renameSync(join(root, "item.txt"), join(root, "previous.txt"));
  fs.writeFileSync(join(root, "item.txt"), "after");
  const id = /Checkpoint (cp-[\w-]+):/.exec(first.output)?.[1];
  assert.ok(id);
  assert.equal(history.rollback(id).ok, false);
  assert.equal(fs.readFileSync(join(root, "item.txt"), "utf8"), "after");
});

test("Windows checkpoint pins ancestors and retains exact file IDs while a handle is open", { skip: process.platform !== "win32" }, (t) => {
  assert.equal(safeCheckpointIoAvailable, true);
  const root = fs.mkdtempSync(join(tmpdir(), "dragons-win-pin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, "nested"));
  const file = join(root, "nested", "item.txt");
  fs.writeFileSync(file, "unchanged");
  const rootInfo = directoryNoFollow(root);
  assert.equal(rootInfo.fileId, fs.lstatSync(root, { bigint: true }).ino.toString());
  const handle = openCheckpoint(file, fs.constants.O_RDWR);
  try {
    assert.equal(statCheckpoint(handle).fileId, fs.lstatSync(file, { bigint: true }).ino.toString());
    assert.throws(() => fs.renameSync(join(root, "nested"), join(root, "moved")));
    assert.equal(fs.readFileSync(file, "utf8"), "unchanged");
  } finally { closeCheckpoint(handle); }
  fs.renameSync(join(root, "nested"), join(root, "moved"));
  assert.equal(fs.readFileSync(join(root, "moved", "item.txt"), "utf8"), "unchanged");
});
