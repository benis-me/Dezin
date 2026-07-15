import { isIP } from "node:net";
import { basename, dirname, extname } from "node:path";
import type {
  Resource,
  ResourceKind as WorkspaceResourceKind,
  Store,
} from "../../../packages/core/src/index.ts";
import { getBuiltInEffect, type EffectDefinition } from "../../../packages/effects/src/index.ts";
import {
  ContextIntegrityError,
  assertIdentifier,
  cloneAndFreeze,
  type ResourceRevisionSnapshot,
  type ResourceSnapshotSource,
} from "./context/context-types.ts";
import { resourceAdapters } from "./context/adapters/index.ts";
import { readOwnedResourceBytes } from "./context/adapters/file.ts";
import { moodboardAssetPath } from "./project-moodboard-context.ts";
import { projectDir } from "./serve-static.ts";

export type OwnedResourceRevisionSource =
  | { type: "moodboard"; moodboardId: string }
  | { type: "effect"; effectId: string }
  | { type: "uploaded-file"; uploadedFileId: string }
  | { type: "asset"; assetId: string }
  | { type: "external-reference"; url: string };

export interface CreateResourceRevisionRequest {
  expectedHeadRevisionId: string | null;
  source: OwnedResourceRevisionSource;
}

/** A dedicated boundary error lets HTTP integration classify malformed input as 400. */
export class ResourceRevisionSourceInputError extends ContextIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceRevisionSourceInputError";
  }
}

export const EXTERNAL_REFERENCE_FETCH_POLICY = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 8_000,
  maxRedirects: 3,
  publicIpOnly: true,
  pinResolvedAddress: true,
  revalidateRedirects: true,
} as const);

export interface SafeExternalFetchRequest {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  publicIpOnly: true;
  pinResolvedAddress: true;
  revalidateRedirects: true;
  signal: AbortSignal;
}

export interface SafeBoundedExternalRepresentation {
  finalUrl: string;
  status: number;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * This dependency is intentionally injected by trusted daemon wiring. Its
 * contract requires DNS address pinning, public-address filtering, and the same
 * checks after every redirect. There is deliberately no ambient/default fetch.
 */
export type SafeBoundedExternalFetcher = (
  request: SafeExternalFetchRequest,
) => Promise<SafeBoundedExternalRepresentation>;

export interface SnapshotOwnedResourceRevisionSourceInput {
  store: Store;
  dataDir: string;
  projectId: string;
  workspaceId: string;
  resource: Pick<Resource, "id" | "workspaceId" | "kind">;
  revisionId: string;
  snapshotRoot: string;
  source: OwnedResourceRevisionSource;
  createdAt: number;
  fetchExternal?: SafeBoundedExternalFetcher;
}

export interface OwnedResourceRevisionSnapshotResult {
  snapshot: ResourceRevisionSnapshot;
  summary: string;
  metadata: Readonly<{
    resourceKind: WorkspaceResourceKind;
    payloadChecksum: string;
    /** Canonical durable payload size terminology. */
    byteLength: number;
    /** Compatibility alias consumed by the Task 11 HTTP contract. */
    byteSize: number;
    mimeType: string;
  }>;
  provenance: Readonly<Record<string, unknown>>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResourceRevisionSourceInputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const expected = new Set(required);
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      throw new ResourceRevisionSourceInputError(
        `${label} contains unsupported client-authored field ${field}`,
      );
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      throw new ResourceRevisionSourceInputError(`${label} is missing field ${field}`);
    }
  }
}

function ownedId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ResourceRevisionSourceInputError(`${label} must be a string`);
  try {
    assertIdentifier(value, label);
  } catch {
    throw new ResourceRevisionSourceInputError(`${label} is not a safe identifier`);
  }
  return value;
}

function uploadedFileIdentity(value: unknown): string {
  if (typeof value !== "string") {
    throw new ResourceRevisionSourceInputError("Uploaded file source id must be a string");
  }
  const prefix = ".refs/";
  const name = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (
    !name
    || name === "."
    || name === ".."
    || name.length > 80
    || !/^[A-Za-z0-9._-]+$/.test(name)
    || basename(name) !== name
    || value !== `${prefix}${name}`
  ) {
    throw new ResourceRevisionSourceInputError(
      "Uploaded file source must be exactly .refs/<safe basename>",
    );
  }
  return value;
}

