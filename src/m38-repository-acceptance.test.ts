import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AgentModel } from "./agent.js";
import { main } from "./cli.js";
import { createCodingTools } from "./tools.js";

type Step = { name: string; arguments: string };

function scripted(steps: Step[]): AgentModel {
  let index = 0;
  return {
    async respond(request) {
      if (index < steps.length) {
        const step = steps[index]!;
        index += 1;
        return { responseId: `m38-${index}`, text: "", toolCalls: [{ callId: `m38-call-${index}`, ...step }] };
      }
      assert.equal(request.toolOutputs.length, 1);
      return { responseId: "m38-final", text: "Fixture task completed and verification passed.", toolCalls: [] };
    },
  };
}

async function scenario(name: string, files: Record<string, string>, steps: Step[], verify: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `dragons-m38-${name}-`));
  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => writeFile(join(directory, path), content)));
    const output: string[] = [];
    await main(["Complete the requested coding task after inspecting this repository and running its test."], {
      workingDirectory: directory,
      model: scripted(steps),
      tools: await createCodingTools(directory),
      input: Readable.from(Array.from({ length: 12 }, () => "yes\n")),
      write: (text) => output.push(text),
    });
    await verify(directory);
    assert.match(output.join(""), /Fixture task completed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("M38 bug-fix acceptance inspects multiple files, fixes root cause, and verifies independently", async () => {
  await scenario("bug", {
    "package.json": '{"type":"module"}\n',
    "math.js": "export const total = (a, b) => a - b;\n",
    "service.js": "import { total } from './math.js';\nexport const invoice = (a, b) => total(a, b);\n",
    "math.test.js": "import test from 'node:test'; import assert from 'node:assert/strict'; import { invoice } from './service.js'; test('invoice totals', () => assert.equal(invoice(2, 3), 5));\n",
  }, [
    { name: "search_files", arguments: '{"query":"total"}' },
    { name: "read_file", arguments: '{"path":"service.js"}' },
    { name: "read_file", arguments: '{"path":"math.js"}' },
    { name: "edit_file", arguments: '{"path":"math.js","oldText":"a - b","newText":"a + b"}' },
    { name: "shell", arguments: '{"command":"node --test math.test.js"}' },
  ], async (directory) => {
    assert.match(await readFile(join(directory, "math.js"), "utf8"), /a \+ b/);
    assert.match(await readFile(join(directory, "math.test.js"), "utf8"), /invoice totals/);
  });
});

test("M38 feature acceptance follows project instructions and verifies a multi-file addition", async () => {
  await scenario("feature", {
    "package.json": '{"type":"module"}\n',
    "AGENTS.md": "Export public helpers from index.js and test new behavior.\n",
    "format.js": "export const upper = (value) => value.toUpperCase();\n",
    "index.js": "export { upper } from './format.js';\n",
    "format.test.js": "import test from 'node:test'; import assert from 'node:assert/strict'; import { upper } from './index.js'; test('upper', () => assert.equal(upper('go'), 'GO'));\n",
  }, [
    { name: "read_file", arguments: '{"path":"AGENTS.md"}' },
    { name: "read_file", arguments: '{"path":"format.js"}' },
    { name: "write_file", arguments: '{"path":"lower.js","content":"export const lower = (value) => value.toLowerCase();\\n"}' },
    { name: "edit_file", arguments: '{"path":"index.js","oldText":"export { upper } from \'./format.js\';","newText":"export { upper } from \'./format.js\';\\nexport { lower } from \'./lower.js\';"}' },
    { name: "edit_file", arguments: '{"path":"format.test.js","oldText":"import { upper } from \'./index.js\';","newText":"import { upper, lower } from \'./index.js\';"}' },
    { name: "edit_file", arguments: '{"path":"format.test.js","oldText":"test(\'upper\', () => assert.equal(upper(\'go\'), \'GO\'));","newText":"test(\'upper\', () => assert.equal(upper(\'go\'), \'GO\'));\\ntest(\'lower\', () => assert.equal(lower(\'GO\'), \'go\'));"}' },
    { name: "shell", arguments: '{"command":"node --test format.test.js"}' },
  ], async (directory) => {
    assert.match(await readFile(join(directory, "index.js"), "utf8"), /lower/);
    assert.match(await readFile(join(directory, "format.test.js"), "utf8"), /test\('lower'/);
  });
});

test("M38 refactor acceptance inspects Git state, preserves behavior, and checks the diff", async () => {
  await scenario("refactor", {
    "package.json": '{"type":"module"}\n',
    "values.js": "export const twice = (value) => value + value;\n",
    "values.test.js": "import test from 'node:test'; import assert from 'node:assert/strict'; import { twice } from './values.js'; test('twice', () => assert.equal(twice(4), 8));\n",
  }, [
    { name: "git_status", arguments: '{}' },
    { name: "read_file", arguments: '{"path":"values.js"}' },
    { name: "edit_file", arguments: '{"path":"values.js","oldText":"value + value","newText":"value * 2"}' },
    { name: "shell", arguments: '{"command":"node --test values.test.js"}' },
    { name: "git_diff", arguments: '{}' },
  ], async (directory) => {
    assert.match(await readFile(join(directory, "values.js"), "utf8"), /value \* 2/);
  });
});
