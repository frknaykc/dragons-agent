import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
async function files(path) {
  const entries = await readdir(new URL(path, root), { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}
const testOnly = /\.test\.|^(?:acceptance-|provider-acceptance|live-smoke|chatgpt-stream-trace|mcp-mock-server|mcp-official-sdk-server)/;

test('production source and clean output contain no test/acceptance entrypoints or fixtures', async () => {
  for (const directory of ['src/', 'dist/']) {
    const names = await files(directory);
    assert.ok(names.includes(directory === 'src/' ? 'runtime.ts' : 'runtime.js'));
    assert.deepEqual(names.filter((name) => testOnly.test(name)), [], directory);
  }
});

test('every permanent TypeScript test and subprocess fixture has an isolated compiled counterpart', async () => {
  async function relativeFiles(directory, prefix = '') {
    const result = [];
    for (const entry of await readdir(new URL(directory + prefix, root), { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) result.push(...await relativeFiles(directory, name + '/'));
      else if (entry.isFile()) result.push(name);
    }
    return result;
  }
  const source = (await relativeFiles('tests/')).filter((name) => name.endsWith('.ts'));
  // Finder may add metadata while a maintainer browses output; it is not compiler output.
  const compiled = (await relativeFiles('.test-build/')).filter((name) => name.split('/').at(-1) !== '.DS_Store');
  assert.ok(source.some((name) => name.endsWith('.test.ts')));
  assert.ok(source.includes('fixtures/mcp-mock-server.ts'));
  assert.ok(source.includes('fixtures/mcp-official-sdk-server.ts'));
  assert.deepEqual(compiled.sort(), source.map((name) => name.replace(/\.ts$/, '.js')).sort());
});
