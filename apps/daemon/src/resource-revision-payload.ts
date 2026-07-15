import fs, {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { once } from "node:events";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { crc32 as zlibCrc32, createInflate } from "node:zlib";
import { parseFragment, type ParserError } from "parse5";
import type { Store } from "../../../packages/core/src/index.ts";

export const RESOURCE_REVISION_PAYLOAD_PROTOCOL = "dezin-resource-revision-payload-v1" as const;
export const MAX_RESOURCE_MANIFEST_BYTES = 64 * 1024;
export const MAX_RESOURCE_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_RENDER_ASSEMBLY_RESOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_RENDER_ASSEMBLY_RESOURCES = 256;

const MAX_TEXT_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SVG_PAYLOAD_BYTES = 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 128 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const MIME_PROBE_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });

type ResourceKind =
  | "research"
  | "moodboard"
  | "sharingan-capture"
  | "file"
  | "asset"
  | "effect"
  | "external-reference";

interface ResourceRevisionRow {
  id: string;
  workspace_id: string;
  resource_id: string;
  manifest_path: string;
  metadata_json: string;
  checksum: string;
  kind: ResourceKind;
}

/** Durable v1 contract written only by daemon-side Resource adapters. */
export interface ResourceRevisionPayloadManifest {
  protocol: typeof RESOURCE_REVISION_PAYLOAD_PROTOCOL;
  workspaceId: string;
  resourceId: string;
  resourceRevisionId: string;
  payload: {
    file: "payload.bin";
    mimeType: string;
    byteLength: number;
    checksum: string;
  };
}

export interface ResourceRevisionPayloadDescriptor {
  protocol: typeof RESOURCE_REVISION_PAYLOAD_PROTOCOL;
  workspaceId: string;
  resourceId: string;
  resourceRevisionId: string;
  resourceKind: ResourceKind;
  manifestPath: string;
  manifestChecksum: string;
  payloadPath: string;
  payloadChecksum: string;
  byteLength: number;
  mimeType: string;
  mountPath: string;
  publicUrl: string;
}

export class ResourceRevisionPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceRevisionPayloadError";
  }
}

function sha256(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}

function bytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resourceRevisionManifestRelativePath(workspaceId: string, resourceRevisionId: string): string {
  return posix.join(
    "resource-revisions",
    sha256("dezin-resource-workspace-v1", workspaceId),
    sha256("dezin-resource-revision-v1", resourceRevisionId),
    "manifest.json",
  );
}

export function resourceRevisionMountKey(resourceRevisionId: string): string {
  return sha256("dezin-resource-revision-v1", resourceRevisionId);
}

export function resourceRevisionPublicRoot(resourceRevisionId: string): string {
  return `/.dezin/resources/${resourceRevisionMountKey(resourceRevisionId)}/`;
}

