import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionCheckpoints } from "../../dist/checkpoint.js";

const LIMIT = 256 * 1024;
async function fixture(t: TestContext, content = "seed") {
  const root = await mkdtemp(join(tmpdir(), "dragons-large-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "file.txt");
  await writeFile(target, content);
  return { root, target, history: new SessionCheckpoints(root) };
}
const id = (history: SessionCheckpoints) => history.list().split(":")[0]!;

test("large UTF-8 images retain exact CRLF/no-final-newline diff and restore", async (t) => {
  const before = "é ".repeat(6000) + "\r\nend";
  const after = "ø ".repeat(6000) + "\r\nlast";
  const f = await fixture(t, before);
  assert.equal(f.history.mutate([{ path: "file.txt", content: after, expected: before }]).ok, true);
  assert.deepEqual(JSON.parse(f.history.diff(id(f.history))), [{ path: "file.txt", before, after }]);
  assert.equal(f.history.rollback(id(f.history)).ok, true);
  assert.equal(await readFile(f.target, "utf8"), before);
});

test("exact 256 KiB images restore while single-path diff stays capped at 60000 bytes", async (t) => {
  const before = "a\n".repeat(LIMIT / 2), after = "b\n".repeat(LIMIT / 2);
  const f = await fixture(t, before);
  assert.equal(f.history.mutate([{ path: "file.txt", content: after }]).ok, true);
  assert.throws(() => f.history.diff(id(f.history), "file.txt"), /display bound/);
  assert.equal(f.history.rollback(id(f.history)).ok, true);
  assert.equal(await readFile(f.target, "utf8"), before);
  assert.equal(f.history.mutate([{ path: "file.txt", content: after + "b" }]).ok, false);
  await writeFile(f.target, before + "a");
  assert.equal(f.history.mutate([{ path: "file.txt", content: "small" }]).ok, false);
  assert.equal((await readFile(f.target)).length, LIMIT + 1);
});

test("2 MiB batch admission is inclusive; excess rejects before writing or evicting history", async (t) => {
  const f = await fixture(t);
  const before = "a\n".repeat(LIMIT / 2), after = "b\n".repeat(LIMIT / 2);
  const batch = Array.from({ length: 4 }, (_, i) => ({ path: `${i}.txt`, content: after }));
  for (const item of batch) await writeFile(join(f.root, item.path), before);
  assert.equal(f.history.mutate(batch).ok, true);
  const listing = f.history.list();
  const excess = [...batch.map(item => ({ ...item, content: before })), { path: "file.txt", content: "new" }];
  assert.equal(f.history.classify(excess).kind, "rejected");
  assert.match(f.history.mutate(excess).output, /aggregate|batch/i);
  assert.equal(f.history.list(), listing);
  assert.equal(await readFile(join(f.root, "0.txt"), "utf8"), after);
  assert.equal(await readFile(f.target, "utf8"), "seed");
  assert.equal(f.history.rollback(id(f.history)).ok, true);
});

for (const stage of ["capture", "verify"] as const) for (const fault of ["growth", "short", "error"] as const) {
  test(`bounded ${stage} rejects ${fault}, closes fd, and never writes`, async (t) => {
    const before = "a\n".repeat(35000);
    const f = await fixture(t, before);
    const originalRead = fs.readSync, originalOpen = fs.openSync, originalClose = fs.closeSync;
    let writable = false, injected = false, bytesRequested = 0;
    const openFds = new Set<number>();
    const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      writable = typeof args[1] === "number" && Boolean(args[1] & fs.constants.O_RDWR);
      const fd = originalOpen(...args); openFds.add(fd); return fd;
    });
    const close = t.mock.method(fs, "closeSync", (fd: number) => { openFds.delete(fd); return originalClose(fd); });
    const read = t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      assert.ok(length <= 65536); bytesRequested += length;
      if (!injected && writable === (stage === "verify")) {
        injected = true;
        if (fault === "growth") fs.appendFileSync(f.target, "extra");
        if (fault === "short") return 0;
        if (fault === "error") throw new Error("Synthetic read failure");
      }
      return originalRead(fd, buffer, offset, length, position);
    });
    syncBuiltinESMExports();
    let result;
    try { result = f.history.mutate([{ path: "file.txt", content: "new" }]); }
    finally { read.mock.restore(); open.mock.restore(); close.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(openFds.size, 0);
    assert.ok(bytesRequested <= 2 * (before.length + 1));
    assert.equal(await readFile(f.target, "utf8"), before + (fault === "growth" ? "extra" : ""));
    assert.match(f.history.list(), /No checkpoints/);
  });
}

test("large images still inspect their entire sensitive/UTF-8 content and expected source", async (t) => {
  const prefix = "a\n".repeat(35000) + "\n";
  const f = await fixture(t, prefix);
  for (const content of [prefix + "service_token=synthetic", prefix + "\0"]) {
    assert.equal(f.history.mutate([{ path: "file.txt", content }]).ok, false);
  }
  assert.equal(f.history.mutate([{ path: "file.txt", content: "new", expected: "stale" }]).ok, false);
  for (const suffix of [Buffer.from("service_token=synthetic"), Buffer.from([0xff])]) {
    await writeFile(f.target, Buffer.concat([Buffer.from(prefix), suffix]));
    assert.equal(f.history.mutate([{ path: "file.txt", content: "new" }]).ok, false);
  }
  assert.match(f.history.list(), /No checkpoints/);
});
