import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createChatGPTAuthService, createCodexCredentialManager } from "./provider/codex-auth.js";

import {
  createLegacyCodexCredentialStore,
  createMigratingCodexCredentialStore,
  createNativeCodexCredentialStore,
  createPreferredCodexCredentialStore,
  type CodexCredentialStore,
  type CodexCredentials,
  type NativeCredentialEntry,
} from "./provider/credential-store.js";

const fixtureCredentials: CodexCredentials = {
  accessToken: "access-fixture-a",
  refreshToken: "refresh-fixture-a",
  expiresAt: "2099-01-01T00:00:00.000Z",
  accountId: "acct_fixture",
  tokenType: "Bearer",
};

function clone(credentials: CodexCredentials | undefined): CodexCredentials | undefined {
  return credentials && structuredClone(credentials);
}

function memoryStore(label: string, initial?: CodexCredentials, options: { failLoad?: boolean; failSave?: boolean; failRemove?: boolean } = {}) {
  let current = clone(initial);
  let writes = 0;
  let removals = 0;
  const store: CodexCredentialStore = {
    async load() {
      if (options.failLoad) throw new Error("fixture credential detail must not escape");
      return clone(current);
    },
    async save(credentials) {
      writes += 1;
      if (options.failSave) throw new Error("fixture credential detail must not escape");
      current = clone(credentials);
    },
    async remove() {
      removals += 1;
      if (options.failRemove) throw new Error("fixture credential detail must not escape");
      current = undefined;
    },
    async storageDescription() { return label; },
  };
  return { store, current: () => clone(current), writes: () => writes, removals: () => removals };
}

test("native credential store persists only its versioned Dragons payload through an injected entry", async () => {
  let payload: string | undefined;
  const entry: NativeCredentialEntry = {
    async getPassword() { return payload; },
    async setPassword(value) { payload = value; },
    async deletePassword() { const deleted = payload !== undefined; payload = undefined; return deleted; },
  };
  const store = createNativeCodexCredentialStore({ entry, platform: "darwin" });

  assert.equal(await store.load(), undefined);
  await store.save(fixtureCredentials);
  assert.deepEqual(await store.load(), fixtureCredentials);
  assert.equal(await store.storageDescription(), "macOS Keychain");
  assert.equal(payload?.includes("authorization_code"), false);
  await store.remove();
  assert.equal(await store.load(), undefined);
});

test("legacy credentials migrate once after native write/read verification and then remain idempotent", async () => {
  const native = memoryStore("macOS Keychain");
  const legacy = memoryStore("secure file fallback", fixtureCredentials);
  const store = createMigratingCodexCredentialStore(native.store, legacy.store);

  assert.deepEqual(await store.load(), fixtureCredentials);
  assert.deepEqual(native.current(), fixtureCredentials);
  assert.equal(legacy.current(), undefined);
  assert.equal(native.writes(), 1);
  assert.deepEqual(await store.load(), fixtureCredentials);
  assert.equal(native.writes(), 1);
});

test("failed migration preserves the legacy Dragons credential and redacts the storage failure", async () => {
  const native = memoryStore("macOS Keychain", undefined, { failSave: true });
  const legacy = memoryStore("secure file fallback", fixtureCredentials);
  const store = createMigratingCodexCredentialStore(native.store, legacy.store);

  await assert.rejects(store.load(), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Unable to migrate Dragons ChatGPT credentials/);
    assert.doesNotMatch(message, /fixture credential detail|access-fixture-a|refresh-fixture-a/);
    return true;
  });
  assert.deepEqual(legacy.current(), fixtureCredentials);
});

test("corrupted legacy data is rejected without migration or credential disclosure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-credential-corrupt-"));
  const path = join(directory, "auth.json");
  await writeFile(path, "{ malformed", "utf8");
  const native = memoryStore("macOS Keychain");
  const store = createMigratingCodexCredentialStore(native.store, createLegacyCodexCredentialStore(path));

  await assert.rejects(store.load(), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Legacy Dragons ChatGPT credential is corrupted/);
    assert.doesNotMatch(message, /malformed/);
    return true;
  });
  assert.equal(native.current(), undefined);
});

test("unavailable native storage uses an explicit visible restrictive-file fallback only", async () => {
  const nativeEntry: NativeCredentialEntry = {
    async getPassword() { throw new Error("backend unavailable"); },
    async setPassword() {},
    async deletePassword() { return true; },
  };
  const native = createNativeCodexCredentialStore({ entry: nativeEntry, platform: "darwin" });
  const legacy = memoryStore("secure file fallback", fixtureCredentials);
  const store = createPreferredCodexCredentialStore(native, legacy.store);

  assert.deepEqual(await store.load(), fixtureCredentials);
  assert.equal(await store.storageDescription(), "secure file fallback (native credential storage unavailable)");
  await store.remove();
  assert.equal(legacy.current(), undefined);
});

test("corrupt native payload fails safely instead of downgrading to the legacy file", async () => {
  const nativeEntry: NativeCredentialEntry = {
    async getPassword() { return "{ invalid"; },
    async setPassword() {},
    async deletePassword() { return true; },
  };
  const native = createNativeCodexCredentialStore({ entry: nativeEntry, platform: "darwin" });
  const legacy = memoryStore("secure file fallback", fixtureCredentials);
  const store = createPreferredCodexCredentialStore(native, legacy.store);

  await assert.rejects(store.load(), /Native Dragons ChatGPT credential is corrupted/);
  assert.deepEqual(legacy.current(), fixtureCredentials);
});

