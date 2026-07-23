import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { agentSpawnEnv } from "../../../../packages/agent/src/index.ts";
import { stableStringify } from "../context/context-types.ts";

const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;
const EMPTY_HOOKS_PATH = "/dev/null";
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ZERO_BYTE = Buffer.from([0]);
const SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_ARTIFACT_REVISION_EVIDENCE_ENTRIES = 2_048;
const MAX_ARTIFACT_REVISION_EVIDENCE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_REVISION_EVIDENCE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_REVISION_EVIDENCE_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface ArtifactCandidateAttempt {
  workspaceId: string;
  taskId: string;
  attempt: number;
  inputHash: string;
  createdAt: number;
  sourceCommitHash: string;
  sourceTreeHash: string;
}

export interface ArtifactCandidateIdentity {
  commitHash: string;
  treeHash: string;
}

export type ArtifactRevisionEvidenceKind = "frame" | "source";

export interface ArtifactRevisionEvidenceEntryDescriptor {
  readonly kind: ArtifactRevisionEvidenceKind;
  readonly round: number;
  readonly storageKey: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly descriptor: Readonly<Record<string, unknown>>;
}

export interface ArtifactRevisionEvidenceEntryInput extends ArtifactRevisionEvidenceEntryDescriptor {
  readonly bytes: Uint8Array;
}

export interface ArtifactRevisionEvidenceBundleSubject {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly artifactId: string;
  readonly trackId: string;
  readonly candidate: ArtifactCandidateIdentity;
  readonly contextPackHash: string;
  readonly attempt: ArtifactCandidateAttempt;
  readonly candidateEvidenceSha256: string;
  readonly entries: readonly ArtifactRevisionEvidenceEntryDescriptor[];
}

export interface PrepareArtifactRevisionEvidenceBundleInput extends Omit<
  ArtifactRevisionEvidenceBundleSubject,
  "entries"
> {
  readonly repositoryDir: string;
  readonly entries: readonly ArtifactRevisionEvidenceEntryInput[];
  readonly signal?: AbortSignal;
}

export interface VerifyArtifactRevisionEvidenceBundleInput extends ArtifactRevisionEvidenceBundleSubject {
  readonly repositoryDir: string;
  readonly signal?: AbortSignal;
}

export interface ArtifactRevisionEvidenceBundleIdentity {
  readonly ref: string;
  readonly commitHash: string;
  readonly treeHash: string;
  readonly manifestSha256: string;
}

/**
 * Complete verification receipt. The subject is intentionally carried with the Git identity so
 * promotion/recovery can re-run exact manifest/tree/blob verification instead of trusting a token.
 */
export interface ArtifactRevisionEvidenceBundleReceipt
extends ArtifactRevisionEvidenceBundleIdentity {
  readonly subject: ArtifactRevisionEvidenceBundleSubject;
}

export interface ArtifactCandidateResult extends ArtifactCandidateIdentity {
  attemptRef: string;
}

export interface BeginArtifactCandidateTransactionInput {
  repositoryDir: string;
  attempt: ArtifactCandidateAttempt;
  signal?: AbortSignal;
}

export interface ArtifactCandidateTransactionDeps {
  checkpoint?: (phase: "after-attempt-ref") => void | Promise<void>;
}

export interface CommitArtifactCandidateInput {
  message: string;
  signal?: AbortSignal;
}

export interface ArtifactCandidateTransaction {
  readonly dir: string;
  readonly worktreeDir: string;
  readonly attemptRef: string;
  fingerprint(signal: AbortSignal): Promise<string>;
  commit(message: string, signal: AbortSignal): Promise<ArtifactCandidateResult>;
  commitCandidate(input: CommitArtifactCandidateInput): Promise<ArtifactCandidateResult>;
  restore(candidate: ArtifactCandidateIdentity, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export interface ArtifactCandidateLifecycleInput {
  repositoryDir: string;
  attempt: ArtifactCandidateAttempt;
  revisionId: string;
  candidate: ArtifactCandidateIdentity & { attemptRef?: string };
  /** Exact ordered candidate versions recorded in immutable execution evidence. */
  history: readonly ArtifactCandidateIdentity[];
  /** Exact final Attempt head that retains every version, including rounds after the selection. */
  historyHead: ArtifactCandidateIdentity;
  /**
   * Immutable evidence bundle promoted atomically with the selected Revision and version history.
   * Optional only while legacy callers migrate; production Artifact publication must provide it.
   */
  evidence?: ArtifactRevisionEvidenceBundleReceipt;
  signal?: AbortSignal;
}

export interface ReleaseOrphanArtifactCandidateAttemptRefInput {
  repositoryDir: string;
  attempt: ArtifactCandidateAttempt;
  signal?: AbortSignal;
}

export interface VerifyArtifactCandidateObjectInput {
  repositoryDir: string;
  commitHash: string;
  treeHash: string;
  signal?: AbortSignal;
}

export class ArtifactCandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactCandidateValidationError";
  }
}

export class ArtifactCandidateRevisionRefNotRetainedError extends ArtifactCandidateValidationError {
  readonly ref: string;
  readonly state: "missing" | "conflict";
  readonly actual: string | null;

  constructor(ref: string, actual: string | null) {
    super(actual === null
      ? `durable revision ref does not retain the candidate: ${ref} is missing`
      : `durable revision ref does not retain the candidate: ${ref} conflicts`);
    this.name = "ArtifactCandidateRevisionRefNotRetainedError";
    this.ref = ref;
    this.state = actual === null ? "missing" : "conflict";
    this.actual = actual;
  }
}

export class ArtifactCandidateRefConflictError extends Error {
  readonly ref: string;

  constructor(ref: string, message = `durable Artifact candidate ref ${ref} changed concurrently`) {
    super(message);
    this.name = "ArtifactCandidateRefConflictError";
    this.ref = ref;
  }
}

interface ResolvedRepository {
  root: string;
  commonGitDir: string;
  objectDir: string;
  objectIdLength: 40 | 64;
  objectFormat: "sha1" | "sha256";
}

interface GitCommandOptions {
  signal?: AbortSignal;
  input?: string | Buffer;
  gitEnv?: NodeJS.ProcessEnv;
  hooksPath?: string;
}

interface GitCommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact candidate transaction aborted", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function combinedSignal(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
  if (left === undefined) return right;
  if (right === undefined || right === left) return left;
  return AbortSignal.any([left, right]);
}

function safeGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = agentSpawnEnv();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_PAGER: "cat",
    ...extra,
  };
}

function hardenedGitArgs(args: readonly string[], hooksPath = EMPTY_HOOKS_PATH): string[] {
  return [
    "--no-replace-objects",
    "-c", `core.hooksPath=${hooksPath}`,
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false",
    "-c", "core.attributesFile=/dev/null",
    ...args,
  ];
}

function captureGit(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  checkAbort(options.signal);
  return new Promise((resolveCommand, reject) => {
    const child = spawn("git", hardenedGitArgs(args, options.hooksPath), {
      cwd,
      env: safeGitEnvironment(options.gitEnv),
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > GIT_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(() => reject(new ArtifactCandidateValidationError("Git output exceeded the Artifact transaction limit")));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish(() => reject(options.signal?.aborted ? abortReason(options.signal) : error)));
    child.on("close", (code) => finish(() => resolveCommand({
      code: code ?? 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    })));
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") finish(() => reject(error));
    });
    child.stdin.end(options.input);
  });
}

function gitError(args: readonly string[], result: GitCommandResult): Error {
  const detail = Buffer.concat([result.stderr, result.stdout]).toString("utf8").trim();
  return new Error(`git ${args.join(" ")} failed: ${detail || `exit ${result.code}`}`);
}

async function gitBuffer(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<Buffer> {
  const result = await captureGit(cwd, args, options);
  if (result.code !== 0) throw gitError(args, result);
  checkAbort(options.signal);
  return result.stdout;
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<string> {
  return (await gitBuffer(cwd, args, options)).toString("utf8").trim();
}

async function gitVoid(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<void> {
  await gitBuffer(cwd, args, options);
}

function canonicalString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || value.includes("\0") || !isWellFormed(value)) {
    throw new ArtifactCandidateValidationError(`${label} is invalid`);
  }
  return value;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalObjectId(value: unknown, label: string, expectedLength?: 40 | 64): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)
    || (expectedLength !== undefined && value.length !== expectedLength)) {
    throw new ArtifactCandidateValidationError(`${label} is not a canonical Git object id`);
  }
  return value;
}

function canonicalAttempt(value: ArtifactCandidateAttempt, objectIdLength?: 40 | 64): ArtifactCandidateAttempt {
  const attempt = {
    workspaceId: canonicalString(value?.workspaceId, "Artifact Attempt workspace id", 256),
    taskId: canonicalString(value?.taskId, "Artifact Attempt Task id", 256),
    attempt: value?.attempt,
    inputHash: value?.inputHash,
    createdAt: value?.createdAt,
    sourceCommitHash: canonicalObjectId(
      value?.sourceCommitHash,
      "Artifact Attempt source commit hash",
      objectIdLength,
    ),
    sourceTreeHash: canonicalObjectId(
      value?.sourceTreeHash,
      "Artifact Attempt source tree hash",
      objectIdLength,
    ),
  };
  if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1
    || typeof attempt.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(attempt.inputHash)
    || !Number.isSafeInteger(attempt.createdAt) || attempt.createdAt < 0) {
    throw new ArtifactCandidateValidationError("Artifact Attempt identity is invalid");
  }
  return attempt as ArtifactCandidateAttempt;
}

