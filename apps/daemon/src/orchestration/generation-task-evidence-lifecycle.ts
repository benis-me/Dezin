import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { readPngEvidenceFile, samePngEvidenceIdentity } from "../png-evidence.ts";
import {
  artifactRevisionEvidenceRef,
  type ArtifactRevisionEvidenceBundleReceipt,
} from "./artifact-candidate-transaction.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ATTEMPT = /^attempt-([1-9][0-9]*)$/;
const PNG_FILE = /^round-[0-9]+-.+-([a-f0-9]{64})\.png$/;
const QUARANTINE = ".quarantine";
const STORAGE_PREFIX = "generation-task-evidence/";
const MARKER = "owner.json";
const QUARANTINED_EVIDENCE = "evidence.png";
const ACTIVE_ATTEMPT_STATUSES = new Set([
  "queued",
  "running",
  "cancel-requested",
  "needs-rebase",
]);

interface EvidenceAttemptView {
  readonly taskId: string;
  readonly planId: string;
  readonly workspaceId: string;
  readonly attempt: number;
  readonly status: string;
  readonly candidateEvidence: Record<string, unknown> | null;
}

export interface GenerationTaskEvidenceLifecycleStorePort {
  getGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    taskId: string,
    attempt: number,
  ): EvidenceAttemptView | null;
}

export interface GenerationTaskEvidenceRecoverySummary {
  readonly scanned: number;
  readonly retained: number;
  readonly quarantined: number;
  readonly restored: number;
  readonly removed: number;
  readonly failed: number;
}

export interface GenerationTaskEvidenceAttemptIdentity {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly attempt: number;
}

interface DurablePublicationMarkerProof {
  readonly revisionId: string;
  readonly ref: string;
  readonly commitHash: string;
  readonly treeHash: string;
  readonly manifestSha256: string;
  readonly candidateEvidenceSha256: string;
}

