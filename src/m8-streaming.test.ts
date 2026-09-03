import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { runAgent, type AgentEvent, type AgentModel } from "./agent.js";
import { main } from "./cli.js";
import { createOpenAIAgentModel } from "./provider/openai.js";
import type { AgentTool } from "./tools.js";

function responseCompleted(responseId: string): string {
  return `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: responseId },
  })}\n\n`;
}

function writeTool(onExecute: (input: unknown) => void): AgentTool {
  return {
    name: "write_file",
    operation: "WRITE",
    description: "Write a fixture.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative file path." },
        content: { type: "string", description: "File content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(input) {
      onExecute(input);
      return { ok: true, output: "Wrote fixture" };
    },
  };
}

test("OpenAI stream deltas, authorization, tool output, and final text flow through the active agent", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const requests: Array<Record<string, unknown>> = [];
  const events: AgentEvent[] = [];
  const authorizations: Array<{ name: string; arguments: string }> = [];
  let executions = 0;
  process.env.OPENAI_API_KEY = "test-key";

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(await request.json() as Record<string, unknown>);
    const body = requests.length === 1
      ? [
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Applying fix. "}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\\"path\\\":","item_id":"item-1","output_index":0,"sequence_number":2}\n\n',
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"write_file","arguments":"{\\\"path\\\":\\\"fixture.txt\\\",\\\"content\\\":\\\"fixed\\\"}"},"output_index":0,"sequence_number":3}\n\n',
          responseCompleted("response-1"),
        ].join("")
      : [
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Fix verified."}\n\n',
          responseCompleted("response-2"),
        ].join("");

    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  try {
    const result = await runAgent({
      task: "Fix the fixture.",
      model: createOpenAIAgentModel(),
      tools: [writeTool((input) => {
        executions += 1;
        assert.deepEqual(input, { path: "fixture.txt", content: "fixed" });
      })],
      authorize: (request) => {
        authorizations.push({ name: request.name, arguments: request.arguments });
        return true;
      },
      onEvent: (event) => events.push(event),
    });

    assert.equal(executions, 1);
    assert.deepEqual(authorizations, [{
      name: "write_file",
      arguments: '{"path":"fixture.txt","content":"fixed"}',
    }]);
    assert.equal(result.finalText, "Fix verified.");
    assert.deepEqual(events, [
      { type: "agent_started", task: "Fix the fixture." },
      { type: "message_delta", text: "Applying fix. " },
      {
        type: "authorization_requested",
        name: "write_file",
        operation: "WRITE",
        arguments: '{"path":"fixture.txt","content":"fixed"}',
      },
      { type: "authorization_completed", name: "write_file", operation: "WRITE", allowed: true },
      {
        type: "tool_started",
        name: "write_file",
        arguments: '{"path":"fixture.txt","content":"fixed"}',
      },
      { type: "tool_completed", name: "write_file", result: { ok: true, output: "Wrote fixture" } },
      { type: "message_delta", text: "Fix verified." },
      { type: "agent_completed", finalText: "Fix verified." },
    ]);
    assert.deepEqual(requests[1]?.input, [
      { type: "function_call_output", call_id: "call-1", output: "Wrote fixture" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("a partial streamed function-call argument cannot execute before its completed item arrives", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const encoder = new TextEncoder();
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveFirstRequest: (() => void) | undefined;
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve;
  });
  let requestCount = 0;
  let executions = 0;
  let authorizations = 0;
  process.env.OPENAI_API_KEY = "test-key";

  const firstStream = new ReadableStream<Uint8Array>({
    start(controller) {
      firstController = controller;
    },
  });

  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      resolveFirstRequest?.();
      return new Response(firstStream, { headers: { "content-type": "text/event-stream" } });
    }

    return new Response(
      [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Done."}\n\n',
        responseCompleted("response-2"),
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const run = runAgent({
      task: "Fix the fixture.",
      model: createOpenAIAgentModel(),
      tools: [writeTool(() => {
        executions += 1;
      })],
      authorize: () => {
        authorizations += 1;
        return true;
      },
    });

    await firstRequest;
    assert.ok(firstController);
    firstController.enqueue(encoder.encode(
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\\"path\\\":","item_id":"item-1","output_index":0,"sequence_number":1}\n\n',
    ));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(authorizations, 0);
    assert.equal(executions, 0);

    firstController.enqueue(encoder.encode([
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"write_file","arguments":"{\\\"path\\\":\\\"fixture.txt\\\",\\\"content\\\":\\\"fixed\\\"}"},"output_index":0,"sequence_number":2}\n\n',
      responseCompleted("response-1"),
    ].join("")));
    firstController.close();

    const result = await run;
    assert.equal(result.finalText, "Done.");
    assert.equal(authorizations, 1);
    assert.equal(executions, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("CLI renders streamed chunks in order without duplicating accumulated text", async () => {
  const output: string[] = [];
  const model: AgentModel = {
    async respond(_request, onTextDelta) {
      onTextDelta?.("First ");
      onTextDelta?.("second.");
      return {
        responseId: "response-1",
        text: "First second.",
        textWasStreamed: true,
        toolCalls: [],
      };
    },
  };

  await main(["Stream a response."], {
    model,
    tools: [],
    input: Readable.from([]),
    write: (text) => output.push(text),
  });

  assert.equal(output.join(""), "First second.\n");
});

test("CLI applies its one-time approval path to a streamed completed write call", async () => {
  const output: string[] = [];
  let turn = 0;
  let executions = 0;
  const model: AgentModel = {
    async respond(request, onTextDelta) {
      turn += 1;
      if (turn === 1) {
        onTextDelta?.("Writing. ");
        return {
          responseId: "response-1",
          text: "Writing. ",
          textWasStreamed: true,
          toolCalls: [{
            callId: "call-1",
            name: "write_file",
            arguments: '{"path":"fixture.txt","content":"fixed"}',
          }],
        };
      }

      assert.deepEqual(request.toolOutputs, [{ callId: "call-1", output: "Wrote fixture" }]);
      onTextDelta?.("Done.");
      return {
        responseId: "response-2",
        text: "Done.",
        textWasStreamed: true,
        toolCalls: [],
      };
    },
  };

  await main(["Write the fixture."], {
    model,
    tools: [writeTool(() => {
      executions += 1;
    })],
    input: Readable.from(["yes\n"]),
    write: (text) => output.push(text),
  });

  assert.equal(executions, 1);
  assert.equal(
    output.join(""),
    "Writing. \n? Allow WRITE write_file with {\"path\":\"fixture.txt\",\"content\":\"fixed\"}? [y/N] \n• write_file\n\n✓ write_file\nDone.\n",
  );
});
