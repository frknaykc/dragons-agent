import { AsyncEntry } from "@napi-rs/keyring";
import { isSafeProfileName } from "../profiles.js";
import { DRAGONS_CREDENTIAL_SERVICE, type NativeCredentialEntry } from "./credential-store.js";

export const API_KEY_PROVIDERS = ["openai-api", "anthropic", "gemini", "openrouter"] as const;
export type ApiKeyProvider = typeof API_KEY_PROVIDERS[number];
export function isApiKeyProvider(value: string | undefined): value is ApiKeyProvider {
  return API_KEY_PROVIDERS.includes(value as ApiKeyProvider);
}
export type ApiKeyStore = {
  load(): Promise<string | undefined>;
  save(key: string): Promise<void>;
  remove(): Promise<void>;
  /** Recover only an OS-stored, previously verified named slot; never a raw orphan write. */
  recover?(): Promise<string | undefined>;
  /** Mark a failed named-slot write unrecoverable, without a plaintext fallback. */
  quarantine?(): Promise<void>;
};
// Documented product bound per profile/provider, including unverified slots.
export const MAX_API_KEY_SLOTS = 8;
export function isApiKeySlot(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}
export function apiKeyAccount(profile: string, provider: ApiKeyProvider, slot?: string): string {
  if (slot !== undefined) {
    if (!isApiKeySlot(slot)) throw new Error("Invalid API-key slot.");
    // Components cannot contain ':', and the prefix cannot alias the legacy singleton.
    apiKeyAccount(profile, provider);
    return `api-key-slot:${profile}:${provider}:${slot}`;
  }
  if (!isSafeProfileName(profile) || !isApiKeyProvider(provider)) throw new Error("Invalid credential namespace.");
  return `api-key:${profile}:${provider}`;
}
function validKey(key: unknown): key is string {
  return typeof key === "string" && /^[\x21-\x7e]{1,8192}$/.test(key);
}
/** OS-only storage: no plaintext file fallback, environment mutation, or error causes. */
export function createApiKeyStore(profile: string, provider: ApiKeyProvider, injected?: NativeCredentialEntry, slot?: string): ApiKeyStore {
  const account = apiKeyAccount(profile, provider, slot);
  let entry: NativeCredentialEntry;
  const native = (): NativeCredentialEntry => entry ??= injected ?? new AsyncEntry(DRAGONS_CREDENTIAL_SERVICE, account);
  const load = async (): Promise<string | undefined> => {
    try {
      const payload = await native().getPassword();
      if (payload == null) return undefined;
      if (slot === undefined) {
        if (!validKey(payload)) throw new Error();
        return payload;
      }
      const record = JSON.parse(payload) as Record<string, unknown>;
      if (record.version !== 1 || record.state !== "ready" || !validKey(record.key)) throw new Error();
      return record.key;
    } catch { throw new Error("Unable to load API key from OS credential storage."); }
  };
  return {
    load,
    ...(slot === undefined ? {} : {
      recover: load,
      async quarantine() {
        try { await native().setPassword(JSON.stringify({ version: 1, state: "unverified" })); }
        catch { throw new Error("Unable to quarantine API-key slot in OS credential storage."); }
      },
    }),
    async save(key) {
      if (!validKey(key)) throw new Error("Invalid API key. Enter a single printable key without whitespace.");
      try {
        const pendingPayload = slot === undefined ? key : JSON.stringify({ version: 1, state: "unverified", key });
        await native().setPassword(pendingPayload);
        if (await native().getPassword() !== pendingPayload) throw new Error();
        if (slot !== undefined) {
          const readyPayload = JSON.stringify({ version: 1, state: "ready", key });
          await native().setPassword(readyPayload);
          if (await native().getPassword() !== readyPayload) throw new Error();
        }
      } catch {
        // Best-effort durable quarantine: a failed verification must not become
        // a recoverable ready record after the process-local inventory is lost.
        if (slot !== undefined) {
          try { await native().setPassword(JSON.stringify({ version: 1, state: "unverified" })); } catch { /* Native backend unavailable; no fallback. */ }
        }
        throw new Error("Unable to save and verify API key in OS credential storage.");
      }
    },
    async remove() {
      try {
        if (slot !== undefined) await native().setPassword(JSON.stringify({ version: 1, state: "unverified" }));
        await native().deletePassword();
        if (await native().getPassword() != null) throw new Error();
      }
      catch { throw new Error("Unable to remove API key from OS credential storage."); }
    },
  };
}
export type SecretPrompt = (signal: AbortSignal) => Promise<string | undefined>;
type StoreFactory = (provider: ApiKeyProvider, slot?: string) => ApiKeyStore;
export type ApiKeySlotMetadata = Readonly<{ slot: string; state: "ready" | "unverified" | "cooldown" }>;
const pools = new Map<string, Map<string, Exclude<ApiKeySlotMetadata["state"], "cooldown">>>();
let tail: Promise<unknown> = Promise.resolve();
type SlotHealth = { cooldownUntil: number };
const health = new Map<string, Map<string, SlotHealth>>();
const MAX_COOLDOWN_MILLISECONDS = 300_000;
const DEFAULT_COOLDOWN_MILLISECONDS = 30_000;
function healthFor(profile: string, provider: ApiKeyProvider) {
  const namespace = apiKeyAccount(profile, provider);
  let entries = health.get(namespace);
  if (!entries) { entries = new Map(); health.set(namespace, entries); }
  return entries;
}
function available(profile: string, provider: ApiKeyProvider, slot: string, now: number): boolean {
  const until = healthFor(profile, provider).get(slot)?.cooldownUntil;
  return until === undefined || until <= now;
}

