export const DESIGN_NODE_KINDS = [
  "component",
  "page",
  "design-system",
  "research",
  "design-tokens",
  "design-document",
  "layout",
  "knowledge",
  "image",
  "video",
  "document",
  "file",
] as const;

export const DESIGN_GENERATIVE_NODE_KINDS = DESIGN_NODE_KINDS.slice(0, 8);
export const DESIGN_MATERIAL_NODE_KINDS = DESIGN_NODE_KINDS.slice(8);

export type DesignNodeKind = (typeof DESIGN_NODE_KINDS)[number];
export type DesignGenerativeNodeKind = (typeof DESIGN_GENERATIVE_NODE_KINDS)[number];
export type DesignMaterialNodeKind = (typeof DESIGN_MATERIAL_NODE_KINDS)[number];

/**
 * The UI accepts terminal lifecycle states beyond the first storage schema so a
 * cancelled or superseded run never has to masquerade as a generic failure.
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
  /** Exact last good revision, retained while a newer generation fails. */
  lastReadyVersionId?: string | null;
  versionCount: number;
  assetId: string | null;
  activeJobId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DesignCanvas {
  schemaVersion: number;
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
  id: string;
  scope: DesignThreadScope;
  messages: DesignThreadMessage[];
  createdAt: number;
  updatedAt: number;
}

export type DesignJobKind = "node-generation" | "node-analysis" | "main-agent" | "implementation-export";
export type DesignJobStatus = "queued" | "running" | "validating" | "ready" | "failed" | "cancelled" | "superseded";

export interface DesignJobActivity {
  id: string;
  kind: "text" | "tool" | "status";
  text: string;
  createdAt: number;
}

export interface DesignJob {
  id: string;
  kind: DesignJobKind;
  runnerId: string;
  model: string | null;
  status: DesignJobStatus;
  nodeId: string | null;
  parentJobId: string | null;
  contextHash: string | null;
  versionId: string | null;
  exportId: string | null;
  error: string | null;
  conversationOnly?: boolean;
  activity: DesignJobActivity[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface ExactVersionPreview {
  nodeId: string;
  versionId: string;
  url: string;
  expiresAt?: number;
}

export interface DesignAgentContext {
  nodeIds: string[];
}

export interface DesignAgentSelection {
  agentCommand?: string;
  /** null explicitly selects the provider default; undefined inherits Settings. */
  model?: string | null;
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