function safeRefDigest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function artifactCandidateAttemptRef(attemptInput: ArtifactCandidateAttempt): string {
  const attempt = canonicalAttempt(attemptInput);
  return `refs/dezin/generation-attempts/artifacts/${safeRefDigest([
    "artifact-candidate-attempt-v1",
    attempt.workspaceId,
    attempt.taskId,
    attempt.attempt,
    attempt.inputHash,
  ])}`;
}

export function artifactRevisionRef(revisionIdInput: string): string {
  const revisionId = canonicalString(revisionIdInput, "Artifact Revision id", 256);
  // Keep one canonical Revision namespace with direct mutation and recovery flows.
  return `refs/dezin/artifact-revisions/${createHash("sha256").update(revisionId).digest("hex")}`;
}

/** Canonical durable head from which Task 15 viewers can derive a Revision's full version lineage. */
export function artifactRevisionHistoryRef(revisionIdInput: string): string {
  const revisionId = canonicalString(revisionIdInput, "Artifact Revision id", 256);
  return `refs/dezin/artifact-revision-history/${createHash("sha256").update(revisionId).digest("hex")}`;
}

/** Canonical immutable visual-evidence bundle retained for one exact Artifact Revision. */
export function artifactRevisionEvidenceRef(
  workspaceIdInput: string,
  revisionIdInput: string,
): string {
  const workspaceId = canonicalString(workspaceIdInput, "Artifact evidence Workspace id", 256);
  const revisionId = canonicalString(revisionIdInput, "Artifact evidence Revision id", 256);
  return `refs/dezin/artifact-revision-evidence/${safeRefDigest([
    "artifact-revision-evidence-v1",
    workspaceId,
    revisionId,
  ])}`;
}

async function resolveRepository(repositoryDir: string, signal?: AbortSignal): Promise<ResolvedRepository> {
  checkAbort(signal);
  const repositoryPath = canonicalString(repositoryDir, "Artifact repository path", 4_096);
  if (repositoryPath.includes("\n") || repositoryPath.includes("\r")) {
    throw new ArtifactCandidateValidationError("Artifact repository path is invalid");
  }
  const requested = await realpath(resolve(repositoryPath));
  const topLevelOutput = await gitOutput(requested, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { signal });
  const topLevel = await realpath(topLevelOutput);
  if (requested !== topLevel) {
    throw new ArtifactCandidateValidationError("Artifact repository path must be the owned repository root");
  }
  const [bare, commonGitDirOutput, objectDirOutput, objectFormat] = await Promise.all([
    gitOutput(requested, ["rev-parse", "--is-bare-repository"], { signal }),
    gitOutput(requested, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
    gitOutput(requested, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], { signal }),
    gitOutput(requested, ["rev-parse", "--show-object-format"], { signal }),
  ]);
  if (bare !== "false" || (objectFormat !== "sha1" && objectFormat !== "sha256")) {
    throw new ArtifactCandidateValidationError("Artifact repository must be an owned non-bare SHA repository");
  }
  const commonGitDir = await realpath(commonGitDirOutput);
  const objectDir = await realpath(objectDirOutput);
  if (objectDir.includes("\n") || objectDir.includes("\r")) {
    throw new ArtifactCandidateValidationError("Artifact repository object directory is invalid");
  }
  return {
    root: topLevel,
    commonGitDir,
    objectDir,
    objectFormat,
    objectIdLength: objectFormat === "sha1" ? 40 : 64,
  };
}

async function verifyObjectInRepository(
  repository: ResolvedRepository,
  commitHashInput: string,
  treeHashInput: string,
  signal?: AbortSignal,
): Promise<ArtifactCandidateIdentity> {
  const commitHash = canonicalObjectId(commitHashInput, "Artifact candidate commit hash", repository.objectIdLength);
  const treeHash = canonicalObjectId(treeHashInput, "Artifact candidate tree hash", repository.objectIdLength);
  let commitType: string;
  let treeType: string;
  let exactTree: string;
  try {
    [commitType, treeType, exactTree] = await Promise.all([
      gitOutput(repository.root, ["cat-file", "-t", commitHash], { signal }),
      gitOutput(repository.root, ["cat-file", "-t", treeHash], { signal }),
      gitOutput(repository.root, ["rev-parse", "--verify", `${commitHash}^{tree}`], { signal }),
    ]);
  } catch {
    checkAbort(signal);
    throw new ArtifactCandidateValidationError("Artifact candidate commit or tree is not exactly readable in the owned repository");
  }
  if (commitType !== "commit" || treeType !== "tree" || exactTree !== treeHash) {
    throw new ArtifactCandidateValidationError("Artifact candidate commit does not name the exact expected tree");
  }
  return { commitHash, treeHash };
}

export async function verifyArtifactCandidateObject(
  input: VerifyArtifactCandidateObjectInput,
): Promise<ArtifactCandidateIdentity> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  return verifyObjectInRepository(repository, input.commitHash, input.treeHash, input.signal);
}

interface NormalizedArtifactRevisionEvidenceEntry extends ArtifactRevisionEvidenceEntryDescriptor {
  descriptor: Readonly<Record<string, unknown>>;
  blobPath: string;
  bytes?: Buffer;
}

interface NormalizedArtifactRevisionEvidenceSubject {
  projectId: string;
  workspaceId: string;
  revisionId: string;
  artifactId: string;
  trackId: string;
  candidate: ArtifactCandidateIdentity;
  contextPackHash: string;
  attempt: ArtifactCandidateAttempt;
  candidateEvidenceSha256: string;
  entries: readonly NormalizedArtifactRevisionEvidenceEntry[];
}

function canonicalEvidenceOwnerId(value: unknown, label: string): string {
  const exact = canonicalString(value, label, 256);
  if (!EVIDENCE_OWNER_ID.test(exact)) {
    throw new ArtifactCandidateValidationError(`${label} is invalid`);
  }
  return exact;
}

function canonicalSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ArtifactCandidateValidationError(`${label} is not a canonical SHA-256 digest`);
  }
  return value;
}

function canonicalEvidenceText(value: unknown, label: string, maximum: number): string {
  const exact = canonicalString(value, label, maximum);
  if (exact !== exact.trim() || /[\u0000-\u001f\u007f]/.test(exact)) {
    throw new ArtifactCandidateValidationError(`${label} is invalid`);
  }
  return exact;
}

function canonicalEvidenceDescriptor(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  let canonical: string;
  try {
    canonical = stableStringify(value);
  } catch {
    throw new ArtifactCandidateValidationError(`${label} is not canonical JSON`);
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_ARTIFACT_REVISION_EVIDENCE_MANIFEST_BYTES) {
    throw new ArtifactCandidateValidationError(`${label} exceeds its canonical byte limit`);
  }
  const descriptor = JSON.parse(canonical) as unknown;
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new ArtifactCandidateValidationError(`${label} must be a JSON object`);
  }
  return descriptor as Readonly<Record<string, unknown>>;
}

function evidenceBlobPath(sha256: string): string {
  return `png/sha256/${sha256.slice(0, 2)}/${sha256}.png`;
}

