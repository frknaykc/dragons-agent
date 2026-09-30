import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { main } from "../../dist/cli.js";
import { type AgentModel } from "../../dist/agent.js";
import { parseLspConfig } from "../../dist/lsp-diagnostics.js";
import { createProviderRegistry } from "../../dist/provider/registry.js";
import { createDragonsRuntime, type RuntimeEvent } from "../../dist/runtime.js";
import { createSessionSearchTools } from "../../dist/session-search.js";
import { createSessionStore } from "../../dist/session-store.js";
import { createCodingTools } from "../../dist/tools.js";
const lsp = parseLspConfig({ command: process.execPath, args: [resolve("tests/fixtures/lsp-server.mjs"), "pull"], extensions: [".ts"], languageId: "typescript" });
async function assertDurableObservation(root: string, store: ReturnType<typeof createSessionStore>, allow: boolean) {
  const sessions = await store.list(); assert.equal(sessions.length, 1);
  const session = sessions[0]!;
  assert.equal(session.toolHistory?.length, 1);
  assert.equal(session.toolHistory![0]!.name, "write_file");
  assert.match(session.toolHistory![0]!.output, /Checkpoint .*1 file\(s\) changed/);
  const raw = await readFile(join(root, "sessions", `${session.id}.json`), "utf8");
  assert.doesNotMatch(raw, /EXECUTE denied|lsp_diagnostics_start/);
  const [search, read] = createSessionSearchTools(store, root);
  assert.equal(JSON.parse((await search!.execute({ query: "denied" })).output).results.length, 0);
  const projection = (await read!.execute({ sessionId: session.id })).output;
  assert.match(projection, /write_file/); assert.doesNotMatch(projection, /EXECUTE denied/);
  if (allow) assert.match(projection, /Type mismatch/);
}
function model(expected: RegExp = /Type mismatch/): AgentModel {
  let turn = 0;
  return { async respond(request) {
    if (++turn === 1) return { responseId: "1", text: "", toolCalls: [{ callId: "w", name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: "let a: number = 'bad';" }) }] };
    assert.match(request.toolOutputs[0]!.output, expected);
    return { responseId: "2", text: "done", toolCalls: [] };
  } };
}
for (const allow of [false, true]) for (const interactive of [false, true]) test(`CLI ${interactive ? "interactive" : "plain"} displays LSP report after separate EXECUTE approval (${allow})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-lsp-cli-")); let output = "";
  try {
    await main(interactive ? [] : ["edit"], { config: { lsp }, configPath: join(root, "config.json"), workingDirectory: root,
      sessionDirectory: join(root, "sessions"), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills"),
      model: model(allow ? /Type mismatch/ : /EXECUTE denied/), tools: await createCodingTools(root), input: Readable.from([`${interactive ? "edit\n" : ""}y\n${allow ? "y" : "n"}\n${interactive ? "/exit\n" : ""}`]),
      write: (text) => { output += text; }, terminal: { inputIsTTY: false, outputIsTTY: false, color: false },
    });
    assert.match(output, /EXECUTE lsp_diagnostics_start/); assert.match(output, allow ? /3:5 error: Type mismatch/ : /EXECUTE denied/); assert.doesNotMatch(output, /fixture-secret/);
    if (interactive) await assertDurableObservation(root, createSessionStore(join(root, "sessions")), allow);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("real runtime → Desktop bridge preserves script A/B scope and denies unsafe scopes before emission", async () => {
  const seen: RuntimeEvent[] = [];
  const labels: string[] = [];
  const nodes = new Map<string, any>();
  const element = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, {textContent:"",value:"",disabled:false,hidden:true,children:[],setAttribute(){},focus(){},append(node:any){this.children.push(node);},replaceChildren(){this.children=[];},get childElementCount(){return this.children.length;}});
    return nodes.get(id);
  };
  const context = vm.createContext({document:{getElementById:element,createElement:()=>element(`generated-${nodes.size}`)},window:{addEventListener(){},dragons:{events:()=>new Promise(()=>{}),request:async()=>({ok:true,value:[]})}},setTimeout,Error,Promise,TextEncoder});
  vm.runInContext(await readFile(new URL("../../desktop/renderer.js",import.meta.url),"utf8"),context);
  await new Promise(resolve=>setImmediate(resolve));
  for (const args of [["/trusted/server-A.js"], ["/trusted/server-B.js"], ["--token", "fixture-secret"], ["x\u202ejs"], Array(8).fill("x".repeat(1000))]) {
    const root = await mkdtemp(join(tmpdir(),"dragons-lsp-bridge-"));
    const unsafe = args.length > 1 || args[0]!.includes("\u202e");
    const providers = createProviderRegistry([{id:"fixture",label:"Fixture",defaultModel:"fixture",credentialRequirement:"none",capabilities:{streaming:true,toolCalls:true,toolResultContinuation:true,usageMetadata:false},createModel:()=>model(unsafe?/scope cannot be safely displayed/:/EXECUTE denied/)}]);
    const runtime = await createDragonsRuntime({workingDirectory:root,lsp:{...lsp,args},providerRegistry:providers,sessionStore:createSessionStore(join(root,"sessions"),{providerIds:providers.ids()}),memoryDirectory:join(root,"memory"),skillsDirectory:join(root,"skills")});
    let complete!:()=>void; const finished = new Promise<void>(resolve=>{complete=resolve;});
    const events: RuntimeEvent[] = []; const replies: Promise<unknown>[] = [];
    const bridge = new DesktopBridge(runtime,event=>{
      events.push(event);
      vm.runInContext(`session={id:${JSON.stringify(event.sessionId)}};receive(${JSON.stringify(event)})`,context);
      if(event.type==="approval_requested"&&event.toolName==="lsp_diagnostics_start") labels.push(element("approval-label").textContent);
      if(event.type==="approval_requested") replies.push(bridge.request({type:"approve",sessionId:event.sessionId,runId:event.runId,approvalId:event.approvalId,decision:event.operation==="WRITE"?"allow_once":"deny"}));
      if(["run_completed","run_failed","run_cancelled"].includes(event.type)) complete();
    });
    try {
      assert.equal((await bridge.request({type:"create"})).ok,true);
      assert.equal((await bridge.request({type:"send",content:"edit"})).ok,true);
      await finished; await Promise.all(replies);
      assert.equal(events.at(-1)!.type,"run_completed");
      const approvals=events.filter(e=>e.type==="approval_requested");
      assert.equal(approvals.length,unsafe?1:2);
      if(!unsafe) assert.deepEqual(approvals[1]!.lspApproval,{command:lsp.command,args,document:"a.ts"});
      assert.doesNotMatch(JSON.stringify(events),/fixture-secret|\\u202e/); seen.push(...approvals);
    } finally {await bridge.close();await runtime.dispose();await rm(root,{recursive:true,force:true});}
  }
  const scopes=seen.flatMap(e=>e.type==="approval_requested"&&e.lspApproval?[e.lspApproval]:[]);
  assert.equal(scopes.length,2); assert.notDeepEqual(scopes[0],scopes[1]);
  assert.equal(labels.length,2); assert.match(labels[0]!,/server-A\.js/); assert.match(labels[1]!,/server-B\.js/);
  for(const label of labels) {assert.ok(label.includes(JSON.stringify(lsp.command)));assert.match(label,/Document: "a\.ts"/);}
});

for (const allow of [false, true]) test(`Desktop's runtime stream carries bounded diagnostics and independent one-use EXECUTE approval (${allow})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-lsp-runtime-"));
  const providers = createProviderRegistry([{ id: "fixture", label: "Fixture", defaultModel: "fixture-1", credentialRequirement: "none", capabilities: { streaming: true, toolCalls: true, toolResultContinuation: true, usageMetadata: false }, createModel: () => model(allow ? /Type mismatch/ : /EXECUTE denied/) }]);
  const runtime = await createDragonsRuntime({ workingDirectory: root, lsp, providerRegistry: providers, sessionStore: createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), memoryDirectory: join(root, "memory"), skillsDirectory: join(root, "skills") });
  try {
    const session = await runtime.createSession(); const run = await runtime.sendUserInput({ sessionId: session.id, content: "edit" }); const events: RuntimeEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "approval_requested") {
        if (event.toolName === "lsp_diagnostics_start") assert.deepEqual((event as any).lspApproval, { command: lsp.command, args: lsp.args, document: "a.ts" });
        assert.equal(runtime.resolveAuthorization({ runId: run.id, approvalId: event.approvalId, decision: event.operation === "EXECUTE" && !allow ? "deny" : "allow_session" }), true);
        assert.equal(runtime.resolveAuthorization({ runId: run.id, approvalId: event.approvalId, decision: "allow_once" }), false);
      }
    }
    await run.result;
    assert.deepEqual(events.flatMap((e) => e.type === "approval_requested" ? [e.operation] : []), ["WRITE", "EXECUTE"]);
    const completed = events.filter((e) => e.type === "tool_activity" && e.phase === "completed");
    assert.match(JSON.stringify(completed), allow ? /Type mismatch/ : /EXECUTE denied/); assert.doesNotMatch(JSON.stringify(events), /fixture-secret/);
    await assertDurableObservation(root, createSessionStore(join(root, "sessions"), { providerIds: providers.ids() }), allow);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
