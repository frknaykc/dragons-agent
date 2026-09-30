// Exercise packaged MoA selection and SHARE authorization without making provider requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDragonsConfigPath, saveDragonsConfig } from '../dist/config.js';

assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-desktop-installed-mixture.mjs <executable>');
const executable = resolve(process.argv[2]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'dragons-installed-mixture-')));
const home = join(root, 'home');
let child, socket, stage = 'setup';
const deadline = setTimeout(() => { child?.kill('SIGKILL'); process.exitCode = 1; }, 60_000);

try {
  await mkdir(home);
  const configPath = getDragonsConfigPath({ homeDirectory: home });
  await saveDragonsConfig({ provider: 'local', models: { local: 'fixture-local', 'openai-api': 'fixture-openai' } }, configPath);
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'),
    LOCALAPPDATA: join(home, 'local'), PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root };
  for (const name of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'CHROME_DEVEL_SANDBOX']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  stage = 'process-readiness';
  child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(root, 'chromium')}`, `--workspace=${root}`],
  { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  const debugging = await new Promise((done, reject) => {
    let buffer = '';
    child.once('error', () => reject(new Error('Packaged executable could not start')));
    child.once('exit', () => reject(new Error('Packaged executable exited before readiness')));
    child.stderr.on('data', (chunk) => {
      buffer = (buffer + chunk).slice(-8192);
      const match = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) done(match[1]);
    });
  });
  stage = 'renderer-discovery';
  let page;
  for (let i = 0; i < 100; i++) {
    const pages = await (await fetch(new URL('/json/list', debugging.replace(/^ws:/, 'http:')), { signal: AbortSignal.timeout(2000) })).json();
    page = pages.find((entry) => entry.type === 'page' && entry.url.endsWith('/desktop/index.html'));
    if (page) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(page, 'Packaged MoA renderer did not load');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  let sequence = 0;
  const evaluate = (expression) => new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Renderer evaluation timed out')); }, 5000);
    function receive(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer); socket.removeEventListener('message', receive);
      if (message.error || message.result?.exceptionDetails) reject(new Error('Renderer evaluation failed'));
      else done(message.result?.result?.value);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  const until = async (expression) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Packaged MoA acceptance condition unmet');
  };
  const send = (text) => evaluate(`document.querySelector('#prompt').value=${JSON.stringify(text)};document.querySelector('#composer').requestSubmit()`);
  await until('!!document.querySelector("#composer") && !!window.dragons?.request && !document.querySelector("#send").disabled');
  assert.deepEqual(await evaluate('[typeof require, typeof process, typeof window.dragons.request]'), ['undefined', 'undefined', 'function']);
  await evaluate('document.querySelector("#create").click()');
  await until('!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
  stage = 'moa-prepare';
  await send('/moa duo local openai-api --aggregate local -- Inspect this workspace');
  await until('document.querySelector("#messages").textContent.includes("/moa confirm SHARE") && !document.querySelector("#send").disabled');
  const preview = await evaluate('document.querySelector("#messages").textContent');
  assert.match(preview, /local:fixture-local.*openai-api:fixture-openai.*local:fixture-local.*SHARE/s);
  stage = 'moa-session-boundary';
  await evaluate('document.querySelector("#create").click()');
  await until('!document.querySelector("#send").disabled && !document.querySelector("#messages").textContent.includes("/moa confirm SHARE")');
  await send('/moa confirm SHARE');
  await until('document.querySelector("#messages").textContent.includes("not pending") && !document.querySelector("#send").disabled');
  stage = 'moa-model-change';
  await send('/moa duo local openai-api --aggregate local -- Inspect this workspace');
  stage = 'moa-model-change-preview';
  await until('document.querySelector("#messages").textContent.includes("/moa confirm SHARE") && !document.querySelector("#send").disabled');
  await saveDragonsConfig({ provider: 'local', models: { local: 'fixture-local', 'openai-api': 'fixture-changed' } }, configPath);
  await send('/moa confirm SHARE');
  stage = 'moa-model-change-rejection';
  await until('document.querySelector("#error").textContent === "Desktop runtime request failed." && !document.querySelector("#send").disabled');
  await send('/moa confirm SHARE');
  stage = 'moa-model-change-consumed';
  await until('document.querySelector("#messages").textContent.includes("confirmation not pending") && !document.querySelector("#send").disabled');
  assert.equal(await evaluate('document.querySelector("#error").textContent'), '');
  stage = 'moa-model-change-refreshed';
  await send('/moa duo local openai-api --aggregate local -- Inspect this workspace');
  await until('document.querySelector("#messages").lastElementChild?.textContent.includes("openai-api:fixture-changed") && !document.querySelector("#send").disabled');
  stage = 'quit';
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  socket.send(JSON.stringify({ id: ++sequence, method: 'Page.close' }));
  const [code, signal] = await exited;
  assert.equal(code, 0); assert.equal(signal, null);
  socket.close(); socket = undefined; child = undefined;
  console.log('DESKTOP_INSTALLED_MIXTURE_PREFLIGHT_PASS packaged host / sandbox / exact provider-model preview / SHARE pending / session and model-change rejection / no provider requests');
} catch (error) {
  process.exitCode = 1;
  const reason = error instanceof Error ? error.message : 'unknown';
  console.error(`DESKTOP_INSTALLED_MIXTURE_PREFLIGHT_FAILED stage=${stage} reason=${reason} exit=${child?.exitCode ?? 'none'} signal=${child?.signalCode ?? 'none'} (raw process output suppressed)`);
} finally {
  clearTimeout(deadline);
  socket?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }); child.kill('SIGKILL'); await exited; }
    catch { process.exitCode = 1; }
  }
  await rm(root, { recursive: true, force: true });
}
