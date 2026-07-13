import type { ProjectMode, QualityFinding } from "./types.ts";

export type WorkspaceNodeKind = "page" | "component" | "resource";
export type WorkspaceEdgeKind = "prototype" | "uses" | "informs" | "derives-from";
export type ArtifactKind = "page" | "component";
export type ResourceKind =
  | "research"
  | "moodboard"
  | "sharingan-capture"
  | "file"
  | "asset"
  | "effect"
  | "external-reference";
export type ResourcePinPolicy = "follow-head" | "pin-current" | "manual";
export type PrototypeEdgeStatus = "planned" | "interactive" | "broken";
export type ArtifactQualityState = "passed" | "needs-attention" | "failed" | "unassessed";

export interface RenderFrameSpec {
  id: string;
  name: string;
  width: number;
  height: number;
  initialState?: string;
  fixture?: Record<string, unknown>;
  background?: string;
}

export interface ArtifactQualityProfile {
  requiredFrameIds: string[];
  blockingSeverities: QualityFinding["severity"][];
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
}

export interface ArtifactQualitySummary {
  state: ArtifactQualityState;
  score: number | null;
  findings: QualityFinding[];
}

export interface ProjectWorkspace {
  id: string;
  projectId: string;
  mode: ProjectMode;
  graphRevision: number;
  activeSnapshotId: string;
  activeKernelRevisionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SharedDesignKernelRevision {
  id: string;
  workspaceId: string;
  sequence: number;
  parentRevisionId: string | null;
  tokens: Record<string, string | number>;
  typography: Record<string, unknown>;
  sharedAssetRevisionIds: string[];
  brief: string;
  terminology: Record<string, string>;
  exclusions: string[];
  responsiveFrames: RenderFrameSpec[];
  qualityProfile: ArtifactQualityProfile;
  checksum: string;
  createdAt: number;
}

interface WorkspaceNodeBase {
  id: string;
  workspaceId: string;
  name: string;
}

export interface WorkspaceArtifactNode extends WorkspaceNodeBase {
  kind: ArtifactKind;
  artifactId: string;
  resourceId?: never;
  quality?: ArtifactQualitySummary;
}

export interface WorkspaceResourceNode extends WorkspaceNodeBase {
  kind: "resource";
  resourceId: string;
  artifactId?: never;
}

export type WorkspaceNode = WorkspaceArtifactNode | WorkspaceResourceNode;

export interface DesignNodeLocator {
  designNodeId: string;
  sourcePath?: string;
  selector?: string;
}

export type PrototypeTrigger = "click" | "submit";

export interface PrototypeTransition {
  type: "none" | "fade" | "slide";
  durationMs?: number;
  easing?: string;
}

export interface PrototypeBinding {
  sourceArtifactId: string;
  sourceRevisionId: string;
  sourceLocator: DesignNodeLocator;
  trigger: PrototypeTrigger;
  targetArtifactId: string;
  targetState?: string;
  transition?: PrototypeTransition;
}

export interface PrototypeEdge {
  status: PrototypeEdgeStatus;
  binding?: PrototypeBinding;
  brokenReason?: string;
}

export interface WorkspaceEdge {
  id: string;
  workspaceId: string;
  kind: WorkspaceEdgeKind;
  sourceNodeId: string;
  targetNodeId: string;
  prototype?: PrototypeEdge;
}

export interface WorkspaceGraph {
  workspaceId: string;
  revision: number;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

export type NewWorkspaceNode =
  | {
    id: string;
    kind: ArtifactKind;
    name: string;
    artifactId: string;
    createIdentity?: { initialTrackId: string };
  }
  | {
    id: string;
    kind: "resource";
    name: string;
    resourceId: string;
    createIdentity?: { resourceKind: ResourceKind; defaultPinPolicy: ResourcePinPolicy };
  };

export interface NewWorkspaceEdge {
  id: string;
  workspaceId: string;
  kind: WorkspaceEdgeKind;
  sourceNodeId: string;
  targetNodeId: string;
  prototype?: Partial<PrototypeEdge>;
}

export type WorkspaceGraphCommand =
  | { id: string; type: "add-node"; node: NewWorkspaceNode }
  | { id: string; type: "rename-node"; nodeId: string; name: string }
  | { id: string; type: "archive-node"; nodeId: string }
  | { id: string; type: "add-edge"; edge: NewWorkspaceEdge }
  | { id: string; type: "remove-edge"; edgeId: string }
  | { id: string; type: "bind-prototype"; edgeId: string; binding: PrototypeBinding };
