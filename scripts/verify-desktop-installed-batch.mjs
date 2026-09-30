// Exercise packaged renderer -> host -> persistent batch queue with an isolated Local model fixture.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { batchWorkspaceDirectory, createFileBatchQueue, inspectBatchLock } from '../dist/batch-queue.js';
import { getDragonsConfigPath, saveDragonsConfig } from '../dist/config.js';

assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-desktop-installed-batch.mjs <executable>');
const executable = resolve(process.argv[2]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'dragons-installed-batch-')));
const home = join(root, 'home');
let child, socket, server, evaluate, stage = 'setup', modelRequests = 0, modelError;
const deadline = setTimeout(() => { child?.kill('SIGKILL'); process.exitCode = 1; }, 90_000);
const prompts = ['Read packaged batch one', 'Read packaged batch two'];
const readTools = new Set(['list_directory', 'read_file', 'search_files', 'grep', 'project_info',
  'list_symbols', 'find_symbol', 'find_references', 'suggest_tests', 'review_changes', 'git_status', 'git_diff', 'git_log']);

async function launch() {
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'),
    LOCALAPPDATA: join(home, 'local'), PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root };
  for (const name of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'CHROME_DEVEL_SANDBOX']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(root, 'chromium')}`, `--workspace=${root}`],
  { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  stage = 'process-readiness';
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
  assert.ok(page, 'Packaged batch renderer did not load');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  let sequence = 0;
  evaluate = (expression) => new Promise((done, reject) => {
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
  async function until(expression) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Packaged batch acceptance condition unmet');
  }
  await until('!!document.querySelector("#composer") && !!window.dragons?.request && !document.querySelector("#send").disabled');
  assert.deepEqual(await evaluate('[typeof require, typeof process, typeof window.dragons.request]'), ['undefined', 'undefined', 'function']);
  const send = (text) => evaluate(`document.querySelector('#prompt').value=${JSON.stringify(text)};document.querySelector('#composer').requestSubmit()`);
  async function quit() {
    stage = 'quit';
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    socket.send(JSON.stringify({ id: ++sequence, method: 'Page.close' }));
    const [code, signal] = await exited;
    assert.equal(code, 0); assert.equal(signal, null);
    socket.close(); socket = undefined; child = undefined;
  }
  return { send, until, quit };
}

try {
  await mkdir(home);
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, undefined);
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length < 256_000, 'Unbounded model request');
      }
      const payload = JSON.parse(body);
      assert.equal(payload.messages.at(-1)?.content, prompts[modelRequests]);
      assert.ok(payload.tools?.length && payload.tools.every((tool) => readTools.has(tool.function.name)));
      const index = modelRequests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'fixture-batch', choices: [{ index: 0,
        delta: { role: 'assistant', content: `batch fixture result ${index + 1}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      modelError = error;
      response.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const configPath = getDragonsConfigPath({ homeDirectory: home });
  await saveDragonsConfig({ provider: 'local', model: 'fixture', localEndpoint: `http://127.0.0.1:${address.port}/v1` }, configPath);
  const directory = batchWorkspaceDirectory(join(dirname(configPath), 'batches'), root);
  const queue = createFileBatchQueue(directory, root);
  const first = await launch();
  await evaluate('document.querySelector("#create").click()');
  await first.until('!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
  const sessionId = await evaluate('document.querySelector("#resume-id").value');
  stage = 'batch-create';
  await first.send('/batch add 2 -- Read packaged batch one -- Read packaged batch two');
  await first.until('document.querySelector("#messages").textContent.includes("created (revision") && !document.querySelector("#send").disabled');
  const id = await evaluate('document.querySelector("#messages").textContent.match(/Batch ([0-9a-f-]{36}) created/)?.[1]');
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal((await queue.load(id))?.runsUsed, 0);
  assert.equal(modelRequests, 0);
  stage = 'batch-confirm';
  await first.send(`/batch run ${id} 0`);
  await first.until('document.querySelector("#messages").textContent.includes("/batch confirm RUN") && !document.querySelector("#send").disabled');
  assert.equal(modelRequests, 0);
  await first.send('/batch confirm RUN');
  await first.until('document.querySelector("#messages").textContent.includes("checkpointed at revision 4: completed, completed") && !document.querySelector("#send").disabled');
  assert.equal(modelError, undefined);
  assert.equal(modelRequests, 2);
  const saved = await queue.load(id);
  assert.deepEqual(saved?.tasks.map((task) => task.state), ['completed', 'completed']);
  assert.deepEqual(saved?.tasks.map((task) => task.result), ['batch fixture result 1', 'batch fixture result 2']);
  assert.equal(saved?.runsUsed, 2);
  assert.equal(await evaluate('document.querySelector("#error").textContent'), '');
  await first.quit();
  stage = 'batch-restart';
  const second = await launch();
  await evaluate(`document.querySelector('#resume-id').value=${JSON.stringify(sessionId)};document.querySelector('#resume').click()`);
  await second.until('!document.querySelector("#send").disabled && document.querySelector("#status").textContent !== "No session"');
  await second.send(`/batch status ${id}`);
  await second.until('document.querySelector("#messages").textContent.includes("2/2 runs") && !document.querySelector("#send").disabled');
  await second.send(`/batch run ${id} ${saved.revision}`);
  await second.until('document.querySelector("#messages").textContent.includes("Batch cannot run") && !document.querySelector("#send").disabled');
  assert.equal(modelRequests, 2, 'Restart or a spent budget must not replay model runs');
  stage = 'batch-orphan-recovery';
  const stranded = await queue.create(['Read orphaned batch one', 'Read orphaned batch two'], 2);
  const moduleUrl = pathToFileURL(resolve('dist/batch-queue.js')).href;
  const reservation = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { createFileBatchQueue } = await import(${JSON.stringify(moduleUrl)});
     await createFileBatchQueue(${JSON.stringify(directory)}, ${JSON.stringify(root)})
       .reserve(${JSON.stringify(stranded.id)}, ${stranded.revision});
     process.exit(3);`], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(reservation.status, 3, 'The reservation owner must exit after a durable checkpoint');
  const orphan = await queue.load(stranded.id);
  assert.equal(orphan?.tasks[0]?.state, 'running');
  assert.equal(orphan?.tasks[0]?.owner?.pid, reservation.pid);
  await second.send(`/batch recover ${stranded.id} ${orphan.revision}`);
  await second.until('document.querySelector("#messages").textContent.includes("Only mark interrupted") && !document.querySelector("#send").disabled');
  assert.equal((await queue.load(stranded.id))?.tasks[0]?.state, 'running');
  await second.send('/batch confirm RECOVER');
  await second.until('document.querySelector("#messages").textContent.includes("task marked interrupted") && !document.querySelector("#send").disabled');
  const recovered = await queue.load(stranded.id);
  assert.deepEqual(recovered?.tasks.map((task) => task.state), ['interrupted', 'queued']);
  assert.equal(recovered.runsUsed, 1);
  assert.equal(modelRequests, 2, 'Recovering a reservation must not start or replay any models');
  stage = 'batch-lock-recovery';
  const lockOwner = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { open } from 'node:fs/promises';
     import { hostname } from 'node:os';
     import { randomUUID } from 'node:crypto';
     const lock = await open(${JSON.stringify(join(directory, '.batch.lock'))}, 'wx', 0o600);
     await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }));
     await lock.close();
     process.exit(3);`], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(lockOwner.status, 3, 'The batch lock owner must exit after creating its lock');
  assert.equal((await inspectBatchLock(directory))?.pid, lockOwner.pid);
  await second.send('/batch lock recover');
  await second.until('document.querySelector("#messages").textContent.includes("/batch lock confirm RECOVER") && !document.querySelector("#send").disabled');
  assert.equal((await inspectBatchLock(directory))?.pid, lockOwner.pid, 'Inspection must not remove the lock');
  await second.send('/batch lock confirm RECOVER');
  await second.until('document.querySelector("#messages").textContent.includes("Abandoned batch lock removed") && !document.querySelector("#send").disabled');
  assert.equal(await inspectBatchLock(directory), undefined);
  assert.deepEqual((await queue.load(stranded.id))?.tasks.map((task) => task.state), ['interrupted', 'queued']);
  assert.equal((await queue.load(stranded.id))?.runsUsed, 1);
  assert.equal(modelRequests, 2, 'Lock recovery must not start or replay any models');
  assert.equal(await evaluate('document.querySelector("#error").textContent'), '');
  await second.quit();
  console.log('DESKTOP_INSTALLED_BATCH_PASS packaged host / sandbox / explicit RUN / two sequential READ-only models / durable checkpoint / restart no replay / real stopped-owner reservation and lock recovery / quit');
} catch (error) {
  process.exitCode = 1;
  const reason = error instanceof Error ? error.message : 'unknown';
  console.error(`DESKTOP_INSTALLED_BATCH_FAILED stage=${stage} reason=${reason} requests=${modelRequests} modelAssertion=${modelError instanceof assert.AssertionError ? modelError.message : modelError ? 'fixture failure' : 'none'} exit=${child?.exitCode ?? 'none'} signal=${child?.signalCode ?? 'none'} (raw process output suppressed)`);
} finally {
  clearTimeout(deadline);
  socket?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }); child.kill('SIGKILL'); await exited; }
    catch { process.exitCode = 1; }
  }
  if (server) await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
