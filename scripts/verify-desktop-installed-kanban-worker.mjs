// Exercise the packaged Desktop renderer -> trusted host -> separate Local worker without real credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDragonsConfigPath, saveDragonsConfig } from '../dist/config.js';
import { createFileKanbanBoard, kanbanWorkspaceDirectory } from '../dist/kanban.js';
import { createDragonsProfileStore } from '../dist/profiles.js';

assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-desktop-installed-kanban-worker.mjs <executable>');
const executable = resolve(process.argv[2]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'dragons-installed-kanban-worker-')));
const home = join(root, 'home');
let child, socket, server, board, task, evaluate, stage = 'setup', modelRequests = 0, modelError, sequence = 0;
const deadline = setTimeout(() => { child?.kill('SIGKILL'); process.exitCode = 1; }, 90_000);
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
      assert.equal(payload.messages.at(-1)?.content,
        ['Inspect packaged worker', 'First lane child', 'Dependent lane child'][modelRequests]);
      const readTools = new Set(['list_directory', 'read_file', 'search_files', 'grep', 'project_info',
        'list_symbols', 'find_symbol', 'find_references', 'suggest_tests', 'review_changes', 'git_status', 'git_diff', 'git_log']);
      assert.ok(payload.tools?.length > 0 && payload.tools.every((tool) => readTools.has(tool.function.name)));
      modelRequests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"id":"packaged-worker","choices":[{"index":0,"delta":{"content":"private fixture output"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
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
  const config = { provider: 'local', model: 'fixture', localEndpoint: `http://127.0.0.1:${address.port}/v1` };
  await saveDragonsConfig(config, configPath);
  const profiles = createDragonsProfileStore({ configPath });
  const source = await profiles.select('handoff-source');
  await saveDragonsConfig(config, source.configPath);
  const boardDirectory = kanbanWorkspaceDirectory(configPath, root);
  board = createFileKanbanBoard(boardDirectory, profiles);
  task = await board.create('default', 'Inspect packaged worker', 'default', []);
  const offeredTask = await board.create('handoff-source', 'Cross-profile handoff fixture', 'handoff-source', []);
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'),
    LOCALAPPDATA: join(home, 'local'), PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root };
  for (const name of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'CHROME_DEVEL_SANDBOX']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  async function openDesktop(profile) {
    stage = `${profile}-process-readiness`;
    child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(root, `chromium-${profile}`)}`, `--workspace=${root}`],
      { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    const debuggerUrl = await new Promise((resolve_, reject) => {
      let buffer = '';
      child.once('error', () => reject(new Error('Packaged executable could not start')));
      child.once('exit', () => reject(new Error('Packaged executable exited before readiness')));
      child.stderr.on('data', (chunk) => {
        buffer = (buffer + chunk).slice(-8192);
        const match = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (match) resolve_(match[1]);
      });
    });
    stage = `${profile}-renderer-discovery`;
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
      const pages = await (await fetch(new URL('/json/list', debuggerUrl.replace(/^ws:/, 'http:')), { signal: AbortSignal.timeout(2000) })).json();
      page = pages.find((entry) => entry.type === 'page' && entry.url.endsWith('/desktop/index.html'));
      if (page) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(page, 'Packaged local Desktop renderer did not load');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
    evaluate = (expression) => new Promise((resolve_, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Renderer evaluation timed out')); }, 5000);
      function receive(event) {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer); socket.removeEventListener('message', receive);
        if (message.error || message.result?.exceptionDetails) reject(new Error('Renderer evaluation failed'));
        else resolve_(message.result?.result?.value);
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    await until('!!document.querySelector("#composer") && !!window.dragons?.request && !document.querySelector("#send").disabled');
    assert.deepEqual(await evaluate('[typeof require, typeof process, typeof window.dragons.request]'), ['undefined', 'undefined', 'function']);
  }
  async function quitDesktop() {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    socket.send(JSON.stringify({ id: ++sequence, method: 'Page.close' }));
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    socket.close(); socket = undefined;
    evaluate = undefined;
    child = undefined;
  }
  const until = async (expression) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Packaged worker acceptance condition unmet');
  };
  await openDesktop('handoff-source');
  stage = 'source-handoff-offer';
  const offerCommand = `/kanban handoff offer ${offeredTask.id} ${offeredTask.revision} default`;
  await evaluate(`document.querySelector('#prompt').value=${JSON.stringify(offerCommand)};document.querySelector('#composer').requestSubmit()`);
  await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`Kanban task ${offeredTask.id} revision ${offeredTask.revision + 1}`)}) && !document.querySelector('#send').disabled`);
  const offer = await board.get('handoff-source', offeredTask.id);
  assert.equal(offer?.handoffTo, 'default');
  assert.equal(offer?.assignee, 'handoff-source');
  assert.equal(modelRequests, 0);
  assert.equal(await evaluate('document.querySelector("#error").textContent'), '');
  await quitDesktop();
  await profiles.select('default');
  await openDesktop('default');
  stage = 'worker-run';
  const command = `/kanban worker start ${task.id} ${task.revision}`;
  await evaluate(`document.querySelector('#prompt').value=${JSON.stringify(command)};document.querySelector('#composer').requestSubmit()`);
  await until('document.querySelector("#messages").textContent.includes("worker completed task") && !document.querySelector("#send").disabled');
  assert.equal(modelError, undefined);
  assert.equal(modelRequests, 1);
  assert.equal((await board.get('default', task.id))?.status, 'done');
  assert.doesNotMatch(await readFile(join(boardDirectory, 'board.json'), 'utf8'), /private fixture output|packaged-worker/);
  assert.equal(await evaluate('document.querySelector("#error").textContent'), '');
  stage = 'lane-run';
  const first = await board.create('default', 'First lane child', 'default', []);
  const second = await board.create('default', 'Dependent lane child', 'default', []);
  const dependent = await board.addDependency('default', second.id, second.revision, first.id);
  const lane = `/kanban worker lane ${first.id}:${first.revision} ${second.id}:${dependent.revision}`;
  await evaluate(`document.querySelector('#prompt').value=${JSON.stringify(lane)};document.querySelector('#composer').requestSubmit()`);
  await until('document.querySelector("#messages").textContent.includes("worker lane completed 2 tasks") && !document.querySelector("#send").disabled');
  assert.equal(modelError, undefined);
  assert.equal(modelRequests, 3);
  assert.equal((await board.get('default', first.id))?.status, 'done');
  assert.equal((await board.get('default', second.id))?.status, 'done');
  assert.doesNotMatch(await readFile(join(boardDirectory, 'board.json'), 'utf8'), /private fixture output|packaged-worker/);
  assert.equal(await evaluate('document.querySelector("#error").textContent'), '');
  stage = 'cross-profile-board';
  await evaluate('document.querySelector("#kanban-refresh").click()');
  await until(`document.querySelector('#kanban-columns').textContent.includes(${JSON.stringify(offeredTask.id)})`);
  assert.ok((await evaluate('document.querySelector("#kanban-columns").textContent')).includes('offered to default'));
  const accept = `/kanban handoff accept ${offeredTask.id} ${offer.revision}`;
  await evaluate(`document.querySelector('#prompt').value=${JSON.stringify(accept)};document.querySelector('#composer').requestSubmit()`);
  await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`Kanban task ${offeredTask.id} revision ${offer.revision + 1}`)}) && !document.querySelector('#send').disabled`);
  const accepted = await board.get('handoff-source', offeredTask.id);
  assert.equal(accepted?.assignee, 'default');
  assert.equal(accepted?.handoffTo, undefined);
  const progress = `/kanban progress ${offeredTask.id} ${accepted.revision} done 100`;
  await evaluate(`document.querySelector('#prompt').value=${JSON.stringify(progress)};document.querySelector('#composer').requestSubmit()`);
  await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`Kanban task ${offeredTask.id} revision ${accepted.revision + 1} done 100%`)}) && !document.querySelector('#send').disabled`);
  await until(`document.querySelector('#kanban-columns').querySelectorAll('.kanban-card').length === 4 && document.querySelector('#kanban-columns').textContent.includes(${JSON.stringify('default · 100%')})`);
  assert.equal((await board.get('handoff-source', offeredTask.id))?.status, 'done');
  assert.equal(modelRequests, 3, 'Handoff and board operations must not invoke the model');
  assert.equal(await evaluate('document.querySelector("#error").textContent'), '');
  stage = 'quit';
  await quitDesktop();
  console.log('DESKTOP_INSTALLED_KANBAN_WORKER_PASS two packaged Desktop profiles / renderer sandbox / separate Local READ-only child and dependent two-child lane / cross-profile handoff and visual board / no saved model output / quit');
} catch (error) {
  process.exitCode = 1;
  const reason = error instanceof Error ? error.message : 'unknown';
  const state = await board?.get('default', task?.id).catch(() => undefined);
  const renderer = socket && evaluate ? await evaluate(`({ error: document.querySelector('#error')?.textContent || '', completed: document.querySelector('#messages')?.textContent.includes('worker completed task'), failed: document.querySelector('#messages')?.textContent.includes('worker failed') })`).catch(() => undefined) : undefined;
  console.error(`DESKTOP_INSTALLED_KANBAN_WORKER_FAILED stage=${stage} reason=${reason} requests=${modelRequests} modelAssertion=${modelError instanceof assert.AssertionError ? modelError.message : modelError ? 'fixture failure' : 'none'} task=${state?.status ?? 'unknown'} revision=${state?.revision ?? 'unknown'} renderer=${JSON.stringify(renderer)} exit=${child?.exitCode ?? 'none'} signal=${child?.signalCode ?? 'none'} (raw process output suppressed)`);
} finally {
  clearTimeout(deadline);
  socket?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }); child.kill('SIGKILL'); await exited; }
    catch { process.exitCode = 1; }
  }
  if (server) await new Promise((resolve_) => server.close(resolve_));
  await rm(root, { recursive: true, force: true });
}