function extensionForMime(mimeType: string): string {
  const exact: Record<string, string> = {
    "application/json": "json",
    "application/pdf": "pdf",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "text/css": "css",
    "text/csv": "csv",
    "text/html": "html",
    "text/markdown": "md",
    "text/plain": "txt",
    "video/mp4": "mp4",
    "video/ogg": "ogv",
    "video/webm": "webm",
  };
  return exact[mimeType] ?? "bin";
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

interface SecureStoredFile {
  path: string;
  metadata: Stats;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile();
}

function secureStoredFile(dataDir: string, storedPath: string, label: string): SecureStoredFile {
  if (isAbsolute(storedPath) || storedPath.includes("\\")) {
    throw new ResourceRevisionPayloadError(`${label} must be a daemon-owned relative storage path`);
  }
  const root = resolve(dataDir);
  const candidate = resolve(root, storedPath);
  if (!inside(root, candidate)) throw new ResourceRevisionPayloadError(`${label} escapes daemon storage`);
  const relativePath = relative(root, candidate);
  let cursor = root;
  for (const segment of relativePath.split(sep)) {
    if (!segment) continue;
    cursor = join(cursor, segment);
    let metadata;
    try {
      metadata = lstatSync(cursor);
    } catch {
      throw new ResourceRevisionPayloadError(`${label} is missing`);
    }
    if (metadata.isSymbolicLink()) throw new ResourceRevisionPayloadError(`${label} cannot traverse a symlink`);
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(root);
    realCandidate = realpathSync(candidate);
  } catch {
    throw new ResourceRevisionPayloadError(`${label} is missing`);
  }
  if (!inside(realRoot, realCandidate)) throw new ResourceRevisionPayloadError(`${label} escapes daemon storage`);
  const metadata = lstatSync(realCandidate);
  if (!metadata.isFile()) throw new ResourceRevisionPayloadError(`${label} must be a regular file`);
  return { path: realCandidate, metadata };
}

function openStoredFileSync(dataDir: string, storedPath: string, label: string): {
  fd: number;
  metadata: Stats;
} {
  const verified = secureStoredFile(dataDir, storedPath, label);
  let fd: number | null = null;
  try {
    fd = openSync(verified.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    const current = secureStoredFile(dataDir, storedPath, label);
    if (!sameFile(verified.metadata, opened) || !sameFile(opened, current.metadata)) {
      throw new ResourceRevisionPayloadError(`${label} changed while it was being opened`);
    }
    return { fd, metadata: opened };
  } catch {
    if (fd !== null) closeSync(fd);
    throw new ResourceRevisionPayloadError(`${label} is unavailable or changed during access`);
  }
}

function readStoredManifest(dataDir: string, storedPath: string): Buffer {
  const opened = openStoredFileSync(dataDir, storedPath, "Resource Revision manifest");
  try {
    if (opened.metadata.size <= 0 || opened.metadata.size > MAX_RESOURCE_MANIFEST_BYTES) {
      throw new ResourceRevisionPayloadError("Resource Revision manifest size is out of bounds");
    }
    const bytes = Buffer.allocUnsafe(MAX_RESOURCE_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.readSync(opened.fd, bytes, offset, bytes.byteLength - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_RESOURCE_MANIFEST_BYTES) {
      throw new ResourceRevisionPayloadError("Resource Revision manifest size is out of bounds");
    }
    return Buffer.from(bytes.subarray(0, offset));
  } catch (error) {
    if (error instanceof ResourceRevisionPayloadError) throw error;
    throw new ResourceRevisionPayloadError("Resource Revision manifest is unavailable");
  } finally {
    closeSync(opened.fd);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResourceRevisionPayloadError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const fields = Object.keys(value);
  const known = new Set(expected);
  for (const field of fields) {
    if (!known.has(field)) throw new ResourceRevisionPayloadError(`${label} contains unsupported field ${field}`);
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) throw new ResourceRevisionPayloadError(`${label} is missing field ${field}`);
  }
}

function normalizedMime(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ResourceRevisionPayloadError(`${label} is invalid`);
  const mimeType = value.trim().toLowerCase();
  if (mimeType !== value || !MIME.test(mimeType) || mimeType.length > 127) {
    throw new ResourceRevisionPayloadError(`${label} is invalid`);
  }
  return mimeType;
}

function parseManifest(
  bytes: Buffer,
  row: ResourceRevisionRow,
): ResourceRevisionPayloadManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(FATAL_UTF8.decode(bytes));
  } catch {
    throw new ResourceRevisionPayloadError("Resource Revision manifest is not valid UTF-8 JSON");
  }
  const manifest = record(parsed, "Resource Revision manifest");
  exactFields(
    manifest,
    ["protocol", "workspaceId", "resourceId", "resourceRevisionId", "payload"],
    "Resource Revision manifest",
  );
  if (manifest.protocol !== RESOURCE_REVISION_PAYLOAD_PROTOCOL
    || manifest.workspaceId !== row.workspace_id
    || manifest.resourceId !== row.resource_id
    || manifest.resourceRevisionId !== row.id) {
    throw new ResourceRevisionPayloadError("Resource Revision manifest identity does not match its immutable row");
  }
  const payload = record(manifest.payload, "Resource Revision payload manifest");
  exactFields(payload, ["file", "mimeType", "byteLength", "checksum"], "Resource Revision payload manifest");
  if (payload.file !== "payload.bin") {
    throw new ResourceRevisionPayloadError("Resource Revision payload file must use daemon-owned storage");
  }
  const mimeType = normalizedMime(payload.mimeType, "Resource Revision payload MIME");
  if (typeof payload.byteLength !== "number"
    || !Number.isSafeInteger(payload.byteLength)
    || payload.byteLength < 0
    || payload.byteLength > MAX_RESOURCE_PAYLOAD_BYTES) {
    throw new ResourceRevisionPayloadError("Resource Revision payload byte length is out of bounds");
  }
  if (typeof payload.checksum !== "string" || !SHA256.test(payload.checksum)) {
    throw new ResourceRevisionPayloadError("Resource Revision payload checksum is invalid");
  }
  return {
    protocol: RESOURCE_REVISION_PAYLOAD_PROTOCOL,
    workspaceId: row.workspace_id,
    resourceId: row.resource_id,
    resourceRevisionId: row.id,
    payload: {
      file: "payload.bin",
      mimeType,
      byteLength: payload.byteLength,
      checksum: payload.checksum,
    },
  };
}

function resourceRow(
  store: Store,
  workspaceId: string,
  resourceRevisionId: string,
): ResourceRevisionRow {
  const row = store.db.prepare(
    `SELECT revision.id, revision.workspace_id, revision.resource_id,
            revision.manifest_path, revision.metadata_json, revision.checksum,
            resource.kind
       FROM resource_revisions revision
       JOIN resources resource
         ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
      WHERE revision.id = ? AND revision.workspace_id = ?`,
  ).get(resourceRevisionId, workspaceId) as ResourceRevisionRow | undefined;
  if (!row) throw new ResourceRevisionPayloadError("Resource Revision payload row is missing or foreign");
  return row;
}

export function resolveResourceRevisionPayloadDescriptor(input: {
  store: Store;
  dataDir: string;
  workspaceId: string;
  resourceRevisionId: string;
  expectedResourceId?: string;
}): ResourceRevisionPayloadDescriptor {
  const row = resourceRow(input.store, input.workspaceId, input.resourceRevisionId);
  if (input.expectedResourceId !== undefined && row.resource_id !== input.expectedResourceId) {
    throw new ResourceRevisionPayloadError("Resource Revision payload does not match its exact Resource pin");
  }
  const expectedManifestPath = resourceRevisionManifestRelativePath(row.workspace_id, row.id);
  if (row.manifest_path !== expectedManifestPath) {
    throw new ResourceRevisionPayloadError("Resource Revision manifest path is not daemon-owned durable storage");
  }
  const manifestBytes = readStoredManifest(input.dataDir, row.manifest_path);
  if (manifestBytes.byteLength > MAX_RESOURCE_MANIFEST_BYTES
    || !SHA256.test(row.checksum)
    || bytesSha256(manifestBytes) !== row.checksum) {
    throw new ResourceRevisionPayloadError("Resource Revision manifest checksum does not match its immutable row");
  }
  const manifest = parseManifest(manifestBytes, row);
  let metadata: Record<string, unknown>;
  try {
    metadata = record(JSON.parse(row.metadata_json), "Resource Revision metadata");
  } catch (error) {
    if (error instanceof ResourceRevisionPayloadError) throw error;
    throw new ResourceRevisionPayloadError("Resource Revision metadata is invalid JSON");
  }
  const metadataMime = normalizedMime(metadata.mimeType, "Resource Revision metadata MIME");
  if (metadataMime !== manifest.payload.mimeType) {
    throw new ResourceRevisionPayloadError("Resource Revision manifest and metadata MIME do not match");
  }
  const payloadPath = posix.join(posix.dirname(row.manifest_path), manifest.payload.file);
  const payloadFile = openStoredFileSync(input.dataDir, payloadPath, "Resource Revision payload");
  try {
    if (payloadFile.metadata.size !== manifest.payload.byteLength) {
      throw new ResourceRevisionPayloadError("Resource Revision payload byte length does not match its manifest");
    }
  } finally {
    closeSync(payloadFile.fd);
  }
  const mountPath = posix.join(
    ".dezin",
    "resources",
    resourceRevisionMountKey(row.id),
    `payload.${extensionForMime(manifest.payload.mimeType)}`,
  );
  return {
    protocol: RESOURCE_REVISION_PAYLOAD_PROTOCOL,
    workspaceId: row.workspace_id,
    resourceId: row.resource_id,
    resourceRevisionId: row.id,
    resourceKind: row.kind,
    manifestPath: row.manifest_path,
    manifestChecksum: row.checksum,
    payloadPath,
    payloadChecksum: manifest.payload.checksum,
    byteLength: manifest.payload.byteLength,
    mimeType: manifest.payload.mimeType,
    mountPath,
    publicUrl: `/${mountPath}`,
  };
}

function begins(bytes: Buffer, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("ascii");
}

const MAX_MEDIA_STRUCTURE_RECORDS = 4_096;

function imageDimensionsAreSafe(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width >= 1 && height >= 1
    && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION
    && width * height <= MAX_IMAGE_PIXELS;
}

function pngScanLayout(
  width: number,
  height: number,
  bitDepth: number,
  channels: number,
  interlace: number,
): { byteLength: number; rowOffsets: number[] } | null {
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
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (passWidth === 0 || passHeight === 0) continue;
    const rowBytes = Math.ceil((passWidth * bitDepth * channels) / 8);
    for (let row = 0; row < passHeight; row += 1) {
      rowOffsets.push(byteLength);
      byteLength += rowBytes + 1;
      if (byteLength > MAX_DECODED_IMAGE_BYTES) return null;
    }
  }
  return { byteLength, rowOffsets };
}

