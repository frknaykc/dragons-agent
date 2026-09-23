import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
const compiled = await discover(new URL('../.test-build/', import.meta.url), '.test.js');
const scripts = await discover(new URL('../tests/', import.meta.url), '.test.mjs');
assert.ok(compiled.length > 0, 'No compiled tests found; run pnpm build:tests');
assert.ok(scripts.length > 0, 'No script regression tests found');
console.log(`TEST_DISCOVERY compiled=${compiled.length} scripts=${scripts.length}`);
const child = spawn(process.execPath, ['--test', ...compiled, ...scripts], { stdio: 'inherit' });
child.once('error', (error) => { throw error; });
child.once('close', (code, signal) => {
  if (signal) { console.error(`Test runner terminated by ${signal}`); process.exitCode = 1; }
  else process.exitCode = code ?? 1;
});
