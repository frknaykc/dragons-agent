import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const args of [["test"], ["typecheck"], ["build"], ["verify:package"]]) {
  const { stdout, stderr } = await run(pnpm, args, { stdio: "pipe" });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}
process.stdout.write("RELEASE_CHECK_OK\n");
