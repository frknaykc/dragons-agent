import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { main } from "./cli.js";
import { createCodingTools } from "./tools.js";

async function runFixtureTest(workingDirectory: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "calculator.test.js"], {
      cwd: workingDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, output }));
  });
}

test("CLI drives an autonomous search-read-edit-test workflow to fix a fixture", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dragons-agent-e2e-"));
  await writeFile(join(workspace, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(workspace, "calculator.js"),
    "export function add(left, right) {\n  return left - right;\n}\n",
  );
  await writeFile(
    join(workspace, "calculator.test.js"),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './calculator.js';\n\ntest('adds numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
  );

  try {
    const before = await runFixtureTest(workspace);
    assert.notEqual(before.code, 0);

    const toolCalls = [
      { name: "search_files", arguments: '{"query":"return"}' },
      { name: "read_file", arguments: '{"path":"calculator.js"}' },
      {
        name: "edit_file",
        arguments: '{"path":"calculator.js","oldText":"return left - right;","newText":"return left + right;"}',
      },
      { name: "shell", arguments: '{"command":"node --test calculator.test.js"}' },
    ];
    let turn = 0;
    const model: AgentModel = {
      async respond(request) {
        if (turn < toolCalls.length) {
          const toolCall = toolCalls[turn] as { name: string; arguments: string };
          turn += 1;
          return {
            responseId: `response-${turn}`,
            text: "",
            toolCalls: [
              {
                callId: `call-${turn}`,
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            ],
          };
        }

        assert.equal(request.toolOutputs.length, 1);
        assert.match(request.toolOutputs[0]?.output ?? "", /pass 1/);
        return {
          responseId: "response-final",
          text: "Fixed calculator.js and verified the calculator test passes.",
          toolCalls: [],
        };
      },
    };
    const output: string[] = [];

    await main(["Fix the failing calculator test."], {
      workingDirectory: workspace,
      model,
      tools: await createCodingTools(workspace),
      input: Readable.from(["yes\n", "yes\n"]),
      write: (text) => output.push(text),
    });

    assert.equal(
      await readFile(join(workspace, "calculator.js"), "utf8"),
      "export function add(left, right) {\n  return left + right;\n}\n",
    );
    const after = await runFixtureTest(workspace);
    assert.equal(after.code, 0);
    assert.deepEqual(toolCalls.map((toolCall) => toolCall.name), [
      "search_files",
      "read_file",
      "edit_file",
      "shell",
    ]);
    assert.match(output.join(""), /• search_files/);
    assert.match(output.join(""), /• shell/);
    assert.match(output.join(""), /Fixed calculator\.js and verified the calculator test passes\./);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
