import assert from "node:assert/strict";
import { AsyncEntry } from "@napi-rs/keyring";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { getDragonsConfigPath, loadDragonsConfig, saveDragonsConfig } from "../../dist/config.js";
import { createFileCronTaskStore, cronWorkspaceDirectory } from "../../dist/cron-store.js";
import { createDesktopRuntime, desktopLocalControls } from "../../dist/desktop/host.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { createSessionStore } from "../../dist/session-store.js";
import { readProjectSkill } from "../../dist/skills.js";

// Real host composition, with fail-fast guards on all native credential operations.
// No auth/status/login/model request is needed to change local reasoning preferences.
test("desktop host config isolation, persistence, credential inactivity and legacy defaults", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-host-isolation-")));
  const savedEnv = { ...process.env };
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA"]) process.env[key] = root;
  t.after(async () => {
    process.env = savedEnv;
    await rm(root, { recursive: true, force: true });
  });
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  const native = ["getPassword", "setPassword", "deletePassword"].map((method) =>
    t.mock.method(AsyncEntry.prototype, method as "getPassword", async () => { throw new Error("Native credentials forbidden"); }));
  const legacyPath = getDragonsConfigPath();
  await saveDragonsConfig({ provider: "local", model: "legacy-fixture" }, legacyPath);
  const legacyBefore = await readFile(legacyPath, "utf8");
  const configPath = join(root, "isolated", "config.json");
  const profiles = createDragonsProfileStore({ configPath });
  const profileName = "acceptance-unique-fixture";
  const chosen = await profiles.create(profileName);
  await saveDragonsConfig({
    provider: "chatgpt",
    model: "gpt-5.4",
    fallback: {
      enabled: true,
      consent: "allow-context-sharing",
      targets: [{ provider: "local", model: "qwen2.5-coder:7b" }],
    },
  }, chosen.configPath);
  const other = await profiles.select("other-fixture");
  await saveDragonsConfig({ provider: "local", model: "other-fixture" }, other.configPath);
  const otherBefore = await readFile(other.configPath, "utf8");
  // Reflect.apply permits this regression to exercise the old one-argument host too.
  const compose = (options?: { configPath?: string; profileName?: string }) =>
    Reflect.apply(createDesktopRuntime, undefined, [root, options]) as ReturnType<typeof createDesktopRuntime>;

  await assert.rejects(compose({ configPath }), /explicit.*profile/i);
  await assert.rejects(compose({ configPath, profileName: "default" }), /explicit.*profile/i);
  await assert.rejects(compose({ configPath, profileName: "../escape" }), /profile/i);
  await assert.rejects(compose({ configPath: "relative.json", profileName }), /absolute/i);
  const runtime = await compose({ configPath, profileName });
  const local = desktopLocalControls(runtime)!;
  const bridge = new DesktopBridge(runtime, () => {}, local);
  let id: string;
  try {
    assert.match(await local.profiles(), new RegExp(`Current desktop profile: ${profileName}`));
    const cron = await bridge.request({ type: "slash", content: "/cron list" });
    assert.equal(cron.ok, true);
    if (cron.ok) assert.match(JSON.stringify(cron.value), /No cron tasks in this workspace/);
    const invalidCron = await bridge.request({ type: "slash", content: "/cron trigger .." });
    assert.equal(invalidCron.ok, true);
    if (invalidCron.ok) assert.match(JSON.stringify(invalidCron.value), /Usage: \/cron/);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const oneOff = await bridge.request({ type: "slash", content: `/cron once ${at} -- Read project status` });
    assert.equal(oneOff.ok, true);
    const onceId = oneOff.ok ? JSON.stringify(oneOff.value).match(/[0-9a-f-]{36}/)?.[0] : undefined;
    assert.ok(onceId);
    const recurring = await bridge.request({ type: "slash", content: "/cron add */30 * * * * -- Read health" });
    assert.equal(recurring.ok, true);
    const cronId = recurring.ok ? JSON.stringify(recurring.value).match(/[0-9a-f-]{36}/)?.[0] : undefined;
    assert.ok(cronId);
    assert.notEqual(cronId, onceId);
    const skillPath = join(root, ".dragons", "skills", "read-health");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: Read Health\ndescription: Inspect status\n---\n# Read health safely\n");
    const pinned = await bridge.request({ type: "slash", content: `/cron once ${at} --skill project read-health -- Read project health` });
    assert.equal(pinned.ok, true);
    const pinnedId = pinned.ok ? JSON.stringify(pinned.value).match(/[0-9a-f-]{36}/)?.[0] : undefined;
    assert.ok(pinnedId);
    const pinnedTask = await createFileCronTaskStore(cronWorkspaceDirectory(join(dirname(chosen.configPath), "cron"), root)).load(pinnedId);
    assert.deepEqual(pinnedTask?.skill, { id: "read-health", scope: "PROJECT", digest: (await readProjectSkill(root, "read-health")).digest });
    const invalidSkill = await bridge.request({ type: "slash", content: `/cron once ${at} --skill project ../other -- Read health` });
    assert.equal(invalidSkill.ok, true);
    if (invalidSkill.ok) assert.match(JSON.stringify(invalidSkill.value), /Usage: \/cron/);
    const scheduled = await bridge.request({ type: "slash", content: "/cron list" });
    assert.equal(scheduled.ok, true);
    if (scheduled.ok) { assert.match(JSON.stringify(scheduled.value), new RegExp(onceId)); assert.match(JSON.stringify(scheduled.value), new RegExp(cronId)); }
    const rejected = await bridge.request({ type: "slash", content: `/cron once ${at} -- api_key=not-a-real-key` });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "RUNTIME_ERROR");
    const paused = await bridge.request({ type: "slash", content: `/cron pause ${cronId}` });
    assert.equal(paused.ok, true);
    if (paused.ok) assert.match(JSON.stringify(paused.value), /paused/);
    assert.equal((await bridge.request({ type: "slash", content: `/cron resume ${cronId}` })).ok, true);
    assert.equal((await bridge.request({ type: "slash", content: `/cron remove ${cronId}` })).ok, true);
    assert.equal((await bridge.request({ type: "slash", content: `/cron remove ${onceId}` })).ok, true);
    assert.equal((await bridge.request({ type: "slash", content: `/cron remove ${pinnedId}` })).ok, true);
    const session = await runtime.createSession();
    id = session.id;
    assert.equal(session.provider, "chatgpt");
    assert.equal((await bridge.request({ type: "resume", sessionId: id })).ok, true);
    const loop = await bridge.request({ type: "slash", content: "/loop start 3600 1 -- inspect workspace" });
    assert.equal(loop.ok, true);
    if (loop.ok) assert.match(JSON.stringify(loop.value), /Loop started/);
    const loopStatus = await bridge.request({ type: "slash", content: "/loop status" });
    assert.equal(loopStatus.ok, true);
    if (loopStatus.ok) assert.match(JSON.stringify(loopStatus.value), /completed: 0/);
    assert.equal((await bridge.request({ type: "slash", content: "/loop stop" })).ok, true);
    assert.equal((await bridge.request({ type: "slash", content: "/reasoning high", configPath: legacyPath })).ok, false);
    assert.equal((await bridge.request({ type: "slash", content: "/reasoning high" })).ok, true);
    assert.equal((await loadDragonsConfig(chosen.configPath)).reasoning?.chatgpt?.["gpt-5.4"], "high");
    assert.match(await local.sessions(), new RegExp(id));
    assert.equal((await createSessionStore(chosen.sessionDirectory).load(id))?.id, id);
    assert.equal(await createSessionStore(other.sessionDirectory).load(id), undefined);
    assert.equal(await createSessionStore(join(root, "isolated", "sessions")).load(id), undefined);
  } finally { await bridge.close(); }
  await assert.rejects(local.cron!({ action: "list" }), /closed/);
  await assert.rejects(local.loop!({ action: "status", sessionId: id! }), /closed/);
  const restarted = await compose({ configPath, profileName });
  try {
    assert.match(await desktopLocalControls(restarted)!.reasoning!("chatgpt", "gpt-5.4"), /Reasoning: high/);
    assert.equal((await restarted.resumeSession(id!)).id, id!);
  } finally { await desktopLocalControls(restarted)!.close(); await restarted.dispose(); }
  assert.equal(await readFile(legacyPath, "utf8"), legacyBefore);
  assert.equal(await readFile(other.configPath, "utf8"), otherBefore);
  assert.deepEqual((await readdir(join(root, "isolated"))).sort(), ["profiles"]);
  assert.equal(await profiles.active(), "other-fixture", "host override must not rewrite active selection");

  // No-options production path still follows legacy root and its persisted active profile.
  const legacy = await createDesktopRuntime(root);
  try {
    const session = await legacy.createSession();
    assert.equal(session.model, "legacy-fixture");
    assert.equal((await createSessionStore(createDragonsProfileStore().paths("default").sessionDirectory).load(session.id))?.id, session.id);
  } finally { await desktopLocalControls(legacy)!.close(); await legacy.dispose(); }
  const active = await createDragonsProfileStore().select("legacy-active");
  await saveDragonsConfig({ provider: "local", model: "active-fixture" }, active.configPath);
  const selected = await createDesktopRuntime(root);
  try { assert.equal((await selected.createSession()).model, "active-fixture"); }
  finally { await desktopLocalControls(selected)!.close(); await selected.dispose(); }
  assert.equal(network.mock.callCount(), 0);
  for (const operation of native) assert.equal(operation.mock.callCount(), 0);
});
