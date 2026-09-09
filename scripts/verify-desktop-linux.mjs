// Real Linux distribution acceptance, only on disposable GitHub-hosted runners.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, unlink, rmdir, access, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoDebIntegration, pathExists as exists } from './desktop-linux-acceptance.mjs';
const exec = promisify(execFile);
const mode = process.argv[2];
const artifact = resolve(process.argv[3] || '.');
let stage = 'preconditions';
const run = async (file, args, extra = {}) => {
  try { return await exec(file, args, { timeout: 120000, maxBuffer: 1024 * 1024, ...extra }); }
  catch (error) {
    console.error(`LINUX_COMMAND_FAILED stage=${stage} tool=${file} code=${error.code}`);
    // Parser diagnostics contain policy paths, not application/provider payloads.
    if (file === 'sudo' && args[0] === 'apparmor_parser') console.error(String(error.stderr).slice(0, 2000));
    if (file === 'xvfb-run') {
      for (const line of `${error.stdout}\n${error.stderr}`.split('\n')) {
        if (line.startsWith('DESKTOP_INSTALLED_SMOKE_') || line.startsWith('PACKAGED_RENDERER_INITIAL_DOM_READY=')) console.error(line.slice(0, 512));
      }
      const diagnostic = String(error.stderr);
      console.error(JSON.stringify({ xvfbFailure: diagnostic.includes('xvfb-run: error:'), missingModule: diagnostic.includes('ERR_MODULE_NOT_FOUND'), permissionDenied: diagnostic.includes('EACCES'), stderrBytes: diagnostic.length }));
    }
    throw error;
  }
};

