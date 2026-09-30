import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_PROJECT_SKILL_FILE_BYTES, isSafeSkillId, readSkill, validateSkillDocument, type Skill } from "./skills.js";

export type SkillHubEntry = Readonly<{ source: string; id: string; version: string; sha256: string }>;
export type SkillHubSource = Readonly<{ id: string; directory: string; entries: readonly SkillHubEntry[] }>;

const BUNDLED: SkillHubSource = Object.freeze({
  id: "bundled",
  directory: fileURLToPath(new URL("../catalog/skills", import.meta.url)),
  entries: Object.freeze([
    Object.freeze({ source: "bundled", id: "quick-notes", version: "1.0.0", sha256: "692759c69b1f196471e912060880dfed119be61b3895cbeeded5f52da838215c" }),
    Object.freeze({ source: "bundled", id: "quick-notes", version: "1.1.0", sha256: "ee42d72a4e8b7c681a5a5424c844998086a187fb3fd019e5bfd6db43cc732d44" }),
  ]),
});
const MAX_BYTES = DEFAULT_MAX_PROJECT_SKILL_FILE_BYTES;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function checkSource(source: SkillHubSource): void {
  if (!isSafeSkillId(source.id) || !source.directory || source.entries.length > 64) throw new Error("Invalid skill hub source.");
  for (const entry of source.entries) {
    if (entry.source !== source.id || !isSafeSkillId(entry.id) || !/^\d+\.\d+\.\d+$/.test(entry.version) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid skill hub entry.");
  }
}
async function boundedFile(path: string, allowHardlinks = false): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (!allowHardlinks && before.nlink !== 1) || before.size > MAX_BYTES) throw new Error("Skill hub file must be a small, unlinked regular file.");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if ((!allowHardlinks && after.nlink !== 1) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) throw new Error("Skill hub file changed during read.");
    return bytes;
  } finally { await handle.close(); }
}
async function ownedDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Skill hub requires a real, host-owned directory.");
}
async function writeNew(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** A host-selected, local-only source registry. Documents remain advisory and never execute. */
export class SkillHub {
  private readonly sources: readonly SkillHubSource[];

  constructor(private readonly root: string, additionalSources: readonly SkillHubSource[] = []) {
    if (!root) throw new Error("Skill hub requires an explicit host-owned skill directory.");
    this.sources = [BUNDLED, ...additionalSources.map((source) => ({ ...source, entries: [...source.entries] }))];
    if (this.sources.length > 8) throw new Error("Too many skill hub sources.");
    const names = new Set<string>();
    const records = new Set<string>();
    for (const source of this.sources) {
      checkSource(source);
      if (names.has(source.id)) throw new Error("Duplicate skill hub source.");
      names.add(source.id);
      for (const entry of source.entries) {
        const key = `${entry.id}/${entry.version}`;
        if (records.has(key)) throw new Error("Duplicate skill hub entry.");
        records.add(key);
      }
    }
  }

  listSources(): string[] { return this.sources.map((source) => source.id); }
  list(source?: string): SkillHubEntry[] {
    if (source && !this.sources.some((item) => item.id === source)) throw new Error("Skill source was not found.");
    return this.sources.flatMap((item) => source && source !== item.id ? [] : item.entries.map((entry) => ({ ...entry })));
  }

  private entry(source: string, id: string, version: string): { record: SkillHubEntry; directory: string } {
    const selected = this.sources.find((item) => item.id === source);
    const record = selected?.entries.find((item) => item.id === id && item.version === version);
    if (!selected || !record) throw new Error("Skill version was not found in a registered source.");
    return { record, directory: selected.directory };
  }

  private async sourceBytes(source: string, id: string, version: string): Promise<Buffer> {
    const { record, directory } = this.entry(source, id, version);
    await ownedDirectory(directory);
    const child = join(directory, id);
    await ownedDirectory(child);
    const versionDirectory = join(child, version);
    await ownedDirectory(versionDirectory);
    // Bundled, digest-pinned files may be hardlinked by a package manager; host-added sources may not.
    const bytes = await boundedFile(join(versionDirectory, "SKILL.md"), source === BUNDLED.id);
    if (digest(bytes) !== record.sha256) throw new Error("Skill source digest does not match its pinned record.");
    validateSkillDocument(bytes.toString("utf8"), id);
    return bytes;
  }

  private async rootDirectory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await ownedDirectory(this.root);
  }

  private async installed(id: string): Promise<{ skill: Skill; record: SkillHubEntry }> {
    if (!isSafeSkillId(id)) throw new Error("Invalid skill ID.");
    await ownedDirectory(join(this.root, id));
    const bytes = await boundedFile(join(this.root, id, "SKILL.md"));
    const record = this.list().find((entry) => entry.id === id && entry.sha256 === digest(bytes));
    if (!record) throw new Error("Installed skill is not an unchanged hub-managed version.");
    const skill = await readSkill(this.root, id, { maximumFileBytes: MAX_BYTES });
    if (skill.digest !== record.sha256) throw new Error("Installed skill changed while it was being read.");
    return { skill, record };
  }

  async listInstalled(): Promise<Array<{ skill: Skill; version: string; source: string }>> {
    await this.rootDirectory();
    const result: Array<{ skill: Skill; version: string; source: string }> = [];
    for (const id of new Set(this.list().map((entry) => entry.id))) {
      try {
        const { skill, record } = await this.installed(id);
        result.push({ skill, version: record.version, source: record.source });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return result;
  }

  async install(source: string, id: string, version: string): Promise<Skill> {
    const bytes = await this.sourceBytes(source, id, version);
    await this.rootDirectory();
    const directory = join(this.root, id);
    await mkdir(directory, { mode: 0o700 }); // EEXIST refuses pre-existing user skills.
    try { await writeNew(join(directory, "SKILL.md"), bytes); }
    catch (error) { await rmdir(directory).catch(() => undefined); throw error; }
    return (await this.installed(id)).skill;
  }

  async update(source: string, id: string, version: string): Promise<Skill> {
    const bytes = await this.sourceBytes(source, id, version);
    await this.rootDirectory();
    const current = await this.installed(id);
    if (current.record.source !== source) throw new Error("Skill source changed; refusing to replace it.");
    if (current.record.version === version) return current.skill;
    const oldParts = current.record.version.split(".").map(Number);
    const newParts = version.split(".").map(Number);
    if (!newParts.some((part, index) => part > oldParts[index] && newParts.slice(0, index).every((earlier, previous) => earlier === oldParts[previous]))) throw new Error("Skill update cannot downgrade an installed version.");
    const directory = join(this.root, id);
    if ((await readdir(directory)).some((name) => name !== "SKILL.md")) throw new Error("Refusing to update a skill containing other files.");
    const temporary = join(directory, `.skill-${randomUUID()}`);
    try {
      await writeNew(temporary, bytes);
      await rename(temporary, join(directory, "SKILL.md"));
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    return (await this.installed(id)).skill;
  }

  async remove(id: string): Promise<void> {
    if (!isSafeSkillId(id)) throw new Error("Invalid skill ID.");
    await this.rootDirectory();
    await this.installed(id);
    const directory = join(this.root, id);
    if ((await readdir(directory)).some((name) => name !== "SKILL.md")) throw new Error("Refusing to remove a skill containing other files.");
    await unlink(join(directory, "SKILL.md"));
    await rmdir(directory);
  }
}