function inflatePngScanlines(
  chunks: readonly Buffer[],
  compressedByteLength: number,
  layout: { byteLength: number; rowOffsets: number[] },
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const inflater = createInflate();
    let settled = false;
    let decodedOffset = 0;
    let rowIndex = 0;
    const finish = (valid: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(valid);
    };
    const abort = (): void => {
      inflater.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Resource payload validation aborted"));
      finish(false);
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
        inflater.destroy();
        finish(false);
        return;
      }
      while (rowIndex < layout.rowOffsets.length && layout.rowOffsets[rowIndex]! < nextOffset) {
        const rowOffset = layout.rowOffsets[rowIndex]!;
        if (rowOffset >= decodedOffset && chunk[rowOffset - decodedOffset]! > 4) {
          inflater.destroy();
          finish(false);
          return;
        }
        rowIndex += 1;
      }
      decodedOffset = nextOffset;
    });
    inflater.once("error", () => finish(false));
    inflater.once("end", () => {
      finish(
        decodedOffset === layout.byteLength
        && rowIndex === layout.rowOffsets.length
        && inflater.bytesWritten === compressedByteLength,
      );
    });
    void (async () => {
      for (const chunk of chunks) {
        if (settled) return;
        if (!inflater.write(chunk)) {
          await once(inflater, "drain", signal === undefined ? undefined : { signal });
        }
      }
      if (!settled) inflater.end();
    })().catch(() => {
      inflater.destroy();
      finish(false);
    });
  });
}

