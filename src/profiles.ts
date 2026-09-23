import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { getDragonsConfigPath, type ConfigPathOptions } from "./config.js";

export const DEFAULT_DRAGONS_PROFILE = "default";
const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ACTIVE_PROFILE_FILE = "active.json";

export type DragonsProfilePaths = {
  name: string;
  configPath: string;
  sessionDirectory: string;
  skillsDirectory: string;
  memoryDirectory: string;
  backgroundJobsDirectory: string;
  /** Credential-store account namespace; this is a label only, never credential data. */
  credentialAccount: string;
};

export type DragonsProfileStore = {
  active(): Promise<string>;
  list(): Promise<string[]>;
  create(name: string): Promise<DragonsProfilePaths>;
  select(name: string): Promise<DragonsProfilePaths>;
  paths(name: string): DragonsProfilePaths;
};

export function isSafeProfileName(name: string): boolean {
  return PROFILE_NAME.test(name) && name !== "." && name !== "..";
}

function validateProfileName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!isSafeProfileName(normalized)) throw new Error("Profile name must contain 1-64 lowercase letters, numbers, or hyphens.");
  return normalized;
}

function profileRoot(configPath: string): string {
  return join(dirname(configPath), "profiles");
}

function profileDirectory(configPath: string, name: string): string {
  return join(profileRoot(configPath), validateProfileName(name));
}

/**
 * The default profile deliberately retains legacy paths, so upgrading does not
 * move or duplicate existing local state. Every named profile is isolated.
 */
export function getDragonsProfilePaths(name: string, configPath = getDragonsConfigPath()): DragonsProfilePaths {
  const safeName = validateProfileName(name);
  const base = dirname(configPath);
  const root = safeName === DEFAULT_DRAGONS_PROFILE ? base : profileDirectory(configPath, safeName);
  return {
    name: safeName,
    configPath: safeName === DEFAULT_DRAGONS_PROFILE ? configPath : join(root, "config.json"),
    sessionDirectory: join(root, "sessions"),
    skillsDirectory: join(root, "skills"),
    memoryDirectory: join(root, "memory"),
    backgroundJobsDirectory: join(root, "jobs"),
    credentialAccount: safeName === DEFAULT_DRAGONS_PROFILE ? "chatgpt-subscription" : `chatgpt-subscription:${safeName}`,
  };
}

async function ensureOwnedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Dragons profile directory must be a real directory, not a symlink.");
  await chmod(directory, 0o700);
}

async function writeActiveProfile(path: string, name: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, profile: name })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readActiveProfile(path: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.profile !== "string" || !isSafeProfileName(record.profile)) throw new Error("invalid");
    return record.profile;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_DRAGONS_PROFILE;
    throw new Error("Active Dragons profile state is invalid.");
  }
}

export function createDragonsProfileStore(options: ConfigPathOptions & { configPath?: string } = {}): DragonsProfileStore {
  const configPath = options.configPath ?? getDragonsConfigPath(options);
  const root = profileRoot(configPath);
  const activePath = join(root, ACTIVE_PROFILE_FILE);

  return {
    async active(): Promise<string> {
      await ensureOwnedDirectory(root);
      return readActiveProfile(activePath);
    },
    async list(): Promise<string[]> {
      await ensureOwnedDirectory(root);
      const profiles = [DEFAULT_DRAGONS_PROFILE];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && isSafeProfileName(entry.name) && entry.name !== DEFAULT_DRAGONS_PROFILE) profiles.push(entry.name);
      }
      return profiles.sort((left, right) => left.localeCompare(right));
    },
    async create(name: string): Promise<DragonsProfilePaths> {
      const paths = getDragonsProfilePaths(name, configPath);
      if (paths.name !== DEFAULT_DRAGONS_PROFILE) await ensureOwnedDirectory(profileDirectory(configPath, paths.name));
      return paths;
    },
    async select(name: string): Promise<DragonsProfilePaths> {
      const paths = await this.create(name);
      await ensureOwnedDirectory(root);
      await writeActiveProfile(activePath, paths.name);
      return paths;
    },
    paths(name: string): DragonsProfilePaths { return getDragonsProfilePaths(name, configPath); },
  };
}
