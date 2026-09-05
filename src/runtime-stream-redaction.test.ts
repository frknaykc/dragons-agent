import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderRegistry } from "./provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "./runtime.js";
import { createSessionStore } from "./session-store.js";

test("M71 public stream and result redact credentials split across provider deltas", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-runtime-stream-redaction-"));
  const text = 'Visible text. {"authorization":"Basic fixtureCredential"} password="fixturePassword with spaces" Done.';
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none",
    capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel() {
      return { async respond(_request, onTextDelta) {
        for (const char of text) onTextDelta?.(char);
        return { responseId: "fixture-response", text, textWasStreamed: true, toolCalls: [] };
      } };
    },
  }]);
  const runtime = await createDragonsRuntime({
    workingDirectory: root, providerRegistry: providers,
    sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
  });
  try {
    const session = await runtime.createSession({ provider: "fixture" });
    for (let turn = 0; turn < 2; turn += 1) {
      const run = await runtime.sendUserInput({ sessionId: session.id, content: "Fixture redaction check." });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);
      const result = await run.result;
      const streamed = events.flatMap((event) => event.type === "assistant_delta" ? [event.text] : []).join("");
      assert.equal(streamed, result.finalText);
      assert.match(streamed, /^Visible text\./);
      assert.match(streamed, /Done\.$/);
      assert.match(streamed, /\[REDACTED\]/);
      assert.doesNotMatch(streamed, /fixtureCredential|fixturePassword|with spaces/);
      assert.doesNotMatch(JSON.stringify({ events, result }), /fixtureCredential|fixturePassword|with spaces/);
      assert.equal(events.at(-1)?.type, "run_completed");
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
