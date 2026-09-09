// macOS image acceptance in a disposable user directory, never /Applications.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

export async function verifyDesktopDmg(image, {
  execute = exec,
  createRoot = () => mkdtemp(join(tmpdir(), 'dragons-dmg-')),
  remove = rm,
  warn = console.error,
} = {}) {
  const root = await createRoot();
  const mount = join(root, 'mounted');
  const installed = join(root, 'installed', 'Dragons Agent.app');
  let mountMayExist = false;
  try {
    await mkdir(mount); await mkdir(join(root, 'installed'));
    // A timeout/rejection can occur after the OS has already mounted the image.
    mountMayExist = true;
    await execute('hdiutil', ['attach', image, '-readonly', '-nobrowse', '-mountpoint', mount], { timeout: 60000 });
    await execute('ditto', [join(mount, 'Dragons Agent.app'), installed], { timeout: 60000 });
    await execute('hdiutil', ['detach', mount], { timeout: 30000 });
    mountMayExist = false;
    await execute(process.execPath, ['scripts/verify-desktop-package.mjs', join(installed, 'Contents', 'Resources', 'app.asar')], { timeout: 30000 });
    await execute(process.execPath, ['scripts/verify-desktop-installed.mjs', join(installed, 'Contents', 'MacOS', 'Dragons Agent')], { timeout: 60000 });
    await remove(join(root, 'installed'), { recursive: true, force: true });
  } finally {
    if (mountMayExist) {
      try { await execute('hdiutil', ['detach', mount], { timeout: 30000 }); mountMayExist = false; }
      catch { warn(`DMG cleanup requires manual detach: ${mount}`); }
    }
    // A successful detach is required before recursive deletion after any attach attempt.
    // If attach failed before mounting and detach also fails, retain the directory conservatively.
    if (!mountMayExist) await remove(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.platform, 'darwin', 'DMG acceptance requires macOS');
  assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-desktop-dmg.mjs <dmg>');
  try {
    await verifyDesktopDmg(resolve(process.argv[2]));
    console.log('DESKTOP_DMG_SMOKE_PASS read-only mount / copy / detach / archive audit / packaged runtime / remove copied app');
  } catch {
    process.exitCode = 1;
    console.error('DESKTOP_DMG_SMOKE_FAILED (raw subprocess output suppressed)');
  }
}
