import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInflate, crc32 as zlibCrc32 } from "node:zlib";
import type { RenderFrameSpec, Store } from "../../../packages/core/src/index.ts";
import { stablePreviewHash } from "./render-assembly.ts";

const CACHE_VERSION = 1;
export const MAX_PNG_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = MAX_PNG_IMAGE_BYTES;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_PNG_CHUNKS = 4_096;
const MAX_RENDER_CONCURRENCY = 2;
const MAX_VALIDATION_CONCURRENCY = 2;
const DEFAULT_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;
const LOCK_WAIT_TIMEOUT_MS = 120_000;
const LOCK_STALE_AFTER_MS = 30_000;
const MAX_LOCK_BYTES = 4 * 1024;
const LEGACY_ARTBOARD_FRAME: RenderFrameSpec = Object.freeze({
  id: "legacy-artboard",
  name: "Legacy artboard",
  width: 1440,
  height: 900,
  background: "#ffffff",
});
const flights = new Map<string, ThumbnailFlight>();
const CONTEXT_DEPENDENT_BACKGROUND_TOKEN = /(?:^|[^a-z0-9_-])(?:currentcolor|inherit|initial|revert|revert-layer|unset|accentcolor|accentcolortext|activetext|buttonborder|buttonface|buttontext|canvas|canvastext|field|fieldtext|graytext|highlight|highlighttext|linktext|mark|marktext|selecteditem|selecteditemtext|visitedtext|activeborder|activecaption|appworkspace|background|buttonhighlight|buttonshadow|captiontext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|menu|menutext|scrollbar|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|window|windowframe|windowtext|-webkit-focus-ring-color)(?:$|[^a-z0-9_-])/i;
const CONTEXT_DEPENDENT_BACKGROUND_FUNCTION = /(?:^|[^a-z0-9_-])light-dark\s*\(/i;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export type ArtifactThumbnailContentType = "image/png";

export interface ArtifactThumbnailRenderTarget {
  readonly version: 1;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly trackId: string;
  readonly sourceCommitHash: string;
  readonly sourceTreeHash: string;
  readonly artifactRoot: string;
  readonly renderSpecChecksum: string;
  readonly frame: DeepReadonly<RenderFrameSpec>;
  readonly stateKey: string | null;
  readonly targetChecksum: string;
}

export interface ArtifactThumbnailRenderResult {
  readonly bytes: Uint8Array;
  readonly contentType: ArtifactThumbnailContentType;
  readonly targetChecksum: string;
}

export interface ArtifactThumbnailRenderContext {
  readonly signal?: AbortSignal;
}

export type ArtifactThumbnailRenderer = (
  target: ArtifactThumbnailRenderTarget,
  context: ArtifactThumbnailRenderContext,
) => ArtifactThumbnailRenderResult | Promise<ArtifactThumbnailRenderResult>;

export interface GetArtifactThumbnailInput {
  store: Store;
  dataDir: string;
  projectId: string;
  artifactId: string;
  revisionId: string;
  requiredFrameId?: string;
  requiredStateKey?: string | null;
  signal?: AbortSignal;
  cacheBudgetBytes?: number;
}

export interface ArtifactThumbnailResult {
  bytes: Buffer;
  contentType: ArtifactThumbnailContentType;
  cacheKey: string;
  etag: string;
  cacheHit: boolean;
  renderSpecChecksum: string;
  target: ArtifactThumbnailRenderTarget;
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface ValidatedImage extends ImageDimensions {
  bytes: Buffer;
  contentType: ArtifactThumbnailContentType;
}

interface CacheHeader {
  version: 1;
  cacheKey: string;
  targetChecksum: string;
  contentType: ArtifactThumbnailContentType;
  byteLength: number;
  byteChecksum: string;
  imageWidth: number;
  imageHeight: number;
}

interface HeldFileLock {
  handle: FileHandle;
  path: string;
  token: string;
}

interface ThumbnailFlight {
  controller: AbortController;
  promise: Promise<ArtifactThumbnailResult>;
  waiters: Set<symbol>;
  settled: boolean;
}

interface LockSnapshot {
  pid: number;
  token: string;
  createdAt: number;
  dev: number;
  ino: number;
}

interface CacheFileSnapshot {
  size: number;
  dev: number;
  ino: number;
}

interface CacheUsageSnapshot {
  totalBytes: number;
  target: CacheFileSnapshot | null;
}

interface DirectorySnapshot {
  dev: number;
  ino: number;
}

interface ConcurrencyWaiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

export class ArtifactThumbnailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactThumbnailValidationError";
  }
}

