import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDesktopSecretPrompt } from '../../desktop/secret-prompt.mjs';

function fixture() {
  const handlers = new Map();
  const windows = [];
  const ipcMain = { handle(name, handler) { assert.equal(handlers.has(name), false); handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } };
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, setWindowOpenHandler(handler) { this.openHandler = handler; } });
    constructor(options) { super(); this.options = options; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
  }
  const parent = new Window({});
  const policies = [];
  const session = { fromPartition(name) {
    assert.ok(!name.startsWith('persist:'));
    const policy = { setPermissionRequestHandler(handler) { this.permission = handler; }, setPermissionCheckHandler(handler) { this.check = handler; }, webRequest: { onBeforeRequest(handler) { policy.network = handler; } } };
    policies.push(policy); return policy;
  } };
  const prompt = createDesktopSecretPrompt({ BrowserWindow: Window, ipcMain, session, parent });
  const submit = (value, event) => {
    const window = windows.at(-1);
    return handlers.get('dragons:secret-submit')(event ?? { sender: window.webContents, senderFrame: window.webContents.mainFrame }, value);
  };
  return { prompt, windows, parent, handlers, policies, submit };
}

test('secret dialog isolates exact sender, bounds input, destroys one-shot view, and never returns a key over IPC', async () => {
  const f = fixture(); const controller = new AbortController();
  const result = f.prompt(controller.signal);
  const window = f.windows.at(-1);
  assert.equal(window.options.modal, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.devTools, false);
  assert.equal(f.submit('synthetic-key', { sender: f.parent.webContents, senderFrame: window.webContents.mainFrame }), false);
  assert.equal(f.submit('synthetic-key', { sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } }), false);
  const url = window.webContents.mainFrame.url;
  window.webContents.mainFrame.url = 'https://untrusted.invalid';
  assert.equal(f.submit('synthetic-key'), false);
  window.webContents.mainFrame.url = url;
  for (const value of ['', 'with whitespace', 'x'.repeat(8193), { key: 'synthetic-key' }, null]) assert.equal(f.submit(value), false);
  await assert.rejects(f.prompt(controller.signal), /already open/);
  assert.equal(f.submit('synthetic-key'), true);
  assert.equal(await result, 'synthetic-key');
  assert.equal(window.isDestroyed(), true);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.parent.listenerCount('closed'), 0);
});

test('secret dialog closes on abort, cancel, parent close, crash and navigation; no credential is retained', async () => {
  for (const action of ['abort', 'cancel', 'parent', 'crash', 'navigation', 'close']) {
    const f = fixture(); const controller = new AbortController(); const result = f.prompt(controller.signal);
    const window = f.windows.at(-1);
    if (action === 'abort') controller.abort();
    if (action === 'cancel') f.submit(undefined);
    if (action === 'parent') f.parent.destroy();
    if (action === 'crash') window.webContents.emit('render-process-gone');
    if (action === 'navigation') window.webContents.emit('will-navigate', { preventDefault() {} });
    if (action === 'close') window.destroy();
    assert.equal(await result, undefined);
    assert.equal(window.isDestroyed(), true);
    assert.equal(f.handlers.size, 0);
  }
  const f = fixture(); const controller = new AbortController(); controller.abort();
  assert.equal(await f.prompt(controller.signal), undefined);
  assert.equal(f.windows.length, 1);
});

test('secret view denies network/permissions and exposes no generic runtime bridge', async () => {
  const f = fixture(); const controller = new AbortController(); const result = f.prompt(controller.signal);
  const policy = f.policies[0];
  assert.equal(policy.check(), false);
  policy.permission(null, 'clipboard-read', (allowed) => assert.equal(allowed, false));
  policy.network({ url: 'https://untrusted.invalid' }, ({ cancel }) => assert.equal(cancel, true));
  policy.network({ url: new URL('../../desktop/secret.html', import.meta.url).href }, ({ cancel }) => assert.equal(cancel, false));
  const html = await readFile(new URL('../../desktop/secret.html', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../../desktop/secret-preload.cjs', import.meta.url), 'utf8');
  const normalPreload = await readFile(new URL('../../desktop/preload.cjs', import.meta.url), 'utf8');
  const script = await readFile(new URL('../../desktop/secret.js', import.meta.url), 'utf8');
  const packaged = JSON.parse(await readFile(new URL('../../electron-builder.json', import.meta.url), 'utf8'));
  for (const name of ['secret-prompt.mjs', 'secret-preload.cjs', 'secret.html', 'secret.js']) assert.ok(packaged.files.includes(`desktop/${name}`));
  assert.match(html, /type="password"/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(preload, /dragons:request|dragons:events/);
  assert.doesNotMatch(normalPreload, /secret-submit/);
  assert.doesNotMatch(script, /console\.|localStorage|sessionStorage|dragons\.request/);
  assert.match(script, /input\.value = ''/);
  controller.abort(); await result;
});
