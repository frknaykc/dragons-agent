import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createLiveSmokeFixture,
  removeLiveSmokeFixture,
  runLiveSmoke,
  verifyLiveSmokeFixture,
} from "./live-smoke.js";

test("live smoke requires explicit opt-in and an API key before any network request", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network should not be called");
  };
  delete process.env.OPENAI_API_KEY;

  try {
    await assert.rejects(runLiveSmoke([]), /--live/);
    await assert.rejects(runLiveSmoke(["--live"]), /OPENAI_API_KEY/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("live smoke fixture evaluates success from its source and test outcome", async () => {
  const workspace = await createLiveSmokeFixture();

  try {
    const before = await verifyLiveSmokeFixture(workspace);
    assert.equal(before.sourceIsFixed, false);
    assert.equal(before.testPassed, false);
    assert.equal(before.success, false);

    await writeFile(
      join(workspace, "calculator.js"),
      "export function add(left, right) {\n  return left + right;\n}\n",
      "utf8",
    );

    const after = await verifyLiveSmokeFixture(workspace);
    assert.equal(after.sourceIsFixed, true);
    assert.equal(after.testPassed, true);
    assert.equal(after.success, true);
  } finally {
    await removeLiveSmokeFixture(workspace);
  }
});

test("live smoke fixture cleanup removes the isolated workspace", async () => {
  const workspace = await createLiveSmokeFixture();

  await removeLiveSmokeFixture(workspace);

  await assert.rejects(access(workspace), { code: "ENOENT" });
  await rm(workspace, { recursive: true, force: true });
});