let pending = 0;
function coordinated<T>(operation: () => Promise<T>): Promise<T> {
  if (pending >= 128) return Promise.reject(new Error("Credential operation limit reached."));
  pending++;
  const result = tail.then(operation);
  tail = result.then(() => {}, () => {}).finally(() => { pending--; });
  return result;
}
function poolFor(profile: string, provider: ApiKeyProvider) {
  const namespace = apiKeyAccount(profile, provider);
  let pool = pools.get(namespace);
  if (!pool) {
    if (pools.size >= 128) throw new Error("Credential namespace limit reached.");
    pool = new Map();
    pools.set(namespace, pool);
  }
  return pool;
}
/** Trusted host only, never a model tool or remote protocol capability.
 * Inventory is PROCESS-LOCAL (128 namespaces, 8 named slots each), not durable.
 * Explicit selection can recover verified OS records; list never probes credentials.
 * Historical raw/unverified orphan records require explicit removal and re-add.
 * No cross-process transactions or automatic OS inventory discovery are provided.
 */
export function createApiKeyAuth(profile: string, store: StoreFactory = (provider, slot) => createApiKeyStore(profile, provider, undefined, slot), options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  apiKeyAccount(profile, "gemini");
  const credentials = (provider: ApiKeyProvider, slot?: string): Promise<string | undefined> => coordinated(async () => {
    apiKeyAccount(profile, provider, slot);
    if (slot !== undefined) {
      const pool = poolFor(profile, provider);
      if (!pool.has(slot)) {
        if (pool.size >= MAX_API_KEY_SLOTS) throw new Error("API-key slot limit reached.");
        try {
          const recovered = await store(provider, slot).recover?.();
          if (!validKey(recovered)) throw new Error();
          pool.set(slot, "ready");
        } catch { throw new Error("Selected API-key slot is unavailable."); }
      }
      if (pool.get(slot) !== "ready" || !available(profile, provider, slot, now())) throw new Error("Selected API-key slot is unavailable.");
    }
    try {
      const key = await store(provider, slot).load();
      if (slot !== undefined && !validKey(key)) throw new Error();
      return key;
    } catch { throw new Error("Unable to resolve selected API-key credentials."); }
  });
  return {
    async add(provider: ApiKeyProvider, slot: string, prompt: SecretPrompt, signal: AbortSignal): Promise<boolean> {
      apiKeyAccount(profile, provider, slot);
      if (!isApiKeySlot(slot)) throw new Error("Invalid API-key slot.");
      return coordinated(async () => {
        const pool = poolFor(profile, provider);
        if (pool.has(slot)) throw new Error("API-key slot already exists; remove before replacing.");
        if (pool.size >= MAX_API_KEY_SLOTS) throw new Error("API-key slot limit reached.");
        let key: string | undefined;
        try {
          if (signal.aborted) return false;
          key = await prompt(signal);
          if (signal.aborted || key === undefined) return false;
          if (!validKey(key)) throw new Error();
          // Failed writes may persist. Retain a blocked, capacity-counted recovery record.
          pool.set(slot, "unverified");
          const target = store(provider, slot);
          if (await target.load() !== undefined) throw new Error();
          try {
            await target.save(key);
            if (await target.load() !== key) throw new Error();
          } catch {
            try { await target.quarantine?.(); } catch { /* Keep the in-process slot blocked. */ }
            throw new Error();
          }
          pool.set(slot, "ready");
          return true;
        } catch { throw new Error("Unable to add and verify API-key slot. Remove unverified slots before retrying."); }
        finally { key = undefined; }
      });
    },
    async remove(provider: ApiKeyProvider, slot: string): Promise<void> {
      apiKeyAccount(profile, provider, slot);
      if (!isApiKeySlot(slot)) throw new Error("Invalid API-key slot.");
      await coordinated(async () => {
        const pool = poolFor(profile, provider);
        if (!pool.has(slot) && pool.size >= MAX_API_KEY_SLOTS) throw new Error("API-key slot limit reached.");
        pool.set(slot, "unverified");
        try {
          const target = store(provider, slot);
          await target.remove();
          if (await target.load() !== undefined) throw new Error();
          pool.delete(slot);
        } catch { throw new Error("Unable to remove and verify API-key slot."); }
      });
    },
    async list(provider: ApiKeyProvider): Promise<readonly ApiKeySlotMetadata[]> {
      const namespace = apiKeyAccount(profile, provider);
      return coordinated(async () => [...(pools.get(namespace) ?? [])]
        .map(([slot, state]) => Object.freeze({ slot, state: state === "ready" && !available(profile, provider, slot, now()) ? "cooldown" : state }))
        .sort((a, b) => a.slot.localeCompare(b.slot)));
    },
    /** Credential-only facade for ONE run. Copy selection; pin first resolution including failures.
     * Pass to builtins.apiKeyAuth. Explicit missing slots reject before adapter env fallback.
     */
    forRun(selection: Partial<Record<ApiKeyProvider, string>> = {}) {
      const selected = new Map<ApiKeyProvider, string>();
      for (const [provider, slot] of Object.entries(selection)) {
        if (!isApiKeyProvider(provider) || !isApiKeySlot(slot)) throw new Error("Invalid API-key selection.");
        selected.set(provider, slot);
      }
      const resolved = new Map<ApiKeyProvider, Promise<string | undefined>>();
      return {
        credentials(provider: ApiKeyProvider): Promise<string | undefined> {
          apiKeyAccount(profile, provider);
          let result = resolved.get(provider);
          if (!result) { result = credentials(provider, selected.get(provider)); resolved.set(provider, result); }
          return result;
        },
        reportRateLimit(provider: ApiKeyProvider, retryAfterMilliseconds?: number): void {
          const slot = selected.get(provider);
          if (!slot) return;
          const delay = Number.isSafeInteger(retryAfterMilliseconds) && retryAfterMilliseconds! >= 0
            ? Math.min(retryAfterMilliseconds!, MAX_COOLDOWN_MILLISECONDS)
            : DEFAULT_COOLDOWN_MILLISECONDS;
          healthFor(profile, provider).set(slot, { cooldownUntil: now() + delay });
        },
      };
    },
    async login(provider: ApiKeyProvider, prompt: SecretPrompt, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return false;
      let key: string | undefined;
      try {
        key = await prompt(signal);
        if (signal.aborted || key === undefined) return false;
        apiKeyAccount(profile, provider);
        return await coordinated(async () => {
          if (signal.aborted) return false;
          await store(provider).save(key!);
          return true;
        });
      } catch { throw new Error("API-key sign-in failed. Check input and OS credential storage."); }
      finally { key = undefined; }
    },
    async logout(provider: ApiKeyProvider): Promise<void> {
      apiKeyAccount(profile, provider);
      await coordinated(async () => {
        try { await store(provider).remove(); }
        catch { throw new Error("Unable to remove API key from OS credential storage."); }
      });
    },
    credentials,
  };
}
export type ApiKeyPoolAuth = ReturnType<typeof createApiKeyAuth>;
/** Legacy host contract remains implementable by singleton-only injected services. */
export type ApiKeyAuth = Pick<ApiKeyPoolAuth, "login" | "logout" | "credentials"> & Partial<Pick<ApiKeyPoolAuth, "add" | "remove" | "list" | "forRun">>;
