import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionLoop } from "../../dist/session-loop.js";

test("session loop rejects unbounded settings and exposes no prompt through status", () => {
  const config = { sessionId: "session-1", prompt: "check", intervalMs: 1_000, maxRuns: 2 };
  const callbacks = { run: async () => {}, isBusy: () => false, onError: () => {} };
  assert.throws(() => new SessionLoop({ config: { ...config, maxRuns: Infinity }, ...callbacks }));
  assert.throws(() => new SessionLoop({ config: { ...config, intervalMs: 0 }, ...callbacks }));
  assert.throws(() => new SessionLoop({ config: { ...config, idleMs: 500 }, ...callbacks }));
  assert.deepEqual(new SessionLoop({ config, ...callbacks }).status(), { running: false, completed: 0, active: false, sessionId: "session-1" });
});

test("loop serializes ticks, skips busy sessions and stops at the run budget", async () => {
  let busy = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const loop = new SessionLoop({
    config: { sessionId: "session-1", prompt: "review", intervalMs: 60_000, maxRuns: 2 },
    isBusy: () => busy,
    run: async (sessionId, prompt) => { calls.push(`${sessionId}:${prompt}`); await gate; },
    onError: () => assert.fail("unexpected error"),
  });
  loop.start();
  try {
    assert.equal(await loop.tick(), false);
    busy = false;
    const first = loop.tick();
    assert.equal(await loop.tick(), false);
    release();
    assert.equal(await first, true);
    assert.equal(await loop.tick(), true);
    assert.equal(await loop.tick(), false);
    assert.deepEqual(calls, ["session-1:review", "session-1:review"]);
    assert.deepEqual(loop.status(), { running: false, completed: 2, active: false, sessionId: "session-1" });
  } finally { await loop.stop(); }
});

test("heartbeat waits for inactivity and resets the idle clock after each run", async () => {
  let time = 0;
  let count = 0;
  const loop = new SessionLoop({
    config: { sessionId: "session-2", prompt: "heartbeat", intervalMs: 1_000, idleMs: 3_000, maxRuns: 2 },
    now: () => time,
    isBusy: () => false,
    run: async () => { count += 1; },
    onError: () => assert.fail("unexpected error"),
  });
  loop.start();
  try {
    time = 2_999;
    assert.equal(await loop.tick(), false);
    loop.markActivity();
    time = 5_998;
    assert.equal(await loop.tick(), false);
    time = 5_999;
    assert.equal(await loop.tick(), true);
    time = 8_998;
    assert.equal(await loop.tick(), false);
    time = 8_999;
    assert.equal(await loop.tick(), true);
    assert.equal(count, 2);
  } finally { await loop.stop(); }
});

test("stop aborts the active run and a failed run halts rather than retries", async () => {
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const loop = new SessionLoop({
    config: { sessionId: "session-3", prompt: "check", intervalMs: 60_000, maxRuns: 4 },
    isBusy: () => false,
    run: async (_id, _prompt, current) => { signal = current; started(); await pending; },
    onError: () => assert.fail("unexpected error"),
  });
  loop.start();
  const active = loop.tick();
  await admitted;
  assert.equal(loop.status().active, true);
  const stopped = loop.stop();
  assert.equal(signal?.aborted, true);
  release();
  await stopped;
  assert.equal(await active, false);
  assert.equal(await loop.tick(), false);
  assert.equal(loop.status().completed, 0);

  let attempts = 0;
  const failing = new SessionLoop({
    config: { sessionId: "session-4", prompt: "check", intervalMs: 60_000, maxRuns: 4 },
    isBusy: () => false,
    run: async () => { attempts += 1; throw new Error("provider failed"); },
    onError: () => {},
  });
  failing.start();
  try {
    await assert.rejects(failing.tick(), /provider failed/);
    assert.equal(await failing.tick(), false);
    assert.equal(attempts, 1);
  } finally { await failing.stop(); }
});
