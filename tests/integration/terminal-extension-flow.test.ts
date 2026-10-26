import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { main } from "../../dist/cli.js";
import { McpClientManager } from "../../dist/mcp-client.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createSessionStore } from "../../dist/session-store.js";

import type { AgentModel } from "../../dist/agent.js";

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
}
class Output extends Writable {
  isTTY = true;
  columns = 120;
  rows = 40;
  text = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString().replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    callback();
  }
}
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 8_000;
  while (!await check()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const tui of [false, true]) test(`CT04 ${tui ? "TUI" : "CLI"} composes skills, context, MCP, search, Git and checkpoints`, { timeout: 45_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dragons-terminal-extensions-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const skillsDirectory = join(root, "skills");
  await mkdir(workspace);
  await mkdir(join(skillsDirectory, "fixture"), { recursive: true });
  await writeFile(join(skillsDirectory, "fixture", "SKILL.md"), "---\nname: Fixture\ndescription: Terminal skill fixture\n---\nCT04_SKILL_BODY\n");
  await writeFile(join(workspace, "note.txt"), "before\n");
  await promisify(execFile)("git", ["init", "--quiet", workspace]);
  if (!tui) {
    await mkdir(join(root, "hooks"));
    await promisify(execFile)("git", ["add", "note.txt"], { cwd: workspace });
    await promisify(execFile)("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "hooks")}`, "commit", "-qm", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "source-only.txt"), "keep source changes\n");
  }
  const calls: string[] = [];
  const toolResults = new Map<string, string>();
  let expectedSkill = false;
  const model: AgentModel = { async respond(request) {
    if (request.toolOutputs.some((item) => item.callId === request.task)) {
      toolResults.set(request.task, request.toolOutputs.filter((item) => item.callId === request.task).map((item) => item.output).join("\n"));
      return { responseId: "done", text: `DONE:${request.task}`, toolCalls: [] };
    }
    if (!request.toolOutputs.length) calls.push(request.task);
    assert.equal(JSON.stringify(request.skills ?? {}).includes("CT04_SKILL_BODY"), expectedSkill);
    const selected = request.task === "write-note" ? { name: "write_file", args: { path: "note.txt", content: "after\n" } }
      : request.task === "search-history" ? { name: "session_search", args: { query: "unique-history-marker" } }
      : request.task === "git-read" ? { name: "git_status", args: {} }
      : request.task === "read-checkout" ? { name: "read_file", args: { path: "note.txt" } }
      : request.task.startsWith("mcp-") ? { name: "mcp__fixture__inspect", args: { nested: { query: request.task } } }
      : undefined;
    if (selected && !request.tools.some((tool) => tool.name === selected.name)) {
      const searched = request.toolOutputs.some((item) => item.callId === "discover");
      return { responseId: "catalog", text: "", toolCalls: [{ callId: searched ? "describe" : "discover",
        name: searched ? "tool_describe" : "tool_search",
        arguments: JSON.stringify(searched ? { names: [selected.name] } : { query: selected.name }),
      }] };
    }
    return { responseId: "fixture", text: selected ? "" : `DONE:${request.task}`, toolCalls: selected ? [{ callId: request.task, name: selected.name, arguments: JSON.stringify(selected.args) }] : [] };
  } };
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => model,
  }]);
  const sessions = createSessionStore(join(root, "sessions"), { providerIds: providers.ids() });
  const mcpManager = new McpClientManager([{
    id: "fixture", command: process.execPath,
    args: [fileURLToPath(new URL("../fixtures/mcp-mock-server.js", import.meta.url))],
  }]);
  t.after(() => mcpManager.closeAll());
  const input = new Input();
  const output = new Output();
  const running = main(tui ? ["--tui"] : [], {
    workingDirectory: workspace, providerRegistry: providers, sessionStore: sessions,
    mcpManager, skillsDirectory,
    memoryDirectory: join(root, "memory"), configPath: join(root, "config.json"),
    config: { version: 1, provider: "fixture", maxTurns: 8 }, input, tuiOutput: output, write: (text) => { output.text += text; },
    terminal: { inputIsTTY: false, outputIsTTY: false, color: false }, backgroundJobsDirectory: join(root, "jobs"),
  });
  let closed = false;
  t.after(async () => {
    if (!closed) { input.write(tui ? "\u0004" : "/exit\n"); input.end(); await running; }
  });
  async function send(command: string, expected: string): Promise<void> {
    output.text = "";
    if (tui) output.emit("resize");
    input.write(`${command}${tui ? "\r" : "\n"}`);
    await until(() => {
      return output.text.includes(expected);
    }, `${command} → ${expected}`).catch((error: unknown) => { throw new Error(`${String(error)}; output: ${output.text.slice(-2000)}`); });
    if (tui) {
      output.text = "";
      output.emit("resize");
      await until(() => output.text.includes("fixture / fixture-1 | READY"), "ready");
    }
  }
  await until(() => output.text.includes(tui ? "fixture / fixture-1 | READY" : "Session:"), "startup");
  await send("/skills list", "Terminal skill fixture");
  await send("/skills activate fixture", "Activated skill: fixture");
  expectedSkill = true;
  await send("unique-history-marker", "DONE:unique-history-marker");
  // A completed bare slash command needs the picker's trailing space before submit.
  await send("/context ", tui ? "Info: Context:" : "Session context estimate:");
  await send("git-read", "DONE:git-read");
  assert.match(toolResults.get("git-read")!, tui ? /note\.txt/ : /source-only\.txt/);
  await send("search-history", "DONE:search-history");
  assert.match(toolResults.get("search-history")!, /unique-history-marker/);
  await send("/mcp connect fixture", tui ? "MCP connection updated." : "Connected MCP server fixture");
  await until(() => mcpManager.status()[0]?.state === "connected", "MCP connected");
  if (!tui) await send("/worktree create sandbox", "Disconnect MCP servers before changing workspace.");
  async function decision(command: string, tool: string, allow: boolean | "cancel"): Promise<void> {
    output.text = "";
    if (tui) output.emit("resize");
    input.write(`${command}${tui ? "\r" : "\n"}`);
    const operation = tool === "write_file" || tool === "rollback_checkpoint" ? "WRITE" : "EXECUTE";
    await until(() => output.text.includes(tui ? `PERMISSION: ${operation} ${tool}` : `? Allow ${operation} ${tool}`), `approval ${tool}`);
    if (tui) assert.match(output.text, new RegExp(tool));
    output.text = "";
    if (allow === "cancel") {
      if (tui) input.write("\u0003"); else process.emit("SIGINT");
    } else input.write(tui ? (allow ? "\t\r" : "\r") : (allow ? "yes\n" : "\n"));
    await until(() => { return command.startsWith("/rollback")
      ? output.text.includes(tui ? "fixture / fixture-1 | READY" : "> ")
      : output.text.includes(`DONE:${command}`); }, `settled ${command}`).catch((error: unknown) => { throw new Error(`${String(error)}; output: ${output.text.slice(-2000)}`); });
  }
  await decision("mcp-denied", "mcp__fixture__inspect", false);
  assert.doesNotMatch(toolResults.get("mcp-denied")!, /result:mcp-denied/);
  await decision("mcp-approved", "mcp__fixture__inspect", true);
  assert.match(toolResults.get("mcp-approved")!, /result:mcp-approved/);
  await send("/mcp disconnect fixture", tui ? "MCP connection updated." : "Disconnected MCP server fixture");
  await until(() => mcpManager.status()[0]?.state === "disconnected", "MCP disconnected");
  await decision("write-note", "write_file", true);
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "after\n");
  await send("/checkpoint list", "note.txt");
  const checkpoint = /(cp-[0-9a-f-]+-\d+):/.exec(output.text)?.[1];
  assert.ok(checkpoint, "checkpoint id must be presented to the user");
  const beforeLocal = calls.length;
  await send(`/checkpoint diff ${checkpoint}`, "before");
  await decision(`/rollback ${checkpoint}`, "rollback_checkpoint", false);
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "after\n");
  await decision(`/rollback ${checkpoint}`, "rollback_checkpoint", "cancel");
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "after\n");
  await decision(`/rollback ${checkpoint}`, "rollback_checkpoint", true);
  await until(async () => await readFile(join(workspace, "note.txt"), "utf8") === "before\n", "rollback restores file");
  assert.equal(calls.length, beforeLocal, "checkpoint commands must never call the provider");
  await send("/skills deactivate fixture", "Deactivated skill: fixture");
  expectedSkill = false;
  await send("no-skill", "DONE:no-skill");
  assert.deepEqual((await sessions.load((await sessions.list())[0]!.id))!.skills, []);
  if (tui) {
    await send("/worktree create sandbox", "not available");
  } else {
    await send("/worktree create sandbox", "Workspace:");
    const target = join(root, "workspace-worktrees", "sandbox");
    assert.equal(await readFile(join(target, "note.txt"), "utf8"), "before\n");
    assert.equal(await readFile(join(workspace, "source-only.txt"), "utf8"), "keep source changes\n");
    await assert.rejects(readFile(join(target, "source-only.txt")), { code: "ENOENT" });
    await writeFile(join(workspace, "note.txt"), "source changed after switch\n");
    await send("read-checkout", "DONE:read-checkout");
    assert.match(toolResults.get("read-checkout")!, /before/);
    assert.doesNotMatch(toolResults.get("read-checkout")!, /source changed/);
    await send("/checkpoint list", "No checkpoints");
    await send("search-history", "DONE:search-history");
    assert.equal(JSON.parse(toolResults.get("search-history")!).results.length, 0, "workspace switch must isolate history");
    await send("/worktree select sandbox", "Workspace:");
    await send("/worktree select ../escape", "Worktree switch failed:");
  }
  input.write(tui ? "\u0004" : "/exit\n");
  await running;
  closed = true;
  assert.equal(input.isRaw, false);
});
