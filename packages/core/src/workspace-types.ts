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

export interface Resource {
  id: string;
  workspaceId: string;
  kind: ResourceKind;
  title: string;
  headRevisionId: string | null;
  defaultPinPolicy: ResourcePinPolicy;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResourceRevision {
  id: string;
  workspaceId: string;
  resourceId: string;
  sequence: number;
  /** Head observed when this immutable candidate was created. */
  parentRevisionId: string | null;
  manifestPath: string;
  summary: string;
  metadata: Record<string, unknown>;
  checksum: string;
  provenance: Record<string, unknown>;
  createdByRunId: string | null;
  createdAt: number;
}

export interface CreateResourceForProjectInput {
  kind: ResourceKind;
  title: string;
  defaultPinPolicy: ResourcePinPolicy;
  baseGraphRevision: number;
  expectedSnapshotId: string;
}

export interface CreateResourceForProjectResult {
  resource: Resource;
  node: WorkspaceResourceNode;
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
}

export type UpdateResourceForProjectInput =
  | {
    action: "rename";
    title: string;
    baseGraphRevision: number;
    expectedSnapshotId: string;
  }
  | {
    action: "set-default-pin-policy";
    expectedDefaultPinPolicy: ResourcePinPolicy;
    defaultPinPolicy: ResourcePinPolicy;
  }
  | {
    action: "archive";
    baseGraphRevision: number;
    expectedSnapshotId: string;
    consumerImpactConfirmed: true;
  };

export type UpdateResourceForProjectResult =
  | {
    action: "rename" | "archive";
    resource: Resource;
    graph: WorkspaceGraph;
    snapshot: WorkspaceSnapshot;
  }
  | {
    action: "set-default-pin-policy";
    resource: Resource;
  };

export interface CreateResourceRevisionCandidateInput {
  /** Daemon-allocated UUID embedded in the already-frozen manifest. */
  revisionId: string;
  parentRevisionId: string | null;
  manifestPath: string;
  summary: string;
  metadata: Record<string, unknown>;
  checksum: string;
  provenance: Record<string, unknown>;
  createdByRunId?: string | null;
}

export interface ResourcePublicationExpectation {
  expectedHeadRevisionId: string | null;
  expectedSnapshotId: string;
  reason: string;
  runId?: string;
  planId?: string;
  taskId?: string;
}

/** Context Pack targets use normalized Workspace/Artifact/Resource IDs, not legacy Project IDs. */
export type ContextPackTarget =
  | { type: "workspace"; id: string }
  | { type: "artifact"; id: string }
  | { type: "resource"; id: string };

/** Resolver-facing compatibility alias for the same normalized target contract. */
export type AgentScope = ContextPackTarget;

export type AgentIntent = "plan" | "generate" | "edit" | "repair" | "analyze-impact";

export type ContextItemRefKind = "artifact" | "resource" | "kernel" | "inline";

export type ContextItemRef =
  | { kind: "resource"; id: string; resourceKind: ResourceKind; revisionId?: string }
  | { kind: "artifact"; id: string; revisionId?: string }
  | { kind: "kernel"; id: string; revisionId?: string }
  | { kind: "inline"; id: string };

export type ResolvedContextKind = "artifact-revision" | "resource-revision" | "kernel-revision" | "inline";
export type ContextTrustLevel = "system" | "trusted" | "untrusted";

export interface ResolvedContextItem {
  ordinal: number;
  ref: ContextItemRef;
  resolvedKind: ResolvedContextKind;
  artifactRevisionId: string | null;
  resourceRevisionId: string | null;
  kernelRevisionId: string | null;
  checksum: string;
  reason: string;
  trustLevel: ContextTrustLevel;
  boundary: Record<string, unknown>;
  tokenEstimate: number;
  provenance: Record<string, unknown>;
  provided: boolean;
}

export interface ContextOmission {
  ref: ContextItemRef;
  reason: string;
  tokenEstimate: number;
}

export interface ContextPack {
  id: string;
  workspaceId: string;
  graphRevision: number;
  target: ContextPackTarget;
  intent: AgentIntent;
  messageChecksum: string;
  items: ResolvedContextItem[];
  omissions: ContextOmission[];
  tokenEstimate: number;
  manifestPath: string;
  hash: string;
  createdAt: number;
}

export interface PersistContextPackItemInput {
  ref: ContextItemRef;
  resolvedKind: ResolvedContextKind;
  artifactRevisionId?: string | null;
  resourceRevisionId?: string | null;
  kernelRevisionId?: string | null;
  checksum: string;
  reason: string;
  trustLevel: ContextTrustLevel;
  boundary: Record<string, unknown>;
  tokenEstimate: number;
  provenance: Record<string, unknown>;
  provided: boolean;
}

export interface PersistContextPackInput {
  id: string;
  workspaceId: string;
  graphRevision: number;
  target: ContextPackTarget;
  intent: AgentIntent;
  messageChecksum: string;
  items: PersistContextPackItemInput[];
  omissions: ContextOmission[];
  tokenEstimate: number;
  manifestPath: string;
  hash: string;
}

export type ContextPackUsageKind = "observed-read" | "agent-declared-used";

export interface RecordContextPackItemUsageInput {
  contextPackId: string;
  workspaceId: string;
  ordinal: number;
  usageKind: ContextPackUsageKind;
  runId?: string | null;
  evidence: Record<string, unknown>;
}

export interface ContextPackItemUsage {
  contextPackId: string;
  workspaceId: string;
  ordinal: number;
  sequence: number;
  usageKind: ContextPackUsageKind;
  runId: string | null;
  evidence: Record<string, unknown>;
  recordedAt: number;
}

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
  | {
      kind: "plan-checkpoint";
      proposalId: string;
      planId: string;
      checkpointId: string;
      validatedSnapshotId?: string;
      validationEvidenceHash?: string;
    }
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

interface WorkspaceGenerationResourceOperationBase {
  nodeId: string;
  resourceId: string;
  kind: ResourceKind;
  title: string;
}

export type WorkspaceGenerationResourceOperation =
  | (WorkspaceGenerationResourceOperationBase & {
    operation: "create" | "revise";
    revisionPolicy: { kind: "generate" };
  })
  | (WorkspaceGenerationResourceOperationBase & {
    operation: "reuse";
    revisionPolicy: Extract<WorkspaceResourceRevisionPolicy, { kind: "exact" | "base-snapshot" }>;
  });

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
  constructionSealed: boolean;
  compileError: Record<string, unknown> | null;
  createdAt: number;
  finishedAt: number | null;
}

