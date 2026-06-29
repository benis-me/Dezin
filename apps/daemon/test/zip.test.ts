import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { createZip, crc32 } from "../src/zip.ts";

interface ReadEntry {
  path: string;
  data: Buffer;
}

/** Minimal ZIP reader for round-trip verification. */
function readZip(buf: Buffer): ReadEntry[] {
  const out: ReadEntry[] = [];
  let o = 0;
  while (o + 4 <= buf.length && buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8);
    const compSize = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const path = buf.toString("utf8", o + 30, o + 30 + nameLen);
    const start = o + 30 + nameLen + extraLen;
    const comp = buf.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(comp) : Buffer.from(comp);
    out.push({ path, data });
    o = start + compSize;
  }
  return out;
}

test("createZip produces a valid PK archive with the right signatures", () => {
  const zip = createZip([{ path: "a.txt", data: "hello" }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature");
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "end-of-central-directory signature");
});

test("entries round-trip through inflateRawSync", () => {
  const files = [
    { path: "index.html", data: "<h1>Hello</h1>".repeat(20) },
    { path: "assets/style.css", data: ":root{--accent:#2563eb}" },
    { path: "empty.txt", data: "" },
  ];
  const zip = createZip(files);
  const read = readZip(zip);
  assert.equal(read.length, 3);
  for (const f of files) {
    const got = read.find((r) => r.path === f.path);
    assert.ok(got, `entry ${f.path} present`);
    assert.equal(got!.data.toString("utf8"), f.data);
  }
});

test("crc32 matches a known value", () => {
  // CRC-32 of "hello" is 0x3610a686
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
});