export class ArtifactThumbnailNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactThumbnailNotFoundError";
  }
}

function nonEmptyString(value: unknown, label: string, limit = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || !isWellFormedUtf16(value)) {
    throw new ArtifactThumbnailValidationError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

export function isDeterministicFrameBackground(value: string): boolean {
  return !CONTEXT_DEPENDENT_BACKGROUND_TOKEN.test(value)
    && !CONTEXT_DEPENDENT_BACKGROUND_FUNCTION.test(value);
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return nonEmptyString(value, label);
}

function cloneFixtureValue(
  value: unknown,
  label: string,
  state: { nodes: number },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (depth > 32 || state.nodes > 20_000) {
    throw new ArtifactThumbnailValidationError(`${label} is too deeply nested or large`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormedUtf16(value)) throw new ArtifactThumbnailValidationError(`${label} contains invalid text`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ArtifactThumbnailValidationError(`${label} contains an invalid number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneFixtureValue(item, `${label}[${index}]`, state, depth + 1));
  }
  if (!value || typeof value !== "object") {
    throw new ArtifactThumbnailValidationError(`${label} must contain only JSON values`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArtifactThumbnailValidationError(`${label} must contain only plain objects`);
  }
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.length > 256 || !isWellFormedUtf16(key)) {
      throw new ArtifactThumbnailValidationError(`${label} contains an invalid property name`);
    }
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneFixtureValue(item, `${label}.${key}`, state, depth + 1),
      writable: true,
    });
  }
  return clone;
}

function cloneFixture(value: unknown, label: string): Record<string, unknown> {
  return cloneFixtureValue(value, label, { nodes: 0 }) as Record<string, unknown>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (!value || typeof value !== "object" || seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}

function frameFrom(value: unknown, index: number): RenderFrameSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactThumbnailValidationError(`RenderSpec frame ${index} must be an object`);
  }
  const frame = value as Record<string, unknown>;
  const id = nonEmptyString(frame.id, `RenderSpec frame ${index} id`);
  const name = frame.name === undefined ? id : nonEmptyString(frame.name, `RenderSpec frame ${id} name`);
  if (!Number.isSafeInteger(frame.width) || (frame.width as number) < 1 || (frame.width as number) > MAX_IMAGE_DIMENSION
    || !Number.isSafeInteger(frame.height) || (frame.height as number) < 1 || (frame.height as number) > MAX_IMAGE_DIMENSION
    || (frame.width as number) * (frame.height as number) > MAX_IMAGE_PIXELS) {
    throw new ArtifactThumbnailValidationError(`RenderSpec frame ${id} dimensions are invalid`);
  }
  const initialState = frame.initialState === undefined
    ? undefined
    : nonEmptyString(frame.initialState, `RenderSpec frame ${id} initialState`);
  const background = frame.background === undefined
    ? undefined
    : nonEmptyString(frame.background, `RenderSpec frame ${id} background`, 4_096);
  if (background !== undefined && !isDeterministicFrameBackground(background)) {
    throw new ArtifactThumbnailValidationError(
      `RenderSpec frame ${id} background must not depend on document or operating-system color state`,
    );
  }
  if (frame.fixture !== undefined && (!frame.fixture || typeof frame.fixture !== "object" || Array.isArray(frame.fixture))) {
    throw new ArtifactThumbnailValidationError(`RenderSpec frame ${id} fixture must be an object`);
  }
  return {
    id,
    name,
    width: frame.width as number,
    height: frame.height as number,
    ...(initialState === undefined ? {} : { initialState }),
    ...(frame.fixture === undefined ? {} : { fixture: cloneFixture(frame.fixture, `RenderSpec frame ${id} fixture`) }),
    ...(background === undefined ? {} : { background }),
  };
}

function requiredRenderTarget(
  renderSpec: Record<string, unknown>,
  requiredFrameId: string | undefined,
  requiredStateKey: string | null | undefined,
  allowLegacyArtboard: boolean,
): { frame: RenderFrameSpec; stateKey: string | null } {
  if (!Array.isArray(renderSpec.frames) || renderSpec.frames.length > 64) {
    throw new ArtifactThumbnailValidationError("Artifact RenderSpec must declare between 1 and 64 frames");
  }
  if (renderSpec.frames.length === 0) {
    if (!allowLegacyArtboard) {
      throw new ArtifactThumbnailValidationError("Artifact RenderSpec must declare between 1 and 64 frames");
    }
    if (requiredFrameId !== undefined && requiredFrameId !== LEGACY_ARTBOARD_FRAME.id) {
      throw new ArtifactThumbnailValidationError(
        `required thumbnail frame ${requiredFrameId} is not available for the legacy Artifact Revision`,
      );
    }
    if (requiredStateKey !== undefined && requiredStateKey !== null) {
      throw new ArtifactThumbnailValidationError(
        "legacy Artifact Revision thumbnails do not declare interactive states",
      );
    }
    return { frame: { ...LEGACY_ARTBOARD_FRAME }, stateKey: null };
  }
  const frames = renderSpec.frames.map(frameFrom);
  const ids = new Set<string>();
  for (const frame of frames) {
    if (ids.has(frame.id)) throw new ArtifactThumbnailValidationError(`Artifact RenderSpec has duplicate frame ${frame.id}`);
    ids.add(frame.id);
  }
  const configured = requiredFrameId
    ?? (renderSpec.thumbnailFrameId === undefined
      ? frames[0]!.id
      : nonEmptyString(renderSpec.thumbnailFrameId, "RenderSpec thumbnailFrameId"));
  const frame = frames.find((candidate) => candidate.id === configured);
  if (!frame) throw new ArtifactThumbnailValidationError(`required thumbnail frame ${configured} is not in the RenderSpec`);
  const stateKey = requiredStateKey === undefined
    ? optionalString(renderSpec.thumbnailStateKey ?? frame.initialState, "required thumbnail state")
    : optionalString(requiredStateKey, "required thumbnail state");
  return { frame, stateKey };
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertImageDimensions(width: number, height: number): ImageDimensions {
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
      const reason = signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
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

async function probePng(bytes: Buffer, signal?: AbortSignal): Promise<ImageDimensions> {
  throwIfAborted(signal);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) throw new Error("invalid PNG signature");
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
      if (!sawHeader || sawEnd || imageDataRunEnded || length === 0 || (colorType === 3 && !sawPalette)) {
        throw new Error("invalid PNG image data");
      }
      sawImageData = true;
      compressedByteLength += length;
      compressed.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (!sawHeader || !sawImageData || sawEnd || length !== 0) throw new Error("invalid PNG end chunk");
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

/**
 * Fully validates one bounded PNG, including chunks, CRCs, decoded scanline
 * layout, dimensions, pixel budget, and cancellation during inflation.
 */
export async function inspectBoundedPngImage(
  value: Uint8Array,
  signal?: AbortSignal,
): Promise<Readonly<ImageDimensions>> {
  throwIfAborted(signal);
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_PNG_IMAGE_BYTES) {
    throw new Error("PNG bytes exceed the bounded image budget");
  }
  return probePng(Buffer.from(value), signal);
}

function probeImageDimensions(
  bytes: Buffer,
  _contentType: ArtifactThumbnailContentType,
  signal?: AbortSignal,
): Promise<ImageDimensions> {
  return probePng(bytes, signal);
}

async function validateRenderedImageWithoutGlobalLimit(
  value: ArtifactThumbnailRenderResult,
  expectedTargetChecksum: string,
  signal?: AbortSignal,
): Promise<ValidatedImage> {
  throwIfAborted(signal);
  if (!value || typeof value !== "object" || value.targetChecksum !== expectedTargetChecksum) {
    throw new ArtifactThumbnailValidationError("thumbnail renderer target checksum does not match the requested target");
  }
  if (!(value.bytes instanceof Uint8Array)
    || value.bytes.length === 0 || value.bytes.length > MAX_IMAGE_BYTES
    || value.contentType !== "image/png") {
    throw new ArtifactThumbnailValidationError("thumbnail renderer must return a bounded decodable PNG image");
  }
  const bytes = Buffer.from(value.bytes);
  try {
    const dimensions = await probeImageDimensions(bytes, value.contentType, signal);
    return { ...dimensions, bytes, contentType: value.contentType };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    void error;
    throw new ArtifactThumbnailValidationError("thumbnail renderer must return a bounded decodable PNG image");
  }
}

function validateRenderedImage(
  value: ArtifactThumbnailRenderResult,
  expectedTargetChecksum: string,
  signal?: AbortSignal,
): Promise<ValidatedImage> {
  return withValidationSlot(
    () => validateRenderedImageWithoutGlobalLimit(value, expectedTargetChecksum, signal),
    signal,
  );
}

function cacheRoot(dataDir: string): string {
  return join(dataDir, "cache", "artifact-thumbnails", `v${CACHE_VERSION}`);
}

async function assertRealDirectory(
  path: string,
  signal?: AbortSignal,
  expected?: DirectorySnapshot,
): Promise<DirectorySnapshot> {
  throwIfAborted(signal);
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new ArtifactThumbnailValidationError("thumbnail cache directory must be a real directory");
  }
  throwIfAborted(signal);
  if (await realpath(path) !== path) {
    throw new ArtifactThumbnailValidationError("thumbnail cache directory must not traverse symbolic links");
  }
  if (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino)) {
    throw new ArtifactThumbnailValidationError("thumbnail cache directory changed during rendering");
  }
  return { dev: entry.dev, ino: entry.ino };
}

async function ensureRealDirectory(path: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertRealDirectory(path, signal);
}

async function ensureCachePath(dataDir: string, cacheKey: string, signal?: AbortSignal): Promise<string> {
  let directory = dataDir;
  for (const segment of ["cache", "artifact-thumbnails", `v${CACHE_VERSION}`, cacheKey.slice(0, 2)]) {
    directory = join(directory, segment);
    await ensureRealDirectory(directory, signal);
  }
  return join(directory, `${cacheKey}.bin`);
}

function encodeEnvelope(header: CacheHeader, bytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), bytes]);
}

async function openBoundedRegularFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ handle: FileHandle; file: Stats } | null> {
  throwIfAborted(signal);
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!before || before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > maxBytes) {
    return null;
  }
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENXIO" || code === "ENODEV") return null;
    throw error;
  }
  try {
    const file = await handle.stat({ bigint: false });
    if (!file.isFile() || file.size < 1 || file.size > maxBytes
      || file.dev !== before.dev || file.ino !== before.ino) {
      await handle.close().catch(() => {});
      return null;
    }
    return { handle, file };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readBoundedFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
  const opened = await openBoundedRegularFile(path, maxBytes, signal);
  if (!opened) return null;
  const { handle, file } = opened;
  try {
    throwIfAborted(signal);
    const bytes = Buffer.allocUnsafe(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      throwIfAborted(signal);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) return null;
      offset += result.bytesRead;
    }
    throwIfAborted(signal);
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) return null;
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readEnvelopeWithoutGlobalLimit(
  path: string,
  cacheKey: string,
  targetChecksum: string,
  signal?: AbortSignal,
): Promise<ValidatedImage | null> {
  const envelope = await readBoundedFile(path, MAX_IMAGE_BYTES + MAX_HEADER_BYTES, signal);
  if (!envelope) return null;
  const separator = envelope.indexOf(0x0a);
  if (separator < 1 || separator > MAX_HEADER_BYTES) return null;
  try {
    const header = JSON.parse(envelope.subarray(0, separator).toString("utf8")) as Partial<CacheHeader>;
    const bytes = envelope.subarray(separator + 1);
    throwIfAborted(signal);
    const byteChecksum = checksum(bytes);
    throwIfAborted(signal);
    if (header.version !== CACHE_VERSION || header.cacheKey !== cacheKey || header.targetChecksum !== targetChecksum
      || header.contentType !== "image/png"
      || header.byteLength !== bytes.length || header.byteChecksum !== byteChecksum) return null;
    const contentType = header.contentType as ArtifactThumbnailContentType;
    const dimensions = await probeImageDimensions(bytes, contentType, signal);
    if (header.imageWidth !== dimensions.width || header.imageHeight !== dimensions.height) return null;
    return { bytes, contentType, ...dimensions };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    void error;
    return null;
  }
}

function readEnvelope(
  path: string,
  cacheKey: string,
  targetChecksum: string,
  signal?: AbortSignal,
): Promise<ValidatedImage | null> {
  return withValidationSlot(
    () => readEnvelopeWithoutGlobalLimit(path, cacheKey, targetChecksum, signal),
    signal,
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

export type ArtifactThumbnailConcurrencyLimiter = <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export function createArtifactThumbnailConcurrencyLimiter(
  maxConcurrency: number,
): ArtifactThumbnailConcurrencyLimiter {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("thumbnail concurrency limit must be a positive safe integer");
  }
  let active = 0;
  const waiters: ConcurrencyWaiter[] = [];

  const pump = (): void => {
    while (active < maxConcurrency && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      active += 1;
      waiter.resolve();
    }
  };

  const acquire = async (signal?: AbortSignal): Promise<void> => {
    throwIfAborted(signal);
    if (active < maxConcurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ConcurrencyWaiter = { signal, resolve, reject };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(abortReason(signal!));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort();
    });
  };

  return async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    await acquire(signal);
    try {
      throwIfAborted(signal);
      return await operation();
    } finally {
      active -= 1;
      pump();
    }
  };
}

const withValidationSlot = createArtifactThumbnailConcurrencyLimiter(MAX_VALIDATION_CONCURRENCY);

let activeRenders = 0;
const renderWaiters: ConcurrencyWaiter[] = [];

function pumpRenderWaiters(): void {
  while (activeRenders < MAX_RENDER_CONCURRENCY && renderWaiters.length > 0) {
    const waiter = renderWaiters.shift()!;
    if (waiter.signal?.aborted) {
      waiter.reject(abortReason(waiter.signal));
      continue;
    }
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    activeRenders += 1;
    waiter.resolve();
  }
}

async function acquireRenderSlot(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (activeRenders < MAX_RENDER_CONCURRENCY) {
    activeRenders += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: ConcurrencyWaiter = { signal, resolve, reject };
    waiter.onAbort = () => {
      const index = renderWaiters.indexOf(waiter);
      if (index >= 0) renderWaiters.splice(index, 1);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    renderWaiters.push(waiter);
    if (signal?.aborted) waiter.onAbort();
  });
}

function releaseRenderSlot(): void {
  activeRenders -= 1;
  pumpRenderWaiters();
}

async function renderWithGlobalLimit(
  target: ArtifactThumbnailRenderTarget,
  renderer: ArtifactThumbnailRenderer,
  signal?: AbortSignal,
): Promise<ValidatedImage> {
  await acquireRenderSlot(signal);
  let rendering: Promise<ArtifactThumbnailRenderResult>;
  try {
    throwIfAborted(signal);
    rendering = Promise.resolve(renderer(target, { signal }));
  } catch (error) {
    releaseRenderSlot();
    throw error;
  }
  const trackedRendering = rendering.then(
    (result) => {
      releaseRenderSlot();
      return result;
    },
    (error: unknown) => {
      releaseRenderSlot();
      throw error;
    },
  );
  const result = await awaitWithAbort(trackedRendering, signal);
  throwIfAborted(signal);
  return validateRenderedImage(result, target.targetChecksum, signal);
}

async function tryCreateOwnedFileLock(path: string): Promise<HeldFileLock | null> {
  await assertRealDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.candidate`;
  let handle: FileHandle | null = null;
  let published = false;
  const token = randomUUID();
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), "utf8");
    await handle.sync();
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    return { handle, path, token };
  } catch (error) {
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
    if (!published) {
      await handle?.close().catch(() => {});
    }
  }
}

async function readLockSnapshot(path: string, signal?: AbortSignal): Promise<LockSnapshot | null> {
  const opened = await openBoundedRegularFile(path, MAX_LOCK_BYTES, signal);
  if (!opened) return null;
  const { handle, file } = opened;
  try {
    const bytes = Buffer.allocUnsafe(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      throwIfAborted(signal);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) return null;
      offset += result.bytesRead;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1
      || typeof value.token !== "string" || value.token.length < 1 || value.token.length > 256
      || !Number.isFinite(value.createdAt) || (value.createdAt as number) < 1) return null;
    return {
      pid: value.pid as number,
      token: value.token,
      createdAt: value.createdAt as number,
      dev: file.dev,
      ino: file.ino,
    };
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sameLock(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.token === right.token;
}

function isAbandonedLock(lock: LockSnapshot): boolean {
  return Date.now() - lock.createdAt >= LOCK_STALE_AFTER_MS && !processIsAlive(lock.pid);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function unlinkMatchingLock(path: string, expected: LockSnapshot, signal?: AbortSignal): Promise<boolean> {
  const current = await readLockSnapshot(path, signal);
  if (!current || !sameLock(current, expected)) return false;
  await unlink(path);
  return true;
}

async function unlinkMatchingAbandonedLock(
  path: string,
  expected: LockSnapshot,
  signal?: AbortSignal,
): Promise<boolean> {
  const current = await readLockSnapshot(path, signal);
  if (!current || !sameLock(current, expected) || !isAbandonedLock(current)) return false;
  await unlink(path);
  return true;
}

function reclaimPaths(path: string): { claim: string; owner: string; takeover: string } {
  return {
    claim: `${path}.reclaim`,
    owner: `${path}.reclaim-owner`,
    takeover: `${path}.reclaim-takeover`,
  };
}

async function recoverAbandonedReclaim(path: string, signal?: AbortSignal): Promise<boolean> {
  const paths = reclaimPaths(path);
  const owner = await readLockSnapshot(paths.owner, signal);
  if (!owner) {
    if (await pathExists(paths.owner)) return false;
    const takeoverOnly = await readLockSnapshot(paths.takeover, signal);
    if (!takeoverOnly || !isAbandonedLock(takeoverOnly)) return false;
    if (await pathExists(paths.owner)) return false;
    return unlinkMatchingAbandonedLock(paths.takeover, takeoverOnly, signal);
  }
  if (!isAbandonedLock(owner)) return false;
  let takeover = await tryCreateOwnedFileLock(paths.takeover);
  if (!takeover) {
    const abandonedTakeover = await readLockSnapshot(paths.takeover, signal);
    if (abandonedTakeover && isAbandonedLock(abandonedTakeover)) {
      await unlinkMatchingAbandonedLock(paths.takeover, abandonedTakeover, signal);
      takeover = await tryCreateOwnedFileLock(paths.takeover);
    }
  }
  if (!takeover) return false;
  try {
    const confirmedOwner = await readLockSnapshot(paths.owner, signal);
    if (!confirmedOwner || !sameLock(confirmedOwner, owner)
      || !isAbandonedLock(confirmedOwner)) return false;
    const claimed = await readLockSnapshot(paths.claim, signal);
    const current = await readLockSnapshot(path, signal);
    if (claimed && current && sameLock(claimed, current)
      && Date.now() - current.createdAt >= LOCK_STALE_AFTER_MS
      && !processIsAlive(current.pid)) {
      await unlinkMatchingLock(path, current, signal);
    }
    if (!await pathExists(path)) await unlink(paths.claim).catch(() => {});
    await unlinkMatchingLock(paths.owner, confirmedOwner, signal);
    return true;
  } finally {
    await releaseFileLock(takeover);
  }
}

async function reclaimStaleFileLock(path: string, signal?: AbortSignal): Promise<boolean> {
  const paths = reclaimPaths(path);
  const owner = await tryCreateOwnedFileLock(paths.owner);
  if (!owner) {
    await recoverAbandonedReclaim(path, signal);
    return false;
  }
  try {
    try {
      await link(path, paths.claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const claimed = await readLockSnapshot(paths.claim, signal);
    if (!claimed || Date.now() - claimed.createdAt < LOCK_STALE_AFTER_MS || processIsAlive(claimed.pid)) return false;
    const current = await readLockSnapshot(path, signal);
    if (!current || !sameLock(current, claimed)) return false;
    await unlinkMatchingLock(path, current, signal);
    return true;
  } finally {
    await unlink(paths.claim).catch(() => {});
    await releaseFileLock(owner);
  }
}

async function tryAcquireFileLock(path: string, signal?: AbortSignal): Promise<HeldFileLock | null> {
  const paths = reclaimPaths(path);
  if (await pathExists(paths.claim) || await pathExists(paths.owner) || await pathExists(paths.takeover)) {
    await recoverAbandonedReclaim(path, signal);
    return null;
  }
  return tryCreateOwnedFileLock(path);
}

async function acquireFileLock(path: string, signal?: AbortSignal): Promise<HeldFileLock> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let delay = 10;
  while (true) {
    throwIfAborted(signal);
    const lock = await tryAcquireFileLock(path, signal);
    if (lock) return lock;
    if (await reclaimStaleFileLock(path, signal)) continue;
    if (Date.now() >= deadline) {
      throw new ArtifactThumbnailValidationError("timed out waiting for the thumbnail cache lock");
    }
    await abortableDelay(delay, signal);
    delay = Math.min(250, delay * 2);
  }
}

async function releaseFileLock(lock: HeldFileLock): Promise<void> {
  let owned: Awaited<ReturnType<FileHandle["stat"]>> | null = null;
  try {
    owned = await lock.handle.stat();
  } finally {
    await lock.handle.close().catch(() => {});
  }
  if (!owned) return;
  const current = await readLockSnapshot(lock.path).catch(() => null);
  if (current && current.dev === owned.dev && current.ino === owned.ino && current.token === lock.token) {
    await unlink(lock.path).catch(() => {});
  }
}

async function publishEnvelope(
  path: string,
  envelope: Buffer,
  signal?: AbortSignal,
  expectedDirectory?: DirectorySnapshot,
): Promise<void> {
  throwIfAborted(signal);
  await assertRealDirectory(dirname(path), signal, expectedDirectory);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(envelope);
    await handle.sync();
    await handle.close();
    handle = null;
    throwIfAborted(signal);
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function cacheUsage(root: string, targetPath: string, signal?: AbortSignal): Promise<CacheUsageSnapshot> {
  let totalBytes = 0;
  let target: CacheFileSnapshot | null = null;
  const directories = [root];
  while (directories.length > 0) {
    throwIfAborted(signal);
    const directory = directories.pop()!;
    await assertRealDirectory(directory, signal);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!file || file.isSymbolicLink()) continue;
      if (file.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!file.isFile()) continue;
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes)) {
        throw new ArtifactThumbnailValidationError("thumbnail cache size is invalid");
      }
      if (path === targetPath) target = { size: file.size, dev: file.dev, ino: file.ino };
    }
  }
  return { totalBytes, target };
}

async function assertCacheBudget(
  root: string,
  path: string,
  envelopeBytes: number,
  budgetBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const usage = await cacheUsage(root, path, signal);
  throwIfAborted(signal);
  const replaced = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const counted = usage.target;
  const replacedBytes = replaced?.isFile() && !replaced.isSymbolicLink()
    && counted?.size === replaced.size && counted.dev === replaced.dev && counted.ino === replaced.ino
    ? counted.size
    : 0;
  if (usage.totalBytes - Math.min(usage.totalBytes, replacedBytes) + envelopeBytes > budgetBytes) {
    throw new ArtifactThumbnailValidationError("thumbnail cache budget would be exceeded");
  }
}

function resolveTarget(input: GetArtifactThumbnailInput): {
  target: ArtifactThumbnailRenderTarget;
  cacheKey: string;
  renderSpecChecksum: string;
} {
  const projectId = nonEmptyString(input.projectId, "thumbnail projectId");
  const artifactId = nonEmptyString(input.artifactId, "thumbnail artifactId");
  const revisionId = nonEmptyString(input.revisionId, "thumbnail revisionId");
  const workspace = input.store.workspace.getWorkspace(projectId);
  const artifact = input.store.workspace.getArtifact(artifactId);
  const revision = input.store.workspace.getArtifactRevision(revisionId);
  if (!workspace || !artifact || !revision || artifact.archivedAt !== null
    || artifact.workspaceId !== workspace.id || revision.workspaceId !== workspace.id
    || revision.artifactId !== artifact.id || revision.artifactRoot !== artifact.sourceRoot
    || !input.store.workspace.isArtifactRevisionPublished(revision.id)) {
    throw new ArtifactThumbnailNotFoundError("owned immutable Artifact Revision thumbnail target was not found");
  }
  const renderSpecChecksum = stablePreviewHash("dezin-render-spec-v1", revision.renderSpec);
  const required = requiredRenderTarget(
    revision.renderSpec,
    input.requiredFrameId,
    input.requiredStateKey,
    revision.legacyRunId !== null,
  );
  const descriptor = {
    version: 1 as const,
    projectId,
    workspaceId: workspace.id,
    artifactId: artifact.id,
    revisionId: revision.id,
    trackId: revision.trackId,
    sourceCommitHash: revision.sourceCommitHash,
    sourceTreeHash: revision.sourceTreeHash,
    artifactRoot: revision.artifactRoot,
    renderSpecChecksum,
    frame: required.frame,
    stateKey: required.stateKey,
  };
  const targetChecksum = stablePreviewHash("dezin-artifact-thumbnail-target-v1", descriptor);
  const target = deepFreeze({ ...descriptor, targetChecksum }) as ArtifactThumbnailRenderTarget;
  const cacheKey = stablePreviewHash("dezin-artifact-thumbnail-cache-v1", {
    revisionId: revision.id,
    renderSpecChecksum,
    requiredFrame: required.frame,
    requiredStateKey: required.stateKey,
    targetChecksum,
  });
  return { target, cacheKey, renderSpecChecksum };
}

function cacheBudgetFrom(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CACHE_BUDGET_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ArtifactThumbnailValidationError("thumbnail cache budget must be a positive safe integer");
  }
  return value;
}

