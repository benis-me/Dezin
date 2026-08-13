/**
 * Pure Design Canvas contracts shared by browser and server packages.
 *
 * Keep this module free of runtime platform dependencies. Storage manifests and
 * UI-only state belong in their owning packages rather than in this wire layer.
 */

export const DESIGN_SCHEMA_VERSION = 2 as const;

export const DESIGN_GENERATIVE_NODE_KINDS = [
  "component",
  "page",
  "design-system",
  "research",
  "design-tokens",
  "design-document",
  "layout",
  "knowledge",
] as const;

export const DESIGN_MATERIAL_NODE_KINDS = [
  "image",
  "video",
  "document",
  "file",
] as const;

export const DESIGN_NODE_KINDS = [
  ...DESIGN_GENERATIVE_NODE_KINDS,
  ...DESIGN_MATERIAL_NODE_KINDS,
] as const;

export type DesignNodeKind = (typeof DESIGN_NODE_KINDS)[number];
export type DesignGenerativeNodeKind = (typeof DESIGN_GENERATIVE_NODE_KINDS)[number];
export type DesignMaterialNodeKind = (typeof DESIGN_MATERIAL_NODE_KINDS)[number];

/**
 * Terminal lifecycle states remain explicit so cancelled or superseded work
 * never has to masquerade as a generic failure at a contract boundary.
 */
export type DesignNodeState =
  | "empty"
  | "queued"
  | "generating"
  | "validating"
  | "ready"
  | "failed"
  | "cancelled"
  | "superseded";

