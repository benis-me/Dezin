import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LegacyWorkspaceSeedDriftError,
  WorkspaceCommandReplayConflictError,
  WorkspaceGraphValidationError,
  WorkspaceLayoutConflictError,
  WorkspacePointerConflictError,
  WorkspaceProposalConflictError,
  WorkspaceProposalNotFoundError,
  WorkspaceProposalOwnershipError,
  WorkspaceProposalRevisionConflictError,
  WorkspaceProposalStateConflictError,
  WorkspaceProposalValidationError,
  WorkspaceRevisionConflictError,
  WorkspaceStoreCodecError,
  normalizeCreateWorkspaceProposalInput,
  normalizeUpdateWorkspaceProposalInput,
  normalizeWorkspaceGraphMutationInput,
  normalizeWorkspaceLayoutPatch,
  normalizeWorkspaceProposalApprovalMode,
  type CreateWorkspaceProposalInput,
  type UpdateWorkspaceProposalInput,
  type WorkspaceGraphMutationInput,
  type WorkspaceLayoutPatch,
  type WorkspaceProposalApprovalMode,
  type WorkspaceProposalRecord,
} from "../../../packages/core/src/index.ts";
import type { AppDeps } from "./app.ts";
import { HttpError, readJsonBody, sendJson } from "./http-util.ts";
import {
  ensureStandardProjectWorkspace,
  type EnsureStandardProjectWorkspaceResult,
} from "./workspace-migration.ts";

type ReadyWorkspace = Extract<EnsureStandardProjectWorkspaceResult, { status: "ready" }>;

function requireProject(deps: AppDeps, projectId: string): void {
  if (!deps.store.getProject(projectId)) throw new HttpError(404, "project not found");
}

function sendUnsupported(
  res: ServerResponse,
  result: Extract<EnsureStandardProjectWorkspaceResult, { status: "unsupported" }>,
): void {
  sendJson(res, 409, {
    error: "Workspace APIs require a Standard project",
    ...result,
  });
}

async function getWorkspaceResult(
  res: ServerResponse,
  deps: AppDeps,
  projectId: string,
): Promise<EnsureStandardProjectWorkspaceResult | null> {
  requireProject(deps, projectId);
  try {
    return await ensureStandardProjectWorkspace(deps, projectId);
  } catch (error) {
    // The initial existence check precedes asynchronous Git verification. If a
    // concurrent Project deletion wins that race, preserve the public 404
    // contract instead of exposing the Store's internal not-found exception.
    if (!deps.store.getProject(projectId)) throw new HttpError(404, "project not found");
    if (error instanceof LegacyWorkspaceSeedDriftError) {
      sendJson(res, 409, {
        error: error.message,
        code: "legacy_workspace_seed_drift",
        projectId: error.projectId,
      });
      return null;
    }
    throw error;
  }
}

async function requireReadyWorkspace(
  res: ServerResponse,
  deps: AppDeps,
  projectId: string,
): Promise<ReadyWorkspace | null> {
  const result = await getWorkspaceResult(res, deps, projectId);
  if (result === null) return null;
  if (result.status === "unsupported") {
    sendUnsupported(res, result);
    return null;
  }
  return result;
}

function invalidRequest(error: unknown): never {
  if (error instanceof WorkspaceStoreCodecError || error instanceof WorkspaceGraphValidationError) {
    throw new HttpError(400, error.message);
  }
  throw error;
}

async function parseGraphCommandBody(req: IncomingMessage): Promise<WorkspaceGraphMutationInput> {
  const body = await readJsonBody(req);
  try {
    return normalizeWorkspaceGraphMutationInput(body);
  } catch (error) {
    return invalidRequest(error);
  }
}

async function parseWorkspaceLayoutBody(
  req: IncomingMessage,
): Promise<WorkspaceLayoutPatch & { layoutId: string }> {
  const body = await readJsonBody(req);
  try {
    return normalizeWorkspaceLayoutPatch(body);
  } catch (error) {
    return invalidRequest(error);
  }
}

