import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";

import type {
  ArtifactRevisionRecord,
  GenerationTask,
  GenerationTaskAttempt,
  GenerationTaskAttemptClaim,
  GenerationTaskSourceVisualEvidenceAuthority,
} from "../../../../packages/core/src/index.ts";
import {
  RENDER_FRAME_NAME_LIMIT,
  generationTaskCandidateEvidenceHash,
  isExactRenderFrameCaptureViewport,
} from "../../../../packages/core/src/index.ts";
import { stableStringify } from "../context/context-types.ts";
import {
  generationTaskVisualEvidenceFrameStorageSegment,
  readGenerationTaskSourceVisualEvidence,
  readGenerationTaskVisualEvidence,
  type GenerationTaskSourceVisualEvidenceCapture,
  type GenerationTaskSourceVisualEvidenceDescriptor,
  type GenerationTaskVisualEvidenceDescriptor,
  type GenerationTaskVisualEvidenceFrame,
  type GenerationTaskVisualEvidenceOwner,
} from "./generation-task-visual-evidence.ts";
import {
  artifactCandidateAttemptRef,
  prepareArtifactRevisionEvidenceBundle,
  promoteArtifactCandidateRef,
  releaseArtifactCandidateAttemptRef,
  verifyArtifactRevisionEvidenceBundle,
  type ArtifactCandidateAttempt,
  type ArtifactCandidateIdentity,
  type ArtifactRevisionEvidenceBundleReceipt,
  type ArtifactRevisionEvidenceEntryInput,
} from "./artifact-candidate-transaction.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VIEWER_BRIDGE_TEXT_CONTROL = /[\u0000-\u001f\u007f]/;
const VIEWER_BRIDGE_FRAME_TEXT_LIMIT = 256;
const VIEWER_BRIDGE_BACKGROUND_LIMIT = 4_096;
const MAX_EVALUATION_FRAMES = 64;
const MAX_CAPTURE_DIMENSION = 32_768;
const MAX_CAPTURE_PIXELS = 64_000_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_EVALUATION_FINDINGS_BYTES = 1024 * 1024;
const MAX_ARTIFACT_RUN_EVIDENCE_BYTES = 1024 * 1024;
const MAX_IMMUTABLE_EVIDENCE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

export interface ArtifactCandidateRetentionInput {
  readonly claim: GenerationTaskAttemptClaim;
  readonly artifactRevision: ArtifactRevisionRecord;
  readonly evidence: Record<string, unknown>;
}

export interface ArtifactCandidateRetentionPreparedInput {
  readonly claim: GenerationTaskAttemptClaim;
  readonly candidate: {
    readonly workspaceId: string;
    readonly artifactId: string;
    readonly trackId: string;
    readonly sourceCommitHash: string;
    readonly sourceTreeHash: string;
    readonly quality: Readonly<Record<string, unknown>>;
  };
  readonly evidence: Record<string, unknown>;
}

export interface ArtifactCandidateRetentionPort {
  /** Reopens every durable evidence file before Core records a candidate Revision. */
  verify(input: ArtifactCandidateRetentionPreparedInput, signal: AbortSignal): Promise<void>;
  /** Reopens every durable evidence file after ref release and immediately before Core publish. */
  verifyPublication(
    input: ArtifactCandidateRetentionInput,
    receipt: ArtifactRevisionEvidenceBundleReceipt,
    signal: AbortSignal,
  ): Promise<ArtifactRevisionEvidenceBundleReceipt>;
  promote(
    input: ArtifactCandidateRetentionInput,
    signal: AbortSignal,
  ): Promise<ArtifactRevisionEvidenceBundleReceipt>;
  release(
    input: ArtifactCandidateRetentionInput,
    receipt: ArtifactRevisionEvidenceBundleReceipt,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface GitArtifactCandidateRetentionOptions {
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
  readonly dataDir: string;
  readonly sourceAuthorityForRevision: (
    input: {
      workspaceId: string;
      resourceId: string;
      revisionId: string;
    },
    signal: AbortSignal,
  ) => GenerationTaskSourceVisualEvidenceAuthority | null
    | Promise<GenerationTaskSourceVisualEvidenceAuthority | null>;
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

function exactDataArray(
  value: unknown,
  label: string,
  minimum = 1,
  maximum = 256,
): readonly unknown[] {
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
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum) {
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

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value.includes("\0") || !isWellFormedUtf16(value)) {
    throw new ArtifactCandidateRetentionError(`${label} is invalid`);
  }
  return value;
}

function exactViewerText(value: unknown, label: string, maximum: number): string {
  const text = exactText(value, label);
  if (text.length > maximum || VIEWER_BRIDGE_TEXT_CONTROL.test(text)) {
    throw new ArtifactCandidateRetentionError(`${label} is not Viewer-safe text`);
  }
  return text;
}

function exactObjectId(value: unknown, label: string): string {
  const id = exactText(value, label);
  if (!GIT_OBJECT_ID.test(id)) {
    throw new ArtifactCandidateRetentionError(`${label} is not a canonical Git object id`);
  }
  return id;
}

function exactIdentifier(value: unknown, label: string): string {
  const id = exactText(value, label);
  if (!EVIDENCE_ID.test(id)) {
    throw new ArtifactCandidateRetentionError(`${label} is not a canonical evidence id`);
  }
  return id;
}

function exactSha256(value: unknown, label: string): string {
  const checksum = exactText(value, label);
  if (!SHA256.test(checksum)) {
    throw new ArtifactCandidateRetentionError(`${label} is not a SHA-256 checksum`);
  }
  return checksum;
}

interface ExactSourceAuthority {
  resourceId: string;
  revisionId: string;
  revisionChecksum: string;
}

function exactSourceAuthority(value: unknown, label: string): ExactSourceAuthority {
  const authority = dataRecord(value, label);
  exactFields(authority, ["resourceId", "revisionId", "revisionChecksum"], label);
  return {
    resourceId: exactIdentifier(authority.resourceId, `${label} Resource id`),
    revisionId: exactIdentifier(authority.revisionId, `${label} Resource Revision id`),
    revisionChecksum: exactSha256(
      authority.revisionChecksum,
      `${label} Resource Revision checksum`,
    ),
  };
}

function exactBoundedText(value: unknown, label: string, maximum: number): string {
  const text = exactText(value, label);
  if (Buffer.byteLength(text, "utf8") > maximum) {
    throw new ArtifactCandidateRetentionError(`${label} exceeds its byte limit`);
  }
  return text;
}

function exactPositiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new ArtifactCandidateRetentionError(`${label} is invalid`);
  }
  return Number(value);
}

