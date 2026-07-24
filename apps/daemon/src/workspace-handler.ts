import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GenerationPlanCompileError,
  LegacyWorkspaceSeedDriftError,
  WorkspaceCommandReplayConflictError,
  WorkspaceGraphValidationError,
  WorkspaceLayoutConflictError,
  WorkspacePointerConflictError,
  WorkspaceResourceNotFoundError,
  WorkspaceResourceOwnershipError,
  WorkspaceProposalConflictError,
  WorkspaceProposalNotFoundError,
  WorkspaceProposalOwnershipError,
  WorkspaceProposalRevisionConflictError,
  WorkspaceProposalStateConflictError,
  WorkspaceProposalValidationError,
  ScopedAgentTurnConflictError,
  ScopedAgentTurnDerivedInputConflictError,
  WorkspaceAgentTurnConflictError,
  ResearchDirectionArtifactIntentConflictError,
  WorkspaceRevisionConflictError,
  WorkspaceStoreCodecError,
  normalizeCreateWorkspaceProposalInput,
  normalizeCreateResourceForProjectInput,
  normalizeForkArtifactTrackInput,
  normalizeResourcePublicationExpectation,
  normalizeRestoreArtifactRevisionInput,
  normalizeUpdateResourceForProjectInput,
  normalizeUpdateWorkspaceProposalInput,
  normalizeWorkspaceGraphMutationInput,
  normalizeWorkspaceLayoutPatch,
  normalizeWorkspaceProposalApprovalMode,
  type CreateWorkspaceProposalInput,
  type CreateResearchDirectionArtifactIntentInput,
  type CreateResourceForProjectInput,
  type ForkArtifactTrackInput,
  type Resource,
  type ResearchDirectionArtifactIntentRequestFacts,
  type ResourcePublicationExpectation,
  type RestoreArtifactRevisionInput,
  type UpdateResourceForProjectInput,
  type UpdateWorkspaceProposalInput,
  type WorkspaceGraphMutationInput,
  type WorkspaceLayoutPatch,
  type WorkspaceProposalApprovalMode,
  type WorkspaceProposalRecord,
} from "../../../packages/core/src/index.ts";
import type { AppDeps } from "./app.ts";
import { HttpError, readJsonBody, sendJson } from "./http-util.ts";
import {
  ResourceRevisionSourceInputError,
  normalizeCreateResourceRevisionRequest,
  snapshotOwnedResourceRevisionSource,
} from "./resource-revision-source.ts";
import {
  BlockedContextError,
  ContextIntegrityError,
  normalizeAgentExecutionSelection,
  normalizeAgentTurnId,
  normalizeAgentTurnRequest,
  normalizeScopedAgentTurnId,
  type AgentTurnRequest,
} from "./context/context-types.ts";
import { removeSealedResourceRevisionPayload } from "./context/adapters/file.ts";
import {
  ensureStandardProjectWorkspace,
  type EnsureStandardProjectWorkspaceResult,
} from "./workspace-migration.ts";
import { wakeGenerationPlan } from "./orchestration/generation-plan-control.ts";
import {
  ProductionAgentOrchestratorError,
  type ProductionAgentTurnResult,
  type ProductionScopedAgentTurnResult,
  type ProductionWorkspaceAgentTurnResult,
} from "./orchestration/production-agent-orchestrator.ts";
import { ProductionWorkspacePlannerError } from "./orchestration/production-workspace-agent.ts";
import {
  readResearchResourceRevision,
  ResearchResourceRevisionError,
} from "./research-resource-revision.ts";

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
    return await ensureStandardProjectWorkspace(deps, projectId, { readMode: "compact" });
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

async function parseWorkspaceAgentTurnBody(
  req: IncomingMessage,
  ready: ReadyWorkspace,
): Promise<AgentTurnRequest> {
  const body = requestRecord(await readJsonBody(req), "Workspace Agent turn body");
  rejectUnexpectedRequestFields(
    body,
    ["turnId", "agentCommand", "model", "message", "explicitContext", "graphRevision", "selection"],
    "Workspace Agent turn body",
  );
  if (typeof body.message !== "string" || body.message.trim().length === 0
    || Buffer.byteLength(body.message, "utf8") > 64 * 1024) {
    throw new HttpError(400, "Workspace Agent message must be non-empty and at most 64 KiB");
  }
  try {
    return normalizeAgentTurnRequest({
      scope: {
        type: "workspace",
        id: ready.workspace.id,
        workspaceId: ready.workspace.id,
      },
      intent: "plan",
      agent: normalizeAgentExecutionSelection({
        providerId: body.agentCommand,
        command: body.agentCommand,
        model: body.model ?? null,
      }),
      turnId: normalizeAgentTurnId(body.turnId),
      message: body.message.trim(),
      explicitContext: body.explicitContext,
      graphRevision: body.graphRevision,
      ...(body.selection === undefined ? {} : { selection: body.selection }),
    });
  } catch (error) {
    if (error instanceof ContextIntegrityError) throw new HttpError(400, error.message);
    throw error;
  }
}

