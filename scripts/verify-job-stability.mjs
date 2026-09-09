import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Bounded diagnostic experiment for the intermittent native Windows CI failure.
// Each child uses the existing isolated deterministic fixture; never print raw TAP.
const target = fileURLToPath(new URL('../dist/m60-review-regressions.test.js', import.meta.url));
const runs = 64;
const concurrency = 8;
let next = 0;
const results = [];
async function attempt(index) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', target], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, spawnFailed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    const capture = (chunk) => { output = (output + chunk).slice(-32768); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const passed = code === 0 && !signal && !timedOut && !spawnFailed && /# pass 1\b/.test(output);
      const category = passed ? 'pass' : timedOut ? 'timeout' : spawnFailed ? 'spawn-failure'
        : output.match(/first job did not finish \(((?:EPERM|EACCES|ENOENT|EBUSY|unclassified):(?:rename|chmod|open|unlink|mkdir|lstat|read|write|unknown))\)/)?.[1]
          ?? (output.includes('EPERM') ? 'EPERM-other-stage' : 'other-failure');
      resolve({ index, category });
    });
  });
}
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const index = next++;
    if (index >= runs) return;
    results.push(await attempt(index));
  }
}));
assert.equal(results.length, runs);
const counts = {};
for (const { category } of results) counts[category] = (counts[category] ?? 0) + 1;
console.log(JSON.stringify({ experiment: 'M60_NATIVE_JOB_STABILITY', platform: process.platform, runs, concurrency, counts }));
if (counts.pass !== runs) process.exitCode = 1;
