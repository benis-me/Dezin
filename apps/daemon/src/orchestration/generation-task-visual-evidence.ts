import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  RENDER_FRAME_NAME_LIMIT,
  generationTaskVisualEvidenceFrameStorageSegment,
  isExactRenderFrameCaptureViewport,
  type GenerationTaskSourceVisualEvidenceAuthority,
  type RenderFrameSpec,
} from "../../../../packages/core/src/index.ts";
import {
  readPngEvidenceFile,
  samePngEvidenceIdentity,
  type PngEvidenceIdentity,
} from "../png-evidence.ts";

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VIEWER_BRIDGE_TEXT_CONTROL = /[\u0000-\u001f\u007f]/;
const VIEWER_BRIDGE_FRAME_TEXT_LIMIT = 256;
const VIEWER_BRIDGE_BACKGROUND_LIMIT = 4_096;

export interface GenerationTaskVisualEvidenceOwner {
  projectId: string;
  workspaceId: string;
  planId: string;
  taskId: string;
  attempt: number;
  candidateCommitHash: string;
  candidateTreeHash: string;
  contextPackId: string;
  contextPackHash: string;
}

export interface GenerationTaskVisualEvidenceFrame extends RenderFrameSpec {
  frameAttemptId: string;
}

export interface GenerationTaskSourceVisualEvidenceCapture {
  scope: "source";
  sourceAttemptId: string;
  width: number;
  height: number;
}

export interface GenerationTaskVisualEvidenceDescriptor {
  protocol: "dezin.generation-task-visual-evidence.v1";
  owner: GenerationTaskVisualEvidenceOwner;
  frame: GenerationTaskVisualEvidenceFrame;
  round: number;
  mediaType: "image/png";
  sha256: string;
  byteLength: number;
  /** Relative, content-addressed storage locator. It is not an authorization-free URL. */
  storageKey: string;
}

export interface PersistGenerationTaskVisualEvidenceInput {
  dataDir: string;
  owner: GenerationTaskVisualEvidenceOwner;
  frame: GenerationTaskVisualEvidenceFrame;
  round: number;
  sourcePath: string;
  /** Byte and pixel identity fixed when this exact screenshot was captured and reviewed. */
  expectedIdentity: PngEvidenceIdentity;
}

export interface GenerationTaskSourceVisualEvidenceDescriptor {
  protocol: "dezin.generation-task-source-visual-evidence.v1";
  owner: GenerationTaskVisualEvidenceOwner;
  capture: GenerationTaskSourceVisualEvidenceCapture;
  sourceAuthority: GenerationTaskSourceVisualEvidenceAuthority;
  round: number;
  mediaType: "image/png";
  sha256: string;
  byteLength: number;
  /** Relative, content-addressed storage locator. It is not an authorization-free URL. */
  storageKey: string;
}

export interface PersistGenerationTaskSourceVisualEvidenceInput {
  dataDir: string;
  owner: GenerationTaskVisualEvidenceOwner;
  capture: GenerationTaskSourceVisualEvidenceCapture;
  /** Exact immutable Resource Revision supplied by Artifact run preparation. */
  sourceAuthority: GenerationTaskSourceVisualEvidenceAuthority;
  round: number;
  sourcePath: string;
  /** Byte and pixel identity fixed when this exact screenshot was captured and reviewed. */
  expectedIdentity: PngEvidenceIdentity;
}

export class GenerationTaskVisualEvidenceError extends Error {
  readonly failureClass = "storage" as const;

  constructor(message: string) {
    super(message);
    this.name = "GenerationTaskVisualEvidenceError";
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !OWNER_ID.test(value) || value === "." || value === "..") {
    throw new GenerationTaskVisualEvidenceError(`${label} is invalid`);
  }
  return value;
}

