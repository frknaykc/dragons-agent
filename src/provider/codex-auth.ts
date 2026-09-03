import { spawn } from "node:child_process";
import {
  createLegacyCodexCredentialStore,
  createLoginReplacementCodexCredentialStore,
  createNativeCodexCredentialStore,
  createPreferredCodexCredentialStore,
  type CodexCredentialStore,
  type CodexCredentials,
} from "./credential-store.js";
import { joinPlatformPath } from "../platform-path.js";

export {
  createLegacyCodexCredentialStore as createCodexCredentialStore,
  createMigratingCodexCredentialStore,
  createNativeCodexCredentialStore,
  createPreferredCodexCredentialStore,
  DRAGONS_CHATGPT_CREDENTIAL_ACCOUNT,
  DRAGONS_CREDENTIAL_SERVICE,
} from "./credential-store.js";
export type { CodexCredentialStore, CodexCredentials, NativeCredentialEntry } from "./credential-store.js";

// Public OAuth client identifier used by the current Hermes/Codex device flow.
// It is not a secret; this experimental provider depends on its current compatibility.
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const REFRESH_SKEW_MILLISECONDS = 120_000;


export type DragonsCredentialPathOptions = {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  xdgConfigHome?: string;
  appData?: string;
};

export function getDragonsChatGPTCredentialPath(options: DragonsCredentialPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE;
  if (!homeDirectory) throw new Error("Unable to determine a home directory for Dragons credentials.");
  if (platform === "darwin") return joinPlatformPath(platform, homeDirectory, "Library", "Application Support", "Dragons Agent", "auth.json");
  if (platform === "win32") return joinPlatformPath(platform, options.appData ?? process.env.APPDATA ?? homeDirectory, "Dragons Agent", "auth.json");
  return joinPlatformPath(platform, options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? joinPlatformPath(platform, homeDirectory, ".config"), "dragons-agent", "auth.json");
}