async function parseCreateProposalBody(
  req: IncomingMessage,
  projectId: string,
): Promise<CreateWorkspaceProposalInput> {
  const body = await readJsonBody(req);
  if (
    typeof body === "object"
    && body !== null
    && !Array.isArray(body)
    && (Object.hasOwn(body, "projectId") || Object.hasOwn(body, "workspaceId"))
  ) {
    throw new HttpError(400, "Proposal ownership is determined by the request path");
  }
  try {
    return normalizeCreateWorkspaceProposalInput({
      ...(typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}),
      projectId,
    });
  } catch (error) {
    return invalidRequest(error);
  }
}

function requestRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedRequestFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedFields = new Set(allowed);
  const unexpected = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unexpected) throw new HttpError(400, `${label} contains unexpected field: ${unexpected}`);
}

async function parseUpdateProposalBody(req: IncomingMessage): Promise<UpdateWorkspaceProposalInput> {
  const body = await readJsonBody(req);
  try {
    return normalizeUpdateWorkspaceProposalInput(body);
  } catch (error) {
    return invalidRequest(error);
  }
}

async function parseApproveProposalBody(req: IncomingMessage): Promise<WorkspaceProposalApprovalMode> {
  const body = requestRecord(await readJsonBody(req), "Proposal approval body");
  rejectUnexpectedRequestFields(body, ["mode"], "Proposal approval body");
  try {
    return normalizeWorkspaceProposalApprovalMode(body.mode);
  } catch (error) {
    return invalidRequest(error);
  }
}

async function parseRejectProposalBody(req: IncomingMessage): Promise<void> {
  const body = requestRecord(await readJsonBody(req), "Proposal rejection body");
  rejectUnexpectedRequestFields(body, [], "Proposal rejection body");
}

function proposalNotFound(error: unknown): never {
  if (error instanceof WorkspaceProposalNotFoundError || error instanceof WorkspaceProposalOwnershipError) {
    throw new HttpError(404, "proposal not found");
  }
  throw error;
}

interface ProposalErrorContext {
  revalidateDurableState: () => void;
  loadProposal?: () => WorkspaceProposalRecord;
}

function sendProposalError(
  res: ServerResponse,
  error: unknown,
  context: ProposalErrorContext,
): boolean {
  if (error instanceof WorkspaceProposalNotFoundError || error instanceof WorkspaceProposalOwnershipError) {
    sendJson(res, 404, { error: "proposal not found" });
    return true;
  }
  if (error instanceof WorkspaceProposalConflictError) {
    context.revalidateDurableState();
    const proposal = context.loadProposal?.();
    if (!proposal) throw new Error("conflicted Proposal could not be reloaded");
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_revision_conflict",
      expectedGraphRevision: error.summary.expectedGraphRevision,
      actualGraphRevision: error.summary.actualGraphRevision,
      expectedSnapshotId: error.summary.expectedSnapshotId,
      actualSnapshotId: error.summary.actualSnapshotId,
      expectedLayoutChecksum: error.summary.expectedLayoutChecksum,
      actualLayoutChecksum: error.summary.actualLayoutChecksum,
      graphChanged: error.summary.graphChanged,
      snapshotChanged: error.summary.snapshotChanged,
      layoutChanged: error.summary.layoutChanged,
      proposal,
      summary: error.summary,
    });
    return true;
  }
  if (error instanceof WorkspaceProposalRevisionConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_proposal_revision_conflict",
      proposalId: error.proposalId,
      expectedProposalRevision: error.expectedProposalRevision,
      actualProposalRevision: error.actualProposalRevision,
    });
    return true;
  }
  if (error instanceof WorkspaceProposalStateConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_proposal_state_conflict",
      proposalId: error.proposalId,
      status: error.status,
    });
    return true;
  }
  if (error instanceof WorkspaceLayoutConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_layout_conflict",
      expectedGraphRevision: error.expectedRevision,
      actualGraphRevision: error.actualRevision,
      expectedLayoutChecksum: error.expectedLayoutChecksum,
      actualLayoutChecksum: error.actualLayoutChecksum,
    });
    return true;
  }
  if (error instanceof WorkspaceRevisionConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_revision_conflict",
      expectedGraphRevision: error.expectedRevision,
      actualGraphRevision: error.actualRevision,
      ...(error.expectedSnapshotId === undefined
        ? {}
        : { expectedSnapshotId: error.expectedSnapshotId, actualSnapshotId: error.actualSnapshotId }),
    });
    return true;
  }
  if (error instanceof WorkspaceProposalValidationError || error instanceof WorkspaceGraphValidationError) {
    context.revalidateDurableState();
    sendJson(res, 422, {
      error: error.message,
      code: "workspace_proposal_validation_error",
      details: {},
    });
    return true;
  }
  return false;
}