function exactWorkspaceAgentHttpReceipt(
  result: ProductionAgentTurnResult,
  ready: ReadyWorkspace,
  request: AgentTurnRequest,
): ProductionWorkspaceAgentTurnResult {
  if (result.kind !== "proposal"
    || result.proposal.workspaceId !== ready.workspace.id
    || result.proposal.kind !== "workspace-generation"
    || result.proposal.generation?.kind !== "workspace-generation"
    || result.proposal.baseGraphRevision !== request.graphRevision) {
    throw new ProductionAgentOrchestratorError(
      "Workspace Agent returned a cross-Workspace or incorrectly anchored Proposal",
    );
  }
  return result;
}

type ScopedAgentType = "artifact" | "resource";
const SCOPED_CONTEXT_PACK_ID = /^context-pack-[0-9a-f]{64}$/;

function exactScopedAgentHttpReceipt(
  result: ProductionAgentTurnResult,
  ready: ReadyWorkspace,
  scopeType: ScopedAgentType,
  targetId: string,
): ProductionScopedAgentTurnResult {
  if (result.kind !== "task" || result.task.workspaceId !== ready.workspace.id
    || result.task.target.type !== scopeType || result.task.target.id !== targetId
    || result.task.target.workspaceId !== ready.workspace.id
    || typeof result.contextPackId !== "string" || !SCOPED_CONTEXT_PACK_ID.test(result.contextPackId)) {
    throw new ProductionAgentOrchestratorError(
      "Scoped Agent returned a cross-target Task or invalid Context Pack receipt",
    );
  }
  return result;
}

async function parseScopedAgentTurnBody(
  req: IncomingMessage,
  ready: ReadyWorkspace,
  scopeType: ScopedAgentType,
  targetId: string,
): Promise<AgentTurnRequest> {
  const label = `${scopeType === "artifact" ? "Artifact" : "Resource"} Agent turn body`;
  const body = requestRecord(await readJsonBody(req), label);
  rejectUnexpectedRequestFields(
    body,
    [
      "turnId", "intent", "agentCommand", "model", "message", "explicitContext",
      "graphRevision", "baseRevisionId", "selection",
    ],
    label,
  );
  if (body.intent !== "generate" && body.intent !== "edit" && body.intent !== "repair") {
    throw new HttpError(400, `${label} intent must be generate, edit, or repair`);
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0
    || Buffer.byteLength(body.message, "utf8") > 64 * 1024) {
    throw new HttpError(400, `${label} message must be non-empty and at most 64 KiB`);
  }
  if (typeof body.baseRevisionId !== "string" || body.baseRevisionId.trim().length === 0) {
    throw new HttpError(400, `${label} requires baseRevisionId`);
  }
  try {
    return normalizeAgentTurnRequest({
      scope: {
        type: scopeType,
        id: targetId,
        workspaceId: ready.workspace.id,
      },
      intent: body.intent,
      agent: normalizeAgentExecutionSelection({
        providerId: body.agentCommand,
        command: body.agentCommand,
        model: body.model ?? null,
      }),
      turnId: normalizeScopedAgentTurnId(body.turnId),
      message: body.message.trim(),
      explicitContext: body.explicitContext,
      graphRevision: body.graphRevision,
      baseRevisionId: body.baseRevisionId,
      ...(body.selection === undefined ? {} : { selection: body.selection }),
    });
  } catch (error) {
    if (error instanceof ContextIntegrityError) throw new HttpError(400, error.message);
    throw error;
  }
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

async function parseCreateResourceBody(req: IncomingMessage): Promise<CreateResourceForProjectInput> {
  try {
    return normalizeCreateResourceForProjectInput(await readJsonBody(req));
  } catch (error) {
    return invalidRequest(error);
  }
}

async function parseMaterializeResourceBody(req: IncomingMessage): Promise<{
  resource: CreateResourceForProjectInput;
  source: ReturnType<typeof normalizeCreateResourceRevisionRequest>["source"];
  reason: string;
}> {
  const body = requestRecord(await readJsonBody(req), "Materialize Resource body");
  rejectUnexpectedRequestFields(body, [
    "kind", "title", "defaultPinPolicy", "baseGraphRevision", "expectedSnapshotId", "source", "reason",
  ], "Materialize Resource body");
  try {
    const resource = normalizeCreateResourceForProjectInput({
      kind: body.kind,
      title: body.title,
      defaultPinPolicy: body.defaultPinPolicy,
      baseGraphRevision: body.baseGraphRevision,
      expectedSnapshotId: body.expectedSnapshotId,
    });
    const { source } = normalizeCreateResourceRevisionRequest({
      expectedHeadRevisionId: null,
      source: body.source,
    });
    const publication = normalizeResourcePublicationExpectation({
      expectedHeadRevisionId: null,
      expectedSnapshotId: resource.expectedSnapshotId,
      reason: body.reason,
    });
    return { resource, source, reason: publication.reason };
  } catch (error) {
    if (error instanceof ResourceRevisionSourceInputError) throw new HttpError(400, error.message);
    return invalidRequest(error);
  }
}

async function parseCreateResourceRevisionBody(
  req: IncomingMessage,
): Promise<ReturnType<typeof normalizeCreateResourceRevisionRequest>> {
  try {
    return normalizeCreateResourceRevisionRequest(await readJsonBody(req));
  } catch (error) {
    if (error instanceof ResourceRevisionSourceInputError) throw new HttpError(400, error.message);
    throw error;
  }
}

async function parseUpdateResourceBody(req: IncomingMessage): Promise<UpdateResourceForProjectInput> {
  try {
    return normalizeUpdateResourceForProjectInput(await readJsonBody(req));
  } catch (error) {
    return invalidRequest(error);
  }
}

async function parsePublishResourceBody(req: IncomingMessage): Promise<ResourcePublicationExpectation> {
  try {
    return normalizeResourcePublicationExpectation(await readJsonBody(req));
  } catch (error) {
    return invalidRequest(error);
  }
}

async function parseResearchDirectionArtifactIntentBody(
  req: IncomingMessage,
): Promise<CreateResearchDirectionArtifactIntentInput> {
  const body = requestRecord(await readJsonBody(req), "Research direction selection body");
  rejectUnexpectedRequestFields(body, [
    "selectionRequestId",
    "artifactId",
    "agentCommand",
    "model",
    "expectedResourceHeadRevisionId",
    "expectedGraphRevision",
    "expectedSnapshotId",
    "expectedLayoutChecksum",
    "confirmHypothesis",
  ], "Research direction selection body");
  if (typeof body.selectionRequestId !== "string"
    || !/^selection-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.selectionRequestId)
    || typeof body.artifactId !== "string" || body.artifactId.trim() !== body.artifactId || body.artifactId.length === 0
    || typeof body.expectedResourceHeadRevisionId !== "string"
    || body.expectedResourceHeadRevisionId.trim() !== body.expectedResourceHeadRevisionId
    || body.expectedResourceHeadRevisionId.length === 0
    || !Number.isSafeInteger(body.expectedGraphRevision) || Number(body.expectedGraphRevision) < 0
    || typeof body.expectedSnapshotId !== "string" || body.expectedSnapshotId.length === 0
    || typeof body.expectedLayoutChecksum !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedLayoutChecksum)
    || typeof body.confirmHypothesis !== "boolean") {
    throw new HttpError(400, "Research direction selection body is invalid");
  }
  try {
    const agent = normalizeAgentExecutionSelection({
      providerId: body.agentCommand,
      command: body.agentCommand,
      model: body.model ?? null,
    });
    return {
      selectionRequestId: body.selectionRequestId,
      artifactId: body.artifactId,
      agent,
      expectedResourceHeadRevisionId: body.expectedResourceHeadRevisionId,
      expectedGraphRevision: Number(body.expectedGraphRevision),
      expectedSnapshotId: body.expectedSnapshotId,
      expectedLayoutChecksum: body.expectedLayoutChecksum,
      confirmHypothesis: body.confirmHypothesis,
    };
  } catch (error) {
    if (error instanceof ContextIntegrityError) throw new HttpError(400, error.message);
    throw error;
  }
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