function exactDimensions(value: Record<string, unknown>, label: string): { width: number; height: number } {
  if (!isExactRenderFrameCaptureViewport(value.width, value.height)) {
    throw new ArtifactCandidateRetentionError(`${label} dimensions exceed their pixel limit`);
  }
  return { width: Number(value.width), height: Number(value.height) };
}

interface ExactCaptureIdentity {
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
}

function exactCaptureIdentity(value: unknown, label: string, audited: {
  width: number;
  height: number;
  sha256?: string;
  byteLength?: number;
}): ExactCaptureIdentity {
  const identity = dataRecord(value, label);
  exactFields(identity, ["sha256", "byteLength", "width", "height"], label);
  const checksum = exactSha256(identity.sha256, `${label} checksum`);
  const byteLength = exactPositiveInteger(identity.byteLength, `${label} byte length`, MAX_CAPTURE_BYTES);
  const width = exactPositiveInteger(identity.width, `${label} width`, MAX_CAPTURE_DIMENSION);
  const height = exactPositiveInteger(identity.height, `${label} height`, MAX_CAPTURE_DIMENSION);
  if (width < audited.width || height < audited.height || width * height > MAX_CAPTURE_PIXELS
    || (audited.sha256 !== undefined && checksum !== audited.sha256)
    || (audited.byteLength !== undefined && byteLength !== audited.byteLength)) {
    throw new ArtifactCandidateRetentionError(`${label} does not match the reviewed PNG evidence`);
  }
  return { sha256: checksum, byteLength, width, height };
}

function exactJsonClone(
  value: unknown,
  label: string,
  state: { ancestors: WeakSet<object>; nodes: number } = {
    ancestors: new WeakSet<object>(),
    nodes: 0,
  },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ArtifactCandidateRetentionError(`${label} exceeds its JSON inspection budget`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ArtifactCandidateRetentionError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object" || nodeUtilTypes.isProxy(value)) {
    throw new ArtifactCandidateRetentionError(`${label} must contain only non-proxy JSON data`);
  }
  if (state.ancestors.has(value)) {
    throw new ArtifactCandidateRetentionError(`${label} cannot contain cyclic references`);
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    throw new ArtifactCandidateRetentionError(`${label} could not be inspected safely`);
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new ArtifactCandidateRetentionError(`${label} must be a plain array`);
      }
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_NODES) {
        throw new ArtifactCandidateRetentionError(`${label} array length is invalid`);
      }
      const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
        throw new ArtifactCandidateRetentionError(`${label} must be a dense data array`);
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new ArtifactCandidateRetentionError(`${label}[${index}] must be enumerable data`);
        }
        result.push(exactJsonClone(descriptor.value, `${label}[${index}]`, state, depth + 1));
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ArtifactCandidateRetentionError(`${label} must be a plain object`);
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors).sort((left, right) => String(left).localeCompare(String(right)))) {
      if (typeof key !== "string") {
        throw new ArtifactCandidateRetentionError(`${label} cannot contain symbol fields`);
      }
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new ArtifactCandidateRetentionError(`${label} contains unsafe field ${key}`);
      }
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new ArtifactCandidateRetentionError(`${label}.${key} must be enumerable data`);
      }
      result[key] = exactJsonClone(descriptor.value, `${label}.${key}`, state, depth + 1);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalBytes(value: unknown, label: string, maximum: number): string {
  let canonical: string;
  try {
    canonical = stableStringify(exactJsonClone(value, label));
  } catch {
    throw new ArtifactCandidateRetentionError(`${label} is not bounded canonical JSON`);
  }
  if (Buffer.byteLength(canonical, "utf8") > maximum) {
    throw new ArtifactCandidateRetentionError(`${label} exceeds its canonical byte limit`);
  }
  return canonical;
}

function exactPlannedFrames(payloadValue: unknown): readonly Record<string, unknown>[] {
  const payload = dataRecord(payloadValue, "Artifact Task payload");
  const values = exactDataArray(
    payload.responsiveFrames,
    "Artifact Task responsive Frames",
    1,
    MAX_EVALUATION_FRAMES,
  );
  const ids = new Set<string>();
  return values.map((value, index) => {
    const frame = dataRecord(value, `Artifact Task Frame ${index}`);
    const hasInitialState = Object.hasOwn(frame, "initialState");
    const hasFixture = Object.hasOwn(frame, "fixture");
    const hasBackground = Object.hasOwn(frame, "background");
    exactFields(frame, [
      "id", "name", "width", "height",
      ...(hasInitialState ? ["initialState"] : []),
      ...(hasFixture ? ["fixture"] : []),
      ...(hasBackground ? ["background"] : []),
    ], `Artifact Task Frame ${index}`);
    const id = exactViewerText(
      frame.id,
      `Artifact Task Frame ${index} id`,
      VIEWER_BRIDGE_FRAME_TEXT_LIMIT,
    );
    if (ids.has(id)) {
      throw new ArtifactCandidateRetentionError("Artifact Task Frame ids are not unique");
    }
    ids.add(id);
    if (exactText(frame.name, `Artifact Task Frame ${index} name`).length
      > RENDER_FRAME_NAME_LIMIT) {
      throw new ArtifactCandidateRetentionError(
        `Artifact Task Frame ${index} name exceeds its length limit`,
      );
    }
    exactDimensions(frame, `Artifact Task Frame ${index}`);
    if (hasInitialState) {
      exactViewerText(
        frame.initialState,
        `Artifact Task Frame ${index} initial state`,
        VIEWER_BRIDGE_FRAME_TEXT_LIMIT,
      );
    }
    if (hasBackground) {
      exactViewerText(
        frame.background,
        `Artifact Task Frame ${index} background`,
        VIEWER_BRIDGE_BACKGROUND_LIMIT,
      );
    }
    if (hasFixture) dataRecord(frame.fixture, `Artifact Task Frame ${index} fixture`);
    canonicalBytes(frame, `Artifact Task Frame ${index}`, 256 * 1024);
    return frame;
  });
}

interface EvaluationManifestOwner {
  projectId: string;
  workspaceId: string;
  planId: string;
  taskId: string;
  attempt: number;
  contextPackId: string;
  contextPackHash: string;
  candidateCommitHash: string;
  candidateTreeHash: string;
}

interface EvaluationManifestIdentity extends EvaluationManifestOwner {
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
  round: number;
  passed: boolean;
  score: number;
  frames: readonly Record<string, unknown>[];
  resourcePins: readonly { resourceId: string; revisionId: string }[];
}

export interface ArtifactCandidateVisualEvidenceVerification {
  readonly descriptor: GenerationTaskVisualEvidenceDescriptor;
  readonly expectedOwner: GenerationTaskVisualEvidenceOwner;
}

