const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_PNG_CHUNKS = 4_096;
const MAX_RENDER_AXIS = 8_192;
const MAX_RENDER_PIXELS = 32_000_000;
const SAFE_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

export class FigmaPngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaPngError";
  }
}

export interface SanitizedFigmaPng {
  bytes: Buffer;
  width: number;
  height: number;
  pixels: number;
}

function fail(message: string): never {
  throw new FigmaPngError(message);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validBitDepth(colorType: number, bitDepth: number): boolean {
  return colorType === 0 ? [1, 2, 4, 8, 16].includes(bitDepth)
    : colorType === 2 ? [8, 16].includes(bitDepth)
      : colorType === 3 ? [1, 2, 4, 8].includes(bitDepth)
        : colorType === 4 || colorType === 6 ? [8, 16].includes(bitDepth)
          : false;
}

export function sanitizeFigmaPng(value: Uint8Array): SanitizedFigmaPng {
  const input = Buffer.from(value);
  if (input.length < PNG_SIGNATURE.length || !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail("Figma render is not a valid PNG");
  }
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  let paletteEntries = 0;
  let seenHeader = false;
  let seenPalette = false;
  let seenTransparency = false;
  let seenImageData = false;
  let imageDataClosed = false;
  let seenEnd = false;
  const safe: Buffer[] = [PNG_SIGNATURE];

  while (offset < input.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS || input.length - offset < 12) fail("Figma PNG structure is invalid");
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > input.length) fail("Figma PNG structure is invalid");
    const typeBytes = input.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type) || (typeBytes[2]! & 0x20) !== 0) fail("Figma PNG chunk type is invalid");
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = input.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== expectedCrc) fail("Figma PNG chunk checksum is invalid");
    const critical = (typeBytes[0]! & 0x20) === 0;
    if (critical && !SAFE_CHUNKS.has(type)) fail("Figma PNG contains an unsupported critical chunk");

    if (type === "IHDR") {
      if (seenHeader || chunkCount !== 1 || length !== 13) fail("Figma PNG IHDR is invalid");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (width < 1 || height < 1 || width > MAX_RENDER_AXIS || height > MAX_RENDER_AXIS
        || width * height > MAX_RENDER_PIXELS || !validBitDepth(colorType, bitDepth)
        || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12]!)) {
        fail("Figma PNG IHDR is invalid");
      }
      seenHeader = true;
    } else if (!seenHeader || seenEnd) {
      fail("Figma PNG chunk order is invalid");
    } else if (type === "PLTE") {
      if (seenPalette || seenImageData || colorType === 0 || colorType === 4
        || length < 3 || length > 768 || length % 3 !== 0) fail("Figma PNG PLTE is invalid");
      paletteEntries = length / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) fail("Figma PNG PLTE is invalid");
      seenPalette = true;
    } else if (type === "tRNS") {
      const validLength = colorType === 0 ? length === 2
        : colorType === 2 ? length === 6
          : colorType === 3 ? seenPalette && length > 0 && length <= paletteEntries
            : false;
      if (seenTransparency || seenImageData || !validLength) fail("Figma PNG tRNS is invalid");
      seenTransparency = true;
    } else if (type === "IDAT") {
      if (imageDataClosed || (colorType === 3 && !seenPalette)) fail("Figma PNG IDAT order is invalid");
      seenImageData = true;
    } else if (type === "IEND") {
      if (!seenImageData || length !== 0 || end !== input.length) fail("Figma PNG IEND is invalid");
      seenEnd = true;
    } else if (seenImageData) {
      imageDataClosed = true;
    }

    if (SAFE_CHUNKS.has(type)) safe.push(input.subarray(offset, end));
    offset = end;
  }
  if (!seenHeader || !seenImageData || !seenEnd) fail("Figma PNG structure is incomplete");
  return { bytes: Buffer.concat(safe), width, height, pixels: width * height };
}
