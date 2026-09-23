import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";

const MAX_MANIFEST_BYTES = 16_384;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const DOMAIN = "dragons-agent:update-manifest:v1\n";

export interface UpdateManifest {
  schemaVersion: 1;
  product: "dragons-agent";
  artifact: string;
  platform: "darwin" | "win32" | "linux";
  arch: "arm64" | "x64";
  version: string;
  size: number;
  sha256: string;
}

/** Supplied by trusted host composition, never a feed, renderer or model. */
export interface UpdatePolicy {
  trustedKeys: ReadonlyMap<string, string>;
  platform: UpdateManifest["platform"];
  arch: UpdateManifest["arch"];
  currentVersion: string;
  expectedVersion: string;
  expectedArtifact: string;
}

function reject(): never {
  throw new Error("Update rejected: untrusted or incompatible artifact.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return reject();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) reject();
}

function version(value: unknown): number[] {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) return reject();
  return value.split(".").map(Number);
}

function newer(candidate: number[], current: number[]): boolean {
  for (let index = 0; index < 3; index++) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}

function base64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return reject();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== value) return reject();
  return bytes;
}

/** Exact UTF-8 payload bytes, prefixed with the protocol domain, are signed. */
export function verifyUpdateManifest(envelope: string, policy: UpdatePolicy): Readonly<UpdateManifest> {
  try {
    if (typeof envelope !== "string" || Buffer.byteLength(envelope) > MAX_MANIFEST_BYTES) return reject();
    const outer = record(JSON.parse(envelope));
    exactKeys(outer, ["keyId", "payload", "signature"]);
    if (typeof outer.keyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(outer.keyId)) return reject();
    const pem = policy.trustedKeys.get(outer.keyId);
    if (!pem) return reject();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return reject();
    const payload = base64(outer.payload, 8192);
    const signature = base64(outer.signature, 64);
    if (signature.length !== 64 || !verify(null, Buffer.concat([Buffer.from(DOMAIN), payload]), key, signature)) return reject();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const data = record(JSON.parse(text));
    exactKeys(data, ["schemaVersion", "product", "artifact", "platform", "arch", "version", "size", "sha256"]);
    if (data.schemaVersion !== 1 || data.product !== "dragons-agent"
      || !["darwin", "win32", "linux"].includes(String(data.platform))
      || !["arm64", "x64"].includes(String(data.arch))
      || data.platform !== policy.platform || data.arch !== policy.arch
      || typeof data.artifact !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(data.artifact)
      || data.artifact !== policy.expectedArtifact
      || data.version !== policy.expectedVersion
      || !newer(version(data.version), version(policy.currentVersion))
      || typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_ARTIFACT_BYTES
      || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) return reject();
    return Object.freeze(data as unknown as UpdateManifest);
  } catch {
    return reject();
  }
}

/** No keys/source are shipped; host integration cannot silently trust a feed key. */
export const productionUpdatePolicy = Object.freeze({ enabled: false, reason: "No production trust root or update source configured." });

export type ActivationMode = "transactional" | "external-package-manager" | "unsupported";

/**
 * The signed artifact selects the installation authority; a renderer/feed never does.
 * macOS ZIP, Windows installer and AppImage need a future trusted transaction worker.
 * A DEB is intentionally owned by the platform package manager, never self-installed.
 */
export function activationMode(manifest: Readonly<UpdateManifest>): ActivationMode {
  const artifact = manifest.artifact.toLowerCase();
  if (manifest.platform === "linux") {
    if (artifact.endsWith(".deb")) return "external-package-manager";
    return artifact.endsWith(".appimage") ? "transactional" : "unsupported";
  }
  if (manifest.platform === "darwin") return artifact.endsWith(".zip") ? "transactional" : "unsupported";
  return artifact.endsWith(".exe") ? "transactional" : "unsupported";
}

async function nextChunk(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted();
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => iterator.next()),
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}

/**
 * Private staging only: never extracts, executes, installs or opens user data.
 * The root must be host-owned, outside workspaces and inaccessible to untrusted writers.
 * A returned candidate is NOT an activation capability: installation must reverify.
 * A hard interruption can leave an inert partial directory; the active app is untouched.
 */
export async function stageVerifiedUpdate(options: {
  envelope: string;
  policy: UpdatePolicy;
  root: string;
  artifact: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}): Promise<{ directory: string; manifest: Readonly<UpdateManifest> }> {
  const manifest = verifyUpdateManifest(options.envelope, options.policy);
  options.signal.throwIfAborted();
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(options.root, "candidate-"));
  try {
    options.signal.throwIfAborted();
    const handle = await open(join(directory, "artifact"), "wx", 0o600);
    try {
      const hash = createHash("sha256");
      let size = 0;
      const iterator = options.artifact[Symbol.asyncIterator]();
      try {
        while (true) {
          const item = await nextChunk(iterator, options.signal);
          options.signal.throwIfAborted();
          if (item.done) break;
          const chunk = item.value;
          if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > manifest.size - size) reject();
          // Own the bytes across asynchronous writes; a producer cannot mutate them after hashing.
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          hash.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const result = await handle.write(bytes, offset, bytes.length - offset);
            if (result.bytesWritten === 0) throw new Error("Update staging write failed.");
            offset += result.bytesWritten;
          }
        }
      } finally {
        // An uncooperative pending next()/return() must not retain the staging file.
        void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
      }
      options.signal.throwIfAborted();
      if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) reject();
      await handle.sync();
    } finally {
      await handle.close();
    }
    options.signal.throwIfAborted();
    const receipt = await open(join(directory, "manifest.json"), "wx", 0o600);
    try {
      await receipt.writeFile(options.envelope, "utf8");
      await receipt.sync();
    } finally {
      await receipt.close();
    }
    options.signal.throwIfAborted();
    return { directory, manifest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
