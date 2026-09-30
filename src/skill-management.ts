import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isSafeSkillId, readSkill, validateSkillDocument, type Skill } from "./skills.js";
import type { AgentTool, ToolResult } from "./tools.js";

const MAX_BYTES = 16_384;
const DIGEST = /^[a-f0-9]{64}$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function inputRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid skill management input.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) throw new Error("Unknown skill management input field.");
  return record;
}
function skillId(value: unknown): string {
  if (typeof value !== "string" || !isSafeSkillId(value)) throw new Error("Invalid skill ID.");
  return value;
}
function expected(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error("An expected skill digest is required.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Skill content must be a Markdown document.");
  return value;
}
function document(raw: unknown, id: string): Buffer {
  if (typeof raw !== "string") throw new Error("Skill content must be a Markdown document.");
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length > MAX_BYTES) throw new Error("Skill document exceeds the file size limit.");
  validateSkillDocument(raw, id);
  return bytes;
}
async function realDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Skill management requires a real host-owned directory.");
}
async function checkedFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error("Skill file must be an unlinked, bounded regular file.");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.size !== bytes.length) throw new Error("Skill file changed during validation.");
    return createHash("sha256").update(bytes).digest("hex");
  } finally { await handle.close(); }
}
async function newFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Explicit user-skill operations. Project skills and foreign files are not managed here. */
export class SkillManager {
  constructor(private readonly root: string) {
    if (!root) throw new Error("Skill management requires an explicit user skill directory.");
  }

  private async rootDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    await realDirectory(this.root);
  }

  private async current(id: string): Promise<Skill> {
    await this.rootDirectory(false);
    const directory = join(this.root, id);
    await realDirectory(directory);
    const digest = await checkedFile(join(directory, "SKILL.md"));
    const skill = await readSkill(this.root, id, { maximumFileBytes: MAX_BYTES });
    if (skill.digest !== digest) throw new Error("Skill changed during validation.");
    return skill;
  }

  async validate(id: string): Promise<Skill>;
  async validate(id: string, raw: string): Promise<Pick<Skill, "name" | "description" | "body">>;
  async validate(id: string, raw?: string): Promise<Skill | Pick<Skill, "name" | "description" | "body">> {
    skillId(id);
    if (raw === undefined) return this.current(id);
    return validateSkillDocument(document(raw, id).toString("utf8"), id);
  }

  async create(id: string, raw: string): Promise<Skill> {
    skillId(id);
    const bytes = document(raw, id);
    await this.rootDirectory(true);
    const directory = join(this.root, id);
    await mkdir(directory, { mode: 0o700 }); // Never adopt or replace an existing user skill.
    try { await newFile(join(directory, "SKILL.md"), bytes); }
    catch (error) { await rmdir(directory).catch(() => undefined); throw error; }
    return this.current(id);
  }

  async edit(id: string, raw: string, expectedDigest: string): Promise<Skill> {
    skillId(id);
    expected(expectedDigest);
    const bytes = document(raw, id);
    const current = await this.current(id);
    if (current.digest !== expectedDigest) throw new Error("Skill changed since it was inspected.");
    const directory = join(this.root, id);
    if ((await readdir(directory)).some((name) => name !== "SKILL.md")) throw new Error("Refusing to edit a skill containing other files.");
    const temporary = join(directory, `.skill-${randomUUID()}`);
    try { await newFile(temporary, bytes); await rename(temporary, join(directory, "SKILL.md")); }
    finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    return this.current(id);
  }

  async archive(id: string, expectedDigest: string): Promise<string> {
    skillId(id);
    expected(expectedDigest);
    const current = await this.current(id);
    if (current.digest !== expectedDigest) throw new Error("Skill changed since it was inspected.");
    const directory = join(this.root, id);
    if ((await readdir(directory)).some((name) => name !== "SKILL.md")) throw new Error("Refusing to archive a skill containing other files.");
    const archiveRoot = join(this.root, ".archive");
    await mkdir(archiveRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await realDirectory(archiveRoot);
    const idRoot = join(archiveRoot, id);
    await mkdir(idRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await realDirectory(idRoot);
    const archiveId = randomUUID();
    await rename(directory, join(idRoot, archiveId));
    return archiveId; // Opaque archive receipt; not an absolute path.
  }

  async delete(id: string, expectedDigest: string): Promise<void> {
    skillId(id);
    expected(expectedDigest);
    const current = await this.current(id);
    if (current.digest !== expectedDigest) throw new Error("Skill changed since it was inspected.");
    const directory = join(this.root, id);
    if ((await readdir(directory)).some((name) => name !== "SKILL.md")) throw new Error("Refusing to delete a skill containing other files.");
    await unlink(join(directory, "SKILL.md"));
    await rmdir(directory);
  }
}

/** Host opt-in: pass these tools to createDragonsRuntime; runAgent owns WRITE authorization. */
export function createSkillManagementTools(directory: string): AgentTool[] {
  const manager = new SkillManager(directory);
  const make = (name: string, operation: "READ" | "WRITE", description: string, fields: readonly string[], run: (input: Record<string, unknown>) => Promise<string>): AgentTool => ({
    name, operation, description,
    inputSchema: { type: "object", properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])), required: fields.filter((field) => field !== "content" || name !== "skill_validate"), additionalProperties: false },
    async execute(value: unknown): Promise<ToolResult> {
      try { return { ok: true, output: await run(inputRecord(value, fields)) }; }
      catch { return { ok: false, output: "Skill management failed; inspect the skill, its digest, or the host-owned directory." }; }
    },
  });
  return [
    make("skill_create", "WRITE", "Create a validated user skill document; requires WRITE approval.", ["id", "content"], async (v) => `Created ${(await manager.create(skillId(v.id), text(v.content))).id}.`),
    make("skill_edit", "WRITE", "Edit a user skill with an expected digest; requires WRITE approval.", ["id", "content", "expectedDigest"], async (v) => `Edited ${(await manager.edit(skillId(v.id), text(v.content), expected(v.expectedDigest))).id}.`),
    make("skill_validate", "READ", "Validate a proposed or installed user skill and return its digest without writing files.", ["id", "content"], async (v) => {
      const validated = v.content === undefined ? await manager.validate(skillId(v.id)) : await manager.validate(skillId(v.id), text(v.content));
      const digest = "digest" in validated ? validated.digest : createHash("sha256").update(text(v.content), "utf8").digest("hex");
      return `Skill is valid; digest: ${digest}.`;
    }),
    make("skill_archive", "WRITE", "Archive a user skill by expected digest; requires WRITE approval.", ["id", "expectedDigest"], async (v) => `Archived ${skillId(v.id)} as ${await manager.archive(skillId(v.id), expected(v.expectedDigest))}.`),
    make("skill_delete", "WRITE", "Permanently delete a user skill by expected digest; requires WRITE approval.", ["id", "expectedDigest"], async (v) => { await manager.delete(skillId(v.id), expected(v.expectedDigest)); return `Deleted ${skillId(v.id)}.`; }),
  ];
}
