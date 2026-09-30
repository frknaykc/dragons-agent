// Exercise the packaged host or sandbox renderer with an isolated profile and loopback model fixtures.
// The renderer fixture starts with an isolated HOME, then restores OS HOME in its
// disposable main process after profile composition so Keychain can resolve its account.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDragonsConfigPath, saveDragonsConfig } from '../dist/config.js';
import { createApiKeyStore } from '../dist/provider/api-key-auth.js';
import { createDragonsProfileStore, getDragonsProfilePaths } from '../dist/profiles.js';

assert.equal(process.platform, 'darwin', 'The packaged Keychain fixture is macOS-only.');
const renderer = process.argv[2] === '--renderer';
assert.equal(process.argv.length, renderer ? 4 : 3,
  'Usage: node scripts/verify-desktop-installed-mixture-synthesis.mjs [--renderer] <executable>');
const executable = resolve(process.argv[renderer ? 3 : 2]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'dragons-installed-mixture-synthesis-')));
const home = join(root, 'home');
const profile = `fixture-${randomBytes(12).toString('hex')}`;
const store = createApiKeyStore(profile, 'openai-api');
const fixtureKey = randomBytes(24).toString('hex');
const counts = { local: 0, remote: 0, aggregate: 0 };
const transport = { tcp: 0, tls: 0, tlsErrors: 0, rejected: 0 };
let local, remote, child, rendererSocket, inspectorSocket, saved = false, stage = 'setup';
const deadline = setTimeout(() => child?.kill('SIGKILL'), 90_000);
const sendSse = (response, content, openai = false) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (openai) response.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}\n\ndata: {"type":"response.completed","response":{"id":"fixture-remote"}}\n\ndata: [DONE]\n\n`);
  else response.end(`data: ${JSON.stringify({ id: 'fixture-local', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
};
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const receive = async (request) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 65_536) throw new Error('Fixture request too large');
  }
  return JSON.parse(body);
};
const connect = async (url) => {
  const socket = new WebSocket(url);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  return socket;
};
const evaluate = (socket, expression) => new Promise((done, reject) => {
  const id = Math.floor(Math.random() * 0x7fffffff);
  const timer = setTimeout(() => { socket.removeEventListener('message', receiveMessage); reject(new Error('Inspector evaluation timed out')); }, 5000);
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
const until = async (socket, expression, timeoutMilliseconds = 15_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await evaluate(socket, expression)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Packaged renderer condition unmet');
};
const runRenderer = async ({ cert, remotePort, configPath }) => {
  stage = 'renderer-profile';
  await createDragonsProfileStore({ configPath }).select(profile);
  stage = 'renderer-readiness';
  child = spawn(executable, ['--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(root, 'chromium')}`, `--workspace=${root}`], { cwd: root, env: {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'),
      LOCALAPPDATA: join(home, 'local'), PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root,
      NODE_EXTRA_CA_CERTS: cert, OPENAI_BASE_URL: `https://127.0.0.1:${remotePort}/v1`,
    }, stdio: ['ignore', 'ignore', 'pipe'] });
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
  for (let i = 0; i < 100; i++) {
    const pages = await (await fetch(new URL('/json/list', urls.browser.replace(/^ws:/, 'http:')),
      { signal: AbortSignal.timeout(2000) })).json();
    page = pages.find((entry) => entry.type === 'page' && entry.url.endsWith('/desktop/index.html'));
    if (page) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(page, 'Packaged MoA renderer did not load');
  rendererSocket = await connect(page.webSocketDebuggerUrl);
  await until(rendererSocket, '!!document.querySelector("#composer") && !!window.dragons?.request && !document.querySelector("#send").disabled');
  assert.deepEqual(await evaluate(rendererSocket, '[typeof require, typeof process, typeof window.dragons.request]'),
    ['undefined', 'undefined', 'function']);
  // Runtime/profile/config are now pinned to the isolated HOME. Keychain needs
  // the real OS HOME; change it in this disposable process before any request.
  stage = 'renderer-keychain-context';
  inspectorSocket = await connect(urls.node);
  assert.equal(await evaluate(inspectorSocket, `process.env.HOME=${JSON.stringify(process.env.HOME)};process.pid`), child.pid);
  inspectorSocket.close(); inspectorSocket = undefined;
  const send = (text) => evaluate(rendererSocket,
    `document.querySelector('#prompt').value=${JSON.stringify(text)};document.querySelector('#composer').requestSubmit()`);
  stage = 'renderer-session';
  await evaluate(rendererSocket, 'document.querySelector("#create").click()');
  await until(rendererSocket, '!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
  stage = 'renderer-preview';
  await send('/moa duo local openai-api --aggregate local -- Inspect this workspace');
  await until(rendererSocket, 'document.querySelector("#messages").textContent.includes("/moa confirm SHARE") && !document.querySelector("#send").disabled');
  assert.match(await evaluate(rendererSocket, 'document.querySelector("#messages").textContent'),
    /local:fixture-local.*openai-api:fixture-remote.*SHARE/s);
  assert.deepEqual(counts, { local: 0, remote: 0, aggregate: 0 });
  stage = 'renderer-share';
  const shareStarted = Date.now();
  await send('/moa confirm SHARE');
  try {
    // Candidate work may remain busy beyond the short UI-readiness timeout before HTTPS begins.
    await until(rendererSocket, 'document.querySelector("#messages").textContent.includes("combined fixture answer") && !document.querySelector("#send").disabled', 45_000);
  } catch (error) {
    const state = await evaluate(rendererSocket, '({last:document.querySelector("#messages").lastElementChild?.textContent,error:document.querySelector("#error").textContent,busy:document.querySelector("#send").disabled})');
    throw new Error(`Renderer completion failed after ${Date.now() - shareStarted}ms: ${JSON.stringify(state).replaceAll(fixtureKey, '[REDACTED]').slice(0, 640)}`, { cause: error });
  }
  const shareMilliseconds = Date.now() - shareStarted;
  assert.equal(await evaluate(rendererSocket, 'document.querySelector("#error").textContent'), '');
  assert.deepEqual(counts, { local: 1, remote: 1, aggregate: 1 });
  if (shareMilliseconds > 15_000) console.log(`DESKTOP_INSTALLED_MIXTURE_RENDERER_DELAY shareMilliseconds=${shareMilliseconds}`);
  stage = 'renderer-quit';
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  rendererSocket.send(JSON.stringify({ id: 2147483647, method: 'Page.close' }));
  const [code, signal] = await exited;
  assert.equal(code, 0); assert.equal(signal, null);
  rendererSocket.close(); rendererSocket = undefined; child = undefined;
};
try {
  await mkdir(home);
  const cert = join(root, 'fixture.crt');
  const keyPath = join(root, 'fixture.key');
  stage = 'tls-certificate';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', cert],
  { stdio: 'ignore', timeout: 15_000 });
  local = createHttpServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const body = await receive(request);
      assert.equal(body.model, 'fixture-local');
      if (body.messages?.some((message) => message.content?.includes('remote report'))) {
        assert.match(JSON.stringify(body.messages), /\[local\] local report.*\[openai-api\] remote report/s);
        counts.aggregate++;
        sendSse(response, 'combined fixture answer');
      } else {
        counts.local++;
        sendSse(response, 'local report');
      }
    } catch { response.writeHead(400); response.end(); }
  });
  const localPort = await listen(local);
  remote = createHttpsServer({ cert: await readFile(cert), key: await readFile(keyPath) }, async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      const body = await receive(request);
      assert.equal(body.model, 'fixture-remote');
      assert.equal(body.input, 'Inspect this workspace');
      counts.remote++;
      sendSse(response, 'remote report', true);
    } catch { transport.rejected++; response.writeHead(400); response.end(); }
  });
  remote.on('connection', () => { transport.tcp++; });
  remote.on('secureConnection', () => { transport.tls++; });
  remote.on('tlsClientError', () => { transport.tlsErrors++; });
  const remotePort = await listen(remote);
  const configPath = getDragonsConfigPath({ homeDirectory: home });
  const profileConfigPath = getDragonsProfilePaths(profile, configPath).configPath;
  await saveDragonsConfig({ provider: 'local', models: { local: 'fixture-local', 'openai-api': 'fixture-remote' },
    localEndpoint: `http://127.0.0.1:${localPort}/v1` }, profileConfigPath);
  stage = 'keychain';
  assert.equal(await store.load(), undefined);
  saved = true;
  await store.save(fixtureKey);
  if (renderer) {
    await runRenderer({ cert, remotePort, configPath });
    console.log('DESKTOP_INSTALLED_MIXTURE_RENDERER_SYNTHESIS_PASS packaged sandbox renderer / OS Keychain / loopback HTTPS / Local+OpenAI candidates / Local aggregator');
  } else {
    stage = 'packaged-host';
    const resources = resolve(dirname(executable), '..', 'Resources');
    const fixtureChild = fileURLToPath(new URL('./fixture-installed-mixture-child.mjs', import.meta.url));
    const result = await new Promise((done, reject) => {
      child = spawn(executable, [fixtureChild], { cwd: root, env: {
        HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE ?? process.env.HOME,
        PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root,
        ELECTRON_RUN_AS_NODE: '1', NODE_EXTRA_CA_CERTS: cert,
        OPENAI_BASE_URL: `https://127.0.0.1:${remotePort}/v1`,
      }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4096); });
      child.stdin.end(JSON.stringify({ resources, workspace: root, configPath, profile }));
      child.once('error', () => reject(new Error('Packaged executable could not start')));
      child.once('exit', (code, signal) => done({ code, signal, status: output.match(/PACKAGED_MIXTURE_SYNTHESIS=(pass|failed)(?: stage=([a-z-]+))?/)?.slice(1) }));
    });
    child = undefined;
    assert.equal(result.code, 0, `Packaged fixture failed at ${result.status?.[1] ?? 'unknown'}`);
    assert.equal(result.signal, null);
    assert.equal(result.status?.[0], 'pass');
    assert.deepEqual(counts, { local: 1, remote: 1, aggregate: 1 });
    console.log('DESKTOP_INSTALLED_MIXTURE_SYNTHESIS_PASS packaged host / OS Keychain / loopback HTTPS / Local+OpenAI candidates / Local aggregator');
  }
} catch (error) {
  process.exitCode = 1;
  const reason = error instanceof Error ? error.message : 'unknown';
  console.error(`DESKTOP_INSTALLED_MIXTURE_SYNTHESIS_FAILED stage=${stage} reason=${reason} counts=${JSON.stringify(counts)} transport=${JSON.stringify(transport)} (raw process output suppressed)`);
} finally {
  clearTimeout(deadline);
  rendererSocket?.close(); inspectorSocket?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }); child.kill('SIGKILL'); await exited; }
    catch { process.exitCode = 1; }
  }
  if (saved) {
    try { await store.remove(); assert.equal(await store.load(), undefined); }
    catch { console.error('ISOLATED_KEYRING_CLEANUP_FAILED'); process.exitCode = 1; }
  }
  await Promise.all([local, remote].filter(Boolean).map((server) => new Promise((done) => server.close(done))));
  await rm(root, { recursive: true, force: true });
}
