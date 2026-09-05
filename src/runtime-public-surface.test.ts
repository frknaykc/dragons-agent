import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDragonsRuntime } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

test("M71 returns only frozen bound public methods, not a mutable core instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-surface-"));
  const runtime = await createDragonsRuntime({
    workingDirectory: root, tools: [], sessionStore: createSessionStore(join(root, "sessions")),
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
  });
  try {
    assert.equal(Object.getPrototypeOf(runtime), Object.prototype);
    assert.equal(Object.isFrozen(runtime), true);
    assert.ok(Object.values(runtime).every((value) => typeof value === "function"));
    for (const internal of ["providerRegistry", "sessionStore", "tools", "mcpManager", "memoryStore", "activeRuns", "executeRun", "loadOwnedSession"]) {
      assert.equal(internal in runtime, false, internal);
    }
    const { providers } = runtime;
    assert.ok(providers().length > 0, "public methods do not depend on caller-provided this");
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
