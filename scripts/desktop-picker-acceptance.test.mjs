import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPickerBinding, cleanupPicker, signalPickerGroup } from './desktop-picker-acceptance.mjs';

for (const condition of ['selected', 'launcher', 'other', 'wrong-session', 'missing-session']) {
  test(`picker binding validates ${condition}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dragons-picker-binding-'));
    try {
      const selected = join(root, 'selected workspace'), launcher = join(root, 'launcher'), other = join(root, 'other');
      for (const directory of [selected, launcher, other]) await mkdir(directory);
      const session = { id: condition === 'missing-session' ? '' : 'fixture-id', workingDirectory: condition === 'launcher' ? launcher : condition === 'other' ? other : selected };
      const check = () => assertPickerBinding(session, selected, launcher, condition === 'wrong-session' ? 'different-id · fixture' : 'fixture-id · fixture');
      if (condition === 'selected') await check(); else await assert.rejects(check);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('cleanup attempts directory removal even if process cleanup fails', async () => {
  let removed = false;
  await assert.rejects(() => cleanupPicker(async () => { throw new Error('stop failed'); }, async () => { removed = true; }));
  assert.equal(removed, true);
});
test('directory identity accepts an alias of selected folder, rejects the same basename elsewhere', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dragons-picker-identity-'));
  try {
    const selected = join(root, 'a', 'workspace'), other = join(root, 'b', 'workspace'), launcher = join(root, 'launcher'), alias = join(root, 'alias');
    await Promise.all([selected, other, launcher].map((path) => mkdir(path, { recursive: true })));
    await symlink(selected, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assertPickerBinding({ id: 'fixture', workingDirectory: alias }, selected, launcher, 'fixture · provider');
    await assert.rejects(() => assertPickerBinding({ id: 'fixture', workingDirectory: other }, selected, launcher, 'fixture · provider'), /PICKER_SELECTED_PATH_MISMATCH/);
    await assert.rejects(() => assertPickerBinding({ id: 'fixture', workingDirectory: selected }, selected, alias, 'fixture · provider'), /PICKER_LAUNCHER_COLLISION/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('cleanup errors cannot pass', async () => {
  await assert.rejects(() => cleanupPicker(async () => {}, async () => { throw new Error('remove failed'); }));
});
test('owned process group signals use negative PID, never just the parent', () => {
  assert.equal(signalPickerGroup(123, 'SIGKILL', (pid, signal) => {
    assert.equal(pid, -123); assert.equal(signal, 'SIGKILL');
  }), true);
  assert.throws(() => signalPickerGroup(0, 0, () => {}));
});
test('only absent process group is accepted; inspection errors fail closed', () => {
  assert.equal(signalPickerGroup(123, 0, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.throws(() => signalPickerGroup(123, 0, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }));
});