function resourceNotFound(error: unknown): never {
  if (error instanceof WorkspaceResourceNotFoundError || error instanceof WorkspaceResourceOwnershipError) {
    throw new HttpError(404, "resource not found");
  }
  throw error;
}

function requireOwnedResource(deps: AppDeps, projectId: string, resourceId: string): Resource {
  try {
    const resource = deps.store.workspace.getResourceForProject(projectId, resourceId);
    if (!resource) throw new WorkspaceResourceNotFoundError(resourceId);
    return resource;
  } catch (error) {
    resourceNotFound(error);
  }
}

function sendResourceMutationError(
  res: ServerResponse,
  error: unknown,
  deps: AppDeps,
  projectId: string,
  resourceId?: string,
  revisionId?: string,
): boolean {
  if (error instanceof WorkspaceResourceNotFoundError || error instanceof WorkspaceResourceOwnershipError) {
    sendJson(res, 404, { error: "resource not found" });
    return true;
  }
  return sendMutationError(res, error, () => {
    deps.store.workspace.getGraph(projectId);
    if (!resourceId) return;
    const resource = deps.store.workspace.getResourceForProject(projectId, resourceId);
    if (!resource) throw new WorkspaceResourceNotFoundError(resourceId);
    if (revisionId) deps.store.workspace.getResourceRevisionForProject(projectId, resourceId, revisionId);
  });
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
  const overview = deps.store.workspace.getCompactOverviewByProjectId(projectId);
  if (overview === null) throw new HttpError(404, "project not found");
  sendJson(res, 200, {
    status: "ready",
    ...overview,
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
      if (!deps.store.workspace.getCompactBundleByProjectId(projectId)) {
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
      if (!deps.store.workspace.getCompactBundleByProjectId(projectId)) {
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

export async function handleWorkspaceAgentTurn(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal: AbortSignal,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  if (!deps.workspaceAgent) throw new HttpError(501, "Workspace Agent is not configured");
  const request = await parseWorkspaceAgentTurnBody(req, ready);
  try {
    // A committed Workspace turn owns its historical graph anchor. Replay it
    // before the current graph fence so response loss remains recoverable even
    // after review or later canvas changes.
    const replay = await deps.workspaceAgent.replayWorkspace?.(request, signal) ?? null;
    if (replay !== null) {
      sendJson(res, 201, exactWorkspaceAgentHttpReceipt(replay, ready, request).proposal);
      return;
    }
    if (request.graphRevision !== ready.graph.revision) {
      sendJson(res, 409, {
        error: `Workspace changed from graph Revision ${request.graphRevision} to ${ready.graph.revision}`,
        code: "workspace_revision_conflict",
        expectedGraphRevision: request.graphRevision,
        actualGraphRevision: ready.graph.revision,
      });
      return;
    }
    const result = exactWorkspaceAgentHttpReceipt(
      await deps.workspaceAgent.turn(request, signal),
      ready,
      request,
    );
    sendJson(res, 201, result.proposal);
  } catch (error) {
    if (error instanceof WorkspaceAgentTurnConflictError) {
      sendJson(res, 409, {
        error: error.message,
        code: "workspace_agent_turn_conflict",
        turnId: error.turnId,
      });
      return;
    }
    if (error instanceof ContextIntegrityError || error instanceof BlockedContextError) {
      sendJson(res, 422, {
        error: error.message,
        code: "workspace_agent_context_blocked",
        missing: error.missing,
      });
      return;
    }
    if (error instanceof ProductionWorkspacePlannerError) {
      sendJson(res, 502, {
        error: error.message,
        code: "workspace_agent_planner_failed",
      });
      return;
    }
    if (error instanceof ProductionAgentOrchestratorError) throw error;
    if (!sendProposalError(res, error, {
      revalidateDurableState: () => revalidateProposalDurableState(deps, projectId),
    })) throw error;
  }
}

export async function handleScopedAgentTurn(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
  signal: AbortSignal,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  if (!deps.workspaceAgent) throw new HttpError(501, "Scoped Agent is not configured");
  const scopeType: ScopedAgentType = params.artifactId === undefined ? "resource" : "artifact";
  const targetId = scopeType === "artifact" ? params.artifactId! : params.resourceId!;
  if (scopeType === "artifact") requireArtifact(ready, targetId);
  else requireOwnedResource(deps, projectId, targetId);
  const request = await parseScopedAgentTurnBody(req, ready, scopeType, targetId);
  try {
    // A committed turn owns its immutable historical graph/Head facts. Replay
    // it before current-state fences so a lost 202 remains recoverable after
    // the original Plan has advanced either pointer.
    const replay = await deps.workspaceAgent.replayScoped?.(request, signal) ?? null;
    if (replay !== null) {
      const receipt = exactScopedAgentHttpReceipt(replay, ready, scopeType, targetId);
      sendJson(res, 202, { task: receipt.task, contextPackId: receipt.contextPackId });
      return;
    }
    if (request.graphRevision !== ready.graph.revision) {
      sendJson(res, 409, {
        error: `Workspace changed from graph Revision ${request.graphRevision} to ${ready.graph.revision}`,
        code: "workspace_revision_conflict",
        expectedGraphRevision: request.graphRevision,
        actualGraphRevision: ready.graph.revision,
      });
      return;
    }
    const activeRevisionId = scopeType === "artifact"
      ? ready.activeSnapshot.artifactRevisions[targetId] ?? null
      : ready.activeSnapshot.resourceRevisions[targetId] ?? null;
    if (request.baseRevisionId !== activeRevisionId) {
      sendJson(res, 409, {
        error: `${scopeType === "artifact" ? "Artifact" : "Resource"} Head changed before the Agent Task could be queued`,
        code: "workspace_pointer_conflict",
        pointer: scopeType === "artifact" ? "artifact-head" : "resource-head",
        ownerId: targetId,
        expectedId: request.baseRevisionId,
        actualId: activeRevisionId,
      });
      return;
    }
    const result = exactScopedAgentHttpReceipt(
      await deps.workspaceAgent.turn(request, signal),
      ready,
      scopeType,
      targetId,
    );
    sendJson(res, 202, { task: result.task, contextPackId: result.contextPackId });
  } catch (error) {
    if (error instanceof ScopedAgentTurnConflictError
      || error instanceof ScopedAgentTurnDerivedInputConflictError) {
      sendJson(res, 409, {
        error: error.message,
        code: "scoped_agent_turn_conflict",
        scopeType,
        targetId,
        turnId: error.turnId,
      });
      return;
    }
    if (error instanceof ContextIntegrityError || error instanceof BlockedContextError) {
      sendJson(res, 422, {
        error: error.message,
        code: "scoped_agent_context_blocked",
        scopeType,
        targetId,
        missing: error.missing,
      });
      return;
    }
    if (error instanceof ProductionAgentOrchestratorError) throw error;
    throw error;
  }
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
    if (plan === null) {
      sendJson(res, 200, { proposal, graph, snapshot, layout, plan });
      return;
    }
    try {
      const compiled = deps.store.workspace.compileApprovedGenerationPlanForProject(projectId, plan.id);
      wakeGenerationPlan(deps.generationPlanEvents, deps.generationPlanRuntime, plan.id);
      sendJson(res, 200, { proposal, graph, snapshot, layout, plan: compiled.plan });
    } catch (error) {
      wakeGenerationPlan(deps.generationPlanEvents, deps.generationPlanRuntime, plan.id);
      if (error instanceof GenerationPlanCompileError) {
        const failedPlan = deps.store.workspace.getGenerationPlanForProject(projectId, plan.id);
        sendJson(res, 422, {
          error: error.message,
          code: "generation_plan_compile_failed",
          planId: plan.id,
          compileCode: error.code,
          details: error.details,
          proposal,
          graph,
          snapshot,
          layout,
          plan: failedPlan,
        });
        return;
      }
      throw error;
    }
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

export async function handleListResources(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  sendJson(res, 200, deps.store.workspace.listResources(projectId));
}

export async function handleCreateResource(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const input = await parseCreateResourceBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    sendJson(res, 201, deps.store.workspace.createResourceForProject(projectId, input));
  } catch (error) {
    if (!sendResourceMutationError(res, error, deps, projectId)) throw error;
  }
}

export async function handleMaterializeResource(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const input = await parseMaterializeResourceBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  if (ready.graph.revision !== input.resource.baseGraphRevision
    || ready.activeSnapshot.id !== input.resource.expectedSnapshotId) {
    sendJson(res, 409, {
      error: "Workspace changed before the Resource source could be snapshotted",
      code: "workspace_revision_conflict",
      expectedGraphRevision: input.resource.baseGraphRevision,
      actualGraphRevision: ready.graph.revision,
      expectedSnapshotId: input.resource.expectedSnapshotId,
      actualSnapshotId: ready.activeSnapshot.id,
    });
    return;
  }

  const resourceId = randomUUID();
  const revisionId = randomUUID();
  let frozen;
  try {
    frozen = await snapshotOwnedResourceRevisionSource({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId,
      workspaceId: ready.workspace.id,
      resource: { id: resourceId, workspaceId: ready.workspace.id, kind: input.resource.kind },
      revisionId,
      snapshotRoot: deps.dataDir,
      source: input.source,
      createdAt: Date.now(),
      fetchExternal: deps.resourceExternalFetch,
    });
  } catch (error) {
    if (error instanceof ResourceRevisionSourceInputError) throw new HttpError(400, error.message);
    if (error instanceof ContextIntegrityError || error instanceof TypeError) {
      sendJson(res, 422, { error: error.message, code: "resource_source_validation_error" });
      return;
    }
    throw error;
  }

  let result: ReturnType<typeof deps.store.workspace.createPublishedResourceForProject>;
  try {
    result = deps.store.workspace.createPublishedResourceForProject(projectId, {
      resourceId,
      nodeId: randomUUID(),
      commandId: randomUUID(),
      ...input.resource,
      revision: {
        revisionId,
        parentRevisionId: null,
        manifestPath: frozen.snapshot.manifestPath,
        summary: frozen.summary,
        metadata: { ...frozen.metadata },
        checksum: frozen.snapshot.checksum,
        provenance: { ...frozen.provenance },
      },
      reason: input.reason,
    });
  } catch (error) {
    let cleanupError: unknown;
    try {
      await removeSealedResourceRevisionPayload(deps.dataDir, frozen.snapshot);
    } catch (candidate) {
      cleanupError = candidate;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Resource materialization failed and its newly frozen payload could not be rolled back",
      );
    }
    if (!sendResourceMutationError(res, error, deps, projectId)) throw error;
    return;
  }
  sendJson(res, 201, result);
}

export async function handleGetResource(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    const resource = deps.store.workspace.getResourceForProject(projectId, params.resourceId!);
    if (!resource) throw new WorkspaceResourceNotFoundError(params.resourceId!);
    sendJson(res, 200, resource);
  } catch (error) {
    resourceNotFound(error);
  }
}

export async function handleUpdateResource(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const input = await parseUpdateResourceBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    const result = input.action === "rename"
      ? deps.store.workspace.updateResourceForProject(projectId, params.resourceId!, input)
      : input.action === "archive"
        ? deps.store.workspace.updateResourceForProject(projectId, params.resourceId!, input)
        : deps.store.workspace.updateResourceForProject(projectId, params.resourceId!, input);
    sendJson(res, 200, result);
  } catch (error) {
    if (!sendResourceMutationError(res, error, deps, projectId, params.resourceId!)) throw error;
  }
}

export async function handleListResourceRevisions(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    sendJson(res, 200, deps.store.workspace.listResourceRevisions(projectId, params.resourceId!));
  } catch (error) {
    resourceNotFound(error);
  }
}

export async function handleGetResearchResourceRevision(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    const view = await readResearchResourceRevision({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId,
      resourceId: params.resourceId!,
      revisionId: params.revisionId!,
      signal: AbortSignal.timeout(15_000),
    });
    sendJson(res, 200, view);
  } catch (error) {
    if (error instanceof ResearchResourceRevisionError) {
      sendJson(res, /missing|archived|foreign/i.test(error.message) ? 404 : 422, {
        error: error.message,
        code: "research_revision_unavailable",
      });
      return;
    }
    throw error;
  }
}

