import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_PNG_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_PNG_DIMENSION = 32_768;
const MAX_PNG_PIXELS = 64_000_000;
const MAX_PNG_DECODED_BYTES = 256 * 1024 * 1024;
const MAX_PNG_CHUNKS = 4_096;

export interface PngEvidenceIdentity {
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
}

export interface InspectedPngEvidence {
  bytes: Buffer;
  identity: PngEvidenceIdentity;
}

export interface DecodedPngEvidence extends InspectedPngEvidence {
  /** RGB/RGBA channel count. Evidence PNGs intentionally fail closed on other encodings. */
  channels: 3 | 4;
  /** Unfiltered scanlines, retaining one leading filter byte per row (rewritten to zero). */
  scanlines: Buffer;
  scanlineStride: number;
}

interface ParsedPngEvidence {
  identity: PngEvidenceIdentity;
  channels: 3 | 4;
  scanlines: Buffer;
  scanlineStride: number;
}

let crcTable: Uint32Array | undefined;

function crc32(type: Buffer, data: Buffer): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
  let crc = 0xffff_ffff;
  for (const bytes of [type, data]) {
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function unfilterScanlines(
  decoded: Buffer,
  height: number,
  rowBytes: number,
  channels: 3 | 4,
): boolean {
  const stride = rowBytes + 1;
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * stride;
    const filter = decoded[rowStart];
    if (filter === undefined || filter > 4) return false;
    const dataStart = rowStart + 1;
    const previousStart = row === 0 ? -1 : dataStart - stride;
    for (let index = 0; index < rowBytes; index += 1) {
      const current = decoded[dataStart + index];
      if (current === undefined) return false;
      const left = index >= channels ? decoded[dataStart + index - channels]! : 0;
      const up = previousStart >= 0 ? decoded[previousStart + index]! : 0;
      const upLeft = previousStart >= 0 && index >= channels
        ? decoded[previousStart + index - channels]!
        : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      decoded[dataStart + index] = (current + predictor) & 0xff;
    }
    decoded[rowStart] = 0;
  }
  return true;
}

/**
 * Strict, bounded PNG decoder for generated visual evidence.
 *
 * The evidence protocol intentionally accepts only non-interlaced 8-bit RGB/RGBA.
 * Browser captures use those encodings; every other color model fails closed instead
 * of carrying partially validated palette/transparency semantics into the trust chain.
 */
