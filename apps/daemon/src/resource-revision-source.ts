import { isIP } from "node:net";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type {
  Resource,
  ResourceKind as WorkspaceResourceKind,
  Store,
} from "../../../packages/core/src/index.ts";
import { getBuiltInEffect, type EffectDefinition } from "../../../packages/effects/src/index.ts";
import {
  ContextIntegrityError,
  assertIdentifier,
  checksumBytes,
  cloneAndFreeze,
  stableStringify,
  type ResourceRevisionSnapshot,
  type ResourceSnapshotSource,
} from "./context/context-types.ts";
import { resourceAdapters } from "./context/adapters/index.ts";
import { readOwnedResourceBytes } from "./context/adapters/file.ts";
import { moodboardAssetPath } from "./project-moodboard-context.ts";
import { projectDir } from "./serve-static.ts";
import {
  acquireMaterializedRenderAssembly,
  buildRenderAssembly,
  RenderAssemblyError,
} from "./render-assembly.ts";

export type OwnedResourceRevisionSource =
  | { type: "moodboard"; moodboardId: string }
  | { type: "effect"; effectId: string }
  | { type: "uploaded-file"; uploadedFileId: string }
  | {
      type: "project-reference";
      sourceProjectId: string;
      sourceWorkspaceId: string;
      sourceSnapshotId: string;
      sourceArtifactId: string;
      sourceArtifactRevisionId: string;
    }
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
  if (source.type === "project-reference") {
    exactFields(source, [
      "type",
      "sourceProjectId",
      "sourceWorkspaceId",
      "sourceSnapshotId",
      "sourceArtifactId",
      "sourceArtifactRevisionId",
    ], "Project Reference Resource source");
    return {
      type: "project-reference",
      sourceProjectId: ownedId(source.sourceProjectId, "Project Reference source Project id"),
      sourceWorkspaceId: ownedId(source.sourceWorkspaceId, "Project Reference source Workspace id"),
      sourceSnapshotId: ownedId(source.sourceSnapshotId, "Project Reference source Snapshot id"),
      sourceArtifactId: ownedId(source.sourceArtifactId, "Project Reference source Artifact id"),
      sourceArtifactRevisionId: ownedId(
        source.sourceArtifactRevisionId,
        "Project Reference source Artifact Revision id",
      ),
    };
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
  "project-reference": "file",
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

// Keep enough headroom beneath the shared 64 MiB immutable Resource payload cap
// for deterministic JSON/base64 framing. This covers Home's full two-image /
// 12 MiB visual contract plus source, Component roots, fonts, and sidecars.
const MAX_PROJECT_REFERENCE_BUNDLE_BYTES = 56 * 1024 * 1024;
const MAX_PROJECT_REFERENCE_FILES = 512;
const MAX_PROJECT_REFERENCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_REFERENCE_TOTAL_FILE_BYTES = 40 * 1024 * 1024;
const UTF8_SOURCE_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "image/svg+xml",
]);

function projectReferenceFileMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": case ".htm": return "text/html";
    case ".css": return "text/css";
    case ".js": case ".mjs": case ".cjs": case ".jsx": return "text/javascript";
    case ".ts": case ".tsx": return "text/typescript";
    case ".json": return "application/json";
    case ".md": case ".txt": return "text/plain";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function exactProjectReferenceFiles(
  sourceRoot: string,
  includedArtifactRoots: readonly string[],
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const sourceMetadata = await lstat(canonicalSourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new ContextIntegrityError("Project Reference assembly source root is invalid");
  }
  const paths = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      // RenderAssembly deliberately treats installed dependencies as mutable
      // runtime cache rather than immutable Revision source.
      if (entry.name === "node_modules") continue;
      const absolute = resolve(directory, entry.name);
      if (!inside(canonicalSourceRoot, absolute)) {
        throw new ContextIntegrityError("Project Reference Artifact file escaped its assembled source");
      }
      if (entry.isSymbolicLink()) {
        throw new ContextIntegrityError("Project Reference Artifact assembly cannot contain symlinks");
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new ContextIntegrityError("Project Reference Artifact assembly contains a non-file entry");
      }
      paths.add(relative(canonicalSourceRoot, absolute).split(sep).join("/"));
      if (paths.size > MAX_PROJECT_REFERENCE_FILES) {
        throw new ContextIntegrityError(
          `Project Reference Artifact assembly exceeds its ${MAX_PROJECT_REFERENCE_FILES}-file limit`,
        );
      }
    }
  };
  const roots = [...new Set(includedArtifactRoots)]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const artifactRoot of roots) {
    const absoluteRoot = resolve(canonicalSourceRoot, ...artifactRoot.split("/"));
    if (!inside(canonicalSourceRoot, absoluteRoot)) {
      throw new ContextIntegrityError("Project Reference Artifact root escaped its assembled source");
    }
    const before = await lstat(absoluteRoot);
    const canonicalRoot = await realpath(absoluteRoot);
    if (!inside(canonicalSourceRoot, canonicalRoot) || before.isSymbolicLink() || !before.isDirectory()) {
      throw new ContextIntegrityError("Project Reference Artifact root is unavailable or invalid");
    }
    await visit(canonicalRoot);
  }
  let totalBytes = 0;
  const result: Readonly<Record<string, unknown>>[] = [];
  for (const path of [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const absolute = resolve(canonicalSourceRoot, ...path.split("/"));
    const before = await lstat(absolute);
    const canonical = await realpath(absolute);
    if (!inside(canonicalSourceRoot, canonical) || before.isSymbolicLink() || !before.isFile()
      || before.size > MAX_PROJECT_REFERENCE_FILE_BYTES) {
      throw new ContextIntegrityError(
        `Project Reference Artifact file ${path} is unavailable or exceeds its 16 MiB limit`,
      );
    }
    const bytes = await readFile(canonical);
    const after = await lstat(absolute);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size) {
      throw new ContextIntegrityError(`Project Reference Artifact file ${path} changed while captured`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROJECT_REFERENCE_TOTAL_FILE_BYTES) {
      throw new ContextIntegrityError("Project Reference Artifact files exceed their 40 MiB total limit");
    }
    const mimeType = projectReferenceFileMimeType(path);
    let text: string | null = null;
    if (mimeType.startsWith("text/") || UTF8_SOURCE_MIME_TYPES.has(mimeType)) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    result.push(Object.freeze({
      path,
      mimeType,
      byteLength: bytes.byteLength,
      checksum: checksumBytes(bytes),
      ...(text === null
        ? { encoding: "base64", content: bytes.toString("base64") }
        : { encoding: "utf8", content: text }),
    }));
  }
  return Object.freeze(result);
}

