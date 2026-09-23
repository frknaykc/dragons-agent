import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchAndStageTrustedUpdate, type TrustedUpdateSource } from "../../dist/desktop/update-transport.js";
import type { UpdateManifest, UpdatePolicy } from "../../dist/desktop/update.js";

const privateKey = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + "43".repeat(32), "hex"), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
const artifact = Buffer.from("fixture artifact");
const manifest: UpdateManifest = { schemaVersion: 1, product: "dragons-agent", artifact: "Dragons-Agent-0.2.0-darwin-arm64.zip", platform: "darwin", arch: "arm64", version: "0.2.0", size: artifact.length, sha256: createHash("sha256").update(artifact).digest("hex") };
const policy: UpdatePolicy = { trustedKeys: new Map([["fixture", publicKey]]), platform: "darwin", arch: "arm64", currentVersion: "0.1.0", expectedVersion: "0.2.0", expectedArtifact: manifest.artifact };
const source: TrustedUpdateSource = { manifestUrl: "https://updates.example.test/releases/manifest.json" };

function envelope(): string {
  const payload = Buffer.from(JSON.stringify(manifest));
  return JSON.stringify({ keyId: "fixture", payload: payload.toString("base64"), signature: sign(null, Buffer.concat([Buffer.from("dragons-agent:update-manifest:v1\n"), payload]), privateKey).toString("base64") });
}

function response(body: BodyInit | null, options: ResponseInit = {}): Response { return new Response(body, options); }

test("trusted HTTPS transport verifies the manifest before requesting and privately staging its same-origin artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-transport-"));
  const calls: string[] = [];
  try {
    const staged = await fetchAndStageTrustedUpdate({ source, policy, root, signal: new AbortController().signal, fetch: async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      return String(input).endsWith("manifest.json") ? response(envelope(), { status: 200 }) : response(artifact, { status: 200, headers: { "content-length": String(artifact.length) } });
    } });
    assert.deepEqual(calls, [source.manifestUrl, "https://updates.example.test/releases/Dragons-Agent-0.2.0-darwin-arm64.zip"]);
    assert.deepEqual(await readFile(join(staged.directory, "artifact")), artifact);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transport fails closed before artifact fetch for insecure, redirected, malformed or untrusted manifest responses", async () => {
  for (const unsafe of ["http://updates.example.test/manifest.json", "https://user@updates.example.test/manifest.json", "https://updates.example.test/manifest.json?q=1"]) {
    await assert.rejects(fetchAndStageTrustedUpdate({ source: { manifestUrl: unsafe }, policy, root: join(tmpdir(), "never-created"), signal: new AbortController().signal, fetch: async () => { throw new Error("must not fetch"); } }), /Update transport rejected/);
  }
  for (const manifestResponse of [response("{}", { status: 200 }), response(envelope(), { status: 302, headers: { location: "https://other.invalid" } }), response("x".repeat(16_385), { status: 200 })]) {
    const calls: string[] = [];
    await assert.rejects(fetchAndStageTrustedUpdate({ source, policy, root: join(tmpdir(), "never-created"), signal: new AbortController().signal, fetch: async (input) => { calls.push(String(input)); return manifestResponse; } }), /Update transport rejected|Update rejected/);
    assert.equal(calls.length, 1);
  }
});

test("transport rejects cross-origin artifact resolution and wrong declared artifact length before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "dragons-update-transport-"));
  try {
    await assert.rejects(fetchAndStageTrustedUpdate({ source, policy, root, signal: new AbortController().signal, fetch: async (input) => String(input).endsWith("manifest.json")
      ? response(envelope(), { status: 200 }) : response(artifact, { status: 200, headers: { "content-length": "1" } }) }), /Update transport rejected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
