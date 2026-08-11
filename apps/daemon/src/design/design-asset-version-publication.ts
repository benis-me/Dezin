import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_SCHEMA_VERSION,
  type DesignAssetBundleFile,
  type DesignAssetManifest,
  type DesignCanvas,
  type DesignCanvasIntent,
  type DesignJob,
  type DesignNode,
  type DesignNodeKind,
  type DesignVersionManifest,
  type DesignVersionPublicationPhase,
  type DesignVersionPublicationTransaction,
} from "./design-types.ts";
import type { DesignCanvasState } from "./design-canvas-state.ts";
import { stableStringify } from "../canonical-json.ts";
import {
  buildPortableDesignHtmlFromAssetLoader,
  PortableDesignHtmlError,
  rewriteDesignHtmlUrlReferences,
} from "./design-portable-html.ts";
import { extractDesignPageTitle } from "./design-page-title.ts";
import {
  collectDesignJavaScriptUrlSinks,
  validateDesignHtml,
} from "./design-static-validation.ts";
import {
  DesignRevisionConflictError,
  DesignStorageError,
  MAX_ASSET_BUNDLE_FILES,
  MAX_DESIGN_ASSET_BATCH_BYTES,
  MAX_DESIGN_ASSET_BATCH_ITEMS,
  MAX_DESIGN_ASSET_BYTES,
  MAX_DESIGN_HTML_BYTES,
  MAX_HISTORY,
  SAFE_SEGMENT,
  SHA256,
  assertStoredBundleFiles,
  assetRoot,
  designRoot,
  ensureDurableDirectory,
  exists,
  jobFilePath,
  nodeRoot,
  nowValue,
  projectFilePath,
  publicationTransactionsRoot,
  readJson,
  safeBundlePath,
  safeSegment,
  storedRecord,
  syncDesignDirectory,
  validStoredNullableId,
  validStoredText,
  validStoredTimestamp,
  validStoredViewport,
  withProjectLock,
  writeAtomic,
  writeAtomicJson,
  writeAuthorityJson,
} from "./design-storage-primitives.ts";

export interface DesignAssetStoreInput {
  name: string;
  mimeType?: string;
  base64?: string;
  uploadedFileId?: string;
  sourceVersion?: { projectId: string; nodeId: string; versionId: string };
}

export interface DesignCanvasAssetImport {
  asset: DesignAssetStoreInput;
  binding:
    | {
        type: "create-node";
        node: Extract<DesignCanvasIntent, { type: "add-node" }>["node"];
      }
    | { type: "append-version"; nodeId: string };
}

export type DesignAssetImportPhase = "marker" | "assets" | "versions" | "canvas" | "receipt";

export interface DesignAssetPayloadReadTestHooks {
  /** Test-only: mutate an uploaded Project reference immediately before its no-follow open. */
  beforeUploadedPayloadOpen?: (path: string) => void | Promise<void>;
  /** Test-only: mutate an immutable source payload immediately before its no-follow open. */
  beforeSourceVersionPayloadOpen?: (input: {
    kind: "version" | "asset" | "bundle";
    path: string;
  }) => void | Promise<void>;
}

export interface DesignAssetImportTestHooks extends DesignAssetPayloadReadTestHooks {
  /** Test-only: leave the durable WAL exactly as a process exit would. */
  simulateProcessCrash?: boolean;
  /** Test-only: lower (never raise) the production batch budget. */
  assetBatchByteLimit?: number;
  /** Test-only proof point emitted only after each phase's file and directory fsyncs complete. */
  afterDurablePhase?: (phase: DesignAssetImportPhase) => void | Promise<void>;
  afterPhase?: (phase: DesignAssetImportPhase) => void | Promise<void>;
}

export interface EnsureDesignCanvasAssetBatchInput {
  idempotencyKey: string;
  requestHash: string;
  items: DesignCanvasAssetImport[];
}

export interface EnsuredDesignCanvasAssetBatch {
  canvas: DesignCanvas;
  reused: boolean;
}

export interface ImportedDesignMaterialVersion {
  canvas: DesignCanvas;
  node: DesignNode;
  version: DesignVersionManifest;
  asset: DesignAssetManifest;
}

export interface DesignVersionPublicationTestHooks {
  /** Test-only: model a process exit by leaving the durable marker for restart recovery. */
  simulateProcessCrash?: boolean;
  afterPhase?: (phase: DesignVersionPublicationPhase) => void | Promise<void>;
  afterPendingDirectory?: () => void | Promise<void>;
  afterPendingIndex?: () => void | Promise<void>;
}

export type ResolvedDesignVersionPreview =
  | { kind: "html"; path: string; manifest: DesignVersionManifest }
  | {
      kind: "asset";
      path: string;
      manifest: DesignVersionManifest;
      assetManifest: DesignAssetManifest;
    };

export interface PortableDesignVersionHtmlTestHooks {
  beforeVersionPayloadRead?: () => void | Promise<void>;
  beforeAssetPayloadRead?: (assetId: string) => void | Promise<void>;
  afterAssetPayloadRead?: (assetId: string) => void | Promise<void>;
}

export interface DesignAssetVersionPublicationSources {
  canvasState: Pick<
    DesignCanvasState,
    | "addNode"
    | "assertStoredProject"
    | "canvas"
    | "cloneNode"
    | "readNodes"
    | "readProject"
    | "requireInitialized"
    | "snapshot"
  >;
  readJob(root: string, jobId: string): Promise<DesignJob>;
}

