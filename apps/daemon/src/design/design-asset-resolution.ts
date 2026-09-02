/**
 * Asset manifest and payload resolution with integrity checks.
 * Split out of design-asset-version-publication.ts; the facade there wires these
 * modules together and remains the only entry point.
 */
import {
  createHash,
} from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import {
  basename,
  join,
} from "node:path";
import {
  type DesignAssetBundleFile,
  type DesignAssetManifest,
} from "./design-types.ts";
import {
  DesignStorageError,
  assetRoot,
  designRoot,
  readJson,
  safeBundlePath,
  withProjectLock,
} from "./design-storage-primitives.ts";
import type { DesignAssetPreparation } from "./design-asset-preparation.ts";
import type { PublicationShared } from "./design-publication-shared.ts";
import type { DesignCanvasState } from "./design-canvas-state.ts";

export interface DesignAssetResolutionDeps extends Pick<DesignCanvasState, "requireInitialized"> {
  checksumExactImmutablePayload: DesignAssetPreparation["checksumExactImmutablePayload"];
  assertStoredAssetManifest: DesignAssetPreparation["assertStoredAssetManifest"];
  /** Functions constructed after this module; resolved at call time. */
  shared: PublicationShared;
}

export function createDesignAssetResolution(deps: DesignAssetResolutionDeps) {
  const requireInitialized: DesignCanvasState["requireInitialized"] = deps.requireInitialized;
  const checksumExactImmutablePayload: DesignAssetPreparation["checksumExactImmutablePayload"] = deps.checksumExactImmutablePayload;
  const assertStoredAssetManifest: DesignAssetPreparation["assertStoredAssetManifest"] = deps.assertStoredAssetManifest;
  const recoverPendingAssetImportsUnlocked: PublicationShared["recoverPendingAssetImportsUnlocked"] = (...args) => deps.shared.recoverPendingAssetImportsUnlocked(...args);

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
    const checksum = await checksumExactImmutablePayload(path, manifest.bytes, `Design Asset ${assetId} payload`);
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

  return {
    getDesignAssetManifestUnlocked,
    getDesignAssetManifest,
    listDesignAssets,
    resolveDesignAssetFile,
    resolveDesignAssetFileUnlocked,
    resolveDesignAssetBundleFile,
    resolveDesignAssetBundleFileUnlocked,
  };
}

export type DesignAssetResolution = ReturnType<typeof createDesignAssetResolution>;