export async function handleCreateResearchDirectionArtifactIntent(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const input = await parseResearchDirectionArtifactIntentBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  const intentRequest: ResearchDirectionArtifactIntentRequestFacts = {
    workspaceId: ready.workspace.id,
    resourceId: params.resourceId!,
    revisionId: params.revisionId!,
    directionId: params.directionId!,
    artifactId: input.artifactId,
    agent: input.agent,
    resourceHeadRevisionId: input.expectedResourceHeadRevisionId,
    graphRevision: input.expectedGraphRevision,
    snapshotId: input.expectedSnapshotId,
    layoutChecksum: input.expectedLayoutChecksum,
    confirmHypothesis: input.confirmHypothesis === true,
  };
  try {
    const replay = deps.store.workspace.getResearchDirectionArtifactIntentReceiptForProject(
      projectId,
      input.selectionRequestId,
      intentRequest,
    );
    if (replay !== null) {
      sendJson(res, 200, replay);
      return;
    }
  } catch (error) {
    if (error instanceof ResearchDirectionArtifactIntentConflictError) {
      sendJson(res, 409, {
        error: error.message,
        code: "research_direction_intent_request_conflict",
        selectionRequestId: error.selectionRequestId,
      });
      return;
    }
    throw error;
  }
  let research;
  try {
    research = await readResearchResourceRevision({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId,
      resourceId: params.resourceId!,
      revisionId: params.revisionId!,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof ResearchResourceRevisionError) {
      sendJson(res, /missing|archived|foreign/i.test(error.message) ? 404 : 422, {
        error: error.message,
        code: "research_revision_unavailable",
      });
      return;
    }
    throw error;
  }
  const direction = research.directions.find((candidate) => candidate.id === params.directionId!);
  if (!direction) {
    sendJson(res, 404, { error: "Research direction not found", code: "research_direction_not_found" });
    return;
  }
  if (direction.evidenceStatus === "hypothesis" && input.confirmHypothesis !== true) {
    sendJson(res, 409, {
      error: "This direction contains unverified hypotheses and requires explicit confirmation",
      code: "research_hypothesis_confirmation_required",
      directionId: direction.id,
      hypothesisFindingIds: direction.hypothesisFindingIds,
    });
    return;
  }
  const artifact = ready.artifacts.find((candidate) => candidate.id === input.artifactId);
  const artifactNode = ready.graph.nodes.find((candidate) => candidate.kind !== "resource"
    && candidate.artifactId === input.artifactId);
  const resourceNode = ready.graph.nodes.find((candidate) => candidate.kind === "resource"
    && candidate.resourceId === research.resource.id);
  const trackId = ready.activeSnapshot.artifactTracks[input.artifactId] ?? null;
  if (!artifact || !artifactNode || !resourceNode || trackId === null || artifact.activeTrackId !== trackId
    || !Object.hasOwn(ready.activeSnapshot.artifactRevisions, artifact.id)) {
    sendJson(res, 404, { error: "Artifact target not found", code: "artifact_target_not_found" });
    return;
  }
  const baseRevisionId = ready.activeSnapshot.artifactRevisions[artifact.id] ?? null;
  const qualityProfile = structuredClone(ready.activeKernelRevision.qualityProfile);
  const frames = structuredClone(ready.activeKernelRevision.responsiveFrames);
  const capabilities = qualityProfile.requireVisualReview
    ? [{ id: "research-direction-visual-qa", kind: "visual-qa" as const, required: true }]
    : [];
  const layout = deps.store.workspace.getLayout(projectId);
  const hasInformsEdge = ready.graph.edges.some((edge) => edge.kind === "informs"
    && edge.sourceNodeId === resourceNode.id
    && edge.targetNodeId === artifactNode.id);
  const relationshipSuffix = input.selectionRequestId.slice("selection-".length);
  const proposalInput: CreateWorkspaceProposalInput = {
    projectId,
    kind: "workspace-generation",
    baseGraphRevision: input.expectedGraphRevision,
    baseSnapshotId: input.expectedSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: input.expectedLayoutChecksum,
    operations: hasInformsEdge ? [] : [{
      id: `command-research-informs-${relationshipSuffix}`,
      type: "add-edge",
      edge: {
        id: `edge-research-informs-${relationshipSuffix}`,
        workspaceId: ready.workspace.id,
        kind: "informs",
        sourceNodeId: resourceNode.id,
        targetNodeId: artifactNode.id,
      },
    }],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation",
      agent: input.agent,
      resourceOperations: [{
        operation: "reuse",
        nodeId: resourceNode.id,
        resourceId: research.resource.id,
        kind: "research",
        title: research.resource.title,
        revisionPolicy: { kind: "exact", resourceRevisionId: research.revision.id },
      }],
      artifactPlans: [{
        operation: baseRevisionId === null ? "create" : "revise",
        nodeId: artifactNode.id,
        artifactId: artifact.id,
        kind: artifact.kind,
        name: artifact.name,
        trackId,
        baseRevisionId,
        dependsOnArtifactIds: [],
        capabilityIds: capabilities.map((capability) => capability.id),
        responsiveFrameIds: frames.map((frame) => frame.id),
        researchDirectionSelection: {
          protocol: "dezin.research-direction-selection.v1",
          version: 1,
          resourceId: research.resource.id,
          revisionId: research.revision.id,
          directionId: direction.id,
        },
      }],
      dependencyPlans: [{
        kind: "resource",
        ownerArtifactId: artifact.id,
        resourceId: research.resource.id,
      }],
      prototypeIntents: [],
      capabilities,
      responsiveFrames: frames,
      qualityProfile,
    },
    rationale: `Use Research direction “${direction.title}” for ${artifact.name}.`,
    assumptions: [
      `Human-selected exact Research tuple: ${research.resource.id}@${research.revision.id}#${direction.id}.`,
      `Selection request: ${input.selectionRequestId}.`,
      direction.evidenceStatus === "hypothesis"
        ? "The user explicitly confirmed that this direction contains unverified hypotheses."
        : "The selected direction is grounded by verified evidence.",
    ],
    createdByRunId: null,
  };
  try {
    const result = deps.store.workspace.createApprovedResearchDirectionArtifactIntentForProject(
      projectId,
      input.selectionRequestId,
      intentRequest,
      proposalInput,
    );
    wakeGenerationPlan(deps.generationPlanEvents, deps.generationPlanRuntime, result.plan.id);
    sendJson(res, result.created ? 201 : 200, result);
  } catch (error) {
    if (error instanceof ResearchDirectionArtifactIntentConflictError) {
      sendJson(res, 409, {
        error: error.message,
        code: "research_direction_intent_request_conflict",
        selectionRequestId: error.selectionRequestId,
      });
      return;
    }
    if (error instanceof WorkspaceRevisionConflictError || error instanceof WorkspaceLayoutConflictError
      || error instanceof WorkspacePointerConflictError) {
      if (!sendMutationError(res, error, () => revalidateProposalDurableState(deps, projectId))) throw error;
      return;
    }
    if (error instanceof WorkspaceProposalValidationError || error instanceof WorkspaceGraphValidationError
      || error instanceof GenerationPlanCompileError) {
      deps.store.workspace.assertProposalDurableIntegrityForProject(projectId);
      sendJson(res, 422, {
        error: error.message,
        code: "research_direction_intent_invalid",
      });
      return;
    }
    throw error;
  }
}

