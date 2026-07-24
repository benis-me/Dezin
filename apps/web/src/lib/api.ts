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

export interface ArtifactRevisionHistoryPage {
  items: ArtifactRevision[];
  nextCursor: string | null;
}

export interface ArtifactVersionActionExpectation {
  expectedHeadRevisionId: string | null;
  expectedSnapshotId: string;
}

export interface ForkArtifactTrackRequest extends ArtifactVersionActionExpectation {
  name: string;
}

export interface ArtifactVersionActionResult {
  action: "restore-as-new-revision" | "fork-track";
  artifact: WorkspaceArtifact;
  track: ArtifactTrack;
  revision: ArtifactRevision;
  snapshot: WorkspaceSnapshot;
}

export type PreviewTarget =
  | { kind: "artifact-current"; projectId: string; artifactId: string; trackId?: string }
  | { kind: "artifact-revision"; projectId: string; revisionId: string }
  | { kind: "run-candidate"; projectId: string; runId: string }
  | {
    kind: "generation-candidate";
    projectId: string;
    artifactId: string;
    planId: string;
    taskId: string;
    attempt: number;
  }
  | { kind: "workspace-flow"; projectId: string; snapshotId: string; startArtifactId: string; stateKey?: string }
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
  generationCandidate?: {
    planId: string;
    taskId: string;
    attempt: number;
    evidenceHash: string;
  } | null;
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

export type ResearchEvidenceStatus = "evidence" | "hypothesis";
export type ResearchRevisionQualityState = "grounded" | "needs-review";

export interface ResearchRevisionSourceView {
  id: string;
  kind: "context" | "web" | "user";
  title: string;
  locator: string;
  excerpt: string;
  notes: string;
  verification: "verified" | "unverified";
  receiptId: string;
}

export interface ResearchRevisionFindingView {
  id: string;
  statement: string;
  implication: string;
  confidence: "high" | "medium" | "low";
  evidenceStatus: ResearchEvidenceStatus;
  sourceIds: string[];
  verifiedSourceIds: string[];
  unverifiedSourceIds: string[];
  supportReceiptIds: string[];
  groundedness: {
    verified: boolean;
    verifier: { id: string; model?: string } | null;
    rationale: string;
    supportReceiptIds: string[];
  };
}

export interface ResearchRevisionPrincipleView {
  id: string;
  title: string;
  rationale: string;
  findingIds: string[];
  evidenceStatus: ResearchEvidenceStatus;
  evidenceFindingIds: string[];
  hypothesisFindingIds: string[];
}

export interface ResearchRevisionDirectionView {
  id: string;
  title: string;
  thesis: string;
  visualLanguage: string[];
  interactionPrinciples: string[];
  risks: string[];
  findingIds: string[];
  evidenceStatus: ResearchEvidenceStatus;
  evidenceFindingIds: string[];
  hypothesisFindingIds: string[];
}

export interface ResearchResourceRevisionView {
  protocol: "dezin.research-resource-revision-view.v1";
  resource: Resource;
  revision: ResourceRevision;
  observed: ResourceRevisionViewObservation;
  qualityState: ResearchRevisionQualityState;
  evidenceDirectionCount: number;
  hypothesisDirectionCount: number;
  executiveSummary: string;
  sources: ResearchRevisionSourceView[];
  findings: ResearchRevisionFindingView[];
  designPrinciples: ResearchRevisionPrincipleView[];
  directions: ResearchRevisionDirectionView[];
  openQuestions: string[];
}

export type ResourceRevisionPreviewKind = "text" | "image" | "pdf" | "video" | "audio" | "download";

export interface ResourceRevisionViewIdentity {
  id: string;
  workspaceId: string;
  resourceId: string;
  sequence: number;
  parentRevisionId: string | null;
  summary: string;
  checksum: string;
  createdAt: number;
}

export interface ResourceRevisionViewObservation {
  headRevisionId: string | null;
  snapshotId: string;
}

export interface ResourceRevisionPayloadView {
  mimeType: string;
  byteLength: number;
  checksum: string;
  previewKind: ResourceRevisionPreviewKind;
  url: string | null;
  downloadUrl: string;
}

interface ResourceRevisionViewBase {
  protocol: "dezin.resource-revision-view.v1";
  resource: Resource;
  revision: ResourceRevisionViewIdentity;
  observed: ResourceRevisionViewObservation;
  payload: ResourceRevisionPayloadView;
}

export type ResearchResourceRevisionContentView = Omit<
  ResearchResourceRevisionView,
  "protocol" | "resource" | "revision" | "observed"
>;

export interface MoodboardRevisionNodeView {
  id: string;
  type: string;
  label: string;
  text: string;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  assetId: string | null;
}

export interface MoodboardRevisionAssetView {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  byteLength: number;
  checksum: string;
  url: string | null;
  downloadUrl: string;
}

export interface MoodboardResourceRevisionContentView {
  board: { id: string; name: string; coverAssetId: string | null };
  nodes: MoodboardRevisionNodeView[];
  assets: MoodboardRevisionAssetView[];
  totalNodeCount: number;
  totalAssetCount: number;
  nodesTruncated: boolean;
  assetsTruncated: boolean;
}

export interface SharinganCaptureScreenshotView {
  id: string;
  label: string;
  width: number;
  height: number;
  url: string;
  downloadUrl: string;
}

export interface SharinganCapturePageView {
  title: string;
  requestedUrl: string;
  finalUrl: string;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  screenshots: SharinganCaptureScreenshotView[];
  dom: { nodeCount: number; tags: string[] };
  styleTokens: {
    colors: string[];
    fontFamilies: string[];
    fontSizes: string[];
    radii: string[];
    shadows: string[];
  };
  links: string[];
}

export interface SharinganCaptureResourceRevisionContentView {
  source: { requestedUrl: string; finalUrl: string; capturedAt: number };
  exporter: { id: string; version: 1 };
  pages: SharinganCapturePageView[];
}

export type EffectRevisionParameterValue = string | number | boolean;

export interface EffectRevisionParameterView {
  id: string;
  label: string;
  type: "number" | "color" | "select" | "boolean" | "image";
  defaultValue: EffectRevisionParameterValue;
  min?: number;
  max?: number;
  step?: number;
  options: Array<{ label: string; value: string }>;
  description: string;
}

export interface EffectResourceRevisionContentView {
  definition: {
    id: string;
    name: string;
    origin: "built-in" | "custom";
    category: string;
    summary: string;
    parameters: EffectRevisionParameterView[];
    presets: Array<{ id: string; name: string; values: Record<string, EffectRevisionParameterValue> }>;
    code: string;
  };
  fixture: {
    width: 640;
    height: 360;
    timesMs: [0, 500, 1_000];
    values: Record<string, EffectRevisionParameterValue>;
  };
}

export interface FileResourceRevisionContentView {
  fileName: string;
  previewKind: ResourceRevisionPreviewKind;
  text: string | null;
  textTruncated: boolean;
}

export interface AssetResourceRevisionContentView {
  fileName: string;
  mediaKind: ResourceRevisionPreviewKind;
  text: string | null;
  textTruncated: boolean;
  width: number | null;
  height: number | null;
  sourceType: string;
  sourceId: string;
}

export interface ExternalReferenceResourceRevisionContentView {
  sourceUrl: string;
  finalUrl: string;
  status: number;
  previewKind: ResourceRevisionPreviewKind;
  text: string | null;
  textTruncated: boolean;
}

export type ResourceRevisionView =
  | (ResourceRevisionViewBase & { kind: "research"; content: ResearchResourceRevisionContentView })
  | (ResourceRevisionViewBase & { kind: "moodboard"; content: MoodboardResourceRevisionContentView })
  | (ResourceRevisionViewBase & { kind: "sharingan-capture"; content: SharinganCaptureResourceRevisionContentView })
  | (ResourceRevisionViewBase & { kind: "file"; content: FileResourceRevisionContentView })
  | (ResourceRevisionViewBase & { kind: "asset"; content: AssetResourceRevisionContentView })
  | (ResourceRevisionViewBase & { kind: "effect"; content: EffectResourceRevisionContentView })
  | (ResourceRevisionViewBase & { kind: "external-reference"; content: ExternalReferenceResourceRevisionContentView });

export interface ResourceRevisionHistoryPage {
  items: ResourceRevision[];
  nextCursor: string | null;
}

