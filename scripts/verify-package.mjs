import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import packageMetadata from "../package.json" with { type: "json" };

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function command(command_, args, cwd, env = process.env) {
  const { stdout, stderr } = await run(command_, args, { cwd, env: { ...env, NO_UPDATE_NOTIFIER: "1" } });
  return `${stdout}${stderr}`;
}

function commandWithInput(command_, args, cwd, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command_, args, {
      cwd,
      env: { ...env, NO_UPDATE_NOTIFIER: "1" },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(output)
      : reject(new Error(`${command_} exited with code ${code}: ${output}`)));
    child.stdin.end(input);
  });
}

const directory = await mkdtemp(join(tmpdir(), "dragons-package-"));
try {
  assert.equal(packageMetadata.license, "MIT", "package metadata must declare MIT licensing");
  await command(pnpm, ["pack", "--pack-destination", directory], root);
  const tarball = join(directory, `${packageMetadata.name}-${packageMetadata.version}.tgz`);
  const contents = await command("tar", ["-tzf", tarball], directory);
  for (const forbidden of [".env", "/src/", ".test.js", ".test.d.ts", "MILESTONES.md", ".hermes/", "acceptance-", "provider-acceptance", "live-smoke", "stream-trace"]) assert.equal(contents.includes(forbidden), false, `package contains forbidden ${forbidden}`);
  assert.match(contents, /package\/dist\/cli\.js/);
  assert.match(contents, /package\/dist\/runtime\.js/);
  assert.match(contents, /package\/dist\/runtime\.d\.ts/);
  assert.match(contents, /package\/dist\/provider\/credential-store\.js/);
  assert.match(contents, /package\/CHANGELOG\.md/);
  assert.match(contents, /package\/LICENSE/);
  const packagedManifest = JSON.parse(await command("tar", ["-xOf", tarball, "package/package.json"], directory));
  const packagedLicense = await command("tar", ["-xOf", tarball, "package/LICENSE"], directory);
  assert.equal(packagedManifest.license, "MIT");
  assert.equal(packagedManifest.types, "./dist/runtime.d.ts");
  assert.deepEqual(packagedManifest.exports, { ".": "./dist/runtime.js", "./runtime": "./dist/runtime.js" });
  assert.match(packagedLicense, /^MIT License\n\nCopyright \(c\) 2026 Furkan "NaxoziwuS" Aykaç\n/);
  assert.equal(packagedLicense.includes("[INSERT COPYRIGHT HOLDER]"), false, "packaged license must not retain a copyright placeholder");

  const install = join(directory, "install");
  await mkdir(install, { recursive: true });
  await writeFile(join(install, "package.json"), '{"private":true,"type":"module"}\n', { encoding: "utf8" });
  await command(pnpm, ["add", tarball], install);
  const bin = join(install, "node_modules", ".bin", process.platform === "win32" ? "dragons.cmd" : "dragons");
  const isolatedEnv = { ...process.env, HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "xdg") };
  delete isolatedEnv.OPENAI_API_KEY;
  const help = await command(bin, ["--help"], install, isolatedEnv);
  const version = await command(bin, ["--version"], install, isolatedEnv);
  const config = await command(bin, ["config", "show"], install, isolatedEnv);
  const sessions = await command(bin, ["session", "list"], install, isolatedEnv);
  await commandWithInput(bin, [], install, isolatedEnv, "exit\n");
  const runtimeApi = await command(process.execPath, ["--input-type=module", "--eval", "import { createDragonsRuntime as root } from 'dragons-agent'; import { createDragonsRuntime as subpath } from 'dragons-agent/runtime'; if (typeof root !== 'function' || root !== subpath) throw new Error('runtime API unavailable'); process.stdout.write('RUNTIME_API_OK\\n');"], install, isolatedEnv);

  assert.match(help, /Usage: dragons/);
  assert.equal(version.trim(), `dragons ${packageMetadata.version}`);
  assert.equal(config.trim(), "{}");
  assert.match(sessions, /No saved Dragons sessions/);
  assert.equal(runtimeApi.trim(), "RUNTIME_API_OK");

  console.log(`PACKAGE_ACCEPTANCE_OK ${basename(tarball)}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
