import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPackageWithOptions } from '@electron/asar';
import { auditDesktopArchive } from '../../scripts/verify-desktop-package.mjs';

const builder = JSON.parse(await readFile(new URL('../../electron-builder.json', import.meta.url), 'utf8'));
const desktopAssets = builder.files.filter((file) => file.startsWith('desktop/'));
const desktopEntries = Object.fromEntries(await Promise.all(desktopAssets.map(async (file) => [file, await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')])));
const binding = `node_modules/@napi-rs/keyring-${process.platform}-${process.arch}/keyring.${process.platform}-${process.arch}.node`;
const checkpointBinding = 'native/checkpoint-win32/build/Release/checkpoint_win32.node';

async function fixture(extra, action, unpack = true) {
  const root = await mkdtemp(join(tmpdir(), 'dragons-archive-test-'));
  try {
    const entries = {
      ...desktopEntries,
      'dist/runtime.js': '', 'dist/desktop/host.js': '', 'dist/desktop/workspace.js': '', 'dist/remote/runtime.js': '',
      'node_modules/@napi-rs/keyring/index.js': '', [binding]: 'synthetic sidecar fixture, not a loadable native binary',
      ...(process.platform === 'win32' ? { [checkpointBinding]: 'synthetic checkpoint sidecar fixture, not a loadable native binary' } : {}),
      'package.json': JSON.stringify({ main: 'desktop/main.mjs', version: '0.1.0', type: 'module', dependencies: {} }),
      ...extra,
    };
    for (const [name, content] of Object.entries(entries)) {
      if (content === null) continue;
      const target = join(root, 'input', name);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
    }
    const archive = join(root, 'app.asar');
    // asar matches absolute paths with matchBase: true. A basename glob also works
    // when TMPDIR has a hidden ancestor (for example a profile-local scratch root).
    await createPackageWithOptions(join(root, 'input'), archive, unpack ? { unpack: '*.node' } : {});
    await action(archive);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('M77 archive audit accepts only runtime/package components', async () => {
  await fixture({}, (archive) => assert.equal(auditDesktopArchive(archive).status, 'PASS'));
});

for (const name of ['desktop/secret-extra.js', '.env', '.hermes/config.json', 'credentials', 'src/runtime.ts', 'tests/fixtures/server.js', 'experiments/macos-native/helper.c', '.test-build/core/runtime.test.js', 'dist/mcp-mock-server.js', 'dist/mcp-official-sdk-server.js', 'dist/runtime.test.js', 'dist/acceptance-live.js', 'node_modules/electron/index.js']) {
  test(`M77 archive audit rejects ${name}`, async () => {
    await fixture({ [name]: 'non-secret fixture' }, (archive) => assert.throws(() => auditDesktopArchive(archive)));
  });
}

for (const asset of [...desktopAssets, 'dist/runtime.js', 'dist/desktop/host.js', 'dist/desktop/workspace.js', 'dist/remote/runtime.js', 'node_modules/@napi-rs/keyring/index.js']) {
  test(`M77 archive audit requires ${asset}`, async () => {
    await fixture({ [asset]: null }, (archive) => assert.throws(() => auditDesktopArchive(archive), (error) => error instanceof Error && error.message.startsWith(`Missing packaged runtime component: ${asset}\n`)));
  });
}

test('M77 archive audit rejects a packed-only native binding', async () => {
  await fixture({}, (archive) => assert.throws(() => auditDesktopArchive(archive)), false);
});

test('M77 archive audit rejects a missing native sidecar', async () => {
  await fixture({}, async (archive) => {
    await rm(`${archive}.unpacked`, { recursive: true });
    assert.throws(() => auditDesktopArchive(archive));
  });
});

test('M77 archive audit rejects an empty native sidecar', async () => {
  await fixture({ [binding]: '' }, (archive) => assert.throws(() => auditDesktopArchive(archive)));
});

test('M77 archive audit rejects a binding for a different target', async () => {
  await fixture({ [binding]: null, 'node_modules/@napi-rs/keyring-other-other/keyring.other.node': 'fixture' },
    (archive) => assert.throws(() => auditDesktopArchive(archive)));
});

test('M77 archive audit permits sidecar size changes after signing', async () => {
  await fixture({}, async (archive) => {
    await appendFile(join(`${archive}.unpacked`, binding), 'simulated signing size change');
    assert.equal(auditDesktopArchive(archive).nativeCredentialSidecar, true);
  });
});

test('M77 archive audit rejects a non-file sidecar', async () => {
  await fixture({}, async (archive) => {
    const sidecar = join(`${archive}.unpacked`, binding);
    await rm(sidecar); await mkdir(sidecar);
    assert.throws(() => auditDesktopArchive(archive));
  });
});

if (process.platform === 'win32') {
  test('M77 archive audit rejects a missing Windows checkpoint binding', async () => {
    await fixture({ [checkpointBinding]: null }, (archive) => assert.throws(() => auditDesktopArchive(archive), /Windows checkpoint binding missing/));
  });
  test('M77 archive audit rejects an empty Windows checkpoint sidecar', async () => {
    await fixture({ [checkpointBinding]: '' }, (archive) => assert.throws(() => auditDesktopArchive(archive), /Windows checkpoint sidecar must not be empty/));
  });
}
