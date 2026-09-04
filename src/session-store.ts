import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compactContextText } from "./context-budget.js";
import { isSkillReference, type SkillReference } from "./skills.js";
import { isDragonsPlan, type DragonsPlan } from "./plan.js";
import { joinPlatformPath } from "./platform-path.js";

export type SessionProvider = "openai-api" | "chatgpt";

export type SessionMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type SessionContinuation = {
  responseId: string;
  providerState?: Record<string, unknown>;
};

export type DragonsSession = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  provider: SessionProvider;
  model: string;
  messages: SessionMessage[];
  continuation?: SessionContinuation;
  /** Skill activation intent only; bodies are never persisted with the transcript. */
  skills?: SkillReference[];
  /** Bounded app-owned task state, never provider continuation or transcript content. */
  plan?: DragonsPlan;
};

export type DragonsSessionDirectoryOptions = {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  xdgConfigHome?: string;
  appData?: string;
};

export type SessionStoreOptions = {
  now?: () => Date;
  createId?: () => string;
};

export type SessionStore = {
  create(metadata: Pick<DragonsSession, "workingDirectory" | "provider" | "model">): Promise<DragonsSession>;
  load(id: string): Promise<DragonsSession | undefined>;
  save(session: DragonsSession): Promise<void>;
  /** Atomically read, validate, and replace one session while holding its durable exclusive lock. */
  mutate?(id: string, operation: (session: DragonsSession) => DragonsSession | Promise<DragonsSession>): Promise<DragonsSession | undefined>;
  list(): Promise<DragonsSession[]>;
  delete(id: string): Promise<boolean>;
};

/** Keeps the newest transcript entries and labels structural compaction honestly. */
export function compactSessionMessages(messages: readonly SessionMessage[], maxCharacters: number): SessionMessage[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) throw new Error("Session context budget must be a positive integer.");
  let remaining = maxCharacters;
  const retained: SessionMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (remaining <= 0) break;
    const content = compactContextText(message.content, remaining);
    retained.unshift({ ...message, content });
    remaining -= content.length;
  }
  if (retained.length === messages.length) return retained;
  const reference = retained[0] ?? messages[messages.length - 1]!;
  return [{ role: "assistant", createdAt: reference.createdAt, content: "[Earlier conversation compacted; retained recent messages below.]" }, ...retained];
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set<SessionProvider>(["openai-api", "chatgpt"]);
const FORBIDDEN_PROVIDER_STATE_KEYS = new Set([
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "authorization",
  "credentials",
  "password",
  "secret",
]);

export function getDragonsSessionDirectory(options: DragonsSessionDirectoryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE;
  if (!homeDirectory) throw new Error("Unable to determine a home directory for Dragons sessions.");
  if (platform === "darwin") return joinPlatformPath(platform, homeDirectory, "Library", "Application Support", "Dragons Agent", "sessions");
  if (platform === "win32") return joinPlatformPath(platform, options.appData ?? process.env.APPDATA ?? homeDirectory, "Dragons Agent", "sessions");
  return joinPlatformPath(platform, options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? joinPlatformPath(platform, homeDirectory, ".config"), "dragons-agent", "sessions");
}

function sessionPath(directory: string, id: string): string {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error("Invalid Dragons session ID.");
  return join(directory, `${id}.json`);
}

function sessionLockPath(directory: string, id: string): string {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error("Invalid Dragons session ID.");
  return join(directory, `.${id}.lock`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function acquireSessionLock(directory: string, id: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = sessionLockPath(directory, id);
  const token = randomUUID();
  try {
    await writeFile(path, JSON.stringify({ version: 1, pid: process.pid, token }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Reclaiming a stale path needs a compare-and-delete primitive Node does not expose.
    // Fail closed instead of risking deletion of a newly acquired cross-process claim.
    throw new Error("Dragons session is busy.");
  }
  return async () => {
    try {
      const lock = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isRecord(lock) && lock.token === token) await rm(path, { force: true });
    } catch { /* A lost or replaced lock must not remove another owner's claim. */ }
  };
}

function containsProviderCredentials(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProviderCredentials);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    FORBIDDEN_PROVIDER_STATE_KEYS.has(key.toLowerCase()) || containsProviderCredentials(nested)
  ));
}

function isSessionMessage(value: unknown): value is SessionMessage {
  return isRecord(value)
    && (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string"
    && typeof value.createdAt === "string";
}

function parseSession(value: unknown): DragonsSession | undefined {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.id !== "string"
    || !SESSION_ID_PATTERN.test(value.id)
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || typeof value.workingDirectory !== "string"
    || !PROVIDERS.has(value.provider as SessionProvider)
    || typeof value.model !== "string"
    || !Array.isArray(value.messages)
    || !value.messages.every(isSessionMessage)) return undefined;

  const continuation = value.continuation;
  if (continuation !== undefined) {
    if (!isRecord(continuation) || typeof continuation.responseId !== "string") return undefined;
    if (continuation.providerState !== undefined && (!isRecord(continuation.providerState) || containsProviderCredentials(continuation.providerState))) {
      return undefined;
    }
  }
  if (value.skills !== undefined && (!Array.isArray(value.skills) || !value.skills.every(isSkillReference))) return undefined;
  if (value.plan !== undefined && !isDragonsPlan(value.plan)) return undefined;

  return value as DragonsSession;
}

async function writeSession(filePath: string, session: DragonsSession): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function createSessionStore(directory: string, options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  return {
    async create(metadata): Promise<DragonsSession> {
      const timestamp = now().toISOString();
      const session: DragonsSession = {
        version: 1,
        id: createId(),
        createdAt: timestamp,
        updatedAt: timestamp,
        workingDirectory: metadata.workingDirectory,
        provider: metadata.provider,
        model: metadata.model,
        messages: [],
      };
      if (!parseSession(session)) throw new Error("Unable to create a valid Dragons session.");
      await writeSession(sessionPath(directory, session.id), session);
      return session;
    },

    async load(id): Promise<DragonsSession | undefined> {
      let filePath: string;
      try {
        filePath = sessionPath(directory, id);
      } catch {
        return undefined;
      }
      try {
        return parseSession(JSON.parse(await readFile(filePath, "utf8")) as unknown);
      } catch {
        return undefined;
      }
    },

    async save(session): Promise<void> {
      if (!parseSession(session)) throw new Error("Refusing to save an invalid or credential-bearing Dragons session.");
      await writeSession(sessionPath(directory, session.id), session);
    },

    async mutate(id, operation): Promise<DragonsSession | undefined> {
      const release = await acquireSessionLock(directory, id);
      try {
        const current = await this.load(id);
        if (!current) return undefined;
        const next = await operation(structuredClone(current));
        if (next.id !== id || !parseSession(next)) throw new Error("Refusing to save an invalid or credential-bearing Dragons session.");
        await writeSession(sessionPath(directory, id), next);
        return structuredClone(next);
      } finally {
        await release();
      }
    },

    async list(): Promise<DragonsSession[]> {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error("Unable to list Dragons sessions.");
      }
      const sessions = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.load(entry.name.slice(0, -".json".length))));
      return sessions
        .filter((session): session is DragonsSession => Boolean(session))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async delete(id): Promise<boolean> {
      try {
        await rm(sessionPath(directory, id), { force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}