function text(value: unknown, label: string, limit = RENDER_FRAME_NAME_LIMIT): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()
    || value.length > limit || !isWellFormedUtf16(value)) {
    throw new GenerationTaskVisualEvidenceError(`${label} is invalid`);
  }
  return value;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function viewerText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit
    || value !== value.trim() || !isWellFormedUtf16(value)
    || VIEWER_BRIDGE_TEXT_CONTROL.test(value)) {
    throw new GenerationTaskVisualEvidenceError(`${label} is invalid`);
  }
  return value;
}

function owner(value: GenerationTaskVisualEvidenceOwner): GenerationTaskVisualEvidenceOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !OBJECT_ID.test(value.candidateCommitHash)
    || !OBJECT_ID.test(value.candidateTreeHash)
    || !SHA256.test(value.contextPackHash)
    || value.contextPackId !== `context-pack-${value.contextPackHash}`) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence owner is invalid");
  }
  return {
    projectId: id(value.projectId, "Project id"),
    workspaceId: id(value.workspaceId, "Workspace id"),
    planId: id(value.planId, "Plan id"),
    taskId: id(value.taskId, "Task id"),
    attempt: value.attempt,
    candidateCommitHash: value.candidateCommitHash,
    candidateTreeHash: value.candidateTreeHash,
    contextPackId: value.contextPackId,
    contextPackHash: value.contextPackHash,
  };
}

function frame(value: GenerationTaskVisualEvidenceFrame): GenerationTaskVisualEvidenceFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isExactRenderFrameCaptureViewport(value.width, value.height)) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence Frame is invalid");
  }
  const normalized: GenerationTaskVisualEvidenceFrame = {
    id: viewerText(value.id, "Frame id", VIEWER_BRIDGE_FRAME_TEXT_LIMIT),
    name: text(value.name, "Frame name"),
    width: value.width,
    height: value.height,
    frameAttemptId: id(value.frameAttemptId, "Frame Attempt id"),
  };
  if (value.initialState !== undefined) {
    normalized.initialState = viewerText(
      value.initialState,
      "Frame initial state",
      VIEWER_BRIDGE_FRAME_TEXT_LIMIT,
    );
  }
  if (value.fixture !== undefined) normalized.fixture = structuredClone(value.fixture);
  if (value.background !== undefined) {
    normalized.background = viewerText(
      value.background,
      "Frame background",
      VIEWER_BRIDGE_BACKGROUND_LIMIT,
    );
  }
  return normalized;
}

function sourceCapture(
  value: GenerationTaskSourceVisualEvidenceCapture,
): GenerationTaskSourceVisualEvidenceCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.scope !== "source"
    || !isExactRenderFrameCaptureViewport(value.width, value.height)) {
    throw new GenerationTaskVisualEvidenceError("Generation Task source evidence capture is invalid");
  }
  return {
    scope: "source",
    sourceAttemptId: id(value.sourceAttemptId, "Source Attempt id"),
    width: value.width,
    height: value.height,
  };
}

function sourceAuthority(
  value: GenerationTaskSourceVisualEvidenceAuthority,
): GenerationTaskSourceVisualEvidenceAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, "resourceId")
    || !Object.hasOwn(value, "revisionId")
    || !Object.hasOwn(value, "revisionChecksum")
    || !SHA256.test(value.revisionChecksum)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task source evidence authority is invalid",
    );
  }
  return {
    resourceId: id(value.resourceId, "Sharingan Resource id"),
    revisionId: id(value.revisionId, "Sharingan Resource Revision id"),
    revisionChecksum: value.revisionChecksum,
  };
}

function sameSourceAuthority(
  left: GenerationTaskSourceVisualEvidenceAuthority,
  right: GenerationTaskSourceVisualEvidenceAuthority,
): boolean {
  return left.resourceId === right.resourceId
    && left.revisionId === right.revisionId
    && left.revisionChecksum === right.revisionChecksum;
}