export type GenerationTaskKind =
  | "resource"
  | "component"
  | "page"
  | "prototype-validation"
  | "checkpoint"
  | "propagation-candidate"
  | "propagation-publish";

export type GenerationTaskTarget =
  | { type: "workspace"; workspaceId: string; id: string }
  | { type: "artifact"; workspaceId: string; id: string; trackId: string }
  | { type: "resource"; workspaceId: string; id: string };

export type GenerationTaskStatus =
  | "materialization-pending"
  | "retry-wait"
  | "blocked-context"
  | "queued"
  | "running"
  | "candidate-ready"
  | "needs-rebase"
  | "awaiting-context-refresh"
  | "cancel-requested"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type GenerationTaskAttemptStatus =
  | "queued"
  | "running"
  | "cancel-requested"
  | "candidate-ready"
  | "succeeded"
  | "retryable-failed"
  | "failed"
  | "needs-rebase"
  | "cancelled";

export type GenerationTaskExecutionMode = "full" | "publication-only";
export type GenerationTaskRetryContextPolicy = "same-context" | "latest-context";
export type GenerationTaskAttemptOrigin = "materialized" | "same-input-retry" | "publication-retry";
export type GenerationTaskCapacityClass = "agent" | "render-qa" | "image";
export type GenerationTaskClaimKind = "capacity" | "writer";
export type GenerationTaskCapacityClaimKey =
  | "capacity:agent:1"
  | "capacity:agent:2"
  | "capacity:agent:3"
  | "capacity:render-qa:1"
  | "capacity:render-qa:2"
  | "capacity:image:1"
  | "capacity:image:2";
