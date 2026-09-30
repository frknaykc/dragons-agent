import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, ToolInputSchema, ToolResult } from "./tools.js";

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_ID = /^[a-z][a-z0-9_]{0,31}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_MANIFEST_BYTES = 16_384;
const MAX_SCHEMA_BYTES = 8_192;
const MAX_PLUGIN_OUTPUT_BYTES = 16_384;
const MAX_PLUGINS = 32;
const MAX_TOOLS = 16;

/** A discovered manifest is data, never permission to load or run code. */
export type PluginManifest = Readonly<{
  apiVersion: 1;
  id: string;
  version: string;
  name: string;
  capabilities: readonly ["tools"];
}>;

/** Factories are provided only by trusted host code, not imported from a manifest. */
export type PluginToolFactory = () => readonly AgentTool[];

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeJson(value: unknown, maxBytes: number): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > 128 || depth > 8) throw new Error("Plugin metadata exceeds its complexity limit.");
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number" && Number.isFinite(node)) return;
    if (typeof node !== "object" || seen.has(node)) throw new Error("Plugin metadata must be finite JSON data.");
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
    } else if (plainObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("Unsafe plugin metadata key.");
        visit(item, depth + 1);
      }
    } else throw new Error("Plugin metadata must be plain JSON data.");
    seen.delete(node);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("Plugin metadata exceeds its byte limit.");
  return JSON.parse(encoded) as unknown;
}

export function validatePluginManifest(value: unknown): PluginManifest {
  const data = safeJson(value, MAX_MANIFEST_BYTES);
  if (!plainObject(data) || Object.keys(data).sort().join(",") !== "apiVersion,capabilities,id,name,version"
    || data.apiVersion !== 1 || !PLUGIN_ID.test(data.id as string) || !VERSION.test(data.version as string)
    || typeof data.name !== "string" || data.name.length < 1 || data.name.length > 128
    || /[\x00-\x1f\x7f]/.test(data.name)
    || !Array.isArray(data.capabilities) || data.capabilities.length !== 1 || data.capabilities[0] !== "tools") {
    throw new Error("Invalid or unsupported plugin manifest.");
  }
  return Object.freeze({ apiVersion: 1, id: data.id as string, version: data.version as string,
    name: data.name as string, capabilities: Object.freeze(["tools"] as const) });
}

/** Only immediate real directories/files in the host-owned root are eligible. No symlink traversal. */
export async function readPluginManifest(root: string, id: string): Promise<PluginManifest> {
  if (!PLUGIN_ID.test(id)) throw new Error("Invalid plugin ID.");
  const directory = join(root, id);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Plugin directory must be a real directory.");
  const path = join(directory, "plugin.json");
  const file = await lstat(path);
  if (!file.isFile() || file.size > MAX_MANIFEST_BYTES) throw new Error("Plugin manifest must be a bounded regular file.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let manifest: PluginManifest;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_MANIFEST_BYTES || opened.dev !== file.dev || opened.ino !== file.ino) {
      throw new Error("Plugin manifest changed during discovery.");
    }
    const content = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    if (bytesRead > MAX_MANIFEST_BYTES) throw new Error("Plugin manifest is too large.");
    manifest = validatePluginManifest(JSON.parse(content.subarray(0, bytesRead).toString("utf8")) as unknown);
  } finally {
    await handle.close();
  }
  if (manifest.id !== id) throw new Error("Plugin manifest ID does not match its directory.");
  return manifest;
}

export async function discoverPlugins(root: string): Promise<PluginManifest[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > 256) throw new Error("Plugin directory has too many entries.");
  const found: PluginManifest[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !PLUGIN_ID.test(entry.name)) continue;
    try { found.push(await readPluginManifest(root, entry.name)); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") throw error;
      // Malformed or incomplete packages are not activated by discovery.
    }
    if (found.length > MAX_PLUGINS) throw new Error("Too many plugins.");
  }
  return found;
}

function boundedResult(value: ToolResult): ToolResult {
  if (!value || typeof value.ok !== "boolean" || typeof value.output !== "string") {
    return { ok: false, output: "Plugin returned an invalid result." };
  }
  const bytes = Buffer.from(value.output, "utf8");
  if (bytes.length <= MAX_PLUGIN_OUTPUT_BYTES) return { ok: value.ok, output: value.output };
  const marker = "\n[plugin output truncated]";
  return { ok: value.ok, output: `${bytes.subarray(0, MAX_PLUGIN_OUTPUT_BYTES - Buffer.byteLength(marker)).toString("utf8")}${marker}` };
}

/** Explicit trusted registration; every plugin tool is EXECUTE regardless of its declared operation. */
export class PluginRegistry {
  private readonly factories = new Map<string, { manifest: PluginManifest; factory: PluginToolFactory }>();

  register(manifest: PluginManifest, factory: PluginToolFactory): void {
    const validated = validatePluginManifest(manifest);
    if (typeof factory !== "function") throw new Error("Plugin must provide a trusted tool factory.");
    if (this.factories.has(validated.id)) throw new Error("Plugin ID is already registered.");
    if (this.factories.size >= MAX_PLUGINS) throw new Error("Too many registered plugins.");
    this.factories.set(validated.id, { manifest: validated, factory });
  }

  list(): PluginManifest[] {
    return [...this.factories.values()].map((entry) => entry.manifest);
  }

  /** Construct fresh tool instances for one run, then pass them through runAgent's authorization gate. */
  tools(): AgentTool[] {
    const tools: AgentTool[] = [];
    const names = new Set<string>();
    for (const [id, { factory }] of this.factories) {
      let provided: readonly AgentTool[];
      try { provided = factory(); }
      catch { throw new Error(`Plugin ${id} factory failed.`); }
      if (!Array.isArray(provided) || provided.length > MAX_TOOLS) throw new Error("Plugin factory returned too many tools.");
      for (const tool of provided) {
        if (!tool || !TOOL_ID.test(tool.name) || typeof tool.description !== "string"
          || tool.description.length < 1 || tool.description.length > 512 || /[\x00-\x1f\x7f]/.test(tool.description)
          || typeof tool.execute !== "function") throw new Error("Invalid plugin tool.");
        const name = `plugin_${id.replaceAll("-", "_")}_${tool.name}`;
        if (name.length > 64 || names.has(name)) throw new Error("Duplicate or oversized plugin tool name.");
        names.add(name);
        const schema = safeJson(tool.inputSchema, MAX_SCHEMA_BYTES);
        if (!plainObject(schema) || schema.type !== "object") throw new Error("Plugin tool requires an object input schema.");
        tools.push({ name, description: tool.description, operation: "EXECUTE", inputSchema: schema as ToolInputSchema,
          execute: async (input, options) => {
            try { return boundedResult(await tool.execute(input, options)); }
            catch { return { ok: false, output: "Plugin tool failed." }; }
          } });
      }
    }
    return tools;
  }
}
