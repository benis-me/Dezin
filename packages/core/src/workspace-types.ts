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
export type ComponentInstanceDependencyStatus = "linked" | "detached";

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

export interface LegacyWorkspaceProjectFact {
  id: string;
  name: string;
  mode: ProjectMode;
  skillId: string | null;
  designSystemId: string | null;
  sharingan: boolean;
  sourceUrl: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  activeVariantId: string | null;
}

export interface LegacyWorkspaceVariantFact {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
}

export interface LegacyWorkspaceRunFact {
  id: string;
  projectId: string;
  variantId: string | null;
  status: "succeeded";
  commitHash: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface LegacyWorkspaceFacts {
  project: LegacyWorkspaceProjectFact;
  variants: LegacyWorkspaceVariantFact[];
  successfulRuns: LegacyWorkspaceRunFact[];
}

export type LegacyGitSnapshot =
  | {
    status: "verified";
    sourceCommitHash: string;
    sourceTreeHash: string;
    artifactRoot: ".";
  }
  | { status: "unavailable" };

export interface LegacyWorkspaceSeed extends Omit<LegacyWorkspaceFacts, "project" | "successfulRuns"> {
  version: 1;
  project: LegacyWorkspaceProjectFact & { mode: "standard" };
  successfulRuns: Array<LegacyWorkspaceRunFact & { gitSnapshot: LegacyGitSnapshot }>;
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

export interface CreateKernelRevisionInput {
  workspaceId: string;
  parentRevisionId: string;
  tokens: Record<string, string | number>;
  typography: Record<string, unknown>;
  sharedAssetRevisionIds: string[];
  brief: string;
  terminology: Record<string, string>;
  exclusions: string[];
  responsiveFrames: RenderFrameSpec[];
  qualityProfile: ArtifactQualityProfile;
}

export interface ArtifactRevisionDependencyInput {
  instanceId: string;
  componentArtifactId: string;
  componentRevisionId: string;
  createInstanceIdentity?: true;
  variantKey?: string;
  stateKey?: string;
  sourceLocator: DesignNodeLocator;
  overrides: Record<string, unknown>;
  status: ComponentInstanceDependencyStatus;
}

export interface ArtifactRevisionDependency {
  workspaceId: string;
  ownerArtifactId: string;
  revisionId: string;
  instanceId: string;
  componentArtifactId: string;
  componentRevisionId: string;
  variantKey: string | null;
  stateKey: string | null;
  sourceLocator: DesignNodeLocator;
  overrides: Record<string, unknown>;
  status: ComponentInstanceDependencyStatus;
}

export interface ArtifactRevisionResourcePinInput {
  resourceId: string;
  resourceRevisionId: string;
}

export interface ArtifactRevisionResourcePin {
  workspaceId: string;
  ownerArtifactId: string;
  revisionId: string;
  resourceId: string;
  resourceRevisionId: string;
}

export interface CreateArtifactRevisionInput {
  artifactId: string;
  trackId: string;
  parentRevisionId: string | null;
  sourceCommitHash: string;
  sourceTreeHash: string;
  kernelRevisionId: string;
  renderSpec: Record<string, unknown>;
  quality: Record<string, unknown>;
  contextPackHash?: string | null;
  producedByRunId?: string | null;
  dependencies: ArtifactRevisionDependencyInput[];
  resourcePins: ArtifactRevisionResourcePinInput[];
}

export interface WorkspaceSnapshotPublicationInput {
  expectedSnapshotId: string;
  reason: string;
  provenance: WorkspaceSnapshotProvenance;
  createdByRunId?: string | null;
}

export interface ArtifactPublicationExpectation {
  expectedHeadRevisionId: string | null;
  expectedSnapshotId: string;
}

export interface KernelPublicationExpectation {
  expectedKernelRevisionId: string;
  expectedSnapshotId: string;
}

export interface KernelImpactArtifactRevision {
  artifactId: string;
  revisionId: string;
  pinnedKernelRevisionId: string;
}

export interface KernelImpactAnalysis {
  workspaceId: string;
  baseSnapshotId: string;
  fromKernelRevisionId: string;
  toKernelRevisionId: string;
  affectedArtifactRevisions: KernelImpactArtifactRevision[];
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
  | {
      kind: "kernel-publication";
      kernelRevisionId: string;
      proposalId?: string;
      impact?: KernelImpactAnalysis;
    }
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
  baseLayoutChecksum: string;
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
  checksum: string;
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

export type WorkspaceProposalKind = "workspace-generation" | "component-propagation";
export type WorkspaceProposalStatus = "draft" | "approved" | "rejected" | "superseded" | "conflicted";
export type WorkspaceProposalApprovalMode = "structure-only" | "generate";

export type WorkspaceResourceRevisionPolicy =
  | { kind: "exact"; resourceRevisionId: string }
  | { kind: "base-snapshot" }
  | { kind: "generate" };

export interface WorkspaceGenerationResourceOperation {
  operation: "create" | "revise" | "reuse";
  nodeId: string;
  resourceId: string;
  kind: ResourceKind;
  title: string;
  revisionPolicy: WorkspaceResourceRevisionPolicy;
}

export interface WorkspaceGenerationArtifactPlan {
  operation: "create" | "revise";
  nodeId: string;
  artifactId: string;
  kind: ArtifactKind;
  name: string;
  trackId: string;
  baseRevisionId: string | null;
  dependsOnArtifactIds: string[];
  capabilityIds: string[];
  responsiveFrameIds: string[];
}

export type WorkspaceGenerationDependencyPlan =
  | {
    kind: "component-instance";
    ownerArtifactId: string;
    instanceId: string;
    componentArtifactId: string;
    componentRevisionId: string | null;
    variantKey?: string;
    stateKey?: string;
    sourceLocator: DesignNodeLocator;
    overrides: Record<string, unknown>;
    status: ComponentInstanceDependencyStatus;
  }
  | {
    kind: "resource";
    ownerArtifactId: string;
    resourceId: string;
  };

export interface WorkspaceGenerationPrototypeIntent {
  edgeId: string;
  sourceArtifactId: string;
  targetArtifactId: string;
  sourceLocator?: DesignNodeLocator;
  trigger: PrototypeTrigger;
  targetState?: string;
  transition?: PrototypeTransition;
}

export interface WorkspaceGenerationCapability {
  id: string;
  kind: "text" | "image" | "video" | "browser" | "visual-qa";
  required: boolean;
}

export interface WorkspaceGenerationPayload {
  kind: "workspace-generation";
  resourceOperations: WorkspaceGenerationResourceOperation[];
  artifactPlans: WorkspaceGenerationArtifactPlan[];
  dependencyPlans: WorkspaceGenerationDependencyPlan[];
  prototypeIntents: WorkspaceGenerationPrototypeIntent[];
  capabilities: WorkspaceGenerationCapability[];
  responsiveFrames: RenderFrameSpec[];
  qualityProfile: ArtifactQualityProfile;
}

export interface ComponentPropagationOverrideResolution {
  instanceId: string;
  resolution: "preserve" | "accept-component" | "manual";
  overrides: Record<string, unknown>;
}

export interface ComponentPropagationProposalPayload {
  kind: "component-propagation";
  impactAnalysisId: string;
  componentArtifactId: string;
  fromRevisionId: string;
  toRevisionId: string;
  selectedInstanceIds: string[];
  overrideResolutions: ComponentPropagationOverrideResolution[];
  requiredQaFrameIds: string[];
}

export type WorkspaceProposalGeneration = WorkspaceGenerationPayload | ComponentPropagationProposalPayload;

export type WorkspaceProposalReview =
  | { kind: "none" }
  | { kind: "approved"; mode: WorkspaceProposalApprovalMode }
  | { kind: "rejected" }
  | {
    kind: "conflict";
    expectedGraphRevision: number;
    actualGraphRevision: number;
    expectedSnapshotId: string;
    actualSnapshotId: string;
    expectedLayoutChecksum: string;
    actualLayoutChecksum: string;
    graphChanged: boolean;
    snapshotChanged: boolean;
    layoutChanged: boolean;
  };

export interface WorkspaceProposal {
  id: string;
  workspaceId: string;
  revision: number;
  kind: WorkspaceProposalKind;
  baseGraphRevision: number;
  baseSnapshotId: string;
  baseGraph: WorkspaceGraph;
  layoutId: string;
  baseLayoutChecksum: string;
  baseLayout: WorkspaceLayout;
  status: WorkspaceProposalStatus;
  operations: WorkspaceGraphCommand[];
  layoutOperations: WorkspaceLayoutCommand[];
  rationale: string;
  assumptions: string[];
  generation: WorkspaceProposalGeneration;
  review: WorkspaceProposalReview;
  createdByRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkspaceProposalInput {
  projectId: string;
  kind: WorkspaceProposalKind;
  baseGraphRevision: number;
  baseSnapshotId: string;
  layoutId?: string;
  baseLayoutChecksum: string;
  operations: readonly WorkspaceGraphCommand[];
  layoutOperations?: readonly WorkspaceLayoutCommand[];
  generation: WorkspaceProposalGeneration;
  rationale: string;
  assumptions: readonly string[];
  createdByRunId?: string | null;
}

export interface UpdateWorkspaceProposalInput {
  expectedProposalRevision: number;
  operations: readonly WorkspaceGraphCommand[];
  layoutOperations: readonly WorkspaceLayoutCommand[];
  generation: WorkspaceProposalGeneration;
  rationale: string;
  assumptions: readonly string[];
}

export type GenerationPlanStatus =
  | "approved"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "compile-failed"
  | "requires-new-impact"
  | "cancelled";

export interface GenerationPlan {
  id: string;
  workspaceId: string;
  proposalId: string;
  proposalRevision: number;
  baseSnapshotId: string;
  status: GenerationPlanStatus;
  compileError: Record<string, unknown> | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface ApprovedProposalResult {
  proposal: WorkspaceProposal;
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
  plan: GenerationPlan | null;
}
