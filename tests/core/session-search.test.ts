import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSessionStore } from "../../dist/session-store.js";
import { createSessionHistoryRecorder, createSessionSearchTools, sessionSearchText } from "../../dist/session-search.js";

async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "dragons-search-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const directory = join(path, "sessions");
  const workspace = join(path, "workspace"); await mkdir(workspace);
  const store = createSessionStore(directory);
  const session = await store.create({ workingDirectory: workspace, provider: "openai-api", model: "fixture" });
  session.messages = [{ role: "user", content: "Türkçe orchid design", createdAt: session.createdAt }];
  session.toolHistory = [{ name: "read_file", output: "orchid build successful", ok: true, createdAt: session.createdAt }];
  session.continuation = { responseId: "opaquecontinuation", providerState: { transcript: "invisibleproviderword" } };
  await store.save(session);
  const [search, read] = createSessionSearchTools(store, workspace);
  return { path, directory, workspace, store, session, search: search!, read: read! };
}

test("indexed token AND search and paginated read expose only persisted projection, without writes", async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.directory, `${f.session.id}.json`), "utf8");
  const found = JSON.parse((await f.search.execute({ query: "ORCHID successful" })).output);
  assert.equal(found.results[0].sessionId, f.session.id);
  assert.equal(JSON.parse((await f.search.execute({ query: "Türkçe" })).output).results.length, 1);
  for (const query of ["orch", "invisibleproviderword", "opaquecontinuation"]) assert.equal(JSON.parse((await f.search.execute({ query })).output).results.length, 0);
  let offset = 0; let text = "";
  do {
    const page = JSON.parse((await f.read.execute({ sessionId: f.session.id, revision: found.results[0].revision, offset, limit: 17 })).output);
    text += page.content; offset = page.nextOffset;
  } while (offset !== null);
  assert.match(text, /orchid build successful/); assert.doesNotMatch(text, /opaquecontinuation|invisibleproviderword/);
  assert.deepEqual(await readdir(f.directory), [`${f.session.id}.json`]);
  assert.equal(await readFile(join(f.directory, `${f.session.id}.json`), "utf8"), before);
});

test("workspace, profile, symlink and filename identity isolation", async t => {
  const f = await fixture(t); const other = join(f.path, "other"); await mkdir(other);
  assert.equal(JSON.parse((await createSessionSearchTools(f.store, other)[0]!.execute({ query: "orchid" })).output).results.length, 0);
  assert.equal((await createSessionSearchTools(f.store, other)[1]!.execute({ sessionId: f.session.id })).ok, false);
  const foreignStore = createSessionStore(join(f.path, "foreign-profile"));
  assert.equal(JSON.parse((await createSessionSearchTools(foreignStore, f.workspace)[0]!.execute({ query: "orchid" })).output).results.length, 0);
  const alias = "11111111-1111-1111-1111-111111111111";
  await writeFile(join(f.directory, `${alias}.json`), JSON.stringify(f.session));
  const link = "22222222-2222-2222-2222-222222222222";
  await symlink(join(f.directory, `${f.session.id}.json`), join(f.directory, `${link}.json`));
  assert.equal(JSON.parse((await f.search.execute({ query: "orchid" })).output).results.length, 1);
});

test("changed/deleted records and restart rebuild have no stale index", async t => {
  const f = await fixture(t); const found = JSON.parse((await f.search.execute({ query: "orchid" })).output).results[0];
  f.session.messages[0]!.content = "replacement"; f.session.toolHistory = []; await f.store.save(f.session);
  assert.equal((await f.read.execute({ sessionId: f.session.id, revision: found.revision })).ok, false);
  assert.equal(JSON.parse((await f.search.execute({ query: "orchid" })).output).results.length, 0);
  const restarted = createSessionSearchTools(createSessionStore(f.directory), f.workspace);
  assert.equal(JSON.parse((await restarted[0]!.execute({ query: "replacement" })).output).results.length, 1);
  await f.store.delete(f.session.id);
  assert.equal((await restarted[1]!.execute({ sessionId: f.session.id })).ok, false);
});

test("bounded validation, cancellation, malformed and oversized records", async t => {
  const f = await fixture(t);
  for (const input of [{ query: "" }, { query: "x".repeat(257) }, { query: "orchid", limit: 21 }, { query: "orchid", offset: -1 }, { query: "orchid", unknown: true }, null]) assert.equal((await f.search.execute(input)).ok, false);
  for (const input of [{ sessionId: "../bad" }, { sessionId: f.session.id, limit: 8001 }, { sessionId: f.session.id, revision: "bad" }]) assert.equal((await f.read.execute(input)).ok, false);
  assert.equal((await f.search.execute({ query: "orchid" }, { signal: AbortSignal.abort() })).output, "Session search cancelled.");
  await writeFile(join(f.directory, "11111111-1111-1111-1111-111111111111.json"), "x".repeat(1_048_577));
  await writeFile(join(f.directory, "22222222-2222-2222-2222-222222222222.json"), "{");
  assert.equal(JSON.parse((await f.search.execute({ query: "orchid" })).output).limited, true);
  await assert.rejects(f.store.save({ ...f.session, toolHistory: [{ name: "x", output: "x".repeat(2001), ok: true, createdAt: "now" }] }));
});

