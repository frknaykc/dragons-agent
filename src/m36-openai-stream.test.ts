import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIAgentModel } from "./provider/openai.js";

test("M36 OpenAI tolerates ignorable metadata and rejects unknown critical stream semantics", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let responseNumber = 0;
  globalThis.fetch = async () => {
    responseNumber += 1;
    const body = responseNumber === 1
      ? [
          'data: {"type":"response.progress.snapshot","phase":"queued"}\n\n',
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_ok"}}\n\n',
        ].join("")
      : [
          'data: {"type":"response.future_tool_call.completed","call_id":"call_future"}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_bad"}}\n\n',
        ].join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const request = { task: "x", tools: [], toolOutputs: [] };
    assert.equal((await createOpenAIAgentModel().respond(request)).text, "ok");
    await assert.rejects(createOpenAIAgentModel().respond(request), /incompatible with this Dragons adapter/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
