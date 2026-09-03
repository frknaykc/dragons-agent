import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIAgentModel, streamOpenAIResponse } from "./openai.js";

const readFileTool = {
  name: "read_file",
  operation: "READ" as const,
  description: "Read a file.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "A project-relative file path." },
    },
    required: ["path"],
    additionalProperties: false as const,
  },
  async execute() {
    return { ok: true, output: "fixture" };
  },
};

const responseEvents = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":", Dragons"}\n\n',
].join("");

function responseCompleted(responseId: string): string {
  return `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: responseId },
  })}\n\n`;
}

test("OpenAI provider yields response text deltas in order", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);

    assert.equal(request.method, "POST");
    assert.match(request.url, /\/v1\/responses$/);
    assert.equal(request.headers.get("authorization"), "Bearer test-key");

    return new Response(responseEvents, {
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const chunks: string[] = [];

    for await (const chunk of streamOpenAIResponse("Say hello")) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, ["Hello", ", Dragons"]);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test("OpenAI agent model streams text-only responses through its callback", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  globalThis.fetch = async () => new Response(
    [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"First "}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"second."}\n\n',
      responseCompleted("response-1"),
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

  try {
    const chunks: string[] = [];
    const response = await createOpenAIAgentModel().respond({
      task: "Respond with text.",
      tools: [readFileTool],
      toolOutputs: [],
    }, (text) => chunks.push(text));

    assert.deepEqual(chunks, ["First ", "second."]);
    assert.equal(response.text, "First second.");
    assert.equal(response.textWasStreamed, true);
    assert.deepEqual(response.toolCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("OpenAI agent model exposes a function call only after its completed stream item", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const requests: Array<Record<string, unknown>> = [];
  process.env.OPENAI_API_KEY = "test-key";

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(await request.json() as Record<string, unknown>);
    const body = requests.length === 1
      ? [
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Inspecting. "}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\\"path\\\":","item_id":"item-1","output_index":0,"sequence_number":2}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"read_file","arguments":"{\\\"path\\\":\\\"README.md\\\"}"},"output_index":0,"sequence_number":3}\n\n',
          responseCompleted("response-1"),
        ].join("")
      : [
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Done."}\n\n',
          responseCompleted("response-2"),
        ].join("");

    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  try {
    const firstChunks: string[] = [];
    const model = createOpenAIAgentModel();
    const first = await model.respond({
      task: "Inspect the project.",
      tools: [readFileTool],
      toolOutputs: [],
    }, (text) => firstChunks.push(text));
    const secondChunks: string[] = [];
    const second = await model.respond({
      task: "Inspect the project.",
      tools: [readFileTool],
      previousResponseId: first.responseId,
      toolOutputs: [{ callId: "call-1", output: "# Fixture" }],
    }, (text) => secondChunks.push(text));

    assert.deepEqual(firstChunks, ["Inspecting. "]);
    assert.deepEqual(first.toolCalls, [{
      callId: "call-1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    }]);
    assert.equal(second.text, "Done.");
    assert.deepEqual(secondChunks, ["Done."]);
    assert.equal(requests[0]?.stream, true);
    assert.equal(requests[1]?.previous_response_id, "response-1");
    assert.deepEqual(requests[1]?.input, [
      { type: "function_call_output", call_id: "call-1", output: "# Fixture" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("OpenAI provider sends project instructions and git context separately from the user task", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let body: Record<string, unknown> | undefined;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    body = await new Request(input, init).json() as Record<string, unknown>;
    return new Response(responseCompleted("response-context"), {
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    await createOpenAIAgentModel().respond({
      task: "Fix the failing auth test.",
      tools: [readFileTool],
      toolOutputs: [],
      projectContext: {
        instructions: { path: ".hermes.md", content: "Use project fixtures.\n" },
        git: {
          isRepository: true,
          repositoryRoot: "/fixture/repository",
          branch: "main",
          dirty: true,
          changedFiles: ["src/auth.ts", "src/auth.test.ts"],
          changedFileCount: 2,
        },
      },
    });

    assert.equal(body?.input, "Fix the failing auth test.");
    assert.equal(body?.parallel_tool_calls, false);
    assert.equal(body?.instructions, [
      "Repository-local project instructions (.hermes.md):",
      "Use project fixtures.\n",
      "Git snapshot:",
      "repository root: /fixture/repository",
      "branch: main",
      "working tree: dirty",
      "changed files (2): src/auth.ts, src/auth.test.ts",
    ].join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("OpenAI provider continues an interactive user turn from the prior completed response", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let body: Record<string, unknown> | undefined;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    body = await new Request(input, init).json() as Record<string, unknown>;
    return new Response(responseCompleted("response-2"), {
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    await createOpenAIAgentModel().respond({
      task: "Fix it.",
      tools: [readFileTool],
      toolOutputs: [],
      conversationResponseId: "response-1",
    });

    assert.equal(body?.previous_response_id, "response-1");
    assert.equal(body?.input, "Fix it.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("OpenAI provider resumes from serialized continuation state", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let body: Record<string, unknown> | undefined;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    body = await new Request(input, init).json() as Record<string, unknown>;
    return new Response(responseCompleted("response-2"), {
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const response = await createOpenAIAgentModel().respond({
      task: "Fix it.",
      tools: [readFileTool],
      toolOutputs: [],
      continuationState: JSON.parse(JSON.stringify({
        kind: "openai-responses",
        previousResponseId: "response-1",
      })) as Record<string, unknown>,
    });

    assert.equal(body?.previous_response_id, "response-1");
    assert.deepEqual(response.continuationState, {
      kind: "openai-responses",
      previousResponseId: "response-2",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("OpenAI agent model forwards cancellation to its active response request", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  let requestSeen!: () => void;
  const requestStarted = new Promise<void>((resolve) => { requestSeen = resolve; });
  process.env.OPENAI_API_KEY = "test-key";

  globalThis.fetch = async (_input, init) => {
    observedSignal = init?.signal;
    requestSeen();
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };

  try {
    const response = createOpenAIAgentModel().respond({
      task: "Wait for cancellation.",
      tools: [readFileTool],
      toolOutputs: [],
      signal: controller.signal,
    });
    await requestStarted;
    controller.abort();

    await assert.rejects(response);
    assert.equal(observedSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});