async function pngStructureIsValid(bytes: Buffer, signal?: AbortSignal): Promise<boolean> {
  if (bytes.length < 45 || !begins(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return false;
  let offset = 8;
  let records = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataRunEnded = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let channels = 0;
  let interlace = 0;
  let compressedByteLength = 0;
  const compressedChunks: Buffer[] = [];
  while (offset < bytes.length && records < MAX_MEDIA_STRUCTURE_RECORDS) {
    signal?.throwIfAborted();
    records += 1;
    if (bytes.length - offset < 12) return false;
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;
    const type = ascii(bytes, offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)
      || zlibCrc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
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
      if (!imageDimensionsAreSafe(width, height) || !validDepths[colorType]?.includes(bitDepth)
        || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0
        || (bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)) return false;
      channels = channelCounts[colorType]!;
      interlace = bytes[dataStart + 12]!;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    } else if (type === "PLTE") {
      if (sawPalette || sawImageData || length === 0 || length > 768 || length % 3 !== 0
        || colorType === 0 || colorType === 4
        || (colorType === 3 && length / 3 > 2 ** bitDepth)) return false;
      sawPalette = true;
    }
    if (type === "IDAT") {
      if (imageDataRunEnded || length === 0 || (colorType === 3 && !sawPalette)) return false;
      sawImageData = true;
      compressedByteLength += length;
      compressedChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (sawImageData && type !== "IEND") {
      imageDataRunEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.length) return false;
      const layout = pngScanLayout(width, height, bitDepth, channels, interlace);
      return layout !== null
        && await inflatePngScanlines(compressedChunks, compressedByteLength, layout, signal);
    }
    if (type !== "IHDR" && type !== "PLTE" && type !== "IDAT" && type !== "IEND"
      && (type.charCodeAt(0) & 0x20) === 0) return false;
    offset = chunkEnd;
  }
  return false;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegContainerIsCompatible(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let records = 0;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.length && records < MAX_MEDIA_STRUCTURE_RECORDS) {
    records += 1;
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++]!;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0x01) continue;
    if (bytes.length - offset < 2) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2) return false;
    const segmentEnd = offset + segmentLength;
    if (segmentEnd < offset || segmentEnd > bytes.length) return false;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 11) return false;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7]!;
      if (!imageDimensionsAreSafe(width, height) || components === 0 || components > 4
        || segmentLength !== 8 + (3 * components)) return false;
      sawFrame = true;
    }
    if (marker !== 0xda) {
      offset = segmentEnd;
      continue;
    }
    const scanComponents = bytes[offset + 2]!;
    if (!sawFrame || scanComponents === 0 || scanComponents > 4
      || segmentLength !== 6 + (2 * scanComponents)) return false;
    sawScan = true;
    offset = segmentEnd;
    let foundMarker = false;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const markerStart = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      const entropyMarker = bytes[offset]!;
      if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = markerStart;
      foundMarker = true;
      break;
    }
    if (!foundMarker) return false;
  }
  return false;
}

