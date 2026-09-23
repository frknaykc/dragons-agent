// Deterministic JSON-RPC/LSP fixture. Never reads the workspace or launches other tools.
import { writeFileSync } from 'node:fs';
const mode = process.argv[2] || 'pull';
const marker = process.argv[3];
if (marker) writeFileSync(marker, String(process.pid));
let buffer = Buffer.alloc(0);
let document;
function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  if (mode === 'split') { process.stdout.write(frame.slice(0, 9)); setTimeout(() => process.stdout.write(frame.slice(9)), 5); }
  else process.stdout.write(frame);
}
const diagnostic = { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, severity: 1, message: 'Type mismatch; token=fixture-secret \u001b[31m' };
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const m = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (m.method === 'initialize') {
      if (mode === 'hang') continue;
      if (mode === 'exit') process.exit(0);
      if (mode === 'header-oversize') { process.stdout.write('x'.repeat(8197)); continue; }
      if (mode === 'oversize') { process.stdout.write('Content-Length: 9999999\r\n\r\n'); continue; }
      if (mode === 'flood') { for (let i = 0; i < 300; i++) send({ method: 'window/logMessage', params: { message: 'ignored' } }); continue; }
      if (mode === 'stderr') { process.stderr.write('x'.repeat(2200000)); continue; }
      send({ id: m.id, result: { capabilities: mode.startsWith('push') ? {} : { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } } });
    }
    if (m.method === 'textDocument/didOpen') {
      document = m.params.textDocument;
      if (mode.startsWith('push')) {
        send({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///outside.ts', version: 1, diagnostics: [diagnostic] } });
        send({ method: 'textDocument/publishDiagnostics', params: { uri: document.uri, version: 0, diagnostics: [diagnostic] } });
        send({ method: 'textDocument/publishDiagnostics', params: { uri: document.uri, diagnostics: [diagnostic] } });
        if (mode === 'push') send({ method: 'textDocument/publishDiagnostics', params: { uri: document.uri, version: 1, diagnostics: [diagnostic] } });
      }
    }
    if (m.method === 'textDocument/diagnostic') {
      if (mode === 'request') { send({ id: 'server-edit', method: 'workspace/applyEdit', params: { edit: { changes: { 'file:///outside.ts': [] } } } }); continue; }
      send({ id: m.id, result: { kind: 'full', items: mode === 'empty' ? [] : mode === 'many' ? Array(100).fill(diagnostic) : [diagnostic] } });
    }
    if (m.id === 'server-edit' && m.error?.code === -32601) send({ id: 2, result: { kind: 'full', items: [{ ...diagnostic, message: 'Server request denied' }] } });
    if (m.method === 'shutdown') send({ id: m.id, result: null });
    if (m.method === 'exit') process.exit(0);
  }
});