function sameOwner(left: GenerationTaskVisualEvidenceOwner, right: GenerationTaskVisualEvidenceOwner): boolean {
  return left.projectId === right.projectId
    && left.workspaceId === right.workspaceId
    && left.planId === right.planId
    && left.taskId === right.taskId
    && left.attempt === right.attempt
    && left.candidateCommitHash === right.candidateCommitHash
    && left.candidateTreeHash === right.candidateTreeHash
    && left.contextPackId === right.contextPackId
    && left.contextPackHash === right.contextPackHash;
}

function storageKey(
  exactOwner: GenerationTaskVisualEvidenceOwner,
  exactFrame: GenerationTaskVisualEvidenceFrame,
  round: number,
  sha256: string,
): string {
  return [
    "generation-task-evidence",
    exactOwner.projectId,
    exactOwner.workspaceId,
    exactOwner.planId,
    exactOwner.taskId,
    `attempt-${exactOwner.attempt}`,
    "visual",
    `round-${round}-${generationTaskVisualEvidenceFrameStorageSegment(exactFrame.id)}-${sha256}.png`,
  ].join("/");
}

export { generationTaskVisualEvidenceFrameStorageSegment } from "../../../../packages/core/src/index.ts";

function sourceStorageKey(
  exactOwner: GenerationTaskVisualEvidenceOwner,
  round: number,
  sha256: string,
): string {
  return [
    "generation-task-evidence",
    exactOwner.projectId,
    exactOwner.workspaceId,
    exactOwner.planId,
    exactOwner.taskId,
    `attempt-${exactOwner.attempt}`,
    "visual",
    `round-${round}-source-${sha256}.png`,
  ].join("/");
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sameNode(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint; size: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; size: number | bigint },
): boolean {
  return sameNode(left, right) && left.size === right.size;
}

async function canonicalEvidenceRoot(dataDir: string, create: boolean): Promise<string> {
  const lexical = resolve(dataDir);
  if (create) await mkdir(lexical, { recursive: true, mode: 0o700 });
  const metadata = await lstat(lexical).catch(() => {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence storage root is unavailable",
    );
  });
  const canonical = await realpath(lexical).catch(() => {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence storage root is unavailable",
    );
  });
  const canonicalMetadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || !canonicalMetadata.isDirectory() || !sameNode(metadata, canonicalMetadata)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence storage root must be a canonical directory",
    );
  }
  return canonical;
}

async function assertCanonicalEvidenceRoot(root: string): Promise<void> {
  const metadata = await lstat(root).catch(() => null);
  const canonical = await realpath(root).catch(() => null);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== root) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence canonical storage root changed",
    );
  }
}

async function syncEvidenceDirectory(directory: string): Promise<void> {
  const directoryFlag = Number.isInteger(constants.O_DIRECTORY) ? constants.O_DIRECTORY : 0;
  const handle = await open(directory, constants.O_RDONLY | directoryFlag);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function secureEvidenceDirectory(
  root: string,
  directory: string,
  create: boolean,
): Promise<void> {
  await assertCanonicalEvidenceRoot(root);
  if (!inside(root, directory)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence storage directory escapes its root",
    );
  }
  let cursor = root;
  for (const segment of relative(root, directory).split(sep)) {
    if (!segment) continue;
    cursor = join(cursor, segment);
    let created = false;
    if (create) {
      try {
        await mkdir(cursor, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (created) await syncEvidenceDirectory(dirname(cursor));
    }
    const metadata = await lstat(cursor).catch(() => null);
    const canonical = await realpath(cursor).catch(() => null);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()
      || canonical !== cursor || !inside(root, canonical)) {
      throw new GenerationTaskVisualEvidenceError(
        "Generation Task evidence storage cannot traverse a symlink or non-directory",
      );
    }
  }
}

async function assertStableEvidenceDirectory(
  root: string,
  directory: string,
  expected: { dev: number | bigint; ino: number | bigint },
): Promise<void> {
  const current = await lstat(directory).catch(() => null);
  const canonical = await realpath(directory).catch(() => null);
  if (!current || current.isSymbolicLink() || !current.isDirectory()
    || !sameNode(expected, current) || canonical !== directory || !inside(root, directory)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence storage directory changed during I/O",
    );
  }
}

