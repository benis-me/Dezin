import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import {
  FIGMA_IMPORT_SCHEMA_VERSION,
  type DesignCanvasAssetImportItem,
  type FigmaImportArtifactManifest,
  type FigmaImportInput,
  type FigmaImportManifest,
  type FigmaImportResult,
} from "@dezin/design-canvas-contracts";

import { inspectBoundedPngImage } from "../bounded-png.ts";
import { ensureDesignCanvasAssetBatch, getDesignCanvas } from "./design-storage.ts";
import { designRoot } from "./design-storage-primitives.ts";
import type { ResolvedFigmaCredential } from "./figma-credential-store.ts";
import {
  containsEphemeralRemoteResourceBytes,
  finalizeFigmaVisualReferences,
  normalizeFigmaImport,
  type FigmaNormalizedPayload,
  type NormalizedFigmaImport,
} from "./figma-import-normalizer.ts";
import type { FigmaRestClient } from "./figma-rest-client.ts";
import { sanitizeFigmaPng } from "./figma-png.ts";
import { isSafeFigmaApiNodeId, parseFigmaUrl, type ParsedFigmaUrl } from "./figma-url.ts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_DEPTH = 4;
const MAX_DEPTH = 8;
const MAX_ANCHOR_COORDINATE = 1_000_000;
const execFile = promisify(execFileCallback);
const LEASE_TICKET = /^ticket-([0-9]{16})$/;
const LEASE_PENDING = /^\.pending-[a-f0-9-]{36}$/i;
const MAX_LEASE_QUEUE_ENTRIES = 4_096;
const MAX_LEASE_DIRECTORY_ENTRIES = 65_536;
const MAX_LEASE_TICKET = 9_999_999_999_999_999;
const MALFORMED_PENDING_GRACE_MS = 2_000;
const LIVE_OWNER_IDENTITY_CACHE_MS = 1_000;
const LIVE_OWNER_POLL_MS = 100;
const MAX_RECOVERY_RECEIPTS = 8_192;
const MAX_REFERENCE_RENDER_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_RENDER_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_RENDER_PIXELS = 64_000_000;

type FigmaImportPhase = "accepted" | "snapshot-staged" | "artifacts-imported" | "ready";

interface StoredFigmaImportRequest {
  schemaVersion: typeof FIGMA_IMPORT_SCHEMA_VERSION;
  idempotencyKey: string;
  projectId: string;
  source: ParsedFigmaUrl;
  depth: number;
  anchor: { x: number; y: number };
  rightsAcknowledged: true;
}

interface StoredSnapshot {
  fileName: string;
  resolvedVersion: string;
  editorType: string | null;
  role: string | null;
  linkAccess: string | null;
  incomplete: string[];
  warnings: string[];
  tokenAuthority: NormalizedFigmaImport["tokenAuthority"];
  credential: { mode: "personal-access-token"; subject: string };
  payloads: Array<{
    kind: FigmaImportArtifactManifest["kind"];
    path: string;
    mimeType: string;
    sha256: string;
    bytes: number;
    nodeId: string | null;
  }>;
}

interface StoredSnapshotEnvelope {
  schemaVersion: typeof FIGMA_IMPORT_SCHEMA_VERSION;
  importId: string;
  projectId: string;
  requestHash: string;
  snapshot: StoredSnapshot;
}

interface StoredFigmaImportJob {
  schemaVersion: typeof FIGMA_IMPORT_SCHEMA_VERSION;
  id: string;
  importId: string;
  projectId: string;
  requestHash: string;
  request: StoredFigmaImportRequest;
  status: "running" | "ready" | "failed";
  completedPhase: FigmaImportPhase;
  snapshot: StoredSnapshot | null;
  canvasRevision: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ImportFigmaDesignProjectOptions {
  dataDir: string;
  projectId: string;
  input: FigmaImportInput;
  client: FigmaRestClient;
  credentialProvider: () => Promise<ResolvedFigmaCredential | null>;
  /**
   * Own the existing target Project lifecycle from Canvas validation through
   * final response projection. Production binds this to RuntimeSupervisor;
   * direct callers default to an identity scope.
  */
  withProjectLease?: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  /** Complete any final Project projection before the lifecycle lease is released. */
  finalizeUnderProjectLease?: (result: FigmaImportResult) => void | Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  testHooks?: {
    afterPhase?: (phase: FigmaImportPhase) => void | Promise<void>;
    afterAcceptedJobPublished?: () => void | Promise<void>;
    afterSnapshotRename?: () => void | Promise<void>;
    afterImportRename?: () => void | Promise<void>;
    afterLeaseOwnerDurable?: () => void | Promise<void>;
    afterLeaseObservedPredecessor?: () => void | Promise<void>;
    afterLeaseProcessIdentityCheck?: (pid: number) => void | Promise<void>;
    afterAuthorityDirectoryDurable?: (path: string, parent: string) => void | Promise<void>;
    simulateProcessCrash?: boolean;
  };
}

export interface RecoverFigmaImportsOptions {
  dataDir: string;
  projectIds: readonly string[];
  client: FigmaRestClient;
  credentialProvider: () => Promise<ResolvedFigmaCredential | null>;
  withProjectLease?: ImportFigmaDesignProjectOptions["withProjectLease"];
  signal?: AbortSignal;
}

export interface PendingFigmaImportRecovery {
  jobId: string;
  importId: string;
  projectId: string;
  idempotencyKey: string;
  reason: "snapshot-required";
}

export interface RecoverFigmaImportsResult {
  recovered: FigmaImportResult[];
  pending: PendingFigmaImportRecovery[];
}

export class FigmaImportError extends Error {
  readonly code: "invalid-input" | "conflict" | "corrupt" | "credential" | "upstream" | "version-drift" | "failed";

