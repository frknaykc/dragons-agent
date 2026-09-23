import { createInflateRaw } from "node:zlib";
import { addAbortSignal } from "node:stream";
import { spawn } from "node:child_process";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { MacOSArchiveEntry } from "./update-macos.js";

function unsafe(): never { throw new Error("Unsafe macOS update candidate."); }
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
async function crc32(bytes: Uint8Array, signal: AbortSignal): Promise<number> {
  let crc = 0xffffffff;
  for (let start = 0; start < bytes.length; start += 65536) {
    await yieldTurn(undefined, { signal });
    for (const byte of bytes.subarray(start, start + 65536)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP32 only, stored/deflated, Unix regular files/directories/links. No native
 * extractor receives paths. Central/local records must cover the entire archive
 * without overlaps, hidden local entries, trailers, encryption or ZIP64. */
export async function* decodeMacOSZip(input: Uint8Array, limits: { maxEntries: number; maxExpandedBytes: number; maxFileBytes: number }, signal: AbortSignal): AsyncIterable<MacOSArchiveEntry> {
  signal.throwIfAborted();
  for (const limit of [limits.maxEntries, limits.maxExpandedBytes, limits.maxFileBytes]) if (!Number.isSafeInteger(limit) || limit < 1) unsafe();
  if (limits.maxEntries > 30_000 || limits.maxFileBytes > 512 * 1024 * 1024 || limits.maxExpandedBytes > 1024 * 1024 * 1024) unsafe();
  const zip = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (zip.length < 22 || zip.length > 512 * 1024 * 1024) unsafe();
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && !(zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length)) end--;
  if (end < Math.max(0, zip.length - 65557)) unsafe();
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const central = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || count !== zip.readUInt16LE(end + 8) || !count || count === 65535 || count > limits.maxEntries || central + centralSize !== end) unsafe();
  const records: { path: string; kind: MacOSArchiveEntry["kind"]; mode: number; start: number; size: number; expanded: number; crc: number; method: number }[] = [];
  let cursor = central;
  let local = 0;
  let expandedTotal = 0;
  const extra = (start: number, length: number) => {
    const stop = start + length;
    while (start < stop) {
      if (start + 4 > stop) unsafe();
      const id = zip.readUInt16LE(start); const size = zip.readUInt16LE(start + 2);
      // ZIP64 and Unicode path overrides introduce a second interpretation.
      if (id === 1 || id === 0x7075 || start + 4 + size > stop) unsafe();
      start += 4 + size;
    }
  };
  for (let index = 0; index < count; index++) {
    if (index % 128 === 0) await yieldTurn(undefined, { signal });
    signal.throwIfAborted();
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) unsafe();
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16), size = zip.readUInt32LE(cursor + 20), expanded = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28), extraLength = zip.readUInt16LE(cursor + 30), commentLength = zip.readUInt16LE(cursor + 32);
    const offset = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || nameLength > 1025 || zip.readUInt16LE(cursor + 34) || offset !== local || (flags & ~0x080e) || ![0, 8].includes(method) || (method === 0 && (flags & 6)) || expanded > limits.maxFileBytes || expanded > limits.maxExpandedBytes - expandedTotal || size === 0xffffffff) unsafe();
    expandedTotal += expanded;
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    if ([...name].some((byte) => byte < 32 || byte > 126)) unsafe();
    const rawPath = name.toString("ascii");
    const unix = zip[cursor + 5] === 3;
    const mode = unix ? zip.readUInt32LE(cursor + 38) >>> 16 : 0;
    const type = mode & 0xf000;
    if (type && ![0x8000, 0x4000, 0xa000].includes(type)) unsafe();
    const kind = type === 0xa000 ? "symlink" : (type === 0x4000 || rawPath.endsWith("/")) ? "directory" : "file";
    if ((type === 0x8000 || type === 0xa000) && rawPath.endsWith("/")) unsafe();
    if (kind === "directory" && expanded !== 0 || kind === "symlink" && expanded > 1024) unsafe();
    extra(cursor + 46 + nameLength, extraLength);
    if (local + 30 > central || zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method || zip.readUInt16LE(local + 26) !== nameLength) unsafe();
    const localExtra = zip.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + localExtra;
    if (start + size > central || !zip.subarray(local + 30, local + 30 + nameLength).equals(name)) unsafe();
    extra(local + 30 + nameLength, localExtra);
    for (const [delta, expected] of [[14, crc], [18, size], [22, expanded]] as const) {
      const actual = zip.readUInt32LE(local + delta);
      if (actual !== expected && (!(flags & 8) || actual !== 0)) unsafe();
    }
    local = start + size;
    if (flags & 8) {
      if (local + 12 > central) unsafe();
      if (zip.readUInt32LE(local) === 0x08074b50) local += 4;
      if (local + 12 > central || zip.readUInt32LE(local) !== crc || zip.readUInt32LE(local + 4) !== size || zip.readUInt32LE(local + 8) !== expanded) unsafe();
      local += 12;
    }
    records.push({ path: rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath, kind, mode, start, size, expanded, crc, method });
    cursor = next;
  }
  if (cursor !== end || local !== central) unsafe();
  // All records and advertised budgets are validated before any inflation/yield.
  for (const record of records) {
    await yieldTurn(undefined, { signal });
    const compressed = zip.subarray(record.start, record.start + record.size);
    let bytes: Buffer;
    if (record.method === 0) bytes = compressed;
    else {
      const inflater = addAbortSignal(signal, createInflateRaw({ chunkSize: 65536 }));
      bytes = Buffer.alloc(record.expanded);
      let written = 0;
      try {
        inflater.end(compressed);
        for await (const chunk of inflater) {
          signal.throwIfAborted();
          const output = chunk as Buffer;
          if (output.length > record.expanded - written) unsafe();
          output.copy(bytes, written); written += output.length;
        }
        if (written !== record.expanded || inflater.bytesWritten !== record.size) unsafe();
      } finally { inflater.destroy(); }
    }
    if (bytes.length !== record.expanded || await crc32(bytes, signal) !== record.crc) unsafe();
    yield { path: record.path, kind: record.kind, bytes, mode: record.mode };
  }
}