export async function handleCreateResourceRevision(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const resourceId = params.resourceId!;
  requireProject(deps, projectId);
  const input = await parseCreateResourceRevisionBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;

  const resource = requireOwnedResource(deps, projectId, resourceId);
  if (resource.archivedAt !== null) {
    return sendJson(res, 409, { error: "archived Resources cannot accept new Revisions", code: "resource_archived" });
  }
  if (resource.headRevisionId !== input.expectedHeadRevisionId) {
    return sendJson(res, 409, {
      error: "Resource Head changed before its source could be snapshotted",
      code: "workspace_pointer_conflict",
      pointer: "resource-head",
      ownerId: resource.id,
      expectedId: input.expectedHeadRevisionId,
      actualId: resource.headRevisionId,
    });
  }

  let frozen;
  try {
    frozen = await snapshotOwnedResourceRevisionSource({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId,
      workspaceId: ready.workspace.id,
      resource,
      revisionId: randomUUID(),
      snapshotRoot: deps.dataDir,
      source: input.source,
      createdAt: Date.now(),
      fetchExternal: deps.resourceExternalFetch,
    });
  } catch (error) {
    if (error instanceof ResourceRevisionSourceInputError) throw new HttpError(400, error.message);
    if (error instanceof ContextIntegrityError || error instanceof TypeError) {
      return sendJson(res, 422, { error: error.message, code: "resource_source_validation_error" });
    }
    throw error;
  }

  let revision: ReturnType<typeof deps.store.workspace.createResourceRevisionCandidateForProject>;
  try {
    revision = deps.store.workspace.createResourceRevisionCandidateForProject(projectId, resource.id, {
      revisionId: frozen.snapshot.id,
      parentRevisionId: input.expectedHeadRevisionId,
      manifestPath: frozen.snapshot.manifestPath,
      summary: frozen.summary,
      metadata: { ...frozen.metadata },
      checksum: frozen.snapshot.checksum,
      provenance: { ...frozen.provenance },
    });
  } catch (error) {
    let rollbackError: unknown;
    try {
      await removeSealedResourceRevisionPayload(deps.dataDir, frozen.snapshot);
    } catch (cleanupError) {
      rollbackError = cleanupError;
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Resource Revision candidate failed and its newly frozen payload could not be rolled back",
      );
    }
    if (!sendResourceMutationError(res, error, deps, projectId, resource.id)) throw error;
    return;
  }
  sendJson(res, 201, revision);
}

