import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

if (process.versions.electron) {
  void (async () => {
  const { app, BrowserWindow, ipcMain, session } = createRequire(import.meta.url)('electron');
  app.setPath('userData', process.env.DRAGONS_LAYOUT_TEMP);
  app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  const { createDesktopSecretPrompt } = await import('../../desktop/secret-prompt.mjs');
  const parent = new BrowserWindow({ show: false });
  const prompt = createDesktopSecretPrompt({ BrowserWindow, ipcMain, session, parent });
  try {
    for (const size of [undefined, [320, 240]]) {
      const result = prompt(new AbortController().signal);
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate !== parent);
      await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
      if (size) window.setContentSize(...size);
      if (process.env.DRAGONS_LAYOUT_BASELINE) await window.webContents.executeJavaScript("document.body.classList.remove('secret-page')");
      const geometry = await window.webContents.executeJavaScript(`(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}; };
        return { title:rect('h1'), description:rect('main > p'), label:rect('label'), input:rect('#secret'), save:rect('[type=submit]'), cancel:rect('#cancel'), width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth, type:document.querySelector('#secret').type, autocomplete:document.querySelector('#secret').autocomplete, blank:document.querySelector('#secret').value === '' };
      })()`);
      assert.ok(geometry.title.bottom <= geometry.description.top, 'title must precede description');
      assert.ok(geometry.description.bottom <= geometry.label.top, 'description must not overlap API-key label');
      assert.ok(geometry.label.bottom <= geometry.input.top, 'label must precede input');
      assert.ok(geometry.input.bottom <= geometry.cancel.top, 'actions must follow input');
      assert.ok(geometry.cancel.bottom <= geometry.height, 'Cancel must be visible');
      assert.ok(geometry.save.right <= geometry.cancel.left, 'actions must not overlap');
      assert.ok(geometry.scrollWidth <= geometry.width, 'no horizontal overflow');
      assert.equal(geometry.type, 'password');
      assert.equal(geometry.autocomplete, 'off');
      assert.equal(geometry.blank, true);
      // Exercise the real renderer click listener and IPC, not a synthetic host cancel.
      await window.webContents.executeJavaScript("document.querySelector('#cancel').click(); true").catch(() => {});
      assert.equal(await result, undefined);
      assert.equal(window.isDestroyed(), true);
    }
    writeSync(1, 'SECRET_LAYOUT_CANCEL_OK\n');
    parent.destroy(); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  })();
} else {
  test('secret layout at native dialog size and 320x240; blank Cancel IPC closes and releases pending', { timeout: 30000 }, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'dragons-secret-layout-'));
    try {
      const electron = createRequire(import.meta.url)('electron');
      const env = { ...process.env, DRAGONS_LAYOUT_TEMP: temporary };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(electron, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: 25000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SECRET_LAYOUT_CANCEL_OK/);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}
