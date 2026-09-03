import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import type { AgentTool, ToolExecutionOptions, ToolOperation, ToolResult } from "./tools.js";

export const DEFAULT_MCP_CONNECT_TIMEOUT_MILLISECONDS = 10_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MILLISECONDS = 30_000;
export const DEFAULT_MAX_MCP_TOOLS = 64;
export const DEFAULT_MAX_MCP_SCHEMA_BYTES = 16_384;
export const DEFAULT_MAX_MCP_TOTAL_SCHEMA_BYTES = 262_144;
export const DEFAULT_MAX_MCP_OUTPUT_BYTES = 65_536;
export const DEFAULT_MAX_MCP_TRANSPORT_BUFFER_BYTES = 1_048_576;

const MAX_MCP_SERVER_TOOL_NAME_BYTES = 4_096;
const MAX_MCP_SERVER_TOOL_DESCRIPTION_BYTES = 16_384;

const SAFE_ENVIRONMENT_NAMES = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "NO_COLOR", "TZ", "NODE_ENV"]);
const SECRET_ENVIRONMENT_PATTERN = /(?:secret|token|password|credential|authorization|api[_-]?key|bearer)/i;
const SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CREDENTIAL_ARGUMENT_PATTERN = /^--?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|authorization|auth)(?:=|$)|^(?:Bearer\s+|sk-|rk-)/i;

export type McpServerConfig = {
  id: string;
  command: string;
  args?: string[];
  /** Safe, non-secret overrides only. The subprocess otherwise receives the SDK's safe default environment. */
  env?: Record<string, string>;
  operation?: ToolOperation;
};

export type McpClientOptions = {
  connectTimeoutMilliseconds?: number;
  toolTimeoutMilliseconds?: number;
  maxTools?: number;
  maxSchemaBytes?: number;
  maxTotalSchemaBytes?: number;
  maxOutputBytes?: number;
};

export type McpServerStatus = {
  id: string;
  state: "disconnected" | "connected";
  toolCount: number;
  /** Safe negotiated MCP metadata only; no server payloads or transport details. */
  protocolVersion?: string;
  capabilities: { tools: boolean };
  callCount: number;
  failureCount: number;
  cancellationCount: number;
  lastError?: string;
};

type Connection = {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: AgentTool[];
  state: "connected" | "disconnected";
  protocolVersion?: string;
  capabilities: { tools: boolean };
  callCount: number;
  failureCount: number;
  cancellationCount: number;
  lastError?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unexpected MCP error.";
}

