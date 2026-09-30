// Launch the packaged Electron executable in Node mode, then exercise the
// binding resolved from app.asar rather than the source-tree addon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'Windows packaged checkpoint acceptance requires Windows');
assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-windows-packaged-checkpoint.mjs <packaged executable>');
if (!process.versions.electron) {
  const executable = resolve(process.argv[2]);
  const archive = join(dirname(executable), 'resources', 'app.asar');
  const child = spawn(executable, [fileURLToPath(import.meta.url), archive], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4096); });
  child.stderr.resume(); // Native diagnostics may include machine-local paths.
  const deadline = setTimeout(() => child.kill(), 30000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, 'Packaged checkpoint probe timed out or was terminated');
    assert.equal(code, 0, 'Packaged checkpoint probe failed');
    assert.match(stdout, /WINDOWS_PACKAGED_CHECKPOINT_PASS/);
    console.log('WINDOWS_PACKAGED_CHECKPOINT_PASS binding / capture / mutation / rollback');
  } finally { clearTimeout(deadline); }
} else {
  const archive = resolve(process.argv[2]);
  const moduleUrl = pathToFileURL(join(archive, 'dist', 'checkpoint-win32.js')).href;
  const { safeCheckpointIoAvailable } = await import(moduleUrl);
  assert.equal(safeCheckpointIoAvailable, true, 'Packaged Windows checkpoint binding is not loadable');
  const { SessionCheckpoints } = await import(pathToFileURL(join(archive, 'dist', 'checkpoint.js')).href);
  const root = await mkdtemp(join(tmpdir(), 'dragons-packaged-checkpoint-'));
  try {
    const target = join(root, 'fixture.txt');
    await writeFile(target, 'before');
    const history = new SessionCheckpoints(root);
    const mutation = history.mutate([{ path: 'fixture.txt', content: 'after' }]);
    assert.equal(mutation.ok, true, 'Packaged checkpoint mutation failed');
    assert.equal(await readFile(target, 'utf8'), 'after');
    const id = history.list().split(':')[0];
    assert.ok(id.startsWith('cp-'));
    const rollback = history.rollback(id);
    assert.equal(rollback.ok, true, 'Packaged checkpoint rollback failed');
    assert.equal(await readFile(target, 'utf8'), 'before');
    console.log('WINDOWS_PACKAGED_CHECKPOINT_PASS binding / capture / mutation / rollback');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
