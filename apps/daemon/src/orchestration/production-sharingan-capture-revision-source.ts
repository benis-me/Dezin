import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { GenerationTaskFailureClass, Store } from "../../../../packages/core/src/index.ts";
import {
  ResourceRevisionPayloadError,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
} from "../resource-revision-payload.ts";
import type {
  SharinganCaptureRevisionBundleSourcePort,
  SharinganCaptureRevisionMaterializationReceipt,
} from "./sharingan-capture-revision-materializer.ts";
import {
  decodeSharinganCaptureResourceBundle,
  SHARINGAN_CAPTURE_RESOURCE_BUNDLE_ROOTS,
  SharinganCaptureResourceBundleError,
  validateSharinganCaptureResourceBundleSemantics,
} from "./sharingan-capture-resource-bundle.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const CONTEXT_PACK_ID = /^context-pack-([a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class ProductionSharinganCaptureRevisionBundleSourceError extends Error {
  readonly code:
    | "SHARINGAN_CAPTURE_SOURCE_CONFIGURATION_INVALID"
    | "SHARINGAN_CAPTURE_REFERENCE_INVALID"
    | "SHARINGAN_CAPTURE_REVISION_UNAVAILABLE"
    | "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED"
    | "SHARINGAN_CAPTURE_BUNDLE_INVALID"
    | "SHARINGAN_CAPTURE_DESTINATION_INVALID"
    | "SHARINGAN_CAPTURE_COPY_FAILED";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: ProductionSharinganCaptureRevisionBundleSourceError["code"],
    message: string,
    failureClass: GenerationTaskFailureClass,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProductionSharinganCaptureRevisionBundleSourceError";
    this.code = code;
    this.failureClass = failureClass;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function fail(
  code: ProductionSharinganCaptureRevisionBundleSourceError["code"],
  message: string,
  failureClass: GenerationTaskFailureClass,
  cause?: unknown,
): never {
  throw new ProductionSharinganCaptureRevisionBundleSourceError(code, message, failureClass, cause);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Sharingan Capture exact Revision copy aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function exactReference(reference: Parameters<SharinganCaptureRevisionBundleSourcePort["materializeExactRevision"]>[0]["reference"]) {
  const match = typeof reference?.contextPackId === "string"
    ? CONTEXT_PACK_ID.exec(reference.contextPackId)
    : null;
  if (!reference || !SAFE_ID.test(reference.workspaceId) || !SAFE_ID.test(reference.resourceId)
    || !SAFE_ID.test(reference.revisionId) || !match || reference.contextPackHash !== match[1]
    || !SHA256.test(reference.contextPackHash) || !SHA256.test(reference.revisionChecksum)) {
    return fail(
      "SHARINGAN_CAPTURE_REFERENCE_INVALID",
      "Sharingan Capture source reference is not one exact Resource Revision and Context Pack identity",
      "context",
    );
  }
  return Object.freeze({ ...reference });
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function emptyCanonicalDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    return fail("SHARINGAN_CAPTURE_DESTINATION_INVALID", "Sharingan Capture destination path is invalid", "storage");
  }
  let canonical: string;
  try {
    const metadata = await lstat(path);
    canonical = await realpath(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || (await readdir(canonical)).length !== 0) {
      return fail(
        "SHARINGAN_CAPTURE_DESTINATION_INVALID",
        "Sharingan Capture destination must be one empty daemon-owned directory",
        "storage",
      );
    }
  } catch (error) {
    if (error instanceof ProductionSharinganCaptureRevisionBundleSourceError) throw error;
    return fail("SHARINGAN_CAPTURE_DESTINATION_INVALID", "Sharingan Capture destination is unavailable", "storage", error);
  }
  return canonical;
}

interface SourceDirectoryFence {
  readonly path: string;
  readonly canonical: string;
  readonly dev: number;
  readonly ino: number;
}

async function assertSourceDirectoryFences(fences: readonly SourceDirectoryFence[]): Promise<void> {
  for (const fence of fences) {
    const metadata = await lstat(fence.path).catch(() => null);
    const canonical = await realpath(fence.path).catch(() => "");
    if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.dev !== fence.dev || metadata.ino !== fence.ino || canonical !== fence.canonical) {
      fail(
        "SHARINGAN_CAPTURE_DESTINATION_INVALID",
        "Sharingan Capture destination directory changed during exact copy",
        "storage",
      );
    }
  }
}