export interface CreateResearchDirectionArtifactIntentInput {
  selectionRequestId: string;
  artifactId: string;
  agentCommand: "claude" | "codebuddy";
  model?: string | null;
  expectedResourceHeadRevisionId: string;
  expectedGraphRevision: number;
  expectedSnapshotId: string;
  expectedLayoutChecksum: string;
  confirmHypothesis: boolean;
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

export interface MaterializeResourceInput extends CreateResourceInput {
  source: ResourceRevisionOwnedSource;
  reason: string;
}

export interface MaterializeResourceResult extends CreateResourceResult {
  revision: ResourceRevision;
}

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

export interface WorkspaceResearchDirectionSelection {
  protocol: "dezin.research-direction-selection.v1";
  version: 1;
  resourceId: string;
  revisionId: string;
  directionId: string;
}

export interface WorkspaceGenerationArtifactPlan {
  operation: "create" | "revise";
  nodeId: string;
  artifactId: string;
  kind: WorkspaceArtifactKind;
  name: string;
  instructions?: string;
  trackId: string;
  baseRevisionId: string | null;
  dependsOnArtifactIds: string[];
  capabilityIds: string[];
  responsiveFrameIds: string[];
  researchDirectionSelection?: WorkspaceResearchDirectionSelection;
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

export type WorkspaceGenerationAgentSelection =
  | { providerId: "claude"; command: "claude"; model: string | null }
  | { providerId: "codebuddy"; command: "codebuddy"; model: string | null };

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
  /** Optional only for historical persisted Proposals; new executable mutations require it. */
  agent?: WorkspaceGenerationAgentSelection;
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
  constructionSealed?: boolean;
  executionEpoch?: number;
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

export type GenerationTaskTarget =
  | { type: "workspace"; workspaceId: string; id: string }
  | { type: "artifact"; workspaceId: string; id: string; trackId: string }
  | { type: "resource"; workspaceId: string; id: string };

export interface GenerationTask {
  id: string;
  ordinal: number;
  workspaceId: string;
  planId: string;
  kind: GenerationTaskKind;
  target: GenerationTaskTarget;
  dependencyIds: string[];
  payload?: Record<string, unknown>;
  capabilities: string[];
  status: GenerationTaskStatus;
  blockedReason: string | null;
  blockedByTaskId: string | null;
  pendingContextPolicy: "same-context" | "latest-context" | null;
  currentAttempt: number;
  materializationFailures: number;
  rebaseCount?: number;
  failureClass: string | null;
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

export interface GenerationPlanCurrentAttempt {
  taskId: string;
  attempt: number;
  status: GenerationTaskAttemptStatus;
  candidateRevisionId: string | null;
  candidateResourceRevisionId: string | null;
  candidateEvidence: Record<string, unknown> | null;
  candidateEvidenceHash: string | null;
}

export interface GenerationPlanDetail {
  plan: GenerationPlan;
  tasks: GenerationTask[];
  dependencies: GenerationTaskDependency[];
  currentAttempts: GenerationPlanCurrentAttempt[];
}

export interface GenerationPlanEvent {
  planId: string;
  sequence: number;
  taskId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type GenerationTaskRetryMode = "same-context" | "latest-context";

export interface ApprovedProposalResult {
  proposal: WorkspaceProposal;
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
  layout: WorkspaceLayout;
  plan: GenerationPlan | null;
}

export interface ApprovedResearchDirectionArtifactIntentResult {
  proposal: WorkspaceProposal;
  graph: WorkspaceGraph;
  snapshot: WorkspaceSnapshot;
  layout: WorkspaceLayout;
  plan: GenerationPlan;
  task: GenerationTask;
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
  /** Active, client-safe Resource identities and exact active Revision metadata. */
  resources?: Resource[];
  resourceRevisions?: ResourceRevision[];
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
  turnId: string;
  message: string;
  agentCommand?: string;
  model?: string;
  explicitContext: ContextItemRef[];
  graphRevision: number;
  baseRevisionId?: string;
  selection?: SelectionRef[];
}

/** Browser-owned inputs only; daemon derives Workspace scope and proposal-only intent from the route. */
export interface WorkspaceAgentTurnInput {
  turnId: string;
  message: string;
  agentCommand?: string;
  model?: string;
  explicitContext: ContextItemRef[];
  graphRevision: number;
  selection?: SelectionRef[];
}

export type ScopedAgentIntent = "generate" | "edit" | "repair";

/** Browser-owned inputs only; daemon derives the exact Artifact/Resource scope from the route. */
export interface ScopedAgentTurnInput {
  turnId: string;
  intent: ScopedAgentIntent;
  message: string;
  agentCommand?: string;
  model?: string;
  explicitContext: ContextItemRef[];
  graphRevision: number;
  baseRevisionId: string;
  selection?: SelectionRef[];
}

export interface ScopedAgentTurnReceipt {
  task: GenerationTask;
  contextPackId: string;
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
  availability?: "ready" | "not-installed" | "authentication-required" | "verification-required";
  unavailableReason?: string;
  version?: string;
  models: string[];
}

/** Streamed progress from a rescan: presence/readiness/model steps, then a final "done". */
export type ScanEvent =
  | { type: "progress"; id: string; label: string; phase: "probe" | "readiness" | "models" }
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

function codecStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => codecString(item, `${label} ${index}`));
}

const GENERATION_TASK_KINDS = [
  "resource",
  "component",
  "page",
  "prototype-validation",
  "checkpoint",
  "propagation-candidate",
  "propagation-publish",
] as const satisfies readonly GenerationTaskKind[];
const GENERATION_TASK_STATUSES = [
  "materialization-pending",
  "retry-wait",
  "blocked-context",
  "queued",
  "running",
  "candidate-ready",
  "needs-rebase",
  "awaiting-context-refresh",
  "cancel-requested",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
] as const satisfies readonly GenerationTaskStatus[];

function decodeGenerationTaskTarget(value: unknown): GenerationTaskTarget {
  const input = codecRecord(value, "Generation Task target");
  const type = codecEnum(input.type, ["workspace", "artifact", "resource"] as const, "Generation Task target type");
  const workspaceId = codecString(input.workspaceId, "Generation Task target workspaceId");
  const id = codecString(input.id, "Generation Task target id");
  if (type === "artifact") {
    return {
      type,
      workspaceId,
      id,
      trackId: codecString(input.trackId, "Generation Task target trackId"),
    };
  }
  return { type, workspaceId, id };
}

/** Decode the untrusted HTTP/storage boundary before a scoped Agent receipt reaches UI state. */
export function decodeScopedAgentTurnReceipt(value: unknown): ScopedAgentTurnReceipt {
  const input = codecRecord(value, "Scoped Agent receipt");
  const taskInput = codecRecord(input.task, "Scoped Agent receipt Task");
  const workspaceId = codecString(taskInput.workspaceId, "Generation Task workspaceId");
  const target = decodeGenerationTaskTarget(taskInput.target);
  if (target.workspaceId !== workspaceId) {
    throw new TypeError("Generation Task target belongs to another Workspace");
  }
  const pendingContextPolicy = taskInput.pendingContextPolicy === null
    ? null
    : codecEnum(
        taskInput.pendingContextPolicy,
        ["same-context", "latest-context"] as const,
        "Generation Task pendingContextPolicy",
      );
  const task: GenerationTask = {
    id: codecString(taskInput.id, "Generation Task id"),
    ordinal: codecInteger(taskInput.ordinal, "Generation Task ordinal"),
    workspaceId,
    planId: codecString(taskInput.planId, "Generation Task planId"),
    kind: codecEnum(taskInput.kind, GENERATION_TASK_KINDS, "Generation Task kind"),
    target,
    dependencyIds: codecStringArray(taskInput.dependencyIds, "Generation Task dependencyIds"),
    ...(taskInput.payload === undefined
      ? {}
      : { payload: codecRecord(taskInput.payload, "Generation Task payload") }),
    capabilities: codecStringArray(taskInput.capabilities, "Generation Task capabilities"),
    status: codecEnum(taskInput.status, GENERATION_TASK_STATUSES, "Generation Task status"),
    blockedReason: codecNullableString(taskInput.blockedReason, "Generation Task blockedReason"),
    blockedByTaskId: codecNullableString(taskInput.blockedByTaskId, "Generation Task blockedByTaskId"),
    pendingContextPolicy,
    currentAttempt: codecInteger(taskInput.currentAttempt, "Generation Task currentAttempt"),
    materializationFailures: codecInteger(taskInput.materializationFailures, "Generation Task materializationFailures"),
    ...(taskInput.rebaseCount === undefined
      ? {}
      : { rebaseCount: codecInteger(taskInput.rebaseCount, "Generation Task rebaseCount") }),
    failureClass: codecNullableString(taskInput.failureClass, "Generation Task failureClass"),
    error: taskInput.error === null ? null : codecRecord(taskInput.error, "Generation Task error"),
    nextEligibleAt: taskInput.nextEligibleAt === null
      ? null
      : codecTimestamp(taskInput.nextEligibleAt, "Generation Task nextEligibleAt"),
    resultRevisionId: codecNullableString(taskInput.resultRevisionId, "Generation Task resultRevisionId"),
    resultResourceRevisionId: codecNullableString(
      taskInput.resultResourceRevisionId,
      "Generation Task resultResourceRevisionId",
    ),
    resultSnapshotId: codecNullableString(taskInput.resultSnapshotId, "Generation Task resultSnapshotId"),
    createdAt: codecTimestamp(taskInput.createdAt, "Generation Task createdAt"),
    finishedAt: taskInput.finishedAt === null
      ? null
      : codecTimestamp(taskInput.finishedAt, "Generation Task finishedAt"),
  };
  return {
    task,
    contextPackId: codecString(input.contextPackId, "Scoped Agent receipt contextPackId"),
  };
}

function decodeResearchEvidenceReferences(input: Record<string, unknown>, label: string) {
  return {
    findingIds: codecStringArray(input.findingIds, `${label} findingIds`),
    evidenceStatus: codecEnum(input.evidenceStatus, ["evidence", "hypothesis"] as const, `${label} evidenceStatus`),
    evidenceFindingIds: codecStringArray(input.evidenceFindingIds, `${label} evidenceFindingIds`),
    hypothesisFindingIds: codecStringArray(input.hypothesisFindingIds, `${label} hypothesisFindingIds`),
  };
}

function sameStringMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} cannot contain duplicates`);
}

function sameResearchVerifier(
  left: { id: string; model?: string } | null,
  right: { id: string; model?: string } | null,
): boolean {
  return left?.id === right?.id && (left?.model ?? null) === (right?.model ?? null);
}

function assertResearchEvidenceReferences(
  item: ResearchRevisionPrincipleView | ResearchRevisionDirectionView,
  findings: ReadonlyMap<string, ResearchRevisionFindingView>,
  label: string,
): void {
  assertUniqueStrings(item.findingIds, `${label} findingIds`);
  assertUniqueStrings(item.evidenceFindingIds, `${label} evidenceFindingIds`);
  assertUniqueStrings(item.hypothesisFindingIds, `${label} hypothesisFindingIds`);
  const expectedEvidence = item.findingIds.filter((id) => findings.get(id)?.evidenceStatus === "evidence");
  const expectedHypotheses = item.findingIds.filter((id) => findings.get(id)?.evidenceStatus === "hypothesis");
  if (item.findingIds.some((id) => !findings.has(id))
    || !sameStringMembers(item.evidenceFindingIds, expectedEvidence)
    || !sameStringMembers(item.hypothesisFindingIds, expectedHypotheses)
    || item.evidenceStatus !== (expectedHypotheses.length === 0 ? "evidence" : "hypothesis")) {
    throw new TypeError(`${label} evidence references are inconsistent`);
  }
}

export function decodeResearchResourceRevision(value: unknown): ResearchResourceRevisionView {
  const input = codecExactRecord(value, [
    "protocol", "resource", "revision", "observed", "qualityState", "evidenceDirectionCount",
    "hypothesisDirectionCount", "executiveSummary", "sources", "findings", "designPrinciples", "directions",
    "openQuestions",
  ], "Research Resource Revision");
  if (input.protocol !== "dezin.research-resource-revision-view.v1") {
    throw new TypeError("Research Resource Revision protocol is unsupported");
  }
  const sources = Array.isArray(input.sources) ? input.sources.map((raw, index): ResearchRevisionSourceView => {
    const source = codecExactRecord(raw, [
      "id", "kind", "title", "locator", "excerpt", "notes", "verification", "receiptId",
    ], `Research source ${index}`);
    const kind = codecEnum(source.kind, ["context", "web", "user"] as const, `Research source ${index} kind`);
    return {
      id: codecString(source.id, `Research source ${index} id`),
      kind,
      title: codecString(source.title, `Research source ${index} title`),
      locator: kind === "web"
        ? codecHttpUrl(source.locator, `Research source ${index} locator`)
        : codecString(source.locator, `Research source ${index} locator`),
      excerpt: codecString(source.excerpt, `Research source ${index} excerpt`),
      notes: typeof source.notes === "string" ? source.notes : (() => { throw new TypeError(`Research source ${index} notes must be a string`); })(),
      verification: codecEnum(source.verification, ["verified", "unverified"] as const, `Research source ${index} verification`),
      receiptId: codecString(source.receiptId, `Research source ${index} receiptId`),
    };
  }) : (() => { throw new TypeError("Research sources must be an array"); })();
  const findings = Array.isArray(input.findings) ? input.findings.map((raw, index): ResearchRevisionFindingView => {
    const finding = codecExactRecord(raw, [
      "id", "statement", "implication", "confidence", "evidenceStatus", "sourceIds", "verifiedSourceIds",
      "unverifiedSourceIds", "supportReceiptIds", "groundedness",
    ], `Research finding ${index}`);
    const groundedness = codecExactRecord(
      finding.groundedness,
      ["verified", "verifier", "rationale", "supportReceiptIds"],
      `Research finding ${index} groundedness`,
    );
    const rawVerifier = groundedness.verifier === null
      ? null
      : codecExactRecord(groundedness.verifier, ["id", "model"], `Research finding ${index} verifier`);
    if (typeof groundedness.verified !== "boolean") throw new TypeError(`Research finding ${index} verified must be boolean`);
    return {
      id: codecString(finding.id, `Research finding ${index} id`),
      statement: codecString(finding.statement, `Research finding ${index} statement`),
      implication: codecString(finding.implication, `Research finding ${index} implication`),
      confidence: codecEnum(finding.confidence, ["high", "medium", "low"] as const, `Research finding ${index} confidence`),
      evidenceStatus: codecEnum(finding.evidenceStatus, ["evidence", "hypothesis"] as const, `Research finding ${index} evidenceStatus`),
      sourceIds: codecStringArray(finding.sourceIds, `Research finding ${index} sourceIds`),
      verifiedSourceIds: codecStringArray(finding.verifiedSourceIds, `Research finding ${index} verifiedSourceIds`),
      unverifiedSourceIds: codecStringArray(finding.unverifiedSourceIds, `Research finding ${index} unverifiedSourceIds`),
      supportReceiptIds: codecStringArray(finding.supportReceiptIds, `Research finding ${index} supportReceiptIds`),
      groundedness: {
        verified: groundedness.verified,
        verifier: rawVerifier === null ? null : {
          id: codecString(rawVerifier.id, `Research finding ${index} verifier id`),
          ...(rawVerifier.model === undefined
            ? {}
            : { model: codecString(rawVerifier.model, `Research finding ${index} verifier model`) }),
        },
        rationale: codecString(groundedness.rationale, `Research finding ${index} groundedness rationale`),
        supportReceiptIds: codecStringArray(
          groundedness.supportReceiptIds,
          `Research finding ${index} groundedness supportReceiptIds`,
        ),
      },
    };
  }) : (() => { throw new TypeError("Research findings must be an array"); })();
  const designPrinciples = Array.isArray(input.designPrinciples)
    ? input.designPrinciples.map((raw, index): ResearchRevisionPrincipleView => {
        const principle = codecExactRecord(raw, [
          "id", "title", "rationale", "findingIds", "evidenceStatus", "evidenceFindingIds", "hypothesisFindingIds",
        ], `Research principle ${index}`);
        return {
          id: codecString(principle.id, `Research principle ${index} id`),
          title: codecString(principle.title, `Research principle ${index} title`),
          rationale: codecString(principle.rationale, `Research principle ${index} rationale`),
          ...decodeResearchEvidenceReferences(principle, `Research principle ${index}`),
        };
      })
    : (() => { throw new TypeError("Research principles must be an array"); })();
  const directions = Array.isArray(input.directions)
    ? input.directions.map((raw, index): ResearchRevisionDirectionView => {
        const direction = codecExactRecord(raw, [
          "id", "title", "thesis", "visualLanguage", "interactionPrinciples", "risks", "findingIds",
          "evidenceStatus", "evidenceFindingIds", "hypothesisFindingIds",
        ], `Research direction ${index}`);
        return {
          id: codecString(direction.id, `Research direction ${index} id`),
          title: codecString(direction.title, `Research direction ${index} title`),
          thesis: codecString(direction.thesis, `Research direction ${index} thesis`),
          visualLanguage: codecStringArray(direction.visualLanguage, `Research direction ${index} visualLanguage`),
          interactionPrinciples: codecStringArray(direction.interactionPrinciples, `Research direction ${index} interactionPrinciples`),
          risks: codecStringArray(direction.risks, `Research direction ${index} risks`),
          ...decodeResearchEvidenceReferences(direction, `Research direction ${index}`),
        };
      })
    : (() => { throw new TypeError("Research directions must be an array"); })();
  if (sources.length < 2 || findings.length < 3 || designPrinciples.length < 3 || directions.length < 2) {
    throw new TypeError("Research Resource Revision does not meet the production schema minimums");
  }
  const sourceIds = sources.map((source) => source.id);
  const sourceReceiptIds = sources.map((source) => source.receiptId);
  assertUniqueStrings(sourceIds, "Research source ids");
  assertUniqueStrings(sourceReceiptIds, "Research source receipt ids");
  for (const [index, source] of sources.entries()) {
    if (!/^research-evidence-[a-f0-9]{64}$/.test(source.receiptId)) {
      throw new TypeError(`Research source ${index} receiptId is not canonical`);
    }
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const findingIds = findings.map((finding) => finding.id);
  assertUniqueStrings(findingIds, "Research finding ids");
  const claimedSupportReceiptIds: string[] = [];
  const expectedVerifier = findings.find((finding) => finding.groundedness.verifier !== null)?.groundedness.verifier ?? null;
  for (const [index, finding] of findings.entries()) {
    assertUniqueStrings(finding.sourceIds, `Research finding ${index} sourceIds`);
    assertUniqueStrings(finding.verifiedSourceIds, `Research finding ${index} verifiedSourceIds`);
    assertUniqueStrings(finding.unverifiedSourceIds, `Research finding ${index} unverifiedSourceIds`);
    assertUniqueStrings(finding.supportReceiptIds, `Research finding ${index} supportReceiptIds`);
    assertUniqueStrings(finding.groundedness.supportReceiptIds, `Research finding ${index} grounded supportReceiptIds`);
    const expectedVerified = finding.sourceIds.filter((id) => sourceById.get(id)?.verification === "verified");
    const expectedUnverified = finding.sourceIds.filter((id) => sourceById.get(id)?.verification === "unverified");
    const evidence = finding.evidenceStatus === "evidence";
    if (finding.sourceIds.some((id) => !sourceById.has(id))
      || !sameStringMembers(finding.verifiedSourceIds, expectedVerified)
      || !sameStringMembers(finding.unverifiedSourceIds, expectedUnverified)
      || finding.supportReceiptIds.length < 1
      || finding.supportReceiptIds.some((id) => !/^research-support-[a-f0-9]{64}$/.test(id))
      || finding.groundedness.supportReceiptIds.some((id) => !finding.supportReceiptIds.includes(id))
      || finding.groundedness.verified !== evidence
      || !sameResearchVerifier(finding.groundedness.verifier, expectedVerifier)
      || (evidence && (finding.groundedness.verifier === null
        || expectedUnverified.length > 0
        || !sameStringMembers(finding.groundedness.supportReceiptIds, finding.supportReceiptIds)))
      || (!evidence && finding.confidence !== "low")) {
      throw new TypeError(`Research finding ${index} evidence projection is inconsistent`);
    }
    claimedSupportReceiptIds.push(...finding.supportReceiptIds);
  }
  assertUniqueStrings(claimedSupportReceiptIds, "Research support receipt ids");
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  assertUniqueStrings(designPrinciples.map((principle) => principle.id), "Research principle ids");
  designPrinciples.forEach((principle, index) => {
    assertResearchEvidenceReferences(principle, findingById, `Research principle ${index}`);
  });
  assertUniqueStrings(directions.map((direction) => direction.id), "Research direction ids");
  directions.forEach((direction, index) => {
    assertResearchEvidenceReferences(direction, findingById, `Research direction ${index}`);
  });
  const evidenceDirectionCount = directions.filter((direction) => direction.evidenceStatus === "evidence").length;
  const hypothesisDirectionCount = directions.length - evidenceDirectionCount;
  const qualityState = codecEnum(input.qualityState, ["grounded", "needs-review"] as const, "Research qualityState");
  if (codecInteger(input.evidenceDirectionCount, "Research evidenceDirectionCount") !== evidenceDirectionCount
    || codecInteger(input.hypothesisDirectionCount, "Research hypothesisDirectionCount") !== hypothesisDirectionCount
    || qualityState !== (evidenceDirectionCount > 0 ? "grounded" : "needs-review")) {
    throw new TypeError("Research quality projection is inconsistent");
  }
  const resource = decodeResource(input.resource);
  const revision = decodeResourceRevision(input.revision);
  const observed = decodeResourceRevisionViewObservation(input.observed);
  if (resource.kind !== "research" || revision.workspaceId !== resource.workspaceId
    || revision.resourceId !== resource.id || observed.headRevisionId !== resource.headRevisionId) {
    throw new TypeError("Research Resource Revision ownership is inconsistent");
  }
  return {
    protocol: input.protocol,
    resource,
    revision,
    observed,
    qualityState,
    evidenceDirectionCount,
    hypothesisDirectionCount,
    executiveSummary: codecString(input.executiveSummary, "Research executiveSummary"),
    sources,
    findings,
    designPrinciples,
    directions,
    openQuestions: codecStringArray(input.openQuestions, "Research openQuestions"),
  };
}

function codecBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function codecNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string or null`);
  return value;
}

