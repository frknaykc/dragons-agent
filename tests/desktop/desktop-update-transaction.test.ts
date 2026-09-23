import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { access, mkdir, mkdtemp, readFile, rename, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateStagedCandidate, confirmActivatedUpdate, recoverUnconfirmedActivation } from "../../dist/desktop/update-transaction.js";

const names = { active: "active", candidate: "candidate", backup: "previous", failed: "failed" };

async function confirmedFixture(root: string): Promise<void> {
  await writeFile(join(root, "active"), "v1");
  await writeFile(join(root, "candidate"), "v2");
  await activateStagedCandidate({ root, ...names });
  await confirmActivatedUpdate(root);
  await writeFile(join(root, "candidate"), "v3");
}

test("repeat update retains both rollback generations until health confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-repeat-"));
  try {
    await confirmedFixture(root);
    await activateStagedCandidate({ root, ...names });
    assert.equal(await readFile(join(root, "active"), "utf8"), "v3");
    assert.equal(await readFile(join(root, "previous"), "utf8"), "v2");
    assert.equal(await readFile(join(root, ".activation.retired"), "utf8"), "v1");
    await confirmActivatedUpdate(root);
    await absent(join(root, ".activation.retired"));
    await writeFile(join(root, "candidate"), "v4");
    await activateStagedCandidate({ root, ...names });
    assert.equal(await recoverUnconfirmedActivation(root), "rolled-back");
    assert.equal(await readFile(join(root, "active"), "utf8"), "v3");
    assert.equal(await readFile(join(root, "failed"), "utf8"), "v4");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const moved of [false, true]) {
  test(`interrupted repeat preparation recovers confirmed rollback (rotated=${moved})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dragons-repeat-"));
    try {
      await confirmedFixture(root);
      await writeFile(join(root, "activation.json"), JSON.stringify({ schemaVersion: 1, state: "preparing", retired: true, ...names }));
      if (moved) await rename(join(root, "previous"), join(root, ".activation.retired"));
      assert.equal(await recoverUnconfirmedActivation(root), "confirmed");
      assert.equal(await readFile(join(root, "active"), "utf8"), "v2");
      assert.equal(await readFile(join(root, "previous"), "utf8"), "v1");
      await activateStagedCandidate({ root, ...names });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("orphan lock is never reclaimed by age; explicit offline removal permits journal recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-orphan-"));
  try {
    await writeFile(join(root, "active"), "v1");
    await writeFile(join(root, "candidate"), "v2");
    await activateStagedCandidate({ root, ...names });
    await mkdir(join(root, ".activation.lock"));
    await utimes(join(root, ".activation.lock"), new Date(0), new Date(0));
    await assert.rejects(recoverUnconfirmedActivation(root), /ownership.*offline/i);
    assert.equal(await readFile(join(root, "active"), "utf8"), "v2");
    await access(join(root, ".activation.lock"));
    // Offline fixture: no updater is running. No automatic PID/timeout assumption.
    await rmdir(join(root, ".activation.lock"));
    assert.equal(await recoverUnconfirmedActivation(root), "rolled-back");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const checkpoint of [1, 2, 3, 4, 5]) {
  test(`repeat update rename fault ${checkpoint} preserves recoverable working bytes`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "dragons-fault-"));
    const original = fs.rename;
    try {
      await confirmedFixture(root);
      let count = 0;
      const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await original(...args);
        if (++count === checkpoint) throw new Error("injected interruption");
      });
      syncBuiltinESMExports();
      await assert.rejects(activateStagedCandidate({ root, ...names }), /injected interruption/);
      fault.mock.restore();
      syncBuiltinESMExports();
      assert.equal(await recoverUnconfirmedActivation(root), checkpoint <= 2 ? "confirmed" : "rolled-back");
      assert.equal(await readFile(join(root, "active"), "utf8"), "v2");
      assert.equal(await readFile(join(root, checkpoint <= 3 ? "previous" : ".activation.retired"), "utf8"), "v1");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const checkpoint of [1, 2]) {
  test(`rollback can resume after rename fault ${checkpoint}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "dragons-rollback-fault-"));
    const original = fs.rename;
    try {
      await confirmedFixture(root);
      await activateStagedCandidate({ root, ...names });
      let count = 0;
      const fault = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await original(...args);
        if (++count === checkpoint) throw new Error("injected interruption");
      });
      syncBuiltinESMExports();
      await assert.rejects(recoverUnconfirmedActivation(root), /injected interruption/);
      fault.mock.restore();
      syncBuiltinESMExports();
      assert.equal(await recoverUnconfirmedActivation(root), "rolled-back");
      assert.equal(await recoverUnconfirmedActivation(root), "none");
      assert.equal(await readFile(join(root, "active"), "utf8"), "v2");
      assert.equal(await readFile(join(root, "failed"), "utf8"), "v3");
      assert.equal(await readFile(join(root, ".activation.retired"), "utf8"), "v1");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("failed durable preparation does not remove the confirmed rollback copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-journal-fault-"));
  try {
    await confirmedFixture(root);
    await mkdir(join(root, "activation.json.tmp"));
    await writeFile(join(root, "activation.json.tmp", "blocker"), "preserve");
    await assert.rejects(activateStagedCandidate({ root, ...names }));
    assert.equal(await readFile(join(root, "active"), "utf8"), "v2");
    assert.equal(await readFile(join(root, "previous"), "utf8"), "v1");
    assert.equal(await readFile(join(root, "candidate"), "utf8"), "v3");
    assert.equal(await recoverUnconfirmedActivation(root), "confirmed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup failure after durable confirmation remains confirmed and the next update retries cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-cleanup-fault-"));
  const original = fs.rm;
  try {
    await confirmedFixture(root);
    await activateStagedCandidate({ root, ...names });
    const fault = t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === join(root, ".activation.retired")) throw new Error("injected cleanup failure");
      await original(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(confirmActivatedUpdate(root), /injected cleanup failure/);
    fault.mock.restore();
    syncBuiltinESMExports();
    assert.equal(await recoverUnconfirmedActivation(root), "confirmed");
    assert.equal(await readFile(join(root, "active"), "utf8"), "v3");
    assert.equal(await readFile(join(root, "previous"), "utf8"), "v2");
    await writeFile(join(root, "candidate"), "v4");
    await activateStagedCandidate({ root, ...names });
    assert.equal(await readFile(join(root, ".activation.retired"), "utf8"), "v2");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeat activation rejects mismatched slots without touching the confirmed journal or backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-mismatch-"));
  try {
    await confirmedFixture(root);
    const journal = await readFile(join(root, "activation.json"), "utf8");
    await assert.rejects(activateStagedCandidate({ root, ...names, backup: "different" }));
    assert.equal(await readFile(join(root, "activation.json"), "utf8"), journal);
    assert.equal(await readFile(join(root, "previous"), "utf8"), "v1");
    await absent(join(root, ".activation.retired"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("untracked retired bytes are never deleted by repeat activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-untracked-"));
  try {
    await confirmedFixture(root);
    await writeFile(join(root, ".activation.retired"), "not-owned-by-journal");
    await assert.rejects(activateStagedCandidate({ root, ...names }));
    assert.equal(await readFile(join(root, ".activation.retired"), "utf8"), "not-owned-by-journal");
    assert.equal(await readFile(join(root, "previous"), "utf8"), "v1");
    assert.equal(await readFile(join(root, "active"), "utf8"), "v2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function absent(path: string): Promise<void> {
  await assert.rejects(access(path));
}

test("transaction stages a candidate behind a durable pending journal and preserves the previous version", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-transaction-"));
  try {
    await writeFile(join(root, "active"), "old-working");
    await writeFile(join(root, "candidate"), "new-working");
    await activateStagedCandidate({ root, active: "active", candidate: "candidate", backup: "previous", failed: "failed" });
    assert.equal(await readFile(join(root, "active"), "utf8"), "new-working");
    assert.equal(await readFile(join(root, "previous"), "utf8"), "old-working");
    await absent(join(root, "candidate"));
    assert.match(await readFile(join(root, "activation.json"), "utf8"), /"pending"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unconfirmed activation rolls back without touching user data and preserves the failed candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-transaction-"));
  try {
    const userData = join(root, "user-data");
    await writeFile(join(root, "active"), "old-working");
    await writeFile(join(root, "candidate"), "new-working");
    await writeFile(userData, "must-not-change");
    await activateStagedCandidate({ root, active: "active", candidate: "candidate", backup: "previous", failed: "failed" });
    assert.equal(await recoverUnconfirmedActivation(root), "rolled-back");
    assert.equal(await readFile(join(root, "active"), "utf8"), "old-working");
    assert.equal(await readFile(join(root, "failed"), "utf8"), "new-working");
    assert.equal(await readFile(userData, "utf8"), "must-not-change");
    await absent(join(root, "activation.json"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("confirmed activation survives recovery and malformed or unsafe journals fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-transaction-"));
  try {
    await writeFile(join(root, "active"), "old-working");
    await writeFile(join(root, "candidate"), "new-working");
    await activateStagedCandidate({ root, active: "active", candidate: "candidate", backup: "previous", failed: "failed" });
    await confirmActivatedUpdate(root);
    assert.equal(await recoverUnconfirmedActivation(root), "confirmed");
    assert.equal(await readFile(join(root, "active"), "utf8"), "new-working");
    await writeFile(join(root, "activation.json"), JSON.stringify({ schemaVersion: 1, state: "pending", active: "../outside", backup: "previous", candidate: "candidate", failed: "failed" }));
    await assert.rejects(recoverUnconfirmedActivation(root));
    assert.equal(await readFile(join(root, "active"), "utf8"), "new-working");
    await writeFile(join(root, "activation.json"), JSON.stringify({ schemaVersion: 1, state: "pending", active: "..\\outside", backup: "previous", candidate: "candidate", failed: "failed" }));
    await assert.rejects(recoverUnconfirmedActivation(root));
    assert.equal(await readFile(join(root, "active"), "utf8"), "new-working");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a crash after durable intent but before replacement preserves the active slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-transaction-"));
  try {
    await writeFile(join(root, "active"), "old-working");
    await writeFile(join(root, "candidate"), "new-working");
    await writeFile(join(root, "activation.json"), JSON.stringify({ schemaVersion: 1, state: "pending", active: "active", candidate: "candidate", backup: "previous", failed: "failed" }));
    assert.equal(await recoverUnconfirmedActivation(root), "rolled-back");
    assert.equal(await readFile(join(root, "active"), "utf8"), "old-working");
    assert.equal(await readFile(join(root, "candidate"), "utf8"), "new-working");
    await absent(join(root, "activation.json"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an existing activation lock rejects a concurrent switch without changing slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-transaction-"));
  try {
    await writeFile(join(root, "active"), "old-working");
    await writeFile(join(root, "candidate"), "new-working");
    await writeFile(join(root, ".activation.lock"), "owner");
    await assert.rejects(activateStagedCandidate({ root, active: "active", candidate: "candidate", backup: "previous", failed: "failed" }));
    assert.equal(await readFile(join(root, "active"), "utf8"), "old-working");
    assert.equal(await readFile(join(root, "candidate"), "utf8"), "new-working");
    await absent(join(root, "activation.json"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
