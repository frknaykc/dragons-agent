import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit recursive discovery works identically on POSIX and Windows Node 22.
// Do not import fixture/acceptance entrypoints: only *.test.js / *.test.mjs run.
async function discover(directory, suffix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...await discover(url, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(fileURLToPath(url));
  }
  return files.sort();
}
const args = process.argv.slice(2);
const suiteOptions = args.filter((arg) => arg.startsWith('--suite='));
const suite = suiteOptions[0]?.slice('--suite='.length) ?? 'all';
assert.ok(suiteOptions.length <= 1 && ['all', 'terminal', 'desktop'].includes(suite)
  && args.filter((arg) => arg === '--list').length <= 1
  && args.every((arg) => arg.startsWith('--suite=') || arg === '--list'),
'Invalid test runner arguments; use [--suite=all|terminal|desktop] [--list]');

const root = fileURLToPath(new URL('../', import.meta.url));
const compiledRoot = new URL('../.test-build/', import.meta.url);
const scriptsRoot = new URL('../tests/', import.meta.url);
// UI-only integrations outside tests/desktop. Shared runtime/provider/LSP tests
// stay in terminal even when they also exercise a Desktop adapter.
const desktopIntegrations = new Set([
  'integration/remote-dashboard.test',
  'integration/personal-browser-adapter.test',
  'integration/personal-browser-extension.test',
  'integration/personal-browser-page.test',
]);
function select(files, base) {
  return files.filter((file) => {
    const path = relative(fileURLToPath(base), file).split(sep).join('/');
    const desktop = path.startsWith('desktop/') || desktopIntegrations.has(path.replace(/\.(?:mjs|js)$/, ''));
    return suite === 'all' || (suite === 'desktop' ? desktop : !desktop);
  });
}
const allCompiled = await discover(compiledRoot, '.test.js');
const allScripts = await discover(scriptsRoot, '.test.mjs');
assert.ok(allCompiled.length > 0, 'No compiled tests found; run pnpm build:tests');
assert.ok(allScripts.length > 0, 'No script regression tests found');
const compiled = select(allCompiled, compiledRoot);
const scripts = select(allScripts, scriptsRoot);
assert.ok(compiled.length + scripts.length > 0, `No tests found for suite ${suite}`);
if (args.includes('--list')) {
  const paths = (files) => files.map((file) => relative(root, file).split(sep).join('/'));
  console.log(JSON.stringify({ suite, compiled: paths(compiled), scripts: paths(scripts) }, null, 2));
} else {
  console.log(`TEST_DISCOVERY suite=${suite} compiled=${compiled.length} scripts=${scripts.length}`);
  const child = spawn(process.execPath, ['--test', ...compiled, ...scripts], { stdio: 'inherit' });
  child.once('error', (error) => { throw error; });
  child.once('close', (code, signal) => {
    if (signal) { console.error(`Test runner terminated by ${signal}`); process.exitCode = 1; }
    else process.exitCode = code ?? 1;
  });
}
