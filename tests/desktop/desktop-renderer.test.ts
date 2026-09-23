import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function renderer() {
  const nodes = new Map<string, any>();
  const element = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", value: "", disabled: false, hidden: true, children: [],
      setAttribute() {}, focus() {},
      append(node: any) { this.children.push(node); }, replaceChildren() { this.children = []; },
      get childElementCount() { return this.children.length; } });
    return nodes.get(id);
  };
  let status: () => Promise<unknown> = async () => ({ session: { id: "session" } });
  const context = vm.createContext({ document: { getElementById: element, createElement: () => element(`generated-${nodes.size}`) },
    window: { addEventListener() {}, dragons: { events: () => new Promise(() => {}),
      request: async (message: { type: string }) => ({ ok: true, value: message.type === "status" ? await status() : [] }) } },
    setTimeout, Error, Promise, TextEncoder });
  vm.runInContext(await readFile(new URL("../../desktop/renderer.js", import.meta.url), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("session={id:'session',provider:'fixture',model:'fixture'};mayControl=false;controls();", context);
  return { context, nodes, setStatus: (next: typeof status) => { status = next; }, run: (code: string): any => vm.runInContext(code, context) };
}

test("LSP Desktop rejects missing, oversized and hostile scope without an allow action", async () => {
  const f = await renderer();
  f.run("mayControl=true;runId='run';globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return {ok:true,value:true}};");
  for (const lspApproval of [undefined, {command:"/node",args:["x\u001b[2J"],document:"a.ts"}, {command:"/node",args:["x\u202ejs"],document:"a.ts"}, {command:"/node",args:["x".repeat(2049)],document:"a.ts"}, {command:"/node",args:Array(16).fill("x".repeat(500)),document:"a.ts"}]) {
    f.run(`receive(${JSON.stringify({type:"approval_requested",sessionId:"session",runId:"run",approvalId:"approval",toolName:"lsp_diagnostics_start",operation:"EXECUTE",lspApproval})})`);
    assert.equal(f.run("approval"), undefined); assert.equal(f.nodes.get("approval").hidden,true);
    assert.equal(f.nodes.get("approval-label").textContent, "");
    await f.run("$('allow').onclick()");
  }
  assert.equal(f.run("requests.length"),5);
  assert.equal(f.run("requests.every(r=>r.decision==='deny')"),true);
});

test("LSP Desktop approval distinguishes interpreter scripts and renders full document scope", async () => {
  const f = await renderer();
  const labels: string[] = [];
  for (const script of ["/trusted/server-A.js", "/trusted/server-B.js"]) {
    const event = { type: "approval_requested", sessionId: "session", runId: "run", approvalId: "approval", operation: "EXECUTE", toolName: "lsp_diagnostics_start", lspApproval: { command: "/usr/bin/node", args: [script], document: "src/a.ts" } };
    f.run(`receive(${JSON.stringify(event)})`);
    const label = f.nodes.get("approval-label").textContent;
    assert.ok(label.includes(script)); assert.ok(label.includes("src/a.ts")); labels.push(label);
  }
  assert.notEqual(labels[0], labels[1]);
});

test("M78 update UI uses intent-only requests and keeps disabled/unavailable honest", async () => {
  const f = await renderer();
  f.run("globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return {ok:true,value:{state:'disabled',canCheck:false,canCancel:false,canInstall:false}}}");
  await f.run("updateAction('update_status')");
  assert.match(f.nodes.get('update-status').textContent, /Updates disabled/);
  await f.run("$('update-check').onclick()");
  assert.equal(f.run('requests.length'), 1);
  f.run("updateStatus={state:'idle',canCheck:true};window.dragons.request=async r=>{requests.push(r);return {ok:true,value:{state:'available',canCheck:true,canInstall:false,version:'<script>unsafe</script>'}}};updateControls()");
  await f.run("$('update-check').onclick()");
  assert.equal(f.run("requests[1].type"), 'update_check');
  assert.equal(f.run("Object.keys(requests[1]).length"), 1);
  assert.match(f.nodes.get('update-status').textContent, /Installation unavailable/);
  assert.ok(!f.nodes.get('update-status').textContent.includes('<script>'));
  f.run("window.dragons.request=async()=>{throw new Error('private')}");
  await f.run("updateAction('update_status')");
  assert.equal(f.nodes.get('update-check').disabled, true);
  assert.match(f.nodes.get('update-status').textContent, /unavailable/);
});

test("M78 update UI cancel wins over late polling and disconnect blocks checks", async () => {
  const f = await renderer();
  f.run("updateStatus={state:'checking',canCancel:true};globalThis.pending=undefined;window.dragons.request=r=>r.type==='update_status'?new Promise(resolve=>{pending=resolve}):Promise.resolve({ok:true,value:{state:'cancelled',canCheck:true,canCancel:false}})");
  const pending = f.run("updateAction('update_status')");
  await f.run("$('update-cancel').onclick()");
  f.run("pending({ok:true,value:{state:'available',canCheck:true}})"); await pending;
  assert.match(f.nodes.get('update-status').textContent, /cancelled/);
  f.run("receive({type:'client_disconnected',message:'Closed'})");
  assert.equal(f.nodes.get('update-check').disabled, true);
  assert.equal(f.nodes.get('update-cancel').disabled, true);
  assert.match(f.nodes.get('update-status').textContent, /disconnected/);
});

test("M78 prepare requires an explicit trusted capability and sends only intent", async () => {
  const f = await renderer();
  f.run("globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return {ok:true,value:{state:'preparing',canPrepare:false,canCancel:true}}}");
  for (const capability of ["undefined", "false", "'true'", "1"]) {
    f.run(`updateStatus={state:'idle',canCheck:true,canPrepare:${capability}};updateControls()`);
    assert.equal(f.nodes.get('update-prepare').disabled, true);
    await f.run("$('update-prepare').onclick()");
  }
  assert.equal(f.run('requests.length'), 0);
  f.run("updateStatus={state:'idle',canPrepare:true};updateControls()");
  assert.equal(f.nodes.get('update-prepare').disabled, false);
  await f.run("$('update-prepare').onclick()");
  assert.equal(f.run('JSON.stringify(requests)'), '[{"type":"update_prepare"}]');
  assert.match(f.nodes.get('update-status').textContent, /Preparing/);
  assert.equal(f.nodes.get('update-prepare').disabled, true);
  assert.equal(f.nodes.get('update-cancel').disabled, false);
});

test("M78 prepare blocks double clicks, fails closed on errors and disconnect", async () => {
  const f = await renderer();
  f.run("updateStatus={state:'idle',canPrepare:true};globalThis.requests=[];window.dragons.request=r=>{requests.push(r);return new Promise(resolve=>{globalThis.finish=resolve})};updateControls()");
  const pending = f.run("$('update-prepare').onclick()");
  await f.run("$('update-prepare').onclick()");
  assert.equal(f.run('requests.length'), 1);
  assert.equal(f.nodes.get('update-prepare').disabled, true);
  f.run("finish({ok:false,error:{message:'private host failure'}})"); await pending;
  assert.equal(f.nodes.get('update-prepare').disabled, true);
  assert.match(f.nodes.get('update-status').textContent, /unavailable/);
  assert.ok(!f.nodes.get('update-status').textContent.includes('private'));
  f.run("updateStatus={state:'idle',canPrepare:true};receive({type:'client_disconnected',message:'Closed'})");
  await f.run("$('update-prepare').onclick()");
  assert.equal(f.run('requests.length'), 1);
  assert.equal(f.nodes.get('update-prepare').disabled, true);
});

test("M78 preparing polls to prepared without exposing installation", async () => {
  const f = await renderer();
  f.run("updateStatus={state:'preparing',canCancel:true};updatePoll=19;globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return {ok:true,value:{state:'prepared',canPrepare:false,canCancel:false,canInstall:false}}}");
  await f.run('pollUpdate()');
  assert.equal(f.run('JSON.stringify(requests)'), '[{"type":"update_status"}]');
  assert.match(f.nodes.get('update-status').textContent, /prepared.*Installation unavailable/i);
  assert.equal(f.nodes.get('update-prepare').disabled, true);
  for (let i = 0; i < 25; i++) await f.run('pollUpdate()');
  assert.equal(f.run('requests.length'), 1);
  const html = await readFile(new URL('../../desktop/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="update-prepare" disabled/);
  assert.doesNotMatch(html, /id="update-install"/);
});

test("M78 prepare cancellation deduplicates and polls until cleanup completes", async () => {
  const f = await renderer();
  f.run("updateStatus={state:'preparing',canCancel:true};globalThis.requests=[];window.dragons.request=r=>{requests.push(r);return new Promise(resolve=>{globalThis.finish=resolve})};updateControls()");
  const pending = f.run("$('update-cancel').onclick()");
  await f.run("$('update-cancel').onclick()");
  assert.equal(f.run('JSON.stringify(requests)'), '[{"type":"update_cancel"}]');
  f.run("finish({ok:true,value:{state:'cancelled',canCheck:false,canPrepare:false,canCancel:false}})"); await pending;
  assert.match(f.nodes.get('update-status').textContent, /cleanup/i);
  f.run("updatePoll=19;window.dragons.request=async r=>{requests.push(r);return {ok:true,value:{state:'cancelled',canCheck:true,canPrepare:true,canCancel:false}}}");
  await f.run('pollUpdate()');
  assert.equal(f.run('requests.length'), 2);
  assert.equal(f.nodes.get('update-prepare').disabled, false);
  assert.doesNotMatch(f.nodes.get('update-status').textContent, /cleanup/i);
  for (let i = 0; i < 25; i++) await f.run('pollUpdate()');
  assert.equal(f.run('requests.length'), 2);
});

test("desktop model picker isolates provider drafts without executing requests", async () => {
  const f = await renderer();
  f.run("globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return {ok:true,value:[]}};providers=[{id:'one',defaultModel:'a',modelCatalogue:['a','vendor/b','bad id']},{id:'two',defaultModel:'z'}];$('provider').value='one';$('provider').onchange();");
  assert.deepEqual(Array.from(f.nodes.get('model-options').children, (n: any) => n.value), ['a', 'vendor/b']);
  f.run("$('model').value='custom/exact-ID';$('model').oninput();$('provider').value='two';$('provider').onchange();$('provider').value='one';$('provider').onchange();");
  assert.equal(f.nodes.get('model').value, 'custom/exact-ID');
  assert.equal(f.run('requests.length'), 0);
});

test("desktop reasoning applies only explicitly through local slash and reads host state", async () => {
  const f = await renderer();
  f.run("globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return {ok:true,value:r.type==='choices'?[{value:'/reasoning default',description:'Provider decides'},{value:'/reasoning high',description:'Verified'}]:{kind:'text',text:'Reasoning: high. Available: default, high.'}}};");
  await f.run('refreshReasoning()');
  assert.equal(f.nodes.get('reasoning').disabled, false);
  f.run("$('reasoning').value='high';$('reasoning').onchange()");
  assert.equal(f.run("requests.some(r=>r.content==='/reasoning high')"), false);
  await f.run("$('apply-reasoning').onclick()");
  assert.equal(f.run("requests.filter(r=>r.content==='/reasoning high').length"), 1);
  assert.match(f.nodes.get('reasoning-status').textContent, /Reasoning: high/);
  assert.equal(f.run("requests.every(r=>r.type==='choices'||r.type==='slash')"), true);
  f.run('busy=true;controls()');
  assert.equal(f.nodes.get('reasoning').disabled, true);
  assert.equal(f.nodes.get('apply-reasoning').disabled, true);
});

test("desktop reasoning ignores stale session metadata and unsupported models", async () => {
  const f = await renderer();
  f.run('globalThis.resolveChoices=undefined;window.dragons.request=r=>new Promise(resolve=>{resolveChoices=resolve});');
  const pending = f.run('refreshReasoning()');
  f.run("session={id:'other',provider:'two',model:'unknown'};resolveChoices({ok:true,value:[{value:'/reasoning high',description:'old'}]});");
  await pending;
  assert.equal(f.nodes.get('reasoning').children.length, 0);
  f.run('window.dragons.request=async()=>({ok:true,value:[]})');
  await f.run('refreshReasoning()');
  assert.equal(f.nodes.get('reasoning').disabled, true);
  assert.match(f.nodes.get('reasoning-status').textContent, /unavailable|unsupported/i);
});

test("desktop model creation preserves exact IDs and resume synchronizes picker", async () => {
  const f = await renderer();
  f.run("globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return r.type==='create'?{ok:false,error:{message:'Invalid model'}}:{ok:true,value:r.type==='resume'?{id:'saved',provider:'two',model:'custom/saved'}:r.type==='status'?{}:[]}};$('provider').value='one';$('model').value=' custom/id ';");
  await f.run("$('create').onclick()");
  assert.equal(f.run('requests[0].model'), ' custom/id ');
  assert.match(f.nodes.get('error').textContent, /Invalid model/);
  await f.run("$('resume').onclick()");
  assert.equal(f.nodes.get('provider').value, 'two');
  assert.equal(f.nodes.get('model').value, 'custom/saved');
  assert.equal(f.run("requests.some(r=>r.type==='send'||r.content?.startsWith('/login'))"), false);
});

test("desktop reasoning rejection retains host state and disconnect blocks selection", async () => {
  const f = await renderer();
  f.run("globalThis.requests=[];window.dragons.request=async r=>{requests.push(r);return {ok:true,value:r.type==='choices'?[{value:'/reasoning default',description:'Reset'},{value:'/reasoning high',description:'High'}]:{kind:'text',text:r.content==='/reasoning default'?'Unable to set reasoning: profile could not be saved.':'Reasoning: high.'}}};");
  await f.run('refreshReasoning()');
  f.run("$('reasoning').value='default'");
  await f.run("$('apply-reasoning').onclick()");
  assert.equal(f.nodes.get('reasoning-status').textContent, 'Reasoning: high.');
  assert.match(f.nodes.get('messages').children[0].textContent, /Unable to set/);
  f.run("receive({type:'client_disconnected',message:'Closed'});globalThis.before=requests.length;$('reasoning').value='high'");
  await f.run("$('apply-reasoning').onclick()");
  assert.equal(f.run('requests.length===before'), true);
  assert.equal(f.nodes.get('reasoning').disabled, true);
});

test("desktop completion keyboard/click only fill input; Escape cannot send", async () => {
  const f = await renderer();
  f.run("globalThis.requests=[]; window.dragons.request=async(input)=>{requests.push(input);return {ok:true,value:[{value:'/login chatgpt',description:'OAuth'},{value:'/login local',description:'No auth'}]}}; $('prompt').value='/login ';");
  await f.run("updateChoices()");
  f.run("$('prompt').onkeydown({key:'ArrowDown',preventDefault(){}}); $('prompt').onkeydown({key:'Tab',preventDefault(){}})");
  assert.equal(f.nodes.get("prompt").value, "/login local ");
  await new Promise((resolve) => setImmediate(resolve));
  f.run("choiceBox.children[0].onclick()");
  assert.equal(f.nodes.get("prompt").value, "/login chatgpt ");
  f.run("$('prompt').onkeydown({key:'Escape',preventDefault(){}})");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.run("choiceBox.hidden"), true);
  assert.equal(f.run("requests.every(r=>r.type==='choices')"), true);
});

test("M75 renderer does not resurrect a completed run from a late status reply", async () => {
  const f = await renderer(); let resolve!: (value: unknown) => void;
  f.setStatus(() => new Promise((yes) => { resolve = yes; }));
  f.run("receive({type:'run_started',runId:'run',sessionId:'session'});");
  const refreshed = f.run("refresh()");
  f.run("receive({type:'run_completed',runId:'run',sessionId:'session',result:{finalText:'done'}});");
  resolve({ activeRunId: "run", session: { id: "session" }, shared: { clientId: "observer", ownerClientId: "owner", revision: 1 } });
  await refreshed;
  assert.equal(f.run("busy"), false); assert.equal(f.run("runId"), undefined);
  assert.equal(f.nodes.get("send").disabled, false);
});

test("M75 renderer reconciles an idle status and ignores a stale refresh after session switch", async () => {
  const f = await renderer();
  f.run("runId='stale';busy=true;");
  await f.run("refresh()"); assert.equal(f.run("busy"), false); assert.equal(f.run("runId"), undefined);
  let resolve!: (value: unknown) => void;
  f.setStatus(() => new Promise((yes) => { resolve = yes; }));
  const refreshed = f.run("refresh()");
  f.run("session={id:'new-session',provider:'fixture',model:'other'};");
  resolve({ activeRunId: "old-session-run", session: { id: "session" } }); await refreshed;
  assert.equal(f.run("runId"), undefined);
});

test("M75 renderer accepts matching ownership metadata when run-start arrives before status", async () => {
  const f = await renderer(); let resolve!: (value: unknown) => void;
  f.run("mayControl=true;"); f.setStatus(() => new Promise((yes) => { resolve = yes; }));
  const refreshed = f.run("refresh()");
  f.run("receive({type:'run_started',runId:'run',sessionId:'session'});");
  resolve({ activeRunId: "run", session: { id: "session" }, shared: { clientId: "observer", ownerClientId: "owner", revision: 1 } });
  await refreshed; assert.equal(f.run("busy"), true); assert.equal(f.nodes.get("cancel").disabled, true);
});

test("desktop renderer routes slash before session admission and applies session/restart replies", async () => {
  const f = await renderer();
  f.run("session=undefined;controls();globalThis.requests=[];window.dragons.request=async (input)=>{requests.push(input);return {ok:true,value:{kind:'text',text:'Commands: /new'}}};");
  assert.equal(f.nodes.get("send").disabled, false);
  f.run("$('prompt').value='/help'");
  await f.run("$('composer').onsubmit({preventDefault(){}})");
  assert.equal(f.run("requests[0].type"), "slash");
  assert.equal(f.nodes.get("messages").children[0].textContent, "Commands: /new");
  f.run("window.dragons.request=async (input)=>({ok:true,value:input.type==='slash'?{kind:'session',session:{id:'new',provider:'fixture',model:'fixture'}}:input.type==='status'?{}:[]});");
  f.nodes.get("prompt").value = "/new";
  await f.run("$('composer').onsubmit({preventDefault(){}})");
  assert.equal(f.run("session.id"), "new");
  f.run("window.dragons.request=async()=>({ok:true,value:{kind:'restart',text:'Restart required'}});");
  f.nodes.get("prompt").value = "/profile select work";
  await f.run("$('composer').onsubmit({preventDefault(){}})");
  assert.equal(f.run("stopped"), true); assert.equal(f.run("session"), undefined);
  assert.equal(f.nodes.get("send").disabled, true);
});

test("late slash admission cannot overwrite a subsequent composer run", async () => {
  const f = await renderer();
  f.run("globalThis.admissions=[];window.dragons.request=r=>r.type==='slash'?new Promise(resolve=>admissions.push(resolve)):Promise.resolve({ok:true,value:r.type==='status'?{}:[]})");
  f.nodes.get("prompt").value = "/checkpoint";
  const first = f.run("$('composer').onsubmit({preventDefault(){}})");
  f.run("receive({type:'run_started',sessionId:'session',runId:'first'});receive({type:'run_completed',sessionId:'session',runId:'first',result:{finalText:'first done'}})");
  await new Promise((resolve) => setImmediate(resolve));
  f.nodes.get("prompt").value = "/rollback fixture";
  const second = f.run("$('composer').onsubmit({preventDefault(){}})");
  assert.equal(f.run("admissions.length"), 2);
  f.run("admissions[0]({ok:true,value:{runId:'first',sessionId:'session'}})"); await first;
  assert.equal(f.nodes.get("send").disabled, true, "old finally must not clear pending submission");
  assert.equal(f.run("runId"), undefined, "old admission must not attach to the new submission");
  f.run("admissions[1]({ok:true,value:{runId:'second',sessionId:'session'}})"); await second;
  assert.equal(f.run("runId"), "second");
  assert.equal(f.nodes.get("cancel").disabled, false);
});

for (const content of ["/checkpoint", "/rollback fixture"]) {
  for (const delayReply of [false, true]) {
    test(`composer -> real bridge -> events and cancel: ${content}, delayed admission=${delayReply}`, async (t) => {
      const { DesktopBridge } = await import("../../dist/desktop/bridge.js");
      const f = await renderer();
      const sessionId = "12345678-1234-1234-1234-123456789012";
      const runId = "checkpoint-run";
      const current = { id: sessionId, provider: "local", model: "fixture" };
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      let releaseReply!: () => void;
      const replyGate = new Promise<void>((resolve) => { releaseReply = resolve; });
      const inputs: unknown[] = [];
      const cancellations: string[] = [];
      const events: string[] = [];
      const runtime = {
        providers: () => [], createSession: async () => current,
        status: async () => ({ session: current }), listBackgroundTasks: async () => [],
        dispose: async () => { finish(); },
        cancelRun: (id: string) => { cancellations.push(id); finish(); return true; },
        sendUserInput: async (input: unknown) => {
          inputs.push(input);
          return { id: runId, sessionId, result: done, cancel: finish,
            events: (async function* () {
              yield { type: "run_started", runId, sessionId };
              yield { type: "assistant_delta", runId, sessionId, text: "checkpoint output" };
              await done;
              yield { type: "run_cancelled", runId, sessionId };
            })() };
        },
      };
      const bridge = new DesktopBridge(runtime as unknown as import("../../dist/runtime.js").DragonsRuntime, (event) => {
        events.push(event.type); f.context.hostEvent = event; f.run("receive(hostEvent)");
      });
      t.after(() => bridge.close());
      assert.equal((await bridge.request({ type: "create" })).ok, true);
      f.context.hostRequest = async (input: any) => {
        // Electron structured clone crosses the VM's object-prototype boundary.
        const reply = await bridge.request(structuredClone(input));
        if (input.type === "slash" && delayReply) await replyGate;
        return reply;
      };
      f.context.hostSession = current;
      f.run("session=hostSession;assistant=message('assistant','previous answer');window.dragons.request=hostRequest");
      f.nodes.get("prompt").value = content;
      const submitted = f.run("$('composer').onsubmit({preventDefault(){}})");
      await new Promise((resolve) => setImmediate(resolve));
      if (!delayReply) await submitted;
      assert.deepEqual(inputs, [{ sessionId, content }]);
      assert.deepEqual(events, ["run_started", "assistant_delta"]);
      assert.equal(f.nodes.get("send").disabled, true);
      assert.equal(f.nodes.get("cancel").disabled, false);
      assert.equal(f.nodes.get("messages").children[0].textContent, "previous answer");
      assert.equal(f.nodes.get("messages").children[1].textContent, "checkpoint output");
      assert.equal(f.nodes.get("error").textContent, "");
      await f.run("$('cancel').onclick()");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(cancellations, [runId]);
      assert.equal(events.at(-1), "run_cancelled");
      releaseReply(); await submitted;
      assert.equal(f.run("runId"), undefined);
      assert.equal(f.nodes.get("cancel").disabled, true);
      assert.equal(f.nodes.get("send").disabled, false);
    });
  }
}

for (const content of ["hello", "/checkpoint", "/rollback fixture"]) {
  for (const timing of ["admission-first", "events-first", "terminal-first", "disconnect-first", "rejected"]) {
    test(`composer run lifecycle: ${content} / ${timing}`, async () => {
      const f = await renderer();
      f.run("assistant=message('assistant','previous answer');globalThis.requests=[];globalThis.admit=undefined;window.dragons.request=r=>{requests.push(r);return ['send','slash'].includes(r.type)?new Promise(resolve=>{admit=resolve}):Promise.resolve({ok:true,value:r.type==='status'?{}:[]})}");
      f.nodes.get("prompt").value = content;
      const submitted = f.run("$('composer').onsubmit({preventDefault(){}})");
      assert.equal(f.nodes.get("send").disabled, true);
      assert.equal(f.nodes.get("cancel").disabled, true);
      assert.equal(f.run("requests[0].type"), content.startsWith("/") ? "slash" : "send");
      assert.equal(f.run("requests[0].content"), content);
      if (timing !== "admission-first" && timing !== "rejected") {
        f.run("receive({type:'run_started',sessionId:'session',runId:'run'});receive({type:'assistant_delta',sessionId:'session',runId:'run',text:'new output'})");
        assert.equal(f.nodes.get("cancel").disabled, false);
      }
      if (timing === "terminal-first") f.run("receive({type:'run_completed',sessionId:'session',runId:'run',result:{finalText:'done'}})");
      if (timing === "disconnect-first") f.run("receive({type:'client_disconnected',message:'Closed'})");
      f.run(timing === "rejected" ? "admit({ok:false,error:{message:'Rejected'}})" : "admit({ok:true,value:{runId:'run',sessionId:'session'}})");
      await submitted;
      await new Promise((resolve) => setImmediate(resolve));
      if (["terminal-first", "disconnect-first", "rejected"].includes(timing)) {
        assert.equal(f.run("runId"), undefined);
        assert.equal(f.nodes.get("cancel").disabled, true);
        assert.equal(f.nodes.get("send").disabled, timing === "disconnect-first");
      } else {
        assert.equal(f.run("runId"), "run");
        assert.equal(f.nodes.get("send").disabled, true);
        assert.equal(f.nodes.get("cancel").disabled, false);
        await f.run("$('cancel').onclick()");
        assert.equal(f.run("JSON.stringify(requests.at(-1))"), '{"type":"cancel","runId":"run"}');
        if (timing === "admission-first") f.run("receive({type:'run_started',sessionId:'session',runId:'run'});receive({type:'assistant_delta',sessionId:'session',runId:'run',text:'new output'})");
        f.run("receive({type:'run_cancelled',sessionId:'session',runId:'run'})");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.nodes.get("send").disabled, false);
      }
      assert.equal(f.nodes.get("messages").children[0].textContent, "previous answer", "new runs must not reuse the previous assistant node");
      assert.doesNotMatch(f.nodes.get("error").textContent, /slice|undefined/);
    });
  }
}
