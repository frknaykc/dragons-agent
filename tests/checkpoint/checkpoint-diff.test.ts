import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Readable } from "node:stream";
import { SessionCheckpoints, checkpointCommand } from "../../dist/checkpoint.js";
import { runAgent } from "../../dist/agent.js";
import { main } from "../../dist/cli.js";
import { createCodingTools } from "../../dist/tools.js";
import { RuntimeTextRedactor } from "../../dist/runtime-redaction.js";
import { supportedCheckpointTest as checkpointTest } from "./checkpoint-support.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dragons-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, history: new SessionCheckpoints(root) };
}
const idOf = (history: SessionCheckpoints) => history.list().split(":")[0]!;
async function command(root: string, history: SessionCheckpoints, task: string) {
  return runAgent({ task, workingDirectory: root, ...checkpointCommand(task, history),
    authorize: async request => { assert.equal(request.operation, "READ"); return true; } });
}

checkpointTest("real local command reconstructs both 256 KiB UTF-8 images through bounded deterministic pages", async (t) => {
  const f = await fixture(t);
  const before = "😀\r\n".repeat(43690) + "end!";
  const after = "é\u001b\r\n ".repeat(43690) + "last";
  assert.equal(Buffer.byteLength(before), 262144);
  assert.equal(Buffer.byteLength(after), 262144);
  await writeFile(join(f.root, "file.txt"), before);
  assert.equal(f.history.mutate([{ path: "file.txt", content: after }]).ok, true);
  const id = idOf(f.history);
  let next: string | null = `/checkpoint diff ${id}`;
  const restored = { before: "", after: "" };
  let pages = 0;
  while (next) {
    const result = await command(f.root, f.history, next);
    assert.ok(Buffer.byteLength(result.finalText) < 30000);
    assert.doesNotMatch(result.finalText, /[\u001b\u0080-\u009f\u202e]/);
    const page = JSON.parse(result.finalText);
    assert.equal(page.page, ++pages);
    assert.equal(page.offset, Buffer.byteLength(restored[page.side as "before" | "after"]));
    assert.ok(page.end - page.offset <= 4099);
    restored[page.side as "before" | "after"] += page.text;
    next = page.next;
  }
  assert.equal(pages, 128);
  assert.deepEqual(restored, { before, after });
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), after);
  assert.equal(f.history.rollback(id).ok, true);
  assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), before);
});

checkpointTest("quoted exact paths, escaped listing, small compatibility and invalid local arguments", async (t) => {
  const f = await fixture(t);
  const paths = ["a  b.txt", "a b.txt", ...(process.platform === "win32" ? [] : ["tab\t.txt", "tail ", "escape\u001b[31m.txt"]), "bidi\u202e.txt"];
  for (const path of paths) await writeFile(join(f.root, path), "old " + paths.indexOf(path));
  assert.equal(f.history.mutate(paths.map(path => ({ path, content: "new " + paths.indexOf(path) }))).ok, true);
  const id = idOf(f.history);
  const listing = (await command(f.root, f.history, "/checkpoint list")).finalText;
  assert.doesNotMatch(listing, /[\t\u001b\u202e]/);
  if (process.platform !== "win32") assert.match(listing, /\\t/);
  for (const path of paths) {
    const output = (await command(f.root, f.history, `/checkpoint diff ${id} ${JSON.stringify(path)}`)).finalText;
    assert.deepEqual(JSON.parse(output), [{ path, before: "old " + paths.indexOf(path), after: "new " + paths.indexOf(path) }]);
    const page = JSON.parse((await command(f.root, f.history, `/checkpoint diff ${id} --page 1 ${JSON.stringify(path)}`)).finalText);
    const last = JSON.parse((await command(f.root, f.history, page.next)).finalText);
    assert.equal(last.path, path); assert.equal(last.next, null);
  }
  for (const suffix of ["--page 0", "--page -1", "--page 1.5", "--page 9999", "--page 9007199254740993", "--page", "--other 1", "--page 1 --page 2", '"a b.txt" extra', "a  b.txt", "a b.txt"]) {
    assert.match((await command(f.root, f.history, `/checkpoint diff ${id} ${suffix}`)).finalText, /Usage:|Diff page/);
  }
  const local = checkpointCommand(`/rollback ${id} ${JSON.stringify(paths[0])}`, f.history);
  await runAgent({ task: "rollback", workingDirectory: f.root, ...local, authorize: async () => true });
  assert.equal(await readFile(join(f.root, paths[0]!), "utf8"), "old 0");
  assert.equal(await readFile(join(f.root, paths[1]!), "utf8"), "new 1");
});

test("credential-bearing filenames are refused instead of emitting ambiguous redacted selectors", async (t) => {
  const f = await fixture(t);
  for (const path of ["sk-synthetic-fixture.txt", "password=synthetic.txt"]) {
    await writeFile(join(f.root, path), "before");
    assert.equal(f.history.mutate([{ path, content: "after" }]).ok, false);
    assert.doesNotMatch((await command(f.root, f.history, "/checkpoint list")).finalText, /synthetic/);
    assert.equal(await readFile(join(f.root, path), "utf8"), "before");
  }
});

checkpointTest("slice boundaries do not trigger streaming secret redaction or replacement interpolation", async (t) => {
  const f = await fixture(t);
  const text = "x".repeat(4096) + "sk-synthetic $& $` $'\r\n";
  await writeFile(join(f.root, "file.txt"), text);
  assert.equal(f.history.mutate([{ path: "file.txt", content: "after" }]).ok, true);
  const output = (await command(f.root, f.history, `/checkpoint diff ${idOf(f.history)} --page 2`)).finalText;
  const redactor = new RuntimeTextRedactor();
  const redacted = redactor.push(output) + redactor.finish();
  assert.equal(JSON.parse(redacted).text, text.slice(4096));
});

checkpointTest("actual interactive CLI accepts page syntax and exact quoted selectors without provider requests", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const paths = ["a  b.txt", "a b.txt"];
  for (const path of paths) await writeFile(join(f.root, path), "old");
  let output = "", requests = 0;
  let ready!: (id: string) => void;
  const captured = new Promise<string>(resolve => { ready = resolve; });
  await main([], { workingDirectory: f.root, configPath: join(f.root, "config.json"), config: {},
    sessionDirectory: join(f.root, "sessions"), memoryDirectory: join(f.root, "memory"), skillsDirectory: join(f.root, "skills"),
    tools: await createCodingTools(f.root), model: { async respond(request) {
      requests++;
      return { responseId: "fixture", text: requests === 1 ? "" : request.toolOutputs.map(x => x.output).join("\n"),
        toolCalls: requests === 1 ? paths.map((path, i) => ({ callId: String(i), name: "write_file", arguments: JSON.stringify({ path, content: "new " + i }) })) : [] };
    } },
    input: Readable.from((async function* () {
      yield "write\ny\ny\n";
      const id = await captured;
      yield `/checkpoint list\n/checkpoint diff ${id} --page 2 ${JSON.stringify(paths[0])}\n/checkpoint diff ${id} --page 0\n/exit\n`;
    })(), { highWaterMark: 0 }),
    write: text => { output += text; const id = /Checkpoint (cp-[0-9a-f-]+-1):/.exec(output)?.[1]; if (id) ready(id); },
    terminal: { inputIsTTY: false, outputIsTTY: false },
  });
  assert.equal(requests, 2);
  assert.match(output, /"path": "a  b.txt"/);
  assert.match(output, /"text": "\\u006eew 0"/);
  assert.match(output, /Usage:/);
});
