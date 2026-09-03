import { AsyncEntry } from "@napi-rs/keyring";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const DRAGONS_CREDENTIAL_SERVICE = "Dragons Agent";
export const DRAGONS_CHATGPT_CREDENTIAL_ACCOUNT = "chatgpt-subscription";

export type CodexCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  accountId?: string;
  tokenType: string;
};

type StoredCredentials = {
  version: 1;
  chatgpt: CodexCredentials;
};

export type CodexCredentialStore = {
  load(): Promise<CodexCredentials | undefined>;
  save(credentials: CodexCredentials): Promise<void>;
  remove(): Promise<void>;
  /** Deliberately non-secret storage label for status output. */
  storageDescription(): Promise<string>;
};

export type NativeCredentialEntry = {
  getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deletePassword(signal?: AbortSignal | null): Promise<boolean>;
};

export class NativeCredentialStoreUnavailableError extends Error {
  constructor() {
    super("Native credential storage is unavailable.");
    this.name = "NativeCredentialStoreUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCredentials(value: unknown): value is CodexCredentials {
  if (!isRecord(value)) return false;
  return typeof value.accessToken === "string" && Boolean(value.accessToken)
    && typeof value.refreshToken === "string" && Boolean(value.refreshToken)
    && typeof value.expiresAt === "string" && Boolean(value.expiresAt)
    && typeof value.tokenType === "string" && Boolean(value.tokenType)
    && (value.accountId === undefined || typeof value.accountId === "string");
}

function parseStoredCredentials(payload: string, context: string): CodexCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error(`${context} is corrupted.`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isCredentials(parsed.chatgpt)) {
    throw new Error(`${context} is invalid.`);
  }
  return structuredClone(parsed.chatgpt);
}

function serializeCredentials(credentials: CodexCredentials, pretty = false): string {
  if (!isCredentials(credentials)) throw new Error("Refusing to store invalid ChatGPT Subscription credentials.");
  return JSON.stringify({ version: 1, chatgpt: credentials satisfies CodexCredentials }, null, pretty ? 2 : undefined);
}

function nativeStorageDescription(platform = process.platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  if (platform === "linux") return "Linux Secret Service";
  return "native secure credential store";
}

/** Native OS credential store for the single Dragons-owned ChatGPT credential payload. */
export function createNativeCodexCredentialStore(options: {
  entry?: NativeCredentialEntry;
  platform?: NodeJS.Platform;
} = {}): CodexCredentialStore {
  const entry = options.entry ?? new AsyncEntry(DRAGONS_CREDENTIAL_SERVICE, DRAGONS_CHATGPT_CREDENTIAL_ACCOUNT);
  const storage = nativeStorageDescription(options.platform);
  return {
    async load(): Promise<CodexCredentials | undefined> {
      let payload: string | undefined;
      try {
        payload = await entry.getPassword();
      } catch {
        throw new NativeCredentialStoreUnavailableError();
      }
      return payload === undefined ? undefined : parseStoredCredentials(payload, "Native Dragons ChatGPT credential");
    },
    async save(credentials: CodexCredentials): Promise<void> {
      try {
        await entry.setPassword(serializeCredentials(credentials));
      } catch {
        throw new Error("Native credential storage could not save ChatGPT Subscription credentials.");
      }
    },
    async remove(): Promise<void> {
      try {
        await entry.deletePassword();
      } catch {
        throw new Error("Native credential storage could not remove ChatGPT Subscription credentials.");
      }
    },
    async storageDescription(): Promise<string> { return storage; },
  };
}