async function exactProjectReferenceBundle(
  store: Store,
  dataDir: string,
  source: Extract<OwnedResourceRevisionSource, { type: "project-reference" }>,
): Promise<{
  bytes: Buffer;
  summary: string;
  sourceId: string;
  provenance: Readonly<Record<string, unknown>>;
}> {
  const project = store.getProject(source.sourceProjectId);
  const bundle = store.workspace.getBundleByProjectId(source.sourceProjectId);
  if (!project || project.mode !== "standard" || !bundle
    || bundle.workspace.id !== source.sourceWorkspaceId
    || bundle.workspace.projectId !== source.sourceProjectId) {
    throw new ContextIntegrityError("Project Reference source Workspace is missing or foreign");
  }
  const snapshot = bundle.snapshots.find((candidate) => candidate.id === source.sourceSnapshotId);
  const artifact = bundle.artifacts.find((candidate) => candidate.id === source.sourceArtifactId);
  const revision = bundle.revisions.find((candidate) => candidate.id === source.sourceArtifactRevisionId);
  const track = artifact === undefined
    ? undefined
    : bundle.tracks.find((candidate) => candidate.id === revision?.trackId
      && candidate.artifactId === artifact.id);
  if (!snapshot || !artifact || !revision || !track
    || artifact.workspaceId !== bundle.workspace.id
    || revision.workspaceId !== bundle.workspace.id
    || revision.artifactId !== artifact.id
    || snapshot.workspaceId !== bundle.workspace.id
    || snapshot.artifactRevisions[artifact.id] !== revision.id) {
    throw new ContextIntegrityError(
      "Project Reference does not identify one exact immutable Artifact Revision in its Snapshot",
    );
  }
  let graph: typeof bundle.graph;
  try {
    graph = store.workspace.getGraphRevision(source.sourceProjectId, snapshot.graphRevision);
  } catch (error) {
    throw new ContextIntegrityError(
      `Project Reference Snapshot lost its immutable graph Revision: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (graph.workspaceId !== bundle.workspace.id || graph.revision !== snapshot.graphRevision) {
    throw new ContextIntegrityError("Project Reference graph does not match its immutable Snapshot");
  }
  const kernelRevision = store.workspace.getKernelRevision(revision.kernelRevisionId);
  if (!kernelRevision || kernelRevision.workspaceId !== bundle.workspace.id) {
    throw new ContextIntegrityError("Project Reference Artifact Revision lost its exact Design Kernel");
  }
  let assembly: ReturnType<typeof buildRenderAssembly>;
  let files: readonly Readonly<Record<string, unknown>>[];
  try {
    assembly = buildRenderAssembly(
      store,
      { projectId: source.sourceProjectId, revisionId: revision.id },
      { dataDir, shallowSnapshotId: snapshot.id },
    );
    if (assembly.rootRevision.id !== revision.id
      || assembly.rootRevision.sourceCommitHash !== revision.sourceCommitHash
      || assembly.rootRevision.sourceTreeHash !== revision.sourceTreeHash
      || assembly.artifactId !== artifact.id
      || assembly.workspaceId !== bundle.workspace.id) {
      throw new ContextIntegrityError("Project Reference RenderAssembly substituted its exact Revision");
    }
    const materialized = await acquireMaterializedRenderAssembly({ dataDir }, assembly);
    try {
      files = await exactProjectReferenceFiles(
        materialized.sourceDir,
        ["."],
      );
    } finally {
      await materialized.release();
    }
  } catch (error) {
    if (error instanceof ContextIntegrityError) throw error;
    if (error instanceof RenderAssemblyError) {
      throw new ContextIntegrityError(`Project Reference exact Artifact source is unavailable: ${error.message}`);
    }
    throw error;
  }
  const graphNode = graph.nodes.find((node) => (
    (node.kind === "page" || node.kind === "component") && node.artifactId === artifact.id
  )) ?? null;
  const adjacentEdges = graphNode === null
    ? []
    : graph.edges.filter((edge) => (
        edge.sourceNodeId === graphNode.id || edge.targetNodeId === graphNode.id
      ));
  const adjacentNodeIds = new Set(adjacentEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
  const body = {
    protocol: "dezin.project-reference-bundle.v1",
    source: {
      project: { id: project.id, name: project.name, mode: project.mode },
      workspaceId: bundle.workspace.id,
      snapshotId: snapshot.id,
      artifactId: artifact.id,
      artifactRevisionId: revision.id,
    },
    design: {
      artifact,
      track,
      revision,
      kernelRevision,
      assembly: {
        assemblyHash: assembly.assemblyHash,
        dependencyLockHash: assembly.dependencyLockHash,
        artifactRoot: assembly.artifactRoot,
        revisionIds: assembly.revisions.map((candidate) => candidate.id),
        resourceRevisionIds: assembly.resourcePayloads.map((payload) => payload.resourceRevisionId),
      },
      dependencies: store.workspace.listArtifactRevisionDependencies(revision.id),
      resourcePins: store.workspace.listArtifactRevisionResourcePins(revision.id),
      graphNode,
      adjacentEdges,
      adjacentNodes: graph.nodes.filter((node) => adjacentNodeIds.has(node.id)),
      files,
    },
  };
  const bytes = Buffer.from(`${stableStringify(body)}\n`, "utf8");
  if (bytes.byteLength > MAX_PROJECT_REFERENCE_BUNDLE_BYTES) {
    throw new ContextIntegrityError("Project Reference bundle exceeds its 56 MiB byte limit");
  }
  const sourceId = [
    source.sourceProjectId,
    source.sourceSnapshotId,
    source.sourceArtifactId,
    source.sourceArtifactRevisionId,
  ].join(":");
  return {
    bytes,
    summary: `Project Reference: ${summaryLabel(project.name, "Untitled project")} / ${summaryLabel(artifact.name, "Untitled artifact")}`,
    sourceId,
    provenance: cloneAndFreeze({
      sourceProjectId: project.id,
      sourceWorkspaceId: bundle.workspace.id,
      sourceSnapshotId: snapshot.id,
      sourceArtifactId: artifact.id,
      sourceArtifactRevisionId: revision.id,
      sourceArtifactKind: artifact.kind,
      sourceCommitHash: revision.sourceCommitHash,
      sourceTreeHash: revision.sourceTreeHash,
      bundleProtocol: "dezin.project-reference-bundle.v1",
    }),
  };
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

  let additionalProvenance: Readonly<Record<string, unknown>> = {};
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
  } else if (input.source.type === "project-reference") {
    const reference = await exactProjectReferenceBundle(input.store, input.dataDir, input.source);
    sourceId = reference.sourceId;
    summary = reference.summary;
    additionalProvenance = reference.provenance;
    source = {
      type: "owned-bytes",
      bytes: reference.bytes,
      mimeType: "application/json",
      label: `${input.source.sourceProjectId}-${input.source.sourceArtifactId}.dezin-reference.json`,
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
      ...additionalProvenance,
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
