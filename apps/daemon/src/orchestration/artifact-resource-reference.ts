import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import type { AgentRunner } from "../../../../packages/agent/src/index.ts";
import type {
  GenerationTaskAttemptClaim,
  GenerationTaskFailureClass,
  Store,
} from "../../../../packages/core/src/index.ts";
import {
  ContextIntegrityError,
  stableStringify,
  type ContextPack,
} from "../context/context-types.ts";
import {
  resourceRevisionMountKey,
  resolveResourceRevisionPayloadDescriptor,
  verifyResourceRevisionPayload,
  type ResourceRevisionPayloadDescriptor,
} from "../resource-revision-payload.ts";
import type {
  StandardArtifactCandidateIdentity,
  StandardArtifactQualityEvaluatorPort,
} from "./standard-artifact-execution.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const CONTEXT_PACK_ID = /^context-pack-([0-9a-f]{64})$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const REFERENCE_MOUNT = ".dezin/references";
const PROJECT_REFERENCE_PROTOCOL = "dezin.project-reference-bundle.v1";
const MAX_REFERENCES = 64;
const MAX_PROJECT_FILES = 512;
const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_PROJECT_BUNDLE_BYTES = 56 * 1024 * 1024;
const MAX_FINGERPRINT_FILES = 1_100;
const MAX_FINGERPRINT_DIRECTORIES = 1_100;
const MAX_FINGERPRINT_BYTES = 128 * 1024 * 1024;
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_PATH_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;

export type ArtifactResourceReferenceSourceType = "uploaded-file" | "project-reference";

export interface ImmutableArtifactResourceReference {
  readonly workspaceId: string;
  readonly contextPackId: string;
  readonly contextPackHash: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly revisionChecksum: string;
  readonly sourceType: ArtifactResourceReferenceSourceType;
}

export interface MaterializedArtifactResourceReference {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly revisionChecksum: string;
  readonly sourceType: ArtifactResourceReferenceSourceType;
  readonly mimeType: string;
  /** Candidate-worktree-relative exact payload path. */
  readonly payloadPath: string;
  /** Candidate-worktree-relative extracted Project source root, when applicable. */
  readonly projectRoot?: string;
}