function ipv4IsPublic(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipLiteralIsPublic(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const version = isIP(unwrapped);
  if (version === 4) return ipv4IsPublic(unwrapped);
  if (version !== 6) return true;
  const normalized = unwrapped.toLowerCase();
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  // Current globally routable unicast IPv6 space. Link-local, ULA,
  // multicast, loopback, unspecified, and documentation ranges fail closed.
  return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith("2001:db8:");
}

const CREDENTIAL_PARAMETER = /(?:^|[_-])(?:access[_-]?token|token|api[_-]?key|secret|signature|sig|auth|authorization|password|credential)(?:$|[_-])/i;

function safeExternalUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new ResourceRevisionSourceInputError(`${label} must be a bounded URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ResourceRevisionSourceInputError(`${label} is invalid`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username || parsed.password || parsed.href.length > 4_096) {
    throw new ResourceRevisionSourceInputError(`${label} must be a credential-free HTTP(S) URL`);
  }
  const fragmentParameters = new URLSearchParams(parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash);
  if ([...parsed.searchParams.keys(), ...fragmentParameters.keys()].some((key) => CREDENTIAL_PARAMETER.test(key))) {
    throw new ResourceRevisionSourceInputError(`${label} cannot persist credential-bearing parameters`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const blockedName = hostname === "localhost"
    || !hostname.includes(".")
    || [".localhost", ".local", ".lan", ".home", ".internal", ".test", ".invalid", ".example"]
      .some((suffix) => hostname.endsWith(suffix));
  if (blockedName || !ipLiteralIsPublic(hostname)) {
    throw new ResourceRevisionSourceInputError(`${label} must resolve only to a public address`);
  }
  return parsed.href;
}

function normalizeSource(value: unknown): OwnedResourceRevisionSource {
  const source = record(value, "Resource Revision source");
  if (source.type === "moodboard") {
    exactFields(source, ["type", "moodboardId"], "Moodboard Resource source");
    return { type: "moodboard", moodboardId: ownedId(source.moodboardId, "Moodboard source id") };
  }
  if (source.type === "effect") {
    exactFields(source, ["type", "effectId"], "Effect Resource source");
    return { type: "effect", effectId: ownedId(source.effectId, "Effect source id") };
  }
  if (source.type === "uploaded-file") {
    exactFields(source, ["type", "uploadedFileId"], "Uploaded file Resource source");
    return { type: "uploaded-file", uploadedFileId: uploadedFileIdentity(source.uploadedFileId) };
  }
  if (source.type === "asset") {
    exactFields(source, ["type", "assetId"], "Asset Resource source");
    return { type: "asset", assetId: ownedId(source.assetId, "Asset source id") };
  }
  if (source.type === "external-reference") {
    exactFields(source, ["type", "url"], "External Reference Resource source");
    return { type: "external-reference", url: safeExternalUrl(source.url, "External Reference source URL") };
  }
  throw new ResourceRevisionSourceInputError("Resource Revision source type is unsupported");
}

/**
 * Strict HTTP/runtime parser. manifestPath, checksum, metadata, provenance and
 * source filesystem paths are intentionally absent and rejected as extra fields.
 */
export function normalizeCreateResourceRevisionRequest(value: unknown): CreateResourceRevisionRequest {
  const input = record(value, "Create Resource Revision request");
  exactFields(input, ["expectedHeadRevisionId", "source"], "Create Resource Revision request");
  if (input.expectedHeadRevisionId !== null && typeof input.expectedHeadRevisionId !== "string") {
    throw new ResourceRevisionSourceInputError("expectedHeadRevisionId must be a string or null");
  }
  const expectedHeadRevisionId = input.expectedHeadRevisionId === null
    ? null
    : ownedId(input.expectedHeadRevisionId, "Expected Head Revision id");
  return cloneAndFreeze({
    expectedHeadRevisionId,
    source: normalizeSource(input.source),
  });
}

const SOURCE_RESOURCE_KIND: Readonly<Record<OwnedResourceRevisionSource["type"], WorkspaceResourceKind>> = {
  moodboard: "moodboard",
  effect: "effect",
  "uploaded-file": "file",
  asset: "asset",
  "external-reference": "external-reference",
};

function mimeTypeForUploadedFile(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".txt": case ".md": case ".csv": return "text/plain";
    case ".json": return "application/json";
    case ".html": case ".htm": return "text/html";
    case ".css": return "text/css";
    case ".js": case ".mjs": return "text/javascript";
    case ".ts": case ".tsx": return "text/typescript";
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    default: return "application/octet-stream";
  }
}

function summaryLabel(value: string, fallback: string): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(compact || fallback).slice(0, 200).join("");
}

function sourceMismatch(source: OwnedResourceRevisionSource, kind: WorkspaceResourceKind): never {
  throw new ContextIntegrityError(
    `Resource kind ${kind} does not match owned source type ${source.type}`,
  );
}

async function externalRepresentation(
  url: string,
  fetcher: SafeBoundedExternalFetcher | undefined,
): Promise<Extract<ResourceSnapshotSource, { type: "bounded-external" }>> {
  if (!fetcher) {
    throw new ContextIntegrityError(
      "External Reference snapshot is fail-closed without an injected SSRF-safe bounded fetcher",
    );
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new Error("External Reference fetch timed out"));
      reject(new ContextIntegrityError("External Reference fetch exceeded its time limit"));
    }, EXTERNAL_REFERENCE_FETCH_POLICY.timeoutMs);
    timeout.unref?.();
  });
  let fetched: SafeBoundedExternalRepresentation;
  try {
    fetched = await Promise.race([
      fetcher({
        url,
        ...EXTERNAL_REFERENCE_FETCH_POLICY,
        signal: controller.signal,
      }),
      bounded,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!fetched || typeof fetched !== "object") {
    throw new ContextIntegrityError("External Reference fetcher returned an invalid representation");
  }
  if (!(fetched.bytes instanceof Uint8Array)
    || fetched.bytes.byteLength > EXTERNAL_REFERENCE_FETCH_POLICY.maxBytes) {
    throw new ContextIntegrityError("External Reference representation exceeds its byte limit");
  }
  if (!Number.isInteger(fetched.status) || fetched.status < 200 || fetched.status > 299) {
    throw new ContextIntegrityError("External Reference fetch did not return a successful response");
  }
  if (typeof fetched.mimeType !== "string" || !fetched.mimeType) {
    throw new ContextIntegrityError("External Reference representation MIME type is invalid");
  }
  return {
    type: "bounded-external",
    url,
    finalUrl: safeExternalUrl(fetched.finalUrl, "External Reference final URL"),
    status: fetched.status,
    mimeType: fetched.mimeType,
    bytes: fetched.bytes,
  };
}

/** Resolve only daemon-owned identities, freeze them through the registered adapter, and return server-authored candidate fields. */
export async function snapshotOwnedResourceRevisionSource(
  input: SnapshotOwnedResourceRevisionSourceInput,
): Promise<OwnedResourceRevisionSnapshotResult> {
  if (!input.store.getProject(input.projectId)) throw new ContextIntegrityError("Resource source Project was not found");
  assertIdentifier(input.projectId, "Project ID");
  assertIdentifier(input.workspaceId, "Workspace ID");
  assertIdentifier(input.resource.id, "Resource ID");
  assertIdentifier(input.revisionId, "Resource Revision ID");
  if (input.resource.workspaceId !== input.workspaceId) {
    throw new ContextIntegrityError("Resource source Workspace ownership does not match");
  }

  const expectedKind = SOURCE_RESOURCE_KIND[input.source.type];
  if (expectedKind !== input.resource.kind) sourceMismatch(input.source, input.resource.kind);

  let source: ResourceSnapshotSource;
  let workspaceRoot = projectDir(input.dataDir, input.projectId);
  let summary: string;
  let sourceId: string;

  if (input.source.type === "uploaded-file") {
    // Re-normalize even for typed internal callers: TypeScript types are not a
    // runtime security boundary, and only the Project's own .refs basename is valid.
    const ownedFileId = uploadedFileIdentity(input.source.uploadedFileId);
    sourceId = ownedFileId;
    summary = `Uploaded file: ${summaryLabel(basename(ownedFileId), "attachment")}`;
    source = {
      type: "owned-file",
      path: ownedFileId,
      mimeType: mimeTypeForUploadedFile(ownedFileId),
      label: basename(ownedFileId),
    };
  } else if (input.source.type === "moodboard") {
    sourceId = ownedId(input.source.moodboardId, "Moodboard source id");
    const board = input.store.getMoodboard(sourceId);
    if (!board || board.archivedAt !== null) throw new ContextIntegrityError("Owned Moodboard source was not found");
    const conversations = input.store.listMoodboardConversations(board.id);
    const nodes = input.store.listMoodboardNodes(board.id);
    const assets = input.store.listMoodboardAssets(board.id);
    const messages = conversations.flatMap((conversation) => input.store.listMoodboardMessages(board.id, conversation.id));
    const frozenAssets = await Promise.all(assets.map(async (asset) => {
      if (asset.boardId !== board.id) throw new ContextIntegrityError("Moodboard Asset ownership does not match");
      const path = moodboardAssetPath(input.dataDir, board.id, asset);
      return {
        id: asset.id,
        metadata: structuredClone(asset) as unknown as Readonly<Record<string, unknown>>,
        bytes: await readOwnedResourceBytes(dirname(path), basename(path)),
      };
    }));
    summary = `Moodboard: ${summaryLabel(board.name, "Untitled moodboard")}`;
    source = {
      type: "moodboard-bundle",
      board: { ...structuredClone(board), conversations: structuredClone(conversations) },
      nodes: structuredClone(nodes),
      messages: structuredClone(messages),
      assets: frozenAssets,
    };
  } else if (input.source.type === "effect") {
    sourceId = ownedId(input.source.effectId, "Effect source id");
    const definition = getBuiltInEffect(sourceId) ?? input.store.getEffect(sourceId);
    if (!definition) throw new ContextIntegrityError("Owned Effect source was not found");
    summary = `Effect: ${summaryLabel(definition.name, "Untitled effect")}`;
    source = {
      type: "effect-definition",
      definition: structuredClone(definition as EffectDefinition) as unknown as Readonly<Record<string, unknown>>,
    };
  } else if (input.source.type === "asset") {
    sourceId = ownedId(input.source.assetId, "Asset source id");
    const asset = input.store.getMoodboardAsset(sourceId);
    const board = asset ? input.store.getMoodboard(asset.boardId) : null;
    if (!asset || !board || board.archivedAt !== null) throw new ContextIntegrityError("Owned Asset source was not found");
    const path = moodboardAssetPath(input.dataDir, board.id, asset);
    workspaceRoot = dirname(path);
    summary = `Asset: ${summaryLabel(asset.fileName, "Untitled asset")}`;
    source = {
      type: "owned-file",
      path: basename(path),
      mimeType: asset.mimeType,
      label: asset.fileName,
    };
  } else {
    sourceId = safeExternalUrl(input.source.url, "External Reference source URL");
    summary = `External Reference: ${new URL(sourceId).hostname}`;
    source = await externalRepresentation(sourceId, input.fetchExternal);
  }

  const snapshot = await resourceAdapters.require(input.resource.kind).snapshot({
    workspaceId: input.workspaceId,
    resourceId: input.resource.id,
    revisionId: input.revisionId,
    kind: input.resource.kind,
    workspaceRoot,
    snapshotRoot: input.snapshotRoot,
    source,
    provenance: {
      sourceType: input.source.type,
      sourceId,
      adapter: input.resource.kind,
    },
    createdAt: input.createdAt,
  });

  // `snapshotBytes()` returns a deeply frozen object whose identity is also the
  // unforgeable cleanup capability held by the file adapter. Keep that exact
  // identity here so a later database/CAS failure can compensate the files it
  // just created. Cloning the wrapper would silently strip that capability.
  return Object.freeze({
    snapshot,
    summary,
    metadata: cloneAndFreeze({
      resourceKind: input.resource.kind,
      payloadChecksum: snapshot.payloadChecksum,
      byteLength: snapshot.byteSize,
      byteSize: snapshot.byteSize,
      mimeType: snapshot.mimeType,
    }),
    provenance: snapshot.provenance,
  });
}
