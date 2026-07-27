import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 as zlibCrc32, deflateSync } from "node:zlib";

import { inspectBoundedPngImage } from "../src/artifact-thumbnail.ts";
import { centerCropPngToAspectRatio } from "../src/png-center-crop.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(body.byteLength + 12);
  chunk.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(zlibCrc32(Buffer.concat([typeBytes, body])), 8 + body.byteLength);
  return chunk;
}

function pngRgbaScanlines(width: number, height: number, interlace: 0 | 1): Buffer {
  const passes = interlace === 0
    ? [[0, 0, 1, 1] as const]
    : [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ] as const;
  const rows: Buffer[] = [];
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    for (let row = 0; row < passHeight; row += 1) {
      rows.push(Buffer.alloc(1 + (passWidth * 4)));
    }
  }
  return Buffer.concat(rows);
}

function rgbaPng(width: number, height: number, interlace: 0 | 1 = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = interlace;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pngRgbaScanlines(width, height, interlace))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function grayscale1Png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  header[9] = 0;
  const rowBytes = Math.ceil(width / 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((rowBytes + 1) * height))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunkOffset(bytes: Buffer, target: string): number {
  let offset = PNG_SIGNATURE.byteLength;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === target) return offset;
    offset += length + 12;
  }
  throw new Error(`fixture does not contain ${target}`);
}

function crop(bytes: Uint8Array, aspectRatio: "16:9" = "16:9"): Promise<Buffer> {
  return centerCropPngToAspectRatio({
    bytes,
    aspectRatio,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    signal: new AbortController().signal,
  });
}

test("centerCropPngToAspectRatio emits an independently valid exact-ratio PNG", async () => {
  const output = await crop(rgbaPng(96, 64));
  const dimensions = await inspectBoundedPngImage(output);

  assert.deepEqual(dimensions, { width: 96, height: 54 });
  assert.equal(dimensions.width * 9, dimensions.height * 16);
});

test("centerCropPngToAspectRatio rejects a provider PNG with a corrupt chunk CRC", async () => {
  const bytes = rgbaPng(96, 64);
  const idat = chunkOffset(bytes, "IDAT");
  const length = bytes.readUInt32BE(idat);
  const checksumOffset = idat + 8 + length;
  bytes[checksumOffset] = bytes[checksumOffset]! ^ 0xff;

  await assert.rejects(crop(bytes), /invalid PNG chunk checksum/);
});

test("centerCropPngToAspectRatio rejects oversized chunk lengths before offset traversal", async () => {
  const bytes = rgbaPng(96, 64);
  bytes.writeUInt32BE(0xffff_ffff, PNG_SIGNATURE.byteLength);

  await assert.rejects(crop(bytes), /truncated PNG chunk data/);
});

test("centerCropPngToAspectRatio rejects duplicate IHDR chunks", async () => {
  const bytes = rgbaPng(96, 64);
  const duplicateHeader = Buffer.from(bytes.subarray(8, 33));
  const duplicate = Buffer.concat([bytes.subarray(0, 33), duplicateHeader, bytes.subarray(33)]);

  await assert.rejects(crop(duplicate), /invalid PNG header/);
});

test("centerCropPngToAspectRatio rejects duplicate IEND chunks and trailing bytes", async () => {
  const duplicate = Buffer.concat([rgbaPng(96, 64), pngChunk("IEND", Buffer.alloc(0))]);

  await assert.rejects(crop(duplicate), /PNG has trailing bytes/);
});

test("centerCropPngToAspectRatio rejects unknown critical chunks", async () => {
  const bytes = rgbaPng(96, 64);
  const idat = chunkOffset(bytes, "IDAT");
  const unknownCritical = pngChunk("ABCD", Buffer.alloc(0));
  const malformed = Buffer.concat([bytes.subarray(0, idat), unknownCritical, bytes.subarray(idat)]);

  await assert.rejects(crop(malformed), /unknown critical PNG chunk/);
});

test("centerCropPngToAspectRatio safely crops valid Adam7 interlaced PNGs", async () => {
  const bytes = rgbaPng(32, 24, 1);
  assert.deepEqual(await inspectBoundedPngImage(bytes), { width: 32, height: 24 });

  const output = await crop(bytes);
  assert.deepEqual(await inspectBoundedPngImage(output), { width: 32, height: 18 });
});

test("centerCropPngToAspectRatio rejects decoded surfaces beyond its Moodboard pixel cap", async () => {
  const bytes = grayscale1Png(2_048, 2_049);
  assert.deepEqual(await inspectBoundedPngImage(bytes), { width: 2_048, height: 2_049 });

  await assert.rejects(crop(bytes), /bounded Moodboard crop pixel budget/);
});

test("centerCropPngToAspectRatio preserves the caller abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("test crop deadline");
  controller.abort(reason);

  await assert.rejects(
    centerCropPngToAspectRatio({
      bytes: rgbaPng(96, 64),
      aspectRatio: "16:9",
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
});
