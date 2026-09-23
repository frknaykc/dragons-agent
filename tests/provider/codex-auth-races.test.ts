import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createChatGPTAuthService, createCodexCredentialManager, CODEX_OAUTH_TOKEN_URL } from "../../dist/provider/codex-auth.js";
import { createMigratingCodexCredentialStore, type CodexCredentialStore, type CodexCredentials } from "../../dist/provider/credential-store.js";

const fixture: CodexCredentials = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: "2099-01-01T00:00:00Z", tokenType: "Bearer" };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function memory(initial?: CodexCredentials): CodexCredentialStore {
  let value = initial;
  return { load: async () => value, save: async (next) => { value = next; }, remove: async () => { value = undefined; }, storageDescription: async () => "fixture" };
}

for (const reader of ["direct", "credentials", "status"] as const) {
  test(`logout waits for actual migrating ${reader} load's pending native save`, async () => {
    const native = memory();
    const legacy = memory(fixture);
    const entered = gate();
    const saving = gate();
    const save = native.save;
    native.save = async (credentials) => { entered.release(); await saving.promise; await save(credentials); };
    const store = createMigratingCodexCredentialStore(native, legacy);
    const service = createChatGPTAuthService({ credentialStore: store });
    const pending = reader === "direct" ? store.load() : reader === "status" ? service.status() : service.credentials.getValidCredentials();
    const outcome = Promise.allSettled([pending]);
    await entered.promise;
    let removed = false;
    const logout = (reader === "direct" ? store.remove() : service.logout()).then(() => { removed = true; });
    await setImmediate();
    const removedBeforeSave = removed;
    saving.release();
    await logout;
    await outcome;
    assert.equal(removedBeforeSave, false, "logout must serialize after migration side effects");
    assert.equal(await native.load(), undefined);
    assert.equal(await legacy.load(), undefined);
    assert.equal((await service.status()).authenticated, false);
  });
}

test("a token exchange completing after logout cannot commit an earlier login", async () => {
  const store = memory();
  const entered = gate();
  const token = gate();
  const service = createChatGPTAuthService({
    credentialStore: store, sleep: async () => {}, openBrowser: () => false, write: () => {},
    fetchImpl: async (input) => {
      if (String(input).endsWith("/usercode")) return Response.json({ user_code: "fixture", device_auth_id: "fixture" });
      if (String(input) !== CODEX_OAUTH_TOKEN_URL) return Response.json({ authorization_code: "fixture", code_verifier: "fixture" });
      entered.release(); await token.promise;
      return Response.json({ access_token: fixture.accessToken, refresh_token: fixture.refreshToken });
    },
  });
  const pending = service.login();
  const outcome = Promise.allSettled([pending]);
  await entered.promise;
  await service.logout();
  token.release();
  assert.equal((await outcome)[0].status, "rejected");
  assert.equal(await store.load(), undefined);
  assert.equal((await service.status()).authenticated, false);
});

function loginFetch(): typeof fetch {
  return async (input) => {
    if (String(input).endsWith("/usercode")) return Response.json({ user_code: "fixture", device_auth_id: "fixture" });
    if (String(input) !== CODEX_OAUTH_TOKEN_URL) return Response.json({ authorization_code: "fixture", code_verifier: "fixture" });
    return Response.json({ access_token: fixture.accessToken, refresh_token: fixture.refreshToken });
  };
}

test("logout waits for an already-started native login replacement save", async () => {
  const native = memory();
  const legacy = memory();
  const entered = gate();
  const saving = gate();
  const save = native.save;
  native.save = async (credentials) => { entered.release(); await saving.promise; await save(credentials); };
  const service = createChatGPTAuthService({ nativeCredentialStore: native, legacyCredentialStore: legacy, fetchImpl: loginFetch(), sleep: async () => {}, openBrowser: () => false, write: () => {} });
  const login = Promise.allSettled([service.login()]);
  await entered.promise;
  let removed = false;
  const logout = service.logout().then(() => { removed = true; });
  await setImmediate();
  const removedBeforeSave = removed;
  saving.release();
  await logout;
  assert.equal((await login)[0].status, "rejected");
  assert.equal(removedBeforeSave, false);
  assert.equal(await native.load(), undefined);
  assert.equal(await legacy.load(), undefined);
  assert.equal((await service.status()).authenticated, false);
});

test("service cancellation prevents a login commit queued behind a status read", async () => {
  const store = memory();
  const entered = gate();
  const reading = gate();
  const load = store.load;
  store.load = async () => { entered.release(); await reading.promise; return load(); };
  const controller = new AbortController();
  const service = createChatGPTAuthService({ credentialStore: store, fetchImpl: loginFetch(), sleep: async () => {}, openBrowser: () => false, write: () => {} });
  const status = Promise.allSettled([service.status()]);
  await entered.promise;
  const login = service.login({ signal: controller.signal });
  const rejected = assert.rejects(login, { name: "AbortError" });
  await setImmediate();
  controller.abort();
  reading.release();
  await rejected;
  await status;
  assert.equal(await store.load(), undefined);
});

test("failed migration releases both queues so logout can remove the retained credential", async () => {
  const native = memory();
  const legacy = memory(fixture);
  native.save = async () => { throw new Error("synthetic storage failure"); };
  const service = createChatGPTAuthService({ credentialStore: createMigratingCodexCredentialStore(native, legacy) });
  await assert.rejects(service.status(), /Unable to migrate/);
  await service.logout();
  assert.equal(await legacy.load(), undefined);
  assert.equal((await service.status()).authenticated, false);
});

for (const stage of ["usercode", "poll", "exchange", "refresh"] as const) {
  for (const status of [307, 308]) {
    test(`${stage} rejects HTTP ${status} redirects without forwarding OAuth POST bodies`, async () => {
      const store = memory(stage === "refresh" ? { ...fixture, expiresAt: "2000-01-01T00:00:00Z" } : undefined);
      let forwarded = 0;
      let intercepted = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const current = String(input).endsWith("/usercode") ? "usercode" : String(input) !== CODEX_OAUTH_TOKEN_URL ? "poll" : stage === "refresh" ? "refresh" : "exchange";
        if (current === stage) {
          intercepted++;
          // Model fetch's 307/308 body-preserving redirect policy, without a network.
          if (init?.redirect !== "error") forwarded++;
          if (init?.redirect === "error") throw new TypeError("redirect rejected");
          return new Response(null, { status, headers: { Location: "https://untrusted.invalid/collect" } });
        }
        if (current === "usercode") return Response.json({ user_code: "fixture", device_auth_id: "fixture" });
        return Response.json({ authorization_code: "fixture", code_verifier: "fixture" });
      };
      if (stage === "refresh") {
        await assert.rejects(createCodexCredentialManager({ store, fetchImpl }).getValidCredentials(), /Unable to refresh/);
      } else {
        const service = createChatGPTAuthService({ credentialStore: store, fetchImpl, sleep: async () => {}, openBrowser: () => false, write: () => {} });
        await assert.rejects(service.login());
        assert.equal(await store.load(), undefined);
      }
      assert.equal(intercepted, 1);
      assert.equal(forwarded, 0);
    });
  }
}
