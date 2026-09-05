import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent, type RuntimeSession } from "./runtime.js";
import { createSessionStore } from "./session-store.js";
import { RemoteClient } from "./remote/client.js";
import { startRemoteServer } from "./remote/server.js";

test("M74 public client/server complete authenticated approval, continuation and reconnect", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dragons-remote-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerRegistry = createProviderRegistry([{
    id: "fixture", label: "Remote fixture", defaultModel: "remote-model", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond(request, delta) {
      if (request.task === "write" && !request.toolOutputs.length) return { responseId: "call", text: "", toolCalls: [{ callId: "write", name: "fixture_write", arguments: "{}" }] };
      const text = request.task === "resume-check" ? (request.conversationResponseId ? "resumed" : "lost") : "remote completed";
      delta?.(text); return { responseId: "remote-result", text, textWasStreamed: true, toolCalls: [] };
    } }),
  }]);
  const token = randomBytes(32).toString("base64url");
  const server = await startRemoteServer({ principals: [{ id: "owner", token }], createRuntime: () => createDragonsRuntime({
    workingDirectory: root, providerRegistry, sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providerRegistry.ids() }),
    memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
    tools: [{ name: "fixture_write", description: "Isolated transport sentinel", operation: "WRITE", inputSchema: { type: "object", properties: {} },
      execute: async () => { await writeFile(join(root, "sentinel.txt"), "approved"); return { ok: true, output: "done" }; } }],
  }) });
  t.after(() => server.close());
  const events: RuntimeEvent[] = [];
  const waitFor = async (type: RuntimeEvent["type"]) => { for (let i = 0; i < 300; i++) { const event = events.find((entry) => entry.type === type); if (event) return event; await new Promise((r) => setTimeout(r, 5)); } throw new Error(`No ${type} event`); };
  let client = await RemoteClient.connect({ url: server.url, token, onEvent: (event) => events.push(event) });
  t.after(() => client.close());
  const created = await client.request<RuntimeSession>({ type: "create" }); assert.equal(created.ok, true); if (!created.ok) return;
  const sessionId = created.value.id;
  assert.equal((await client.request({ type: "send", sessionId, content: "write" })).ok, true);
  const approval = await waitFor("approval_requested"); assert.equal(approval.type, "approval_requested"); if (approval.type !== "approval_requested") return;
  assert.equal((await client.request({ type: "approve", sessionId, runId: approval.runId, approvalId: approval.approvalId, decision: "allow_once" })).ok, true);
  const completed = await waitFor("run_completed"); assert.equal(completed.type, "run_completed");
  assert.equal(await readFile(join(root, "sentinel.txt"), "utf8"), "approved");
  assert.equal(events.filter((event) => event.type === "assistant_delta").map((event) => event.text).join(""), "remote completed");
  await client.close(); events.length = 0;
  client = await RemoteClient.connect({ url: server.url, token, onEvent: (event) => events.push(event) });
  assert.equal((await client.request({ type: "resume", sessionId })).ok, true);
  assert.equal((await client.request({ type: "send", sessionId, content: "resume-check" })).ok, true);
  const resumed = await waitFor("run_completed"); assert.equal(resumed.type === "run_completed" && resumed.result.finalText, "resumed");
  await client.close();
});
