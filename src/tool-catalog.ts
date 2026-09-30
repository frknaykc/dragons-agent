import type { AgentTool, ToolResult } from "./tools.js";

/** Large catalogs keep the everyday coding surface available; other tools require explicit discovery. */
export const TOOL_SEARCH_THRESHOLD = 24;
export const TOOL_SEARCH_NAME = "tool_search";
export const TOOL_DESCRIBE_NAME = "tool_describe";
const MAX_RESULTS = 10;
const MAX_DESCRIBED = 5;
const MAX_ACTIVATED = 32;
const MAX_CATALOG_TOOLS = 2_048;
const MAX_SCHEMA_BYTES = 16_384; // Match the default per-tool MCP schema limit.
const MAX_DESCRIPTION_BYTES = 96_000;
const CORE_NAMES = new Set([
  "list_directory", "read_file", "search_files", "grep", "project_info", "list_symbols",
  "find_symbol", "find_references", "suggest_tests", "review_changes", "git_status",
  "git_diff", "git_log", "write_file", "edit_file", "apply_patch", "shell", "suggest_memory",
]);

function object(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function fail(message: string): ToolResult { return { ok: false, output: message }; }
function clean(text: string, max: number): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max);
}

export type CatalogDescription = { result: ToolResult; activated: AgentTool[] };

/** A fresh instance belongs to one run; neither discovery nor activation is persisted. */
export class ToolCatalog {
  readonly initial: AgentTool[];
  readonly searchTool: AgentTool;
  readonly describeTool: AgentTool;
  private readonly hidden: Map<string, AgentTool>;
  private readonly active = new Set<string>();
  private readonly discovered = new Set<string>();

  constructor(tools: AgentTool[]) {
    if (tools.length > MAX_CATALOG_TOOLS || tools.some((tool) => Buffer.byteLength(tool.name, "utf8") > 128)) {
      throw new Error("Tool catalog exceeds tool count or name length limit.");
    }
    if (tools.some((tool) => tool.name === TOOL_SEARCH_NAME || tool.name === TOOL_DESCRIBE_NAME)) {
      throw new Error("Tool catalog reserved name collision.");
    }
    this.initial = tools.filter((tool) => CORE_NAMES.has(tool.name));
    this.hidden = new Map(tools.filter((tool) => !CORE_NAMES.has(tool.name)).map((tool) => [tool.name, tool]));
    this.searchTool = {
      name: TOOL_SEARCH_NAME, operation: "READ",
      description: "Search available tools by name and description. Returns bounded metadata only, not schemas or execution authority. Call tool_describe to activate a tool before calling it.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "One or more keywords." }, offset: { type: "integer", description: `Optional result offset (0-${MAX_CATALOG_TOOLS - 1}).` } }, required: ["query"], additionalProperties: false },
      execute: async (input) => this.search(input),
    };
    this.describeTool = {
      name: TOOL_DESCRIBE_NAME, operation: "READ",
      description: "Load full input schemas for exact tool names and activate them for this run. Up to 5 names per call; activation does not grant WRITE or EXECUTE approval.",
      inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "Exact tool names from tool_search." } }, required: ["names"], additionalProperties: false },
      execute: async () => fail("Tool descriptions must be handled by runAgent."),
    };
  }

  search(input: unknown): ToolResult {
    if (!object(input) || typeof input.query !== "string" || !input.query.trim() || input.query.length > 120 ||
        (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) >= MAX_CATALOG_TOOLS))) {
      return fail(`Expected a non-empty query (up to 120 characters) and offset between 0 and ${MAX_CATALOG_TOOLS - 1}.`);
    }
    const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [...this.hidden.values()].filter((tool) => {
      const haystack = `${tool.name} ${tool.description.slice(0, 1024)}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const offset = (input.offset as number | undefined) ?? 0;
    const results = matches.slice(offset, offset + MAX_RESULTS).map((tool) => ({
      name: tool.name, operation: tool.operation, description: clean(tool.description, 160),
      activated: this.active.has(tool.name),
    }));
    for (const result of results) this.discovered.add(result.name);
    return { ok: true, output: JSON.stringify({ results, nextOffset: offset + MAX_RESULTS < matches.length ? offset + MAX_RESULTS : null }) };
  }

  /** Return no activation on any invalid, oversized or unknown member of the batch. */
  describe(input: unknown): CatalogDescription {
    if (!object(input) || !Array.isArray(input.names) || input.names.length < 1 || input.names.length > MAX_DESCRIBED ||
        input.names.some((name) => typeof name !== "string") || new Set(input.names).size !== input.names.length) {
      return { result: fail("Expected 1-5 distinct exact tool names."), activated: [] };
    }
    const names = input.names as string[];
    const selected = names.map((name) => this.hidden.get(name));
    if (selected.some((tool) => !tool) || names.some((name) => !this.discovered.has(name))) {
      return { result: fail("Tool name has not been discovered by tool_search."), activated: [] };
    }
    const tools = selected as AgentTool[];
    if (new Set([...this.active, ...names]).size > MAX_ACTIVATED) {
      return { result: fail(`At most ${MAX_ACTIVATED} catalog tools may be activated in one run.`), activated: [] };
    }
    let output: string;
    try {
      const descriptions = tools.map((tool) => {
        const schema = JSON.stringify(tool.inputSchema);
        if (!schema || Buffer.byteLength(schema, "utf8") > MAX_SCHEMA_BYTES) throw new Error("Schema exceeds catalog limit.");
        return { name: tool.name, operation: tool.operation, description: clean(tool.description, 1024), inputSchema: tool.inputSchema };
      });
      output = JSON.stringify({ tools: descriptions });
      if (Buffer.byteLength(output, "utf8") > MAX_DESCRIPTION_BYTES) throw new Error("Description exceeds catalog limit.");
    } catch {
      return { result: fail("Tool schema or description exceeds catalog limit or is invalid."), activated: [] };
    }
    for (const name of names) this.active.add(name);
    return { result: { ok: true, output }, activated: tools };
  }
}