export async function handlePublishResourceRevision(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  requireProject(deps, projectId);
  const expected = await parsePublishResourceBody(req);
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  try {
    sendJson(
      res,
      200,
      deps.store.workspace.publishResourceRevisionForProject(
        projectId,
        params.resourceId!,
        params.revisionId!,
        expected,
      ),
    );
  } catch (error) {
    if (!sendResourceMutationError(
      res,
      error,
      deps,
      projectId,
      params.resourceId!,
      params.revisionId!,
    )) throw error;
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
  sendJson(res, 200, deps.store.workspace.listTracks(params.id!, artifact.id));
}

function artifactRevisionHistoryCursor(value: string): { createdAt: number; id: string } {
  if (value.length === 0 || value.length > 2_048) throw new HttpError(400, "Artifact history cursor is invalid");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, "createdAt") || !Object.hasOwn(parsed, "id")) {
      throw new Error("shape");
    }
    const cursor = parsed as { createdAt?: unknown; id?: unknown };
    if (!Number.isSafeInteger(cursor.createdAt) || (cursor.createdAt as number) < 0
      || typeof cursor.id !== "string" || cursor.id.length === 0 || cursor.id !== cursor.id.trim()) {
      throw new Error("value");
    }
    const canonical = Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString("base64url");
    if (canonical !== value) throw new Error("canonical");
    return { createdAt: cursor.createdAt as number, id: cursor.id };
  } catch {
    throw new HttpError(400, "Artifact history cursor is invalid");
  }
}

