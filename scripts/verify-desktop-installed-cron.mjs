// Exercise the packaged local Desktop host and real renderer. --loop-live explicitly opts into one LM Studio call.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getDragonsConfigPath, saveDragonsConfig } from '../dist/config.js';
import { createFilePersistentGoalStore, goalWorkspaceDirectory } from '../dist/persistent-goal-store.js';

const loopLive = process.argv[2] === '--loop-live';
const loop = process.argv[2] === '--loop' || loopLive;
const goal = process.argv[2] === '--goal';
assert.ok(process.argv.length === (loop || goal ? 4 : 3),
  'Usage: node scripts/verify-desktop-installed-cron.mjs [--loop|--loop-live|--goal] <executable>');
const executable = resolve(process.argv[loop || goal ? 3 : 2]);
const root = await mkdtemp(join(tmpdir(), `dragons-installed-${goal ? 'goal' : loop ? 'loop' : 'cron'}-`));
const home = join(root, 'home');
let child, socket, server, stage = 'setup';
let modelRequests = 0;
let modelError;
const deadline = setTimeout(() => { child?.kill('SIGKILL'); process.exitCode = 1; }, loopLive ? 240_000 : 90_000);

async function launch() {
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'),
    LOCALAPPDATA: join(home, 'local'), PATH: process.env.PATH || '', TMPDIR: root, TEMP: root, TMP: root };
  for (const name of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'CHROME_DEVEL_SANDBOX']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'chromium')}`, `--workspace=${root}`],
    { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  stage = 'process-readiness';
  const debugging = await new Promise((resolve_, reject) => {
    let buffer = '';
    child.once('error', () => reject(new Error('Packaged executable could not start')));
    child.once('exit', () => reject(new Error('Packaged executable exited before readiness')));
    child.stderr.on('data', (chunk) => {
      buffer = (buffer + chunk).slice(-8192);
      const match = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) resolve_(match[1]);
    });
  });
  const origin = debugging.replace(/^ws:/, 'http:');
  stage = 'renderer-discovery';
  let page;
  for (let i = 0; i < 100; i++) {
    const pages = await (await fetch(new URL('/json/list', origin), { signal: AbortSignal.timeout(2000) })).json();
    page = pages.find((entry) => entry.type === 'page' && entry.url.endsWith('/desktop/index.html'));
    if (page) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(page, 'Packaged local Desktop renderer did not load');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  let sequence = 0;
  const evaluate = (expression) => new Promise((resolve_, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Packaged automation renderer evaluation timed out')); }, 5000);
    function receive(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer); socket.removeEventListener('message', receive);
      if (message.error || message.result?.exceptionDetails) reject(new Error('Packaged automation renderer evaluation failed'));
      else resolve_(message.result?.result?.value);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  async function until(expression, timeoutMilliseconds = loopLive ? 60_000 : 10_000) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Packaged automation renderer acceptance condition unmet');
  }
  await until('!!document.querySelector("#composer") && !!window.dragons?.request && !document.querySelector("#send").disabled');
  assert.deepEqual(await evaluate('[typeof require, typeof process, typeof window.dragons.request]'), ['undefined', 'undefined', 'function']);
  const send = (text) => evaluate(`document.querySelector('#prompt').value=${JSON.stringify(text)};document.querySelector('#composer').requestSubmit()`);
  async function quit() {
    stage = 'quit';
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    socket.send(JSON.stringify({ id: ++sequence, method: 'Page.close' }));
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    socket.close(); socket = undefined;
    child = undefined;
  }
  return { evaluate, until, send, quit };
}

try {
  await mkdir(home);
  if (loopLive) {
    const response = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(3_000) });
    assert.equal(response.ok, true, 'LM Studio model endpoint unavailable');
    assert.equal((await response.json()).data.some((value) => value.id === 'qwen3.6-35b-a3b-mlx'), true);
  }
  if ((loop && !loopLive) || goal) {
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
        const names = payload.tools?.map((tool) => tool.function.name) ?? [];
        assert.ok(names.includes('read_file'));
        const readTools = new Set(['list_directory', 'read_file', 'search_files', 'grep', 'project_info',
          'list_symbols', 'find_symbol', 'find_references', 'suggest_tests', 'review_changes', 'git_status', 'git_diff', 'git_log']);
        assert.ok(names.every((name) => readTools.has(name)), 'Unattended model received an unexpected tool');
        modelRequests += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'fixture-automation', choices: [{ index: 0, delta: { role: 'assistant', content: goal ? 'goal fixture report' : 'verified read-only timer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        modelError = error;
        response.writeHead(400).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const address = server?.address();
  await saveDragonsConfig({ provider: 'local', model: loopLive ? 'qwen3.6-35b-a3b-mlx' : 'fixture',
    ...(loopLive ? { localEndpoint: 'http://127.0.0.1:1234/v1' }
      : address && typeof address !== 'string' ? { localEndpoint: `http://127.0.0.1:${address.port}/v1` } : {}),
  }, getDragonsConfigPath({ homeDirectory: home }));
  const first = await launch();
  if (goal) {
    stage = 'goal-create';
    await first.evaluate('document.querySelector("#create").click()');
    await first.until('!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
    const sessionId = await first.evaluate('document.querySelector("#resume-id").value');
    await first.send(`/goal add 2 ${new Date(Date.now() + 3_600_000).toISOString()} -- Review workspace state -- User verifies the report`);
    await first.until('document.querySelector("#messages").textContent.includes("Goal created:") && !document.querySelector("#send").disabled');
    const id = await first.evaluate('document.querySelector("#messages").textContent.match(/Goal created: ([0-9a-f-]{36})/)?.[1]');
    assert.match(id, /^[0-9a-f-]{36}$/);
    const goalDirectory = goalWorkspaceDirectory(join(dirname(getDragonsConfigPath({ homeDirectory: home })), 'goals'), await realpath(root));
    const store = createFilePersistentGoalStore(goalDirectory);
    assert.equal((await store.load(id))?.turnsUsed, 0);
    assert.equal(modelRequests, 0);
    stage = 'goal-run';
    await first.send(`/goal run ${id}`);
    await first.until('document.querySelector("#messages").textContent.includes("goal fixture report") && !document.querySelector("#send").disabled');
    assert.equal(modelError, undefined);
    assert.equal(modelRequests, 1);
    assert.equal((await store.load(id))?.state, 'ready');
    assert.equal((await store.load(id))?.turnsUsed, 1);
    assert.doesNotMatch(await readFile(join(goalDirectory, `${id}.json`), 'utf8'), /goal fixture report/);
    await first.quit();
    stage = 'goal-restart';
    const second = await launch();
    await second.evaluate(`document.querySelector('#resume-id').value=${JSON.stringify(sessionId)};document.querySelector('#resume').click()`);
    await second.until('!document.querySelector("#send").disabled && document.querySelector("#status").textContent !== "No session"');
    await second.send(`/goal status ${id}`);
    await second.until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id}: ready; turns: 1/2`)}) && !document.querySelector('#send').disabled`);
    assert.equal(modelRequests, 1, 'Restart must not replay the goal turn');
    await second.send(`/goal complete ${id}`);
    await second.until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id}: completed; turns: 1/2`)}) && !document.querySelector('#send').disabled`);
    assert.equal((await store.load(id))?.state, 'completed');
    assert.equal(await second.evaluate('document.querySelector("#error").textContent'), '');
    await second.quit();
    assert.equal(modelRequests, 1);
    console.log('DESKTOP_INSTALLED_GOAL_PASS packaged host / sandbox / profile store / READ-only turn / restart no replay / user completion');
  } else if (loop) {
    stage = 'loop-create';
    await first.evaluate('document.querySelector("#create").click()');
    await first.until('!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
    const sessionId = await first.evaluate('document.querySelector("#resume-id").value');
    await first.send('/loop start 1 1 -- Read workspace status');
    await first.until('document.querySelector("#messages").textContent.includes("Loop started (READ-only") && !document.querySelector("#send").disabled');
    if (!loopLive) await new Promise((resolve_, reject) => {
      const started = Date.now();
      const poll = () => modelRequests > 0 ? resolve_() : Date.now() - started > 10_000 ? reject(new Error('Packaged scheduled model run did not start')) : setTimeout(poll, 100);
      poll();
    });
    let completed = false;
    const stopAt = Date.now() + (loopLive ? 150_000 : 20_000);
    while (Date.now() < stopAt && !completed) {
      await first.send('/loop status');
      await first.until('!document.querySelector("#send").disabled');
      completed = await first.evaluate(`(() => {
        const text = document.querySelector('#messages').lastElementChild?.textContent || '';
        return text.includes('stopped; completed: 1') &&
          ${loopLive ? "!text.includes('last report: none')" : "text.includes('verified read-only timer')"};
      })()`);
      if (!completed) await new Promise((done) => setTimeout(done, loopLive ? 1_000 : 100));
    }
    assert.equal(completed, true, 'Scheduled model run did not finish');
    if (!loopLive) assert.equal(modelRequests, 1);
    await first.quit();
    stage = 'loop-restart';
    const second = await launch();
    await second.evaluate(`document.querySelector('#resume-id').value=${JSON.stringify(sessionId)};document.querySelector('#resume').click()`);
    await second.until('!document.querySelector("#send").disabled');
    await second.send('/loop status');
    await second.until('document.querySelector("#messages").textContent.includes("No Loop/Heartbeat for this session.") && !document.querySelector("#send").disabled');
    await second.send('/heartbeat start 3600 3600 2 -- Read workspace status');
    await second.until('document.querySelector("#messages").textContent.includes("Heartbeat started (READ-only") && !document.querySelector("#send").disabled');
    await second.send('/heartbeat stop');
    await second.until('document.querySelector("#messages").textContent.includes("Loop/Heartbeat stopped.") && !document.querySelector("#send").disabled');
    assert.equal(await second.evaluate('document.querySelector("#error").textContent'), '');
    await second.quit();
    if (!loopLive) assert.equal(modelRequests, 1, 'Restart and stopped heartbeat must not replay the previous run');
    console.log(loopLive
      ? 'DESKTOP_INSTALLED_LOOP_LIVE_PASS packaged host / sandbox / scheduled LM Studio READ-only turn / no restart replay / heartbeat stop'
      : 'DESKTOP_INSTALLED_LOOP_PASS packaged host / sandbox / timed local-model READ-only turn / quit / no restart replay / heartbeat stop');
  } else {
    stage = 'create';
    await first.send(`/cron once ${new Date(Date.now() + 3_600_000).toISOString()} -- Read workspace status`);
    await first.until('document.querySelector("#messages").textContent.includes("Cron task created:") && !document.querySelector("#send").disabled');
    const id = await first.evaluate('document.querySelector("#messages").textContent.match(/Cron task created: ([0-9a-f-]{36})/)?.[1]');
    assert.match(id, /^[0-9a-f-]{36}$/);
    await first.quit();
    const second = await launch();
    stage = 'restart-recovery';
    await second.send('/cron list');
    await second.until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id} [active]`)}) && !document.querySelector('#send').disabled`);
    await second.send(`/cron remove ${id}`);
    await second.until('document.querySelector("#messages").textContent.includes("Cron task removed:") && !document.querySelector("#send").disabled');
    assert.equal(await second.evaluate('document.querySelector("#error").textContent'), '');
    await second.quit();
    console.log('DESKTOP_INSTALLED_CRON_PASS packaged local host / sandbox / create / restart recovery / remove / quit');
  }
} catch (error) {
  process.exitCode = 1;
  const reason = error instanceof Error && /^(Packaged local Desktop renderer did not load|Packaged executable exited before readiness|Packaged executable could not start|Packaged automation renderer acceptance condition unmet)$/.test(error.message)
    ? error.message : error instanceof Error ? error.name : 'unknown';
  console.error(`DESKTOP_INSTALLED_${goal ? 'GOAL' : loop ? 'LOOP' : 'CRON'}_FAILED stage=${stage} reason=${reason} exit=${child?.exitCode ?? 'none'} signal=${child?.signalCode ?? 'none'} (raw process output suppressed)`);
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
