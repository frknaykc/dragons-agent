import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createCodexAgentModel } from "./codex.js";
import { createAnthropicAgentModel } from "./anthropic.js";
import { createGeminiAgentModel } from "./gemini.js";
import { createOpenRouterAgentModel } from "./openrouter.js";
import { createLocalAgentModel } from "./local.js";

for (const provider of ["chatgpt", "anthropic", "gemini", "openrouter", "local"] as const) {
  test(`M76 ${provider} observes reader cancellation rejection after transport abort`, async () => {
    const abort = new AbortController();
    let fetches = 0;
    let deltas = 0;
    const events = provider === "chatgpt" ? [{ type: "response.output_text.delta", delta: "hello" }]
      : provider === "anthropic" ? [
        { type: "message_start", message: { id: "synthetic" } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      ] : provider === "gemini" ? [{ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "hello" }] } }] }]
        : [{ id: "synthetic", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }];
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
        // Native fetch errors its body before the adapter's abort listener calls cancel().
        abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    };
    const options = { fetchImpl, apiKey: "synthetic-key" };
    const model = provider === "chatgpt" ? createCodexAgentModel({ fetchImpl, credentials: { getValidCredentials: async () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: "2099-01-01T00:00:00Z", tokenType: "Bearer" }) } })
      : provider === "anthropic" ? createAnthropicAgentModel(options)
        : provider === "gemini" ? createGeminiAgentModel(options)
          : provider === "local" ? createLocalAgentModel({ fetchImpl }) : createOpenRouterAgentModel(options);
    await assert.rejects(model.respond({ task: "Synthetic cancellation", tools: [], toolOutputs: [], signal: abort.signal }, () => { deltas += 1; abort.abort(); }), { name: "AbortError" });
    await setImmediate();
    assert.equal(deltas, 1);
    assert.equal(fetches, 1, "no retry after streamed output");
  });
}
