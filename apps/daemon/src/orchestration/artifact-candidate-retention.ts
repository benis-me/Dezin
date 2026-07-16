import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";

import type {
  ArtifactRevisionRecord,
  GenerationTask,
  GenerationTaskAttempt,
  GenerationTaskAttemptClaim,
} from "../../../../packages/core/src/index.ts";
import { generationTaskCandidateEvidenceHash } from "../../../../packages/core/src/index.ts";
import {
  artifactCandidateAttemptRef,
  promoteArtifactCandidateRef,
  releaseArtifactCandidateAttemptRef,
  type ArtifactCandidateAttempt,
  type ArtifactCandidateIdentity,
} from "./artifact-candidate-transaction.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface ArtifactCandidateRetentionInput {
  readonly claim: GenerationTaskAttemptClaim;
  readonly artifactRevision: ArtifactRevisionRecord;
  readonly evidence: Record<string, unknown>;
}

export interface ArtifactCandidateRetentionPort {
  promote(input: ArtifactCandidateRetentionInput, signal: AbortSignal): Promise<void>;
  release(input: ArtifactCandidateRetentionInput, signal: AbortSignal): Promise<void>;
}

export interface GitArtifactCandidateRetentionOptions {
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
}

export class ArtifactCandidateRetentionError extends Error {
  readonly failureClass = "build-infrastructure" as const;

