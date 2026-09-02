/**
 * Version file and preview resolution, portable single-file HTML, and pinned Asset lookup.
 * Split out of design-asset-version-publication.ts; the facade there wires these
 * modules together and remains the only entry point.
 */
import {
  createHash,
} from "node:crypto";
import {
  lstat,
  readFile,
} from "node:fs/promises";
import {
  join,
} from "node:path";
import {
  type DesignAssetManifest,
  type DesignVersionManifest,
} from "./design-types.ts";
import {
  buildPortableDesignHtmlFromAssetLoader,
  PortableDesignHtmlError,
} from "./design-portable-html.ts";
import {
  DesignStorageError,
  SHA256,
  assetRoot,
  designRoot,
  withProjectLock,
} from "./design-storage-primitives.ts";
import {
  mimeType,
  versionRoot,
} from "./design-publication-primitives.ts";
import type {
  ResolvedDesignVersionPreview,
  PortableDesignVersionHtmlTestHooks,
} from "./design-asset-version-publication.ts";
import type { DesignAssetPreparation } from "./design-asset-preparation.ts";
import type { DesignAssetResolution } from "./design-asset-resolution.ts";
import type { DesignVersionPublication } from "./design-version-publication.ts";
import type { DesignCanvasState } from "./design-canvas-state.ts";

export interface DesignVersionResolutionDeps extends Pick<DesignCanvasState, "canvas" | "requireInitialized"> {
  readExactImmutablePayload: DesignAssetPreparation["readExactImmutablePayload"];
  getDesignAssetManifestUnlocked: DesignAssetResolution["getDesignAssetManifestUnlocked"];
  resolveDesignAssetFile: DesignAssetResolution["resolveDesignAssetFile"];
  resolveDesignAssetFileUnlocked: DesignAssetResolution["resolveDesignAssetFileUnlocked"];
  getDesignVersionUnlocked: DesignVersionPublication["getDesignVersionUnlocked"];
  getDesignVersion: DesignVersionPublication["getDesignVersion"];
}

export function createDesignVersionResolution(deps: DesignVersionResolutionDeps) {
  const canvas: DesignCanvasState["canvas"] = deps.canvas;
  const requireInitialized: DesignCanvasState["requireInitialized"] = deps.requireInitialized;
  const readExactImmutablePayload: DesignAssetPreparation["readExactImmutablePayload"] = deps.readExactImmutablePayload;
  const getDesignAssetManifestUnlocked: DesignAssetResolution["getDesignAssetManifestUnlocked"] = deps.getDesignAssetManifestUnlocked;
  const resolveDesignAssetFile: DesignAssetResolution["resolveDesignAssetFile"] = deps.resolveDesignAssetFile;
  const resolveDesignAssetFileUnlocked: DesignAssetResolution["resolveDesignAssetFileUnlocked"] = deps.resolveDesignAssetFileUnlocked;
  const getDesignVersionUnlocked: DesignVersionPublication["getDesignVersionUnlocked"] = deps.getDesignVersionUnlocked;
  const getDesignVersion: DesignVersionPublication["getDesignVersion"] = deps.getDesignVersion;

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
    resolveDesignVersionFileUnlocked,
    resolveDesignVersionFile,
    resolveDesignVersionPreviewUnlocked,
    resolveDesignVersionPreview,
    buildPortableDesignVersionHtml,
    resolvePinnedDesignAssetFile,
  };
}

export type DesignVersionResolution = ReturnType<typeof createDesignVersionResolution>;
