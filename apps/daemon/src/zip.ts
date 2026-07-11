/**
 * A tiny, dependency-free ZIP writer. Builds a real .zip (PK) archive from a list
 * of in-memory entries using node:zlib raw deflate + a CRC32 table. Enough for
 * "export this project's artifact folder" without pulling in jszip/archiver.
 */

import { once } from "node:events";
import { createDeflateRaw, deflateRawSync } from "node:zlib";

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  return crc32Final(crc32Update(0xffffffff, buf));
}

function crc32Update(state: number, buf: Uint8Array): number {
  let c = state;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return c;
}

function crc32Final(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Archive path, forward slashes. */
  path: string;
  data: Uint8Array | string;
}

// Fixed DOS timestamp (1980-01-01) keeps archives deterministic for tests.
const DOS_TIME = 0;
const DOS_DATE = 33;

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const data =
      typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const METHOD = 8; // deflate

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 file name
    local.writeUInt16LE(METHOD, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 file name
    central.writeUInt16LE(METHOD, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // relative offset of local header
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const localPart = Buffer.concat(locals);
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central directory size
  eocd.writeUInt32LE(localPart.length, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localPart, centralDir, eocd]);
}

export interface StreamingZipEntry {
  /** Archive path, forward slashes. */
  path: string;
  /** Opens a fresh byte stream. Called exactly once. */
  open(): AsyncIterable<Uint8Array>;
  /** Optional preflight size. A growing source is rejected while streaming. */
  expectedSize?: number;
}

export interface StreamingZipOptions {
  signal?: AbortSignal;
  /** Called after every uncompressed input chunk for live budget enforcement. */
  onEntryBytes?: (entry: StreamingZipEntry, bytesRead: number) => void;
}

interface CentralRecord {
  nameBytes: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

function uint32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} exceeds classic ZIP limits`);
  }
  return value;
}

/**
 * Stream a deterministic, deflated classic ZIP archive without retaining source files,
 * compressed entries, or the final archive in aggregate memory. Local headers use ZIP
 * data descriptors; only compact central-directory metadata is retained.
 */
export async function streamZip(
  entries: Iterable<StreamingZipEntry> | AsyncIterable<StreamingZipEntry>,
  write: (chunk: Uint8Array) => Promise<void>,
  options: StreamingZipOptions = {},
): Promise<void> {
  const central: CentralRecord[] = [];
  let offset = 0;

  const emit = async (chunk: Uint8Array): Promise<void> => {
    options.signal?.throwIfAborted();
    if (chunk.byteLength === 0) return;
    await write(chunk);
    offset += chunk.byteLength;
    uint32(offset, "ZIP archive");
  };

  for await (const entry of entries) {
    options.signal?.throwIfAborted();
    const nameBytes = Buffer.from(entry.path, "utf8");
    if (nameBytes.length === 0 || nameBytes.length > 0xffff) throw new Error("invalid ZIP entry path");
    const localOffset = offset;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // UTF-8 name; CRC and sizes follow in a data descriptor.
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    await emit(local);

    const deflate = createDeflateRaw();
    let crcState = 0xffffffff;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const feed = (async () => {
      try {
        for await (const raw of entry.open()) {
          options.signal?.throwIfAborted();
          const chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
          if (chunk.length === 0) continue;
          uncompressedSize += chunk.length;
          uint32(uncompressedSize, `ZIP entry ${entry.path}`);
          if (entry.expectedSize !== undefined && uncompressedSize > entry.expectedSize) {
            throw new Error(`ZIP entry changed while exporting: ${entry.path}`);
          }
          options.onEntryBytes?.(entry, uncompressedSize);
          crcState = crc32Update(crcState, chunk);
          if (!deflate.write(chunk)) await once(deflate, "drain");
        }
        deflate.end();
      } catch (error) {
        deflate.destroy(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    })();

    try {
      for await (const raw of deflate) {
        const chunk = Buffer.from(raw as Uint8Array);
        compressedSize += chunk.length;
        uint32(compressedSize, `Compressed ZIP entry ${entry.path}`);
        await emit(chunk);
      }
      await feed;
    } catch (error) {
      deflate.destroy();
      await feed.catch(() => {});
      throw error;
    }

    const crc = crc32Final(crcState);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
    await emit(descriptor);
    central.push({ nameBytes, crc, compressedSize, uncompressedSize, offset: localOffset });
  }

  if (central.length > 0xffff) throw new Error("ZIP archive has too many entries");
  const centralOffset = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46 + entry.nameBytes.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt32LE(entry.offset, 42);
    entry.nameBytes.copy(header, 46);
    await emit(header);
  }
  const centralSize = offset - centralOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(uint32(centralSize, "ZIP central directory"), 12);
  eocd.writeUInt32LE(uint32(centralOffset, "ZIP central directory offset"), 16);
  await emit(eocd);
}