interface QuarantineMarker extends GenerationTaskEvidenceAttemptIdentity {
  readonly protocol: "dezin.generation-task-evidence-quarantine.v1";
  readonly disposition: "unbound" | "durable-publication-cache";
  readonly durablePublication: DurablePublicationMarkerProof | null;
  readonly storageKey: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface QuarantineDurablePublishedEvidenceInput
extends GenerationTaskEvidenceAttemptIdentity {
  /** Receipt returned by exact immutable Git bundle verification in this publication flow. */
  readonly receipt: ArtifactRevisionEvidenceBundleReceipt;
}

interface MutableSummary {
  scanned: number;
  retained: number;
  quarantined: number;
  restored: number;
  removed: number;
  failed: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Generation Task evidence recovery aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
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

async function canonicalDirectory(path: string): Promise<string> {
  const lexical = resolve(path);
  const metadata = await lstat(lexical);
  const canonical = await realpath(lexical);
  const canonicalMetadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
    || !canonicalMetadata.isDirectory() || !sameNode(metadata, canonicalMetadata)) {
    throw new Error("Generation Task evidence lifecycle root is not a canonical directory");
  }
  return canonical;
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryFlag = Number.isInteger(constants.O_DIRECTORY) ? constants.O_DIRECTORY : 0;
  const handle = await open(directory, constants.O_RDONLY | directoryFlag);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exactDirectory(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error("Generation Task evidence lifecycle path escapes its root");
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonical !== path) {
    throw new Error("Generation Task evidence lifecycle cannot traverse a symlink");
  }
}

async function ensureDirectoryChain(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error("Generation Task evidence lifecycle path escapes its root");
  let cursor = root;
  for (const segment of relative(root, path).split(sep)) {
    if (!segment) continue;
    cursor = join(cursor, segment);
    let created = false;
    try {
      await mkdir(cursor, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await exactDirectory(root, cursor);
    if (created) await syncDirectory(dirname(cursor));
  }
}

function exactIdentity(parts: readonly string[]): GenerationTaskEvidenceAttemptIdentity | null {
  if (parts.length !== 7 || parts[5] !== "visual"
    || !SAFE_ID.test(parts[0]!) || !SAFE_ID.test(parts[1]!)
    || !SAFE_ID.test(parts[2]!) || !SAFE_ID.test(parts[3]!)) return null;
  const attempt = ATTEMPT.exec(parts[4]!);
  if (!attempt || !PNG_FILE.test(parts[6]!)) return null;
  const attemptNumber = Number(attempt[1]);
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) return null;
  return {
    projectId: parts[0]!,
    workspaceId: parts[1]!,
    planId: parts[2]!,
    taskId: parts[3]!,
    attempt: attemptNumber,
  };
}

function storagePath(root: string, storageKey: string): string {
  if (!storageKey.startsWith(STORAGE_PREFIX)) {
    throw new Error("Generation Task evidence storage key has an invalid root");
  }
  const path = resolve(root, ...storageKey.slice(STORAGE_PREFIX.length).split("/"));
  if (!inside(root, path) || path === root) {
    throw new Error("Generation Task evidence storage key escapes its root");
  }
  return path;
}

function exactAttempt(
  value: EvidenceAttemptView | null,
  identity: GenerationTaskEvidenceAttemptIdentity,
): EvidenceAttemptView | null {
  if (value === null) return null;
  if (value.taskId !== identity.taskId || value.planId !== identity.planId
    || value.workspaceId !== identity.workspaceId || value.attempt !== identity.attempt
    || typeof value.status !== "string"
    || (value.candidateEvidence !== null
      && (typeof value.candidateEvidence !== "object" || Array.isArray(value.candidateEvidence)))) {
    throw new Error("Generation Task evidence Store owner is invalid");
  }
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function descriptorStorageKey(
  value: unknown,
  protocol:
    | "dezin.generation-task-visual-evidence.v1"
    | "dezin.generation-task-source-visual-evidence.v1",
  label: string,
): string {
  const descriptor = plainRecord(value, label);
  if (descriptor.protocol !== protocol || typeof descriptor.storageKey !== "string"
    || !descriptor.storageKey.startsWith(STORAGE_PREFIX)) {
    throw new Error(`${label} is invalid`);
  }
  return descriptor.storageKey;
}

function collectEvaluationEvidence(
  value: unknown,
  expectedProtocol: "dezin.artifact-run-evaluation-manifest.v1" | "dezin.standard-artifact-quality.v1",
  label: string,
  result: Set<string>,
): void {
  const evidence = plainRecord(value, label);
  if (evidence.protocol !== expectedProtocol) throw new Error(`${label} protocol is invalid`);
  if (Object.hasOwn(evidence, "visualEvidence")) {
    if (!Array.isArray(evidence.visualEvidence) || evidence.visualEvidence.length > 64) {
      throw new Error(`${label} visual evidence is invalid`);
    }
    for (const [index, descriptor] of evidence.visualEvidence.entries()) {
      result.add(descriptorStorageKey(
        descriptor,
        "dezin.generation-task-visual-evidence.v1",
        `${label} visual evidence ${index}`,
      ));
    }
  }
  if (Object.hasOwn(evidence, "sourceVisualEvidence")) {
    result.add(descriptorStorageKey(
      evidence.sourceVisualEvidence,
      "dezin.generation-task-source-visual-evidence.v1",
      `${label} source visual evidence`,
    ));
  }
}

function evidenceStorageKeys(value: Record<string, unknown> | null): Set<string> {
  const result = new Set<string>();
  if (value === null) return result;
  const artifactEvidence = plainRecord(value, "Artifact candidate evidence");
  if (artifactEvidence.protocol !== "dezin.artifact-run.v1"
    || !Array.isArray(artifactEvidence.versions)
    || artifactEvidence.versions.length < 1
    || artifactEvidence.versions.length > 256
    || !Object.hasOwn(artifactEvidence, "qualityEvidence")) {
    throw new Error("Artifact candidate evidence ownership structure is invalid");
  }
  for (const [index, versionValue] of artifactEvidence.versions.entries()) {
    const version = plainRecord(versionValue, `Artifact candidate version ${index}`);
    if (!Object.hasOwn(version, "evaluationManifest")) {
      throw new Error(`Artifact candidate version ${index} has no evaluation manifest`);
    }
    collectEvaluationEvidence(
      version.evaluationManifest,
      "dezin.artifact-run-evaluation-manifest.v1",
      `Artifact candidate version ${index} evaluation manifest`,
      result,
    );
  }
  collectEvaluationEvidence(
    artifactEvidence.qualityEvidence,
    "dezin.standard-artifact-quality.v1",
    "Artifact candidate selected quality evidence",
    result,
  );
  return result;
}

interface DurablePublishedEntry {
  readonly storageKey: string;
  readonly sha256: string;
  readonly byteLength: number;
}

function exactRecordKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} structure is invalid`);
  }
}

function durablePublishedEntries(
  input: QuarantineDurablePublishedEvidenceInput,
): {
  readonly proof: DurablePublicationMarkerProof;
  readonly entries: readonly DurablePublishedEntry[];
} {
  const receipt = plainRecord(input.receipt, "Artifact immutable evidence receipt");
  exactRecordKeys(
    receipt,
    ["ref", "commitHash", "treeHash", "manifestSha256", "subject"],
    "Artifact immutable evidence receipt",
  );
  const subject = plainRecord(receipt.subject, "Artifact immutable evidence receipt subject");
  exactRecordKeys(subject, [
    "projectId",
    "workspaceId",
    "revisionId",
    "artifactId",
    "trackId",
    "candidate",
    "contextPackHash",
    "attempt",
    "candidateEvidenceSha256",
    "entries",
  ], "Artifact immutable evidence receipt subject");
  const attempt = plainRecord(subject.attempt, "Artifact immutable evidence receipt Attempt");
  if (subject.projectId !== input.projectId
    || subject.workspaceId !== input.workspaceId
    || typeof subject.revisionId !== "string" || !SAFE_ID.test(subject.revisionId)
    || typeof subject.artifactId !== "string" || !SAFE_ID.test(subject.artifactId)
    || typeof subject.trackId !== "string" || !SAFE_ID.test(subject.trackId)
    || attempt.workspaceId !== input.workspaceId
    || attempt.taskId !== input.taskId
    || attempt.attempt !== input.attempt
    || typeof receipt.commitHash !== "string" || !GIT_OBJECT_ID.test(receipt.commitHash)
    || typeof receipt.treeHash !== "string" || !GIT_OBJECT_ID.test(receipt.treeHash)
    || receipt.commitHash.length !== receipt.treeHash.length
    || typeof receipt.manifestSha256 !== "string" || !SHA256.test(receipt.manifestSha256)
    || typeof subject.candidateEvidenceSha256 !== "string"
    || !SHA256.test(subject.candidateEvidenceSha256)
    || receipt.ref !== artifactRevisionEvidenceRef(input.workspaceId, subject.revisionId)) {
    throw new Error("Artifact immutable evidence receipt ownership is invalid");
  }
  if (!Array.isArray(subject.entries) || subject.entries.length > 2_048) {
    throw new Error("Artifact immutable evidence receipt entries are invalid");
  }
  const storageKeys = new Set<string>();
  const entries = subject.entries.map((value, index): DurablePublishedEntry => {
    const entry = plainRecord(value, `Artifact immutable evidence receipt entry ${index}`);
    exactRecordKeys(
      entry,
      ["kind", "round", "storageKey", "sha256", "byteLength", "descriptor"],
      `Artifact immutable evidence receipt entry ${index}`,
    );
    const descriptor = plainRecord(
      entry.descriptor,
      `Artifact immutable evidence receipt entry ${index} descriptor`,
    );
    const protocol = entry.kind === "frame"
      ? "dezin.generation-task-visual-evidence.v1"
      : entry.kind === "source"
        ? "dezin.generation-task-source-visual-evidence.v1"
        : null;
    if (protocol === null
      || !Number.isSafeInteger(entry.round) || Number(entry.round) < 0
      || typeof entry.storageKey !== "string"
      || storageKeys.has(entry.storageKey)
      || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)
      || !Number.isSafeInteger(entry.byteLength) || Number(entry.byteLength) < 1
      || descriptor.protocol !== protocol
      || descriptor.round !== entry.round
      || descriptor.storageKey !== entry.storageKey
      || descriptor.sha256 !== entry.sha256
      || descriptor.byteLength !== entry.byteLength) {
      throw new Error(`Artifact immutable evidence receipt entry ${index} is invalid`);
    }
    const parsed = exactIdentity(
      entry.storageKey.slice(STORAGE_PREFIX.length).split("/"),
    );
    if (!entry.storageKey.startsWith(STORAGE_PREFIX)
      || parsed === null
      || parsed.projectId !== input.projectId
      || parsed.workspaceId !== input.workspaceId
      || parsed.planId !== input.planId
      || parsed.taskId !== input.taskId
      || parsed.attempt !== input.attempt) {
      throw new Error(`Artifact immutable evidence receipt entry ${index} ownership is invalid`);
    }
    storageKeys.add(entry.storageKey);
    return {
      storageKey: entry.storageKey,
      sha256: entry.sha256,
      byteLength: Number(entry.byteLength),
    };
  });
  return {
    proof: {
      revisionId: subject.revisionId,
      ref: receipt.ref,
      commitHash: receipt.commitHash,
      treeHash: receipt.treeHash,
      manifestSha256: receipt.manifestSha256,
      candidateEvidenceSha256: subject.candidateEvidenceSha256,
    },
    entries,
  };
}

function markerToken(storageKey: string): string {
  return createHash("sha256").update(storageKey, "utf8").digest("hex");
}

async function writeMarker(path: string, marker: QuarantineMarker): Promise<void> {
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : null;
  if (noFollow === null) throw new Error("Generation Task evidence quarantine cannot enforce no-follow writes");
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o400,
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

function sameMarker(left: QuarantineMarker, right: QuarantineMarker): boolean {
  return left.protocol === right.protocol
    && left.disposition === right.disposition
    && left.projectId === right.projectId
    && left.workspaceId === right.workspaceId
    && left.planId === right.planId
    && left.taskId === right.taskId
    && left.attempt === right.attempt
    && left.storageKey === right.storageKey
    && left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && ((left.durablePublication === null && right.durablePublication === null)
      || (left.durablePublication !== null && right.durablePublication !== null
        && left.durablePublication.revisionId === right.durablePublication.revisionId
        && left.durablePublication.ref === right.durablePublication.ref
        && left.durablePublication.commitHash === right.durablePublication.commitHash
        && left.durablePublication.treeHash === right.durablePublication.treeHash
        && left.durablePublication.manifestSha256 === right.durablePublication.manifestSha256
        && left.durablePublication.candidateEvidenceSha256
          === right.durablePublication.candidateEvidenceSha256));
}

function parseDurablePublication(value: unknown): DurablePublicationMarkerProof {
  const proof = plainRecord(value, "Evidence quarantine immutable publication proof");
  exactRecordKeys(proof, [
    "revisionId",
    "ref",
    "commitHash",
    "treeHash",
    "manifestSha256",
    "candidateEvidenceSha256",
  ], "Evidence quarantine immutable publication proof");
  if (typeof proof.revisionId !== "string" || !SAFE_ID.test(proof.revisionId)
    || typeof proof.ref !== "string"
    || typeof proof.commitHash !== "string" || !GIT_OBJECT_ID.test(proof.commitHash)
    || typeof proof.treeHash !== "string" || !GIT_OBJECT_ID.test(proof.treeHash)
    || proof.commitHash.length !== proof.treeHash.length
    || typeof proof.manifestSha256 !== "string" || !SHA256.test(proof.manifestSha256)
    || typeof proof.candidateEvidenceSha256 !== "string"
    || !SHA256.test(proof.candidateEvidenceSha256)) {
    throw new Error("Invalid evidence quarantine immutable publication proof");
  }
  return proof as unknown as DurablePublicationMarkerProof;
}

function parseMarker(value: unknown, token: string): QuarantineMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid evidence quarantine marker");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "attempt", "byteLength", "disposition", "durablePublication", "planId",
    "projectId", "protocol", "sha256", "storageKey", "taskId", "workspaceId",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || record.protocol !== "dezin.generation-task-evidence-quarantine.v1"
    || (record.disposition !== "unbound" && record.disposition !== "durable-publication-cache")
    || typeof record.storageKey !== "string" || markerToken(record.storageKey) !== token
    || typeof record.sha256 !== "string" || !SHA256.test(record.sha256)
    || !Number.isSafeInteger(record.byteLength) || Number(record.byteLength) < 1
    || typeof record.projectId !== "string" || !SAFE_ID.test(record.projectId)
    || typeof record.workspaceId !== "string" || !SAFE_ID.test(record.workspaceId)
    || typeof record.planId !== "string" || !SAFE_ID.test(record.planId)
    || typeof record.taskId !== "string" || !SAFE_ID.test(record.taskId)
    || !Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1) {
    throw new Error("Invalid evidence quarantine marker");
  }
  if ((record.disposition === "unbound" && record.durablePublication !== null)
    || (record.disposition === "durable-publication-cache"
      && record.durablePublication === null)) {
    throw new Error("Invalid evidence quarantine marker disposition");
  }
  const durablePublication = record.durablePublication === null
    ? null
    : parseDurablePublication(record.durablePublication);
  if (durablePublication !== null
    && durablePublication.ref !== artifactRevisionEvidenceRef(
      String(record.workspaceId),
      durablePublication.revisionId,
    )) {
    throw new Error("Invalid evidence quarantine immutable publication ref");
  }
  return { ...record, durablePublication } as unknown as QuarantineMarker;
}

function markerIdentity(marker: QuarantineMarker): GenerationTaskEvidenceAttemptIdentity {
  return {
    projectId: marker.projectId,
    workspaceId: marker.workspaceId,
    planId: marker.planId,
    taskId: marker.taskId,
    attempt: marker.attempt,
  };
}

function quarantineMarker(
  identity: GenerationTaskEvidenceAttemptIdentity,
  entry: DurablePublishedEntry,
  disposition: QuarantineMarker["disposition"],
  durablePublication: DurablePublicationMarkerProof | null,
): QuarantineMarker {
  return {
    protocol: "dezin.generation-task-evidence-quarantine.v1",
    disposition,
    durablePublication,
    ...identity,
    storageKey: entry.storageKey,
    sha256: entry.sha256,
    byteLength: entry.byteLength,
  };
}

async function durableQuarantineState(
  root: string,
  identity: GenerationTaskEvidenceAttemptIdentity,
  entry: DurablePublishedEntry,
  proof: DurablePublicationMarkerProof,
): Promise<"absent" | "marker-only" | "quarantined"> {
  const quarantineRoot = join(root, identity.projectId, QUARANTINE);
  if (!await lstat(quarantineRoot).catch(() => null)) return "absent";
  await exactDirectory(root, quarantineRoot);
  const token = markerToken(entry.storageKey);
  const directory = join(quarantineRoot, token);
  if (!await lstat(directory).catch(() => null)) return "absent";
  await exactDirectory(root, directory);
  const contents = await readdir(directory, { withFileTypes: true });
  if (contents.length === 0) return "absent";
  if (contents.some((candidate) => candidate.name !== MARKER
    && candidate.name !== QUARANTINED_EVIDENCE)) {
    throw new Error("Durable Artifact publication quarantine contains an unexpected entry");
  }
  const markerEntry = contents.find((candidate) => candidate.name === MARKER);
  if (!markerEntry?.isFile()) {
    throw new Error("Durable Artifact publication quarantine marker is unavailable");
  }
  const marker = parseMarker(
    JSON.parse(await readFile(join(directory, MARKER), "utf8")),
    token,
  );
  const expected = quarantineMarker(
    identity,
    entry,
    "durable-publication-cache",
    proof,
  );
  if (!sameMarker(marker, expected)) {
    throw new Error("Durable Artifact publication quarantine proof conflicts");
  }
  const evidenceEntry = contents.find((candidate) => candidate.name === QUARANTINED_EVIDENCE);
  if (evidenceEntry === undefined) return "marker-only";
  if (!evidenceEntry.isFile()) {
    throw new Error("Durable Artifact publication quarantine evidence is invalid");
  }
  const inspected = readPngEvidenceFile(join(directory, QUARANTINED_EVIDENCE));
  if (!inspected || inspected.identity.sha256 !== entry.sha256
    || inspected.identity.byteLength !== entry.byteLength) {
    throw new Error("Durable Artifact publication quarantine evidence conflicts");
  }
  return "quarantined";
}

export class GenerationTaskEvidenceLifecycle {
  readonly #dataDir: string;
  readonly #store: GenerationTaskEvidenceLifecycleStorePort;

  constructor(options: {
    readonly dataDir: string;
    readonly store: GenerationTaskEvidenceLifecycleStorePort;
  }) {
    if (typeof options?.dataDir !== "string" || options.dataDir.length === 0
      || !options.store || typeof options.store.getGenerationTaskAttemptForProject !== "function") {
      throw new TypeError("Generation Task evidence lifecycle configuration is invalid");
    }
    this.#dataDir = options.dataDir;
    this.#store = options.store;
  }

  async recover(signal: AbortSignal): Promise<GenerationTaskEvidenceRecoverySummary> {
    checkAbort(signal);
    const summary: MutableSummary = {
      scanned: 0,
      retained: 0,
      quarantined: 0,
      restored: 0,
      removed: 0,
      failed: 0,
    };
    const dataRoot = await canonicalDirectory(this.#dataDir);
    const evidenceRoot = join(dataRoot, "generation-task-evidence");
    const rootMetadata = await lstat(evidenceRoot).catch(() => null);
    if (rootMetadata === null) return summary;
    const root = await canonicalDirectory(evidenceRoot);
    const projectEntries = await readdir(root, { withFileTypes: true });
    const restoredKeys = new Set<string>();
    const existingQuarantine = projectEntries
      .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
      .map((entry) => ({
        projectId: entry.name,
        path: join(root, entry.name, QUARANTINE),
      }));
    for (const candidate of existingQuarantine) {
      checkAbort(signal);
      if (await lstat(candidate.path).catch(() => null)) {
        await this.#recoverQuarantine(
          root,
          candidate.projectId,
          candidate.path,
          restoredKeys,
          summary,
          signal,
        );
      }
    }
    await this.#scanActive(root, restoredKeys, summary, signal);
    return Object.freeze({ ...summary });
  }

  async quarantineAttempt(
    input: GenerationTaskEvidenceAttemptIdentity,
    signal: AbortSignal,
  ): Promise<GenerationTaskEvidenceRecoverySummary> {
    checkAbort(signal);
    const summary: MutableSummary = {
      scanned: 0,
      retained: 0,
      quarantined: 0,
      restored: 0,
      removed: 0,
      failed: 0,
    };
    const dataRoot = await canonicalDirectory(this.#dataDir);
    const rootPath = join(dataRoot, "generation-task-evidence");
    if (!await lstat(rootPath).catch(() => null)) return summary;
    const root = await canonicalDirectory(rootPath);
    const visual = join(
      root,
      input.projectId,
      input.workspaceId,
      input.planId,
      input.taskId,
      `attempt-${input.attempt}`,
      "visual",
    );
    if (!await lstat(visual).catch(() => null)) return summary;
    await this.#scanVisual(root, visual, input, summary, signal);
    return Object.freeze({ ...summary });
  }

  async quarantineDurablePublishedEvidence(
    input: QuarantineDurablePublishedEvidenceInput,
    signal: AbortSignal,
  ): Promise<GenerationTaskEvidenceRecoverySummary> {
    checkAbort(signal);
    if (!SAFE_ID.test(input.projectId) || !SAFE_ID.test(input.workspaceId)
      || !SAFE_ID.test(input.planId) || !SAFE_ID.test(input.taskId)
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new TypeError("Durable Artifact publication evidence identity is invalid");
    }
    const attemptIdentity: GenerationTaskEvidenceAttemptIdentity = {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      planId: input.planId,
      taskId: input.taskId,
      attempt: input.attempt,
    };
    const publication = durablePublishedEntries(input);
    const summary: MutableSummary = {
      scanned: 0,
      retained: 0,
      quarantined: 0,
      restored: 0,
      removed: 0,
      failed: 0,
    };
    const dataRoot = await canonicalDirectory(this.#dataDir);
    const rootPath = join(dataRoot, "generation-task-evidence");
    if (!await lstat(rootPath).catch(() => null)) {
      summary.scanned = publication.entries.length;
      summary.removed = publication.entries.length;
      return Object.freeze({ ...summary });
    }
    const root = await canonicalDirectory(rootPath);
    const paths = publication.entries.map((entry) => ({
      entry,
      path: storagePath(root, entry.storageKey),
    }));
    const pending: typeof paths = [];
    // Check the complete immutable inventory before moving its first mutable file.
    for (const { entry, path } of paths) {
      checkAbort(signal);
      summary.scanned += 1;
      const metadata = await lstat(path).catch(() => null);
      const quarantineState = await durableQuarantineState(
        root,
        attemptIdentity,
        entry,
        publication.proof,
      );
      if (metadata === null) {
        if (quarantineState === "quarantined") summary.quarantined += 1;
        else summary.removed += 1;
        continue;
      }
      const inspected = readPngEvidenceFile(path);
      if (!metadata.isFile() || metadata.nlink !== 1 || !inspected
        || inspected.identity.sha256 !== entry.sha256
        || inspected.identity.byteLength !== entry.byteLength) {
        throw new Error("Durable Artifact publication cache diverges from its immutable receipt");
      }
      if (quarantineState === "quarantined") {
        throw new Error("Durable Artifact publication cache has conflicting active and quarantined copies");
      }
      pending.push({ entry, path });
    }
    for (const { entry, path } of pending) {
      checkAbort(signal);
      await this.#quarantine(
        root,
        path,
        entry.storageKey,
        attemptIdentity,
        "durable-publication-cache",
        publication.proof,
        entry,
      );
      summary.quarantined += 1;
    }
    return Object.freeze({ ...summary });
  }

  async #attempt(
    identity: GenerationTaskEvidenceAttemptIdentity,
  ): Promise<EvidenceAttemptView | null | undefined> {
    try {
      return exactAttempt(this.#store.getGenerationTaskAttemptForProject(
        identity.projectId,
        identity.planId,
        identity.taskId,
        identity.attempt,
      ), identity);
    } catch {
      return undefined;
    }
  }

  async #recoverQuarantine(
    root: string,
    projectId: string,
    quarantineRoot: string,
    restoredKeys: Set<string>,
    summary: MutableSummary,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await exactDirectory(root, quarantineRoot);
    } catch {
      summary.failed += 1;
      return;
    }
    const entries = await readdir(quarantineRoot, { withFileTypes: true });
    for (const entry of entries) {
      checkAbort(signal);
      summary.scanned += 1;
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        summary.failed += 1;
        continue;
      }
      const directory = join(quarantineRoot, entry.name);
      try {
        await exactDirectory(root, directory);
        const contents = await readdir(directory, { withFileTypes: true });
        const markerEntry = contents.find((candidate) => candidate.name === MARKER);
        const evidenceEntry = contents.find((candidate) => candidate.name === QUARANTINED_EVIDENCE);
        if (markerEntry === undefined && evidenceEntry === undefined && contents.length === 0) {
          await rm(directory, { recursive: true });
          await syncDirectory(quarantineRoot);
          summary.removed += 1;
          continue;
        }
        if (!markerEntry?.isFile()
          || contents.some((candidate) => candidate.name !== MARKER
            && candidate.name !== QUARANTINED_EVIDENCE)) {
          throw new Error("Invalid partial evidence quarantine entry");
        }
        const markerPath = join(directory, MARKER);
        const markerMetadata = await lstat(markerPath);
        if (!markerMetadata.isFile() || markerMetadata.nlink !== 1) throw new Error("Invalid marker file");
        const marker = parseMarker(
          JSON.parse(await readFile(markerPath, "utf8")),
          entry.name,
        );
        if (marker.projectId !== projectId) throw new Error("Quarantine Project owner changed");
        const evidencePath = join(directory, QUARANTINED_EVIDENCE);
        const evidenceMetadata = await lstat(evidencePath).catch(() => null);
        if (evidenceMetadata === null) {
          await rm(directory, { recursive: true });
          await syncDirectory(quarantineRoot);
          summary.removed += 1;
          continue;
        }
        if (!evidenceMetadata.isFile() || evidenceMetadata.nlink !== 1) throw new Error("Invalid quarantined evidence file");
        const inspected = readPngEvidenceFile(evidencePath);
        if (!inspected || inspected.identity.sha256 !== marker.sha256
          || inspected.identity.byteLength !== marker.byteLength) throw new Error("Quarantined evidence identity changed");
        if (marker.disposition === "durable-publication-cache") {
          await rm(directory, { recursive: true });
          await syncDirectory(quarantineRoot);
          summary.removed += 1;
          continue;
        }
        const attempt = await this.#attempt(markerIdentity(marker));
        if (attempt === undefined) {
          summary.failed += 1;
          continue;
        }
        const references = evidenceStorageKeys(attempt?.candidateEvidence ?? null);
        const restore = references.has(marker.storageKey)
          || (attempt !== null && attempt.candidateEvidence === null && ACTIVE_ATTEMPT_STATUSES.has(attempt.status));
        if (restore) {
          const destination = storagePath(root, marker.storageKey);
          await ensureDirectoryChain(root, dirname(destination));
          const existing = await lstat(destination).catch(() => null);
          if (existing === null) {
            await rename(evidencePath, destination);
            await syncDirectory(dirname(destination));
          } else {
            const current = readPngEvidenceFile(destination);
            if (!existing.isFile() || existing.nlink !== 1 || !current
              || !samePngEvidenceIdentity(current.identity, inspected.identity)) {
              throw new Error("Quarantine restoration destination is occupied by different evidence");
            }
          }
          await rm(directory, { recursive: true });
          await syncDirectory(quarantineRoot);
          restoredKeys.add(marker.storageKey);
          summary.restored += 1;
        } else {
          await rm(directory, { recursive: true });
          await syncDirectory(quarantineRoot);
          summary.removed += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
  }

  async #scanActive(
    root: string,
    restoredKeys: ReadonlySet<string>,
    summary: MutableSummary,
    signal: AbortSignal,
  ): Promise<void> {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      checkAbort(signal);
      if (!project.isDirectory() || !SAFE_ID.test(project.name)) continue;
      const projectPath = join(root, project.name);
      await this.#scanIdLevel(root, projectPath, [project.name], 1, restoredKeys, summary, signal);
    }
  }

  async #scanIdLevel(
    root: string,
    directory: string,
    parts: string[],
    depth: number,
    restoredKeys: ReadonlySet<string>,
    summary: MutableSummary,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await exactDirectory(root, directory);
    } catch {
      summary.failed += 1;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      checkAbort(signal);
      if (depth === 1 && entry.name === QUARANTINE) continue;
      if (!entry.isDirectory()) continue;
      if (depth < 4) {
        if (!SAFE_ID.test(entry.name)) continue;
        await this.#scanIdLevel(
          root,
          join(directory, entry.name),
          [...parts, entry.name],
          depth + 1,
          restoredKeys,
          summary,
          signal,
        );
      } else {
        const attemptMatch = ATTEMPT.exec(entry.name);
        if (!attemptMatch) continue;
        const attempt = Number(attemptMatch[1]);
        if (!Number.isSafeInteger(attempt) || attempt < 1) continue;
        const visual = join(directory, entry.name, "visual");
        if (!await lstat(visual).catch(() => null)) continue;
        await this.#scanVisual(root, visual, {
          projectId: parts[0]!,
          workspaceId: parts[1]!,
          planId: parts[2]!,
          taskId: parts[3]!,
          attempt,
        }, summary, signal, restoredKeys);
      }
    }
  }

  async #scanVisual(
    root: string,
    visual: string,
    identity: GenerationTaskEvidenceAttemptIdentity,
    summary: MutableSummary,
    signal: AbortSignal,
    restoredKeys: ReadonlySet<string> = new Set<string>(),
  ): Promise<void> {
    try {
      await exactDirectory(root, visual);
    } catch {
      summary.failed += 1;
      return;
    }
    const attempt = await this.#attempt(identity);
    let references: Set<string> | null;
    try {
      references = attempt === undefined
        ? null
        : evidenceStorageKeys(attempt?.candidateEvidence ?? null);
    } catch {
      summary.failed += 1;
      return;
    }
    const entries = await readdir(visual, { withFileTypes: true });
    for (const entry of entries) {
      checkAbort(signal);
      if (!entry.isFile() || !PNG_FILE.test(entry.name)) continue;
      const storageKey = `${STORAGE_PREFIX}${relative(root, join(visual, entry.name)).split(sep).join("/")}`;
      if (restoredKeys.has(storageKey)) continue;
      summary.scanned += 1;
      const parsed = exactIdentity(storageKey.slice(STORAGE_PREFIX.length).split("/"));
      if (!parsed || parsed.projectId !== identity.projectId || parsed.workspaceId !== identity.workspaceId
        || parsed.planId !== identity.planId || parsed.taskId !== identity.taskId
        || parsed.attempt !== identity.attempt || references === null) {
        summary.failed += 1;
        continue;
      }
      if (references.has(storageKey)
        || (attempt !== null && attempt !== undefined
          && attempt.candidateEvidence === null && ACTIVE_ATTEMPT_STATUSES.has(attempt.status))) {
        summary.retained += 1;
        continue;
      }
      try {
        await this.#quarantine(
          root,
          join(visual, entry.name),
          storageKey,
          identity,
          "unbound",
          null,
        );
        summary.quarantined += 1;
      } catch {
        summary.failed += 1;
      }
    }
  }

  async #quarantine(
    root: string,
    sourcePath: string,
    storageKey: string,
    identity: GenerationTaskEvidenceAttemptIdentity,
    disposition: QuarantineMarker["disposition"],
    durablePublication: DurablePublicationMarkerProof | null,
    expected?: DurablePublishedEntry,
  ): Promise<void> {
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Evidence is not an owned regular file");
    const inspected = readPngEvidenceFile(sourcePath);
    if (!inspected) throw new Error("Evidence is not a valid bounded PNG");
    if (expected !== undefined
      && (inspected.identity.sha256 !== expected.sha256
        || inspected.identity.byteLength !== expected.byteLength
        || storageKey !== expected.storageKey)) {
      throw new Error("Evidence changed after immutable receipt preflight");
    }
    const quarantineRoot = join(root, identity.projectId, QUARANTINE);
    await ensureDirectoryChain(root, quarantineRoot);
    const token = markerToken(storageKey);
    const directory = join(quarantineRoot, token);
    const marker = quarantineMarker(identity, {
      storageKey,
      sha256: inspected.identity.sha256,
      byteLength: inspected.identity.byteLength,
    }, disposition, durablePublication);
    const destination = join(directory, QUARANTINED_EVIDENCE);
    let resumeAfterMarker = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      await syncDirectory(quarantineRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await exactDirectory(root, directory);
      const contents = await readdir(directory, { withFileTypes: true });
      if (contents.length === 0) {
        await rm(directory, { recursive: true });
        await syncDirectory(quarantineRoot);
        await mkdir(directory, { mode: 0o700 });
        await syncDirectory(quarantineRoot);
      } else if (contents.length === 1 && contents[0]?.name === MARKER && contents[0].isFile()) {
        const existing = parseMarker(
          JSON.parse(await readFile(join(directory, MARKER), "utf8")),
          token,
        );
        if (!sameMarker(existing, marker)) {
          throw new Error("Partial evidence quarantine marker has a different owner");
        }
        resumeAfterMarker = true;
      } else {
        throw new Error("Evidence quarantine destination is already occupied");
      }
    }
    if (!resumeAfterMarker) await writeMarker(join(directory, MARKER), marker);
    const beforeMove = await lstat(sourcePath);
    if (!sameNode(metadata, beforeMove) || beforeMove.nlink !== 1) {
      throw new Error("Evidence changed before quarantine");
    }
    await rename(sourcePath, destination);
    await syncDirectory(dirname(sourcePath));
    await syncDirectory(directory);
  }
}
