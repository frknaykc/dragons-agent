// Opt-in only; not discovered by the default test suite. Never installs dependencies.
// node tests/acceptance/lsp-real-server.mjs <scratch-root> <scratch-dependency-prefix>
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [scratchArgument, prefixArgument, candidate = "tls"] = process.argv.slice(2);
assert.ok(["tls", "native"].includes(candidate));
assert.ok(scratchArgument && prefixArgument, "Explicit scratch root and dependency prefix required");
const scratch = await realpath(scratchArgument);
const prefix = await realpath(prefixArgument);
assert.ok(isAbsolute(scratchArgument) && isAbsolute(prefixArgument));
assert.ok(scratch.includes(`${sep}cache${sep}scratch`), "Use an isolated Hermes scratch root");
assert.ok(relative(scratch, prefix) && !relative(scratch, prefix).startsWith(".."));
const workspace = await mkdtemp(join(scratch, "dragons-real-lsp-"));
const nativePackage = `@typescript/native-preview-${process.platform}-${process.arch}`;
const server = candidate === "native"
  ? join(prefix, "node_modules", nativePackage, "lib/tsgo")
  : join(prefix, "node_modules/typescript-language-server/lib/cli.mjs");
const versions = {};
for (const name of candidate === "native" ? ["@typescript/native-preview", nativePackage] : ["typescript-language-server", "typescript"]) {
  versions[name] = JSON.parse(await readFile(join(prefix, "node_modules", name, "package.json"), "utf8")).version;
}
assert.deepEqual(versions, candidate === "native"
  ? { "@typescript/native-preview": "7.0.0-dev.20260707.2", [nativePackage]: "7.0.0-dev.20260707.2" }
  : { "typescript-language-server": "5.0.0", typescript: "5.9.3" });
const provenance = JSON.parse(await readFile(join(prefix, "package-lock.json"), "utf8"));
const lsp = { command: candidate === "native" ? server : process.execPath, args: candidate === "native" ? ["--lsp", "--stdio"] : [server, "--stdio"], languageId: "typescript", extensions: [".ts"], timeoutMilliseconds: 10000 };
const launches = [];
const originalSpawn = childProcess.spawn;
// Observe the real production spawn and its untouched stdout; no fixture/proxy responses.
childProcess.spawn = function (command, args, options) {
  assert.equal(command, lsp.command);
  assert.deepEqual(args, lsp.args);
  assert.equal(options.cwd, workspace);
  const child = originalSpawn.call(this, command, args, options);
  const launch = { command, args, cwd: options.cwd, pid: child.pid, messages: [] };
  launches.push(launch);
  let pending = Buffer.alloc(0);
  let observedBytes = 0;
  child.stdout.on("data", (chunk) => {
    observedBytes += chunk.length;
    assert.ok(observedBytes <= 2097152, "Observer output bound");
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) break;
      const match = /Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString());
      assert.ok(match);
      const length = Number(match[1]);
      assert.ok(length <= 262144);
      if (pending.length < end + 4 + length) break;
      const message = JSON.parse(pending.subarray(end + 4, end + 4 + length));
      if (message.id === 1 || message.id === 2 || message.method === "textDocument/publishDiagnostics") launch.messages.push(message);
      pending = pending.subarray(end + 4 + length);
    }
  });
  return child;
};
syncBuiltinESMExports();
const { runAgent } = await import("../../dist/agent.js");
const { createCodingTools } = await import("../../dist/tools.js");
const { parseDragonsConfig } = await import("../../dist/config.js");
const results = [];
try {
  // Explicit synthetic project; no parent/project dependency discovery is needed.
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [], noEmit: true }, files: ["a.ts"] }));
  assert.equal(parseDragonsConfig({}).lsp, undefined);
  for (const mode of ["disabled", "denied", "enabled"]) {
    const approvals = [], reports = [], outputs = [];
    const start = launches.length;
    let turn = 0;
    await runAgent({ task: "Synthetic TypeScript diagnostic acceptance", workingDirectory: workspace, tools: await createCodingTools(workspace),
      ...(mode === "disabled" ? {} : { lsp }),
      authorize(request) {
        approvals.push(request);
        if (request.operation === "EXECUTE") {
          assert.equal(request.name, "lsp_diagnostics_start");
          assert.deepEqual(JSON.parse(request.arguments), { command: lsp.command, args: lsp.args, path: "a.ts" });
          return mode !== "denied";
        }
        assert.equal(request.operation, "WRITE");
        return true;
      },
      onEvent(event) { if (event.type === "tool_completed") { assert.equal(event.result.ok, true); reports.push(event.result.lspDiagnostics ?? null); } },
      model: { async respond(request) {
        outputs.push(...(request.toolOutputs ?? []).map((output) => output.output));
        turn++;
        const call = turn === 1
          ? { name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: 'export const count: number = "wrong";\n' }) }
          : turn === 2 ? { name: "edit_file", arguments: JSON.stringify({ path: "a.ts", oldText: '"wrong"', newText: "42" }) } : undefined;
        return { responseId: String(turn), text: call ? "" : "done", toolCalls: call ? [{ callId: String(turn), ...call }] : [] };
      } },
    });
    assert.equal(await readFile(join(workspace, "a.ts"), "utf8"), "export const count: number = 42;\n");
    assert.deepEqual(approvals.map((a) => a.operation), mode === "disabled" ? ["WRITE", "WRITE"] : ["WRITE", "EXECUTE", "WRITE", "EXECUTE"]);
    assert.equal(launches.length - start, mode === "enabled" ? 2 : 0);
    if (mode === "disabled") assert.deepEqual(reports, [null, null]);
    if (mode === "denied") for (const report of reports) assert.match(report, /EXECUTE denied/);
    for (const report of reports.filter(Boolean)) assert.ok(outputs.some((output) => output.includes(report)));
    results.push({ mode, approvals, reports, modelContinuationOutputs: outputs });
  }
  const enabled = results.find((result) => result.mode === "enabled");
  const accepted = /error:.*not assignable/.test(enabled.reports[0]) && /no diagnostics reported/.test(enabled.reports[1]);
  const uri = pathToFileURL(join(workspace, "a.ts")).href;
  const pushes = launches.map((launch) => launch.messages.filter((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri));
  const pulls = launches.map((launch) => launch.messages.filter((m) => m.id === 2 && m.result?.kind === "full"));
  const wireSemanticError = pushes[0].some((m) => m.params.diagnostics.some((d) => d.code === 2322))
    || pulls[0].some((m) => m.result.items.some((d) => Number(d.code) === 2322));
  const wireCorrectedEmpty = pushes[1].some((m) => m.params.diagnostics.length === 0)
    || pulls[1].some((m) => m.result.items.length === 0);
  const evidence = { candidate, accepted, wireSemanticError, wireCorrectedEmpty, node: process.version, versions, workspace,
    provenance: Object.fromEntries(Object.entries(provenance.packages).filter(([key]) => key.startsWith("node_modules/")).map(([key, value]) => [key, { version: value.version, resolved: value.resolved, integrity: value.integrity }])), results, launches };
  await writeFile(join(workspace, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ accepted, wireSemanticError, wireCorrectedEmpty, versions, results: results.map(({ mode, reports }) => ({ mode, reports })), evidence: join(workspace, "evidence.json") }, null, 2));
  // A protocol trace is not acceptance: both actual runtime reports must succeed.
  if (!accepted) process.exitCode = 2;
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
