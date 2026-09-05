import { createHash } from "node:crypto";

import { Client, InsufficientScopeError, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import { createNativeMcpBearerTokenStore, type McpBearerTokenStore, type McpCredentialScope } from "./mcp-credential-store.js";
import type { AgentTool, ToolExecutionOptions, ToolOperation, ToolResult } from "./tools.js";

export type { McpBearerTokenStore, McpCredentialScope } from "./mcp-credential-store.js";

export const DEFAULT_MCP_CONNECT_TIMEOUT_MILLISECONDS = 10_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MILLISECONDS = 30_000;
export const DEFAULT_MAX_MCP_SERVERS = 8;
export const DEFAULT_MAX_MCP_CONCURRENT_CONNECTIONS = 2;
export const DEFAULT_MAX_MCP_TOTAL_TOOLS = 128;
export const DEFAULT_MCP_HTTP_SESSION_TERMINATION_TIMEOUT_MILLISECONDS = 1_000;
export const DEFAULT_MAX_MCP_TOOLS = 64;
export const DEFAULT_MAX_MCP_SCHEMA_BYTES = 16_384;
export const DEFAULT_MAX_MCP_TOTAL_SCHEMA_BYTES = 262_144;
export const DEFAULT_MAX_MCP_OUTPUT_BYTES = 65_536;
export const DEFAULT_MAX_MCP_TRANSPORT_BUFFER_BYTES = 1_048_576;
export const DEFAULT_MAX_MCP_HTTP_RESPONSE_BYTES = 1_048_576;

const MAX_MCP_SERVER_TOOL_NAME_BYTES = 4_096;
const MAX_MCP_SERVER_TOOL_DESCRIPTION_BYTES = 16_384;

const SAFE_ENVIRONMENT_NAMES = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "NO_COLOR", "TZ", "NODE_ENV"]);
const SECRET_ENVIRONMENT_PATTERN = /(?:secret|token|password|credential|authorization|api[_-]?key|bearer)/i;
const SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const CREDENTIAL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CREDENTIAL_ARGUMENT_PATTERN = /^--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|authorization|auth)(?:=|$)|^(?:Bearer\s+|sk-|rk-)/i;

export type StdioMcpServerConfig = {
  id: string;
  /** Omitted for compatibility with existing stdio configuration. */
  transport?: "stdio";
  command: string;
  args?: string[];
  /** Safe, non-secret overrides only. The subprocess otherwise receives the SDK's safe default environment. */
  env?: Record<string, string>;
  operation?: ToolOperation;
};

export type HttpMcpServerConfig = {
  id: string;
  transport: "http";
  url: string;
  /** Bearer token is resolved only from Dragons native credential storage. */
  auth?: { type: "bearer"; credentialId?: string };
  operation?: ToolOperation;
};

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;
export type McpTransport = "stdio" | "http";
export type McpFailureCategory = "connection" | "discovery" | "authentication" | "timeout" | "cancelled" | "tool";

export type McpClientOptions = {
  connectTimeoutMilliseconds?: number;
  toolTimeoutMilliseconds?: number;
  maxConcurrentConnections?: number;
  maxTools?: number;
  maxTotalTools?: number;
  maxSchemaBytes?: number;
  maxTotalSchemaBytes?: number;
  maxOutputBytes?: number;
  credentialStore?: Pick<McpBearerTokenStore, "load">;
};

export type McpConnectAllResult = {
  connected: string[];
  failed: string[];
};

export type McpServerStatus = {
  id: string;
  transport: McpTransport;
  authentication: "none" | "bearer";
  state: "disconnected" | "connected";
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  toolNames: string[];
  /** Safe negotiated MCP metadata only; no server payloads or transport details. */
  protocolVersion?: string;
  capabilities: { tools: boolean };
  callCount: number;
  failureCount: number;
  cancellationCount: number;
  connectDurationMilliseconds?: number;
  discoveryDurationMilliseconds?: number;
  lastInvocationDurationMilliseconds?: number;
  lastFailureCategory?: McpFailureCategory;
  lastError?: string;
};

export type McpCapability =
  | { serverId: string; transport: McpTransport; state: "connected"; type: "tool"; originalName: string; name: string; operation: ToolOperation }
  | { serverId: string; transport: McpTransport; state: "connected"; type: "resource"; originalName: string; name: string; uri: string; mimeType?: string }
  | { serverId: string; transport: McpTransport; state: "connected"; type: "prompt"; originalName: string; name: string; description?: string };