test("explicit login replaces a malformed native credential and makes status authenticated", async () => {
  let payload = "{ malformed-native-payload";
  const native = createNativeCodexCredentialStore({
    platform: "darwin",
    entry: {
      async getPassword() { return payload; },
      async setPassword(value) { payload = value; },
      async deletePassword() { payload = undefined as unknown as string; return true; },
    },
  });
  const legacy = memoryStore("secure file fallback");
  const auth = createChatGPTAuthService({
    nativeCredentialStore: native,
    legacyCredentialStore: legacy.store,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    sleep: async () => undefined,
    openBrowser: () => true,
    write: () => undefined,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/usercode")) return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device", interval: 1 });
      if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600, token_type: "Bearer" });
    },
  });

  await auth.login();
  assert.deepEqual(await auth.status(), {
    authenticated: true,
    expiresAt: "2026-09-03T01:00:00.000Z",
    storage: "macOS Keychain",
  });
  assert.equal(payload.includes("fresh-access"), true);
});

test("secure-store write failure never falls back during credential rotation", async () => {
  const native = memoryStore("macOS Keychain", fixtureCredentials, { failSave: true });
  const legacy = memoryStore("secure file fallback");
  const store = createMigratingCodexCredentialStore(native.store, legacy.store);
  const rotated = { ...fixtureCredentials, accessToken: "access-fixture-b", refreshToken: "refresh-fixture-b" };

  await assert.rejects(store.save(rotated), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Unable to save Dragons ChatGPT credentials to secure storage/);
    assert.doesNotMatch(message, /access-fixture-b|refresh-fixture-b/);
    return true;
  });
  assert.equal(legacy.current(), undefined);
  assert.deepEqual(native.current(), fixtureCredentials);
});

test("auth status and logout use the active Dragons-owned credential store without exposing payload metadata", async () => {
  const active = memoryStore("macOS Keychain", fixtureCredentials);
  const auth = createChatGPTAuthService({ credentialStore: active.store });

  assert.deepEqual(await auth.status(), {
    authenticated: true,
    expiresAt: fixtureCredentials.expiresAt,
    storage: "macOS Keychain",
  });
  await auth.logout();
  assert.deepEqual(await auth.status(), { authenticated: false, storage: "macOS Keychain" });
  assert.equal(active.removals(), 1);
});

test("refresh refuses to continue when secure persistence of a rotated credential fails", async () => {
  const active = memoryStore("macOS Keychain", {
    ...fixtureCredentials,
    expiresAt: "2020-01-01T00:00:00.000Z",
  }, { failSave: true });
  const manager = createCodexCredentialManager({
    store: active.store,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    fetchImpl: async () => Response.json({
      access_token: "access-fixture-b",
      refresh_token: "refresh-fixture-b",
      expires_in: 3600,
    }),
  });

  await assert.rejects(manager.getValidCredentials(), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /Unable to save refreshed ChatGPT Subscription credentials to secure storage/);
    assert.doesNotMatch(message, /access-fixture-b|refresh-fixture-b|fixture credential detail/);
    return true;
  });
  assert.equal(active.writes(), 1);
  assert.equal(active.current()?.accessToken, fixtureCredentials.accessToken);
});

test("an explicit login invalidation prevents an older concurrent refresh from overwriting replacement state", async () => {
  const active = memoryStore("macOS Keychain", { ...fixtureCredentials, expiresAt: "2020-01-01T00:00:00.000Z" });
  let releaseRefresh: ((response: Response) => void) | undefined;
  const refreshResponse = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
  const manager = createCodexCredentialManager({
    store: active.store,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    fetchImpl: async () => refreshResponse,
  });

  const pending = manager.getValidCredentials();
  await new Promise<void>((resolve) => setImmediate(resolve));
  manager.invalidate();
  await active.store.save({ ...fixtureCredentials, accessToken: "replacement-access", refreshToken: "replacement-refresh", expiresAt: "2099-01-01T00:00:00.000Z" });
  releaseRefresh!(Response.json({ access_token: "stale-access", refresh_token: "stale-refresh", expires_in: 3600 }));

  await assert.rejects(pending, /credentials changed during refresh/);
  assert.equal(active.current()?.accessToken, "replacement-access");
});

test("explicit login deliberately replaces both valid and expired native credentials", async () => {
  for (const expiresAt of ["2099-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"]) {
    const native = memoryStore("macOS Keychain", { ...fixtureCredentials, expiresAt });
    const auth = createChatGPTAuthService({
      nativeCredentialStore: native.store,
      legacyCredentialStore: memoryStore("secure file fallback").store,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      sleep: async () => undefined,
      openBrowser: () => true,
      write: () => undefined,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/usercode")) return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device", interval: 1 });
        if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
        return Response.json({ access_token: "replacement-access", refresh_token: "replacement-refresh", expires_in: 3600 });
      },
    });
    await auth.login();
    assert.equal((await auth.status()).authenticated, true);
    assert.equal(native.current()?.accessToken, "replacement-access");
  }
});

test("failed explicit login preserves prior state and secure-store failure cannot report success", async () => {
  const original = { ...fixtureCredentials, expiresAt: "2020-01-01T00:00:00.000Z" };
  const failingNative = memoryStore("macOS Keychain", original, { failSave: true });
  const auth = createChatGPTAuthService({
    nativeCredentialStore: failingNative.store,
    legacyCredentialStore: memoryStore("secure file fallback").store,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    sleep: async () => undefined,
    openBrowser: () => true,
    write: () => undefined,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/usercode")) return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device", interval: 1 });
      if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      return Response.json({ access_token: "replacement-access", refresh_token: "replacement-refresh", expires_in: 3600 });
    },
  });

  await assert.rejects(auth.login(), /Unable to replace Dragons ChatGPT credentials in secure storage/);
  assert.deepEqual(failingNative.current(), original);
  assert.equal((await auth.status()).authenticated, true);
});
