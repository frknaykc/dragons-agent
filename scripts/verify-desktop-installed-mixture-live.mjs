import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDragonsConfigPath, saveDragonsConfig } from '../dist/config.js';

// Explicit opt-in: this sends one question to the selected local and authenticated models.
// Keep the real OS HOME for Keychain access, but isolate the packaged app's on-disk state.
const executable = process.argv[2];
if (!executable || process.argv.length !== 3 || process.platform !== 'darwin') {
  throw new Error('Usage (macOS): node scripts/verify-desktop-installed-mixture-live.mjs <packaged-app-executable>');
}
const root = await realpath(await mkdtemp(join(tmpdir(), 'dragons-installed-mixture-live-')));
const appHome = join(root, 'home');
const workspace = join(root, 'workspace');
const realHome = homedir();
let child;
let rendererSocket;
let inspectorSocket;
let stage = 'setup';
const deadline = setTimeout(() => child?.kill('SIGKILL'), 240_000);

const connect = async (url) => {
  const socket = new WebSocket(url);
  await once(socket, 'open', { signal: AbortSignal.timeout(5_000) });
  return socket;
};
const evaluate = (socket, expression) => new Promise((done, reject) => {
  const id = Math.floor(Math.random() * 0x7fffffff);
  const timer = setTimeout(() => { socket.removeEventListener('message', receiveMessage); reject(new Error('Inspector evaluation timed out')); }, 5_000);
  function receiveMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id !== id) return;
    clearTimeout(timer);
    socket.removeEventListener('message', receiveMessage);
    if (message.error || message.result?.exceptionDetails) reject(new Error('Inspector evaluation failed'));
    else done(message.result?.result?.value);
  }
  socket.addEventListener('message', receiveMessage);
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
});
const until = async (socket, expression, timeoutMilliseconds = 45_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await evaluate(socket, expression)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Packaged renderer condition unmet');
};

try {
  await mkdir(appHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const configPath = getDragonsConfigPath({ homeDirectory: appHome });
  await saveDragonsConfig({ provider: 'local', localEndpoint: 'http://127.0.0.1:1234/v1',
    models: { local: 'qwen3.6-35b-a3b-mlx', chatgpt: 'gpt-5.6-terra' } }, configPath);
  const models = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(3_000) });
  assert.equal(models.ok, true, 'LM Studio model endpoint unavailable');
  assert.equal((await models.json()).data.some((value) => value.id === 'qwen3.6-35b-a3b-mlx'), true);
  const environment = { HOME: appHome, USERPROFILE: appHome, XDG_CONFIG_HOME: join(appHome, 'config'),
    APPDATA: join(appHome, 'config'), LOCALAPPDATA: join(appHome, 'local'),
    PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root };
  child = spawn(resolve(executable), ['--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${join(root, 'chromium')}`, `--workspace=${workspace}`],
  { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  stage = 'inspector';
  const urls = await new Promise((done, reject) => {
    let buffer = '';
    child.once('error', () => reject(new Error('Packaged executable could not start')));
    child.once('exit', () => reject(new Error('Packaged executable exited before inspector readiness')));
    child.stderr.on('data', (chunk) => {
      buffer = (buffer + chunk).slice(-8192);
      const node = buffer.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
      const browser = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
      if (node && browser) done({ node, browser });
    });
  });
  stage = 'renderer-discovery';
  let page;
  for (let index = 0; index < 100; index++) {
    const pages = await (await fetch(new URL('/json/list', urls.browser.replace(/^ws:/, 'http:')),
      { signal: AbortSignal.timeout(2_000) })).json();
    page = pages.find((entry) => entry.type === 'page' && entry.url.endsWith('/desktop/index.html'));
    if (page) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(page, 'Packaged MoA renderer did not load');
  rendererSocket = await connect(page.webSocketDebuggerUrl);
  await until(rendererSocket, '!!document.querySelector("#composer") && !!window.dragons?.request && !document.querySelector("#send").disabled', 60_000);
  assert.deepEqual(await evaluate(rendererSocket, '[typeof require, typeof process, typeof window.dragons.request]'),
    ['undefined', 'undefined', 'function']);
  // The runtime has already captured the isolated profile paths. Native Keychain
  // resolves the login keychain using HOME when the authenticated request starts.
  stage = 'renderer-keychain-context';
  inspectorSocket = await connect(urls.node);
  assert.equal(await evaluate(inspectorSocket, `process.env.HOME=${JSON.stringify(realHome)};process.pid`), child.pid);
  inspectorSocket.close(); inspectorSocket = undefined;
  const inspect = (expression) => evaluate(rendererSocket, expression);
  const submit = (content) => inspect(`document.querySelector('#prompt').value=${JSON.stringify(content)};document.querySelector('#composer').requestSubmit()`);
  stage = 'renderer-session';
  await inspect('document.querySelector("#create").click()');
  await until(rendererSocket, '!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
  const question = 'Harmless integration check. Answer with a single short word: READY. Use no tools.';
  stage = 'preview';
  await submit(`/moa duo local chatgpt --aggregate local -- ${question}`);
  await until(rendererSocket, `(() => {
    const text = document.getElementById('messages')?.lastElementChild?.textContent || '';
    return document.getElementById('send')?.disabled === false &&
      text.includes('local:qwen3.6-35b-a3b-mlx') && text.includes('chatgpt:gpt-5.6-terra') && text.includes('SHARE');
  })()`, 60_000);
  stage = 'share';
  await submit('/moa confirm SHARE');
  await until(rendererSocket, `(() => {
    const messages = document.getElementById('messages');
    const text = messages?.lastElementChild?.textContent || '';
    return document.getElementById('send')?.disabled === false &&
      (document.getElementById('error')?.textContent || messages?.childElementCount >= 2 && text.length > 0 && !text.includes('SHARE'));
  })()`, 145_000);
  const outcome = await inspect(`(() => {
    const error = document.getElementById('error')?.textContent || '';
    const text = document.getElementById('messages')?.lastElementChild?.textContent || '';
    return { hasError: !!error, hasAnswer: !!text.trim() && text.length <= 8000,
      confirmationOnly: text.includes('confirmation not pending') };
  })()`);
  assert.equal(outcome.hasError, false, 'renderer reported a request error');
  assert.equal(outcome.hasAnswer, true, 'no bounded synthesis answer');
  assert.equal(outcome.confirmationOnly, false, 'SHARE was not accepted');
  console.log('INSTALLED_MIXTURE_LIVE_PASS local + chatgpt candidates; local synthesis; packaged renderer/IPC/host; isolated app state');
} catch {
  console.error(`INSTALLED_MIXTURE_LIVE_FAILED stage=${stage} (no credential, response, or error body printed)`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  rendererSocket?.close(); inspectorSocket?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { const exited = once(child, 'exit', { signal: AbortSignal.timeout(5_000) }); child.kill('SIGKILL'); await exited; }
    catch { process.exitCode = 1; }
  }
  await rm(root, { recursive: true, force: true });
}