export interface DesignViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface DesignNodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignNode {
  id: string;
  kind: DesignNodeKind;
  name: string;
  geometry: DesignNodeGeometry;
  state: DesignNodeState;
  currentVersionId: string | null;
  selectedVersionId: string | null;
  versionCount: number;
  assetId: string | null;
  activeJobId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DesignCanvas {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  projectId: string;
  revision: number;
  viewport: DesignViewport;
  nodeOrder: string[];
  nodes: DesignNode[];
  undoDepth: number;
  redoDepth: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewDesignNode {
  id?: string;
  kind: DesignNodeKind;
  name?: string;
  geometry?: Partial<DesignNodeGeometry>;
  assetId?: string | null;
}

export type DesignCanvasIntent =
  | { type: "add-node"; node: NewDesignNode }
  | {
      type: "update-node";
      nodeId: string;
      patch: {
        name?: string;
        geometry?: Partial<DesignNodeGeometry>;
        selectedVersionId?: string | null;
      };
    }
  | { type: "remove-node"; nodeId: string }
  | { type: "set-viewport"; viewport: DesignViewport }
  | {
      type: "replace-layout";
      nodes: Array<{ nodeId: string; geometry: DesignNodeGeometry }>;
    };

export interface DesignAsset {
  id: string;
  name: string;
  mimeType: string;
  checksum: string;
  bytes: number;
  createdAt: number;
}

export interface DesignNodeVersion {
  id: string;
  nodeId: string;
  sequence: number;
  contentKind: "html" | "asset";
  assetId: string | null;
  mimeType: string | null;
  fileName: string | null;
  checksum: string;
  bytes: number;
  contextHash: string | null;
  jobId: string | null;
  runnerId: string | null;
  model: string | null;
  createdAt: number;
}

export type DesignThreadScope = { type: "main" } | { type: "node"; nodeId: string };
export type DesignThreadRole = "user" | "assistant" | "system" | "tool";

export interface DesignThreadMessage {
  id: string;
  role: DesignThreadRole;
  content: string;
  jobId: string | null;
  createdAt: number;
}

export interface DesignThread {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  id: string;
  scope: DesignThreadScope;
  messages: DesignThreadMessage[];
  createdAt: number;
  updatedAt: number;
}

export type DesignJobKind =
  | "node-generation"
  | "node-analysis"
  | "main-agent"
  | "implementation-export";

export type DesignJobStatus =
  | "queued"
  | "running"
  | "validating"
  | "ready"
  | "failed"
  | "cancelled"
  | "superseded";

/** Stable, presentation-safe identity for a persisted Agent tool activity. */
export const DESIGN_JOB_TOOL_NAMES = ["write", "read", "command", "search", "tool"] as const;
export type DesignJobToolName = (typeof DESIGN_JOB_TOOL_NAMES)[number];

export interface DesignJobActivity {
  id: string;
  kind: "text" | "tool" | "status";
  text: string;
  /** Optional so Jobs written before tool identity persistence remain readable. */
  toolName?: DesignJobToolName;
  /** Provider-issued id used to attach a later real tool result to this activity. */
  toolCallId?: string;
  /** Bounded JSON serialization of the provider's exact tool input. */
  toolInput?: string;
  /** Bounded provider tool_result content; absent until/unless the provider emits it. */
  toolResult?: string;
  toolResultError?: boolean;
  /** Exact provider patch projection; never inferred from the activity summary. */
  diff?: string;
  createdAt: number;
}

export interface DesignJob {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  id: string;
  kind: DesignJobKind;
  runnerId: string;
  model: string | null;
  status: DesignJobStatus;
  nodeId: string | null;
  parentJobId: string | null;
  contextHash: string | null;
  canvasRevision: number | null;
  expectedHeadVersionId: string | null;
  versionId: string | null;
  exportId: string | null;
  error: string | null;
  cancelRequested: boolean;
  conversationOnly?: boolean;
  activity: DesignJobActivity[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface DesignAgentContext {
  nodeIds: string[];
}

export interface DesignAgentSelection {
  agentCommand?: string;
  /** null explicitly selects the provider default; undefined inherits Settings. */
  model?: string | null;
}

export type DesignCanvasAssetImportSource =
  | { name: string; mimeType: string; base64: string; sourceVersion?: never }
  | {
      name: string;
      mimeType: string;
      sourceVersion: { projectId: string; nodeId: string; versionId: string };
      base64?: never;
    };

export interface DesignCanvasAssetImportItem {
  asset: DesignCanvasAssetImportSource;
  binding:
    | {
        type: "create-node";
        node: {
          id?: string;
          kind: DesignNodeKind;
          name?: string;
          geometry?: Partial<DesignNodeGeometry>;
        };
      }
    | { type: "append-version"; nodeId: string };
}

export const DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export interface DesignProjectBootstrapInput {
  schemaVersion: typeof DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION;
  idempotencyKey: string;
  name: string;
  prompt: string;
  items: DesignCanvasAssetImportItem[];
  agent?: DesignAgentSelection;
}

export type DesignProjectBootstrapPhase =
  | "accepted"
  | "project-created"
  | "assets-imported"
  | "main-reserved"
  | "ready";

export interface DesignProjectBootstrapJob {
  schemaVersion: typeof DESIGN_PROJECT_BOOTSTRAP_SCHEMA_VERSION;
  id: string;
  projectId: string;
  requestHash: string;
  status: "running" | "ready" | "failed";
  completedPhase: DesignProjectBootstrapPhase;
  mainJobId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DesignProjectBootstrapResult {
  job: DesignProjectBootstrapJob;
  reused: boolean;
}

export const FIGMA_IMPORT_SCHEMA_VERSION = 1 as const;

export interface FigmaImportAnchor {
  x: number;
  y: number;
}

export interface FigmaImportInput {
  schemaVersion: typeof FIGMA_IMPORT_SCHEMA_VERSION;
  idempotencyKey: string;
  url: string;
  nodeIds?: string[];
  depth?: number;
  anchor: FigmaImportAnchor;
  rightsAcknowledged: true;
}

export interface FigmaImportArtifactManifest {
  kind:
    | "raw-file"
    | "raw-variables"
    | "design-document"
    | "tokens"
    | "components"
    | "layout"
    | "reference-render";
  path: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  nodeId: string | null;
}

export interface FigmaImportManifest {
  schemaVersion: typeof FIGMA_IMPORT_SCHEMA_VERSION;
  importId: string;
  projectId: string;
  source: {
    normalizedUrl: string;
    fileType: "design" | "file" | "board" | "slides";
    fileKey: string;
    branchKey: string | null;
    fileName: string;
    requestedVersionId: string | null;
    resolvedVersion: string;
    selectedNodeIds: string[];
    depth: number;
  };
  access: {
    editorType: string | null;
    role: string | null;
    linkAccess: string | null;
  };
  credential: {
    mode: "personal-access-token";
    /** Stable non-secret digest label; never the PAT itself. */
    subject: string;
  };
  tokenAuthority: "figma-variables-exact" | "style-values-inferred" | "not-applicable";
  artifacts: FigmaImportArtifactManifest[];
  incomplete: string[];
  warnings: string[];
  canvasRevision: number;
  createdAt: number;
}

export interface FigmaImportResult {
  manifest: FigmaImportManifest;
  reused: boolean;
}

export interface FigmaCanvasImportResponse {
  canvas: DesignCanvas;
  import: FigmaImportResult;
}

export interface FigmaCredentialStatus {
  configured: boolean;
  source: "environment" | "local" | null;
}

export interface FigmaCredentialPutInput {
  token: string;
}

export interface DesignAgentTurnResult {
  thread: DesignThread;
  job: DesignJob;
  canvas?: DesignCanvas;
}

export interface DesignExportResult {
  exportId: string;
  job: DesignJob;
}

export type DesignJobRetryResult =
  | {
      retryOfJobId: string;
      thread: DesignThread;
      job: DesignJob;
      canvas: DesignCanvas;
    }
  | {
      retryOfJobId: string;
      exportId: string;
      job: DesignJob;
    };

export type DesignInvalidationTopic =
  | "canvas"
  | "jobs"
  | "thread:main"
  | `thread:node:${string}`;

export interface DesignInvalidationEvent {
  type: "invalidate";
  cursor: string;
  epoch: string;
  sequence: number;
  topics: DesignInvalidationTopic[];
}

export interface DesignInvalidationReset {
  type: "reset";
  cursor: string;
  epoch: string;
  sequence: number;
  reason: "initial" | "invalid-cursor" | "epoch-mismatch" | "history-compacted" | "cursor-ahead";
}

export type DesignInvalidationMessage = DesignInvalidationEvent | DesignInvalidationReset;
