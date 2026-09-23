import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

// Isolate builtin/platform overrides from every other test process.
test("Windows rename retry queues behind cancellation across canonical store instances", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import timers from 'node:timers/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    function barrier() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      return { promise, release };
    }
    const root = await fs.mkdtemp(join(tmpdir(), 'dragons-rename-cancel-'));
    const canonicalRoot = await fs.realpath(root);
    const original = { rename: fs.rename, realpath: fs.realpath, writeFile: fs.writeFile, delay: timers.setTimeout };
    const platform = process.platform;
    const backoff = barrier(), retry = barrier(), cancelling = barrier(), commit = barrier(), retryEntered = barrier();
    let attempts = 0, models = 0, delays = 0, overlappingLocks = 0;
    let cancellationHeld = false, retryResumed = false;
    fs.rename = async (source, target) => {
      const job = JSON.parse(await fs.readFile(source, 'utf8'));
      if (job.state === 'running') {
        attempts++;
        throw Object.assign(new Error('synthetic conflict'), { code: 'EPERM', syscall: 'rename' });
      }
      if (job.state === 'cancelled') {
        cancellationHeld = true;
        cancelling.release();
        await commit.promise;
        cancellationHeld = false;
      }
      return original.rename(source, target);
    };
    timers.setTimeout = async milliseconds => {
      assert.equal(milliseconds, 10);
      delays++;
      backoff.release();
      await retry.promise;
      retryResumed = true;
    };
    fs.realpath = async (...args) => {
      const result = await original.realpath(...args);
      if (retryResumed && cancellationHeld) retryEntered.release();
      return result;
    };
    fs.writeFile = async (path, ...args) => {
      if (String(path).endsWith('.persistent-background-jobs.lock') && cancellationHeld) {
        overlappingLocks++;
        retryEntered.release();
      }
      return original.writeFile(path, ...args);
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { createPersistentBackgroundJobStore, PersistentBackgroundJobManager } = await import(${JSON.stringify(new URL("../../dist/persistent-background-jobs.js", import.meta.url).href)});
      const backing = createPersistentBackgroundJobStore(root);
      const other = createPersistentBackgroundJobStore(canonicalRoot + '/.');
      const manager = new PersistentBackgroundJobManager({ store: {
        ...backing,
        save(job, revision) { return (job.state === 'cancelled' ? other : backing).save(job, revision); },
      } });
      const job = await manager.start({ sessionId: '11111111-1111-4111-8111-111111111111', workingDirectory: root, prompt: 'Read only.', tools: [], createModel() {
        models++; throw new Error('Must not create model');
      } });
      // Capture before cancellation: a late wait can silently miss a detached rejection.
      const waiting = manager.wait(job.id);
      void waiting.catch(() => {});
      await backoff.promise;
      const cancelled = manager.cancel(job.id);
      await cancelling.promise;
      retry.release();
      await retryEntered.promise;
      // Drain microtasks after canonicalization: the retry has joined the queue,
      // while cancellation still owns the cross-process lock. No timed sleeps.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(overlappingLocks, 0, 'retry must not acquire its own process lock');
      commit.release();
      assert.equal(await cancelled, true);
      await waiting;
      assert.equal(delays, 1);
      assert.equal(attempts, 1, 'stale retry must fail revision validation before rename');
      assert.equal(models, 0);
      assert.equal(manager.show(job.id).state, 'cancelled');
      assert.equal(JSON.parse(await fs.readFile(join(root, job.id + '.json'), 'utf8')).state, 'cancelled');
      assert.deepEqual(await fs.readdir(root), [job.id + '.json']);
      // A rejected stale save must release the queue for subsequent saves.
      const current = await other.load(job.id);
      await backing.save(current, current.revision);
      assert.deepEqual(await fs.readdir(root), [job.id + '.json']);
      console.log('RENAME_CANCEL_PASS');
    } finally {
      retry.release(); commit.release();
      Object.defineProperty(process, 'platform', { value: platform });
      fs.rename = original.rename; fs.realpath = original.realpath; fs.writeFile = original.writeFile;
      timers.setTimeout = original.delay; syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  `], { timeout: 10000, maxBuffer: 16384 });
  assert.match(stdout, /RENAME_CANCEL_PASS/);
});
