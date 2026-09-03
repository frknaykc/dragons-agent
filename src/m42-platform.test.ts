import assert from "node:assert/strict";
import test from "node:test";

import { getDragonsConfigPath } from "./config.js";
import { getDragonsMemoryDirectory } from "./memory.js";
import { getDragonsSessionDirectory } from "./session-store.js";
import { getDragonsSkillsDirectory } from "./skills.js";
import { getDragonsChatGPTCredentialPath } from "./provider/codex-auth.js";
import { createNativeCodexCredentialStore, type NativeCredentialEntry } from "./provider/credential-store.js";

const home = "/home/dragon";
const appData = "C:\\Users\\dragon\\AppData\\Roaming";
const entry: NativeCredentialEntry = {
  async getPassword() { return undefined; },
  async setPassword() {},
  async deletePassword() { return true; },
};

test("M42 derives isolated config, session, Skills, Memory, and legacy-auth paths for every supported platform", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const options = platform === "darwin"
      ? { platform, homeDirectory: "/Users/dragon" }
      : platform === "win32"
        ? { platform, homeDirectory: home, appData }
        : { platform, homeDirectory: home, xdgConfigHome: "/home/dragon/.config" };
    const configPath = getDragonsConfigPath(options);
    if (platform === "darwin") assert.equal(configPath, "/Users/dragon/Library/Application Support/Dragons Agent/config.json");
    if (platform === "linux") assert.equal(configPath, "/home/dragon/.config/dragons-agent/config.json");
    if (platform === "win32") assert.match(configPath, /AppData\\Roaming.*Dragons Agent.*config\.json$/);
    assert.match(getDragonsSessionDirectory(options), /sessions$/);
    assert.match(getDragonsSkillsDirectory(options), /skills$/);
    assert.match(getDragonsMemoryDirectory(options), /memory$/);
    assert.match(getDragonsChatGPTCredentialPath(options), /auth\.json$/);
  }
});

test("M42 labels native credential storage by platform without using a credential payload", async () => {
  assert.equal(await createNativeCodexCredentialStore({ entry, platform: "darwin" }).storageDescription(), "macOS Keychain");
  assert.equal(await createNativeCodexCredentialStore({ entry, platform: "linux" }).storageDescription(), "Linux Secret Service");
  assert.equal(await createNativeCodexCredentialStore({ entry, platform: "win32" }).storageDescription(), "Windows Credential Manager");
});