function normalizeArtifactRevisionEvidenceSubject(
  input: ArtifactRevisionEvidenceBundleSubject | PrepareArtifactRevisionEvidenceBundleInput,
  objectIdLength: 40 | 64,
  requireBytes: boolean,
): NormalizedArtifactRevisionEvidenceSubject {
  const projectId = canonicalEvidenceOwnerId(input?.projectId, "Artifact evidence Project id");
  const workspaceId = canonicalEvidenceOwnerId(input?.workspaceId, "Artifact evidence Workspace id");
  const revisionId = canonicalEvidenceOwnerId(input?.revisionId, "Artifact evidence Revision id");
  const artifactId = canonicalEvidenceOwnerId(input?.artifactId, "Artifact evidence Artifact id");
  const trackId = canonicalEvidenceOwnerId(input?.trackId, "Artifact evidence Track id");
  const attempt = canonicalAttempt(input?.attempt, objectIdLength);
  const candidate = {
    commitHash: canonicalObjectId(
      input?.candidate?.commitHash,
      "Artifact evidence candidate commit hash",
      objectIdLength,
    ),
    treeHash: canonicalObjectId(
      input?.candidate?.treeHash,
      "Artifact evidence candidate tree hash",
      objectIdLength,
    ),
  };
  if (workspaceId !== attempt.workspaceId) {
    throw new ArtifactCandidateValidationError(
      "Artifact evidence Workspace does not match its immutable Attempt",
    );
  }
  const contextPackHash = canonicalSha256(
    input?.contextPackHash,
    "Artifact evidence Context Pack hash",
  );
  const candidateEvidenceSha256 = canonicalSha256(
    input?.candidateEvidenceSha256,
    "Artifact candidate evidence hash",
  );
  if (!Array.isArray(input?.entries)
    || input.entries.length > MAX_ARTIFACT_REVISION_EVIDENCE_ENTRIES) {
    throw new ArtifactCandidateValidationError("Artifact Revision evidence entry count is invalid");
  }
  const storageKeys = new Set<string>();
  const blobByteLengths = new Map<string, number>();
  let totalBytes = 0;
  const entries = input.entries.map((unsafeEntry, index): NormalizedArtifactRevisionEvidenceEntry => {
    if (unsafeEntry === null || typeof unsafeEntry !== "object" || Array.isArray(unsafeEntry)) {
      throw new ArtifactCandidateValidationError(`Artifact Revision evidence entry ${index} is invalid`);
    }
    const entry = unsafeEntry as ArtifactRevisionEvidenceEntryDescriptor & { readonly bytes?: unknown };
    if (entry.kind !== "frame" && entry.kind !== "source") {
      throw new ArtifactCandidateValidationError(`Artifact Revision evidence entry ${index} kind is invalid`);
    }
    if (!Number.isSafeInteger(entry.round) || entry.round < 0) {
      throw new ArtifactCandidateValidationError(`Artifact Revision evidence entry ${index} round is invalid`);
    }
    const storageKey = canonicalEvidenceText(
      entry.storageKey,
      `Artifact Revision evidence entry ${index} storage key`,
      4_096,
    );
    if (storageKeys.has(storageKey)) {
      throw new ArtifactCandidateValidationError("Artifact Revision evidence storage keys must be unique");
    }
    storageKeys.add(storageKey);
    const sha256 = canonicalSha256(
      entry.sha256,
      `Artifact Revision evidence entry ${index} digest`,
    );
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1
      || entry.byteLength > MAX_ARTIFACT_REVISION_EVIDENCE_ENTRY_BYTES) {
      throw new ArtifactCandidateValidationError(
        `Artifact Revision evidence entry ${index} byte length is invalid`,
      );
    }
    const retainedByteLength = blobByteLengths.get(sha256);
    if (retainedByteLength !== undefined && retainedByteLength !== entry.byteLength) {
      throw new ArtifactCandidateValidationError(
        "Artifact Revision evidence entries assign contradictory byte lengths to the same SHA-256 blob",
      );
    }
    blobByteLengths.set(sha256, entry.byteLength);
    const descriptor = canonicalEvidenceDescriptor(
      entry.descriptor,
      `Artifact Revision evidence entry ${index} descriptor`,
    );
    if (descriptor.round !== entry.round
      || descriptor.storageKey !== storageKey
      || descriptor.sha256 !== sha256
      || descriptor.byteLength !== entry.byteLength) {
      throw new ArtifactCandidateValidationError(
        `Artifact Revision evidence entry ${index} diverges from its exact descriptor`,
      );
    }
    let bytes: Buffer | undefined;
    if (requireBytes) {
      if (!(entry.bytes instanceof Uint8Array)) {
        throw new ArtifactCandidateValidationError(
          `Artifact Revision evidence entry ${index} bytes are unavailable`,
        );
      }
      bytes = Buffer.from(entry.bytes);
      if (bytes.byteLength !== entry.byteLength
        || createHash("sha256").update(bytes).digest("hex") !== sha256) {
        throw new ArtifactCandidateValidationError(
          `Artifact Revision evidence entry ${index} bytes do not match their identity`,
        );
      }
    }
    totalBytes += entry.byteLength;
    if (!Number.isSafeInteger(totalBytes)
      || totalBytes > MAX_ARTIFACT_REVISION_EVIDENCE_TOTAL_BYTES) {
      throw new ArtifactCandidateValidationError(
        "Artifact Revision evidence bundle exceeds its total byte limit",
      );
    }
    return {
      kind: entry.kind,
      round: entry.round,
      storageKey,
      sha256,
      byteLength: entry.byteLength,
      descriptor,
      blobPath: evidenceBlobPath(sha256),
      ...(bytes === undefined ? {} : { bytes }),
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.storageKey, "utf8"),
    Buffer.from(right.storageKey, "utf8"),
  ));
  return {
    projectId,
    workspaceId,
    revisionId,
    artifactId,
    trackId,
    candidate,
    contextPackHash,
    attempt,
    candidateEvidenceSha256,
    entries,
  };
}

function artifactRevisionEvidenceManifest(
  subject: NormalizedArtifactRevisionEvidenceSubject,
): Readonly<Record<string, unknown>> {
  return {
    protocol: "dezin.artifact-revision-evidence.v1",
    revision: {
      projectId: subject.projectId,
      workspaceId: subject.workspaceId,
      revisionId: subject.revisionId,
      artifactId: subject.artifactId,
      trackId: subject.trackId,
      sourceCommitHash: subject.candidate.commitHash,
      sourceTreeHash: subject.candidate.treeHash,
      contextPackHash: subject.contextPackHash,
    },
    originAttempt: {
      workspaceId: subject.attempt.workspaceId,
      taskId: subject.attempt.taskId,
      attempt: subject.attempt.attempt,
      inputHash: subject.attempt.inputHash,
      createdAt: subject.attempt.createdAt,
      sourceCommitHash: subject.attempt.sourceCommitHash,
      sourceTreeHash: subject.attempt.sourceTreeHash,
    },
    candidateEvidenceSha256: subject.candidateEvidenceSha256,
    entries: subject.entries.map((entry) => ({
      kind: entry.kind,
      round: entry.round,
      storageKey: entry.storageKey,
      sha256: entry.sha256,
      byteLength: entry.byteLength,
      blobPath: entry.blobPath,
      descriptor: entry.descriptor,
    })),
  };
}

function artifactRevisionEvidencePublicSubject(
  subject: NormalizedArtifactRevisionEvidenceSubject,
): ArtifactRevisionEvidenceBundleSubject {
  return {
    projectId: subject.projectId,
    workspaceId: subject.workspaceId,
    revisionId: subject.revisionId,
    artifactId: subject.artifactId,
    trackId: subject.trackId,
    candidate: { ...subject.candidate },
    contextPackHash: subject.contextPackHash,
    attempt: { ...subject.attempt },
    candidateEvidenceSha256: subject.candidateEvidenceSha256,
    entries: subject.entries.map((entry) => ({
      kind: entry.kind,
      round: entry.round,
      storageKey: entry.storageKey,
      sha256: entry.sha256,
      byteLength: entry.byteLength,
      descriptor: structuredClone(entry.descriptor),
    })),
  };
}

function artifactRevisionEvidenceManifestBytes(
  subject: NormalizedArtifactRevisionEvidenceSubject,
): Buffer {
  const bytes = Buffer.from(stableStringify(artifactRevisionEvidenceManifest(subject)), "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_REVISION_EVIDENCE_MANIFEST_BYTES) {
    throw new ArtifactCandidateValidationError(
      "Artifact Revision evidence manifest exceeds its canonical byte limit",
    );
  }
  return bytes;
}

interface EvidenceTreeNode {
  readonly blobs: Map<string, string>;
  readonly directories: Map<string, EvidenceTreeNode>;
}

function evidenceTreeNode(): EvidenceTreeNode {
  return { blobs: new Map(), directories: new Map() };
}

function insertEvidenceTreeBlob(root: EvidenceTreeNode, path: string, objectId: string): void {
  const parts = path.split("/");
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (node.blobs.has(part)) {
      throw new ArtifactCandidateValidationError("Artifact Revision evidence tree path collides");
    }
    let child = node.directories.get(part);
    if (!child) {
      child = evidenceTreeNode();
      node.directories.set(part, child);
    }
    node = child;
  }
  const name = parts.at(-1)!;
  if (node.blobs.has(name) || node.directories.has(name)) {
    throw new ArtifactCandidateValidationError("Artifact Revision evidence tree path collides");
  }
  node.blobs.set(name, objectId);
}

async function hashRepositoryObject(
  repository: ResolvedRepository,
  type: "blob" | "commit",
  bytes: Buffer,
  write: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const objectId = await gitOutput(repository.root, [
    "hash-object",
    ...(write ? ["-w"] : []),
    "-t",
    type,
    ...(type === "blob" ? ["--no-filters"] : []),
    "--stdin",
  ], { signal, input: bytes });
  return canonicalObjectId(
    objectId,
    `Artifact Revision evidence ${type} hash`,
    repository.objectIdLength,
  );
}

async function writeEvidenceTreeNode(
  repository: ResolvedRepository,
  node: EvidenceTreeNode,
  signal?: AbortSignal,
): Promise<string> {
  const names = [...node.blobs.keys(), ...node.directories.keys()].sort((left, right) => (
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  ));
  const records: Buffer[] = [];
  for (const name of names) {
    checkAbort(signal);
    const child = node.directories.get(name);
    const type = child ? "tree" : "blob";
    const mode = child ? "040000" : "100644";
    const objectId = child
      ? await writeEvidenceTreeNode(repository, child, signal)
      : node.blobs.get(name)!;
    records.push(Buffer.concat([
      Buffer.from(`${mode} ${type} ${objectId}\t`, "utf8"),
      Buffer.from(name, "utf8"),
      ZERO_BYTE,
    ]));
  }
  const treeHash = await gitOutput(repository.root, ["mktree", "-z"], {
    signal,
    input: Buffer.concat(records),
  });
  return canonicalObjectId(
    treeHash,
    "Artifact Revision evidence tree hash",
    repository.objectIdLength,
  );
}

function artifactRevisionEvidenceCommitObjectBytes(
  attempt: ArtifactCandidateAttempt,
  candidateCommitHash: string,
  treeHash: string,
  manifestSha256: string,
): Buffer {
  const timestampSeconds = Math.floor(attempt.createdAt / 1_000);
  const identity = `Dezin Evidence <daemon@dezin.local> ${timestampSeconds} +0000`;
  return Buffer.from([
    `tree ${treeHash}`,
    `parent ${candidateCommitHash}`,
    `author ${identity}`,
    `committer ${identity}`,
    "",
    `Dezin Artifact Revision evidence ${manifestSha256}`,
    "",
  ].join("\n"), "utf8");
}