/** Restricted legacy store retained solely to migrate Dragons-owned pre-M35 credentials. */
export function createLegacyCodexCredentialStore(filePath: string): CodexCredentialStore {
  return {
    async load(): Promise<CodexCredentials | undefined> {
      let payload: string;
      try {
        payload = await readFile(filePath, "utf8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Unable to read legacy Dragons ChatGPT credentials.");
      }
      return parseStoredCredentials(payload, "Legacy Dragons ChatGPT credential");
    },
    async save(credentials: CodexCredentials): Promise<void> {
      const directory = dirname(filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${serializeCredentials(credentials, true)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
        await chmod(filePath, 0o600);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
    async remove(): Promise<void> { await rm(filePath, { force: true }); },
    async storageDescription(): Promise<string> { return "secure file fallback"; },
  };
}

function sameCredentials(left: CodexCredentials, right: CodexCredentials): boolean {
  return left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.expiresAt === right.expiresAt
    && left.accountId === right.accountId
    && left.tokenType === right.tokenType;
}

/**
 * Native credentials always win. A legacy file is deleted only after a native
 * write/read round trip has verified the exact Dragons-owned payload.
 */
export function createMigratingCodexCredentialStore(
  native: CodexCredentialStore,
  legacy: CodexCredentialStore,
): CodexCredentialStore {
  return {
    async load(): Promise<CodexCredentials | undefined> {
      const stored = await native.load();
      if (stored) {
        await legacy.remove();
        return stored;
      }
      const existing = await legacy.load();
      if (!existing) return undefined;
      try {
        await native.save(existing);
        const verified = await native.load();
        if (!verified || !sameCredentials(existing, verified)) {
          throw new Error("Native credential verification failed.");
        }
        await legacy.remove();
        return verified;
      } catch {
        // The legacy credential remains intact for recovery; no payload details escape.
        throw new Error("Unable to migrate Dragons ChatGPT credentials to native secure storage.");
      }
    },
    async save(credentials: CodexCredentials): Promise<void> {
      try {
        await native.save(credentials);
        await legacy.remove();
      } catch {
        throw new Error("Unable to save Dragons ChatGPT credentials to secure storage.");
      }
    },
    async remove(): Promise<void> {
      let nativeError: unknown;
      try { await native.remove(); } catch (error: unknown) { nativeError = error; }
      try { await legacy.remove(); } catch (error: unknown) { nativeError ??= error; }
      if (nativeError) throw new Error("Unable to remove Dragons ChatGPT credentials from secure storage.");
    },
    async storageDescription(): Promise<string> { return native.storageDescription(); },
  };
}

/**
 * Explicit login writes a fresh OAuth result without first loading an older
 * payload. An invalid prior payload remains until native write/read
 * replacement succeeds, after which legacy state is removed.
 */
export function createLoginReplacementCodexCredentialStore(
  native: CodexCredentialStore,
  legacy: CodexCredentialStore,
): CodexCredentialStore {
  return {
    async load(): Promise<CodexCredentials | undefined> { return native.load(); },
    async save(credentials: CodexCredentials): Promise<void> {
      try {
        await native.save(credentials);
        const verified = await native.load();
        if (!verified || !sameCredentials(credentials, verified)) throw new Error("Native credential verification failed.");
        await legacy.remove();
      } catch (error: unknown) {
        if (!(error instanceof NativeCredentialStoreUnavailableError)) {
          throw new Error("Unable to replace Dragons ChatGPT credentials in secure storage.");
        }
        await legacy.save(credentials);
        const verified = await legacy.load();
        if (!verified || !sameCredentials(credentials, verified)) {
          throw new Error("Unable to replace Dragons ChatGPT credentials in secure storage.");
        }
      }
    },
    async remove(): Promise<void> { await legacy.remove(); },
    async storageDescription(): Promise<string> { return native.storageDescription(); },
  };
}

/**
 * A native store is probed before it is selected. Only an unavailable native
 * backend selects the visibly-labelled existing restrictive file fallback;
 * later write failures never downgrade or hide inconsistent refresh state.
 */
export function createPreferredCodexCredentialStore(
  native: CodexCredentialStore,
  legacy: CodexCredentialStore,
): CodexCredentialStore {
  let selected: CodexCredentialStore | undefined;
  let selecting: Promise<CodexCredentialStore> | undefined;
  const select = async (): Promise<CodexCredentialStore> => {
    if (selected) return selected;
    if (!selecting) {
      const attempt = native.load()
        .then(() => createMigratingCodexCredentialStore(native, legacy))
        .catch((error: unknown) => {
          if (!(error instanceof NativeCredentialStoreUnavailableError)) throw error;
          return {
          load: () => legacy.load(),
          save: (credentials: CodexCredentials) => legacy.save(credentials),
          remove: () => legacy.remove(),
          async storageDescription(): Promise<string> {
            return "secure file fallback (native credential storage unavailable)";
          },
          } satisfies CodexCredentialStore;
        })
      selecting = attempt.then((store) => {
        selected = store;
        return store;
      }, (error: unknown) => {
        selecting = undefined;
        throw error;
      });
    }
    return selecting;
  };
  return {
    async load(): Promise<CodexCredentials | undefined> { return (await select()).load(); },
    async save(credentials: CodexCredentials): Promise<void> { await (await select()).save(credentials); },
    async remove(): Promise<void> { await (await select()).remove(); },
    async storageDescription(): Promise<string> { return (await select()).storageDescription(); },
  };
}