type Connection = {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  sensitiveValues: Set<string>;
  tools: AgentTool[];
  capabilityMetadata: McpCapability[];
  state: "connected" | "disconnected";
  protocolVersion?: string;
  capabilities: { tools: boolean };
  callCount: number;
  failureCount: number;
  cancellationCount: number;
  connectDurationMilliseconds?: number;
  discoveryDurationMilliseconds?: number;
  lastInvocationDurationMilliseconds?: number;
  lastFailureCategory?: McpFailureCategory;
  lastError?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unexpected MCP error.";
}

class McpAuthenticationError extends Error {
  constructor() { super("MCP authentication required or rejected."); }
}

function boundedOutput(output: string, maximum: number): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= maximum) return output;
  const marker = `[MCP output truncated at ${maximum} bytes]`;
  const available = Math.max(0, maximum - Buffer.byteLength(`\n${marker}`));
  return `${bytes.subarray(0, available).toString("utf8")}\n${marker}`;
}

function boundedHttpResponse(response: Response, maximum: number): Response {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximum) {
    throw new Error(`MCP HTTP response exceeds the ${maximum}-byte limit.`);
  }
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maximum) {
        controller.error(new Error(`MCP HTTP response exceeds the ${maximum}-byte limit.`));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function redactMcpText(value: string, sensitiveValues: Iterable<string> = []): string {
  let redacted = value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:\\?["'])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|authorization|auth)(?:\\?["'])?\s*(?:=|:)\s*\\?["']?)[^\s,\\"'}\]]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9._~-]+\b/gi, "[REDACTED]");
  for (const sensitiveValue of sensitiveValues) if (sensitiveValue) redacted = redacted.split(sensitiveValue).join("[REDACTED]");
  return redacted;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("MCP bounds must be finite positive integers.");
  return Math.max(1, Math.floor(value));
}

function isJsonValue(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const valid = values.every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && isJsonValue(value);
}

function schemaFrom(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonValue(value)) {
    throw new Error("MCP tool input schema must be a JSON-serializable object.");
  }
  const schema = value as Record<string, unknown>;
  if (schema.type !== "object") throw new Error("MCP tool input schema must declare type object.");
  return structuredClone(schema);
}

function timeout<T>(operation: Promise<T>, milliseconds: number, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error(message))), milliseconds);
    const abort = (): void => finish(() => reject(new DOMException("Aborted", "AbortError")));
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    };
    signal?.addEventListener("abort", abort, { once: true });
    void operation.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

function transportOf(config: McpServerConfig): McpTransport {
  return config.transport === "http" ? "http" : "stdio";
}

function isAuthenticatedHttp(config: McpServerConfig): config is HttpMcpServerConfig & { auth: NonNullable<HttpMcpServerConfig["auth"]> } {
  return config.transport === "http" && config.auth !== undefined;
}

function failureCategory(error: unknown, fallback: "connection" | "discovery" | "tool", signal?: AbortSignal): McpFailureCategory {
  if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return "cancelled";
  if (error instanceof McpAuthenticationError || error instanceof UnauthorizedError || error instanceof InsufficientScopeError) return "authentication";
  if (error instanceof Error && /timed out/i.test(error.message)) return "timeout";
  return fallback;
}

function normalizedOperation(value: unknown, id: string): ToolOperation | undefined {
  if (value !== undefined && !["READ", "WRITE", "EXECUTE"].includes(value as ToolOperation)) {
    throw new Error(`MCP server ${id} operation must be READ, WRITE, or EXECUTE.`);
  }
  return value as ToolOperation | undefined;
}

function normalizedHttpUrl(value: unknown, id: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`MCP server ${id} URL must be a non-empty HTTP or HTTPS URL.`);
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error(`MCP server ${id} URL must be a valid HTTP or HTTPS URL.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`MCP server ${id} URL must use HTTP or HTTPS.`);
  if (url.username || url.password) throw new Error(`MCP server ${id} URL must not include credentials.`);
  if (url.hash) throw new Error(`MCP server ${id} URL must not include a fragment.`);
  if (url.search) throw new Error(`MCP server ${id} URL must not include query parameters.`);
  return url.toString();
}

function normalizedHttpAuth(value: unknown, id: string): HttpMcpServerConfig["auth"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP HTTP server ${id} auth must be a bearer credential reference.`);
  const auth = value as Record<string, unknown>;
  for (const key of Object.keys(auth)) if (key !== "type" && key !== "credentialId") throw new Error(`Unknown MCP auth config key: ${key}`);
  if (auth.type !== "bearer") throw new Error(`MCP HTTP server ${id} auth type must be bearer.`);
  if (auth.credentialId !== undefined && (typeof auth.credentialId !== "string" || !CREDENTIAL_ID_PATTERN.test(auth.credentialId))) {
    throw new Error(`MCP HTTP server ${id} credential ID must use letters, numbers, hyphens, and underscores only.`);
  }
  return { type: "bearer", ...(auth.credentialId === undefined ? {} : { credentialId: auth.credentialId }) };
}

