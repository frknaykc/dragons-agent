import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Node 24 cannot spawn .cmd files with shell:false. Use pnpm's actual entrypoint
// rather than a cmd.exe shell, where arguments could be interpreted as commands.
export function pnpmInvocation(platform = process.platform, npmExecPath = process.env.npm_execpath) {
  if (platform !== "win32") return ["pnpm", []];
  if (/\.(?:cjs|mjs|js)$/i.test(npmExecPath ?? "")) return [process.execPath, [npmExecPath]];
  if (/\.exe$/i.test(npmExecPath ?? "")) return [npmExecPath, []];
  throw new Error("On Windows, run release:check with pnpm whose npm_execpath is a JS entrypoint or .exe");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pnpm, prefix] = pnpmInvocation();
  for (const args of [["test"], ["typecheck"], ["build"], ["verify:package"]]) {
    // Stream complete diagnostics, including failed gates, without execFile's buffer
    // limit or Node's truncation of an uncaught error's stdout/stderr properties.
    const code = await new Promise((resolve, reject) => {
      const child = spawn(pnpm, [...prefix, ...args], { stdio: "inherit" });
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
}
