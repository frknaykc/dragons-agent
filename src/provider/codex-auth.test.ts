import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_DEVICE_AUTH_URL,
  CODEX_OAUTH_TOKEN_URL,
  createCodexCredentialStore,
  createCodexCredentialManager,
  createCodexOAuthClient,
  getDragonsChatGPTCredentialPath,
} from "./codex-auth.js";

function jwtWithAccountId(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

test("device login persists Dragons-owned credentials without printing secret values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-codex-auth-"));
  const credentialFile = join(directory, "auth.json");
  const accessToken = jwtWithAccountId("acct_test");
  const refreshToken = "refresh-test-token";
  const writes: string[] = [];
  const requests: Array<{ url: string; body?: string }> = [];
  let pollCount = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === "string" ? init.body : undefined });

    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device-auth", interval: 1 });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      pollCount += 1;
      return pollCount === 1
        ? new Response("", { status: 404 })
        : Response.json({ authorization_code: "authorization-code", code_verifier: "pkce-verifier" });
    }
    if (url === CODEX_OAUTH_TOKEN_URL) {
      return Response.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const store = createCodexCredentialStore(credentialFile);
  const client = createCodexOAuthClient({
    store,
    fetchImpl,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    sleep: async () => undefined,
    openBrowser: () => true,
    write: (text) => writes.push(text),
  });

  const credentials = await client.login();

  assert.equal(credentials.accountId, "acct_test");
  assert.equal(credentials.expiresAt, "2026-09-03T01:00:00.000Z");
  assert.equal((await store.load())?.refreshToken, refreshToken);
  assert.equal(requests[0]?.url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.equal(requests[1]?.url, "https://auth.openai.com/api/accounts/deviceauth/token");
  assert.equal(requests[2]?.url, "https://auth.openai.com/api/accounts/deviceauth/token");
  assert.equal(requests[3]?.url, CODEX_OAUTH_TOKEN_URL);
  assert.match(requests[3]?.body ?? "", /grant_type=authorization_code/);
  assert.match(requests[3]?.body ?? "", /code_verifier=pkce-verifier/);
  assert.equal(writes.join(""), [
    "ChatGPT Subscription (Experimental)\n\n",
    `Open this page:\n${CODEX_DEVICE_AUTH_URL}\n\n`,
    "Code:\nABCD-EFGH\n\n",
    "Waiting for authentication...\n",
    "✓ Signed in\n",
  ].join(""));
  assert.equal(writes.join("").includes(accessToken), false);
  assert.equal(writes.join("").includes(refreshToken), false);
  if (process.platform !== "win32") assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
  assert.match(await readFile(credentialFile, "utf8"), /"version": 1/);
});

test("expired credentials refresh once and atomically persist the rotated token set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-codex-refresh-"));
  const store = createCodexCredentialStore(join(directory, "auth.json"));
  await store.save({
    accessToken: jwtWithAccountId("acct_test"),
    refreshToken: "old-refresh-token",
    expiresAt: "2026-09-03T00:01:00.000Z",
    accountId: "acct_test",
    tokenType: "Bearer",
  });
  let refreshRequests = 0;
  const manager = createCodexCredentialManager({
    store,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), CODEX_OAUTH_TOKEN_URL);
      assert.match(String(init?.body), /grant_type=refresh_token/);
      refreshRequests += 1;
      return Response.json({
        access_token: jwtWithAccountId("acct_test"),
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      });
    },
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  const [first, second] = await Promise.all([manager.getValidCredentials(), manager.getValidCredentials()]);

  assert.equal(refreshRequests, 1);
  assert.equal(first.refreshToken, "rotated-refresh-token");
  assert.equal(second.refreshToken, "rotated-refresh-token");
  assert.equal((await store.load())?.refreshToken, "rotated-refresh-token");
});

test("terminal refresh failures remove Dragons credentials without leaking token material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-codex-invalid-refresh-"));
  const store = createCodexCredentialStore(join(directory, "auth.json"));
  await store.save({
    accessToken: jwtWithAccountId("acct_test"),
    refreshToken: "revoked-refresh-token",
    expiresAt: "2026-09-03T00:01:00.000Z",
    accountId: "acct_test",
    tokenType: "Bearer",
  });
  const manager = createCodexCredentialManager({
    store,
    fetchImpl: async () => new Response("revoked-refresh-token", { status: 400 }),
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  await assert.rejects(manager.getValidCredentials(), /ChatGPT Subscription login is required/);
  assert.equal(await store.load(), undefined);
});

test("Dragons uses its own per-user ChatGPT credential location", () => {
  assert.equal(
    getDragonsChatGPTCredentialPath({ platform: "darwin", homeDirectory: "/Users/dragon" }),
    "/Users/dragon/Library/Application Support/Dragons Agent/auth.json",
  );
  assert.equal(
    getDragonsChatGPTCredentialPath({ platform: "linux", homeDirectory: "/home/dragon", xdgConfigHome: "/home/dragon/.config" }),
    "/home/dragon/.config/dragons-agent/auth.json",
  );
});

test("device authorization network failures do not expose credential-like error text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-codex-network-"));
  const store = createCodexCredentialStore(join(directory, "auth.json"));
  const client = createCodexOAuthClient({
    store,
    fetchImpl: async () => { throw new Error("access-token-from-network-error"); },
    write: () => undefined,
  });

  await assert.rejects(client.login(), (error: unknown) => {
    assert.match(error instanceof Error ? error.message : "", /Unable to start ChatGPT Subscription login/);
    assert.doesNotMatch(error instanceof Error ? error.message : "", /access-token-from-network-error/);
    return true;
  });
  assert.equal(await store.load(), undefined);
});