function permitsBearerOverHttp(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "https:" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
}

function normalizeConfig(value: McpServerConfig): McpServerConfig {
  const config = value as Record<string, unknown>;
  const id = config.id;
  if (typeof id !== "string" || !SERVER_ID_PATTERN.test(id)) throw new Error("MCP server ID must use letters, numbers, hyphens, and underscores only.");
  const transport = config.transport;
  if (transport !== undefined && transport !== "stdio" && transport !== "http") throw new Error(`MCP server ${id} transport must be stdio or http.`);
  const operation = normalizedOperation(config.operation, id);
  if (transport === "http") {
    if (config.command !== undefined || config.args !== undefined || config.env !== undefined) {
      throw new Error(`MCP HTTP server ${id} must not include stdio command, args, or env settings.`);
    }
    const auth = normalizedHttpAuth(config.auth, id);
    const url = normalizedHttpUrl(config.url, id);
    if (auth && !permitsBearerOverHttp(url)) throw new Error(`MCP HTTP server ${id} bearer auth requires HTTPS or loopback HTTP.`);
    return { id, transport: "http", url, ...(auth ? { auth } : {}), ...(operation ? { operation } : {}) };
  }
  if (config.url !== undefined) throw new Error(`MCP server ${id} URL requires transport: http.`);
  if (config.auth !== undefined) throw new Error(`MCP stdio server ${id} must not include HTTP auth settings.`);
  if (typeof config.command !== "string" || !config.command.trim()) throw new Error(`MCP server ${id} command must be a non-empty string.`);
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((argument) => typeof argument !== "string"))) {
    throw new Error(`MCP server ${id} args must be strings.`);
  }
  const args = config.args as string[] | undefined;
  if (args?.some((argument) => CREDENTIAL_ARGUMENT_PATTERN.test(argument))) {
    throw new Error(`MCP server ${id} args must not contain credential-like arguments.`);
  }
  const environment = config.env;
  if (environment !== undefined) {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error(`MCP server ${id} env must be a safe environment object.`);
    for (const [key, environmentValue] of Object.entries(environment)) {
      if ((!SAFE_ENVIRONMENT_NAMES.has(key) && !key.startsWith("XDG_")) || SECRET_ENVIRONMENT_PATTERN.test(key)
        || typeof environmentValue !== "string" || SECRET_ENVIRONMENT_PATTERN.test(environmentValue) || environmentValue.length > 2048) {
        throw new Error(`MCP server ${id} env must contain only safe environment values.`);
      }
    }
  }
  return { id, ...(transport === "stdio" ? { transport: "stdio" as const } : {}), command: config.command.trim(), args: args ? [...args] : [], ...(environment ? { env: { ...(environment as Record<string, string>) } } : {}), ...(operation ? { operation } : {}) };
}

/** Produces a stable, provider-safe namespace without trusting arbitrary server tool names. */
function mappedToolName(serverId: string, toolName: string): string {
  const candidate = `mcp__${serverId}__${toolName}`;
  if (!serverId.includes("__") && !toolName.includes("__") && PROVIDER_TOOL_NAME_PATTERN.test(candidate) && redactMcpText(toolName) === toolName && redactMcpText(candidate) === candidate) return candidate;
  const digest = createHash("sha256").update(`${serverId}\0${toolName}`, "utf8").digest("hex").slice(0, 24);
  return `mcp__${digest}`;
}

function mappedCapabilityName(serverId: string, type: "resource" | "prompt", originalName: string): string {
  const digest = createHash("sha256").update(`${serverId}\0${type}\0${originalName}`, "utf8").digest("hex").slice(0, 24);
  return `mcp__${type}__${digest}`;
}

/** Parse one config entry; config values are app-owned and never include secret transport credentials. */
export function parseMcpServerConfig(value: unknown): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP server config must be an object.");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) if (!new Set(["id", "transport", "command", "args", "env", "url", "auth", "operation"]).has(key)) throw new Error(`Unknown MCP server config key: ${key}`);
  return normalizeConfig(config as McpServerConfig);
}