function boundedOutput(output: string, maximum: number): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= maximum) return output;
  const marker = `[MCP output truncated at ${maximum} bytes]`;
  const available = Math.max(0, maximum - Buffer.byteLength(`\n${marker}`));
  return `${bytes.subarray(0, available).toString("utf8")}\n${marker}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(1, Math.floor(value));
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

function normalizeConfig(value: McpServerConfig): McpServerConfig {
  if (!SERVER_ID_PATTERN.test(value.id)) throw new Error("MCP server ID must use letters, numbers, hyphens, and underscores only.");
  if (typeof value.command !== "string" || !value.command.trim()) throw new Error(`MCP server ${value.id} command must be a non-empty string.`);
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== "string"))) {
    throw new Error(`MCP server ${value.id} args must be strings.`);
  }
  if (value.args?.some((argument) => CREDENTIAL_ARGUMENT_PATTERN.test(argument))) {
    throw new Error(`MCP server ${value.id} args must not contain credential-like arguments.`);
  }
  if (value.operation !== undefined && !["READ", "WRITE", "EXECUTE"].includes(value.operation)) {
    throw new Error(`MCP server ${value.id} operation must be READ, WRITE, or EXECUTE.`);
  }
  if (value.env !== undefined) {
    if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) throw new Error(`MCP server ${value.id} env must be a safe environment object.`);
    for (const [key, environmentValue] of Object.entries(value.env)) {
      if ((!SAFE_ENVIRONMENT_NAMES.has(key) && !key.startsWith("XDG_")) || SECRET_ENVIRONMENT_PATTERN.test(key)
        || typeof environmentValue !== "string" || SECRET_ENVIRONMENT_PATTERN.test(environmentValue) || environmentValue.length > 2048) {
        throw new Error(`MCP server ${value.id} env must contain only safe environment values.`);
      }
    }
  }
  return { id: value.id, command: value.command.trim(), args: value.args ? [...value.args] : [], ...(value.env ? { env: { ...value.env } } : {}), ...(value.operation ? { operation: value.operation } : {}) };
}

/** Produces a stable, provider-safe namespace without trusting arbitrary server tool names. */
function mappedToolName(serverId: string, toolName: string): string {
  const direct = `mcp__${serverId}__${toolName}`;
  if (PROVIDER_TOOL_NAME_PATTERN.test(direct)) return direct;
  const digest = createHash("sha256").update(`${serverId}\0${toolName}`, "utf8").digest("hex").slice(0, 24);
  return `mcp__${serverId.slice(0, 24)}__${digest}`;
}

/** Parse one config entry; config values are app-owned and never include secret transport credentials. */
export function parseMcpServerConfig(value: unknown): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP server config must be an object.");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) if (!new Set(["id", "command", "args", "env", "operation"]).has(key)) throw new Error(`Unknown MCP server config key: ${key}`);
  return normalizeConfig(config as McpServerConfig);
}

export function parseMcpServerConfigs(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) throw new Error("MCP servers must be an array.");
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
  private readonly options: Required<McpClientOptions>;

  constructor(configs: readonly McpServerConfig[] = [], options: McpClientOptions = {}) {
    const normalized = parseMcpServerConfigs(configs);
    this.configs = new Map(normalized.map((config) => [config.id, config]));
    this.options = {
      connectTimeoutMilliseconds: positiveInteger(options.connectTimeoutMilliseconds, DEFAULT_MCP_CONNECT_TIMEOUT_MILLISECONDS),
      toolTimeoutMilliseconds: positiveInteger(options.toolTimeoutMilliseconds, DEFAULT_MCP_TOOL_TIMEOUT_MILLISECONDS),
      maxTools: positiveInteger(options.maxTools, DEFAULT_MAX_MCP_TOOLS),
      maxSchemaBytes: positiveInteger(options.maxSchemaBytes, DEFAULT_MAX_MCP_SCHEMA_BYTES),
      maxTotalSchemaBytes: positiveInteger(options.maxTotalSchemaBytes, DEFAULT_MAX_MCP_TOTAL_SCHEMA_BYTES),
      maxOutputBytes: positiveInteger(options.maxOutputBytes, DEFAULT_MAX_MCP_OUTPUT_BYTES),
    };
  }

  list(): McpServerConfig[] { return [...this.configs.values()].map((config) => structuredClone(config)); }
  tools(): AgentTool[] { return [...this.connections.values()].filter((connection) => connection.state === "connected").flatMap((connection) => connection.tools); }
  toolsFor(id: string): AgentTool[] {
    const connection = this.connections.get(id);
    return connection?.state === "connected" ? [...connection.tools] : [];
  }
  status(): McpServerStatus[] {
    return this.list().map((config) => {
      const connection = this.connections.get(config.id);
      return {
        id: config.id,
        state: connection?.state ?? "disconnected",
        toolCount: connection?.state === "connected" ? connection.tools.length : 0,
        capabilities: connection?.capabilities ?? { tools: false },
        callCount: connection?.callCount ?? 0,
        failureCount: connection?.failureCount ?? 0,
        cancellationCount: connection?.cancellationCount ?? 0,
        ...(connection?.protocolVersion ? { protocolVersion: connection.protocolVersion } : {}),
        ...(connection?.lastError ? { lastError: connection.lastError } : {}),
      };
    });
  }

  async connect(id: string, existingTools: readonly AgentTool[] = [], signal?: AbortSignal): Promise<AgentTool[]> {
    const ongoing = this.connecting.get(id);
    if (ongoing) return ongoing;
    const connecting = Promise.resolve().then(() => this.connectOnce(id, existingTools, signal));
    this.connecting.set(id, connecting);
    try {
      return await connecting;
    } finally {
      if (this.connecting.get(id) === connecting) this.connecting.delete(id);
    }
  }

  private async connectOnce(id: string, existingTools: readonly AgentTool[] = [], signal?: AbortSignal): Promise<AgentTool[]> {
    const config = this.configs.get(id);
    if (!config) throw new Error(`MCP server is not configured: ${id}`);
    const current = this.connections.get(id);
    if (current?.state === "connected") return current.tools;
    const client = new Client({ name: "dragons-agent", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "pipe",
      maxBufferSize: DEFAULT_MAX_MCP_TRANSPORT_BUFFER_BYTES,
    });
    const connection: Connection = { config, client, transport, tools: [], state: "disconnected", capabilities: { tools: false }, callCount: 0, failureCount: 0, cancellationCount: 0 };
    transport.onerror = () => { connection.lastError = "MCP transport error."; };
    transport.onclose = () => { connection.state = "disconnected"; };
    this.connections.set(id, connection);
    try {
      await timeout(client.connect(transport), this.options.connectTimeoutMilliseconds, signal, `MCP server ${id} connection timed out.`);
      connection.protocolVersion = client.getNegotiatedProtocolVersion();
      const capabilities = client.getServerCapabilities();
      connection.capabilities = { tools: Boolean(capabilities?.tools) };
      if (!connection.protocolVersion || !connection.capabilities.tools) {
        throw new Error(`MCP server ${id} did not negotiate the required tools capability.`);
      }
      const listed = await timeout(client.listTools(), this.options.connectTimeoutMilliseconds, signal, `MCP server ${id} tool discovery timed out.`);
      if (listed.tools.length > this.options.maxTools) throw new Error(`MCP server ${id} exposes more than ${this.options.maxTools} tools.`);
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
      connection.state = "connected";
      return tools;
    } catch (error: unknown) {
      connection.lastError = "MCP connection or discovery failed.";
      await this.close(id);
      throw error;
    }
  }

  async disconnect(id: string): Promise<void> {
    if (!this.configs.has(id)) throw new Error(`MCP server is not configured: ${id}`);
    await this.close(id);
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
    try { await connection.client.close(); }
    catch { try { await connection.transport.close(); } catch { /* already closed */ } }
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
        try {
          connection.callCount += 1;
          const result = await timeout(connection.client.callTool({ name: serverToolName, arguments: structuredClone(input) }), this.options.toolTimeoutMilliseconds, execution.signal, `MCP tool call timed out after ${this.options.toolTimeoutMilliseconds}ms.`);
          if (result.isError) connection.failureCount += 1;
          return { ok: !result.isError, output: boundedOutput(JSON.stringify(result.content), this.options.maxOutputBytes) };
        } catch (error: unknown) {
          const cancelled = execution.signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
          const timedOut = error instanceof Error && error.message.startsWith("MCP tool call timed out");
          if (cancelled || timedOut) await this.close(connection.config.id);
          if (cancelled) { connection.cancellationCount += 1; return { ok: false, output: "MCP tool call cancelled." }; }
          if (timedOut) { connection.failureCount += 1; return { ok: false, output: error.message }; }
          connection.failureCount += 1;
          return { ok: false, output: boundedOutput(`MCP tool ${mappedName} failed: ${errorMessage(error)}`, this.options.maxOutputBytes) };
        }
      },
    };
  }
}
