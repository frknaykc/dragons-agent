// Opt-in native-store acceptance using the packaged executable in Electron Node mode.
// Never reads default credential accounts; no GUI, provider inference or file fallback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let setupStage = 'arguments';
async function worker(archive) {
  setupStage = 'electron-host';
  assert.ok(process.versions.electron, 'Packaged Electron host required');
  setupStage = 'native-import';
  const require = createRequire(join(archive, 'package.json'));
  const { AsyncEntry } = require('@napi-rs/keyring');
  setupStage = 'provider-import';
  const { createNativeCodexCredentialStore } = await import(pathToFileURL(join(archive, 'dist/provider/credential-store.js')).href);
  setupStage = 'mcp-import';
  const { createNativeMcpBearerTokenStore } = await import(pathToFileURL(join(archive, 'dist/mcp-credential-store.js')).href);
  for (const kind of ['provider', 'mcp']) {
    const entry = new AsyncEntry('Dragons Agent M77 synthetic acceptance', randomUUID());
    const scope = { serverId: 'fixture', origin: 'https://example.invalid', credentialId: 'fixture' };
    const store = kind === 'provider' ? createNativeCodexCredentialStore({ entry }) : createNativeMcpBearerTokenStore({ entry });
    const fixture = kind === 'provider'
      ? { accessToken: 'synthetic-not-a-token', refreshToken: 'synthetic-not-a-refresh-token', expiresAt: '2000-01-01T00:00:00.000Z', tokenType: 'synthetic' }
      : 'synthetic-not-a-token';
    let cleanupRequired = false;
    let stage = 'initial-absence';
    try {
      assert.equal(await store.load(scope), undefined);
      cleanupRequired = true;
      stage = 'save';
      if (kind === 'provider') await store.save(fixture); else await store.save(scope, fixture);
      stage = 'readback';
      assert.deepEqual(await store.load(scope), fixture);
      stage = 'remove';
      await store.remove(scope);
      assert.equal(await store.load(scope), undefined);
      cleanupRequired = false;
      console.log(JSON.stringify({ status: 'PASS', kind, platform: process.platform, arch: process.arch, electron: process.versions.electron, scope: 'packaged-resources-electron-node-mode', deletionVerified: true }));
    } catch {
      console.log(JSON.stringify({ status: 'FAIL', kind, stage }));
      process.exitCode = 1;
    } finally {
      if (cleanupRequired) {
        try {
          await entry.deletePassword();
          assert.ok((await entry.getPassword()) == null);
          console.log('SYNTHETIC_ENTRY_CLEANUP_PASS');
        } catch {
          console.log('SYNTHETIC_ENTRY_CLEANUP_INCOMPLETE');
          process.exitCode = 1;
        }
      }
    }
    if (process.exitCode) break;
  }
}

async function main() {
  if (process.argv[2] === '--worker') {
    assert.equal(process.argv.length, 4);
    await worker(resolve(process.argv[3]));
    return;
  }
  assert.equal(process.argv.length, 4, 'Usage: node scripts/verify-desktop-credentials.mjs <packaged-executable> <app.asar>');
  const executable = resolve(process.argv[2]);
  const archive = resolve(process.argv[3]);
  const root = await mkdtemp(join(tmpdir(), 'dragons-packaged-credentials-'));
  try {
    const home = join(root, 'home');
    await mkdir(home);
    const env = { ELECTRON_RUN_AS_NODE: '1', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'), LOCALAPPDATA: join(home, 'local'), TMPDIR: root, TEMP: root, TMP: root, PATH: process.env.PATH || '' };
    // macOS Keychain needs the logged-in user's HOME. Only injected synthetic
    // entries are used; no application startup, config or credential file loader runs.
    if (process.platform === 'darwin' && process.env.HOME) env.HOME = process.env.HOME;
    for (const name of ['SystemRoot', 'WINDIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'XAUTHORITY']) if (process.env[name]) env[name] = process.env[name];
    const child = spawn(executable, [fileURLToPath(import.meta.url), '--worker', archive], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
    // Worker stdout contains only fixed-schema summaries, never stored payloads.
    let output = '';
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-8192); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
    try {
      const result = await new Promise((resolve_, reject) => {
        child.once('error', () => reject(new Error('Packaged credential host failed to start')));
        child.once('close', (code, signal) => resolve_({ code, signal }));
      });
      process.stdout.write(output);
      if (timedOut) throw new Error('Native acceptance timed out; synthetic entry cleanup is unverified');
      assert.equal(result.signal, null);
      assert.equal(result.code, 0);
      const results = output.trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(results.map((item) => item.kind), ['provider', 'mcp']);
      assert.ok(results.every((item) => item.status === 'PASS' && item.deletionVerified === true));
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
}

main().catch(() => {
  console.log(JSON.stringify({ status: 'FAIL', setupStage }));
  console.error('PACKAGED_CREDENTIAL_ACCEPTANCE_FAILED: native result or cleanup incomplete; no acceptance claimed');
  process.exitCode = 1;
});