export function parseMcpServerConfigs(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) throw new Error("MCP servers must be an array.");
  if (value.length > DEFAULT_MAX_MCP_SERVERS) throw new Error(`Dragons supports at most ${DEFAULT_MAX_MCP_SERVERS} MCP servers.`);
  const servers = value.map(parseMcpServerConfig);
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`MCP server ID is duplicated: ${server.id}`);
    ids.add(server.id);
  }
  return servers;
}

export class McpClientManager {
  private readonly configs: Map<string, McpServerConfig>;
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<AgentTool[]>>();
  private activeConnectionCount = 0;
  private readonly connectionWaiters: Array<() => void> = [];
  private readonly options: Required<McpClientOptions>;
  private readonly credentialStore: Pick<McpBearerTokenStore, "load">;

  constructor(configs: readonly McpServerConfig[] = [], options: McpClientOptions = {}) {
    const normalized = parseMcpServerConfigs(configs);
    this.configs = new Map(normalized.map((config) => [config.id, config]));
    this.credentialStore = options.credentialStore ?? createNativeMcpBearerTokenStore();
    this.options = {
      connectTimeoutMilliseconds: positiveInteger(options.connectTimeoutMilliseconds, DEFAULT_MCP_CONNECT_TIMEOUT_MILLISECONDS),
      toolTimeoutMilliseconds: positiveInteger(options.toolTimeoutMilliseconds, DEFAULT_MCP_TOOL_TIMEOUT_MILLISECONDS),
      maxConcurrentConnections: positiveInteger(options.maxConcurrentConnections, DEFAULT_MAX_MCP_CONCURRENT_CONNECTIONS),
      maxTools: positiveInteger(options.maxTools, DEFAULT_MAX_MCP_TOOLS),
      maxTotalTools: positiveInteger(options.maxTotalTools, DEFAULT_MAX_MCP_TOTAL_TOOLS),
      maxSchemaBytes: positiveInteger(options.maxSchemaBytes, DEFAULT_MAX_MCP_SCHEMA_BYTES),
      maxTotalSchemaBytes: positiveInteger(options.maxTotalSchemaBytes, DEFAULT_MAX_MCP_TOTAL_SCHEMA_BYTES),
      maxOutputBytes: positiveInteger(options.maxOutputBytes, DEFAULT_MAX_MCP_OUTPUT_BYTES),
      credentialStore: this.credentialStore,
    };
  }

  list(): McpServerConfig[] { return [...this.configs.values()].map((config) => structuredClone(config)); }
  tools(): AgentTool[] { return [...this.connections.values()].filter((connection) => connection.state === "connected").flatMap((connection) => connection.tools); }
  toolsFor(id: string): AgentTool[] {
    const connection = this.connections.get(id);
    return connection?.state === "connected" ? [...connection.tools] : [];
  }
  capabilities(): McpCapability[] {
    return [...this.connections.values()].filter((connection) => connection.state === "connected").flatMap((connection) => structuredClone(connection.capabilityMetadata));
  }
  status(): McpServerStatus[] {
    return this.list().map((config) => {
      const connection = this.connections.get(config.id);
      return {
        id: config.id,
        transport: transportOf(config),
        authentication: config.transport === "http" && config.auth ? "bearer" : "none",
        state: connection?.state ?? "disconnected",
        toolCount: connection?.state === "connected" ? connection.tools.length : 0,
        resourceCount: connection?.state === "connected" ? connection.capabilityMetadata.filter((capability) => capability.type === "resource").length : 0,
        promptCount: connection?.state === "connected" ? connection.capabilityMetadata.filter((capability) => capability.type === "prompt").length : 0,
        toolNames: connection?.state === "connected" ? connection.capabilityMetadata.filter((capability) => capability.type === "tool").map((capability) => capability.name) : [],
        capabilities: connection?.capabilities ?? { tools: false },
        callCount: connection?.callCount ?? 0,
        failureCount: connection?.failureCount ?? 0,
        cancellationCount: connection?.cancellationCount ?? 0,
        ...(connection?.connectDurationMilliseconds !== undefined ? { connectDurationMilliseconds: connection.connectDurationMilliseconds } : {}),
        ...(connection?.discoveryDurationMilliseconds !== undefined ? { discoveryDurationMilliseconds: connection.discoveryDurationMilliseconds } : {}),
        ...(connection?.lastInvocationDurationMilliseconds !== undefined ? { lastInvocationDurationMilliseconds: connection.lastInvocationDurationMilliseconds } : {}),
        ...(connection?.lastFailureCategory ? { lastFailureCategory: connection.lastFailureCategory } : {}),
        ...(connection?.protocolVersion ? { protocolVersion: connection.protocolVersion } : {}),
        ...(connection?.lastError ? { lastError: connection.lastError } : {}),
      };
    });
  }