test("result pagination, absent stores, and abort during snapshot never return partial results", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 22; n++) await f.store.save({ ...f.session, id: randomUUID() });
  const first = JSON.parse((await f.search.execute({ query: "orchid", limit: 20 })).output);
  const last = JSON.parse((await f.search.execute({ query: "orchid", offset: first.nextOffset, limit: 20 })).output);
  assert.equal(first.results.length, 20); assert.equal(last.results.length, 3); assert.equal(last.nextOffset, null);
  assert.equal(new Set([...first.results, ...last.results].map(item => item.sessionId)).size, 23);
  const controller = new AbortController();
  const aborted = createSessionSearchTools({ ...f.store, async searchSnapshot() { controller.abort(); return { sessions: [f.session], limited: false }; } }, f.workspace);
  assert.equal((await aborted[0]!.execute({ query: "orchid" }, { signal: controller.signal })).ok, false);
  assert.equal((await createSessionSearchTools({ ...f.store, searchSnapshot: undefined }, f.workspace)[0]!.execute({ query: "orchid" })).ok, false);
});

test("scan byte and entry budgets report incomplete coverage", async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ ...f.session, messages: [{ role: "user", content: "x".repeat(950000), createdAt: "now" }] });
  for (let n = 0; n < 10; n++) { const id = randomUUID(); await writeFile(join(f.directory, `${id}.json`), body.replace(f.session.id, id)); }
  assert.equal((await f.store.searchSnapshot!(f.workspace)).limited, true);
  const directory = join(f.path, "many"); await mkdir(directory);
  // Non-session entries count too: a directory cannot cause unbounded enumeration.
  await Promise.all(Array.from({ length: 1001 }, (_, n) => writeFile(join(directory, `entry-${n}`), "")));
  assert.equal((await createSessionStore(directory).searchSnapshot!(f.workspace)).limited, true);
});

test("legacy credential fields are redacted on search/read without rewriting the record", async t => {
  const f = await fixture(t);
  const content = '{"cookie":"syntheticcookiemarker","setCookie":"syntheticsetmarker","id_token":"syntheticidmarker"} orchid';
  f.session.messages[0]!.content = content;
  f.session.toolHistory![0]!.output = content;
  await f.store.save(f.session);
  const before = await readFile(join(f.directory, `${f.session.id}.json`), "utf8");
  for (const query of ["syntheticcookiemarker", "syntheticsetmarker", "syntheticidmarker"]) {
    assert.equal(JSON.parse((await f.search.execute({ query })).output).results.length, 0);
  }
  const read = (await f.read.execute({ sessionId: f.session.id })).output;
  assert.match(read, /orchid/); assert.doesNotMatch(read, /synthetic(?:cookie|set|id)marker/);
  assert.equal(await readFile(join(f.directory, `${f.session.id}.json`), "utf8"), before);
});

test("history recorder bounds, redacts, omits arguments and avoids recursive search copies", async t => {
  const f = await fixture(t); const recorder = createSessionHistoryRecorder();
  recorder.observe({ type: "tool_started", name: "shell", arguments: "privatearguments" });
  recorder.observe({ type: "tool_completed", name: "session_read", result: { ok: true, output: "recursivecopy" } });
  for (let n = 0; n < 105; n++) recorder.observe({ type: "tool_completed", name: "read_file", result: { ok: true, output: `password=fixturecredential orchid ${"a ".repeat(2000)}` } });
  const history = recorder.merge(f.session);
  assert.equal(history.length, 100); assert.ok(history.every(item => item.output.length <= 2000));
  assert.doesNotMatch(JSON.stringify(history), /fixturecredential|privatearguments|recursivecopy/);
  assert.doesNotMatch(sessionSearchText("ghp_fixturecredentialvalue cookie=fixturecookie\n-----BEGIN PRIVATE KEY-----\nprivatebody\n-----END PRIVATE KEY-----"), /fixturecredentialvalue|fixturecookie|privatebody/);
  f.session.messages[0]!.content = "password=fixturecredential orchid"; await f.store.save(f.session);
  assert.equal(JSON.parse((await f.search.execute({ query: "fixturecredential" })).output).results.length, 0);
});

test("recorder uses authority-owned observations, including empty and excluded outputs", async t => {
  const f = await fixture(t); const recorder = createSessionHistoryRecorder();
  recorder.observe({ type: "tool_completed", name: "denied", result: { ok: false, output: "denialpresentation" }, observationOutput: null });
  recorder.observe({ type: "tool_completed", name: "empty", result: { ok: true, output: "nesteddecision" }, observationOutput: "" });
  recorder.observe({ type: "tool_completed", name: "write_file", result: { ok: true, output: "useful nesteddecision" }, observationOutput: 'useful {"cookie":"syntheticcookiemarker","id_token":"syntheticidmarker"}' });
  const history = recorder.merge({ ...f.session, toolHistory: [] });
  assert.deepEqual(history.map(item => item.name), ["empty", "write_file"]);
  assert.equal(history[0]!.output, ""); assert.match(history[1]!.output, /useful/);
  assert.doesNotMatch(JSON.stringify(history), /denialpresentation|nesteddecision|syntheticcookiemarker|syntheticidmarker/);
});

test("automatic lifecycle actions never enter durable tool search history", async t => {
  const f = await fixture(t); const recorder = createSessionHistoryRecorder();
  recorder.observe({ type: "authorization_completed", name: "hook_fixture", operation: "EXECUTE", allowed: false, origin: "lifecycle" });
  recorder.observe({ type: "tool_completed", name: "hook_fixture", result: { ok: true, output: "private hook output" }, origin: "lifecycle" });
  recorder.observe({ type: "tool_completed", name: "hook_fixture", result: { ok: true, output: "model result" } });
  assert.deepEqual(recorder.merge({ ...f.session, toolHistory: [] }).map(item => item.output), ["model result"]);
});
