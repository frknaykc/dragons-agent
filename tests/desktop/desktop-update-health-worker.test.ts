import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HEALTH_PROBE_ARGUMENT } from "../../dist/desktop/update-health.js";
import { runIsolatedHealthProbe } from "../../dist/desktop/update-health-worker.js";

test("health worker launches only an explicit probe in a disposable profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-health-worker-"));
  try {
    const probe = join(root, "probe.mjs");
    await writeFile(probe, [
      `if (process.argv.at(-1) !== ${JSON.stringify(HEALTH_PROBE_ARGUMENT)}) process.exit(2);`,
      'if (process.env.OPENAI_API_KEY || process.env.DRAGONS_RUNTIME_URL || process.env.HOME.includes("real-home")) process.exit(3);',
      'console.log("DRAGONS_UPDATE_HEALTH_OK");',
    ].join("\n"));
    await runIsolatedHealthProbe({
      executable: process.execPath,
      arguments: [probe],
      root,
      sourceEnvironment: { PATH: process.env.PATH, HOME: "/real-home", OPENAI_API_KEY: "secret", DRAGONS_RUNTIME_URL: "http://127.0.0.1:1" },
      timeoutMilliseconds: 2_000,
    });
    assert.equal(await readFile(probe, "utf8").then(() => "fixture-intact"), "fixture-intact");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("health worker rejects an unhealthy or non-terminating candidate without exposing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-health-worker-"));
  try {
    const unhealthy = join(root, "unhealthy.mjs");
    await writeFile(unhealthy, 'console.log("unexpected"); process.exit(1);');
    await assert.rejects(runIsolatedHealthProbe({ executable: process.execPath, arguments: [unhealthy], root, sourceEnvironment: process.env, timeoutMilliseconds: 2_000 }), /Update health probe failed/);
    const stalled = join(root, "stalled.mjs");
    await writeFile(stalled, 'setInterval(() => {}, 1000);');
    await assert.rejects(runIsolatedHealthProbe({ executable: process.execPath, arguments: [stalled], root, sourceEnvironment: process.env, timeoutMilliseconds: 20 }), /Update health probe failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


for (const trigger of ["timeout", "overflow", "abort", "child-error", "stdout-error"] as const) {
  test(`health worker ${trigger} waits for exit after bounded escalation before cleanup`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const root = await mkdtemp(join(tmpdir(), "dragons-health-lifecycle-"));
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough() });
    const signals: NodeJS.Signals[] = [];
    let home = "";
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => { spawned = resolve; });
    const spawnFake = ((_file: string, _args: readonly string[], options: { cwd: string }) => {
      home = options.cwd;
      spawned();
      return Object.assign(child, { kill(signal: NodeJS.Signals) {
        signals.push(signal);
        // Both rejection forms must leave the cleanup barrier intact.
        if (trigger === "child-error") throw new Error("private kill detail");
        return false;
      } }) as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    let settled = false;
    const probe = runIsolatedHealthProbe({ executable: "unused", root, sourceEnvironment: {}, timeoutMilliseconds: 1000, signal: controller.signal }, { spawn: spawnFake });
    const rejected = assert.rejects(probe, { message: "Update health probe failed." });
    void probe.then(() => { settled = true; }, () => { settled = true; });
    try {
      await ready;
      if (trigger === "timeout") t.mock.timers.tick(1000);
      if (trigger === "overflow") child.stdout.write(Buffer.alloc(1025, 255));
      if (trigger === "abort") controller.abort();
      if (trigger === "child-error") child.emit("error", new Error("private child detail"));
      if (trigger === "stdout-error") child.stdout.emit("error", new Error("private stream detail"));
      assert.deepEqual(signals, ["SIGTERM"]);
      assert.equal(settled, false);
      assert.equal((await stat(home)).isDirectory(), true);
      t.mock.timers.tick(249);
      assert.deepEqual(signals, ["SIGTERM"]);
      t.mock.timers.tick(1);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      t.mock.timers.tick(60_000);
      assert.equal(settled, false, "signal delivery must not permit rollback");
      assert.equal((await stat(home)).isDirectory(), true);
      child.emit("exit", null, "SIGKILL");
      await rejected;
      await assert.rejects(stat(home), { code: "ENOENT" });
      controller.abort();
      child.emit("error", new Error("late error is contained"));
      t.mock.timers.tick(60_000);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    } finally {
      child.emit("exit", null, "SIGKILL");
      await rejected;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("health worker waits for graceful termination and cancels escalation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "dragons-health-graceful-"));
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough() });
  const signals: NodeJS.Signals[] = [];
  let home = "";
  let spawned!: () => void;
  const ready = new Promise<void>((resolve) => { spawned = resolve; });
  const spawnFake = ((_file: string, _args: readonly string[], options: { cwd: string }) => {
    home = options.cwd;
    spawned();
    return Object.assign(child, { kill(signal: NodeJS.Signals) { signals.push(signal); return true; } });
  }) as unknown as typeof spawn;
  try {
    const probe = runIsolatedHealthProbe({ executable: "unused", root, sourceEnvironment: {}, timeoutMilliseconds: 1000, signal: controller.signal }, { spawn: spawnFake });
    const rejected = assert.rejects(probe, /Update health probe failed/);
    await ready;
    controller.abort();
    assert.equal((await stat(home)).isDirectory(), true);
    child.emit("exit", 0, null);
    await rejected;
    t.mock.timers.tick(10_000);
    assert.deepEqual(signals, ["SIGTERM"]);
    await assert.rejects(stat(home), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("health worker reaps a real SIGTERM-resistant child before cancellation completes", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-health-reap-"));
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  let home = "";
  let ready = false;
  const realSpawn = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    home = String(options!.cwd);
    child = spawn(file, args, options!);
    child.stdout!.once("data", () => { ready = true; controller.abort(); });
    return child;
  }) as typeof spawn;
  try {
    const fixture = join(root, "resistant.mjs");
    await writeFile(fixture, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");');
    await assert.rejects(runIsolatedHealthProbe({ executable: process.execPath, arguments: [fixture], root, sourceEnvironment: process.env, timeoutMilliseconds: 5000, signal: controller.signal }, { spawn: realSpawn }), /Update health probe failed/);
    assert.equal(ready, true, "cancel only after the child installed its signal handler");
    assert.ok(child?.pid && child.pid > 0);
    assert.equal(child.signalCode, "SIGKILL");
    assert.throws(() => process.kill(child!.pid!, 0), { code: "ESRCH" });
    await assert.rejects(stat(home), { code: "ENOENT" });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("health worker handles spawn failure and pre-aborted admission without leaking details", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-health-spawn-"));
  try {
    await assert.rejects(runIsolatedHealthProbe({ executable: join(root, "private-missing-executable"), root, sourceEnvironment: {}, timeoutMilliseconds: 1000 }), { message: "Update health probe failed." });
    let failedHome = "";
    const throwingSpawn = ((_file: string, _args: readonly string[], options: { cwd: string }) => {
      failedHome = options.cwd;
      throw new Error("private synchronous spawn details");
    }) as unknown as typeof spawn;
    await assert.rejects(runIsolatedHealthProbe({ executable: "unused", root, sourceEnvironment: {}, timeoutMilliseconds: 1000 }, { spawn: throwingSpawn }), { message: "Update health probe failed." });
    await assert.rejects(stat(failedHome), { code: "ENOENT" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runIsolatedHealthProbe({ executable: "unused", root, sourceEnvironment: {}, timeoutMilliseconds: 1000, signal: controller.signal }, { spawn: (() => { assert.fail("must not spawn"); }) as unknown as typeof spawn }), { message: "Update health probe failed." });
  } finally { await rm(root, { recursive: true, force: true }); }
});