  constructor(code: FigmaImportError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FigmaImportError";
    this.code = code;
  }
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(value: unknown, label: string, fields?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FigmaImportError("invalid-input", `${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (fields && Object.keys(result).some((field) => !fields.includes(field))) {
    throw new FigmaImportError("invalid-input", `${label} contains an unexpected field`);
  }
  return result;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > maxBytes) {
    throw new FigmaImportError("invalid-input", `${label} is invalid`);
  }
  return value.trim();
}

function anchorCoordinate(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > MAX_ANCHOR_COORDINATE) {
    throw new FigmaImportError("invalid-input", `${label} is invalid`);
  }
  return value as number;
}

function prepareRequest(projectIdValue: string, input: FigmaImportInput): StoredFigmaImportRequest {
  if (typeof projectIdValue !== "string" || !PROJECT_ID.test(projectIdValue)) {
    throw new FigmaImportError("invalid-input", "Figma import Project id is invalid");
  }
  const record = exactRecord(input, "Figma import", [
    "schemaVersion", "idempotencyKey", "url", "nodeIds", "depth", "anchor", "rightsAcknowledged",
  ]);
  if (record.schemaVersion !== FIGMA_IMPORT_SCHEMA_VERSION || record.rightsAcknowledged !== true
    || typeof record.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(record.idempotencyKey)) {
    throw new FigmaImportError("invalid-input", "Figma import request is invalid");
  }
  const source = parseFigmaUrl(record.url, record.nodeIds as unknown[] | undefined);
  const depth = record.depth === undefined ? DEFAULT_DEPTH : record.depth;
  if (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > MAX_DEPTH) {
    throw new FigmaImportError("invalid-input", `Figma import depth must be between 1 and ${MAX_DEPTH}`);
  }
  const rawAnchor = exactRecord(record.anchor, "Figma import anchor", ["x", "y"]);
  return {
    schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
    idempotencyKey: record.idempotencyKey,
    projectId: projectIdValue,
    source,
    depth: depth as number,
    anchor: {
      x: anchorCoordinate(rawAnchor.x, "Figma import anchor.x"),
      y: anchorCoordinate(rawAnchor.y, "Figma import anchor.y"),
    },
    rightsAcknowledged: true,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function receiptId(key: string): string {
  return createHash("sha256").update(`dezin-figma-canvas-import-v1\0${key}`).digest("hex");
}

function jobsRoot(dataDir: string, projectId: string): string {
  return join(designRoot(dataDir, projectId), "transactions", "figma-imports");
}

function jobRoot(dataDir: string, projectId: string, key: string): string {
  return join(jobsRoot(dataDir, projectId), receiptId(key));
}

function jobPath(dataDir: string, projectId: string, key: string): string {
  return join(jobRoot(dataDir, projectId, key), "job.json");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const pending = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await durableWrite(pending, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
    await rename(pending, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

async function cleanupReadySnapshot(root: string): Promise<void> {
  await rm(join(root, "snapshot"), { recursive: true, force: true }).catch(() => {});
}

async function durableWrite(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRegularDirectory(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new FigmaImportError("corrupt", `${label} is missing`, { cause: error });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new FigmaImportError("corrupt", `${label} must be a regular directory`);
  }
}

async function ensureDurableDirectory(
  path: string,
  label: string,
  afterDurable?: (path: string, parent: string) => void | Promise<void>,
): Promise<void> {
  const parent = dirname(path);
  await assertRegularDirectory(parent, `${label} parent`);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertRegularDirectory(path, label);
  if (created) {
    await syncDirectory(parent);
    await afterDurable?.(path, parent);
  }
}

async function exactFile(
  path: string,
  expected?: { bytes: number; sha256: string },
  maxBytes = 16 * 1024 * 1024,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const limit = expected?.bytes ?? maxBytes;
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit
      || (expected && before.size !== expected.bytes)) {
      throw new FigmaImportError("corrupt", "Figma import artifact is not an exact regular file");
    }
    const buffer = Buffer.allocUnsafe(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (bytesRead !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino || pathAfter.size !== before.size) {
      throw new FigmaImportError("corrupt", "Figma import artifact changed while being read");
    }
    const bytes = buffer.subarray(0, bytesRead);
    if (expected && createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new FigmaImportError("corrupt", "Figma import artifact failed integrity verification");
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof FigmaImportError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new FigmaImportError("corrupt", "Figma import artifact may not be a symlink", { cause: error });
    }
    throw new FigmaImportError("corrupt", "Figma import artifact is missing or corrupt", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishAcceptedJob(root: string, job: StoredFigmaImportJob): Promise<boolean> {
  const parent = dirname(root);
  await assertRegularDirectory(parent, "Figma import Jobs authority root");
  const pending = join(parent, `.${basename(root)}.${randomUUID()}.tmp`);
  try {
    await mkdir(pending, { mode: 0o700 });
    await durableWrite(join(pending, "job.json"), Buffer.from(`${JSON.stringify(job, null, 2)}\n`), 0o600);
    await syncDirectory(pending);
    try {
      await rename(pending, root);
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code))) {
        return false;
      }
      throw error;
    }
    await syncDirectory(parent);
    return true;
  } finally {
    await rm(pending, { recursive: true, force: true }).catch(() => {});
  }
}

async function readJob(path: string, expectedProjectId: string): Promise<StoredFigmaImportJob | null> {
  let value: unknown;
  try {
    const root = dirname(path);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new FigmaImportError("corrupt", "Figma import receipt root is not a regular directory");
    }
    value = JSON.parse((await exactFile(path, undefined, 2 * 1024 * 1024)).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new FigmaImportError("corrupt", "Figma import Job is corrupt", { cause: error });
  }
  return validateStoredJob(value, path, expectedProjectId);
}

function storedRecord(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FigmaImportError("corrupt", `${label} is corrupt`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || Object.keys(record).some((field) => !fields.includes(field))) {
    throw new FigmaImportError("corrupt", `${label} schema is corrupt`);
  }
  return record;
}

function storedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new FigmaImportError("corrupt", `${label} is corrupt`);
  }
  return value;
}

function storedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new FigmaImportError("corrupt", `${label} is corrupt`);
  return value.map((item) => storedText(item, label, 4_096));
}

function validateStoredRequest(value: unknown): StoredFigmaImportRequest {
  const request = storedRecord(value, "Stored Figma import request", [
    "schemaVersion", "idempotencyKey", "projectId", "source", "depth", "anchor", "rightsAcknowledged",
  ]);
  const idempotencyKey = storedText(request.idempotencyKey, "Stored Figma import idempotencyKey", 160);
  const projectId = storedText(request.projectId, "Stored Figma import Project id", 128);
  const anchor = storedRecord(request.anchor, "Stored Figma import anchor", ["x", "y"]);
  if (request.schemaVersion !== FIGMA_IMPORT_SCHEMA_VERSION || !IDEMPOTENCY_KEY.test(idempotencyKey)
    || !PROJECT_ID.test(projectId)
    || request.rightsAcknowledged !== true || !Number.isSafeInteger(request.depth)
    || (request.depth as number) < 1 || (request.depth as number) > MAX_DEPTH
    || !Number.isSafeInteger(anchor.x) || Math.abs(anchor.x as number) > MAX_ANCHOR_COORDINATE
    || !Number.isSafeInteger(anchor.y) || Math.abs(anchor.y as number) > MAX_ANCHOR_COORDINATE) {
    throw new FigmaImportError("corrupt", "Stored Figma import request is corrupt");
  }
  const sourceRecord = storedRecord(request.source, "Stored Figma import source", [
    "fileType", "fileKey", "branchKey", "fileName", "nodeIds", "requestedVersionId", "normalizedUrl",
  ]);
  if (sourceRecord.requestedVersionId !== null || typeof sourceRecord.normalizedUrl !== "string"
    || !Array.isArray(sourceRecord.nodeIds)) {
    throw new FigmaImportError("corrupt", "Stored Figma import source is corrupt");
  }
  let source: ParsedFigmaUrl;
  try {
    source = parseFigmaUrl(sourceRecord.normalizedUrl, sourceRecord.nodeIds);
  } catch (error) {
    throw new FigmaImportError("corrupt", "Stored Figma import source is corrupt", { cause: error });
  }
  if (!isDeepStrictEqual(source, sourceRecord)) {
    throw new FigmaImportError("corrupt", "Stored Figma import source diverges from its normalized URL");
  }
  return {
    schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
    idempotencyKey,
    projectId,
    source,
    depth: request.depth as number,
    anchor: { x: anchor.x as number, y: anchor.y as number },
    rightsAcknowledged: true,
  };
}

function validateStoredSnapshot(value: unknown, importId: string): StoredSnapshot {
  const record = storedRecord(value, "Stored Figma snapshot", [
    "fileName", "resolvedVersion", "editorType", "role", "linkAccess", "incomplete", "warnings",
    "tokenAuthority", "credential", "payloads",
  ]);
  const nullableText = (candidate: unknown, label: string) => candidate === null
    ? null
    : storedText(candidate, label, 1_024);
  const credential = storedRecord(record.credential, "Stored Figma credential provenance", ["mode", "subject"]);
  if (credential.mode !== "personal-access-token" || typeof credential.subject !== "string"
    || !/^pat-[a-f0-9]{16}$/.test(credential.subject)
    || !["figma-variables-exact", "style-values-inferred", "not-applicable"].includes(String(record.tokenAuthority))
    || !Array.isArray(record.payloads) || record.payloads.length < 5 || record.payloads.length > 18) {
    throw new FigmaImportError("corrupt", "Stored Figma snapshot is corrupt");
  }
  const ids = nodeIds(importId);
  const expected = new Map<string, { kind: FigmaImportArtifactManifest["kind"]; mimeType: string; nodeId: string | null }>([
    ["raw/file.json", { kind: "raw-file", mimeType: "application/json", nodeId: null }],
    ["raw/variables.json", { kind: "raw-variables", mimeType: "application/json", nodeId: null }],
    ["derived/Design.md", { kind: "design-document", mimeType: "text/markdown", nodeId: ids.design }],
    ["derived/tokens.json", { kind: "tokens", mimeType: "application/json", nodeId: ids.tokens }],
    ["derived/components.json", { kind: "components", mimeType: "application/json", nodeId: ids.components }],
    ["derived/layout.json", { kind: "layout", mimeType: "application/json", nodeId: ids.layout }],
  ]);
  for (let index = 0; index < 12; index += 1) {
    expected.set(
      `derived/references/reference-frame-${String(index + 1).padStart(3, "0")}.png`,
      { kind: "reference-render", mimeType: "image/png", nodeId: ids.reference(index) },
    );
  }
  const seen = new Set<string>();
  const payloads = record.payloads.map((value): StoredSnapshot["payloads"][number] => {
    const payload = storedRecord(value, "Stored Figma snapshot artifact", [
      "kind", "path", "mimeType", "sha256", "bytes", "nodeId",
    ]);
    const path = storedText(payload.path, "Stored Figma snapshot artifact path", 128);
    const authority = expected.get(path);
    if (!authority || seen.has(path) || payload.kind !== authority.kind || payload.mimeType !== authority.mimeType
      || payload.nodeId !== authority.nodeId || typeof payload.sha256 !== "string" || !SHA256.test(payload.sha256)
      || !Number.isSafeInteger(payload.bytes) || (payload.bytes as number) < 1
      || (payload.bytes as number) > 16 * 1024 * 1024) {
      throw new FigmaImportError("corrupt", "Stored Figma snapshot artifact authority is corrupt");
    }
    seen.add(path);
    return {
      kind: authority.kind,
      path,
      mimeType: authority.mimeType,
      sha256: payload.sha256,
      bytes: payload.bytes as number,
      nodeId: authority.nodeId,
    };
  });
  for (const required of [
    "raw/file.json", "derived/Design.md", "derived/tokens.json", "derived/components.json", "derived/layout.json",
  ]) {
    if (!seen.has(required)) throw new FigmaImportError("corrupt", "Stored Figma snapshot is incomplete");
  }
  const references = payloads.filter((artifact) => artifact.kind === "reference-render");
  let previousReferenceIndex = 0;
  let totalReferenceBytes = 0;
  for (const reference of references) {
    const match = /^derived\/references\/reference-frame-(\d{3})\.png$/.exec(reference.path);
    const referenceIndex = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(referenceIndex) || referenceIndex < 1 || referenceIndex > 12
      || referenceIndex <= previousReferenceIndex) {
      throw new FigmaImportError("corrupt", "Stored Figma reference render sequence is corrupt");
    }
    previousReferenceIndex = referenceIndex;
    totalReferenceBytes += reference.bytes;
    if (totalReferenceBytes > MAX_TOTAL_REFERENCE_RENDER_BYTES) {
      throw new FigmaImportError("corrupt", "Stored Figma reference render byte budget is corrupt");
    }
  }
  return {
    fileName: storedText(record.fileName, "Stored Figma snapshot fileName", 1_024),
    resolvedVersion: storedText(record.resolvedVersion, "Stored Figma snapshot Version", 256),
    editorType: nullableText(record.editorType, "Stored Figma snapshot editorType"),
    role: nullableText(record.role, "Stored Figma snapshot role"),
    linkAccess: nullableText(record.linkAccess, "Stored Figma snapshot linkAccess"),
    incomplete: storedStringArray(record.incomplete, "Stored Figma snapshot incomplete diagnostic"),
    warnings: storedStringArray(record.warnings, "Stored Figma snapshot warning"),
    tokenAuthority: record.tokenAuthority as StoredSnapshot["tokenAuthority"],
    credential: { mode: "personal-access-token", subject: credential.subject },
    payloads,
  };
}

function validateStoredJob(value: unknown, path: string, expectedProjectId: string): StoredFigmaImportJob {
  const record = storedRecord(value, "Stored Figma import Job", [
    "schemaVersion", "id", "importId", "projectId", "requestHash", "request", "status", "completedPhase",
    "snapshot", "canvasRevision", "error", "createdAt", "updatedAt",
  ]);
  const request = validateStoredRequest(record.request);
  const id = storedText(record.id, "Stored Figma import Job id", 128);
  const importId = storedText(record.importId, "Stored Figma import id", 128);
  const projectId = storedText(record.projectId, "Stored Figma import Project id", 128);
  const phase = record.completedPhase as FigmaImportPhase;
  const status = record.status as StoredFigmaImportJob["status"];
  if (record.schemaVersion !== FIGMA_IMPORT_SCHEMA_VERSION || !/^figma-job-[A-Fa-f0-9-]{36}$/.test(id)
    || !/^figma-[A-Fa-f0-9-]{36}$/.test(importId) || !PROJECT_ID.test(projectId)
    || projectId !== expectedProjectId || request.projectId !== projectId
    || typeof record.requestHash !== "string" || !SHA256.test(record.requestHash)
    || record.requestHash !== hash(request) || basename(dirname(path)) !== receiptId(request.idempotencyKey)
    || !["running", "ready", "failed"].includes(status)
    || !["accepted", "snapshot-staged", "artifacts-imported", "ready"].includes(phase)
    || (status === "ready") !== (phase === "ready")
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < (record.createdAt as number)
    || (record.error !== null && (typeof record.error !== "string" || Buffer.byteLength(record.error, "utf8") > 64 * 1024))) {
    throw new FigmaImportError("corrupt", "Stored Figma import Job is corrupt");
  }
  const snapshot = record.snapshot === null ? null : validateStoredSnapshot(record.snapshot, importId);
  const canvasRevision = record.canvasRevision;
  if ((phase === "accepted") !== (snapshot === null)
    || (["accepted", "snapshot-staged"].includes(phase) && canvasRevision !== null)
    || (["artifacts-imported", "ready"].includes(phase)
      && (!Number.isSafeInteger(canvasRevision) || (canvasRevision as number) < 1))) {
    throw new FigmaImportError("corrupt", "Stored Figma import phase authority is corrupt");
  }
  return {
    schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
    id,
    importId,
    projectId,
    requestHash: record.requestHash,
    request,
    status,
    completedPhase: phase,
    snapshot,
    canvasRevision: canvasRevision as number | null,
    error: record.error as string | null,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function processStartIdentity(pid: number): Promise<string> {
  const result = await execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    timeout: 2_000,
    maxBuffer: 8_192,
  });
  const identity = result.stdout.trim();
  if (!identity || Buffer.byteLength(identity, "utf8") > 256) {
    throw new FigmaImportError("failed", "Could not establish a stable process identity for the Figma import lease");
  }
  return identity;
}

async function processMatchesLeaseOwner(owner: { pid: number; processStartIdentity: string }): Promise<boolean> {
  if (!processIsAlive(owner.pid)) return false;
  try {
    return await processStartIdentity(owner.pid) === owner.processStartIdentity;
  } catch {
    // If process identity cannot be inspected, preserving a live owner's lease is fail-safe.
    return true;
  }
}

interface ImportLeaseOwner {
  pid: number;
  nonce: string;
  createdAt: number;
  processStartIdentity: string;
}

async function readLeaseOwner(ticket: string): Promise<ImportLeaseOwner> {
  let value: unknown;
  try {
    value = JSON.parse((await exactFile(ticket, undefined, 4_096)).toString("utf8"));
  } catch (error) {
    throw new FigmaImportError("corrupt", "Figma import lease owner is missing or corrupt", { cause: error });
  }
  const record = storedRecord(value, "Figma import lease owner", ["pid", "nonce", "createdAt", "processStartIdentity"]);
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1
    || typeof record.nonce !== "string" || !/^[a-f0-9-]{36}$/i.test(record.nonce)
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 1
    || typeof record.processStartIdentity !== "string" || !record.processStartIdentity
    || Buffer.byteLength(record.processStartIdentity as string, "utf8") > 256) {
    throw new FigmaImportError("corrupt", "Figma import lease owner is corrupt");
  }
  return record as unknown as ImportLeaseOwner;
}

function causedByFileCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if ("code" in current && current.code === code) return true;
    current = current.cause;
  }
  return false;
}

async function readLeaseOwnerIfPresent(ticket: string): Promise<ImportLeaseOwner | null> {
  try {
    return await readLeaseOwner(ticket);
  } catch (error) {
    // A normal predecessor may unlink after queue enumeration but before or during the exact
    // fd read. Only disappearance is a rescan; an entry that still exists but is malformed
    // remains a hard corruption failure.
    if (causedByFileCode(error, "ENOENT")) return null;
    throw error;
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The Figma import was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface LeaseTicket {
  number: number;
  name: string;
  path: string;
}

async function leaseTickets(queueRoot: string): Promise<LeaseTicket[]> {
  const entries = await readdir(queueRoot, { withFileTypes: true });
  if (entries.length > MAX_LEASE_DIRECTORY_ENTRIES) {
    throw new FigmaImportError("corrupt", "Figma import lease directory exceeds its entry budget");
  }
  const tickets: LeaseTicket[] = [];
  for (const entry of entries) {
    const match = LEASE_TICKET.exec(entry.name);
    if (match === null) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new FigmaImportError("corrupt", "Figma import lease ticket is not a regular file");
    }
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LEASE_TICKET) {
      throw new FigmaImportError("corrupt", "Figma import lease ticket number is corrupt");
    }
    tickets.push({ number, name: entry.name, path: join(queueRoot, entry.name) });
  }
  if (tickets.length > MAX_LEASE_QUEUE_ENTRIES) {
    throw new FigmaImportError("corrupt", "Figma import lease queue exceeds its ticket budget");
  }
  return tickets.sort((left, right) => left.number - right.number);
}

async function cleanDeadPendingLeaseOwners(queueRoot: string): Promise<void> {
  const entries = await readdir(queueRoot, { withFileTypes: true });
  if (entries.length > MAX_LEASE_DIRECTORY_ENTRIES) {
    throw new FigmaImportError("corrupt", "Figma import lease directory exceeds its entry budget");
  }
  let changed = false;
  for (const entry of entries) {
    if (!LEASE_PENDING.test(entry.name)) continue;
    const path = join(queueRoot, entry.name);
    if (entry.isDirectory()) {
      throw new FigmaImportError("corrupt", "Figma import pending lease path is an unexpected directory");
    }
    let owner: ImportLeaseOwner | null;
    try {
      owner = await readLeaseOwnerIfPresent(path);
    } catch {
      // A pending file is not authority until hard-linked as a numbered ticket. A concurrently
      // publishing owner may still be writing it. Once a short grace has elapsed, unlinking this
      // unique non-authority path can only make that publisher fail safely; it cannot steal a lease.
      const info = await lstat(path).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs >= MALFORMED_PENDING_GRACE_MS) {
        await rm(path, { force: true });
        changed = true;
      }
      continue;
    }
    if (owner !== null && !(await processMatchesLeaseOwner(owner))) {
      await rm(path, { force: true });
      changed = true;
    }
  }
  if (changed) await syncDirectory(queueRoot);
}

async function withFilesystemImportLease<T>(
  jobFile: string,
  signal: AbortSignal | undefined,
  afterOwnerDurable: (() => void | Promise<void>) | undefined,
  afterObservedPredecessor: (() => void | Promise<void>) | undefined,
  afterProcessIdentityCheck: ((pid: number) => void | Promise<void>) | undefined,
  afterDirectoryDurable: ((path: string, parent: string) => void | Promise<void>) | undefined,
  operation: (assertLease: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const receiptRoot = dirname(jobFile);
  const parent = dirname(receiptRoot);
  const queueRoot = join(parent, `.${basename(receiptRoot)}.lease-queue`);
  const nonce = randomUUID();
  const owner: ImportLeaseOwner = {
    pid: process.pid,
    nonce,
    createdAt: Date.now(),
    processStartIdentity: await processStartIdentity(process.pid),
  };
  await ensureDurableDirectory(parent, "Figma import Jobs authority root", afterDirectoryDurable);
  await ensureDurableDirectory(queueRoot, "Figma import lease queue", afterDirectoryDurable);
  await cleanDeadPendingLeaseOwners(queueRoot);
  const pending = join(queueRoot, `.pending-${nonce}`);
  await durableWrite(pending, Buffer.from(`${JSON.stringify(owner)}\n`), 0o600);
  await syncDirectory(queueRoot);
  await afterOwnerDurable?.();
  let ownTicket: LeaseTicket | null = null;
  try {
    while (ownTicket === null) {
      throwIfAborted(signal);
      const tickets = await leaseTickets(queueRoot);
      const next = (tickets.at(-1)?.number ?? 0) + 1;
      if (!Number.isSafeInteger(next) || next > MAX_LEASE_TICKET) {
        throw new FigmaImportError("failed", "Figma import lease ticket space is exhausted");
      }
      const name = `ticket-${String(next).padStart(16, "0")}`;
      const path = join(queueRoot, name);
      try {
        await link(pending, path);
        await syncDirectory(queueRoot);
        ownTicket = { number: next, name, path };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    await rm(pending, { force: true });
    await syncDirectory(queueRoot);

    const assertLease = async () => {
      throwIfAborted(signal);
      const current = await readLeaseOwner(ownTicket!.path);
      if (current.nonce !== nonce || current.pid !== process.pid
        || current.processStartIdentity !== owner.processStartIdentity) {
        throw new FigmaImportError("corrupt", "Figma import lease ownership changed");
      }
      const first = (await leaseTickets(queueRoot))[0];
      if (first?.name !== ownTicket!.name) {
        throw new FigmaImportError("corrupt", "Figma import lease is not the active fenced ticket");
      }
    };

    let verifiedPredecessor = { name: "", nonce: "", checkedAt: 0 };
    while (true) {
      throwIfAborted(signal);
      const first = (await leaseTickets(queueRoot))[0];
      if (first === undefined) {
        throw new FigmaImportError("corrupt", "Figma import lease queue lost its owner ticket");
      }
      if (first.name === ownTicket.name) break;
      await afterObservedPredecessor?.();
      const current = await readLeaseOwnerIfPresent(first.path);
      if (current === null) continue;
      const now = Date.now();
      if (verifiedPredecessor.name === first.name && verifiedPredecessor.nonce === current.nonce
        && now - verifiedPredecessor.checkedAt < LIVE_OWNER_IDENTITY_CACHE_MS && processIsAlive(current.pid)) {
        await abortableDelay(LIVE_OWNER_POLL_MS, signal);
        continue;
      }
      const matches = await processMatchesLeaseOwner(current);
      await afterProcessIdentityCheck?.(current.pid);
      if (matches) {
        verifiedPredecessor = { name: first.name, nonce: current.nonce, checkedAt: now };
        await abortableDelay(LIVE_OWNER_POLL_MS, signal);
        continue;
      }
      // Our higher ticket remains present while this unlink happens. New contenders therefore
      // receive a still-higher number, so this dead lower number cannot be reused (no ABA).
      await rm(first.path, { force: true });
      await syncDirectory(queueRoot);
    }
    await assertLease();
    return await operation(assertLease);
  } finally {
    try {
      if (ownTicket !== null) {
        const current = await readLeaseOwner(ownTicket.path);
        if (current.nonce !== nonce || current.pid !== process.pid
          || current.processStartIdentity !== owner.processStartIdentity) {
          throw new FigmaImportError("corrupt", "Figma import lease ownership changed before release");
        }
        await rm(ownTicket.path);
        await syncDirectory(queueRoot);
      }
    } finally {
      await rm(pending, { force: true }).catch(() => {});
    }
  }
}

interface MetadataFence {
  version: string;
}

function metadataFence(value: unknown, expectedFileKey: string): MetadataFence {
  try {
    const root = exactRecord(value, "Figma metadata");
    const file = exactRecord(root.file, "Figma metadata file");
    const version = boundedString(file.version, "Figma metadata version", 256);
    if (file.key !== undefined
      && boundedString(file.key, "Figma metadata file key", 128) !== expectedFileKey) {
      throw new FigmaImportError("upstream", "Figma metadata identity does not match the requested file");
    }
    return { version };
  } catch (error) {
    if (error instanceof FigmaImportError && error.code === "upstream") throw error;
    throw new FigmaImportError("upstream", "Figma metadata response is invalid");
  }
}

function responseVersion(value: unknown, source: ParsedFigmaUrl): string {
  try {
    const response = exactRecord(value, "Figma File response");
    if (source.branchKey !== null) {
      const mainFileKey = boundedString(response.mainFileKey, "Figma branch response mainFileKey", 128);
      if (mainFileKey !== source.fileKey) {
        throw new FigmaImportError("upstream", "Figma branch response does not belong to the requested main file");
      }
    }
    return boundedString(response.version, "Figma File response version", 256);
  } catch (error) {
    if (error instanceof FigmaImportError && error.code === "upstream") throw error;
    throw new FigmaImportError("upstream", "Figma File response is invalid");
  }
}

function responseEditorType(value: unknown): string {
  try {
    return boundedString(exactRecord(value, "Figma File response").editorType, "Figma editorType", 128).toLowerCase();
  } catch {
    throw new FigmaImportError("upstream", "Figma File response is invalid");
  }
}

function sameFence(left: MetadataFence, right: MetadataFence): boolean {
  return left.version === right.version;
}

function credentialCanaries(token: string): string[] {
  const encoded = Buffer.from(token).toString("base64");
  return [...new Set([token, encoded, encodeURIComponent(token), encodeURIComponent(encoded)])];
}

function rejectCredentialMaterial(values: readonly string[], credential: ResolvedFigmaCredential): void {
  const canaries = credentialCanaries(credential.token);
  if (values.some((value) => canaries.some((canary) => value.includes(canary)))) {
    throw new FigmaImportError("upstream", "Figma response contained credential material and was rejected");
  }
}

async function requiredCredential(
  provider: ImportFigmaDesignProjectOptions["credentialProvider"],
): Promise<ResolvedFigmaCredential> {
  const credential = await provider();
  if (credential === null) {
    throw new FigmaImportError(
      "credential",
      "Figma access is not configured. Add a Figma personal access token in Dezin or set FIGMA_ACCESS_TOKEN.",
    );
  }
  return credential;
}

function rejectRequestCredentialMaterial(
  request: StoredFigmaImportRequest,
  credential: ResolvedFigmaCredential,
): void {
  const persistedRequest = JSON.stringify(request);
  const canaries = credentialCanaries(credential.token);
  if (canaries.some((canary) => persistedRequest.includes(canary))) {
    throw new FigmaImportError("invalid-input", "Figma import request contains credential material and was rejected");
  }
}

async function fetchVersionFencedSnapshot(
  options: ImportFigmaDesignProjectOptions,
  request: StoredFigmaImportRequest,
  resolvedCredential?: ResolvedFigmaCredential,
) {
  const credential = resolvedCredential ?? await requiredCredential(options.credentialProvider);
  const fileKey = request.source.branchKey ?? request.source.fileKey;
  rejectCredentialMaterial([fileKey], credential);
  for (let round = 0; round < 2; round += 1) {
    const meta0 = metadataFence(await options.client.getMetadata({
      fileKey,
      credential,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }), fileKey);
    rejectCredentialMaterial([meta0.version], credential);
    const file = await options.client.getFileVersion({
      fileKey,
      version: meta0.version,
      nodeIds: request.source.nodeIds,
      depth: request.depth,
      branchData: request.source.branchKey !== null,
      credential,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (responseVersion(file, request.source) !== meta0.version) {
      if (round === 0) continue;
      throw new FigmaImportError("version-drift", "Figma file changed while its exact Version was being imported");
    }
    const editorType = responseEditorType(file);
    const variables = editorType === "figma"
      ? await options.client.getLocalVariables({
        fileKey,
        credential,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      : { kind: "unavailable" as const, status: 404 as const, reason: "Variables are not applicable to this Figma editor type." };
    let normalized: NormalizedFigmaImport;
    try {
      normalized = normalizeFigmaImport({ source: request.source, file, variables, depthLimited: true });
    } catch {
      // Normalizer labels can be derived from hostile upstream object keys. Never let those
      // labels (or a cause carrying them) cross the credential boundary into Job or HTTP state.
      throw new FigmaImportError("upstream", "Figma response could not be normalized safely");
    }
    if (normalized.visualCandidates.length > 0 && options.client.getNodeRenders) {
      const renderResult = await options.client.getNodeRenders({
        fileKey,
        version: meta0.version,
        nodeIds: normalized.visualCandidates.map((candidate) => candidate.nodeId),
        credential,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const expected = new Set(normalized.visualCandidates.map((candidate) => candidate.nodeId));
      const seen = new Set<string>();
      const renderByNodeId = new Map<string, (typeof renderResult.renders)[number]>();
      let totalBytes = 0;
      let totalPixels = 0;
      for (const render of renderResult.renders) {
        if (!expected.has(render.nodeId) || seen.has(render.nodeId)
          || !Buffer.isBuffer(render.png) || render.png.length < 45
          || render.png.length > MAX_REFERENCE_RENDER_BYTES
          || !Number.isSafeInteger(render.width) || !Number.isSafeInteger(render.height)
          || render.width < 1 || render.height < 1 || render.width > 8_192 || render.height > 8_192
          || render.width * render.height > 32_000_000) {
          throw new FigmaImportError("upstream", "Figma rendered reference response is invalid");
        }
        let sanitized: ReturnType<typeof sanitizeFigmaPng>;
        try {
          sanitized = sanitizeFigmaPng(render.png);
        } catch {
          throw new FigmaImportError("upstream", "Figma rendered reference response is invalid");
        }
        try {
          await inspectBoundedPngImage(sanitized.bytes, options.signal);
        } catch (error) {
          if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
          throw new FigmaImportError("upstream", "Figma rendered reference pixels are invalid", { cause: error });
        }
        if (sanitized.width !== render.width || sanitized.height !== render.height
          || containsEphemeralRemoteResourceBytes(sanitized.bytes)) {
          throw new FigmaImportError("upstream", "Figma rendered reference response is invalid");
        }
        totalBytes += sanitized.bytes.length;
        totalPixels += sanitized.pixels;
        if (totalBytes > MAX_TOTAL_REFERENCE_RENDER_BYTES) {
          throw new FigmaImportError("upstream", "Figma rendered references exceed the total byte budget");
        }
        if (totalPixels > MAX_TOTAL_REFERENCE_RENDER_PIXELS) {
          throw new FigmaImportError("upstream", "Figma rendered references exceed the total pixel budget");
        }
        seen.add(render.nodeId);
        renderByNodeId.set(render.nodeId, { ...render, png: sanitized.bytes });
      }
      for (const id of renderResult.unavailableNodeIds) {
        if (!expected.has(id) || seen.has(id)) {
          throw new FigmaImportError("upstream", "Figma rendered reference response is invalid");
        }
        seen.add(id);
      }
      if (seen.size !== expected.size) {
        throw new FigmaImportError("upstream", "Figma rendered reference response is incomplete");
      }
      const unavailable = new Set(renderResult.unavailableNodeIds);
      for (const candidate of normalized.visualCandidates) {
        const render = renderByNodeId.get(candidate.nodeId);
        if (!render) continue;
        normalized.referenceRenders.push({
          nodeId: render.nodeId,
          candidateIndex: candidate.referenceIndex,
          referencePath: candidate.referencePath,
          width: render.width,
          height: render.height,
          payload: { bytes: render.png, sha256: createHash("sha256").update(render.png).digest("hex") },
        });
      }
      finalizeFigmaVisualReferences(normalized, new Set(renderByNodeId.keys()), unavailable);
      if (renderResult.unavailableNodeIds.length > 0) {
        normalized.incomplete.push("visual-reference-unavailable");
        normalized.warnings.push(
          `${renderResult.unavailableNodeIds.length} Figma visual reference render(s) were unavailable.`,
        );
      }
    } else if (normalized.visualCandidates.length > 0) {
      finalizeFigmaVisualReferences(
        normalized,
        new Set(),
        new Set(normalized.visualCandidates.map((candidate) => candidate.nodeId)),
      );
      normalized.incomplete.push("visual-reference-unavailable");
      normalized.warnings.push("Figma visual reference rendering is unavailable.");
    }
    const meta1 = metadataFence(await options.client.getMetadata({
      fileKey,
      credential,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }), fileKey);
    rejectCredentialMaterial([meta1.version], credential);
    if (!sameFence(meta0, meta1)) {
      if (round === 0) continue;
      throw new FigmaImportError("version-drift", "Figma file changed while its exact Version was being imported");
    }
    const canaries = credentialCanaries(credential.token);
    for (const artifact of [normalized.rawFile, normalized.rawVariables, normalized.designMarkdown,
      normalized.tokensJson, normalized.componentsJson, normalized.layoutJson,
      ...normalized.referenceRenders.map((render) => render.payload)]) {
      if (artifact && canaries.some((canary) => artifact.bytes.includes(Buffer.from(canary)))) {
        throw new FigmaImportError("upstream", "Figma response contained credential material and was rejected");
      }
    }
    return { normalized, credential };
  }
  throw new FigmaImportError("version-drift", "Figma file changed while its exact Version was being imported");
}

function nodeIds(importId: string) {
  const suffix = importId.slice("figma-".length);
  return {
    design: `figma-design-${suffix}`,
    tokens: `figma-tokens-${suffix}`,
    components: `figma-components-${suffix}`,
    layout: `figma-layout-${suffix}`,
    reference: (index: number) => `figma-reference-${String(index + 1).padStart(3, "0")}-${suffix}`,
  };
}

function snapshotPayloads(
  importId: string,
  normalized: NormalizedFigmaImport,
): Array<StoredSnapshot["payloads"][number] & { payload: FigmaNormalizedPayload }> {
  const ids = nodeIds(importId);
  const artifact = (
    kind: FigmaImportArtifactManifest["kind"],
    path: string,
    mimeType: string,
    nodeId: string | null,
    payload: FigmaNormalizedPayload,
  ): StoredSnapshot["payloads"][number] & { payload: FigmaNormalizedPayload } => ({
    kind, path, mimeType, nodeId, sha256: payload.sha256, bytes: payload.bytes.length, payload,
  });
  const values: Array<StoredSnapshot["payloads"][number] & { payload: FigmaNormalizedPayload }> = [
    artifact("raw-file", "raw/file.json", "application/json", null, normalized.rawFile),
    artifact("design-document", "derived/Design.md", "text/markdown", ids.design, normalized.designMarkdown),
    artifact("tokens", "derived/tokens.json", "application/json", ids.tokens, normalized.tokensJson),
    artifact("components", "derived/components.json", "application/json", ids.components, normalized.componentsJson),
    artifact("layout", "derived/layout.json", "application/json", ids.layout, normalized.layoutJson),
  ];
  for (const render of normalized.referenceRenders) {
    values.push(artifact(
      "reference-render",
      render.referencePath,
      "image/png",
      ids.reference(render.candidateIndex),
      render.payload,
    ));
  }
  if (normalized.rawVariables) {
    values.splice(1, 0, artifact(
      "raw-variables", "raw/variables.json", "application/json", null, normalized.rawVariables,
    ));
  }
  return values;
}

async function stageSnapshot(
  root: string,
  job: StoredFigmaImportJob,
  normalized: NormalizedFigmaImport,
  credential: ResolvedFigmaCredential,
  afterRename?: () => void | Promise<void>,
): Promise<StoredSnapshot> {
  const target = join(root, "snapshot");
  const pending = join(root, `.snapshot.${randomUUID()}.tmp`);
  const payloads = snapshotPayloads(job.importId, normalized);
  await assertRegularDirectory(root, "Figma import receipt root");
  const snapshot: StoredSnapshot = {
    fileName: normalized.fileName,
    resolvedVersion: normalized.resolvedVersion,
    editorType: normalized.editorType,
    role: normalized.role,
    linkAccess: normalized.linkAccess,
    incomplete: normalized.incomplete,
    warnings: normalized.warnings,
    tokenAuthority: normalized.tokenAuthority,
    credential: { mode: "personal-access-token", subject: credential.subject },
    payloads: payloads.map(({ payload: _payload, ...artifact }) => artifact),
  };
  const envelope: StoredSnapshotEnvelope = {
    schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
    importId: job.importId,
    projectId: job.projectId,
    requestHash: job.requestHash,
    snapshot,
  };
  const existing = await readStagedSnapshot(root, job).catch((error) => {
    if (error instanceof FigmaImportError && /missing/.test(error.message)) return null;
    throw error;
  });
  if (existing !== null) {
    if (!isDeepStrictEqual(existing, snapshot)) {
      throw new FigmaImportError("corrupt", "Existing staged Figma snapshot diverges from the fetched authority");
    }
    return existing;
  }
  try {
    await mkdir(pending, { recursive: true, mode: 0o700 });
    for (const artifact of payloads) {
      const path = join(pending, ...artifact.path.split("/"));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await durableWrite(path, artifact.payload.bytes, 0o600);
      await syncDirectory(dirname(path));
    }
    await durableWrite(
      join(pending, "snapshot.json"),
      Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`),
      0o600,
    );
    await syncDirectory(pending);
    try {
      await rename(pending, target);
      await syncDirectory(root);
      await afterRename?.();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) {
        throw error;
      }
      const concurrent = await readStagedSnapshot(root, job);
      if (concurrent === null || !isDeepStrictEqual(concurrent, snapshot)) {
        throw new FigmaImportError("corrupt", "Concurrent staged Figma snapshot diverges from authority");
      }
      return concurrent;
    }
  } finally {
    await rm(pending, { recursive: true, force: true }).catch(() => {});
  }
  return snapshot;
}

