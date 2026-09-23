import assert from "node:assert/strict";
import { AsyncEntry } from "@napi-rs/keyring";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDragonsConfigPath, loadDragonsConfig, saveDragonsConfig } from "../../dist/config.js";
import { createDesktopRuntime, desktopLocalControls } from "../../dist/desktop/host.js";
import { DesktopBridge } from "../../dist/desktop/bridge.js";
import { createDragonsProfileStore } from "../../dist/profiles.js";
import { createSessionStore } from "../../dist/session-store.js";

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
    const session = await runtime.createSession();
    id = session.id;
    assert.equal(session.provider, "chatgpt");
    assert.equal((await bridge.request({ type: "resume", sessionId: id })).ok, true);
    assert.equal((await bridge.request({ type: "slash", content: "/reasoning high", configPath: legacyPath })).ok, false);
    assert.equal((await bridge.request({ type: "slash", content: "/reasoning high" })).ok, true);
    assert.equal((await loadDragonsConfig(chosen.configPath)).reasoning?.chatgpt?.["gpt-5.4"], "high");
    assert.match(await local.sessions(), new RegExp(id));
    assert.equal((await createSessionStore(chosen.sessionDirectory).load(id))?.id, id);
    assert.equal(await createSessionStore(other.sessionDirectory).load(id), undefined);
    assert.equal(await createSessionStore(join(root, "isolated", "sessions")).load(id), undefined);
  } finally { await bridge.close(); }
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