function gifSubBlocksEnd(bytes: Buffer, start: number): number | null {
  let offset = start;
  let records = 0;
  while (offset < bytes.length && records < MAX_MEDIA_STRUCTURE_RECORDS) {
    records += 1;
    const size = bytes[offset++]!;
    if (size === 0) return offset;
    if (size > bytes.length - offset) return null;
    offset += size;
  }
  return null;
}

function gifContainerIsCompatible(bytes: Buffer): boolean {
  if (bytes.length < 14 || (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a")) {
    return false;
  }
  const screenWidth = bytes.readUInt16LE(6);
  const screenHeight = bytes.readUInt16LE(8);
  if (!imageDimensionsAreSafe(screenWidth, screenHeight)) return false;
  const packed = bytes[10]!;
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    const colorTableBytes = 3 * (2 ** ((packed & 0x07) + 1));
    if (colorTableBytes > bytes.length - offset) return false;
    offset += colorTableBytes;
  }
  let sawImage = false;
  let records = 0;
  while (offset < bytes.length && records < MAX_MEDIA_STRUCTURE_RECORDS) {
    records += 1;
    const block = bytes[offset++]!;
    if (block === 0x3b) return sawImage && offset === bytes.length;
    if (block === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      const end = gifSubBlocksEnd(bytes, offset);
      if (end === null) return false;
      offset = end;
      continue;
    }
    if (block !== 0x2c || bytes.length - offset < 9) return false;
    const width = bytes.readUInt16LE(offset + 4);
    const height = bytes.readUInt16LE(offset + 6);
    const imagePacked = bytes[offset + 8]!;
    if (!imageDimensionsAreSafe(width, height)) return false;
    offset += 9;
    if ((imagePacked & 0x80) !== 0) {
      const colorTableBytes = 3 * (2 ** ((imagePacked & 0x07) + 1));
      if (colorTableBytes > bytes.length - offset) return false;
      offset += colorTableBytes;
    }
    if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) return false;
    offset += 1;
    const end = gifSubBlocksEnd(bytes, offset);
    if (end === null || end === offset + 1) return false;
    offset = end;
    sawImage = true;
  }
  return false;
}