async function validateStoredVisualAuthority(
  root: string,
  artifacts: readonly StoredSnapshot["payloads"][number][],
  importId: string,
): Promise<void> {
  const layoutArtifact = artifacts.find((artifact) => artifact.kind === "layout");
  if (!layoutArtifact) throw new FigmaImportError("corrupt", "Stored Figma visual layout authority is missing");
  let candidates: unknown[];
  try {
    const layoutBytes = await exactFile(join(root, ...layoutArtifact.path.split("/")), layoutArtifact);
    const layout = storedRecord(JSON.parse(layoutBytes.toString("utf8")), "Stored Figma visual layout", [
      "schemaVersion", "selectedNodeIds", "selectedNodes", "candidates", "diagnostics",
    ]);
    if (layout.schemaVersion !== 1 || !Array.isArray(layout.candidates) || layout.candidates.length > 12) {
      throw new FigmaImportError("corrupt", "Stored Figma visual layout candidates are corrupt");
    }
    candidates = layout.candidates;
  } catch (error) {
    if (error instanceof FigmaImportError) throw error;
    throw new FigmaImportError("corrupt", "Stored Figma visual layout authority is corrupt", { cause: error });
  }

  const references = new Map(
    artifacts.filter((artifact) => artifact.kind === "reference-render")
      .map((artifact) => [artifact.path, artifact] as const),
  );
  const expectedReferencePaths = new Set<string>();
  const sourceNodeIds = new Set<string>();
  const ids = nodeIds(importId);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = storedRecord(candidates[index], "Stored Figma visual candidate", [
      "nodeId", "selectedNodeId", "name", "type", "depth", "geometry",
      "referenceIndex", "referencePath", "referenceAvailability",
    ]);
    const expectedPath = `derived/references/reference-frame-${String(index + 1).padStart(3, "0")}.png`;
    const available = candidate.referenceAvailability === "available";
    if (!isSafeFigmaApiNodeId(candidate.nodeId)
      || sourceNodeIds.has(candidate.nodeId) || candidate.referenceIndex !== index
      || candidate.referencePath !== expectedPath
      || (!available && candidate.referenceAvailability !== "unavailable")) {
      throw new FigmaImportError("corrupt", "Stored Figma visual candidate authority is corrupt");
    }
    sourceNodeIds.add(candidate.nodeId);
    const reference = references.get(expectedPath);
    if (available !== Boolean(reference) || (reference && reference.nodeId !== ids.reference(index))) {
      throw new FigmaImportError("corrupt", "Stored Figma visual availability diverges from reference authority");
    }
    if (reference) expectedReferencePaths.add(expectedPath);
  }
  if (expectedReferencePaths.size !== references.size) {
    throw new FigmaImportError("corrupt", "Stored Figma reference authority diverges from its visual layout");
  }

  let totalReferenceBytes = 0;
  let totalReferencePixels = 0;
  for (const artifact of artifacts) {
    if (artifact === layoutArtifact) continue;
    const bytes = await exactFile(join(root, ...artifact.path.split("/")), artifact);
    if (artifact.kind !== "reference-render") continue;
    let sanitized: ReturnType<typeof sanitizeFigmaPng>;
    try {
      sanitized = sanitizeFigmaPng(bytes);
    } catch (error) {
      throw new FigmaImportError("corrupt", "Stored Figma reference render is not a valid PNG authority", { cause: error });
    }
    try {
      await inspectBoundedPngImage(sanitized.bytes);
    } catch (error) {
      throw new FigmaImportError("corrupt", "Stored Figma reference render pixels are invalid", { cause: error });
    }
    if (!sanitized.bytes.equals(bytes) || containsEphemeralRemoteResourceBytes(bytes)) {
      throw new FigmaImportError("corrupt", "Stored Figma reference render contains non-visual authority");
    }
    totalReferenceBytes += bytes.length;
    totalReferencePixels += sanitized.pixels;
    if (totalReferenceBytes > MAX_TOTAL_REFERENCE_RENDER_BYTES
      || totalReferencePixels > MAX_TOTAL_REFERENCE_RENDER_PIXELS) {
      throw new FigmaImportError("corrupt", "Stored Figma reference render aggregate budget is corrupt");
    }
  }
}

