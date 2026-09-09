import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDesktopDmg } from './verify-desktop-dmg.mjs';
import { runOutcome } from './desktop-acceptance.mjs';

for (const kind of ['failure', 'cancel']) {
  test(`M77 streamed sentinel followed by ${kind} is not successful completion`, async () => {
    let reject;
    const result = new Promise((_resolve, fail) => { reject = fail; });
    const outcome = runOutcome(result, 'expected');
    const displayedDelta = 'expected';
    reject(new Error(kind));
    assert.equal(displayedDelta, 'expected');
    assert.equal(await outcome, 'failed');
  });
}

test('M77 successful run requires the exact final result', async () => {
  assert.equal(await runOutcome(Promise.resolve({ finalText: 'expected' }), 'expected'), 'completed');
  assert.equal(await runOutcome(Promise.resolve({ finalText: 'different' }), 'expected'), 'wrong-result');
});

async function dmgFixture(t, behavior) {
  const root = await mkdtemp(join(tmpdir(), 'dragons-dmg-test-'));
  // No real image is mounted by these injected subprocess tests.
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], removed = [], warnings = [];
  const options = {
    createRoot: async () => root,
    execute: async (command, args) => { calls.push([command, ...args]); await behavior(command, args); },
    remove: async (path) => { removed.push(path); },
    warn: (message) => { warnings.push(message); },
  };
  return { root, calls, removed, warnings, options };
}

test('M77 DMG late attach failure detaches before recursive removal', async (t) => {
  const fixture = await dmgFixture(t, async (_command, args) => {
    if (args[0] === 'attach') throw new Error('simulated mount succeeded but attach process timed out');
  });
  await assert.rejects(verifyDesktopDmg('fixture.dmg', fixture.options), /timed out/);
  assert.deepEqual(fixture.calls.map((call) => call[1]), ['attach', 'detach']);
  assert.deepEqual(fixture.removed, [fixture.root]);
  assert.deepEqual(fixture.warnings, []);
});

test('M77 DMG uncertain mount is preserved when detach fails', async (t) => {
  const fixture = await dmgFixture(t, async (_command, args) => {
    if (args[0] === 'attach') throw new Error('late attach failure');
    if (args[0] === 'detach') throw new Error('detach failed');
  });
  await assert.rejects(verifyDesktopDmg('fixture.dmg', fixture.options), /late attach/);
  assert.deepEqual(fixture.calls.map((call) => call[1]), ['attach', 'detach']);
  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.warnings.length, 1);
});

test('M77 DMG detach retry failure never removes a possibly mounted root', async (t) => {
  const fixture = await dmgFixture(t, async (_command, args) => {
    if (args[0] === 'detach') throw new Error('detach failed');
  });
  await assert.rejects(verifyDesktopDmg('fixture.dmg', fixture.options), /detach failed/);
  assert.equal(fixture.calls.filter((call) => call[1] === 'detach').length, 2);
  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.warnings.length, 1);
});

test('M77 DMG normal flow detaches before audit/smoke and removes the copied app', async (t) => {
  const fixture = await dmgFixture(t, async () => {});
  await verifyDesktopDmg('fixture.dmg', fixture.options);
  assert.equal(fixture.calls[0][1], 'attach');
  assert.equal(fixture.calls[1][0], 'ditto');
  assert.equal(fixture.calls[2][1], 'detach');
  assert.equal(fixture.calls[3][1], 'scripts/verify-desktop-package.mjs');
  assert.equal(fixture.calls[4][1], 'scripts/verify-desktop-installed.mjs');
  assert.deepEqual(fixture.removed, [join(fixture.root, 'installed'), fixture.root]);
});
