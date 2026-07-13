import type { IncomingMessage, ServerResponse } from "node:http";
import {
  LegacyWorkspaceSeedDriftError,
  WorkspaceCommandReplayConflictError,
  WorkspaceGraphValidationError,
  WorkspacePointerConflictError,
  WorkspaceRevisionConflictError,
  WorkspaceStoreCodecError,
  normalizeWorkspaceGraphMutationInput,
  normalizeWorkspaceLayoutPatch,
  type WorkspaceGraphMutationInput,
  type WorkspaceLayoutPatch,
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
