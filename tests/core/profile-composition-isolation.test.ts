import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Fresh processes exercise production CLI -> persisted selection -> Desktop host.
// Only the native binding is replaced, BEFORE importing either composition root.
// Fake credentials are generated in memory in each process: this is not native
// multi-account/login/persistence acceptance, and never contacts OS storage.
const harness = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const root = process.env.PROFILE_TEST_ROOT;
const phase = Number(process.env.PROFILE_TEST_PHASE);
const configPath = join(root, 'config.json');
const values = new Map();
const reads = [];
const deletes = [];
const secrets = [];
const key = () => { const value = randomUUID(); secrets.push(value); return value; };
values.set('api-key:alpha:openai-api', key());
values.set('api-key:beta:anthropic', key());
values.set('chatgpt-subscription:alpha', JSON.stringify({ version: 1, chatgpt: {
  accessToken: key(), refreshToken: key(), expiresAt: '2099-01-01T00:00:00.000Z', tokenType: 'Bearer',
} }));
let nativeConstructed = 0;
class FakeEntry {
  constructor(service, account) {
    assert.equal(service, 'Dragons Agent');
    assert.match(account, /^(api-key:(alpha|beta):(openai-api|anthropic|gemini|openrouter)|chatgpt-subscription:(alpha|beta))$/);
    this.account = account;
    nativeConstructed++;
  }
  async getPassword() { reads.push(this.account); return values.get(this.account) ?? null; }
  async setPassword() { assert.fail('No login/credential writes authorized in this regression'); }
  async deletePassword() { deletes.push(this.account); return values.delete(this.account); }
}
// CJS export substitution is process-local. No native Entry is constructed.
require('@napi-rs/keyring').AsyncEntry = FakeEntry;
assert.equal((await import('@napi-rs/keyring')).AsyncEntry, FakeEntry);
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('Network forbidden'); };
const { main } = await import(process.env.PROFILE_CLI_URL);
const { createDesktopRuntime, desktopLocalControls } = await import(process.env.PROFILE_HOST_URL);
const { createDragonsProfileStore } = await import(process.env.PROFILE_STORE_URL);
const profiles = createDragonsProfileStore({ configPath });
const output = [];
const cli = async (args, input = '/exit\n') => {
  let text = '';
  await main(args, { configPath, workingDirectory: root, tools: [],
    input: Readable.from([input]),
    model: { async respond() { assert.fail('Inference forbidden'); } },
    write: value => { text += value; output.push(value); },
  });
  return text;
};
if (phase === 0) {
  await cli(['profile', 'create', 'alpha']);
  await cli(['profile', 'select', 'alpha']);
} else {
  assert.equal(await profiles.active(), phase === 1 ? 'beta' : 'alpha');
}
const name = phase === 1 ? 'beta' : 'alpha';
const provider = phase === 1 ? 'anthropic' : 'openai-api';
const model = phase === 1 ? 'fixture-beta-model' : 'fixture-alpha-model';
if (phase < 2) {
  assert.deepEqual(JSON.parse(await cli(['config', 'show'])), {});
  await cli(['config', 'set-provider', provider]);
  await cli(['config', 'set-model', provider, model]);
  await cli([]); // Production CLI creates and saves a session, without inference.
}
const config = JSON.parse(await cli(['config', 'show']));
assert.equal(config.provider, provider);
assert.equal(config.models[provider], model);
assert.deepEqual(Object.keys(config.models), [provider]);
const host = await createDesktopRuntime(root, { configPath, profileName: name });
const local = desktopLocalControls(host);
try {
  assert.match(await local.profiles(), new RegExp('Current desktop profile: ' + name));
  const listed = await cli(['session', 'list']);
  const ownIds = (await readdir(profiles.paths(name).sessionDirectory))
    .filter(file => file.endsWith('.json')).map(file => file.slice(0, -5));
  assert.ok(ownIds.length > 0);
  for (const id of ownIds) {
    assert.ok(listed.includes(id));
    assert.ok((await local.sessions()).includes(id));
    const resumed = await host.resumeSession(id);
    assert.equal(resumed.provider, provider);
    assert.equal(resumed.model, model);
  }
  if (phase > 0) {
    const foreign = JSON.parse(await readFile(join(root, phase === 1 ? 'alpha-ids.json' : 'beta-ids.json'), 'utf8'));
    for (const id of foreign) {
      assert.ok(!listed.includes(id));
      assert.ok(!(await local.sessions()).includes(id));
      await assert.rejects(host.resumeSession(id));
      await assert.rejects(cli(['session', 'show', id]), /not found|unreadable/);
    }
  }
  const fresh = await host.createSession();
  assert.equal(fresh.provider, provider);
  assert.equal(fresh.model, model);
  for (const target of ['openai-api', 'anthropic', 'gemini', 'openrouter', 'chatgpt']) {
    const account = target === 'chatgpt' ? 'chatgpt-subscription:' + name : 'api-key:' + name + ':' + target;
    const present = values.has(account);
    reads.length = 0;
    const status = await cli(['auth', 'status', '--provider', target]);
    assert.ok(reads.length > 0);
    assert.ok(reads.every(value => value === account));
    assert.match(status, target === 'chatgpt' ? (present ? /signed in/i : /not signed in/i) : (present ? /saved API key present/ : /no saved API key/));
    reads.length = 0;
    const desktopStatus = await local.auth(target);
    assert.ok(reads.length > 0);
    assert.ok(reads.every(value => value === account));
    assert.match(desktopStatus, target === 'chatgpt' ? (present ? /^Signed in/ : /^Not signed in/) : (present ? /: API key stored/ : /: No API key stored/));
  }
  // Destructive control must only remove its selected provider/profile slot.
  const account = 'api-key:' + name + ':' + provider;
  const before = new Map(values);
  await local.logout(provider);
  assert.deepEqual(deletes, [account]);
  assert.equal(values.has(account), false);
  before.delete(account);
  assert.deepEqual(values, before);
  assert.match(await cli(['auth', 'status', '--provider', provider]), /no saved API key/);
  if (phase < 2) {
    await writeFile(join(root, name + '-ids.json'), JSON.stringify([...ownIds, fresh.id]));
    if (phase === 0) await local.createProfile('beta');
    await local.selectProfile(phase === 0 ? 'beta' : 'alpha');
    // Selection affects the next process, not this host's pinned state.
    assert.match(await local.profiles(), new RegExp('Current desktop profile: ' + name));
    assert.equal((await host.createSession()).model, model);
  }
} finally { await local.close(); await host.dispose(); }
assert.ok(nativeConstructed > 0);
assert.equal(fetchCalls, 0);
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else {
      assert.notEqual(entry.name, 'auth.json');
      const text = await readFile(path, 'utf8');
      for (const secret of secrets) assert.ok(!text.includes(secret), 'Fake credential leaked to disk');
    }
  }
}
await inspect(root);
for (const secret of secrets) assert.ok(!output.join('').includes(secret), 'Fake credential leaked to CLI output');
console.log('PROFILE_COMPOSITION_PHASE_OK ' + phase);
`;

test("CLI and Desktop profile create/select/process restart isolate models, sessions and native credential namespaces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-profile-composition-")));
  try {
    for (const phase of [0, 1, 2]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", harness], {
        cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? "",
          PROFILE_TEST_ROOT: root, PROFILE_TEST_PHASE: String(phase),
          PROFILE_CLI_URL: new URL("../../dist/cli.js", import.meta.url).href,
          PROFILE_HOST_URL: new URL("../../dist/desktop/host.js", import.meta.url).href,
          PROFILE_STORE_URL: new URL("../../dist/profiles.js", import.meta.url).href,
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `phase ${phase}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`PROFILE_COMPOSITION_PHASE_OK ${phase}`));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