function revalidateProposalDurableState(
  deps: AppDeps,
  projectId: string,
  proposalId?: string,
  layoutId = "default",
): void {
  deps.store.workspace.assertProposalDurableIntegrityForProject(projectId, proposalId);
  const proposal = proposalId === undefined
    ? undefined
    : deps.store.workspace.getProposalForProject(projectId, proposalId);
  deps.store.workspace.getLayout(projectId, proposal?.layoutId ?? layoutId);
}

function sendMutationError(
  res: ServerResponse,
  error: unknown,
  revalidateDurableState: () => void,
): boolean {
  if (error instanceof WorkspaceCommandReplayConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_command_replay_conflict",
      commandIds: error.commandIds,
    });
    return true;
  }
  if (error instanceof WorkspaceLayoutConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_layout_conflict",
      expectedGraphRevision: error.expectedRevision,
      actualGraphRevision: error.actualRevision,
      expectedLayoutChecksum: error.expectedLayoutChecksum,
      actualLayoutChecksum: error.actualLayoutChecksum,
    });
    return true;
  }
  if (error instanceof WorkspaceRevisionConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_revision_conflict",
      expectedGraphRevision: error.expectedRevision,
      actualGraphRevision: error.actualRevision,
      ...(error.expectedSnapshotId === undefined
        ? {}
        : { expectedSnapshotId: error.expectedSnapshotId, actualSnapshotId: error.actualSnapshotId }),
    });
    return true;
  }
  if (error instanceof WorkspacePointerConflictError) {
    sendJson(res, 409, {
      error: error.message,
      code: "workspace_pointer_conflict",
      pointer: error.pointer,
      ownerId: error.ownerId,
      expectedId: error.expectedId,
      actualId: error.actualId,
    });
    return true;
  }
  if (error instanceof WorkspaceStoreCodecError || error instanceof WorkspaceGraphValidationError) {
    // A validation-shaped error can also come from stored state that changed
    // after the ready read. Re-read outside the client-error classification so
    // durable corruption remains a 500 instead of being laundered into a 400.
    revalidateDurableState();
    sendJson(res, 400, { error: error.message, code: "workspace_validation_error" });
    return true;
  }
  return false;
}

function requireArtifact(ready: ReadyWorkspace, artifactId: string): ReadyWorkspace["artifacts"][number] {
  const artifact = ready.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact || artifact.workspaceId !== ready.workspace.id) throw new HttpError(404, "artifact not found");
  return artifact;
}

export async function handleGetWorkspace(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const result = await getWorkspaceResult(res, deps, projectId);
  if (result === null) return;
  if (result.status === "unsupported") {
    sendJson(res, 200, result);
    return;
  }
  sendJson(res, 200, {
    ...result,
    layout: deps.store.workspace.getLayout(projectId),
  });
}

export async function handleGraphCommands(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const input = await parseGraphCommandBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    sendJson(res, 200, deps.store.workspace.applyGraphCommands(projectId, input));
  } catch (error) {
    if (!sendMutationError(res, error, () => {
      if (!deps.store.workspace.getBundleByProjectId(projectId)) {
        throw new Error(`workspace not found for project: ${projectId}`);
      }
    })) throw error;
  }
}

export async function handlePutWorkspaceLayout(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const input = await parseWorkspaceLayoutBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  // Validate durable layout state outside the client-error catch. Corrupt stored
  // groups are a server failure, while invalid commands below remain a 400.
  deps.store.workspace.getLayout(projectId, input.layoutId);
  try {
    sendJson(res, 200, deps.store.workspace.saveLayout(projectId, input));
  } catch (error) {
    if (!sendMutationError(res, error, () => {
      if (!deps.store.workspace.getBundleByProjectId(projectId)) {
        throw new Error(`workspace not found for project: ${projectId}`);
      }
      deps.store.workspace.getLayout(projectId, input.layoutId);
    })) throw error;
  }
}

