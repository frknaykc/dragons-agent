import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { removeMemoryFromProvider, shareMemoryWithProvider } from "../../dist/external-memory.js";
import { createMemoryStore, createProjectMemoryScope, type MemoryStore } from "../../dist/memory.js";
import { FakeExternalMemoryProvider } from "../fixtures/external-memory-provider.js";

const INSTANT = new Date("2026-01-01T00:00:00.000Z");
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

async function fixture(fn: (f: { store: MemoryStore; provider: FakeExternalMemoryProvider; now: () => Date; advance(days: number): void; root: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dragons-external-memory-"));
  let time = INSTANT.getTime();
  let ids = 0;
  const now = () => new Date(time);
  const store = createMemoryStore(join(root, "memory"), { now, createId: () => [FIRST_ID, SECOND_ID][ids++]! });
  const provider = new FakeExternalMemoryProvider(now);
  try { await fn({ store, provider, now, advance: (days) => { time += days * 86_400_000; }, root }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("external memory sharing requires exact per-record consent, bounds retention, and never imports automatically", async () => fixture(async ({ store, provider, now, advance, root }) => {
  const projectScope = await createProjectMemoryScope(root);
  const local = await store.add({ body: "Remember the local style.", scope: projectScope });
  let consent = 0;
  const request = { store, provider, scope: projectScope, id: local.id, retentionDays: 30, now,
    approve: (decision: { action: string; providerId: string; record: { body: string; expiresAt: string; scope: { kind: string } } }) => {
      consent += 1;
      assert.equal(decision.action, "share");
      assert.equal(decision.providerId, "fake-memory");
      assert.equal(decision.record.body, local.body);
      assert.equal(decision.record.scope.kind, "PROJECT");
      assert.equal(decision.record.expiresAt, "2026-01-31T00:00:00.000Z");
      return consent > 1;
    },
  };
  assert.equal(await shareMemoryWithProvider(request), false);
  assert.deepEqual(provider.calls, []);
  assert.equal(await shareMemoryWithProvider(request), true);
  assert.equal(consent, 2);
  assert.equal((await provider.list(projectScope)).length, 1);
  assert.deepEqual(await provider.list({ kind: "USER" }), []);
  await mkdir(join(root, "another-project"));
  const otherScope = await createProjectMemoryScope(join(root, "another-project"));
  assert.deepEqual(await provider.list(otherScope), []);
  assert.equal(await shareMemoryWithProvider({ ...request, scope: otherScope, approve: () => true }), false);
  assert.equal(await shareMemoryWithProvider({ ...request, scope: { kind: "USER" }, approve: () => true }), false);
  assert.equal((await store.list(projectScope)).length, 1);
  advance(31);
  assert.deepEqual(await provider.list(projectScope), []);
}));

test("remote removal needs fresh consent, revalidates the remote record, and leaves local data untouched", async () => fixture(async ({ store, provider, now }) => {
  const scope = { kind: "USER" as const };
  const local = await store.add({ body: "Durable note", scope });
  assert.equal(await shareMemoryWithProvider({ store, provider, scope, id: local.id, retentionDays: 7, now, approve: () => true }), true);
  const options = { store, provider, scope, id: local.id, now };
  assert.equal(await removeMemoryFromProvider({ ...options, approve: () => false }), false);
  assert.equal((await provider.list(scope)).length, 1);
  await assert.rejects(removeMemoryFromProvider({ ...options, approve: async () => {
    await provider.upsert({ id: local.id, scope, body: "Changed on server", expiresAt: "2026-01-08T00:00:00.000Z" });
    return true;
  } }), /changed/);
  assert.equal(await removeMemoryFromProvider({ ...options, approve: () => true }), true);
  assert.deepEqual(await provider.list(scope), []);
  assert.equal((await store.list(scope)).length, 1);
}));

test("remote scope mismatch and invalid records cannot trigger a deletion", async () => fixture(async ({ store, provider, now, root }) => {
  const scope = { kind: "USER" as const };
  const local = await store.add("Scoped note");
  await mkdir(join(root, "project"));
  const otherScope = await createProjectMemoryScope(join(root, "project"));
  const record = { id: local.id, body: local.body, scope: otherScope, expiresAt: "2026-01-08T00:00:00.000Z" };
  const wrongScope = { ...provider, id: "misleading", list: async () => [record], remove: () => { throw new Error("must not remove"); }, upsert: provider.upsert.bind(provider) };
  await assert.rejects(removeMemoryFromProvider({ store, provider: wrongScope, id: local.id, scope, now, approve: () => true }), /scope mismatch/);
  const invalidRecord = { ...wrongScope, list: async () => [{ ...record, scope, body: "access_token=secret-value" }] };
  await assert.rejects(removeMemoryFromProvider({ store, provider: invalidRecord, id: local.id, scope, now, approve: () => true }), /secret/);
}));

test("stale local consent, cancellation, invalid policies, and secret-bearing bodies fail closed", async () => fixture(async ({ store, provider, now, root }) => {
  const local = await store.add("No transfer without approval");
  const scope = { kind: "USER" as const };
  const options = { store, provider, id: local.id, scope, retentionDays: 10, now };
  await assert.rejects(shareMemoryWithProvider({ ...options, retentionDays: 366, approve: () => true }), /1–365/);
  await assert.rejects(shareMemoryWithProvider({ ...options, approve: async () => {
    await store.update(local.id, { body: "Updated after decision" }, scope);
    return true;
  } }), /changed/);
  assert.deepEqual(provider.calls, []);
  const abort = new AbortController();
  await assert.rejects(shareMemoryWithProvider({ ...options, signal: abort.signal, approve: () => { abort.abort(); return true; } }), /cancelled/);
  const projectScope = await createProjectMemoryScope(root);
  assert.equal(await shareMemoryWithProvider({ ...options, scope: projectScope, approve: () => true }), false);
  await assert.rejects(shareMemoryWithProvider({ ...options, id: "../outside", approve: () => true }), /Invalid memory ID/);
  const secretStore: MemoryStore = { ...store, get: async () => ({ ...local, body: "api_key=exposed-value" }) };
  await assert.rejects(shareMemoryWithProvider({ ...options, store: secretStore, approve: () => true }), /secret/);
  assert.deepEqual(provider.calls, []);
}));

test("remote expiry never exceeds local expiry and provider failures do not write local state", async () => fixture(async ({ store, provider, now }) => {
  const scope = { kind: "USER" as const };
  const local = await store.add("Temporary user note");
  await store.expire(local.id, "2026-01-03T00:00:00.000Z", scope);
  assert.equal(await shareMemoryWithProvider({ store, provider, scope, id: local.id, retentionDays: 30, now, approve: ({ record }) => {
    assert.equal(record.expiresAt, "2026-01-03T00:00:00.000Z");
    return true;
  } }), true);
  const broken = { ...provider, id: "broken", list: provider.list.bind(provider), remove: provider.remove.bind(provider), upsert: async () => { throw new Error("offline"); } };
  await assert.rejects(shareMemoryWithProvider({ store, provider: broken, scope, id: local.id, retentionDays: 1, now, approve: () => true }), /offline/);
  assert.equal((await store.list(scope)).length, 1);
}));