async function canonicalDataDir(path: string, signal?: AbortSignal): Promise<string> {
  nonEmptyString(path, "thumbnail dataDir", 4_096);
  throwIfAborted(signal);
  await mkdir(path, { recursive: true });
  throwIfAborted(signal);
  return realpath(path);
}

function makeResult(
  image: ValidatedImage,
  cacheKey: string,
  cacheHit: boolean,
  renderSpecChecksum: string,
  target: ArtifactThumbnailRenderTarget,
): ArtifactThumbnailResult {
  return {
    bytes: Buffer.from(image.bytes),
    contentType: image.contentType,
    cacheKey,
    etag: `"${cacheKey}"`,
    cacheHit,
    renderSpecChecksum,
    target,
  };
}

async function createThumbnailFlight(
  renderer: ArtifactThumbnailRenderer,
  dataDir: string,
  target: ArtifactThumbnailRenderTarget,
  cacheKey: string,
  renderSpecChecksum: string,
  budgetBytes: number,
  signal?: AbortSignal,
): Promise<ArtifactThumbnailResult> {
  const path = await ensureCachePath(dataDir, cacheKey, signal);
  const lock = await acquireFileLock(`${path}.lock`, signal);
  try {
    const shard = dirname(path);
    const shardSnapshot = await assertRealDirectory(shard, signal);
    throwIfAborted(signal);
    const winner = await readEnvelope(path, cacheKey, target.targetChecksum, signal);
    if (winner) return makeResult(winner, cacheKey, true, renderSpecChecksum, target);

    const rendered = await renderWithGlobalLimit(target, renderer, signal);
    throwIfAborted(signal);
    const header: CacheHeader = {
      version: CACHE_VERSION,
      cacheKey,
      targetChecksum: target.targetChecksum,
      contentType: rendered.contentType,
      byteLength: rendered.bytes.length,
      byteChecksum: checksum(rendered.bytes),
      imageWidth: rendered.width,
      imageHeight: rendered.height,
    };
    const envelope = encodeEnvelope(header, rendered.bytes);
    throwIfAborted(signal);
    await assertRealDirectory(shard, signal, shardSnapshot);
    const root = cacheRoot(dataDir);
    await assertRealDirectory(root, signal);
    const budgetLock = await acquireFileLock(join(root, ".budget.lock"), signal);
    try {
      await assertRealDirectory(shard, signal, shardSnapshot);
      const lateWinner = await readEnvelope(path, cacheKey, target.targetChecksum, signal);
      if (lateWinner) return makeResult(lateWinner, cacheKey, true, renderSpecChecksum, target);
      await assertCacheBudget(root, path, envelope.length, budgetBytes, signal);
      await assertRealDirectory(shard, signal, shardSnapshot);
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await publishEnvelope(path, envelope, signal, shardSnapshot);
    } finally {
      await releaseFileLock(budgetLock);
    }
    return makeResult(rendered, cacheKey, false, renderSpecChecksum, target);
  } finally {
    await releaseFileLock(lock);
  }
}