function resolvedStoragePath(root: string, key: string): string {
  const path = resolve(root, ...key.split("/"));
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence storage key escapes its data directory");
  }
  return path;
}

async function readSecurePng(
  root: string,
  path: string,
): Promise<ReturnType<typeof readPngEvidenceFile>> {
  if (!inside(root, path)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence storage path escapes its root",
    );
  }
  const directory = dirname(path);
  await secureEvidenceDirectory(root, directory, false);
  const directoryIdentity = await lstat(directory);
  const inspected = readPngEvidenceFile(path);
  await assertStableEvidenceDirectory(root, directory, directoryIdentity);
  return inspected;
}

async function writeDurablePng(
  root: string,
  path: string,
  bytes: Buffer,
  identity: PngEvidenceIdentity,
): Promise<"owned-created" | "preexisting"> {
  const directory = dirname(path);
  await secureEvidenceDirectory(root, directory, true);
  const directoryIdentity = await lstat(directory);
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : null;
  if (noFollow === null) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence storage cannot enforce no-follow writes",
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let createdIdentity: { dev: number | bigint; ino: number | bigint; size: number | bigint } | null = null;
  let durable = false;
  try {
    try {
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o444,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readSecurePng(root, path);
      if (!existing || !samePngEvidenceIdentity(existing.identity, identity)
        || !existing.bytes.equals(bytes)) {
        throw new GenerationTaskVisualEvidenceError(
          "Existing generation Task evidence failed content verification",
        );
      }
      await syncEvidenceDirectory(directory);
      await assertStableEvidenceDirectory(root, directory, directoryIdentity);
      return "preexisting";
    }
    createdIdentity = await handle.stat();
    const openedPath = await lstat(path);
    await assertStableEvidenceDirectory(root, directory, directoryIdentity);
    if (!openedPath.isFile() || openedPath.nlink !== 1
      || !sameFile(createdIdentity, openedPath)) {
      throw new GenerationTaskVisualEvidenceError(
        "Generation Task evidence file changed while it was opened",
      );
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten <= 0) {
        throw new GenerationTaskVisualEvidenceError(
          "Generation Task evidence write made no progress",
        );
      }
      offset += result.bytesWritten;
    }
    await handle.sync();
    const written = await handle.stat();
    const writtenPath = await lstat(path);
    await assertStableEvidenceDirectory(root, directory, directoryIdentity);
    if (writtenPath.nlink !== 1 || !sameNode(createdIdentity, written)
      || !sameFile(written, writtenPath) || Number(written.size) !== bytes.byteLength) {
      throw new GenerationTaskVisualEvidenceError(
        "Generation Task evidence file changed while it was written",
      );
    }
    await handle.close();
    handle = null;
    await syncEvidenceDirectory(directory);
    await assertStableEvidenceDirectory(root, directory, directoryIdentity);
    const stored = await readSecurePng(root, path);
    if (!stored || !samePngEvidenceIdentity(stored.identity, identity)
      || !stored.bytes.equals(bytes)) {
      throw new GenerationTaskVisualEvidenceError(
        "Generation Task evidence durable write verification failed",
      );
    }
    durable = true;
    return "owned-created";
  } finally {
    await handle?.close().catch(() => {});
    if (!durable && createdIdentity !== null) {
      const current = await lstat(path).catch(() => null);
      if (current && sameNode(createdIdentity, current)) {
        await rm(path).catch(() => {});
        await syncEvidenceDirectory(directory).catch(() => {});
      }
    }
  }
}