export type GenerationTaskWriterClaimKey =
  | `writer:artifact:${string}:${string}`
  | `writer:resource:${string}:${string}`
  | `writer:checkpoint:${string}`
  | `writer:kernel:${string}`
  | `writer:source:${string}`;
export type GenerationTaskClaimKey = GenerationTaskCapacityClaimKey | GenerationTaskWriterClaimKey;

export type GenerationTaskFailureClass =
  | "context"
  | "adapter"
  | "storage"
  | "provider"
  | "agent-transport"
  | "build-infrastructure"
  | "design"
  | "build"
  | "qa"
  | "publication-conflict"
  | "cancelled"
  | "unknown";

export interface RecordGenerationTaskMaterializationFailureInput {
  taskId: string;
  expectedFailureCount: number;
  failureClass: GenerationTaskFailureClass;
  error: Record<string, unknown>;
  nextEligibleAt: number | null;
}

export interface GenerationTaskMaterializationFailure
  extends Omit<RecordGenerationTaskMaterializationFailureInput, "expectedFailureCount"> {
  planId: string;
  workspaceId: string;
  sequence: number;
  createdAt: number;
}

export interface GenerationTaskResourceLimits {
  timeoutMs: number;
  maxAgentTurns: number;
  maxRepairRounds: number;
  maxOutputBytes: number;
  capacityClasses: GenerationTaskCapacityClass[];
}

export interface GenerationTaskIntentInput {
  id: string;
  ordinal: number;
  workspaceId: string;
  planId: string;
  kind: GenerationTaskKind;
  target: GenerationTaskTarget;
  dependencyIds: string[];
  payload: Record<string, unknown>;
  capabilities: string[];
  qaProfile: ArtifactQualityProfile;
  resourceLimits: GenerationTaskResourceLimits;
}

export interface GenerationTaskIntent extends GenerationTaskIntentInput {
  /** Hash of the complete canonical, immutable task intent. */
  intentHash: string;
  /** Stable retry-independent key for this Plan task identity and intent. */
  idempotencyKey: string;
}

