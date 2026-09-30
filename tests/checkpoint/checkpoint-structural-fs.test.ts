import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { CheckpointStructuralFs, reverseStructural, StructuralMutationFailure, STRUCTURAL_MAX_FILE } from "../../dist/checkpoint-structural-fs.js";
import { checkpointIo, type CheckpointHandle } from "../../dist/checkpoint-win32.js";
import { supportedCheckpointTest as checkpointTest } from "./checkpoint-support.js";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "structural-checkpoint-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, "nested"));
  const file = (path: string, value: string) => fs.writeFileSync(join(root, path), value, { mode: 0o600 });
  const read = (path: string) => fs.readFileSync(join(root, path), "utf8");
  return { root, file, read, store: new CheckpointStructuralFs(root) };
}
const desired = (value: string | null) => ({ bytes: value === null ? null : Buffer.from(value), mode: value === null ? 0 : 0o600 });

checkpointTest("mixed nested create/edit/delete produces owned receipts and selective reverse conflicts", (t) => {
  const { store, file, read, root } = fixture(t);
  file("nested/edit", "old"); file("delete", "gone");
  const receipts = store.apply([
    { expected: store.capture("nested/new"), desired: desired("new") },
    { expected: store.capture("nested/edit"), desired: desired("updated") },
    { expected: store.capture("delete"), desired: desired(null) },
  ]);
  assert.equal(receipts[0]!.before.image.kind, "absent");
  assert.equal(receipts[0]!.after.image.kind, "present");
  assert.equal(receipts[2]!.after.image.kind, "absent");
  assert.equal(read("nested/new"), "new");
  file("nested/edit", "external");
  assert.throws(() => store.apply(reverseStructural(receipts)), /conflict/);
  assert.equal(read("nested/new"), "new"); // whole selection preflight refused
  const restored = store.apply(reverseStructural([receipts[0]!, receipts[2]!]));
  assert.equal(restored.length, 2);
  assert.equal(fs.existsSync(join(root, "nested/new")), false);
  assert.equal(read("delete"), "gone");
  assert.equal(read("nested/edit"), "external");
  store.apply(reverseStructural(restored)); // use fresh identities after recreation
  assert.equal(read("nested/new"), "new");
  assert.equal(fs.existsSync(join(root, "delete")), false);
});

checkpointTest("expected absence refuses later creation and delete rollback refuses occupied name", (t) => {
  const { store, file, read } = fixture(t);
  const expected = store.capture("new"); file("new", "outside");
  assert.throws(() => store.apply([{ expected, desired: desired("ours") }]), /conflict/);
  assert.equal(read("new"), "outside");
  const receipt = store.apply([{ expected: store.capture("new"), desired: desired(null) }]);
  file("new", "replacement");
  assert.throws(() => store.apply(reverseStructural(receipt)), /conflict/);
  assert.equal(read("new"), "replacement");
});

checkpointTest("same-content replaced inode and changed mode refuse mutation", (t) => {
  const { store, root, file, read } = fixture(t);
  file("item", "old"); const expected = store.capture("item");
  fs.renameSync(join(root, "item"), join(root, "original")); file("item", "old");
  assert.throws(() => store.apply([{ expected, desired: desired(null) }]), /conflict/);
  const current = store.capture("item"); fs.chmodSync(join(root, "item"), process.platform === "win32" ? 0o444 : 0o644);
  assert.throws(() => store.apply([{ expected: current, desired: desired("new") }]), /conflict/);
  assert.equal(read("item"), "old");
});

checkpointTest("ancestor replacement is refused even when original leaf inode is moved back", (t) => {
  const { store, root, file, read } = fixture(t);
  file("nested/item", "old"); const expected = store.capture("nested/item");
  fs.renameSync(join(root, "nested"), join(root, "old-dir")); fs.mkdirSync(join(root, "nested"));
  fs.renameSync(join(root, "old-dir/item"), join(root, "nested/item"));
  assert.throws(() => store.apply([{ expected, desired: desired("new") }]), /conflict/);
  assert.equal(read("nested/item"), "old");
});

checkpointTest("links, traversal, non-files, and missing parents are refused without mkdir", (t) => {
  const { store, root, file } = fixture(t); file("item", "data");
  fs.symlinkSync(join(root, "item"), join(root, "sym"));
  fs.symlinkSync(join(root, "nested"), join(root, "symdir"));
  fs.linkSync(join(root, "item"), join(root, "hard"));
  for (const path of ["sym", "symdir/new", "hard", "item", "nested", "../escape", "nested/../item", "nested//new", "missing/new", "nested\\new"]) {
    assert.throws(() => store.capture(path), { name: "Error" }, path);
  }
  assert.equal(fs.existsSync(join(root, "missing")), false);
});

