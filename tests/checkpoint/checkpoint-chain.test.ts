import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { SessionCheckpoints } from "../../dist/checkpoint.js";
import { CheckpointStructuralFs, StructuralMutationFailure } from "../../dist/checkpoint-structural-fs.js";
import { supportedCheckpointTest as checkpointTest } from "./checkpoint-support.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "checkpoint-chain-"));
  const handles: number[] = [];
  t.after(() => { handles.forEach((fd) => fs.closeSync(fd)); fs.rmSync(root, { recursive: true, force: true }); });
  const history = new SessionCheckpoints(root);
  const mutate = (changes: { path: string; content: string | null }[]) => {
    const result = history.mutate(changes); assert.equal(result.ok, true, result.output);
    return /Checkpoint (cp-[\w-]+):/.exec(result.output)![1]!;
  };
  const pin = (path: string) => { handles.push(fs.openSync(join(root, path), "r")); return fs.fstatSync(handles.at(-1)!).ino; };
  const rollback = (id: string, path?: string) => { const result = history.rollback(id, path); assert.equal(result.ok, true, result.output); };
  return { root, history, mutate, pin, rollback };
}
for (const path of ["a", "nested/a"]) for (const operation of ["create", "edit"]) {
  checkpointTest(`${operation}/delete rollback chain preserves actual inode: ${path}`, (t) => {
    const f = fixture(t); fs.mkdirSync(join(f.root, "nested"));
    if (operation === "edit") fs.writeFileSync(join(f.root, path), "seed");
    const c1 = f.mutate([{ path, content: "first" }]);
    const old = f.pin(path);
    const c2 = f.mutate([{ path, content: null }]);
    f.rollback(c2);
    assert.notEqual(fs.statSync(join(f.root, path)).ino, old);
    f.rollback(c1);
    if (operation === "create") assert.equal(fs.existsSync(join(f.root, path)), false);
    else assert.equal(fs.readFileSync(join(f.root, path), "utf8"), "seed");
  });
}
checkpointTest("multiple edit ancestors and selected paths retain their causal chain", (t) => {
  const f = fixture(t);
  const c1 = f.mutate([{ path: "a", content: "one" }, { path: "b", content: "other" }]);
  const c2 = f.mutate([{ path: "a", content: "two" }]);
  f.pin("a"); const c3 = f.mutate([{ path: "a", content: null }]);
  f.rollback(c3); f.rollback(c2); f.rollback(c1, "a");
  assert.equal(fs.readFileSync(join(f.root, "b"), "utf8"), "other");
  f.rollback(c1, "b");
});
checkpointTest("completed recreation before a later structural failure repairs only completed chain", (t) => {
  const f = fixture(t);
  const c1 = f.mutate([{ path: "a", content: "one" }, { path: "b", content: "two" }]);
  const old = f.pin("b"); f.pin("a");
  const c2 = f.mutate([{ path: "a", content: null }, { path: "b", content: null }]);
  const original = CheckpointStructuralFs.prototype.apply;
  const mock = t.mock.method(CheckpointStructuralFs.prototype, "apply", function (this: CheckpointStructuralFs, mutations: Parameters<CheckpointStructuralFs["apply"]>[0]) {
    const completed = original.call(this, mutations.slice(0, 1));
    throw new StructuralMutationFailure("injected later failure", completed, []);
  });
  const result = f.history.rollback(c2); mock.mock.restore();
  assert.equal(result.ok, false); assert.deepEqual(result.changedPaths, ["b"]);
  assert.notEqual(fs.statSync(join(f.root, "b")).ino, old);
  f.rollback(c1, "b"); f.rollback(c2, "a"); f.rollback(c1, "a");
});
checkpointTest("external same-content replacement before deletion is not causally rebound", (t) => {
  const f = fixture(t); const c1 = f.mutate([{ path: "a", content: "one" }]);
  fs.renameSync(join(f.root, "a"), join(f.root, "original"));
  fs.writeFileSync(join(f.root, "a"), "one", { mode: 0o600 }); f.pin("a");
  const c2 = f.mutate([{ path: "a", content: null }]); f.rollback(c2);
  assert.equal(f.history.rollback(c1).ok, false);
});
for (const change of ["bytes", "mode", "topology"] as const) checkpointTest(`rebind requires matching historical ${change}, not only path and inode`, (t) => {
  const f = fixture(t); fs.mkdirSync(join(f.root, "nested"));
  const c1 = f.mutate([{ path: "nested/a", content: "one" }]);
  const old = change === "topology" ? fs.statSync(join(f.root, "nested/a")).ino : f.pin("nested/a");
  if (change === "bytes") fs.writeFileSync(join(f.root, "nested/a"), "external");
  if (change === "mode") fs.chmodSync(join(f.root, "nested/a"), process.platform === "win32" ? 0o444 : 0o640);
  if (change === "topology") {
    fs.renameSync(join(f.root, "nested"), join(f.root, "old-parent"));
    fs.mkdirSync(join(f.root, "nested"));
    fs.renameSync(join(f.root, "old-parent/a"), join(f.root, "nested/a"));
  }
  assert.equal(fs.statSync(join(f.root, "nested/a")).ino, old);
  if (change === "mode" && process.platform === "win32") {
    // Windows denies DELETE on a read-only leaf. Refusal must leave history
    // intact and must not silently rebind the earlier writable generation.
    assert.equal(f.history.mutate([{ path: "nested/a", content: null }]).ok, false);
    assert.equal(f.history.rollback(c1).ok, false);
    return;
  }
  const c2 = f.mutate([{ path: "nested/a", content: null }]); f.rollback(c2);
  assert.equal(f.history.rollback(c1).ok, false);
});
checkpointTest("receipt return followed by replacement never adopts a fresh disk image", (t) => {
  const f = fixture(t); const c1 = f.mutate([{ path: "a", content: "one" }]);
  f.pin("a"); const c2 = f.mutate([{ path: "a", content: null }]);
  const original = CheckpointStructuralFs.prototype.apply;
  const mock = t.mock.method(CheckpointStructuralFs.prototype, "apply", function (this: CheckpointStructuralFs, mutations: Parameters<CheckpointStructuralFs["apply"]>[0]) {
    const completed = original.call(this, mutations);
    fs.renameSync(join(f.root, "a"), join(f.root, "receipt-owned"));
    fs.writeFileSync(join(f.root, "a"), "one", { mode: 0o600 });
    return completed;
  });
  f.rollback(c2); mock.mock.restore();
  assert.equal(f.history.rollback(c1).ok, false);
  assert.equal(fs.readFileSync(join(f.root, "a"), "utf8"), "one");
});
checkpointTest("external same-content replacement after restoration and separate sessions remain conflicts", (t) => {
  const f = fixture(t); const c1 = f.mutate([{ path: "a", content: "one" }]);
  const other = new SessionCheckpoints(f.root);
  assert.equal(other.mutate([{ path: "a", content: "one" }]).ok, true);
  const otherId = other.list().split(":")[0]!;
  f.pin("a"); const c2 = f.mutate([{ path: "a", content: null }]); f.rollback(c2);
  assert.equal(other.rollback(otherId).ok, false);
  fs.renameSync(join(f.root, "a"), join(f.root, "restored"));
  fs.writeFileSync(join(f.root, "a"), "one", { mode: 0o600 });
  assert.equal(f.history.rollback(c1).ok, false);
});
