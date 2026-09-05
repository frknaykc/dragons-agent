// Local deterministic PTY fixture; never a built-in provider or live inference path.
import { writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { main } from "../dist/cli.js";
import { AgentRunCancelledError } from "../dist/agent.js";
import { createProviderRegistry } from "../dist/provider/registry.js";

const root = resolve(process.argv[2]);
const providers = createProviderRegistry([{
  id: "fixture", label: "Deterministic PTY fixture", defaultModel: "pty-fixture", credentialRequirement: "none",
  capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
  createModel: () => ({ async respond(request, delta) {
    const task = request.task;
    if (task === "wait") {
      await new Promise((resolve_, reject) => {
        const cancel = () => { void writeFile(join(root, "cancelled.txt"), "cancelled").then(() => reject(new AgentRunCancelledError())); };
        if (request.signal?.aborted) cancel(); else request.signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    if (task === "write" && request.toolOutputs.length === 0) return { responseId: "tool", text: "", toolCalls: [{ callId: "fixture-write", name: "synthetic_write", arguments: "{}" }] };
    if (task === "write") {
      let approved = false;
      try { await access(join(root, "approved.txt")); approved = true; } catch {}
      return { responseId: "fixture-done", text: approved ? "WRITE APPROVED" : "WRITE DENIED", toolCalls: [] };
    }
    if (task === "stream") {
      delta?.("Fixture stream part one.\n");
      await new Promise((resolve_) => setTimeout(resolve_, 150));
      delta?.("Fixture stream part two.\n");
      return { responseId: "fixture-stream", text: "Fixture stream part one.\nFixture stream part two.\n", textWasStreamed: true, toolCalls: [] };
    }
    const text = task === "resume-check" ? (request.conversationResponseId ? "RESUME CONTINUATION OK" : "NO CONTINUATION")
      : task === "unsafe" ? "SAFE\x1b]52;c;clipboard-fixture\x07\x1b[2J TEXT"
      : `Echo ${task}`;
    return { responseId: "fixture-answer", text, toolCalls: [] };
  } }),
}]);
try {
  await main(["--tui", ...process.argv.slice(3)], {
    workingDirectory: root, providerRegistry: providers, config: {},
    tools: [{ name: "synthetic_write", description: "Write only the isolated acceptance sentinel", operation: "WRITE", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { await writeFile(join(root, "approved.txt"), "approved"); return { ok: true, output: "synthetic write complete" }; } }],
    sessionDirectory: join(root, "sessions"), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
  });
} catch (error) {
  process.stderr.write(`Fixture failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
}
