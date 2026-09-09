// Opt-in native picker acceptance. No remote runtime, provider call or production test hook.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathExists } from './desktop-linux-acceptance.mjs';
import { assertPickerBinding } from './desktop-picker-acceptance.mjs';
const exec = promisify(execFile);
const run = (command, args) => exec(command, args, { timeout: 25000, maxBuffer: 8192 });
const pause = () => new Promise((r) => setTimeout(r, 100));
async function until(probe, timeout = 15000) {
  const end = Date.now() + timeout;
  do { const value = await probe(); if (value) return value; await pause(); } while (Date.now() < end);
  throw new Error('Acceptance condition unmet');
}
async function drive(child, mode, workspace) {
  if (process.platform === 'win32') {
    const result = await run('pwsh', ['-NoProfile', '-File', 'scripts/drive-desktop-picker.ps1', '-ApplicationPid', String(child.pid), '-Mode', mode, '-Workspace', workspace]);
    assert.equal(result.stdout.trim(), `NATIVE_PICKER_DRIVEN ${mode}`);
    return;
  }
  const window = await until(async () => {
    try {
      const ids = (await run('xdotool', ['search', '--onlyvisible', '--pid', String(child.pid), '--name', '^Choose a Dragons workspace$'])).stdout.trim().split('\n');
      assert.equal(ids.length, 1); assert.match(ids[0], /^\d+$/); return ids[0];
    } catch (error) { if (error.code === 1) return false; throw error; }
  });
  await run('xdotool', ['windowfocus', '--sync', window]);
  assert.equal((await run('xdotool', ['getwindowfocus'])).stdout.trim(), window);
  if (mode === 'cancel') await run('xdotool', ['key', '--clearmodifiers', 'Escape']);
  else {
    await run('xdotool', ['key', '--clearmodifiers', 'ctrl+l']);
    await run('xdotool', ['type', '--clearmodifiers', '--', workspace + '/']);
    await run('xdotool', ['key', '--clearmodifiers', 'Return']);
    // GTK folder selection: the location entry navigates; Open confirms the directory.
    try {
      if ((await run('xdotool', ['getwindowname', window])).stdout.trim() === 'Choose a Dragons workspace') {
        await run('xdotool', ['key', '--clearmodifiers', 'alt+o']);
      }
    } catch (error) { if (error.code !== 1) throw error; }
  }
}
async function scenario(executable, mode) {
  const root = await mkdtemp(join(tmpdir(), 'dragons-native-picker-'));
  let child, socket, ended = false, spawnFailed = false, stage = 'setup', sequence = 0;
  let exit;
  try {
    const home = join(root, 'home'), workspace = join(root, 'selected workspace'), launchDirectory = join(root, 'launcher');
    for (const directory of [home, workspace, launchDirectory]) await mkdir(directory);
    const config = join(home, 'config');
    const state = join(config, process.platform === 'win32' ? 'Dragons Agent' : 'dragons-agent');
    const env = { HOME: home, USERPROFILE: home, APPDATA: config, XDG_CONFIG_HOME: config, LOCALAPPDATA: join(home, 'local'),
      PATH: process.env.PATH || '', TMPDIR: root, TMP: root, TEMP: root };
    for (const key of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'CHROME_DEVEL_SANDBOX']) if (process.env[key]) env[key] = process.env[key];
    let debugging, buffer = '';
    child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'chromium')}`], { cwd: launchDirectory, env, stdio: ['ignore', 'ignore', 'pipe'] });
    exit = new Promise((r) => {
      child.once('exit', (code, signal) => { ended = true; r([code, signal]); });
      child.once('error', () => { spawnFailed = true; ended = true; r([null, 'spawn-error']); });
    });
    child.stderr.on('data', (chunk) => {
      buffer = (buffer + chunk).slice(-8192);
      debugging = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1] || debugging;
    });
    stage = 'native-dialog';
    await drive(child, mode, workspace);
    if (mode === 'cancel') {
      stage = 'cancel-exit';
      await until(() => ended);
      assert.deepEqual(await exit, [0, null]);
      for (const name of ['sessions', 'memory', 'skills', 'config.json']) {
        assert.equal(await pathExists(join(state, name)), false, 'Cancellation persisted Dragons state');
      }
    } else {
      stage = 'renderer-discovery';
      await until(() => { assert.equal(ended, false); return debugging; });
      const origin = debugging.replace(/^ws:/, 'http:');
      const page = await until(async () => {
        assert.equal(ended, false);
        const pages = await (await fetch(new URL('/json/list', origin), { signal: AbortSignal.timeout(2000) })).json();
        return pages.find((p) => p.type === 'page' && p.url.endsWith('/desktop/index.html'));
      });
      socket = new WebSocket(page.webSocketDebuggerUrl);
      await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
      const evaluate = (expression) => new Promise((yes, no) => {
        const id = ++sequence;
        const timer = setTimeout(() => { socket.removeEventListener('message', receive); no(new Error('Evaluation deadline')); }, 5000);
        function receive(event) {
          const reply = JSON.parse(event.data); if (reply.id !== id) return;
          clearTimeout(timer); socket.removeEventListener('message', receive);
          if (reply.error || reply.result?.exceptionDetails) no(new Error('Evaluation failed'));
          else yes(reply.result?.result?.value);
        }
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      });
      stage = 'session-creation';
      await until(() => evaluate('document.querySelector("#provider")?.options.length > 1 && !document.querySelector("#create").disabled'));
      assert.deepEqual(await evaluate('[typeof require, typeof process]'), ['undefined', 'undefined']);
      await evaluate('document.querySelector("#create").click()');
      await until(() => evaluate('document.querySelector("#send")?.disabled === false'));
      const sessionDirectory = join(state, 'sessions');
      const files = (await readdir(sessionDirectory)).filter((name) => name.endsWith('.json'));
      assert.equal(files.length, 1);
      const session = JSON.parse(await readFile(join(sessionDirectory, files[0]), 'utf8'));
      await assertPickerBinding(session, workspace, launchDirectory, await evaluate('document.querySelector("#session").textContent'));
      stage = 'graceful-quit';
      socket.send(JSON.stringify({ id: ++sequence, method: 'Page.close' }));
      await until(() => ended);
      assert.deepEqual(await exit, [0, null]);
    }
    assert.equal(spawnFailed, false);
  } catch {
    throw new Error(`NATIVE_PICKER_FAILED mode=${mode} stage=${stage} (native output suppressed)`);
  } finally {
    socket?.close();
    if (child?.pid && !ended) {
      if (process.platform === 'win32') await run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
      await until(() => ended, 5000);
    }
    await rm(root, { recursive: true, force: true });
    assert.equal(await pathExists(root), false);
  }
  console.log(`NATIVE_PICKER_PASS ${mode} / real dialog / clean exit / isolated state cleanup`);
}
try {
  assert.equal(process.argv.length, 3);
  assert.ok(['linux', 'win32'].includes(process.platform));
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  if (process.platform === 'linux') assert.notEqual(process.getuid(), 0);
  const executable = resolve(process.argv[2]);
  await scenario(executable, 'cancel');
  await scenario(executable, 'select');
} catch (error) {
  console.error(error.message.startsWith('NATIVE_PICKER_FAILED ') ? error.message : 'NATIVE_PICKER_FAILED precondition or cleanup');
  process.exitCode = 1;
}
