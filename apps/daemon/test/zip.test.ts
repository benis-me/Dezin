import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { createZip, crc32, streamZip } from "../src/zip.ts";

interface ReadEntry {
  path: string;
  data: Buffer;
}

/** Minimal ZIP reader for round-trip verification. */
function readZip(buf: Buffer): ReadEntry[] {
  const out: ReadEntry[] = [];
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let central = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(central), 0x02014b50);
    const method = buf.readUInt16LE(central + 10);
    const compSize = buf.readUInt32LE(central + 20);
    const nameLen = buf.readUInt16LE(central + 28);
    const extraLen = buf.readUInt16LE(central + 30);
    const commentLen = buf.readUInt16LE(central + 32);
    const localOffset = buf.readUInt32LE(central + 42);
    const path = buf.toString("utf8", central + 46, central + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(comp) : Buffer.from(comp);
    out.push({ path, data });
    central += 46 + nameLen + extraLen + commentLen;
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

test("streamZip emits bounded chunks and a valid data-descriptor archive", async () => {
  const chunks: Buffer[] = [];
  let largest = 0;
  const payload = Buffer.from("stream me\n".repeat(20_000));
  await streamZip(
    [
      {
        path: "large.txt",
        expectedSize: payload.length,
        async *open() {
          for (let offset = 0; offset < payload.length; offset += 4096) {
            yield payload.subarray(offset, Math.min(payload.length, offset + 4096));
          }
        },
      },
      {
        path: "empty.txt",
        expectedSize: 0,
        async *open() {},
      },
    ],
    async (chunk) => {
      largest = Math.max(largest, chunk.byteLength);
      chunks.push(Buffer.from(chunk));
    },
  );

  const zip = Buffer.concat(chunks);
  const entries = readZip(zip);
  assert.equal(entries.find((entry) => entry.path === "large.txt")?.data.equals(payload), true);
  assert.equal(entries.find((entry) => entry.path === "empty.txt")?.data.length, 0);
  assert.ok(largest < payload.length, `largest emitted chunk ${largest} should not aggregate the source`);
  assert.equal(zip.readUInt16LE(6) & 0x08, 0x08, "streamed local header uses a data descriptor");
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800, "streamed local header declares UTF-8 names");
  const centralOffset = zip.readUInt32LE(zip.length - 22 + 16);
  assert.equal(zip.readUInt16LE(centralOffset + 8) & 0x0800, 0x0800, "central header declares UTF-8 names");
});

test("streamZip aborts without consuming the rest of an entry", async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    streamZip(
      [{
        path: "abort.txt",
        async *open() {
          for (let i = 0; i < 100; i++) {
            reads += 1;
            yield Buffer.alloc(1024, i);
          }
        },
      }],
      async () => {
        controller.abort(new Error("client left"));
      },
      { signal: controller.signal },
    ),
    /client left/,
  );
  assert.ok(reads < 100);
});
