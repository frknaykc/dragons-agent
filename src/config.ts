import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { parseMcpServerConfigs, type McpServerConfig } from "./mcp-client.js";
import { joinPlatformPath } from "./platform-path.js";
import { DEFAULT_PROVIDER_IDS, type ProviderId } from "./provider/registry.js";

export type DragonsConfig = {
  version?: 1;
  provider?: ProviderId;
  /** Legacy global model value retained for existing local configuration. */
  model?: string;
  models?: Partial<Record<ProviderId, string>>;
  /** Explicit credential-free OpenAI-compatible local-runtime endpoint. */
  localEndpoint?: string;
  maxTurns?: number;
  maxToolOutputBytes?: number;
  shellTimeoutMilliseconds?: number;
  contextBudgetChars?: number;
  retryMaxAttempts?: number;
  /** Explicit, app-owned stdio or Streamable HTTP MCP servers. Never auto-connected or persisted in sessions. */
  mcpServers?: McpServerConfig[];
};

export type ConfigPathOptions = { platform?: NodeJS.Platform; homeDirectory?: string; xdgConfigHome?: string; appData?: string };
const ALLOWED = new Set<keyof DragonsConfig>(["version", "provider", "model", "models", "localEndpoint", "maxTurns", "maxToolOutputBytes", "shellTimeoutMilliseconds", "contextBudgetChars", "retryMaxAttempts", "mcpServers"]);

export function getDragonsConfigPath(options: ConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("Unable to determine a home directory for Dragons config.");
  if (platform === "darwin") return joinPlatformPath(platform, home, "Library", "Application Support", "Dragons Agent", "config.json");
  if (platform === "win32") return joinPlatformPath(platform, options.appData ?? process.env.APPDATA ?? home, "Dragons Agent", "config.json");
  return joinPlatformPath(platform, options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? joinPlatformPath(platform, home, ".config"), "dragons-agent", "config.json");
}
function positiveInteger(value: unknown, key: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Dragons config ${key} must be a positive integer.`);
  return value as number;
}
function validLocalEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) throw new Error("Dragons config localEndpoint must be a bounded non-empty URL.");
  let endpoint: URL;
  try { endpoint = new URL(value.trim()); } catch { throw new Error("Dragons config localEndpoint must be a valid URL."); }
  const loopbackHttp = endpoint.protocol === "http:" && (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]" || endpoint.hostname === "::1");
  if ((endpoint.protocol !== "https:" && !loopbackHttp) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Dragons config localEndpoint must be credential-free HTTPS or literal loopback HTTP.");
  }
  return endpoint.toString().replace(/\/$/, "");
}
export function parseDragonsConfig(value: unknown, providerIds: readonly ProviderId[] = DEFAULT_PROVIDER_IDS): DragonsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dragons config must be a JSON object.");
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!ALLOWED.has(key as keyof DragonsConfig)) throw new Error(`Unknown Dragons config key: ${key}`);
  const config: DragonsConfig = {};
  if (source.version !== undefined) {
    if (source.version !== 1) throw new Error("Dragons config version must be 1.");
    config.version = 1;
  }
  if (source.provider !== undefined) { if (typeof source.provider !== "string" || !providerIds.includes(source.provider)) throw new Error("Dragons config provider must be a registered provider."); config.provider = source.provider; }
  if (source.model !== undefined) { if (typeof source.model !== "string" || !source.model.trim()) throw new Error("Dragons config model must be a non-empty string."); config.model = source.model.trim(); }
  if (source.models !== undefined) {
    if (!source.models || typeof source.models !== "object" || Array.isArray(source.models)) throw new Error("Dragons config models must be an object.");
    const models = source.models as Record<string, unknown>;
    for (const [provider, model] of Object.entries(models)) {
      if (!providerIds.includes(provider) || typeof model !== "string" || !model.trim()) {
        throw new Error("Dragons config models must contain non-empty supported provider model values.");
      }
    }
    config.models = Object.fromEntries(Object.entries(models).map(([provider, model]) => [provider, (model as string).trim()])) as DragonsConfig["models"];
  }
  if (source.localEndpoint !== undefined) config.localEndpoint = validLocalEndpoint(source.localEndpoint);
  if (source.mcpServers !== undefined) config.mcpServers = parseMcpServerConfigs(source.mcpServers);
  for (const key of ["maxTurns", "maxToolOutputBytes", "shellTimeoutMilliseconds", "contextBudgetChars", "retryMaxAttempts"] as const) if (source[key] !== undefined) config[key] = positiveInteger(source[key], key);
  return config;
}
export async function loadDragonsConfig(configPath = getDragonsConfigPath(), providerIds: readonly ProviderId[] = DEFAULT_PROVIDER_IDS): Promise<DragonsConfig> {
  try { return parseDragonsConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown, providerIds); }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof Error && (error.message.startsWith("Dragons config") || error.message.startsWith("Unknown Dragons"))) throw error;
    throw new Error(`Unable to read Dragons config: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}
export async function saveDragonsConfig(config: DragonsConfig, configPath = getDragonsConfigPath(), providerIds: readonly ProviderId[] = DEFAULT_PROVIDER_IDS): Promise<void> {
  const valid = parseDragonsConfig(config, providerIds); const directory = dirname(configPath); const temporary = `${configPath}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  try { await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, configPath); await chmod(configPath, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
