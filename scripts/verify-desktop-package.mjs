import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { listPackage, extractFile, statFile } from '@electron/asar';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

export function auditDesktopArchive(archive) {
  const files = listPackage(archive).map((name) => name.replaceAll('\\', '/').replace(/^\//, ''));
  for (const file of files) {
    assert.equal(file.split('/').some((part) => part === '..' || part === '.' || part === ''), false, 'Invalid archive path');
    assert.equal(/(^|\/)(\.env(?:\..*)?|\.git|\.hermes|AGENTS\.md|MILESTONES\.md|IDEA\.md)(\/|$)/.test(file), false, 'Forbidden local state in desktop archive');
    if (file.startsWith('node_modules/')) {
      assert.equal(/^node_modules\/(electron|electron-builder|app-builder-lib|typescript)(\/|$)/.test(file), false, 'Development dependency in desktop archive');
      continue;
    }
    if ('files' in statFile(archive, join(...file.split('/')))) {
      assert.equal(file === 'desktop' || file === 'dist' || file === 'node_modules' || file.startsWith('dist/'), true, 'Unexpected first-party directory');
      continue;
    }
    assert.equal(file === 'LICENSE' || file === 'package.json' || /^desktop\/(main\.mjs|preload\.cjs|index\.html|renderer\.js|style\.css)$/.test(file) || /^dist\/.*\.js$/.test(file), true, 'Unexpected first-party desktop file');
    assert.equal(/\.test\.js$|^dist\/(acceptance-|provider-acceptance|live-smoke|chatgpt-stream-trace|mcp-mock-server|mcp-official-sdk-server)/.test(file), false, 'Test/acceptance fixture in desktop archive');
  }
  for (const file of ['desktop/main.mjs', 'desktop/preload.cjs', 'desktop/index.html', 'desktop/renderer.js', 'desktop/style.css', 'dist/runtime.js', 'dist/desktop/host.js', 'dist/desktop/workspace.js', 'dist/remote/runtime.js', 'node_modules/@napi-rs/keyring/index.js']) {
    assert.equal(files.includes(file), true, `Missing packaged runtime component: ${file}`);
  }
  const prefix = `node_modules/@napi-rs/keyring-${process.platform}-${process.arch}`;
  const bindings = files.filter((file) => file.endsWith('.node') && (file.startsWith(`${prefix}/`) || file.startsWith(`${prefix}-`)));
  assert.ok(bindings.length > 0, 'Native credential-store binding for host OS/architecture missing');
  for (const binding of bindings) {
    const metadata = statFile(archive, join(...binding.split('/')), false);
    assert.equal(metadata.unpacked, true, 'Native credential-store binding must be unpacked');
    assert.equal('link' in metadata, false, 'Native credential-store binding must be a regular file');
    const sidecar = lstatSync(join(`${archive}.unpacked`, binding));
    assert.equal(sidecar.isFile(), true, 'Native credential-store sidecar must be a regular file');
    assert.ok(sidecar.size > 0, 'Native credential-store sidecar must not be empty');
    // Code signing can change unpacked Mach-O size after the ASAR header is built.
    // Loadability/signature integrity belongs to the native executable smoke/signature gate.
  }
  const metadata = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(metadata.main, 'desktop/main.mjs');
  assert.equal(metadata.version, '0.1.0');
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.dependencies['electron-updater'], undefined);
  return { status: 'PASS', files: files.length, version: metadata.version, target: `${process.platform}-${process.arch}`, nativeCredentialSidecar: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-desktop-package.mjs <app.asar>');
  console.log(JSON.stringify(auditDesktopArchive(resolve(process.argv[2]))));
}
