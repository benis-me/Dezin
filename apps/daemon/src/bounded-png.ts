import { createInflate, crc32 as zlibCrc32 } from "node:zlib";

export const MAX_PNG_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_PNG_CHUNKS = 4_096;

export interface BoundedPngDimensions {
  width: number;
  height: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function assertImageDimensions(width: number, height: number): BoundedPngDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS) {
    throw new Error("image dimensions are invalid");
  }
  return { width, height };
}

function pngScanLayout(
  width: number,
  height: number,
  bitDepth: number,
  channels: number,
  interlace: number,
  signal?: AbortSignal,
): { byteLength: number; rowOffsets: number[] } {
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
  let byteLength = 0;
  const rowOffsets: number[] = [];
  for (const [startX, startY, stepX, stepY] of passes) {
    throwIfAborted(signal);
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (passWidth === 0 || passHeight === 0) continue;
    const rowBytes = Math.ceil((passWidth * bitDepth * channels) / 8);
    for (let row = 0; row < passHeight; row += 1) {
      if ((row & 0x3ff) === 0) throwIfAborted(signal);
      rowOffsets.push(byteLength);
      byteLength += rowBytes + 1;
      if (byteLength > MAX_DECODED_IMAGE_BYTES) throw new Error("decoded PNG is too large");
    }
  }
  return { byteLength, rowOffsets };
}

function validatePngScanlines(
  chunks: readonly Buffer[],
  compressedByteLength: number,
  layout: { byteLength: number; rowOffsets: number[] },
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const inflater = createInflate();
    let settled = false;
    let decodedOffset = 0;
    let rowIndex = 0;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const fail = (message: string): void => {
      inflater.destroy();
      finish(new Error(message));
    };
    const abort = (): void => {
      const reason = abortReason(signal!);
      inflater.destroy(reason instanceof Error ? reason : new Error("PNG validation aborted"));
      finish(reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    inflater.on("data", (chunk: Buffer) => {
      if (settled) return;
      const nextOffset = decodedOffset + chunk.byteLength;
      if (nextOffset > layout.byteLength) {
        fail("decoded PNG exceeds its exact scanline layout");
        return;
      }
      while (rowIndex < layout.rowOffsets.length && layout.rowOffsets[rowIndex]! < nextOffset) {
        const rowOffset = layout.rowOffsets[rowIndex]!;
        if (rowOffset >= decodedOffset && chunk[rowOffset - decodedOffset]! > 4) {
          fail("PNG contains an invalid scanline filter");
          return;
        }
        rowIndex += 1;
      }
      decodedOffset = nextOffset;
    });
    inflater.once("error", (error) => finish(error));
    inflater.once("end", () => {
      if (decodedOffset !== layout.byteLength
        || rowIndex !== layout.rowOffsets.length
        || inflater.bytesWritten !== compressedByteLength) {
        finish(new Error("PNG compressed input or scanline layout is not exact"));
        return;
      }
      finish();
    });
    try {
      for (const chunk of chunks) inflater.write(chunk);
      inflater.end();
    } catch (error) {
      inflater.destroy();
      finish(error);
    }
  });
}

async function probePng(bytes: Buffer, signal?: AbortSignal): Promise<BoundedPngDimensions> {
  throwIfAborted(signal);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("invalid PNG signature");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let channels = 0;
  let interlace = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataRunEnded = false;
  let sawEnd = false;
  let chunks = 0;
  let compressedByteLength = 0;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    throwIfAborted(signal);
    if (++chunks > MAX_PNG_CHUNKS) throw new Error("PNG contains too many chunks");
    if (offset + 12 > bytes.length) throw new Error("truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) throw new Error("truncated PNG chunk data");
    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("invalid PNG chunk type");
    if (zlibCrc32(bytes.subarray(typeStart, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      throw new Error("invalid PNG chunk checksum");
    }
    if (!sawHeader && type !== "IHDR") throw new Error("PNG header must be first");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new Error("invalid PNG header");
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      const validDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      const channelCounts: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      if (!validDepths[colorType]?.includes(bitDepth)
        || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0
        || ![0, 1].includes(bytes[dataStart + 12]!)) {
        throw new Error("unsupported PNG header");
      }
      channels = channelCounts[colorType]!;
      interlace = bytes[dataStart + 12]!;
      assertImageDimensions(width, height);
      sawHeader = true;
    } else if (type === "PLTE") {
      if (!sawHeader || sawPalette || sawImageData || length === 0 || length > 768 || length % 3 !== 0
        || colorType === 0 || colorType === 4
        || (colorType === 3 && length / 3 > 2 ** bitDepth)) {
        throw new Error("invalid PNG palette");
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd || imageDataRunEnded || length === 0
        || (colorType === 3 && !sawPalette)) {
        throw new Error("invalid PNG image data");
      }
      sawImageData = true;
      compressedByteLength += length;
      compressed.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (!sawHeader || !sawImageData || sawEnd || length !== 0) {
        throw new Error("invalid PNG end chunk");
      }
      sawEnd = true;
      if (chunkEnd !== bytes.length) throw new Error("PNG has trailing bytes");
    } else {
      if ((type.charCodeAt(0) & 0x20) === 0) throw new Error("unknown critical PNG chunk");
      if (sawImageData) imageDataRunEnded = true;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawImageData || !sawEnd) throw new Error("incomplete PNG image");
  const layout = pngScanLayout(width, height, bitDepth, channels, interlace, signal);
  throwIfAborted(signal);
  await validatePngScanlines(compressed, compressedByteLength, layout, signal);
  throwIfAborted(signal);
  return assertImageDimensions(width, height);
}

/** Fully validates one bounded PNG without any Artifact or Viewer dependency. */
export async function inspectBoundedPngImage(
  value: Uint8Array,
  signal?: AbortSignal,
): Promise<Readonly<BoundedPngDimensions>> {
  throwIfAborted(signal);
  if (!(value instanceof Uint8Array) || value.byteLength === 0
    || value.byteLength > MAX_PNG_IMAGE_BYTES) {
    throw new Error("PNG bytes exceed the bounded image budget");
  }
  return probePng(Buffer.from(value), signal);
}
