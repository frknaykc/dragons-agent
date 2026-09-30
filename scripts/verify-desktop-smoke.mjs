// Actual Electron window + production preload/renderer; deterministic local model only.
import { app } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, access, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDesktop } from '../desktop/main.mjs';
import { createDragonsRuntime } from '../dist/runtime.js';
import { createProviderRegistry } from '../dist/provider/registry.js';
import { createSessionStore } from '../dist/session-store.js';
import { AgentRunCancelledError } from '../dist/agent.js';
import { randomBytes } from 'node:crypto';
import { createSharedRuntimeHost } from '../dist/shared-runtime.js';
import { startRemoteServer } from '../dist/remote/server.js';
import { connectRemoteRuntime } from '../dist/remote/runtime.js';
import { TuiController } from '../dist/tui/controller.js';
import { saveDragonsConfig } from '../dist/config.js';
import { createDesktopRuntime } from '../dist/desktop/host.js';
import { createDragonsProfileStore } from '../dist/profiles.js';
import { createFilePersistentGoalStore, goalWorkspaceDirectory } from '../dist/persistent-goal-store.js';

async function smoke() {
app.on('window-all-closed', () => {}); // Verify asynchronous cleanup before explicit app.exit.
const root = await mkdtemp(join(tmpdir(), 'dragons-desktop-smoke-'));
let desktop;
let sharedHost;
let server;
let tui;
let goalServer;
const shared = process.argv.includes('--shared');
const visual = process.argv.includes('--visual');
const cron = process.argv.includes('--cron');
const loop = process.argv.includes('--loop');
const goal = process.argv.includes('--goal');
let goalModelRequests = 0;
let goalModelError;
let waiting = 0;
let cancellations = 0;
const deadline = setTimeout(() => { console.error('DESKTOP_SMOKE_TIMEOUT'); app.exit(1); }, visual ? 180000 : 25000);
try {
  console.log('GUI_SMOKE waiting for Electron readiness');
  await app.whenReady();
  console.log('GUI_SMOKE Electron ready');
  if (cron || loop || goal) {
    const configPath = join(root, 'config.json');
    const profile = await createDragonsProfileStore({ configPath }).create('automation-gui-fixture');
    if (goal) {
      goalServer = createServer(async (request, response) => {
        try {
          assert.equal(request.url, '/v1/chat/completions');
          assert.equal(request.method, 'POST');
          assert.equal(request.headers.authorization, undefined);
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            assert.ok(body.length < 256_000);
          }
          const names = JSON.parse(body).tools?.map((tool) => tool.function.name) ?? [];
          assert.ok(names.includes('read_file'));
          const readTools = new Set(['list_directory', 'read_file', 'search_files', 'grep', 'project_info',
            'list_symbols', 'find_symbol', 'find_references', 'suggest_tests', 'review_changes', 'git_status', 'git_diff', 'git_log']);
          assert.ok(names.every((name) => readTools.has(name)), 'Goal turn was offered a non-READ tool');
          goalModelRequests += 1;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ id: 'fixture-goal', choices: [{ index: 0, delta: { role: 'assistant', content: 'goal fixture report' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        } catch (error) { goalModelError = error; response.writeHead(400).end(); }
      });
      goalServer.listen(0, '127.0.0.1');
      await once(goalServer, 'listening');
    }
    const address = goalServer?.address();
    await saveDragonsConfig({ provider: 'local', model: 'fixture',
      ...(address && typeof address !== 'string' ? { localEndpoint: `http://127.0.0.1:${address.port}/v1` } : {}),
    }, profile.configPath);
    desktop = await openDesktop(await createDesktopRuntime(root, { configPath, profileName: profile.name }));
    const js = (source) => desktop.window.webContents.executeJavaScript(source);
    const until = async (source) => {
      for (let i = 0; i < 150; i++) {
        if (await js(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(`GUI condition unmet: ${source}`);
    };
    await until('document.querySelector("#send") && !document.querySelector("#send").disabled');
    const preferences = desktop.window.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    const send = async (text) => js(`document.querySelector('#prompt').value=${JSON.stringify(text)}; document.querySelector('#composer').requestSubmit()`);
    if (loop) {
      await js('document.querySelector("#create").click()');
      await until('!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
      const sessionId = await js('document.querySelector("#resume-id").value');
      await send('/loop start 3600 2 -- Read workspace status');
      await until('document.querySelector("#messages").textContent.includes("Loop started (READ-only") && !document.querySelector("#send").disabled');
      await send('/loop status');
      await until('document.querySelector("#messages").textContent.includes("Loop/Heartbeat: running; completed: 0") && !document.querySelector("#send").disabled');
      await send('/loop stop');
      await until('document.querySelector("#messages").textContent.includes("Loop/Heartbeat stopped.") && !document.querySelector("#send").disabled');
      await send('/heartbeat start 3600 3600 2 -- Read workspace status');
      await until('document.querySelector("#messages").textContent.includes("Heartbeat started (READ-only") && !document.querySelector("#send").disabled');
      await js('document.querySelector("#create").click()');
      await until(`!document.querySelector('#send').disabled && document.querySelector('#resume-id').value !== ${JSON.stringify(sessionId)}`);
      await send('/heartbeat status');
      await until('document.querySelector("#messages").textContent.includes("No Loop/Heartbeat for this session.") && !document.querySelector("#send").disabled');
      assert.equal(await js('document.querySelector("#error").textContent'), '');
      await desktop.close();
      console.log('DESKTOP_LOOP_GUI_SMOKE_PASS sandbox / composer loop-start-status-stop / heartbeat / session-switch cleanup / no provider call');
      return;
    }
    if (goal) {
      await js('document.querySelector("#create").click()');
      await until('!document.querySelector("#send").disabled && !!document.querySelector("#resume-id").value');
      const sessionId = await js('document.querySelector("#resume-id").value');
      await send(`/goal add 2 ${new Date(Date.now() + 3_600_000).toISOString()} -- Review workspace state -- User verifies the report`);
      await until('document.querySelector("#messages").textContent.includes("Goal created:") && !document.querySelector("#send").disabled');
      const id = await js('document.querySelector("#messages").textContent.match(/Goal created: ([0-9a-f-]{36})/)?.[1]');
      assert.match(id, /^[0-9a-f-]{36}$/);
      const store = createFilePersistentGoalStore(goalWorkspaceDirectory(join(dirname(profile.configPath), 'goals'), await realpath(root)));
      assert.equal((await store.load(id))?.turnsUsed, 0);
      assert.equal(goalModelRequests, 0, 'Creating a goal must not call a model');
      await send(`/goal pause ${id}`);
      await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id}: paused; turns: 0/2`)}) && !document.querySelector('#send').disabled`);
      assert.equal((await store.load(id))?.state, 'paused');
      await send(`/goal resume ${id}`);
      await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id}: ready; turns: 0/2`)}) && !document.querySelector('#send').disabled`);
      assert.equal((await store.load(id))?.state, 'ready');
      await send(`/goal run ${id}`);
      await until('document.querySelector("#messages").textContent.includes("goal fixture report") && !document.querySelector("#send").disabled');
      assert.equal(goalModelError, undefined);
      assert.equal(goalModelRequests, 1);
      assert.equal((await store.load(id))?.state, 'ready', 'Model text is not a completion verdict');
      assert.equal((await store.load(id))?.turnsUsed, 1);
      assert.doesNotMatch(await readFile(join(goalWorkspaceDirectory(join(dirname(profile.configPath), 'goals'), await realpath(root)), `${id}.json`), 'utf8'), /goal fixture report/);
      await desktop.close();
      desktop = await openDesktop(await createDesktopRuntime(root, { configPath, profileName: profile.name }));
      await until('document.querySelector("#resume-id") && !document.querySelector("#send").disabled');
      await js(`document.querySelector('#resume-id').value=${JSON.stringify(sessionId)};document.querySelector('#resume').click()`);
      await until('!document.querySelector("#send").disabled && document.querySelector("#status").textContent !== "No session"');
      await send(`/goal status ${id}`);
      await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id}: ready; turns: 1/2`)}) && !document.querySelector('#send').disabled`);
      assert.equal(goalModelRequests, 1, 'Restart must not replay a goal turn');
      await send(`/goal complete ${id}`);
      await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id}: completed; turns: 1/2`)}) && !document.querySelector('#send').disabled`);
      assert.equal((await store.load(id))?.state, 'completed');
      assert.equal(await js('document.querySelector("#error").textContent'), '');
      await desktop.close();
      console.log('DESKTOP_GOAL_GUI_SMOKE_PASS sandbox / profile store / explicit READ-only turn / restart no replay / user completion');
      return;
    }
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await send(`/cron once ${at} -- Read workspace status`);
    await until('document.querySelector("#messages").textContent.includes("Cron task created:") && !document.querySelector("#send").disabled');
    const id = await js('document.querySelector("#messages").textContent.match(/Cron task created: ([0-9a-f-]{36})/)?.[1]');
    assert.match(id, /^[0-9a-f-]{36}$/);
    await send('/cron list');
    await until(`document.querySelector('#messages').textContent.includes(${JSON.stringify(`${id} [active]`)}) && !document.querySelector('#send').disabled`);
    await send(`/cron remove ${id}`);
    await until('document.querySelector("#messages").textContent.includes("Cron task removed:")');
    assert.equal(await js('document.querySelector("#error").textContent'), '');
    assert.equal(await js('document.querySelector("#status").textContent'), 'No session');
    await desktop.close();
    console.log('DESKTOP_CRON_GUI_SMOKE_PASS sandbox / host-owned scheduler / composer create-list-remove / no provider call');
    return;
  }
  const providers = createProviderRegistry([{
    id: 'fixture', label: 'Local GUI fixture', defaultModel: 'gui', credentialRequirement: 'none',
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request, delta) {
      if (request.task === 'wait') await new Promise((_resolve, reject) => {
        waiting++;
        const abort = () => { waiting--; cancellations++; reject(new AgentRunCancelledError()); };
        if (request.signal?.aborted) abort(); else request.signal?.addEventListener('abort', abort, { once: true });
      });
      if (request.task === 'write' && !request.toolOutputs.length) return { responseId: 'tool', text: '', toolCalls: [{ callId: 'gui-write', name: 'fixture_write', arguments: '{}' }] };
      const text = request.task === 'write' ? 'WRITE FINISHED' : request.task === 'resume-check' ? (request.conversationResponseId ? 'RESUME OK' : 'NO CONTINUATION') : 'GUI stream <img src=x onerror="window.executed=true">';
      delta?.(text);
      return { responseId: 'gui-done', text, textWasStreamed: true, toolCalls: [] };
    } }),
  }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, providerRegistry: providers,
    defaultModel: 'configured-gui-model',
    sessionStore: createSessionStore(join(root, 'sessions'), { providerIds: providers.ids() }),
    memoryDirectory: join(root, 'memory'), skillsDirectory: join(root, 'skills'),
    tools: [{ name: 'fixture_write', description: 'Isolated GUI sentinel', operation: 'WRITE', inputSchema: { type: 'object', properties: {} },
      execute: async () => { await writeFile(join(root, 'approved.txt'), 'approved'); return { ok: true, output: 'written' }; } }],
  });
  let desktopRuntime = runtime;
  if (shared) {
    sharedHost = createSharedRuntimeHost(runtime);
    const token = randomBytes(32).toString('base64url');
    server = await startRemoteServer({ principals: [{ id: 'fixture-owner', token }], maxConnectionsPerPrincipal: 8,
      createRuntime: async (_principal, id) => sharedHost.connect(id) });
    desktopRuntime = await connectRemoteRuntime({ url: server.url, token });
    tui = new TuiController(await connectRemoteRuntime({ url: server.url, token }));
  }
  desktop = await openDesktop(desktopRuntime);
  console.log('GUI_SMOKE window loaded');
  const js = (source) => desktop.window.webContents.executeJavaScript(source);
  const until = async (source) => { for (let i = 0; i < (visual ? 3000 : 150); i++) { if (await js(source)) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error(`GUI condition unmet: ${source}`); };
  const untilWaiting = async () => { for (let i = 0; i < 150 && waiting !== 1; i++) await new Promise((r) => setTimeout(r, 40)); assert.equal(waiting, 1); };
  await until('document.querySelector("#provider").options.length === 2');
  assert.deepEqual(await js('[typeof require, typeof process, typeof window.dragons.request]'), ['undefined', 'undefined', 'function']);
  const preferences = desktop.window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  await js('document.querySelector("#create").click()');
  await until('!document.querySelector("#send").disabled');
  const sessionId = await js('document.querySelector("#resume-id").value');
  assert.equal(await js('document.querySelector("#session").textContent.includes("configured-gui-model")'), true);
  const send = async (text) => { await js(`document.querySelector('#prompt').value=${JSON.stringify(text)}; document.querySelector('#composer').requestSubmit()`); };
  if (visual) {
    await send('write');
    await until('!document.querySelector("#approval").hidden');
    await assert.rejects(access(join(root, 'approved.txt')));
    console.log('VISUAL_APPROVAL_DENY_READY');
    await until('document.querySelector("#approval").hidden && !document.querySelector("#send").disabled');
    await assert.rejects(access(join(root, 'approved.txt')));
    await send('write');
    await until('!document.querySelector("#approval").hidden');
    console.log('VISUAL_APPROVAL_ALLOW_READY');
    await until('document.querySelector("#approval").hidden && !document.querySelector("#send").disabled');
    assert.equal(await readFile(join(root, 'approved.txt'), 'utf8'), 'approved');
    console.log('DESKTOP_VISUAL_APPROVAL_PASS denied write absent / approved write present / fixture cleaned on exit');
    return;
  }
  await send('stream');
  await until('document.querySelector("#messages").textContent.includes("GUI stream") && !document.querySelector("#send").disabled');
  assert.equal(await js('document.querySelectorAll("#messages img").length'), 0);
  assert.equal(await js('window.executed === undefined'), true);
  assert.equal(await js('document.querySelectorAll("#messages .assistant").length'), 1);
  if (shared) {
    await tui.initialize({ resume: sessionId });
    const running = tui.submit('wait');
    for (let i = 0; i < 100 && !waiting; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(waiting, 1);
    await js('document.querySelector("#refresh").click()');
    await until('document.querySelector("#session").textContent.includes("observing") && document.querySelector("#send").disabled');
    assert.equal(await js('document.querySelector("#cancel").disabled'), true);
    assert.equal(tui.cancel(), true); await running;
    await until('!document.querySelector("#send").disabled');
    await js('document.querySelector("#refresh").click()');
    await until('!document.querySelector("#send").disabled && !document.querySelector("#session").textContent.includes("observing")');
  }
  await send('write'); await until('!document.querySelector("#approval").hidden');
  await assert.rejects(access(join(root, 'approved.txt')));
  await js('document.querySelector("#deny").click()'); await until('!document.querySelector("#send").disabled');
  await assert.rejects(access(join(root, 'approved.txt')));
  await send('write'); await until('!document.querySelector("#approval").hidden');
  await js('document.querySelector("#allow").click()'); await until('!document.querySelector("#send").disabled');
  assert.equal(await readFile(join(root, 'approved.txt'), 'utf8'), 'approved');
  await send('wait'); await until('!document.querySelector("#cancel").disabled'); await untilWaiting();
  await js('document.querySelector("#cancel").click()'); await until('!document.querySelector("#send").disabled');
  await js(`document.querySelector('#resume-id').value=${JSON.stringify(sessionId)}; document.querySelector('#resume').click()`);
  await until('!document.querySelector("#send").disabled');
  await send('resume-check'); await until('document.querySelector("#messages").textContent.includes("RESUME OK") && !document.querySelector("#send").disabled');
  assert.equal(await js('window.dragons.request({type:"shell",command:"no"}).then(r=>r.ok)'), false);
  await send('wait'); await until('!document.querySelector("#cancel").disabled'); await untilWaiting();
  if (shared) { await tui.refresh(); assert.equal(tui.state.busy, true); assert.equal(tui.cancel(), false); }
  desktop.window.webContents.reload();
  for (let i = 0; i < 100 && !desktop.window.isDestroyed(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(desktop.window.isDestroyed(), true);
  await desktop.close();
  assert.equal(cancellations, shared ? 3 : 2);
  if (shared) {
    for (let i = 0; i < 100 && tui.state.busy; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(tui.state.busy, false);
    assert.equal((await runtime.status({ sessionId })).activeRunId, undefined);
    console.log('SHARED_DESKTOP_TUI_SMOKE_PASS real GUI + TUI controller / authenticated SSE / both ownership directions / observer cannot cancel / reload cancels owner only');
  } else await assert.rejects(runtime.status());
  console.log('DESKTOP_GUI_SMOKE_PASS sandbox / IPC / session / stream / inert content / deny / allow / cancel / resume / reload cleanup');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await desktop?.close(); if (desktop && !desktop.window.isDestroyed()) desktop.window.destroy();
  await tui?.close(); await server?.close(); await sharedHost?.close();
  if (goalServer) await new Promise((resolve, reject) => goalServer.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true }); app.exit(process.exitCode || 0);
}
}
void smoke();
