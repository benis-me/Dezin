import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useApi } from "../lib/api-context.tsx";
import { ApiError } from "../lib/api.ts";
import type {
  ApiClient,
  Project,
  ProjectWorkspacePayload,
  ReadyProjectWorkspacePayload,
  UnsupportedProjectWorkspacePayload,
  WorkspaceGraphCommand,
  WorkspaceGraph,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceProposal,
  WorkspaceProposalApprovalMode,
  WorkspaceViewport,
} from "../lib/api.ts";
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
  selectedGraphObjectIds: string[];
  setSelectedGraphObjectIds: Dispatch<SetStateAction<string[]>>;
  viewport: WorkspaceViewport;
  setViewport: Dispatch<SetStateAction<WorkspaceViewport | null>>;
  taskQueue: WorkspaceStudioTask[];
  setTaskQueue: Dispatch<SetStateAction<WorkspaceStudioTask[]>>;
  saveLayout: (commands: readonly WorkspaceLayoutCommand[]) => Promise<WorkspaceLayout>;
  applyGraphCommands: (commands: readonly WorkspaceGraphCommand[]) => Promise<void>;
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

function isWorkspaceRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 409
    && error.details?.code === "workspace_revision_conflict";
}

function isWorkspaceLayoutConflict(error: unknown): boolean {
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

function canReplayGraphCommands(graph: WorkspaceGraph, commands: readonly WorkspaceGraphCommand[]): boolean {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  return commands.length > 0 && commands.every((command) => (
    command.type === "add-edge"
    && nodeIds.has(command.edge.sourceNodeId)
    && nodeIds.has(command.edge.targetNodeId)
    && !edgeIds.has(command.edge.id)
  ));
}

type ReadyLoadState = Extract<ProjectStudioLoadState, { status: "ready" }>;
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

export function useProjectStudio(projectId: string): ProjectStudioState {
  const api = useApi();
  const [load, setLoad] = useState<ProjectStudioLoadState>({ status: "loading" });
  const [proposals, setProposals] = useState<WorkspaceProposal[]>([]);
  const [proposalReview, setProposalReview] = useState<ProposalReviewState>({ status: "loading" });
  const [proposalFocus, setProposalFocus] = useState<ProposalFocusRequest | null>(null);
  const [focusedProposalChangeKey, setFocusedProposalChangeKey] = useState<string | null>(null);
  const [workspaceAgentDraft, setWorkspaceAgentDraft] = useState("");
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
  const proposalFocusNonceRef = useRef(0);
  const epochProjectIdRef = useRef(projectId);
  const resetProjectIdRef = useRef(projectId);
  const projectEpochRef = useRef(0);
  if (epochProjectIdRef.current !== projectId) {
    epochProjectIdRef.current = projectId;
    projectEpochRef.current += 1;
  }
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

  const enqueueMutation = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const result = mutationQueueRef.current.then(work);
    mutationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  useEffect(() => {
    let current = true;
    proposalValidationRef.current = null;
    if (resetProjectIdRef.current !== projectId) {
      resetProjectIdRef.current = projectId;
      setWorkspaceAgentDraft("");
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
    };
  }, [api, commitLoad, commitProposalReview, loadAttempt, projectId]);

  const saveLayout = useCallback((commands: readonly WorkspaceLayoutCommand[]): Promise<WorkspaceLayout> => {
    const epoch = projectEpochRef.current;
    return enqueueMutation(async () => {
      if (epoch !== projectEpochRef.current) throw new Error("The project changed before the layout could be saved.");
      let current = requireReady();
      if (commands.length === 0) return current.workspace.layout;
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
      const apply = (ready: Extract<ProjectStudioLoadState, { status: "ready" }>) => api.applyWorkspaceGraphCommands(projectId, {
        baseGraphRevision: ready.workspace.graph.revision,
        expectedSnapshotId: ready.workspace.activeSnapshot.id,
        commands,
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
        if (!canReplayGraphCommands(current.workspace.graph, commands)) throw error;
        result = await apply(current);
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
        const approved = result.proposal;
        proposalValidationRef.current = null;
        replaceProposal(approved);
        setViewport(null);
        setFocusedProposalChangeKey(null);
        setProposalFocus(null);
        commitProposalReview({ status: "approved", proposal: approved, plan: result.plan });
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
      } catch (error) {
        if (epoch !== projectEpochRef.current) return;
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
  }, [api, commitLoad, commitProposalReview, enqueueMutation, projectId, readCurrentReadyWorkspace, replaceProposal, requireReady]);

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
    selectedGraphObjectIds,
    setSelectedGraphObjectIds,
    viewport,
    setViewport,
    taskQueue,
    setTaskQueue,
    saveLayout,
    applyGraphCommands,
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
