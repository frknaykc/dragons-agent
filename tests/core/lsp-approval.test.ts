import assert from "node:assert/strict";
import test from "node:test";
import { validateLspApproval, lspApprovalFromArguments } from "../../dist/lsp-approval.js";
import { TerminalRenderer } from "../../dist/terminal/renderer.js";

test("scope is bounded, allowlisted, control-safe and rejects lossy redaction", () => {
  const scope = {command: process.execPath, args:["/trusted/server.js"], document:"src/a.ts"};
  for (const args of [["token=fixture-secret"], ["--token", "fixture-secret"], ["Bearer fixture-secret"], ["ghp_abcdefghijklmnopqrst"], ["https://user:fixture-secret@example.invalid"], ["x\u001b[2J"], ["x\u202ejs"], ["x\u200bjs"], ["x\u0085js"], ["x".repeat(2049)], Array(16).fill("x".repeat(500)), ["é".repeat(1500), "é".repeat(1500)], ["[REDACTED]"]]) {
    assert.equal(validateLspApproval({...scope,args}),undefined);
    let output="";
    new TerminalRenderer({isTTY:true,color:false,width:40,write:s=>{output+=s;}}).renderApproval({name:"lsp_diagnostics_start",operation:"EXECUTE",arguments:JSON.stringify({command:scope.command,args,path:scope.document})});
    assert.match(output,/Denied/); assert.doesNotMatch(output,/fixture-secret|Allow once|\u001b|\u202e/);
  }
  assert.equal(validateLspApproval({...scope,secret:"fixture-secret"}),undefined);
  assert.equal(lspApprovalFromArguments(JSON.stringify({...scope,path:"a.ts",raw:"fixture-secret"})),undefined);
  assert.deepEqual(validateLspApproval({...scope,args:["", "with spaces", "a\"b"]}),{...scope,args:["", "with spaces", "a\"b"]});
});

test("actual TTY renderer distinguishes interpreter scripts and includes full document scope", () => {
  const outputs: string[] = [];
  for (const script of ["/trusted/server-A.js", "/trusted/server-B.js"]) {
    let output = "";
    const renderer = new TerminalRenderer({ isTTY: true, color: false, write: (text) => { output += text; }, width: 40 });
    renderer.renderApproval({name:"lsp_diagnostics_start", operation:"EXECUTE", arguments:JSON.stringify({command:"/usr/bin/node",args:[script],path:"src/a.ts"})});
    assert.ok(output.includes(script)); assert.ok(output.includes("src/a.ts")); outputs.push(output);
  }
  assert.notEqual(outputs[0],outputs[1]);
});
