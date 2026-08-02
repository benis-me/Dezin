import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import {
  MAX_MOODBOARD_RESOURCE_BUNDLE_BYTES,
  MAX_RESOURCE_MANIFEST_BYTES,
  RESOURCE_REVISION_PAYLOAD_PROTOCOL,
  resourceRevisionManifestRelativePath,
  resourceRevisionMountKey,
  verifyResourceRevisionPayload,
  type ResourceRevisionPayloadDescriptor,
  type ResourceRevisionPayloadManifest,
} from "./resource-revision-payload.ts";
import { stableStringify } from "./canonical-json.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class SharinganResourceRevisionWriteError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SharinganResourceRevisionWriteError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface WrittenSharinganResourceRevisionPayload {
  manifestPath: string;
  checksum: string;
  payloadChecksum: string;
  byteSize: number;
  mimeType: "application/json";
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new SharinganResourceRevisionWriteError(`${label} is invalid`);
  return value;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function secureDirectory(root: string, directory: string): Promise<void> {
  if (!inside(root, directory)) throw new SharinganResourceRevisionWriteError("Resource Revision path escapes storage");
  const path = relative(root, directory);
  let cursor = root;
  for (const segment of path.split(sep)) {
    if (!segment) continue;
    cursor = join(cursor, segment);
    try {
      await mkdir(cursor, { mode: 0o700 });
      await syncDirectory(dirname(cursor));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(cursor) !== cursor) {
      throw new SharinganResourceRevisionWriteError("Resource Revision storage traverses a symlink");
    }
  }
}

async function writeImmutableFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await secureDirectory(root, directory);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o444,
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesWritten <= 0) {
        throw new SharinganResourceRevisionWriteError("Resource Revision write made no progress");
      }
      offset += result.bytesWritten;
    }
    await handle.sync();
    const opened = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino
      || Number(opened.size) !== bytes.byteLength || Number(current.size) !== bytes.byteLength) {
      throw new SharinganResourceRevisionWriteError("Resource Revision file changed while it was written");
    }
    await handle.close();
    handle = null;
    await chmod(path, 0o444);
    await syncDirectory(directory);
  } catch (error) {
    throw error instanceof SharinganResourceRevisionWriteError
      ? error
      : new SharinganResourceRevisionWriteError("Resource Revision could not be sealed", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Seal the exact Sharingan JSON bundle after its durable materialization intent
 * exists. The DB row is created only after this function verifies both files.
 */
export async function writeSharinganResourceRevisionPayload(input: {
  dataDir: string;
  workspaceId: string;
  resourceId: string;
  revisionId: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
}): Promise<WrittenSharinganResourceRevisionPayload> {
  input.signal?.throwIfAborted();
  const workspaceId = safeId(input.workspaceId, "Sharingan Workspace id");
  const resourceId = safeId(input.resourceId, "Sharingan Resource id");
  const revisionId = safeId(input.revisionId, "Sharingan Resource Revision id");
  if (!(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength < 2
    || input.bytes.byteLength > MAX_MOODBOARD_RESOURCE_BUNDLE_BYTES) {
    throw new SharinganResourceRevisionWriteError("Sharingan capture bundle exceeds its exact byte limit");
  }
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  } catch (error) {
    throw new SharinganResourceRevisionWriteError("Sharingan capture bundle must be valid UTF-8 JSON", error);
  }

  const root = await realpath(resolve(input.dataDir)).catch((error) => {
    throw new SharinganResourceRevisionWriteError("Resource Revision storage root is unavailable", error);
  });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new SharinganResourceRevisionWriteError("Resource Revision storage root is invalid");
  }
  const manifestPath = resourceRevisionManifestRelativePath(workspaceId, revisionId);
  const manifestAbsolutePath = join(root, ...manifestPath.split("/"));
  const payloadPath = posix.join(posix.dirname(manifestPath), "payload.bin");
  const payloadAbsolutePath = join(root, ...payloadPath.split("/"));
  if (!inside(root, manifestAbsolutePath) || !inside(root, payloadAbsolutePath)) {
    throw new SharinganResourceRevisionWriteError("Resource Revision path escapes storage");
  }
  const payloadChecksum = checksum(input.bytes);
  const manifest: ResourceRevisionPayloadManifest = {
    protocol: RESOURCE_REVISION_PAYLOAD_PROTOCOL,
    workspaceId,
    resourceId,
    resourceRevisionId: revisionId,
    payload: {
      file: "payload.bin",
      mimeType: "application/json",
      byteLength: input.bytes.byteLength,
      checksum: payloadChecksum,
    },
  };
  const manifestBytes = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
  if (manifestBytes.byteLength > MAX_RESOURCE_MANIFEST_BYTES) {
    throw new SharinganResourceRevisionWriteError("Sharingan Resource Revision manifest is too large");
  }

  await writeImmutableFile(root, payloadAbsolutePath, input.bytes);
  await writeImmutableFile(root, manifestAbsolutePath, manifestBytes);
  const manifestChecksum = checksum(manifestBytes);
  const mountPath = posix.join(
    ".dezin",
    "resources",
    resourceRevisionMountKey(revisionId),
    "payload.json",
  );
  const descriptor: ResourceRevisionPayloadDescriptor = {
    protocol: RESOURCE_REVISION_PAYLOAD_PROTOCOL,
    workspaceId,
    resourceId,
    resourceRevisionId: revisionId,
    resourceKind: "sharingan-capture",
    manifestPath,
    manifestChecksum,
    payloadPath,
    payloadChecksum,
    byteLength: input.bytes.byteLength,
    mimeType: "application/json",
    mountPath,
    publicUrl: `/${mountPath}`,
  };
  try {
    await verifyResourceRevisionPayload(root, descriptor, {
      signal: input.signal,
      maxTextPayloadBytes: MAX_MOODBOARD_RESOURCE_BUNDLE_BYTES,
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    throw new SharinganResourceRevisionWriteError("Sharingan Resource Revision verification failed", error);
  }
  return Object.freeze({
    manifestPath,
    checksum: manifestChecksum,
    payloadChecksum,
    byteSize: input.bytes.byteLength,
    mimeType: "application/json",
  });
}
