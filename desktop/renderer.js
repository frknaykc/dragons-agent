/* Untrusted content is rendered as text only. No HTML/markdown execution. */
const $ = (id) => document.getElementById(id);
let session;
let runId;
let approval;
let busy = false;
let stopped = false;
let assistant;
let providers = [];
function controls() {
  $('send').disabled = !session || busy || stopped;
  $('cancel').disabled = !runId || stopped;
  for (const id of ['create', 'resume', 'provider', 'model']) $(id).disabled = busy || stopped;
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
function useSession(value) {
  session = value; runId = undefined; approval = undefined; assistant = undefined;
  $('messages').replaceChildren(); $('activity').textContent = 'No activity.';
  $('session').textContent = `${value.id} · ${value.provider} / ${value.model} · Resume restores context, not previous message display.`;
  $('resume-id').value = value.id; controls();
}
$('provider').onchange = () => { $('model').value = providers.find((p) => p.id === $('provider').value)?.defaultModel || ''; };
$('create').onclick = async () => {
  busy = true; controls();
  try { useSession(await request({ type: 'create', ...($('provider').value ? { provider: $('provider').value } : {}), ...($('model').value.trim() ? { model: $('model').value.trim() } : {}) })); }
  catch (error) { fail(error); } finally { busy = false; controls(); }
};
$('resume').onclick = async () => {
  busy = true; controls();
  try { useSession(await request({ type: 'resume', sessionId: $('resume-id').value.trim() })); }
  catch (error) { fail(error); } finally { busy = false; controls(); }
};
$('composer').onsubmit = async (event) => {
  event.preventDefault(); if (busy || !session || stopped || !$('prompt').value.trim()) return;
  busy = true; assistant = undefined; controls();
  const content = $('prompt').value; message('user', content); $('prompt').value = '';
  try { const result = await request({ type: 'send', sessionId: session.id, content }); if (busy) runId = result.runId; }
  catch (error) { busy = false; fail(error); } finally { controls(); }
};
$('cancel').onclick = async () => { try { await request({ type: 'cancel', runId }); } catch (error) { fail(error); } };
async function decide(decision) {
  if (!approval) return;
  const pending = approval; approval = undefined; controls();
  try { await request({ type: 'approve', sessionId: pending.sessionId, runId: pending.runId, approvalId: pending.approvalId, decision }); }
  catch (error) { fail(error); }
}
$('deny').onclick = () => decide('deny'); $('allow').onclick = () => decide('allow_once');
function receive(event) {
  if (event.type === 'client_disconnected') { stopped = true; busy = false; approval = undefined; fail(new Error(event.message)); controls(); return; }
  if (!session || event.sessionId !== session.id) return;
  if (event.type === 'run_started') { runId = event.runId; busy = true; }
  if (event.type === 'assistant_delta') {
    assistant ??= message('assistant', ''); assistant.textContent = (assistant.textContent + event.text).slice(-32000);
  }
  if (event.type === 'tool_activity') $('activity').textContent = ($('activity').textContent + `\n${event.toolName} · ${event.operation || ''} · ${event.phase}\n${event.output || ''}`).slice(-16000);
  if (event.type === 'approval_requested') { approval = event; $('approval-label').textContent = `${event.operation}: ${event.toolName}`; }
  if (event.type === 'event_stream_truncated') $('error').textContent = 'Earlier stream output was truncated.';
  if (event.type === 'run_completed') {
    assistant ??= message('assistant', ''); assistant.textContent = event.result.finalText.slice(-32000);
  }
  if (['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)) {
    busy = false; runId = undefined; approval = undefined;
    if (event.type !== 'run_completed') $('error').textContent = event.message || 'Run cancelled.';
  }
  controls();
}
async function start() {
  try {
    providers = await request({ type: 'providers' });
    for (const provider of providers) { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.label; $('provider').append(option); }
    $('provider').onchange(); controls();
    while (!stopped) {
      for (const event of await window.dragons.events()) receive(event);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) { stopped = true; fail(error); controls(); }
}
window.addEventListener('pagehide', () => { stopped = true; });
void start();