function uint24le(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function webpContainerIsCompatible(bytes: Buffer): boolean {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP"
    || bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  let offset = 12;
  let records = 0;
  let sawDimensions = false;
  let sawImageData = false;
  let firstChunk = true;
  while (offset < bytes.length && records < MAX_MEDIA_STRUCTURE_RECORDS) {
    records += 1;
    if (bytes.length - offset < 8) return false;
    const type = ascii(bytes, offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const chunkEnd = dataEnd + (size & 1);
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;
    if ((size & 1) !== 0 && bytes[dataEnd] !== 0) return false;
    if (firstChunk && type !== "VP8 " && type !== "VP8L" && type !== "VP8X") return false;
    firstChunk = false;
    if (type === "VP8 ") {
      if (size < 10 || (bytes[dataStart]! & 1) !== 0
        || !begins(bytes.subarray(dataStart + 3), [0x9d, 0x01, 0x2a])) return false;
      const width = bytes.readUInt16LE(dataStart + 6) & 0x3fff;
      const height = bytes.readUInt16LE(dataStart + 8) & 0x3fff;
      if (!imageDimensionsAreSafe(width, height)) return false;
      sawDimensions = true;
      sawImageData = true;
    } else if (type === "VP8L") {
      if (size < 5 || bytes[dataStart] !== 0x2f) return false;
      const dimensions = bytes.readUInt32LE(dataStart + 1);
      const width = (dimensions & 0x3fff) + 1;
      const height = ((dimensions >>> 14) & 0x3fff) + 1;
      if (!imageDimensionsAreSafe(width, height)) return false;
      sawDimensions = true;
      sawImageData = true;
    } else if (type === "VP8X") {
      if (offset !== 12 || size !== 10 || (bytes[dataStart]! & 0xc1) !== 0
        || bytes[dataStart + 1] !== 0 || bytes[dataStart + 2] !== 0 || bytes[dataStart + 3] !== 0) return false;
      const width = uint24le(bytes, dataStart + 4) + 1;
      const height = uint24le(bytes, dataStart + 7) + 1;
      if (!imageDimensionsAreSafe(width, height)) return false;
      sawDimensions = true;
    } else if (type === "ANMF") {
      if (size < 16) return false;
      const width = uint24le(bytes, dataStart + 6) + 1;
      const height = uint24le(bytes, dataStart + 9) + 1;
      if (!imageDimensionsAreSafe(width, height)) return false;
      sawImageData = true;
    }
    offset = chunkEnd;
  }
  return offset === bytes.length && sawDimensions && sawImageData;
}

interface ParsedSvgNode {
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedSvgNode[];
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    startTag?: { startOffset: number; endOffset: number };
    endTag?: { startOffset: number; endOffset: number };
  };
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const FORBIDDEN_SVG_ELEMENTS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);

function svgStructureIsValid(bytes: Buffer): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SVG_PAYLOAD_BYTES) return false;
  let markupTokens = 0;
  for (const byte of bytes) {
    if (byte === 0x3c && ++markupTokens > MAX_MEDIA_STRUCTURE_RECORDS) return false;
  }
  let source: string;
  try {
    source = FATAL_UTF8.decode(bytes).replace(/^\uFEFF/, "").trim();
  } catch {
    return false;
  }
  if (source.length === 0 || /<!\s*(?:doctype|entity)\b/i.test(source)) return false;
  if (source.startsWith("<?xml")) {
    const declarationEnd = source.indexOf("?>");
    if (declarationEnd < 0) return false;
    source = source.slice(declarationEnd + 2).trimStart();
  }
  const errors: ParserError[] = [];
  let fragment: ParsedSvgNode;
  try {
    fragment = parseFragment(source, {
      sourceCodeLocationInfo: true,
      onParseError(error) {
        errors.push(error);
      },
    }) as unknown as ParsedSvgNode;
  } catch {
    return false;
  }
  if (errors.length > 0) return false;
  const meaningfulRoots = (fragment.childNodes ?? []).filter((node) => (
    node.nodeName !== "#comment" && !(node.nodeName === "#text" && (node.value ?? "").trim() === "")
  ));
  if (meaningfulRoots.length !== 1) return false;
  const root = meaningfulRoots[0]!;
  if (root.tagName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) return false;
  const pending = [root];
  let records = 0;
  while (pending.length > 0) {
    records += 1;
    if (records > MAX_MEDIA_STRUCTURE_RECORDS) return false;
    const node = pending.pop()!;
    if (node.tagName !== undefined) {
      const location = node.sourceCodeLocation;
      if (!location?.startTag) return false;
      const opening = source.slice(location.startTag.startOffset, location.startTag.endOffset);
      const selfClosing = /\/\s*>$/.test(opening);
      if (!selfClosing && !location.endTag) return false;
      const tagName = node.tagName.toLowerCase();
      if (FORBIDDEN_SVG_ELEMENTS.has(tagName)) return false;
      for (const attribute of node.attrs ?? []) {
        if (/^on/i.test(attribute.name)
          || ((attribute.name === "href" || attribute.name === "xlink:href")
            && /^\s*(?:javascript|vbscript|data:text\/html)/i.test(attribute.value))) return false;
      }
    }
    for (const child of node.childNodes ?? []) pending.push(child);
  }
  return true;
}

