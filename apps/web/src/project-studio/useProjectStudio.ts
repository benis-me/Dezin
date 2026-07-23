import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useApi } from "../lib/api-context.tsx";
import { ApiError } from "../lib/api.ts";
import type {
  ApiClient,
  ApprovedProposalResult,
  ArtifactMutationResult,
  ContextItemRef,
  Project,
  ProjectWorkspacePayload,
  ReadyProjectWorkspacePayload,
  ResourceRevisionOwnedSource,
  ScopedAgentTurnReceipt,
  SelectionRef,
  UnsupportedProjectWorkspacePayload,
  WorkspaceResourceKind,
  WorkspaceGraphCommand,
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceProposal,
  WorkspaceProposalApprovalMode,
  WorkspaceViewport,
} from "../lib/api.ts";
import {
  serializeDaemonOwnedComposerContext,
  type AgentComposerContextItem,
} from "../components/AgentComposerContext.tsx";
import {
  buildProposalDiff,
  type ProposalChange,
} from "./proposal/proposal-diff.ts";
import type { ProposalFocusRequest } from "./proposal/ProposalOverlay.tsx";
import type {
  ProposalConflictSummary,
  ProposalEditField,
  ProposalEditPatch,
  ProposalIssue,
  ProposalReviewState,
} from "./proposal/ProposalReviewPanel.tsx";
import {
  WORKSPACE_AGENT_SCOPE,
  agentScopeKey,
  agentTargetFor,
  readAgentSession,
  upsertTranscriptEntry,
  writeAgentSession,
  type AgentScopeKey,
  type AgentSession,
  type AgentTranscriptEntry,
  type AgentTurnOutbox,
} from "./scoped-agent-session.ts";

export interface WorkspaceStudioTask {
  id: string;
  label: string;
  state: "queued" | "running" | "done" | "failed";
}

export type ProjectStudioLoadState =
  | { status: "loading" }
  | { status: "ready"; project: Project; workspace: ReadyProjectWorkspacePayload }
  | { status: "prototype"; project: Project; workspace: UnsupportedProjectWorkspacePayload }
  | { status: "error"; message: string };

export interface ProjectStudioState {
  load: ProjectStudioLoadState;
  proposals: WorkspaceProposal[];
  proposalReview: ProposalReviewState;
  proposalFocus: ProposalFocusRequest | null;
  focusedProposalChangeKey: string | null;
  workspaceAgentDraft: string;
  setWorkspaceAgentDraft: Dispatch<SetStateAction<string>>;
  agentContextItems: Array<Extract<AgentComposerContextItem, { type: "context-ref" }>>;
  addAgentContextItems: (items: Array<Extract<AgentComposerContextItem, { type: "context-ref" }>>) => void;
  setAgentContextItems: (items: Array<Extract<AgentComposerContextItem, { type: "context-ref" }>>) => void;
  removeAgentContextItem: (id: string) => void;
  agentTranscript: AgentTranscriptEntry[];
  materializeAgentResourceContext: (input: {
    title: string;
    kind: Exclude<WorkspaceResourceKind, "research" | "sharingan-capture">;
    source: ResourceRevisionOwnedSource;
    previewUrl?: string;
  }) => Promise<void>;
  agentTurnSubmitting: boolean;
  workspaceAgentSubmitting: boolean;
  workspaceAgentError: string | null;
  submitWorkspaceAgentPrompt: () => Promise<void>;
  artifactAgentSubmitting: boolean;
  artifactAgentError: string | null;
  artifactAgentReceipt: ScopedAgentTurnReceipt | null;
  artifactAgentPlanId: string | null;
  submitArtifactAgentPrompt: (input: {
    artifactId: string;
    baseRevisionId: string;
    selection?: SelectionRef[];
    intent?: "generate" | "edit" | "repair";
  }) => Promise<void>;
  resourceAgentSubmitting: boolean;
  resourceAgentError: string | null;
  resourceAgentReceipt: ScopedAgentTurnReceipt | null;
  resourceAgentPlanId: string | null;
  submitResourceAgentPrompt: (input: {
    resourceId: string;
    baseRevisionId: string;
    intent?: "generate" | "edit" | "repair";
  }) => Promise<void>;
  selectedGraphObjectIds: string[];
  setSelectedGraphObjectIds: Dispatch<SetStateAction<string[]>>;
  viewport: WorkspaceViewport;
  setViewport: Dispatch<SetStateAction<WorkspaceViewport | null>>;
  taskQueue: WorkspaceStudioTask[];
  setTaskQueue: Dispatch<SetStateAction<WorkspaceStudioTask[]>>;
  saveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  applyGraphCommands: (commands: readonly WorkspaceGraphCommand[]) => Promise<void>;
  reconcileArtifactPublication: (result: ArtifactMutationResult) => void;
  reconcileGenerationPublication: () => void;
  editProposal: (patch: ProposalEditPatch) => Promise<WorkspaceProposal>;
  renameProposalNode: (change: ProposalChange<unknown>, name: string) => Promise<WorkspaceProposal>;
  revertProposalChange: (change: ProposalChange<unknown>) => Promise<WorkspaceProposal>;
  focusProposalChange: (changeKey: string) => void;
  approveProposal: (mode: WorkspaceProposalApprovalMode) => Promise<void>;
  rejectProposal: () => Promise<void>;
  closeProposalReview: () => void;
  retry: () => void;
}

const DEFAULT_VIEWPORT: WorkspaceViewport = { x: 0, y: 0, zoom: 1 };
const CONTEXT_PACK_ID = /^context-pack-[0-9a-f]{64}$/;
const SCOPED_PLAN_POLL_MS = 2_000;
const SCOPED_PLAN_RETRY_MS = 250;
function canonicalTurnId(): string {
  return `turn-${globalThis.crypto.randomUUID().toLowerCase()}`;
}
type ProjectStudioRequest = Promise<[
  Project,
  ProjectWorkspacePayload,
  { proposals: WorkspaceProposal[]; error: string | null },
]>;
const inFlightReads = new WeakMap<ApiClient, Map<string, ProjectStudioRequest>>();

function readProjectStudio(api: ApiClient, projectId: string): ProjectStudioRequest {
  let byProject = inFlightReads.get(api);
  if (!byProject) {
    byProject = new Map();
    inFlightReads.set(api, byProject);
  }
  const existing = byProject.get(projectId);
  if (existing) return existing;
  const request: ProjectStudioRequest = Promise.all([
    api.getProject(projectId),
    api.getWorkspace(projectId),
  ]).then(async ([project, workspace]) => {
    if (project.mode !== "standard" || workspace.status !== "ready") {
      return [project, workspace, { proposals: [], error: null }];
    }
    try {
      return [project, workspace, { proposals: await api.listWorkspaceProposals(projectId), error: null }];
    } catch (error) {
      return [project, workspace, { proposals: [], error: errorMessage(error) }];
    }
  });
  byProject.set(projectId, request);
  const release = () => {
    if (byProject?.get(projectId) === request) byProject.delete(projectId);
  };
  void request.then(release, release);
  return request;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Couldn't load this project workspace.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function resolveLoadState(project: Project, workspace: ProjectWorkspacePayload): ProjectStudioLoadState {
  if (project.mode === "prototype") {
    if (workspace.status !== "unsupported" || workspace.projectId !== project.id) {
      return { status: "error", message: "Prototype project workspace response is invalid." };
    }
    return { status: "prototype", project, workspace };
  }
  if (workspace.status !== "ready") {
    return { status: "error", message: "Standard project workspace is unavailable." };
  }
  if (workspace.workspace.projectId !== project.id || workspace.workspace.mode !== "standard") {
    return { status: "error", message: "Project workspace identity does not match this project." };
  }
  return { status: "ready", project, workspace };
}

function upsertById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return items.some((candidate) => candidate.id === item.id)
    ? items.map((candidate) => candidate.id === item.id ? item : candidate)
    : [...items, item];
}

export function reconcileArtifactPublicationPayload(
  current: ReadyProjectWorkspacePayload,
  result: ArtifactMutationResult,
): ReadyProjectWorkspacePayload {
  const { revision, snapshot } = result;
  const track = current.tracks.find((candidate) => candidate.id === revision.trackId);
  if (revision.workspaceId !== current.workspace.id
    || snapshot.workspaceId !== current.workspace.id
    || snapshot.kernelRevisionId !== current.activeKernelRevision.id
    || snapshot.artifactRevisions[revision.artifactId] !== revision.id
    || track?.artifactId !== revision.artifactId) {
    return current;
  }

  const revisions = upsertById(current.revisions, revision);
  const snapshots = upsertById(current.snapshots, snapshot);
  const activeSnapshot = snapshot.id === current.activeSnapshot.id
    || snapshot.sequence > current.activeSnapshot.sequence
    ? snapshot
    : current.activeSnapshot;
  const activeRevisionId = activeSnapshot.artifactRevisions[revision.artifactId] ?? null;
  const activeRevision = activeRevisionId === null
    ? null
    : revisions.find((candidate) => candidate.id === activeRevisionId) ?? null;
  const tracks = current.tracks.map((candidate) => candidate.id === revision.trackId
    && candidate.artifactId === revision.artifactId
    && activeRevision?.trackId === candidate.id
    ? { ...candidate, headRevisionId: activeRevision.id }
    : candidate);
  const artifacts = current.artifacts.map((candidate) => candidate.id === revision.artifactId
    ? { ...candidate, updatedAt: Math.max(candidate.updatedAt, activeRevision?.createdAt ?? revision.createdAt) }
    : candidate);
  const graph = activeSnapshot.graphRevision >= current.graph.revision
    ? activeSnapshot.graph
    : current.graph;

  return {
    ...current,
    workspace: {
      ...current.workspace,
      activeSnapshotId: activeSnapshot.id,
      graphRevision: Math.max(current.workspace.graphRevision, graph.revision),
      updatedAt: Math.max(current.workspace.updatedAt, activeSnapshot.createdAt, revision.createdAt),
    },
    graph,
    activeSnapshot,
    artifacts,
    tracks,
    revisions,
    snapshots,
  };
}

function isWorkspaceRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 409
    && error.details?.code === "workspace_revision_conflict";
}

function isWorkspaceLayoutConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && (error.details?.code === "workspace_revision_conflict"
      || error.details?.code === "workspace_layout_conflict");
}

function isProposalApprovalConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && (error.details?.code === "workspace_revision_conflict"
      || error.details?.code === "workspace_proposal_conflict");
}

function isProposalPayloadConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && (error.details?.code === "workspace_proposal_revision_conflict"
      || error.details?.code === "workspace_proposal_state_conflict");
}

function isProposalValidationError(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 422
    && (error.details?.code === "workspace_proposal_validation_error"
      || error.details?.code === "workspace_proposal_validation");
}

function generationCompileFailureResult(error: unknown): ApprovedProposalResult | null {
  if (!(error instanceof ApiError) || error.status !== 422
    || error.details?.code !== "generation_plan_compile_failed") return null;
  const { proposal, graph, snapshot, layout, plan } = error.details;
  if (proposal === null || typeof proposal !== "object"
    || graph === null || typeof graph !== "object"
    || snapshot === null || typeof snapshot !== "object"
    || layout === null || typeof layout !== "object"
    || plan === null || typeof plan !== "object") return null;
  const candidate = { proposal, graph, snapshot, layout, plan } as ApprovedProposalResult;
  if (candidate.proposal.status !== "approved"
    || candidate.plan?.status !== "compile-failed"
    || candidate.plan.id !== error.details.planId
    || candidate.proposal.workspaceId !== candidate.plan.workspaceId
    || candidate.graph.workspaceId !== candidate.plan.workspaceId
    || candidate.snapshot.workspaceId !== candidate.plan.workspaceId
    || candidate.layout.workspaceId !== candidate.plan.workspaceId) return null;
  return candidate;
}

type GraphCommandConflictResolution =
  | { kind: "replay"; commands: readonly WorkspaceGraphCommand[] }
  | { kind: "converged" }
  | { kind: "conflict" };

function sameSerializableValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameSerializableValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameSerializableValue(leftRecord[key], rightRecord[key]));
}

function sameWorkspaceNodeIdentity(
  left: WorkspaceGraph["nodes"][number],
  right: WorkspaceGraph["nodes"][number],
): boolean {
  if (left.id !== right.id || left.workspaceId !== right.workspaceId || left.kind !== right.kind) return false;
  return left.kind === "resource"
    ? right.kind === "resource" && left.resourceId === right.resourceId
    : right.kind !== "resource" && left.artifactId === right.artifactId;
}

function classifyGraphCommandConflict(
  baselineGraph: WorkspaceGraph,
  graph: WorkspaceGraph,
  commands: readonly WorkspaceGraphCommand[],
): GraphCommandConflictResolution {
  if (commands.length === 0 || baselineGraph.workspaceId !== graph.workspaceId
    || new Set(commands.map((command) => command.id)).size !== commands.length) {
    return { kind: "conflict" };
  }
  const baselineNodesById = new Map(baselineGraph.nodes.map((node) => [node.id, node]));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const baselineEdgesById = new Map(baselineGraph.edges.map((edge) => [edge.id, edge]));
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const addCommands = commands.filter((command): command is Extract<WorkspaceGraphCommand, { type: "add-edge" }> => (
    command.type === "add-edge"
  ));
  if (addCommands.length === commands.length) {
    const batchEdgeIds = new Set<string>();
    for (const command of addCommands) {
      const baselineSource = baselineNodesById.get(command.edge.sourceNodeId);
      const baselineTarget = baselineNodesById.get(command.edge.targetNodeId);
      const source = nodesById.get(command.edge.sourceNodeId);
      const target = nodesById.get(command.edge.targetNodeId);
      if (batchEdgeIds.has(command.edge.id)
        || command.edge.workspaceId !== graph.workspaceId
        || !baselineSource || !baselineTarget || !source || !target
        || !sameWorkspaceNodeIdentity(baselineSource, source)
        || !sameWorkspaceNodeIdentity(baselineTarget, target)
        || baselineEdgesById.has(command.edge.id)
        || edgesById.has(command.edge.id)) return { kind: "conflict" };
      batchEdgeIds.add(command.edge.id);
    }
    return { kind: "replay", commands: addCommands };
  }
  const removeCommands = commands.filter((command): command is Extract<WorkspaceGraphCommand, { type: "remove-edge" }> => (
    command.type === "remove-edge"
  ));
  if (removeCommands.length !== commands.length) return { kind: "conflict" };
  const replayCommands: WorkspaceGraphCommand[] = [];
  const batchEdgeIds = new Set<string>();
  for (const command of removeCommands) {
    if (batchEdgeIds.has(command.edgeId)) return { kind: "conflict" };
    batchEdgeIds.add(command.edgeId);
    const baselineEdge = baselineEdgesById.get(command.edgeId);
    if (!baselineEdge || baselineEdge.kind === "uses") return { kind: "conflict" };
    const edge = edgesById.get(command.edgeId);
    if (!edge) continue;
    const baselineSource = baselineNodesById.get(baselineEdge.sourceNodeId);
    const baselineTarget = baselineNodesById.get(baselineEdge.targetNodeId);
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (edge.kind === "uses"
      || !sameSerializableValue(baselineEdge, edge)
      || !baselineSource || !baselineTarget || !source || !target
      || !sameWorkspaceNodeIdentity(baselineSource, source)
      || !sameWorkspaceNodeIdentity(baselineTarget, target)) return { kind: "conflict" };
    replayCommands.push(command);
  }
  return replayCommands.length > 0
    ? { kind: "replay", commands: replayCommands }
    : { kind: "converged" };
}

type ReadyLoadState = Extract<ProjectStudioLoadState, { status: "ready" }>;
interface ReadyWorkspaceHead {
  workspaceId: string;
  graphRevision: number;
  snapshotId: string;
  snapshotSequence: number;
  layoutChecksum: string;
}

interface GenerationPublicationReconcileState {
  epoch: number;
  requested: boolean;
  running: boolean;
}

function readyWorkspaceHead(workspace: ReadyProjectWorkspacePayload): ReadyWorkspaceHead {
  return {
    workspaceId: workspace.workspace.id,
    graphRevision: workspace.graph.revision,
    snapshotId: workspace.activeSnapshot.id,
    snapshotSequence: workspace.activeSnapshot.sequence,
    layoutChecksum: workspace.layout.checksum,
  };
}

function sameReadyWorkspaceHead(left: ReadyWorkspaceHead, right: ReadyWorkspaceHead): boolean {
  return left.workspaceId === right.workspaceId
    && left.graphRevision === right.graphRevision
    && left.snapshotId === right.snapshotId
    && left.snapshotSequence === right.snapshotSequence
    && left.layoutChecksum === right.layoutChecksum;
}

function canAdvanceReadyWorkspace(
  current: ReadyProjectWorkspacePayload,
  candidate: ReadyProjectWorkspacePayload,
): boolean {
  if (candidate.workspace.id !== current.workspace.id
    || candidate.workspace.projectId !== current.workspace.projectId
    || candidate.graph.revision < current.graph.revision
    || candidate.workspace.graphRevision < current.workspace.graphRevision
    || candidate.activeSnapshot.sequence < current.activeSnapshot.sequence) {
    return false;
  }
  return candidate.activeSnapshot.sequence !== current.activeSnapshot.sequence
    || candidate.activeSnapshot.id === current.activeSnapshot.id;
}

async function selectedGraphContextRefs(
  api: ApiClient,
  projectId: string,
  ready: ReadyProjectWorkspacePayload,
  selectedIds: readonly string[],
): Promise<ContextItemRef[]> {
  const selected = new Set(selectedIds);
  const resourceIds = ready.graph.nodes.flatMap((node) => (
    selected.has(node.id) && node.kind === "resource" && node.resourceId ? [node.resourceId] : []
  ));
  const resourceKinds = new Map((await Promise.all(resourceIds.map(async (resourceId) => {
    const resource = await api.getResource(projectId, resourceId);
    return [resource.id, resource.kind] as const;
  }))).map(([id, kind]) => [id, kind]));
  return ready.graph.nodes.flatMap((node): ContextItemRef[] => {
    if (!selected.has(node.id)) return [];
    if (node.kind === "resource") {
      const revisionId = ready.activeSnapshot.resourceRevisions[node.resourceId] ?? null;
      const resourceKind = resourceKinds.get(node.resourceId);
      if (revisionId === null || resourceKind === undefined) return [];
      return [{ kind: "resource", id: node.resourceId, resourceKind, revisionId }];
    }
    const revisionId = ready.activeSnapshot.artifactRevisions[node.artifactId] ?? null;
    return revisionId === null ? [] : [{ kind: "artifact", id: node.artifactId, revisionId }];
  });
}