async function readStagedSnapshot(root: string, job: StoredFigmaImportJob): Promise<StoredSnapshot | null> {
  const target = join(root, "snapshot");
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new FigmaImportError("corrupt", "Staged Figma snapshot is not a regular directory");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let snapshot: StoredSnapshot;
  try {
    const envelope = storedRecord(
      JSON.parse((await exactFile(join(target, "snapshot.json"), undefined, 2 * 1024 * 1024)).toString("utf8")),
      "Staged Figma snapshot envelope",
      ["schemaVersion", "importId", "projectId", "requestHash", "snapshot"],
    );
    if (envelope.schemaVersion !== FIGMA_IMPORT_SCHEMA_VERSION || envelope.importId !== job.importId
      || envelope.projectId !== job.projectId || envelope.requestHash !== job.requestHash) {
      throw new FigmaImportError("corrupt", "Staged Figma snapshot envelope diverges from its Job");
    }
    snapshot = validateStoredSnapshot(envelope.snapshot, job.importId);
  } catch (error) {
    if (error instanceof FigmaImportError) throw error;
    throw new FigmaImportError("corrupt", "Staged Figma snapshot metadata is corrupt", { cause: error });
  }
  await validateStoredVisualAuthority(target, snapshot.payloads, job.importId);
  return snapshot;
}

