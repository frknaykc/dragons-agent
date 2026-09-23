import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const args of [["test"], ["typecheck"], ["build"], ["verify:package"]]) {
  // Stream complete diagnostics, including failed gates, without execFile's buffer
  // limit or Node's truncation of an uncaught error's stdout/stderr properties.
  const code = await new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`pnpm ${args.join(" ")} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (code !== 0) {
    process.stderr.write(`RELEASE_CHECK_FAILED: pnpm ${args.join(" ")} (exit ${code})\n`);
    process.exit(code);
  }
}
process.stdout.write("RELEASE_CHECK_OK\n");