/** Apple's parser handles binary and XML plists; no package code is executed.
 * Fixed executable/argv, input/output caps, cancellation, deadline and close
 * barrier. Native parsing intentionally fails closed on non-macOS hosts. */
export async function readMacOSBundleIdentity(plist: Uint8Array, signal = new AbortController().signal): Promise<{ bundleIdentifier: string; version: string; executable: string }> {
  if (process.platform !== "darwin") throw new Error("macOS plist parsing unsupported on this host.");
  if (!plist.length || plist.length > 1024 * 1024) unsafe();
  signal.throwIfAborted();
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    let failed = false, size = 0;
    const chunks: Buffer[] = [];
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timeout = setTimeout(stop, 5000);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", stop); };
    child.on("error", () => { failed = true; });
    child.stdin.on("error", stop);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("error", stop);
      stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) stop(); else if (stream === child.stdout) chunks.push(chunk); });
    }
    child.once("close", (code) => { cleanup(); if (failed || code !== 0) reject(new Error("Unsafe macOS plist.")); else resolve(Buffer.concat(chunks)); });
    if (signal.aborted) stop(); else child.stdin.end(plist);
  });
  signal.throwIfAborted();
  const value: unknown = JSON.parse(output.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) unsafe();
  const data = value as Record<string, unknown>;
  if (typeof data.CFBundleIdentifier !== "string" || typeof data.CFBundleShortVersionString !== "string" || typeof data.CFBundleExecutable !== "string") unsafe();
  return { bundleIdentifier: data.CFBundleIdentifier, version: data.CFBundleShortVersionString, executable: data.CFBundleExecutable };
}