export interface ArtifactResourceReferenceFence {
  readonly protocol: "dezin.artifact-resource-reference-fence.v1";
  readonly worktreeDir: string;
  readonly mountPath: typeof REFERENCE_MOUNT;
  readonly fingerprint: string;
  readonly references: readonly MaterializedArtifactResourceReference[];
  verify(signal: AbortSignal): Promise<void>;
  withoutMaterializedReferences<Result>(
    operation: () => Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result>;
  dispose(): Promise<void>;
}

export interface ArtifactResourceReferenceMaterializerPort {
  materializeExactReferences(input: {
    readonly references: readonly ImmutableArtifactResourceReference[];
    readonly worktreeDir: string;
    readonly signal: AbortSignal;
  }): Promise<ArtifactResourceReferenceFence | null>;
}

export interface ArtifactResourceCandidateTransactionPort {
  readonly dir: string;
  readonly attemptRef: string;
  fingerprint(signal: AbortSignal): Promise<string>;
  commit(message: string, signal: AbortSignal): Promise<StandardArtifactCandidateIdentity>;
  restore(candidate: StandardArtifactCandidateIdentity, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export class ArtifactResourceReferenceError extends Error {
  readonly code:
    | "invalid-reference"
    | "payload-invalid"
    | "sidecar-conflict"
    | "sidecar-missing"
    | "sidecar-mutated"
    | "sidecar-unbounded"
    | "sidecar-cleanup-failed";
  readonly failureClass: GenerationTaskFailureClass = "context";

  constructor(code: ArtifactResourceReferenceError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "ArtifactResourceReferenceError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Artifact Resource reference operation aborted", "AbortError");
  }
}

function canonicalId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value !== value.trim() || value.includes("\0")) {
    throw new ContextIntegrityError(`${label} is invalid`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextIntegrityError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const expected = new Set(fields);
  if (keys.length !== fields.length || keys.some((key) => !expected.has(key))) {
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      `${label} fields do not match the immutable protocol`,
    );
  }
}

function sourceTypeFromItem(item: ContextPack["items"][number]): ArtifactResourceReferenceSourceType {
  const provenance = record(item.provenance, "File Resource Context provenance");
  const source = record(provenance.source, "File Resource Context source provenance");
  if (source.sourceType !== "uploaded-file" && source.sourceType !== "project-reference") {
    throw new ContextIntegrityError("File Resource Context source type is unsupported for Artifact execution");
  }
  return source.sourceType;
}

/**
 * Derive only exact, provided file references from the immutable Context Pack,
 * then bind each one 1:1 to the Attempt's immutable Resource pins.
 */
export function exactArtifactResourceReferences(input: {
  readonly claim: Pick<GenerationTaskAttemptClaim, "task" | "attempt">;
  readonly contextPack: ContextPack;
}): readonly ImmutableArtifactResourceReference[] {
  const { claim, contextPack } = input;
  const contextMatch = CONTEXT_PACK_ID.exec(contextPack.id);
  if (!contextMatch || contextPack.hash !== contextMatch[1] || !SHA256.test(contextPack.hash)
    || contextPack.workspaceId !== claim.task.workspaceId
    || claim.attempt.contextPackId !== contextPack.id) {
    throw new ContextIntegrityError("Artifact file references are not bound to the immutable Attempt Context Pack");
  }
  if (contextPack.omissions.some((omission) => (
    omission.ref.kind === "resource" && omission.ref.resourceKind === "file"
  ))) {
    throw new ContextIntegrityError("Artifact file Resource evidence was omitted from the immutable Context Pack");
  }

  const pins = new Map<string, string>();
  for (const pin of claim.attempt.resourcePins) {
    const resourceId = canonicalId(pin.resourceId, "Attempt Resource pin id");
    const revisionId = canonicalId(pin.revisionId, "Attempt Resource Revision pin id");
    if (pins.has(resourceId)) {
      throw new ContextIntegrityError("Artifact Attempt contains duplicate Resource pins");
    }
    pins.set(resourceId, revisionId);
  }

  const seen = new Set<string>();
  const references: ImmutableArtifactResourceReference[] = [];
  for (const item of contextPack.items) {
    if (item.ref.kind !== "resource" || item.ref.resourceKind !== "file") continue;
    const resourceId = canonicalId(item.ref.id, "File Resource id");
    const revisionId = canonicalId(item.ref.revisionId, "File Resource Revision id");
    if (item.resolvedKind !== "resource-revision" || item.provided !== true
      || typeof item.checksum !== "string" || !SHA256.test(item.checksum)) {
      throw new ContextIntegrityError(
        "Artifact file reference is not one exact provided Resource Revision",
      );
    }
    if (seen.has(resourceId)) {
      throw new ContextIntegrityError("Artifact Context Pack contains duplicate file Resource references");
    }
    seen.add(resourceId);
    if (pins.get(resourceId) !== revisionId) {
      throw new ContextIntegrityError(
        "Artifact file Resource Revision does not match its immutable Attempt pin",
      );
    }
    const provenance = record(item.provenance, "File Resource Context provenance");
    if (provenance.resourceId !== resourceId
      || provenance.resourceRevisionId !== revisionId
      || provenance.resourceKind !== "file"
      || provenance.manifestChecksum !== item.checksum) {
      throw new ContextIntegrityError("Artifact file Resource provenance substituted its exact Revision");
    }
    references.push(Object.freeze({
      workspaceId: claim.task.workspaceId,
      contextPackId: contextPack.id,
      contextPackHash: contextPack.hash,
      resourceId,
      revisionId,
      revisionChecksum: item.checksum,
      sourceType: sourceTypeFromItem(item),
    }));
    if (references.length > MAX_REFERENCES) {
      throw new ContextIntegrityError(`Artifact file references exceed their ${MAX_REFERENCES}-item limit`);
    }
  }
  references.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.resourceId}\0${left.revisionId}`),
    Buffer.from(`${right.resourceId}\0${right.revisionId}`),
  ));
  return Object.freeze(references);
}

function canonicalReference(
  value: ImmutableArtifactResourceReference,
): ImmutableArtifactResourceReference {
  const contextPackId = canonicalId(value.contextPackId, "Artifact reference Context Pack id");
  const contextPackHash = canonicalId(value.contextPackHash, "Artifact reference Context Pack hash");
  const match = CONTEXT_PACK_ID.exec(contextPackId);
  if (!match || match[1] !== contextPackHash || !SHA256.test(contextPackHash)
    || typeof value.revisionChecksum !== "string" || !SHA256.test(value.revisionChecksum)
    || (value.sourceType !== "uploaded-file" && value.sourceType !== "project-reference")) {
    throw new ArtifactResourceReferenceError(
      "invalid-reference",
      "Artifact Resource reference is not bound to an exact Context Pack and Revision",
    );
  }
  return Object.freeze({
    workspaceId: canonicalId(value.workspaceId, "Artifact reference Workspace id"),
    contextPackId,
    contextPackHash,
    resourceId: canonicalId(value.resourceId, "Artifact reference Resource id"),
    revisionId: canonicalId(value.revisionId, "Artifact reference Revision id"),
    revisionChecksum: value.revisionChecksum,
    sourceType: value.sourceType,
  });
}

function inside(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function safeProjectPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_BYTES
    || value.includes("\\") || value.includes("\0") || isAbsolute(value)
    || posix.normalize(value) !== value) {
    throw new ArtifactResourceReferenceError("payload-invalid", "Project Reference contains an unsafe file path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ArtifactResourceReferenceError("payload-invalid", "Project Reference contains an unsafe file path");
  }
  return value;
}

interface DecodedProjectReferenceFile {
  readonly path: string;
  readonly bytes: Buffer;
}

function decodeProjectReferencePayload(payload: Buffer): readonly DecodedProjectReferenceFile[] {
  if (payload.byteLength <= 0 || payload.byteLength > MAX_PROJECT_BUNDLE_BYTES) {
    throw new ArtifactResourceReferenceError("payload-invalid", "Project Reference payload exceeds its byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch (error) {
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      "Project Reference payload is not valid UTF-8 JSON",
      error,
    );
  }
  let canonical: Buffer;
  try {
    canonical = Buffer.from(`${stableStringify(parsed)}\n`, "utf8");
  } catch (error) {
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      "Project Reference payload is not canonical portable JSON",
      error,
    );
  }
  if (!payload.equals(canonical)) {
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      "Project Reference payload is not in canonical byte form",
    );
  }
  const root = record(parsed, "Project Reference payload");
  exactFields(root, ["protocol", "source", "design"], "Project Reference payload");
  if (root.protocol !== PROJECT_REFERENCE_PROTOCOL) {
    throw new ArtifactResourceReferenceError("payload-invalid", "Project Reference protocol is unsupported");
  }
  record(root.source, "Project Reference source");
  const design = record(root.design, "Project Reference design");
  exactFields(
    design,
    [
      "artifact",
      "track",
      "revision",
      "kernelRevision",
      "assembly",
      "dependencies",
      "resourcePins",
      "graphNode",
      "adjacentEdges",
      "adjacentNodes",
      "files",
    ],
    "Project Reference design",
  );
  if (!Array.isArray(design.files) || design.files.length > MAX_PROJECT_FILES) {
    throw new ArtifactResourceReferenceError("payload-invalid", "Project Reference file list is invalid");
  }
  const paths = new Set<string>();
  let total = 0;
  const files = design.files.map((raw, index) => {
    const file = record(raw, `Project Reference file ${index}`);
    exactFields(
      file,
      ["path", "mimeType", "byteLength", "checksum", "encoding", "content"],
      `Project Reference file ${index}`,
    );
    const path = safeProjectPath(file.path);
    if (paths.has(path)) {
      throw new ArtifactResourceReferenceError("payload-invalid", "Project Reference contains duplicate file paths");
    }
    paths.add(path);
    if (typeof file.mimeType !== "string" || file.mimeType.length > 127 || !MIME.test(file.mimeType)
      || !Number.isSafeInteger(file.byteLength) || Number(file.byteLength) < 0
      || Number(file.byteLength) > MAX_PROJECT_FILE_BYTES
      || typeof file.checksum !== "string" || !SHA256.test(file.checksum)
      || (file.encoding !== "utf8" && file.encoding !== "base64")
      || typeof file.content !== "string") {
      throw new ArtifactResourceReferenceError(
        "payload-invalid",
        `Project Reference file ${path} metadata is invalid`,
      );
    }
    const bytes = file.encoding === "utf8"
      ? Buffer.from(file.content, "utf8")
      : Buffer.from(file.content, "base64");
    if (file.encoding === "base64" && bytes.toString("base64") !== file.content) {
      throw new ArtifactResourceReferenceError(
        "payload-invalid",
        `Project Reference file ${path} base64 is not canonical`,
      );
    }
    if (bytes.byteLength !== file.byteLength
      || createHash("sha256").update(bytes).digest("hex") !== file.checksum) {
      throw new ArtifactResourceReferenceError(
        "payload-invalid",
        `Project Reference file ${path} bytes do not match their exact digest`,
      );
    }
    total += bytes.byteLength;
    if (total > MAX_PROJECT_TOTAL_BYTES) {
      throw new ArtifactResourceReferenceError(
        "payload-invalid",
        "Project Reference files exceed their total byte limit",
      );
    }
    return Object.freeze({ path, bytes });
  });
  const sorted = [...files].sort((left, right) => Buffer.compare(
    Buffer.from(left.path),
    Buffer.from(right.path),
  ));
  if (files.some((file, index) => file.path !== sorted[index]!.path)) {
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      "Project Reference files are not in canonical order",
    );
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.path.startsWith(`${sorted[index - 1]!.path}/`)) {
      throw new ArtifactResourceReferenceError(
        "payload-invalid",
        "Project Reference file paths contain a file/directory collision",
      );
    }
  }
  return Object.freeze(files);
}

async function writeExactFile(root: string, relativePath: string, bytes: Uint8Array): Promise<void> {
  const destination = resolve(root, ...relativePath.split("/"));
  if (!inside(root, destination)) {
    throw new ArtifactResourceReferenceError("payload-invalid", "Artifact reference file escaped its sidecar");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
  await chmod(destination, 0o444);
}

async function freezeReferenceDirectories(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await freezeReferenceDirectories(join(directory, entry.name));
  }
  await chmod(directory, 0o555);
}

async function makeTreeRemovable(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) return;
  await chmod(path, 0o700).catch(() => {});
  const names = await readdir(path).catch(() => []);
  for (const name of names) await makeTreeRemovable(join(path, name));
}

function descriptorMatches(
  descriptor: ResourceRevisionPayloadDescriptor,
  reference: ImmutableArtifactResourceReference,
): boolean {
  return descriptor.workspaceId === reference.workspaceId
    && descriptor.resourceId === reference.resourceId
    && descriptor.resourceRevisionId === reference.revisionId
    && descriptor.resourceKind === "file"
    && descriptor.manifestChecksum === reference.revisionChecksum
    && SHA256.test(descriptor.payloadChecksum);
}

interface FingerprintState {
  files: number;
  directories: number;
  bytes: number;
  readonly records: string[];
}

function sameFile(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: typeof left,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function safeSidecarComponent(value: string): void {
  if (!value || value === "." || value === ".." || value.toLowerCase() === ".git"
    || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference sidecar contains an unsafe path");
  }
}

async function exactFileHash(
  path: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  signal: AbortSignal,
): Promise<string> {
  const noFollow = constants.O_NOFOLLOW;
  const nonblock = constants.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || noFollow <= 0 || !Number.isInteger(nonblock) || nonblock <= 0) {
    throw new ArtifactResourceReferenceError(
      "sidecar-mutated",
      "Artifact reference files cannot be opened with no-follow semantics",
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | nonblock);
  } catch (error) {
    throw new ArtifactResourceReferenceError(
      "sidecar-mutated",
      "Artifact reference file could not be opened safely",
      error,
    );
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameFile(expected, before)) {
      throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference file changed before verification");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < before.size) {
      checkAbort(signal);
      const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read.bytesRead <= 0) {
        throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference file ended during verification");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const extra = await handle.read(buffer, 0, 1, offset);
    const [after, current] = await Promise.all([handle.stat(), lstat(path).catch(() => null)]);
    if (extra.bytesRead !== 0 || current === null || current.isSymbolicLink()
      || !current.isFile() || !sameFile(before, after) || !sameFile(after, current)) {
      throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference file changed during verification");
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectFingerprint(
  directory: string,
  relativeDirectory: string,
  state: FingerprintState,
  signal: AbortSignal,
  depth: number,
): Promise<void> {
  checkAbort(signal);
  state.directories += 1;
  if (depth > MAX_FINGERPRINT_DEPTH || state.directories > MAX_FINGERPRINT_DIRECTORIES) {
    throw new ArtifactResourceReferenceError("sidecar-unbounded", "Artifact reference sidecar directory bound exceeded");
  }
  const before = await lstat(directory).catch(() => null);
  if (before === null || !before.isDirectory() || before.isSymbolicLink()) {
    throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference sidecar directory is unsafe");
  }
  const names = await readdir(directory);
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of names) {
    safeSidecarComponent(name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    if (Buffer.byteLength(relativePath, "utf8") > MAX_PATH_BYTES) {
      throw new ArtifactResourceReferenceError("sidecar-unbounded", "Artifact reference sidecar path bound exceeded");
    }
    const path = join(directory, name);
    const metadata = await lstat(path).catch(() => null);
    if (metadata === null || metadata.isSymbolicLink()) {
      throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference sidecar cannot contain links");
    }
    if (metadata.isDirectory()) {
      state.records.push(JSON.stringify(["directory", relativePath, metadata.mode & 0o777]));
      await collectFingerprint(path, relativePath, state, signal, depth + 1);
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1
      || !Number.isSafeInteger(metadata.size) || metadata.size < 0
      || state.files >= MAX_FINGERPRINT_FILES
      || state.bytes > MAX_FINGERPRINT_BYTES - metadata.size) {
      throw new ArtifactResourceReferenceError("sidecar-unbounded", "Artifact reference sidecar file bound exceeded");
    }
    const checksum = await exactFileHash(path, metadata, signal);
    state.files += 1;
    state.bytes += metadata.size;
    state.records.push(JSON.stringify([
      "file",
      relativePath,
      metadata.mode & 0o777,
      metadata.size,
      checksum,
    ]));
  }
  const after = await lstat(directory).catch(() => null);
  if (after === null || !after.isDirectory() || after.isSymbolicLink() || !sameFile(before, after)) {
    throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference directory changed during verification");
  }
}

async function sidecarFingerprint(worktreeDir: string, signal: AbortSignal): Promise<string> {
  checkAbort(signal);
  const canonicalWorktree = await realpath(worktreeDir).catch(() => {
    throw new ArtifactResourceReferenceError("sidecar-missing", "Artifact reference candidate worktree is missing");
  });
  const mount = join(canonicalWorktree, ...REFERENCE_MOUNT.split("/"));
  const canonicalMount = await realpath(mount).catch(() => {
    throw new ArtifactResourceReferenceError("sidecar-missing", "Artifact reference sidecar is missing");
  });
  if (canonicalMount !== resolve(canonicalWorktree, ...REFERENCE_MOUNT.split("/"))) {
    throw new ArtifactResourceReferenceError("sidecar-mutated", "Artifact reference sidecar escaped its worktree");
  }
  const state: FingerprintState = { files: 0, directories: 0, bytes: 0, records: [] };
  await collectFingerprint(canonicalMount, REFERENCE_MOUNT, state, signal, 0);
  if (state.files === 0) {
    throw new ArtifactResourceReferenceError("sidecar-missing", "Artifact reference sidecar is empty");
  }
  const hash = createHash("sha256");
  hash.update("dezin.artifact-resource-reference-fingerprint.v1\0");
  for (const item of state.records) hash.update(item).update("\n");
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function ensurePlainParent(worktreeDir: string): Promise<{ path: string; created: boolean }> {
  const parent = join(worktreeDir, ".dezin");
  let created = false;
  if (!await pathExists(parent)) {
    await mkdir(parent, { mode: 0o755 });
    created = true;
  }
  const metadata = await lstat(parent);
  const canonical = await realpath(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== resolve(worktreeDir, ".dezin")) {
    throw new ArtifactResourceReferenceError("sidecar-conflict", "Artifact reference parent path is unsafe");
  }
  return { path: parent, created };
}

async function materializeReference(
  store: Store,
  dataDir: string,
  root: string,
  reference: ImmutableArtifactResourceReference,
  signal: AbortSignal,
): Promise<MaterializedArtifactResourceReference> {
  checkAbort(signal);
  let descriptor: ResourceRevisionPayloadDescriptor;
  try {
    descriptor = resolveResourceRevisionPayloadDescriptor({
      store,
      dataDir,
      workspaceId: reference.workspaceId,
      resourceRevisionId: reference.revisionId,
      expectedResourceId: reference.resourceId,
    });
  } catch (error) {
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      "Artifact Resource Revision payload is unavailable or invalid",
      error,
    );
  }
  if (!descriptorMatches(descriptor, reference)) {
    throw new ArtifactResourceReferenceError(
      "invalid-reference",
      "Artifact Resource payload descriptor substituted its exact Revision",
    );
  }
  const revision = store.workspace.getResourceRevisionForWorkspace(
    reference.workspaceId,
    reference.revisionId,
  );
  if (!revision || revision.resourceId !== reference.resourceId
    || revision.checksum !== reference.revisionChecksum
    || revision.manifestPath !== descriptor.manifestPath
    || revision.provenance.sourceType !== reference.sourceType) {
    throw new ArtifactResourceReferenceError(
      "invalid-reference",
      "Artifact Resource reference provenance substituted its exact immutable source",
    );
  }
  if (reference.sourceType === "project-reference" && descriptor.mimeType !== "application/json") {
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      "Project Reference Resource payload must be immutable JSON",
    );
  }
  const key = resourceRevisionMountKey(reference.revisionId);
  const relativeRoot = posix.join(REFERENCE_MOUNT, key);
  const payloadName = posix.basename(descriptor.mountPath);
  const payloadPath = posix.join(relativeRoot, payloadName);
  const absolutePayload = resolve(root, ...payloadPath.split("/"));
  try {
    await verifyResourceRevisionPayload(dataDir, descriptor, {
      destination: absolutePayload,
      signal,
      maxTextPayloadBytes: reference.sourceType === "project-reference"
        ? MAX_PROJECT_BUNDLE_BYTES
        : undefined,
    });
    await chmod(absolutePayload, 0o444);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw new ArtifactResourceReferenceError(
      "payload-invalid",
      "Artifact Resource Revision payload checksum or MIME verification failed",
      error,
    );
  }

  let projectRoot: string | undefined;
  if (reference.sourceType === "project-reference") {
    projectRoot = posix.join(relativeRoot, "project");
    const payload = await readFile(absolutePayload);
    const files = decodeProjectReferencePayload(payload);
    for (const file of files) {
      await writeExactFile(root, posix.join(projectRoot, file.path), file.bytes);
    }
  }
  return Object.freeze({
    resourceId: reference.resourceId,
    revisionId: reference.revisionId,
    revisionChecksum: reference.revisionChecksum,
    sourceType: reference.sourceType,
    mimeType: descriptor.mimeType,
    payloadPath,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  });
}

export function createProductionArtifactResourceReferenceMaterializer(input: {
  readonly store: Store;
  readonly dataDir: string;
}): ArtifactResourceReferenceMaterializerPort {
  const materializer: ArtifactResourceReferenceMaterializerPort = {
    async materializeExactReferences(request): Promise<ArtifactResourceReferenceFence | null> {
      checkAbort(request.signal);
      if (request.references.length === 0) return null;
      if (request.references.length > MAX_REFERENCES) {
        throw new ArtifactResourceReferenceError("invalid-reference", "Artifact Resource references exceed their limit");
      }
      const references = request.references.map(canonicalReference);
      const identities = new Set(references.map((reference) => (
        `${reference.resourceId}\0${reference.revisionId}`
      )));
      const contextPacks = new Set(references.map((reference) => (
        `${reference.workspaceId}\0${reference.contextPackId}\0${reference.contextPackHash}`
      )));
      if (identities.size !== references.length || contextPacks.size !== 1) {
        throw new ArtifactResourceReferenceError(
          "invalid-reference",
          "Artifact Resource references are duplicated or mix immutable Context Packs",
        );
      }
      const worktreeDir = await realpath(request.worktreeDir).catch((error) => {
        throw new ArtifactResourceReferenceError(
          "sidecar-missing",
          "Artifact reference candidate worktree is unavailable",
          error,
        );
      });
      const worktreeMetadata = await lstat(worktreeDir);
      if (!worktreeMetadata.isDirectory() || worktreeMetadata.isSymbolicLink()) {
        throw new ArtifactResourceReferenceError("sidecar-missing", "Artifact reference worktree is not a plain directory");
      }
      const parent = await ensurePlainParent(worktreeDir);
      const mount = join(worktreeDir, ...REFERENCE_MOUNT.split("/"));
      if (await pathExists(mount)) {
        throw new ArtifactResourceReferenceError(
          "sidecar-conflict",
          "Artifact candidate already contains the reserved Resource reference sidecar",
        );
      }
      const quarantineRoot = await mkdtemp(join(dirname(worktreeDir), ".dezin-artifact-references-"));
      const stagedRoot = join(quarantineRoot, "staged");
      const stagedMount = join(stagedRoot, ...REFERENCE_MOUNT.split("/"));
      const heldMount = join(quarantineRoot, "held");
      let installed = false;
      try {
        await mkdir(stagedMount, { recursive: true, mode: 0o755 });
        const materialized: MaterializedArtifactResourceReference[] = [];
        for (const reference of references) {
          materialized.push(await materializeReference(
            input.store,
            input.dataDir,
            stagedRoot,
            reference,
            request.signal,
          ));
        }
        await writeExactFile(stagedRoot, posix.join(REFERENCE_MOUNT, "manifest.json"), Buffer.from(
          `${stableStringify({
            protocol: "dezin.artifact-resource-reference-sidecar.v1",
            contextPackId: references[0]!.contextPackId,
            contextPackHash: references[0]!.contextPackHash,
            references: materialized,
          })}\n`,
          "utf8",
        ));
        await rename(stagedMount, mount);
        installed = true;
        await freezeReferenceDirectories(mount);
        const fingerprint = await sidecarFingerprint(worktreeDir, request.signal);
        let busy = false;
        let disposed = false;

        const verify = async (signal: AbortSignal): Promise<void> => {
          checkAbort(signal);
          if (disposed) {
            throw new ArtifactResourceReferenceError("sidecar-cleanup-failed", "Artifact reference fence is disposed");
          }
          if (busy) {
            throw new ArtifactResourceReferenceError("sidecar-conflict", "Artifact reference sidecar is temporarily hidden");
          }
          if (await sidecarFingerprint(worktreeDir, signal) !== fingerprint) {
            throw new ArtifactResourceReferenceError(
              "sidecar-mutated",
              "Artifact reference sidecar fingerprint changed",
            );
          }
        };

        const fence: ArtifactResourceReferenceFence = {
          protocol: "dezin.artifact-resource-reference-fence.v1",
          worktreeDir,
          mountPath: REFERENCE_MOUNT,
          fingerprint,
          references: Object.freeze(materialized),
          verify,
          async withoutMaterializedReferences<Result>(
            operation: () => Promise<Result>,
            signal: AbortSignal,
          ): Promise<Result> {
            if (busy) {
              throw new ArtifactResourceReferenceError(
                "sidecar-conflict",
                "Artifact reference candidate operations overlapped",
              );
            }
            await verify(signal);
            busy = true;
            let result: Result | undefined;
            let operationError: unknown = null;
            let integrityError: unknown = null;
            let hidden = false;
            const conflict = join(quarantineRoot, "candidate-conflict");
            try {
              // macOS denies renaming a read-only directory even when both
              // parents are writable. The root is writable only while hidden;
              // its exact read-only mode is restored before it is re-exposed.
              await chmod(mount, 0o755);
              await rename(mount, heldMount);
              hidden = true;
              try {
                result = await operation();
              } catch (error) {
                operationError = error;
              }
            } catch (error) {
              integrityError = error instanceof ArtifactResourceReferenceError
                ? error
                : new ArtifactResourceReferenceError(
                  "sidecar-conflict",
                  "Artifact reference sidecar could not be isolated from the candidate operation",
                  error,
                );
            } finally {
              try {
                if (hidden && await pathExists(heldMount)) {
                  await ensurePlainParent(worktreeDir);
                  if (await pathExists(mount)) {
                    await rename(mount, conflict);
                    integrityError ??= new ArtifactResourceReferenceError(
                      "sidecar-conflict",
                      "Candidate operation recreated the reserved Artifact reference sidecar",
                    );
                  }
                  await rename(heldMount, mount);
                  await chmod(mount, 0o555);
                  hidden = false;
                  await makeTreeRemovable(conflict);
                  await rm(conflict, { recursive: true, force: true });
                } else if (!hidden && await pathExists(mount)) {
                  await chmod(mount, 0o555);
                }
              } catch (error) {
                integrityError = new ArtifactResourceReferenceError(
                  "sidecar-cleanup-failed",
                  "Artifact reference sidecar could not be restored after the candidate operation",
                  error,
                );
              }
              busy = false;
            }
            try {
              await verify(signal);
            } catch (error) {
              integrityError ??= error;
            }
            if (integrityError !== null) throw integrityError;
            if (operationError !== null) throw operationError;
            return result as Result;
          },
          async dispose(): Promise<void> {
            if (disposed) return;
            if (busy) {
              throw new ArtifactResourceReferenceError(
                "sidecar-cleanup-failed",
                "Artifact reference fence cannot be disposed during a candidate operation",
              );
            }
            disposed = true;
            await makeTreeRemovable(mount);
            await rm(mount, { recursive: true, force: true });
            await makeTreeRemovable(quarantineRoot);
            await rm(quarantineRoot, { recursive: true, force: true });
            if (parent.created) {
              await rmdir(parent.path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
              });
            }
          },
        };
        return Object.freeze(fence);
      } catch (error) {
        if (installed) {
          await makeTreeRemovable(mount);
          await rm(mount, { recursive: true, force: true }).catch(() => {});
        }
        await makeTreeRemovable(quarantineRoot);
        await rm(quarantineRoot, { recursive: true, force: true }).catch(() => {});
        if (parent.created) await rmdir(parent.path).catch(() => {});
        throw error;
      }
    },
  };
  return Object.freeze(materializer);
}

export function artifactResourceReferencePrompt(
  fence: ArtifactResourceReferenceFence | null,
): string | null {
  if (fence === null) return null;
  return [
    "Exact immutable Resource reference files are mounted read-only in this candidate worktree.",
    "Use only the candidate-relative paths below; never substitute live files, refresh a referenced Project, or invent omitted evidence.",
    stableStringify({
      protocol: "dezin.artifact-resource-reference-prompt.v1",
      mountPath: fence.mountPath,
      references: fence.references,
    }),
  ].join("\n");
}

async function verifyAround<Result>(
  fence: ArtifactResourceReferenceFence,
  signal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  await fence.verify(signal);
  let result: Result;
  try {
    result = await operation();
  } catch (error) {
    await fence.verify(signal);
    throw error;
  }
  await fence.verify(signal);
  return result;
}

export function fenceArtifactResourceRunner(
  runner: AgentRunner,
  fence: ArtifactResourceReferenceFence | null,
  signal: AbortSignal,
): AgentRunner {
  if (fence === null) return runner;
  const fenced: AgentRunner = {
    id: runner.id,
    runTurn(input) {
      return verifyAround(fence, signal, () => runner.runTurn(input));
    },
  };
  return Object.freeze(fenced);
}

export function fenceArtifactResourceEvaluator(
  evaluator: StandardArtifactQualityEvaluatorPort,
  fence: ArtifactResourceReferenceFence | null,
  signal: AbortSignal,
): StandardArtifactQualityEvaluatorPort {
  if (fence === null) return evaluator;
  const fenced: StandardArtifactQualityEvaluatorPort = {
    ...(evaluator.maxRepairRounds === undefined ? {} : { maxRepairRounds: evaluator.maxRepairRounds }),
    evaluate(input) {
      return fence.withoutMaterializedReferences(() => evaluator.evaluate(input), signal);
    },
  };
  return Object.freeze(fenced);
}

export function fenceArtifactResourceCandidateTransaction(
  transaction: ArtifactResourceCandidateTransactionPort,
  fence: ArtifactResourceReferenceFence,
): ArtifactResourceCandidateTransactionPort {
  let transactionDir: string;
  try {
    transactionDir = realpathSync(transaction.dir);
  } catch {
    transactionDir = resolve(transaction.dir);
  }
  if (transactionDir !== resolve(fence.worktreeDir)) {
    throw new ArtifactResourceReferenceError(
      "invalid-reference",
      "Artifact Resource reference fence is scoped to another candidate worktree",
    );
  }
  let disposed = false;
  const fenced: ArtifactResourceCandidateTransactionPort = {
    dir: transaction.dir,
    attemptRef: transaction.attemptRef,
    fingerprint(signal) {
      return fence.withoutMaterializedReferences(() => transaction.fingerprint(signal), signal);
    },
    commit(message, signal) {
      return fence.withoutMaterializedReferences(() => transaction.commit(message, signal), signal);
    },
    restore(candidate, signal) {
      return fence.withoutMaterializedReferences(() => transaction.restore(candidate, signal), signal);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      let fenceError: unknown = null;
      try {
        await fence.dispose();
      } catch (error) {
        fenceError = error;
      }
      try {
        await transaction.dispose();
      } catch (error) {
        if (fenceError === null) throw error;
      }
      if (fenceError !== null) throw fenceError;
    },
  };
  return Object.freeze(fenced);
}
