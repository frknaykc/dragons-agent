import { rm } from 'node:fs/promises';

// Only generated compiler output is removed; never source, fixtures or local state.
const target = process.argv[2];
if (target !== undefined && target !== 'tests') throw new Error('Usage: clean-build.mjs [tests]');
await rm(new URL(target === 'tests' ? '../.test-build/' : '../dist/', import.meta.url), { recursive: true, force: true });
