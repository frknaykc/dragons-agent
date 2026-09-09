import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPickerBinding } from './desktop-picker-acceptance.mjs';

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