async function ensureOwnedDirectory(
  root: string,
  relativeDirectory: string,
  pinned: Map<string, SourceDirectoryFence>,
): Promise<readonly SourceDirectoryFence[]> {
  let cursor = root;
  const result: SourceDirectoryFence[] = [];
  const rootFence = pinned.get(root);
  if (!rootFence) fail("SHARINGAN_CAPTURE_DESTINATION_INVALID", "Sharingan Capture destination root is not pinned", "storage");
  result.push(rootFence);
  for (const segment of relativeDirectory.split("/").filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!inside(root, cursor)) fail("SHARINGAN_CAPTURE_BUNDLE_INVALID", "Sharingan Capture directory escaped its destination", "context");
    let fence = pinned.get(cursor);
    if (!fence) {
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const metadata = await lstat(cursor);
      const canonical = await realpath(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || !inside(root, canonical)) {
        fail("SHARINGAN_CAPTURE_DESTINATION_INVALID", "Sharingan Capture destination directory changed during copy", "storage");
      }
      fence = Object.freeze({ path: cursor, canonical, dev: metadata.dev, ino: metadata.ino });
      pinned.set(cursor, fence);
    }
    result.push(fence);
  }
  await assertSourceDirectoryFences(result);
  return Object.freeze(result);
}

