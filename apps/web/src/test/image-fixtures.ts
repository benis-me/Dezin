export const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function decodedBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function validPngFile(name = "reference.png", byteLength?: number): File {
  const exact = decodedBase64(VALID_PNG_BASE64);
  const requested = byteLength ?? exact.byteLength;
  const parts: BlobPart[] = requested <= exact.byteLength
    ? [exactArrayBuffer(exact.slice(0, requested))]
    : [exactArrayBuffer(exact), new ArrayBuffer(requested - exact.byteLength)];
  return new File(parts, name, { type: "image/png" });
}

export function validJpegFile(name = "reference.jpg", byteLength = 4): File {
  const bytes = new Uint8Array(Math.max(4, byteLength));
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return new File([exactArrayBuffer(bytes)], name, { type: "image/jpeg" });
}
