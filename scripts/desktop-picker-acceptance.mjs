import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';

export async function assertPickerBinding(session, workspace, launchDirectory, displayedSession) {
  assert.equal(typeof session.id, 'string');
  assert.ok(session.id.length > 0);
  // Windows native dialogs and Node may spell the same path differently.
  // Compare real directory identity, never relax to basename or case-insensitive text.
  const identity = async (path) => {
    const value = await stat(path, { bigint: true });
    assert.ok(value.isDirectory() && value.ino > 0n, 'Directory identity unavailable');
    return [value.dev, value.ino];
  };
  const [actual, selected, launcher] = await Promise.all([session.workingDirectory, workspace, launchDirectory].map(identity));
  assert.notDeepEqual(selected, launcher, 'PICKER_LAUNCHER_COLLISION');
  assert.deepEqual(actual, selected, 'PICKER_SELECTED_PATH_MISMATCH');
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
