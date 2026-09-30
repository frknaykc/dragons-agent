import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectLspDiagnostics, parseLspConfig, type LspConfig } from "../../dist/lsp-diagnostics.js";
import { parseDragonsConfig } from "../../dist/config.js";
import { runAgent, AgentRunCancelledError, type AgentRequest, type ToolAuthorizationRequest } from "../../dist/agent.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createSessionHistoryRecorder } from "../../dist/session-search.js";
import { createCodingTools } from "../../dist/tools.js";
const fixture = resolve("tests/fixtures/lsp-server.mjs");
const config = (mode = "pull", marker?: string): LspConfig => parseLspConfig({ command: process.execPath, args: [fixture, mode, ...(marker ? [marker] : [])], languageId: "typescript", extensions: [".ts"], timeoutMilliseconds: 1000 });
async function workspace(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dragons-lsp-"));
  try { await writeFile(join(directory, "a.ts"), "const a: number = 'wrong';\n"); await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}
test("explicit LSP config is validated, copied and default remains absent", () => {
  assert.equal(parseDragonsConfig({}).lsp, undefined);
  for (const value of [{ ...config(), command: "npx" }, { ...config(), env: {} }, { ...config(), timeoutMilliseconds: 10001 }, { ...config(), extensions: ["../"] }]) assert.throws(() => parseDragonsConfig({ lsp: value }));
  const source = config(); const parsed = parseDragonsConfig({ lsp: source }).lsp!; source.args.push("bad"); assert.notDeepEqual(parsed.args, source.args);
});
for (const mode of ["pull", "push", "split", "request", "empty", "many"]) test(`real framed LSP ${mode}, sanitized and bounded report`, () => workspace(async (dir) => {
  const report = await collectLspDiagnostics(config(mode), dir, "a.ts");
  assert.match(report, mode === "empty" ? /no diagnostics reported/ : mode === "request" ? /Server request denied/ : /3:5 error: Type mismatch/);
  assert.doesNotMatch(report, /fixture-secret|\u001b|outside/);
  assert.ok(report.length <= 8192);
  if (mode === "many") assert.match(report, /truncated/);
}));
for (const [mode, expected] of [["header-oversize", /header limit/], ["push-stale", /timeout/], ["hang", /timeout/], ["exit", /exited/], ["oversize", /frame limit/], ["flood", /message limit/], ["stderr", /output limit/]] as const) test(`LSP ${mode} is bounded and unavailable, not a false clean result`, () => workspace(async (dir) => {
  assert.match(await collectLspDiagnostics(config(mode), dir, "a.ts"), expected);
}));
test("missing server, path and URI containment, symlink, deletion and document bounds", () => workspace(async (dir) => {
  assert.match(await collectLspDiagnostics({ ...config(), command: join(dir, "absent") }, dir, "a.ts"), /unavailable/);
  assert.match(await collectLspDiagnostics(config(), dir, "../outside.ts"), /unsafe/);
  assert.match(await collectLspDiagnostics(config(), dir, "deleted.ts"), /unavailable/);
  assert.match(await collectLspDiagnostics(config(), dir, "."), /unsafe/);
  if (process.platform !== "win32") {
    execFileSync("/usr/bin/mkfifo", [join(dir, "fifo.ts")]);
    assert.match(await collectLspDiagnostics(config(), dir, "fifo.ts"), /unsupported/);
  }
  await writeFile(join(dir, "big.ts"), "x".repeat(131073));
  assert.match(await collectLspDiagnostics(config(), dir, "big.ts"), /unsupported/);
  await writeFile(join(dir, ".env"), "fake");
  assert.match(await collectLspDiagnostics(config(), dir, ".env"), /sensitive/);
  if (process.platform !== "win32") { await symlink(join(dir, "a.ts"), join(dir, "link.ts")); assert.match(await collectLspDiagnostics(config(), dir, "link.ts"), /symlink/); }
}));
test("cancellation cleans up fixture process", () => workspace(async (dir) => {
  const marker = join(dir, "pid"); const controller = new AbortController();
  const result = collectLspDiagnostics(config("hang", marker), dir, "a.ts", controller.signal);
  let pid = 0;
  for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(marker, "utf8")); break; } catch { await new Promise((r) => setTimeout(r, 10)); } }
  assert.ok(pid); controller.abort(); assert.match(await result, /cancelled/);
  // OS delivery is asynchronous; wait boundedly for exit rather than trusting kill() alone.
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return; } await new Promise((r) => setTimeout(r, 10)); }
  assert.fail("fixture survived cancellation");
}));
for (const allow of [false, true]) test(`runAgent WRITE does not authorize LSP EXECUTE (${allow}) and reports to model/event`, () => workspace(async (dir) => {
  const requests: AgentRequest[] = []; const approvals: ToolAuthorizationRequest[] = []; let report = "";
  const recorder = createSessionHistoryRecorder();
  await runAgent({ task: "edit", workingDirectory: dir, tools: await createCodingTools(dir), lsp: config(),
    authorize: (request) => { approvals.push(request); return request.operation !== "EXECUTE" || allow; },
    onEvent: (e) => { recorder.observe(e); if (e.type === "tool_completed") report = e.result.lspDiagnostics ?? ""; },
    model: { async respond(request) { requests.push(request); return requests.length === 1 ? { responseId: "1", text: "", toolCalls: [{ callId: "w", name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: "const bad: number = 'x';" }) }] } : { responseId: "2", text: "done", toolCalls: [] }; } },
  });
  assert.deepEqual(approvals.map((r) => [r.name, r.operation]), [["write_file", "WRITE"], ["lsp_diagnostics_start", "EXECUTE"]]);
  assert.match(report, allow ? /Type mismatch/ : /EXECUTE denied/);
  assert.ok(requests[1]!.toolOutputs[0]!.output.includes(report));
  const history = recorder.merge(await createSessionStore(join(dir, "sessions")).create({ workingDirectory: dir, provider: "openai-api", model: "fixture" }));
  assert.equal(history.length, 1); assert.equal(history[0]!.name, "write_file");
  assert.match(history[0]!.output, /Checkpoint .*1 file\(s\) changed/);
  assert.doesNotMatch(history[0]!.output, /EXECUTE denied/);
  if (allow) assert.match(history[0]!.output, /Type mismatch/);
  assert.match(await readFile(join(dir, "a.ts"), "utf8"), /const bad/);
}));
test("runAgent refuses unsafe or oversized approval scopes before authorizer/startup", () => workspace(async (dir) => {
  const marker = join(dir, "pid");
  for (const extra of [["token=fixture-secret"], ["--token", "fixture-secret"], ["x\u202ejs"], Array(8).fill("x".repeat(1000))]) {
    let turn = 0; const approvals: string[] = []; let report = "";
    await runAgent({task:"edit",workingDirectory:dir,tools:await createCodingTools(dir),lsp:{...config("pull",marker),args:[...config("pull",marker).args,...extra]},
      authorize:r=>{approvals.push(r.name);return true;},
      onEvent:e=>{if(e.type==="tool_completed")report=e.result.lspDiagnostics??"";},
      model:{async respond(){return ++turn===1?{responseId:"1",text:"",toolCalls:[{callId:"w",name:"write_file",arguments:JSON.stringify({path:"a.ts",content:"x"})}]}:{responseId:"2",text:"done",toolCalls:[]};}},
    });
    assert.deepEqual(approvals,["write_file"]); assert.match(report,/scope cannot be safely displayed/); assert.doesNotMatch(report,/fixture-secret/); await assert.rejects(readFile(marker));
  }
}));

