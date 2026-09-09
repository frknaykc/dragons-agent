import assert from "node:assert/strict";
import test from "node:test";
import { retryPersistentJobRename } from "./persistent-job-rename.js";

const denied = () => Object.assign(new Error("synthetic sharing conflict"), { code: "EPERM", syscall: "rename" });

test("Windows EPERM from a non-rename operation is not retried", async () => {
  const error = Object.assign(new Error("synthetic open denial"), { code: "EPERM", syscall: "open" });
  let attempts = 0;
  await assert.rejects(retryPersistentJobRename(async () => { attempts++; throw error; }, {
    platform: "win32",
    delay: async () => { assert.fail("unexpected delay"); },
  }), (actual) => actual === error);
  assert.equal(attempts, 1);
});

test("persistent job replacement retries transient Windows rename EPERM", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await retryPersistentJobRename(async () => { attempts++; if (attempts < 3) throw denied(); return "saved"; }, {
    platform: "win32",
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.deepEqual(delays, [10, 20]);
  assert.equal(attempts, 3);
  assert.equal(result, "saved");
});

test("persistent Windows permission denial is bounded and preserves the original error", async () => {
  const error = denied();
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(retryPersistentJobRename(async () => { attempts++; throw error; }, {
    platform: "win32",
    delay: async (milliseconds) => { delays.push(milliseconds); },
  }), (actual) => actual === error);
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [10, 20, 40, 80, 160]);
});

for (const [platform, code] of [["darwin", "EPERM"], ["linux", "EPERM"], ["win32", "ENOENT"], ["win32", "EACCES"]] as const) {
  test(`persistent replacement does not retry ${platform}/${code}`, async () => {
    const error = Object.assign(new Error("synthetic failure"), { code, syscall: "rename" });
    let attempts = 0;
    await assert.rejects(retryPersistentJobRename(async () => { attempts++; throw error; }, {
      platform,
      delay: async () => { assert.fail("unexpected delay"); },
    }), (actual) => actual === error);
    assert.equal(attempts, 1);
  });
}
