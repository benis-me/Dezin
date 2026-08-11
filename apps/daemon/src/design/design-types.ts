import {
  DESIGN_JOB_TOOL_NAMES,
  DESIGN_SCHEMA_VERSION,
} from "@dezin/design-canvas-contracts";
import type {
  DesignCanvas,
  DesignCanvasIntent,
  DesignGenerativeNodeKind,
  DesignInvalidationEvent,
  DesignInvalidationMessage,
  DesignInvalidationReset,
  DesignInvalidationTopic,
  DesignJob,
  DesignJobActivity,
  DesignJobKind,
  DesignJobStatus,
  DesignJobToolName,
  DesignMaterialNodeKind,
  DesignNode,
  DesignNodeGeometry,
  DesignNodeKind,
  DesignNodeState,
  DesignThread,
  DesignThreadMessage,
  DesignThreadRole,
  DesignThreadScope,
  DesignViewport,
  NewDesignNode,
} from "@dezin/design-canvas-contracts";

export {
  DESIGN_GENERATIVE_NODE_KINDS,
  DESIGN_JOB_TOOL_NAMES,
  DESIGN_MATERIAL_NODE_KINDS,
  DESIGN_NODE_KINDS,
} from "@dezin/design-canvas-contracts";
export { DESIGN_SCHEMA_VERSION };
export type {
  DesignCanvas,
  DesignCanvasIntent,
  DesignGenerativeNodeKind,
  DesignInvalidationEvent,
  DesignInvalidationMessage,
  DesignInvalidationReset,
  DesignInvalidationTopic,
  DesignJob,
  DesignJobActivity,
  DesignJobKind,
  DesignJobStatus,
  DesignJobToolName,
  DesignMaterialNodeKind,
  DesignNode,
  DesignNodeGeometry,
  DesignNodeKind,
  DesignNodeState,
  DesignThread,
  DesignThreadMessage,
  DesignThreadRole,
  DesignThreadScope,
  DesignViewport,
  NewDesignNode,
};

export interface DesignCanvasSnapshot {
  viewport: DesignViewport;
  nodeOrder: string[];
  nodes: DesignNode[];
}

export interface DesignProjectFile {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  projectId: string;
  revision: number;
  viewport: DesignViewport;
  nodeOrder: string[];
  /** Complete Canvas/Node authority. Node directories contain immutable payloads and Agent threads only. */
  nodes: DesignNode[];
  /** Node identities are never reused after removal; undo may still restore one. */
  retiredNodeIds: string[];
  undo: DesignCanvasSnapshot[];
  redo: DesignCanvasSnapshot[];
  turnReceipts: Record<string, {
    jobId: string;
    kind: DesignJobKind;
    nodeId: string | null;
    /** Hash of the normalized caller request (provider, model, parent, prompt, and priority context). */
    requestHash?: string;
    /** Hash of the exact frozen Canvas/Version/Asset authority used by this attempt. */
    authorityHash?: string;
    /** Immutable Main Agent plan bound to this idempotent request, when one was produced. */
    mainPlanHash?: string;
    /** Canvas revision committed atomically with this Main Agent plan application. */
    mainPlanAppliedRevision?: number;
    createdAt: number;
  }>;
  createdAt: number;
  updatedAt: number;
}

export interface DesignAssetManifest {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  id: string;
  name: string;
  mimeType: string;
  checksum: string;
  bytes: number;
  fileName: string;
  /** Additional immutable files required by the primary payload, stored relative to the Asset root. */
  bundleFiles: DesignAssetBundleFile[];
  sourceVersion?: {
    projectId: string;
    nodeId: string;
    versionId: string;
    checksum: string;
    assetPins: Array<{
      assetId: string;
      checksum: string;
      bytes: number;
      fileName: string;
      bundlePath: string;
    }>;
  };
  createdAt: number;
}

export interface DesignAssetBundleFile {
  path: string;
  checksum: string;
  bytes: number;
}

export interface DesignFrozenAssetPin {
  assetId: string;
  checksum: string;
  bytes: number;
  fileName: string;
  path: string;
  bundleFiles: DesignAssetBundleFile[];
}

export type DesignVersionContentKind = "html" | "asset";

export interface DesignVersionManifest {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  id: string;
  nodeId: string;
  contentKind: DesignVersionContentKind;
  /** Asset payload identity for material Versions; HTML Versions keep this null. */
  assetId: string | null;
  sequence: number;
  checksum: string;
  bytes: number;
  contextHash: string;
  canvasRevision: number;
  expectedHeadVersionId: string | null;
  publicationStatus: "published" | "superseded";
  assetPins: Array<{ assetId: string; checksum: string }>;
  jobId: string | null;
  runnerId: string | null;
  model: string | null;
  createdAt: number;
}

export type DesignVersionPublicationPhase = "marker" | "pending" | "target" | "canvas" | "job";

export interface DesignVersionPublicationTransaction {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  projectId: string;
  jobId: string;
  nodeId: string;
  manifest: DesignVersionManifest;
  terminalStatus: "ready" | "superseded";
  projectRevisionBefore: number;
  previousVersionCount: number;
  /** Added without changing the project schema; absent only on a pre-title publication WAL. */
  nodeNameBefore?: string;
  /** Added without changing the project schema; absent only on a pre-title publication WAL. */
  nodeNameAfter?: string;
  currentVersionIdBefore: string | null;
  selectedVersionIdBefore: string | null;
  followsHead: boolean;
  createdAt: number;
  checksum: string;
}

export interface DesignFrozenContext {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  projectId: string;
  canvasRevision: number;
  targetNodeId: string | null;
  checksum: string;
  viewport: DesignViewport;
  nodes: Array<{
    id: string;
    kind: DesignNodeKind;
    name: string;
    state: DesignNodeState;
    geometry: DesignNodeGeometry;
    selectedVersionId: string | null;
    selectedVersionContentKind: DesignVersionContentKind | null;
    selectedVersionChecksum: string | null;
    selectedVersionBytes: number | null;
    selectedVersionPath: string | null;
    selectedVersionJobId: string | null;
    selectedVersionRunnerId: string | null;
    selectedVersionModel: string | null;
    selectedVersionAssetPins: DesignFrozenAssetPin[];
    assetId: string | null;
    assetChecksum: string | null;
    assetBytes: number | null;
    assetPath: string | null;
    assetBundleFiles: DesignAssetBundleFile[];
  }>;
}

export interface DesignExportManifest {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  id: string;
  projectId: string;
  jobId: string;
  providerId: string;
  model: string | null;
  canvasRevision: number;
  inputHash: string;
  nodes: Array<{
    nodeId: string;
    nodeKind: DesignNodeKind;
    versionId: string;
    checksum: string;
    sourceJobId: string | null;
    sourceProviderId: string | null;
    sourceModel: string | null;
  }>;
  assets: Array<{ assetId: string; checksum: string }>;
  visualValidation: {
    protocol: "dezin-design-export-visual-v1";
    receiptPath: string;
    receiptChecksum: string;
    caseCount: number;
    passed: true;
  };
  outputFiles: Array<{ path: string; checksum: string; bytes: number }>;
  outputHash: string;
  createdAt: number;
}
