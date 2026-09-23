import { stageVerifiedUpdate, verifyUpdateManifest, type UpdateManifest, type UpdatePolicy } from "./update.js";

const MAX_MANIFEST_BYTES = 16_384;

export interface TrustedUpdateSource {
  /** Host-owned HTTPS endpoint; no credentials, query, fragment, redirect or renderer input. */
  manifestUrl: string;
}

function reject(): never { throw new Error("Update transport rejected."); }

function sourceUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return reject(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname.endsWith("/")) reject();
  return url;
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work.then((value) => { if (signal.aborted) late?.(value); return value; }), new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Update cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

async function boundedText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) { void response.body?.cancel().catch(() => {}); reject(); }
  if (!response.body) reject();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || item.value.byteLength > limit - size) reject();
      size += item.value.byteLength;
      chunks.push(Buffer.from(item.value));
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { return reject(); }
}

async function* responseBytes(response: Response, expectedSize: number): AsyncGenerator<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expectedSize)) reject();
  if (!response.body) reject();
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      if (!(item.value instanceof Uint8Array) || item.value.byteLength === 0) reject();
      yield item.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function artifactUrl(manifestUrl: URL, manifest: Readonly<UpdateManifest>): URL {
  const artifact = new URL(manifest.artifact, manifestUrl);
  if (artifact.origin !== manifestUrl.origin || artifact.protocol !== "https:" || artifact.username || artifact.password || artifact.search || artifact.hash) reject();
  return artifact;
}

/**
 * Checks signed metadata from an explicit host-owned HTTPS source without fetching an artifact.
 * Redirects and malformed response bounds fail closed; abort cancels an in-flight body reader.
 * Supplying a source and policy is deliberate host composition — this does not enable production updates.
 */
export async function fetchTrustedUpdateManifest(options: {
  source: TrustedUpdateSource;
  policy: UpdatePolicy;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<{ envelope: string; manifest: Readonly<UpdateManifest> }> {
  const manifestUrl = sourceUrl(options.source.manifestUrl);
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== "function") reject();
  options.signal.throwIfAborted();
  let manifestResponse: Response;
  try {
    manifestResponse = await abortable(request(manifestUrl, { method: "GET", redirect: "error", cache: "no-store", signal: options.signal }), options.signal, (response) => { void response.body?.cancel().catch(() => {}); });
  } catch { return reject(); }
  if (manifestResponse.status !== 200 || manifestResponse.redirected || manifestResponse.url && manifestResponse.url !== manifestUrl.href) { void manifestResponse.body?.cancel().catch(() => {}); reject(); }
  const envelope = await boundedText(manifestResponse, MAX_MANIFEST_BYTES, options.signal);
  const manifest = verifyUpdateManifest(envelope, options.policy);
  options.signal.throwIfAborted();
  return { envelope, manifest };
}

export async function fetchAndStageTrustedUpdate(options: {
  source: TrustedUpdateSource;
  policy: UpdatePolicy;
  root: string;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<{ directory: string; manifest: Readonly<UpdateManifest> }> {
  const { envelope, manifest } = await fetchTrustedUpdateManifest(options);
  const manifestUrl = sourceUrl(options.source.manifestUrl);
  const request = options.fetch ?? globalThis.fetch;
  const url = artifactUrl(manifestUrl, manifest);
  options.signal.throwIfAborted();
  let artifactResponse: Response;
  try {
    artifactResponse = await abortable(request(url, { method: "GET", redirect: "error", cache: "no-store", signal: options.signal }), options.signal, (response) => { void response.body?.cancel().catch(() => {}); });
  } catch { return reject(); }
  if (artifactResponse.status !== 200 || artifactResponse.redirected || artifactResponse.url && artifactResponse.url !== url.href) reject();
  return stageVerifiedUpdate({ envelope, policy: options.policy, root: options.root, artifact: responseBytes(artifactResponse, manifest.size), signal: options.signal });
}
