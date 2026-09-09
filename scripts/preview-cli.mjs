// Credential-free presentation fixture for native-terminal documentation captures.
// Build first, then run in a terminal with at least 100 columns and 42 rows.
import { createTerminalRenderer } from '../dist/terminal/renderer.js';

if (!process.stdout.isTTY) throw new Error('A native terminal is required.');
process.stdout.write('\x1b[2J\x1b[H');
const renderer = createTerminalRenderer({
  write: (text) => process.stdout.write(text),
  isTTY: true,
  color: true,
  width: process.stdout.columns,
  now: () => 0,
});
renderer.renderStartup({ provider: 'Local', model: 'demo-model', workingDirectory: '/workspace/dragons-agent' });
renderer.renderComposer();
// No provider, configuration, credentials or real project data are loaded.
process.stdin.resume();
process.stdin.once('data', () => { renderer.finishComposer(); process.exit(0); });
