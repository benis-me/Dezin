import type { IncomingMessage, ServerResponse } from "node:http";
import { LegacyWorkspaceSeedDriftError } from "../../../packages/core/src/index.ts";
import type { AppDeps, DevServerLease } from "./app.ts";
import { HttpError, readJsonBody, sendJson } from "./http-util.ts";
import { requirePreviewLease, type PreviewLease } from "./preview-lease.ts";
import {
  acquirePreviewTargetLease,
  parsePreviewTarget,
  parseResolvedPreviewTarget,
  PreviewTargetConflictError,
  PreviewTargetNotFoundError,
  PreviewTargetValidationError,
  resolvePreviewTarget,
  type PreviewTargetLease,
} from "./preview-target.ts";
import { RenderAssemblyError } from "./render-assembly.ts";
import { ensureStandardProjectWorkspace } from "./workspace-migration.ts";

function requestRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewTargetValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function envelopeValue(body: unknown, field: "target" | "resolved"): unknown {
  const input = requestRecord(body, "Preview Target request body");
  const fields = Object.keys(input);
  if (fields.length !== 1 || fields[0] !== field) {
    const unexpected = fields.find((candidate) => candidate !== field);
    throw new PreviewTargetValidationError(
      unexpected
        ? `Preview Target request body contains unexpected field ${unexpected}`
        : `Preview Target request body requires ${field}`,
    );
  }
  return input[field];
}

async function requireReadyWorkspace(
  res: ServerResponse,
  deps: AppDeps,
  projectId: string,
): Promise<boolean> {
  if (!deps.store.getProject(projectId)) {
    sendJson(res, 404, { error: "preview target not found", code: "preview_target_not_found" });
    return false;
  }
  try {
    const result = await ensureStandardProjectWorkspace(deps, projectId, { readMode: "compact" });
    if (result.status === "unsupported") {
      sendJson(res, 409, {
        error: "Preview Target APIs require a Standard project",
        ...result,
      });
      return false;
    }
    return true;
  } catch (error) {
    if (!deps.store.getProject(projectId)) {
      sendJson(res, 404, { error: "preview target not found", code: "preview_target_not_found" });
      return false;
    }
    if (error instanceof LegacyWorkspaceSeedDriftError) {
      sendJson(res, 409, {
        error: error.message,
        code: "legacy_workspace_seed_drift",
        projectId: error.projectId,
      });
      return false;
    }
    throw error;
  }
}

function sendPreviewTargetError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof PreviewTargetValidationError) {
    sendJson(res, 400, { error: error.message, code: "preview_target_invalid" });
    return true;
  }
  if (error instanceof PreviewTargetNotFoundError) {
    sendJson(res, 404, { error: error.message, code: "preview_target_not_found" });
    return true;
  }
  if (error instanceof PreviewTargetConflictError) {
    sendJson(res, 409, { error: error.message, code: "preview_target_conflict" });
    return true;
  }
  if (error instanceof RenderAssemblyError) {
    sendJson(res, 409, { error: error.message, code: "preview_target_assembly_invalid" });
    return true;
  }
  return false;
}

function requirePathOwnership(pathProjectId: string, bodyProjectId: string): void {
  if (pathProjectId !== bodyProjectId) {
    // Do not reveal whether the body-owned Project or target exists.
    throw new PreviewTargetNotFoundError("Preview Target was not found");
  }
}

function requireFullLease(lease: DevServerLease): PreviewLease {
  return requirePreviewLease(lease, "artifact preview runtime");
}

export async function handleResolvePreviewTarget(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const target = parsePreviewTarget(envelopeValue(
      await readJsonBody(req, undefined, signal),
      "target",
    ));
    requirePathOwnership(id!, target.projectId);
    if (!await requireReadyWorkspace(res, deps, id!)) return;
    signal?.throwIfAborted();
    sendJson(res, 200, { resolved: await resolvePreviewTarget(deps, target) });
  } catch (error) {
    if (!sendPreviewTargetError(res, error)) throw error;
  }
}

export async function handleAcquirePreviewTargetLease(
  req: IncomingMessage,
  res: ServerResponse,
  { id }: Record<string, string>,
  deps: AppDeps,
  signal?: AbortSignal,
): Promise<void> {
  let acquiredLease: PreviewTargetLease | undefined;
  try {
    const resolved = parseResolvedPreviewTarget(envelopeValue(
      await readJsonBody(req, undefined, signal),
      "resolved",
    ));
    requirePathOwnership(id!, resolved.projectId);
    if (!await requireReadyWorkspace(res, deps, id!)) return;
    signal?.throwIfAborted();
    const injectedEnsure = deps.ensureDevServer
      ? async (...args: Parameters<NonNullable<AppDeps["ensureDevServer"]>>): Promise<PreviewLease> =>
        requireFullLease(await deps.ensureDevServer!(...args))
      : undefined;
    acquiredLease = await acquirePreviewTargetLease({
      store: deps.store,
      dataDir: deps.dataDir,
      ...(deps.previewLeaseManager ? { previewLeaseManager: deps.previewLeaseManager } : {}),
      ...(injectedEnsure ? { ensureDevServer: injectedEnsure } : {}),
    }, resolved, signal);
    signal?.throwIfAborted();
    sendJson(res, 201, {
      leaseId: acquiredLease.leaseId,
      url: acquiredLease.url,
      bridgeNonce: acquiredLease.bridgeNonce,
      expiresAt: acquiredLease.expiresAt,
      resolved: acquiredLease.resolved,
    });
    acquiredLease = undefined;
  } catch (error) {
    if (acquiredLease) await acquiredLease.release();
    if (error instanceof HttpError || !sendPreviewTargetError(res, error)) throw error;
  }
}
