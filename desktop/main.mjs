import { app, BrowserWindow, ipcMain, session } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DesktopBridge } from '../dist/desktop/bridge.js';
import { createDesktopRuntime } from '../dist/desktop/host.js';

const asset = (name) => new URL(name, import.meta.url);
const page = asset('index.html').href;

/** One sandboxed local view and one owned runtime. No renderer-chosen workspace. */
export async function openDesktop(runtime) {
  const isolated = session.fromPartition(`dragons-${crypto.randomUUID()}`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  const assets = new Set(['index.html', 'renderer.js', 'style.css'].map((name) => asset(name).href));
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assets.has(details.url) }));
  const window = new BrowserWindow({
    width: 1040, height: 760, minWidth: 640, minHeight: 480, title: 'Dragons Agent',
    webPreferences: {
      session: isolated, preload: fileURLToPath(asset('preload.cjs')),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, navigateOnDragDrop: false,
    },
  });
  let events = [];
  let bytes = 0;
  let closed = false;
  const bridge = new DesktopBridge(runtime, (event) => {
    if (closed) return;
    const size = JSON.stringify(event).length;
    if (events.length >= 256 || bytes + size > 524288) {
      events = [{ type: 'client_disconnected', message: 'Event capacity exceeded. Reopen the window to resume.' }];
      bytes = 0;
      closed = true;
      void bridge.close();
      return;
    }
    events.push(event); bytes += size;
  });
  function trusted(event) {
    return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
  }
  // This foundation deliberately supports one window. IPC exposes no Electron objects.
  ipcMain.handle('dragons:request', async (event, input) => {
    if (!trusted(event) || closed) return { ok: false, error: { code: 'CLOSED', message: 'Client unavailable.' } };
    return bridge.request(input);
  });
  ipcMain.handle('dragons:events', (event) => {
    if (!trusted(event)) return [];
    const batch = events; events = []; bytes = 0; return batch;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  let cleanup;
  function close() {
    if (cleanup) return cleanup;
    closed = true; events = []; bytes = 0;
    ipcMain.removeHandler('dragons:request'); ipcMain.removeHandler('dragons:events');
    cleanup = bridge.close();
    return cleanup;
  }
  window.webContents.on('render-process-gone', () => { void close(); window.destroy(); });
  window.webContents.on('unresponsive', () => { void close(); window.destroy(); });
  window.on('closed', () => { void close(); });
  try { await window.loadURL(page); } catch { await close(); window.destroy(); throw new Error('Desktop launch failed.'); }
  // Reload is a disconnect, not a new owner of an in-flight authorization.
  window.webContents.on('did-start-navigation', () => { void close(); if (!window.isDestroyed()) window.destroy(); });
  return { window, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let desktop;
  let exiting = false;
  app.on('before-quit', (event) => {
    if (exiting) return;
    event.preventDefault(); exiting = true;
    void (desktop?.close() ?? Promise.resolve()).finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());
  void (async () => { try {
    await app.whenReady();
    // Workspace is selected by the trusted launcher, never by UI messages.
    const runtime = await createDesktopRuntime(process.cwd());
    desktop = await openDesktop(runtime);
  } catch {
    console.error('Unable to open Dragons Desktop. Check local configuration and workspace.');
    app.quit();
  } })();
}