function codecFiniteNullable(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite or null`);
  return value;
}

function codecArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must be a bounded array`);
  return value;
}

function codecSha256(value: unknown, label: string): string {
  const checksum = codecString(value, label);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new TypeError(`${label} must be a SHA-256 checksum`);
  return checksum;
}

function codecApiPath(value: unknown, label: string): string {
  const path = codecString(value, label);
  if (!path.startsWith("/api/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new TypeError(`${label} must be a daemon API path`);
  }
  return path;
}

function codecHttpUrl(value: unknown, label: string): string {
  const raw = codecString(value, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be an HTTP(S) URL`);
  }
  const credentialParameter = /(?:^|[_-])(?:access[_-]?token|token|api[_-]?key|secret|signature|sig|auth|authorization|password|credential)(?:$|[_-])/i;
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
    || url.hash || url.href !== raw
    || [...url.searchParams.keys()].some((key) => credentialParameter.test(key))) {
    throw new TypeError(`${label} must be a canonical credential-free HTTP(S) URL`);
  }
  return raw;
}

function decodeResourceRevisionViewIdentity(value: unknown): ResourceRevisionViewIdentity {
  const input = codecExactRecord(value, [
    "id", "workspaceId", "resourceId", "sequence", "parentRevisionId", "summary", "checksum", "createdAt",
  ], "Resource Revision view identity");
  return {
    id: codecString(input.id, "Resource Revision view id"),
    workspaceId: codecString(input.workspaceId, "Resource Revision view workspaceId"),
    resourceId: codecString(input.resourceId, "Resource Revision view resourceId"),
    sequence: codecInteger(input.sequence, "Resource Revision view sequence", 1),
    parentRevisionId: codecNullableString(input.parentRevisionId, "Resource Revision view parentRevisionId"),
    summary: codecString(input.summary, "Resource Revision view summary"),
    checksum: codecSha256(input.checksum, "Resource Revision view checksum"),
    createdAt: codecTimestamp(input.createdAt, "Resource Revision view createdAt"),
  };
}

function decodeResourceRevisionViewObservation(value: unknown): ResourceRevisionViewObservation {
  const input = codecExactRecord(value, ["headRevisionId", "snapshotId"], "Resource Revision observation");
  return {
    headRevisionId: codecNullableString(input.headRevisionId, "Resource Revision observed Head"),
    snapshotId: codecString(input.snapshotId, "Resource Revision observed Snapshot"),
  };
}

function decodeResourceRevisionPayloadView(value: unknown): ResourceRevisionPayloadView {
  const input = codecExactRecord(
    value,
    ["mimeType", "byteLength", "checksum", "previewKind", "url", "downloadUrl"],
    "Resource Revision payload view",
  );
  const previewKind = codecEnum(
    input.previewKind,
    ["text", "image", "pdf", "video", "audio", "download"] as const,
    "Resource Revision payload previewKind",
  );
  const url = input.url === null ? null : codecApiPath(input.url, "Resource Revision payload URL");
  if ((previewKind === "image" || previewKind === "pdf" || previewKind === "video" || previewKind === "audio")
    !== (url !== null)) {
    throw new TypeError("Resource Revision payload inline URL does not match its preview kind");
  }
  return {
    mimeType: codecString(input.mimeType, "Resource Revision payload MIME"),
    byteLength: codecInteger(input.byteLength, "Resource Revision payload byteLength"),
    checksum: codecSha256(input.checksum, "Resource Revision payload checksum"),
    previewKind,
    url,
    downloadUrl: codecApiPath(input.downloadUrl, "Resource Revision payload download URL"),
  };
}

function decodeMoodboardContent(value: unknown): MoodboardResourceRevisionContentView {
  const input = codecExactRecord(value, [
    "board", "nodes", "assets", "totalNodeCount", "totalAssetCount", "nodesTruncated", "assetsTruncated",
  ], "Moodboard Revision content");
  const board = codecExactRecord(input.board, ["id", "name", "coverAssetId"], "Moodboard Revision board");
  const nodes = codecArray(input.nodes, "Moodboard Revision nodes", 256).map((raw, index): MoodboardRevisionNodeView => {
    const node = codecExactRecord(raw, [
      "id", "type", "label", "text", "x", "y", "width", "height", "assetId",
    ], `Moodboard Revision node ${index}`);
    return {
      id: codecString(node.id, `Moodboard Revision node ${index} id`),
      type: codecString(node.type, `Moodboard Revision node ${index} type`),
      label: typeof node.label === "string" ? node.label : (() => { throw new TypeError(`Moodboard Revision node ${index} label must be a string`); })(),
      text: typeof node.text === "string" ? node.text : (() => { throw new TypeError(`Moodboard Revision node ${index} text must be a string`); })(),
      x: codecFiniteNullable(node.x, `Moodboard Revision node ${index} x`),
      y: codecFiniteNullable(node.y, `Moodboard Revision node ${index} y`),
      width: codecFiniteNullable(node.width, `Moodboard Revision node ${index} width`),
      height: codecFiniteNullable(node.height, `Moodboard Revision node ${index} height`),
      assetId: codecNullableString(node.assetId, `Moodboard Revision node ${index} assetId`),
    };
  });
  const assets = codecArray(input.assets, "Moodboard Revision Assets", 128).map((raw, index): MoodboardRevisionAssetView => {
    const asset = codecExactRecord(raw, [
      "id", "kind", "fileName", "mimeType", "width", "height", "byteLength", "checksum", "url", "downloadUrl",
    ], `Moodboard Revision Asset ${index}`);
    return {
      id: codecString(asset.id, `Moodboard Revision Asset ${index} id`),
      kind: codecString(asset.kind, `Moodboard Revision Asset ${index} kind`),
      fileName: codecString(asset.fileName, `Moodboard Revision Asset ${index} fileName`),
      mimeType: codecString(asset.mimeType, `Moodboard Revision Asset ${index} MIME`),
      width: codecFiniteNullable(asset.width, `Moodboard Revision Asset ${index} width`),
      height: codecFiniteNullable(asset.height, `Moodboard Revision Asset ${index} height`),
      byteLength: codecInteger(asset.byteLength, `Moodboard Revision Asset ${index} byteLength`),
      checksum: codecSha256(asset.checksum, `Moodboard Revision Asset ${index} checksum`),
      url: asset.url === null ? null : codecApiPath(asset.url, `Moodboard Revision Asset ${index} URL`),
      downloadUrl: codecApiPath(asset.downloadUrl, `Moodboard Revision Asset ${index} download URL`),
    };
  });
  const totalNodeCount = codecInteger(input.totalNodeCount, "Moodboard Revision totalNodeCount");
  const totalAssetCount = codecInteger(input.totalAssetCount, "Moodboard Revision totalAssetCount");
  const nodesTruncated = codecBoolean(input.nodesTruncated, "Moodboard Revision nodesTruncated");
  const assetsTruncated = codecBoolean(input.assetsTruncated, "Moodboard Revision assetsTruncated");
  if (totalNodeCount < nodes.length || totalAssetCount < assets.length
    || nodesTruncated !== (totalNodeCount > nodes.length)
    || assetsTruncated !== (totalAssetCount > assets.length)) {
    throw new TypeError("Moodboard Revision projection counts are inconsistent");
  }
  return {
    board: {
      id: codecString(board.id, "Moodboard Revision board id"),
      name: codecString(board.name, "Moodboard Revision board name"),
      coverAssetId: codecNullableString(board.coverAssetId, "Moodboard Revision board coverAssetId"),
    },
    nodes,
    assets,
    totalNodeCount,
    totalAssetCount,
    nodesTruncated,
    assetsTruncated,
  };
}

function decodeSharinganContent(value: unknown): SharinganCaptureResourceRevisionContentView {
  const input = codecExactRecord(value, ["source", "exporter", "pages"], "Sharingan Revision content");
  const source = codecExactRecord(input.source, ["requestedUrl", "finalUrl", "capturedAt"], "Sharingan Revision source");
  const exporter = codecExactRecord(input.exporter, ["id", "version"], "Sharingan Revision exporter");
  if (exporter.version !== 1) throw new TypeError("Sharingan Revision exporter version is unsupported");
  const pages = codecArray(input.pages, "Sharingan Revision pages", 8).map((raw, pageIndex): SharinganCapturePageView => {
    const page = codecExactRecord(raw, [
      "title", "requestedUrl", "finalUrl", "viewport", "document", "screenshots", "dom", "styleTokens", "links",
    ], `Sharingan Revision page ${pageIndex}`);
    const dimensions = (rawValue: unknown, label: string) => {
      const value = codecExactRecord(rawValue, ["width", "height"], label);
      return {
        width: codecInteger(value.width, `${label} width`, 1),
        height: codecInteger(value.height, `${label} height`, 1),
      };
    };
    const screenshots = codecArray(page.screenshots, `Sharingan Revision page ${pageIndex} screenshots`, 16)
      .map((rawScreenshot, screenshotIndex): SharinganCaptureScreenshotView => {
        const screenshot = codecExactRecord(rawScreenshot, [
          "id", "label", "width", "height", "url", "downloadUrl",
        ], `Sharingan Revision screenshot ${screenshotIndex}`);
        return {
          id: codecString(screenshot.id, `Sharingan Revision screenshot ${screenshotIndex} id`),
          label: codecString(screenshot.label, `Sharingan Revision screenshot ${screenshotIndex} label`),
          width: codecInteger(screenshot.width, `Sharingan Revision screenshot ${screenshotIndex} width`, 1),
          height: codecInteger(screenshot.height, `Sharingan Revision screenshot ${screenshotIndex} height`, 1),
          url: codecApiPath(screenshot.url, `Sharingan Revision screenshot ${screenshotIndex} URL`),
          downloadUrl: codecApiPath(screenshot.downloadUrl, `Sharingan Revision screenshot ${screenshotIndex} download URL`),
        };
      });
    const dom = codecExactRecord(page.dom, ["nodeCount", "tags"], `Sharingan Revision page ${pageIndex} DOM`);
    const tokens = codecExactRecord(
      page.styleTokens,
      ["colors", "fontFamilies", "fontSizes", "radii", "shadows"],
      `Sharingan Revision page ${pageIndex} style tokens`,
    );
    return {
      title: codecString(page.title, `Sharingan Revision page ${pageIndex} title`),
      requestedUrl: codecHttpUrl(page.requestedUrl, `Sharingan Revision page ${pageIndex} requestedUrl`),
      finalUrl: codecHttpUrl(page.finalUrl, `Sharingan Revision page ${pageIndex} finalUrl`),
      viewport: dimensions(page.viewport, `Sharingan Revision page ${pageIndex} viewport`),
      document: dimensions(page.document, `Sharingan Revision page ${pageIndex} document`),
      screenshots,
      dom: {
        nodeCount: codecInteger(dom.nodeCount, `Sharingan Revision page ${pageIndex} DOM nodeCount`),
        tags: codecStringArray(dom.tags, `Sharingan Revision page ${pageIndex} DOM tags`),
      },
      styleTokens: {
        colors: codecStringArray(tokens.colors, `Sharingan Revision page ${pageIndex} colors`),
        fontFamilies: codecStringArray(tokens.fontFamilies, `Sharingan Revision page ${pageIndex} fontFamilies`),
        fontSizes: codecStringArray(tokens.fontSizes, `Sharingan Revision page ${pageIndex} fontSizes`),
        radii: codecStringArray(tokens.radii, `Sharingan Revision page ${pageIndex} radii`),
        shadows: codecStringArray(tokens.shadows, `Sharingan Revision page ${pageIndex} shadows`),
      },
      links: codecStringArray(page.links, `Sharingan Revision page ${pageIndex} links`),
    };
  });
  return {
    source: {
      requestedUrl: codecHttpUrl(source.requestedUrl, "Sharingan Revision source requestedUrl"),
      finalUrl: codecHttpUrl(source.finalUrl, "Sharingan Revision source finalUrl"),
      capturedAt: codecTimestamp(source.capturedAt, "Sharingan Revision source capturedAt"),
    },
    exporter: { id: codecString(exporter.id, "Sharingan Revision exporter id"), version: 1 },
    pages,
  };
}

function codecEffectValue(value: unknown, label: string): EffectRevisionParameterValue {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new TypeError(`${label} must be a string, number, or boolean`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function decodeEffectContent(value: unknown): EffectResourceRevisionContentView {
  const input = codecExactRecord(value, ["definition", "fixture"], "Effect Revision content");
  const definition = codecExactRecord(input.definition, [
    "id", "name", "origin", "category", "summary", "parameters", "presets", "code",
  ], "Effect Revision definition");
  const parameters = codecArray(definition.parameters, "Effect Revision parameters", 128)
    .map((raw, index): EffectRevisionParameterView => {
      const parameter = codecExactRecord(raw, [
        "id", "label", "type", "defaultValue", "min", "max", "step", "options", "description",
      ], `Effect Revision parameter ${index}`);
      const optionalFinite = (field: "min" | "max" | "step"): number | undefined => (
        parameter[field] === undefined
          ? undefined
          : codecFiniteNullable(parameter[field], `Effect Revision parameter ${index} ${field}`) ?? undefined
      );
      return {
        id: codecString(parameter.id, `Effect Revision parameter ${index} id`),
        label: codecString(parameter.label, `Effect Revision parameter ${index} label`),
        type: codecEnum(
          parameter.type,
          ["number", "color", "select", "boolean", "image"] as const,
          `Effect Revision parameter ${index} type`,
        ),
        defaultValue: codecEffectValue(parameter.defaultValue, `Effect Revision parameter ${index} defaultValue`),
        ...(optionalFinite("min") === undefined ? {} : { min: optionalFinite("min") }),
        ...(optionalFinite("max") === undefined ? {} : { max: optionalFinite("max") }),
        ...(optionalFinite("step") === undefined ? {} : { step: optionalFinite("step") }),
        options: codecArray(parameter.options, `Effect Revision parameter ${index} options`, 64).map((rawOption, optionIndex) => {
          const option = codecExactRecord(rawOption, ["label", "value"], `Effect Revision option ${optionIndex}`);
          return {
            label: codecString(option.label, `Effect Revision option ${optionIndex} label`),
            value: codecString(option.value, `Effect Revision option ${optionIndex} value`),
          };
        }),
        description: typeof parameter.description === "string"
          ? parameter.description
          : (() => { throw new TypeError(`Effect Revision parameter ${index} description must be a string`); })(),
      };
    });
  const presets = codecArray(definition.presets, "Effect Revision presets", 64).map((raw, index) => {
    const preset = codecExactRecord(raw, ["id", "name", "values"], `Effect Revision preset ${index}`);
    const values = codecRecord(preset.values, `Effect Revision preset ${index} values`);
    return {
      id: codecString(preset.id, `Effect Revision preset ${index} id`),
      name: codecString(preset.name, `Effect Revision preset ${index} name`),
      values: Object.fromEntries(Object.entries(values).map(([key, item]) => [
        key,
        codecEffectValue(item, `Effect Revision preset ${index} value ${key}`),
      ])),
    };
  });
  const fixture = codecExactRecord(input.fixture, ["width", "height", "timesMs", "values"], "Effect Revision fixture");
  if (fixture.width !== 640 || fixture.height !== 360
    || !Array.isArray(fixture.timesMs) || fixture.timesMs.length !== 3
    || fixture.timesMs[0] !== 0 || fixture.timesMs[1] !== 500 || fixture.timesMs[2] !== 1_000) {
    throw new TypeError("Effect Revision fixture is not canonical");
  }
  const fixtureValues = codecRecord(fixture.values, "Effect Revision fixture values");
  return {
    definition: {
      id: codecString(definition.id, "Effect Revision definition id"),
      name: codecString(definition.name, "Effect Revision definition name"),
      origin: codecEnum(definition.origin, ["built-in", "custom"] as const, "Effect Revision definition origin"),
      category: codecString(definition.category, "Effect Revision definition category"),
      summary: codecString(definition.summary, "Effect Revision definition summary"),
      parameters,
      presets,
      code: codecString(definition.code, "Effect Revision definition code"),
    },
    fixture: {
      width: 640,
      height: 360,
      timesMs: [0, 500, 1_000],
      values: Object.fromEntries(Object.entries(fixtureValues).map(([key, item]) => [
        key,
        codecEffectValue(item, `Effect Revision fixture value ${key}`),
      ])),
    },
  };
}

export function decodeResourceRevisionView(value: unknown): ResourceRevisionView {
  const input = codecExactRecord(
    value,
    ["protocol", "kind", "resource", "revision", "observed", "payload", "content"],
    "Resource Revision view",
  );
  if (input.protocol !== "dezin.resource-revision-view.v1") {
    throw new TypeError("Resource Revision view protocol is unsupported");
  }
  const kind = codecEnum(input.kind, RESOURCE_KINDS, "Resource Revision view kind");
  const resource = decodeResource(input.resource);
  const revision = decodeResourceRevisionViewIdentity(input.revision);
  const observed = decodeResourceRevisionViewObservation(input.observed);
  const payload = decodeResourceRevisionPayloadView(input.payload);
  if (resource.kind !== kind || resource.workspaceId !== revision.workspaceId || resource.id !== revision.resourceId) {
    throw new TypeError("Resource Revision view ownership is inconsistent");
  }
  const common: ResourceRevisionViewBase = {
    protocol: "dezin.resource-revision-view.v1",
    resource,
    revision,
    observed,
    payload,
  };
  if (kind === "moodboard") return { ...common, kind, content: decodeMoodboardContent(input.content) };
  if (kind === "sharingan-capture") return { ...common, kind, content: decodeSharinganContent(input.content) };
  if (kind === "effect") return { ...common, kind, content: decodeEffectContent(input.content) };
  if (kind === "file") {
    const content = codecExactRecord(input.content, ["fileName", "previewKind", "text", "textTruncated"], "File Revision content");
    return {
      ...common,
      kind,
      content: {
        fileName: codecString(content.fileName, "File Revision fileName"),
        previewKind: codecEnum(content.previewKind, ["text", "image", "pdf", "video", "audio", "download"] as const, "File Revision previewKind"),
        text: codecNullableText(content.text, "File Revision text"),
        textTruncated: codecBoolean(content.textTruncated, "File Revision textTruncated"),
      },
    };
  }
  if (kind === "asset") {
    const content = codecExactRecord(input.content, [
      "fileName", "mediaKind", "text", "textTruncated", "width", "height", "sourceType", "sourceId",
    ], "Asset Revision content");
    return {
      ...common,
      kind,
      content: {
        fileName: codecString(content.fileName, "Asset Revision fileName"),
        mediaKind: codecEnum(content.mediaKind, ["text", "image", "pdf", "video", "audio", "download"] as const, "Asset Revision mediaKind"),
        text: codecNullableText(content.text, "Asset Revision text"),
        textTruncated: codecBoolean(content.textTruncated, "Asset Revision textTruncated"),
        width: codecFiniteNullable(content.width, "Asset Revision width"),
        height: codecFiniteNullable(content.height, "Asset Revision height"),
        sourceType: codecString(content.sourceType, "Asset Revision sourceType"),
        sourceId: codecString(content.sourceId, "Asset Revision sourceId"),
      },
    };
  }
  if (kind === "external-reference") {
    const content = codecExactRecord(input.content, [
      "sourceUrl", "finalUrl", "status", "previewKind", "text", "textTruncated",
    ], "External Reference Revision content");
    return {
      ...common,
      kind,
      content: {
        sourceUrl: codecHttpUrl(content.sourceUrl, "External Reference sourceUrl"),
        finalUrl: codecHttpUrl(content.finalUrl, "External Reference finalUrl"),
        status: codecInteger(content.status, "External Reference status", 100),
        previewKind: codecEnum(content.previewKind, ["text", "image", "pdf", "video", "audio", "download"] as const, "External Reference previewKind"),
        text: codecNullableText(content.text, "External Reference text"),
        textTruncated: codecBoolean(content.textTruncated, "External Reference textTruncated"),
      },
    };
  }
  const researchContent = codecExactRecord(input.content, [
    "qualityState", "evidenceDirectionCount", "hypothesisDirectionCount", "executiveSummary", "sources", "findings",
    "designPrinciples", "directions", "openQuestions",
  ], "Research Revision content");
  const decoded = decodeResearchResourceRevision({
    protocol: "dezin.research-resource-revision-view.v1",
    resource,
    revision: {
      ...revision,
      manifestPath: "client-safe-view",
      metadata: {},
      provenance: {},
      createdByRunId: null,
    },
    ...researchContent,
    observed,
  });
  const {
    protocol: _protocol,
    resource: _resource,
    revision: _revision,
    observed: _observed,
    ...content
  } = decoded;
  return { ...common, kind: "research", content };
}

export function decodeResourceRevisionHistoryPage(value: unknown): ResourceRevisionHistoryPage {
  const input = codecExactRecord(value, ["items", "nextCursor"], "Resource Revision history page");
  const items = decodeArray(input.items, decodeResourceRevision, "Resource Revision history items");
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    if (previous.createdAt < current.createdAt
      || (previous.createdAt === current.createdAt && previous.id <= current.id)) {
      throw new TypeError("Resource Revision history is not in stable descending order");
    }
  }
  return {
    items,
    nextCursor: codecNullableString(input.nextCursor, "Resource Revision history nextCursor"),
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

function encodeMaterializeResourceInput(value: MaterializeResourceInput): MaterializeResourceInput {
  const input = codecExactRecord(value, [
    "kind", "title", "defaultPinPolicy", "baseGraphRevision", "expectedSnapshotId", "source", "reason",
  ], "Materialize Resource request");
  const resource = encodeCreateResourceInput({
    kind: input.kind as WorkspaceResourceKind,
    title: input.title as string,
    defaultPinPolicy: input.defaultPinPolicy as ResourcePinPolicy,
    baseGraphRevision: input.baseGraphRevision as number,
    expectedSnapshotId: input.expectedSnapshotId as string,
  });
  const source = encodeOwnedResourceSource(input.source as ResourceRevisionOwnedSource);
  const expectedKind: WorkspaceResourceKind = source.type === "moodboard"
    ? "moodboard"
    : source.type === "effect"
      ? "effect"
      : source.type === "asset"
        ? "asset"
        : source.type === "external-reference"
          ? "external-reference"
          : "file";
  if (resource.kind !== expectedKind) {
    throw new TypeError("Materialize Resource kind does not match its owned source type");
  }
  return {
    ...resource,
    source,
    reason: codecBoundedString(input.reason, "Materialize Resource reason", 2_000),
  };
}

function encodeCreateResearchDirectionArtifactIntentInput(
  value: CreateResearchDirectionArtifactIntentInput,
): CreateResearchDirectionArtifactIntentInput {
  const input = codecExactRecord(value, [
    "selectionRequestId",
    "artifactId",
    "agentCommand",
    "model",
    "expectedResourceHeadRevisionId",
    "expectedGraphRevision",
    "expectedSnapshotId",
    "expectedLayoutChecksum",
    "confirmHypothesis",
  ], "Research direction Artifact intent request");
  if (typeof input.confirmHypothesis !== "boolean") {
    throw new TypeError("Research direction confirmHypothesis must be boolean");
  }
  const agentCommand = codecEnum(
    input.agentCommand,
    ["claude", "codebuddy"] as const,
    "Research direction Agent command",
  );
  const model = input.model === undefined
    ? undefined
    : input.model === null
      ? null
      : codecBoundedString(input.model, "Research direction Agent model", 256);
  if (typeof model === "string" && (
    model !== model.trim()
    || model.includes("\0")
    || new TextEncoder().encode(model).byteLength > 256
  )) {
    throw new TypeError("Research direction Agent model must be canonical");
  }
  return {
    selectionRequestId: codecString(input.selectionRequestId, "Research direction selectionRequestId"),
    artifactId: codecString(input.artifactId, "Research direction artifactId"),
    agentCommand,
    ...(model === undefined ? {} : { model }),
    expectedResourceHeadRevisionId: codecString(
      input.expectedResourceHeadRevisionId,
      "Research direction expectedResourceHeadRevisionId",
    ),
    expectedGraphRevision: codecInteger(input.expectedGraphRevision, "Research direction expectedGraphRevision"),
    expectedSnapshotId: codecString(input.expectedSnapshotId, "Research direction expectedSnapshotId"),
    expectedLayoutChecksum: codecString(input.expectedLayoutChecksum, "Research direction expectedLayoutChecksum"),
    confirmHypothesis: input.confirmHypothesis,
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

function decodeMaterializeResourceResult(value: unknown): MaterializeResourceResult {
  const input = codecExactRecord(
    value,
    ["resource", "node", "revision", "graph", "snapshot"],
    "Materialize Resource response",
  );
  const created = decodeCreateResourceResult(input);
  const revision = decodeResourceRevision(input.revision);
  if (revision.resourceId !== created.resource.id
    || revision.workspaceId !== created.resource.workspaceId
    || revision.sequence !== 1
    || revision.parentRevisionId !== null
    || created.resource.headRevisionId !== revision.id) {
    throw new TypeError("Materialize Resource response does not describe one exact first published Revision");
  }
  if (created.node.resourceId !== created.resource.id
    || created.node.workspaceId !== created.resource.workspaceId) {
    throw new TypeError("Materialize Resource node ownership is inconsistent");
  }
  const graph = codecRecord(created.graph, "Materialize Resource graph");
  if (codecString(graph.workspaceId, "Materialize Resource graph workspaceId") !== created.resource.workspaceId
    || !codecArray(graph.nodes, "Materialize Resource graph nodes", 10_000).some((candidate) => {
      const node = codecRecord(candidate, "Materialize Resource graph node");
      return node.id === created.node.id && node.resourceId === created.resource.id && node.kind === "resource";
    })) {
    throw new TypeError("Materialize Resource graph does not contain its exact Resource node");
  }
  const snapshot = codecRecord(created.snapshot, "Materialize Resource Snapshot");
  const resourceRevisions = codecRecord(
    snapshot.resourceRevisions,
    "Materialize Resource Snapshot Resource revisions",
  );
  if (codecString(snapshot.workspaceId, "Materialize Resource Snapshot workspaceId") !== created.resource.workspaceId
    || resourceRevisions[created.resource.id] !== revision.id) {
    throw new TypeError("Materialize Resource Snapshot does not pin its exact first Revision");
  }
  return { ...created, revision };
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

interface ParsedSseBlock {
  event: string | null;
  data: unknown;
}

function parseSseEnvelope(block: string): ParsedSseBlock | null {
  const eventLine = block
    .split("\n")
    .find((line) => line.startsWith("event:"));
  const dataLines = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)));
  if (dataLines.length === 0) return null;
  try {
    return {
      event: eventLine === undefined ? null : eventLine.slice(6).trim() || null,
      data: JSON.parse(dataLines.join("\n")) as unknown,
    };
  } catch {
    return null;
  }
}

/** Parse one SSE block ("data: {...}" possibly multi-line) into a RunEvent. */
export function parseSseBlock(block: string): RunEvent | null {
  return (parseSseEnvelope(block)?.data as RunEvent | undefined) ?? null;
}

export class GenerationPlanStreamError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "GenerationPlanStreamError";
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
  workspaceAgentTurn(
    projectId: string,
    input: WorkspaceAgentTurnInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceProposal>;
  artifactAgentTurn(
    projectId: string,
    artifactId: string,
    input: ScopedAgentTurnInput,
    signal?: AbortSignal,
  ): Promise<ScopedAgentTurnReceipt>;
  resourceAgentTurn(
    projectId: string,
    resourceId: string,
    input: ScopedAgentTurnInput,
    signal?: AbortSignal,
  ): Promise<ScopedAgentTurnReceipt>;
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
  listGenerationPlans(projectId: string): Promise<GenerationPlan[]>;
  getLatestScopedArtifactPlanId(
    projectId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  getGenerationPlan(projectId: string, planId: string): Promise<GenerationPlanDetail>;
  streamGenerationPlanEvents(
    projectId: string,
    planId: string,
    signal?: AbortSignal,
    options?: { after?: number },
  ): AsyncGenerator<GenerationPlanEvent>;
  cancelGenerationPlan(projectId: string, planId: string): Promise<GenerationPlanDetail>;
  retryGenerationTask(
    projectId: string,
    planId: string,
    taskId: string,
    mode: GenerationTaskRetryMode,
  ): Promise<GenerationPlanDetail>;
  applyWorkspaceGraphCommands(projectId: string, input: GraphCommandRequest): Promise<WorkspaceGraphMutationResult>;
  saveWorkspaceLayout(projectId: string, input: WorkspaceLayoutPatch): Promise<WorkspaceLayout>;
  listResources(projectId: string): Promise<Resource[]>;
  createResource(projectId: string, input: CreateResourceInput): Promise<CreateResourceResult>;
  materializeResource(projectId: string, input: MaterializeResourceInput): Promise<MaterializeResourceResult>;
  getResource(projectId: string, resourceId: string): Promise<Resource>;
  updateResource(projectId: string, resourceId: string, input: UpdateResourceInput): Promise<UpdateResourceResult>;
  listResourceRevisions(projectId: string, resourceId: string): Promise<ResourceRevision[]>;
  listResourceRevisionHistory(
    projectId: string,
    resourceId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<ResourceRevisionHistoryPage>;
  getResourceRevisionView(
    projectId: string,
    resourceId: string,
    revisionId: string,
  ): Promise<ResourceRevisionView>;
  getResourceRevisionBlob(path: string, signal?: AbortSignal): Promise<Blob>;
  getResearchResourceRevision(
    projectId: string,
    resourceId: string,
    revisionId: string,
  ): Promise<ResearchResourceRevisionView>;
  createResearchDirectionArtifactIntent(
    projectId: string,
    resourceId: string,
    revisionId: string,
    directionId: string,
    input: CreateResearchDirectionArtifactIntentInput,
  ): Promise<ApprovedResearchDirectionArtifactIntentResult>;
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
  listArtifactRevisionHistory(
    projectId: string,
    artifactId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<ArtifactRevisionHistoryPage>;
  restoreArtifactRevision(
    projectId: string,
    artifactId: string,
    revisionId: string,
    input: ArtifactVersionActionExpectation,
  ): Promise<ArtifactVersionActionResult>;
  forkArtifactTrack(
    projectId: string,
    artifactId: string,
    revisionId: string,
    input: ForkArtifactTrackRequest,
  ): Promise<ArtifactVersionActionResult>;
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

  async function* consumeSse<T = RunEvent>(
    res: Response,
    options: { rejectErrorEvents?: boolean } = {},
  ): AsyncGenerator<T> {
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    if (!res.body) {
      // Environments without a streaming body: parse the whole text.
      for (const block of (await res.text()).split("\n\n")) {
        const envelope = parseSseEnvelope(block);
        if (envelope?.event === "error" && options.rejectErrorEvents) {
          const payload = envelope.data as { error?: unknown };
          throw new GenerationPlanStreamError(
            typeof payload?.error === "string" && payload.error.trim()
              ? payload.error.trim()
              : "Generation Plan updates are unavailable.",
          );
        }
        if (envelope) yield envelope.data as T;
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
        const envelope = parseSseEnvelope(block);
        if (envelope?.event === "error" && options.rejectErrorEvents) {
          const payload = envelope.data as { error?: unknown };
          throw new GenerationPlanStreamError(
            typeof payload?.error === "string" && payload.error.trim()
              ? payload.error.trim()
              : "Generation Plan updates are unavailable.",
          );
        }
        if (envelope) yield envelope.data as T;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const envelope = parseSseEnvelope(tail);
      if (envelope?.event === "error" && options.rejectErrorEvents) {
        const payload = envelope.data as { error?: unknown };
        throw new GenerationPlanStreamError(
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "Generation Plan updates are unavailable.",
        );
      }
      if (envelope) yield envelope.data as T;
    }
  }

  async function* streamRun(input: RunInput, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    yield* consumeSse(await f(baseUrl + "/api/runs", initWithDaemonToken({ ...jsonInit("POST", encodeRunInput(input)), signal })));
  }

  async function* reattachRun(runId: string, signal?: AbortSignal, options: { afterSeq?: number } = {}): AsyncGenerator<RunEvent> {
    const after = typeof options.afterSeq === "number" && Number.isFinite(options.afterSeq) ? `?after=${encodeURIComponent(String(options.afterSeq))}` : "";
    yield* consumeSse(await f(`${baseUrl}/api/runs/${enc(runId)}/stream${after}`, initWithDaemonToken({ signal })));
  }

  async function* streamGenerationPlanEvents(
    projectId: string,
    planId: string,
    signal?: AbortSignal,
    options: { after?: number } = {},
  ): AsyncGenerator<GenerationPlanEvent> {
    const after = typeof options.after === "number" && Number.isSafeInteger(options.after) && options.after >= 0
      ? `?after=${enc(String(options.after))}`
      : "";
    yield* consumeSse<GenerationPlanEvent>(await f(
      `${baseUrl}/api/projects/${enc(projectId)}/workspace/plans/${enc(planId)}/events${after}`,
      initWithDaemonToken({ signal }),
    ), { rejectErrorEvents: true });
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
    streamGenerationPlanEvents,
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
    workspaceAgentTurn: (projectId, input, signal) =>
      json<WorkspaceProposal>(
        `/api/projects/${enc(projectId)}/workspace/agent/turns`,
        { ...jsonInit("POST", input), signal },
      ),
    artifactAgentTurn: (projectId, artifactId, input, signal) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/agent/turns`,
        decodeScopedAgentTurnReceipt,
        { ...jsonInit("POST", input), signal },
      ),
    resourceAgentTurn: (projectId, resourceId, input, signal) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/agent/turns`,
        decodeScopedAgentTurnReceipt,
        { ...jsonInit("POST", input), signal },
      ),
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
    listGenerationPlans: (projectId) =>
      json<GenerationPlan[]>(`/api/projects/${enc(projectId)}/workspace/plans`),
    getLatestScopedArtifactPlanId: (projectId, artifactId, signal) =>
      json<{ planId: string | null }>(
        `/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/agent/latest-plan`,
        signal === undefined ? undefined : { signal },
      ).then(({ planId }) => planId),
    getGenerationPlan: (projectId, planId) =>
      json<GenerationPlanDetail>(`/api/projects/${enc(projectId)}/workspace/plans/${enc(planId)}`),
    cancelGenerationPlan: (projectId, planId) =>
      json<GenerationPlanDetail>(
        `/api/projects/${enc(projectId)}/workspace/plans/${enc(planId)}/cancel`,
        jsonInit("POST", {}),
      ),
    retryGenerationTask: (projectId, planId, taskId, mode) =>
      json<GenerationPlanDetail>(
        `/api/projects/${enc(projectId)}/workspace/plans/${enc(planId)}/tasks/${enc(taskId)}/retry`,
        jsonInit("POST", { mode }),
      ),
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
    materializeResource: (projectId, input) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/materialize`,
        decodeMaterializeResourceResult,
        jsonInit("POST", encodeMaterializeResourceInput(input)),
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
    listResourceRevisionHistory: (projectId, resourceId, options = {}) => {
      const query: string[] = [];
      if (options.limit !== undefined) query.push(`limit=${enc(String(options.limit))}`);
      if (options.cursor !== undefined) query.push(`cursor=${enc(options.cursor)}`);
      const suffix = query.length > 0 ? `?${query.join("&")}` : "";
      return jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/history${suffix}`,
        decodeResourceRevisionHistoryPage,
      );
    },
    getResourceRevisionView: (projectId, resourceId, revisionId) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/revisions/${enc(revisionId)}`,
        decodeResourceRevisionView,
      ),
    getResourceRevisionBlob: (path, signal) => {
      if (!/^\/api\/projects\/[^/?#]+\/resources\/[^/?#]+\/revisions\/[^/?#]+\/(?:payload|embedded-assets\/[^/?#]+)(?:\?download=1)?$/.test(path)) {
        throw new TypeError("Resource bytes must use a protected Resource Revision byte path");
      }
      return blob(path, signal === undefined ? undefined : { signal });
    },
    getResearchResourceRevision: (projectId, resourceId, revisionId) =>
      jsonDecoded(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/revisions/${enc(revisionId)}/research`,
        decodeResearchResourceRevision,
      ),
    createResearchDirectionArtifactIntent: (projectId, resourceId, revisionId, directionId, input) =>
      json<ApprovedResearchDirectionArtifactIntentResult>(
        `/api/projects/${enc(projectId)}/resources/${enc(resourceId)}/revisions/${enc(revisionId)}/directions/${enc(directionId)}/artifact-intents`,
        jsonInit("POST", encodeCreateResearchDirectionArtifactIntentInput(input)),
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
    listArtifactRevisionHistory: (projectId, artifactId, options = {}) => {
      const query: string[] = [];
      if (options.limit !== undefined) query.push(`limit=${enc(String(options.limit))}`);
      if (options.cursor !== undefined) query.push(`cursor=${enc(options.cursor)}`);
      const suffix = query.length > 0 ? `?${query.join("&")}` : "";
      return json<ArtifactRevisionHistoryPage>(
        `/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/history${suffix}`,
      );
    },
    restoreArtifactRevision: (projectId, artifactId, revisionId, input) =>
      json<ArtifactVersionActionResult>(
        `/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions/${enc(revisionId)}/restore`,
        jsonInit("POST", input),
      ),
    forkArtifactTrack: (projectId, artifactId, revisionId, input) =>
      json<ArtifactVersionActionResult>(
        `/api/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions/${enc(revisionId)}/fork-track`,
        jsonInit("POST", input),
      ),
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