async function persistPng(
  dataDir: string,
  sourcePath: string,
  expectedIdentity: PngEvidenceIdentity,
  keyForHash: (sha256: string) => string,
  validateIdentity: (identity: PngEvidenceIdentity) => boolean,
): Promise<{
  sha256: string;
  byteLength: number;
  storageKey: string;
  storageDisposition: "owned-created" | "preexisting";
} | undefined> {
  const inspected = readPngEvidenceFile(sourcePath);
  if (!inspected) return undefined;
  const { bytes, identity } = inspected;
  if (!samePngEvidenceIdentity(identity, expectedIdentity)
    || !validateIdentity(identity)) return undefined;
  const key = keyForHash(identity.sha256);
  const root = await canonicalEvidenceRoot(dataDir, true);
  const path = resolvedStoragePath(root, key);
  const storageDisposition = await writeDurablePng(root, path, bytes, identity);
  return {
    sha256: identity.sha256,
    byteLength: identity.byteLength,
    storageKey: key,
    storageDisposition,
  };
}

async function removeOwnedCreatedPng(input: {
  root: string;
  storageKey: string;
  identity: PngEvidenceIdentity;
}): Promise<void> {
  const path = resolvedStoragePath(input.root, input.storageKey);
  const directory = dirname(path);
  await secureEvidenceDirectory(input.root, directory, false);
  const directoryIdentity = await lstat(directory);
  const current = await lstat(path).catch(() => null);
  const inspected = await readSecurePng(input.root, path);
  await assertStableEvidenceDirectory(input.root, directory, directoryIdentity);
  if (!current || !current.isFile() || current.nlink !== 1 || !inspected
    || !samePngEvidenceIdentity(inspected.identity, input.identity)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence batch rollback refused a changed file",
    );
  }
  const beforeRemove = await lstat(path).catch(() => null);
  if (!beforeRemove || !sameNode(current, beforeRemove) || beforeRemove.nlink !== 1) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence batch rollback observed a substituted file",
    );
  }
  await rm(path);
  await syncEvidenceDirectory(directory);
  await assertStableEvidenceDirectory(input.root, directory, directoryIdentity);
}

async function resolveVerifiedPng(input: {
  dataDir: string;
  storageKey: string;
  sha256: string;
  byteLength: number;
  validateIdentity: (identity: PngEvidenceIdentity) => boolean;
}): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const root = await canonicalEvidenceRoot(input.dataDir, false);
  const path = resolvedStoragePath(root, input.storageKey);
  const inspected = await readSecurePng(root, path);
  const identity = inspected?.identity;
  if (!identity
    || identity.byteLength !== input.byteLength
    || identity.sha256 !== input.sha256
    || !input.validateIdentity(identity)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence is missing, empty, or content identity verification failed",
    );
  }
  return { path, bytes: inspected.bytes };
}

function pngCoversSourceCapture(
  identity: PngEvidenceIdentity,
  capture: GenerationTaskSourceVisualEvidenceCapture,
): boolean {
  // The descriptor records the audited source viewport. A full-page screenshot may
  // legitimately extend beyond it when the candidate overflows; retain that failed
  // evidence instead of turning a design defect into a storage-infrastructure error.
  return identity.width >= capture.width && identity.height >= capture.height;
}

function pngCoversFrame(
  identity: PngEvidenceIdentity,
  exactFrame: GenerationTaskVisualEvidenceFrame,
): boolean {
  // Full-page captures may exceed the immutable viewport in either dimension when
  // overflow is itself the reviewed defect, but a smaller image cannot prove the Frame.
  return identity.width >= exactFrame.width && identity.height >= exactFrame.height;
}

export async function persistGenerationTaskVisualEvidence(
  input: PersistGenerationTaskVisualEvidenceInput,
): Promise<GenerationTaskVisualEvidenceDescriptor | undefined> {
  const exactOwner = owner(input.owner);
  const exactFrame = frame(input.frame);
  if (typeof input.dataDir !== "string" || input.dataDir.length === 0
    || !Number.isSafeInteger(input.round) || input.round < 0) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence persistence input is invalid");
  }
  const persisted = await persistPng(
    input.dataDir,
    input.sourcePath,
    input.expectedIdentity,
    (sha256) => storageKey(exactOwner, exactFrame, input.round, sha256),
    (identity) => pngCoversFrame(identity, exactFrame),
  );
  if (!persisted) return undefined;
  const { storageDisposition: _storageDisposition, ...descriptor } = persisted;
  return {
    protocol: "dezin.generation-task-visual-evidence.v1",
    owner: exactOwner,
    frame: exactFrame,
    round: input.round,
    mediaType: "image/png",
    ...descriptor,
  };
}

