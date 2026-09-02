import {
  type DesignAssetManifest,
  type DesignCanvas,
  type DesignCanvasIntent,
  type DesignJob,
  type DesignNode,
  type DesignVersionManifest,
  type DesignVersionPublicationPhase,
} from "./design-types.ts";
import type {
  DesignCanvasState,
} from "./design-canvas-state.ts";
import type { PublicationShared } from "./design-publication-shared.ts";
import { createDesignAssetPreparation } from "./design-asset-preparation.ts";
import { createDesignAssetImport } from "./design-asset-import.ts";
import { createDesignAssetResolution } from "./design-asset-resolution.ts";
import { createDesignVersionPublication } from "./design-version-publication.ts";
import { createDesignVersionResolution } from "./design-version-resolution.ts";

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

  const shared = {} as PublicationShared;
  const preparation = createDesignAssetPreparation({ canvas, requireInitialized, snapshot, shared });
  const resolution = createDesignAssetResolution({ requireInitialized, checksumExactImmutablePayload: preparation.checksumExactImmutablePayload, assertStoredAssetManifest: preparation.assertStoredAssetManifest, shared });
  const versions = createDesignVersionPublication({ canvas, cloneNode, readNodes, readProject, requireInitialized, readJob, getDesignAssetManifest: resolution.getDesignAssetManifest });
  const imports = createDesignAssetImport({ assertStoredProject, addNode, canvas, cloneNode, readNodes, readProject, requireInitialized, snapshot, snapshotDesignSourceVersions: preparation.snapshotDesignSourceVersions, prepareDesignAsset: preparation.prepareDesignAsset, discardPreparedDesignAsset: preparation.discardPreparedDesignAsset, persistPreparedDesignAsset: preparation.persistPreparedDesignAsset, stagePreparedDesignAsset: preparation.stagePreparedDesignAsset, getDesignAssetManifestUnlocked: resolution.getDesignAssetManifestUnlocked, assertStoredVersionManifest: versions.assertStoredVersionManifest });
  const versionFiles = createDesignVersionResolution({ canvas, requireInitialized, readExactImmutablePayload: preparation.readExactImmutablePayload, getDesignAssetManifestUnlocked: resolution.getDesignAssetManifestUnlocked, resolveDesignAssetFile: resolution.resolveDesignAssetFile, resolveDesignAssetFileUnlocked: resolution.resolveDesignAssetFileUnlocked, getDesignVersionUnlocked: versions.getDesignVersionUnlocked, getDesignVersion: versions.getDesignVersion });
  Object.assign(shared, {
    recoverPendingAssetImportsUnlocked: imports.recoverPendingAssetImportsUnlocked,
    getDesignAssetManifestUnlocked: resolution.getDesignAssetManifestUnlocked,
    getDesignVersionUnlocked: versions.getDesignVersionUnlocked,
  });

  return {
    appendDesignMaterialVersion: imports.appendDesignMaterialVersion,
    buildPortableDesignVersionHtml: versionFiles.buildPortableDesignVersionHtml,
    getDesignAssetManifest: resolution.getDesignAssetManifest,
    getDesignAssetManifestUnlocked: resolution.getDesignAssetManifestUnlocked,
    getDesignVersion: versions.getDesignVersion,
    getDesignVersionUnlocked: versions.getDesignVersionUnlocked,
    ensureDesignCanvasAssetBatch: imports.ensureDesignCanvasAssetBatch,
    importDesignCanvasAssetBatch: imports.importDesignCanvasAssetBatch,
    listDesignAssets: resolution.listDesignAssets,
    listDesignVersions: versions.listDesignVersions,
    publishDesignVersion: versions.publishDesignVersion,
    recoverDesignVersionPublication: versions.recoverDesignVersionPublication,
    recoverPendingAssetImportsUnlocked: imports.recoverPendingAssetImportsUnlocked,
    recoverPublicationTransactionsUnlocked: versions.recoverPublicationTransactionsUnlocked,
    resolveDesignAssetBundleFile: resolution.resolveDesignAssetBundleFile,
    resolveDesignAssetFile: resolution.resolveDesignAssetFile,
    resolveDesignVersionFile: versionFiles.resolveDesignVersionFile,
    resolveDesignVersionPreview: versionFiles.resolveDesignVersionPreview,
    resolvePinnedDesignAssetFile: versionFiles.resolvePinnedDesignAssetFile,
    storeDesignAsset: imports.storeDesignAsset,
  };
}

export type DesignAssetVersionPublication =
  ReturnType<typeof createDesignAssetVersionPublication>;