export interface ArtifactCandidateSourceVisualEvidenceVerification {
  readonly descriptor: GenerationTaskSourceVisualEvidenceDescriptor;
  readonly expectedOwner: GenerationTaskVisualEvidenceOwner;
}

interface EvaluationEvidenceCollection {
  visualEvidence: ArtifactCandidateVisualEvidenceVerification[];
  sourceVisualEvidence: ArtifactCandidateSourceVisualEvidenceVerification[];
}

function evidenceOwner(expected: EvaluationManifestOwner): GenerationTaskVisualEvidenceOwner {
  return {
    projectId: expected.projectId,
    workspaceId: expected.workspaceId,
    planId: expected.planId,
    taskId: expected.taskId,
    attempt: expected.attempt,
    candidateCommitHash: expected.candidateCommitHash,
    candidateTreeHash: expected.candidateTreeHash,
    contextPackId: expected.contextPackId,
    contextPackHash: expected.contextPackHash,
  };
}

function exactEvaluationOwner(value: unknown, expected: EvaluationManifestOwner, label: string): void {
  const owner = dataRecord(value, label);
  exactFields(owner, [
    "projectId", "workspaceId", "planId", "taskId", "attempt",
    "candidateCommitHash", "candidateTreeHash", "contextPackId", "contextPackHash",
  ], label);
  const projectId = exactIdentifier(owner.projectId, `${label} Project id`);
  const workspaceId = exactIdentifier(owner.workspaceId, `${label} Workspace id`);
  const planId = exactIdentifier(owner.planId, `${label} Plan id`);
  const taskId = exactIdentifier(owner.taskId, `${label} Task id`);
  const attempt = exactPositiveInteger(owner.attempt, `${label} Attempt`);
  const candidateCommitHash = exactObjectId(owner.candidateCommitHash, `${label} candidate commit`);
  const candidateTreeHash = exactObjectId(owner.candidateTreeHash, `${label} candidate tree`);
  const contextPackId = exactIdentifier(owner.contextPackId, `${label} Context Pack id`);
  const contextPackHash = exactSha256(owner.contextPackHash, `${label} Context Pack hash`);
  if (candidateCommitHash.length !== candidateTreeHash.length
    || projectId !== expected.projectId
    || workspaceId !== expected.workspaceId
    || planId !== expected.planId
    || taskId !== expected.taskId
    || attempt !== expected.attempt
    || candidateCommitHash !== expected.candidateCommitHash
    || candidateTreeHash !== expected.candidateTreeHash
    || contextPackId !== expected.contextPackId
    || contextPackHash !== expected.contextPackHash) {
    throw new ArtifactCandidateRetentionError(`${label} does not match its exact evaluation owner`);
  }
}

function exactFrameResult(value: unknown, index: number, plannedFrame: Record<string, unknown>): {
  frameId: string;
  frameAttemptId: string;
  width: number;
  height: number;
  status: "passed" | "failed";
  reviewed: boolean;
  captureIdentity: ExactCaptureIdentity | null;
} {
  const label = `Artifact evaluation Frame result ${index}`;
  const result = dataRecord(value, label);
  const hasCaptureIdentity = Object.hasOwn(result, "captureIdentity");
  exactFields(result, [
    "frameId", "frameAttemptId", "width", "height", "status", "reviewed",
    ...(hasCaptureIdentity ? ["captureIdentity"] : []),
  ], label);
  const frameId = exactViewerText(
    result.frameId,
    `${label} Frame id`,
    VIEWER_BRIDGE_FRAME_TEXT_LIMIT,
  );
  const frameAttemptId = exactIdentifier(result.frameAttemptId, `${label} Frame Attempt id`);
  const { width, height } = exactDimensions(result, label);
  if ((result.status !== "passed" && result.status !== "failed")
    || typeof result.reviewed !== "boolean"
    || frameId !== plannedFrame.id || width !== plannedFrame.width || height !== plannedFrame.height
    || ((result.status === "passed" || result.reviewed === true) && !hasCaptureIdentity)) {
    throw new ArtifactCandidateRetentionError(`${label} status is invalid`);
  }
  return {
    frameId,
    frameAttemptId,
    width,
    height,
    status: result.status,
    reviewed: result.reviewed,
    captureIdentity: hasCaptureIdentity
      ? exactCaptureIdentity(result.captureIdentity, `${label} PNG identity`, { width, height })
      : null,
  };
}