checkpointTest("failed second mutation preserves completed receipt and marks only attempted uncertain path", (t) => {
  const { store, root, read } = fixture(t);
  const mutations = ["one", "two", "three"].map((path) => ({ expected: store.capture(path), desired: desired(path) }));
  const original = checkpointIo.write;
  let calls = 0;
  t.mock.method(checkpointIo, "write", (...args: Parameters<typeof checkpointIo.write>) => {
    if (++calls === 2) throw new Error("injected second write failure");
    return original(...args);
  });
  let failure: StructuralMutationFailure | undefined;
  try { store.apply(mutations); } catch (error) { assert.ok(error instanceof StructuralMutationFailure); failure = error; }
  assert.ok(failure); assert.equal(failure.completed.length, 1);
  assert.deepEqual(failure.uncertainPaths, ["two"]);
  assert.equal(read("one"), "one"); assert.equal(read("two"), "");
  assert.equal(fs.existsSync(join(root, "three")), false);
  t.mock.restoreAll();
  store.apply(reverseStructural(failure.completed));
  assert.equal(fs.existsSync(join(root, "one")), false);
});

checkpointTest("creation uses exclusive open and does not overwrite a last-moment arrival", (t) => {
  const { store, root, file, read } = fixture(t);
  const expected = store.capture("new"), original = checkpointIo.open;
  t.mock.method(checkpointIo, "open", (path: string, flags: number, mode?: number) => {
    if (path === join(root, "new") && (flags & fs.constants.O_CREAT)) {
      assert.ok(flags & fs.constants.O_EXCL);
      // Use original descriptor calls, not recursive writeFile/open mocks.
      const other = original(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      checkpointIo.write(other, Buffer.from("external"), 0, 8, 0); checkpointIo.close(other);
    }
    return original(path, flags, mode);
  });
  assert.throws(() => store.apply([{ expected, desired: desired("ours") }]), /EEXIST/);
  assert.equal(read("new"), "external"); void file;
});

checkpointTest("descriptor receipt refuses replaced pathname after successful write", (t) => {
  const { store, root, file, read } = fixture(t); file("item", "old");
  const expected = store.capture("item"), original = checkpointIo.chmod;
  t.mock.method(checkpointIo, "chmod", (fd: CheckpointHandle, mode: number) => {
    original(fd, mode);
    fs.renameSync(join(root, "item"), join(root, "owned")); file("item", "external");
  });
  assert.throws(() => store.apply([{ expected, desired: desired("ours") }]), (error: unknown) => {
    assert.ok(error instanceof StructuralMutationFailure);
    assert.deepEqual(error.uncertainPaths, ["item"]); assert.equal(error.completed.length, 0); return true;
  });
  assert.equal(read("owned"), "ours"); assert.equal(read("item"), "external");
});

checkpointTest("leaf replacement at writable open is refused before any write or unlink", (t) => {
  const { store, root, file, read } = fixture(t); file("item", "old");
  const expected = store.capture("item"), original = checkpointIo.open;
  t.mock.method(checkpointIo, "open", (path: string, flags: number, mode?: number) => {
    const fd = original(path, flags, mode);
    if (path === join(root, "item") && (flags & fs.constants.O_RDWR)) {
      fs.renameSync(join(root, "item"), join(root, "original"));
      const other = original(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      checkpointIo.write(other, Buffer.from("external"), 0, 8, 0); checkpointIo.close(other);
    }
    return fd;
  });
  assert.throws(() => store.apply([{ expected, desired: desired(null) }]), (error: unknown) => {
    assert.ok(error instanceof StructuralMutationFailure); assert.deepEqual(error.uncertainPaths, []); return true;
  });
  assert.equal(read("original"), "old"); assert.equal(read("item"), "external");
});

checkpointTest("growing file bounded read refuses an extra byte rather than reading an unbounded tail", (t) => {
  const { store, root, file } = fixture(t); file("item", "old");
  const original = checkpointIo.read; let first = true; let requested = 0;
  t.mock.method(checkpointIo, "read", (fd: CheckpointHandle, buffer: Buffer, offset: number, length: number, position: number) => {
    requested += length;
    const count = original(fd, buffer, offset, length, position);
    if (first) { first = false; fs.appendFileSync(join(root, "item"), Buffer.alloc(STRUCTURAL_MAX_FILE)); }
    return count;
  });
  assert.throws(() => store.capture("item"), /conflict/);
  assert.equal(requested, 4);
});

checkpointTest("bounds reject before mutation, including aggregate, count and duplicate paths", (t) => {
  const { store, root } = fixture(t);
  const expected = store.capture("new");
  assert.throws(() => store.apply([{ expected, desired: { bytes: Buffer.alloc(STRUCTURAL_MAX_FILE + 1), mode: 0o600 } }]), /limit/);
  const many = Array.from({ length: 9 }, (_, i) => ({ expected: store.capture(`new${i}`), desired: { bytes: Buffer.alloc(STRUCTURAL_MAX_FILE), mode: 0o600 } }));
  assert.throws(() => store.apply(many), /aggregate/);
  assert.throws(() => store.apply([many[0]!, many[0]!]), /unique/);
  assert.throws(() => store.apply(Array.from({ length: 33 }, (_, i) => ({ expected: store.capture(`count${i}`), desired: desired("") }))), /1–32/);
  fs.writeFileSync(join(root, "large"), Buffer.alloc(STRUCTURAL_MAX_FILE + 1));
  assert.throws(() => store.capture("large"), /limit/);
  fs.writeFileSync(join(root, "small"), "1234");
  assert.throws(() => store.capture("small", 3), /limit/);
  assert.equal(fs.existsSync(join(root, "new0")), false);
});
