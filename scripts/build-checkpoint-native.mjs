import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  const root = fileURLToPath(new URL("../native/checkpoint-win32/", import.meta.url));
  const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
  const result = spawnSync(process.execPath, [nodeGyp, "rebuild", "--directory", root], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