export async function persistGenerationTaskSourceVisualEvidence(
  input: PersistGenerationTaskSourceVisualEvidenceInput,
): Promise<GenerationTaskSourceVisualEvidenceDescriptor | undefined> {
  const exactOwner = owner(input.owner);
  const exactCapture = sourceCapture(input.capture);
  const exactSourceAuthority = sourceAuthority(input.sourceAuthority);
  if (typeof input.dataDir !== "string" || input.dataDir.length === 0
    || !Number.isSafeInteger(input.round) || input.round < 0) {
    throw new GenerationTaskVisualEvidenceError("Generation Task source evidence persistence input is invalid");
  }
  const persisted = await persistPng(
    input.dataDir,
    input.sourcePath,
    input.expectedIdentity,
    (sha256) => sourceStorageKey(exactOwner, input.round, sha256),
    (identity) => pngCoversSourceCapture(identity, exactCapture),
  );
  if (!persisted) return undefined;
  const { storageDisposition: _storageDisposition, ...descriptor } = persisted;
  return {
    protocol: "dezin.generation-task-source-visual-evidence.v1",
    owner: exactOwner,
    capture: exactCapture,
    sourceAuthority: exactSourceAuthority,
    round: input.round,
    mediaType: "image/png",
    ...descriptor,
  };
}

export interface PersistGenerationTaskVisualEvidenceBatchInput {
  readonly dataDir: string;
  readonly owner: GenerationTaskVisualEvidenceOwner;
  readonly round: number;
  readonly signal: AbortSignal;
  readonly frames: readonly {
    readonly frame: GenerationTaskVisualEvidenceFrame;
    readonly sourcePath: string;
    readonly expectedIdentity: PngEvidenceIdentity;
  }[];
  readonly source?: {
    readonly capture: GenerationTaskSourceVisualEvidenceCapture;
    readonly sourceAuthority: GenerationTaskSourceVisualEvidenceAuthority;
    readonly sourcePath: string;
    readonly expectedIdentity: PngEvidenceIdentity;
  };
}

export interface PersistGenerationTaskVisualEvidenceBatchResult {
  readonly frames: readonly GenerationTaskVisualEvidenceDescriptor[];
  readonly source?: GenerationTaskSourceVisualEvidenceDescriptor;
}

function evidenceAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Generation Task evidence persistence aborted", "AbortError");
}

function checkEvidenceAbort(signal: AbortSignal): void {
  if (signal.aborted) throw evidenceAbortReason(signal);
}

/**
 * Persists one reviewer round as a single rollback domain. A later file,
 * validation, or abort failure removes only paths this invocation created;
 * content that already existed before the batch is never removed.
 */
