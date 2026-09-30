import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "./tools.js";
import { PluginRegistry, validatePluginManifest, type PluginManifest, type PluginToolFactory } from "./plugins.js";

export type ReviewedPlugin = Readonly<{ id: string; version: string; sha256: string; name: string }>;

// Reviewed in the repository; no external registry, script loader or dynamic import.
const REVIEWED: readonly ReviewedPlugin[] = Object.freeze([
  Object.freeze({ id: "hello", version: "1.0.0", sha256: "c4a3582773e4f7d75ed5c087b92c87a4f936cc8fc3773e676c7eb9ef59145dbb", name: "Reviewed Hello" }),
  Object.freeze({ id: "hello", version: "1.1.0", sha256: "b6e84bdac9f252cb7e9be10280334ab1f85bcaf7f4f610d00d192380e4c0255c", name: "Reviewed Hello" }),
]);
const MAX_MANIFEST_BYTES = 16_384;

const helloTools: PluginToolFactory = (): readonly AgentTool[] => [{
  name: "greet",
  description: "Return a greeting for a short name.",
  operation: "EXECUTE",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  async execute(input) {
    const name = (input as { name?: unknown }).name;
    if (typeof name !== "string" || !/^[a-zA-Z ]{1,80}$/.test(name)) return { ok: false, output: "Name must be 1–80 ASCII letters/spaces." };
    return { ok: true, output: `Hello, ${name}!` };
  },
}];
const TRUSTED_FACTORIES: Readonly<Record<string, PluginToolFactory>> = Object.freeze({ hello: helloTools });

function pinned(id: string, version?: string): ReviewedPlugin {
  const entry = REVIEWED.find((item) => item.id === id && (version === undefined || item.version === version));
  if (!entry) throw new Error("Plugin is not in the reviewed catalog at that version.");
  return entry;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFile(path: string, allowHardlinks = false): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || (!allowHardlinks && before.nlink !== 1) || before.size > MAX_MANIFEST_BYTES) throw new Error("Catalog manifest must be a bounded, unlinked regular file.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || (!allowHardlinks && after.nlink !== 1) || before.dev !== after.dev || before.ino !== after.ino || after.size > MAX_MANIFEST_BYTES) {
      throw new Error("Catalog manifest changed during reading.");
    }
    const bytes = Buffer.alloc(after.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== after.size) throw new Error("Catalog manifest changed during reading.");
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function checkedManifest(path: string, entry: ReviewedPlugin): Promise<{ bytes: Buffer; manifest: PluginManifest }> {
  // Package managers may hardlink published files into their stores. The pinned digest authenticates this source;
  // installed metadata remains unlinked and is never adopted from a package-manager store.
  const bytes = await regularFile(path, true);
  if (digest(bytes) !== entry.sha256) throw new Error("Catalog manifest does not match its pinned SHA-256.");
  const manifest = validatePluginManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.name !== entry.name) {
    throw new Error("Catalog manifest identity does not match its reviewed entry.");
  }
  return { bytes, manifest };
}

async function installed(root: string, id: string): Promise<{ entry: ReviewedPlugin; manifest: PluginManifest }> {
  const directory = join(root, id);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Installed plugin directory is not a real directory.");
  const path = join(directory, "plugin.json");
  const bytes = await regularFile(path);
  const manifest = validatePluginManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  if (manifest.id !== id) throw new Error("Installed plugin identity changed.");
  const entry = pinned(id, manifest.version);
  if (digest(bytes) !== entry.sha256) throw new Error("Installed plugin was modified; refusing to overwrite it.");
  return { entry, manifest };
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

/** Metadata lifecycle only. Activation uses an already compiled, trusted host factory. */
export class ReviewedPluginCatalog {
  constructor(private readonly root: string) {
    if (!root) throw new Error("An explicit host-owned plugin root is required.");
  }

  list(): ReviewedPlugin[] { return REVIEWED.map((entry) => ({ ...entry })); }

  private async rootDirectory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) throw new Error("Plugin root must be a real directory.");
  }

  private async source(entry: ReviewedPlugin): Promise<{ bytes: Buffer; manifest: PluginManifest }> {
    const path = new URL(`../catalog/plugins/${entry.id}/${entry.version}/plugin.json`, import.meta.url);
    return checkedManifest(fileURLToPath(path), entry);
  }

  async listInstalled(): Promise<PluginManifest[]> {
    await this.rootDirectory();
    const result: PluginManifest[] = [];
    for (const id of new Set(REVIEWED.map((entry) => entry.id))) {
      try { result.push((await installed(this.root, id)).manifest); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return result;
  }

  async install(id: string, version: string): Promise<PluginManifest> {
    const entry = pinned(id, version);
    const { bytes, manifest } = await this.source(entry);
    await this.rootDirectory();
    const directory = join(this.root, id);
    await mkdir(directory, { mode: 0o700 }); // EEXIST fails closed; never adopt an unknown directory.
    try { await writeExclusive(join(directory, "plugin.json"), bytes); }
    catch (error) { await rmdir(directory).catch(() => undefined); throw error; }
    return manifest;
  }

  async update(id: string, version: string): Promise<PluginManifest> {
    const entry = pinned(id, version);
    const { bytes, manifest } = await this.source(entry);
    await this.rootDirectory();
    const current = await installed(this.root, id);
    if (current.entry.version === version) return current.manifest;
    const oldParts = current.entry.version.split(".").map(Number);
    const newParts = version.split(".").map(Number);
    const newer = newParts.some((part, index) => part > oldParts[index] && newParts.slice(0, index).every((earlier, previous) => earlier === oldParts[previous]));
    if (!newer) throw new Error("Plugin update cannot downgrade an installed version.");
    const directory = join(this.root, id);
    if ((await readdir(directory)).some((name) => name !== "plugin.json")) throw new Error("Refusing to update a plugin directory containing other files.");
    const temporary = join(directory, `.plugin-${randomUUID()}`);
    await writeExclusive(temporary, bytes);
    try {
      await installed(this.root, id); // Recheck the pinned previous manifest before replacement.
      await rename(temporary, join(directory, "plugin.json"));
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    return manifest;
  }

  async remove(id: string): Promise<void> {
    pinned(id);
    await this.rootDirectory();
    await installed(this.root, id);
    const directory = join(this.root, id);
    if ((await readdir(directory)).some((name) => name !== "plugin.json")) throw new Error("Refusing to remove a plugin directory containing other files.");
    await unlink(join(directory, "plugin.json"));
    await rmdir(directory);
  }

  async activate(id: string, registry: PluginRegistry): Promise<void> {
    await this.rootDirectory();
    const { manifest } = await installed(this.root, id);
    const factory = TRUSTED_FACTORIES[id];
    if (!factory) throw new Error("Reviewed plugin has no trusted factory.");
    registry.register(manifest, factory);
  }
}