export interface GenerationTask extends GenerationTaskIntent {
  status: GenerationTaskStatus;
  blockedReason: string | null;
  blockedByTaskId: string | null;
  pendingContextPolicy: GenerationTaskRetryContextPolicy | null;
  currentAttempt: number;
  materializationFailures: number;
  failureClass: GenerationTaskFailureClass | null;
  error: Record<string, unknown> | null;
  nextEligibleAt: number | null;
  resultRevisionId: string | null;
  resultResourceRevisionId: string | null;
  resultSnapshotId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface GenerationTaskDependency {
  planId: string;
  taskId: string;
  dependencyTaskId: string;
  ordinal: number;
}

export interface GenerationTaskAttemptDependencyOutputInput {
  taskId: string;
  resultRevisionId: string | null;
  resultResourceRevisionId: string | null;
  resultSnapshotId: string | null;
}

export interface GenerationTaskAttemptDependencyOutput extends GenerationTaskAttemptDependencyOutputInput {
  ordinal: number;
}

export interface GenerationTaskAttemptResourcePinInput {
  resourceId: string;
  revisionId: string;
  sourceTaskId: string | null;
}

export interface GenerationTaskAttemptResourcePin extends GenerationTaskAttemptResourcePinInput {
  ordinal: number;
}

export interface GenerationTaskAttemptComponentPinInput {
  instanceId: string;
  ownerArtifactId: string;
  componentArtifactId: string;
  revisionId: string;
  sourceTaskId: string | null;
  variantKey: string | null;
  stateKey: string | null;
  sourceLocator: DesignNodeLocator;
  overrides: Record<string, unknown>;
  status: ComponentInstanceDependencyStatus;
}

export interface GenerationTaskAttemptComponentPin extends GenerationTaskAttemptComponentPinInput {
  ordinal: number;
  designNodeId: string;
}

export interface CreateGenerationTaskAttemptInput {
  taskId: string;
  planId: string;
  workspaceId: string;
  attempt: number;
  target: GenerationTaskTarget;
  baseRevisionId: string | null;
  expectedSnapshotId: string;
  contextPackId: string | null;
  kernelRevisionId: string;
  payload: Record<string, unknown>;
  dependencyOutputs: GenerationTaskAttemptDependencyOutputInput[];
  resourcePins: GenerationTaskAttemptResourcePinInput[];
  componentPins: GenerationTaskAttemptComponentPinInput[];
  retryContextPolicy: GenerationTaskRetryContextPolicy;
  executionMode: GenerationTaskExecutionMode;
}

export type GenerationTaskMaterializationObservation = Omit<
  CreateGenerationTaskAttemptInput,
  "contextPackId" | "retryContextPolicy" | "executionMode"
>;

export interface GenerationTaskAttemptInput extends Omit<
  CreateGenerationTaskAttemptInput,
  "dependencyOutputs" | "resourcePins" | "componentPins"
> {
  dependencyOutputs: GenerationTaskAttemptDependencyOutput[];
  resourcePins: GenerationTaskAttemptResourcePin[];
  componentPins: GenerationTaskAttemptComponentPin[];
  inputHash: string;
}

export type GenerationTaskAttemptHashInput = Omit<GenerationTaskAttemptInput, "inputHash">;

export interface GenerationTaskCandidateEvidenceHashInput {
  taskId: string;
  planId: string;
  workspaceId: string;
  attempt: number;
  candidateRevisionId: string | null;
  candidateResourceRevisionId: string | null;
  candidateEvidence: Record<string, unknown>;
}

export interface GenerationTaskArtifactCandidateInput {
  kind: "artifact";
  sourceCommitHash: string;
  sourceTreeHash: string;
  renderSpec: Record<string, unknown>;
  quality: Record<string, unknown>;
}

export interface GenerationTaskResourceCandidateInput {
  kind: "resource";
  /** Executor-reported identity, checked against the immutable Attempt target. */
  resourceId: string;
  revision: CreateResourceRevisionCandidateInput;
}

export type GenerationTaskCandidateInput =
  | GenerationTaskArtifactCandidateInput
  | GenerationTaskResourceCandidateInput;

export interface StageGenerationTaskCandidateInput {
  lease: GenerationTaskAttemptLease;
  candidate: GenerationTaskArtifactCandidateInput;
  evidence: Record<string, unknown>;
}

export type StageGenerationTaskArtifactCandidateInput = StageGenerationTaskCandidateInput;

export interface StageGenerationTaskResourceCandidateInput {
  lease: GenerationTaskAttemptLease;
  candidate: GenerationTaskResourceCandidateInput;
  evidence: Record<string, unknown>;
}

export type AnyStageGenerationTaskCandidateInput =
  | StageGenerationTaskArtifactCandidateInput
  | StageGenerationTaskResourceCandidateInput;

export interface PublishGenerationTaskCandidateInput {
  lease: GenerationTaskAttemptLease;
}

export interface FinishGenerationTaskAttemptFailureInput {
  lease: GenerationTaskAttemptLease;
  failure: {
    failureClass: GenerationTaskFailureClass;
    error: Record<string, unknown>;
  };
}

export interface CompleteGenerationTaskValidationInput {
  lease: GenerationTaskAttemptLease;
  validation: {
    snapshotId: string;
    graphRevision: number;
    artifactRevisionIds: string[];
    resourceRevisionIds: string[];
    evidence: Record<string, unknown>;
  };
}

export interface GenerationTaskValidationRecord {
  taskId: string;
  planId: string;
  workspaceId: string;
  attempt: number;
  snapshotId: string;
  graphRevision: number;
  artifactRevisionIds: string[];
  resourceRevisionIds: string[];
  evidence: Record<string, unknown>;
  evidenceHash: string;
  validationFenceHash: string;
  createdAt: number;
}

export interface PublishGenerationPlanCheckpointInput {
  lease: GenerationTaskAttemptLease;
}

export interface GenerationTaskAttemptLease {
  taskId: string;
  workspaceId: string;
  attempt: number;
  ownerId: string;
  leaseToken: string;
}

export interface TryClaimGenerationTaskAttemptInput {
  taskId: string;
  attempt: number;
  ownerId: string;
  now: number;
  leaseMs: number;
}

export interface HeartbeatGenerationTaskAttemptInput extends GenerationTaskAttemptLease {
  now: number;
  leaseMs: number;
}

export interface GenerationTaskAttempt extends GenerationTaskAttemptInput {
  attemptOrigin: GenerationTaskAttemptOrigin;
  predecessorAttempt: number | null;
  automaticRetryIndex: number;
  status: GenerationTaskAttemptStatus;
  blockedReason: string | null;
  failureClass: GenerationTaskFailureClass | null;
  error: Record<string, unknown> | null;
  nextEligibleAt: number | null;
  candidateRevisionId: string | null;
  candidateResourceRevisionId: string | null;
  candidateEvidence: Record<string, unknown> | null;
  candidateEvidenceHash: string | null;
  lease: GenerationTaskAttemptLease | null;
  leaseExpiresAt: number | null;
  heartbeatAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GenerationTaskClaim extends GenerationTaskAttemptLease {
  planId: string;
  claimKey: GenerationTaskClaimKey;
  claimKind: GenerationTaskClaimKind;
  leaseExpiresAt: number;
  createdAt: number;
}

export interface GenerationTaskExecutionLease extends GenerationTaskAttemptLease {
  planId: string;
  leaseExpiresAt: number;
  heartbeatAt: number;
  claims: GenerationTaskClaim[];
}

export interface GenerationTaskAttemptClaim {
  /** Exact current aggregate Task as committed by the same claim transaction. */
  task: GenerationTask;
  attempt: GenerationTaskAttempt;
  lease: GenerationTaskAttemptLease;
  claims: GenerationTaskClaim[];
}

export interface GenerationTaskRecoverySummary {
  planIds: string[];
  retriedTaskIds: string[];
  needsRebaseTaskIds: string[];
  cancelledTaskIds: string[];
  failedTaskIds: string[];
}

export type GenerationPlanEventType =
  | "plan-queued"
  | "plan-compile-failed"
  | "task-materialization-failed"
  | "task-blocked-context"
  | "task-materialized"
  | "task-running"
  | "task-candidate-ready"
  | "task-needs-rebase"
  | "task-retry-wait"
  | "task-succeeded"
  | "task-failed"
  | "task-blocked"
  | "task-cancel-requested"
  | "task-cancelled"
  | "plan-succeeded"
  | "plan-failed"
  | "plan-cancelled";

export interface GenerationPlanEvent {
  planId: string;
  sequence: number;
  taskId: string | null;
  type: GenerationPlanEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ListGenerationPlanEventsInput {
  after: number;
  limit: number;
}

export interface GenerationPlanGraph {
  id: string;
  workspaceId: string;
  proposalId: string;
  proposalRevision: number;
  baseSnapshotId: string;
  tasks: GenerationTaskIntent[];
  dependencies: GenerationTaskDependency[];
}

export interface GenerationPlanDetail {
  plan: GenerationPlan;
  tasks: GenerationTask[];
  dependencies: GenerationTaskDependency[];
}

export interface ApprovedProposalResult {
  proposal: WorkspaceProposal;
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
  layout: WorkspaceLayout;
  plan: GenerationPlan | null;
}
