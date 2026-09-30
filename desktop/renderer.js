/* Untrusted content is rendered as text only. No HTML/markdown execution. */
const $ = (id) => document.getElementById(id);
let session;
let runId;
let approval;
let busy = false;
let stopped = false;
let assistant;
let providers = [];
let mayControl = true;
let refreshing = false;
let eventVersion = 0;
let submissionVersion = 0;
const modelDrafts = new Map();
let reasoningOptions = [];
let reasoningVersion = 0;
let reasoningLoading = false;
function modelOptions() {
  const provider = providers.find((p) => p.id === $('provider').value);
  $('model-options').replaceChildren();
  const ids = [modelDrafts.get(provider?.id), provider?.defaultModel, ...(Array.isArray(provider?.modelCatalogue) ? provider.modelCatalogue.slice(0, 128) : [])];
  for (const id of new Set(ids)) {
    if (typeof id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) continue;
    const option = document.createElement('option'); option.value = id;
    option.textContent = id === provider?.defaultModel ? 'Provider default · access not verified' : 'Access not verified';
    $('model-options').append(option);
  }
}
async function refreshReasoning() {
  const version = ++reasoningVersion;
  const current = session;
  reasoningOptions = []; $('reasoning').replaceChildren(); $('reasoning').value = '';
  if (!current || stopped) { reasoningLoading = false; controls(); return; }
  reasoningLoading = true; controls();
  const valid = () => version === reasoningVersion && session === current && !stopped;
  try {
    const choices = await request({ type: 'choices', content: '/reasoning ', provider: current.provider });
    if (!valid()) return;
    reasoningOptions = Array.isArray(choices) ? choices.filter((c) => /^\/reasoning (default|none|minimal|low|medium|high|xhigh|max)$/.test(c.value)).slice(0, 8) : [];
    if (!reasoningOptions.length) { $('reasoning-status').textContent = 'Reasoning unavailable or unsupported for this session model.'; return; }
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose effort…'; $('reasoning').append(placeholder);
    for (const choice of reasoningOptions) {
      const option = document.createElement('option'); option.value = choice.value.slice(11); option.textContent = `${option.value} — ${choice.description}`; $('reasoning').append(option);
    }
    const result = await request({ type: 'slash', content: '/reasoning' });
    if (valid()) $('reasoning-status').textContent = result.text || 'Select an effort and apply explicitly.';
  } catch (error) {
    if (valid()) { reasoningOptions = []; $('reasoning-status').textContent = 'Reasoning metadata unavailable. Refresh status to retry.'; fail(error); }
  } finally { if (version === reasoningVersion) { reasoningLoading = false; controls(); } }
}
$('reasoning').onchange = controls;
$('apply-reasoning').onclick = async () => {
  const content = `/reasoning ${$('reasoning').value}`;
  if (busy || refreshing || stopped || reasoningLoading || !session || !reasoningOptions.some((c) => c.value === content)) return;
  busy = true; controls();
  try {
    const result = await request({ type: 'slash', content });
    $('reasoning-status').textContent = result.text;
    message('assistant', result.text);
    // A text reply may describe a rejected save; always read authoritative host state.
    await refreshReasoning();
  } catch (error) { fail(error); }
  finally { busy = !!runId; controls(); }
};
let updateStatus;
let updateRequest = false;
let updateCancelRequest = false;
let updateRevision = 0;
let updatePoll = 0;
function updateControls() {
  const labels = { disabled: 'Updates disabled: no production trust root or source configured.', idle: 'Update check ready.', checking: 'Checking signed update metadata…', available: 'Verified update metadata available. Installation unavailable.', unavailable: 'Update check unavailable or rejected. No update installed.', preparing: 'Preparing verified update candidate… No update installed.', prepared: 'Update candidate prepared. Installation unavailable. No update installed.', cancelled: updateStatus?.canCheck === true ? 'Update operation cancelled.' : 'Update operation cancelled; cleanup pending…', closed: 'Update checks closed.' };
  $('update-status').textContent = stopped ? 'Update status unavailable: disconnected.' : (labels[updateStatus?.state] || 'Update status unavailable.');
  $('update-check').disabled = stopped || updateRequest || updateStatus?.canCheck !== true;
  $('update-prepare').disabled = stopped || updateRequest || updateStatus?.canPrepare !== true;
  $('update-cancel').disabled = stopped || updateCancelRequest || updateStatus?.canCancel !== true;
}
async function updateAction(type) {
  if (stopped || (type === 'update_check' && (updateRequest || updateStatus?.canCheck !== true)) || (type === 'update_prepare' && (updateRequest || updateStatus?.canPrepare !== true)) || (type === 'update_cancel' && (updateCancelRequest || updateStatus?.canCancel !== true))) return;
  if (type === 'update_cancel') updateCancelRequest = true;
  const revision = ++updateRevision;
  updateRequest = true; updateControls();
  try {
    const value = await request({ type });
    if (!stopped && revision === updateRevision) updateStatus = value;
  } catch { if (!stopped && revision === updateRevision) updateStatus = undefined; }
  finally {
    if (type === 'update_cancel') updateCancelRequest = false;
    if (revision === updateRevision) { updateRequest = false; updateControls(); }
  }
}
async function pollUpdate() {
  if (!stopped && !updateRequest && (['checking', 'preparing'].includes(updateStatus?.state) || updateStatus?.state === 'cancelled' && updateStatus?.canCheck !== true) && ++updatePoll % 20 === 0) await updateAction('update_status');
}
$('update-check').onclick = () => updateAction('update_check');
$('update-prepare').onclick = () => updateAction('update_prepare');
$('update-cancel').onclick = () => updateAction('update_cancel');
function controls() {
  updateControls();
  $('reasoning').disabled = busy || refreshing || stopped || reasoningLoading || !session || !reasoningOptions.length;
  $('apply-reasoning').disabled = $('reasoning').disabled || !reasoningOptions.some((c) => c.value === `/reasoning ${$('reasoning').value}`);
  $('send').disabled = busy || refreshing || reasoningLoading || stopped;
  $('cancel').disabled = !runId || !mayControl || stopped;
  $('refresh').disabled = !session || stopped;
  for (const id of ['create', 'resume', 'provider', 'model']) $(id).disabled = busy || refreshing || stopped;
  $('status').textContent = stopped ? 'Disconnected' : busy ? 'Running' : session ? 'Ready' : 'No session';
  $('approval').hidden = !approval || stopped;
}
async function request(message) {
  $('error').textContent = '';
  const reply = await window.dragons.request(message);
  if (!reply.ok) throw new Error(reply.error?.message || 'Request rejected.');
  return reply.value;
}
function fail(error) { $('error').textContent = error instanceof Error ? error.message.slice(0, 500) : 'Client request failed.'; }
function message(role, text) {
  const node = document.createElement('p'); node.className = role; node.textContent = text.slice(-32000);
  $('messages').append(node);
  while ($('messages').childElementCount > 80) $('messages').firstElementChild.remove();
  return node;
}
async function useSession(value) {
  eventVersion++;
  session = value; runId = undefined; approval = undefined; assistant = undefined;
  $('messages').replaceChildren(); $('activity').textContent = 'No activity.';
  $('session').textContent = `${value.id} · ${value.provider} / ${value.model} · Resume restores context, not previous message display.`;
  $('resume-id').value = value.id;
  $('provider').value = value.provider; $('model').value = value.model;
  modelDrafts.set(value.provider, value.model); modelOptions();
  await refresh(); controls();
}
async function refresh() {
  if (!session || stopped || refreshing) return;
  const version = eventVersion;
  const sessionId = session.id;
  refreshing = true; controls();
  try {
  const status = await request({ type: 'status' });
  if (stopped || session?.id !== sessionId || (version !== eventVersion && status.activeRunId !== runId)) return;
  mayControl = !status.shared?.ownerClientId || status.shared.ownerClientId === status.shared.clientId;
  runId = status.activeRunId; busy = !!runId;
  if (!runId) approval = undefined;
  if (status.shared) $('session').textContent = `${session.id} · ${session.provider} / ${session.model} · revision ${status.shared.revision} · ${mayControl ? 'owner / ready' : 'observing'} · plan tasks ${status.session?.planTaskCount || 0}`;
  const tasks = await request({ type: 'background' });
  if (stopped || session?.id !== sessionId || version !== eventVersion) return;
  if (tasks.length) $('activity').textContent = ($('activity').textContent + '\nBackground: ' + tasks.map((task) => `${task.id}: ${task.state}`).join('\n')).slice(-16000);
  if (!runId) await refreshReasoning();
  } finally { refreshing = false; controls(); }
}
$('refresh').onclick = () => refresh().catch(fail);
let kanbanVersion = 0;
const kanbanStages = [['todo', 'To do'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['done', 'Done']];
function renderKanban(tasks) {
  const columns = $('kanban-columns');
  columns.replaceChildren();
  for (const [status, label] of kanbanStages) {
    const column = document.createElement('section'); column.className = 'kanban-column';
    const heading = document.createElement('h3'); heading.textContent = `${label} · ${tasks.filter(task => task.status === status).length}`;
    column.append(heading);
    for (const task of tasks.filter(item => item.status === status)) {
      const card = document.createElement('article'); card.className = 'kanban-card';
      const title = document.createElement('strong'); title.textContent = task.title;
      const meta = document.createElement('small');
      meta.textContent = `${task.assignee} · ${task.progress}% · rev ${task.revision}${task.handoffTo ? ` · offered to ${task.handoffTo}` : ''}\n${task.id}${task.dependsOn.length ? ` · depends on ${task.dependsOn.join(', ')}` : ''}`;
      card.append(title); card.append(meta); column.append(card);
    }
    columns.append(column);
  }
}
async function refreshKanban() {
  if (stopped) return;
  const version = ++kanbanVersion;
  $('kanban-refresh').disabled = true;
  $('kanban-status').textContent = 'Loading board…';
  try {
    const tasks = await request({ type: 'kanban_board' });
    if (stopped || version !== kanbanVersion) return;
    if (!Array.isArray(tasks)) throw new Error('Invalid Kanban board response.');
    renderKanban(tasks);
    $('kanban-status').textContent = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} · refreshed`;
  } catch (error) {
    if (stopped || version !== kanbanVersion) return;
    $('kanban-columns').replaceChildren();
    $('kanban-status').textContent = `Board unavailable: ${error.message || 'Unable to load'}`;
  } finally { if (version === kanbanVersion) $('kanban-refresh').disabled = stopped; }
}
$('kanban-refresh').onclick = () => refreshKanban();
$('provider').onchange = () => { $('model').value = modelDrafts.get($('provider').value) ?? providers.find((p) => p.id === $('provider').value)?.defaultModel ?? ''; modelOptions(); };
$('model').oninput = () => { modelDrafts.set($('provider').value, $('model').value); };
$('create').onclick = async () => {
  busy = true; controls();
  try { await useSession(await request({ type: 'create', ...($('provider').value ? { provider: $('provider').value } : {}), ...($('model').value ? { model: $('model').value } : {}) })); }
  catch (error) { fail(error); } finally { busy = !!runId; controls(); }
};
$('resume').onclick = async () => {
  busy = true; controls();
  try { await useSession(await request({ type: 'resume', sessionId: $('resume-id').value.trim() })); }
  catch (error) { fail(error); } finally { busy = !!runId; controls(); }
};
// Host-generated command metadata only; completion never calls send or executes a command.
const choiceBox = document.createElement('div');
choiceBox.id = 'slash-choices'; choiceBox.setAttribute('role', 'listbox'); choiceBox.hidden = true;
$('composer').append(choiceBox);
let slashOptions = [];
let slashIndex = 0;
let choiceVersion = 0;
function hideChoices() { choiceVersion++; slashOptions = []; choiceBox.hidden = true; choiceBox.replaceChildren(); }
function renderChoices() {
  choiceBox.replaceChildren(); choiceBox.hidden = !slashOptions.length;
  slashOptions.forEach((choice, index) => {
    const node = document.createElement('button'); node.type = 'button';
    node.setAttribute('role', 'option'); node.setAttribute('aria-selected', String(index === slashIndex));
    node.textContent = `${index === slashIndex ? '› ' : ''}${choice.value} — ${choice.description}`;
    node.onclick = () => completeChoice(index); choiceBox.append(node);
  });
}
function completeChoice(index) {
  const choice = slashOptions[index]; if (!choice || busy || refreshing || stopped) return;
  $('prompt').value = choice.value + ' '; hideChoices(); $('prompt').focus(); void updateChoices();
}
async function updateChoices() {
  const content = $('prompt').value; const version = ++choiceVersion;
  if (!content.startsWith('/') || busy || refreshing || stopped) { hideChoices(); return; }
  try {
    const reply = await window.dragons.request({ type: 'choices', content, ...(session?.provider ? { provider: session.provider } : {}) });
    if (version !== choiceVersion || $('prompt').value !== content || busy || stopped) return;
    slashOptions = reply.ok && Array.isArray(reply.value) ? reply.value.slice(0, 32) : [];
    slashIndex = 0; renderChoices();
  } catch { if (version === choiceVersion) hideChoices(); }
}
$('prompt').oninput = () => { void updateChoices(); };
$('prompt').onkeydown = (event) => {
  if (event.key === 'Escape') { hideChoices(); event.preventDefault(); return; }
  if (!slashOptions.length || busy || refreshing || stopped) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault(); slashIndex = (slashIndex + (event.key === 'ArrowUp' ? -1 : 1) + slashOptions.length) % slashOptions.length; renderChoices();
  } else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); completeChoice(slashIndex); }
};
$('composer').onsubmit = async (event) => {
  hideChoices();
  event.preventDefault(); if (busy || refreshing || stopped || !$('prompt').value.trim()) return;
  const slash = $('prompt').value.trimStart().startsWith('/');
  if (!slash && !session) { fail(new Error('Create a session first, or run /help.')); return; }
  const version = ++submissionVersion;
  const currentSession = session;
  eventVersion++;
  busy = true; mayControl = true; assistant = undefined; controls();
  const content = $('prompt').value; $('prompt').value = '';
  if (!slash) message('user', content);
  try {
    const result = await request(slash ? { type: 'slash', content } : { type: 'send', sessionId: session.id, content });
    if (stopped || version !== submissionVersion || session !== currentSession) return;
    // Checkpoint/rollback slash replies are run admission, not assistant text.
    // Events may start or finish the run before IPC returns; never resurrect it.
    if (typeof result.runId === 'string' && result.sessionId === session?.id) {
      if (busy && (!runId || runId === result.runId)) runId = result.runId;
    } else if (result.kind === 'session') await useSession(result.session);
    else {
      message('assistant', result.text);
      if (content.trimStart().startsWith('/kanban ')) void refreshKanban();
      if (content.trim().split(/\s+/)[0] === '/reasoning') await refreshReasoning();
      if (result.kind === 'restart') { stopped = true; session = undefined; runId = undefined; approval = undefined; }
    }
  } catch (error) { if (!stopped && version === submissionVersion) fail(error); }
  finally { if (version === submissionVersion) { busy = !!runId; controls(); } }
};
$('cancel').onclick = async () => { try { await request({ type: 'cancel', runId }); } catch (error) { fail(error); } };
async function decide(decision) {
  if (!approval) return;
  const pending = approval; approval = undefined; controls();
  try { await request({ type: 'approve', sessionId: pending.sessionId, runId: pending.runId, approvalId: pending.approvalId, decision }); }
  catch (error) { fail(error); }
}
$('deny').onclick = () => decide('deny'); $('allow').onclick = () => decide('allow_once');
// Host validates/redaction-checks this allowlisted DTO; never render raw tool arguments.
function lspApprovalText(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).sort().join(',') !== 'args,command,document'
    || typeof scope.command !== 'string' || !scope.command
    || typeof scope.document !== 'string' || !scope.document || scope.document.length > 512
    || !Array.isArray(scope.args) || scope.args.length > 16) return undefined;
  const fields = [scope.command, ...scope.args, scope.document];
  if (fields.some(s => typeof s !== 'string' || s.length > 2048 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(s) || s.includes('[REDACTED]'))
    || new TextEncoder().encode(JSON.stringify(scope)).length > 4096) return undefined;
  return `Command: ${JSON.stringify(scope.command)}\nArgs: ${JSON.stringify(scope.args)}\nDocument: ${JSON.stringify(scope.document)}`;
}
function receive(event) {
  if (event.type === 'client_disconnected') { eventVersion++; stopped = true; busy = false; runId = undefined; approval = undefined; fail(new Error(event.message)); controls(); return; }
  if (stopped || !session || event.sessionId !== session.id) return;
  if (event.type === 'run_started') { eventVersion++; runId = event.runId; busy = true; }
  if (event.type === 'assistant_delta') {
    assistant ??= message('assistant', ''); assistant.textContent = (assistant.textContent + event.text).slice(-32000);
  }
  if (event.type === 'tool_activity') $('activity').textContent = ($('activity').textContent + `\n${event.toolName} · ${event.operation || ''} · ${event.phase}\n${event.output || ''}\n${event.mutationWarning || ''}`).slice(-16000);
  if (event.type === 'approval_requested') {
    const scope = event.toolName === 'lsp_diagnostics_start' ? lspApprovalText(event.lspApproval) : undefined;
    if (event.toolName === 'inline_context_url') {
      const url = event.contextUrl;
      if (event.operation !== 'EXECUTE' || typeof url !== 'string' || url.length > 2048 || !/^https:\/\//.test(url) || /[\s\p{C}]/u.test(url)) {
        approval = undefined;
        $('approval-label').textContent = '';
        $('error').textContent = 'URL approval scope unavailable; request denied.';
        void request({ type: 'approve', sessionId: event.sessionId, runId: event.runId, approvalId: event.approvalId, decision: 'deny' }).catch(fail);
      } else {
        approval = event;
        $('approval-label').textContent = `EXECUTE: HTTPS GET ${url}\nOne request, no redirects; no future network permission.`;
      }
      controls(); return;
    }
    if (event.toolName === 'lsp_diagnostics_start' && (event.operation !== 'EXECUTE' || !scope)) {
      approval = undefined;
      $('approval-label').textContent = '';
      $('error').textContent = 'LSP approval scope unavailable; request denied.';
      void request({ type: 'approve', sessionId: event.sessionId, runId: event.runId, approvalId: event.approvalId, decision: 'deny' }).catch(fail);
    } else {
      approval = event;
      $('approval-label').textContent = `${event.operation}: ${event.toolName}${scope ? `\n${scope}\nOne document, one process; no future startup permission.` : ''}`;
    }
  }
  if (event.type === 'event_stream_truncated') $('error').textContent = 'Earlier stream output was truncated.';
  if (event.type === 'run_completed') {
    assistant ??= message('assistant', ''); assistant.textContent = event.result.finalText.slice(-32000);
  }
  if (['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)) {
    eventVersion++;
    const owned = mayControl;
    busy = false; runId = undefined; approval = undefined;
    if (event.type !== 'run_completed') $('error').textContent = event.message || 'Run cancelled.';
    if (owned) void refresh().catch(fail);
  }
  controls();
}
async function start() {
  try {
    providers = await request({ type: 'providers' });
    for (const provider of providers) { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.label; $('provider').append(option); }
    $('provider').onchange(); controls();
    await updateAction('update_status');
    while (!stopped) {
      for (const event of await window.dragons.events()) receive(event);
      await pollUpdate();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) { stopped = true; fail(error); controls(); }
}
window.addEventListener('pagehide', () => { stopped = true; kanbanVersion++; updateRevision++; updateControls(); });
void start();
