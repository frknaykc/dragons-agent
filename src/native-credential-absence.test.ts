import assert from "node:assert/strict";
import test from "node:test";
import { createNativeCodexCredentialStore } from "./provider/credential-store.js";
import { createNativeMcpBearerTokenStore } from "./mcp-credential-store.js";

const scope = { serverId: "fixture", origin: "https://example.invalid", credentialId: "fixture" };

for (const missing of [null, undefined]) {
  test(`native stores normalize ${String(missing)} missing entries`, async () => {
    const entry = {
      async getPassword() { return missing; },
      async setPassword() { assert.fail("Missing-entry reads must not write"); },
      async deletePassword() { assert.fail("Missing-entry reads must not delete"); },
    };
    assert.equal(await createNativeCodexCredentialStore({ entry }).load(), undefined);
    assert.equal(await createNativeMcpBearerTokenStore({ entry }).load(scope), undefined);
  });
}

for (const payload of ["", "null", "{}", "invalid-json"]) {
  test(`native stores still reject malformed payload ${JSON.stringify(payload)}`, async () => {
    const entry = {
      async getPassword() { return payload; },
      async setPassword() {},
      async deletePassword() { return false; },
    };
    await assert.rejects(createNativeCodexCredentialStore({ entry }).load());
    await assert.rejects(createNativeMcpBearerTokenStore({ entry }).load(scope));
  });
}