async function mountPresent(path) {
  try { await run('findmnt', ['--mountpoint', path, '--noheadings', '--output', 'TARGET']); return true; }
  catch (e) { if (e.code === 1) return false; throw e; }
}
async function withProfile(executable, smoke) {
  assert.match(executable, /^\/[a-zA-Z0-9 /._-]+$/);
  const name = 'dragons-distribution-ci';
  const target = `/etc/apparmor.d/${name}`;
  assert.equal(await exists(target), false, 'Do not replace an existing profile');
  const root = await mkdtemp(join(tmpdir(), 'dragons-profile-'));
  const source = join(root, 'profile');
  let installed = false;
  try {
    await writeFile(source, `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ${name} "${executable}" flags=(unconfined) {\n  userns,\n}\n`);
    installed = true;
    await run('sudo', ['install', '-o', 'root', '-g', 'root', '-m', '644', source, target]);
    await run('sudo', ['apparmor_parser', '-r', target]);
    await smoke();
  } finally {
    if (installed) {
      await run('sudo', ['apparmor_parser', '-R', target]);
      await run('sudo', ['rm', '--', target]);
    }
    await unlink(source);
    await rmdir(root);
  }
}
async function smoke(executable, archive, temporaryProfile = true) {
  const scope = stage;
  stage = `${scope}-archive`;
  await run(process.execPath, ['scripts/verify-desktop-package.mjs', archive]);
  stage = `${scope}-profile`;
  const launch = async () => {
    stage = `${scope}-runtime`;
    await run('xvfb-run', ['--auto-servernum', process.execPath, 'scripts/verify-desktop-installed.mjs', executable]);
  };
  if (temporaryProfile) await withProfile(executable, launch); else await launch();
}
async function deb() {
  stage = 'deb-metadata';
  const name = (await run('dpkg-deb', ['--field', artifact, 'Package'])).stdout.trim();
  assert.equal(name, 'dragons-agent');
  // Refuse any existing package state; never upgrade or remove an unrelated installation.
  try {
    await run('dpkg-query', ['--status', name]);
    throw new Error('Existing package');
  } catch (e) { if (e.code !== 1) throw e; }
  await assertNoDebIntegration({ run });
  let attempted = false;
  try {
    stage = 'deb-install';
    attempted = true;
    await run('sudo', ['apt-get', 'install', '-y', artifact]);
    const paths = (await run('dpkg-query', ['--listfiles', name])).stdout.trim().split('\n');
    const ownedFiles = [];
    for (const path of paths) {
      if (!(await lstat(path)).isDirectory()) ownedFiles.push(path);
    }
    const executables = paths.filter((path) => /^\/opt\/[^\n]+\/dragons-agent$/.test(path));
    assert.equal(executables.length, 1);
    const executable = executables[0];
    const directory = executable.slice(0, -'/dragons-agent'.length);
    stage = 'deb-smoke';
    // The DEB postinstall supplies its own exact-path AppArmor profile. A second
    // matching attachment would conflict; exercise the shipped policy unchanged.
    assert.equal(await exists('/etc/apparmor.d/dragons-agent'), true);
    await smoke(executable, join(directory, 'resources', 'app.asar'), false);
    stage = 'deb-remove';
    await run('sudo', ['dpkg', '--purge', name]);
    for (const path of ownedFiles) assert.equal(await exists(path), false, 'Package-owned file or symlink remains');
    assert.equal(await exists(executable), false);
    assert.equal(await exists(join(directory, 'resources', 'app.asar')), false);
    assert.equal(await exists(directory), false, 'Package installation directory remains');
    await assertNoDebIntegration({ run });
    try { await run('dpkg-query', ['--status', name]); throw new Error('Package still registered'); }
    catch (e) { if (e.code !== 1) throw e; }
    attempted = false;
  } finally {
    if (attempted) await run('sudo', ['dpkg', '--purge', name]);
  }
}
async function appimage() {
  const image = '/opt/dragons-distribution-ci.AppImage';
  assert.equal(await exists(image), false);
  let child, closed, mount, stopped = false, installed = false;
  try {
    stage = 'appimage-copy';
    installed = true;
    await run('sudo', ['install', '-o', 'root', '-g', 'root', '-m', '755', artifact, image]);
    stage = 'appimage-mount';
    child = spawn(image, ['--appimage-mount'], { stdio: ['ignore', 'pipe', 'ignore'] });
    closed = new Promise((resolve_) => { child.once('close', () => { stopped = true; resolve_(); }); });
    mount = await new Promise((resolve_, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Mount startup timeout')), 20000);
      const finish = (error, path) => { clearTimeout(timer); error ? reject(error) : resolve_(path); };
      child.once('error', () => finish(new Error('Mount launch failed')));
      child.once('exit', () => finish(new Error('Mount exited before readiness')));
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-4096);
        const path = output.split('\n').find((line) => /^\/tmp\/\.mount_[a-zA-Z0-9_-]+$/.test(line.trim()));
        if (path) finish(null, path.trim());
      });
    });
    assert.equal(await mountPresent(mount), true);
    stage = 'appimage-mounted-smoke';
    // Audit and launch the payload from the real read-only FUSE artifact, not an unpacked build.
    await smoke(join(mount, 'dragons-agent'), join(mount, 'resources', 'app.asar'));
  } finally {
    stage = 'appimage-cleanup';
    if (child && !stopped) child.kill('SIGTERM');
    if (closed) {
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Mount process did not stop')); }, 10000); })]); }
      finally { clearTimeout(timer); }
    }
    if (mount && await mountPresent(mount)) await run('fusermount', ['-u', mount]);
    if (mount) assert.equal(await mountPresent(mount), false);
    // Unknown mount startup is not a successful cleanup; retain the image conservatively.
    assert.ok(mount && stopped, 'Mount cleanup unverified');
    // Remove only an empty mountpoint after confirmed unmount; never recursively delete it.
    if (await exists(mount)) await rmdir(mount);
    assert.equal(await exists(mount), false);
    if (installed) await run('sudo', ['rm', '--', image]);
    assert.equal(await exists(image), false);
  }
}
try {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.notEqual(process.getuid(), 0);
  assert.equal(process.argv.length, 4);
  assert.ok(['deb', 'appimage'].includes(mode));
  await access(artifact);
  if (mode === 'deb') await deb(); else await appimage();
  console.log(`LINUX_DISTRIBUTION_PASS ${mode} / archive / sandboxed READ smoke / verified removal`);
} catch {
  console.error(`LINUX_DISTRIBUTION_FAILED stage=${stage}; no acceptance claimed`);
  process.exitCode = 1;
}
