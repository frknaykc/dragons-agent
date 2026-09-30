import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { isSafeSkillId, type ActiveSkill, type Skill, type SkillScope } from "./skills.js";

const MAX_STATE_BYTES = 131_072;
const MAX_RECORDS = 256;
const O_NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
type RecordUsage = { id: string; scope: SkillScope; digest: string; count: number; firstUsedAt: string; lastUsedAt: string };
type State = { version: 1; records: RecordUsage[] };
export type SkillSuggestion = { kind: "maintenance" | "merge" | "archive"; scope: SkillScope; id: string; reason: "unused" | "changed" | "stale" | "duplicate"; withId?: string };

function key(scope: SkillScope, id: string): string { return `${scope}:${id}`; }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function checkState(value: unknown): State {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid skill curator state.");
  const state = value as Partial<State>;
  if (state.version !== 1 || !Array.isArray(state.records) || state.records.length > MAX_RECORDS || Object.keys(state).some((field) => field !== "version" && field !== "records")) throw new Error("Invalid skill curator state.");
  const seen = new Set<string>();
  for (const item of state.records) {
    if (!item || typeof item !== "object" || Object.keys(item).some((field) => !["id", "scope", "digest", "count", "firstUsedAt", "lastUsedAt"].includes(field)) || !isSafeSkillId(item.id) || !["USER", "PROJECT"].includes(item.scope)
      || !/^[a-f0-9]{64}$/.test(item.digest) || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 1_000_000
      || !validTimestamp(item.firstUsedAt) || !validTimestamp(item.lastUsedAt) || item.firstUsedAt > item.lastUsedAt
      || seen.has(key(item.scope, item.id))) throw new Error("Invalid skill curator state.");
    seen.add(key(item.scope, item.id));
  }
  return { version: 1, records: state.records };
}
function timestamp(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("Invalid curator observation time.");
  return at.toISOString();
}

/** Bounded advisory usage metadata. The caller owns the single-writer state directory. */
export class SkillCurator {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly stateDirectory: string) {}

  private async read(): Promise<State> {
    let dir;
    try { dir = await lstat(this.stateDirectory); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] }; throw error; }
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Skill curator directory must be a real directory.");
    const path = join(this.stateDirectory, "skill-curator.json");
    let handle;
    try { handle = await open(path, constants.O_RDONLY | O_NOFOLLOW); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] }; throw error; }
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_STATE_BYTES) throw new Error("Invalid skill curator state file.");
      const bytes = await handle.readFile();
      if (bytes.length > MAX_STATE_BYTES) throw new Error("Invalid skill curator state file.");
      return checkState(JSON.parse(bytes.toString("utf8")));
    } finally { await handle.close(); }
  }

  /** Counts only skills that were actually included in a completed run's resolved context. */
  async recordResolved(skills: readonly ActiveSkill[], at = new Date()): Promise<void> {
    if (!Array.isArray(skills) || skills.length > 128 || skills.some((skill) => !skill || !isSafeSkillId(skill.id) || !/^[a-f0-9]{64}$/.test(skill.digest) || (skill.scope !== undefined && skill.scope !== "USER" && skill.scope !== "PROJECT"))) throw new Error("Invalid resolved skill set.");
    const now = timestamp(at);
    const work = async (): Promise<void> => {
      const state = await this.read();
      const seen = new Set<string>();
      for (const skill of skills) {
        const scope = skill.scope ?? "USER";
        const identity = key(scope, skill.id);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const previous = state.records.find((entry) => key(entry.scope, entry.id) === identity);
        if (previous) {
          if (Date.parse(now) < Date.parse(previous.lastUsedAt)) throw new Error("Skill curator time moved backwards.");
          previous.digest = skill.digest;
          previous.count = Math.min(previous.count + 1, 1_000_000);
          previous.lastUsedAt = now;
        } else {
          if (state.records.length >= MAX_RECORDS) throw new Error("Skill curator capacity exceeded.");
          state.records.push({ id: skill.id, scope, digest: skill.digest, count: 1, firstUsedAt: now, lastUsedAt: now });
        }
      }
      if (!seen.size) return;
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      const root = await lstat(this.stateDirectory);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Skill curator directory must be a real directory.");
      const temp = join(this.stateDirectory, `.skill-curator-${randomUUID()}`);
      try {
        const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
        try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, join(this.stateDirectory, "skill-curator.json"));
      } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    };
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    await next;
  }

  async usage(): Promise<readonly RecordUsage[]> { return (await this.read()).records.map((entry) => ({ ...entry })); }

  /** Suggestions are data, never edits or model instructions; only installed skills supplied by the host are considered. */
  async suggest(skills: readonly Skill[], at = new Date()): Promise<SkillSuggestion[]> {
    if (!Array.isArray(skills) || skills.length > MAX_RECORDS) throw new Error("Invalid skill inventory.");
    const now = Date.parse(timestamp(at));
    const state = await this.read();
    const seen = new Set<string>();
    const digests = new Map<string, string>();
    const suggestions: SkillSuggestion[] = [];
    for (const skill of skills) {
      if (!isSafeSkillId(skill.id) || !["USER", "PROJECT"].includes(skill.scope) || !/^[a-f0-9]{64}$/.test(skill.digest)) throw new Error("Invalid skill inventory.");
      const identity = key(skill.scope, skill.id);
      if (seen.has(identity)) throw new Error("Duplicate skill inventory entry.");
      seen.add(identity);
      const previous = state.records.find((entry) => key(entry.scope, entry.id) === identity);
      if (!previous) suggestions.push({ kind: "maintenance", scope: skill.scope, id: skill.id, reason: "unused" });
      else if (previous.digest !== skill.digest) suggestions.push({ kind: "maintenance", scope: skill.scope, id: skill.id, reason: "changed" });
      else if (now - Date.parse(previous.lastUsedAt) >= 180 * 86_400_000 && previous.count <= 2) suggestions.push({ kind: "archive", scope: skill.scope, id: skill.id, reason: "stale" });
      else if (now - Date.parse(previous.lastUsedAt) >= 90 * 86_400_000) suggestions.push({ kind: "maintenance", scope: skill.scope, id: skill.id, reason: "stale" });
      const duplicate = digests.get(key(skill.scope, skill.digest));
      if (duplicate !== undefined) suggestions.push({ kind: "merge", scope: skill.scope, id: skill.id, withId: duplicate, reason: "duplicate" });
      else digests.set(key(skill.scope, skill.digest), skill.id);
    }
    return suggestions;
  }
}
