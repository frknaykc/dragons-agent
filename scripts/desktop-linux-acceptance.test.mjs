import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoDebIntegration, pathExists } from './desktop-linux-acceptance.mjs';

const absent = async () => { throw Object.assign(new Error('absent'), { code: 2, stderr: 'update-alternatives: error: no alternatives for dragons-agent\n' }); };

test('absent integration and explicit absent alternatives record pass', async () => {
  await assertNoDebIntegration({ exists: async () => false, run: absent });
});
for (const residue of ['/usr/bin/dragons-agent', '/etc/alternatives/dragons-agent', '/etc/apparmor.d/dragons-agent']) {
  test(`generated residue fails: ${residue}`, async () => {
    await assert.rejects(assertNoDebIntegration({ exists: async (path) => path === residue, run: absent }));
  });
}
test('registration without remaining symlinks fails', async () => {
  await assert.rejects(assertNoDebIntegration({ exists: async () => false, run: async () => ({ stdout: 'registered' }) }));
});
test('query failure is not treated as absent registration', async () => {
  await assert.rejects(assertNoDebIntegration({ exists: async () => false, run: async () => { throw Object.assign(new Error('io'), { code: 2, stderr: 'database unavailable' }); } }));
});
test('filesystem inspection failure fails closed', async () => {
  await assert.rejects(assertNoDebIntegration({ exists: async () => { throw new Error('EACCES'); }, run: absent }));
});
test('dangling symlinks count as residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dragons-linux-cleanup-'));
  try {
    const link = join(root, 'link');
    await symlink(join(root, 'missing'), link);
    assert.equal(await pathExists(link), true);
    assert.equal(await pathExists(join(root, 'absent')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
