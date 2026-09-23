import { fileURLToPath } from 'node:url';

const asset = (name) => new URL(name, import.meta.url);
const page = asset('secret.html').href;
const channel = 'dragons:secret-submit';

/** Separate ephemeral renderer: no chat bridge, session IDs, credentials in URLs, or logs. */
export function createDesktopSecretPrompt({ BrowserWindow, ipcMain, session, parent }) {
  let pending = false;
  return (signal) => {
    if (signal.aborted || parent.isDestroyed()) return Promise.resolve(undefined);
    if (pending) return Promise.reject(new Error('Secret prompt already open.'));
    pending = true;
    return new Promise((resolve) => {
      let window;
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        parent.removeListener('closed', abort);
        ipcMain.removeHandler(channel);
        if (window && !window.isDestroyed()) window.destroy();
        pending = false;
        resolve(value);
      };
      const abort = () => finish(undefined);
      try {
        const isolated = session.fromPartition(`dragons-secret-${crypto.randomUUID()}`);
        isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        isolated.setPermissionCheckHandler(() => false);
        const assets = new Set(['secret.html', 'secret.js', 'style.css'].map((name) => asset(name).href));
        isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assets.has(details.url) }));
        window = new BrowserWindow({
          parent, modal: true, width: 520, height: 300, resizable: false, title: 'Save provider API key',
          webPreferences: {
            session: isolated, preload: fileURLToPath(asset('secret-preload.cjs')),
            sandbox: true, contextIsolation: true, nodeIntegration: false,
            webSecurity: true, webviewTag: false, navigateOnDragDrop: false, devTools: false,
          },
        });
        ipcMain.handle(channel, (event, value) => {
          if (finished || signal.aborted || event.sender !== window.webContents
            || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) return false;
          if (value !== undefined && (typeof value !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(value))) return false;
          finish(value);
          return true;
        });
        signal.addEventListener('abort', abort, { once: true });
        parent.once('closed', abort);
        window.on('closed', abort);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => { event.preventDefault(); abort(); });
        window.webContents.on('will-attach-webview', (event) => event.preventDefault());
        window.webContents.on('render-process-gone', abort);
        window.webContents.on('unresponsive', abort);
        void window.loadURL(page).then(() => {
          if (!finished) window.webContents.on('did-start-navigation', abort);
        }, abort);
        if (signal.aborted) abort();
      } catch {
        abort();
        // No native exception details or input escape this boundary.
      }
    });
  };
}