function mergeContextRefs(...groups: readonly ContextItemRef[][]): ContextItemRef[] {
  const seen = new Set<string>();
  return groups.flat().filter((ref) => {
    const key = JSON.stringify(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type ReviewableProposalState = Extract<ProposalReviewState, {
  status: "draft" | "saving" | "validation-error" | "conflicted";
}>;

type ProposalValidationIdentity = `field:${ProposalEditField}` | `operations:${string}`;

interface PendingProposalValidation {
  proposalId: string;
  identities: Set<ProposalValidationIdentity>;
  message: string;
  issues: ProposalIssue[];
}

function fieldValidationIdentity(field: ProposalEditField): ProposalValidationIdentity {
  return `field:${field}`;
}

function changeValidationIdentity(changeKey: string): ProposalValidationIdentity {
  return `operations:${changeKey}`;
}

function proposalValidationMetadata(pending: PendingProposalValidation): Pick<
  Extract<ProposalReviewState, { status: "validation-error" }>,
  "invalidEditFields" | "invalidChangeKeys"
> {
  const invalidEditFields: ProposalEditField[] = [];
  const invalidChangeKeys: string[] = [];
  for (const identity of pending.identities) {
    if (identity.startsWith("field:")) {
      invalidEditFields.push(identity.slice("field:".length) as ProposalEditField);
    } else {
      invalidChangeKeys.push(identity.slice("operations:".length));
    }
  }
  return { invalidEditFields, invalidChangeKeys };
}

function pruneMissingProposalChangeValidations(
  pending: PendingProposalValidation,
  proposal: WorkspaceProposal,
  ready: ReadyLoadState,
): void {
  const activeChangeKeys = new Set(diffProposal(proposal, ready).reviewItems.map((change) => change.key));
  for (const identity of pending.identities) {
    if (identity.startsWith("operations:")
      && !activeChangeKeys.has(identity.slice("operations:".length))) {
      pending.identities.delete(identity);
    }
  }
}

function diffProposal(proposal: WorkspaceProposal, ready: ReadyLoadState) {
  return buildProposalDiff(proposal, {
    graph: ready.workspace.graph,
    activeSnapshotId: ready.workspace.activeSnapshot.id,
    layoutChecksum: ready.workspace.layout.checksum,
  });
}

function conflictSummary(proposal: WorkspaceProposal, ready: ReadyLoadState): ProposalConflictSummary {
  if (proposal.review.kind === "conflict") return proposal.review;
  return {
    expectedGraphRevision: proposal.baseGraphRevision,
    actualGraphRevision: ready.workspace.graph.revision,
    expectedSnapshotId: proposal.baseSnapshotId,
    actualSnapshotId: ready.workspace.activeSnapshot.id,
    expectedLayoutChecksum: proposal.baseLayoutChecksum,
    actualLayoutChecksum: ready.workspace.layout.checksum,
    graphChanged: proposal.baseGraphRevision !== ready.workspace.graph.revision,
    snapshotChanged: proposal.baseSnapshotId !== ready.workspace.activeSnapshot.id,
    layoutChanged: proposal.baseLayoutChecksum !== ready.workspace.layout.checksum,
  };
}

function reviewStateForProposal(proposal: WorkspaceProposal, ready: ReadyLoadState): ProposalReviewState {
  if (proposal.status === "draft") {
    return { status: "draft", proposal, diff: diffProposal(proposal, ready) };
  }
  if (proposal.status === "conflicted") {
    return {
      status: "conflicted",
      proposal,
      diff: diffProposal(proposal, ready),
      conflict: conflictSummary(proposal, ready),
    };
  }
  return { status: proposal.status, proposal, plan: null };
}

function reviewableProposal(review: ProposalReviewState): ReviewableProposalState | null {
  return review.status === "draft"
    || review.status === "saving"
    || review.status === "validation-error"
    || review.status === "conflicted"
    ? review
    : null;
}

function validationIssues(error: ApiError): ProposalIssue[] {
  const nested = error.details?.details;
  const issues = error.details?.issues
    ?? (nested && typeof nested === "object" && "issues" in nested ? nested.issues : undefined);
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue): ProposalIssue[] => {
    if (!issue || typeof issue !== "object" || !("message" in issue) || typeof issue.message !== "string") return [];
    return [{
      message: issue.message,
      code: "code" in issue && typeof issue.code === "string" ? issue.code : undefined,
      objectId: "objectId" in issue && typeof issue.objectId === "string" ? issue.objectId : undefined,
    }];
  });
}

function proposalFromError(error: ApiError): WorkspaceProposal | null {
  const proposal = error.details?.proposal;
  if (!proposal || typeof proposal !== "object") return null;
  if (!("id" in proposal) || typeof proposal.id !== "string") return null;
  if (!("status" in proposal) || typeof proposal.status !== "string") return null;
  return proposal as WorkspaceProposal;
}

function isProposalEditPatchNoop(proposal: WorkspaceProposal, patch: ProposalEditPatch): boolean {
  const fields = Object.keys(patch) as ProposalEditField[];
  return fields.length === 0 || fields.every((field) => (
    JSON.stringify(patch[field]) === JSON.stringify(proposal[field])
  ));
}

export function useProjectStudio(
  projectId: string,
  artifactAgentTargetId: string | null = null,
  resourceAgentTargetId: string | null = null,
): ProjectStudioState {
  const api = useApi();
  const [load, setLoad] = useState<ProjectStudioLoadState>({ status: "loading" });
  const [proposals, setProposals] = useState<WorkspaceProposal[]>([]);
  const [proposalReview, setProposalReview] = useState<ProposalReviewState>({ status: "loading" });
  const [proposalFocus, setProposalFocus] = useState<ProposalFocusRequest | null>(null);
  const [focusedProposalChangeKey, setFocusedProposalChangeKey] = useState<string | null>(null);
  const currentAgentTarget = agentTargetFor(artifactAgentTargetId, resourceAgentTargetId);
  const currentAgentScopeKey = agentScopeKey(currentAgentTarget);
  const [agentDrafts, setAgentDrafts] = useState<Partial<Record<AgentScopeKey, string>>>({});
  const [, setAgentSessionRevision] = useState(0);
  const [activeAgentTurnScope, setActiveAgentTurnScope] = useState<AgentScopeKey | null>(null);
  const [agentErrors, setAgentErrors] = useState<Partial<Record<AgentScopeKey, string>>>({});
  const [scopedAgentReceipts, setScopedAgentReceipts] = useState<Record<string, ScopedAgentTurnReceipt>>({});
  const [scopedAgentPlanIds, setScopedAgentPlanIds] = useState<Record<string, string>>({});
  const [selectedGraphObjectIds, setSelectedGraphObjectIds] = useState<string[]>([]);
  const [viewportOverride, setViewport] = useState<WorkspaceViewport | null>(null);
  const [taskQueue, setTaskQueue] = useState<WorkspaceStudioTask[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadRef = useRef<ProjectStudioLoadState>(load);
  const proposalReviewRef = useRef<ProposalReviewState>(proposalReview);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const proposalEditQueueRef = useRef<Promise<void>>(Promise.resolve());
  const proposalEditGenerationRef = useRef(0);
  const proposalValidationRef = useRef<PendingProposalValidation | null>(null);
  const proposalActionLockRef = useRef(false);
  const activeAgentTurnRef = useRef<{
    projectEpoch: number;
    scopeKey: AgentScopeKey;
    controller: AbortController;
  } | null>(null);
  const scopedTurnIdsRef = useRef(new Map<AgentScopeKey, { id: string; fingerprint: string }>());
  const scopedPlanDiscoveryEpochRef = useRef(0);
  const agentSessionCacheRef = useRef(new Map<AgentScopeKey, AgentSession>());
  const lastReconciledAgentScopeRef = useRef<AgentScopeKey | null>(null);
  const agentSessionProjectRef = useRef(projectId);
  const artifactAgentTargetIdRef = useRef(artifactAgentTargetId);
  const artifactAgentTargetEpochRef = useRef(0);
  if (artifactAgentTargetIdRef.current !== artifactAgentTargetId) {
    artifactAgentTargetIdRef.current = artifactAgentTargetId;
    artifactAgentTargetEpochRef.current += 1;
  }
  const resourceAgentTargetIdRef = useRef(resourceAgentTargetId);
  const resourceAgentTargetEpochRef = useRef(0);
  if (resourceAgentTargetIdRef.current !== resourceAgentTargetId) {
    resourceAgentTargetIdRef.current = resourceAgentTargetId;
    resourceAgentTargetEpochRef.current += 1;
  }
  const proposalFocusNonceRef = useRef(0);
  const generationPublicationReconcileRef = useRef<GenerationPublicationReconcileState>({
    epoch: -1,
    requested: false,
    running: false,
  });
  const epochProjectIdRef = useRef(projectId);
  const resetProjectIdRef = useRef(projectId);
  const projectEpochRef = useRef(0);
  if (epochProjectIdRef.current !== projectId) {
    epochProjectIdRef.current = projectId;
    projectEpochRef.current += 1;
  }
  if (agentSessionProjectRef.current !== projectId) {
    agentSessionProjectRef.current = projectId;
    agentSessionCacheRef.current.clear();
    lastReconciledAgentScopeRef.current = null;
  }
  const readCachedAgentSession = (scopeKey: AgentScopeKey): AgentSession => {
    const cached = agentSessionCacheRef.current.get(scopeKey);
    if (cached) return cached;
    const restored = readAgentSession(projectId, scopeKey);
    agentSessionCacheRef.current.set(scopeKey, restored);
    return restored;
  };
  const updateAgentSession = (scopeKey: AgentScopeKey, update: (session: AgentSession) => AgentSession): AgentSession => {
    const next = update(readCachedAgentSession(scopeKey));
    agentSessionCacheRef.current.set(scopeKey, next);
    writeAgentSession(projectId, scopeKey, next);
    setAgentSessionRevision((revision) => revision + 1);
    return next;
  };
  const currentAgentSession = readCachedAgentSession(currentAgentScopeKey);
  const workspaceAgentDraft = agentDrafts[currentAgentScopeKey] ?? currentAgentSession.draft;
  const setWorkspaceAgentDraft = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    const scopeKey = currentAgentScopeKey;
    setAgentDrafts((current) => {
      const previous = current[scopeKey] ?? readCachedAgentSession(scopeKey).draft;
      const value = typeof next === "function" ? next(previous) : next;
      scopedTurnIdsRef.current.delete(scopeKey);
      updateAgentSession(scopeKey, (session) => ({ ...session, draft: value }));
      return value === previous ? current : { ...current, [scopeKey]: value };
    });
  }, [currentAgentScopeKey, projectId]);
  const agentTurnSubmitting = activeAgentTurnScope !== null;
  const workspaceAgentSubmitting = activeAgentTurnScope === WORKSPACE_AGENT_SCOPE;
  const artifactAgentSubmitting = artifactAgentTargetId !== null && activeAgentTurnScope === currentAgentScopeKey;
  const resourceAgentSubmitting = resourceAgentTargetId !== null && activeAgentTurnScope === currentAgentScopeKey;
  const workspaceAgentError = agentErrors[WORKSPACE_AGENT_SCOPE] ?? null;
  const artifactAgentError = artifactAgentTargetId === null ? null : agentErrors[currentAgentScopeKey] ?? null;
  const resourceAgentError = resourceAgentTargetId === null ? null : agentErrors[currentAgentScopeKey] ?? null;
  const artifactAgentReceipt = artifactAgentTargetId === null
    ? null
    : scopedAgentReceipts[currentAgentScopeKey]
      ?? (currentAgentSession.receipt?.kind === "scoped" ? currentAgentSession.receipt.receipt : null);
  const resourceAgentReceipt = resourceAgentTargetId === null
    ? null
    : scopedAgentReceipts[currentAgentScopeKey]
      ?? (currentAgentSession.receipt?.kind === "scoped" ? currentAgentSession.receipt.receipt : null);
  const artifactAgentPlanId = artifactAgentTargetId === null
    ? null
    : scopedAgentPlanIds[currentAgentScopeKey] ?? artifactAgentReceipt?.task.planId ?? null;
  const resourceAgentPlanId = resourceAgentTargetId === null
    ? null
    : scopedAgentPlanIds[currentAgentScopeKey] ?? resourceAgentReceipt?.task.planId ?? null;
  const agentContextItems = currentAgentSession.contextItems;
  const agentTranscript = currentAgentSession.transcript;
  const setAgentContextItems = (
    items: Array<Extract<AgentComposerContextItem, { type: "context-ref" }>>,
  ): void => {
    const scopeKey = currentAgentScopeKey;
    updateAgentSession(scopeKey, (session) => ({ ...session, contextItems: [...items] }));
  };
  const addAgentContextItems = (
    items: Array<Extract<AgentComposerContextItem, { type: "context-ref" }>>,
  ): void => {
    const scopeKey = currentAgentScopeKey;
    updateAgentSession(scopeKey, (session) => {
      const next = [...session.contextItems];
      for (const item of items) {
        const index = next.findIndex((candidate) => candidate.id === item.id);
        if (index === -1) next.push(item);
        else next[index] = item;
      }
      return { ...session, contextItems: next };
    });
  };
  const removeAgentContextItem = (id: string): void => {
    const scopeKey = currentAgentScopeKey;
    updateAgentSession(scopeKey, (session) => ({
      ...session,
      contextItems: session.contextItems.filter((item) => item.id !== id),
    }));
  };
  const retry = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  const commitLoad = useCallback((next: ProjectStudioLoadState) => {
    loadRef.current = next;
    setLoad(next);
  }, []);

  const commitProposalReview = useCallback((next: ProposalReviewState) => {
    proposalReviewRef.current = next;
    setProposalReview(next);
  }, []);

  const replaceProposal = useCallback((next: WorkspaceProposal) => {
    setProposals((current) => current.some((proposal) => proposal.id === next.id)
      ? current.map((proposal) => proposal.id === next.id ? next : proposal)
      : [...current, next]);
  }, []);

  const requireReady = useCallback((): Extract<ProjectStudioLoadState, { status: "ready" }> => {
    const current = loadRef.current;
    if (current.status !== "ready") throw new Error("The project workspace is not ready.");
    return current;
  }, []);

  const readCurrentReadyWorkspace = useCallback(async (epoch: number): Promise<ReadyLoadState | null> => {
    try {
      if (epoch !== projectEpochRef.current) return null;
      const current = requireReady();
      const startedAt = {
        graphRevision: current.workspace.graph.revision,
        snapshotId: current.workspace.activeSnapshot.id,
        layoutChecksum: current.workspace.layout.checksum,
      };
      const payload = await api.getWorkspace(projectId);
      if (epoch !== projectEpochRef.current) return null;
      const latest = requireReady();
      if (latest.project.id !== current.project.id
        || latest.workspace.graph.revision !== startedAt.graphRevision
        || latest.workspace.activeSnapshot.id !== startedAt.snapshotId
        || latest.workspace.layout.checksum !== startedAt.layoutChecksum) {
        return null;
      }
      const resolved = resolveLoadState(current.project, payload);
      return resolved.status === "ready" ? resolved : null;
    } catch {
      return null;
    }
  }, [api, projectId, requireReady]);

  const updateReadyWorkspace = useCallback((workspace: ReadyProjectWorkspacePayload) => {
    const current = requireReady();
    const next: ReadyLoadState = { ...current, workspace };
    commitLoad(next);
    const review = reviewableProposal(proposalReviewRef.current);
    if (review) commitProposalReview({ ...review, diff: diffProposal(review.proposal, next) });
  }, [commitLoad, commitProposalReview, requireReady]);

  const reconcileArtifactPublication = useCallback((result: ArtifactMutationResult): void => {
    const current = loadRef.current;
    if (current.status !== "ready") return;
    const reconciled = reconcileArtifactPublicationPayload(current.workspace, result);
    if (reconciled !== current.workspace) updateReadyWorkspace(reconciled);
  }, [updateReadyWorkspace]);

  const reconcileGenerationPublication = useCallback((): void => {
    const epoch = projectEpochRef.current;
    if (loadRef.current.status !== "ready") return;
    let state = generationPublicationReconcileRef.current;
    if (state.epoch !== epoch) {
      state = { epoch, requested: false, running: false };
      generationPublicationReconcileRef.current = state;
    }
    state.requested = true;
    if (state.running) return;
    state.running = true;

    void (async () => {
      let transientFailures = 0;
      try {
        while (state.epoch === projectEpochRef.current && state.requested) {
          state.requested = false;
          while (state.epoch === projectEpochRef.current) {
            const current = loadRef.current;
            if (current.status !== "ready" || current.project.id !== projectId) return;
            const startedAt = readyWorkspaceHead(current.workspace);
            let payload: ProjectWorkspacePayload;
            try {
              payload = await api.getWorkspace(projectId);
            } catch {
              transientFailures += 1;
              await new Promise<void>((resolve) => setTimeout(
                resolve,
                Math.min(40 * (4 ** Math.min(transientFailures - 1, 4)), 4_000),
              ));
              continue;
            }
            transientFailures = 0;
            if (state.epoch !== projectEpochRef.current) return;
            const latest = loadRef.current;
            if (latest.status !== "ready" || latest.project.id !== current.project.id) return;
            if (!sameReadyWorkspaceHead(startedAt, readyWorkspaceHead(latest.workspace))) {
              state.requested = true;
              break;
            }
            const resolved = resolveLoadState(latest.project, payload);
            if (resolved.status === "ready" && canAdvanceReadyWorkspace(latest.workspace, resolved.workspace)) {
              updateReadyWorkspace(resolved.workspace);
            }
            break;
          }
        }
      } finally {
        state.running = false;
      }
    })();
  }, [api, projectId, updateReadyWorkspace]);

  const enqueueMutation = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const result = mutationQueueRef.current.then(work);
    mutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const materializeAgentResourceContext = useCallback((input: {
    title: string;
    kind: Exclude<WorkspaceResourceKind, "research" | "sharingan-capture">;
    source: ResourceRevisionOwnedSource;
    previewUrl?: string;
  }): Promise<void> => {
    const scopeKey = currentAgentScopeKey;
    const epoch = projectEpochRef.current;
    return enqueueMutation(async () => {
      if (epoch !== projectEpochRef.current) return;
      const ready = requireReady();
      const title = input.title.trim();
      if (!title) throw new Error("Agent Context title is required.");
      const created = await api.materializeResource(projectId, {
        kind: input.kind,
        title,
        defaultPinPolicy: "pin-current",
        baseGraphRevision: ready.workspace.graph.revision,
        expectedSnapshotId: ready.workspace.activeSnapshot.id,
        source: input.source,
        reason: "Attached to scoped Agent Context",
      });
      if (epoch !== projectEpochRef.current) return;
      const payload = await api.getWorkspace(projectId);
      if (epoch !== projectEpochRef.current) return;
      const refreshed = resolveLoadState(ready.project, payload);
      if (refreshed.status !== "ready") throw new Error("The refreshed Standard workspace is unavailable.");
      updateReadyWorkspace(refreshed.workspace);
      updateAgentSession(scopeKey, (session) => {
        const revision = created.revision;
        const item: Extract<AgentComposerContextItem, { type: "context-ref" }> = {
          id: `resource:${created.resource.id}:${revision.id}`,
          type: "context-ref",
          title,
          subtitle: `${created.resource.kind} · Revision ${revision.sequence}`,
          ref: {
            kind: "resource",
            id: created.resource.id,
            resourceKind: created.resource.kind,
            revisionId: revision.id,
          },
          ...(input.previewUrl === undefined ? {} : { previewUrl: input.previewUrl }),
          projectId,
          revisionId: revision.id,
        };
        const contextItems = session.contextItems.some((candidate) => candidate.id === item.id)
          ? session.contextItems.map((candidate) => candidate.id === item.id ? item : candidate)
          : [...session.contextItems, item];
        return { ...session, contextItems };
      });
    });
  }, [api, currentAgentScopeKey, enqueueMutation, projectId, requireReady, updateReadyWorkspace]);

  useEffect(() => {
    let current = true;
    const effectEpoch = projectEpochRef.current;
    proposalValidationRef.current = null;
    if (resetProjectIdRef.current !== projectId) {
      resetProjectIdRef.current = projectId;
      activeAgentTurnRef.current?.controller.abort(new DOMException("Project changed", "AbortError"));
      activeAgentTurnRef.current = null;
      setActiveAgentTurnScope(null);
      scopedTurnIdsRef.current.clear();
      scopedPlanDiscoveryEpochRef.current += 1;
      setAgentDrafts({});
      setAgentErrors({});
      setScopedAgentReceipts({});
      setScopedAgentPlanIds({});
      setSelectedGraphObjectIds([]);
      setViewport(null);
      setTaskQueue([]);
      mutationQueueRef.current = Promise.resolve();
      proposalEditQueueRef.current = Promise.resolve();
      proposalEditGenerationRef.current += 1;
      proposalActionLockRef.current = false;
      proposalFocusNonceRef.current = 0;
    }
    commitLoad({ status: "loading" });
    setProposals([]);
    commitProposalReview({ status: "loading" });
    setProposalFocus(null);
    setFocusedProposalChangeKey(null);
    void readProjectStudio(api, projectId)
      .then(([project, workspace, proposalResult]) => {
        if (!current) return;
        const resolved = resolveLoadState(project, workspace);
        commitLoad(resolved);
        setProposals(proposalResult.proposals);
        if (resolved.status !== "ready") {
          commitProposalReview({ status: "idle" });
          return;
        }
        if (proposalResult.error) {
          commitProposalReview({ status: "error", message: proposalResult.error });
          return;
        }
        const active = proposalResult.proposals.find((proposal) => proposal.status === "draft" || proposal.status === "conflicted");
        commitProposalReview(active ? reviewStateForProposal(active, resolved) : { status: "idle" });
      })
      .catch((error: unknown) => {
        if (current) {
          commitLoad({ status: "error", message: errorMessage(error) });
          commitProposalReview({ status: "error", message: errorMessage(error) });
        }
      });
    return () => {
      current = false;
      const activeTurn = activeAgentTurnRef.current;
      if (activeTurn?.projectEpoch === effectEpoch) {
        activeTurn.controller.abort(new DOMException("Agent view closed", "AbortError"));
        activeAgentTurnRef.current = null;
        setActiveAgentTurnScope(null);
      }
      const reconcileState = generationPublicationReconcileRef.current;
      reconcileState.requested = false;
      reconcileState.epoch = -1;
    };
  }, [api, commitLoad, commitProposalReview, loadAttempt, projectId]);

  useEffect(() => {
    const nextScopeKey = agentScopeKey(agentTargetFor(artifactAgentTargetId, resourceAgentTargetId));
    const activeTurn = activeAgentTurnRef.current;
    if (activeTurn !== null && activeTurn.scopeKey !== nextScopeKey) {
      activeTurn.controller.abort(new DOMException("Agent scope changed", "AbortError"));
      if (activeAgentTurnRef.current?.controller === activeTurn.controller) {
        activeAgentTurnRef.current = null;
        setActiveAgentTurnScope(null);
      }
    }
  }, [artifactAgentTargetId, resourceAgentTargetId]);

  const readyWorkspaceId = load.status === "ready" ? load.workspace.workspace.id : null;
  useEffect(() => {
    if (artifactAgentTargetId === null || readyWorkspaceId === null) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let reconciledPlanId: string | null = null;
    const controller = new AbortController();
    const scopeKey = agentScopeKey({ type: "artifact", id: artifactAgentTargetId });
    scopedPlanDiscoveryEpochRef.current += 1;
    const discover = async (): Promise<void> => {
      const requestEpoch = scopedPlanDiscoveryEpochRef.current;
      let delay = SCOPED_PLAN_POLL_MS;
      try {
        const planId = await api.getLatestScopedArtifactPlanId(
          projectId,
          artifactAgentTargetId,
          controller.signal,
        );
        failures = 0;
        if (current && requestEpoch === scopedPlanDiscoveryEpochRef.current
          && artifactAgentTargetIdRef.current === artifactAgentTargetId && planId !== null) {
          setScopedAgentPlanIds((known) => known[scopeKey] === planId
            ? known
            : { ...known, [scopeKey]: planId });
          if (reconciledPlanId !== planId) {
            reconciledPlanId = planId;
            reconcileGenerationPublication();
          }
        }
      } catch {
        failures += 1;
        delay = Math.min(
          SCOPED_PLAN_RETRY_MS * (2 ** Math.min(failures - 1, 3)),
          SCOPED_PLAN_POLL_MS,
        );
      } finally {
        if (current) timer = setTimeout(() => void discover(), delay);
      }
    };
    void discover();
    return () => {
      current = false;
      controller.abort(new DOMException("Artifact view closed", "AbortError"));
      scopedPlanDiscoveryEpochRef.current += 1;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, artifactAgentTargetId, projectId, readyWorkspaceId, reconcileGenerationPublication]);

  const saveLayout = useCallback((commands: readonly WorkspaceLayoutCommand[]): Promise<WorkspaceLayout> => {
    const epoch = projectEpochRef.current;
    return enqueueMutation(async () => {
      if (epoch !== projectEpochRef.current) throw new Error("The project changed before the layout could be saved.");
      let current = requireReady();
      if (commands.length === 0) return current.workspace.layout;
      const baseLayoutChecksum = current.workspace.layout.checksum;
      const save = (ready: ReadyLoadState) => api.saveWorkspaceLayout(projectId, {
        layoutId: ready.workspace.layout.layoutId,
        graphRevision: ready.workspace.graph.revision,
        baseLayoutChecksum: ready.workspace.layout.checksum,
        commands,
      });
      let saved: WorkspaceLayout;
      try {
        saved = await save(current);
      } catch (error) {
        if (epoch !== projectEpochRef.current) throw new Error("The project changed while the layout was saving.");
        if (!isWorkspaceLayoutConflict(error)) throw error;
        const refreshedPayload = await api.getWorkspace(projectId);
        if (epoch !== projectEpochRef.current) throw new Error("The project changed while the layout was saving.");
        const refreshed = resolveLoadState(current.project, refreshedPayload);
        if (refreshed.status !== "ready") throw new Error("The refreshed Standard workspace is unavailable.");
        updateReadyWorkspace(refreshed.workspace);
        current = refreshed;
        if (error.details?.code !== "workspace_revision_conflict"
          || current.workspace.layout.checksum !== baseLayoutChecksum) {
          throw error;
        }
        saved = await save(current);
      }
      if (epoch !== projectEpochRef.current) throw new Error("The project changed while the layout was saving.");
      updateReadyWorkspace({ ...requireReady().workspace, layout: saved });
      return saved;
    });
  }, [api, enqueueMutation, projectId, requireReady, updateReadyWorkspace]);

  const applyGraphCommands = useCallback((commands: readonly WorkspaceGraphCommand[]): Promise<void> => {
    const epoch = projectEpochRef.current;
    return enqueueMutation(async () => {
      if (epoch !== projectEpochRef.current) return;
      if (commands.length === 0) return;
      let current = requireReady();
      const baselineGraph = current.workspace.graph;
      const apply = (
        ready: Extract<ProjectStudioLoadState, { status: "ready" }>,
        nextCommands: readonly WorkspaceGraphCommand[] = commands,
      ) => api.applyWorkspaceGraphCommands(projectId, {
        baseGraphRevision: ready.workspace.graph.revision,
        expectedSnapshotId: ready.workspace.activeSnapshot.id,
        commands: nextCommands,
      });
      let result;
      try {
        result = await apply(current);
      } catch (error) {
        if (epoch !== projectEpochRef.current) return;
        if (!isWorkspaceRevisionConflict(error)) throw error;
        const refreshedPayload = await api.getWorkspace(projectId);
        if (epoch !== projectEpochRef.current) return;
        const refreshed = resolveLoadState(current.project, refreshedPayload);
        if (refreshed.status !== "ready") throw new Error("The refreshed Standard workspace is unavailable.");
        updateReadyWorkspace(refreshed.workspace);
        current = refreshed;
        const resolution = classifyGraphCommandConflict(baselineGraph, current.workspace.graph, commands);
        if (resolution.kind === "conflict") throw error;
        if (resolution.kind === "converged") return;
        result = await apply(current, resolution.commands);
      }
      if (epoch !== projectEpochRef.current) return;
      const snapshots = current.workspace.snapshots.some((snapshot) => snapshot.id === result.snapshot.id)
        ? current.workspace.snapshots.map((snapshot) => snapshot.id === result.snapshot.id ? result.snapshot : snapshot)
        : [...current.workspace.snapshots, result.snapshot];
      updateReadyWorkspace({
        ...current.workspace,
        workspace: {
          ...current.workspace.workspace,
          graphRevision: result.graph.revision,
          activeSnapshotId: result.snapshot.id,
          updatedAt: Math.max(current.workspace.workspace.updatedAt, result.snapshot.createdAt),
        },
        graph: result.graph,
        activeSnapshot: result.snapshot,
        snapshots,
      });
    });
  }, [api, enqueueMutation, projectId, requireReady, updateReadyWorkspace]);

  const submitWorkspaceAgentPromptInternal = useCallback(async (
    restoredOutbox: Extract<AgentTurnOutbox, { kind: "workspace" }> | null = null,
  ): Promise<void> => {
    if (activeAgentTurnRef.current !== null || artifactAgentTargetIdRef.current !== null
      || resourceAgentTargetIdRef.current !== null) return;
    const scopeKey = WORKSPACE_AGENT_SCOPE;
    const session = readCachedAgentSession(scopeKey);
    const message = (restoredOutbox?.request.message ?? agentDrafts[scopeKey] ?? session.draft).trim();
    if (!message) return;
    let ready: ReadyLoadState;
    let requestFacts: Extract<AgentTurnOutbox, { kind: "workspace" }>["request"];
    try {
      ready = requireReady();
      const selectedContext = restoredOutbox === null
        ? await selectedGraphContextRefs(api, projectId, ready.workspace, selectedGraphObjectIds)
        : [];
      requestFacts = restoredOutbox?.request ?? {
        turnId: "",
        message,
        explicitContext: mergeContextRefs(
          serializeDaemonOwnedComposerContext(readCachedAgentSession(scopeKey).contextItems),
          selectedContext,
        ),
        graphRevision: ready.workspace.graph.revision,
        selection: [...new Set(selectedGraphObjectIds)].map((id) => ({ kind: "node" as const, id })),
      };
    } catch (error) {
      setAgentErrors((current) => ({ ...current, [scopeKey]: errorMessage(error) }));
      return;
    }
    if (activeAgentTurnRef.current !== null || artifactAgentTargetIdRef.current !== null
      || resourceAgentTargetIdRef.current !== null) return;
    const fingerprintFacts = {
      message: requestFacts.message,
      explicitContext: requestFacts.explicitContext,
      graphRevision: requestFacts.graphRevision,
      selection: requestFacts.selection ?? [],
    };
    const fingerprint = restoredOutbox?.fingerprint ?? JSON.stringify(fingerprintFacts);
    const persistedOutbox = readCachedAgentSession(scopeKey).outbox;
    const previousTurn = scopedTurnIdsRef.current.get(scopeKey);
    const turnId = restoredOutbox?.turnId
      ?? (persistedOutbox?.kind === "workspace" && persistedOutbox.fingerprint === fingerprint
        ? persistedOutbox.turnId
        : previousTurn?.fingerprint === fingerprint ? previousTurn.id : canonicalTurnId());
    const request = { ...requestFacts, turnId };
    scopedTurnIdsRef.current.set(scopeKey, { id: turnId, fingerprint });
    const epoch = projectEpochRef.current;
    const controller = new AbortController();
    const submittedAt = restoredOutbox?.createdAt ?? Date.now();
    const outbox: AgentTurnOutbox = { kind: "workspace", turnId, fingerprint, request, createdAt: submittedAt };
    updateAgentSession(scopeKey, (current) => ({
      ...current,
      outbox,
      transcript: upsertTranscriptEntry(current.transcript, {
        id: `user:${turnId}`,
        turnId,
        role: "user",
        content: message,
        createdAt: submittedAt,
        state: "submitted",
      }),
    }));
    activeAgentTurnRef.current = { projectEpoch: epoch, scopeKey, controller };
    setActiveAgentTurnScope(scopeKey);
    setAgentErrors((current) => {
      if (!(scopeKey in current)) return current;
      const next = { ...current };
      delete next[scopeKey];
      return next;
    });
    try {
      const proposal = await api.workspaceAgentTurn(projectId, request, controller.signal);
      if (epoch !== projectEpochRef.current || artifactAgentTargetIdRef.current !== null
        || resourceAgentTargetIdRef.current !== null
        || controller.signal.aborted) return;
      const current = requireReady();
      if (proposal.workspaceId !== current.workspace.workspace.id
        || proposal.kind !== "workspace-generation"
        || proposal.generation?.kind !== "workspace-generation"
        || proposal.baseGraphRevision !== request.graphRevision
        || (proposal.status === "draft" && proposal.review.kind !== "none")) {
        throw new Error("Workspace Agent returned a Proposal outside the current canvas Revision.");
      }
      scopedTurnIdsRef.current.delete(scopeKey);
      proposalValidationRef.current = null;
      replaceProposal(proposal);
      setFocusedProposalChangeKey(null);
      setProposalFocus(null);
      commitProposalReview(reviewStateForProposal(proposal, current));
      updateAgentSession(scopeKey, (stored) => ({
        ...stored,
        draft: stored.draft.trim() === message ? "" : stored.draft,
        outbox: stored.outbox?.turnId === turnId ? null : stored.outbox,
        receipt: {
          kind: "workspace",
          turnId,
          proposalId: proposal.id,
          status: proposal.status,
          createdAt: Date.now(),
        },
        transcript: upsertTranscriptEntry(stored.transcript, {
          id: `assistant:${turnId}`,
          turnId,
          role: "assistant",
          content: `Proposal ${proposal.id} is ready for review.`,
          createdAt: Date.now(),
          state: "proposal",
        }),
      }));
      setAgentDrafts((currentDrafts) => {
        if ((currentDrafts[scopeKey] ?? session.draft).trim() !== message) return currentDrafts;
        const next = { ...currentDrafts };
        delete next[scopeKey];
        return next;
      });
    } catch (error) {
      if (epoch !== projectEpochRef.current || artifactAgentTargetIdRef.current !== null
        || resourceAgentTargetIdRef.current !== null
        || controller.signal.aborted || isAbortError(error)) return;
      setAgentErrors((current) => ({ ...current, [scopeKey]: errorMessage(error) }));
    } finally {
      if (activeAgentTurnRef.current?.controller === controller) {
        activeAgentTurnRef.current = null;
        if (epoch === projectEpochRef.current) setActiveAgentTurnScope(null);
      }
    }
  }, [agentDrafts, api, commitProposalReview, projectId, replaceProposal, requireReady, selectedGraphObjectIds]);

  const submitWorkspaceAgentPrompt = useCallback(
    (): Promise<void> => submitWorkspaceAgentPromptInternal(),
    [submitWorkspaceAgentPromptInternal],
  );

  const submitScopedAgentPrompt = useCallback(async ({
    scopeType,
    targetId,
    baseRevisionId,
    selection = [],
    intent = "edit",
    restoredOutbox = null,
  }: {
    scopeType: "artifact" | "resource";
    targetId: string;
    baseRevisionId: string;
    selection?: SelectionRef[];
    intent?: "generate" | "edit" | "repair";
    restoredOutbox?: Extract<AgentTurnOutbox, { kind: "scoped" }> | null;
  }): Promise<void> => {
    const currentTargetId = scopeType === "artifact"
      ? artifactAgentTargetIdRef.current
      : resourceAgentTargetIdRef.current;
    const scopeKey = agentScopeKey({ type: scopeType, id: targetId });
    if (currentTargetId !== targetId) {
      setAgentErrors((current) => ({
        ...current,
        [scopeKey]: `The ${scopeType === "artifact" ? "Artifact" : "Resource"} Agent target changed before the request could be queued.`,
      }));
      return;
    }
    if (activeAgentTurnRef.current !== null) return;
    const session = readCachedAgentSession(scopeKey);
    const message = (restoredOutbox?.request.message ?? agentDrafts[scopeKey] ?? session.draft).trim();
    if (!message) return;
    let ready: ReadyLoadState;
    let requestFacts: Extract<AgentTurnOutbox, { kind: "scoped" }>["request"];
    try {
      ready = requireReady();
      requestFacts = restoredOutbox?.request ?? {
        turnId: "",
        intent,
        message,
        explicitContext: serializeDaemonOwnedComposerContext(session.contextItems),
        graphRevision: ready.workspace.graph.revision,
        baseRevisionId,
        selection,
      };
    } catch (error) {
      setAgentErrors((current) => ({ ...current, [scopeKey]: errorMessage(error) }));
      return;
    }
    const projectEpoch = projectEpochRef.current;
    const targetEpoch = scopeType === "artifact"
      ? artifactAgentTargetEpochRef.current
      : resourceAgentTargetEpochRef.current;
    const controller = new AbortController();
    const fingerprintFacts = {
      intent: requestFacts.intent,
      message: requestFacts.message,
      explicitContext: requestFacts.explicitContext,
      graphRevision: requestFacts.graphRevision,
      baseRevisionId: requestFacts.baseRevisionId,
      selection: requestFacts.selection ?? [],
    };
    const fingerprint = restoredOutbox?.fingerprint ?? JSON.stringify(fingerprintFacts);
    const persistedOutbox = session.outbox;
    const previousTurn = scopedTurnIdsRef.current.get(scopeKey);
    const turnId = restoredOutbox?.turnId
      ?? (persistedOutbox?.kind === "scoped" && persistedOutbox.fingerprint === fingerprint
        ? persistedOutbox.turnId
        : previousTurn?.fingerprint === fingerprint ? previousTurn.id : canonicalTurnId());
    const request = { ...requestFacts, turnId };
    scopedTurnIdsRef.current.set(scopeKey, { id: turnId, fingerprint });
    const submittedAt = restoredOutbox?.createdAt ?? Date.now();
    const outbox: Extract<AgentTurnOutbox, { kind: "scoped" }> = {
      kind: "scoped",
      scopeType,
      targetId,
      turnId,
      fingerprint,
      request,
      createdAt: submittedAt,
    };
    updateAgentSession(scopeKey, (stored) => ({
      ...stored,
      outbox,
      transcript: upsertTranscriptEntry(stored.transcript, {
        id: `user:${turnId}`,
        turnId,
        role: "user",
        content: message,
        createdAt: submittedAt,
        state: "submitted",
      }),
    }));
    activeAgentTurnRef.current = { projectEpoch, scopeKey, controller };
    setActiveAgentTurnScope(scopeKey);
    setAgentErrors((current) => {
      if (!(scopeKey in current)) return current;
      const next = { ...current };
      delete next[scopeKey];
      return next;
    });
    setScopedAgentReceipts((current) => {
      if (!(scopeKey in current)) return current;
      const next = { ...current };
      delete next[scopeKey];
      return next;
    });
    try {
      const receipt = scopeType === "artifact"
        ? await api.artifactAgentTurn(projectId, targetId, request, controller.signal)
        : await api.resourceAgentTurn(projectId, targetId, request, controller.signal);
      const liveTargetId = scopeType === "artifact"
        ? artifactAgentTargetIdRef.current
        : resourceAgentTargetIdRef.current;
      const liveTargetEpoch = scopeType === "artifact"
        ? artifactAgentTargetEpochRef.current
        : resourceAgentTargetEpochRef.current;
      if (projectEpoch !== projectEpochRef.current || targetEpoch !== liveTargetEpoch
        || liveTargetId !== targetId || controller.signal.aborted) return;
      const current = requireReady();
      if (receipt.task.workspaceId !== current.workspace.workspace.id
        || receipt.task.target.type !== scopeType || receipt.task.target.id !== targetId
        || receipt.task.target.workspaceId !== current.workspace.workspace.id
        || receipt.task.id.trim().length === 0 || receipt.task.planId.trim().length === 0
        || !CONTEXT_PACK_ID.test(receipt.contextPackId)) {
        throw new Error(`${scopeType === "artifact" ? "Artifact" : "Resource"} Agent returned a Task outside the current scope.`);
      }
      scopedPlanDiscoveryEpochRef.current += 1;
      scopedTurnIdsRef.current.delete(scopeKey);
      setScopedAgentReceipts((known) => ({ ...known, [scopeKey]: receipt }));
      setScopedAgentPlanIds((known) => ({ ...known, [scopeKey]: receipt.task.planId }));
      updateAgentSession(scopeKey, (stored) => ({
        ...stored,
        draft: stored.draft.trim() === message ? "" : stored.draft,
        outbox: stored.outbox?.turnId === turnId ? null : stored.outbox,
        receipt: { kind: "scoped", turnId, receipt, createdAt: Date.now() },
        transcript: upsertTranscriptEntry(stored.transcript, {
          id: `assistant:${turnId}`,
          turnId,
          role: "assistant",
          content: `Queued Task ${receipt.task.id} in Plan ${receipt.task.planId}.`,
          createdAt: Date.now(),
          state: "queued",
        }),
      }));
      setAgentDrafts((currentDrafts) => {
        if ((currentDrafts[scopeKey] ?? session.draft).trim() !== message) return currentDrafts;
        const next = { ...currentDrafts };
        delete next[scopeKey];
        return next;
      });
    } catch (error) {
      const liveTargetId = scopeType === "artifact"
        ? artifactAgentTargetIdRef.current
        : resourceAgentTargetIdRef.current;
      const liveTargetEpoch = scopeType === "artifact"
        ? artifactAgentTargetEpochRef.current
        : resourceAgentTargetEpochRef.current;
      if (projectEpoch !== projectEpochRef.current || targetEpoch !== liveTargetEpoch
        || liveTargetId !== targetId || controller.signal.aborted || isAbortError(error)) return;
      setAgentErrors((current) => ({ ...current, [scopeKey]: errorMessage(error) }));
    } finally {
      if (activeAgentTurnRef.current?.controller === controller) {
        activeAgentTurnRef.current = null;
        if (projectEpoch === projectEpochRef.current) setActiveAgentTurnScope(null);
      }
    }
  }, [agentDrafts, api, projectId, requireReady]);

  const submitArtifactAgentPrompt = useCallback((input: {
    artifactId: string;
    baseRevisionId: string;
    selection?: SelectionRef[];
    intent?: "generate" | "edit" | "repair";
  }): Promise<void> => submitScopedAgentPrompt({
    scopeType: "artifact",
    targetId: input.artifactId,
    baseRevisionId: input.baseRevisionId,
    selection: input.selection,
    intent: input.intent,
  }), [submitScopedAgentPrompt]);

  const submitResourceAgentPrompt = useCallback((input: {
    resourceId: string;
    baseRevisionId: string;
    intent?: "generate" | "edit" | "repair";
  }): Promise<void> => submitScopedAgentPrompt({
    scopeType: "resource",
    targetId: input.resourceId,
    baseRevisionId: input.baseRevisionId,
    intent: input.intent,
  }), [submitScopedAgentPrompt]);

  useEffect(() => {
    if (load.status !== "ready" || activeAgentTurnRef.current !== null
      || lastReconciledAgentScopeRef.current === currentAgentScopeKey) return;
    lastReconciledAgentScopeRef.current = currentAgentScopeKey;
    const session = readCachedAgentSession(currentAgentScopeKey);
    const outbox = session.outbox;
    if (outbox === null) return;
    if (currentAgentTarget.type === "workspace") {
      if (outbox.kind === "workspace") void submitWorkspaceAgentPromptInternal(outbox);
      return;
    }
    if (outbox.kind !== "scoped" || outbox.scopeType !== currentAgentTarget.type
      || outbox.targetId !== currentAgentTarget.id) return;
    void submitScopedAgentPrompt({
      scopeType: outbox.scopeType,
      targetId: outbox.targetId,
      baseRevisionId: outbox.request.baseRevisionId,
      selection: outbox.request.selection,
      intent: outbox.request.intent,
      restoredOutbox: outbox,
    });
  }, [
    activeAgentTurnScope,
    currentAgentScopeKey,
    load.status,
    submitScopedAgentPrompt,
    submitWorkspaceAgentPromptInternal,
  ]);

  const enqueueProposalEdit = useCallback((
    resolvePatch: (proposal: WorkspaceProposal) => ProposalEditPatch | null,
    resolveValidationIdentities: (
      proposal: WorkspaceProposal,
      patch: ProposalEditPatch,
    ) => readonly ProposalValidationIdentity[] = (_proposal, patch) => (
      (Object.keys(patch) as ProposalEditField[]).map(fieldValidationIdentity)
    ),
  ): Promise<WorkspaceProposal> => {
    const initial = reviewableProposal(proposalReviewRef.current);
    if (!initial || initial.status === "conflicted") {
      return Promise.reject(new Error("The active proposal is not editable."));
    }
    if (proposalActionLockRef.current) return Promise.resolve(initial.proposal);
    const epoch = projectEpochRef.current;
    const editGeneration = proposalEditGenerationRef.current;
    const result = proposalEditQueueRef.current.then(async () => {
      if (epoch !== projectEpochRef.current || editGeneration !== proposalEditGenerationRef.current) {
        return initial.proposal;
      }
      const review = reviewableProposal(proposalReviewRef.current);
      if (!review || review.status === "conflicted") {
        return initial.proposal;
      }
      const proposal = review.proposal;
      const patch = resolvePatch(proposal);
      if (patch === null) return proposal;
      const validationIdentities = resolveValidationIdentities(proposal, patch);
      if (isProposalEditPatchNoop(proposal, patch)) {
        const pendingValidation = proposalValidationRef.current;
        if (pendingValidation?.proposalId === proposal.id) {
          for (const identity of validationIdentities) pendingValidation.identities.delete(identity);
          if (pendingValidation.identities.size === 0) {
            proposalValidationRef.current = null;
            commitProposalReview(reviewStateForProposal(proposal, requireReady()));
          } else {
            commitProposalReview({
              status: "validation-error",
              source: "edit",
              proposal,
              diff: diffProposal(proposal, requireReady()),
              message: pendingValidation.message,
              issues: pendingValidation.issues,
              ...proposalValidationMetadata(pendingValidation),
            });
          }
        }
        return proposal;
      }
      commitProposalReview({ status: "saving", intent: "edit", proposal, diff: review.diff });
      try {
        const updated = await api.updateWorkspaceProposal(projectId, proposal.id, {
          expectedProposalRevision: proposal.revision,
          operations: [...(patch.operations ?? proposal.operations)],
          layoutOperations: [...(patch.layoutOperations ?? proposal.layoutOperations)],
          generation: patch.generation ?? proposal.generation,
          rationale: patch.rationale ?? proposal.rationale,
          assumptions: [...(patch.assumptions ?? proposal.assumptions)],
        });
        if (epoch !== projectEpochRef.current) return updated;
        const ready = requireReady();
        const pendingValidation = proposalValidationRef.current;
        if (pendingValidation?.proposalId === updated.id) {
          for (const identity of validationIdentities) pendingValidation.identities.delete(identity);
          pruneMissingProposalChangeValidations(pendingValidation, updated, ready);
          if (pendingValidation.identities.size === 0) proposalValidationRef.current = null;
        }
        replaceProposal(updated);
        const remainingValidation = proposalValidationRef.current;
        if (remainingValidation?.proposalId === updated.id && updated.status === "draft") {
          commitProposalReview({
            status: "validation-error",
            source: "edit",
            proposal: updated,
            diff: diffProposal(updated, ready),
            message: remainingValidation.message,
            issues: remainingValidation.issues,
            ...proposalValidationMetadata(remainingValidation),
          });
        } else {
          commitProposalReview(reviewStateForProposal(updated, ready));
        }
        return updated;
      } catch (error) {
        if (epoch !== projectEpochRef.current) return initial.proposal;
        if (isProposalPayloadConflict(error)) {
          const resetEditFields = Object.keys(patch) as ProposalEditField[];
          proposalEditGenerationRef.current += 1;
          try {
            const latest = await api.getWorkspaceProposal(projectId, proposal.id);
            if (epoch !== projectEpochRef.current) return latest;
            const ready = requireReady();
            const pendingValidation = proposalValidationRef.current;
            if (pendingValidation?.proposalId === latest.id) {
              for (const identity of validationIdentities) pendingValidation.identities.delete(identity);
              pruneMissingProposalChangeValidations(pendingValidation, latest, ready);
              if (pendingValidation.identities.size === 0) proposalValidationRef.current = null;
            }
            replaceProposal(latest);
            if (latest.status === "draft") {
              commitProposalReview({
                status: "validation-error",
                source: "edit",
                proposal: latest,
                diff: diffProposal(latest, ready),
                message: "Proposal changed while you were reviewing it. Review the latest draft, then save your edit again.",
                issues: [],
                resetEditFields,
                ...(proposalValidationRef.current?.proposalId === latest.id
                  ? proposalValidationMetadata(proposalValidationRef.current)
                  : { invalidEditFields: [], invalidChangeKeys: [] }),
              });
            } else {
              proposalValidationRef.current = null;
              const refreshed = await readCurrentReadyWorkspace(epoch);
              if (epoch !== projectEpochRef.current) return latest;
              const authoritative = refreshed ?? requireReady();
              if (refreshed) commitLoad(refreshed);
              commitProposalReview(reviewStateForProposal(latest, authoritative));
            }
            return latest;
          } catch (refreshError) {
            if (epoch !== projectEpochRef.current) return initial.proposal;
            commitProposalReview({ status: "error", message: errorMessage(refreshError) });
            return proposal;
          }
        }
        if (isProposalValidationError(error)) {
          const message = typeof error.details?.error === "string" ? error.details.error : error.message;
          const issues = validationIssues(error);
          const existing = proposalValidationRef.current?.proposalId === proposal.id
            ? proposalValidationRef.current
            : null;
          proposalValidationRef.current = {
            proposalId: proposal.id,
            identities: new Set([...(existing?.identities ?? []), ...validationIdentities]),
            message,
            issues,
          };
          commitProposalReview({
            status: "validation-error",
            source: "edit",
            proposal,
            diff: diffProposal(proposal, requireReady()),
            message,
            issues,
            ...proposalValidationMetadata(proposalValidationRef.current),
          });
          return proposal;
        }
        commitProposalReview({ status: "error", message: errorMessage(error) });
        return proposal;
      }
    });
    proposalEditQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [api, commitLoad, commitProposalReview, projectId, readCurrentReadyWorkspace, replaceProposal, requireReady]);

  const editProposal = useCallback((patch: ProposalEditPatch): Promise<WorkspaceProposal> => (
    enqueueProposalEdit(() => patch)
  ), [enqueueProposalEdit]);

  const renameProposalNode = useCallback((change: ProposalChange<unknown>, name: string): Promise<WorkspaceProposal> => (
    enqueueProposalEdit((proposal) => {
      const latestChange = diffProposal(proposal, requireReady()).reviewItems
        .find((candidate) => candidate.key === change.key);
      if (!latestChange) return null;
      const commandIds = new Set(latestChange.operationRefs.flatMap((reference) => (
        reference.kind === "graph" ? [reference.commandId] : []
      )));
      let changed = false;
      const operations = proposal.operations.map((command): WorkspaceGraphCommand => {
        if (!commandIds.has(command.id)) return command;
        if (command.type === "add-node" && command.node.id === latestChange.objectId) {
          changed = true;
          return { ...command, node: { ...command.node, name } };
        }
        if (command.type === "rename-node" && command.nodeId === latestChange.objectId) {
          changed = true;
          return { ...command, name };
        }
        return command;
      });
      return changed ? { operations } : null;
    }, () => [changeValidationIdentity(change.key)])
  ), [enqueueProposalEdit, requireReady]);

  const revertProposalChange = useCallback((change: ProposalChange<unknown>): Promise<WorkspaceProposal> => {
    return enqueueProposalEdit((proposal) => {
      const latestChange = diffProposal(proposal, requireReady()).reviewItems
        .find((candidate) => candidate.key === change.key);
      if (!latestChange) return null;
      const operationRefs = latestChange.operationRefs;
      const graphCommandIds = new Set(operationRefs.flatMap((ref) => ref.kind === "graph" ? [ref.commandId] : []));
      const layoutIndexes = new Set(operationRefs.flatMap((ref) => ref.kind === "layout" ? [ref.index] : []));
      return {
        operations: proposal.operations.filter((command) => !graphCommandIds.has(command.id)),
        layoutOperations: proposal.layoutOperations.filter((_command, index) => !layoutIndexes.has(index)),
      };
    }, () => [changeValidationIdentity(change.key)]);
  }, [enqueueProposalEdit, requireReady]);

  const focusProposalChange = useCallback((changeKey: string) => {
    setFocusedProposalChangeKey(changeKey);
    proposalFocusNonceRef.current += 1;
    setProposalFocus({ key: changeKey, nonce: proposalFocusNonceRef.current });
  }, []);

  const reconcileApprovedProposalResult = useCallback(async (
    result: ApprovedProposalResult,
    epoch: number,
  ): Promise<void> => {
    if (epoch !== projectEpochRef.current) return;
    const current = requireReady();
    const snapshots = current.workspace.snapshots.some((snapshot) => snapshot.id === result.snapshot.id)
      ? current.workspace.snapshots.map((snapshot) => snapshot.id === result.snapshot.id ? result.snapshot : snapshot)
      : [...current.workspace.snapshots, result.snapshot];
    commitLoad({
      ...current,
      workspace: {
        ...current.workspace,
        workspace: {
          ...current.workspace.workspace,
          graphRevision: result.graph.revision,
          activeSnapshotId: result.snapshot.id,
          updatedAt: Math.max(current.workspace.workspace.updatedAt, result.snapshot.createdAt),
        },
        graph: result.graph,
        activeSnapshot: result.snapshot,
        snapshots,
        layout: result.layout,
      },
    });
    proposalValidationRef.current = null;
    replaceProposal(result.proposal);
    setViewport(null);
    setFocusedProposalChangeKey(null);
    setProposalFocus(null);
    commitProposalReview({ status: "approved", proposal: result.proposal, plan: result.plan });
    const refreshed = await readCurrentReadyWorkspace(epoch);
    if (epoch !== projectEpochRef.current) return;
    if (refreshed
      && refreshed.workspace.graph.revision >= result.graph.revision
      && refreshed.workspace.activeSnapshot.id === result.snapshot.id) {
      const approvedCurrent = requireReady();
      commitLoad({
        ...approvedCurrent,
        workspace: {
          ...approvedCurrent.workspace,
          artifacts: refreshed.workspace.artifacts,
          tracks: refreshed.workspace.tracks,
          revisions: refreshed.workspace.revisions,
          snapshots: refreshed.workspace.snapshots,
          activeKernelRevision: refreshed.workspace.activeKernelRevision,
        },
      });
    }
  }, [commitLoad, commitProposalReview, readCurrentReadyWorkspace, replaceProposal, requireReady]);

  const approveProposal = useCallback(async (mode: WorkspaceProposalApprovalMode): Promise<void> => {
    if (proposalActionLockRef.current) return;
    const initial = reviewableProposal(proposalReviewRef.current);
    if (!initial || initial.status === "conflicted") return;
    if (initial.status === "validation-error" && initial.source === "edit") return;
    proposalActionLockRef.current = true;
    const epoch = projectEpochRef.current;
    const editGeneration = proposalEditGenerationRef.current;
    commitProposalReview({ status: "saving", intent: "approve", proposal: initial.proposal, diff: initial.diff });
    try {
      await proposalEditQueueRef.current;
      if (epoch !== projectEpochRef.current || editGeneration !== proposalEditGenerationRef.current) return;
      await enqueueMutation(async () => {
        if (epoch !== projectEpochRef.current || editGeneration !== proposalEditGenerationRef.current) return;
        const review = reviewableProposal(proposalReviewRef.current);
        if (!review || review.status === "conflicted") return;
        if (review.status === "validation-error" && review.source === "edit") return;
        const proposal = review.proposal;
        commitProposalReview({ status: "saving", intent: "approve", proposal, diff: review.diff });
        try {
          const result = await api.approveWorkspaceProposal(projectId, proposal.id, mode);
          await reconcileApprovedProposalResult(result, epoch);
      } catch (error) {
        if (epoch !== projectEpochRef.current) return;
        const compileFailure = generationCompileFailureResult(error);
        if (compileFailure) {
          await reconcileApprovedProposalResult(compileFailure, epoch);
          return;
        }
        if (isProposalApprovalConflict(error)) {
          try {
            const persisted = proposalFromError(error)
              ?? await api.getWorkspaceProposal(projectId, proposal.id);
            if (epoch !== projectEpochRef.current) return;
            const refreshed = await readCurrentReadyWorkspace(epoch);
            if (epoch !== projectEpochRef.current) return;
            const authoritative = refreshed ?? requireReady();
            if (refreshed) commitLoad(refreshed);
            proposalValidationRef.current = null;
            replaceProposal(persisted);
            commitProposalReview({
              status: "conflicted",
              proposal: persisted,
              diff: diffProposal(persisted, authoritative),
              conflict: conflictSummary(persisted, authoritative),
            });
          } catch (refreshError) {
            if (epoch !== projectEpochRef.current) return;
            commitProposalReview({ status: "error", message: errorMessage(refreshError) });
          }
          return;
        }
        if (isProposalPayloadConflict(error)) {
          try {
            const latest = await api.getWorkspaceProposal(projectId, proposal.id);
            if (epoch !== projectEpochRef.current) return;
            replaceProposal(latest);
            const ready = requireReady();
            if (latest.status === "draft") {
              commitProposalReview({
                status: "validation-error",
                source: "approve",
                proposal: latest,
                diff: diffProposal(latest, ready),
                message: "Proposal changed while you were reviewing it. Review the latest draft before approving.",
                issues: [],
              });
            } else {
              proposalValidationRef.current = null;
              const refreshed = await readCurrentReadyWorkspace(epoch);
              if (epoch !== projectEpochRef.current) return;
              const authoritative = refreshed ?? requireReady();
              if (refreshed) commitLoad(refreshed);
              commitProposalReview(reviewStateForProposal(latest, authoritative));
            }
          } catch (refreshError) {
            if (epoch !== projectEpochRef.current) return;
            commitProposalReview({ status: "error", message: errorMessage(refreshError) });
          }
          return;
        }
        if (isProposalValidationError(error)) {
          const message = typeof error.details?.error === "string" ? error.details.error : error.message;
          commitProposalReview({
            status: "validation-error",
            source: "approve",
            proposal,
            diff: diffProposal(proposal, requireReady()),
            message,
            issues: validationIssues(error),
          });
          return;
        }
        commitProposalReview({ status: "error", message: errorMessage(error) });
      }
      });
    } finally {
      if (epoch === projectEpochRef.current) proposalActionLockRef.current = false;
    }
  }, [
    api,
    commitLoad,
    commitProposalReview,
    enqueueMutation,
    projectId,
    readCurrentReadyWorkspace,
    reconcileApprovedProposalResult,
    replaceProposal,
    requireReady,
  ]);

  const rejectProposal = useCallback(async (): Promise<void> => {
    if (proposalActionLockRef.current) return;
    const initial = reviewableProposal(proposalReviewRef.current);
    if (!initial || initial.status === "conflicted") return;
    proposalActionLockRef.current = true;
    const epoch = projectEpochRef.current;
    const editGeneration = proposalEditGenerationRef.current;
    commitProposalReview({ status: "saving", intent: "reject", proposal: initial.proposal, diff: initial.diff });
    try {
      await proposalEditQueueRef.current;
      if (epoch !== projectEpochRef.current || editGeneration !== proposalEditGenerationRef.current) return;
      await enqueueMutation(async () => {
        if (epoch !== projectEpochRef.current || editGeneration !== proposalEditGenerationRef.current) return;
        const review = reviewableProposal(proposalReviewRef.current);
        if (!review || review.status === "conflicted") return;
        const proposal = review.proposal;
        commitProposalReview({ status: "saving", intent: "reject", proposal, diff: review.diff });
        try {
          const rejected = await api.rejectWorkspaceProposal(projectId, proposal.id);
          if (epoch !== projectEpochRef.current) return;
          proposalValidationRef.current = null;
          replaceProposal(rejected);
          commitProposalReview({ status: "rejected", proposal: rejected, plan: null });
        } catch (error) {
          if (epoch !== projectEpochRef.current) return;
          if (isProposalPayloadConflict(error)) {
            try {
              const latest = await api.getWorkspaceProposal(projectId, proposal.id);
              if (epoch !== projectEpochRef.current) return;
              replaceProposal(latest);
              const refreshed = latest.status === "draft" ? null : await readCurrentReadyWorkspace(epoch);
              if (epoch !== projectEpochRef.current) return;
              const authoritative = refreshed ?? requireReady();
              if (refreshed) commitLoad(refreshed);
              let pendingValidation = proposalValidationRef.current;
              if (latest.status === "draft" && pendingValidation?.proposalId === latest.id) {
                pruneMissingProposalChangeValidations(pendingValidation, latest, authoritative);
                if (pendingValidation.identities.size === 0) {
                  proposalValidationRef.current = null;
                  pendingValidation = null;
                }
              }
              if (latest.status === "draft" && pendingValidation?.proposalId === latest.id) {
                commitProposalReview({
                  status: "validation-error",
                  source: "edit",
                  proposal: latest,
                  diff: diffProposal(latest, authoritative),
                  message: pendingValidation.message,
                  issues: pendingValidation.issues,
                  ...proposalValidationMetadata(pendingValidation),
                });
              } else {
                if (latest.status !== "draft") proposalValidationRef.current = null;
                commitProposalReview(reviewStateForProposal(latest, authoritative));
              }
            } catch (refreshError) {
              if (epoch !== projectEpochRef.current) return;
              commitProposalReview({ status: "error", message: errorMessage(refreshError) });
            }
            return;
          }
          commitProposalReview({ status: "error", message: errorMessage(error) });
        }
      });
    } finally {
      if (epoch === projectEpochRef.current) proposalActionLockRef.current = false;
    }
  }, [api, commitLoad, commitProposalReview, enqueueMutation, projectId, readCurrentReadyWorkspace, replaceProposal, requireReady]);

  const closeProposalReview = useCallback(() => {
    setFocusedProposalChangeKey(null);
    setProposalFocus(null);
    commitProposalReview({ status: "idle" });
  }, [commitProposalReview]);

  const viewport = viewportOverride
    ?? (load.status === "ready" ? load.workspace.layout.viewport : DEFAULT_VIEWPORT);

  return {
    load,
    proposals,
    proposalReview,
    proposalFocus,
    focusedProposalChangeKey,
    workspaceAgentDraft,
    setWorkspaceAgentDraft,
    agentContextItems,
    addAgentContextItems,
    setAgentContextItems,
    removeAgentContextItem,
    agentTranscript,
    materializeAgentResourceContext,
    agentTurnSubmitting,
    workspaceAgentSubmitting,
    workspaceAgentError,
    submitWorkspaceAgentPrompt,
    artifactAgentSubmitting,
    artifactAgentError,
    artifactAgentReceipt,
    artifactAgentPlanId,
    submitArtifactAgentPrompt,
    resourceAgentSubmitting,
    resourceAgentError,
    resourceAgentReceipt,
    resourceAgentPlanId,
    submitResourceAgentPrompt,
    selectedGraphObjectIds,
    setSelectedGraphObjectIds,
    viewport,
    setViewport,
    taskQueue,
    setTaskQueue,
    saveLayout,
    applyGraphCommands,
    reconcileArtifactPublication,
    reconcileGenerationPublication,
    editProposal,
    renameProposalNode,
    revertProposalChange,
    focusProposalChange,
    approveProposal,
    rejectProposal,
    closeProposalReview,
    retry,
  };
}