export async function persistGenerationTaskVisualEvidenceBatch(
  input: PersistGenerationTaskVisualEvidenceBatchInput,
): Promise<PersistGenerationTaskVisualEvidenceBatchResult> {
  const exactOwner = owner(input.owner);
  if (typeof input.dataDir !== "string" || input.dataDir.length === 0
    || !Number.isSafeInteger(input.round) || input.round < 0
    || !input.signal || typeof input.signal.aborted !== "boolean"
    || !Array.isArray(input.frames) || input.frames.length > 64
    || (input.frames.length === 0 && input.source === undefined)) {
    throw new GenerationTaskVisualEvidenceError(
      "Generation Task evidence batch persistence input is invalid",
    );
  }
  const root = await canonicalEvidenceRoot(input.dataDir, true);
  const created: Array<{
    storageKey: string;
    identity: PngEvidenceIdentity;
  }> = [];
  const frames: GenerationTaskVisualEvidenceDescriptor[] = [];
  let source: GenerationTaskSourceVisualEvidenceDescriptor | undefined;
  try {
    checkEvidenceAbort(input.signal);
    if (input.source !== undefined) {
      const exactCapture = sourceCapture(input.source.capture);
      const exactSourceAuthority = sourceAuthority(input.source.sourceAuthority);
      const persisted = await persistPng(
        input.dataDir,
        input.source.sourcePath,
        input.source.expectedIdentity,
        (sha256) => sourceStorageKey(exactOwner, input.round, sha256),
        (identity) => pngCoversSourceCapture(identity, exactCapture),
      );
      if (!persisted) {
        throw new GenerationTaskVisualEvidenceError(
          "Generation Task source evidence is empty, unavailable, or changed",
        );
      }
      if (persisted.storageDisposition === "owned-created") {
        created.push({ storageKey: persisted.storageKey, identity: input.source.expectedIdentity });
      }
      source = {
        protocol: "dezin.generation-task-source-visual-evidence.v1",
        owner: exactOwner,
        capture: exactCapture,
        sourceAuthority: exactSourceAuthority,
        round: input.round,
        mediaType: "image/png",
        sha256: persisted.sha256,
        byteLength: persisted.byteLength,
        storageKey: persisted.storageKey,
      };
      checkEvidenceAbort(input.signal);
    }
    for (const item of input.frames) {
      const exactFrame = frame(item.frame);
      const persisted = await persistPng(
        input.dataDir,
        item.sourcePath,
        item.expectedIdentity,
        (sha256) => storageKey(exactOwner, exactFrame, input.round, sha256),
        (identity) => pngCoversFrame(identity, exactFrame),
      );
      if (!persisted) {
        throw new GenerationTaskVisualEvidenceError(
          `Generation Task evidence for Frame ${exactFrame.id} is empty, unavailable, or changed`,
        );
      }
      if (persisted.storageDisposition === "owned-created") {
        created.push({ storageKey: persisted.storageKey, identity: item.expectedIdentity });
      }
      frames.push({
        protocol: "dezin.generation-task-visual-evidence.v1",
        owner: exactOwner,
        frame: exactFrame,
        round: input.round,
        mediaType: "image/png",
        sha256: persisted.sha256,
        byteLength: persisted.byteLength,
        storageKey: persisted.storageKey,
      });
      checkEvidenceAbort(input.signal);
    }
    return Object.freeze({
      frames: Object.freeze(frames.map((descriptor) => Object.freeze(descriptor))),
      ...(source === undefined ? {} : { source: Object.freeze(source) }),
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const persisted of [...created].reverse()) {
      try {
        await removeOwnedCreatedPng({ root, ...persisted });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Generation Task evidence batch failed and rollback was incomplete",
        { cause: error },
      );
    }
    throw error;
  }
}

async function resolveGenerationTaskVisualEvidence(input: {
  dataDir: string;
  descriptor: GenerationTaskVisualEvidenceDescriptor;
  expectedOwner: GenerationTaskVisualEvidenceOwner;
}): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const expectedOwner = owner(input.expectedOwner);
  const descriptorOwner = owner(input.descriptor?.owner);
  const descriptorFrame = frame(input.descriptor?.frame);
  if (input.descriptor?.protocol !== "dezin.generation-task-visual-evidence.v1"
    || input.descriptor.mediaType !== "image/png"
    || !Number.isSafeInteger(input.descriptor.round) || input.descriptor.round < 0
    || !SHA256.test(input.descriptor.sha256)
    || !Number.isSafeInteger(input.descriptor.byteLength) || input.descriptor.byteLength < 1
    || !sameOwner(descriptorOwner, expectedOwner)) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence descriptor or owner is invalid");
  }
  const expectedKey = storageKey(
    descriptorOwner,
    descriptorFrame,
    input.descriptor.round,
    input.descriptor.sha256,
  );
  if (input.descriptor.storageKey !== expectedKey) {
    throw new GenerationTaskVisualEvidenceError("Generation Task evidence storage ownership is invalid");
  }
  return resolveVerifiedPng({
    dataDir: input.dataDir,
    storageKey: expectedKey,
    sha256: input.descriptor.sha256,
    byteLength: input.descriptor.byteLength,
    validateIdentity: (identity) => pngCoversFrame(identity, descriptorFrame),
  });
}