  async connect(id: string, existingTools: readonly AgentTool[] = [], signal?: AbortSignal): Promise<AgentTool[]> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const ongoing = this.connecting.get(id);
    if (ongoing) return ongoing;
    const connecting = this.connectWithinLimit(id, existingTools, signal);
    this.connecting.set(id, connecting);
    try {
      return await connecting;
    } finally {
      if (this.connecting.get(id) === connecting) this.connecting.delete(id);
    }
  }

  private async connectWithinLimit(id: string, existingTools: readonly AgentTool[], signal?: AbortSignal): Promise<AgentTool[]> {
    await this.acquireConnectionSlot(signal);
    try {
      return await this.connectOnce(id, existingTools, signal);
    } finally {
      this.releaseConnectionSlot();
    }
  }

  private async acquireConnectionSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.activeConnectionCount < this.options.maxConcurrentConnections) {
      this.activeConnectionCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", abort);
        this.activeConnectionCount += 1;
        resolve();
      };
      const abort = (): void => {
        const index = this.connectionWaiters.indexOf(grant);
        if (index >= 0) this.connectionWaiters.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      this.connectionWaiters.push(grant);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private releaseConnectionSlot(): void {
    this.activeConnectionCount -= 1;
    this.connectionWaiters.shift()?.();
  }

  async connectAll(existingTools: readonly AgentTool[] = [], signal?: AbortSignal): Promise<McpConnectAllResult> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const ids = [...this.configs.keys()];
    const outcomes = new Map<string, boolean>();
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= ids.length) return;
        const id = ids[index]!;
        try {
          await this.connect(id, [...existingTools, ...this.tools()], signal);
          outcomes.set(id, true);
        } catch {
          outcomes.set(id, false);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ids.length, this.options.maxConcurrentConnections) }, worker));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return {
      connected: ids.filter((id) => outcomes.get(id) === true),
      failed: ids.filter((id) => outcomes.get(id) === false),
    };
  }

  private async connectOnce(id: string, existingTools: readonly AgentTool[] = [], signal?: AbortSignal): Promise<AgentTool[]> {
    const config = this.configs.get(id);
    if (!config) throw new Error(`MCP server is not configured: ${id}`);
    const current = this.connections.get(id);
    if (current?.state === "connected") return current.tools;
    const client = new Client({ name: "dragons-agent", version: "0.1.0" });
    const sensitiveValues = new Set<string>();
    const transport = this.createTransport(config, sensitiveValues);
    const connection: Connection = { config, client, transport, sensitiveValues, tools: [], capabilityMetadata: [], state: "disconnected", capabilities: { tools: false }, callCount: 0, failureCount: 0, cancellationCount: 0 };
    transport.onerror = () => { connection.lastError = "MCP transport error."; };
    transport.onclose = () => {
      connection.state = "disconnected";
      connection.tools = [];
      connection.capabilityMetadata = [];
      connection.capabilities = { tools: false };
      connection.sensitiveValues.clear();
    };
    this.connections.set(id, connection);
    let phase: "connection" | "discovery" = "connection";
    try {
      const connectStartedAt = Date.now();
      await timeout(client.connect(transport), this.options.connectTimeoutMilliseconds, signal, `MCP server ${id} connection timed out.`);
      connection.connectDurationMilliseconds = Date.now() - connectStartedAt;
      connection.protocolVersion = client.getNegotiatedProtocolVersion();
      const capabilities = client.getServerCapabilities();
      connection.capabilities = { tools: Boolean(capabilities?.tools) };
      if (!connection.protocolVersion || !connection.capabilities.tools) {
        throw new Error(`MCP server ${id} did not negotiate the required tools capability.`);
      }
      phase = "discovery";
      const discoveryStartedAt = Date.now();
      const listed = await timeout(client.listTools(), this.options.connectTimeoutMilliseconds, signal, `MCP server ${id} tool discovery timed out.`);
      connection.discoveryDurationMilliseconds = Date.now() - discoveryStartedAt;
      if (listed.tools.length > this.options.maxTools) throw new Error(`MCP server ${id} exposes more than ${this.options.maxTools} tools.`);
      if (this.tools().length + listed.tools.length > this.options.maxTotalTools) {
        throw new Error(`MCP tools across connected servers exceed ${this.options.maxTotalTools}.`);
      }
      const names = new Set(existingTools.map((tool) => tool.name));
      let totalSchemaBytes = 0;
      const tools = listed.tools.map((tool) => {
        if (!tool.name || typeof tool.name !== "string") throw new Error(`MCP server ${id} returned a tool without a name.`);
        if (Buffer.byteLength(tool.name, "utf8") > MAX_MCP_SERVER_TOOL_NAME_BYTES) throw new Error(`MCP server ${id} tool name exceeds ${MAX_MCP_SERVER_TOOL_NAME_BYTES} bytes.`);
        if (typeof tool.description === "string" && Buffer.byteLength(tool.description, "utf8") > MAX_MCP_SERVER_TOOL_DESCRIPTION_BYTES) {
          throw new Error(`MCP server ${id} tool description exceeds ${MAX_MCP_SERVER_TOOL_DESCRIPTION_BYTES} bytes.`);
        }
        const name = mappedToolName(id, tool.name);
        if (names.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
        names.add(name);
        const inputSchema = schemaFrom(tool.inputSchema);
        const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema), "utf8");
        if (schemaBytes > this.options.maxSchemaBytes) throw new Error(`MCP tool ${name} schema exceeds ${this.options.maxSchemaBytes} bytes.`);
        totalSchemaBytes += schemaBytes;
        if (totalSchemaBytes > this.options.maxTotalSchemaBytes) throw new Error(`MCP tool schemas exceed ${this.options.maxTotalSchemaBytes} bytes.`);
        return this.agentTool(connection, name, tool.name, tool.description ?? "MCP tool", inputSchema, config.operation ?? "EXECUTE");
      });
      connection.tools = tools;
      const resources = capabilities?.resources
        ? await timeout(client.listResources(), this.options.connectTimeoutMilliseconds, signal, `MCP server ${id} resource discovery timed out.`)
        : { resources: [] };
      const prompts = capabilities?.prompts
        ? await timeout(client.listPrompts(), this.options.connectTimeoutMilliseconds, signal, `MCP server ${id} prompt discovery timed out.`)
        : { prompts: [] };
      if (resources.resources.length > this.options.maxTools) throw new Error(`MCP server ${id} exposes more than ${this.options.maxTools} resources.`);
      if (prompts.prompts.length > this.options.maxTools) throw new Error(`MCP server ${id} exposes more than ${this.options.maxTools} prompts.`);
      for (const resource of resources.resources) {
        if (!resource.uri || Buffer.byteLength(resource.uri, "utf8") > MAX_MCP_SERVER_TOOL_NAME_BYTES || Buffer.byteLength(resource.name, "utf8") > MAX_MCP_SERVER_TOOL_NAME_BYTES || (resource.mimeType && Buffer.byteLength(resource.mimeType, "utf8") > MAX_MCP_SERVER_TOOL_NAME_BYTES)) {
          throw new Error(`MCP server ${id} returned oversized resource metadata.`);
        }
      }
      for (const prompt of prompts.prompts) {
        if (!prompt.name || Buffer.byteLength(prompt.name, "utf8") > MAX_MCP_SERVER_TOOL_NAME_BYTES || (prompt.description && Buffer.byteLength(prompt.description, "utf8") > MAX_MCP_SERVER_TOOL_DESCRIPTION_BYTES)) {
          throw new Error(`MCP server ${id} returned oversized prompt metadata.`);
        }
      }
      connection.capabilityMetadata = [
        ...listed.tools.map((tool): McpCapability => ({ serverId: id, transport: transportOf(config), state: "connected", type: "tool", originalName: redactMcpText(tool.name, sensitiveValues), name: mappedToolName(id, tool.name), operation: config.operation ?? "EXECUTE" })),
        ...resources.resources.map((resource): McpCapability => ({ serverId: id, transport: transportOf(config), state: "connected", type: "resource", originalName: redactMcpText(resource.name, sensitiveValues), name: mappedCapabilityName(id, "resource", resource.uri), uri: redactMcpText(resource.uri, sensitiveValues), ...(resource.mimeType ? { mimeType: redactMcpText(resource.mimeType, sensitiveValues) } : {}) })),
        ...prompts.prompts.map((prompt): McpCapability => ({ serverId: id, transport: transportOf(config), state: "connected", type: "prompt", originalName: redactMcpText(prompt.name, sensitiveValues), name: mappedCapabilityName(id, "prompt", prompt.name), ...(prompt.description ? { description: redactMcpText(prompt.description, sensitiveValues) } : {}) })),
      ];
      // Resource/prompt discovery above awaits: another connection may have
      // published its tools meanwhile. Check and publish without another await.
      if (this.tools().length + tools.length > this.options.maxTotalTools) {
        throw new Error(`MCP tools across connected servers exceed ${this.options.maxTotalTools}.`);
      }
      connection.state = "connected";
      return tools;
    } catch (error: unknown) {
      connection.lastError = "MCP connection or discovery failed.";
      connection.lastFailureCategory = failureCategory(error, phase, signal);
      await this.close(id);
      if (connection.lastFailureCategory === "authentication") {
        throw new Error("MCP authentication required or rejected.");
      }
      if (isAuthenticatedHttp(config)) throw new Error("MCP connection or discovery failed.");
      const message = redactMcpText(errorMessage(error), connection.sensitiveValues);
      if (error instanceof Error && message === error.message) throw error;
      throw new Error(message);
    }
  }

  async disconnect(id: string): Promise<void> {
    if (!this.configs.has(id)) throw new Error(`MCP server is not configured: ${id}`);
    await this.close(id);
  }

  /** Resource and prompt payloads remain explicit caller requests; they are never injected during discovery. */
  async listResources(id: string, signal?: AbortSignal): Promise<Array<{ uri: string; name: string; mimeType?: string }>> {
    const result = await this.resourceOperation(id, signal, (client) => client.listResources());
    return result.resources.map((resource) => ({ uri: resource.uri, name: resource.name, ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) }));
  }

  async readResource(id: string, uri: string, signal?: AbortSignal): Promise<Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>> {
    if (!uri || Buffer.byteLength(uri, "utf8") > 4_096) throw new Error("MCP resource URI is invalid.");
    const result = await this.resourceOperation(id, signal, (client) => client.readResource({ uri }));
    return result.contents.map((content) => ({ uri: content.uri, ...("text" in content ? { text: boundedOutput(redactMcpText(content.text, this.connections.get(id)?.sensitiveValues), this.options.maxOutputBytes) } : { blob: boundedOutput(redactMcpText(content.blob, this.connections.get(id)?.sensitiveValues), this.options.maxOutputBytes) }), ...(content.mimeType ? { mimeType: content.mimeType } : {}) }));
  }

  async listPrompts(id: string, signal?: AbortSignal): Promise<Array<{ name: string; description?: string }>> {
    const result = await this.resourceOperation(id, signal, (client) => client.listPrompts());
    return result.prompts.map((prompt) => ({ name: prompt.name, ...(prompt.description ? { description: prompt.description } : {}) }));
  }

  async getPrompt(id: string, name: string, signal?: AbortSignal): Promise<unknown[]> {
    if (!name || Buffer.byteLength(name, "utf8") > 4_096) throw new Error("MCP prompt name is invalid.");
    const result = await this.resourceOperation(id, signal, (client) => client.getPrompt({ name }));
    const output = redactMcpText(JSON.stringify(result.messages), this.connections.get(id)?.sensitiveValues);
    if (Buffer.byteLength(output, "utf8") > this.options.maxOutputBytes) throw new Error(`MCP prompt exceeds ${this.options.maxOutputBytes} bytes.`);
    return JSON.parse(output) as unknown[];
  }

  private async resourceOperation<T>(id: string, signal: AbortSignal | undefined, operation: (client: Client) => Promise<T>): Promise<T> {
    const connection = this.connections.get(id);
    if (!connection || connection.state !== "connected") throw new Error(`MCP server ${id} is disconnected.`);
    try {
      connection.callCount += 1;
      return await timeout(operation(connection.client), this.options.toolTimeoutMilliseconds, signal, `MCP resource or prompt request timed out after ${this.options.toolTimeoutMilliseconds}ms.`);
    } catch (error: unknown) {
      connection.failureCount += 1;
      connection.lastFailureCategory = failureCategory(error, "tool", signal);
      if (signal?.aborted) { connection.cancellationCount += 1; throw new Error("MCP resource or prompt request cancelled."); }
      if (isAuthenticatedHttp(connection.config)) throw new Error("MCP resource or prompt request failed.");
      throw new Error(redactMcpText(`MCP resource or prompt request failed: ${errorMessage(error)}`, connection.sensitiveValues));
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.configs.keys()].map(async (id) => {
      const connecting = this.connecting.get(id);
      if (connecting) await connecting.catch(() => undefined);
      await this.close(id);
    }));
  }

  private async close(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.state = "disconnected";
    connection.tools = [];
    connection.capabilityMetadata = [];
    try {
      if (connection.transport instanceof StreamableHTTPClientTransport) {
        await timeout(
          connection.transport.terminateSession(),
          Math.min(this.options.connectTimeoutMilliseconds, DEFAULT_MCP_HTTP_SESSION_TERMINATION_TIMEOUT_MILLISECONDS),
          undefined,
          "MCP HTTP session termination timed out.",
        ).catch(() => undefined);
      }
    } finally {
      try { await connection.client.close(); }
      catch { try { await connection.transport.close(); } catch { /* already closed */ } }
      connection.sensitiveValues.clear();
    }
  }

  private createTransport(config: McpServerConfig, sensitiveValues: Set<string>): StdioClientTransport | StreamableHTTPClientTransport {
    if (config.transport === "http") {
      const scope: McpCredentialScope | undefined = config.auth
        ? { serverId: config.id, origin: new URL(config.url).origin, credentialId: config.auth.credentialId ?? "default" }
        : undefined;
      return new StreamableHTTPClientTransport(new URL(config.url), {
        ...(scope ? {
          authProvider: {
            token: async () => {
              const token = await this.credentialStore.load(scope);
              if (token) sensitiveValues.add(token);
              return token;
            },
          },
          onInsufficientScope: "throw" as const,
        } : {}),
        fetch: async (input, init) => {
          const response = await fetch(input, { ...(init ?? {}), redirect: "error" });
          if (scope && (response.status === 401 || response.status === 403)) throw new McpAuthenticationError();
          return boundedHttpResponse(response, DEFAULT_MAX_MCP_HTTP_RESPONSE_BYTES);
        },
        reconnectionOptions: {
          initialReconnectionDelay: 100,
          maxReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
      });
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "pipe",
      maxBufferSize: DEFAULT_MAX_MCP_TRANSPORT_BUFFER_BYTES,
    });
  }

  private agentTool(connection: Connection, mappedName: string, serverToolName: string, description: string, inputSchema: Record<string, unknown>, operation: ToolOperation): AgentTool {
    return {
      name: mappedName,
      operation,
      description,
      inputSchema: inputSchema as AgentTool["inputSchema"],
      execute: async (input: unknown, execution: ToolExecutionOptions = {}): Promise<ToolResult> => {
        if (!isArgumentsObject(input)) return { ok: false, output: "MCP tool arguments must be a JSON-serializable object." };
        if (connection.state !== "connected") return { ok: false, output: `MCP server ${connection.config.id} is disconnected.` };
        const invocationStartedAt = Date.now();
        try {
          connection.callCount += 1;
          const result = await timeout(connection.client.callTool({ name: serverToolName, arguments: structuredClone(input) }, { signal: execution.signal }), this.options.toolTimeoutMilliseconds, execution.signal, `MCP tool call timed out after ${this.options.toolTimeoutMilliseconds}ms.`);
          if (result.isError) {
            connection.failureCount += 1;
            connection.lastFailureCategory = "tool";
          }
          if (result.isError && isAuthenticatedHttp(connection.config)) return { ok: false, output: "MCP tool reported failure." };
          return { ok: !result.isError, output: boundedOutput(redactMcpText(JSON.stringify(result.content), connection.sensitiveValues), this.options.maxOutputBytes) };
        } catch (error: unknown) {
          const cancelled = execution.signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
          const timedOut = error instanceof Error && error.message.startsWith("MCP tool call timed out");
          connection.lastFailureCategory = failureCategory(error, "tool", execution.signal);
          if (cancelled || timedOut) await this.close(connection.config.id);
          if (cancelled) { connection.cancellationCount += 1; return { ok: false, output: "MCP tool call cancelled." }; }
          if (timedOut) { connection.failureCount += 1; return { ok: false, output: error.message }; }
          connection.failureCount += 1;
          if (connection.lastFailureCategory === "authentication") return { ok: false, output: "MCP authentication required or rejected." };
          if (isAuthenticatedHttp(connection.config)) return { ok: false, output: "MCP authenticated HTTP tool call failed." };
          return { ok: false, output: boundedOutput(redactMcpText(`MCP tool ${mappedName} failed: ${errorMessage(error)}`, connection.sensitiveValues), this.options.maxOutputBytes) };
        } finally {
          connection.lastInvocationDurationMilliseconds = Date.now() - invocationStartedAt;
        }
      },
    };
  }
}