export async function handleListProposals(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  sendJson(res, 200, deps.store.workspace.listProposals(projectId));
}

export async function handleCreateProposal(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const input = await parseCreateProposalBody(req, projectId);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    sendJson(res, 201, deps.store.workspace.createProposal(input));
  } catch (error) {
    if (!sendProposalError(res, error, {
      revalidateDurableState: () => revalidateProposalDurableState(deps, projectId, undefined, input.layoutId),
    })) throw error;
  }
}

export async function handleGetProposal(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    sendJson(res, 200, deps.store.workspace.getProposalForProject(projectId, params.proposalId!));
  } catch (error) {
    proposalNotFound(error);
  }
}

export async function handleUpdateProposal(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const input = await parseUpdateProposalBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  const proposalId = params.proposalId!;
  try {
    sendJson(res, 200, deps.store.workspace.updateProposalForProject(projectId, proposalId, input));
  } catch (error) {
    if (!sendProposalError(res, error, {
      revalidateDurableState: () => revalidateProposalDurableState(deps, projectId, proposalId),
      loadProposal: () => deps.store.workspace.getProposalForProject(projectId, proposalId),
    })) throw error;
  }
}

export async function handleApproveProposal(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const mode = await parseApproveProposalBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  const proposalId = params.proposalId!;
  try {
    const { proposal, graph, snapshot, layout, plan } = deps.store.workspace.approveProposalForProject(
      projectId,
      proposalId,
      mode,
    );
    sendJson(res, 200, { proposal, graph, snapshot, layout, plan });
  } catch (error) {
    if (!sendProposalError(res, error, {
      revalidateDurableState: () => revalidateProposalDurableState(deps, projectId, proposalId),
      loadProposal: () => deps.store.workspace.getProposalForProject(projectId, proposalId),
    })) throw error;
  }
}

export async function handleRejectProposal(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  await parseRejectProposalBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  const proposalId = params.proposalId!;
  try {
    sendJson(res, 200, deps.store.workspace.rejectProposalForProject(projectId, proposalId));
  } catch (error) {
    if (!sendProposalError(res, error, {
      revalidateDurableState: () => revalidateProposalDurableState(deps, projectId, proposalId),
      loadProposal: () => deps.store.workspace.getProposalForProject(projectId, proposalId),
    })) throw error;
  }
}

export async function handleListWorkspaceArtifacts(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (ready) sendJson(res, 200, ready.artifacts);
}

export async function handleGetWorkspaceArtifact(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (!ready) return;
  sendJson(res, 200, requireArtifact(ready, params.artifactId!));
}

export async function handleListArtifactTracks(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (!ready) return;
  const artifact = requireArtifact(ready, params.artifactId!);
  sendJson(res, 200, ready.tracks.filter((track) => track.artifactId === artifact.id));
}

export async function handleListArtifactRevisions(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (!ready) return;
  const artifact = requireArtifact(ready, params.artifactId!);
  sendJson(res, 200, ready.revisions.filter((revision) => revision.artifactId === artifact.id));
}

export async function handleGetArtifactRevision(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (!ready) return;
  const artifact = requireArtifact(ready, params.artifactId!);
  const revision = ready.revisions.find(
    (candidate) => candidate.id === params.revisionId && candidate.artifactId === artifact.id,
  );
  if (!revision || revision.workspaceId !== ready.workspace.id) throw new HttpError(404, "revision not found");
  sendJson(res, 200, revision);
}

export async function handleListWorkspaceSnapshots(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (ready) sendJson(res, 200, ready.snapshots);
}

export async function handleGetWorkspaceSnapshot(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (!ready) return;
  const snapshot = ready.snapshots.find((candidate) => candidate.id === params.snapshotId);
  if (!snapshot || snapshot.workspaceId !== ready.workspace.id) throw new HttpError(404, "snapshot not found");
  sendJson(res, 200, snapshot);
}
