import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { parseTrustedDesktopWorkspaceArg } from "../../dist/desktop/workspace.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type FixtureOptions = {
  hold?: "ready" | "workspace" | "runtime" | "load";
  fail?: "local" | "session" | "window" | "updates" | "bridge" | "ipc" | "load";
  remote?: boolean;
  lineEndings?: "crlf";
};

async function fixture(options: FixtureOptions = {}) {
  const source = (await readFile(new URL("../../desktop/main.mjs", import.meta.url), "utf8"))
    .replace(/\r?\n/g, options.lineEndings === "crlf" ? "\r\n" : "\n");
  const handlers = new Map<string, unknown>();
  const order: string[] = [];
  const logs: unknown[][] = [];
  const gate = deferred();
  let creations = 0;
  let windows = 0;
  let disposals = 0;
  let localCloses = 0;
  const local = { close() { localCloses++; order.push("local-close"); } };
  const fail = (phase: FixtureOptions["fail"]) => { if (options.fail === phase) throw new Error("private-startup-detail"); };
  let destroyed = false;
  let closes = 0;
  let quits = 0;
  let allowedQuits = 0;
  const signals = new EventEmitter();
  let resolveCleanup!: () => void;
  let rejectCleanup!: (error: Error) => void;
  const cleanup = new Promise<void>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject; });
  const runtime = { dispose() { disposals++; order.push("runtime-dispose"); return cleanup; } };
  async function createRuntime() {
    creations++;
    if (options.hold === "runtime") await gate.promise;
    return runtime;
  }
  let send!: (event: unknown) => void;
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, loadURL: async () => { fail("load"); if (options.hold === "load") await gate.promise; }, isDestroyed: () => destroyed,
    destroy() { destroyed = true; order.push("destroy"); window.emit("closed"); },
  });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, whenReady: async () => { if (options.hold === "ready") await gate.promise; },
    quit() { quits++; let prevented = false; app.emit("before-quit", { preventDefault() { prevented = true; order.push("prevent"); } }); if (!prevented) { allowedQuits++; order.push("allowed-exit"); } },
  });
  const context = vm.createContext({
    app, process: { argv: [], env: options.remote ? { DRAGONS_RUNTIME_URL: "fixture" } : {}, cwd: () => "/fixture", on: signals.on.bind(signals) },
    console: { error: (...args: unknown[]) => logs.push(args) },
    URL, crypto: { randomUUID: () => "fixture" }, fileURLToPath: () => "/fixture/preload.cjs",
    BrowserWindow: function () { fail("window"); windows++; return window; }, desktopLocalControls: () => { fail("local"); return local; },
    DesktopUpdateController: class { constructor() { fail("updates"); } close() { order.push("updates-close"); } },
    DesktopBridge: class {
      constructor(_runtime: unknown, sink: (event: unknown) => void) { fail("bridge"); send = sink; }
      close() { closes++; order.push("bridge-close"); local.close(); return runtime.dispose(); }
    },
    session: { fromPartition: () => { fail("session"); return ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }); } },
    ipcMain: { handle: (key: string, callback: unknown) => { if (key === "dragons:events") fail("ipc"); handlers.set(key, callback); }, removeHandler: (key: string) => {
      assert.equal(destroyed, true, "destroy must precede IPC removal"); order.push(key); handlers.delete(key);
    } },
    isHealthProbeLaunch: () => false,
    parseTrustedDesktopWorkspaceArg,
    selectDesktopWorkspace: async () => { if (options.hold === "workspace") await gate.promise; return "/fixture"; }, createDesktopRuntime: createRuntime, connectRemoteRuntime: createRuntime,
  });
  // Execute the actual launcher and before-quit registration, not an openDesktop-only slice.
  const executable = source.replace(/^import .*;\r?\n/gm, "").replace("export async function", "async function")
    .replaceAll("import.meta.url", JSON.stringify("file:///fixture/main.mjs"))
    .replace("desktop = owner;", "desktop = owner; globalThis.desktop = owner;");
  vm.runInContext(executable, context);
  await flush();
  if (!options.hold && !options.fail) assert.ok(context.desktop, "real launcher published its owner");
  return { gate, localCloses: () => localCloses, creations: () => creations, windows: () => windows, disposals: () => disposals, app, contents, window, context, cleanup, rejectCleanup, resolveCleanup, signals, allowedQuits: () => allowedQuits, logs, order, handlers,
    send: (event: unknown) => send(event), closes: () => closes, quits: () => quits };
}

test("main lifecycle fixture also runs when checkout uses CRLF", async () => {
  const f = await fixture({ lineEndings: "crlf" });
  f.app.quit();
  assert.equal(f.closes(), 1);
  f.resolveCleanup();
  await flush();
  assert.equal(f.allowedQuits(), 1);
});

for (const lifecycle of ["render-process-gone", "unresponsive", "closed", "did-start-navigation"]) {
  test(`main owns rejected ${lifecycle} cleanup without changing the external close contract`, async () => {
    const f = await fixture();
    (lifecycle === "closed" ? f.window : f.contents).emit(lifecycle);
    const closing = f.context.desktop.close();
    assert.equal(closing, f.cleanup);
    assert.equal(f.context.desktop.close(), closing);
    f.rejectCleanup(new Error("private-cleanup-detail"));
    await flush();
    await assert.rejects(closing, /private-cleanup-detail/);
    assert.equal(f.closes(), 1, "destroy's synchronous closed event must reuse cleanup");
    assert.equal(f.handlers.size, 0);
    assert.ok(f.order.indexOf("destroy") < f.order.indexOf("dragons:request"));
    assert.ok(f.logs.length > 0);
    assert.ok(f.logs.every((args) => args.length === 1 && args[0] === "Desktop cleanup failed."));
  });
}