export async function handleListArtifactRevisionHistory(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  const artifact = requireArtifact(ready, params.artifactId!);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "cursor") throw new HttpError(400, `unexpected Artifact history query: ${key}`);
    if (url.searchParams.getAll(key).length !== 1) throw new HttpError(400, `duplicate Artifact history query: ${key}`);
  }
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) {
    throw new HttpError(400, "Artifact history limit must be an integer from 1 to 50");
  }
  const rawCursor = url.searchParams.get("cursor");
  const page = deps.store.workspace.listArtifactRevisionHistoryPage(projectId, artifact.id, {
    limit: rawLimit === null ? 20 : Number(rawLimit),
    ...(rawCursor === null ? {} : { cursor: artifactRevisionHistoryCursor(rawCursor) }),
  });
  sendJson(res, 200, {
    items: page.items,
    nextCursor: page.nextCursor === null
      ? null
      : Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url"),
  });
}

async function parseArtifactVersionActionBody(
  req: IncomingMessage,
  sourceRevisionId: string,
  action: "restore",
): Promise<RestoreArtifactRevisionInput>;
async function parseArtifactVersionActionBody(
  req: IncomingMessage,
  sourceRevisionId: string,
  action: "fork-track",
): Promise<ForkArtifactTrackInput>;
async function parseArtifactVersionActionBody(
  req: IncomingMessage,
  sourceRevisionId: string,
  action: "restore" | "fork-track",
) {
  const body = requestRecord(await readJsonBody(req), `Artifact ${action} body`);
  rejectUnexpectedRequestFields(
    body,
    action === "restore"
      ? ["expectedHeadRevisionId", "expectedSnapshotId"]
      : ["name", "expectedHeadRevisionId", "expectedSnapshotId"],
    `Artifact ${action} body`,
  );
  try {
    return action === "restore"
      ? normalizeRestoreArtifactRevisionInput({ ...body, sourceRevisionId })
      : normalizeForkArtifactTrackInput({ ...body, sourceRevisionId });
  } catch (error) {
    return invalidRequest(error);
  }
}

