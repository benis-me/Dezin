/**
 * Asset payload preparation: reading exact immutable bytes, validating uploaded refs and
 * source Versions, and staging prepared Asset payloads before a transaction commits.
 * Split out of design-asset-version-publication.ts; the facade there wires these
 * modules together and remains the only entry point.
 */
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  constants as fsConstants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  join,
  resolve,
  sep,
} from "node:path";
import {
  DESIGN_SCHEMA_VERSION,
  type DesignAssetBundleFile,
  type DesignAssetManifest,
} from "./design-types.ts";
import {
  DesignStorageError,
  MAX_ASSET_BUNDLE_FILES,
  MAX_DESIGN_ASSET_BATCH_BYTES,
  MAX_DESIGN_ASSET_BYTES,
  SAFE_SEGMENT,
  SHA256,
  assertStoredBundleFiles,
  assetRoot,
  designRoot,
  ensureDurableDirectory,
  exists,
  nowValue,
  readJson,
  safeBundlePath,
  safeSegment,
  storedRecord,
  validStoredText,
  validStoredTimestamp,
  withProjectLock,
  writeAtomic,
} from "./design-storage-primitives.ts";
import {
  displayAssetName,
  extensionFor,
  mimeType,
  strictBase64,
  uploadedRefName,
  validateAssetSignature,
  versionRoot,
} from "./design-publication-primitives.ts";
import type {
  DesignAssetStoreInput,
  DesignAssetPayloadReadTestHooks,
} from "./design-asset-version-publication.ts";
import type { PublicationShared } from "./design-publication-shared.ts";
import type { DesignCanvasState } from "./design-canvas-state.ts";

export interface UploadedDesignAssetPayload {
  kind: "uploaded-file";
  handle: FileHandle;
  bytes: number;
  checksum: string;
  signature: Buffer;
  identity: { dev: number; ino: number; size: number; mtimeMs: number };
}

export type PreparedDesignAssetPayload = { kind: "bytes"; bytes: Buffer } | UploadedDesignAssetPayload;

export type PreparedDesignAsset =
  | { manifest: DesignAssetManifest; target: string; existing: true }
  | {
      manifest: DesignAssetManifest;
      target: string;
      existing: false;
      payload: PreparedDesignAssetPayload;
      bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }>;
    };

export interface DesignSourceVersionReference {
  projectId: string;
  nodeId: string;
  versionId: string;
}

export interface DesignSourceVersionSnapshot {
  reference: DesignSourceVersionReference;
  bytes: Buffer;
  bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }>;
  sourceVersion: NonNullable<DesignAssetManifest["sourceVersion"]>;
  totalBytes: number;
}

export interface DesignAssetPreparationDeps extends Pick<DesignCanvasState, "canvas" | "requireInitialized" | "snapshot"> {
  /** Functions constructed after this module; resolved at call time. */
  shared: PublicationShared;
}