test("overflow owns rejected bridge cleanup without leaking private errors", async () => {
  const f = await fixture();
  for (let i = 0; i < 257; i++) f.send({ type: "fixture" });
  assert.equal(f.closes(), 1);
  f.rejectCleanup(new Error("private-overflow-detail"));
  await flush();
  assert.deepEqual(f.logs, [["Desktop cleanup failed."]]);
});

test("real before-quit chain quits once after rejection and owns its terminal rejection", async () => {
  const f = await fixture();
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  f.app.emit("before-quit", event);
  f.app.emit("before-quit", event);
  assert.equal(prevented, 2);
  assert.equal(f.quits(), 0, "quit waits for cleanup settlement");
  assert.equal(f.closes(), 1);
  f.rejectCleanup(new Error("private-quit-detail"));
  await flush(); await flush();
  assert.equal(f.quits(), 1, "app.quit reentrancy must not start another shutdown");
  assert.equal(f.handlers.size, 0);
  assert.ok(f.logs.length > 0);
  assert.ok(f.logs.every((args) => args.length === 1 && args[0] === "Desktop cleanup failed."));
  // node:test reports any unhandled rejection from the real lifecycle/quit chains as failure.
});

for (const rejected of [false, true]) {
  test(`all repeated quit events and signals wait for cleanup (${rejected ? "reject" : "resolve"})`, async () => {
    const f = await fixture();
    f.app.quit();
    f.app.emit("window-all-closed");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGINT"]) f.signals.emit(signal);
    assert.equal(f.allowedQuits(), 0, "no quit event may bypass pending disposal");
    assert.equal(f.closes(), 1);
    assert.equal(f.handlers.size, 0);
    if (rejected) f.rejectCleanup(new Error("private-cleanup-detail")); else f.resolveCleanup();
    await flush(); await flush();
    assert.equal(f.allowedQuits(), 1, "one final quit is allowed only after cleanup settles");
    assert.equal(f.closes(), 1);
    assert.ok(f.logs.every((args) => args.length === 1 && args[0] === "Desktop cleanup failed."));
  });
}

for (const rejected of [false, true]) {
  test(`quit during pending loadURL disposes before exit without waiting for navigation (${rejected ? "reject" : "resolve"})`, async () => {
    const f = await fixture({ hold: "load" });
    assert.equal(f.handlers.size, 2, "renderer IPC is already live while loadURL is pending");
    f.app.quit();
    f.app.quit();
    assert.equal(f.closes(), 1);
    assert.equal(f.disposals(), 1);
    assert.equal(f.handlers.size, 0);
    assert.equal(f.allowedQuits(), 0);
    f.order.push("cleanup-settled");
    if (rejected) f.rejectCleanup(new Error("private-cleanup-detail")); else f.resolveCleanup();
    await flush();
    assert.equal(f.allowedQuits(), 1, "a never-settling loadURL must not hang shutdown");
    for (const step of ["bridge-close", "runtime-dispose", "dragons:request", "dragons:events", "cleanup-settled"]) {
      assert.ok(f.order.indexOf(step) < f.order.indexOf("allowed-exit"), step);
    }
    f.gate.reject(new Error("navigation aborted by quit"));
    await flush();
    assert.equal(f.allowedQuits(), 1);
    assert.equal(f.disposals(), 1);
    assert.ok(f.logs.every((args) => args.length === 1 && args[0] === "Desktop cleanup failed."));
  });
}

for (const hold of ["ready", "workspace"] as const) {
  test(`quit before ${hold} completes neither hangs nor starts a late runtime`, async () => {
    const f = await fixture({ hold });
    f.app.quit();
    await flush();
    assert.equal(f.allowedQuits(), 1);
    assert.equal(f.creations(), 0);
    f.gate.resolve();
    await flush();
    assert.equal(f.creations(), 0);
    assert.equal(f.windows(), 0);
    assert.equal(f.handlers.size, 0);
  });
}

for (const remote of [false, true]) {
  for (const rejected of [false, true]) {
    test(`quit during ${remote ? "remote" : "local"} runtime creation owns ${rejected ? "rejection" : "late runtime"}`, async () => {
      const f = await fixture({ hold: "runtime", remote });
      assert.equal(f.creations(), 1);
      f.app.quit();
      await flush();
      assert.equal(f.allowedQuits(), 0);
      if (rejected) f.gate.reject(new Error("private-runtime-detail")); else f.gate.resolve();
      await flush();
      if (!rejected) {
        assert.equal(f.disposals(), 1);
        assert.equal(f.allowedQuits(), 0);
        f.resolveCleanup();
        await flush();
      }
      assert.equal(f.allowedQuits(), 1);
      assert.equal(f.windows(), 0);
      assert.equal(f.handlers.size, 0);
    });
  }
}

for (const fail of ["local", "session", "window", "updates", "bridge", "ipc", "load"] as const) {
  for (const rejected of [false, true]) {
    test(`partial startup failure at ${fail} releases owned runtime and IPC before exit (${rejected ? "reject" : "resolve"})`, async () => {
      const f = await fixture({ fail });
      assert.equal(f.disposals(), 1);
      assert.equal(f.allowedQuits(), 0);
      assert.equal(f.handlers.size, 0);
      if (rejected) f.rejectCleanup(new Error("private-cleanup-detail")); else f.resolveCleanup();
      await flush();
      assert.equal(f.allowedQuits(), 1);
      assert.equal(f.disposals(), 1);
      assert.equal(f.localCloses(), fail === "local" ? 0 : 1);
      assert.ok(f.order.indexOf("runtime-dispose") < f.order.indexOf("allowed-exit"));
      assert.ok(f.logs.every((args) => !JSON.stringify(args).includes("private-startup-detail")));
    });
  }
}