test("cancellation during LSP approval prevents startup and further model turns", () => workspace(async (dir) => {
  const controller = new AbortController(); let turns = 0; const marker = join(dir, "pid");
  await assert.rejects(runAgent({ task: "edit", workingDirectory: dir, tools: await createCodingTools(dir), lsp: config("pull", marker), signal: controller.signal,
    authorize: (r) => { if (r.operation === "EXECUTE") controller.abort(); return true; },
    model: { async respond() { turns++; return { responseId: "1", text: "", toolCalls: [{ callId: "w", name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: "x" }) }] }; } },
  }), AgentRunCancelledError);
  assert.equal(turns, 1); await assert.rejects(readFile(marker));
}));

for (const name of ["edit_file", "apply_patch"]) test(`${name} diagnostics are post-success and each process requires new EXECUTE approval`, () => workspace(async (dir) => {
  await writeFile(join(dir, "a.ts"), "one\n");
  let turn = 0; let executeApprovals = 0;
  const calls = name === "edit_file"
    ? [{ path: "a.ts", oldText: "one", newText: "two" }, { path: "a.ts", oldText: "two", newText: "three" }]
    : [{ patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-one\n+two\n" }, { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-two\n+three\n" }];
  await runAgent({ task: "edit", workingDirectory: dir, tools: await createCodingTools(dir), lsp: config(),
    authorize: (r) => { if (r.operation === "EXECUTE") executeApprovals++; return "session"; },
    model: { async respond(request) {
      if (++turn === 1) return { responseId: "1", text: "", toolCalls: calls.map((args, index) => ({ callId: String(index), name, arguments: JSON.stringify(args) })) };
      assert.equal(request.toolOutputs.length, 2); for (const output of request.toolOutputs) assert.match(output.output, /Type mismatch/);
      return { responseId: "2", text: "done", toolCalls: [] };
    } },
  });
  assert.equal(executeApprovals, 2); assert.equal(await readFile(join(dir, "a.ts"), "utf8"), "three\n");
}));
for (const kind of ["disabled", "failed", "unmatched"]) test(`${kind} writes do not start LSP or request EXECUTE`, () => workspace(async (dir) => {
  let turn = 0; const approvals: string[] = []; const marker = join(dir, "pid");
  await runAgent({ task: "edit", workingDirectory: dir, tools: await createCodingTools(dir), ...(kind === "disabled" ? {} : { lsp: config("pull", marker) }),
    authorize: (r) => { approvals.push(r.operation); return true; },
    model: { async respond(request) {
      if (++turn === 1) return { responseId: "1", text: "", toolCalls: [{ callId: "w", name: "write_file", arguments: JSON.stringify({ path: kind === "failed" ? "../escape.ts" : kind === "unmatched" ? "a.txt" : "a.ts", content: "text" }) }] };
      assert.doesNotMatch(request.toolOutputs[0]!.output, /LSP/); return { responseId: "2", text: "done", toolCalls: [] };
    } },
  });
  assert.deepEqual(approvals, ["WRITE"]); await assert.rejects(readFile(marker));
}));