export function createDesignAssetVersionPublication(
  sources: DesignAssetVersionPublicationSources,
) {
  const assertStoredProject: DesignCanvasState["assertStoredProject"] = sources.canvasState.assertStoredProject;
  const {
    addNode,
    canvas,
    cloneNode,
    readNodes,
    readProject,
    requireInitialized,
    snapshot,
  } = sources.canvasState;
  const readJob = sources.readJob;

  function displayAssetName(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
      || Buffer.byteLength(value, "utf8") > 240) {
      throw new DesignStorageError("invalid-input", "Asset name is invalid");
    }
    return value.trim();
  }

  function mimeType(value: unknown): string {
    if (typeof value !== "string" || value.length > 120
      || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(value)) {
      throw new DesignStorageError("invalid-input", "Asset mimeType is invalid");
    }
    return value.toLowerCase();
  }

  function extensionFor(name: string, type: string): string {
    const candidate = extname(basename(name)).toLowerCase();
    if (/^\.[a-z0-9]{1,12}$/.test(candidate)) return candidate;
    const known: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "audio/mpeg": ".mp3",
      "audio/wav": ".wav",
      "application/pdf": ".pdf",
      "text/plain": ".txt",
      "text/markdown": ".md",
    };
    return known[type] ?? ".bin";
  }

  function strictBase64(value: unknown): Buffer {
    if (typeof value !== "string" || value.length === 0
      || value.length > Math.ceil(MAX_DESIGN_ASSET_BYTES / 3) * 4 + 4
      || value.length % 4 !== 0) {
      throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
    }
    // Do not validate a multi-megabyte payload with a repeated-group RegExp.
    // V8's RegExp engine recursively backtracks that shape and overflows the
    // JavaScript stack for otherwise valid local images around 4 MiB or larger.
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const contentLength = value.length - padding;
    for (let index = 0; index < contentLength; index += 1) {
      const code = value.charCodeAt(index);
      const valid = (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || (code >= 48 && code <= 57)
        || code === 43
        || code === 47;
      if (!valid) throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
    }
    for (let index = contentLength; index < value.length; index += 1) {
      if (value.charCodeAt(index) !== 61) {
        throw new DesignStorageError("invalid-input", "Asset base64 is invalid");
      }
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 1 || bytes.length > MAX_DESIGN_ASSET_BYTES || bytes.toString("base64") !== value) {
      throw new DesignStorageError("invalid-input", "Asset base64 is invalid or exceeds the size limit");
    }
    return bytes;
  }

  function validateAssetSignature(bytes: Buffer, type: string): void {
    const matches = (() => {
      switch (type) {
        case "image/png":
          return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        case "image/jpeg":
          return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        case "image/gif":
          return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
        case "image/webp":
          return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
            && bytes.subarray(8, 12).toString("ascii") === "WEBP";
        case "application/pdf":
          return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
        default:
          return true;
      }
    })();
    if (!matches) throw new DesignStorageError("invalid-input", `Asset bytes do not match declared mimeType ${type}`);
  }

  function matchesMaterialNodeKind(kind: DesignNodeKind, type: string): boolean {
    if (kind === "file") return true;
    if (kind === "image") return type.startsWith("image/");
    if (kind === "video") return type.startsWith("video/");
    if (kind !== "document") return false;
    return type === "application/pdf" || type === "application/rtf" || type === "text/rtf"
      || type.startsWith("text/") || type.includes("document") || type.includes("presentation")
      || type.includes("sheet") || type.includes("wordprocessingml")
      || type.includes("presentationml") || type.includes("spreadsheetml");
  }

  function uploadedRefName(value: unknown): string {
    if (typeof value !== "string" || !value.startsWith(".refs/")) {
      throw new DesignStorageError("invalid-input", "uploadedFileId must be exactly .refs/<safe basename>");
    }
    const name = value.slice(".refs/".length);
    if (!name || name !== basename(name) || name.length > 80 || !/^[A-Za-z0-9._-]+$/.test(name)
      || value !== `.refs/${name}`) {
      throw new DesignStorageError("invalid-input", "uploadedFileId must be exactly .refs/<safe basename>");
    }
    return name;
  }

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

  async function readUploadedRef(
    dataDir: string,
    projectId: string,
    uploadedFileId: unknown,
    hooks?: DesignAssetPayloadReadTestHooks,
  ): Promise<Buffer> {
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
      if (!before.isFile() || before.size < 1 || before.size > MAX_DESIGN_ASSET_BYTES) {
        throw new DesignStorageError("invalid-input", "Uploaded reference is not a bounded regular file");
      }
      const bytes = await readExactFileHandle(handle, before.size, "Uploaded reference");
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
        throw new DesignStorageError("conflict", "Uploaded reference changed while it was being ingested");
      }
      return bytes;
    } catch (error) {
      if (error instanceof DesignStorageError) throw error;
      throw new DesignStorageError("invalid-input", "Uploaded reference is unavailable or unsafe", { cause: error });
    } finally {
      await handle?.close().catch(() => {});
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
      || (manifest.bytes as number) > MAX_DESIGN_ASSET_BYTES
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

  type PreparedDesignAsset =
    | { manifest: DesignAssetManifest; target: string; existing: true }
    | {
        manifest: DesignAssetManifest;
        target: string;
        existing: false;
        bytes: Buffer;
        bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }>;
      };

  interface DesignSourceVersionReference {
    projectId: string;
    nodeId: string;
    versionId: string;
  }

  interface DesignSourceVersionSnapshot {
    reference: DesignSourceVersionReference;
    bytes: Buffer;
    bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }>;
    sourceVersion: NonNullable<DesignAssetManifest["sourceVersion"]>;
    totalBytes: number;
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
      let sourceVersion: DesignAssetManifest["sourceVersion"];
      let bundlePayloads: Array<{ file: DesignAssetBundleFile; bytes: Buffer }> = [];
      let bytes: Buffer;
      let type: string;
      if (hasSourceVersion) {
        const reference = sourceVersionReference(input.sourceVersion);
        const snapshot = sourceVersionSnapshots.get(sourceVersionKey(reference));
        if (snapshot === undefined) {
          throw new DesignStorageError("conflict", "Source Design Version snapshot is unavailable");
        }
        bytes = snapshot.bytes;
        bundlePayloads = snapshot.bundlePayloads.map((payload) => ({
          file: { ...payload.file },
          bytes: payload.bytes,
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
        bytes = hasBase64
          ? strictBase64(input.base64)
          : await readUploadedRef(dataDir, projectId, input.uploadedFileId, hooks);
      }
      bundlePayloads = bundlePayloads.sort((left, right) => left.file.path.localeCompare(right.file.path));
      const bundleFiles = bundlePayloads.map((payload) => payload.file);
      assertStoredBundleFiles(bundleFiles, "Design Asset bundle");
      if (bytes.length < 1 || bytes.length > MAX_DESIGN_ASSET_BYTES) {
        throw new DesignStorageError("limit", "Design Asset payload exceeds its bounded size");
      }
      validateAssetSignature(bytes, type);
      const checksum = createHash("sha256").update(bytes).digest("hex");
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
        if (existing.checksum === checksum && existing.bytes === bytes.length && existing.mimeType !== type) {
          throw new DesignStorageError(
            "conflict",
            `The same Asset bytes are already stored with mimeType ${existing.mimeType}`,
          );
        }
        if (existing.checksum !== checksum || existing.bytes !== bytes.length) {
          throw new DesignStorageError("corrupt", `Design Asset ${id} does not match its content identity`);
        }
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
        bytes: bytes.length,
        fileName,
        bundleFiles,
        ...(sourceVersion ? { sourceVersion } : {}),
        createdAt: timestamp,
      };
      return { manifest, target, existing: false, bytes, bundlePayloads };
  }

  async function persistPreparedDesignAsset(root: string, prepared: PreparedDesignAsset): Promise<boolean> {
      if (prepared.existing) return false;
      const { manifest, target, bytes, bundlePayloads } = prepared;
      const { id, fileName, checksum, mimeType: type } = manifest;
      const manifestPath = join(target, "manifest.json");
      const pendingParent = join(root, "assets", ".pending");
      const pending = join(pendingParent, `${id}.${randomUUID()}`);
      await mkdir(pending, { recursive: true });
      try {
        await writeFile(join(pending, fileName), bytes, { flag: "wx", mode: 0o600 });
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
          if (existing.checksum === checksum && existing.bytes === bytes.length && existing.mimeType === type) return false;
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
      await writeAtomic(join(directory, prepared.manifest.fileName), prepared.bytes);
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

  interface DesignAssetImportTransactionBinding {
    createdNode: boolean;
    nodeId: string;
    assetId: string;
    previousHeadVersionId: string | null;
    previousSelectedVersionId: string | null;
    previousVersionCount: number;
    previousAssetId: string | null;
    selectedVersionIdAfter: string | null;
    manifest: DesignVersionManifest;
  }

  interface DesignAssetImportIdempotency {
    receiptId: string;
    requestHash: string;
    itemsHash: string;
  }

  interface DesignAssetImportTransaction {
    schemaVersion: typeof DESIGN_SCHEMA_VERSION;
    projectId: string;
    expectedRevision: number;
    nextRevision: number;
    createdAssetIds: string[];
    bindings: DesignAssetImportTransactionBinding[];
    /** Added by the idempotent batch authority; absent only in legacy in-flight WAL. */
    idempotency?: DesignAssetImportIdempotency | null;
    /** Exact compact committed result; absent only in legacy in-flight WAL. */
    canvasAfter?: DesignCanvas;
    checksum: string;
  }

  interface DesignAssetImportOutcome {
    canvas: DesignCanvas;
    bindings: Array<{
      node: DesignNode;
      version: DesignVersionManifest;
      asset: DesignAssetManifest;
    }>;
  }

  function assetImportTransactionsRoot(root: string): string {
    return join(root, "assets", ".transactions");
  }

  function assetImportReceiptsRoot(root: string): string {
    return join(root, "assets", ".import-receipts");
  }

  function assetImportReceiptId(idempotencyKey: string): string {
    return createHash("sha256")
      .update(`dezin-design-asset-import-receipt-v1\0${idempotencyKey}`)
      .digest("hex");
  }

  function assetImportReceiptPath(root: string, receiptId: string): string {
    if (!SHA256.test(receiptId)) {
      throw new DesignStorageError("corrupt", "Design Asset import receipt identity is invalid");
    }
    return join(assetImportReceiptsRoot(root), `${receiptId}.json`);
  }

  function assetImportTransactionChecksum(
    value: Omit<DesignAssetImportTransaction, "checksum">,
  ): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
  }

  function assertStoredAssetImportCanvas(
    value: unknown,
    expectedProjectId: string,
    expectedRevision: number,
  ): asserts value is DesignCanvas {
    const record = storedRecord(value, "Design Asset import result Canvas", [
      "schemaVersion", "projectId", "revision", "viewport", "nodeOrder", "nodes",
      "undoDepth", "redoDepth", "createdAt", "updatedAt",
    ]);
    if (record.schemaVersion !== DESIGN_SCHEMA_VERSION || record.projectId !== expectedProjectId
      || record.revision !== expectedRevision || !validStoredViewport(record.viewport)
      || !Array.isArray(record.nodeOrder) || !Array.isArray(record.nodes)
      || !Number.isSafeInteger(record.undoDepth) || (record.undoDepth as number) < 0
      || (record.undoDepth as number) > MAX_HISTORY
      || !Number.isSafeInteger(record.redoDepth) || (record.redoDepth as number) < 0
      || (record.redoDepth as number) > MAX_HISTORY
      || !validStoredTimestamp(record.createdAt) || !validStoredTimestamp(record.updatedAt)) {
      throw new DesignStorageError("corrupt", "Design Asset import result Canvas is invalid");
    }
    const syntheticProject = {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      projectId: expectedProjectId,
      revision: expectedRevision,
      viewport: record.viewport,
      nodeOrder: record.nodeOrder,
      nodes: record.nodes,
      retiredNodeIds: [],
      undo: [],
      redo: [],
      turnReceipts: {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    assertStoredProject(syntheticProject, expectedProjectId);
  }

  function assertAssetImportTransaction(
    value: unknown,
    expectedProjectId: string,
  ): asserts value is DesignAssetImportTransaction {
    const record = storedRecord(value, "Design Asset import transaction", [
      "schemaVersion", "projectId", "expectedRevision", "nextRevision", "createdAssetIds", "bindings",
      "idempotency", "canvasAfter", "checksum",
    ]);
    const transaction = record as unknown as DesignAssetImportTransaction;
    if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION
      || transaction.projectId !== expectedProjectId || !SAFE_SEGMENT.test(expectedProjectId)
      || !Number.isSafeInteger(transaction.expectedRevision) || (transaction.expectedRevision as number) < 0
      || !Number.isSafeInteger(transaction.nextRevision)
      || transaction.nextRevision !== (transaction.expectedRevision as number) + 1
      || !Array.isArray(transaction.createdAssetIds)
      || transaction.createdAssetIds.length > MAX_DESIGN_ASSET_BATCH_ITEMS
      || !Array.isArray(transaction.bindings)
      || transaction.bindings.length < 1
      || transaction.bindings.length > MAX_DESIGN_ASSET_BATCH_ITEMS
      || typeof transaction.checksum !== "string" || !SHA256.test(transaction.checksum)) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction is invalid");
    }
    const { checksum, ...content } = transaction;
    if (checksum !== assetImportTransactionChecksum(
      content as Omit<DesignAssetImportTransaction, "checksum">,
    )) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction checksum is invalid");
    }
    if ((transaction.idempotency === undefined) !== (transaction.canvasAfter === undefined)) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction result authority is incomplete");
    }
    if (transaction.idempotency !== undefined && transaction.idempotency !== null) {
      const idempotency = storedRecord(transaction.idempotency, "Design Asset import idempotency", [
        "receiptId", "requestHash", "itemsHash",
      ]);
      if (!SHA256.test(String(idempotency.receiptId))
        || !SHA256.test(String(idempotency.requestHash))
        || !SHA256.test(String(idempotency.itemsHash))) {
        throw new DesignStorageError("corrupt", "Design Asset import idempotency authority is invalid");
      }
    }
    if (transaction.canvasAfter !== undefined) {
      assertStoredAssetImportCanvas(transaction.canvasAfter, expectedProjectId, transaction.nextRevision);
    }
    const assetIds = new Set<string>();
    for (const assetId of transaction.createdAssetIds) {
      if (typeof assetId !== "string" || !SAFE_SEGMENT.test(assetId) || assetIds.has(assetId)) {
        throw new DesignStorageError("corrupt", "Design Asset import transaction Asset identity is invalid");
      }
      assetIds.add(assetId);
    }
    const nodeIds = new Set<string>();
    for (const value of transaction.bindings) {
      const binding = storedRecord(value, "Design Asset import transaction binding", [
        "createdNode", "nodeId", "assetId", "previousHeadVersionId", "previousSelectedVersionId",
        "previousVersionCount", "previousAssetId", "selectedVersionIdAfter", "manifest",
      ]);
      if (typeof binding.nodeId !== "string" || !SAFE_SEGMENT.test(binding.nodeId) || nodeIds.has(binding.nodeId)
        || typeof binding.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(binding.assetId)
        || typeof binding.createdNode !== "boolean"
        || !validStoredNullableId(binding.previousHeadVersionId)
        || !validStoredNullableId(binding.previousSelectedVersionId)
        || !Number.isSafeInteger(binding.previousVersionCount) || (binding.previousVersionCount as number) < 0
        || !validStoredNullableId(binding.previousAssetId)
        || !validStoredNullableId(binding.selectedVersionIdAfter)
        || !binding.manifest || typeof binding.manifest !== "object") {
        throw new DesignStorageError("corrupt", "Design Asset import transaction binding is invalid");
      }
      const manifest = binding.manifest as DesignVersionManifest;
      const versionId = (manifest as { id?: unknown }).id;
      if (typeof versionId !== "string") {
        throw new DesignStorageError("corrupt", "Design Asset import transaction Version is invalid");
      }
      assertStoredVersionManifest(manifest, binding.nodeId, versionId);
      if (manifest.contentKind !== "asset" || manifest.assetId !== binding.assetId
        || manifest.canvasRevision !== transaction.expectedRevision || manifest.publicationStatus !== "published"
        || manifest.expectedHeadVersionId !== binding.previousHeadVersionId
        || manifest.sequence !== (binding.previousVersionCount as number) + 1
        || (binding.selectedVersionIdAfter !== manifest.id
          && binding.selectedVersionIdAfter !== binding.previousSelectedVersionId)
        || (binding.createdNode && (
          binding.previousHeadVersionId !== null || binding.previousSelectedVersionId !== null
          || binding.previousVersionCount !== 0 || binding.previousAssetId !== null
          || binding.selectedVersionIdAfter !== manifest.id
        ))) {
        throw new DesignStorageError("corrupt", "Design Asset import transaction Version authority is invalid");
      }
      nodeIds.add(binding.nodeId);
    }
    const validatedBindings = transaction.bindings as DesignAssetImportTransactionBinding[];
    if ([...assetIds].some((assetId) => !validatedBindings.some((binding) => binding.assetId === assetId))) {
      throw new DesignStorageError("corrupt", "Design Asset import transaction contains an unbound Asset");
    }
    if (transaction.canvasAfter !== undefined) {
      const resultNodes = new Map(transaction.canvasAfter.nodes.map((node) => [node.id, node]));
      if (!validatedBindings.every((binding) =>
        assetImportBindingIsCommitted(resultNodes.get(binding.nodeId), binding))) {
        throw new DesignStorageError("corrupt", "Design Asset import result Canvas is inconsistent");
      }
    }
  }

  async function verifyMaterialVersionManifestDirectory(
    directory: string,
    expected: DesignVersionManifest,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].name !== "manifest.json") {
      throw new DesignStorageError("corrupt", `Material Design Version ${expected.id} payload is invalid`);
    }
    const manifest = await readJson<DesignVersionManifest>(
      join(directory, "manifest.json"),
      `Material Design Version ${expected.id}`,
    );
    assertStoredVersionManifest(manifest, expected.nodeId, expected.id);
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
      throw new DesignStorageError("corrupt", `Material Design Version ${expected.id} diverges from its WAL`);
    }
  }

  async function verifyCommittedAssetImportPayloadsUnlocked(
    root: string,
    transaction: DesignAssetImportTransaction,
  ): Promise<void> {
    for (const binding of transaction.bindings) {
      const asset = await getDesignAssetManifestUnlocked(root, binding.assetId);
      if (asset.checksum !== binding.manifest.checksum || asset.bytes !== binding.manifest.bytes) {
        throw new DesignStorageError("corrupt", "Committed Design Asset import Asset diverges from its Version");
      }
      await verifyMaterialVersionManifestDirectory(
        versionRoot(root, binding.nodeId, binding.manifest.id),
        binding.manifest,
      );
    }
  }

  async function readDesignAssetImportReceiptUnlocked(
    root: string,
    projectId: string,
    receiptId: string,
  ): Promise<DesignAssetImportTransaction | null> {
    const path = assetImportReceiptPath(root, receiptId);
    if (!(await exists(path))) return null;
    const transaction = await readJson<DesignAssetImportTransaction>(path, "Design Asset import receipt");
    assertAssetImportTransaction(transaction, projectId);
    if (transaction.idempotency?.receiptId !== receiptId || transaction.canvasAfter === undefined) {
      throw new DesignStorageError("corrupt", "Design Asset import receipt authority is invalid");
    }
    await verifyCommittedAssetImportPayloadsUnlocked(root, transaction);
    return transaction;
  }

  async function finalizeAssetImportTransactionUnlocked(
    root: string,
    transactionRoot: string,
    transaction: DesignAssetImportTransaction,
  ): Promise<void> {
    const transactionsRoot = resolve(transactionRoot, "..");
    const removeTransaction = async (): Promise<void> => {
      await rm(transactionRoot, { recursive: true, force: true });
      await syncDesignDirectory(transactionsRoot);
    };
    if (transaction.idempotency === undefined || transaction.idempotency === null) {
      await removeTransaction();
      return;
    }
    if (transaction.canvasAfter === undefined) {
      throw new DesignStorageError("corrupt", "Idempotent Design Asset import is missing its exact result");
    }
    const receiptPath = assetImportReceiptPath(root, transaction.idempotency.receiptId);
    const receiptsRoot = assetImportReceiptsRoot(root);
    await ensureDurableDirectory(receiptsRoot);
    if (await exists(receiptPath)) {
      const prior = await readJson<DesignAssetImportTransaction>(receiptPath, "Design Asset import receipt");
      assertAssetImportTransaction(prior, transaction.projectId);
      if (prior.checksum !== transaction.checksum) {
        throw new DesignStorageError("corrupt", "Design Asset import receipt diverges from its committed WAL");
      }
      await removeTransaction();
      return;
    }
    await rename(join(transactionRoot, "transaction.json"), receiptPath);
    await syncDesignDirectory(transactionRoot);
    await syncDesignDirectory(receiptsRoot);
    await removeTransaction();
  }

  function assetImportBindingIsCommitted(
    node: DesignNode | undefined,
    binding: DesignAssetImportTransactionBinding,
  ): boolean {
    return node !== undefined
      && node.currentVersionId === binding.manifest.id
      && node.selectedVersionId === binding.selectedVersionIdAfter
      && node.versionCount === binding.previousVersionCount + 1
      && node.assetId === binding.assetId;
  }

  function assetImportBindingIsBefore(
    node: DesignNode | undefined,
    binding: DesignAssetImportTransactionBinding,
  ): boolean {
    if (binding.createdNode) return node === undefined;
    return node !== undefined
      && node.currentVersionId === binding.previousHeadVersionId
      && node.selectedVersionId === binding.previousSelectedVersionId
      && node.versionCount === binding.previousVersionCount
      && node.assetId === binding.previousAssetId;
  }

  async function recoverPendingAssetImportsUnlocked(root: string): Promise<void> {
    const transactionsRoot = assetImportTransactionsRoot(root);
    if (!(await exists(transactionsRoot))) return;
    const entries = (await readdir(transactionsRoot, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) return;
    for (const entry of entries) {
      const transactionRoot = join(transactionsRoot, entry.name);
      if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) {
        throw new DesignStorageError("corrupt", "Design Asset import staging contains an invalid entry");
      }
      const transactionPath = join(transactionRoot, "transaction.json");
      if (!(await exists(transactionPath))) {
        await rm(transactionRoot, { recursive: true, force: true });
        await syncDesignDirectory(transactionsRoot);
        continue;
      }
      const transaction = await readJson<DesignAssetImportTransaction>(transactionPath, "Design Asset import transaction");
      const projectId = basename(resolve(root, ".."));
      assertAssetImportTransaction(transaction, projectId);
      const project = await readProject(root);
      const nodes = readNodes(project);
      const committed = transaction.bindings.every((binding) =>
        assetImportBindingIsCommitted(nodes.get(binding.nodeId), binding));
      if (project.revision === transaction.nextRevision) {
        if (!committed) {
          throw new DesignStorageError("corrupt", "Committed Design Asset import has inconsistent Canvas authority");
        }
        await verifyCommittedAssetImportPayloadsUnlocked(root, transaction);
        await finalizeAssetImportTransactionUnlocked(root, transactionRoot, transaction);
        continue;
      } else if (project.revision === transaction.expectedRevision) {
        if (!transaction.bindings.every((binding) =>
          assetImportBindingIsBefore(nodes.get(binding.nodeId), binding))) {
          throw new DesignStorageError("corrupt", "Interrupted Design Asset import lost its prior Canvas authority");
        }
        for (const binding of transaction.bindings) {
          const target = versionRoot(root, binding.nodeId, binding.manifest.id);
          if (await exists(target)) {
            await verifyMaterialVersionManifestDirectory(target, binding.manifest);
            await rm(target, { recursive: true, force: true });
            await syncDesignDirectory(resolve(target, ".."));
          }
        }
        const referencedAssetIds = new Set(project.nodes.flatMap((node) => node.assetId ? [node.assetId] : []));
        for (const assetId of transaction.createdAssetIds) {
          if (referencedAssetIds.has(assetId)) {
            throw new DesignStorageError("corrupt", "Interrupted Design Asset import Asset became unexpectedly referenced");
          }
          const target = assetRoot(root, assetId);
          if (await exists(target)) {
            const asset = await getDesignAssetManifestUnlocked(root, assetId);
            const expected = transaction.bindings.find((binding) => binding.assetId === assetId)!.manifest;
            if (asset.checksum !== expected.checksum || asset.bytes !== expected.bytes) {
              throw new DesignStorageError("corrupt", "Interrupted Design Asset import Asset diverges from its WAL");
            }
            await rm(target, { recursive: true, force: true });
            await syncDesignDirectory(join(root, "assets"));
          }
        }
      } else {
        throw new DesignStorageError("corrupt", "Design Asset import WAL revision authority is invalid");
      }
      await rm(transactionRoot, { recursive: true, force: true });
      await syncDesignDirectory(transactionsRoot);
    }
  }

  async function storeDesignAsset(
    dataDir: string,
    projectId: string,
    input: DesignAssetStoreInput,
    now?: number,
    hooks?: DesignAssetPayloadReadTestHooks,
  ): Promise<DesignAssetManifest> {
    const root = designRoot(dataDir, projectId);
    const sourceVersionSnapshots = await snapshotDesignSourceVersions(dataDir, [input], undefined, hooks);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      const prepared = await prepareDesignAsset(
        dataDir,
        projectId,
        root,
        input,
        now,
        sourceVersionSnapshots,
        hooks,
      );
      await persistPreparedDesignAsset(root, prepared);
      return prepared.manifest;
    });
  }

  function materialVersionManifest(
    projectId: string,
    node: DesignNode,
    asset: DesignAssetManifest,
    canvasRevision: number,
    timestamp: number,
  ): DesignVersionManifest {
    const id = `version-${randomUUID()}`;
    const expectedHeadVersionId = node.currentVersionId;
    return {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      id,
      nodeId: node.id,
      contentKind: "asset",
      assetId: asset.id,
      sequence: node.versionCount + 1,
      checksum: asset.checksum,
      bytes: asset.bytes,
      contextHash: createHash("sha256").update(stableStringify({
        protocol: "dezin-material-version-v1",
        projectId,
        nodeId: node.id,
        assetId: asset.id,
        assetChecksum: asset.checksum,
        assetBytes: asset.bytes,
        canvasRevision,
        expectedHeadVersionId,
      })).digest("hex"),
      canvasRevision,
      expectedHeadVersionId,
      publicationStatus: "published",
      assetPins: [],
      jobId: null,
      runnerId: null,
      model: null,
      createdAt: timestamp,
    };
  }

  async function stageMaterialVersionManifest(
    directory: string,
    manifest: DesignVersionManifest,
  ): Promise<void> {
    await ensureDurableDirectory(directory);
    await writeAtomic(
      join(directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  function designAssetImportByteLimit(hooks?: DesignAssetImportTestHooks): number {
    const assetBatchByteLimit = hooks?.assetBatchByteLimit ?? MAX_DESIGN_ASSET_BATCH_BYTES;
    if (!Number.isSafeInteger(assetBatchByteLimit) || assetBatchByteLimit < 1
      || assetBatchByteLimit > MAX_DESIGN_ASSET_BATCH_BYTES) {
      throw new DesignStorageError("invalid-input", "Asset import test byte limit is invalid");
    }
    return assetBatchByteLimit;
  }

  async function importDesignCanvasAssetBatchUnlocked(
    dataDir: string,
    projectId: string,
    root: string,
    input: {
      expectedRevision: number;
      items: DesignCanvasAssetImport[];
      idempotency?: DesignAssetImportIdempotency;
    },
    now?: number,
    hooks?: DesignAssetImportTestHooks,
    sourceVersionSnapshots: ReadonlyMap<string, DesignSourceVersionSnapshot> = new Map(),
  ): Promise<DesignAssetImportOutcome> {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      const project = await readProject(root);
      if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
        throw new DesignStorageError("invalid-input", "expectedRevision is invalid");
      }
      if (input.expectedRevision !== project.revision) {
        throw new DesignRevisionConflictError(input.expectedRevision, project.revision);
      }
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_DESIGN_ASSET_BATCH_ITEMS) {
        throw new DesignStorageError(
          "invalid-input",
          `Asset import must contain 1 to ${MAX_DESIGN_ASSET_BATCH_ITEMS} items`,
        );
      }

      const timestamp = nowValue(now);
      const assetBatchByteLimit = designAssetImportByteLimit(hooks);
      const nodes = readNodes(project);
      const before = snapshot(project, nodes);
      const createdAssetIds = new Set<string>();
      const bindings: DesignAssetImportTransactionBinding[] = [];
      const imported: DesignAssetImportOutcome["bindings"] = [];
      const touchedNodeIds = new Set<string>();
      const transactionId = `import-${randomUUID()}`;
      const transactionRoot = join(assetImportTransactionsRoot(root), transactionId);
      let totalBytes = 0;
      let transaction: DesignAssetImportTransaction | null = null;
      let markerWritten = false;
      try {
        for (const item of input.items) {
          if (!item || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).some((key) => !["asset", "binding"].includes(key))) {
            throw new DesignStorageError("invalid-input", "Asset import item is invalid");
          }
          const prepared = await prepareDesignAsset(
            dataDir,
            projectId,
            root,
            item.asset,
            timestamp,
            sourceVersionSnapshots,
            hooks,
          );
          const preparedBytes = prepared.manifest.bytes
            + prepared.manifest.bundleFiles.reduce((sum, file) => sum + file.bytes, 0);
          totalBytes += preparedBytes;
          if (totalBytes > assetBatchByteLimit) {
            throw new DesignStorageError("limit", "Asset import batch exceeds its bounded size");
          }
          if (!prepared.existing && !createdAssetIds.has(prepared.manifest.id)) {
            await stagePreparedDesignAsset(
              join(transactionRoot, "assets", prepared.manifest.id),
              prepared,
            );
            createdAssetIds.add(prepared.manifest.id);
          }
          const binding = item.binding;
          if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
            throw new DesignStorageError("invalid-input", "Asset import binding is invalid");
          }
          let importedNode: DesignNode;
          let createdNode = false;
          if (binding.type === "create-node") {
            if (Object.keys(binding).some((key) => !["type", "node"].includes(key))) {
              throw new DesignStorageError("invalid-input", "Asset create-Node binding is invalid");
            }
            importedNode = await addNode(project, nodes, {
              type: "add-node",
              node: binding.node,
            }, timestamp);
            createdNode = true;
          } else if (binding.type === "append-version") {
            if (Object.keys(binding).some((key) => !["type", "nodeId"].includes(key))) {
              throw new DesignStorageError("invalid-input", "Asset append-Version binding is invalid");
            }
            const nodeId = safeSegment(binding.nodeId, "Node id");
            const existingNode = nodes.get(nodeId);
            if (!existingNode) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
            importedNode = existingNode;
          } else {
            throw new DesignStorageError("invalid-input", "Asset import binding is unsupported");
          }
          if (touchedNodeIds.has(importedNode.id)) {
            throw new DesignStorageError("invalid-input", "Asset import batch may bind each material Node only once");
          }
          touchedNodeIds.add(importedNode.id);
          if ((DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(importedNode.kind)) {
            throw new DesignStorageError("invalid-input", "Only material Nodes may publish Asset Versions");
          }
          if (importedNode.activeJobId !== null) {
            throw new DesignStorageError("conflict", "Cancel the active scoped Agent Job before importing a material Version");
          }
          if (!matchesMaterialNodeKind(importedNode.kind, prepared.manifest.mimeType)) {
            throw new DesignStorageError(
              "invalid-input",
              `Asset ${prepared.manifest.id} mimeType does not match Node kind ${importedNode.kind}`,
            );
          }
          const previousHeadVersionId = importedNode.currentVersionId;
          const previousSelectedVersionId = importedNode.selectedVersionId;
          const previousVersionCount = importedNode.versionCount;
          const previousAssetId = importedNode.assetId;
          const followsHead = previousSelectedVersionId === null || previousSelectedVersionId === previousHeadVersionId;
          const manifest = materialVersionManifest(projectId, importedNode, prepared.manifest, project.revision, timestamp);
          const selectedVersionIdAfter = followsHead ? manifest.id : previousSelectedVersionId;
          await stageMaterialVersionManifest(
            join(transactionRoot, "versions", importedNode.id, manifest.id),
            manifest,
          );
          importedNode.currentVersionId = manifest.id;
          importedNode.selectedVersionId = selectedVersionIdAfter;
          importedNode.versionCount = previousVersionCount + 1;
          importedNode.assetId = prepared.manifest.id;
          importedNode.state = "ready";
          importedNode.error = null;
          importedNode.updatedAt = timestamp;
          bindings.push({
            createdNode,
            nodeId: importedNode.id,
            assetId: prepared.manifest.id,
            previousHeadVersionId,
            previousSelectedVersionId,
            previousVersionCount,
            previousAssetId,
            selectedVersionIdAfter,
            manifest,
          });
          imported.push({ node: importedNode, version: manifest, asset: prepared.manifest });
        }

        project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
        project.undo = [...project.undo, before].slice(-MAX_HISTORY);
        project.redo = [];
        project.revision += 1;
        project.updatedAt = Math.max(project.updatedAt, timestamp);
        const transactionContent: Omit<DesignAssetImportTransaction, "checksum"> = {
          schemaVersion: DESIGN_SCHEMA_VERSION,
          projectId,
          expectedRevision: input.expectedRevision,
          nextRevision: project.revision,
          createdAssetIds: [...createdAssetIds].sort(),
          bindings,
          idempotency: input.idempotency ?? null,
          canvasAfter: canvas(project, nodes),
        };
        transaction = {
          ...transactionContent,
          checksum: assetImportTransactionChecksum(transactionContent),
        };
        await writeAtomicJson(join(transactionRoot, "transaction.json"), transaction);
        markerWritten = true;
        await hooks?.afterDurablePhase?.("marker");
        await hooks?.afterPhase?.("marker");
        for (const assetId of createdAssetIds) {
          await rename(join(transactionRoot, "assets", assetId), assetRoot(root, assetId));
        }
        if (createdAssetIds.size > 0) {
          await syncDesignDirectory(join(transactionRoot, "assets"));
          await syncDesignDirectory(join(root, "assets"));
        }
        await hooks?.afterDurablePhase?.("assets");
        await hooks?.afterPhase?.("assets");
        for (const binding of bindings) {
          const targetParent = join(nodeRoot(root, binding.nodeId), "versions");
          const sourceParent = join(transactionRoot, "versions", binding.nodeId);
          await ensureDurableDirectory(targetParent);
          await rename(
            join(sourceParent, binding.manifest.id),
            versionRoot(root, binding.nodeId, binding.manifest.id),
          );
          await syncDesignDirectory(sourceParent);
          await syncDesignDirectory(targetParent);
        }
        await hooks?.afterDurablePhase?.("versions");
        await hooks?.afterPhase?.("versions");
        await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
        await hooks?.afterDurablePhase?.("canvas");
        await hooks?.afterPhase?.("canvas");
        await finalizeAssetImportTransactionUnlocked(root, transactionRoot, transaction);
        await hooks?.afterDurablePhase?.("receipt");
        await hooks?.afterPhase?.("receipt");
        const committedCanvas = canvas(project, nodes);
        return {
          canvas: committedCanvas,
          bindings: imported.map((entry) => ({ ...entry, node: cloneNode(nodes.get(entry.node.id)!) })),
        };
      } catch (error) {
        if (!markerWritten) {
          await rm(transactionRoot, { recursive: true, force: true });
          throw error;
        }
        if (hooks?.simulateProcessCrash) throw error;
        await recoverPendingAssetImportsUnlocked(root);
        const recoveredProject = await readProject(root);
        const recoveredNodes = readNodes(recoveredProject);
        if (transaction !== null && recoveredProject.revision === transaction.nextRevision
          && transaction.bindings.every((binding) =>
            assetImportBindingIsCommitted(recoveredNodes.get(binding.nodeId), binding))) {
          return {
            canvas: canvas(recoveredProject, recoveredNodes),
            bindings: imported.map((entry) => ({
              ...entry,
              node: cloneNode(recoveredNodes.get(entry.node.id)!),
            })),
          };
        }
        throw error;
      }
  }

  /**
   * Atomically ingest immutable Asset payloads and publish each material binding
   * as an immutable Node Version in one Canvas revision. The durable WAL owns the
   * Asset directories, Version manifests, and Canvas head transition together.
   */
  async function importDesignCanvasAssetBatch(
    dataDir: string,
    projectId: string,
    input: { expectedRevision: number; items: DesignCanvasAssetImport[] },
    now?: number,
    hooks?: DesignAssetImportTestHooks,
  ): Promise<DesignCanvas> {
    const root = designRoot(dataDir, projectId);
    const assetBatchByteLimit = designAssetImportByteLimit(hooks);
    const sourceVersionSnapshots = await snapshotDesignSourceVersions(
      dataDir,
      Array.isArray(input?.items) ? input.items.map((item) => item?.asset) : [],
      assetBatchByteLimit,
      hooks,
    );
    return withProjectLock(root, async () => (
      await importDesignCanvasAssetBatchUnlocked(
        dataDir,
        projectId,
        root,
        input,
        now,
        hooks,
        sourceVersionSnapshots,
      )
    ).canvas);
  }

  async function ensureDesignCanvasAssetBatch(
    dataDir: string,
    projectId: string,
    input: EnsureDesignCanvasAssetBatchInput,
    now?: number,
    hooks?: DesignAssetImportTestHooks,
  ): Promise<EnsuredDesignCanvasAssetBatch> {
    const root = designRoot(dataDir, projectId);
    if (typeof input?.idempotencyKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.idempotencyKey)
      || typeof input.requestHash !== "string" || !SHA256.test(input.requestHash)
      || !Array.isArray(input.items)) {
      throw new DesignStorageError("invalid-input", "Idempotent Asset import authority is invalid");
    }
    const receiptId = assetImportReceiptId(input.idempotencyKey);
    const itemsHash = createHash("sha256").update(stableStringify(input.items)).digest("hex");
    const replayReceiptUnlocked = async (): Promise<EnsuredDesignCanvasAssetBatch | null> => {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      const prior = await readDesignAssetImportReceiptUnlocked(root, projectId, receiptId);
      if (prior === null) return null;
      if (prior.idempotency?.requestHash !== input.requestHash
        || prior.idempotency.itemsHash !== itemsHash) {
        throw new DesignStorageError(
          "conflict",
          "Asset import idempotencyKey is already bound to a different request",
        );
      }
      return { canvas: structuredClone(prior.canvasAfter!), reused: true };
    };

    const replay = await withProjectLock(root, replayReceiptUnlocked);
    if (replay !== null) return replay;

    const assetBatchByteLimit = designAssetImportByteLimit(hooks);
    let sourceVersionSnapshots: Map<string, DesignSourceVersionSnapshot>;
    try {
      sourceVersionSnapshots = await snapshotDesignSourceVersions(
        dataDir,
        input.items.map((item) => item?.asset),
        assetBatchByteLimit,
        hooks,
      );
    } catch (error) {
      const concurrentReplay = await withProjectLock(root, replayReceiptUnlocked);
      if (concurrentReplay !== null) return concurrentReplay;
      throw error;
    }

    return withProjectLock(root, async () => {
      const concurrentReplay = await replayReceiptUnlocked();
      if (concurrentReplay !== null) return concurrentReplay;
      if (await exists(assetImportReceiptsRoot(root))) {
        const entries = await readdir(assetImportReceiptsRoot(root), { withFileTypes: true });
        if (entries.some((entry) => !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))) {
          throw new DesignStorageError("corrupt", "Design Asset import receipt ledger contains an invalid entry");
        }
        if (entries.length >= 5_000) {
          throw new DesignStorageError("limit", "Design Asset import receipt limit reached");
        }
      }
      const project = await readProject(root);
      const outcome = await importDesignCanvasAssetBatchUnlocked(dataDir, projectId, root, {
        expectedRevision: project.revision,
        items: input.items,
        idempotency: { receiptId, requestHash: input.requestHash, itemsHash },
      }, now, hooks, sourceVersionSnapshots);
      return { canvas: outcome.canvas, reused: false };
    });
  }

  async function appendDesignMaterialVersion(
    dataDir: string,
    projectId: string,
    input: { expectedRevision: number; nodeId: string; asset: DesignAssetStoreInput },
    now?: number,
    hooks?: DesignAssetImportTestHooks,
  ): Promise<ImportedDesignMaterialVersion> {
    const root = designRoot(dataDir, projectId);
    const sourceVersionSnapshots = await snapshotDesignSourceVersions(
      dataDir,
      [input?.asset],
      designAssetImportByteLimit(hooks),
      hooks,
    );
    return withProjectLock(root, async () => {
      const outcome = await importDesignCanvasAssetBatchUnlocked(dataDir, projectId, root, {
        expectedRevision: input.expectedRevision,
        items: [{
          asset: input.asset,
          binding: { type: "append-version", nodeId: input.nodeId },
        }],
      }, now, hooks, sourceVersionSnapshots);
      const binding = outcome.bindings[0];
      if (!binding) throw new DesignStorageError("corrupt", "Material Version import produced no binding");
      return { canvas: outcome.canvas, ...binding };
    });
  }

  async function getDesignAssetManifestUnlocked(
    root: string,
    assetId: string,
  ): Promise<DesignAssetManifest> {
    const manifest = await readJson<DesignAssetManifest>(
      join(assetRoot(root, assetId), "manifest.json"),
      `Design Asset ${assetId}`,
    );
    assertStoredAssetManifest(manifest, assetId);
    return manifest;
  }

  async function getDesignAssetManifest(
    dataDir: string,
    projectId: string,
    assetId: string,
  ): Promise<DesignAssetManifest> {
    return getDesignAssetManifestUnlocked(designRoot(dataDir, projectId), assetId);
  }

  async function listDesignAssets(dataDir: string, projectId: string): Promise<DesignAssetManifest[]> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      await recoverPendingAssetImportsUnlocked(root);
      const entries = await readdir(join(root, "assets"), { withFileTypes: true });
      const ids = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
      return Promise.all(ids.map((id) => getDesignAssetManifest(dataDir, projectId, id)));
    });
  }

  async function resolveDesignAssetFile(
    dataDir: string,
    projectId: string,
    assetId: string,
    requestedFile: string,
  ): Promise<{ manifest: DesignAssetManifest; path: string }> {
    return resolveDesignAssetFileUnlocked(designRoot(dataDir, projectId), assetId, requestedFile);
  }

  async function resolveDesignAssetFileUnlocked(
    root: string,
    assetId: string,
    requestedFile: string,
  ): Promise<{ manifest: DesignAssetManifest; path: string }> {
    const manifest = await getDesignAssetManifestUnlocked(root, assetId);
    if (requestedFile !== manifest.fileName || basename(requestedFile) !== requestedFile) {
      throw new DesignStorageError("not-found", "Design Asset file was not found");
    }
    const path = join(assetRoot(root, assetId), manifest.fileName);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) {
      throw new DesignStorageError("corrupt", `Design Asset ${assetId} payload is invalid`);
    }
    const checksum = createHash("sha256").update(await readFile(path)).digest("hex");
    if (checksum !== manifest.checksum) {
      throw new DesignStorageError("corrupt", `Design Asset ${assetId} payload checksum is invalid`);
    }
    return { manifest, path };
  }

  async function resolveDesignAssetBundleFile(
    dataDir: string,
    projectId: string,
    assetId: string,
    requestedFile: string,
  ): Promise<{ manifest: DesignAssetManifest; file: DesignAssetBundleFile; path: string }> {
    return resolveDesignAssetBundleFileUnlocked(
      designRoot(dataDir, projectId),
      assetId,
      requestedFile,
    );
  }

  async function resolveDesignAssetBundleFileUnlocked(
    root: string,
    assetId: string,
    requestedFile: string,
  ): Promise<{ manifest: DesignAssetManifest; file: DesignAssetBundleFile; path: string }> {
    const manifest = await getDesignAssetManifestUnlocked(root, assetId);
    const normalized = safeBundlePath(requestedFile);
    const file = manifest.bundleFiles.find((candidate) => candidate.path === normalized);
    if (!file) throw new DesignStorageError("not-found", "Design Asset bundle file was not found");
    const path = join(assetRoot(root, assetId), ...normalized.split("/"));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) {
      throw new DesignStorageError("corrupt", `Design Asset ${assetId} bundle payload is invalid`);
    }
    const checksum = createHash("sha256").update(await readFile(path)).digest("hex");
    if (checksum !== file.checksum) {
      throw new DesignStorageError("corrupt", `Design Asset ${assetId} bundle payload checksum is invalid`);
    }
    return { manifest, file, path };
  }

  async function canonicalizeVersionAssets(input: {
    dataDir: string;
    projectId: string;
    nodeId: string;
    versionId: string;
    html: string;
    allowedCanonicalAssetUrls: ReadonlySet<string>;
  }): Promise<{ html: string; pins: Array<{ assetId: string; checksum: string }> }> {
    const projectPath = `/api/projects/${input.projectId}/design-canvas/assets/`;
    const exactAssetReference = /^dezin-asset:\/\/(asset-[a-f0-9]{32})$/i;
    const exactCanonicalReference = /^\/api\/projects\/([A-Za-z0-9._-]+)\/design-canvas\/assets\/(asset-[a-f0-9]{32})\/original\.[a-z0-9]{1,12}\?nodeId=([A-Za-z0-9._-]+)&versionId=(version-[A-Za-z0-9._-]+)&checksum=([a-f0-9]{64})$/i;
    const scriptAssetReference = /dezin-asset:\/\/(asset-[a-f0-9]{32})(?![A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-])/gi;
    const scriptCanonicalReference = /\/api\/projects\/[A-Za-z0-9._-]+\/design-canvas\/assets\/(asset-[a-f0-9]{32})\/original\.[a-z0-9]{1,12}\?nodeId=[A-Za-z0-9._-]+&versionId=version-[A-Za-z0-9._-]+&checksum=[a-f0-9]{64}(?![A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-])/gi;
    const ids = new Set<string>();

    const inspectReference = (rawUrl: string): string => {
      const url = rawUrl.trim();
      const asset = exactAssetReference.exec(url);
      if (asset) {
        ids.add(asset[1]!.toLowerCase());
        return rawUrl;
      }
      if (/^dezin-asset:/i.test(url)) {
        throw new PortableDesignHtmlError("corrupt", "Generated HTML contains an invalid Design Asset reference");
      }
      const canonical = exactCanonicalReference.exec(url);
      if (canonical) {
        if (canonical[1] !== input.projectId || canonical[3] !== input.nodeId
          || !input.allowedCanonicalAssetUrls.has(url)) {
          throw new PortableDesignHtmlError(
            "corrupt",
            "Generated HTML contains a canonical Asset URL not authorized by its expected Head Version",
          );
        }
        ids.add(canonical[2]!.toLowerCase());
        return rawUrl;
      }
      if (/^\/api\/projects\/[^/?#]+\/design-canvas\/assets\//i.test(url)) {
        throw new PortableDesignHtmlError(
          "corrupt",
          "Generated HTML contains a canonical Asset URL not authorized by its expected Head Version",
        );
      }
      return rawUrl;
    };
    const inspectScript = (
      script: string,
      sourceType: "script" | "module" | null,
    ): string => {
      for (const match of script.matchAll(scriptAssetReference)) ids.add(match[1]!.toLowerCase());
      for (const match of script.matchAll(scriptCanonicalReference)) inspectReference(match[0]);
      if (sourceType !== null) {
        for (const { url, sourceRange } of collectDesignJavaScriptUrlSinks(script, sourceType)) {
          const internal = exactAssetReference.test(url)
            || exactCanonicalReference.test(url)
            || /^dezin-asset:/i.test(url)
            || /^\/api\/projects\/[^/?#]+\/design-canvas\/assets\//i.test(url);
          if (!internal) continue;
          inspectReference(url);
          if (sourceRange === null) {
            throw new PortableDesignHtmlError(
              "corrupt",
              "Generated JavaScript Asset URL has no exact source token and cannot be canonicalized safely",
            );
          }
        }
      }
      return script;
    };

    try {
      rewriteDesignHtmlUrlReferences({
        html: input.html,
        rewriteUrl: inspectReference,
        rewriteScriptText: inspectScript,
      });
      const manifests = await Promise.all([...ids].sort().map((id) => getDesignAssetManifest(
        input.dataDir,
        input.projectId,
        id,
      )));
      const canonicalById = new Map(manifests.map((manifest) => [
        manifest.id,
        `${projectPath}${manifest.id}/${manifest.fileName}`
          + `?nodeId=${input.nodeId}&versionId=${input.versionId}&checksum=${manifest.checksum}`,
      ]));
      const rewriteReference = (rawUrl: string): string => {
        const url = rawUrl.trim();
        inspectReference(rawUrl);
        const asset = exactAssetReference.exec(url);
        const canonical = exactCanonicalReference.exec(url);
        const id = (asset?.[1] ?? canonical?.[2])?.toLowerCase();
        return id === undefined ? rawUrl : canonicalById.get(id)!;
      };
      const rewriteScript = (
        script: string,
        sourceType: "script" | "module" | null,
      ): string => {
        if (sourceType === null) return script;
        const edits = new Map<string, { start: number; end: number; replacement: string }>();
        for (const { url, sourceRange } of collectDesignJavaScriptUrlSinks(script, sourceType)) {
          const asset = exactAssetReference.exec(url);
          const canonical = exactCanonicalReference.exec(url);
          const id = (asset?.[1] ?? canonical?.[2])?.toLowerCase();
          if (id === undefined) continue;
          if (sourceRange === null) {
            throw new PortableDesignHtmlError(
              "corrupt",
              "Generated JavaScript Asset URL has no exact source token and cannot be canonicalized safely",
            );
          }
          const replacement = canonicalById.get(id);
          if (!replacement) {
            throw new PortableDesignHtmlError("corrupt", "Generated JavaScript Asset URL has no immutable pin");
          }
          const key = `${sourceRange.start}:${sourceRange.end}`;
          const existing = edits.get(key);
          if (existing && existing.replacement !== replacement) {
            throw new PortableDesignHtmlError("corrupt", "Generated JavaScript Asset URL source is ambiguous");
          }
          edits.set(key, { ...sourceRange, replacement });
        }
        let rewritten = script;
        for (const edit of [...edits.values()].sort((left, right) => right.start - left.start)) {
          rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
        }
        return rewritten;
      };
      const html = rewriteDesignHtmlUrlReferences({
        html: input.html,
        rewriteUrl: rewriteReference,
        rewriteScriptText: rewriteScript,
      });
      let residual = html;
      for (const canonical of canonicalById.values()) {
        residual = residual
          .replaceAll(canonical, "")
          .replaceAll(canonical.replaceAll("&", "&amp;"), "");
      }
      if (/dezin-asset:/i.test(residual)
        || /\/api\/projects\/[^/?#\s"'<>]+\/design-canvas\/assets\//i.test(residual)) {
        throw new PortableDesignHtmlError("corrupt", "Generated HTML contains an invalid Design Asset reference");
      }
      validateDesignHtml(html, { allowCanonicalAssets: true });
      return {
        html,
        pins: manifests.map((manifest) => ({ assetId: manifest.id, checksum: manifest.checksum })),
      };
    } catch (error) {
      if (error instanceof PortableDesignHtmlError) {
        throw new DesignStorageError("invalid-html", error.message, { cause: error });
      }
      throw error;
    }
  }

  function versionRoot(root: string, nodeId: string, versionId: string): string {
    return join(nodeRoot(root, nodeId), "versions", safeSegment(versionId, "Version id"));
  }

  function publicationTransactionPath(root: string, jobId: string): string {
    return join(publicationTransactionsRoot(root), `${safeSegment(jobId, "Job id")}.json`);
  }

  function pendingVersionRoot(root: string, nodeId: string, versionId: string): string {
    return join(nodeRoot(root, nodeId), ".pending", "versions", safeSegment(versionId, "Version id"));
  }

  function publicationTransactionChecksum(
    content: Omit<DesignVersionPublicationTransaction, "checksum">,
  ): string {
    return createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
  }

  function assertStoredPublicationTransaction(
    value: unknown,
    expectedProjectId: string,
    expectedJobId: string,
  ): asserts value is DesignVersionPublicationTransaction {
    const transaction = storedRecord(value, `Design publication ${expectedJobId}`, [
      "schemaVersion", "projectId", "jobId", "nodeId", "manifest", "terminalStatus",
      "projectRevisionBefore", "previousVersionCount", "nodeNameBefore", "nodeNameAfter", "currentVersionIdBefore",
      "selectedVersionIdBefore", "followsHead", "createdAt", "checksum",
    ]);
    const { checksum, ...content } = transaction;
    const actualChecksum = publicationTransactionChecksum(
      content as Omit<DesignVersionPublicationTransaction, "checksum">,
    );
    if (transaction.schemaVersion !== DESIGN_SCHEMA_VERSION || transaction.projectId !== expectedProjectId
      || transaction.jobId !== expectedJobId || typeof transaction.nodeId !== "string"
      || !SAFE_SEGMENT.test(transaction.nodeId) || !["ready", "superseded"].includes(String(transaction.terminalStatus))
      || !Number.isSafeInteger(transaction.projectRevisionBefore) || (transaction.projectRevisionBefore as number) < 0
      || !Number.isSafeInteger(transaction.previousVersionCount) || (transaction.previousVersionCount as number) < 0
      || ((transaction.nodeNameBefore === undefined || transaction.nodeNameAfter === undefined)
        ? transaction.nodeNameBefore !== undefined || transaction.nodeNameAfter !== undefined
        : !validStoredText(transaction.nodeNameBefore, 256) || !validStoredText(transaction.nodeNameAfter, 256))
      || !validStoredNullableId(transaction.currentVersionIdBefore)
      || !validStoredNullableId(transaction.selectedVersionIdBefore)
      || typeof transaction.followsHead !== "boolean" || !validStoredTimestamp(transaction.createdAt)
      || typeof checksum !== "string" || !SHA256.test(checksum) || checksum !== actualChecksum) {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} is invalid`);
    }
    const manifest = transaction.manifest;
    if (!manifest || typeof manifest !== "object") {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} manifest is invalid`);
    }
    const versionId = (manifest as { id?: unknown }).id;
    if (typeof versionId !== "string") {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} manifest is invalid`);
    }
    assertStoredVersionManifest(manifest, transaction.nodeId as string, versionId);
    if ((manifest as DesignVersionManifest).contentKind !== "html"
      || (manifest as DesignVersionManifest).assetId !== null
      || (manifest as DesignVersionManifest).jobId !== expectedJobId
      || ((manifest as DesignVersionManifest).publicationStatus === "published" ? "ready" : "superseded")
        !== transaction.terminalStatus) {
      throw new DesignStorageError("corrupt", `Design publication ${expectedJobId} authority is invalid`);
    }
  }

  async function readPublicationTransaction(
    root: string,
    projectId: string,
    jobId: string,
  ): Promise<DesignVersionPublicationTransaction> {
    const value = await readJson<DesignVersionPublicationTransaction>(
      publicationTransactionPath(root, jobId),
      `Design publication ${jobId}`,
    );
    assertStoredPublicationTransaction(value, projectId, jobId);
    return value;
  }

  async function verifyPublicationPayload(path: string, manifest: DesignVersionManifest): Promise<void> {
    const manifestValue = await readJson<DesignVersionManifest>(join(path, "manifest.json"), `Design Version ${manifest.id}`);
    assertStoredVersionManifest(manifestValue, manifest.nodeId, manifest.id);
    if (JSON.stringify(manifestValue) !== JSON.stringify(manifest)) {
      throw new DesignStorageError("corrupt", `Design Version ${manifest.id} diverges from its publication marker`);
    }
    const htmlPath = join(path, "index.html");
    const info = await lstat(htmlPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) {
      throw new DesignStorageError("corrupt", `Design Version ${manifest.id} publication payload is invalid`);
    }
    const checksum = createHash("sha256").update(await readFile(htmlPath)).digest("hex");
    if (checksum !== manifest.checksum) {
      throw new DesignStorageError("corrupt", `Design Version ${manifest.id} publication checksum is invalid`);
    }
  }

  function assertStoredVersionManifest(
    value: unknown,
    expectedNodeId: string,
    expectedVersionId: string,
  ): asserts value is DesignVersionManifest {
    const manifest = storedRecord(value, `Design Version ${expectedVersionId} manifest`, [
      "schemaVersion", "id", "nodeId", "contentKind", "assetId", "sequence", "checksum", "bytes", "contextHash", "canvasRevision",
      "expectedHeadVersionId", "publicationStatus", "assetPins", "jobId", "runnerId", "model", "createdAt",
    ]);
    if (manifest.schemaVersion !== DESIGN_SCHEMA_VERSION || manifest.id !== expectedVersionId
      || manifest.nodeId !== expectedNodeId || !SAFE_SEGMENT.test(expectedVersionId) || !SAFE_SEGMENT.test(expectedNodeId)
      || !Number.isSafeInteger(manifest.sequence) || (manifest.sequence as number) < 1
      || !SHA256.test(String(manifest.checksum))
      || !["html", "asset"].includes(String(manifest.contentKind))
      || !validStoredNullableId(manifest.assetId)
      || !Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) < 1
      || (manifest.bytes as number) > (manifest.contentKind === "asset" ? MAX_DESIGN_ASSET_BYTES : MAX_DESIGN_HTML_BYTES)
      || !SHA256.test(String(manifest.contextHash))
      || !Number.isSafeInteger(manifest.canvasRevision) || (manifest.canvasRevision as number) < 0
      || !validStoredNullableId(manifest.expectedHeadVersionId)
      || !["published", "superseded"].includes(String(manifest.publicationStatus))
      || !Array.isArray(manifest.assetPins) || manifest.assetPins.length > MAX_ASSET_BUNDLE_FILES
      || !validStoredNullableId(manifest.jobId)
      || !validStoredText(manifest.runnerId, 512, { nullable: true })
      || (typeof manifest.runnerId === "string" && manifest.runnerId.trim() !== manifest.runnerId)
      || !validStoredText(manifest.model, 512, { nullable: true })
      || (typeof manifest.model === "string" && manifest.model.trim() !== manifest.model)
      || (manifest.jobId !== null && manifest.runnerId === null)
      || (manifest.runnerId === null && manifest.model !== null)
      || !validStoredTimestamp(manifest.createdAt)) {
      throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} manifest is invalid`);
    }
    const pinIds = new Set<string>();
    for (const [index, entry] of manifest.assetPins.entries()) {
      const pin = storedRecord(entry, `Design Version ${expectedVersionId} Asset pin ${index}`, ["assetId", "checksum"]);
      if (typeof pin.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(pin.assetId)
        || pinIds.has(pin.assetId) || !SHA256.test(String(pin.checksum))) {
        throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} Asset pin ${index} is invalid`);
      }
      pinIds.add(pin.assetId);
    }
    if ((manifest.contentKind === "html" && manifest.assetId !== null)
      || (manifest.contentKind === "asset" && (
        typeof manifest.assetId !== "string" || !/^asset-[a-f0-9]{32}$/.test(manifest.assetId)
        || manifest.assetPins.length !== 0 || manifest.jobId !== null
        || manifest.runnerId !== null || manifest.model !== null
      ))) {
      throw new DesignStorageError("corrupt", `Design Version ${expectedVersionId} content binding is invalid`);
    }
  }

  function assertPublicationJobAuthority(
    job: DesignJob,
    transaction: DesignVersionPublicationTransaction,
  ): void {
    const manifest = transaction.manifest;
    if (job.id !== transaction.jobId || job.kind !== "node-generation" || job.nodeId !== transaction.nodeId
      || job.contextHash !== manifest.contextHash || job.canvasRevision !== manifest.canvasRevision
      || job.expectedHeadVersionId !== manifest.expectedHeadVersionId || job.runnerId !== manifest.runnerId
      || job.model !== manifest.model || (job.versionId !== null && job.versionId !== manifest.id)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Job authority is invalid`);
    }
  }

  function publicationNodeState(
    node: DesignNode,
    transaction: DesignVersionPublicationTransaction,
  ): "before" | "after" | null {
    // A WAL written before first-Page title adoption has no name fields. Its
    // checksum remains authoritative and recovery preserves the current name.
    const nodeNameBefore = transaction.nodeNameBefore ?? node.name;
    const nodeNameAfter = transaction.nodeNameAfter ?? nodeNameBefore;
    const before = node.name === nodeNameBefore
      && node.currentVersionId === transaction.currentVersionIdBefore
      && node.selectedVersionId === transaction.selectedVersionIdBefore
      && node.versionCount === transaction.previousVersionCount
      && node.activeJobId === transaction.jobId;
    if (before) return "before";
    const expectedCurrent = transaction.terminalStatus === "ready"
      ? transaction.manifest.id
      : transaction.currentVersionIdBefore;
    const expectedSelected = transaction.terminalStatus === "ready" && transaction.followsHead
      ? transaction.manifest.id
      : transaction.selectedVersionIdBefore;
    const after = node.name === nodeNameAfter
      && node.currentVersionId === expectedCurrent && node.selectedVersionId === expectedSelected
      && node.versionCount === transaction.previousVersionCount + 1 && node.activeJobId === null
      && node.state === transaction.terminalStatus;
    return after ? "after" : null;
  }

  async function rollForwardPublicationUnlocked(
    root: string,
    transaction: DesignVersionPublicationTransaction,
    hooks?: DesignVersionPublicationTestHooks,
  ): Promise<DesignJob> {
    const manifest = transaction.manifest;
    const nodeNameAfter = transaction.nodeNameAfter;
    const pending = pendingVersionRoot(root, transaction.nodeId, manifest.id);
    const target = versionRoot(root, transaction.nodeId, manifest.id);
    const [pendingExists, targetExists] = await Promise.all([exists(pending), exists(target)]);
    if (pendingExists === targetExists) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} payload state is invalid`);
    }
    if (pendingExists) {
      await verifyPublicationPayload(pending, manifest);
    } else {
      await verifyPublicationPayload(target, manifest);
    }

    const job = await readJob(root, transaction.jobId);
    assertPublicationJobAuthority(job, transaction);
    if (!(job.status === "validating" || job.status === transaction.terminalStatus)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Job state is invalid`);
    }

    const project = await readProject(root);
    if (![transaction.projectRevisionBefore, transaction.projectRevisionBefore + 1].includes(project.revision)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Canvas revision is invalid`);
    }
    const nodes = readNodes(project);
    const node = nodes.get(transaction.nodeId);
    if (!node) throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Node is unavailable`);
    const nodeState = publicationNodeState(node, transaction);
    if (nodeState === null || (nodeState === "before" && project.revision !== transaction.projectRevisionBefore)
      || (nodeState === "after" && project.revision !== transaction.projectRevisionBefore + 1)) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Canvas authority is invalid`);
    }
    if (pendingExists) {
      await mkdir(join(nodeRoot(root, transaction.nodeId), "versions"), { recursive: true });
      await rename(pending, target);
      await hooks?.afterPhase?.("target");
    }
    if (nodeState === "before") {
      if (nodeNameAfter !== undefined) node.name = nodeNameAfter;
      node.versionCount = transaction.previousVersionCount + 1;
      node.error = null;
      if (transaction.terminalStatus === "ready") {
        node.currentVersionId = manifest.id;
        if (transaction.followsHead) node.selectedVersionId = manifest.id;
        node.state = "ready";
      } else {
        node.state = "superseded";
      }
      node.activeJobId = null;
      node.updatedAt = transaction.createdAt;
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision = transaction.projectRevisionBefore + 1;
      project.updatedAt = Math.max(project.updatedAt, transaction.createdAt);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      await hooks?.afterPhase?.("canvas");
    }

    job.status = transaction.terminalStatus;
    job.versionId = manifest.id;
    job.cancelRequested = false;
    job.error = transaction.terminalStatus === "ready"
      ? null
      : "A newer Node head was published before this result completed";
    job.updatedAt = Math.max(job.updatedAt, transaction.createdAt);
    job.finishedAt = job.updatedAt;
    await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
    await hooks?.afterPhase?.("job");
    await rm(publicationTransactionPath(root, transaction.jobId));
    return job;
  }

  async function rollBackUnpublishedPublicationUnlocked(
    root: string,
    transaction: DesignVersionPublicationTransaction,
    timestamp: number,
    pending: string | null = null,
  ): Promise<DesignJob> {
    const job = await readJob(root, transaction.jobId);
    assertPublicationJobAuthority(job, transaction);
    if (!(job.status === "validating" || job.status === "cancelled")) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} rollback Job state is invalid`);
    }
    const project = await readProject(root);
    const nodes = readNodes(project);
    const node = nodes.get(transaction.nodeId);
    if (!node) throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} Node is unavailable`);
    const afterRevision = transaction.projectRevisionBefore + 1;
    const nodeNameBefore = transaction.nodeNameBefore ?? node.name;
    const before = project.revision === transaction.projectRevisionBefore && node.name === nodeNameBefore
      && node.currentVersionId === transaction.currentVersionIdBefore
      && node.selectedVersionId === transaction.selectedVersionIdBefore
      && node.versionCount === transaction.previousVersionCount && node.activeJobId === transaction.jobId;
    const after = project.revision === afterRevision && node.name === nodeNameBefore
      && node.currentVersionId === transaction.currentVersionIdBefore
      && node.selectedVersionId === transaction.selectedVersionIdBefore
      && node.versionCount === transaction.previousVersionCount && node.activeJobId === null && node.state === "cancelled";
    if (!before && !after) {
      throw new DesignStorageError("corrupt", `Design publication ${transaction.jobId} rollback authority is invalid`);
    }
    if (pending !== null) await rm(pending, { recursive: true, force: true });
    if (before) {
      node.state = "cancelled";
      node.activeJobId = null;
      node.error = null;
      node.updatedAt = timestamp;
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision = afterRevision;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
    }
    job.status = "cancelled";
    job.cancelRequested = true;
    job.error = "Interrupted before Design Version publication payload was durably staged";
    job.updatedAt = timestamp;
    job.finishedAt = timestamp;
    await writeAuthorityJson(root, jobFilePath(root, job.id), job, ["jobs"]);
    await rm(publicationTransactionPath(root, transaction.jobId));
    return job;
  }

  function recoverablePendingPayloadError(error: unknown): boolean {
    return (error instanceof DesignStorageError && (error.code === "missing" || error.code === "corrupt"))
      || (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT");
  }

  async function recoverPublicationTransactionUnlocked(
    root: string,
    transaction: DesignVersionPublicationTransaction,
    timestamp: number,
  ): Promise<DesignJob> {
    const pending = pendingVersionRoot(root, transaction.nodeId, transaction.manifest.id);
    const target = versionRoot(root, transaction.nodeId, transaction.manifest.id);
    const [pendingExists, targetExists] = await Promise.all([exists(pending), exists(target)]);
    if (targetExists) {
      // Once the target exists it is the candidate immutable Version. Any mismatch must remain
      // quarantined behind the durable marker instead of being silently discarded or published.
      return rollForwardPublicationUnlocked(root, transaction);
    }
    if (!pendingExists) return rollBackUnpublishedPublicationUnlocked(root, transaction, timestamp);
    try {
      await verifyPublicationPayload(pending, transaction.manifest);
    } catch (error) {
      if (!recoverablePendingPayloadError(error)) throw error;
      return rollBackUnpublishedPublicationUnlocked(root, transaction, timestamp, pending);
    }
    return rollForwardPublicationUnlocked(root, transaction);
  }

  async function recoverPublicationTransactionsUnlocked(
    root: string,
    projectId: string,
    timestamp: number,
  ): Promise<DesignJob[]> {
    const parent = publicationTransactionsRoot(root);
    if (!(await exists(parent))) return [];
    const entries = await readdir(parent, { withFileTypes: true });
    const recovered: DesignJob[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && /^\.job-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
        await rm(join(parent, entry.name));
        continue;
      }
      if (!entry.isFile() || !/^job-[0-9a-f-]{36}\.json$/.test(entry.name)) {
        throw new DesignStorageError("corrupt", "Design publication transaction identity is invalid");
      }
      const jobId = entry.name.slice(0, -5);
      const transaction = await readPublicationTransaction(root, projectId, jobId);
      recovered.push(await recoverPublicationTransactionUnlocked(root, transaction, timestamp));
    }
    return recovered;
  }

  /** Recover one durable Version publication without terminalizing unrelated interrupted Jobs. */
  async function recoverDesignVersionPublication(
    dataDir: string,
    projectId: string,
    jobId: string,
    now?: number,
  ): Promise<DesignJob | null> {
    const root = designRoot(dataDir, projectId);
    safeSegment(jobId, "Job id");
    return withProjectLock(root, async () => {
      const marker = publicationTransactionPath(root, jobId);
      if (!(await exists(marker))) return null;
      const transaction = await readPublicationTransaction(root, projectId, jobId);
      return recoverPublicationTransactionUnlocked(root, transaction, nowValue(now));
    }, { allowPublicationTransactions: true });
  }

  async function listDesignVersionsUnlocked(root: string, nodeId: string): Promise<DesignVersionManifest[]> {
    safeSegment(nodeId, "Node id");
    const parent = join(nodeRoot(root, nodeId), "versions");
    if (!(await exists(parent))) return [];
    const entries = await readdir(parent, { withFileTypes: true });
    const manifests = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
      .map(async (entry) => {
        const manifest = await readJson<DesignVersionManifest>(join(parent, entry.name, "manifest.json"), `Design Version ${entry.name}`);
        assertStoredVersionManifest(manifest, nodeId, entry.name);
        return manifest;
      }));
    return manifests.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  }

  async function listDesignVersions(
    dataDir: string,
    projectId: string,
    nodeId: string,
  ): Promise<DesignVersionManifest[]> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return listDesignVersionsUnlocked(root, nodeId);
    });
  }

  async function getDesignVersionUnlocked(
    root: string,
    nodeId: string,
    versionId: string,
  ): Promise<DesignVersionManifest> {
    const manifest = await readJson<DesignVersionManifest>(
      join(versionRoot(root, nodeId, versionId), "manifest.json"),
      `Design Version ${versionId}`,
    );
    assertStoredVersionManifest(manifest, nodeId, versionId);
    return manifest;
  }

  async function getDesignVersion(
    dataDir: string,
    projectId: string,
    nodeId: string,
    versionId: string,
  ): Promise<DesignVersionManifest> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return getDesignVersionUnlocked(root, nodeId, versionId);
    });
  }

  async function publishDesignVersion(
    dataDir: string,
    projectId: string,
    input: {
      nodeId: string;
      html: string;
      contextHash: string;
      canvasRevision: number;
      expectedHeadVersionId: string | null;
      jobId: string | null;
      runnerId: string | null;
      model: string | null;
      pageTitle?: string | null;
    },
    now?: number,
    hooks?: DesignVersionPublicationTestHooks,
  ): Promise<{ manifest: DesignVersionManifest; node: DesignNode; job: DesignJob | null }> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const project = await readProject(root);
      const nodeId = safeSegment(input.nodeId, "Node id");
      const nodes = readNodes(project);
      const node = nodes.get(nodeId);
      if (!node) throw new DesignStorageError("not-found", `Design Node ${nodeId} was not found`);
      if (!(DESIGN_GENERATIVE_NODE_KINDS as readonly string[]).includes(node.kind)) {
        throw new DesignStorageError("invalid-input", "Material Nodes cannot publish generated versions");
      }
      if (!SHA256.test(input.contextHash) || !Number.isSafeInteger(input.canvasRevision) || input.canvasRevision < 0) {
        throw new DesignStorageError("invalid-input", "Generation context identity is invalid");
      }
      if (input.expectedHeadVersionId !== null) safeSegment(input.expectedHeadVersionId, "Expected Head Version id");
      if (input.jobId !== null) safeSegment(input.jobId, "Job id");
      if (!validStoredText(input.runnerId, 512, { nullable: true })
        || !validStoredText(input.model, 512, { nullable: true })) {
        throw new DesignStorageError("invalid-input", "Generation runner identity is invalid");
      }
      let authorityJob: DesignJob | null = null;
      if (input.jobId !== null) {
        const authority = await readJob(root, input.jobId);
        if (authority.kind !== "node-generation"
          || authority.nodeId !== nodeId
          || authority.status !== "validating"
          || authority.cancelRequested
          || node.activeJobId !== authority.id
          || authority.contextHash !== input.contextHash
          || authority.canvasRevision !== input.canvasRevision
          || authority.expectedHeadVersionId !== input.expectedHeadVersionId
          || authority.runnerId !== input.runnerId
          || authority.model !== input.model) {
          throw new DesignStorageError(
            "conflict",
            "Generation Version publication requires the active validating Job authority",
          );
        }
        authorityJob = authority;
      }
      // A previous immutable Version already contains checksum-bound canonical
      // Asset URLs. Permit only exact URLs pinned by this Node's expected Head;
      // canonicalizeVersionAssets then rebinds them to the new immutable Version.
      const allowedCanonicalAssetUrls = new Set<string>();
      if (input.expectedHeadVersionId !== null) {
        const expectedHead = await getDesignVersionUnlocked(root, nodeId, input.expectedHeadVersionId);
        for (const pin of expectedHead.assetPins) {
          const asset = await getDesignAssetManifest(dataDir, projectId, pin.assetId);
          if (asset.checksum !== pin.checksum) {
            throw new DesignStorageError("corrupt", `Expected Head Version ${expectedHead.id} has an invalid Asset pin`);
          }
          allowedCanonicalAssetUrls.add(
            `/api/projects/${projectId}/design-canvas/assets/${asset.id}/${asset.fileName}`
              + `?nodeId=${nodeId}&versionId=${expectedHead.id}&checksum=${asset.checksum}`,
          );
        }
      }
      validateDesignHtml(input.html, { allowCanonicalAssets: true });

      const existing = await listDesignVersionsUnlocked(root, nodeId);
      const sequence = existing.reduce((maximum, version) => Math.max(maximum, version.sequence), 0) + 1;
      const versionId = `version-${randomUUID()}`;
      const canonical = await canonicalizeVersionAssets({
        dataDir,
        projectId,
        nodeId,
        versionId,
        html: input.html,
        allowedCanonicalAssetUrls,
      });
      const timestamp = nowValue(now);
      const bytes = Buffer.byteLength(canonical.html, "utf8");
      const checksum = createHash("sha256").update(canonical.html, "utf8").digest("hex");
      const publicationStatus = node.currentVersionId === input.expectedHeadVersionId ? "published" : "superseded";
      const firstPageTitle = input.pageTitle ?? null;
      if (firstPageTitle !== null) {
        if (authorityJob === null || node.kind !== "page" || node.versionCount !== 0
          || extractDesignPageTitle(input.html) !== firstPageTitle) {
          throw new DesignStorageError("conflict", "First Page title does not match its publication authority");
        }
      }
      const nodeNameAfter = firstPageTitle !== null && node.name === "Page" ? firstPageTitle : node.name;
      const manifest: DesignVersionManifest = {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        id: versionId,
        nodeId,
        contentKind: "html",
        assetId: null,
        sequence,
        checksum,
        bytes,
        contextHash: input.contextHash,
        canvasRevision: input.canvasRevision,
        expectedHeadVersionId: input.expectedHeadVersionId,
        publicationStatus,
        assetPins: canonical.pins,
        jobId: input.jobId,
        runnerId: input.runnerId,
        model: input.model,
        createdAt: timestamp,
      };

      if (authorityJob !== null) {
        const transactionContent: Omit<DesignVersionPublicationTransaction, "checksum"> = {
          schemaVersion: DESIGN_SCHEMA_VERSION,
          projectId,
          jobId: authorityJob.id,
          nodeId,
          manifest,
          terminalStatus: publicationStatus === "published" ? "ready" : "superseded",
          projectRevisionBefore: project.revision,
          previousVersionCount: node.versionCount,
          nodeNameBefore: node.name,
          nodeNameAfter,
          currentVersionIdBefore: node.currentVersionId,
          selectedVersionIdBefore: node.selectedVersionId,
          followsHead: node.selectedVersionId === null || node.selectedVersionId === node.currentVersionId,
          createdAt: timestamp,
        };
        const transaction: DesignVersionPublicationTransaction = {
          ...transactionContent,
          checksum: publicationTransactionChecksum(transactionContent),
        };
        let markerWritten = false;
        try {
          await mkdir(publicationTransactionsRoot(root), { recursive: true });
          const markerPath = publicationTransactionPath(root, authorityJob.id);
          if (await exists(markerPath)) {
            throw new DesignStorageError("conflict", `Design publication ${authorityJob.id} already has a transaction`);
          }
          await writeAtomicJson(markerPath, transaction);
          markerWritten = true;
          await hooks?.afterPhase?.("marker");

          const pending = pendingVersionRoot(root, nodeId, versionId);
          await mkdir(pending, { recursive: true });
          await hooks?.afterPendingDirectory?.();
          await writeFile(join(pending, "index.html"), canonical.html, { flag: "wx", mode: 0o600 });
          await hooks?.afterPendingIndex?.();
          await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          await hooks?.afterPhase?.("pending");
          const terminalJob = await rollForwardPublicationUnlocked(root, transaction, hooks);
          const committedProject = await readProject(root);
          const committedNode = readNodes(committedProject).get(nodeId);
          if (!committedNode) throw new DesignStorageError("corrupt", `Design publication ${authorityJob.id} lost its Node`);
          return { manifest, node: cloneNode(committedNode), job: terminalJob };
        } catch (error) {
          if (!markerWritten || hooks?.simulateProcessCrash) throw error;
          // Reconcile while this exact Project lock is still held. Letting the lock
          // go first would allow queued Canvas or cancellation writes to invalidate
          // the durable transaction's revision and Job authority.
          const recovered = await recoverPublicationTransactionUnlocked(root, transaction, timestamp);
          if (recovered.status !== transaction.terminalStatus || recovered.versionId !== manifest.id) throw error;
          const committedProject = await readProject(root);
          const committedNode = readNodes(committedProject).get(nodeId);
          if (!committedNode) throw new DesignStorageError("corrupt", `Design publication ${authorityJob.id} lost its Node`);
          return { manifest, node: cloneNode(committedNode), job: recovered };
        }
      }

      const pendingParent = join(nodeRoot(root, nodeId), ".pending");
      const pending = join(pendingParent, versionId);
      const target = versionRoot(root, nodeId, versionId);
      await mkdir(pending, { recursive: true });
      await mkdir(join(nodeRoot(root, nodeId), "versions"), { recursive: true });
      try {
        await writeFile(join(pending, "index.html"), canonical.html, { flag: "wx", mode: 0o600 });
        await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(pending, target);
      } catch (error) {
        await rm(pending, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      node.name = nodeNameAfter;
      node.versionCount = existing.length + 1;
      node.error = null;
      if (publicationStatus === "published") {
        const followsHead = node.selectedVersionId === null || node.selectedVersionId === node.currentVersionId;
        node.currentVersionId = versionId;
        if (followsHead) node.selectedVersionId = versionId;
        node.state = "ready";
      } else if (node.activeJobId === null || node.activeJobId === input.jobId) {
        node.state = "superseded";
      }
      if (node.activeJobId === input.jobId) node.activeJobId = null;
      node.updatedAt = timestamp;
      project.nodes = project.nodeOrder.map((id) => cloneNode(nodes.get(id)!));
      project.revision += 1;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      await writeAuthorityJson(root, projectFilePath(root), project, ["canvas"]);
      return { manifest, node: cloneNode(node), job: null };
    });
  }

  async function resolveDesignVersionFileUnlocked(
    root: string,
    nodeId: string,
    versionId: string,
    requestedFile: string,
  ): Promise<{ manifest: DesignVersionManifest; path: string }> {
    if (requestedFile !== "" && requestedFile !== "index.html") {
      throw new DesignStorageError("not-found", "Design Version file was not found");
    }
    const manifest = await getDesignVersionUnlocked(root, nodeId, versionId);
    if (manifest.contentKind !== "html" || manifest.assetId !== null) {
      throw new DesignStorageError("not-found", "Material Design Versions do not contain index.html");
    }
    const path = join(versionRoot(root, nodeId, versionId), "index.html");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.bytes) {
      throw new DesignStorageError("corrupt", `Design Version ${versionId} HTML is invalid`);
    }
    const checksum = createHash("sha256").update(await readFile(path)).digest("hex");
    if (checksum !== manifest.checksum) {
      throw new DesignStorageError("corrupt", `Design Version ${versionId} HTML checksum is invalid`);
    }
    return { manifest, path };
  }

  async function resolveDesignVersionFile(
    dataDir: string,
    projectId: string,
    nodeId: string,
    versionId: string,
    requestedFile: string,
  ): Promise<{ manifest: DesignVersionManifest; path: string }> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return resolveDesignVersionFileUnlocked(root, nodeId, versionId, requestedFile);
    });
  }

  async function resolveDesignVersionPreviewUnlocked(
    root: string,
    nodeId: string,
    versionId: string,
  ): Promise<ResolvedDesignVersionPreview> {
    const manifest = await getDesignVersionUnlocked(root, nodeId, versionId);
    if (manifest.contentKind === "html") {
      const resolved = await resolveDesignVersionFileUnlocked(root, nodeId, versionId, "index.html");
      return { kind: "html", path: resolved.path, manifest: resolved.manifest };
    }
    const assetId = manifest.assetId;
    if (assetId === null) {
      throw new DesignStorageError("corrupt", `Material Design Version ${versionId} has no Asset`);
    }
    const resolved = await resolveDesignAssetFileUnlocked(
      root,
      assetId,
      (await getDesignAssetManifestUnlocked(root, assetId)).fileName,
    );
    if (resolved.manifest.checksum !== manifest.checksum || resolved.manifest.bytes !== manifest.bytes) {
      throw new DesignStorageError("corrupt", `Material Design Version ${versionId} Asset identity is invalid`);
    }
    return {
      kind: "asset",
      path: resolved.path,
      manifest,
      assetManifest: resolved.manifest,
    };
  }

  async function resolveDesignVersionPreview(
    dataDir: string,
    projectId: string,
    nodeId: string,
    versionId: string,
  ): Promise<ResolvedDesignVersionPreview> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      return resolveDesignVersionPreviewUnlocked(root, nodeId, versionId);
    });
  }

  async function buildPortableDesignVersionHtml(
    dataDir: string,
    projectId: string,
    nodeId: string,
    versionId: string,
    hooks?: PortableDesignVersionHtmlTestHooks,
  ): Promise<{ html: Buffer; checksum: string }> {
    const root = designRoot(dataDir, projectId);
    return withProjectLock(root, async () => {
      await requireInitialized(root);
      const resolved = await resolveDesignVersionPreviewUnlocked(root, nodeId, versionId);
      if (resolved.kind !== "html") {
        throw new DesignStorageError("invalid-input", "Portable preview export requires an HTML Design Version");
      }
      const source = await readExactImmutablePayload({
        path: resolved.path,
        expectedBytes: resolved.manifest.bytes,
        expectedChecksum: resolved.manifest.checksum,
        label: `Portable Design Version ${versionId}`,
        beforeOpen: hooks?.beforeVersionPayloadRead,
      });
      try {
        const assetManifests = new Map<string, DesignAssetManifest>();
        const assets = [] as Array<{
          assetId: string;
          checksum: string;
          mimeType: string;
          canonicalUrl: string;
          byteLength: number;
        }>;
        for (const pin of resolved.manifest.assetPins) {
          const asset = await getDesignAssetManifestUnlocked(root, pin.assetId);
          if (asset.checksum !== pin.checksum) {
            throw new DesignStorageError("corrupt", `Design Asset ${pin.assetId} diverges from its Version pin`);
          }
          assetManifests.set(asset.id, asset);
          assets.push({
            assetId: asset.id,
            checksum: asset.checksum,
            mimeType: asset.mimeType,
            canonicalUrl: `/api/projects/${projectId}/design-canvas/assets/${asset.id}/${asset.fileName}`
              + `?nodeId=${nodeId}&versionId=${versionId}&checksum=${asset.checksum}`,
            byteLength: asset.bytes,
          });
        }
        const html = await buildPortableDesignHtmlFromAssetLoader({ html: source, assets }, async (descriptor) => {
          const asset = assetManifests.get(descriptor.assetId);
          if (!asset) {
            throw new DesignStorageError("corrupt", `Design Asset ${descriptor.assetId} lost its Version pin`);
          }
          const path = join(assetRoot(root, asset.id), asset.fileName);
          const bytes = await readExactImmutablePayload({
            path,
            expectedBytes: asset.bytes,
            expectedChecksum: asset.checksum,
            label: `Portable Design Asset ${asset.id}`,
            beforeOpen: () => hooks?.beforeAssetPayloadRead?.(asset.id),
          });
          await hooks?.afterAssetPayloadRead?.(asset.id);
          return bytes;
        });
        return { html, checksum: createHash("sha256").update(html).digest("hex") };
      } catch (error) {
        if (error instanceof PortableDesignHtmlError) {
          throw new DesignStorageError(error.code, error.message, { cause: error });
        }
        throw error;
      }
    });
  }

  async function resolvePinnedDesignAssetFile(
    dataDir: string,
    projectId: string,
    input: {
      nodeId: string;
      versionId: string;
      assetId: string;
      checksum: string;
      requestedFile: string;
    },
  ): Promise<{ manifest: DesignAssetManifest; path: string }> {
    if (!SHA256.test(input.checksum)) throw new DesignStorageError("invalid-input", "Asset checksum pin is invalid");
    const version = await getDesignVersion(dataDir, projectId, input.nodeId, input.versionId);
    const pin = version.assetPins.find((candidate) => candidate.assetId === input.assetId);
    if (!pin || pin.checksum !== input.checksum) {
      throw new DesignStorageError("forbidden", "Design Asset is not pinned by the exact Version manifest");
    }
    const resolved = await resolveDesignAssetFile(dataDir, projectId, input.assetId, input.requestedFile);
    if (resolved.manifest.checksum !== input.checksum) {
      throw new DesignStorageError("corrupt", "Design Asset payload diverges from the exact Version pin");
    }
    return resolved;
  }

  return {
    appendDesignMaterialVersion,
    buildPortableDesignVersionHtml,
    getDesignAssetManifest,
    getDesignAssetManifestUnlocked,
    getDesignVersion,
    getDesignVersionUnlocked,
    ensureDesignCanvasAssetBatch,
    importDesignCanvasAssetBatch,
    listDesignAssets,
    listDesignVersions,
    publishDesignVersion,
    recoverDesignVersionPublication,
    recoverPendingAssetImportsUnlocked,
    recoverPublicationTransactionsUnlocked,
    resolveDesignAssetBundleFile,
    resolveDesignAssetFile,
    resolveDesignVersionFile,
    resolveDesignVersionPreview,
    resolvePinnedDesignAssetFile,
    storeDesignAsset,
  };
}

export type DesignAssetVersionPublication =
  ReturnType<typeof createDesignAssetVersionPublication>;