async function writeFully(
  path: string,
  bytes: Uint8Array,
  expectedChecksum: string,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
    || !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0) {
    fail("SHARINGAN_CAPTURE_COPY_FAILED", "Sharingan Capture copy requires no-follow non-blocking opens", "storage");
  }
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o444,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      checkAbort(signal);
      const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (written.bytesWritten <= 0) throw new Error("Sharingan Capture copy made no progress");
      offset += written.bytesWritten;
    }
    await handle.sync();
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== bytes.byteLength
      || (before.mode & 0o777) !== 0o444) {
      fail("SHARINGAN_CAPTURE_COPY_FAILED", "Sharingan Capture copied file metadata is invalid", "storage");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    offset = 0;
    while (offset < before.size) {
      checkAbort(signal);
      const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read.bytesRead <= 0) {
        fail("SHARINGAN_CAPTURE_COPY_FAILED", "Sharingan Capture copied file ended during verification", "storage");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    if ((await handle.read(buffer, 0, 1, offset)).bytesRead !== 0) {
      fail("SHARINGAN_CAPTURE_COPY_FAILED", "Sharingan Capture copied file grew during verification", "storage");
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || before.nlink !== after.nlink || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || hash.digest("hex") !== expectedChecksum) {
      fail("SHARINGAN_CAPTURE_COPY_FAILED", "Sharingan Capture copied file changed during verification", "storage");
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

class StoreBackedSharinganCaptureRevisionBundleSource implements SharinganCaptureRevisionBundleSourcePort {
  readonly #store: Store;
  readonly #dataDir: string;

  constructor(store: Store, dataDir: string) {
    this.#store = store;
    this.#dataDir = dataDir;
  }

  async materializeExactRevision(
    input: Parameters<SharinganCaptureRevisionBundleSourcePort["materializeExactRevision"]>[0],
  ): Promise<SharinganCaptureRevisionMaterializationReceipt> {
    const reference = exactReference(input.reference);
    checkAbort(input.signal);
    const destination = await emptyCanonicalDirectory(input.destinationDir);
    let descriptor: ReturnType<typeof resolveResourceRevisionPayloadDescriptor>;
    try {
      descriptor = resolveResourceRevisionPayloadDescriptor({
        store: this.#store,
        dataDir: this.#dataDir,
        workspaceId: reference.workspaceId,
        resourceRevisionId: reference.revisionId,
        expectedResourceId: reference.resourceId,
      });
    } catch (error) {
      if (error instanceof ResourceRevisionPayloadError) {
        return fail(
          "SHARINGAN_CAPTURE_REVISION_UNAVAILABLE",
          "Exact Sharingan Capture Resource Revision is unavailable",
          "context",
          error,
        );
      }
      throw error;
    }
    if (descriptor.workspaceId !== reference.workspaceId
      || descriptor.resourceId !== reference.resourceId
      || descriptor.resourceRevisionId !== reference.revisionId
      || descriptor.resourceKind !== "sharingan-capture"
      || descriptor.manifestChecksum !== reference.revisionChecksum
      || descriptor.mimeType !== "application/json") {
      return fail(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture Resource Revision checksum, kind, or immutable identity was substituted",
        "context",
      );
    }

    const verificationRoot = await mkdtemp(join(dirname(destination), ".dezin-sharingan-revision-read-"));
    const payloadPath = join(verificationRoot, "payload.json");
    let decoded: ReturnType<typeof decodeSharinganCaptureResourceBundle>;
    try {
      await verifyResourceRevisionPayload(this.#dataDir, descriptor, {
        destination: payloadPath,
        signal: input.signal,
      });
      checkAbort(input.signal);
      decoded = decodeSharinganCaptureResourceBundle(await readFile(payloadPath));
      await validateSharinganCaptureResourceBundleSemantics({
        source: decoded.source,
        files: decoded.files,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof SharinganCaptureResourceBundleError) {
        return fail("SHARINGAN_CAPTURE_BUNDLE_INVALID", error.message, "context", error);
      }
      if (error instanceof ResourceRevisionPayloadError) {
        return fail("SHARINGAN_CAPTURE_REVISION_SUBSTITUTED", "Sharingan Capture Resource Revision bytes failed exact verification", "context", error);
      }
      return fail("SHARINGAN_CAPTURE_BUNDLE_INVALID", "Sharingan Capture Resource bundle could not be decoded", "context", error);
    } finally {
      await rm(verificationRoot, { recursive: true, force: true }).catch(() => {});
    }
    // The bundle records its producing Resource Task pack, while `reference`
    // records the consuming Artifact Attempt pack. The exact revision checksum
    // plus Workspace/Resource identity binds the source across that boundary.
    if (decoded.scope.workspaceId !== reference.workspaceId
      || decoded.scope.resourceId !== reference.resourceId
      || decoded.scope.resourceKind !== "sharingan-capture") {
      return fail(
        "SHARINGAN_CAPTURE_REVISION_SUBSTITUTED",
        "Sharingan Capture Resource payload substituted its Workspace or Resource scope",
        "context",
      );
    }

    const destinationMetadata = await lstat(destination);
    const pinnedDirectories = new Map<string, SourceDirectoryFence>([[destination, Object.freeze({
      path: destination,
      canonical: destination,
      dev: destinationMetadata.dev,
      ino: destinationMetadata.ino,
    })]]);
    try {
      for (const root of SHARINGAN_CAPTURE_RESOURCE_BUNDLE_ROOTS) {
        await ensureOwnedDirectory(destination, root, pinnedDirectories);
      }
      for (const file of decoded.files) {
        checkAbort(input.signal);
        const absolute = resolve(destination, ...file.path.split("/"));
        if (!inside(destination, absolute)) {
          return fail("SHARINGAN_CAPTURE_BUNDLE_INVALID", "Sharingan Capture file escaped its destination", "context");
        }
        const directoryFences = await ensureOwnedDirectory(
          destination,
          dirname(file.path) === "." ? "" : dirname(file.path),
          pinnedDirectories,
        );
        await assertSourceDirectoryFences(directoryFences);
        await writeFully(absolute, file.bytes, file.checksum, input.signal);
        await assertSourceDirectoryFences(directoryFences);
      }
      checkAbort(input.signal);
      return Object.freeze({
        protocol: "dezin.sharingan-capture-materialization.v2",
        ...reference,
        files: Object.freeze(decoded.files.map((file) => Object.freeze({
          path: file.path,
          mode: file.mode,
          byteLength: file.byteLength,
          checksum: file.checksum,
        }))),
      });
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof ProductionSharinganCaptureRevisionBundleSourceError) throw error;
      return fail("SHARINGAN_CAPTURE_COPY_FAILED", "Sharingan Capture exact Revision bundle copy failed", "storage", error);
    }
  }
}

/**
 * Reads only the requested ResourceRevision row and its content-addressed
 * daemon payload. It never consults Resource head/latest or a live capture.
 */
export function createProductionSharinganCaptureRevisionBundleSource(options: {
  readonly store: Store;
  readonly dataDir: string;
}): SharinganCaptureRevisionBundleSourcePort {
  if (!options?.store || typeof options.store !== "object"
    || typeof options.dataDir !== "string" || options.dataDir.length === 0 || options.dataDir.includes("\0")) {
    return fail(
      "SHARINGAN_CAPTURE_SOURCE_CONFIGURATION_INVALID",
      "Production Sharingan Capture Resource Revision source configuration is invalid",
      "adapter",
    );
  }
  return new StoreBackedSharinganCaptureRevisionBundleSource(options.store, options.dataDir);
}
