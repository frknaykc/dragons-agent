import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { DesktopUpdateController } from "../../dist/desktop/update-controller.js";

// Execute the actual main-process composition with deterministic Electron endpoints.
test("M78 main IPC authenticates the frame and closes update ownership on reload/crash/close", async () => {
  const source = await readFile(new URL("../../desktop/main.mjs", import.meta.url), "utf8");
  const binding = source.slice(source.indexOf("export async function openDesktop("), source.indexOf("\nif (app.isPackaged" )).replace("export async", "async");
  assert.ok(binding.startsWith("async function openDesktop("));
  for (const lifecycle of ["did-start-navigation", "render-process-gone", "closed"]) {
    const handlers = new Map<string, (...args: any[]) => any>();
    let closes = 0; let disposed = 0; let destroyed = false;
    class Updates extends DesktopUpdateController {
      override close() { closes++; return super.close(); }
    }
    const page = "file:///fixture/index.html";
    const contents = Object.assign(new EventEmitter(), { mainFrame: { url: page }, setWindowOpenHandler() {} });
    const window = Object.assign(new EventEmitter(), { webContents: contents, loadURL: async () => {}, destroy: () => { destroyed = true; }, isDestroyed: () => destroyed });
    const context = vm.createContext({ DesktopBridge, DesktopUpdateController: Updates, page,
      asset: (name: string) => new URL(name, page), fileURLToPath: () => "/fixture/preload.cjs", crypto: { randomUUID: () => "fixture" },
      BrowserWindow: function () { return window; }, desktopLocalControls: () => undefined,
      session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } }) },
      ipcMain: { handle: (key: string, callback: (...args: any[]) => any) => handlers.set(key, callback), removeHandler: (key: string) => handlers.delete(key) } });
    vm.runInContext(binding + "\nglobalThis.open = openDesktop;", context);
    const desktop = await context.open({ dispose: async () => { disposed++; } });
    const request = handlers.get("dragons:request")!;
    const valid = { sender: contents, senderFrame: contents.mainFrame };
    assert.equal((await request(valid, { type: "update_check" })).value.state, "disabled");
    assert.equal((await request({ ...valid, senderFrame: { url: page } }, { type: "update_check" })).ok, false);
    assert.equal((await request({ ...valid, sender: {} }, { type: "update_status" })).ok, false);
    assert.equal((await request(valid, { type: "update_check", manifestUrl: "https://evil.invalid" })).ok, false);
    (lifecycle === "closed" ? window : contents).emit(lifecycle);
    await desktop.close();
    assert.equal(closes, 1); assert.equal(disposed, 1); assert.equal(handlers.size, 0);
    assert.equal((await request(valid, { type: "update_check" })).ok, false);
  }
});
