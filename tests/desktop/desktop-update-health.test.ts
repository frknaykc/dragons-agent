import assert from "node:assert/strict";
import { test } from "node:test";
import { HEALTH_PROBE_ARGUMENT, healthProbeEnvironment, isHealthProbeLaunch } from "../../dist/desktop/update-health.js";

test("health probe mode is explicit and cannot be enabled by an incidental argument", () => {
  assert.equal(isHealthProbeLaunch(["electron", "desktop/main.mjs", HEALTH_PROBE_ARGUMENT]), true);
  assert.equal(isHealthProbeLaunch(["/Applications/Dragons Agent.app/Contents/MacOS/Dragons Agent", HEALTH_PROBE_ARGUMENT]), true);
  assert.equal(isHealthProbeLaunch(["electron", "desktop/main.mjs"]), false);
  assert.equal(isHealthProbeLaunch(["electron", "desktop/main.mjs", "--dragons-update-health=1"]), false);
  assert.equal(isHealthProbeLaunch(["electron", "desktop/main.mjs", HEALTH_PROBE_ARGUMENT, "workspace"]), false);
});

test("health probe environment excludes user data, credential and remote-runtime inputs", () => {
  const environment = healthProbeEnvironment({
    PATH: "/trusted/bin",
    SystemRoot: "C:\\Windows",
    HOME: "/real-home",
    APPDATA: "/real-appdata",
    XDG_CONFIG_HOME: "/real-config",
    DRAGONS_RUNTIME_URL: "http://127.0.0.1:1",
    DRAGONS_REMOTE_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
  }, "/isolated-home");
  assert.deepEqual(environment, {
    PATH: "/trusted/bin",
    SystemRoot: "C:\\Windows",
    HOME: "/isolated-home",
    USERPROFILE: "/isolated-home",
    APPDATA: "/isolated-home/AppData/Roaming",
    LOCALAPPDATA: "/isolated-home/AppData/Local",
    XDG_CONFIG_HOME: "/isolated-home/.config",
    XDG_CACHE_HOME: "/isolated-home/.cache",
    XDG_DATA_HOME: "/isolated-home/.local/share",
  });
});
