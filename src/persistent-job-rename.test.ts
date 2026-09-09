import assert from "node:assert/strict";
import test from "node:test";
import { renamePersistentJob } from "./persistent-job-rename.js";

const denied = () => Object.assign(new Error("synthetic sharing conflict"), { code: "EPERM" });

test("persistent job replacement retries transient Windows EPERM without changing paths", async () => {
  const delays: number[] = [];
  const paths: string[][] = [];
  await renamePersistentJob("source.tmp", "target.json", {
    platform: "win32",
    rename: async (source, target) => { paths.push([String(source), String(target)]); if (paths.length < 3) throw denied(); },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(paths, Array.from({ length: 3 }, () => ["source.tmp", "target.json"]));
});

test("persistent Windows permission denial is bounded and preserves the original error", async () => {
  const error = denied();
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(renamePersistentJob("source.tmp", "target.json", {
    platform: "win32",
    rename: async () => { attempts++; throw error; },
    delay: async (milliseconds) => { delays.push(milliseconds); },
  }), (actual) => actual === error);
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [10, 20, 40, 80, 160]);
});

for (const [platform, code] of [["darwin", "EPERM"], ["linux", "EPERM"], ["win32", "ENOENT"], ["win32", "EACCES"]] as const) {
  test(`persistent replacement does not retry ${platform}/${code}`, async () => {
    const error = Object.assign(new Error("synthetic failure"), { code });
    let attempts = 0;
    await assert.rejects(renamePersistentJob("source.tmp", "target.json", {
      platform,
      rename: async () => { attempts++; throw error; },
      delay: async () => { assert.fail("unexpected delay"); },
    }), (actual) => actual === error);
    assert.equal(attempts, 1);
  });
}
