import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

export async function assertPickerBinding(session, workspace, launchDirectory, displayedSession) {
  assert.equal(typeof session.id, 'string');
  assert.ok(session.id.length > 0);
  assert.equal(await realpath(session.workingDirectory), await realpath(workspace), 'PICKER_SELECTED_PATH_MISMATCH');
  assert.notEqual(await realpath(session.workingDirectory), await realpath(launchDirectory), 'PICKER_LAUNCHER_COLLISION');
  assert.equal(displayedSession.split(' · ')[0], session.id, 'PICKER_DISPLAYED_ID_MISMATCH');
}

export function signalPickerGroup(pid, signal, kill = process.kill) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try { kill(-pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function cleanupPicker(stop, remove) {
  try { await stop(); } finally { await remove(); }
}
