import type { IncomingMessage, ServerResponse } from "node:http";

import {
  WorkspaceResourceNotFoundError,
  WorkspaceResourceOwnershipError,
  WorkspaceStoreCodecError,
} from "../../../packages/core/src/index.ts";
import type { AppDeps } from "./app.ts";
import { HttpError, sendJson } from "./http-util.ts";
import {
  readResourceRevisionEmbeddedAsset,
  readResourceRevisionView,
  readVerifiedExactResourceRevisionPayload,
  resourceRevisionPreviewKind,
  ResourceRevisionViewError,
} from "./resource-revision-view.ts";
import { ensureStandardProjectWorkspace } from "./workspace-migration.ts";

const READ_TIMEOUT_MS = 30_000;

async function requireReadyProject(
  res: ServerResponse,
  deps: AppDeps,
  projectId: string,
): Promise<boolean> {
  if (!deps.store.getProject(projectId)) throw new HttpError(404, "project not found");
  const ready = await ensureStandardProjectWorkspace(deps, projectId, { readMode: "compact" });
  if (ready.status === "unsupported") {
    sendJson(res, 409, {
      error: "Workspace APIs require a Standard project",
      ...ready,
    });
    return false;
  }
  return true;
}

function viewError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof ResourceRevisionViewError) {
    sendJson(res, error.status, {
      error: error.message,
      code: error.status === 404 ? "resource_revision_not_found" : "resource_revision_invalid",
    });
    return true;
  }
  if (error instanceof WorkspaceResourceNotFoundError || error instanceof WorkspaceResourceOwnershipError) {
    sendJson(res, 404, { error: "Resource Revision was not found", code: "resource_revision_not_found" });
    return true;
  }
  return false;
}

function exactQuery(req: IncomingMessage, allowed: readonly string[], label: string): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const allowedKeys = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) throw new HttpError(400, `unexpected ${label} query: ${key}`);
    if (url.searchParams.getAll(key).length !== 1) throw new HttpError(400, `duplicate ${label} query: ${key}`);
  }
  return url.searchParams;
}

function resourceRevisionHistoryCursor(value: string): { createdAt: number; id: string } {
  if (value.length === 0 || value.length > 2_048) throw new HttpError(400, "Resource history cursor is invalid");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, "createdAt") || !Object.hasOwn(parsed, "id")) {
      throw new Error("shape");
    }
    const cursor = parsed as { createdAt?: unknown; id?: unknown };
    if (!Number.isSafeInteger(cursor.createdAt) || Number(cursor.createdAt) < 0
      || typeof cursor.id !== "string" || cursor.id.length === 0 || cursor.id !== cursor.id.trim()) {
      throw new Error("value");
    }
    const canonical = Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString("base64url");
    if (canonical !== value) throw new Error("canonical");
    return { createdAt: Number(cursor.createdAt), id: cursor.id };
  } catch {
    throw new HttpError(400, "Resource history cursor is invalid");
  }
}

export async function handleListResourceRevisionHistory(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const projectId = params.id!;
  if (!await requireReadyProject(res, deps, projectId)) return;
  const query = exactQuery(req, ["limit", "cursor"], "Resource history");
  const rawLimit = query.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) {
    throw new HttpError(400, "Resource history limit must be an integer from 1 to 50");
  }
  const rawCursor = query.get("cursor");
  try {
    const page = deps.store.workspace.listResourceRevisionHistoryPage(projectId, params.resourceId!, {
      limit: rawLimit === null ? 20 : Number(rawLimit),
      ...(rawCursor === null ? {} : { cursor: resourceRevisionHistoryCursor(rawCursor) }),
    });
    sendJson(res, 200, {
      items: page.items,
      nextCursor: page.nextCursor === null
        ? null
        : Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url"),
    });
  } catch (error) {
    if (error instanceof WorkspaceStoreCodecError) throw new HttpError(400, error.message);
    if (!viewError(res, error)) throw error;
  }
}

export async function handleGetResourceRevisionView(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  exactQuery(req, [], "Resource Revision view");
  if (!await requireReadyProject(res, deps, params.id!)) return;
  try {
    const view = await readResourceRevisionView({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId: params.id!,
      resourceId: params.resourceId!,
      revisionId: params.revisionId!,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    sendJson(res, 200, view);
  } catch (error) {
    if (!viewError(res, error)) throw error;
  }
}

function responseFileName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return normalized || "resource-revision.bin";
}

function matchesIfNoneMatch(req: IncomingMessage, etag: string): boolean {
  const header = req.headers["if-none-match"];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  const normalize = (candidate: string): string => candidate.trim().replace(/^W\//i, "");
  return value.split(",").some((candidate) => candidate.trim() === "*" || normalize(candidate) === etag);
}

function sendVerifiedBytes(
  req: IncomingMessage,
  res: ServerResponse,
  input: { bytes: Buffer; mimeType: string; checksum: string; fileName: string },
  download: boolean,
): void {
  const kind = resourceRevisionPreviewKind(input.mimeType);
  const inline = !download && (kind === "image" || kind === "pdf" || kind === "video" || kind === "audio");
  const etag = `"${input.checksum}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Content-Security-Policy",
    "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  );
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${responseFileName(input.fileName)}"`);
  if (matchesIfNoneMatch(req, etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", input.mimeType);
  res.setHeader("Content-Length", String(input.bytes.byteLength));
  res.end(input.bytes);
}

function downloadQuery(req: IncomingMessage, label: string): boolean {
  const query = exactQuery(req, ["download"], label);
  const raw = query.get("download");
  if (raw === null) return false;
  if (raw !== "1") throw new HttpError(400, `${label} download query must be 1`);
  return true;
}

export async function handleGetResourceRevisionPayload(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const download = downloadQuery(req, "Resource Revision payload");
  if (!await requireReadyProject(res, deps, params.id!)) return;
  try {
    const exact = await readVerifiedExactResourceRevisionPayload({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId: params.id!,
      resourceId: params.resourceId!,
      revisionId: params.revisionId!,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    sendVerifiedBytes(req, res, {
      bytes: exact.bytes,
      mimeType: exact.descriptor.mimeType,
      checksum: exact.descriptor.payloadChecksum,
      fileName: `resource-${exact.revision.id}`,
    }, download);
  } catch (error) {
    if (!viewError(res, error)) throw error;
  }
}

export async function handleGetResourceRevisionEmbeddedAsset(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  deps: AppDeps,
): Promise<void> {
  const download = downloadQuery(req, "Resource Revision embedded Asset");
  if (!await requireReadyProject(res, deps, params.id!)) return;
  try {
    const asset = await readResourceRevisionEmbeddedAsset({
      store: deps.store,
      dataDir: deps.dataDir,
      projectId: params.id!,
      resourceId: params.resourceId!,
      revisionId: params.revisionId!,
      assetId: params.assetId!,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    sendVerifiedBytes(req, res, asset, download);
  } catch (error) {
    if (!viewError(res, error)) throw error;
  }
}