export function createDesignAssetPreparation(deps: DesignAssetPreparationDeps) {
  const canvas: DesignCanvasState["canvas"] = deps.canvas;
  const requireInitialized: DesignCanvasState["requireInitialized"] = deps.requireInitialized;
  const snapshot: DesignCanvasState["snapshot"] = deps.snapshot;
  const recoverPendingAssetImportsUnlocked: PublicationShared["recoverPendingAssetImportsUnlocked"] = (...args) => deps.shared.recoverPendingAssetImportsUnlocked(...args);
  const getDesignAssetManifestUnlocked: PublicationShared["getDesignAssetManifestUnlocked"] = (...args) => deps.shared.getDesignAssetManifestUnlocked(...args);
  const getDesignVersionUnlocked: PublicationShared["getDesignVersionUnlocked"] = (...args) => deps.shared.getDesignVersionUnlocked(...args);

  async function readExactFileHandle(
    handle: FileHandle,
    expectedBytes: number,
    label: string,
  ): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
      if (result.bytesRead < 1) {
        throw new DesignStorageError("corrupt", `${label} ended before its declared byte length`);
      }
      offset += result.bytesRead;
    }
    return bytes;
  }

  async function readExactImmutablePayload(input: {
    path: string;
    expectedBytes: number;
    expectedChecksum: string;
    label: string;
    beforeOpen?: () => void | Promise<void>;
  }): Promise<Buffer> {
    let handle: FileHandle | undefined;
    try {
      await input.beforeOpen?.();
      handle = await open(input.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const [openedBefore, pathBefore] = await Promise.all([handle.stat(), lstat(input.path)]);
      if (!openedBefore.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink()
        || openedBefore.dev !== pathBefore.dev || openedBefore.ino !== pathBefore.ino
        || openedBefore.size !== input.expectedBytes || pathBefore.size !== input.expectedBytes) {
        throw new DesignStorageError("corrupt", `${input.label} is invalid; expected one exact regular file`);
      }
      const bytes = await readExactFileHandle(handle, input.expectedBytes, input.label);
      const [openedAfter, pathAfter] = await Promise.all([handle.stat(), lstat(input.path)]);
      if (!openedAfter.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink()
        || openedAfter.dev !== openedBefore.dev || openedAfter.ino !== openedBefore.ino
        || pathAfter.dev !== openedBefore.dev || pathAfter.ino !== openedBefore.ino
        || openedAfter.size !== input.expectedBytes || pathAfter.size !== input.expectedBytes) {
        throw new DesignStorageError("corrupt", `${input.label} changed while it was being read`);
      }
      if (createHash("sha256").update(bytes).digest("hex") !== input.expectedChecksum) {
        throw new DesignStorageError("corrupt", `${input.label} checksum is invalid`);
      }
      return bytes;
    } catch (error) {
      if (error instanceof DesignStorageError) throw error;
      throw new DesignStorageError("corrupt", `${input.label} is unavailable or unsafe`, { cause: error });
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function checksumExactImmutablePayload(
    path: string,
    expectedBytes: number,
    label: string,
  ): Promise<string> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const [openedBefore, pathBefore] = await Promise.all([handle.stat(), lstat(path)]);
      if (!openedBefore.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink()
        || openedBefore.dev !== pathBefore.dev || openedBefore.ino !== pathBefore.ino
        || openedBefore.size !== expectedBytes || pathBefore.size !== expectedBytes) {
        throw new DesignStorageError("corrupt", `${label} is invalid; expected one exact regular file`);
      }
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(Math.min(expectedBytes, 1024 * 1024));
      let offset = 0;
      while (offset < expectedBytes) {
        const length = Math.min(chunk.length, expectedBytes - offset);
        const result = await handle.read(chunk, 0, length, offset);
        if (result.bytesRead < 1) throw new DesignStorageError("corrupt", `${label} ended before its declared byte length`);
        hash.update(chunk.subarray(0, result.bytesRead));
        offset += result.bytesRead;
      }
      const [openedAfter, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
      if (openedAfter.dev !== openedBefore.dev || openedAfter.ino !== openedBefore.ino
        || pathAfter.dev !== openedBefore.dev || pathAfter.ino !== openedBefore.ino
        || openedAfter.size !== expectedBytes || pathAfter.size !== expectedBytes) {
        throw new DesignStorageError("corrupt", `${label} changed while it was being read`);
      }
      return hash.digest("hex");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function inspectUploadedRef(
    dataDir: string,
    projectId: string,
    uploadedFileId: unknown,
    maxBytes: number | null,
    hooks?: DesignAssetPayloadReadTestHooks,
  ): Promise<UploadedDesignAssetPayload> {
    const name = uploadedRefName(uploadedFileId);
    const refsRoot = resolve(dataDir, "projects", safeSegment(projectId, "Project id"), ".refs");
    const path = resolve(refsRoot, name);
    if (path !== join(refsRoot, name) || !path.startsWith(`${refsRoot}${sep}`)) {
      throw new DesignStorageError("invalid-input", "uploadedFileId escapes the Project reference directory");
    }
    let handle;
    try {
      await hooks?.beforeUploadedPayloadOpen?.(path);
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      handle = await open(path, flags);
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || !Number.isSafeInteger(before.size)
        || (maxBytes !== null && before.size > maxBytes)) {
        throw new DesignStorageError("invalid-input", "Uploaded reference is not a supported regular file");
      }
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(Math.min(before.size, 1024 * 1024));
      let signature = Buffer.alloc(0);
      let offset = 0;
      while (offset < before.size) {
        const length = Math.min(chunk.length, before.size - offset);
        const result = await handle.read(chunk, 0, length, offset);
        if (result.bytesRead < 1) throw new DesignStorageError("conflict", "Uploaded reference ended while it was being ingested");
        const bytes = chunk.subarray(0, result.bytesRead);
        if (offset === 0) signature = Buffer.from(bytes.subarray(0, 16));
        hash.update(bytes);
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || offset !== before.size) {
        throw new DesignStorageError("conflict", "Uploaded reference changed while it was being ingested");
      }
      return {
        kind: "uploaded-file",
        handle,
        bytes: before.size,
        checksum: hash.digest("hex"),
        signature,
        identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof DesignStorageError) throw error;
      throw new DesignStorageError("invalid-input", "Uploaded reference is unavailable or unsafe", { cause: error });
    }
  }

  function designAssetIdentity(input: {
    checksum: string;
    mimeType: string;
    name: string;
    bundleFiles: DesignAssetBundleFile[];
    sourceVersion: DesignAssetManifest["sourceVersion"] | null;
  }): string {
    return JSON.stringify({
      checksum: input.checksum,
      mimeType: input.mimeType,
      name: input.name,
      bundleFiles: input.bundleFiles,
      sourceVersion: input.sourceVersion,
    });
  }

  function assertStoredAssetManifest(value: unknown, expectedId: string): asserts value is DesignAssetManifest {
    const manifest = storedRecord(value, `Design Asset ${expectedId} manifest`, [
      "schemaVersion", "id", "name", "mimeType", "checksum", "bytes", "fileName", "bundleFiles", "sourceVersion", "createdAt",
    ]);
    assertStoredBundleFiles(manifest.bundleFiles, `Design Asset ${expectedId} bundle`);
    if (manifest.schemaVersion !== DESIGN_SCHEMA_VERSION || manifest.id !== expectedId
      || !SAFE_SEGMENT.test(expectedId)
      || !validStoredText(manifest.name, 256)
      || !validStoredText(manifest.mimeType, 120)
      || !SHA256.test(String(manifest.checksum))
      || !Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) < 1
      || ((manifest.bytes as number) > MAX_DESIGN_ASSET_BYTES
        && !(typeof manifest.mimeType === "string" && manifest.mimeType.startsWith("video/")))
      || typeof manifest.fileName !== "string" || basename(manifest.fileName) !== manifest.fileName
      || !SAFE_SEGMENT.test(manifest.fileName)
      || !validStoredTimestamp(manifest.createdAt)) {
      throw new DesignStorageError("corrupt", `Design Asset ${expectedId} manifest is invalid`);
    }
    let sourceVersion: DesignAssetManifest["sourceVersion"] | null = null;
    if (manifest.sourceVersion !== undefined) {
      const source = storedRecord(manifest.sourceVersion, `Design Asset ${expectedId} sourceVersion`, [
        "projectId", "nodeId", "versionId", "checksum", "assetPins",
      ]);
      if (typeof source.projectId !== "string" || !SAFE_SEGMENT.test(source.projectId)
        || typeof source.nodeId !== "string" || !SAFE_SEGMENT.test(source.nodeId)
        || typeof source.versionId !== "string" || !SAFE_SEGMENT.test(source.versionId)
        || !SHA256.test(String(source.checksum))
        || !Array.isArray(source.assetPins) || source.assetPins.length > MAX_ASSET_BUNDLE_FILES) {
        throw new DesignStorageError("corrupt", `Design Asset ${expectedId} sourceVersion is invalid`);
      }
      const bundleByPath = new Map((manifest.bundleFiles as DesignAssetBundleFile[]).map((file) => [file.path, file]));
      const pinIds = new Set<string>();
      for (const [index, entry] of source.assetPins.entries()) {
        const pin = storedRecord(entry, `Design Asset ${expectedId} source pin ${index}`, [
          "assetId", "checksum", "bytes", "fileName", "bundlePath",
        ]);
        const bundlePath = safeBundlePath(pin.bundlePath, `Design Asset ${expectedId} source pin ${index} path`);
        const bundle = bundleByPath.get(bundlePath);
        if (typeof pin.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(pin.assetId)
          || pinIds.has(pin.assetId) || !SHA256.test(String(pin.checksum))
          || !Number.isSafeInteger(pin.bytes) || (pin.bytes as number) < 1
          || typeof pin.fileName !== "string" || basename(pin.fileName) !== pin.fileName
          || !SAFE_SEGMENT.test(pin.fileName)
          || !bundle || bundle.checksum !== pin.checksum || bundle.bytes !== pin.bytes) {
          throw new DesignStorageError("corrupt", `Design Asset ${expectedId} source pin ${index} is invalid`);
        }
        pinIds.add(pin.assetId);
      }
      sourceVersion = {
        projectId: source.projectId as string,
        nodeId: source.nodeId as string,
        versionId: source.versionId as string,
        checksum: source.checksum as string,
        assetPins: source.assetPins.map((entry) => {
          const pin = entry as NonNullable<DesignAssetManifest["sourceVersion"]>["assetPins"][number];
          return {
            assetId: pin.assetId,
            checksum: pin.checksum,
            bytes: pin.bytes,
            fileName: pin.fileName,
            bundlePath: pin.bundlePath,
          };
        }),
      };
    }
    const normalizedBundleFiles = (manifest.bundleFiles as DesignAssetBundleFile[]).map((file) => ({
      path: file.path,
      checksum: file.checksum,
      bytes: file.bytes,
    }));
    const identity = designAssetIdentity({
      checksum: manifest.checksum as string,
      mimeType: manifest.mimeType as string,
      name: manifest.name as string,
      bundleFiles: normalizedBundleFiles,
      sourceVersion,
    });
    const actualId = `asset-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
    if (actualId !== expectedId) {
      throw new DesignStorageError("corrupt", `Design Asset ${expectedId} does not match its content identity`);
    }
  }

  function sourceVersionReference(value: unknown): DesignSourceVersionReference {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["projectId", "nodeId", "versionId"].includes(key))) {
      throw new DesignStorageError("invalid-input", "sourceVersion is invalid");
    }
    const source = value as Record<string, unknown>;
    if (typeof source.projectId !== "string" || typeof source.nodeId !== "string"
      || typeof source.versionId !== "string") {
      throw new DesignStorageError("invalid-input", "sourceVersion is invalid");
    }
    return {
      projectId: safeSegment(source.projectId, "Source Project id"),
      nodeId: safeSegment(source.nodeId, "Source Node id"),
      versionId: safeSegment(source.versionId, "Source Version id"),
    };
  }

  function sourceVersionKey(reference: DesignSourceVersionReference): string {
    return `${reference.projectId}\0${reference.nodeId}\0${reference.versionId}`;
  }

  function assetSourceVersionReference(input: DesignAssetStoreInput | undefined): DesignSourceVersionReference | null {
    return input?.sourceVersion === undefined ? null : sourceVersionReference(input.sourceVersion);
  }

  async function snapshotDesignSourceVersion(
    dataDir: string,
    reference: DesignSourceVersionReference,
    byteLimit: number,
    hooks?: DesignAssetPayloadReadTestHooks,
  ): Promise<DesignSourceVersionSnapshot> {
    const sourceRoot = designRoot(dataDir, reference.projectId);
    return withProjectLock(sourceRoot, async () => {
      await requireInitialized(sourceRoot);
      await recoverPendingAssetImportsUnlocked(sourceRoot);
      const sourceManifest = await getDesignVersionUnlocked(
        sourceRoot,
        reference.nodeId,
        reference.versionId,
      );
      if (sourceManifest.contentKind !== "html" || sourceManifest.assetId !== null) {
        throw new DesignStorageError("not-found", "Material Design Versions cannot be copied as HTML Assets");
      }
      let projectedBytes = sourceManifest.bytes;
      if (projectedBytes > byteLimit) {
        throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
      }
      const sourcePath = join(
        versionRoot(sourceRoot, reference.nodeId, reference.versionId),
        "index.html",
      );
      let bytes = await readExactImmutablePayload({
        path: sourcePath,
        expectedBytes: sourceManifest.bytes,
        expectedChecksum: sourceManifest.checksum,
        label: `Source Design Version ${reference.versionId} HTML`,
        beforeOpen: () => hooks?.beforeSourceVersionPayloadOpen?.({
          kind: "version",
          path: sourcePath,
        }),
      });
      const sourcePins: NonNullable<DesignAssetManifest["sourceVersion"]>["assetPins"] = [];
      const seenBundlePaths = new Set<string>();
      const bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }> = [];
      for (const pin of sourceManifest.assetPins) {
        const pinnedManifest = await getDesignAssetManifestUnlocked(sourceRoot, pin.assetId);
        if (pinnedManifest.checksum !== pin.checksum) {
          throw new DesignStorageError("corrupt", "Source Design Version Asset pin changed while it was being copied");
        }
        projectedBytes += pinnedManifest.bytes;
        if (projectedBytes > byteLimit) {
          throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
        }
        const pinnedPath = join(assetRoot(sourceRoot, pin.assetId), pinnedManifest.fileName);
        const pinnedBytes = await readExactImmutablePayload({
          path: pinnedPath,
          expectedBytes: pinnedManifest.bytes,
          expectedChecksum: pinnedManifest.checksum,
          label: `Source Design Version Asset ${pin.assetId}`,
          beforeOpen: () => hooks?.beforeSourceVersionPayloadOpen?.({
            kind: "asset",
            path: pinnedPath,
          }),
        });
        const bundlePath = safeBundlePath(`bundle/assets/${pin.assetId}/${pinnedManifest.fileName}`);
        if (seenBundlePaths.has(bundlePath)) {
          throw new DesignStorageError("corrupt", "Source Design Version contains duplicate Asset pins");
        }
        seenBundlePaths.add(bundlePath);
        bundlePayloads.push({
          file: { path: bundlePath, checksum: pinnedManifest.checksum, bytes: pinnedManifest.bytes },
          bytes: pinnedBytes,
        });
        for (const nested of pinnedManifest.bundleFiles) {
          projectedBytes += nested.bytes;
          if (projectedBytes > byteLimit) {
            throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
          }
          const nestedPathOnDisk = join(assetRoot(sourceRoot, pin.assetId), ...nested.path.split("/"));
          const nestedBytes = await readExactImmutablePayload({
            path: nestedPathOnDisk,
            expectedBytes: nested.bytes,
            expectedChecksum: nested.checksum,
            label: `Source Design Version Asset ${pin.assetId} bundle payload ${nested.path}`,
            beforeOpen: () => hooks?.beforeSourceVersionPayloadOpen?.({
              kind: "bundle",
              path: nestedPathOnDisk,
            }),
          });
          const nestedPath = safeBundlePath(`bundle/assets/${pin.assetId}/${nested.path}`);
          if (seenBundlePaths.has(nestedPath)) {
            throw new DesignStorageError("corrupt", "Source Design Version contains duplicate bundled Asset paths");
          }
          seenBundlePaths.add(nestedPath);
          bundlePayloads.push({
            file: { path: nestedPath, checksum: nested.checksum, bytes: nested.bytes },
            bytes: nestedBytes,
          });
        }
        const canonical = `/api/projects/${reference.projectId}/design-canvas/assets/${pin.assetId}/${pinnedManifest.fileName}`
          + `?nodeId=${reference.nodeId}&versionId=${reference.versionId}&checksum=${pin.checksum}`;
        bytes = Buffer.from(bytes.toString("utf8")
          .replaceAll(canonical, bundlePath)
          .replaceAll(canonical.replaceAll("&", "&amp;"), bundlePath), "utf8");
        sourcePins.push({
          assetId: pin.assetId,
          checksum: pin.checksum,
          bytes: pinnedManifest.bytes,
          fileName: pinnedManifest.fileName,
          bundlePath,
        });
      }
      if (bytes.toString("utf8").includes(`/api/projects/${reference.projectId}/design-canvas/assets/`)) {
        throw new DesignStorageError("corrupt", "Source Design Version contains an unbound Asset reference");
      }
      const totalBytes = bytes.length
        + bundlePayloads.reduce((sum, payload) => sum + payload.file.bytes, 0);
      return {
        reference,
        bytes,
        bundlePayloads,
        sourceVersion: {
          projectId: reference.projectId,
          nodeId: reference.nodeId,
          versionId: reference.versionId,
          checksum: sourceManifest.checksum,
          assetPins: sourcePins,
        },
        totalBytes,
      };
    });
  }

  async function snapshotDesignSourceVersions(
    dataDir: string,
    inputs: readonly (DesignAssetStoreInput | undefined)[],
    byteLimit?: number,
    hooks?: DesignAssetPayloadReadTestHooks,
  ): Promise<Map<string, DesignSourceVersionSnapshot>> {
    const snapshots = new Map<string, DesignSourceVersionSnapshot>();
    const memoryByteLimit = byteLimit ?? MAX_DESIGN_ASSET_BATCH_BYTES;
    let snapshotBytes = 0;
    let totalBytes = 0;
    for (const input of inputs) {
      const reference = assetSourceVersionReference(input);
      if (reference === null) continue;
      const key = sourceVersionKey(reference);
      let snapshot = snapshots.get(key);
      if (snapshot === undefined) {
        const remainingBytes = memoryByteLimit - snapshotBytes;
        if (remainingBytes < 1) {
          throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
        }
        snapshot = await snapshotDesignSourceVersion(dataDir, reference, remainingBytes, hooks);
        snapshots.set(key, snapshot);
        snapshotBytes += snapshot.totalBytes;
      }
      totalBytes += snapshot.totalBytes;
      if (totalBytes > memoryByteLimit) {
        throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
      }
    }
    return snapshots;
  }

  async function prepareDesignAsset(
    dataDir: string,
    projectId: string,
    root: string,
    input: DesignAssetStoreInput,
    now?: number,
    sourceVersionSnapshots: ReadonlyMap<string, DesignSourceVersionSnapshot> = new Map(),
    hooks?: DesignAssetPayloadReadTestHooks,
  ): Promise<PreparedDesignAsset> {
    const name = displayAssetName(input?.name);
    const hasBase64 = typeof input?.base64 === "string";
    const hasUploaded = typeof input?.uploadedFileId === "string";
    const hasSourceVersion = input?.sourceVersion !== undefined;
    if (Number(hasBase64) + Number(hasUploaded) + Number(hasSourceVersion) !== 1) {
      throw new DesignStorageError("invalid-input", "Provide exactly one of base64, uploadedFileId, or sourceVersion");
    }
    let uploaded: UploadedDesignAssetPayload | null = null;
    try {
      let sourceVersion: DesignAssetManifest["sourceVersion"];
      let bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }> = [];
      let payload: PreparedDesignAssetPayload;
      let type: string;
      if (hasSourceVersion) {
        const reference = sourceVersionReference(input.sourceVersion);
        const snapshot = sourceVersionSnapshots.get(sourceVersionKey(reference));
        if (snapshot === undefined) {
          throw new DesignStorageError("conflict", "Source Design Version snapshot is unavailable");
        }
        payload = { kind: "bytes", bytes: snapshot.bytes };
        bundlePayloads = snapshot.bundlePayloads.map((entry) => ({
          file: { ...entry.file },
          bytes: entry.bytes,
        }));
        type = "text/html";
        if (input.mimeType !== undefined && mimeType(input.mimeType) !== type) {
          throw new DesignStorageError("invalid-input", "sourceVersion assets must use text/html");
        }
        sourceVersion = {
          ...snapshot.sourceVersion,
          assetPins: snapshot.sourceVersion.assetPins.map((pin) => ({ ...pin })),
        };
      } else {
        type = mimeType(input?.mimeType);
        if (hasBase64) {
          payload = { kind: "bytes", bytes: strictBase64(input.base64) };
        } else {
          uploaded = await inspectUploadedRef(
            dataDir,
            projectId,
            input.uploadedFileId,
            type.startsWith("video/") ? null : MAX_DESIGN_ASSET_BYTES,
            hooks,
          );
          payload = uploaded;
        }
      }
      bundlePayloads = bundlePayloads.sort((left, right) => left.file.path.localeCompare(right.file.path));
      const bundleFiles = bundlePayloads.map((entry) => entry.file);
      assertStoredBundleFiles(bundleFiles, "Design Asset bundle");
      const bytes = payload.kind === "bytes" ? payload.bytes.length : payload.bytes;
      if (bytes < 1 || (!type.startsWith("video/") && bytes > MAX_DESIGN_ASSET_BYTES)) {
        throw new DesignStorageError("limit", "Design Asset payload exceeds its bounded size");
      }
      validateAssetSignature(payload.kind === "bytes" ? payload.bytes : payload.signature, type);
      const checksum = payload.kind === "bytes"
        ? createHash("sha256").update(payload.bytes).digest("hex")
        : payload.checksum;
      const identity = designAssetIdentity({
        checksum,
        mimeType: type,
        name,
        bundleFiles,
        sourceVersion: sourceVersion ?? null,
      });
      const id = `asset-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
      const target = assetRoot(root, id);
      const manifestPath = join(target, "manifest.json");
      if (await exists(manifestPath)) {
        const existing = await readJson<DesignAssetManifest>(manifestPath, `Design Asset ${id}`);
        assertStoredAssetManifest(existing, id);
        if (existing.checksum === checksum && existing.bytes === bytes && existing.mimeType !== type) {
          throw new DesignStorageError(
            "conflict",
            `The same Asset bytes are already stored with mimeType ${existing.mimeType}`,
          );
        }
        if (existing.checksum !== checksum || existing.bytes !== bytes) {
          throw new DesignStorageError("corrupt", `Design Asset ${id} does not match its content identity`);
        }
        await uploaded?.handle.close().catch(() => {});
        uploaded = null;
        return { manifest: existing, target, existing: true };
      }
      const timestamp = nowValue(now);
      const fileName = sourceVersion ? "original.html" : `original${extensionFor(name, type)}`;
      const manifest: DesignAssetManifest = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        id,
        name,
        mimeType: type,
        checksum,
        bytes,
        fileName,
        bundleFiles,
        ...(sourceVersion ? { sourceVersion } : {}),
        createdAt: timestamp,
      };
      uploaded = null;
      return { manifest, target, existing: false, payload, bundlePayloads };
    } catch (error) {
      await uploaded?.handle.close().catch(() => {});
      throw error;
    }
  }

  async function writePreparedPayload(
    path: string,
    payload: PreparedDesignAssetPayload,
    atomic: boolean,
  ): Promise<void> {
    if (payload.kind === "bytes") {
      if (atomic) await writeAtomic(path, payload.bytes);
      else await writeFile(path, payload.bytes, { flag: "wx", mode: 0o600 });
      return;
    }
    let target: FileHandle | undefined;
    try {
      target = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(Math.min(payload.bytes, 1024 * 1024));
      let offset = 0;
      while (offset < payload.bytes) {
        const length = Math.min(chunk.length, payload.bytes - offset);
        const read = await payload.handle.read(chunk, 0, length, offset);
        if (read.bytesRead < 1) throw new DesignStorageError("conflict", "Uploaded reference ended while it was being copied");
        const bytes = chunk.subarray(0, read.bytesRead);
        hash.update(bytes);
        let written = 0;
        while (written < bytes.length) {
          const result = await target.write(bytes, written, bytes.length - written, offset + written);
          if (result.bytesWritten < 1) throw new DesignStorageError("corrupt", "Uploaded Asset staging stopped before completion");
          written += result.bytesWritten;
        }
        offset += read.bytesRead;
      }
      const after = await payload.handle.stat();
      const identity = payload.identity;
      if (after.dev !== identity.dev || after.ino !== identity.ino || after.size !== identity.size
        || after.mtimeMs !== identity.mtimeMs || offset !== payload.bytes
        || hash.digest("hex") !== payload.checksum) {
        throw new DesignStorageError("conflict", "Uploaded reference changed while it was being copied");
      }
      await target.sync();
    } finally {
      await target?.close().catch(() => {});
      await payload.handle.close().catch(() => {});
    }
  }

  async function discardPreparedDesignAsset(prepared: PreparedDesignAsset): Promise<void> {
    if (!prepared.existing && prepared.payload.kind === "uploaded-file") {
      await prepared.payload.handle.close().catch(() => {});
    }
  }

  async function persistPreparedDesignAsset(root: string, prepared: PreparedDesignAsset): Promise<boolean> {
      if (prepared.existing) return false;
      const { manifest, target, payload, bundlePayloads } = prepared;
      const { id, fileName, checksum, mimeType: type } = manifest;
      const manifestPath = join(target, "manifest.json");
      const pendingParent = join(root, "assets", ".pending");
      const pending = join(pendingParent, `${id}.${randomUUID()}`);
      await mkdir(pending, { recursive: true });
      try {
        await writePreparedPayload(join(pending, fileName), payload, false);
        for (const payload of bundlePayloads) {
          const path = join(pending, ...payload.file.path.split("/"));
          await mkdir(resolve(path, ".."), { recursive: true });
          await writeFile(path, payload.bytes, { flag: "wx", mode: 0o600 });
        }
        await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(pending, target);
      } catch (error) {
        await rm(pending, { recursive: true, force: true }).catch(() => {});
        if (await exists(manifestPath)) {
          const existing = await readJson<DesignAssetManifest>(manifestPath, `Design Asset ${id}`);
          assertStoredAssetManifest(existing, id);
          if (existing.checksum === checksum && existing.bytes === manifest.bytes && existing.mimeType === type) return false;
          if (existing.checksum === checksum && existing.mimeType !== type) {
            throw new DesignStorageError("conflict", `The same Asset bytes are already stored with mimeType ${existing.mimeType}`);
          }
        }
        throw error;
      }
      return true;
  }

  async function stagePreparedDesignAsset(directory: string, prepared: PreparedDesignAsset): Promise<void> {
    if (prepared.existing) return;
    await ensureDurableDirectory(directory);
    try {
      await writePreparedPayload(join(directory, prepared.manifest.fileName), prepared.payload, true);
      for (const payload of prepared.bundlePayloads) {
        const path = join(directory, ...payload.file.path.split("/"));
        await writeAtomic(path, payload.bytes);
      }
      await writeAtomic(
        join(directory, "manifest.json"),
        `${JSON.stringify(prepared.manifest, null, 2)}\n`,
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    readExactFileHandle,
    readExactImmutablePayload,
    checksumExactImmutablePayload,
    inspectUploadedRef,
    designAssetIdentity,
    assertStoredAssetManifest,
    sourceVersionReference,
    sourceVersionKey,
    assetSourceVersionReference,
    snapshotDesignSourceVersion,
    snapshotDesignSourceVersions,
    prepareDesignAsset,
    writePreparedPayload,
    discardPreparedDesignAsset,
    persistPreparedDesignAsset,
    stagePreparedDesignAsset,
  };
}

export type DesignAssetPreparation = ReturnType<typeof createDesignAssetPreparation>;
