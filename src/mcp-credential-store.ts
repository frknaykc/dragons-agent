import { createHash } from "node:crypto";

import { AsyncEntry } from "@napi-rs/keyring";

export const DRAGONS_MCP_CREDENTIAL_SERVICE = "Dragons Agent";

export type McpCredentialScope = {
  serverId: string;
  origin: string;
  credentialId: string;
};

export type McpBearerTokenStore = {
  load(scope: McpCredentialScope): Promise<string | undefined>;
  save(scope: McpCredentialScope, token: string): Promise<void>;
  remove(scope: McpCredentialScope): Promise<void>;
  /** Deliberately non-secret storage label for status output. */
  storageDescription(): Promise<string>;
};

export type NativeMcpCredentialEntry = {
  getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deletePassword(signal?: AbortSignal | null): Promise<boolean>;
};

type StoredMcpBearerToken = {
  version: 1;
  scope: McpCredentialScope;
  token: string;
};

const SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const CREDENTIAL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const MAX_BEARER_TOKEN_BYTES = 8_192;

function nativeStorageDescription(platform = process.platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  if (platform === "linux") return "Linux Secret Service";
  return "native secure credential store";
}

function normalizedScope(value: McpCredentialScope): McpCredentialScope {
  if (!SERVER_ID_PATTERN.test(value.serverId) || !CREDENTIAL_ID_PATTERN.test(value.credentialId)) {
    throw new Error("MCP credential scope is invalid.");
  }
  let origin: URL;
  try { origin = new URL(value.origin); }
  catch { throw new Error("MCP credential scope is invalid."); }
  if (origin.protocol !== "http:" && origin.protocol !== "https:" || origin.origin !== value.origin) {
    throw new Error("MCP credential scope is invalid.");
  }
  return { serverId: value.serverId, origin: value.origin, credentialId: value.credentialId };
}

function sameScope(left: McpCredentialScope, right: McpCredentialScope): boolean {
  return left.serverId === right.serverId && left.origin === right.origin && left.credentialId === right.credentialId;
}

function accountFor(scope: McpCredentialScope): string {
  return `mcp-bearer-${createHash("sha256").update(JSON.stringify(scope), "utf8").digest("hex")}`;
}

function parseStoredToken(payload: string, scope: McpCredentialScope): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(payload) as unknown; }
  catch { throw new Error("Native MCP credential is corrupted."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Native MCP credential is invalid.");
  const record = parsed as Partial<StoredMcpBearerToken>;
  if (record.version !== 1 || !record.scope || typeof record.token !== "string" || !record.token
    || Buffer.byteLength(record.token, "utf8") > MAX_BEARER_TOKEN_BYTES) {
    throw new Error("Native MCP credential is invalid.");
  }
  let storedScope: McpCredentialScope;
  try { storedScope = normalizedScope(record.scope); }
  catch { throw new Error("Native MCP credential is invalid."); }
  return sameScope(storedScope, scope) ? record.token : undefined;
}

/**
 * Native-only storage for bearer tokens. Unlike legacy provider credentials,
 * this deliberately has no plaintext-file fallback: remote MCP tokens must not
 * be introduced into configuration or a new fallback file.
 */
export function createNativeMcpBearerTokenStore(options: {
  entry?: NativeMcpCredentialEntry;
  platform?: NodeJS.Platform;
} = {}): McpBearerTokenStore {
  const storage = nativeStorageDescription(options.platform);
  const entryFor = (scope: McpCredentialScope): NativeMcpCredentialEntry => options.entry
    ?? new AsyncEntry(DRAGONS_MCP_CREDENTIAL_SERVICE, accountFor(scope));
  return {
    async load(input): Promise<string | undefined> {
      const scope = normalizedScope(input);
      let payload: string | undefined;
      try { payload = await entryFor(scope).getPassword(); }
      catch { throw new Error("Native MCP credential storage is unavailable."); }
      return payload === undefined ? undefined : parseStoredToken(payload, scope);
    },
    async save(input, token): Promise<void> {
      const scope = normalizedScope(input);
      if (typeof token !== "string" || !token || Buffer.byteLength(token, "utf8") > MAX_BEARER_TOKEN_BYTES) {
        throw new Error("MCP bearer token is invalid.");
      }
      const payload = JSON.stringify({ version: 1, scope, token } satisfies StoredMcpBearerToken);
      try {
        const entry = entryFor(scope);
        await entry.setPassword(payload);
        if (await entry.getPassword() !== payload) throw new Error("verification failed");
      } catch {
        throw new Error("Native MCP credential storage could not save the bearer token.");
      }
    },
    async remove(input): Promise<void> {
      const scope = normalizedScope(input);
      try { await entryFor(scope).deletePassword(); }
      catch { throw new Error("Native MCP credential storage could not remove the bearer token."); }
    },
    async storageDescription(): Promise<string> { return storage; },
  };
}
