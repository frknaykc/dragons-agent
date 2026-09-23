import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { decodeMacOSZip } from "../../dist/desktop/update-macos-decode.js";

const limits = { maxEntries: 32, maxExpandedBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 };
// Known CRC32 test vector, independently specified rather than using decoder CRC.
const contents = Buffer.from("123456789");
function archive({ method = 8, descriptor = false, data = contents, expanded = data.length, crc = 0xcbf43926, extra = Buffer.alloc(0), mode = 0o100755 }: { method?: number; descriptor?: boolean; data?: Buffer; expanded?: number; crc?: number; extra?: Buffer; mode?: number } = {}) {
  const name = Buffer.from("Dragons Agent.app/Contents/data");
  const compressed = method === 8 ? deflateRawSync(data) : data;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(descriptor ? 8 : 0, 6); header.writeUInt16LE(method, 8);
  if (!descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(expanded, 22); }
  header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28);
  const trailer = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) { trailer.writeUInt32LE(0x08074b50); trailer.writeUInt32LE(crc, 4); trailer.writeUInt32LE(compressed.length, 8); trailer.writeUInt32LE(expanded, 12); }
  const local = Buffer.concat([header, name, extra, compressed, trailer]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(descriptor ? 8 : 0, 8); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(expanded, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  const directory = Buffer.concat([central, name, extra]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, end]);
}
async function decode(bytes: Buffer, bounds = limits, signal = new AbortController().signal) {
  const result = [];
  for await (const entry of decodeMacOSZip(bytes, bounds, signal)) result.push(entry);
  return result;
}
function mutate(change: (bytes: Buffer, central: number, end: number) => void) {
  const bytes = archive(); const end = bytes.length - 22; const central = bytes.readUInt32LE(end + 16);
  change(bytes, central, end); return bytes;
}

test("ZIP32 stored/deflated entries and signed descriptors decode actual bytes and modes", async () => {
  for (const method of [0, 8]) for (const descriptor of [false, true]) {
    const result = await decode(archive({ method, descriptor }));
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.bytes, contents);
    assert.equal(result[0]?.mode, 0o100755);
    assert.equal(result[0]?.kind, "file");
  }
  const result = await decode(archive({ mode: 0o120777 }));
  assert.equal(result[0]?.kind, "symlink");
});

test("ZIP rejects ambiguous headers, encryption, ZIP64, overrides, unknown types and damaged streams", async (t) => {
  const inputs = [
    Buffer.alloc(0), archive().subarray(0, -1), Buffer.concat([archive(), Buffer.from("trailer")]),
    mutate((b, c) => b.writeUInt16LE(1, c + 8)),
    mutate((b, c) => b.writeUInt16LE(99, c + 10)),
    mutate((b, c) => b.writeUInt32LE(1, c + 42)),
    mutate((b, c) => b.writeUInt16LE(1, c + 34)),
    mutate((b, _c, e) => b.writeUInt16LE(1, e + 4)),
    mutate((b, _c, e) => b.writeUInt16LE(65535, e + 10)),
    mutate((b, _c, e) => b.writeUInt32LE(0xffffffff, e + 16)),
    mutate((b) => b.writeUInt16LE(0, 8)),
    mutate((b) => b.writeUInt32LE(0, 14)),
    mutate((b) => b.writeUInt8(88, 30)),
    mutate((b) => { const data = 30 + b.readUInt16LE(26); b[data] = b[data]! ^ 0xff; }),
    archive({ crc: 0 }), archive({ expanded: 1 }), archive({ expanded: 100 }),
    archive({ extra: Buffer.from([1, 0, 0, 0]) }),
    archive({ extra: Buffer.from([0x75, 0x70, 0, 0]) }),
    archive({ extra: Buffer.from([2, 0, 255, 255]) }),
    archive({ mode: 0o020600 }), archive({ mode: 0o040755 }),
  ];
  for (const [index, input] of inputs.entries()) await t.test(`bad ZIP ${index}`, async () => assert.rejects(decode(input)));
});

test("ZIP validates every central/local record before yielding, and rejects exact size/entry bounds", async () => {
  for (const bounds of [{ ...limits, maxFileBytes: 8 }, { ...limits, maxExpandedBytes: 8 }, { ...limits, maxEntries: 0 }]) {
    await assert.rejects(decode(archive(), bounds));
  }
  // Add a second central record without a corresponding local record. The first
  // valid member must not be yielded before discovery of the malformed second.
  const first = archive(); const end = first.length - 22; const central = first.readUInt32LE(end + 16);
  const eocd = Buffer.from(first.subarray(end));
  eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10); eocd.writeUInt32LE((end - central) * 2, 12);
  const two = Buffer.concat([first.subarray(0, end), first.subarray(central, end), eocd]);
  let yielded = false;
  await assert.rejects(async () => { for await (const _entry of decodeMacOSZip(two, limits, new AbortController().signal)) yielded = true; });
  assert.equal(yielded, false);
});

test("ZIP inflation detects dishonest expansion and cancellation without blocking the event loop", async () => {
  const bomb = archive({ data: Buffer.alloc(8 * 1024 * 1024), expanded: 1, crc: 0 });
  await assert.rejects(decode(bomb));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decode(archive(), limits, controller.signal), { name: "AbortError" });
  const during = new AbortController();
  const result = decode(archive({ data: Buffer.alloc(8 * 1024 * 1024), crc: 0 }), { ...limits, maxFileBytes: 8 * 1024 * 1024, maxExpandedBytes: 8 * 1024 * 1024 }, during.signal);
  setTimeout(() => during.abort(), 5);
  await assert.rejects(result, { name: "AbortError" });
});
