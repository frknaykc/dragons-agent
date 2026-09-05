// Trusted source-checkout launcher. Transport secrets are never printed or passed in argv.
import { startRemoteServer } from '../dist/remote/server.js';
import { createDesktopRuntime } from '../dist/desktop/host.js';

const token = process.env.DRAGONS_REMOTE_TOKEN;
if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
  console.error('Set DRAGONS_REMOTE_TOKEN to a cryptographically random base64url transport secret (32–256 characters).');
  process.exitCode = 1;
} else {
  try {
    const server = await startRemoteServer({
      principals: [{ id: 'local-owner', token }],
      createRuntime: () => createDesktopRuntime(process.cwd()),
    });
    console.log(`Dragons remote foundation: ${server.url} (loopback only; bearer authentication required)`);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void server.close(); });
  } catch {
    console.error('Unable to start remote runtime. Check trusted host configuration.');
    process.exitCode = 1;
  }
}