function exactEvaluationManifest(
  value: unknown,
  expected: EvaluationManifestIdentity,
  collected: EvaluationEvidenceCollection,
): Record<string, unknown> {
  const label = `Artifact evaluation manifest ${expected.round}`;
  const manifest = dataRecord(value, label);
  const hasRuntimeChecks = Object.hasOwn(manifest, "runtimeChecks");
  const hasReviewSummary = Object.hasOwn(manifest, "reviewSummary");
  const hasVisualEvidence = Object.hasOwn(manifest, "visualEvidence");
  const hasSourceCaptureResult = Object.hasOwn(manifest, "sourceCaptureResult");
  const hasSourceVisualEvidence = Object.hasOwn(manifest, "sourceVisualEvidence");
  exactFields(manifest, [
    "protocol", "candidate", "round", "passed", "score", "qualityState",
    "findingsDigest", "frameResults",
    ...(hasRuntimeChecks ? ["runtimeChecks"] : []),
    ...(hasReviewSummary ? ["reviewSummary"] : []),
    ...(hasVisualEvidence ? ["visualEvidence"] : []),
    ...(hasSourceCaptureResult ? ["sourceCaptureResult"] : []),
    ...(hasSourceVisualEvidence ? ["sourceVisualEvidence"] : []),
  ], label);
  if ((expected.requireRuntimeChecks && !hasRuntimeChecks)
    || (expected.requireVisualReview && (!hasReviewSummary || !hasVisualEvidence))) {
    throw new ArtifactCandidateRetentionError(
      `${label} omits evidence required by the immutable QA profile`,
    );
  }
  const candidate = dataRecord(manifest.candidate, `${label} candidate`);
  exactFields(candidate, ["commitHash", "treeHash"], `${label} candidate`);
  const commitHash = exactObjectId(candidate.commitHash, `${label} candidate commit`);
  const treeHash = exactObjectId(candidate.treeHash, `${label} candidate tree`);
  const findingsDigest = exactSha256(manifest.findingsDigest, `${label} findings digest`);
  if (manifest.protocol !== "dezin.artifact-run-evaluation-manifest.v1"
    || manifest.round !== expected.round
    || manifest.passed !== expected.passed
    || manifest.score !== expected.score
    || commitHash !== expected.candidateCommitHash
    || treeHash !== expected.candidateTreeHash
    || commitHash.length !== treeHash.length
    || (manifest.qualityState !== "passed"
      && manifest.qualityState !== "needs-attention"
      && manifest.qualityState !== "failed")
    || (expected.passed ? manifest.qualityState === "failed" : manifest.qualityState !== "failed")) {
    throw new ArtifactCandidateRetentionError(`${label} identity or outcome is invalid`);
  }
  void findingsDigest;

  const frameResults = exactDataArray(
    manifest.frameResults,
    `${label} Frame results`,
    0,
    MAX_EVALUATION_FRAMES,
  );
  if (frameResults.length !== expected.frames.length) {
    throw new ArtifactCandidateRetentionError(`${label} Frame results do not exactly cover the immutable Task Frames`);
  }
  const normalizedFrameResults = frameResults.map((result, index) => exactFrameResult(
    result,
    index,
    expected.frames[index]!,
  ));
  const frameIds = new Set<string>();
  const frameAttemptIds = new Set<string>();
  for (const result of normalizedFrameResults) {
    if (frameIds.has(result.frameId) || frameAttemptIds.has(result.frameAttemptId)) {
      throw new ArtifactCandidateRetentionError(`${label} Frame results are not unique`);
    }
    frameIds.add(result.frameId);
    frameAttemptIds.add(result.frameAttemptId);
  }

  if (hasRuntimeChecks) {
    const runtimeChecks = exactDataArray(
      manifest.runtimeChecks,
      `${label} runtime checks`,
      0,
      MAX_EVALUATION_FRAMES,
    );
    if (runtimeChecks.length !== normalizedFrameResults.length) {
      throw new ArtifactCandidateRetentionError(`${label} runtime checks do not cover every Frame`);
    }
    for (let index = 0; index < runtimeChecks.length; index += 1) {
      const check = dataRecord(runtimeChecks[index], `${label} runtime check ${index}`);
      exactFields(check, ["id", "status"], `${label} runtime check ${index}`);
      const result = normalizedFrameResults[index]!;
      if (check.id !== `frame:${result.frameId}`
        || check.status !== result.status) {
        throw new ArtifactCandidateRetentionError(`${label} runtime check ${index} is inconsistent`);
      }
    }
  }

  if (hasReviewSummary !== hasVisualEvidence) {
    throw new ArtifactCandidateRetentionError(`${label} review summary and Frame descriptors must be retained together`);
  }
  let review: Record<string, unknown> | null = null;
  let reviewEvidence: readonly unknown[] = [];
  let sourceReviewEvidence: unknown;
  if (hasReviewSummary) {
    review = dataRecord(manifest.reviewSummary, `${label} review summary`);
    const hasSourceReviewEvidence = Object.hasOwn(review, "sourceEvidence");
    exactFields(review, [
      "status", "fidelity", "evidence",
      ...(hasSourceReviewEvidence ? ["sourceEvidence"] : []),
    ], `${label} review summary`);
    if ((review.status !== "passed" && review.status !== "failed")
      || typeof review.fidelity !== "number" || !Number.isFinite(review.fidelity)
      || review.fidelity < 0 || review.fidelity > 1) {
      throw new ArtifactCandidateRetentionError(`${label} review summary is invalid`);
    }
    reviewEvidence = exactDataArray(
      review.evidence,
      `${label} review Frame evidence`,
      0,
      MAX_EVALUATION_FRAMES,
    );
    sourceReviewEvidence = hasSourceReviewEvidence ? review.sourceEvidence : undefined;
    if (reviewEvidence.length !== normalizedFrameResults.length
      || (expected.passed && review.status !== "passed")) {
      throw new ArtifactCandidateRetentionError(`${label} review outcome is inconsistent`);
    }
    if (normalizedFrameResults.some((result) => !result.reviewed)) {
      throw new ArtifactCandidateRetentionError(`${label} reviewed descriptors include an unreviewed Frame`);
    }
  }

  const storageKeys = new Set<string>();
  if (hasVisualEvidence) {
    const descriptors = exactDataArray(
      manifest.visualEvidence,
      `${label} Frame visual evidence`,
      0,
      MAX_EVALUATION_FRAMES,
    );
    if (descriptors.length !== normalizedFrameResults.length) {
      throw new ArtifactCandidateRetentionError(`${label} Frame descriptors do not cover every Frame`);
    }
    for (let index = 0; index < descriptors.length; index += 1) {
      const result = normalizedFrameResults[index]!;
      const summary = dataRecord(reviewEvidence[index], `${label} Frame review evidence ${index}`);
      exactFields(summary, [
        "frameId", "frameAttemptId", "sha256", "byteLength", "storageKey",
      ], `${label} Frame review evidence ${index}`);
      const checksum = exactSha256(summary.sha256, `${label} Frame review evidence ${index} checksum`);
      const byteLength = exactPositiveInteger(summary.byteLength, `${label} Frame review evidence ${index} byte length`);
      const storageKey = exactBoundedText(
        summary.storageKey,
        `${label} Frame review evidence ${index} storage key`,
        4_096,
      );
      if (summary.frameId !== result.frameId || summary.frameAttemptId !== result.frameAttemptId
        || result.captureIdentity === null
        || result.captureIdentity.sha256 !== checksum
        || result.captureIdentity.byteLength !== byteLength
        || storageKeys.has(storageKey)) {
        throw new ArtifactCandidateRetentionError(`${label} Frame review evidence ${index} is inconsistent`);
      }
      storageKeys.add(storageKey);

      const descriptor = dataRecord(descriptors[index], `${label} Frame descriptor ${index}`);
      exactFields(descriptor, [
        "protocol", "owner", "frame", "round", "mediaType", "sha256", "byteLength", "storageKey",
      ], `${label} Frame descriptor ${index}`);
      exactEvaluationOwner(descriptor.owner, expected, `${label} Frame descriptor ${index} owner`);
      const descriptorFrame = dataRecord(descriptor.frame, `${label} Frame descriptor ${index} Frame`);
      const descriptorFrameCanonical = canonicalBytes(
        descriptorFrame,
        `${label} Frame descriptor ${index} Frame`,
        256 * 1024,
      );
      const expectedDescriptorFrame = dataRecord({
        ...expected.frames[index]!,
        frameAttemptId: result.frameAttemptId,
      }, `${label} expected Frame descriptor ${index}`);
      const expectedDescriptorFrameCanonical = canonicalBytes(
        expectedDescriptorFrame,
        `${label} expected Frame descriptor ${index}`,
        256 * 1024,
      );
      if (descriptorFrameCanonical !== expectedDescriptorFrameCanonical) {
        throw new ArtifactCandidateRetentionError(
          `${label} Frame descriptor ${index} diverges from the immutable Task Frame`,
        );
      }
      const expectedStorageKey = [
        "generation-task-evidence",
        expected.projectId,
        expected.workspaceId,
        expected.planId,
        expected.taskId,
        `attempt-${expected.attempt}`,
        "visual",
        `round-${expected.round}-${generationTaskVisualEvidenceFrameStorageSegment(result.frameId)}-${checksum}.png`,
      ].join("/");
      if (descriptor.protocol !== "dezin.generation-task-visual-evidence.v1"
        || descriptor.round !== expected.round
        || descriptor.mediaType !== "image/png"
        || descriptor.sha256 !== checksum
        || descriptor.byteLength !== byteLength
        || descriptor.storageKey !== storageKey
        || storageKey !== expectedStorageKey
        ) {
        throw new ArtifactCandidateRetentionError(`${label} Frame descriptor ${index} is inconsistent`);
      }
      const exactFrame: GenerationTaskVisualEvidenceFrame = {
        id: result.frameId,
        name: String(descriptorFrame.name),
        width: result.width,
        height: result.height,
        frameAttemptId: result.frameAttemptId,
      };
      if (Object.hasOwn(descriptorFrame, "initialState")) {
        exactFrame.initialState = String(descriptorFrame.initialState);
      }
      if (Object.hasOwn(descriptorFrame, "fixture")) {
        exactFrame.fixture = structuredClone(
          descriptorFrame.fixture as Record<string, unknown>,
        );
      }
      if (Object.hasOwn(descriptorFrame, "background")) {
        exactFrame.background = String(descriptorFrame.background);
      }
      const expectedOwner = evidenceOwner(expected);
      collected.visualEvidence.push({
        expectedOwner,
        descriptor: {
          protocol: "dezin.generation-task-visual-evidence.v1",
          owner: { ...expectedOwner },
          frame: exactFrame,
          round: expected.round,
          mediaType: "image/png",
          sha256: checksum,
          byteLength,
          storageKey,
        },
      });
    }
  }

  const sourcePartCount = [
    hasSourceCaptureResult,
    hasSourceVisualEvidence,
    sourceReviewEvidence !== undefined,
  ].filter(Boolean).length;
  if (sourcePartCount !== 0 && sourcePartCount !== 3) {
    throw new ArtifactCandidateRetentionError(`${label} source evidence is incomplete`);
  }
  if (sourcePartCount === 3) {
    const result = dataRecord(manifest.sourceCaptureResult, `${label} source capture result`);
    exactFields(result, [
      "scope", "sourceAttemptId", "width", "height", "status", "reviewed", "captureIdentity",
    ], `${label} source capture result`);
    const sourceAttemptId = exactIdentifier(result.sourceAttemptId, `${label} source Attempt id`);
    const dimensions = exactDimensions(result, `${label} source capture result`);
    const sourceIdentity = exactCaptureIdentity(
      result.captureIdentity,
      `${label} source PNG identity`,
      dimensions,
    );
    if (result.scope !== "source"
      || (result.status !== "passed" && result.status !== "failed")
      || result.reviewed !== true
      || frameAttemptIds.has(sourceAttemptId)
      || (expected.passed && result.status !== "passed")) {
      throw new ArtifactCandidateRetentionError(`${label} source capture result is invalid`);
    }

    const summary = dataRecord(sourceReviewEvidence, `${label} source review evidence`);
    exactFields(summary, [
      "scope", "sourceAttemptId", "width", "height", "sha256", "byteLength", "storageKey",
    ], `${label} source review evidence`);
    const sourceChecksum = exactSha256(summary.sha256, `${label} source review checksum`);
    const sourceByteLength = exactPositiveInteger(summary.byteLength, `${label} source review byte length`);
    const sourceStorageKey = exactBoundedText(
      summary.storageKey,
      `${label} source review storage key`,
      4_096,
    );
    if (summary.scope !== "source" || summary.sourceAttemptId !== sourceAttemptId
      || summary.width !== dimensions.width || summary.height !== dimensions.height
      || sourceIdentity.sha256 !== sourceChecksum
      || sourceIdentity.byteLength !== sourceByteLength
      || storageKeys.has(sourceStorageKey)) {
      throw new ArtifactCandidateRetentionError(`${label} source review evidence is inconsistent`);
    }

    const descriptor = dataRecord(manifest.sourceVisualEvidence, `${label} source descriptor`);
    exactFields(descriptor, [
      "protocol", "owner", "capture", "sourceAuthority", "round", "mediaType", "sha256",
      "byteLength", "storageKey",
    ], `${label} source descriptor`);
    exactEvaluationOwner(descriptor.owner, expected, `${label} source descriptor owner`);
    const capture = dataRecord(descriptor.capture, `${label} source descriptor capture`);
    exactFields(capture, ["scope", "sourceAttemptId", "width", "height"], `${label} source descriptor capture`);
    const authority = exactSourceAuthority(
      descriptor.sourceAuthority,
      `${label} source descriptor authority`,
    );
    const expectedStorageKey = [
      "generation-task-evidence",
      expected.projectId,
      expected.workspaceId,
      expected.planId,
      expected.taskId,
      `attempt-${expected.attempt}`,
      "visual",
      `round-${expected.round}-source-${sourceChecksum}.png`,
    ].join("/");
    if (descriptor.protocol !== "dezin.generation-task-source-visual-evidence.v1"
      || descriptor.round !== expected.round
      || descriptor.mediaType !== "image/png"
      || descriptor.sha256 !== sourceChecksum
      || descriptor.byteLength !== sourceByteLength
      || descriptor.storageKey !== sourceStorageKey
      || sourceStorageKey !== expectedStorageKey
      || capture.scope !== "source"
      || capture.sourceAttemptId !== sourceAttemptId
      || capture.width !== dimensions.width
      || capture.height !== dimensions.height
      || !expected.resourcePins.some((pin) => pin.resourceId === authority.resourceId
        && pin.revisionId === authority.revisionId)) {
      throw new ArtifactCandidateRetentionError(`${label} source descriptor is inconsistent`);
    }
    const expectedOwner = evidenceOwner(expected);
    const exactCapture: GenerationTaskSourceVisualEvidenceCapture = {
      scope: "source",
      sourceAttemptId,
      width: dimensions.width,
      height: dimensions.height,
    };
    collected.sourceVisualEvidence.push({
      expectedOwner,
      descriptor: {
        protocol: "dezin.generation-task-source-visual-evidence.v1",
        owner: { ...expectedOwner },
        capture: exactCapture,
        sourceAuthority: { ...authority },
        round: expected.round,
        mediaType: "image/png",
        sha256: sourceChecksum,
        byteLength: sourceByteLength,
        storageKey: sourceStorageKey,
      },
    });
  }

  if (expected.passed && normalizedFrameResults.some((result) => result.status !== "passed")) {
    throw new ArtifactCandidateRetentionError(`${label} passed outcome retains a failed Frame`);
  }
  return manifest;
}

