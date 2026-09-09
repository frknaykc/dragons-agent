import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

// Isolate builtin/platform overrides from every other test process.
test("Windows rename retry releases the store lock for cancellation before model creation", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = await fs.mkdtemp(join(tmpdir(), 'dragons-rename-cancel-'));
    const original = fs.rename;
    const platform = process.platform;
    let release;
    const conflict = new Promise(resolve => { release = resolve; });
    let attempts = 0, models = 0;
    fs.rename = async (source, target) => {
      const job = JSON.parse(await fs.readFile(source, 'utf8'));
      if (job.state === 'running' && ++attempts <= 5) {
        release();
        throw Object.assign(new Error('synthetic conflict'), { code: 'EPERM', syscall: 'rename' });
      }
      return original(source, target);
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { createPersistentBackgroundJobStore, PersistentBackgroundJobManager } = await import(${JSON.stringify(new URL("./persistent-background-jobs.js", import.meta.url).href)});
      const manager = new PersistentBackgroundJobManager({ store: createPersistentBackgroundJobStore(root) });
      const job = await manager.start({ sessionId: '11111111-1111-4111-8111-111111111111', workingDirectory: root, prompt: 'Read only.', tools: [], createModel() {
        models++; return { async respond() { return { responseId: 'fixture', text: 'fixture', toolCalls: [] }; } };
      } });
      await conflict;
      assert.equal(await manager.cancel(job.id), true);
      await manager.wait(job.id);
      assert.equal(models, 0);
      assert.equal(manager.show(job.id).state, 'cancelled');
      assert.equal(JSON.parse(await fs.readFile(join(root, job.id + '.json'), 'utf8')).state, 'cancelled');
      assert.deepEqual(await fs.readdir(root), [job.id + '.json']);
      console.log('RENAME_CANCEL_PASS');
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
      fs.rename = original; syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  `], { timeout: 10000, maxBuffer: 16384 });
  assert.match(stdout, /RENAME_CANCEL_PASS/);
});
