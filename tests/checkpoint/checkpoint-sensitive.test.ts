import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCheckpoints } from "../../dist/checkpoint.js";

// Synthetic, non-functional values only; all fixtures are removed after each test.
const candidates = [
  '{"db_password":"private-value"}',
  "DB_PASSWORD=synthetic-private-value",
  "dbPassword: synthetic-private-value",
  "servicePassword = 'synthetic-private-value'",
  '{"serviceClientSecret":"synthetic-private-value"}',
  "app_secret: synthetic-private-value",
  "app-secret = synthetic-private-value",
  '{"serviceAccessToken":"synthetic-private-value"}',
  "deployment_token=synthetic-private-value",
  "service.token = synthetic-private-value",
  '{"url":"postgresql://fixture:synthetic-private-value@db.invalid/app"}',
  '{"url":"https://fixture:synthetic%2Dprivate%40value@example.invalid/"}',
  "url = 'redis://:synthetic-private-value@cache.invalid/0'",
  '{"url":"https://synthetic-userinfo@example.invalid/"}',
];

for (const [index, content] of candidates.entries()) {
  for (const image of ["before", "after"] as const) {
    test(`checkpoint rejects synthetic sensitive ${image} image ${index} before writes or retention`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "dragons-checkpoint-sensitive-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const history = new SessionCheckpoints(root);
      await writeFile(join(root, "safe.txt"), "original", { mode: 0o640 });
      await writeFile(join(root, "config.txt"), image === "before" ? content : "original", { mode: 0o600 });
      assert.equal(history.mutate([{ path: "safe.txt", content: "retained-safe" }]).ok, true);
      const listing = history.list();
      const id = listing.split(":")[0]!;
      const previousDiff = history.diff(id);
      const previousStat = await stat(join(root, "config.txt"));
      const result = history.mutate([
        { path: "safe.txt", content: "must-not-write" },
        { path: "config.txt", content: image === "after" ? content : "sanitized" },
      ]);
      assert.equal(result.ok, false);
      assert.match(result.output, /sensitive content/);
      assert.ok(!result.changedPaths?.length);
      assert.equal(await readFile(join(root, "safe.txt"), "utf8"), "retained-safe");
      assert.equal(await readFile(join(root, "config.txt"), "utf8"), image === "before" ? content : "original");
      const afterStat = await stat(join(root, "config.txt"));
      assert.equal(afterStat.mode, previousStat.mode);
      assert.equal(afterStat.mtimeMs, previousStat.mtimeMs);
      assert.equal(history.list(), listing, "rejection must not retain or evict history");
      assert.equal(history.diff(id), previousDiff, "existing diff remains unchanged");
      assert.throws(() => history.diff(id, "config.txt"), /not found/);
      assert.throws(() => history.diff(id.replace(/-1$/, "-2")), /not found/);
      history.clear();
      assert.equal(history.mutate([{ path: "config.txt", content: image === "after" ? content : "sanitized" }]).ok, false);
      assert.match(history.list(), /^No checkpoints/);
    });
  }
}

test("checkpoint still captures ordinary config and URLs without authority userinfo", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-checkpoint-sensitive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = new SessionCheckpoints(root);
  const before = '{"url":"https://example.invalid/users/fixture@example.invalid","retries":3}';
  const after = '{"url":"https://example.invalid/?contact=fixture@example.invalid","retries":4}';
  await writeFile(join(root, "config.txt"), before);
  assert.equal(history.mutate([{ path: "config.txt", content: after }]).ok, true);
  const id = history.list().split(":")[0]!;
  assert.deepEqual(JSON.parse(history.diff(id)), [{ path: "config.txt", before, after }]);
});