function artifactRevisionEvidenceCommitBytes(
  subject: NormalizedArtifactRevisionEvidenceSubject,
  treeHash: string,
  manifestSha256: string,
): Buffer {
  return artifactRevisionEvidenceCommitObjectBytes(
    subject.attempt,
    subject.candidate.commitHash,
    treeHash,
    manifestSha256,
  );
}

function expectedEvidenceTreeRecords(
  subject: NormalizedArtifactRevisionEvidenceSubject,
): Map<string, { mode: string; type: string }> {
  const expected = new Map<string, { mode: string; type: string }>();
  expected.set("manifest.json", { mode: "100644", type: "blob" });
  const blobPaths = new Set(subject.entries.map((entry) => entry.blobPath));
  for (const path of blobPaths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index).join("/");
      expected.set(prefix, { mode: "040000", type: "tree" });
    }
    expected.set(path, { mode: "100644", type: "blob" });
  }
  return expected;
}

async function verifyArtifactRevisionEvidenceBundleObjects(
  repository: ResolvedRepository,
  subject: NormalizedArtifactRevisionEvidenceSubject,
  identity: ArtifactRevisionEvidenceBundleIdentity,
  requireRef: boolean,
  signal?: AbortSignal,
): Promise<ArtifactRevisionEvidenceBundleIdentity> {
  const ref = artifactRevisionEvidenceRef(subject.workspaceId, subject.revisionId);
  const commitHash = canonicalObjectId(
    identity?.commitHash,
    "Artifact Revision evidence commit hash",
    repository.objectIdLength,
  );
  const treeHash = canonicalObjectId(
    identity?.treeHash,
    "Artifact Revision evidence tree hash",
    repository.objectIdLength,
  );
  const manifestBytes = artifactRevisionEvidenceManifestBytes(subject);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (identity?.ref !== ref || identity?.manifestSha256 !== manifestSha256) {
    throw new ArtifactCandidateValidationError(
      "Artifact Revision evidence identity does not match its immutable subject",
    );
  }
  if (requireRef) {
    const retainedCommitHash = await readRef(repository, ref, signal);
    if (retainedCommitHash !== commitHash) {
      throw new ArtifactCandidateRevisionRefNotRetainedError(ref, retainedCommitHash);
    }
  }
  let commitType: string;
  let treeType: string;
  let rawCommit: Buffer;
  try {
    [commitType, treeType, rawCommit] = await Promise.all([
      gitOutput(repository.root, ["cat-file", "-t", commitHash], { signal }),
      gitOutput(repository.root, ["cat-file", "-t", treeHash], { signal }),
      gitBuffer(repository.root, ["cat-file", "commit", commitHash], { signal }),
    ]);
  } catch {
    checkAbort(signal);
    throw new ArtifactCandidateValidationError(
      "Artifact Revision evidence commit or tree is not readable",
    );
  }
  if (commitType !== "commit" || treeType !== "tree"
    || !rawCommit.equals(artifactRevisionEvidenceCommitBytes(subject, treeHash, manifestSha256))) {
    throw new ArtifactCandidateValidationError(
      "Artifact Revision evidence commit does not exactly bind its candidate, tree, and manifest",
    );
  }
  const records = parseTreeRecords(
    await gitBuffer(repository.root, ["ls-tree", "-r", "-t", "-z", "--full-tree", treeHash], { signal }),
    repository.objectIdLength,
  );
  const expectedRecords = expectedEvidenceTreeRecords(subject);
  const recordsByPath = new Map(records.map((record) => [record.path, record]));
  if (records.length !== expectedRecords.size || recordsByPath.size !== records.length) {
    throw new ArtifactCandidateValidationError(
      "Artifact Revision evidence tree contains missing, duplicate, or extra entries",
    );
  }
  for (const [path, expected] of expectedRecords) {
    const record = recordsByPath.get(path);
    if (!record || record.mode !== expected.mode || record.type !== expected.type) {
      throw new ArtifactCandidateValidationError(
        "Artifact Revision evidence tree does not exactly match its manifest",
      );
    }
  }
  const manifestRecord = recordsByPath.get("manifest.json")!;
  const storedManifest = await gitBuffer(
    repository.root,
    ["cat-file", "blob", manifestRecord.objectId],
    { signal },
  );
  if (!storedManifest.equals(manifestBytes)
    || createHash("sha256").update(storedManifest).digest("hex") !== manifestSha256) {
    throw new ArtifactCandidateValidationError(
      "Artifact Revision evidence manifest is not the exact canonical manifest",
    );
  }
  const entriesByHash = new Map<string, NormalizedArtifactRevisionEvidenceEntry>();
  for (const entry of subject.entries) entriesByHash.set(entry.sha256, entry);
  for (const entry of entriesByHash.values()) {
    checkAbort(signal);
    const record = recordsByPath.get(entry.blobPath)!;
    const bytes = await gitBuffer(repository.root, ["cat-file", "blob", record.objectId], { signal });
    if (bytes.byteLength !== entry.byteLength
      || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new ArtifactCandidateValidationError(
        `Artifact Revision evidence blob ${entry.sha256} failed content verification`,
      );
    }
  }
  return { ref, commitHash, treeHash, manifestSha256 };
}

export async function prepareArtifactRevisionEvidenceBundle(
  input: PrepareArtifactRevisionEvidenceBundleInput,
): Promise<ArtifactRevisionEvidenceBundleReceipt> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const subject = normalizeArtifactRevisionEvidenceSubject(input, repository.objectIdLength, true);
  await verifyAttemptBase(repository, subject.attempt, input.signal);
  await verifyObjectInRepository(
    repository,
    subject.candidate.commitHash,
    subject.candidate.treeHash,
    input.signal,
  );
  await assertCandidateFollowsAttemptBase(
    repository,
    subject.attempt,
    subject.candidate.commitHash,
    input.signal,
  );
  const manifestBytes = artifactRevisionEvidenceManifestBytes(subject);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const root = evidenceTreeNode();
  insertEvidenceTreeBlob(
    root,
    "manifest.json",
    await hashRepositoryObject(repository, "blob", manifestBytes, true, input.signal),
  );
  const blobs = new Map<string, Buffer>();
  for (const entry of subject.entries) {
    const bytes = entry.bytes!;
    const existing = blobs.get(entry.sha256);
    if (existing && !existing.equals(bytes)) {
      throw new ArtifactCandidateValidationError(
        "Artifact Revision evidence SHA-256 collision has inconsistent bytes",
      );
    }
    blobs.set(entry.sha256, bytes);
  }
  for (const [sha256, bytes] of blobs) {
    insertEvidenceTreeBlob(
      root,
      evidenceBlobPath(sha256),
      await hashRepositoryObject(repository, "blob", bytes, true, input.signal),
    );
  }
  const treeHash = await writeEvidenceTreeNode(repository, root, input.signal);
  const commitBytes = artifactRevisionEvidenceCommitBytes(subject, treeHash, manifestSha256);
  const commitHash = await hashRepositoryObject(repository, "commit", commitBytes, true, input.signal);
  const identity = await verifyArtifactRevisionEvidenceBundleObjects(repository, subject, {
    ref: artifactRevisionEvidenceRef(subject.workspaceId, subject.revisionId),
    commitHash,
    treeHash,
    manifestSha256,
  }, false, input.signal);
  return { ...identity, subject: artifactRevisionEvidencePublicSubject(subject) };
}

export async function verifyArtifactRevisionEvidenceBundle(
  input: VerifyArtifactRevisionEvidenceBundleInput,
): Promise<ArtifactRevisionEvidenceBundleReceipt> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const subject = normalizeArtifactRevisionEvidenceSubject(input, repository.objectIdLength, false);
  await verifyAttemptBase(repository, subject.attempt, input.signal);
  await verifyObjectInRepository(
    repository,
    subject.candidate.commitHash,
    subject.candidate.treeHash,
    input.signal,
  );
  await assertCandidateFollowsAttemptBase(
    repository,
    subject.attempt,
    subject.candidate.commitHash,
    input.signal,
  );
  const ref = artifactRevisionEvidenceRef(subject.workspaceId, subject.revisionId);
  const commitHash = await readRef(repository, ref, input.signal);
  if (commitHash === null) throw new ArtifactCandidateRevisionRefNotRetainedError(ref, null);
  let rawCommit: Buffer;
  try {
    rawCommit = await gitBuffer(repository.root, ["cat-file", "commit", commitHash], {
      signal: input.signal,
    });
  } catch {
    checkAbort(input.signal);
    throw new ArtifactCandidateValidationError("Artifact Revision evidence commit is not readable");
  }
  const firstLineEnd = rawCommit.indexOf(10);
  const treeLine = rawCommit.subarray(0, firstLineEnd < 0 ? rawCommit.length : firstLineEnd)
    .toString("ascii");
  const treeMatch = /^tree ([0-9a-f]+)$/.exec(treeLine);
  if (!treeMatch) {
    throw new ArtifactCandidateValidationError("Artifact Revision evidence commit tree is invalid");
  }
  const treeHash = canonicalObjectId(
    treeMatch[1],
    "Artifact Revision evidence tree hash",
    repository.objectIdLength,
  );
  const manifestSha256 = createHash("sha256")
    .update(artifactRevisionEvidenceManifestBytes(subject))
    .digest("hex");
  const identity = await verifyArtifactRevisionEvidenceBundleObjects(repository, subject, {
    ref,
    commitHash,
    treeHash,
    manifestSha256,
  }, true, input.signal);
  return { ...identity, subject: artifactRevisionEvidencePublicSubject(subject) };
}