async function readSnapshotPayload(root: string, artifact: StoredSnapshot["payloads"][number]): Promise<Buffer> {
  const path = join(root, "snapshot", ...artifact.path.split("/"));
  return exactFile(path, artifact);
}

async function artifactImportItems(root: string, job: StoredFigmaImportJob): Promise<DesignCanvasAssetImportItem[]> {
  const snapshot = job.snapshot!;
  await validateStoredVisualAuthority(join(root, "snapshot"), snapshot.payloads, job.importId);
  const derived = snapshot.payloads.filter((artifact) => artifact.nodeId !== null);
  const { x, y } = job.request.anchor;
  const referenceStartY = y + 600;
  const items: DesignCanvasAssetImportItem[] = [];
  let referenceIndex = 0;
  for (let index = 0; index < derived.length; index += 1) {
    const artifact = derived[index]!;
    const bytes = await readSnapshotPayload(root, artifact);
    let geometry = { x: x + (index % 4) * 460, y: y + Math.floor(index / 4) * 600, width: 420, height: 560 };
    if (artifact.kind === "reference-render") {
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      const scale = Math.min(420 / width, 560 / height, 1);
      geometry = {
        x: x + (referenceIndex % 4) * 460,
        y: referenceStartY + Math.floor(referenceIndex / 4) * 600,
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      };
      referenceIndex += 1;
    }
    items.push({
      asset: {
        name: basename(artifact.path),
        mimeType: artifact.mimeType,
        base64: bytes.toString("base64"),
      },
      binding: {
        type: "create-node" as const,
        node: {
          id: artifact.nodeId!,
          kind: artifact.kind === "design-document" ? "document" as const
            : artifact.kind === "reference-render" ? "image" as const
              : "file" as const,
          name: basename(artifact.path),
          geometry,
        },
      },
    });
  }
  return items;
}

