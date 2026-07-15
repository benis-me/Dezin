/**
 * Typed client for the Dezin daemon. fetch is injectable so it can be unit-tested
 * with a mock (no live daemon). Types mirror @dezin/core but are declared locally —
 * the browser bundle must not import the node packages.
 */

export type ProjectMode = "prototype" | "standard";

export type ExtensionScope = "capture:write" | "image:analyze";
export interface ExtensionCredential {
  id: string;
  extensionId: string;
  scopes: ExtensionScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface Project {
  id: string;
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  mode: ProjectMode;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  hasArtifact?: boolean;
  /** A screenshot of the generated design, used as the gallery cover. */
  coverUrl?: string | null;
  /** Active generation state for the project card, if a run is still in flight. */
  runStatus?: "pending" | "running" | null;
  /** Absolute on-disk project folder, when served by the local daemon. */
  projectPath?: string;
  /** Whether this project was created by cloning a website via Sharingan. */
  sharingan?: boolean;
  /** The source URL Sharingan cloned this project from, when sharingan is true. */
  sourceUrl?: string;
}

export type WorkspaceNodeKind = "page" | "component" | "resource";
export type WorkspaceEdgeKind = "prototype" | "uses" | "informs" | "derives-from";
export type WorkspaceArtifactKind = "page" | "component";
export type WorkspacePrototypeEdgeStatus = "planned" | "interactive" | "broken";

export interface WorkspaceQualityFinding {
  severity: "P0" | "P1" | "P2";
  id: string;
  message: string;
  fix: string;
  snippet?: string;
  selector?: string;
  screenshotPath?: string;
  screenshotUrl?: string;
  reviewSummary?: string;
  reviewStatus?: "active" | "resolved";
  reviewRound?: number;
  corroborated?: boolean;
}

export interface WorkspaceArtifactQualitySummary {
  state: "passed" | "needs-attention" | "failed" | "unassessed";
  score: number | null;
  findings: WorkspaceQualityFinding[];
}

interface WorkspaceNodeBase {
  id: string;
  workspaceId: string;
  name: string;
}

export interface WorkspaceArtifactNode extends WorkspaceNodeBase {
  kind: WorkspaceArtifactKind;
  artifactId: string;
  resourceId?: never;
  quality?: WorkspaceArtifactQualitySummary;
}

export interface WorkspaceResourceNode extends WorkspaceNodeBase {
  kind: "resource";
  resourceId: string;
  artifactId?: never;
}

export type WorkspaceNode = WorkspaceArtifactNode | WorkspaceResourceNode;

export interface WorkspaceDesignNodeLocator {
  designNodeId: string;
  sourcePath?: string;
  selector?: string;
}

export interface WorkspacePrototypeBinding {
  sourceArtifactId: string;
  sourceRevisionId: string;
  sourceLocator: WorkspaceDesignNodeLocator;
  trigger: "click" | "submit";
  targetArtifactId: string;
  targetState?: string;
  transition?: {
    type: "none" | "fade" | "slide";
    durationMs?: number;
    easing?: string;
  };
}

interface WorkspaceEdgeBase {
  id: string;
  workspaceId: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export type WorkspaceEdge =
  | (WorkspaceEdgeBase & {
      kind: "prototype";
      prototype:
        | { status: "planned"; binding?: never; brokenReason?: never }
        | { status: "interactive"; binding: WorkspacePrototypeBinding; brokenReason?: never }
        | { status: "broken"; binding?: WorkspacePrototypeBinding; brokenReason: string };
    })
  | (WorkspaceEdgeBase & { kind: Exclude<WorkspaceEdgeKind, "prototype">; prototype?: never });

export interface WorkspaceGraph {
  workspaceId: string;
  revision: number;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
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

export interface WorkspaceArtifact {
  id: string;
  workspaceId: string;
  kind: WorkspaceArtifactKind;
  name: string;
  sourceRoot: string;
  legacyWrapped: boolean;
  activeTrackId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceArtifactPayload = WorkspaceArtifact;

export interface ArtifactTrack {
  id: string;
  artifactId: string;
  name: string;
  headRevisionId: string | null;
  legacyVariantId: string | null;
  createdAt: number;
}

export interface ArtifactRevision {
  id: string;
  workspaceId: string;
  artifactId: string;
  trackId: string;
  sequence: number;
  parentRevisionId: string | null;
  sourceCommitHash: string;
  sourceTreeHash: string;
  artifactRoot: string;
  kernelRevisionId: string;
  renderSpec: Record<string, unknown>;
  quality: Record<string, unknown>;
  contextPackHash: string | null;
  producedByRunId: string | null;
  legacyRunId: string | null;
  createdAt: number;
}

export type PreviewTarget =
  | { kind: "artifact-current"; projectId: string; artifactId: string; trackId?: string }
  | { kind: "artifact-revision"; projectId: string; revisionId: string }
  | { kind: "run-candidate"; projectId: string; runId: string }
  | { kind: "workspace-flow"; projectId: string; snapshotId: string; startArtifactId: string }
  | { kind: "component-state"; projectId: string; revisionId: string; variantKey: string; stateKey: string };

/** Immutable identity returned by PreviewTarget resolution and revalidated on lease acquire. */
export interface ResolvedPreviewTarget {
  version: 1;
  targetKey: string;
  requestedKind: PreviewTarget["kind"];
  projectId: string;
  workspaceId: string;
  artifactId: string;
  artifactKind: WorkspaceArtifactKind;
  revisionId: string;
  trackId: string;
  snapshotId: string | null;
  sourceCommitHash: string;
  sourceTreeHash: string;
  dependencyLockHash: string;
  assemblyHash: string;
  artifactRoot: string;
  renderSpec: Record<string, unknown>;
  variantKey: string | null;
  stateKey: string | null;
  runId: string | null;
}

export type DirectTokenProperty =
  | "color"
  | "background-color"
  | "border-color"
  | "font-family"
  | "font-size"
  | "border-radius";

export interface SupportedLayoutPatch {
  width?: number | "auto" | "fill";
  height?: number | "auto" | "fill";
  padding?: number;
  gap?: number;
  alignment?: "start" | "center" | "end" | "stretch";
  visibility?: "visible" | "hidden";
}

export type DirectArtifactMutationCommand =
  | {
      type: "set-text";
      locator: WorkspaceDesignNodeLocator;
      expectedCurrentValue: string;
      value: string;
    }
  | { type: "set-accessible-label"; locator: WorkspaceDesignNodeLocator; value: string }
  | { type: "set-asset"; locator: WorkspaceDesignNodeLocator; resourceRevisionId: string }
  | { type: "set-token"; locator: WorkspaceDesignNodeLocator; property: DirectTokenProperty; token: string }
  | { type: "set-layout"; locator: WorkspaceDesignNodeLocator; patch: SupportedLayoutPatch };

export type ArtifactMutationCommand = DirectArtifactMutationCommand;

export interface ArtifactMutationInput {
  expectedHeadRevisionId: string;
  expectedSnapshotId: string;
  command: ArtifactMutationCommand;
}

export interface ArtifactMutationResult {
  revision: ArtifactRevision;
  snapshot: WorkspaceSnapshot;
}

export interface WorkspaceRenderFrameSpec {
  id: string;
  name: string;
  width: number;
  height: number;
  initialState?: string;
  fixture?: Record<string, unknown>;
  background?: string;
}

export interface WorkspaceArtifactQualityProfile {
  requiredFrameIds: string[];
  blockingSeverities: WorkspaceQualityFinding["severity"][];
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
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
  responsiveFrames: WorkspaceRenderFrameSpec[];
  qualityProfile: WorkspaceArtifactQualityProfile;
  checksum: string;
  createdAt: number;
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

export type WorkspaceSnapshotProvenance =
  | { kind: "workspace-created" }
  | { kind: "graph-command"; commandIds: string[] }
  | { kind: "proposal-approval"; proposalId: string; proposalRevision: number; planId?: string }
  | { kind: "artifact-publication"; revisionId: string; runId?: string; planId?: string; taskId?: string }
  | { kind: "resource-publication"; resourceRevisionId: string; runId?: string; planId?: string; taskId?: string }
  | { kind: "kernel-publication"; kernelRevisionId: string; proposalId?: string; impact?: KernelImpactAnalysis }
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

export interface WorkspaceViewport {
  x: number;
  y: number;
  zoom: number;
}

export type WorkspaceLayoutCommand =
  | { type: "add-group"; groupId: string; label: string; bounds: { x: number; y: number; width: number; height: number } }
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

export type WorkspaceLayoutObject =
  | { id: string; kind: "node"; x: number; y: number; parentGroupId: string | null }
  | {
      id: string;
      kind: "group";
      x: number;
      y: number;
      width: number;
      height: number;
      parentGroupId: string | null;
      label: string;
      collapsed: boolean;
    };

export interface WorkspaceLayout {
  workspaceId: string;
  layoutId: string;
  objects: WorkspaceLayoutObject[];
  viewport: WorkspaceViewport;
  checksum: string;
}

export type WorkspaceProposalKind = "workspace-generation" | "component-propagation";
export type WorkspaceProposalStatus = "draft" | "approved" | "rejected" | "superseded" | "conflicted";
export type WorkspaceProposalApprovalMode = "structure-only" | "generate";
export type WorkspaceResourceKind =
  | "research"
  | "moodboard"
  | "sharingan-capture"
  | "file"
  | "asset"
  | "effect"
  | "external-reference";
export type ResourcePinPolicy = "follow-head" | "pin-current" | "manual";

export interface Resource {
  id: string;
  workspaceId: string;
  kind: WorkspaceResourceKind;
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
  parentRevisionId: string | null;
  manifestPath: string;
  summary: string;
  metadata: Record<string, unknown>;
  checksum: string;
  provenance: Record<string, unknown>;
  createdByRunId: string | null;
  createdAt: number;
}

export interface CreateResourceInput {
  kind: WorkspaceResourceKind;
  title: string;
  defaultPinPolicy: ResourcePinPolicy;
  baseGraphRevision: number;
  expectedSnapshotId: string;
}

export type UpdateResourceInput =
  | { action: "rename"; title: string; baseGraphRevision: number; expectedSnapshotId: string }
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

/** Client-safe source identities. The daemon derives bytes, metadata, provenance, and checksums. */
export type ResourceRevisionOwnedSource =
  | { type: "moodboard"; moodboardId: string }
  | { type: "effect"; effectId: string }
  | { type: "uploaded-file"; uploadedFileId: string }
  | { type: "asset"; assetId: string }
  | { type: "external-reference"; url: string };

export interface CreateResourceRevisionInput {
  expectedHeadRevisionId: string | null;
  source: ResourceRevisionOwnedSource;
}

export interface PublishResourceRevisionInput {
  expectedHeadRevisionId: string | null;
  expectedSnapshotId: string;
  reason: string;
  runId?: string;
  planId?: string;
  taskId?: string;
}

export interface CreateResourceResult {
  resource: Resource;
  node: WorkspaceResourceNode;
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
}
export type CreateResourceForProjectResult = CreateResourceResult;

export type UpdateResourceResult =
  | { action: "rename" | "archive"; resource: Resource; graph: WorkspaceGraph; snapshot: WorkspaceSnapshot }
  | { action: "set-default-pin-policy"; resource: Resource };
export type UpdateResourceForProjectResult = UpdateResourceResult;

export type WorkspaceResourceRevisionPolicy =
  | { kind: "exact"; resourceRevisionId: string }
  | { kind: "base-snapshot" }
  | { kind: "generate" };

interface WorkspaceGenerationResourceOperationBase {
  nodeId: string;
  resourceId: string;
  kind: WorkspaceResourceKind;
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
  kind: WorkspaceArtifactKind;
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
      sourceLocator: WorkspaceDesignNodeLocator;
      overrides: Record<string, unknown>;
      status: "linked" | "detached";
    }
  | { kind: "resource"; ownerArtifactId: string; resourceId: string };

export interface WorkspaceGenerationPrototypeIntent {
  edgeId: string;
  sourceArtifactId: string;
  targetArtifactId: string;
  sourceLocator?: WorkspaceDesignNodeLocator;
  trigger: WorkspacePrototypeBinding["trigger"];
  targetState?: string;
  transition?: WorkspacePrototypeBinding["transition"];
}

export interface WorkspaceGenerationCapability {
  id: string;
  kind: "text" | "image" | "video" | "browser" | "visual-qa";
  required: boolean;
}

export interface WorkspaceRenderFrameSpec {
  id: string;
  name: string;
  width: number;
  height: number;
  initialState?: string;
  fixture?: Record<string, unknown>;
  background?: string;
}

export interface WorkspaceArtifactQualityProfile {
  requiredFrameIds: string[];
  blockingSeverities: WorkspaceQualityFinding["severity"][];
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
}

export interface WorkspaceGenerationPayload {
  kind: "workspace-generation";
  resourceOperations: WorkspaceGenerationResourceOperation[];
  artifactPlans: WorkspaceGenerationArtifactPlan[];
  dependencyPlans: WorkspaceGenerationDependencyPlan[];
  prototypeIntents: WorkspaceGenerationPrototypeIntent[];
  capabilities: WorkspaceGenerationCapability[];
  responsiveFrames: WorkspaceRenderFrameSpec[];
  qualityProfile: WorkspaceArtifactQualityProfile;
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
  layout: WorkspaceLayout;
  plan: GenerationPlan | null;
}

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
  | {
      id: string;
      type: "add-node";
      node:
        | { id: string; kind: WorkspaceArtifactKind; name: string; artifactId: string; createIdentity?: { initialTrackId: string } }
        | {
            id: string;
            kind: "resource";
            name: string;
            resourceId: string;
            createIdentity?: {
              resourceKind: "research" | "moodboard" | "sharingan-capture" | "file" | "asset" | "effect" | "external-reference";
              defaultPinPolicy: "follow-head" | "pin-current" | "manual";
            };
          };
    }
  | { id: string; type: "rename-node"; nodeId: string; name: string }
  | { id: string; type: "archive-node"; nodeId: string }
  | {
      id: string;
      type: "add-edge";
      edge: NewWorkspaceEdge;
    }
  | { id: string; type: "remove-edge"; edgeId: string }
  | { id: string; type: "bind-prototype"; edgeId: string; binding: WorkspacePrototypeBinding };

export interface GraphCommandRequest {
  baseGraphRevision: number;
  expectedSnapshotId: string;
  commands: readonly WorkspaceGraphCommand[];
}

export interface WorkspaceGraphMutationResult {
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
}

export interface ReadyProjectWorkspacePayload {
  status: "ready";
  workspace: ProjectWorkspace;
  graph: WorkspaceGraph;
  activeSnapshot: WorkspaceSnapshot;
  activeKernelRevision: SharedDesignKernelRevision;
  artifacts: WorkspaceArtifact[];
  tracks: ArtifactTrack[];
  revisions: ArtifactRevision[];
  snapshots: WorkspaceSnapshot[];
  layout: WorkspaceLayout;
}

export interface UnsupportedProjectWorkspacePayload {
  status: "unsupported";
  code: "workspace_requires_standard_project";
  projectId: string;
  projectMode: "prototype";
}

export type ProjectWorkspacePayload = ReadyProjectWorkspacePayload | UnsupportedProjectWorkspacePayload;

export type SetupPhase = "scaffolding" | "installing" | "ready" | "error";
export interface SetupStatus {
  phase: SetupPhase;
  error?: string;
  logs?: Array<{ at: number; level: "info" | "error"; message: string }>;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  scope: ConversationScope;
  createdAt: number;
  turns?: number;
}

export interface Variant {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  active?: boolean;
}

export interface MessageForkResult {
  conversationId: string;
  variantId: string;
  variants: Variant[];
  assetsRestored?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

export interface CreateProjectInput {
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  mode?: ProjectMode;
  sharingan?: boolean;
  sourceUrl?: string;
}

export type MoodboardNodeType = "image" | "image-generator" | "note" | "section" | "video";

export interface Moodboard {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  coverAssetId?: string | null;
  coverUrl?: string | null;
}

export interface MoodboardAsset {
  id: string;
  boardId: string;
  kind: "image" | "video";
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  source: "upload" | "generated" | "edited";
  createdAt: number;
  url?: string;
}

export interface MoodboardNode {
  id: string;
  boardId: string;
  type: MoodboardNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SaveMoodboardNodeInput {
  id?: string;
  type: MoodboardNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex?: number;
  data?: Record<string, unknown>;
}

export interface StartMoodboardInput {
  name: string;
  prompt?: string;
  mode: "agent" | "generate";
  images?: Array<{
    name: string;
    contentBase64: string;
    mimeType?: string;
    width?: number;
    height?: number;
  }>;
  agentCommand?: string;
  agentModel?: string;
  imageModel?: string;
}

export interface MoodboardMessage {
  id: string;
  boardId: string;
  conversationId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

export interface MoodboardConversation {
  id: string;
  boardId: string;
  title: string;
  createdAt: number;
  turns?: number;
}

export type ImageGenerationParams = {
  quality?: "auto" | "low" | "medium" | "high";
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  background?: "auto" | "transparent" | "opaque";
  outputFormat?: "png" | "jpeg" | "webp";
  outputCompression?: number;
  moderation?: "auto" | "low";
  count?: number;
};

export interface GenerateMoodboardImageOptions {
  x?: number;
  y?: number;
  generatorId?: string;
  model?: string;
  sourceAssetId?: string;
  referenceAssetIds?: string[];
  conversationId?: string;
  params?: ImageGenerationParams;
}

export interface MoodboardDetail extends Moodboard {
  assets: MoodboardAsset[];
  nodes: MoodboardNode[];
  conversations?: MoodboardConversation[];
  activeConversationId?: string;
  messages: MoodboardMessage[];
}

export interface ResearchSourceItem {
  id?: string;
  kind?: string;
  title?: string;
  url?: string;
  takeaways?: string[];
  assets?: string[];
  /** Visual-track fields (dribbble/behance/etc.) — absent on product sources. */
  platform?: string;
  designer?: string;
  reached?: boolean;
  authority?: string;
}
/** The .research/ deliverables for the Research tab. `exists:false` → hide the tab. */
export interface ResearchDetail {
  exists: boolean;
  /** Full Research evidence/directions validation; partial artifacts may still exist when false. */
  complete?: boolean;
  issues?: Array<{ area: "product" | "visual" | "directions"; code: string; message: string; path?: string }>;
  report?: string;
  sources?: ResearchSourceItem[];
  directions?: Array<{ slug: string; title: string; markdown: string }>;
  assets?: string[];
  /** The candidate direction the user picked at the gate, if any. */
  chosenSlug?: string;
  /** The parallel visual-research track's deliverables, if the visual track ran. */
  visual?: {
    exists: boolean;
    report: string;
    sources: ResearchDetail["sources"];
    assets: string[];
    boardId?: string;
  };
}

export interface RunInput {
  projectId: string;
  brief: string;
  conversationId?: string;
  variantId?: string;
  maxRounds?: number;
  moodboardRefs?: Array<{ id: string; name?: string }>;
  effectRefs?: Array<{ id: string; name?: string }>;
  /** Standard-mode explicit context. The daemon resolves these immutable identities into a Context Pack. */
  contextRefs?: RunContextRef[];
  /** Standard-mode target selection. Selection is never serialized into the visible message. */
  selection?: RunSelectionRef[];
  /** Per-run overrides (fall back to Settings). */
  agentCommand?: string;
  model?: string;
  /** Chosen design direction slug — skips the direction gate; the build uses this direction. */
  directionSlug?: string;
  /** Explicit Research opt-out: `false` skips the Research phase even when it's enabled in Settings (repair runs use this). */
  research?: boolean;
}

export type WorkspaceContextResourceKind = WorkspaceResourceKind;

/** Browser-local mirror of the Core Context Pack identity contract. */
export type ContextItemRefKind = "artifact" | "resource" | "kernel" | "inline";

export type ContextItemRef =
  | { kind: "resource"; id: string; resourceKind: WorkspaceContextResourceKind; revisionId?: string }
  | { kind: "artifact"; id: string; revisionId?: string }
  | { kind: "kernel"; id: string; revisionId?: string }
  | { kind: "inline"; id: string };

/**
 * Pre-canonical run context accepted at the web boundary. The daemon snapshots owned sources or
 * persists bounded inline content before translating these to canonical ContextItemRef identities.
 */
export type RunContextRef =
  | ContextItemRef
  | {
      kind: "owned-source";
      id: string;
      title: string;
      resourceKind: Exclude<WorkspaceContextResourceKind, "research" | "sharingan-capture">;
      source: ResourceRevisionOwnedSource;
    }
  | {
      kind: "inline";
      id: string;
      title: string;
      content: string;
      trustLevel: "untrusted";
    };

export type SelectionRef = {
  kind: "node" | "artifact" | "resource" | "element";
  id: string;
  revisionId?: string;
};

export type RunSelectionRef = SelectionRef & { locator?: Record<string, unknown> };

export type ConversationScope =
  | { type: "workspace"; id: string }
  | { type: "artifact"; id: string }
  | { type: "resource"; id: string };

export type AgentScope = ConversationScope;

export type AgentIntent = "plan" | "generate" | "edit" | "repair" | "analyze-impact";

export interface AgentTurnRequest {
  scope: AgentScope;
  intent: AgentIntent;
  message: string;
  explicitContext: ContextItemRef[];
  graphRevision: number;
  baseRevisionId?: string;
  selection?: SelectionRef[];
}

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

/** Immutable daemon-owned result; it is carried by run orchestration, not a public Task 11 route. */
export interface ContextPack {
  id: string;
  workspaceId: string;
  graphRevision: number;
  target: AgentScope;
  intent: AgentIntent;
  messageChecksum: string;
  items: ResolvedContextItem[];
  omissions: ContextOmission[];
  tokenEstimate: number;
  manifestPath: string;
  hash: string;
  createdAt: number;
}

export const RUN_CONTEXT_MAX_ITEMS = 32;
export const RUN_CONTEXT_MAX_TITLE_CHARS = 256;
export const RUN_CONTEXT_MAX_INLINE_CHARS = 20_000;
export const RUN_CONTEXT_MAX_TOTAL_INLINE_CHARS = 64_000;

export interface PromptOptimizeInput {
  prompt: string;
  agentCommand?: string;
  model?: string;
  mode?: ProjectMode;
  skillId?: string;
  designSystemId?: string;
}

export interface PromptOptimizeResult {
  prompt: string;
}

export interface Swatch {
  bg: string;
  surface: string;
  fg: string;
  accent: string;
}

export interface DesignSystemCard {
  id: string;
  name: string;
  category: string;
  summary: string;
  swatch?: Swatch;
  origin?: "built-in" | "custom";
}

export interface DesignSystemDetail extends DesignSystemCard {
  designMd: string;
  tokensCss: string;
}

export type EffectOrigin = "built-in" | "custom";
export type EffectParamKind = "number" | "color" | "select" | "boolean" | "image";
export type EffectParamValue = string | number | boolean;

export interface EffectParamOption {
  label: string;
  value: string;
}

export interface EffectParamDefinition {
  id: string;
  label: string;
  type: EffectParamKind;
  defaultValue: EffectParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: EffectParamOption[];
  description?: string;
}

export interface EffectPreset {
  id: string;
  name: string;
  values: Record<string, EffectParamValue>;
}

export interface EffectCard {
  id: string;
  name: string;
  origin: EffectOrigin;
  category: string;
  summary: string;
  previewUrl?: string;
}

export interface EffectDetail extends EffectCard {
  parameters: EffectParamDefinition[];
  presets: EffectPreset[];
  code: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateEffectInput {
  name: string;
}

export type UpdateEffectInput = Partial<Pick<EffectDetail, "name" | "category" | "summary" | "code" | "parameters" | "presets">>;

export interface BrandImportInput {
  name: string;
  accent: string;
  displayFont?: string;
  bodyFont?: string;
  vibe?: string;
  category?: string;
  agentCommand?: string;
  model?: string;
}

export interface SkillCard {
  id: string;
  name: string;
  description: string;
  mode: string;
  triggers: string[];
  designSystem: boolean;
}

export interface Settings {
  agentCommand: string;
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  defaultDesignSystemId: string;
  customInstructions: string;
  imageApiBaseUrl: string;
  imageApiKey: string;
  imageApiKeyConfigured?: boolean;
  imageModel: string;
  removeBackgroundModel: string;
  editRegionModel: string;
  extractLayerModel: string;
  videoApiBaseUrl: string;
  videoApiKey: string;
  videoApiKeyConfigured?: boolean;
  videoModel: string;
  aiProviderId: string;
  aiProviderEnabled: boolean;
  aiProviderModels: string;
  aiProviderOrganization: string;
  aiProviderProfiles: string;
  visualQaEnabled: boolean;
  autoFixLiveRuntimeErrors: boolean;
  sharinganAffirmed: boolean;
  researchEnabled: boolean;
  researchAgentCommand: string;
  researchModel: string;
  visualQaAgentCommand: string;
  visualQaModel: string;
  autoImproveEnabled: boolean;
  autoImproveMaxRounds: number;
}

export interface ModelProviderModel {
  id: string;
  name?: string;
  capabilities?: string[];
}

export interface ModelProviderTestResult {
  ok: boolean;
  message: string;
}

export interface ModelProviderModelsResult {
  models: ModelProviderModel[];
  source?: string;
}

export interface AgentInfo {
  id: string;
  command: string;
  available: boolean;
  version?: string;
  models: string[];
}

/** Streamed progress from a rescan: per-agent "probe"/"models" steps, then a final "done". */
export type ScanEvent =
  | { type: "progress"; id: string; label: string; phase: "probe" | "models" }
  | { type: "done"; agents: AgentInfo[] };

export interface Health {
  ok: boolean;
  version: string;
}

/**
 * A server-sent run event. Known `type`s: run-start, turn-start, turn-end, lint,
 * done, run-done, run-error. Extra fields vary by type, so this stays open.
 */
export type RunEvent = { type: string } & Record<string, unknown>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  daemonToken?: string;
}

export type ApiErrorDetails = Record<string, unknown>;

export class ApiError extends Error {
  status: number;
  details: ApiErrorDetails | null;
  constructor(status: number, message: string, details: ApiErrorDetails | null = null) {
    super(message || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function defaultDaemonToken(): string {
  const g = globalThis as typeof globalThis & { __DEZIN_DAEMON_TOKEN__?: string };
  return typeof g.__DEZIN_DAEMON_TOKEN__ === "string" ? g.__DEZIN_DAEMON_TOKEN__ : "";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText ?? "";
  }
}

async function readApiError(res: Response): Promise<{ message: string; details: ApiErrorDetails | null }> {
  const text = await safeText(res);
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const details = parsed as ApiErrorDetails;
        const error = details.error;
        const message = details.message;
        if (typeof error === "string" && error.trim()) return { message: error.trim(), details };
        if (typeof message === "string" && message.trim()) return { message: message.trim(), details };
        return { message: text, details };
      }
    } catch {
      // Keep the raw response text if the JSON body is malformed.
    }
  }
  return { message: text, details: null };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function codecRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function codecString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function codecNullableString(value: unknown, label: string): string | null {
  return value === null ? null : codecString(value, label);
}

function codecTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite non-negative number`);
  return value;
}

function codecInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function codecEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function codecExactRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  const record = codecRecord(value, label);
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(record).find((key) => !allowed.has(key));
  if (unsupported) throw new TypeError(`${label} contains unsupported field ${unsupported}`);
  return record;
}

const RESOURCE_KINDS = [
  "research",
  "moodboard",
  "sharingan-capture",
  "file",
  "asset",
  "effect",
  "external-reference",
] as const satisfies readonly WorkspaceResourceKind[];
const RESOURCE_PIN_POLICIES = ["follow-head", "pin-current", "manual"] as const satisfies readonly ResourcePinPolicy[];

export function decodeResource(value: unknown): Resource {
  const input = codecRecord(value, "Resource");
  return {
    id: codecString(input.id, "Resource id"),
    workspaceId: codecString(input.workspaceId, "Resource workspaceId"),
    kind: codecEnum(input.kind, RESOURCE_KINDS, "Resource kind"),
    title: codecString(input.title, "Resource title"),
    headRevisionId: codecNullableString(input.headRevisionId, "Resource headRevisionId"),
    defaultPinPolicy: codecEnum(input.defaultPinPolicy, RESOURCE_PIN_POLICIES, "Resource pin policy"),
    archivedAt: input.archivedAt === null ? null : codecTimestamp(input.archivedAt, "Resource archivedAt"),
    createdAt: codecTimestamp(input.createdAt, "Resource createdAt"),
    updatedAt: codecTimestamp(input.updatedAt, "Resource updatedAt"),
  };
}

export function decodeResourceRevision(value: unknown): ResourceRevision {
  const input = codecRecord(value, "Resource Revision");
  return {
    id: codecString(input.id, "Resource Revision id"),
    workspaceId: codecString(input.workspaceId, "Resource Revision workspaceId"),
    resourceId: codecString(input.resourceId, "Resource Revision resourceId"),
    sequence: codecInteger(input.sequence, "Resource Revision sequence", 1),
    parentRevisionId: codecNullableString(input.parentRevisionId, "Resource Revision parentRevisionId"),
    manifestPath: codecString(input.manifestPath, "Resource Revision manifestPath"),
    summary: codecString(input.summary, "Resource Revision summary"),
    metadata: codecRecord(input.metadata, "Resource Revision metadata"),
    checksum: codecString(input.checksum, "Resource Revision checksum"),
    provenance: codecRecord(input.provenance, "Resource Revision provenance"),
    createdByRunId: codecNullableString(input.createdByRunId, "Resource Revision createdByRunId"),
    createdAt: codecTimestamp(input.createdAt, "Resource Revision createdAt"),
  };
}

export function decodeConversationScope(value: unknown): ConversationScope {
  const input = codecExactRecord(value, ["type", "id"], "Conversation scope");
  return {
    type: codecEnum(input.type, ["workspace", "artifact", "resource"] as const, "Conversation scope type"),
    id: codecString(input.id, "Conversation scope id"),
  };
}

export function decodeConversation(value: unknown): Conversation {
  const input = codecRecord(value, "Conversation");
  return {
    id: codecString(input.id, "Conversation id"),
    projectId: codecString(input.projectId, "Conversation projectId"),
    title: codecString(input.title, "Conversation title"),
    scope: decodeConversationScope(input.scope),
    createdAt: codecTimestamp(input.createdAt, "Conversation createdAt"),
    ...(input.turns === undefined ? {} : { turns: codecInteger(input.turns, "Conversation turns") }),
  };
}

export function decodeContextItemRef(value: unknown): ContextItemRef {
  const base = codecRecord(value, "Context reference");
  const kind = codecEnum(base.kind, ["artifact", "resource", "kernel", "inline"] as const, "Context reference kind");
  if (kind === "resource") {
    const input = codecExactRecord(base, ["kind", "id", "resourceKind", "revisionId"], "Resource Context reference");
    return {
      kind,
      id: codecString(input.id, "Context reference id"),
      resourceKind: codecEnum(input.resourceKind, RESOURCE_KINDS, "Context reference resourceKind"),
      ...(input.revisionId === undefined ? {} : { revisionId: codecString(input.revisionId, "Context reference revisionId") }),
    };
  }
  const input = codecExactRecord(
    base,
    kind === "inline" ? ["kind", "id"] : ["kind", "id", "revisionId"],
    "Context reference",
  );
  return kind === "inline"
    ? { kind, id: codecString(input.id, "Context reference id") }
    : {
        kind,
        id: codecString(input.id, "Context reference id"),
        ...(input.revisionId === undefined ? {} : { revisionId: codecString(input.revisionId, "Context reference revisionId") }),
      };
}

export function decodeSelectionRef(value: unknown): SelectionRef {
  const input = codecRecord(value, "Selection reference");
  return {
    kind: codecEnum(input.kind, ["node", "artifact", "resource", "element"] as const, "Selection reference kind"),
    id: codecString(input.id, "Selection reference id"),
    ...(input.revisionId === undefined ? {} : { revisionId: codecString(input.revisionId, "Selection reference revisionId") }),
  };
}

function codecBoundedString(value: unknown, label: string, maximum: number): string {
  const result = codecString(value, label);
  if (result.length > maximum) throw new TypeError(`${label} exceeds ${maximum} characters`);
  return result;
}

export function decodeRunContextRef(value: unknown): RunContextRef {
  const input = codecRecord(value, "Run context reference");
  if (input.kind === "owned-source") {
    const id = codecString(input.id, "Owned-source context id");
    const title = codecBoundedString(input.title, "Owned-source context title", RUN_CONTEXT_MAX_TITLE_CHARS);
    const source = encodeOwnedResourceSource(input.source as ResourceRevisionOwnedSource);
    const resourceKind = codecEnum(
      input.resourceKind,
      ["moodboard", "file", "asset", "effect", "external-reference"] as const,
      "Owned-source context resourceKind",
    );
    const expectedKind: typeof resourceKind = source.type === "moodboard"
      ? "moodboard"
      : source.type === "effect"
        ? "effect"
        : source.type === "asset"
          ? "asset"
          : source.type === "external-reference"
            ? "external-reference"
            : "file";
    if (resourceKind !== expectedKind) throw new TypeError("Owned-source context resourceKind does not match its source type");
    return { kind: "owned-source", id, title, resourceKind, source };
  }
  if (input.kind === "inline" && (input.content !== undefined || input.title !== undefined)) {
    if (input.trustLevel !== "untrusted") throw new TypeError("Inline run context trustLevel must be untrusted");
    return {
      kind: "inline",
      id: codecString(input.id, "Inline run context id"),
      title: codecBoundedString(input.title, "Inline run context title", RUN_CONTEXT_MAX_TITLE_CHARS),
      content: codecBoundedString(input.content, "Inline run context content", RUN_CONTEXT_MAX_INLINE_CHARS),
      trustLevel: "untrusted",
    };
  }
  return decodeContextItemRef(input);
}

export function decodeRunSelectionRef(value: unknown): RunSelectionRef {
  const input = codecRecord(value, "Run selection reference");
  return {
    ...decodeSelectionRef(input),
    ...(input.locator === undefined ? {} : { locator: codecRecord(input.locator, "Run selection locator") }),
  };
}

export function decodeRunContextRefs(value: unknown): RunContextRef[] {
  const refs = decodeArray(value, decodeRunContextRef, "Run context references");
  if (refs.length > RUN_CONTEXT_MAX_ITEMS) throw new TypeError(`Run context references exceed ${RUN_CONTEXT_MAX_ITEMS} items`);
  const inlineCharacters = refs.reduce(
    (total, ref) => total + (ref.kind === "inline" && "content" in ref ? ref.content.length : 0),
    0,
  );
  if (inlineCharacters > RUN_CONTEXT_MAX_TOTAL_INLINE_CHARS) {
    throw new TypeError(`Run inline context exceeds ${RUN_CONTEXT_MAX_TOTAL_INLINE_CHARS} total characters`);
  }
  return refs;
}

export function decodeRunSelectionRefs(value: unknown): RunSelectionRef[] {
  const refs = decodeArray(value, decodeRunSelectionRef, "Run selection references");
  if (refs.length > RUN_CONTEXT_MAX_ITEMS) throw new TypeError(`Run selection references exceed ${RUN_CONTEXT_MAX_ITEMS} items`);
  return refs;
}

function decodeArray<T>(value: unknown, decode: (item: unknown) => T, label: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map(decode);
}

function encodeCreateResourceInput(value: CreateResourceInput): CreateResourceInput {
  const input = codecExactRecord(value, ["kind", "title", "defaultPinPolicy", "baseGraphRevision", "expectedSnapshotId"], "Create Resource request");
  return {
    kind: codecEnum(input.kind, RESOURCE_KINDS, "Create Resource kind"),
    title: codecString(input.title, "Create Resource title"),
    defaultPinPolicy: codecEnum(input.defaultPinPolicy, RESOURCE_PIN_POLICIES, "Create Resource pin policy"),
    baseGraphRevision: codecInteger(input.baseGraphRevision, "Create Resource baseGraphRevision"),
    expectedSnapshotId: codecString(input.expectedSnapshotId, "Create Resource expectedSnapshotId"),
  };
}

function encodeUpdateResourceInput(value: UpdateResourceInput): UpdateResourceInput {
  const base = codecRecord(value, "Update Resource request");
  const action = codecEnum(base.action, ["rename", "set-default-pin-policy", "archive"] as const, "Update Resource action");
  if (action === "rename") {
    const input = codecExactRecord(base, ["action", "title", "baseGraphRevision", "expectedSnapshotId"], "Rename Resource request");
    return {
      action,
      title: codecString(input.title, "Rename Resource title"),
      baseGraphRevision: codecInteger(input.baseGraphRevision, "Rename Resource baseGraphRevision"),
      expectedSnapshotId: codecString(input.expectedSnapshotId, "Rename Resource expectedSnapshotId"),
    };
  }
  if (action === "set-default-pin-policy") {
    const input = codecExactRecord(base, ["action", "expectedDefaultPinPolicy", "defaultPinPolicy"], "Set Resource pin policy request");
    return {
      action,
      expectedDefaultPinPolicy: codecEnum(input.expectedDefaultPinPolicy, RESOURCE_PIN_POLICIES, "Expected Resource pin policy"),
      defaultPinPolicy: codecEnum(input.defaultPinPolicy, RESOURCE_PIN_POLICIES, "Resource pin policy"),
    };
  }
  const input = codecExactRecord(base, ["action", "baseGraphRevision", "expectedSnapshotId", "consumerImpactConfirmed"], "Archive Resource request");
  if (input.consumerImpactConfirmed !== true) throw new TypeError("Archive Resource consumerImpactConfirmed must be true");
  return {
    action,
    baseGraphRevision: codecInteger(input.baseGraphRevision, "Archive Resource baseGraphRevision"),
    expectedSnapshotId: codecString(input.expectedSnapshotId, "Archive Resource expectedSnapshotId"),
    consumerImpactConfirmed: true,
  };
}

function encodeOwnedResourceSource(value: ResourceRevisionOwnedSource): ResourceRevisionOwnedSource {
  const base = codecRecord(value, "Resource Revision source");
  const type = codecEnum(base.type, ["moodboard", "effect", "uploaded-file", "asset", "external-reference"] as const, "Resource Revision source type");
  switch (type) {
    case "moodboard": {
      const input = codecExactRecord(base, ["type", "moodboardId"], "Moodboard Resource source");
      return { type, moodboardId: codecString(input.moodboardId, "Moodboard Resource source id") };
    }
    case "effect": {
      const input = codecExactRecord(base, ["type", "effectId"], "Effect Resource source");
      return { type, effectId: codecString(input.effectId, "Effect Resource source id") };
    }
    case "uploaded-file": {
      const input = codecExactRecord(base, ["type", "uploadedFileId"], "Uploaded file Resource source");
      return { type, uploadedFileId: codecString(input.uploadedFileId, "Uploaded file Resource source id") };
    }
    case "asset": {
      const input = codecExactRecord(base, ["type", "assetId"], "Asset Resource source");
      return { type, assetId: codecString(input.assetId, "Asset Resource source id") };
    }
    case "external-reference": {
      const input = codecExactRecord(base, ["type", "url"], "External reference Resource source");
      const url = codecString(input.url, "External reference Resource source URL");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new TypeError("External reference Resource source URL must be absolute");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new TypeError("External reference Resource source URL must use http or https");
      }
      return { type, url };
    }
  }
}

function encodeCreateResourceRevisionInput(value: CreateResourceRevisionInput): CreateResourceRevisionInput {
  const input = codecExactRecord(value, ["expectedHeadRevisionId", "source"], "Create Resource Revision request");
  return {
    expectedHeadRevisionId: codecNullableString(input.expectedHeadRevisionId, "Create Resource Revision expectedHeadRevisionId"),
    source: encodeOwnedResourceSource(input.source as ResourceRevisionOwnedSource),
  };
}

function encodePublishResourceRevisionInput(value: PublishResourceRevisionInput): PublishResourceRevisionInput {
  const input = codecExactRecord(
    value,
    ["expectedHeadRevisionId", "expectedSnapshotId", "reason", "runId", "planId", "taskId"],
    "Publish Resource Revision request",
  );
  return {
    expectedHeadRevisionId: codecNullableString(input.expectedHeadRevisionId, "Publish Resource Revision expectedHeadRevisionId"),
    expectedSnapshotId: codecString(input.expectedSnapshotId, "Publish Resource Revision expectedSnapshotId"),
    reason: codecString(input.reason, "Publish Resource Revision reason"),
    ...(input.runId === undefined ? {} : { runId: codecString(input.runId, "Publish Resource Revision runId") }),
    ...(input.planId === undefined ? {} : { planId: codecString(input.planId, "Publish Resource Revision planId") }),
    ...(input.taskId === undefined ? {} : { taskId: codecString(input.taskId, "Publish Resource Revision taskId") }),
  };
}

function decodeCreateResourceResult(value: unknown): CreateResourceResult {
  const input = codecRecord(value, "Create Resource response");
  const node = codecRecord(input.node, "Create Resource node");
  if (node.kind !== "resource") throw new TypeError("Create Resource node kind must be resource");
  codecString(node.id, "Create Resource node id");
  codecString(node.workspaceId, "Create Resource node workspaceId");
  codecString(node.name, "Create Resource node name");
  codecString(node.resourceId, "Create Resource node resourceId");
  return {
    resource: decodeResource(input.resource),
    node: node as unknown as WorkspaceResourceNode,
    graph: codecRecord(input.graph, "Create Resource graph") as unknown as WorkspaceGraph,
    snapshot: codecRecord(input.snapshot, "Create Resource snapshot") as unknown as WorkspaceSnapshot,
  };
}

function decodeUpdateResourceResult(value: unknown): UpdateResourceResult {
  const input = codecRecord(value, "Update Resource response");
  const action = codecEnum(input.action, ["rename", "set-default-pin-policy", "archive"] as const, "Update Resource response action");
  const resource = decodeResource(input.resource);
  if (action === "set-default-pin-policy") return { action, resource };
  return {
    action,
    resource,
    graph: codecRecord(input.graph, "Update Resource graph") as unknown as WorkspaceGraph,
    snapshot: codecRecord(input.snapshot, "Update Resource snapshot") as unknown as WorkspaceSnapshot,
  };
}

function encodeRunInput(input: RunInput): RunInput {
  return {
    ...input,
    ...(input.contextRefs === undefined ? {} : { contextRefs: decodeRunContextRefs(input.contextRefs) }),
    ...(input.selection === undefined ? {} : { selection: decodeRunSelectionRefs(input.selection) }),
  };
}

/** Parse one SSE block ("data: {...}" possibly multi-line) into a RunEvent. */
export function parseSseBlock(block: string): RunEvent | null {
  const dataLines = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)));
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as RunEvent;
  } catch {
    return null;
  }
}

/** One step emitted while Sharingan captures a site (navigate, screenshot, login-required, etc.). */
export interface SharinganStep {
  at: number;
  kind: "navigate" | "screenshot" | "dom" | "styles" | "links" | "assets" | "login-required" | "done";
  text: string;
  /** For a "screenshot" step: the project-dir-relative path of the shot it produced (feed to sharinganShotUrl). */
  shot?: string;
}

/** A single captured page: its URL, title, and screenshots keyed by viewport/label. */
export interface SharinganPage {
  url: string;
  title: string;
  screenshots: Record<string, string>;
}

/** Overall capture status for a Sharingan clone job. */
export type SharinganPhase = "idle" | "capturing" | "login-required" | "captured" | "error" | "probing" | "cancelled";
export interface SharinganStatus {
  phase: SharinganPhase;
  steps: number;
  pages: SharinganPage[];
  error?: string;
}

/** Generic SSE consumer for JSON-shaped events that aren't a RunEvent (e.g. SharinganStep). */
export async function* consumeSseJson<T>(res: Response): AsyncGenerator<T> {
  if (!res.ok) throw new ApiError(res.status, await safeText(res));
  if (!res.body) {
    // Environments without a streaming body: parse the whole text.
    for (const block of (await res.text()).split("\n\n")) {
      const parsed = parseSseBlock(block) as T | null;
      if (parsed) yield parsed;
    }
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseBlock(block) as T | null;
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const parsed = parseSseBlock(tail) as T | null;
    if (parsed) yield parsed;
  }
}

export interface ProjectFile {
  path: string;
  size: number;
}

/** One anti-slop finding, as emitted on a run's `lint` SSE event and persisted on runs. */
export interface QualityFinding {
  severity: string;
  id: string;
  message: string;
  fix?: string;
  screenshotPath?: string;
  screenshotUrl?: string;
  reviewSummary?: string;
  reviewStatus?: "active" | "resolved";
  reviewRound?: number;
}

export interface RunFeedback {
  verdict: "up" | "down";
  gap?: string;
}

export interface RunSummary {
  id: string;
  conversationId?: string;
  variantId?: string | null;
  status: string;
  score: number | null;
  repairRounds: number;
  lintPassed: boolean;
  findings?: QualityFinding[];
  feedback?: RunFeedback | null;
  createdAt: number;
  finishedAt: number | null;
}

export type VersionDiffLine = { t: "ctx" | "add" | "del"; text: string };
export interface VersionRestoreResult {
  ok: boolean;
  commitHash?: string;
  runId?: string;
  historyRecorded?: boolean;
  evidenceCopied?: boolean;
  assetsRestored?: boolean;
}
export interface PreviewLeaseInfo {
  leaseId: string;
  url: string;
  bridgeNonce: string;
  expiresAt: number;
}
export interface PreviewTargetLease extends PreviewLeaseInfo {
  resolved: ResolvedPreviewTarget;
}
interface VersionPreviewBase {
  url: string;
  bridgeNonce: string;
}
export type VersionPreview =
  | (VersionPreviewBase & { mode: "prototype"; leaseId?: never; expiresAt?: never })
  | (VersionPreviewBase & { mode: "standard"; leaseId: string; expiresAt: number });

export interface ApiClient {
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  generateProjectTitle(id: string, brief: string): Promise<Project>;
  getSetup(id: string): Promise<SetupStatus>;
  getDevServerUrl(id: string, signal?: AbortSignal): Promise<PreviewLeaseInfo>;
  releaseDevServer(id: string): Promise<void>;
  renewPreviewLease(leaseId: string, signal?: AbortSignal): Promise<PreviewLeaseInfo>;
  releasePreviewLease(leaseId: string): Promise<void>;
  resolvePreviewTarget(projectId: string, target: PreviewTarget, signal?: AbortSignal): Promise<ResolvedPreviewTarget>;
  acquirePreviewTargetLease(
    projectId: string,
    resolved: ResolvedPreviewTarget,
    signal?: AbortSignal,
  ): Promise<PreviewTargetLease>;
  renewPreviewTargetLease(leaseId: string, signal?: AbortSignal): Promise<PreviewLeaseInfo>;
  releasePreviewTargetLease(leaseId: string): Promise<void>;
  captureProjectCover(id: string, options?: { release?: boolean }): Promise<{ captured: boolean; reason?: string }>;
  getProject(id: string): Promise<Project>;
  getWorkspace(projectId: string): Promise<ProjectWorkspacePayload>;
  listWorkspaceProposals(projectId: string): Promise<WorkspaceProposal[]>;
  getWorkspaceProposal(projectId: string, proposalId: string): Promise<WorkspaceProposal>;
  createWorkspaceProposal(projectId: string, input: CreateWorkspaceProposalInput): Promise<WorkspaceProposal>;
  updateWorkspaceProposal(projectId: string, proposalId: string, input: UpdateWorkspaceProposalInput): Promise<WorkspaceProposal>;
  approveWorkspaceProposal(
    projectId: string,
    proposalId: string,
    mode: WorkspaceProposalApprovalMode,
  ): Promise<ApprovedProposalResult>;
  rejectWorkspaceProposal(projectId: string, proposalId: string): Promise<WorkspaceProposal>;
  applyWorkspaceGraphCommands(projectId: string, input: GraphCommandRequest): Promise<WorkspaceGraphMutationResult>;
  saveWorkspaceLayout(projectId: string, input: WorkspaceLayoutPatch): Promise<WorkspaceLayout>;
  listResources(projectId: string): Promise<Resource[]>;
  createResource(projectId: string, input: CreateResourceInput): Promise<CreateResourceResult>;
  getResource(projectId: string, resourceId: string): Promise<Resource>;
  updateResource(projectId: string, resourceId: string, input: UpdateResourceInput): Promise<UpdateResourceResult>;
  listResourceRevisions(projectId: string, resourceId: string): Promise<ResourceRevision[]>;
  createResourceRevision(projectId: string, resourceId: string, input: CreateResourceRevisionInput): Promise<ResourceRevision>;
  publishResourceRevision(
    projectId: string,
    resourceId: string,
    revisionId: string,
    input: PublishResourceRevisionInput,
  ): Promise<WorkspaceSnapshot>;
  getArtifact(projectId: string, artifactId: string): Promise<WorkspaceArtifactPayload>;
  listArtifactTracks(projectId: string, artifactId: string): Promise<ArtifactTrack[]>;
  listArtifactRevisions(projectId: string, artifactId: string): Promise<ArtifactRevision[]>;
  getArtifactRevision(projectId: string, artifactId: string, revisionId: string): Promise<ArtifactRevision>;
  applyArtifactMutation(projectId: string, artifactId: string, input: ArtifactMutationInput): Promise<ArtifactMutationResult>;
  getArtifactThumbnail(projectId: string, artifactId: string, revisionId: string, signal?: AbortSignal): Promise<Blob>;
  artifactThumbnailUrl(projectId: string, artifactId: string, revisionId: string): string;
  listWorkspaceSnapshots(projectId: string): Promise<WorkspaceSnapshot[]>;
  getWorkspaceSnapshot(projectId: string, snapshotId: string): Promise<WorkspaceSnapshot>;
  patchProject(id: string, patch: Partial<CreateProjectInput> & { archived?: boolean }): Promise<Project>;
  saveCover(id: string, dataUrl: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  listConversations(id: string, scope?: ConversationScope): Promise<Conversation[]>;
  createConversation(id: string, title?: string, scope?: ConversationScope): Promise<Conversation>;
  getConversation(projectId: string, cid: string): Promise<Conversation>;
  renameConversation(projectId: string, cid: string, title: string): Promise<Conversation>;
  deleteConversation(projectId: string, cid: string): Promise<void>;
  listVariants(id: string): Promise<Variant[]>;
  createVariant(id: string, name?: string): Promise<Variant[]>;
  /** Fork N variations from the current state so the same scoped edit can be generated N ways. */
  fanoutVariants(id: string, count: number): Promise<{ plan: { count: number }; created: string[]; variants: Variant[] }>;
  forkMessage(id: string, messageId: string, name?: string): Promise<MessageForkResult>;
  activateVariant(id: string, vid: string): Promise<Variant[]>;
  renameVariant(id: string, vid: string, name: string): Promise<Variant[]>;
  deleteVariant(id: string, vid: string): Promise<Variant[]>;
  listMessages(projectId: string, cid: string): Promise<Message[]>;
  listDesignSystems(): Promise<DesignSystemCard[]>;
  getDesignSystem(id: string): Promise<DesignSystemDetail>;
  importBrand(input: BrandImportInput): Promise<DesignSystemCard>;
  listEffects(options?: { query?: string }): Promise<EffectCard[]>;
  getEffect(id: string): Promise<EffectDetail>;
  createEffect(input: CreateEffectInput): Promise<EffectDetail>;
  updateEffect(id: string, patch: UpdateEffectInput): Promise<EffectDetail>;
  listSkills(): Promise<SkillCard[]>;
  createExtensionPairingCode(): Promise<{ code: string; expiresAt: number }>;
  listExtensionCredentials(): Promise<ExtensionCredential[]>;
  revokeExtensionCredential(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  testModelProvider(providerId: string): Promise<ModelProviderTestResult>;
  listModelProviderModels(providerId: string): Promise<ModelProviderModelsResult>;
  listAgents(): Promise<AgentInfo[]>;
  rescanAgents(): Promise<AgentInfo[]>;
  /** Rescan with per-agent progress (SSE). Yields progress events, then a final "done". */
  scanAgentsStream(): AsyncGenerator<ScanEvent>;
  getHealth(): Promise<Health>;
  optimizePrompt(input: PromptOptimizeInput): Promise<PromptOptimizeResult>;
  listFiles(id: string): Promise<ProjectFile[]>;
  getFileText(id: string, path: string): Promise<string>;
  listRuns(id: string, options?: { all?: boolean }): Promise<RunSummary[]>;
  versionPreviewUrl(id: string, runId: string): string;
  getVersionPreview(id: string, runId: string, signal?: AbortSignal): Promise<VersionPreview>;
  getVersionText(id: string, runId: string): Promise<string>;
  getVersionDiff(id: string, runId: string): Promise<VersionDiffLine[]>;
  restoreVersion(id: string, runId: string): Promise<VersionRestoreResult>;
  setVersionCover(id: string, runId: string): Promise<{ captured: boolean }>;
  uploadRef(id: string, name: string, contentBase64: string): Promise<{ name: string; path: string }>;
  /** Parse a Figma .fig file into an agent-ready design summary. */
  parseFig(file: Blob, name: string): Promise<{ name: string; summary: string }>;
  /** Explicitly consume the one-shot pending capture from the browser extension. */
  getCapture(): Promise<{ images: { name: string; base64: string }[]; note: string; source: string }>;
  previewUrl(id: string): string;
  /** URL serving an uploaded reference file (e.g. an image), given its `.refs/<name>` path. */
  refUrl(id: string, refPath: string): string;
  /** The project's research deliverables ({exists:false} when it hasn't been researched). */
  getResearch(id: string): Promise<ResearchDetail>;
  /** URL serving a collected research asset image, given its `assets/<name>` path. */
  researchAssetUrl(id: string, assetPath: string): string;
  /** URL serving a collected VISUAL research asset image, given its `assets/<name>` (or `visual/assets/<name>`) path. */
  researchVisualAssetUrl(id: string, assetPath: string): string;
  variantPreviewUrl(id: string, vid: string): string;
  exportUrl(id: string, scope?: "source" | "full"): string;
  importProject(file: Blob): Promise<Project>;
  listMoodboards(): Promise<Moodboard[]>;
  createMoodboard(input: { name: string }): Promise<Moodboard>;
  startMoodboard(input: StartMoodboardInput): Promise<Moodboard>;
  getMoodboard(id: string): Promise<MoodboardDetail>;
  patchMoodboard(id: string, patch: Partial<Pick<Moodboard, "name" | "coverAssetId">> & { archived?: boolean }): Promise<Moodboard>;
  deleteMoodboard(id: string): Promise<void>;
  listMoodboardNodes(id: string): Promise<MoodboardNode[]>;
  saveMoodboardNodes(id: string, nodes: SaveMoodboardNodeInput[]): Promise<MoodboardNode[]>;
  listMoodboardConversations(id: string): Promise<MoodboardConversation[]>;
  createMoodboardConversation(id: string, title?: string): Promise<MoodboardConversation>;
  renameMoodboardConversation(id: string, conversationId: string, title: string): Promise<MoodboardConversation>;
  deleteMoodboardConversation(id: string, conversationId: string): Promise<{ ok: boolean; conversations: MoodboardConversation[] }>;
  listMoodboardMessages(id: string, conversationId?: string): Promise<MoodboardMessage[]>;
  postMoodboardMessage(
    id: string,
    content: string,
    options?: { agentCommand?: string; model?: string; conversationId?: string },
  ): Promise<{ messages: MoodboardMessage[]; nodes?: MoodboardNode[] }>;
  uploadMoodboardAsset(
    id: string,
    input: { name: string; contentBase64: string; mimeType?: string; width?: number; height?: number },
  ): Promise<MoodboardAsset & { url: string }>;
  generateMoodboardImage(
    id: string,
    prompt: string,
    options?: GenerateMoodboardImageOptions,
  ): Promise<{
    asset: MoodboardAsset & { url: string };
    nodes: MoodboardNode[];
    messages: MoodboardMessage[];
  }>;
  streamRun(input: RunInput, signal?: AbortSignal): AsyncGenerator<RunEvent>;
  /** Reattach to an in-flight (or finished) run: replays its events, then streams live. */
  reattachRun(runId: string, signal?: AbortSignal, options?: { afterSeq?: number }): AsyncGenerator<RunEvent>;
  /** Explicitly stop a run (the composer "Stop"); works across pages. */
  cancelRun(runId: string): Promise<{ cancelled: boolean }>;
  setRunFeedback(runId: string, feedback: RunFeedback | null): Promise<{ run: RunSummary }>;
  suggestPreferences(): Promise<{ suggestion: string; signals: number }>;
  /** Start a Sharingan clone capture for the given source URL. */
  startSharingan(id: string, url: string): Promise<void>;
  /** Cancel the capture and wait until the daemon has released its browser/session resources. */
  cancelSharingan(id: string): Promise<void>;
  /** Current capture status: phase, step count, and pages captured so far. */
  sharinganStatus(id: string): Promise<SharinganStatus>;
  /** Resume a capture that's paused (e.g. waiting after a login-required step). */
  continueSharingan(id: string): Promise<void>;
  /** Bring the capture's browser window to the foreground (e.g. for manual login). */
  focusSharingan(id: string): Promise<void>;
  /** Stream capture steps live (SSE) as Sharingan navigates and screenshots the site. */
  streamSharinganEvents(id: string, signal?: AbortSignal): AsyncGenerator<SharinganStep>;
  /** URL serving a captured screenshot, given its relative path within the capture. */
  sharinganShotUrl(id: string, relPath: string): string;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? "";
  const f: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const daemonToken = (opts.daemonToken ?? defaultDaemonToken()).trim();

  function initWithDaemonToken(init?: RequestInit): RequestInit | undefined {
    if (!daemonToken) return init;
    const rawHeaders = init?.headers;
    const headers =
      rawHeaders instanceof Headers
        ? Object.fromEntries(rawHeaders.entries())
        : Array.isArray(rawHeaders)
          ? Object.fromEntries(rawHeaders)
          : { ...(rawHeaders as Record<string, string> | undefined) };
    headers["x-dezin-daemon-token"] = daemonToken;
    return { ...init, headers };
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await f(baseUrl + path, initWithDaemonToken(init));
    if (!res.ok) {
      const error = await readApiError(res);
      throw new ApiError(res.status, error.message, error.details);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function jsonDecoded<T>(path: string, decode: (value: unknown) => T, init?: RequestInit): Promise<T> {
    return decode(await json<unknown>(path, init));
  }

  async function blob(path: string, init?: RequestInit): Promise<Blob> {
    const res = await f(baseUrl + path, initWithDaemonToken(init));
    if (!res.ok) {
      const error = await readApiError(res);
      throw new ApiError(res.status, error.message, error.details);
    }
    return res.blob();
  }

  async function* consumeSse(res: Response): AsyncGenerator<RunEvent> {
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    if (!res.body) {
      // Environments without a streaming body: parse the whole text.
      for (const block of (await res.text()).split("\n\n")) {
        const ev = parseSseBlock(block);
        if (ev) yield ev;
      }
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const ev = parseSseBlock(tail);
      if (ev) yield ev;
    }
  }

  async function* streamRun(input: RunInput, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    yield* consumeSse(await f(baseUrl + "/api/runs", initWithDaemonToken({ ...jsonInit("POST", encodeRunInput(input)), signal })));
  }

  async function* reattachRun(runId: string, signal?: AbortSignal, options: { afterSeq?: number } = {}): AsyncGenerator<RunEvent> {
    const after = typeof options.afterSeq === "number" && Number.isFinite(options.afterSeq) ? `?after=${encodeURIComponent(String(options.afterSeq))}` : "";
    yield* consumeSse(await f(`${baseUrl}/api/runs/${enc(runId)}/stream${after}`, initWithDaemonToken({ signal })));
  }

  async function* scanAgentsStream(): AsyncGenerator<ScanEvent> {
    const res = await f(baseUrl + "/api/agents/rescan-stream", initWithDaemonToken({ method: "POST" }));
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    const handle = (block: string): ScanEvent | null => {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) return null;
      try {
        return JSON.parse(data) as ScanEvent;
      } catch {
        return null;
      }
    };
    if (!res.body) {
      for (const block of (await res.text()).split("\n\n")) {
        const ev = handle(block);
        if (ev) yield ev;
      }
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const ev = handle(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    const ev = handle(buffer.trim());
    if (ev) yield ev;
  }

  const enc = (id: string) => encodeURIComponent(id);
  const conversationScopeQuery = (scope?: ConversationScope): string => {
    if (!scope) return "";
    const normalized = decodeConversationScope(scope);
    return `?scopeType=${enc(normalized.type)}&scopeId=${enc(normalized.id)}`;
  };

  return {
    scanAgentsStream,
    listProjects: () => json<Project[]>("/api/projects"),
    createProject: (input) => json<Project>("/api/projects", jsonInit("POST", input)),
    generateProjectTitle: (id, brief) => json<Project>(`/api/projects/${enc(id)}/title`, jsonInit("POST", { brief })),
    getSetup: (id) => json<SetupStatus>(`/api/projects/${enc(id)}/setup`),
    getDevServerUrl: (id, signal) => json<PreviewLeaseInfo>(`/api/projects/${enc(id)}/devserver`, { signal }),
    releaseDevServer: (id) => json<{ released: boolean }>(`/api/projects/${enc(id)}/devserver`, { method: "DELETE" }).then(() => {}),
    renewPreviewLease: (leaseId, signal) => json<PreviewLeaseInfo>(`/api/preview-leases/${enc(leaseId)}`, { method: "PATCH", signal }),
    releasePreviewLease: (leaseId) => json<{ released: boolean }>(`/api/preview-leases/${enc(leaseId)}`, { method: "DELETE" }).then(() => {}),
    resolvePreviewTarget: (projectId, target, signal) =>
      json<{ resolved: ResolvedPreviewTarget }>(
        `/api/projects/${enc(projectId)}/preview-targets/resolve`,
        { ...jsonInit("POST", { target }), signal },
      ).then((result) => result.resolved),
    acquirePreviewTargetLease: (projectId, resolved, signal) =>
      json<PreviewTargetLease>(
        `/api/projects/${enc(projectId)}/preview-targets/leases`,
        { ...jsonInit("POST", { resolved }), signal },
      ),
    renewPreviewTargetLease: (leaseId, signal) =>
      json<PreviewLeaseInfo>(`/api/preview-leases/${enc(leaseId)}`, { method: "PATCH", signal }),
    releasePreviewTargetLease: (leaseId) => json<{ released: boolean }>(`/api/preview-leases/${enc(leaseId)}`, { method: "DELETE" }).then(() => {}),
    captureProjectCover: (id, options) =>
      json<{ captured: boolean; reason?: string }>(`/api/projects/${enc(id)}/cover/capture${options?.release ? "?release=1" : ""}`, { method: "POST" }),
    getProject: (id) => json<Project>(`/api/projects/${enc(id)}`),
    getWorkspace: (projectId) => json<ProjectWorkspacePayload>(`/api/projects/${enc(projectId)}/workspace`),
    listWorkspaceProposals: (projectId) =>
      json<WorkspaceProposal[]>(`/api/projects/${enc(projectId)}/workspace/proposals`),
    getWorkspaceProposal: (projectId, proposalId) =>
      json<WorkspaceProposal>(`/api/projects/${enc(projectId)}/workspace/proposals/${enc(proposalId)}`),
    createWorkspaceProposal: (projectId, input) =>
      json<WorkspaceProposal>(`/api/projects/${enc(projectId)}/workspace/proposals`, jsonInit("POST", input)),
    updateWorkspaceProposal: (projectId, proposalId, input) =>
      json<WorkspaceProposal>(`/api/projects/${enc(projectId)}/workspace/proposals/${enc(proposalId)}`, jsonInit("PATCH", input)),
    approveWorkspaceProposal: (projectId, proposalId, mode) =>
      json<ApprovedProposalResult>(`/api/projects/${enc(projectId)}/workspace/proposals/${enc(proposalId)}/approve`, jsonInit("POST", { mode })),
    rejectWorkspaceProposal: (projectId, proposalId) =>
      json<WorkspaceProposal>(`/api/projects/${enc(projectId)}/workspace/proposals/${enc(proposalId)}/reject`, jsonInit("POST", {})),
    applyWorkspaceGraphCommands: (projectId, input) =>
      json<WorkspaceGraphMutationResult>(`/api/projects/${enc(projectId)}/workspace/graph/commands`, jsonInit("POST", input)),
    saveWorkspaceLayout: (projectId, input) =>
      json<WorkspaceLayout>(`/api/projects/${enc(projectId)}/workspace/layout`, jsonInit("PUT", input)),
    listResources: (projectId) =>
      jsonDecoded(`/api/projects/${enc(projectId)}/resources`, (value) => decodeArray(value, decodeResource, "Resources")),
    createResource: (projectId, input) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources`,
        decodeCreateResourceResult,
        jsonInit("POST", encodeCreateResourceInput(input)),
      ),
    getResource: (projectId, resourceId) =>
      jsonDecoded(`/api/projects/${enc(projectId)}/resources/${enc(resourceId)}`, decodeResource),
    updateResource: (projectId, resourceId, input) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}`,
        decodeUpdateResourceResult,
        jsonInit("PATCH", encodeUpdateResourceInput(input)),
      ),
    listResourceRevisions: (projectId, resourceId) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/revisions`,
        (value) => decodeArray(value, decodeResourceRevision, "Resource Revisions"),
      ),
    createResourceRevision: (projectId, resourceId, input) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/revisions`,
        decodeResourceRevision,
        jsonInit("POST", encodeCreateResourceRevisionInput(input)),
      ),
    publishResourceRevision: (projectId, resourceId, revisionId, input) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/revisions/${enc(revisionId)}/publish`,
        (value) => codecRecord(value, "Publish Resource Revision response") as unknown as WorkspaceSnapshot,
        jsonInit("POST", encodePublishResourceRevisionInput(input)),
      ),
    getArtifact: (projectId, artifactId) =>
      json<WorkspaceArtifactPayload>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}`),
    listArtifactTracks: (projectId, artifactId) =>
      json<ArtifactTrack[]>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/tracks`),
    listArtifactRevisions: (projectId, artifactId) =>
      json<ArtifactRevision[]>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions`),
    getArtifactRevision: (projectId, artifactId, revisionId) =>
      json<ArtifactRevision>(`/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions/${enc(revisionId)}`),
    applyArtifactMutation: (projectId, artifactId, input) =>
      json<ArtifactMutationResult>(
        `/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/mutations`,
        jsonInit("POST", input),
      ),
    getArtifactThumbnail: (projectId, artifactId, revisionId, signal) =>
      blob(
        `/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions/${enc(revisionId)}/thumbnail`,
        { signal },
      ),
    artifactThumbnailUrl: (projectId, artifactId, revisionId) =>
      `${baseUrl}/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions/${enc(revisionId)}/thumbnail`,
    listWorkspaceSnapshots: (projectId) =>
      json<WorkspaceSnapshot[]>(`/api/projects/${enc(projectId)}/workspace/snapshots`),
    getWorkspaceSnapshot: (projectId, snapshotId) =>
      json<WorkspaceSnapshot>(`/api/projects/${enc(projectId)}/workspace/snapshots/${enc(snapshotId)}`),
    patchProject: (id, patch) => json<Project>(`/api/projects/${enc(id)}`, jsonInit("PATCH", patch)),
    saveCover: (id, dataUrl) => json<{ ok: boolean }>(`/api/projects/${enc(id)}/cover`, jsonInit("POST", { dataUrl })).then(() => {}),
    deleteProject: (id) => json<void>(`/api/projects/${enc(id)}`, { method: "DELETE" }),
    listConversations: (id, scope) =>
      jsonDecoded(
        `/api/projects/${enc(id)}/conversations${conversationScopeQuery(scope)}`,
        (value) => decodeArray(value, decodeConversation, "Conversations"),
      ),
    createConversation: (id, title, scope) =>
      jsonDecoded(
        `/api/projects/${enc(id)}/conversations`,
        decodeConversation,
        jsonInit("POST", {
          ...(title === undefined ? {} : { title }),
          ...(scope === undefined ? {} : { scope: decodeConversationScope(scope) }),
        }),
      ),
    getConversation: (projectId, cid) =>
      jsonDecoded(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}`, decodeConversation),
    renameConversation: (projectId, cid, title) =>
      jsonDecoded(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}`, decodeConversation, jsonInit("PATCH", { title })),
    deleteConversation: (projectId, cid) =>
      json<{ ok: boolean }>(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}`, { method: "DELETE" }).then(() => {}),
    listVariants: (id) => json<Variant[]>(`/api/projects/${enc(id)}/variants`),
    createVariant: (id, name) => json<Variant[]>(`/api/projects/${enc(id)}/variants`, jsonInit("POST", { name })),
    fanoutVariants: (id, count) =>
      json<{ plan: { count: number }; created: string[]; variants: Variant[] }>(`/api/projects/${enc(id)}/variants/fanout`, jsonInit("POST", { count })),
    forkMessage: (id, messageId, name) =>
      json<MessageForkResult>(`/api/projects/${enc(id)}/messages/${enc(messageId)}/fork`, jsonInit("POST", { name })),
    activateVariant: (id, vid) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}/activate`, { method: "POST" }),
    renameVariant: (id, vid, name) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}`, jsonInit("PATCH", { name })),
    deleteVariant: (id, vid) => json<Variant[]>(`/api/projects/${enc(id)}/variants/${enc(vid)}`, { method: "DELETE" }),
    listMessages: (projectId, cid) =>
      json<Message[]>(`/api/projects/${enc(projectId)}/conversations/${enc(cid)}/messages`),
    listDesignSystems: () => json<DesignSystemCard[]>("/api/design-systems"),
    getDesignSystem: (id) => json<DesignSystemDetail>(`/api/design-systems/${enc(id)}`),
    importBrand: (input) => json<DesignSystemCard>("/api/design-systems/import", jsonInit("POST", input)),
    listEffects: (options) => json<EffectCard[]>(`/api/effects${options?.query?.trim() ? `?query=${enc(options.query.trim())}` : ""}`),
    getEffect: (id) => json<EffectDetail>(`/api/effects/${enc(id)}`),
    createEffect: (input) => json<EffectDetail>("/api/effects", jsonInit("POST", input)),
    updateEffect: (id, patch) => json<EffectDetail>(`/api/effects/${enc(id)}`, jsonInit("PATCH", patch)),
    listSkills: () => json<SkillCard[]>("/api/skills"),
    createExtensionPairingCode: () => json<{ code: string; expiresAt: number }>("/api/extension/pairing-code", { method: "POST" }),
    listExtensionCredentials: () => json<ExtensionCredential[]>("/api/extension/credentials"),
    revokeExtensionCredential: (id) => json<void>(`/api/extension/credentials/${enc(id)}`, { method: "DELETE" }),
    getSettings: () => json<Settings>("/api/settings"),
    updateSettings: (patch) => json<Settings>("/api/settings", jsonInit("PUT", patch)),
    testModelProvider: (providerId) => json<ModelProviderTestResult>("/api/model-providers/test", jsonInit("POST", { providerId })),
    listModelProviderModels: (providerId) => json<ModelProviderModelsResult>("/api/model-providers/models", jsonInit("POST", { providerId })),
    listAgents: () => json<AgentInfo[]>("/api/agents"),
    rescanAgents: () => json<AgentInfo[]>("/api/agents/rescan", { method: "POST" }),
    getHealth: () => json<Health>("/api/health"),
    optimizePrompt: (input) => json<PromptOptimizeResult>("/api/prompts/optimize", jsonInit("POST", input)),
    listFiles: (id) => json<ProjectFile[]>(`/api/projects/${enc(id)}/files`),
    listRuns: (id, options) => json<RunSummary[]>(`/api/projects/${enc(id)}/runs${options?.all ? "?all=1" : ""}`),
    versionPreviewUrl: (id, runId) => `${baseUrl}/api/projects/${enc(id)}/versions/${enc(runId)}`,
    getVersionPreview: (id, runId, signal) => json<VersionPreview>(`/api/projects/${enc(id)}/versions/${enc(runId)}/preview-url`, { signal }),
    getVersionText: async (id, runId) => {
      const url = `${baseUrl}/api/projects/${enc(id)}/versions/${enc(runId)}/source`;
      const init = initWithDaemonToken();
      const res = init ? await f(url, init) : await f(url);
      if (!res.ok) throw new ApiError(res.status, await safeText(res));
      return res.text();
    },
    getVersionDiff: (id, runId) => json<VersionDiffLine[]>(`/api/projects/${enc(id)}/versions/${enc(runId)}/diff`),
    restoreVersion: (id, runId) => json<VersionRestoreResult>(`/api/projects/${enc(id)}/versions/${enc(runId)}/restore`, { method: "POST" }),
    setVersionCover: (id, runId) => json<{ captured: boolean }>(`/api/projects/${enc(id)}/versions/${enc(runId)}/cover`, { method: "POST" }),
    uploadRef: (id, name, contentBase64) =>
      json<{ name: string; path: string }>(`/api/projects/${enc(id)}/refs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, contentBase64 }),
      }),
    parseFig: (file, name) =>
      json<{ name: string; summary: string }>("/api/fig/parse", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(name) },
        body: file,
      }),
    getCapture: () =>
      json<{ images: { name: string; base64: string }[]; note: string; source: string }>("/api/capture/consume", {
        method: "POST",
      }),
    getFileText: async (id, path) => {
      const rel = path.split("/").map(enc).join("/");
      const url = `${baseUrl}/projects/${enc(id)}/preview/${rel}`;
      const init = initWithDaemonToken();
      const res = init ? await f(url, init) : await f(url);
      if (!res.ok) throw new ApiError(res.status, await safeText(res));
      return res.text();
    },
    previewUrl: (id) => `${baseUrl}/projects/${enc(id)}/preview/`,
    refUrl: (id, refPath) => `${baseUrl}/api/projects/${enc(id)}/refs/${refPath.replace(/^\.refs\//, "").split("/").map(encodeURIComponent).join("/")}`,
    getResearch: (id) => json<ResearchDetail>(`/api/projects/${enc(id)}/research`),
    researchAssetUrl: (id, assetPath) => `${baseUrl}/api/projects/${enc(id)}/research/assets/${assetPath.replace(/^assets\//, "").split("/").map(encodeURIComponent).join("/")}`,
    researchVisualAssetUrl: (id, assetPath) => `${baseUrl}/api/projects/${enc(id)}/research/visual/assets/${assetPath.replace(/^(visual\/)?assets\//, "").split("/").map(encodeURIComponent).join("/")}`,
    variantPreviewUrl: (id, vid) => `${baseUrl}/api/projects/${enc(id)}/variants/${enc(vid)}/preview/`,
    exportUrl: (id, scope = "source") => `${baseUrl}/api/projects/${enc(id)}/export${scope === "full" ? "?scope=full" : ""}`,
    importProject: (file) =>
      json<Project>("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: file,
      }),
    listMoodboards: () => json<Moodboard[]>("/api/moodboards"),
    createMoodboard: (input) => json<Moodboard>("/api/moodboards", jsonInit("POST", input)),
    startMoodboard: (input) => json<Moodboard>("/api/moodboards/start", jsonInit("POST", input)),
    getMoodboard: (id) => json<MoodboardDetail>(`/api/moodboards/${enc(id)}`),
    patchMoodboard: (id, patch) => json<Moodboard>(`/api/moodboards/${enc(id)}`, jsonInit("PATCH", patch)),
    deleteMoodboard: (id) => json<void>(`/api/moodboards/${enc(id)}`, { method: "DELETE" }),
    listMoodboardNodes: (id) => json<MoodboardNode[]>(`/api/moodboards/${enc(id)}/nodes`),
    saveMoodboardNodes: (id, nodes) => json<MoodboardNode[]>(`/api/moodboards/${enc(id)}/nodes`, jsonInit("PUT", { nodes })),
    listMoodboardConversations: (id) => json<MoodboardConversation[]>(`/api/moodboards/${enc(id)}/conversations`),
    createMoodboardConversation: (id, title) =>
      json<MoodboardConversation>(`/api/moodboards/${enc(id)}/conversations`, jsonInit("POST", { title })),
    renameMoodboardConversation: (id, conversationId, title) =>
      json<MoodboardConversation>(`/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}`, jsonInit("PATCH", { title })),
    deleteMoodboardConversation: (id, conversationId) =>
      json<{ ok: boolean; conversations: MoodboardConversation[] }>(`/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}`, { method: "DELETE" }),
    listMoodboardMessages: (id, conversationId) =>
      json<MoodboardMessage[]>(
        conversationId ? `/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}/messages` : `/api/moodboards/${enc(id)}/messages`,
      ),
    postMoodboardMessage: (id, content, options) => {
      const { conversationId, ...bodyOptions } = options ?? {};
      return json<{ messages: MoodboardMessage[]; nodes?: MoodboardNode[] }>(
        conversationId ? `/api/moodboards/${enc(id)}/conversations/${enc(conversationId)}/messages` : `/api/moodboards/${enc(id)}/messages`,
        jsonInit("POST", { content, ...bodyOptions }),
      );
    },
    uploadMoodboardAsset: (id, input) =>
      json<MoodboardAsset & { url: string }>(`/api/moodboards/${enc(id)}/assets`, jsonInit("POST", input)),
    generateMoodboardImage: (id, prompt, options) =>
      json<{ asset: MoodboardAsset & { url: string }; nodes: MoodboardNode[]; messages: MoodboardMessage[] }>(
        `/api/moodboards/${enc(id)}/generate-image`,
        jsonInit("POST", { prompt, ...options }),
      ),
    streamRun,
    reattachRun,
    cancelRun: (runId) => json<{ cancelled: boolean }>(`/api/runs/${enc(runId)}/cancel`, { method: "POST" }),
    setRunFeedback: (runId, feedback) => json<{ run: RunSummary }>(`/api/runs/${enc(runId)}/feedback`, jsonInit("POST", feedback ?? { clear: true })),
    suggestPreferences: () => json<{ suggestion: string; signals: number }>("/api/preferences/suggest", { method: "POST" }),
    startSharingan: (id, url) => json<void>(`/api/sharingan/${enc(id)}/start`, jsonInit("POST", { url })),
    cancelSharingan: (id) => json<void>(`/api/sharingan/${enc(id)}/cancel`, { method: "POST" }),
    sharinganStatus: (id) => json<SharinganStatus>(`/api/sharingan/${enc(id)}/status`),
    continueSharingan: (id) => json<void>(`/api/sharingan/${enc(id)}/continue`, jsonInit("POST")),
    focusSharingan: (id) => json<void>(`/api/sharingan/${enc(id)}/focus`, jsonInit("POST")),
    streamSharinganEvents: async function* (id, signal) {
      yield* consumeSseJson<SharinganStep>(await f(baseUrl + `/api/sharingan/${enc(id)}/events`, initWithDaemonToken({ signal })));
    },
    sharinganShotUrl: (id, relPath) => `${baseUrl}/api/sharingan/${enc(id)}/shot?path=${encodeURIComponent(relPath)}`,
  };
}
