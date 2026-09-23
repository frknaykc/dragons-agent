import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLspDiagnostics } from '../../dist/lsp-diagnostics.js';

test('cumulative output budget follows bytes, not transport chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsp-budget-'));
  const original = childProcess.spawn;
  const TOTAL = 2097152;
  const frame = m => { const body = JSON.stringify({jsonrpc:'2.0', ...m}); return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
  const init = frame({id:1,result:{capabilities:{diagnosticProvider:{}}}});
  const diagnostic = frame({id:2,result:{kind:'full',items:[{range:{start:{line:0,character:0}},message:'EXPECTED'}]},padding:'x'});
  const log = size => {
    for (let n = size - 120; n < size; n++) {
      const result = frame({method:'window/logMessage',params:{message:'x'.repeat(n)}});
      if (result.length === size) return result;
    }
    throw new Error('cannot construct exact-size frame');
  };
  let chunks, stderrBytes, killed, exits;
  childProcess.spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed++; queueMicrotask(() => child.emit('close', 0)); return true; };
    child.stdin = new Writable({write(chunk, enc, cb) {
      const m = JSON.parse(chunk.toString().split('\r\n\r\n')[1]); cb();
      if (m.method === 'initialize') queueMicrotask(() => {
        if (stderrBytes) child.stderr.write(Buffer.alloc(stderrBytes));
        for (const part of chunks) child.stdout.write(part);
      });
      if (m.method === 'shutdown') queueMicrotask(() => child.stdout.write(frame({id:3,result:null})));
      if (m.method === 'exit') { exits++; queueMicrotask(() => child.emit('close',0)); }
    }});
    return child;
  }; syncBuiltinESMExports();
  try {
    await writeFile(join(dir,'a.ts'),'const a=1;');
    for (const scenario of [
      {name:'reviewer', end:2096228},
      {name:'one byte before', end:TOTAL-1},
      {name:'exact limit', end:TOTAL},
      {name:'cross diagnostic body', end:TOTAL+1},
      {name:'cross diagnostic header', end:TOTAL+diagnostic.length-10},
      {name:'stderr included before diagnostic', end:TOTAL, stderr:1},
      {name:'graceful shutdown within budget', end:TOTAL-8192, noTail:true},
    ]) {
      const prefix = [init];
      let remaining = scenario.end - init.length - diagnostic.length;
      const logSize = scenario.name === 'reviewer' ? 261996 : 262000;
      while (remaining > logSize) {
        const size = Math.min(logSize, remaining - 200);
        prefix.push(log(size)); remaining -= size;
      }
      prefix.push(log(remaining));
      const frames = [...prefix, diagnostic, ...(scenario.noTail ? [] : [log(4094)])];
      const all = Buffer.concat(frames);
      if (scenario.name === 'reviewer') {
        assert.equal(init.length,98); assert.equal(diagnostic.length,162);
        assert.equal(prefix.length,9);
      }
      const reports = [];
      for (const layout of ['frames', 65536, all.length, 'boundary']) {
        chunks = layout === 'frames' ? frames : layout === 'boundary'
          ? [all.subarray(0,TOTAL-1), all.subarray(TOTAL-1,TOTAL), all.subarray(TOTAL)]
          : layout === 65536
            ? [init, ...Array.from({length:Math.ceil((all.length-init.length)/layout)}, (_,i) => all.subarray(init.length+i*layout,init.length+(i+1)*layout))]
            : [all];
        stderrBytes = scenario.stderr ?? 0; killed = 0; exits = 0;
        reports.push(await collectLspDiagnostics({command:'/fake/injected',args:[],languageId:'typescript',extensions:['.ts'],timeoutMilliseconds:1000},dir,'a.ts'));
        assert.ok(killed > 0, `${scenario.name}/${layout}: process cleanup`);
        if (scenario.noTail) assert.equal(exits,1, 'shutdown response still receives exit');
      }
      const expected = scenario.end + (scenario.stderr ?? 0) <= TOTAL
        ? 'LSP a.ts: 1 reported diagnostic(s)\n1:1 diagnostic: EXPECTED' : 'LSP: output limit exceeded.';
      assert.deepEqual(reports, Array(4).fill(expected), scenario.name);
    }
  } finally { childProcess.spawn=original; syncBuiltinESMExports(); await rm(dir,{recursive:true,force:true}); }
});

test('identical adjacent near-limit frames survive separate, 64KiB and single chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsp-chunks-'));
  const original = childProcess.spawn;
  let layout;
  const frame = m => { const body = JSON.stringify({jsonrpc:'2.0', ...m}); return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
  childProcess.spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({write(chunk, enc, cb) {
      const m = JSON.parse(chunk.toString().split('\r\n\r\n')[1]); cb();
      if (m.method === 'initialize') queueMicrotask(() => child.stdout.write(frame({id:1,result:{capabilities:{diagnosticProvider:{}}}})));
      if (m.method === 'textDocument/diagnostic') queueMicrotask(() => {
        const a = frame({method:'window/logMessage',params:{message:'x'.repeat(262060)}});
        const b = frame({id:2,result:{kind:'full',items:[{range:{start:{line:0,character:0}},message:'EXPECTED'}]},padding:'y'.repeat(30000)});
        const all = Buffer.concat([a,b]);
        if (layout === 'separate') { child.stdout.write(a); child.stdout.write(b); }
        else for (let i=0;i<all.length;i+=layout) child.stdout.write(all.subarray(i,i+layout));
      });
      if (m.method === 'shutdown') queueMicrotask(() => child.stdout.write(frame({id:3,result:null})));
      if (m.method === 'exit') queueMicrotask(() => child.emit('close',0));
    }}); return child;
  }; syncBuiltinESMExports();
  try {
    await writeFile(join(dir,'a.ts'),'const a=1;');
    const reports=[];
    for (layout of ['separate',65536,524288]) reports.push(await collectLspDiagnostics({command:'/fake/injected',args:[],languageId:'typescript',extensions:['.ts'],timeoutMilliseconds:1000},dir,'a.ts'));
    assert.match(reports[0],/EXPECTED/); assert.deepEqual(reports,[reports[0],reports[0],reports[0]]);
  } finally { childProcess.spawn=original; syncBuiltinESMExports(); await rm(dir,{recursive:true,force:true}); }
});