function finalManifest(job: StoredFigmaImportJob): FigmaImportManifest {
  const snapshot = job.snapshot!;
  return {
    schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
    importId: job.importId,
    projectId: job.projectId,
    source: {
      normalizedUrl: job.request.source.normalizedUrl,
      fileType: job.request.source.fileType,
      fileKey: job.request.source.fileKey,
      branchKey: job.request.source.branchKey,
      fileName: snapshot.fileName,
      requestedVersionId: null,
      resolvedVersion: snapshot.resolvedVersion,
      selectedNodeIds: job.request.source.nodeIds,
      depth: job.request.depth,
    },
    access: { editorType: snapshot.editorType, role: snapshot.role, linkAccess: snapshot.linkAccess },
    credential: snapshot.credential,
    tokenAuthority: snapshot.tokenAuthority,
    artifacts: snapshot.payloads,
    incomplete: snapshot.incomplete,
    warnings: snapshot.warnings,
    canvasRevision: job.canvasRevision!,
    createdAt: job.createdAt,
  };
}

async function publishImport(
  dataDir: string,
  root: string,
  job: StoredFigmaImportJob,
  afterRename?: () => void | Promise<void>,
  afterDirectoryDurable?: (path: string, parent: string) => void | Promise<void>,
): Promise<FigmaImportManifest> {
  const importsRoot = join(designRoot(dataDir, job.projectId), "imports");
  const target = join(importsRoot, job.importId);
  const pending = join(importsRoot, `.${job.importId}.${randomUUID()}.tmp`);
  const manifest = finalManifest(job);
  await ensureDurableDirectory(importsRoot, "Figma imports authority root", afterDirectoryDurable);
  try {
    const existing = await lstat(target);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new FigmaImportError("corrupt", "Published Figma import is not a regular directory");
    }
    return readPublishedManifest(target, job);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    await mkdir(pending, { mode: 0o700 });
    for (const artifact of job.snapshot!.payloads) {
      const bytes = await readSnapshotPayload(root, artifact);
      const path = join(pending, ...artifact.path.split("/"));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await durableWrite(path, bytes, 0o444);
      await syncDirectory(dirname(path));
    }
    await durableWrite(
      join(pending, "manifest.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      0o444,
    );
    await syncDirectory(pending);
    try {
      await rename(pending, target);
      await syncDirectory(importsRoot);
      await afterRename?.();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) {
        throw error;
      }
      return readPublishedManifest(target, job);
    }
  } finally {
    await rm(pending, { recursive: true, force: true }).catch(() => {});
  }
  return manifest;
}

