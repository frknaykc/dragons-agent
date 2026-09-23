import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DesktopBridge } from '../dist/desktop/bridge.js';
import { createDesktopRuntime, desktopLocalControls } from '../dist/desktop/host.js';
import { connectRemoteRuntime } from '../dist/remote/runtime.js';
import { selectDesktopWorkspace } from '../dist/desktop/workspace.js';
import { createDesktopSecretPrompt } from './secret-prompt.mjs';
import { DesktopUpdateController } from '../dist/desktop/update-controller.js';
import { isHealthProbeLaunch } from '../dist/desktop/update-health.js';

const asset = (name) => new URL(name, import.meta.url);
const page = asset('index.html').href;

/** One sandboxed local view and one owned runtime. No renderer-chosen workspace. */
// Optional trusted launcher composition only; no workspace/environment discovery.
export async function openDesktop(runtime, trustedUpdates, publish = () => {}) {
  let window;
  let bridge;
  let local;
  let updates;
  let cleanup;
  let events = [];
  let bytes = 0;
  let closed = false;
  const channels = [];
  function close() {
    if (cleanup) return cleanup;
    closed = true; events = []; bytes = 0;
    // Publish cleanup before destroy() synchronously reenters through 'closed'.
    try {
      cleanup = bridge ? bridge.close() : Promise.resolve().then(async () => {
        try { await local?.close(); } catch { /* Continue disposing partial startup. */ }
        try { await runtime.dispose(); } finally { await updates?.close(); }
      });
    } catch (error) { cleanup = Promise.reject(error); }
    if (window && !window.isDestroyed()) window.destroy();
    for (const channel of channels) ipcMain.removeHandler(channel);
    channels.length = 0;
    return cleanup;
  }
  const owner = { get window() { return window; }, close };
  publish(owner);
  try {
    local = desktopLocalControls(runtime);
    const isolated = session.fromPartition(`dragons-${crypto.randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const assets = new Set(['index.html', 'renderer.js', 'style.css'].map((name) => asset(name).href));
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assets.has(details.url) }));
    window = new BrowserWindow({
      width: 1040, height: 760, minWidth: 640, minHeight: 480, title: 'Dragons Agent',
      webPreferences: {
        session: isolated, preload: fileURLToPath(asset('preload.cjs')),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false, navigateOnDragDrop: false,
      },
    });
    if (local?.loginApiKey) local.requestSecret = createDesktopSecretPrompt({ BrowserWindow, ipcMain, session, parent: window });
    updates = trustedUpdates instanceof DesktopUpdateController ? trustedUpdates : new DesktopUpdateController(trustedUpdates);
    bridge = new DesktopBridge(runtime, (event) => {
      if (closed) return;
      const size = JSON.stringify(event).length;
      if (events.length >= 256 || bytes + size > 524288) {
        events = [{ type: 'client_disconnected', message: 'Event capacity exceeded. Reopen the window to resume.' }];
        bytes = 0;
        closed = true;
        void bridge.close().catch(() => console.error('Desktop cleanup failed.'));
        return;
      }
      events.push(event); bytes += size;
    }, local, updates);
    function trusted(event) {
      return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
    }
    // This foundation deliberately supports one window. IPC exposes no Electron objects.
    ipcMain.handle('dragons:request', async (event, input) => {
      if (!trusted(event) || closed) return { ok: false, error: { code: 'CLOSED', message: 'Client unavailable.' } };
      return bridge.request(input);
    });
    channels.push('dragons:request');
    ipcMain.handle('dragons:events', (event) => {
      if (!trusted(event)) return [];
      const batch = events; events = []; bytes = 0; return batch;
    });
    channels.push('dragons:events');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', () => { void close().catch(() => console.error('Desktop cleanup failed.')); });
    window.webContents.on('unresponsive', () => { void close().catch(() => console.error('Desktop cleanup failed.')); });
    window.on('closed', () => { void close().catch(() => console.error('Desktop cleanup failed.')); });
    await window.loadURL(page);
    if (closed) return owner;
    // Reload is a disconnect, not a new owner of an in-flight authorization.
    window.webContents.on('did-start-navigation', () => { void close().catch(() => console.error('Desktop cleanup failed.')); });
    return owner;
  } catch { await close(); throw new Error('Desktop launch failed.'); }
}

if (app.isPackaged || (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)) {
  let desktop;
  let pendingRuntime;
  let exiting = false;
  let cleanupComplete = false;
  app.on('before-quit', (event) => {
    if (cleanupComplete) return;
    event.preventDefault();
    if (exiting) return;
    exiting = true;
    // Readiness/workspace prompts own no runtime and must not delay quit. Once
    // creation starts, retain its result for disposal even if it resolves late.
    // Never await loadURL here: destroying its window may leave it unsettled.
    void (desktop ? desktop.close() : pendingRuntime?.then(() => desktop?.close()) ?? Promise.resolve()).finally(() => {
      cleanupComplete = true;
      app.quit();
    }).catch(() => console.error('Desktop cleanup failed.'));
  });
  app.on('window-all-closed', () => app.quit());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());
  void (async () => { try {
    await app.whenReady();
    if (exiting) return;
    // This deliberately stops before workspace selection, config loading or runtime creation.
    if (isHealthProbeLaunch(process.argv)) {
      console.log('DRAGONS_UPDATE_HEALTH_OK');
      app.quit();
      return;
    }
    // Workspace is selected by the trusted launcher, never by UI messages.
    const workingDirectory = process.env.DRAGONS_RUNTIME_URL ? undefined : await selectDesktopWorkspace({
      packaged: app.isPackaged,
      workingDirectory: process.cwd(),
      selectDirectory: async () => {
        const selection = await dialog.showOpenDialog({ title: 'Choose a Dragons workspace', properties: ['openDirectory'] });
        return selection.canceled ? undefined : selection.filePaths[0];
      },
    });
    if (exiting) return;
    if (!process.env.DRAGONS_RUNTIME_URL && workingDirectory === undefined) { app.quit(); return; }
    pendingRuntime = (process.env.DRAGONS_RUNTIME_URL
      ? connectRemoteRuntime({ url: process.env.DRAGONS_RUNTIME_URL, token: process.env.DRAGONS_REMOTE_TOKEN || '' })
      : createDesktopRuntime(workingDirectory)).then((runtime) => {
        let cleanup;
        desktop = { close: () => cleanup ??= Promise.resolve().then(async () => {
          try { await desktopLocalControls(runtime)?.close(); } finally { await runtime.dispose(); }
        }) };
        return runtime;
      });
    const runtime = await pendingRuntime;
    if (exiting) return;
    await openDesktop(runtime, undefined, (owner) => { desktop = owner; });
  } catch {
    if (exiting) return;
    console.error('Unable to open Dragons Desktop. Check local configuration and workspace.');
    app.quit();
  } })();
}