async function waitForThumbnailFlight(
  flightKey: string,
  flight: ThumbnailFlight,
  signal: AbortSignal | undefined,
  forceCacheHit: boolean,
): Promise<ArtifactThumbnailResult> {
  throwIfAborted(signal);
  const waiter = Symbol("thumbnail-flight-waiter");
  flight.waiters.add(waiter);
  try {
    const result = await awaitWithAbort(flight.promise, signal);
    return {
      ...result,
      bytes: Buffer.from(result.bytes),
      cacheHit: forceCacheHit ? true : result.cacheHit,
    };
  } finally {
    flight.waiters.delete(waiter);
    if (!flight.settled && flight.waiters.size === 0) {
      if (flights.get(flightKey) === flight) flights.delete(flightKey);
      flight.controller.abort(new DOMException("All thumbnail request waiters cancelled", "AbortError"));
    }
  }
}

export async function getOrCreateArtifactThumbnail(
  input: GetArtifactThumbnailInput,
  renderer: ArtifactThumbnailRenderer,
): Promise<ArtifactThumbnailResult> {
  throwIfAborted(input.signal);
  const budgetBytes = cacheBudgetFrom(input.cacheBudgetBytes);
  const { target, cacheKey, renderSpecChecksum } = resolveTarget(input);
  const dataDir = await canonicalDataDir(input.dataDir, input.signal);
  const path = await ensureCachePath(dataDir, cacheKey, input.signal);
  const cached = await readEnvelope(path, cacheKey, target.targetChecksum, input.signal);
  if (cached) return makeResult(cached, cacheKey, true, renderSpecChecksum, target);

  const flightKey = `${dataDir}\0${cacheKey}`;
  const running = flights.get(flightKey);
  if (running) return waitForThumbnailFlight(flightKey, running, input.signal, true);

  const controller = new AbortController();
  const flight: ThumbnailFlight = {
    controller,
    promise: undefined as never,
    waiters: new Set(),
    settled: false,
  };
  const pending = createThumbnailFlight(
    renderer,
    dataDir,
    target,
    cacheKey,
    renderSpecChecksum,
    budgetBytes,
    controller.signal,
  );
  flight.promise = pending.then(
    (result) => {
      flight.settled = true;
      if (flights.get(flightKey) === flight) flights.delete(flightKey);
      return result;
    },
    (error: unknown) => {
      flight.settled = true;
      if (flights.get(flightKey) === flight) flights.delete(flightKey);
      throw error;
    },
  );
  flights.set(flightKey, flight);
  return waitForThumbnailFlight(flightKey, flight, input.signal, false);
}
