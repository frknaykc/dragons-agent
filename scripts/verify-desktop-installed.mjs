// Launch the actual installed/unpacked executable; no production test hooks or live credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDragonsRuntime } from '../dist/runtime.js';
import { createProviderRegistry } from '../dist/provider/registry.js';
import { runOutcome } from './desktop-acceptance.mjs';
import { createSessionStore } from '../dist/session-store.js';
import { createSharedRuntimeHost } from '../dist/shared-runtime.js';
import { startRemoteServer } from '../dist/remote/server.js';

assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-desktop-installed.mjs <executable>');
const executable = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'dragons-installed-'));
let child, server, host, runtime, socket;
let finished = false, timedOut = false;
let stage = 'setup';
let startupFailure = 'unknown';
const deadline = setTimeout(() => { timedOut = true; child?.kill('SIGKILL'); socket?.close(); process.exitCode = 1; }, 45000);
try {
  const home = join(root, 'home');
  await mkdir(home);
  let reads = 0, continued = 0;
  const registry = createProviderRegistry([{
    id: 'fixture', label: 'Packaged acceptance fixture', defaultModel: 'fixture', credentialRequirement: 'none',
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request, delta) {
      if (!request.toolOutputs.length) return { responseId: 'read', text: '', toolCalls: [{ callId: 'read', name: 'fixture_read', arguments: '{}' }] };
      continued++;
      assert.equal(request.toolOutputs[0].output, 'PACKAGED READ');
      delta?.('PACKAGED CONTINUATION PASS');
      return { responseId: 'done', text: 'PACKAGED CONTINUATION PASS', textWasStreamed: true, toolCalls: [] };
    } }),
  }]);
  runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: registry,
    sessionStore: createSessionStore(join(root, 'sessions'), { providerIds: registry.ids() }),
    memoryDirectory: join(root, 'memory'), skillsDirectory: join(root, 'skills'),
    tools: [{ name: 'fixture_read', description: 'Read immutable test sentinel', operation: 'READ',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => { reads++; return { ok: true, output: 'PACKAGED READ' }; } }],
  });
  host = createSharedRuntimeHost(runtime);
  const token = randomBytes(32).toString('base64url');
  const outcomes = [];
  server = await startRemoteServer({ principals: [{ id: 'fixture', token }], createRuntime: async (_principal, id) => {
    const client = host.connect(id);
    return Object.freeze({ ...client, async sendUserInput(input) {
      const run = await client.sendUserInput(input);
      // Streamed text and enabled controls alone also occur after a failed run.
      void runOutcome(run.result, 'PACKAGED CONTINUATION PASS').then((outcome) => { outcomes.push(outcome); });
      return run;
    } });
  } });
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'),
    LOCALAPPDATA: join(home, 'local'), PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root,
    DRAGONS_RUNTIME_URL: server.url, DRAGONS_REMOTE_TOKEN: token };
  for (const name of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[name]) env[name] = process.env[name];
  child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'chromium')}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  // Only inspect the fixed DevTools address; never print child logs or request payloads.
  stage = 'process-readiness';
  const debugging = await new Promise((resolve_, reject) => {
    let buffer = '';
    child.once('error', () => reject(new Error('Packaged executable could not start')));
    child.once('exit', () => reject(new Error('Packaged executable exited before readiness')));
    child.stderr.on('data', (chunk) => {
      buffer = (buffer + chunk).slice(-8192);
      // Fixed labels only: never expose arbitrary native logs, paths or credentials.
      if (/No usable sandbox|SUID sandbox helper binary|Failed to move to new namespace|Operation not permitted/.test(buffer)) startupFailure = 'sandbox-unavailable';
      else if (/error while loading shared libraries/.test(buffer)) startupFailure = 'missing-shared-library';
      else if (/Missing X server|cannot open display/.test(buffer)) startupFailure = 'display-unavailable';
      const match = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) resolve_(match[1]);
    });
  });
  const origin = debugging.replace(/^ws:/, 'http:');
  stage = 'renderer-discovery';
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    const pages = await (await fetch(new URL('/json/list', origin), { signal: AbortSignal.timeout(2000) })).json();
    page = pages.find((entry) => entry.type === 'page' && entry.url.endsWith('/desktop/index.html'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(page, 'Packaged application did not load its real renderer');
  stage = 'renderer-connection';
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  let sequence = 0;
  const evaluate = (expression) => new Promise((resolve_, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Packaged renderer evaluation timed out')); }, 5000);
    function receive(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer); socket.removeEventListener('message', receive);
      if (message.error || message.result?.exceptionDetails) reject(new Error('Packaged renderer evaluation failed'));
      else resolve_(message.result?.result?.value);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('Packaged renderer acceptance condition unmet');
  }
  stage = 'provider-discovery';
  // CDP advertises the page before the deferred renderer script and DOM are ready.
  const initialDomReady = await evaluate('!!document.getElementById("provider")');
  console.log(`PACKAGED_RENDERER_INITIAL_DOM_READY=${initialDomReady}`);
  await until('document.querySelector("#provider")?.options.length === 2');
  assert.deepEqual(await evaluate('[typeof require, typeof process, typeof window.dragons.request]'), ['undefined', 'undefined', 'function']);
  await evaluate('document.querySelector("#create").click()');
  stage = 'session-creation';
  await until('!document.querySelector("#send").disabled');
  await evaluate('document.querySelector("#prompt").value="Read the fixture"; document.querySelector("#composer").requestSubmit()');
  stage = 'tool-continuation';
  await until('document.querySelector("#messages").textContent.includes("PACKAGED CONTINUATION PASS") && !document.querySelector("#send").disabled');
  assert.equal(reads, 1); assert.equal(continued, 1);
  assert.deepEqual(outcomes, ['completed']);
  stage = 'quit';
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  // Close the real page: window-all-closed -> before-quit -> runtime disposal.
  // SIGTERM is forced termination on Windows and cannot establish graceful quit.
  socket.send(JSON.stringify({ id: ++sequence, method: 'Page.close' }));
  const [exitCode, exitSignal] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(exitSignal, null);
  socket.close(); socket = undefined;
  assert.equal(timedOut, false);
  finished = true;
  console.log('DESKTOP_INSTALLED_SMOKE_PASS packaged entry / native module import / sandbox / remote runtime / READ authorization / continuation / quit');
} catch {
  process.exitCode = 1;
  console.error(`DESKTOP_INSTALLED_SMOKE_FAILED stage=${stage} startup=${startupFailure} exit=${child?.exitCode ?? 'none'} signal=${child?.signalCode ?? 'none'} (raw process/model output suppressed)`);
} finally {
  clearTimeout(deadline);
  socket?.close();
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }); child.kill('SIGKILL'); await exited;
    }
    await server?.close(); await host?.close(); if (!host) await runtime?.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
  if (!finished) process.exitCode = 1;
}