async function readReadyManifest(dataDir: string, job: StoredFigmaImportJob): Promise<FigmaImportManifest> {
  const target = join(dataDir, "projects", job.projectId, "design", "imports", job.importId);
  return readPublishedManifest(target, job);
}

async function readPublishedManifest(target: string, job: StoredFigmaImportJob): Promise<FigmaImportManifest> {
  try {
    const root = await lstat(target);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new FigmaImportError("corrupt", "Published Figma import root is not a regular directory");
    }
  } catch (error) {
    if (error instanceof FigmaImportError) throw error;
    throw new FigmaImportError("corrupt", "Published Figma import root is missing or corrupt", { cause: error });
  }
  const path = join(target, "manifest.json");
  let manifest: FigmaImportManifest;
  try {
    manifest = JSON.parse((await exactFile(path)).toString("utf8")) as FigmaImportManifest;
  } catch (error) {
    throw new FigmaImportError("corrupt", "Ready Figma import manifest is missing or corrupt", { cause: error });
  }
  const expected = finalManifest(job);
  if (!isDeepStrictEqual(manifest, expected)) {
    throw new FigmaImportError("corrupt", "Ready Figma import manifest diverges from its Job authority");
  }
  await validateStoredVisualAuthority(target, expected.artifacts, job.importId);
  return manifest;
}

async function withFigmaProjectLease<T>(
  options: Pick<ImportFigmaDesignProjectOptions, "withProjectLease">,
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return options.withProjectLease
    ? options.withProjectLease(projectId, operation)
    : operation();
}

