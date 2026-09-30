import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { RuntimeTextRedactor } from "./runtime-redaction.js";

export const INLINE_URL_TOOL = "inline_context_url";
/** Approval identity is exact and safe to display; queries/fragments and alternate ports are unsupported. */
export function validateContextUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s\p{C}\\]/u.test(value)) return undefined;
  const redactor = new RuntimeTextRedactor();
  if (redactor.push(value) + redactor.finish() !== value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || url.href !== value || !url.hostname.includes(".") || isIP(url.hostname) !== 0
      || url.hostname.endsWith(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname)) return undefined;
    return value;
  } catch { return undefined; }
}
export function contextUrlFromArguments(value: string): string | undefined {
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 1 && "url" in parsed ? validateContextUrl(parsed.url) : undefined; }
  catch { return undefined; }
}
/** Conservative IPv4-only public routing policy. IPv6 (including mapped IPv4) fails closed. */
export function isPublicContextAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export type ContextUrlTransport = {
  lookup: (hostname: string, options: { all: true; verbatim: true }) => Promise<import("node:dns").LookupAddress[]>;
  request: typeof request;
};
/** No global fetch, proxy, provider transport, cookies or credentials. Pin the checked address at connect time. */
export async function fetchPublicContextUrl(value: string, signal: AbortSignal, maxBytes: number,
  transport: ContextUrlTransport = { lookup, request }): Promise<string> {
  if (!validateContextUrl(value)) throw new Error("Inline URL: unsupported or unsafe HTTPS address.");
  signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const url = new URL(value);
  const records = await new Promise<import("node:dns").LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new Error("Inline URL: cancelled or deadline exceeded."));
    signal.addEventListener("abort", abort, { once: true });
    void transport.lookup(url.hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  signal.throwIfAborted();
  if (!Array.isArray(records) || records.length === 0 || records.length > 32 || records.some((entry) => entry.family !== 4 || !isPublicContextAddress(entry.address))) {
    throw new Error("Inline URL: DNS must resolve only to public IPv4 addresses.");
  }
  const address = records[0]!.address;
  return new Promise<string>((resolve, reject) => {
    const req = transport.request(url, {
      method: "GET", agent: false, family: 4, signal, maxHeaderSize: 8192,
      headers: { Accept: "text/plain, text/markdown, text/html, application/json", "Accept-Encoding": "identity" },
      // The TLS servername/hostname remain the original validated name. No second DNS resolution.
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    }, (response) => {
      const fail = () => { response.destroy(); req.destroy(); reject(new Error("Inline URL: response rejected (status, type, encoding or size).")); };
      const type = response.headers["content-type"] ?? "";
      const length = response.headers["content-length"];
      if (response.statusCode !== 200 || !/^(?:text\/(?:plain|markdown|html)|application\/json)(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(type)
        || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
        || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes))) { fail(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) fail(); else chunks.push(chunk); });
      response.on("error", () => reject(new Error("Inline URL: response interrupted.")));
      response.on("end", () => {
        try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new Error("Inline URL: invalid UTF-8 text.")); }
      });
    });
    req.on("error", () => reject(new Error("Inline URL: request failed or cancelled.")));
    req.end();
  });
}