async function mimePayloadIsValid(
  bytes: Buffer,
  byteLength: number,
  mimeType: string,
  signal?: AbortSignal,
): Promise<boolean> {
  switch (mimeType) {
    case "image/png":
      return bytes.length === byteLength && await pngStructureIsValid(bytes, signal);
    case "image/jpeg":
      return bytes.length === byteLength && jpegContainerIsCompatible(bytes);
    case "image/gif":
      return bytes.length === byteLength && gifContainerIsCompatible(bytes);
    case "image/webp":
      return bytes.length === byteLength && webpContainerIsCompatible(bytes);
    case "image/avif":
      return false;
    case "image/svg+xml": {
      return bytes.length === byteLength && svgStructureIsValid(bytes);
    }
    case "audio/mpeg":
      return ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    case "audio/wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
    case "audio/ogg":
    case "video/ogg":
      return ascii(bytes, 0, 4) === "OggS";
    case "audio/webm":
    case "video/webm":
      return begins(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "video/mp4":
      return byteLength >= 16 && ascii(bytes, 4, 8) === "ftyp";
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "application/json":
      try {
        JSON.parse(FATAL_UTF8.decode(bytes));
        return true;
      } catch {
        return false;
      }
    default:
      if (mimeType.startsWith("text/")) {
        try {
          return !FATAL_UTF8.decode(bytes).includes("\0");
        } catch {
          return false;
        }
      }
      return !mimeType.startsWith("image/")
        && !mimeType.startsWith("audio/")
        && !mimeType.startsWith("video/");
  }
}

async function writeFully(
  destination: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await destination.write(bytes, offset, bytes.length - offset, null);
    if (written.bytesWritten <= 0) throw new ResourceRevisionPayloadError("Resource payload copy made no progress");
    offset += written.bytesWritten;
  }
}

/**
 * Revalidate the sealed manifest and payload bytes, optionally copying the exact
 * bytes into an assembly-owned destination. Reads are bounded and observe AbortSignal.
 */