async function verifyAttemptBase(
  repository: ResolvedRepository,
  attemptInput: ArtifactCandidateAttempt,
  signal?: AbortSignal,
): Promise<ArtifactCandidateAttempt> {
  const attempt = canonicalAttempt(attemptInput, repository.objectIdLength);
  let exactTree: string;
  try {
    const [commitType, treeType, resolvedTree] = await Promise.all([
      gitOutput(repository.root, ["cat-file", "-t", attempt.sourceCommitHash], { signal }),
      gitOutput(repository.root, ["cat-file", "-t", attempt.sourceTreeHash], { signal }),
      gitOutput(repository.root, ["rev-parse", "--verify", `${attempt.sourceCommitHash}^{tree}`], { signal }),
    ]);
    if (commitType !== "commit" || treeType !== "tree") throw new Error("wrong object type");
    exactTree = resolvedTree;
  } catch {
    checkAbort(signal);
    throw new ArtifactCandidateValidationError("immutable Artifact Attempt source commit or tree is not readable");
  }
  if (exactTree !== attempt.sourceTreeHash) {
    throw new ArtifactCandidateValidationError("immutable Artifact Attempt source tree does not match its exact commit");
  }
  return attempt;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch {
    throw new ArtifactCandidateValidationError(`${label} is not valid UTF-8`);
  }
}

function assertSafeRepositoryPath(path: string): void {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path) || posix.normalize(path) !== path
    || path === ".." || path.startsWith("../")
    || path.split("/").some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ArtifactCandidateValidationError("Artifact source tree contains an unsafe repository path");
  }
}

function assertConfinedSymlink(path: string, target: string): void {
  if (target.length === 0 || target.includes("\0") || isAbsolute(target)) {
    throw new ArtifactCandidateValidationError(`Artifact source symlink ${path} escapes the isolated worktree`);
  }
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolvedTarget === ".." || resolvedTarget.startsWith("../") || isAbsolute(resolvedTarget)) {
    throw new ArtifactCandidateValidationError(`Artifact source symlink ${path} escapes the isolated worktree`);
  }
}

async function clearMaterializedWorktree(worktreeDir: string): Promise<void> {
  const entries = await readdir(worktreeDir);
  await Promise.all(entries
    .filter((name) => name !== ".git")
    .map((name) => rm(join(worktreeDir, name), { recursive: true, force: true })));
}

interface TreeRecord {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

function parseTreeRecords(output: Buffer, objectIdLength: 40 | 64): TreeRecord[] {
  const records: TreeRecord[] = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) throw new ArtifactCandidateValidationError("Artifact source tree listing is truncated");
    const record = output.subarray(offset, end);
    offset = end + 1;
    if (record.length === 0) continue;
    const separator = record.indexOf(9);
    if (separator < 0) throw new ArtifactCandidateValidationError("Artifact source tree listing is invalid");
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([0-9a-f]+)$/.exec(header);
    if (!match || match[3]!.length !== objectIdLength) {
      throw new ArtifactCandidateValidationError("Artifact source tree entry is invalid");
    }
    const path = decodeUtf8(record.subarray(separator + 1), "Artifact source path");
    assertSafeRepositoryPath(path);
    records.push({ mode: match[1]!, type: match[2]!, objectId: match[3]!, path });
  }
  return records;
}

