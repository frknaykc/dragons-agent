import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { parseInlineReferences, resolveInlineContext } from "../../dist/inline-context.js";
import { runAgent, AgentRunCancelledError } from "../../dist/agent.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dragons-inline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "note.txt"), "Selected content. @file(missing.txt)");
  return root;
}
const signal = () => new AbortController().signal;
const resolve = (root: string, task: string, maxBytes?: number) => resolveInlineContext(task, root, parseInlineReferences(task), signal(), async () => false, maxBytes);

test("inline parser preserves email, prose, escaped mentions and code", () => {
  for (const text of ["mail@file(x)", "@file x @folder @unknown(foo) @diffuse", "`@file(x)`", "```ts\n@file(x)\n```", "\\@file(x)", "@file(x).", "@diff(x)"]) assert.deepEqual(parseInlineReferences(text), []);
  assert.deepEqual(parseInlineReferences("Review @file(a b.txt) @folder(src) @diff @url(https://www.wikipedia.org/guide)"), [
    { kind: "file", value: "a b.txt" }, { kind: "folder", value: "src" }, { kind: "diff", value: "HEAD" }, { kind: "url", value: "https://www.wikipedia.org/guide" },
  ]);
  for (const text of ["@file(", "@file()", "@file(a\nb)", Array(9).fill("@diff").join(" "), `${" ".repeat(65536)}@diff`]) assert.throws(() => parseInlineReferences(text));
});

test("inline file and deterministic shallow folder preserve provenance without recursively expanding content", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "folder")); await writeFile(join(root, "folder", "z.txt"), "do not ingest"); await writeFile(join(root, "folder", "a.txt"), "not ingested");
  await writeFile(join(root, "folder", ".env"), "synthetic fixture");
  const output = await resolve(root, "Inspect @file(note.txt) @folder(folder)");
  assert.match(output, /untrusted advisory/); assert.match(output, /Selected content/); assert.match(output, /@file\(missing.txt\)/);
  assert.ok(output.indexOf("a.txt") < output.indexOf("z.txt")); assert.match(output, /Excluded entries: 1/); assert.doesNotMatch(output, /not ingested|do not ingest|synthetic fixture/);
});

test("inline containment, sensitive content, links, binary and size failures are explicit and do not leak content", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "large"), "a".repeat(16385)); await writeFile(join(root, "binary"), Buffer.from([0, 255]));
  await writeFile(join(root, "private.txt"), "password = synthetic-placeholder");
  await symlink("note.txt", join(root, "soft")); await link(join(root, "note.txt"), join(root, "hard"));
  for (const path of ["../outside", "/outside", ".env", "soft", "hard", "note.txt", "large", "binary", "private.txt", "missing", "foo/../note.txt"])
    await assert.rejects(resolve(root, `@file(${path})`), (error: Error) => { assert.match(error.message, /Inline context/); assert.ok(!error.message.includes(root)); assert.doesNotMatch(error.message, /synthetic-placeholder/); return true; });
});

test("inline total and folder entry budgets fail closed", async (t) => {
  const root = await fixture(t);
  await assert.rejects(resolve(root, "@file(note.txt)", 1), /budget/);
  await mkdir(join(root, "many"));
  await Promise.all(Array.from({ length: 201 }, (_, i) => writeFile(join(root, "many", String(i)), "")));
  await assert.rejects(resolve(root, "@folder(many)"), /200 direct/);
});

test("inline diff uses protected Git HEAD comparison including staged and unstaged edits", async (t) => {
  const root = await fixture(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init"); git("add", "note.txt"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  await writeFile(join(root, "note.txt"), "stage one\n"); git("add", "note.txt"); await writeFile(join(root, "note.txt"), "working tree two\n");
  git("config", "core.fsmonitor", "must-not-run-fixture-helper"); git("config", "diff.external", "must-not-run-fixture-helper");
  git("config", "filter.fixture.clean", "must-not-run-fixture-helper"); git("config", "filter.fixture.required", "true");
  await writeFile(join(root, ".gitattributes"), "*.txt filter=fixture diff=fixture\n");
  git("config", "diff.fixture.textconv", "must-not-run-fixture-helper");
  const output = await resolve(root, "@diff"); assert.match(output, /working tree two/); assert.match(output, /Selected content/);
  await mkdir(join(root, "nested")); await assert.rejects(resolve(join(root, "nested"), "@diff"), /failed/);
  await writeFile(join(root, "note.txt"), "password = synthetic-placeholder"); await assert.rejects(resolve(root, "@diff"), /sensitive/);
});

test("runAgent only resolves opt-in user text once, never subsequent model/tool text", async (t) => {
  const root = await fixture(t); let turns = 0; const tasks: string[] = [];
  await runAgent({ task: "@file(note.txt)", inlineContextReferences: true, workingDirectory: root, tools: [], model: { async respond(request) {
    tasks.push(request.task); turns++;
    if (turns === 1) { await rm(join(root, "note.txt")); return { responseId: "1", text: "@file(missing)", toolCalls: [{ callId: "x", name: "@file(missing)", arguments: "{}" }] }; }
    return { responseId: "2", text: "done", toolCalls: [] };
  } } });
  assert.equal(tasks.length, 2); assert.equal(tasks[0], tasks[1]); assert.match(tasks[0]!, /Selected content/);
  await runAgent({ task: "@file(missing)", workingDirectory: root, tools: [], model: { async respond(r) { assert.equal(r.task, "@file(missing)"); return { responseId: "3", text: "done", toolCalls: [] }; } } });
});

test("URL consent fails closed before any model turn and cancellation prevents context work", async (t) => {
  const root = await fixture(t); let calls = 0;
  const options = { task: "@url(https://www.wikipedia.org/)", inlineContextReferences: true, workingDirectory: root, tools: [], model: { async respond() { calls++; return { responseId: "x", text: "", toolCalls: [] }; } } };
  await assert.rejects(runAgent(options), /approval denied/);
  const approvals: string[] = [];
  await assert.rejects(runAgent({ ...options, authorize: request => { assert.equal(request.operation, "EXECUTE"); approvals.push(request.arguments); return false; } }), /approval denied/);
  assert.deepEqual(approvals, ['{"url":"https://www.wikipedia.org/"}']); assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runAgent({ ...options, signal: controller.signal }), AgentRunCancelledError);
});