export async function resolveGenerationTaskVisualEvidencePath(input: {
  dataDir: string;
  descriptor: GenerationTaskVisualEvidenceDescriptor;
  expectedOwner: GenerationTaskVisualEvidenceOwner;
}): Promise<string> {
  return (await resolveGenerationTaskVisualEvidence(input)).path;
}

export async function readGenerationTaskVisualEvidence(input: {
  dataDir: string;
  descriptor: GenerationTaskVisualEvidenceDescriptor;
  expectedOwner: GenerationTaskVisualEvidenceOwner;
}): Promise<Buffer> {
  return (await resolveGenerationTaskVisualEvidence(input)).bytes;
}

async function resolveGenerationTaskSourceVisualEvidence(input: {
  dataDir: string;
  descriptor: GenerationTaskSourceVisualEvidenceDescriptor;
  expectedOwner: GenerationTaskVisualEvidenceOwner;
  expectedSourceAuthority: GenerationTaskSourceVisualEvidenceAuthority;
}): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const expectedOwner = owner(input.expectedOwner);
  const expectedSourceAuthority = sourceAuthority(input.expectedSourceAuthority);
  const descriptorOwner = owner(input.descriptor?.owner);
  const descriptorCapture = sourceCapture(input.descriptor?.capture);
  const descriptorSourceAuthority = sourceAuthority(input.descriptor?.sourceAuthority);
  if (input.descriptor?.protocol !== "dezin.generation-task-source-visual-evidence.v1"
    || input.descriptor.mediaType !== "image/png"
    || !Number.isSafeInteger(input.descriptor.round) || input.descriptor.round < 0
    || !SHA256.test(input.descriptor.sha256)
    || !Number.isSafeInteger(input.descriptor.byteLength) || input.descriptor.byteLength < 1
    || !sameOwner(descriptorOwner, expectedOwner)
    || !sameSourceAuthority(descriptorSourceAuthority, expectedSourceAuthority)) {
    throw new GenerationTaskVisualEvidenceError("Generation Task source evidence descriptor or owner is invalid");
  }
  const expectedKey = sourceStorageKey(
    descriptorOwner,
    input.descriptor.round,
    input.descriptor.sha256,
  );
  if (input.descriptor.storageKey !== expectedKey) {
    throw new GenerationTaskVisualEvidenceError("Generation Task source evidence storage ownership is invalid");
  }
  return resolveVerifiedPng({
    dataDir: input.dataDir,
    storageKey: expectedKey,
    sha256: input.descriptor.sha256,
    byteLength: input.descriptor.byteLength,
    validateIdentity: (identity) => pngCoversSourceCapture(identity, descriptorCapture),
  });
}

export async function resolveGenerationTaskSourceVisualEvidencePath(input: {
  dataDir: string;
  descriptor: GenerationTaskSourceVisualEvidenceDescriptor;
  expectedOwner: GenerationTaskVisualEvidenceOwner;
  expectedSourceAuthority: GenerationTaskSourceVisualEvidenceAuthority;
}): Promise<string> {
  return (await resolveGenerationTaskSourceVisualEvidence(input)).path;
}

export async function readGenerationTaskSourceVisualEvidence(input: {
  dataDir: string;
  descriptor: GenerationTaskSourceVisualEvidenceDescriptor;
  expectedOwner: GenerationTaskVisualEvidenceOwner;
  expectedSourceAuthority: GenerationTaskSourceVisualEvidenceAuthority;
}): Promise<Buffer> {
  return (await resolveGenerationTaskSourceVisualEvidence(input)).bytes;
}