export interface ArtifactCandidateRetentionDescriptor {
  projectId: string;
  candidateEvidenceSha256: string;
  attempt: ArtifactCandidateAttempt;
  attemptRef: string;
  history: readonly ArtifactCandidateIdentity[];
  historyHead: ArtifactCandidateIdentity;
  visualEvidence: readonly ArtifactCandidateVisualEvidenceVerification[];
  sourceVisualEvidence: readonly ArtifactCandidateSourceVisualEvidenceVerification[];
}

export interface ArtifactCandidateRetentionSubject {
  readonly task: GenerationTask;
  readonly attempt: GenerationTaskAttempt;
  readonly artifactRevision: {
    readonly id: string;
    readonly workspaceId: string;
    readonly artifactId: string;
    readonly trackId: string;
    readonly sourceCommitHash: string;
    readonly sourceTreeHash: string;
    readonly contextPackHash: string | null;
    readonly quality: Readonly<Record<string, unknown>>;
  };
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

  const safeEvidence = exactJsonClone(input.evidence, "Artifact candidate retention evidence");
  const candidateEvidenceSha256 = createHash("sha256").update(canonicalBytes(
    safeEvidence,
    "Artifact candidate retention evidence",
    MAX_ARTIFACT_RUN_EVIDENCE_BYTES,
  ), "utf8").digest("hex");
  const evidence = dataRecord(safeEvidence, "Artifact candidate retention evidence");
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
  const projectId = exactIdentifier(evidence.projectId, "Artifact candidate Project id");
  const workspaceId = exactIdentifier(evidence.workspaceId, "Artifact candidate Workspace id");
  const planId = exactIdentifier(evidence.planId, "Artifact candidate Plan id");
  const taskId = exactIdentifier(evidence.taskId, "Artifact candidate Task id");
  const contextPackId = exactIdentifier(evidence.contextPackId, "Artifact candidate Context Pack id");
  const contextPackHash = exactSha256(evidence.contextPackHash, "Artifact candidate Context Pack hash");
  const plannedFrames = exactPlannedFrames(claim.task.payload);
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
  const collected: EvaluationEvidenceCollection = {
    visualEvidence: [],
    sourceVisualEvidence: [],
  };
  const retainedVersions = exactDataArray(evidence.versions, "Artifact candidate versions").map((value, index) => {
    const version = dataRecord(value, `Artifact candidate version ${index}`);
    exactFields(
      version,
      ["round", "commitHash", "treeHash", "passed", "score", "evaluationManifest"],
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
    const manifest = exactEvaluationManifest(version.evaluationManifest, {
      projectId,
      workspaceId,
      planId,
      taskId,
      attempt: attempt.attempt,
      contextPackId,
      contextPackHash,
      candidateCommitHash: commitHash,
      candidateTreeHash: treeHash,
      requireRuntimeChecks: claim.task.qaProfile.requireRuntimeChecks,
      requireVisualReview: claim.task.qaProfile.requireVisualReview,
      round: index,
      passed: version.passed,
      score: version.score,
      frames: plannedFrames,
      resourcePins: claim.attempt.resourcePins,
    }, collected);
    return { commitHash, treeHash, manifest };
  });
  const firstSourceAuthority = collected.sourceVisualEvidence[0]?.descriptor.sourceAuthority;
  if (firstSourceAuthority !== undefined
    && collected.sourceVisualEvidence.some(({ descriptor }) => (
      !isDeepStrictEqual(descriptor.sourceAuthority, firstSourceAuthority)
    ))) {
    throw new ArtifactCandidateRetentionError(
      "Artifact retained source evidence does not share one exact Resource Revision authority",
    );
  }
  if (selectedRound >= retainedVersions.length) {
    throw new ArtifactCandidateRetentionError("Artifact candidate selected round is not retained");
  }
  const selected = retainedVersions[selectedRound]!;
  if (selected.commitHash !== artifactRevision.sourceCommitHash
    || selected.treeHash !== artifactRevision.sourceTreeHash) {
    throw new ArtifactCandidateRetentionError(
      "Artifact Revision does not match the selected retained version",
    );
  }
  if (selected.manifest.passed !== true
    || selected.manifest.score !== artifactRevision.quality.score
    || selected.manifest.qualityState !== artifactRevision.quality.state) {
    throw new ArtifactCandidateRetentionError(
      "Artifact Revision quality does not match the selected evaluation manifest",
    );
  }
  const selectedFindings = exactDataArray(
    artifactRevision.quality.findings,
    "Artifact Revision selected findings",
    0,
    10_000,
  );
  const selectedFindingsCanonical = canonicalBytes(
    selectedFindings,
    "Artifact Revision selected findings",
    MAX_EVALUATION_FINDINGS_BYTES,
  );
  if (selected.manifest.findingsDigest !== createHash("sha256")
    .update(selectedFindingsCanonical)
    .digest("hex")) {
    throw new ArtifactCandidateRetentionError(
      "Artifact Revision findings do not match the selected evaluation manifest",
    );
  }
  const selectedQualityCandidate = dataRecord(
    qualityEvidence.candidate,
    "Artifact candidate selected quality identity",
  );
  exactFields(
    selectedQualityCandidate,
    ["commitHash", "treeHash"],
    "Artifact candidate selected quality identity",
  );
  if (qualityEvidence.protocol !== "dezin.standard-artifact-quality.v1"
    || qualityEvidence.round !== selectedRound
    || selectedQualityCandidate.commitHash !== selected.commitHash
    || selectedQualityCandidate.treeHash !== selected.treeHash) {
    throw new ArtifactCandidateRetentionError(
      "Artifact selected evaluation manifest does not match top-level quality identity",
    );
  }
  for (const [manifestField, qualityField] of [
    ["frameResults", "frameResults"],
    ["runtimeChecks", "runtimeChecks"],
    ["reviewSummary", "visualReview"],
    ["visualEvidence", "visualEvidence"],
    ["sourceCaptureResult", "sourceCaptureResult"],
    ["sourceVisualEvidence", "sourceVisualEvidence"],
  ] as const) {
    const manifestHasField = Object.hasOwn(selected.manifest, manifestField);
    const qualityHasField = Object.hasOwn(qualityEvidence, qualityField);
    if (manifestHasField !== qualityHasField
      || (manifestHasField
        && !isDeepStrictEqual(selected.manifest[manifestField], qualityEvidence[qualityField]))) {
      throw new ArtifactCandidateRetentionError(
        `Artifact selected ${manifestField} diverges from top-level quality evidence`,
      );
    }
  }
  const versions = retainedVersions.map(({ commitHash, treeHash }) => ({ commitHash, treeHash }));
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
  return {
    projectId,
    candidateEvidenceSha256,
    attempt,
    attemptRef,
    history: versions,
    historyHead,
    visualEvidence: collected.visualEvidence,
    sourceVisualEvidence: collected.sourceVisualEvidence,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact candidate retention aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

type ImmutableEvidenceEntryDescriptor = Omit<ArtifactRevisionEvidenceEntryInput, "bytes">;

function immutableEvidenceEntryDescriptors(
  descriptor: ArtifactCandidateRetentionDescriptor,
): readonly ImmutableEvidenceEntryDescriptor[] {
  const values: ImmutableEvidenceEntryDescriptor[] = [
    ...descriptor.visualEvidence.map((verification) => ({
      kind: "frame" as const,
      round: verification.descriptor.round,
      storageKey: verification.descriptor.storageKey,
      sha256: verification.descriptor.sha256,
      byteLength: verification.descriptor.byteLength,
      descriptor: structuredClone(verification.descriptor) as unknown as Readonly<Record<string, unknown>>,
    })),
    ...descriptor.sourceVisualEvidence.map((verification) => ({
      kind: "source" as const,
      round: verification.descriptor.round,
      storageKey: verification.descriptor.storageKey,
      sha256: verification.descriptor.sha256,
      byteLength: verification.descriptor.byteLength,
      descriptor: structuredClone(verification.descriptor) as unknown as Readonly<Record<string, unknown>>,
    })),
  ];
  const unique = new Map<string, ImmutableEvidenceEntryDescriptor>();
  for (const value of values) {
    const existing = unique.get(value.storageKey);
    if (existing !== undefined && !isDeepStrictEqual(existing, value)) {
      throw new ArtifactCandidateRetentionError(
        "Artifact evidence assigns conflicting descriptors to one storage key",
      );
    }
    unique.set(value.storageKey, value);
  }
  return [...unique.values()].sort((left, right) => Buffer.compare(
    Buffer.from(left.storageKey, "utf8"),
    Buffer.from(right.storageKey, "utf8"),
  ));
}

export async function verifyRetainedArtifactRevisionEvidenceBundle(input: {
  readonly repositoryDir: string;
  readonly task: GenerationTask;
  readonly attempt: GenerationTaskAttempt;
  readonly artifactRevision: ArtifactCandidateRetentionSubject["artifactRevision"];
  readonly evidence: Record<string, unknown>;
  readonly signal: AbortSignal;
}): Promise<ArtifactRevisionEvidenceBundleReceipt> {
  checkAbort(input.signal);
  const descriptor = artifactCandidateRetentionDescriptor(input);
  return verifyArtifactRevisionEvidenceBundle({
    repositoryDir: exactText(input.repositoryDir, "Artifact repository directory"),
    projectId: descriptor.projectId,
    workspaceId: input.artifactRevision.workspaceId,
    revisionId: input.artifactRevision.id,
    artifactId: input.artifactRevision.artifactId,
    trackId: input.artifactRevision.trackId,
    candidate: {
      commitHash: input.artifactRevision.sourceCommitHash,
      treeHash: input.artifactRevision.sourceTreeHash,
    },
    contextPackHash: exactSha256(
      input.artifactRevision.contextPackHash,
      "Artifact Revision Context Pack hash",
    ),
    attempt: descriptor.attempt,
    candidateEvidenceSha256: descriptor.candidateEvidenceSha256,
    entries: immutableEvidenceEntryDescriptors(descriptor),
    signal: input.signal,
  });
}

/** Promotes an Attempt ref to the immutable Revision namespace before Core publication. */
export class GitArtifactCandidateRetention implements ArtifactCandidateRetentionPort {
  private readonly repositoryDirForWorkspace: GitArtifactCandidateRetentionOptions["repositoryDirForWorkspace"];
  private readonly dataDir: string;
  private readonly sourceAuthorityForRevision: GitArtifactCandidateRetentionOptions["sourceAuthorityForRevision"];

  constructor(options: GitArtifactCandidateRetentionOptions) {
    this.repositoryDirForWorkspace = options.repositoryDirForWorkspace;
    this.dataDir = exactText(options.dataDir, "Generation Task evidence data directory");
    if (typeof options.sourceAuthorityForRevision !== "function") {
      throw new ArtifactCandidateRetentionError(
        "Generation Task source evidence authority resolver is unavailable",
      );
    }
    this.sourceAuthorityForRevision = options.sourceAuthorityForRevision;
  }

  async verify(
    input: ArtifactCandidateRetentionPreparedInput,
    signal: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    if (input.claim.attempt.executionMode !== "full") {
      throw new ArtifactCandidateRetentionError(
        "Artifact candidate preflight is available only before full-execution staging",
      );
    }
    const contextPack = typeof input.claim.attempt.contextPackId === "string"
      ? /^context-pack-([0-9a-f]{64})$/.exec(input.claim.attempt.contextPackId)
      : null;
    if (contextPack === null) {
      throw new ArtifactCandidateRetentionError(
        "Artifact candidate preflight has no canonical Context Pack identity",
      );
    }
    const descriptor = artifactCandidateRetentionDescriptor({
      task: input.claim.task,
      attempt: input.claim.attempt,
      artifactRevision: {
        id: "artifact-candidate-preflight",
        ...input.candidate,
        contextPackHash: contextPack[1]!,
      },
      evidence: input.evidence,
    });
    await this.verifyEvidence(
      descriptor,
      input.claim.task.workspaceId,
      signal,
    );
  }

  async promote(
    input: ArtifactCandidateRetentionInput,
    signal: AbortSignal,
  ): Promise<ArtifactRevisionEvidenceBundleReceipt> {
    checkAbort(signal);
    const descriptor = artifactCandidateRetentionDescriptor({
      task: input.claim.task,
      attempt: input.claim.attempt,
      artifactRevision: input.artifactRevision,
      evidence: input.evidence,
    });
    const entries = await this.verifyEvidence(
      descriptor,
      input.claim.task.workspaceId,
      signal,
    );
    checkAbort(signal);
    const repositoryDir = exactText(
      await this.repositoryDirForWorkspace(input.claim.task.workspaceId),
      "Artifact repository directory",
    );
    checkAbort(signal);
    const receipt = await prepareArtifactRevisionEvidenceBundle({
      repositoryDir,
      projectId: descriptor.projectId,
      workspaceId: input.artifactRevision.workspaceId,
      revisionId: input.artifactRevision.id,
      artifactId: input.artifactRevision.artifactId,
      trackId: input.artifactRevision.trackId,
      candidate: {
        commitHash: input.artifactRevision.sourceCommitHash,
        treeHash: input.artifactRevision.sourceTreeHash,
      },
      contextPackHash: exactSha256(
        input.artifactRevision.contextPackHash,
        "Artifact Revision Context Pack hash",
      ),
      attempt: descriptor.attempt,
      candidateEvidenceSha256: descriptor.candidateEvidenceSha256,
      entries,
      signal,
    });
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
      evidence: receipt,
      signal,
    });
    checkAbort(signal);
    return receipt;
  }

  async verifyPublication(
    input: ArtifactCandidateRetentionInput,
    receipt: ArtifactRevisionEvidenceBundleReceipt,
    signal: AbortSignal,
  ): Promise<ArtifactRevisionEvidenceBundleReceipt> {
    checkAbort(signal);
    const descriptor = artifactCandidateRetentionDescriptor({
      task: input.claim.task,
      attempt: input.claim.attempt,
      artifactRevision: input.artifactRevision,
      evidence: input.evidence,
    });
    return this.verifyImmutableReceipt(input, descriptor, receipt, signal);
  }

  private async verifyImmutableReceipt(
    input: ArtifactCandidateRetentionInput,
    descriptor: ArtifactCandidateRetentionDescriptor,
    receipt: ArtifactRevisionEvidenceBundleReceipt,
    signal: AbortSignal,
  ): Promise<ArtifactRevisionEvidenceBundleReceipt> {
    const expectedEntries = immutableEvidenceEntryDescriptors(descriptor);
    const subject = receipt?.subject;
    if (subject?.projectId !== descriptor.projectId
      || subject.workspaceId !== input.artifactRevision.workspaceId
      || subject.revisionId !== input.artifactRevision.id
      || subject.artifactId !== input.artifactRevision.artifactId
      || subject.trackId !== input.artifactRevision.trackId
      || subject.candidate.commitHash !== input.artifactRevision.sourceCommitHash
      || subject.candidate.treeHash !== input.artifactRevision.sourceTreeHash
      || subject.contextPackHash !== input.artifactRevision.contextPackHash
      || subject.candidateEvidenceSha256 !== descriptor.candidateEvidenceSha256
      || !isDeepStrictEqual(subject.attempt, descriptor.attempt)
      || !isDeepStrictEqual(subject.entries, expectedEntries)) {
      throw new ArtifactCandidateRetentionError(
        "Immutable Artifact evidence receipt does not match the exact staged candidate",
      );
    }
    const repositoryDir = exactText(
      await this.repositoryDirForWorkspace(input.claim.task.workspaceId),
      "Artifact repository directory",
    );
    checkAbort(signal);
    const verified = await verifyArtifactRevisionEvidenceBundle({
      repositoryDir,
      ...subject,
      signal,
    });
    if (!isDeepStrictEqual(verified, receipt)) {
      throw new ArtifactCandidateRetentionError(
        "Immutable Artifact evidence receipt changed during exact verification",
      );
    }
    return verified;
  }

  private async verifyEvidence(
    descriptor: ArtifactCandidateRetentionDescriptor,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<readonly ArtifactRevisionEvidenceEntryInput[]> {
    const bytes = new Map<string, Buffer>();
    let totalBytes = 0;
    const retainBytes = (storageKey: string, value: Buffer): void => {
      const existing = bytes.get(storageKey);
      if (existing !== undefined) {
        if (!existing.equals(value)) {
          throw new ArtifactCandidateRetentionError(
            "Artifact immutable evidence storage key changed during inventory",
          );
        }
        return;
      }
      totalBytes += value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_IMMUTABLE_EVIDENCE_TOTAL_BYTES) {
        throw new ArtifactCandidateRetentionError(
          "Artifact immutable evidence inventory exceeds its 256 MiB production limit",
        );
      }
      bytes.set(storageKey, value);
    };
    for (const verification of descriptor.visualEvidence) {
      checkAbort(signal);
      retainBytes(verification.descriptor.storageKey, await readGenerationTaskVisualEvidence({
        dataDir: this.dataDir,
        descriptor: verification.descriptor,
        expectedOwner: verification.expectedOwner,
      }));
      checkAbort(signal);
    }
    const sourceAuthority = descriptor.sourceVisualEvidence[0]?.descriptor.sourceAuthority;
    if (sourceAuthority !== undefined) {
      checkAbort(signal);
      const trustedValue = await this.sourceAuthorityForRevision({
        workspaceId,
        resourceId: sourceAuthority.resourceId,
        revisionId: sourceAuthority.revisionId,
      }, signal);
      checkAbort(signal);
      if (trustedValue === null) {
        throw new ArtifactCandidateRetentionError(
          "Artifact source evidence Resource Revision authority is unavailable",
        );
      }
      const trustedAuthority = exactSourceAuthority(
        trustedValue,
        "Artifact trusted source evidence authority",
      );
      if (trustedAuthority.resourceId !== sourceAuthority.resourceId
        || trustedAuthority.revisionId !== sourceAuthority.revisionId) {
        throw new ArtifactCandidateRetentionError(
          "Artifact source evidence Resource Revision authority is inconsistent",
        );
      }
      for (const verification of descriptor.sourceVisualEvidence) {
        checkAbort(signal);
        retainBytes(verification.descriptor.storageKey, await readGenerationTaskSourceVisualEvidence({
          dataDir: this.dataDir,
          descriptor: verification.descriptor,
          expectedOwner: verification.expectedOwner,
          expectedSourceAuthority: trustedAuthority,
        }));
        checkAbort(signal);
      }
    }
    return immutableEvidenceEntryDescriptors(descriptor).map((entry) => {
      const exactBytes = bytes.get(entry.storageKey);
      if (exactBytes === undefined) {
        throw new ArtifactCandidateRetentionError(
          "Artifact immutable evidence inventory is incomplete",
        );
      }
      return { ...entry, bytes: exactBytes };
    });
  }

  async release(
    input: ArtifactCandidateRetentionInput,
    receipt: ArtifactRevisionEvidenceBundleReceipt,
    signal: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const descriptor = artifactCandidateRetentionDescriptor({
      task: input.claim.task,
      attempt: input.claim.attempt,
      artifactRevision: input.artifactRevision,
      evidence: input.evidence,
    });
    const verifiedReceipt = await this.verifyImmutableReceipt(input, descriptor, receipt, signal);
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
      evidence: verifiedReceipt,
      signal,
    });
    checkAbort(signal);
  }
}
