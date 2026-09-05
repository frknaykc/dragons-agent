// Actual Electron window + production preload/renderer; deterministic local model only.
import { app } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDesktop } from '../desktop/main.mjs';
import { createDragonsRuntime } from '../dist/runtime.js';
import { createProviderRegistry } from '../dist/provider/registry.js';
import { createSessionStore } from '../dist/session-store.js';
import { AgentRunCancelledError } from '../dist/agent.js';

async function smoke() {
const root = await mkdtemp(join(tmpdir(), 'dragons-desktop-smoke-'));
let desktop;
let cancellations = 0;
const deadline = setTimeout(() => { console.error('DESKTOP_SMOKE_TIMEOUT'); app.exit(1); }, 25000);
try {
  console.log('GUI_SMOKE waiting for Electron readiness');
  await app.whenReady();
  console.log('GUI_SMOKE Electron ready');
  const providers = createProviderRegistry([{
    id: 'fixture', label: 'Local GUI fixture', defaultModel: 'gui', credentialRequirement: 'none',
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request, delta) {
      if (request.task === 'wait') await new Promise((_resolve, reject) => {
        const abort = () => { cancellations++; reject(new AgentRunCancelledError()); };
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
  desktop = await openDesktop(runtime);
  console.log('GUI_SMOKE window loaded');
  const js = (source) => desktop.window.webContents.executeJavaScript(source);
  const until = async (source) => { for (let i = 0; i < 150; i++) { if (await js(source)) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error(`GUI condition unmet: ${source}`); };
  await until('document.querySelector("#provider").options.length === 2');
  assert.deepEqual(await js('[typeof require, typeof process, typeof window.dragons.request]'), ['undefined', 'undefined', 'function']);
  const preferences = desktop.window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  await js('document.querySelector("#create").click()');
  await until('!document.querySelector("#send").disabled');
  const sessionId = await js('document.querySelector("#resume-id").value');
  assert.equal(await js('document.querySelector("#session").textContent.includes("configured-gui-model")'), true);
  const send = async (text) => { await js(`document.querySelector('#prompt').value=${JSON.stringify(text)}; document.querySelector('#composer').requestSubmit()`); };
  await send('stream');
  await until('document.querySelector("#messages").textContent.includes("GUI stream") && !document.querySelector("#send").disabled');
  assert.equal(await js('document.querySelectorAll("#messages img").length'), 0);
  assert.equal(await js('window.executed === undefined'), true);
  assert.equal(await js('document.querySelectorAll("#messages .assistant").length'), 1);
  await send('write'); await until('!document.querySelector("#approval").hidden');
  await assert.rejects(access(join(root, 'approved.txt')));
  await js('document.querySelector("#deny").click()'); await until('!document.querySelector("#send").disabled');
  await assert.rejects(access(join(root, 'approved.txt')));
  await send('write'); await until('!document.querySelector("#approval").hidden');
  await js('document.querySelector("#allow").click()'); await until('!document.querySelector("#send").disabled');
  assert.equal(await readFile(join(root, 'approved.txt'), 'utf8'), 'approved');
  await send('wait'); await until('!document.querySelector("#cancel").disabled');
  await js('document.querySelector("#cancel").click()'); await until('!document.querySelector("#send").disabled');
  await js(`document.querySelector('#resume-id').value=${JSON.stringify(sessionId)}; document.querySelector('#resume').click()`);
  await until('!document.querySelector("#send").disabled');
  await send('resume-check'); await until('document.querySelector("#messages").textContent.includes("RESUME OK")');
  assert.equal(await js('window.dragons.request({type:"shell",command:"no"}).then(r=>r.ok)'), false);
  await send('wait'); await until('!document.querySelector("#cancel").disabled');
  desktop.window.webContents.reload();
  for (let i = 0; i < 100 && !desktop.window.isDestroyed(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(desktop.window.isDestroyed(), true);
  await desktop.close();
  assert.equal(cancellations, 2);
  await assert.rejects(runtime.status());
  console.log('DESKTOP_GUI_SMOKE_PASS sandbox / IPC / session / stream / inert content / deny / allow / cancel / resume / reload cleanup');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); await desktop?.close(); if (desktop && !desktop.window.isDestroyed()) desktop.window.destroy();
  await rm(root, { recursive: true, force: true }); app.exit(process.exitCode || 0);
}
}
void smoke();
