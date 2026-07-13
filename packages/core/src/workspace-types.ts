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

export interface PlannedPrototypeEdge {
  status: "planned";
  binding?: never;
  brokenReason?: never;
}

export interface InteractivePrototypeEdge {
  status: "interactive";
  binding: PrototypeBinding;
  brokenReason?: never;
}

export interface BrokenPrototypeEdge {
  status: "broken";
  brokenReason: string;
  binding?: PrototypeBinding;
}

export type PrototypeEdge = PlannedPrototypeEdge | InteractivePrototypeEdge | BrokenPrototypeEdge;

interface WorkspaceEdgeBase {
  id: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export type WorkspaceEdge =
  | (WorkspaceEdgeBase & { kind: "prototype"; prototype: PrototypeEdge })
  | (WorkspaceEdgeBase & { kind: Exclude<WorkspaceEdgeKind, "prototype">; prototype?: never });

export interface WorkspaceGraph {
  workspaceId: string;
  revision: number;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

export type WorkspaceSnapshotProvenance =
  | { kind: "workspace-created" }
  | { kind: "graph-command"; commandIds: string[] }
  | { kind: "proposal-approval"; proposalId: string; proposalRevision: number; planId?: string }
  | { kind: "artifact-publication"; revisionId: string; runId?: string; planId?: string; taskId?: string }
  | { kind: "resource-publication"; resourceRevisionId: string; runId?: string; planId?: string; taskId?: string }
  | { kind: "kernel-publication"; kernelRevisionId: string; proposalId?: string }
  | { kind: "propagation"; proposalId: string; batchId: string }
  | { kind: "plan-checkpoint"; proposalId: string; planId: string; checkpointId: string }
  | { kind: "restore"; restoredSnapshotId?: string; restoredRevisionId?: string }
  | { kind: "legacy-migration"; migration: string };

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  sequence: number;
  parentSnapshotId: string | null;
  graphRevision: number;
  kernelRevisionId: string;
  reason: string;
  provenance: WorkspaceSnapshotProvenance;
  createdByRunId: string | null;
  createdAt: number;
  graph: WorkspaceGraph;
  artifactTracks: Record<string, string>;
  artifactRevisions: Record<string, string | null>;
  resourceRevisions: Record<string, string>;
}

export interface WorkspaceGraphMutationInput {
  baseGraphRevision: number;
  expectedSnapshotId: string;
  commands: readonly WorkspaceGraphCommand[];
}

export interface WorkspaceGraphMutationResult {
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
}

export interface LayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceViewport {
  x: number;
  y: number;
  zoom: number;
}

export type WorkspaceLayoutCommand =
  | { type: "add-group"; groupId: string; label: string; bounds: LayoutBounds }
  | { type: "rename-group"; groupId: string; label: string }
  | { type: "delete-group"; groupId: string; ungroupChildren: true }
  | { type: "set-parent"; objectId: string; parentGroupId: string | null }
  | { type: "move"; objectId: string; x: number; y: number }
  | { type: "resize-group"; groupId: string; width: number; height: number }
  | { type: "set-collapsed"; groupId: string; collapsed: boolean }
  | { type: "set-viewport"; viewport: WorkspaceViewport };

export interface WorkspaceLayoutPatch {
  layoutId?: string;
  graphRevision: number;
  commands: readonly WorkspaceLayoutCommand[];
}

export interface WorkspaceLayoutNode {
  id: string;
  kind: "node";
  x: number;
  y: number;
  parentGroupId: string | null;
}

export interface WorkspaceLayoutGroup {
  id: string;
  kind: "group";
  x: number;
  y: number;
  width: number;
  height: number;
  parentGroupId: string | null;
  label: string;
  collapsed: boolean;
}

export interface WorkspaceLayout {
  workspaceId: string;
  layoutId: string;
  objects: Array<WorkspaceLayoutNode | WorkspaceLayoutGroup>;
  viewport: WorkspaceViewport;
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

interface NewWorkspaceEdgeBase {
  id: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
  prototype?: never;
}

export type NewWorkspaceEdge =
  | (NewWorkspaceEdgeBase & { kind: "prototype" })
  | (NewWorkspaceEdgeBase & { kind: Exclude<WorkspaceEdgeKind, "prototype"> });

export type WorkspaceGraphCommand =
  | { id: string; type: "add-node"; node: NewWorkspaceNode }
  | { id: string; type: "rename-node"; nodeId: string; name: string }
  | { id: string; type: "archive-node"; nodeId: string }
  | { id: string; type: "add-edge"; edge: NewWorkspaceEdge }
  | { id: string; type: "remove-edge"; edgeId: string }
  | { id: string; type: "bind-prototype"; edgeId: string; binding: PrototypeBinding };
