// Invoked only by the isolated packaged MoA acceptance harness in Electron's Node mode.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

let stage = 'input';
let bridge;
try {
  const input = await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) reject(new Error('Oversized fixture input'));
    });
    process.stdin.once('end', () => resolve(JSON.parse(data)));
  });
  const url = (module) => pathToFileURL(`${input.resources}/app.asar/dist/${module}.js`).href;
  stage = 'packaged-import';
  const [{ DesktopBridge }, { createDesktopRuntime, desktopLocalControls }] = await Promise.all([
    import(url('desktop/bridge')), import(url('desktop/host')),
  ]);
  stage = 'host';
  const runtime = await createDesktopRuntime(input.workspace, { configPath: input.configPath, profileName: input.profile });
  bridge = new DesktopBridge(runtime, () => { throw new Error('Interactive model must not run'); }, desktopLocalControls(runtime));
  stage = 'session';
  assert.equal((await bridge.request({ type: 'create', provider: 'local' })).ok, true);
  stage = 'preview';
  const preview = await bridge.request({ type: 'slash', content: '/moa duo local openai-api --aggregate local -- Inspect this workspace' });
  assert.equal(preview.ok, true);
  assert.match(JSON.stringify(preview), /SHARE/);
  stage = 'synthesis';
  const result = await bridge.request({ type: 'slash', content: '/moa confirm SHARE' });
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result), /combined fixture answer/);
  console.log('PACKAGED_MIXTURE_SYNTHESIS=pass');
} catch {
  console.log(`PACKAGED_MIXTURE_SYNTHESIS=failed stage=${stage}`);
  process.exitCode = 1;
} finally {
  try { await bridge?.close(); }
  catch { console.log('PACKAGED_MIXTURE_CLOSE=failed'); process.exitCode = 1; }
}
