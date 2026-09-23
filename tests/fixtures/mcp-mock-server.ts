import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function tools(): Array<Record<string, unknown>> {
  const normal = {
    name: "inspect",
    description: "Inspect a nested value.",
    inputSchema: {
      type: "object",
      properties: {
        nested: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      required: ["nested"],
    },
  };
  if (mode === "duplicate") return [normal, { ...normal }];
  if (mode === "collision-left") return [{ ...normal, name: "b__c" }];
  if (mode === "collision-right") return [{ ...normal, name: "c" }];
  if (mode === "two-schemas") return [normal, { ...normal, name: "inspect-two" }];
  if (mode === "large-schema") return [{ ...normal, inputSchema: { type: "object", description: "x".repeat(20_000) } }];
  if (mode === "large-name") return [{ ...normal, name: "n".repeat(4_097) }];
  if (mode === "large-description") return [{ ...normal, description: "d".repeat(16_385) }];
  if (mode === "secret-metadata") return [{ ...normal, name: "token=fixture-private-marker" }];
  return [normal];
}

if (mode === "malformed") {
  process.stdout.write("{not-json}\n");
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let request: Record<string, unknown>;
    try { request = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    const id = request.id;
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
      return;
    }
    if (request.method === "tools/list") {
      if (mode === "list-error") {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: "server-secret-marker" } });
        return;
      }
      const response = { jsonrpc: "2.0", id, result: { tools: tools() } };
      if (mode === "slow-list") setTimeout(() => send(response), 100);
      else send(response);
      return;
    }
    if (request.method === "tools/call") {
      if (mode === "exit-on-call") process.exit(1);
      if (mode === "wait") return;
      const params = request.params as Record<string, unknown>;
      const args = params.arguments as { nested?: { query?: string } };
      const text = mode === "large-result" ? "x".repeat(70_000) : `result:${args.nested?.query ?? ""}`;
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      return;
    }
    if (request.method === "resources/list") { send({ jsonrpc: "2.0", id, result: { resources: [{ uri: mode === "secret-metadata" ? "fixture://token=fixture-private-marker" : "fixture://note", name: mode === "secret-metadata" ? "token=fixture-private-marker" : "Note", mimeType: "text/plain" }] } }); return; }
    if (request.method === "resources/read") { send({ jsonrpc: "2.0", id, result: { contents: [{ uri: "fixture://note", text: "fixture resource" }] } }); return; }
    if (request.method === "prompts/list") { send({ jsonrpc: "2.0", id, result: { prompts: [{ name: mode === "secret-metadata" ? "token=fixture-private-marker" : "fixture-prompt", description: mode === "secret-metadata" ? "token=fixture-private-marker" : "Fixture prompt" }] } }); return; }
    if (request.method === "prompts/get") { send({ jsonrpc: "2.0", id, result: { messages: [{ role: "user", content: { type: "text", text: "fixture prompt body" } }] } }); }
  });
}