function parsePngEvidenceBytes(input: Uint8Array): ParsedPngEvidence | undefined {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < 57 || bytes.byteLength > MAX_PNG_EVIDENCE_BYTES
    || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) return undefined;

  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | 0 = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawIdat = false;
  let idatEnded = false;
  let sawEnd = false;
  let chunkCount = 0;
  let compressedByteLength = 0;
  const idat: Buffer[] = [];

  while (offset < bytes.byteLength) {
    if (++chunkCount > MAX_PNG_CHUNKS || offset + 12 > bytes.byteLength) return undefined;
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd < dataEnd || chunkEnd > bytes.byteLength) return undefined;
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    // PNG chunk names are ASCII letters and the reserved third bit must be uppercase.
    if (!/^[A-Za-z]{4}$/.test(type) || ((typeBytes[2] ?? 0) & 0x20) !== 0) return undefined;
    const data = bytes.subarray(dataStart, dataEnd);
    if (bytes.readUInt32BE(dataEnd) !== crc32(typeBytes, data)) return undefined;
    offset = chunkEnd;

    if (type === "IHDR") {
      if (sawHeader || typeStart !== 12 || length !== 13) return undefined;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8] ?? 0;
      const colorType = data[9] ?? -1;
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
      if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION
        || width * height > MAX_PNG_PIXELS || bitDepth !== 8 || channels === 0
        || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return undefined;
      sawHeader = true;
      continue;
    }
    if (!sawHeader || sawEnd) return undefined;
    if (type !== "IDAT" && sawIdat) idatEnded = true;
    if (type === "PLTE") {
      if (sawPalette || sawIdat || length < 3 || length > 768 || length % 3 !== 0) return undefined;
      sawPalette = true;
      continue;
    }
    if (type === "tRNS") {
      // Applying a transparent-color sample would change the pixels compared below.
      // This decoder does not approximate that semantic: it fails closed instead.
      return undefined;
    }
    if (type === "IDAT") {
      if (idatEnded || length === 0) return undefined;
      sawIdat = true;
      compressedByteLength += length;
      if (compressedByteLength > MAX_PNG_EVIDENCE_BYTES) return undefined;
      idat.push(Buffer.from(data));
      continue;
    }
    if (type === "IEND") {
      if (!sawIdat || length !== 0 || offset !== bytes.byteLength) return undefined;
      sawEnd = true;
      break;
    }
    // Unknown critical chunks change decoding semantics. Ancillary chunks are inert
    // for this evidence protocol but still receive ordering, CRC, and chunk bounds.
    if (((typeBytes[0] ?? 0) & 0x20) === 0) return undefined;
  }
  if (!sawEnd || channels === 0) return undefined;

  const rowBytes = width * channels;
  const scanlineStride = rowBytes + 1;
  const decodedByteLength = scanlineStride * height;
  if (!Number.isSafeInteger(decodedByteLength) || decodedByteLength < 1
    || decodedByteLength > MAX_PNG_DECODED_BYTES) return undefined;
  const compressed = Buffer.concat(idat, compressedByteLength);
  let decoded: Buffer;
  try {
    const inflated = inflateSync(compressed, {
      info: true,
      maxOutputLength: decodedByteLength + 1,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.engine.bytesWritten !== compressed.byteLength) return undefined;
    decoded = Buffer.from(inflated.buffer);
  } catch {
    return undefined;
  }
  if (decoded.byteLength !== decodedByteLength
    || !unfilterScanlines(decoded, height, rowBytes, channels)) return undefined;

  return {
    identity: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      width,
      height,
    },
    channels,
    scanlines: decoded,
    scanlineStride,
  };
}

export function inspectPngEvidenceBytes(input: Uint8Array): PngEvidenceIdentity | undefined {
  return parsePngEvidenceBytes(input)?.identity;
}

export function decodePngEvidenceBytes(input: Uint8Array): Omit<DecodedPngEvidence, "bytes"> | undefined {
  return parsePngEvidenceBytes(input);
}

export function pngEvidenceOpenFlags(value: {
  readonly O_RDONLY: number;
  readonly O_NOFOLLOW?: number;
  readonly O_NONBLOCK?: number;
}): number | null {
  if (!Number.isInteger(value.O_RDONLY)
    || !Number.isInteger(value.O_NOFOLLOW)
    || !Number.isInteger(value.O_NONBLOCK)) return null;
  return value.O_RDONLY | value.O_NOFOLLOW! | value.O_NONBLOCK!;
}

function readBoundedFile(path: string): Buffer | undefined {
  let descriptor: number | undefined;
  try {
    const flags = pngEvidenceOpenFlags(constants);
    if (flags === null) return undefined;
    descriptor = openSync(path, flags);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || before.size < 1 || before.size > MAX_PNG_EVIDENCE_BYTES) return undefined;
    const expectedSize = Number(before.size);
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const read = readSync(descriptor, bytes, offset, expectedSize - offset, offset);
      if (read <= 0) return undefined;
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, expectedSize) !== 0) return undefined;
    const after = fstatSync(descriptor);
    if (after.nlink !== 1 || bytes.byteLength !== before.size
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readPngEvidenceFile(path: string): InspectedPngEvidence | undefined {
  const bytes = readBoundedFile(path);
  if (!bytes) return undefined;
  const identity = inspectPngEvidenceBytes(bytes);
  return identity ? { bytes, identity } : undefined;
}

export function readDecodedPngEvidenceFile(path: string): DecodedPngEvidence | undefined {
  const bytes = readBoundedFile(path);
  if (!bytes) return undefined;
  const decoded = decodePngEvidenceBytes(bytes);
  return decoded ? { bytes, ...decoded } : undefined;
}

export function samePngEvidenceIdentity(
  left: PngEvidenceIdentity | null | undefined,
  right: PngEvidenceIdentity | null | undefined,
): boolean {
  return Boolean(left && right
    && left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.width === right.width
    && left.height === right.height);
}
