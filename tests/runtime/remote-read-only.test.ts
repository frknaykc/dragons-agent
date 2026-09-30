import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProviderRegistry } from "../../dist/provider/registry.js";
import { connectRemoteRuntime } from "../../dist/remote/runtime.js";
import { startRemoteServer } from "../../dist/remote/server.js";
import { createDragonsRuntime } from "../../dist/runtime.js";
import { createSessionStore } from "../../dist/session-store.js";

test("remote facade rejects read-only requests rather than silently sending a privileged turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-remote-read-only-"));
  const token = randomBytes(32).toString("base64url");
  let modelCalls = 0;
  const providers = createProviderRegistry([{
    id: "fixture", label: "Fixture", defaultModel: "model", credentialRequirement: "none" as const,
    capabilities: { streaming: false, toolCalls: true, toolResultContinuation: true, usageMetadata: false },
    createModel: () => ({ async respond() { modelCalls++; return { responseId: "one", text: "unexpected", toolCalls: [] }; } }),
  }]);
  const server = await startRemoteServer({ principals: [{ id: "owner", token }], createRuntime: () => createDragonsRuntime({
    workingDirectory: root, providerRegistry: providers, sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }),
    tools: [], memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
  }) });
  try {
    const client = await connectRemoteRuntime({ url: server.url, token });
    try {
      const session = await client.createSession({ provider: "fixture" });
      await assert.rejects(client.sendUserInput({ sessionId: session.id, content: "Restricted", readOnly: true }), /read-only.*remote/i);
      assert.equal(modelCalls, 0);
      assert.equal((await client.resumeSession(session.id)).messageCount, 0);
    } finally { await client.dispose(); }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