function extractAccountId(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function requireString(payload: Record<string, unknown>, field: string, context: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${context} did not include ${field}.`);
  }
  return value;
}

async function parseJson(response: Response, context: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${context} returned HTTP ${response.status}.`);
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} returned an invalid response.`);
  }
  return payload as Record<string, unknown>;
}

function credentialsFromTokenPayload(
  payload: Record<string, unknown>,
  now: () => Date,
  fallbackRefreshToken?: string,
  fallbackAccountId?: string,
  fallbackTokenType = "Bearer",
): CodexCredentials {
  const accessToken = requireString(payload, "access_token", "Codex OAuth response");
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
    ? payload.refresh_token
    : fallbackRefreshToken;
  if (!refreshToken) throw new Error("Codex OAuth response did not include refresh_token.");
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? Math.max(1, payload.expires_in)
    : 3600;
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now().getTime() + expiresIn * 1_000).toISOString(),
    accountId: extractAccountId(accessToken) ?? fallbackAccountId,
    tokenType: typeof payload.token_type === "string" && payload.token_type ? payload.token_type : fallbackTokenType,
  };
}


export type CodexOAuthClientOptions = {
  store: CodexCredentialStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => boolean;
  write?: (text: string) => void;
};

function defaultOpenBrowser(url: string): boolean {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function createCodexOAuthClient(options: CodexOAuthClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  return {
    async login(): Promise<CodexCredentials> {
      let deviceResponse: Response;
      try {
        deviceResponse = await fetchImpl(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
        });
      } catch {
        throw new Error("Unable to start ChatGPT Subscription login.");
      }
      const device = await parseJson(deviceResponse, "Codex device authorization");
      const userCode = requireString(device, "user_code", "Codex device authorization");
      const deviceAuthId = requireString(device, "device_auth_id", "Codex device authorization");
      const interval = typeof device.interval === "number" && Number.isFinite(device.interval)
        ? Math.max(3, device.interval)
        : 5;

      write("ChatGPT Subscription (Experimental)\n\n");
      write(`Open this page:\n${CODEX_DEVICE_AUTH_URL}\n\n`);
      write(`Code:\n${userCode}\n\n`);
      openBrowser(CODEX_DEVICE_AUTH_URL);
      write("Waiting for authentication...\n");

      const deadline = now().getTime() + 15 * 60 * 1_000;
      while (now().getTime() < deadline) {
        await sleep(interval * 1_000);
        let response: Response;
        try {
          response = await fetchImpl(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
          });
        } catch {
          throw new Error("Unable to continue ChatGPT Subscription login.");
        }
        if (response.status === 403 || response.status === 404) continue;
        const authorization = await parseJson(response, "Codex device authorization polling");
        const authorizationCode = requireString(authorization, "authorization_code", "Codex device authorization polling");
        const codeVerifier = requireString(authorization, "code_verifier", "Codex device authorization polling");
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: `${CODEX_AUTH_BASE_URL}/deviceauth/callback`,
          client_id: CODEX_OAUTH_CLIENT_ID,
          code_verifier: codeVerifier,
        }).toString();
        let tokenResponse: Response;
        try {
          tokenResponse = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          });
        } catch {
          throw new Error("Unable to complete ChatGPT Subscription login.");
        }
        const credentials = credentialsFromTokenPayload(
          await parseJson(tokenResponse, "Codex token exchange"),
          now,
        );
        await options.store.save(credentials);
        write("✓ Signed in\n");
        return credentials;
      }
      throw new Error("ChatGPT Subscription login timed out after 15 minutes.");
    },
  };
}

export type CodexCredentialManagerOptions = {
  store: CodexCredentialStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export function createCodexCredentialManager(options: CodexCredentialManagerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  let refreshInFlight: Promise<CodexCredentials> | undefined;
  let generation = 0;

  async function refresh(credentials: CodexCredentials, expectedGeneration: number): Promise<CodexCredentials> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }).toString();
    let response: Response;
    try {
      response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new Error("Unable to refresh ChatGPT Subscription credentials.");
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        await options.store.remove();
        throw new Error("ChatGPT Subscription login is required. Run dragons auth login --provider chatgpt.");
      }
      throw new Error(`ChatGPT Subscription credential refresh returned HTTP ${response.status}.`);
    }
    const refreshed = credentialsFromTokenPayload(
      await parseJson(response, "Codex credential refresh"),
      now,
      credentials.refreshToken,
      credentials.accountId,
      credentials.tokenType,
    );
    if (generation !== expectedGeneration) {
      throw new Error("ChatGPT Subscription credentials changed during refresh. Retry the request.");
    }
    try {
      await options.store.save(refreshed);
    } catch {
      throw new Error("Unable to save refreshed ChatGPT Subscription credentials to secure storage. Run dragons auth login --provider chatgpt.");
    }
    return refreshed;
  }

  return {
    async getValidCredentials(): Promise<CodexCredentials> {
      const credentials = await options.store.load();
      if (!credentials) {
        throw new Error("ChatGPT Subscription login is required. Run dragons auth login --provider chatgpt.");
      }
      const expiresAt = Date.parse(credentials.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt - now().getTime() > REFRESH_SKEW_MILLISECONDS) {
        return credentials;
      }
      if (!refreshInFlight) {
        const expectedGeneration = generation;
        refreshInFlight = refresh(credentials, expectedGeneration).finally(() => {
          refreshInFlight = undefined;
        });
      }
      return refreshInFlight;
    },
    invalidate(): void { generation += 1; },
  };
}

export type ChatGPTAuthService = {
  credentials: { getValidCredentials(): Promise<CodexCredentials> };
  login(): Promise<void>;
  status(): Promise<{ authenticated: boolean; expiresAt?: string; storage?: string }>;
  logout(): Promise<void>;
};

export type ChatGPTAuthServiceOptions = {
  /** Test-only injected active store. Production uses native storage plus a legacy migration boundary. */
  credentialStore?: CodexCredentialStore;
  /** Test-only injected native store; never use a real OS keychain in deterministic tests. */
  nativeCredentialStore?: CodexCredentialStore;
  /** Test-only injected legacy file store. */
  legacyCredentialStore?: CodexCredentialStore;
  /** Legacy Dragons-owned path used only for one-time migration/fallback. */
  credentialPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => boolean;
  write?: (text: string) => void;
};

export function createChatGPTAuthService(options: ChatGPTAuthServiceOptions = {}): ChatGPTAuthService {
  const legacy = options.legacyCredentialStore
    ?? createLegacyCodexCredentialStore(options.credentialPath ?? getDragonsChatGPTCredentialPath());
  const native = options.nativeCredentialStore ?? createNativeCodexCredentialStore();
  const store = options.credentialStore ?? createPreferredCodexCredentialStore(native, legacy);
  const loginStore = options.credentialStore ?? createLoginReplacementCodexCredentialStore(native, legacy);
  const oauth = createCodexOAuthClient({ ...options, store: loginStore });
  const credentials = createCodexCredentialManager({ store, fetchImpl: options.fetchImpl, now: options.now });
  return {
    credentials,
    async login(): Promise<void> {
      credentials.invalidate();
      await oauth.login();
    },
    async status(): Promise<{ authenticated: boolean; expiresAt?: string; storage?: string }> {
      const saved = await store.load();
      const storage = await store.storageDescription();
      return saved ? { authenticated: true, expiresAt: saved.expiresAt, storage } : { authenticated: false, storage };
    },
    async logout(): Promise<void> {
      await store.remove();
    },
  };
}