export async function verifyResourceRevisionPayload(
  dataDir: string,
  descriptor: ResourceRevisionPayloadDescriptor,
  options: { destination?: string; signal?: AbortSignal } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const manifestBytes = readStoredManifest(dataDir, descriptor.manifestPath);
  if (manifestBytes.byteLength > MAX_RESOURCE_MANIFEST_BYTES
    || bytesSha256(manifestBytes) !== descriptor.manifestChecksum) {
    throw new ResourceRevisionPayloadError("Resource Revision manifest checksum changed after resolution");
  }
  const payloadFile = secureStoredFile(dataDir, descriptor.payloadPath, "Resource Revision payload");
  let source: Awaited<ReturnType<typeof open>>;
  try {
    source = await open(payloadFile.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new ResourceRevisionPayloadError("Resource Revision payload is unavailable");
  }
  const destinationPath = options.destination;
  const temporaryPath = destinationPath ? `${destinationPath}.tmp-${randomUUID()}` : null;
  let destination: Awaited<ReturnType<typeof open>> | null = null;
  const hash = createHash("sha256");
  let total = 0;
  let validated = false;
  try {
    const metadata = await source.stat();
    const currentPayloadFile = secureStoredFile(dataDir, descriptor.payloadPath, "Resource Revision payload");
    if (!sameFile(payloadFile.metadata, metadata) || !sameFile(metadata, currentPayloadFile.metadata)) {
      throw new ResourceRevisionPayloadError("Resource Revision payload changed while it was being opened");
    }
    if (!metadata.isFile() || metadata.size !== descriptor.byteLength || metadata.size > MAX_RESOURCE_PAYLOAD_BYTES) {
      throw new ResourceRevisionPayloadError("Resource Revision payload byte length changed after resolution");
    }
    if (destinationPath && temporaryPath) {
      await mkdir(dirname(destinationPath), { recursive: true });
      destination = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o444);
    }
    const needsWholeTextPayload = descriptor.mimeType === "application/json"
      || descriptor.mimeType === "image/svg+xml"
      || descriptor.mimeType.startsWith("text/");
    const needsWholePayload = needsWholeTextPayload
      || descriptor.mimeType === "image/png"
      || descriptor.mimeType === "image/jpeg"
      || descriptor.mimeType === "image/gif"
      || descriptor.mimeType === "image/webp";
    if (needsWholeTextPayload && descriptor.byteLength > MAX_TEXT_PAYLOAD_BYTES) {
      throw new ResourceRevisionPayloadError("Text Resource Revision payload exceeds its MIME validation bound");
    }
    const validationBytes = Buffer.allocUnsafe(
      needsWholePayload ? descriptor.byteLength : Math.min(descriptor.byteLength, MIME_PROBE_BYTES),
    );
    let validationBytesWritten = 0;
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (total < descriptor.byteLength) {
      options.signal?.throwIfAborted();
      const read = await source.read(buffer, 0, Math.min(buffer.length, descriptor.byteLength - total), null);
      if (read.bytesRead <= 0) throw new ResourceRevisionPayloadError("Resource Revision payload ended before its manifest length");
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      if (validationBytesWritten < validationBytes.byteLength) {
        const retained = chunk.subarray(0, validationBytes.byteLength - validationBytesWritten);
        retained.copy(validationBytes, validationBytesWritten);
        validationBytesWritten += retained.byteLength;
      }
      if (destination) await writeFully(destination, chunk);
      total += read.bytesRead;
    }
    const extra = await source.read(buffer, 0, 1, null);
    if (extra.bytesRead !== 0) throw new ResourceRevisionPayloadError("Resource Revision payload exceeds its manifest length");
    if (hash.digest("hex") !== descriptor.payloadChecksum) {
      throw new ResourceRevisionPayloadError("Resource Revision payload checksum does not match its manifest");
    }
    if (!await mimePayloadIsValid(
      validationBytes.subarray(0, validationBytesWritten),
      total,
      descriptor.mimeType,
      options.signal,
    )) {
      if (descriptor.mimeType === "image/avif") {
        throw new ResourceRevisionPayloadError(
          "Legacy Resource Viewer AVIF compatibility requires a bounded ISOBMFF decoder; re-import this Resource as PNG or SVG",
        );
      }
      if (descriptor.mimeType === "image/jpeg" || descriptor.mimeType === "image/gif"
        || descriptor.mimeType === "image/webp") {
        throw new ResourceRevisionPayloadError(
          `Legacy Resource Viewer compatibility rejected the bounded container for declared MIME ${descriptor.mimeType}`,
        );
      }
      throw new ResourceRevisionPayloadError("Resource Revision payload bytes do not match the declared MIME");
    }
    options.signal?.throwIfAborted();
    if (destination) await destination.sync();
    validated = true;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof ResourceRevisionPayloadError) throw error;
    throw new ResourceRevisionPayloadError(
      destinationPath
        ? "Resource Revision payload could not be materialized"
        : "Resource Revision payload could not be read",
    );
  } finally {
    await source.close().catch(() => {});
    await destination?.close().catch(() => {});
    if (!validated && temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {});
  }
  if (destinationPath && temporaryPath) {
    try {
      options.signal?.throwIfAborted();
      await rm(destinationPath, { force: true });
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