export async function importFigmaDesignProject(
  options: ImportFigmaDesignProjectOptions,
): Promise<FigmaImportResult> {
  const request = prepareRequest(options.projectId, options.input);
  const requestHash = hash(request);
  const path = jobPath(options.dataDir, request.projectId, request.idempotencyKey);
  return withFigmaProjectLease(options, request.projectId, async () => {
    // The target is existing Canvas authority. Validate it before credential
    // resolution or creation of any receipt/lease directories.
    await getDesignCanvas(options.dataDir, request.projectId);
    return withFilesystemImportLease(
      path,
      options.signal,
      options.testHooks?.afterLeaseOwnerDurable,
      options.testHooks?.afterLeaseObservedPredecessor,
      options.testHooks?.afterLeaseProcessIdentityCheck,
      options.testHooks?.afterAuthorityDirectoryDurable,
      async (assertLease) => {
        await assertLease();
        let existing = await readJob(path, request.projectId);
        if (existing && existing.requestHash !== requestHash) {
          throw new FigmaImportError(
            "conflict",
            "idempotencyKey is already bound to a different Figma import request",
          );
        }
        if (existing?.status === "ready") {
          const readyJob = existing;
          await assertLease();
          const manifest = await readReadyManifest(options.dataDir, readyJob);
          await assertLease();
          await cleanupReadySnapshot(dirname(path));
          const result = { manifest, reused: true };
          await options.finalizeUnderProjectLease?.(result);
          return result;
        }

        const timestamp = options.now?.() ?? Date.now();
        const candidate: StoredFigmaImportJob = {
          schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
          id: `figma-job-${randomUUID()}`,
          importId: `figma-${randomUUID()}`,
          projectId: request.projectId,
          requestHash,
          request,
          status: "running",
          completedPhase: "accepted",
          snapshot: null,
          canvasRevision: null,
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        let job: StoredFigmaImportJob;
        let resolvedCredential: ResolvedFigmaCredential | undefined;
        if (existing === null) {
          resolvedCredential = await requiredCredential(options.credentialProvider);
          rejectRequestCredentialMaterial(request, resolvedCredential);
          await assertLease();
          const published = await publishAcceptedJob(dirname(path), candidate);
          if (published) {
            job = candidate;
            await options.testHooks?.afterAcceptedJobPublished?.();
          } else {
            existing = await readJob(path, request.projectId);
            if (existing === null) {
              throw new FigmaImportError("corrupt", "Concurrent Figma import publication lost its Job");
            }
            if (existing.requestHash !== requestHash) {
              throw new FigmaImportError(
                "conflict",
                "idempotencyKey is already bound to a different Figma import request",
              );
            }
            job = existing;
          }
        } else {
          job = existing;
        }

        job.status = "running";
        job.error = null;
        job.updatedAt = timestamp;
        if (existing !== null) {
          await assertLease();
          await atomicJson(path, job);
        }

        let result: FigmaImportResult;
        try {
          if (job.completedPhase === "accepted") {
            const staged = await readStagedSnapshot(dirname(path), job);
            if (staged !== null) {
              job.snapshot = staged;
            } else {
              const fetched = await fetchVersionFencedSnapshot(options, request, resolvedCredential);
              await assertLease();
              job.snapshot = await stageSnapshot(
                dirname(path), job, fetched.normalized, fetched.credential, options.testHooks?.afterSnapshotRename,
              );
            }
            job.completedPhase = "snapshot-staged";
            job.updatedAt = options.now?.() ?? Date.now();
            await assertLease();
            await atomicJson(path, job);
            await options.testHooks?.afterPhase?.("snapshot-staged");
          }
          if (job.completedPhase === "snapshot-staged") {
            await assertLease();
            const imported = await ensureDesignCanvasAssetBatch(options.dataDir, job.projectId, {
              idempotencyKey: `${job.id}:artifacts`,
              requestHash: job.requestHash,
              items: await artifactImportItems(dirname(path), job),
            });
            job.canvasRevision = imported.canvas.revision;
            job.completedPhase = "artifacts-imported";
            job.updatedAt = options.now?.() ?? Date.now();
            await assertLease();
            await atomicJson(path, job);
            await options.testHooks?.afterPhase?.("artifacts-imported");
          }

          let manifest: FigmaImportManifest;
          if (job.completedPhase === "artifacts-imported") {
            await assertLease();
            manifest = await publishImport(
              options.dataDir,
              dirname(path),
              job,
              options.testHooks?.afterImportRename,
              options.testHooks?.afterAuthorityDirectoryDurable,
            );
            job.completedPhase = "ready";
            job.status = "ready";
            job.updatedAt = options.now?.() ?? Date.now();
            await assertLease();
            await atomicJson(path, job);
            await cleanupReadySnapshot(dirname(path));
            await Promise.resolve(options.testHooks?.afterPhase?.("ready")).catch(() => {});
          } else {
            manifest = await readReadyManifest(options.dataDir, job);
          }
          result = { manifest, reused: existing !== null };
        } catch (error) {
          if (options.testHooks?.simulateProcessCrash) throw error;
          if (error instanceof Error && error.name === "AbortError") throw error;
          await assertLease();
          job.status = "failed";
          job.error = error instanceof Error ? error.message : "Figma import failed";
          job.updatedAt = options.now?.() ?? Date.now();
          await atomicJson(path, job);
          if (error instanceof FigmaImportError) throw error;
          throw new FigmaImportError("failed", job.error, { cause: error });
        }
        await options.finalizeUnderProjectLease?.(result);
        return result;
      },
    );
  });
}

function recoveryInput(job: StoredFigmaImportJob): FigmaImportInput {
  return {
    schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
    idempotencyKey: job.request.idempotencyKey,
    url: job.request.source.normalizedUrl,
    depth: job.request.depth,
    anchor: { ...job.request.anchor },
    rightsAcknowledged: true,
  };
}

async function recoveryJobs(dataDir: string, projectId: string): Promise<StoredFigmaImportJob[]> {
  const root = jobsRoot(dataDir, projectId);
  let before;
  try {
    before = await lstat(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new FigmaImportError("corrupt", "Figma import recovery root is unavailable", { cause: error });
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new FigmaImportError("corrupt", "Figma import recovery root must be a regular directory");
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    throw new FigmaImportError("corrupt", "Figma import recovery root is unavailable", { cause: error });
  }
  if (entries.length > MAX_RECOVERY_RECEIPTS) {
    throw new FigmaImportError("corrupt", "Figma import recovery root exceeds its bounded receipt count");
  }
  const after = await lstat(root);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new FigmaImportError("corrupt", "Figma import recovery root changed while being read");
  }
  const jobs: StoredFigmaImportJob[] = [];
  for (const entry of entries.sort(lexical)) {
    if (entry.startsWith(".")) continue;
    if (!SHA256.test(entry)) {
      throw new FigmaImportError("corrupt", "Figma import recovery found an invalid receipt identity");
    }
    const job = await readJob(join(root, entry, "job.json"), projectId);
    if (job === null) throw new FigmaImportError("corrupt", "Figma import recovery receipt is missing its Job");
    jobs.push(job);
  }
  return jobs;
}

/**
 * Roll forward only receipts that already own a complete immutable snapshot.
 * Startup recovery never turns an accepted/no-snapshot Job into an implicit
 * network request or credential read.
 */
export async function recoverFigmaImports(
  options: RecoverFigmaImportsOptions,
): Promise<RecoverFigmaImportsResult> {
  const recovered: FigmaImportResult[] = [];
  const pending: PendingFigmaImportRecovery[] = [];
  for (const projectId of options.projectIds) for (const job of await recoveryJobs(options.dataDir, projectId)) {
    options.signal?.throwIfAborted();
    if (job.status !== "running") continue;
    if (job.completedPhase === "accepted") {
      const staged = await readStagedSnapshot(
        dirname(jobPath(options.dataDir, job.projectId, job.request.idempotencyKey)),
        job,
      );
      if (staged === null) {
        pending.push({
          jobId: job.id,
          importId: job.importId,
          projectId: job.projectId,
          idempotencyKey: job.request.idempotencyKey,
          reason: "snapshot-required",
        });
        continue;
      }
    }
    recovered.push(await importFigmaDesignProject({
      dataDir: options.dataDir,
      projectId: job.projectId,
      input: recoveryInput(job),
      client: options.client,
      credentialProvider: options.credentialProvider,
      ...(options.withProjectLease === undefined ? {} : { withProjectLease: options.withProjectLease }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  }
  return { recovered, pending };
}