async function materializeTree(
  repository: ResolvedRepository,
  treeHash: string,
  worktreeDir: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  await clearMaterializedWorktree(worktreeDir);
  const listing = await gitBuffer(repository.root, ["ls-tree", "-r", "-t", "-z", "--full-tree", treeHash], { signal });
  const records = parseTreeRecords(listing, repository.objectIdLength);
  for (const record of records) {
    checkAbort(signal);
    const absolutePath = resolve(worktreeDir, ...record.path.split("/"));
    const offset = relative(worktreeDir, absolutePath);
    if (offset.startsWith("..") || isAbsolute(offset)) {
      throw new ArtifactCandidateValidationError("Artifact source path escaped the isolated worktree");
    }
    if (record.mode === "040000" && record.type === "tree") {
      await mkdir(absolutePath, { recursive: true });
      continue;
    }
    if (record.mode === "160000" || record.type === "commit") {
      throw new ArtifactCandidateValidationError("Artifact source cannot contain Gitlinks or submodules");
    }
    await mkdir(resolve(absolutePath, ".."), { recursive: true });
    const bytes = await gitBuffer(repository.root, ["cat-file", "blob", record.objectId], { signal });
    if (record.mode === "120000") {
      const target = decodeUtf8(bytes, `Artifact symlink ${record.path}`);
      assertConfinedSymlink(record.path, target);
      await symlink(target, absolutePath);
    } else {
      await writeFile(absolutePath, bytes, { mode: record.mode === "100755" ? 0o755 : 0o644 });
      await chmod(absolutePath, record.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

interface IsolatedGit {
  gitDir: string;
  realGitDir: string;
  hooksDir: string;
  objectEnvironment: NodeJS.ProcessEnv;
}

function isolatedArgs(isolated: IsolatedGit, worktreeDir: string, args: readonly string[]): string[] {
  return [`--git-dir=${isolated.gitDir}`, `--work-tree=${worktreeDir}`, ...args];
}

async function hashBlob(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<string> {
  const hash = await gitOutput(worktreeDir, isolatedArgs(isolated, worktreeDir, [
    "hash-object", "-w", "--no-filters", "--stdin",
  ]), {
    signal,
    input: bytes,
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
  return canonicalObjectId(hash, "Artifact candidate blob hash", repository.objectIdLength);
}

async function buildDirectoryTree(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  directory: string,
  relativeDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  const names = (await readdir(directory)).sort((left, right) => (
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  ));
  const records: Buffer[] = [];
  for (const name of names) {
    checkAbort(signal);
    if (relativeDirectory === "" && name === ".git") continue;
    canonicalString(name, "Artifact candidate path component", 4_096);
    if (name === "." || name === ".." || name.toLowerCase() === ".git" || name.includes("/")) {
      throw new ArtifactCandidateValidationError("Artifact candidate contains an unsafe path component");
    }
    const path = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    assertSafeRepositoryPath(path);
    const absolutePath = join(directory, name);
    const metadata = await lstat(absolutePath);
    let mode: string;
    let type: "blob" | "tree";
    let objectId: string;
    if (metadata.isDirectory()) {
      mode = "040000";
      type = "tree";
      objectId = await buildDirectoryTree(
        repository,
        isolated,
        worktreeDir,
        absolutePath,
        path,
        signal,
      );
    } else if (metadata.isFile()) {
      mode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
      type = "blob";
      objectId = await hashBlob(repository, isolated, worktreeDir, await readFile(absolutePath), signal);
    } else if (metadata.isSymbolicLink()) {
      mode = "120000";
      type = "blob";
      const target = await readlink(absolutePath);
      assertConfinedSymlink(path, target);
      objectId = await hashBlob(repository, isolated, worktreeDir, Buffer.from(target, "utf8"), signal);
    } else {
      throw new ArtifactCandidateValidationError(`Artifact candidate path ${path} has an unsupported file type`);
    }
    records.push(Buffer.concat([
      Buffer.from(`${mode} ${type} ${objectId}\t`, "utf8"),
      Buffer.from(name, "utf8"),
      ZERO_BYTE,
    ]));
  }
  const treeHash = await gitOutput(worktreeDir, isolatedArgs(isolated, worktreeDir, ["mktree", "-z"]), {
    signal,
    input: Buffer.concat(records),
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
  return canonicalObjectId(treeHash, "Artifact candidate tree hash", repository.objectIdLength);
}

async function buildWorktreeTree(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  signal?: AbortSignal,
): Promise<string> {
  const gitMetadata = await lstat(isolated.gitDir);
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()
    || await realpath(isolated.gitDir) !== isolated.realGitDir) {
    throw new ArtifactCandidateValidationError("isolated Artifact transaction Git metadata was replaced");
  }
  return buildDirectoryTree(repository, isolated, worktreeDir, worktreeDir, "", signal);
}

async function readRef(
  repository: ResolvedRepository,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await captureGit(repository.root, [
    "for-each-ref", "--format=%(refname)%00%(objectname)", ref,
  ], { signal });
  if (result.code !== 0) throw gitError(["for-each-ref", ref], result);
  const values = result.stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean)
    .map((line) => line.split("\0"))
    .filter(([name]) => name === ref);
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0]!.length !== 2) {
    throw new ArtifactCandidateValidationError(`durable ref ${ref} is ambiguous`);
  }
  return canonicalObjectId(values[0]![1], `durable ref ${ref}`, repository.objectIdLength);
}

async function advanceRef(
  repository: ResolvedRepository,
  ref: string,
  candidate: string,
  expected: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const oldValue = expected ?? "0".repeat(repository.objectIdLength);
  const result = await captureGit(repository.root, ["update-ref", ref, candidate, oldValue], { signal });
  if (result.code === 0) return;
  checkAbort(signal);
  const actual = await readRef(repository, ref, signal);
  if (actual === candidate) return;
  throw new ArtifactCandidateRefConflictError(ref);
}

function canonicalCommitMessage(value: unknown): string {
  const message = canonicalString(value, "Artifact candidate commit message", 4_096)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  if (message.length === 0) throw new ArtifactCandidateValidationError("Artifact candidate commit message is empty");
  return message;
}

async function writeCandidateCommit(
  repository: ResolvedRepository,
  isolated: IsolatedGit,
  worktreeDir: string,
  attempt: ArtifactCandidateAttempt,
  parentCommitHash: string,
  treeHash: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  const timestampSeconds = Math.floor(attempt.createdAt / 1_000);
  const identityEnvironment: NodeJS.ProcessEnv = {
    ...isolated.objectEnvironment,
    GIT_AUTHOR_NAME: "Dezin",
    GIT_AUTHOR_EMAIL: "daemon@dezin.local",
    GIT_AUTHOR_DATE: `@${timestampSeconds} +0000`,
    GIT_COMMITTER_NAME: "Dezin",
    GIT_COMMITTER_EMAIL: "daemon@dezin.local",
    GIT_COMMITTER_DATE: `@${timestampSeconds} +0000`,
  };
  const commitHash = await gitOutput(worktreeDir, isolatedArgs(isolated, worktreeDir, [
    "commit-tree", treeHash, "-p", parentCommitHash,
  ]), {
    signal,
    input: `${message}\n`,
    gitEnv: identityEnvironment,
    hooksPath: isolated.hooksDir,
  });
  return canonicalObjectId(commitHash, "Artifact candidate commit hash", repository.objectIdLength);
}

async function pointIsolatedHead(
  isolated: IsolatedGit,
  worktreeDir: string,
  commitHash: string,
  treeHash: string,
  signal?: AbortSignal,
): Promise<void> {
  await gitVoid(worktreeDir, isolatedArgs(isolated, worktreeDir, [
    "update-ref", "--no-deref", "HEAD", commitHash,
  ]), {
    signal,
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
  await gitVoid(worktreeDir, isolatedArgs(isolated, worktreeDir, ["read-tree", treeHash]), {
    signal,
    gitEnv: isolated.objectEnvironment,
    hooksPath: isolated.hooksDir,
  });
}

export async function beginArtifactCandidateTransaction(
  input: BeginArtifactCandidateTransactionInput,
  deps: ArtifactCandidateTransactionDeps = {},
): Promise<ArtifactCandidateTransaction> {
  checkAbort(input.signal);
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = await verifyAttemptBase(repository, input.attempt, input.signal);
  const attemptRef = artifactCandidateAttemptRef(attempt);
  const transactionRoot = await mkdtemp(join(tmpdir(), "dezin-artifact-attempt-"));
  const worktreeDir = join(transactionRoot, "worktree");
  const hooksDir = join(transactionRoot, "empty-hooks");
  const gitDir = join(worktreeDir, ".git");
  let disposed = false;
  let durableHead: string | null = null;
  let durableTree = attempt.sourceTreeHash;
  let lastCandidate: ArtifactCandidateResult | null = null;
  let lastMessage: string | null = null;

  const isolated: IsolatedGit = {
    gitDir,
    realGitDir: gitDir,
    hooksDir,
    objectEnvironment: { GIT_OBJECT_DIRECTORY: repository.objectDir },
  };

  try {
    await mkdir(worktreeDir, { recursive: true });
    await mkdir(hooksDir, { recursive: true, mode: 0o700 });
    await gitVoid(transactionRoot, [
      "init", "-q", `--object-format=${repository.objectFormat}`, "--initial-branch=dezin-isolated", worktreeDir,
    ], { signal: input.signal, hooksPath: hooksDir });
    isolated.realGitDir = await realpath(gitDir);
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${repository.objectDir}\n`, { mode: 0o600 });
    await materializeTree(repository, attempt.sourceTreeHash, worktreeDir, input.signal);
    await pointIsolatedHead(isolated, worktreeDir, attempt.sourceCommitHash, attempt.sourceTreeHash, input.signal);
    const reproducedTree = await buildWorktreeTree(repository, isolated, worktreeDir, input.signal);
    if (reproducedTree !== attempt.sourceTreeHash) {
      throw new ArtifactCandidateValidationError("isolated Artifact worktree did not reproduce the exact Attempt tree");
    }
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const ensureOpen = (): void => {
    if (disposed) throw new ArtifactCandidateValidationError("Artifact candidate transaction is already disposed");
  };

  const commitCandidate = async (commitInput: CommitArtifactCandidateInput): Promise<ArtifactCandidateResult> => {
    ensureOpen();
    const signal = combinedSignal(input.signal, commitInput.signal);
    checkAbort(signal);
    const message = canonicalCommitMessage(commitInput.message);
    const treeHash = await buildWorktreeTree(repository, isolated, worktreeDir, signal);
    if (lastCandidate !== null && lastCandidate.treeHash === treeHash && lastMessage === message) {
      await advanceRef(repository, attemptRef, lastCandidate.commitHash, durableHead, signal);
      durableHead = lastCandidate.commitHash;
      await pointIsolatedHead(
        isolated,
        worktreeDir,
        lastCandidate.commitHash,
        lastCandidate.treeHash,
        signal,
      );
      await Promise.resolve().then(() => deps.checkpoint?.("after-attempt-ref"));
      return { ...lastCandidate };
    }
    if (treeHash === durableTree) {
      throw new ArtifactCandidateValidationError("Artifact candidate has no project changes to commit");
    }
    const parentCommitHash = durableHead ?? attempt.sourceCommitHash;
    const commitHash = await writeCandidateCommit(
      repository,
      isolated,
      worktreeDir,
      attempt,
      parentCommitHash,
      treeHash,
      message,
      signal,
    );
    await verifyObjectInRepository(repository, commitHash, treeHash, signal);
    await advanceRef(repository, attemptRef, commitHash, durableHead, signal);
    durableHead = commitHash;
    durableTree = treeHash;
    lastCandidate = { commitHash, treeHash, attemptRef };
    lastMessage = message;
    await pointIsolatedHead(isolated, worktreeDir, commitHash, treeHash, signal);
    await Promise.resolve().then(() => deps.checkpoint?.("after-attempt-ref"));
    return { ...lastCandidate };
  };

  return {
    dir: worktreeDir,
    worktreeDir,
    attemptRef,
    async fingerprint(signal: AbortSignal): Promise<string> {
      ensureOpen();
      return buildWorktreeTree(repository, isolated, worktreeDir, combinedSignal(input.signal, signal));
    },
    async commit(message: string, signal: AbortSignal): Promise<ArtifactCandidateResult> {
      return commitCandidate({ message, signal });
    },
    commitCandidate,
    async restore(candidateInput: ArtifactCandidateIdentity, restoreSignal: AbortSignal): Promise<void> {
      ensureOpen();
      const signal = combinedSignal(input.signal, restoreSignal);
      const candidate = await verifyObjectInRepository(
        repository,
        candidateInput.commitHash,
        candidateInput.treeHash,
        signal,
      );
      if (durableHead === null) {
        throw new ArtifactCandidateValidationError("cannot restore before an Artifact candidate is durably retained");
      }
      if (!await exactLinearAncestor(repository, candidate.commitHash, durableHead, signal)) {
        throw new ArtifactCandidateValidationError("restore target is not retained by the current Attempt candidate lineage");
      }
      await materializeTree(repository, candidate.treeHash, worktreeDir, signal);
      lastCandidate = null;
      lastMessage = null;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(transactionRoot, { recursive: true, force: true });
    },
  };
}

function candidateForLifecycle(
  repository: ResolvedRepository,
  attempt: ArtifactCandidateAttempt,
  candidateInput: ArtifactCandidateIdentity & { attemptRef?: string },
): ArtifactCandidateResult {
  const attemptRef = artifactCandidateAttemptRef(attempt);
  if (candidateInput.attemptRef !== undefined && candidateInput.attemptRef !== attemptRef) {
    throw new ArtifactCandidateValidationError("Artifact candidate Attempt ref does not match its immutable Attempt");
  }
  return {
    commitHash: canonicalObjectId(candidateInput.commitHash, "Artifact candidate commit hash", repository.objectIdLength),
    treeHash: canonicalObjectId(candidateInput.treeHash, "Artifact candidate tree hash", repository.objectIdLength),
    attemptRef,
  };
}

async function verifyArtifactRevisionEvidenceIdentityForLifecycle(
  repository: ResolvedRepository,
  attempt: ArtifactCandidateAttempt,
  revisionId: string,
  candidate: ArtifactCandidateIdentity,
  receiptInput: ArtifactRevisionEvidenceBundleReceipt,
  signal?: AbortSignal,
): Promise<ArtifactRevisionEvidenceBundleReceipt> {
  const ref = artifactRevisionEvidenceRef(attempt.workspaceId, revisionId);
  const subject = normalizeArtifactRevisionEvidenceSubject(
    receiptInput?.subject,
    repository.objectIdLength,
    false,
  );
  if (subject.workspaceId !== attempt.workspaceId
    || subject.revisionId !== revisionId
    || subject.candidate.commitHash !== candidate.commitHash
    || subject.candidate.treeHash !== candidate.treeHash
    || !isDeepStrictArtifactAttempt(subject.attempt, attempt)) {
    throw new ArtifactCandidateValidationError(
      "Artifact Revision evidence receipt does not match its lifecycle subject",
    );
  }
  const identity = await verifyArtifactRevisionEvidenceBundleObjects(repository, subject, {
    ref,
    commitHash: receiptInput.commitHash,
    treeHash: receiptInput.treeHash,
    manifestSha256: receiptInput.manifestSha256,
  }, false, signal);
  return { ...identity, subject: artifactRevisionEvidencePublicSubject(subject) };
}

function isDeepStrictArtifactAttempt(
  left: ArtifactCandidateAttempt,
  right: ArtifactCandidateAttempt,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.taskId === right.taskId
    && left.attempt === right.attempt
    && left.inputHash === right.inputHash
    && left.createdAt === right.createdAt
    && left.sourceCommitHash === right.sourceCommitHash
    && left.sourceTreeHash === right.sourceTreeHash;
}

async function assertAttemptHeadRetainsCandidate(
  repository: ResolvedRepository,
  attemptRef: string,
  attemptHead: string,
  candidateCommitHash: string,
  signal?: AbortSignal,
): Promise<void> {
  canonicalObjectId(attemptHead, "durable Artifact Attempt head", repository.objectIdLength);
  if (await exactLinearAncestor(repository, candidateCommitHash, attemptHead, signal)) return;
  throw new ArtifactCandidateRefConflictError(
    attemptRef,
    "durable Artifact Attempt head is not a descendant of the selected candidate",
  );
}

async function exactLinearAncestor(
  repository: ResolvedRepository,
  ancestorCommitHash: string,
  descendantCommitHash: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const ancestor = canonicalObjectId(
    ancestorCommitHash,
    "Artifact candidate lineage ancestor",
    repository.objectIdLength,
  );
  let current = canonicalObjectId(
    descendantCommitHash,
    "Artifact candidate lineage descendant",
    repository.objectIdLength,
  );
  const visited = new Set<string>();
  for (let depth = 0; depth <= 256; depth += 1) {
    checkAbort(signal);
    if (current === ancestor) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    // Candidate commits are deliberately one-parent commits. A merge, graft-only
    // relationship, cycle, or overly deep chain is outside the Attempt lineage.
    const parent = await exactCandidateParent(repository, current, signal);
    if (parent === null) return false;
    current = parent;
  }
  return false;
}

async function exactCandidateParent(
  repository: ResolvedRepository,
  commitHash: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const rawCommit = await gitBuffer(repository.root, ["cat-file", "commit", commitHash], { signal });
  const headerEnd = rawCommit.indexOf(Buffer.from("\n\n"));
  const header = rawCommit.subarray(0, headerEnd < 0 ? rawCommit.length : headerEnd).toString("ascii");
  const parents = header.split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));
  if (parents.length !== 1) return null;
  return canonicalObjectId(
    parents[0],
    "Artifact candidate lineage parent",
    repository.objectIdLength,
  );
}

async function verifyArtifactCandidateVersionHistory(
  repository: ResolvedRepository,
  attempt: ArtifactCandidateAttempt,
  candidate: ArtifactCandidateResult,
  historyInput: readonly ArtifactCandidateIdentity[],
  historyHead: ArtifactCandidateIdentity,
  signal?: AbortSignal,
): Promise<ArtifactCandidateIdentity[]> {
  if (!Array.isArray(historyInput) || historyInput.length < 1 || historyInput.length > 256) {
    throw new ArtifactCandidateValidationError("Artifact candidate version history is invalid");
  }
  const history: ArtifactCandidateIdentity[] = [];
  for (let index = 0; index < historyInput.length; index += 1) {
    checkAbort(signal);
    const version = await verifyObjectInRepository(
      repository,
      historyInput[index]?.commitHash,
      historyInput[index]?.treeHash,
      signal,
    );
    const expectedParent = index === 0
      ? attempt.sourceCommitHash
      : history[index - 1]!.commitHash;
    if (await exactCandidateParent(repository, version.commitHash, signal) !== expectedParent) {
      throw new ArtifactCandidateValidationError(
        "Artifact candidate version history is not the exact linear Attempt lineage",
      );
    }
    history.push(version);
  }
  const last = history.at(-1)!;
  if (last.commitHash !== historyHead.commitHash || last.treeHash !== historyHead.treeHash
    || !history.some((version) => (
      version.commitHash === candidate.commitHash && version.treeHash === candidate.treeHash
    ))) {
    throw new ArtifactCandidateValidationError(
      "Artifact candidate version history does not contain the exact selected Revision and head",
    );
  }
  return history;
}

async function assertCandidateFollowsAttemptBase(
  repository: ResolvedRepository,
  attempt: ArtifactCandidateAttempt,
  candidateCommitHash: string,
  signal?: AbortSignal,
): Promise<void> {
  if (candidateCommitHash === attempt.sourceCommitHash) {
    throw new ArtifactCandidateValidationError("selected Artifact commit is outside the generated candidate lineage");
  }
  if (await exactLinearAncestor(repository, attempt.sourceCommitHash, candidateCommitHash, signal)) return;
  throw new ArtifactCandidateValidationError("selected Artifact commit is outside the generated candidate lineage");
}

export async function promoteArtifactCandidateRef(
  input: ArtifactCandidateLifecycleInput,
): Promise<string> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = canonicalAttempt(input.attempt, repository.objectIdLength);
  const candidate = candidateForLifecycle(repository, attempt, input.candidate);
  const historyHead = await verifyObjectInRepository(
    repository,
    input.historyHead?.commitHash,
    input.historyHead?.treeHash,
    input.signal,
  );
  await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
  await assertCandidateFollowsAttemptBase(repository, attempt, candidate.commitHash, input.signal);
  await verifyArtifactCandidateVersionHistory(
    repository,
    attempt,
    candidate,
    input.history,
    historyHead,
    input.signal,
  );
  await assertAttemptHeadRetainsCandidate(
    repository,
    candidate.attemptRef,
    historyHead.commitHash,
    candidate.commitHash,
    input.signal,
  );
  const revisionRef = artifactRevisionRef(input.revisionId);
  const historyRef = artifactRevisionHistoryRef(input.revisionId);
  const evidence = input.evidence === undefined
    ? null
    : await verifyArtifactRevisionEvidenceIdentityForLifecycle(
      repository,
      attempt,
      input.revisionId,
      candidate,
      input.evidence,
      input.signal,
    );
  const verifyRetainedObjects = async (): Promise<void> => {
    await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
    await verifyObjectInRepository(repository, historyHead.commitHash, historyHead.treeHash, input.signal);
    if (evidence !== null) {
      await verifyArtifactRevisionEvidenceIdentityForLifecycle(
        repository,
        attempt,
        input.revisionId,
        candidate,
        evidence,
        input.signal,
      );
    }
  };
  for (let retry = 0; retry < 4; retry += 1) {
    const [attemptHead, existingRevision, existingHistory, existingEvidence] = await Promise.all([
      readRef(repository, candidate.attemptRef, input.signal),
      readRef(repository, revisionRef, input.signal),
      readRef(repository, historyRef, input.signal),
      evidence === null ? Promise.resolve(null) : readRef(repository, evidence.ref, input.signal),
    ]);
    if (existingRevision !== null && existingRevision !== candidate.commitHash) {
      throw new ArtifactCandidateRefConflictError(revisionRef);
    }
    if (existingHistory !== null && existingHistory !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(historyRef);
    }
    if (evidence !== null && existingEvidence !== null && existingEvidence !== evidence.commitHash) {
      throw new ArtifactCandidateRefConflictError(evidence.ref);
    }
    const retentionStates = evidence === null
      ? [existingRevision, existingHistory]
      : [existingRevision, existingHistory, existingEvidence];
    const presentRetentionCount = retentionStates.filter((value) => value !== null).length;
    const repairsLegacyEvidencePair = evidence !== null
      && existingRevision === candidate.commitHash
      && existingHistory === historyHead.commitHash
      && existingEvidence === null;
    if (presentRetentionCount !== 0 && presentRetentionCount !== retentionStates.length
      && !repairsLegacyEvidencePair) {
      throw new ArtifactCandidateRefConflictError(
        existingRevision === null
          ? revisionRef
          : existingHistory === null
            ? historyRef
            : evidence!.ref,
        evidence === null
          ? "durable Artifact Revision retention pair is partial"
          : "durable Artifact Revision retention triple is partial",
      );
    }
    // A fully completed promote + release is still an idempotent promote replay.
    if (attemptHead === null) {
      if (repairsLegacyEvidencePair) {
        const repair = await captureGit(repository.root, ["update-ref", "--stdin"], {
          signal: input.signal,
          input: [
            "start",
            `verify ${revisionRef} ${candidate.commitHash}`,
            `verify ${historyRef} ${historyHead.commitHash}`,
            `create ${evidence.ref} ${evidence.commitHash}`,
            "prepare",
            "commit",
            "",
          ].join("\n"),
        });
        if (repair.code === 0) {
          await verifyRetainedObjects();
          return revisionRef;
        }
        checkAbort(input.signal);
        const [currentRevision, currentHistory, currentEvidence] = await Promise.all([
          readRef(repository, revisionRef, input.signal),
          readRef(repository, historyRef, input.signal),
          readRef(repository, evidence.ref, input.signal),
        ]);
        if (currentRevision === candidate.commitHash
          && currentHistory === historyHead.commitHash
          && currentEvidence === evidence.commitHash) {
          await verifyRetainedObjects();
          return revisionRef;
        }
        if (currentRevision !== candidate.commitHash) {
          throw new ArtifactCandidateRefConflictError(revisionRef);
        }
        if (currentHistory !== historyHead.commitHash) {
          throw new ArtifactCandidateRefConflictError(historyRef);
        }
        throw new ArtifactCandidateRefConflictError(evidence.ref);
      }
      if (existingRevision === candidate.commitHash
        && existingHistory === historyHead.commitHash
        && (evidence === null || existingEvidence === evidence.commitHash)) {
        await verifyRetainedObjects();
        return revisionRef;
      }
      throw new ArtifactCandidateRefConflictError(
        candidate.attemptRef,
        "durable Artifact Attempt ref does not retain the selected candidate",
      );
    }
    await assertAttemptHeadRetainsCandidate(
      repository,
      candidate.attemptRef,
      attemptHead,
      candidate.commitHash,
      input.signal,
    );
    if (attemptHead !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(
        candidate.attemptRef,
        "durable Artifact Attempt head does not exactly match the retained version history",
      );
    }
    const transaction = [
      "start",
      `verify ${candidate.attemptRef} ${attemptHead}`,
      existingRevision === null
        ? `create ${revisionRef} ${candidate.commitHash}`
        : `verify ${revisionRef} ${candidate.commitHash}`,
      existingHistory === null
        ? `create ${historyRef} ${historyHead.commitHash}`
        : `verify ${historyRef} ${historyHead.commitHash}`,
      ...(evidence === null
        ? []
        : [existingEvidence === null
          ? `create ${evidence.ref} ${evidence.commitHash}`
          : `verify ${evidence.ref} ${evidence.commitHash}`]),
      "prepare",
      "commit",
      "",
    ].join("\n");
    const promotion = await captureGit(repository.root, ["update-ref", "--stdin"], {
      signal: input.signal,
      input: transaction,
    });
    if (promotion.code === 0) {
      await verifyRetainedObjects();
      return revisionRef;
    }
    checkAbort(input.signal);
    const [promoted, retainedHistory, retainedEvidence, currentAttempt] = await Promise.all([
      readRef(repository, revisionRef, input.signal),
      readRef(repository, historyRef, input.signal),
      evidence === null ? Promise.resolve(null) : readRef(repository, evidence.ref, input.signal),
      readRef(repository, candidate.attemptRef, input.signal),
    ]);
    if (promoted === candidate.commitHash
      && retainedHistory === historyHead.commitHash
      && (evidence === null || retainedEvidence === evidence.commitHash)
      && (currentAttempt === null || currentAttempt === historyHead.commitHash)) {
      await verifyRetainedObjects();
      return revisionRef;
    }
    if (promoted !== null) throw new ArtifactCandidateRefConflictError(revisionRef);
    if (retainedHistory !== null) throw new ArtifactCandidateRefConflictError(historyRef);
    if (evidence !== null && retainedEvidence !== null) {
      throw new ArtifactCandidateRefConflictError(evidence.ref);
    }
    if (currentAttempt !== null && currentAttempt !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(candidate.attemptRef);
    }
  }
  throw new ArtifactCandidateRefConflictError(
    candidate.attemptRef,
    "durable Artifact Attempt head kept changing during candidate promotion",
  );
}

export async function releaseArtifactCandidateAttemptRef(
  input: ArtifactCandidateLifecycleInput,
): Promise<boolean> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = canonicalAttempt(input.attempt, repository.objectIdLength);
  const candidate = candidateForLifecycle(repository, attempt, input.candidate);
  const revisionRef = artifactRevisionRef(input.revisionId);
  const historyRef = artifactRevisionHistoryRef(input.revisionId);
  const historyHead = await verifyObjectInRepository(
    repository,
    input.historyHead?.commitHash,
    input.historyHead?.treeHash,
    input.signal,
  );
  await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
  await assertCandidateFollowsAttemptBase(repository, attempt, candidate.commitHash, input.signal);
  await verifyArtifactCandidateVersionHistory(
    repository,
    attempt,
    candidate,
    input.history,
    historyHead,
    input.signal,
  );
  await assertAttemptHeadRetainsCandidate(
    repository,
    candidate.attemptRef,
    historyHead.commitHash,
    candidate.commitHash,
    input.signal,
  );
  const evidence = input.evidence === undefined
    ? null
    : await verifyArtifactRevisionEvidenceIdentityForLifecycle(
      repository,
      attempt,
      input.revisionId,
      candidate,
      input.evidence,
      input.signal,
    );
  const [retainedRevision, retainedHistory, retainedEvidence] = await Promise.all([
    readRef(repository, revisionRef, input.signal),
    readRef(repository, historyRef, input.signal),
    evidence === null ? Promise.resolve(null) : readRef(repository, evidence.ref, input.signal),
  ]);
  if (retainedRevision !== candidate.commitHash) {
    throw new ArtifactCandidateRevisionRefNotRetainedError(revisionRef, retainedRevision);
  }
  if (retainedHistory !== historyHead.commitHash) {
    throw new ArtifactCandidateRevisionRefNotRetainedError(historyRef, retainedHistory);
  }
  if (evidence !== null && retainedEvidence !== evidence.commitHash) {
    throw new ArtifactCandidateRevisionRefNotRetainedError(evidence.ref, retainedEvidence);
  }
  for (let retry = 0; retry < 4; retry += 1) {
    const attemptHead = await readRef(repository, candidate.attemptRef, input.signal);
    if (attemptHead === null) return false;
    await assertAttemptHeadRetainsCandidate(
      repository,
      candidate.attemptRef,
      attemptHead,
      candidate.commitHash,
      input.signal,
    );
    if (attemptHead !== historyHead.commitHash) {
      throw new ArtifactCandidateRefConflictError(
        candidate.attemptRef,
        "durable Artifact Attempt head does not exactly match the retained version history",
      );
    }
    const transaction = [
      "start",
      `verify ${revisionRef} ${candidate.commitHash}`,
      `verify ${historyRef} ${historyHead.commitHash}`,
      ...(evidence === null ? [] : [`verify ${evidence.ref} ${evidence.commitHash}`]),
      `delete ${candidate.attemptRef} ${attemptHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    const result = await captureGit(repository.root, ["update-ref", "--stdin"], {
      signal: input.signal,
      input: transaction,
    });
    if (result.code === 0) {
      const [currentRevision, currentHistory, currentEvidence] = await Promise.all([
        readRef(repository, revisionRef, input.signal),
        readRef(repository, historyRef, input.signal),
        evidence === null ? Promise.resolve(null) : readRef(repository, evidence.ref, input.signal),
      ]);
      if (currentRevision !== candidate.commitHash) {
        throw new ArtifactCandidateRevisionRefNotRetainedError(revisionRef, currentRevision);
      }
      if (currentHistory !== historyHead.commitHash) {
        throw new ArtifactCandidateRevisionRefNotRetainedError(historyRef, currentHistory);
      }
      if (evidence !== null && currentEvidence !== evidence.commitHash) {
        throw new ArtifactCandidateRevisionRefNotRetainedError(evidence.ref, currentEvidence);
      }
      await verifyObjectInRepository(repository, candidate.commitHash, candidate.treeHash, input.signal);
      await verifyObjectInRepository(repository, historyHead.commitHash, historyHead.treeHash, input.signal);
      if (evidence !== null) {
        await verifyArtifactRevisionEvidenceIdentityForLifecycle(
          repository,
          attempt,
          input.revisionId,
          candidate,
          evidence,
          input.signal,
        );
      }
      return true;
    }
    checkAbort(input.signal);
    const [currentRevision, currentHistory, currentEvidence] = await Promise.all([
      readRef(repository, revisionRef, input.signal),
      readRef(repository, historyRef, input.signal),
      evidence === null ? Promise.resolve(null) : readRef(repository, evidence.ref, input.signal),
    ]);
    if (currentRevision !== candidate.commitHash) {
      throw new ArtifactCandidateRevisionRefNotRetainedError(revisionRef, currentRevision);
    }
    if (currentHistory !== historyHead.commitHash) {
      throw new ArtifactCandidateRevisionRefNotRetainedError(historyRef, currentHistory);
    }
    if (evidence !== null && currentEvidence !== evidence.commitHash) {
      throw new ArtifactCandidateRevisionRefNotRetainedError(evidence.ref, currentEvidence);
    }
    if (await readRef(repository, candidate.attemptRef, input.signal) === null) return false;
  }
  throw new ArtifactCandidateRefConflictError(
    candidate.attemptRef,
    "durable Artifact Attempt head kept changing during ref release",
  );
}

/**
 * Deletes only the canonical ref for one exact immutable terminal Attempt.
 * The caller must obtain the terminal/no-candidate proof from Core; Git then
 * revalidates that every observed head is generated from the frozen source base
 * and compare-deletes that exact head in one ref transaction.
 */
export async function releaseOrphanArtifactCandidateAttemptRef(
  input: ReleaseOrphanArtifactCandidateAttemptRefInput,
): Promise<boolean> {
  const repository = await resolveRepository(input.repositoryDir, input.signal);
  const attempt = await verifyAttemptBase(repository, input.attempt, input.signal);
  const attemptRef = artifactCandidateAttemptRef(attempt);
  for (let retry = 0; retry < 4; retry += 1) {
    checkAbort(input.signal);
    const attemptHead = await readRef(repository, attemptRef, input.signal);
    if (attemptHead === null) return false;
    await assertCandidateFollowsAttemptBase(repository, attempt, attemptHead, input.signal);
    const transaction = [
      "start",
      `delete ${attemptRef} ${attemptHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    const result = await captureGit(repository.root, ["update-ref", "--stdin"], {
      signal: input.signal,
      input: transaction,
    });
    if (result.code === 0) return true;
    checkAbort(input.signal);
    if (await readRef(repository, attemptRef, input.signal) === null) return false;
  }
  throw new ArtifactCandidateRefConflictError(
    attemptRef,
    "durable orphan Artifact Attempt head kept changing during ref release",
  );
}
