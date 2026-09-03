import { appendFileSync } from "node:fs";

import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

type FixtureInput = { nested: { query: string } };
type FixtureMode = "normal" | "large-result" | "wait" | "crash" | "tool-error";

const mode = (process.argv[2] ?? "normal") as FixtureMode;
const auditPath = process.argv[3];

if (auditPath) appendFileSync(auditPath, `${process.pid}\n`, "utf8");

const server = new McpServer({ name: "dragons-m32-official-fixture", version: "1.0.0" });

server.registerTool(
  "inspect",
  {
    description: "Inspect a nested value through the official MCP TypeScript SDK.",
    inputSchema: fromJsonSchema<FixtureInput>({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      required: ["nested"],
      additionalProperties: false,
    }),
  },
  async ({ nested }) => {
    if (mode === "crash") process.exit(23);
    if (mode === "wait") return await new Promise<never>(() => undefined);
    if (mode === "tool-error") {
      return { isError: true, content: [{ type: "text" as const, text: `fixture failure:${nested.query}` }] };
    }
    const text = mode === "large-result" ? "x".repeat(1_000) : `result:${nested.query}`;
    return { content: [{ type: "text" as const, text }] };
  },
);

await server.connect(new StdioServerTransport());
