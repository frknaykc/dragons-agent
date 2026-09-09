import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';

export async function pathExists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Maintainer scripts create these outside the dpkg payload list; dangling links count as residue.
export async function assertNoDebIntegration({ exists = pathExists, run }) {
  for (const path of ['/usr/bin/dragons-agent', '/etc/alternatives/dragons-agent', '/etc/apparmor.d/dragons-agent']) {
    assert.equal(await exists(path), false, 'Existing or residual DEB integration');
  }
  try {
    await run('update-alternatives', ['--query', 'dragons-agent'], { env: { ...process.env, LC_ALL: 'C' } });
    throw new Error('Existing or residual alternatives registration');
  } catch (error) {
    if (error.code !== 2 || !/^update-alternatives: error: no alternatives for dragons-agent\s*$/.test(String(error.stderr))) throw error;
  }
}
