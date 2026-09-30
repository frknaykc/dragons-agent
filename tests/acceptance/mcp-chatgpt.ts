import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent, type AgentModel } from "../../dist/agent.js";
import { McpClientManager } from "../../dist/mcp-client.js";
import { createChatGPTAuthService } from "../../dist/provider/codex-auth.js";
import { createBuiltInProviderRegistry } from "../../dist/provider/builtins.js";
import type { AgentTool } from "../../dist/tools.js";

const SERVER = "@modelcontextprotocol/server-filesystem@2026.8.31";
const TOOL = "mcp__filesystem_probe__read_text_file";

export function isFixtureRead(input: unknown, path: string): boolean {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).length === 1 && (input as Record<string, unknown>).path === path;
}

/** Opt-in: real external stdio server plus real ChatGPT; no user workspace or config changes. */
export async function runMcpChatgptAcceptance(model: AgentModel): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dragons-live-mcp-"));
  const path = join(directory, "probe.txt");
  const marker = `MCP-${randomUUID()}`;
  const manager = new McpClientManager([
    { id: "filesystem_probe", command: "npx", args: ["-y", SERVER, directory] },
  ], { connectTimeoutMilliseconds: 90_000, toolTimeoutMilliseconds: 10_000 });
  let turns = 0;
  let approvals = 0;
  let calls = 0;
  try {
    await writeFile(path, `${marker}\n`, "utf8");
    const exposed = await manager.connect("filesystem_probe");
    const read = exposed.find(tool => tool.name === TOOL);
    assert.ok(read && read.operation === "EXECUTE", "Expected EXECUTE filesystem read tool was not advertised.");
    const tool: AgentTool = { ...read, async execute(input, options) {
      assert.ok(isFixtureRead(input, path), "Unexpected MCP tool input.");
      calls++;
      const result = await read.execute(input, options);
      assert.ok(result.ok && result.output.includes(marker), "MCP server did not return fixture marker.");
      return result;
    } };
    const bounded: AgentModel = { async respond(request, delta) {
      if (++turns > 4) throw new Error("Provider turn limit reached.");
      const response = await model.respond(request, delta);
      for (const call of response.toolCalls) {
        assert.equal(call.name, TOOL, "Unexpected provider tool call.");
        let input: unknown;
        try { input = JSON.parse(call.arguments) as unknown; } catch { throw new Error("Invalid MCP tool input."); }
        assert.ok(isFixtureRead(input, path), "Unexpected provider tool input.");
      }
      return response;
    } };
    const result = await runAgent({
      task: `Use the ${TOOL} tool exactly once to read the disposable file at ${path}. Return the exact MCP marker found there. Do not call any other tool.`,
      model: bounded, tools: [tool], workingDirectory: directory, maxTurns: 4,
      authorize: request => {
        const input: unknown = (() => { try { return JSON.parse(request.arguments) as unknown; } catch { return null; } })();
        const allowed = request.name === TOOL && request.operation === "EXECUTE" && isFixtureRead(input, path) && approvals === 0;
        if (allowed) approvals++;
        return allowed;
      },
    });
    assert.equal(approvals, 1, "One scoped EXECUTE authorization was required.");
    assert.equal(calls, 1, "MCP read must execute exactly once.");
    assert.equal(manager.status()[0]?.callCount, 1, "Expected one external MCP call.");
    assert.ok(result.finalText.includes(marker), "Provider did not return the MCP marker.");
  } finally {
    await manager.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void (async () => {
    const args = process.argv.slice(2).filter(arg => arg !== "--");
    if (args.length !== 1 || args[0] !== "--live") throw new Error("Opt-in required: --live.");
    if (!(await createChatGPTAuthService().status()).authenticated) throw new Error("Dragons ChatGPT is not signed in.");
    await runMcpChatgptAcceptance(createBuiltInProviderRegistry().createModel("chatgpt", { write: () => {} }));
    process.stdout.write("External MCP + ChatGPT acceptance passed (synthetic fixture cleaned).\n");
  })().catch((error: unknown) => {
    const reason = error instanceof Error && error.name === "AssertionError" ? error.message : "provider, server or runtime error";
    process.stderr.write(`External MCP + ChatGPT acceptance failed (${reason}); no pass recorded.\n`);
    process.exitCode = 1;
  });
}
