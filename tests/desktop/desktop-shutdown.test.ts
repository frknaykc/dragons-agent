import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { DesktopUpdateController } from "../../dist/desktop/update-controller.js";

test("desktop close destroys the polling renderer before removing IPC, without awaiting disposal", async () => {
  const source = await readFile(new URL("../../desktop/main.mjs", import.meta.url), "utf8");
  const binding = source.slice(source.indexOf("export async function openDesktop("), source.indexOf("\nif (app.isPackaged")).replace("export async", "async");
  const handlers = new Map<string, (...args: any[]) => any>();
  const removedWhileAlive: string[] = [];
  let destroyed = false; let disposals = 0;
  let finishDispose!: () => void;
  const disposal = new Promise<void>((resolve) => { finishDispose = resolve; });
  const page = "file:///fixture/index.html";
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: page }, setWindowOpenHandler() {} });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, loadURL: async () => {}, isDestroyed: () => destroyed,
    destroy() { destroyed = true; window.emit("closed"); },
  });
  const context = vm.createContext({ DesktopBridge, DesktopUpdateController, page,
    asset: (name: string) => new URL(name, page), fileURLToPath: () => "/fixture/preload.cjs", crypto: { randomUUID: () => "fixture" },
    BrowserWindow: function () { return window; }, desktopLocalControls: () => undefined,
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }) },
    ipcMain: { handle: (key: string, callback: (...args: any[]) => any) => handlers.set(key, callback), removeHandler: (key: string) => {
      if (!destroyed) removedWhileAlive.push(key);
      handlers.delete(key);
    } } });
  vm.runInContext(binding + "\nglobalThis.open = openDesktop;", context);
  const desktop = await context.open({ dispose: async () => { disposals++; await disposal; } });
  // Use the actual preload and renderer, with a manually advanced polling timer.
  const nodes = new Map<string, any>();
  const element = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", children: [], setAttribute() {}, focus() {}, append(n: any) { this.children.push(n); }, replaceChildren() { this.children = []; } });
    return nodes.get(id);
  };
  let tick: (() => void) | undefined;
  let missingHandlers = 0;
  const rendererWindow: any = { addEventListener() {} };
  vm.runInNewContext(await readFile(new URL("../../desktop/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { rendererWindow[name] = value; } },
      ipcRenderer: { invoke: async (channel: string, input: any) => {
        if (channel === "dragons:request") return { ok: true, value: input.type === "providers" ? [] : { state: "disabled" } };
        const handler = handlers.get(channel);
        if (!handler) { missingHandlers++; throw new Error(`No handler registered for '${channel}'`); }
        return handler({ sender: contents, senderFrame: contents.mainFrame });
      } } }),
  });
  vm.runInNewContext(await readFile(new URL("../../desktop/renderer.js", import.meta.url), "utf8"), {
    window: rendererWindow, document: { getElementById: element, createElement: () => element(`generated-${nodes.size}`) },
    setTimeout: (callback: () => void) => { tick = callback; }, Error, Promise,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(tick, "renderer reached its 50ms polling wait");
  const closing = desktop.close();
  assert.equal(desktop.close(), closing, "reentrant closed event retains the same cleanup promise");
  // A live Electron renderer runs its pending timer while runtime disposal waits.
  if (!destroyed) tick();
  await new Promise((resolve) => setImmediate(resolve));
  finishDispose(); await closing;
  assert.equal(missingHandlers, 0, "polling must not outlive IPC ownership");
  assert.deepEqual(removedWhileAlive, []);
  assert.equal(destroyed, true);
  assert.equal(disposals, 1);
  assert.equal(handlers.size, 0);
});