export async function handleRestoreArtifactRevision(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  const artifact = requireArtifact(ready, params.artifactId!);
  const source = deps.store.workspace.getArtifactRevision(params.revisionId!);
  if (!source || source.workspaceId !== ready.workspace.id || source.artifactId !== artifact.id
    || !deps.store.workspace.isArtifactRevisionPublished(source.id)) {
    throw new HttpError(404, "revision not found");
  }
  const input = await parseArtifactVersionActionBody(req, source.id, "restore");
  try {
    sendJson(res, 201, deps.store.workspace.restoreArtifactRevisionForProject(projectId, artifact.id, input));
  } catch (error) {
    if (!sendMutationError(res, error, () => deps.store.workspace.getGraph(projectId))) throw error;
  }
}

export async function handleForkArtifactTrack(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  const ready = await requireReadyWorkspace(res, deps, projectId);
  if (!ready) return;
  const artifact = requireArtifact(ready, params.artifactId!);
  const source = deps.store.workspace.getArtifactRevision(params.revisionId!);
  if (!source || source.workspaceId !== ready.workspace.id || source.artifactId !== artifact.id
    || !deps.store.workspace.isArtifactRevisionPublished(source.id)) {
    throw new HttpError(404, "revision not found");
  }
  const input = await parseArtifactVersionActionBody(req, source.id, "fork-track");
  try {
    sendJson(res, 201, deps.store.workspace.forkArtifactTrackForProject(projectId, artifact.id, input));
  } catch (error) {
    if (!sendMutationError(res, error, () => deps.store.workspace.getGraph(projectId))) throw error;
  }
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
  sendJson(res, 200, deps.store.workspace.listPublishedRevisions(params.id!, artifact.id));
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
  const revision = deps.store.workspace.getArtifactRevision(params.revisionId!);
  if (!revision || revision.workspaceId !== ready.workspace.id) throw new HttpError(404, "revision not found");
  if (revision.artifactId !== artifact.id) throw new HttpError(404, "revision not found");
  if (!deps.store.workspace.isArtifactRevisionPublished(revision.id)) {
    throw new HttpError(404, "revision not found");
  }
  sendJson(res, 200, revision);
}

export async function handleListWorkspaceSnapshots(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (ready) sendJson(res, 200, deps.store.workspace.listSnapshots(params.id!));
}

export async function handleGetWorkspaceSnapshot(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const ready = await requireReadyWorkspace(res, deps, params.id!);
  if (!ready) return;
  const snapshot = deps.store.workspace.getSnapshotForProject(params.id!, params.snapshotId!);
  if (!snapshot || snapshot.workspaceId !== ready.workspace.id) throw new HttpError(404, "snapshot not found");
  sendJson(res, 200, snapshot);
}
