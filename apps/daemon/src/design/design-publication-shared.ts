/**
 * Functions that later-constructed publication modules provide to earlier ones.
 * The facade fills this object after every module exists; consumers call through
 * it at request time, never during construction.
 */
import type { DesignAssetManifest, DesignVersionManifest } from "./design-types.ts";

export interface PublicationShared {
  recoverPendingAssetImportsUnlocked(root: string): Promise<void>;
  getDesignAssetManifestUnlocked( root: string, assetId: string): Promise<DesignAssetManifest>;
  getDesignVersionUnlocked( root: string, nodeId: string, versionId: string): Promise<DesignVersionManifest>;
}
