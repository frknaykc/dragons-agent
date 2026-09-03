import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runAgent, type AgentModel } from "./agent.js";
import { McpClientManager, type McpServerConfig } from "./mcp-client.js";

const officialServer = fileURLToPath(new URL("./mcp-official-sdk-server.js", import.meta.url));

type FixtureMode = "normal" | "large-result" | "wait" | "crash" | "tool-error";

function fixture(id: string, mode: FixtureMode, auditPath: string, operation?: McpServerConfig["operation"]): McpServerConfig {
  return {
    id,
    command: process.execPath,
    args: [officialServer, mode, auditPath],
    ...(operation ? { operation } : {}),
  };
}

async function auditedPids(auditPath: string): Promise<number[]> {
  try {
    return (await readFile(auditPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function assertProcessExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Official MCP fixture process ${pid} remained after awaited cleanup.`);
}

function scriptedModel(firstCallId: string, toolName: string, argument: string, expectedOutput: RegExp, finalText: string): AgentModel {
  let requests = 0;
  return {
    async respond(request) {
      requests += 1;
      if (requests === 1) {
        assert.equal(request.previousResponseId, undefined);
        return {
          responseId: `${firstCallId}-response`,
          text: "",
          toolCalls: [{ callId: firstCallId, name: toolName, arguments: argument }],
        };
      }
      assert.equal(request.previousResponseId, `${firstCallId}-response`);
      assert.equal(request.toolOutputs.length, 1);
      assert.equal(request.toolOutputs[0]?.callId, firstCallId);
      assert.match(request.toolOutputs[0]?.output ?? "", expectedOutput);
      return { responseId: `${firstCallId}-done`, text: finalText, toolCalls: [] };
    },
  };
}

test("M32 acceptance uses an official SDK stdio server through Dragons discovery, authorization, runtime continuation, failure boundaries, and awaited process cleanup", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dragons-m32-official-mcp-"));
  const auditPath = join(directory, "fixture-pids.txt");
  const primary = new McpClientManager([
    fixture("official", "normal", auditPath),
    fixture("readonly", "normal", auditPath, "READ"),
    fixture("failure", "tool-error", auditPath),
    fixture("crashed", "crash", auditPath),
    fixture("healthy", "normal", auditPath),
  ], { toolTimeoutMilliseconds: 1_000 });
  const capped = new McpClientManager([fixture("capped", "large-result", auditPath)], { maxOutputBytes: 180 });
  const waiting = new McpClientManager([fixture("waiting", "wait", auditPath)], { toolTimeoutMilliseconds: 5_000 });
  const managers = [primary, capped, waiting];

  try {
    const [official] = await primary.connect("official", []);
    const [readonly] = await primary.connect("readonly", primary.tools());
    assert.equal(official?.name, "mcp__official__inspect");
    assert.match(official!.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(official?.operation, "EXECUTE");
    assert.equal(readonly?.name, "mcp__readonly__inspect");
    assert.equal(readonly?.operation, "READ");
    assert.deepEqual(official?.inputSchema, {
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
    });

    assert.deepEqual(await official!.execute({ nested: { query: "mapped" } }), {
      ok: true,
      output: "[{\"type\":\"text\",\"text\":\"result:mapped\"}]",
    });

    const denied = await runAgent({
      task: "Try the remote tool without an EXECUTE approval.",
      model: scriptedModel("denied-call", official!.name, "{\"nested\":{\"query\":\"denied\"}}", /Authorization denied for mcp__official__inspect/, "Denied safely."),
      tools: [official!],
    });
    assert.equal(denied.finalText, "Denied safely.");

    const allowed = await runAgent({
      task: "Use the approved remote tool.",
      model: scriptedModel("allowed-call", official!.name, "{\"nested\":{\"query\":\"allowed\"}}", /result:allowed/, "Allowed result observed."),
      tools: [official!],
      authorize: (request) => request.operation === "EXECUTE",
    });
    assert.equal(allowed.finalText, "Allowed result observed.");

    const [failure] = await primary.connect("failure", primary.tools());
    assert.deepEqual(await failure!.execute({ nested: { query: "broken" } }), {
      ok: false,
      output: "[{\"type\":\"text\",\"text\":\"fixture failure:broken\"}]",
    });
    const [crashed] = await primary.connect("crashed", primary.tools());
    const [healthy] = await primary.connect("healthy", primary.tools());
    const crashResult = await crashed!.execute({ nested: { query: "crash" } });
    assert.equal(crashResult.ok, false);
    assert.match(crashResult.output, /MCP tool mcp__crashed__inspect failed|MCP server crashed is disconnected/i);
    assert.deepEqual(await healthy!.execute({ nested: { query: "still-alive" } }), {
      ok: true,
      output: "[{\"type\":\"text\",\"text\":\"result:still-alive\"}]",
    });

    const [cappedTool] = await capped.connect("capped", []);
    const cappedResult = await cappedTool!.execute({ nested: { query: "large" } });
    assert.equal(cappedResult.ok, true);
    assert.match(cappedResult.output, /\[MCP output truncated at 180 bytes\]$/);

    const [waitingTool] = await waiting.connect("waiting", []);
    assert.ok((await auditedPids(auditPath)).length >= 7, "each official-SDK fixture startup must be audited");
    const controller = new AbortController();
    const pending = waitingTool!.execute({ nested: { query: "cancel" } }, { signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, { ok: false, output: "MCP tool call cancelled." });
    assert.equal(waiting.status().find((status) => status.id === "waiting")?.state, "disconnected");

    await primary.disconnect("readonly");
    assert.equal(primary.status().find((status) => status.id === "readonly")?.state, "disconnected");
    assert.deepEqual(await readonly!.execute({ nested: { query: "after-disconnect" } }), {
      ok: false,
      output: "MCP server readonly is disconnected.",
    });
  } finally {
    await Promise.all(managers.map((manager) => manager.closeAll()));
    const pids = await auditedPids(auditPath);
    await Promise.all(pids.map(assertProcessExited));
    await rm(directory, { recursive: true, force: true });
  }
});
