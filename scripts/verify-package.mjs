import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import packageMetadata from "../package.json" with { type: "json" };
import { pnpmInvocation } from "./release-check.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

export async function command(command_, args, cwd, env = process.env) {
  const { stdout, stderr } = await run(command_, args, { cwd, env: { ...env, NO_UPDATE_NOTIFIER: "1" } });
  return `${stdout}${stderr}`;
}

export function commandWithInput(command_, args, cwd, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command_, args, {
      cwd,
      env: { ...env, NO_UPDATE_NOTIFIER: "1" },
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

export function isolatedPackageEnvironment(directory, env = process.env) {
  const home = join(directory, "home");
  const isolatedEnv = {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  delete isolatedEnv.OPENAI_API_KEY;
  return isolatedEnv;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pnpm, prefix] = pnpmInvocation();
  const directory = await mkdtemp(join(tmpdir(), "dragons-package-"));
  try {
  assert.equal(packageMetadata.license, "MIT", "package metadata must declare MIT licensing");
  await command(pnpm, [...prefix, "pack", "--pack-destination", directory], root);
  const tarball = join(directory, `${packageMetadata.name}-${packageMetadata.version}.tgz`);
  const contents = await command("tar", ["-tzf", tarball], directory);
  for (const forbidden of [".env", "/src/", "/tests/", "/experiments/", "/.test-build/", "mcp-mock-server", "mcp-official-sdk-server", ".test.js", ".test.d.ts", "MILESTONES.md", ".hermes/", "acceptance-", "provider-acceptance", "live-smoke", "stream-trace"]) assert.equal(contents.includes(forbidden), false, `package contains forbidden ${forbidden}`);
  assert.match(contents, /package\/dist\/cli\.js/);
  assert.match(contents, /package\/dist\/runtime\.js/);
  assert.match(contents, /package\/dist\/runtime\.d\.ts/);
  assert.match(contents, /package\/dist\/plugins\.js/);
  assert.match(contents, /package\/dist\/plugins\.d\.ts/);
  assert.match(contents, /package\/dist\/lifecycle-hooks\.js/);
  assert.match(contents, /package\/dist\/lifecycle-hooks\.d\.ts/);
  assert.match(contents, /package\/dist\/plugin-catalog\.js/);
  assert.match(contents, /package\/dist\/plugin-catalog\.d\.ts/);
  assert.match(contents, /package\/catalog\/plugins\/hello\/1\.0\.0\/plugin\.json/);
  assert.match(contents, /package\/catalog\/plugins\/hello\/1\.1\.0\/plugin\.json/);
  assert.match(contents, /package\/dist\/skill-hub\.js/);
  assert.match(contents, /package\/dist\/skill-hub\.d\.ts/);
  assert.match(contents, /package\/dist\/skill-management\.js/);
  assert.match(contents, /package\/dist\/skill-management\.d\.ts/);
  assert.match(contents, /package\/dist\/skill-curator\.js/);
  assert.match(contents, /package\/dist\/skill-curator\.d\.ts/);
  assert.match(contents, /package\/dist\/external-memory\.js/);
  assert.match(contents, /package\/dist\/external-memory\.d\.ts/);
  for (const name of ["cron-schedule", "cron-scheduler", "cron-store", "cron-runner", "session-loop", "session-loop-runtime", "persistent-goals", "persistent-goal-store", "persistent-goals-runtime", "kanban", "kanban-worker", "kanban-worker-entry", "kanban-worker-process", "kanban-worker-lane", "mixture-of-agents", "batch-queue", "batch-runner", "profiles"]) {
    assert.match(contents, new RegExp(`package/dist/${name}\\.js`));
    assert.match(contents, new RegExp(`package/dist/${name}\\.d\\.ts`));
  }
  assert.match(contents, /package\/catalog\/skills\/quick-notes\/1\.0\.0\/SKILL\.md/);
  assert.match(contents, /package\/catalog\/skills\/quick-notes\/1\.1\.0\/SKILL\.md/);
  assert.match(contents, /package\/dist\/provider\/credential-store\.js/);
  assert.match(contents, /package\/CHANGELOG\.md/);
  assert.match(contents, /package\/LICENSE/);
  if (process.platform === "win32") assert.match(contents, /package\/native\/checkpoint-win32\/build\/Release\/checkpoint_win32\.node/);
  const packagedManifest = JSON.parse(await command("tar", ["-xOf", tarball, "package/package.json"], directory));
  const packagedLicense = await command("tar", ["-xOf", tarball, "package/LICENSE"], directory);
  assert.equal(packagedManifest.license, "MIT");
  assert.equal(packagedManifest.types, "./dist/runtime.d.ts");
  assert.deepEqual(packagedManifest.exports, { ".": "./dist/runtime.js", "./runtime": "./dist/runtime.js", "./plugins": "./dist/plugins.js", "./lifecycle-hooks": "./dist/lifecycle-hooks.js", "./plugin-catalog": "./dist/plugin-catalog.js", "./skill-hub": "./dist/skill-hub.js", "./skill-management": "./dist/skill-management.js", "./skill-curator": "./dist/skill-curator.js", "./external-memory": "./dist/external-memory.js", "./cron-schedule": "./dist/cron-schedule.js", "./cron-scheduler": "./dist/cron-scheduler.js", "./cron-store": "./dist/cron-store.js", "./cron-runner": "./dist/cron-runner.js", "./session-loop": "./dist/session-loop.js", "./session-loop-runtime": "./dist/session-loop-runtime.js", "./persistent-goals": "./dist/persistent-goals.js", "./persistent-goal-store": "./dist/persistent-goal-store.js", "./persistent-goals-runtime": "./dist/persistent-goals-runtime.js", "./kanban": "./dist/kanban.js", "./kanban-worker": "./dist/kanban-worker.js", "./kanban-worker-process": "./dist/kanban-worker-process.js", "./kanban-worker-lane": "./dist/kanban-worker-lane.js", "./mixture-of-agents": "./dist/mixture-of-agents.js", "./batch-queue": "./dist/batch-queue.js", "./batch-runner": "./dist/batch-runner.js", "./profiles": "./dist/profiles.js", "./skills": "./dist/skills.js", "./remote/client": "./dist/remote/client.js", "./remote/server": "./dist/remote/server.js", "./remote/runtime": "./dist/remote/runtime.js", "./shared-runtime": "./dist/shared-runtime.js" });
  assert.match(packagedLicense, /^MIT License\n\nCopyright \(c\) 2026 Furkan "NaxoziwuS" Aykaç\n/);
  assert.equal(packagedLicense.includes("[INSERT COPYRIGHT HOLDER]"), false, "packaged license must not retain a copyright placeholder");

  const install = join(directory, "install");
  await mkdir(install, { recursive: true });
  await writeFile(join(install, "package.json"), '{"private":true,"type":"module"}\n', { encoding: "utf8" });
  await command(pnpm, [...prefix, "add", tarball], install);
  assert.equal(packagedManifest.bin.dragons, packageMetadata.bin.dragons);
  // Execute the installed package's bin target with Node, not its Windows .cmd
  // shim: cmd.exe would reinterpret the temporary path and any CLI arguments.
  const bin = join(install, "node_modules", packageMetadata.name, packagedManifest.bin.dragons);
  const isolatedEnv = isolatedPackageEnvironment(directory);
  const help = await command(process.execPath, [bin, "--help"], install, isolatedEnv);
  const version = await command(process.execPath, [bin, "--version"], install, isolatedEnv);
  const config = await command(process.execPath, [bin, "config", "show"], install, isolatedEnv);
  const sessions = await command(process.execPath, [bin, "session", "list"], install, isolatedEnv);
  await commandWithInput(process.execPath, [bin], install, isolatedEnv, "exit\n");
  const runtimeApi = await command(process.execPath, ["--input-type=module", "--eval", "import { createDragonsRuntime as root } from 'dragons-agent'; import { createDragonsRuntime as subpath } from 'dragons-agent/runtime'; if (typeof root !== 'function' || root !== subpath) throw new Error('runtime API unavailable'); process.stdout.write('RUNTIME_API_OK\\n');"], install, isolatedEnv);

  assert.match(help, /Usage: dragons/);
  assert.equal(version.trim(), `dragons ${packageMetadata.version}`);
  assert.ok(config.trim() === "{}", "installed CLI config must be empty in isolated profile");
  assert.ok(/No saved Dragons sessions/.test(sessions), "installed CLI sessions must be empty in isolated profile");
  assert.equal(runtimeApi.trim(), "RUNTIME_API_OK");
  const pluginApi = await command(process.execPath, ["--input-type=module", "--eval", "import { PluginRegistry, validatePluginManifest } from 'dragons-agent/plugins'; if (typeof PluginRegistry !== 'function' || typeof validatePluginManifest !== 'function') throw new Error('plugin API unavailable'); process.stdout.write('PLUGIN_API_OK\\n');"], install, isolatedEnv);
  assert.equal(pluginApi.trim(), "PLUGIN_API_OK");
  const lifecycleApi = await command(process.execPath, ["--input-type=module", "--eval", "import { prepareLifecycleHooks } from 'dragons-agent/lifecycle-hooks'; if (typeof prepareLifecycleHooks !== 'function') throw new Error('lifecycle API unavailable'); process.stdout.write('LIFECYCLE_API_OK\\n');"], install, isolatedEnv);
  assert.equal(lifecycleApi.trim(), "LIFECYCLE_API_OK");
  const catalogApi = await command(process.execPath, ["--input-type=module", "--eval", "import { ReviewedPluginCatalog } from 'dragons-agent/plugin-catalog'; const catalog = new ReviewedPluginCatalog('./catalog-demo'); if (catalog.list().length !== 2 || (await catalog.install('hello', '1.1.0')).version !== '1.1.0') throw new Error('reviewed catalog unavailable'); process.stdout.write('CATALOG_API_OK\\n');"], install, isolatedEnv);
  assert.equal(catalogApi.trim(), "CATALOG_API_OK");
  const skillHubApi = await command(process.execPath, ["--input-type=module", "--eval", "import { SkillHub } from 'dragons-agent/skill-hub'; const hub = new SkillHub('./skills-demo'); if (hub.list().length !== 2 || (await hub.install('bundled', 'quick-notes', '1.1.0')).id !== 'quick-notes') throw new Error('skill hub unavailable'); process.stdout.write('SKILL_HUB_API_OK\\n');"], install, isolatedEnv);
  assert.equal(skillHubApi.trim(), "SKILL_HUB_API_OK");
  const externalMemoryApi = await command(process.execPath, ["--input-type=module", "--eval", "import { shareMemoryWithProvider, removeMemoryFromProvider } from 'dragons-agent/external-memory'; if (typeof shareMemoryWithProvider !== 'function' || typeof removeMemoryFromProvider !== 'function') throw new Error('external memory contract unavailable'); process.stdout.write('EXTERNAL_MEMORY_API_OK\\n');"], install, isolatedEnv);
  assert.equal(externalMemoryApi.trim(), "EXTERNAL_MEMORY_API_OK");
  const cronApi = await command(process.execPath, ["--input-type=module", "--eval", "import { nextCronOccurrence } from 'dragons-agent/cron-schedule'; import { CronScheduler } from 'dragons-agent/cron-scheduler'; import { createFileCronTaskStore } from 'dragons-agent/cron-store'; import { createReadOnlyCronRunner } from 'dragons-agent/cron-runner'; if (typeof nextCronOccurrence !== 'function' || typeof CronScheduler !== 'function' || typeof createFileCronTaskStore !== 'function' || typeof createReadOnlyCronRunner !== 'function') throw new Error('cron API unavailable'); process.stdout.write('CRON_API_OK\\n');"], install, isolatedEnv);
  assert.equal(cronApi.trim(), "CRON_API_OK");
  const loopApi = await command(process.execPath, ["--input-type=module", "--eval", "import { SessionLoop } from 'dragons-agent/session-loop'; import { createRuntimeSessionLoop } from 'dragons-agent/session-loop-runtime'; if (typeof SessionLoop !== 'function' || typeof createRuntimeSessionLoop !== 'function') throw new Error('session loop API unavailable'); process.stdout.write('SESSION_LOOP_API_OK\\n');"], install, isolatedEnv);
  assert.equal(loopApi.trim(), "SESSION_LOOP_API_OK");
  const goalApi = await command(process.execPath, ["--input-type=module", "--eval", "import { PersistentGoalManager } from 'dragons-agent/persistent-goals'; import { createFilePersistentGoalStore } from 'dragons-agent/persistent-goal-store'; import { createRuntimePersistentGoalManager } from 'dragons-agent/persistent-goals-runtime'; if (typeof PersistentGoalManager !== 'function' || typeof createFilePersistentGoalStore !== 'function' || typeof createRuntimePersistentGoalManager !== 'function') throw new Error('persistent goal API unavailable'); process.stdout.write('PERSISTENT_GOAL_API_OK\\n');"], install, isolatedEnv);
  assert.equal(goalApi.trim(), "PERSISTENT_GOAL_API_OK");
  const kanbanApi = await command(process.execPath, ["--input-type=module", "--eval", "import { createFileKanbanBoard, kanbanWorkspaceDirectory } from 'dragons-agent/kanban'; import { runKanbanWorker } from 'dragons-agent/kanban-worker'; import { launchKanbanWorker } from 'dragons-agent/kanban-worker-process'; import { runKanbanWorkerLane } from 'dragons-agent/kanban-worker-lane'; import { createDragonsProfileStore } from 'dragons-agent/profiles'; if (typeof createFileKanbanBoard !== 'function' || typeof kanbanWorkspaceDirectory !== 'function' || typeof runKanbanWorker !== 'function' || typeof launchKanbanWorker !== 'function' || typeof runKanbanWorkerLane !== 'function' || typeof createDragonsProfileStore !== 'function') throw new Error('kanban API unavailable'); process.stdout.write('KANBAN_API_OK\\n');"], install, isolatedEnv);
  assert.equal(kanbanApi.trim(), "KANBAN_API_OK");
  const mixtureApi = await command(process.execPath, ["--input-type=module", "--eval", "import { runMixtureOfAgents } from 'dragons-agent/mixture-of-agents'; if (typeof runMixtureOfAgents !== 'function') throw new Error('mixture API unavailable'); process.stdout.write('MIXTURE_API_OK\\n');"], install, isolatedEnv);
  assert.equal(mixtureApi.trim(), "MIXTURE_API_OK");
  const batchApi = await command(process.execPath, ["--input-type=module", "--eval", "import { createFileBatchQueue, batchWorkspaceDirectory } from 'dragons-agent/batch-queue'; if (typeof createFileBatchQueue !== 'function' || typeof batchWorkspaceDirectory !== 'function') throw new Error('batch queue API unavailable'); process.stdout.write('BATCH_API_OK\\n');"], install, isolatedEnv);
  assert.equal(batchApi.trim(), "BATCH_API_OK");
  const remoteApi = await command(process.execPath, ["--input-type=module", "--eval", "import { RemoteClient } from 'dragons-agent/remote/client'; import { startRemoteServer } from 'dragons-agent/remote/server'; if (typeof RemoteClient.connect !== 'function' || typeof startRemoteServer !== 'function') throw new Error('remote API unavailable'); process.stdout.write('REMOTE_API_OK\\n');"], install, isolatedEnv);
  const sharedApi = await command(process.execPath, ["--input-type=module", "--eval", "import { connectRemoteRuntime } from 'dragons-agent/remote/runtime'; import { createSharedRuntimeHost } from 'dragons-agent/shared-runtime'; if (typeof connectRemoteRuntime !== 'function' || typeof createSharedRuntimeHost !== 'function') throw new Error('shared API unavailable'); process.stdout.write('SHARED_API_OK\\n');"], install, isolatedEnv);
  assert.match(sharedApi, /SHARED_API_OK/);
  assert.equal(remoteApi.trim(), "REMOTE_API_OK");

  console.log(`PACKAGE_ACCEPTANCE_OK ${basename(tarball)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
