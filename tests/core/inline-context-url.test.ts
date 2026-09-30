import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fetchPublicContextUrl, isPublicContextAddress, validateContextUrl, type ContextUrlTransport } from "../../dist/inline-context-url.js";

const url = "https://www.wikipedia.org/guide";
function transport(options: { addresses?: string[]; status?: number; type?: string; encoding?: string; body?: Buffer; stall?: boolean } = {}) {
  let calls = 0; let dns = 0; let captured: any; let destroyed = false;
  const value: ContextUrlTransport = {
    lookup: (async () => { dns++; return (options.addresses ?? ["93.184.216.34"]).map(address => ({ address, family: address.includes(":") ? 6 : 4 })); }) as ContextUrlTransport["lookup"],
    request: ((_url: unknown, requestOptions: any, callback: any) => {
      calls++; captured = requestOptions;
      const req = new EventEmitter() as any;
      req.destroy = () => { destroyed = true; };
      req.end = () => {
        const response = new PassThrough() as any;
        response.statusCode = options.status ?? 200;
        response.headers = { "content-type": options.type ?? "text/plain; charset=utf-8", ...(options.encoding ? { "content-encoding": options.encoding } : {}) };
        requestOptions.signal.addEventListener("abort", () => req.emit("error", new Error("cancelled")), { once: true });
        queueMicrotask(() => { callback(response); if (!options.stall) response.end(options.body ?? Buffer.from("Public documentation.")); });
      };
      return req;
    }) as ContextUrlTransport["request"],
  };
  return { value, stats: () => ({ calls, dns, captured, destroyed }) };
}

test("URL grammar rejects credentials, local/IP endpoints, query/fragment, noncanonical and alternate protocol/port", () => {
  assert.equal(validateContextUrl(url), url);
  for (const bad of ["http://www.wikipedia.org/", "https://user:synthetic@www.wikipedia.org/", "https://127.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://localhost/", "https://router.local/", "https://www.wikipedia.org:8443/", "https://www.wikipedia.org/?q=x", "https://www.wikipedia.org/#x", "https://WWW.wikipedia.org/", "https://www.wikipedia.org", "https://www.wikipedia.org/\u202e"]) assert.equal(validateContextUrl(bad), undefined, bad);
  for (const address of ["0.0.0.0", "10.1.1.1", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:8.8.8.8", "2606:4700::1111"]) assert.equal(isPublicContextAddress(address), false, address);
  assert.equal(isPublicContextAddress("93.184.216.34"), true);
});

test("HTTPS transport pins DNS, preserves hostname TLS, has no credentials/proxy/redirect or compression transport", async () => {
  const f = transport();
  assert.equal(await fetchPublicContextUrl(url, new AbortController().signal, 16384, f.value), "Public documentation.");
  const s = f.stats(); assert.equal(s.dns, 1); assert.equal(s.calls, 1); assert.equal(s.captured.agent, false);
  assert.deepEqual(Object.keys(s.captured.headers).sort(), ["Accept", "Accept-Encoding"]);
  await new Promise<void>((resolve) => s.captured.lookup("www.wikipedia.org", {}, (error: Error, address: string, family: number) => { assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4); resolve(); }));
});

test("DNS mixed/private/mapped/IPv6 answers are denied before connecting", async () => {
  for (const addresses of [[], ["127.0.0.1"], ["93.184.216.34", "10.0.0.1"], ["::ffff:127.0.0.1"], ["2606:4700::1111"]]) {
    const f = transport({ addresses });
    await assert.rejects(fetchPublicContextUrl(url, new AbortController().signal, 16384, f.value), /DNS/);
    assert.equal(f.stats().calls, 0);
  }
});

test("redirects, errors, binary types, foreign charsets, compression, malformed UTF8 and oversized bodies fail closed", async () => {
  for (const options of [{ status: 302 }, { status: 500 }, { type: "application/octet-stream" }, { type: "text/plain; charset=latin1" }, { encoding: "gzip" }, { body: Buffer.from([255]) }, { body: Buffer.alloc(16385, "a") }]) {
    const f = transport(options);
    await assert.rejects(fetchPublicContextUrl(url, new AbortController().signal, 16384, f.value));
    assert.equal(f.stats().calls, 1);
  }
});

test("abort during DNS or response stops promptly; pre-abort performs no DNS", async () => {
  const early = new AbortController(); early.abort(); const f = transport();
  await assert.rejects(fetchPublicContextUrl(url, early.signal, 16384, f.value)); assert.equal(f.stats().dns, 0);
  const dns = new AbortController();
  const pending = fetchPublicContextUrl(url, dns.signal, 16384, { ...f.value, lookup: (() => new Promise(() => {})) as ContextUrlTransport["lookup"] });
  dns.abort(); await assert.rejects(pending);
  const response = new AbortController(); const stalled = transport({ stall: true });
  const body = fetchPublicContextUrl(url, response.signal, 16384, stalled.value);
  await new Promise(resolve => setImmediate(resolve)); response.abort(); await assert.rejects(body);
});
