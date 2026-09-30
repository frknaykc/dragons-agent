import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDragonsProfileStore, DEFAULT_DRAGONS_PROFILE, getDragonsProfilePaths, isSafeProfileName } from "../../dist/profiles.js";

test("profile paths retain legacy defaults and isolate named profiles", () => {
  const configPath = join(tmpdir(), "dragons", "config.json");
  assert.equal(getDragonsProfilePaths(DEFAULT_DRAGONS_PROFILE, configPath).sessionDirectory, join(tmpdir(), "dragons", "sessions"));
  const work = getDragonsProfilePaths("work", configPath);
  assert.equal(work.configPath, join(tmpdir(), "dragons", "profiles", "work", "config.json"));
  assert.equal(work.sessionDirectory, join(tmpdir(), "dragons", "profiles", "work", "sessions"));
  assert.equal(work.credentialAccount, "chatgpt-subscription:work");
  assert.equal(isSafeProfileName("work-2026"), true);
  assert.equal(isSafeProfileName("../outside"), false);
});

test("profiles are created and selected atomically without data-path ambiguity", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-profiles-"));
  try {
    const store = createDragonsProfileStore({ configPath: join(root, "config.json") });
    assert.equal(await store.active(), DEFAULT_DRAGONS_PROFILE);
    await store.create("review");
    const selected = await store.select("review");
    assert.equal(selected.name, "review");
    assert.equal(await store.active(), "review");
    assert.deepEqual(await store.list(), [DEFAULT_DRAGONS_PROFILE, "review"]);
    assert.equal((await lstat(join(root, "profiles", "review"))).isDirectory(), true);
    await assert.rejects(store.create("../outside"), /Profile name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