  constructor(message: string) {
    super(message);
    this.name = "ArtifactCandidateRetentionError";
  }
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)) {
    throw new ArtifactCandidateRetentionError(`${label} must be a non-proxy plain object`);
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    throw new ArtifactCandidateRetentionError(`${label} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArtifactCandidateRetentionError(`${label} must be a plain object`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new ArtifactCandidateRetentionError(`${label} cannot contain symbol fields`);
    }
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new ArtifactCandidateRetentionError(`${label}.${key} must be enumerable data`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactFields(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ArtifactCandidateRetentionError(`${label} fields are invalid`);
  }
}

function exactDataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ArtifactCandidateRetentionError(`${label} must be a non-proxy array`);
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    throw new ArtifactCandidateRetentionError(`${label} could not be inspected safely`);
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (!Number.isSafeInteger(length) || length < 1 || length > 256) {
    throw new ArtifactCandidateRetentionError(`${label} length is invalid`);
  }
  const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    throw new ArtifactCandidateRetentionError(`${label} fields are invalid`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new ArtifactCandidateRetentionError(`${label}[${index}] must be enumerable data`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value.includes("\0")) {
    throw new ArtifactCandidateRetentionError(`${label} is invalid`);
  }
  return value;
}

function exactObjectId(value: unknown, label: string): string {
  const id = exactText(value, label);
  if (!GIT_OBJECT_ID.test(id)) {
    throw new ArtifactCandidateRetentionError(`${label} is not a canonical Git object id`);
  }
  return id;
}

export interface ArtifactCandidateRetentionDescriptor {
  attempt: ArtifactCandidateAttempt;
  attemptRef: string;
  history: readonly ArtifactCandidateIdentity[];
  historyHead: ArtifactCandidateIdentity;
}

export interface ArtifactCandidateRetentionSubject {
  readonly task: GenerationTask;
  readonly attempt: GenerationTaskAttempt;
  readonly artifactRevision: ArtifactRevisionRecord;
  readonly evidence: Record<string, unknown>;
}

export function artifactCandidateRetentionDescriptor(
  input: ArtifactCandidateRetentionSubject,
): ArtifactCandidateRetentionDescriptor {
  const claim = { task: input.task, attempt: input.attempt };
  const { artifactRevision } = input;
  if ((claim.task.kind !== "page" && claim.task.kind !== "component")
    || claim.task.target.type !== "artifact"
    || claim.attempt.target.type !== "artifact"
    || artifactRevision.workspaceId !== claim.task.workspaceId
    || artifactRevision.artifactId !== claim.task.target.id
    || artifactRevision.trackId !== claim.task.target.trackId
    || typeof artifactRevision.sourceCommitHash !== "string"
    || typeof artifactRevision.sourceTreeHash !== "string"
    || artifactRevision.sourceCommitHash.length !== artifactRevision.sourceTreeHash.length
    || !GIT_OBJECT_ID.test(artifactRevision.sourceCommitHash)
    || !GIT_OBJECT_ID.test(artifactRevision.sourceTreeHash)) {
    throw new ArtifactCandidateRetentionError(
      "Artifact Revision does not match the exact Artifact Task candidate",
    );
  }

  const evidence = dataRecord(input.evidence, "Artifact candidate retention evidence");
  const optionalQualityFields = ["runtimeChecks", "visualReview"]
    .filter((field) => Object.hasOwn(evidence, field));
  exactFields(evidence, [
    "protocol",
    "projectId",
    "taskId",
    "planId",
    "workspaceId",
    "attempt",
    "attemptCreatedAt",
    "inputHash",
    "contextPackId",
    "contextPackHash",
    "sourceBase",
    "candidateRetentionRef",
    "selectedRound",
    "versions",
    "qualityEvidence",
    ...optionalQualityFields,
  ], "Artifact candidate retention evidence");
  if (evidence.protocol !== "dezin.artifact-run.v1"
    || typeof evidence.projectId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(evidence.projectId)
    || evidence.taskId !== claim.task.id
    || evidence.planId !== claim.task.planId
    || evidence.workspaceId !== claim.task.workspaceId
    || !Number.isSafeInteger(evidence.attempt) || Number(evidence.attempt) < 1
    || !Number.isSafeInteger(evidence.attemptCreatedAt) || Number(evidence.attemptCreatedAt) < 0
    || typeof evidence.inputHash !== "string" || !SHA256.test(evidence.inputHash)
    || typeof evidence.contextPackHash !== "string" || !SHA256.test(evidence.contextPackHash)
    || evidence.contextPackId !== `context-pack-${evidence.contextPackHash}`
    || evidence.contextPackId !== claim.attempt.contextPackId
    || artifactRevision.contextPackHash !== evidence.contextPackHash) {
    throw new ArtifactCandidateRetentionError("Artifact candidate retention evidence identity is invalid");
  }
  const qualityEvidence = dataRecord(
    evidence.qualityEvidence,
    "Artifact candidate retained quality evidence",
  );
  for (const field of ["runtimeChecks", "visualReview"] as const) {
    const rootHasField = Object.hasOwn(evidence, field);
    const qualityHasField = Object.hasOwn(qualityEvidence, field);
    if (rootHasField !== qualityHasField
      || (rootHasField && !isDeepStrictEqual(evidence[field], qualityEvidence[field]))) {
      throw new ArtifactCandidateRetentionError(
        `Artifact candidate ${field} must exactly mirror retained quality evidence`,
      );
    }
  }
  const sourceBase = dataRecord(evidence.sourceBase, "Artifact candidate source base");
  exactFields(sourceBase, ["commitHash", "treeHash"], "Artifact candidate source base");
  const sourceCommitHash = exactObjectId(sourceBase.commitHash, "Artifact candidate source commit");
  const sourceTreeHash = exactObjectId(sourceBase.treeHash, "Artifact candidate source tree");
  if (sourceCommitHash.length !== sourceTreeHash.length) {
    throw new ArtifactCandidateRetentionError("Artifact candidate source object formats do not match");
  }
  const attempt: ArtifactCandidateAttempt = {
    workspaceId: claim.task.workspaceId,
    taskId: claim.task.id,
    attempt: Number(evidence.attempt),
    inputHash: String(evidence.inputHash),
    createdAt: Number(evidence.attemptCreatedAt),
    sourceCommitHash,
    sourceTreeHash,
  };
  const attemptRef = artifactCandidateAttemptRef(attempt);
  if (evidence.candidateRetentionRef !== attemptRef) {
    throw new ArtifactCandidateRetentionError("Artifact candidate retention ref is not canonical");
  }
  if (!Number.isSafeInteger(evidence.selectedRound) || Number(evidence.selectedRound) < 0) {
    throw new ArtifactCandidateRetentionError("Artifact candidate selected round is invalid");
  }
  const selectedRound = Number(evidence.selectedRound);
  const versions = exactDataArray(evidence.versions, "Artifact candidate versions").map((value, index) => {
    const version = dataRecord(value, `Artifact candidate version ${index}`);
    exactFields(
      version,
      ["round", "commitHash", "treeHash", "passed", "score"],
      `Artifact candidate version ${index}`,
    );
    const commitHash = exactObjectId(version.commitHash, `Artifact candidate version ${index} commit`);
    const treeHash = exactObjectId(version.treeHash, `Artifact candidate version ${index} tree`);
    if (version.round !== index
      || commitHash.length !== sourceCommitHash.length
      || treeHash.length !== sourceTreeHash.length
      || typeof version.passed !== "boolean"
      || typeof version.score !== "number" || !Number.isFinite(version.score)
      || version.score < 0 || version.score > 100) {
      throw new ArtifactCandidateRetentionError(`Artifact candidate version ${index} is invalid`);
    }
    return { commitHash, treeHash };
  });
  if (selectedRound >= versions.length) {
    throw new ArtifactCandidateRetentionError("Artifact candidate selected round is not retained");
  }
  const selected = versions[selectedRound]!;
  if (selected.commitHash !== artifactRevision.sourceCommitHash
    || selected.treeHash !== artifactRevision.sourceTreeHash) {
    throw new ArtifactCandidateRetentionError(
      "Artifact Revision does not match the selected retained version",
    );
  }
  const historyHead = versions.at(-1)!;
  if (claim.attempt.executionMode === "full") {
    if (attempt.attempt !== claim.attempt.attempt
      || attempt.inputHash !== claim.attempt.inputHash
      || attempt.createdAt !== claim.attempt.createdAt
      || attempt.sourceCommitHash !== claim.attempt.sourceCommitHash
      || attempt.sourceTreeHash !== claim.attempt.sourceTreeHash) {
      throw new ArtifactCandidateRetentionError(
        "full Artifact execution evidence does not match its immutable Attempt",
      );
    }
  } else {
    const current = claim.attempt;
    const expectedEvidenceHash = generationTaskCandidateEvidenceHash({
      taskId: claim.task.id,
      planId: claim.task.planId,
      workspaceId: claim.task.workspaceId,
      attempt: current.attempt,
      candidateRevisionId: artifactRevision.id,
      candidateResourceRevisionId: null,
      candidateEvidence: input.evidence,
    });
    if (current.executionMode !== "publication-only"
      || current.attemptOrigin !== "publication-retry"
      || current.predecessorAttempt !== current.attempt - 1
      || current.automaticRetryIndex < 1
      || attempt.attempt >= current.attempt
      || attempt.sourceCommitHash !== current.sourceCommitHash
      || attempt.sourceTreeHash !== current.sourceTreeHash
      || current.candidateRevisionId !== artifactRevision.id
      || current.candidateResourceRevisionId !== null
      || !isDeepStrictEqual(current.candidateEvidence, input.evidence)
      || current.candidateEvidenceHash !== expectedEvidenceHash) {
      throw new ArtifactCandidateRetentionError(
        "Artifact publication retry does not retain an exact predecessor candidate origin",
      );
    }
  }
  return { attempt, attemptRef, history: versions, historyHead };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact candidate retention aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Promotes an Attempt ref to the immutable Revision namespace before Core publication. */
export class GitArtifactCandidateRetention implements ArtifactCandidateRetentionPort {
  private readonly repositoryDirForWorkspace: GitArtifactCandidateRetentionOptions["repositoryDirForWorkspace"];

  constructor(options: GitArtifactCandidateRetentionOptions) {
    this.repositoryDirForWorkspace = options.repositoryDirForWorkspace;
  }

  async promote(input: ArtifactCandidateRetentionInput, signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    const descriptor = artifactCandidateRetentionDescriptor({
      task: input.claim.task,
      attempt: input.claim.attempt,
      artifactRevision: input.artifactRevision,
      evidence: input.evidence,
    });
    const repositoryDir = exactText(
      await this.repositoryDirForWorkspace(input.claim.task.workspaceId),
      "Artifact repository directory",
    );
    checkAbort(signal);
    await promoteArtifactCandidateRef({
      repositoryDir,
      attempt: descriptor.attempt,
      revisionId: input.artifactRevision.id,
      candidate: {
        commitHash: input.artifactRevision.sourceCommitHash,
        treeHash: input.artifactRevision.sourceTreeHash,
        attemptRef: descriptor.attemptRef,
      },
      history: descriptor.history,
      historyHead: descriptor.historyHead,
      signal,
    });
    checkAbort(signal);
  }

  async release(input: ArtifactCandidateRetentionInput, signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    const descriptor = artifactCandidateRetentionDescriptor({
      task: input.claim.task,
      attempt: input.claim.attempt,
      artifactRevision: input.artifactRevision,
      evidence: input.evidence,
    });
    const repositoryDir = exactText(
      await this.repositoryDirForWorkspace(input.claim.task.workspaceId),
      "Artifact repository directory",
    );
    checkAbort(signal);
    await releaseArtifactCandidateAttemptRef({
      repositoryDir,
      attempt: descriptor.attempt,
      revisionId: input.artifactRevision.id,
      candidate: {
        commitHash: input.artifactRevision.sourceCommitHash,
        treeHash: input.artifactRevision.sourceTreeHash,
        attemptRef: descriptor.attemptRef,
      },
      history: descriptor.history,
      historyHead: descriptor.historyHead,
      signal,
    });
    checkAbort(signal);
  }
}
