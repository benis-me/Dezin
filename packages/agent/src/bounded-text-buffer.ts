export const OUTPUT_TRUNCATION_MARKER = "[... output truncated ...]\n";

/** Byte-aware UTF-8 tail buffer with one stable truncation marker. */
export class BoundedTextBuffer {
  private readonly maxBytes: number;
  private readonly marker: Buffer;
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private seenBytes = 0;

  constructor(maxBytes: number, marker = OUTPUT_TRUNCATION_MARKER) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative integer");
    this.maxBytes = maxBytes;
    this.marker = Buffer.from(marker, "utf8").subarray(0, maxBytes);
  }

  append(value: Uint8Array | string): void {
    const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (chunk.length === 0) return;
    this.seenBytes += chunk.length;
    const dataLimit = Math.max(0, this.maxBytes - (this.seenBytes > this.maxBytes ? this.marker.length : 0));
    this.chunks.push(Buffer.from(chunk));
    this.retainedBytes += chunk.length;
    this.trimTo(dataLimit);
  }

  get byteLength(): number {
    return Math.min(this.maxBytes, this.retainedBytes + (this.truncated ? this.marker.length : 0));
  }

  get totalBytes(): number {
    return this.seenBytes;
  }

  get truncated(): boolean {
    return this.seenBytes > this.maxBytes;
  }

  toBuffer(): Buffer {
    const dataLimit = Math.max(0, this.maxBytes - (this.truncated ? this.marker.length : 0));
    this.trimTo(dataLimit);
    const joined = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.retainedBytes);
    // A byte-tail cut can land inside a UTF-8 code point. Drop leading continuation
    // bytes so callers never receive a synthetic replacement character from truncation.
    let start = 0;
    while (start < joined.length && (joined[start]! & 0xc0) === 0x80) start += 1;
    const data = joined.subarray(start);
    return this.truncated ? Buffer.concat([this.marker, data], this.marker.length + data.length) : data;
  }

  toString(): string {
    return this.toBuffer().toString("utf8");
  }

  private trimTo(limit: number): void {
    while (this.retainedBytes > limit && this.chunks.length > 0) {
      const overflow = this.retainedBytes - limit;
      const first = this.chunks[0]!;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.retainedBytes -= overflow;
      }
    }
  }
}
