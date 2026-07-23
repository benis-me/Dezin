import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import {
  generationTaskVisualEvidenceFrameStorageSegment,
  isExactRenderFrameCaptureViewport,
} from "./render-frame.ts";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_FRAME_COUNT = 64;
const MAX_CAPTURE_DIMENSION = 32_768;
const MAX_CAPTURE_PIXELS = 64_000_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_RUN_EVIDENCE_BYTES = 1024 * 1024;

export interface GenerationTaskArtifactQualityGateInput {
  /** Core supplies false or an exact frozen Sharingan Revision; daemon-only preflight passes null. */
  requireSourceVisualEvidence: unknown;
  qaProfile: unknown;
  plannedFrames: unknown;
  renderSpec: unknown;
  quality: unknown;
  evidence: unknown;
  /** Core supplies this fence; daemon-only preflight may pass null. */
  expectedEvidenceOwner: unknown;
}

export interface GenerationTaskSourceVisualEvidenceAuthority {
  resourceId: string;
  revisionId: string;
  revisionChecksum: string;
}

export type GenerationTaskSourceVisualEvidenceRequirement =
  | false
  | null
  | GenerationTaskSourceVisualEvidenceAuthority;

export class GenerationTaskQualityGateError extends Error {
  readonly failureClass = "qa" as const;
  readonly code = "generation-task-quality-gate" as const;

  constructor(message: string) {
    super(message);
    this.name = "GenerationTaskQualityGateError";
  }
}

function fail(message: string): never {
  throw new GenerationTaskQualityGateError(message);
}

function isWellFormedUtf16(value: string): boolean {
  const native = value as string & { isWellFormed?: () => boolean };
  if (typeof native.isWellFormed === "function") return native.isWellFormed();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

interface CloneState {
  ancestors: WeakSet<object>;
  nodes: number;
}

function canonicalClone(value: unknown, label: string, state: CloneState, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    fail(`${label} exceeds the quality evidence boundary budget`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormedUtf16(value)) fail(`${label} contains malformed Unicode`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") fail(`${label} must contain only JSON data`);
  if (state.ancestors.has(value)) fail(`${label} cannot contain cycles`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain array`);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
        || (key !== "length" && !/^\d+$/.test(key)))) {
        fail(`${label} must be a dense data array`);
      }
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          fail(`${label} must be a dense data array`);
        }
        output.push(canonicalClone(descriptor.value, `${label}[${index}]`, state, depth + 1));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) fail(`${label} cannot contain symbol fields`);
    const output: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        fail(`${label} contains unsafe field ${key}`);
      }
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) fail(`${label}.${key} must be data`);
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: canonicalClone(descriptor.value, `${label}.${key}`, state, depth + 1),
        writable: true,
      });
    }
    return output;
  } catch {
    fail(`${label} could not be inspected safely`);
  } finally {
    state.ancestors.delete(value);
  }
}

function normalized(value: unknown, label: string): unknown {
  return canonicalClone(value, label, { ancestors: new WeakSet<object>(), nodes: 0 });
}

function record(value: unknown, label: string): Record<string, unknown> {
  const candidate = normalized(value, label);
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail(`${label} must be an object`);
  }
  return candidate as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  const candidate = normalized(value, label);
  if (!Array.isArray(candidate)) fail(`${label} must be an array`);
  return candidate;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) {
    fail(`${label} fields are invalid`);
  }
}

function text(value: unknown, label: string, maxLength = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || !isWellFormedUtf16(value)) {
    fail(`${label} must be non-empty bounded text`);
  }
  return value;
}

const VIEWER_FRAME_TEXT_CONTROL = /[\u0000-\u001f\u007f]/;

function renderFrameId(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (result !== result.trim() || VIEWER_FRAME_TEXT_CONTROL.test(result)) {
    fail(`${label} is not a Viewer-safe Frame identifier`);
  }
  return result;
}

function validateFrame(value: unknown, index: number): Record<string, unknown> {
  const frame = value as Record<string, unknown>;
  const allowed = new Set(["id", "name", "width", "height", "initialState", "fixture", "background"]);
  if (Object.keys(frame).some((key) => !allowed.has(key))) {
    fail(`Artifact RenderSpec Frame ${index} contains unsupported fields`);
  }
  const id = renderFrameId(frame.id, `Artifact RenderSpec Frame ${index} id`);
  if (!isExactRenderFrameCaptureViewport(frame.width, frame.height)) {
    fail(`Artifact RenderSpec Frame ${id} dimensions are invalid`);
  }
  if (frame.name !== undefined) text(frame.name, `Artifact RenderSpec Frame ${id} name`, 512);
  if (frame.initialState !== undefined) {
    text(frame.initialState, `Artifact RenderSpec Frame ${id} initial state`, 256);
  }
  if (frame.background !== undefined) {
    text(frame.background, `Artifact RenderSpec Frame ${id} background`, 4_096);
  }
  if (frame.fixture !== undefined
    && (frame.fixture === null || typeof frame.fixture !== "object" || Array.isArray(frame.fixture))) {
    fail(`Artifact RenderSpec Frame ${id} fixture must be an object`);
  }
  return frame;
}

function validateProfile(value: unknown): {
  requiredFrameIds: string[];
  blockingSeverities: string[];
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
} {
  const profile = record(value, "Generation Task QA profile");
  exactFields(profile, [
    "requiredFrameIds", "blockingSeverities", "requireRuntimeChecks", "requireVisualReview",
  ], "Generation Task QA profile");
  if (!Array.isArray(profile.requiredFrameIds) || !Array.isArray(profile.blockingSeverities)
    || typeof profile.requireRuntimeChecks !== "boolean"
    || typeof profile.requireVisualReview !== "boolean") {
    fail("Generation Task QA profile is invalid");
  }
  const requiredFrameIds = profile.requiredFrameIds.map((value, index) => text(
    value,
    `Generation Task required Frame ${index}`,
    256,
  ));
  const blockingSeverities = profile.blockingSeverities.map((severity) => {
    if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
      fail("Generation Task blocking severity is invalid");
    }
    return severity;
  });
  if (new Set(requiredFrameIds).size !== requiredFrameIds.length
    || new Set(blockingSeverities).size !== blockingSeverities.length) {
    fail("Generation Task QA profile entries must be unique");
  }
  return {
    requiredFrameIds,
    blockingSeverities,
    requireRuntimeChecks: profile.requireRuntimeChecks,
    requireVisualReview: profile.requireVisualReview,
  };
}

function validateFrames(input: {
  plannedFrames: unknown;
  renderSpec: unknown;
  requiredFrameIds: readonly string[];
}): Record<string, unknown>[] {
  const plannedFrames = array(input.plannedFrames, "Generation Task planned Frames");
  const renderSpec = record(input.renderSpec, "Artifact RenderSpec");
  if (!Array.isArray(renderSpec.frames)
    || renderSpec.frames.length === 0 || renderSpec.frames.length > MAX_FRAME_COUNT) {
    fail("Artifact RenderSpec must contain between 1 and 64 Frames");
  }
  const frames = renderSpec.frames.map(validateFrame);
  const frameIds = frames.map((frame) => frame.id as string);
  if (new Set(frameIds).size !== frameIds.length) fail("Artifact RenderSpec Frame ids must be unique");
  if (plannedFrames.length > 0 && !isDeepStrictEqual(frames, plannedFrames)) {
    fail("Artifact RenderSpec Frames diverge from the immutable Task plan");
  }
  for (const requiredFrameId of input.requiredFrameIds) {
    if (!frameIds.includes(requiredFrameId)) {
      fail(`Artifact RenderSpec is missing required Frame ${requiredFrameId}`);
    }
  }
  return frames;
}

interface ValidatedArtifactQuality {
  state: "passed" | "needs-attention";
  score: number;
  findingsDigest: string;
}

function validateQuality(
  value: unknown,
  blockingSeverities: readonly string[],
): ValidatedArtifactQuality {
  const quality = record(value, "Artifact quality result");
  exactFields(quality, ["state", "score", "findings"], "Artifact quality result");
  if (quality.state !== "passed" && quality.state !== "needs-attention"
    && quality.state !== "failed" && quality.state !== "unassessed") {
    fail("Artifact quality state is invalid");
  }
  if (typeof quality.score !== "number" || !Number.isFinite(quality.score)
    || quality.score < 0 || quality.score > 100) {
    fail("Artifact quality score must be between 0 and 100");
  }
  if (!Array.isArray(quality.findings) || quality.findings.length > 10_000) {
    fail("Artifact quality findings are invalid");
  }
  const findingIds = new Set<string>();
  const activeSeverities: string[] = [];
  const allowed = new Set([
    "severity", "id", "message", "fix", "snippet", "selector", "screenshotPath", "screenshotUrl",
    "reviewSummary", "reviewStatus", "reviewRound", "corroborated",
  ]);
  for (let index = 0; index < quality.findings.length; index += 1) {
    const finding = quality.findings[index] as Record<string, unknown>;
    if (Object.keys(finding).some((key) => !allowed.has(key))) {
      fail(`Artifact quality finding ${index} contains unsupported fields`);
    }
    if (finding.severity !== "P0" && finding.severity !== "P1" && finding.severity !== "P2") {
      fail(`Artifact quality finding ${index} severity is invalid`);
    }
    const id = text(finding.id, `Artifact quality finding ${index} id`, 512);
    if (findingIds.has(id)) fail(`Artifact quality finding id ${id} is duplicated`);
    findingIds.add(id);
    text(finding.message, `Artifact quality finding ${id} message`);
    text(finding.fix, `Artifact quality finding ${id} fix`);
    for (const field of [
      "snippet", "selector", "screenshotPath", "screenshotUrl", "reviewSummary",
    ] as const) {
      if (finding[field] !== undefined) text(finding[field], `Artifact quality finding ${id} ${field}`);
    }
    if (finding.reviewStatus !== undefined
      && finding.reviewStatus !== "active" && finding.reviewStatus !== "resolved") {
      fail(`Artifact quality finding ${id} review status is invalid`);
    }
    if (finding.reviewRound !== undefined
      && (!Number.isSafeInteger(finding.reviewRound) || (finding.reviewRound as number) < 0)) {
      fail(`Artifact quality finding ${id} review round is invalid`);
    }
    if (finding.corroborated !== undefined && typeof finding.corroborated !== "boolean") {
      fail(`Artifact quality finding ${id} corroboration is invalid`);
    }
    if (finding.reviewStatus !== "resolved") activeSeverities.push(finding.severity);
  }
  const blocking = new Set(blockingSeverities);
  const blockingSeverity = activeSeverities.find((severity) => blocking.has(severity));
  if (blockingSeverity !== undefined) {
    fail(`Artifact quality contains an active blocking ${blockingSeverity} finding`);
  }
  if (quality.state === "failed" || quality.state === "unassessed") {
    fail(`Artifact quality state ${quality.state} cannot be published`);
  }
  if ((activeSeverities.length === 0) !== (quality.state === "passed")) {
    fail("Artifact quality state does not match its active findings");
  }
  return {
    state: quality.state as ValidatedArtifactQuality["state"],
    score: quality.score,
    findingsDigest: createHash("sha256")
      .update(JSON.stringify(quality.findings))
      .digest("hex"),
  };
}

interface ExpectedEvidenceOwner {
  projectId: string;
  workspaceId: string;
  planId: string;
  taskId: string;
  attempt: number;
  attemptCreatedAt: number;
  inputHash: string;
  sourceBase: {
    commitHash: string;
    treeHash: string;
  };
  candidateRetentionRef: string;
  candidateCommitHash: string;
  candidateTreeHash: string;
  contextPackId: string;
  contextPackHash: string;
}

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

function evidenceId(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (!EVIDENCE_ID.test(result) || result === "." || result === "..") {
    fail(`${label} is not a safe identifier`);
  }
  return result;
}

function gitObjectId(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!GIT_OBJECT_ID.test(result)) fail(`${label} must be a lowercase Git object id`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!SHA256.test(result)) fail(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function sourceVisualEvidenceAuthority(
  value: unknown,
  label: string,
): GenerationTaskSourceVisualEvidenceAuthority {
  const authority = record(value, label);
  exactFields(authority, ["resourceId", "revisionId", "revisionChecksum"], label);
  return {
    resourceId: evidenceId(authority.resourceId, `${label} Resource id`),
    revisionId: evidenceId(authority.revisionId, `${label} Resource Revision id`),
    revisionChecksum: sha256(authority.revisionChecksum, `${label} Resource Revision checksum`),
  };
}

function sourceVisualEvidenceRequirement(
  value: unknown,
): GenerationTaskSourceVisualEvidenceRequirement {
  if (value === false || value === null) return value;
  return sourceVisualEvidenceAuthority(value, "Generation Task source visual evidence authority");
}

function requiresSourceVisualEvidence(
  value: GenerationTaskSourceVisualEvidenceRequirement,
): value is GenerationTaskSourceVisualEvidenceAuthority {
  return value !== false && value !== null;
}

function captureIdentity(value: unknown, label: string, audited: {
  width: number;
  height: number;
  sha256?: string;
  byteLength?: number;
}): { sha256: string; byteLength: number; width: number; height: number } {
  const identity = record(value, label);
  exactFields(identity, ["sha256", "byteLength", "width", "height"], label);
  const checksum = sha256(identity.sha256, `${label} checksum`);
  if (!Number.isSafeInteger(identity.byteLength) || Number(identity.byteLength) < 1
    || Number(identity.byteLength) > MAX_CAPTURE_BYTES
    || !Number.isSafeInteger(identity.width) || !Number.isSafeInteger(identity.height)
    || Number(identity.width) < audited.width || Number(identity.height) < audited.height
    || Number(identity.width) > MAX_CAPTURE_DIMENSION
    || Number(identity.height) > MAX_CAPTURE_DIMENSION
    || Number(identity.width) * Number(identity.height) > MAX_CAPTURE_PIXELS
    || (audited.sha256 !== undefined && checksum !== audited.sha256)
    || (audited.byteLength !== undefined && Number(identity.byteLength) !== audited.byteLength)) {
    fail(`${label} does not match the reviewed PNG evidence`);
  }
  return {
    sha256: checksum,
    byteLength: Number(identity.byteLength),
    width: Number(identity.width),
    height: Number(identity.height),
  };
}

export function generationTaskArtifactCandidateRetentionRef(input: {
  workspaceId: string;
  taskId: string;
  attempt: number;
  inputHash: string;
}): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "artifact-candidate-attempt-v1",
    input.workspaceId,
    input.taskId,
    input.attempt,
    input.inputHash,
  ])).digest("hex");
  return `refs/dezin/generation-attempts/artifacts/${digest}`;
}

function expectedEvidenceOwner(value: unknown): ExpectedEvidenceOwner | null {
  if (value === null) return null;
  const owner = record(value, "Generation Task expected evidence owner");
  exactFields(owner, [
    "projectId", "workspaceId", "planId", "taskId", "attempt", "candidateCommitHash",
    "candidateTreeHash", "contextPackId", "contextPackHash", "inputHash",
    "attemptCreatedAt", "sourceBase", "candidateRetentionRef",
  ], "Generation Task expected evidence owner");
  if (!Number.isSafeInteger(owner.attempt) || Number(owner.attempt) < 1
    || !Number.isSafeInteger(owner.attemptCreatedAt) || Number(owner.attemptCreatedAt) < 0) {
    fail("Generation Task expected evidence Attempt is invalid");
  }
  const workspaceId = evidenceId(owner.workspaceId, "Generation Task expected Workspace id");
  const taskId = evidenceId(owner.taskId, "Generation Task expected Task id");
  const inputHash = sha256(owner.inputHash, "Generation Task expected input hash");
  const sourceBase = record(owner.sourceBase, "Generation Task expected Source Base");
  exactFields(sourceBase, ["commitHash", "treeHash"], "Generation Task expected Source Base");
  const sourceCommitHash = gitObjectId(
    sourceBase.commitHash,
    "Generation Task expected Source Base commit",
  );
  const sourceTreeHash = gitObjectId(
    sourceBase.treeHash,
    "Generation Task expected Source Base tree",
  );
  if (sourceCommitHash.length !== sourceTreeHash.length) {
    fail("Generation Task expected Source Base mixes Git object formats");
  }
  const candidateRetentionRef = text(
    owner.candidateRetentionRef,
    "Generation Task expected candidate retention ref",
    512,
  );
  const canonicalRetentionRef = generationTaskArtifactCandidateRetentionRef({
    workspaceId,
    taskId,
    attempt: Number(owner.attempt),
    inputHash,
  });
  if (candidateRetentionRef !== canonicalRetentionRef) {
    fail("Generation Task expected candidate retention ref is not canonical");
  }
  const contextPackHash = sha256(
    owner.contextPackHash,
    "Generation Task expected Context Pack hash",
  );
  const contextPackId = text(owner.contextPackId, "Generation Task expected Context Pack id", 512);
  if (contextPackId !== `context-pack-${contextPackHash}`) {
    fail("Generation Task expected Context Pack identity is not content-addressed");
  }
  const candidateCommitHash = gitObjectId(
    owner.candidateCommitHash,
    "Generation Task expected candidate commit",
  );
  const candidateTreeHash = gitObjectId(
    owner.candidateTreeHash,
    "Generation Task expected candidate tree",
  );
  if (candidateCommitHash.length !== candidateTreeHash.length) {
    fail("Generation Task expected candidate mixes Git object formats");
  }
  return {
    projectId: evidenceId(owner.projectId, "Generation Task expected Project id"),
    workspaceId,
    planId: evidenceId(owner.planId, "Generation Task expected Plan id"),
    taskId,
    attempt: Number(owner.attempt),
    attemptCreatedAt: Number(owner.attemptCreatedAt),
    inputHash,
    sourceBase: { commitHash: sourceCommitHash, treeHash: sourceTreeHash },
    candidateRetentionRef,
    candidateCommitHash,
    candidateTreeHash,
    contextPackId,
    contextPackHash,
  };
}

function evidenceOwner(
  value: unknown,
  expected: ExpectedEvidenceOwner | null,
): Record<string, unknown> {
  const owner = record(value, "Artifact visual evidence owner");
  exactFields(owner, [
    "projectId", "workspaceId", "planId", "taskId", "attempt",
    "candidateCommitHash", "candidateTreeHash", "contextPackId", "contextPackHash",
  ], "Artifact visual evidence owner");
  const projectId = evidenceId(owner.projectId, "Artifact visual evidence Project id");
  const workspaceId = evidenceId(owner.workspaceId, "Artifact visual evidence Workspace id");
  const planId = evidenceId(owner.planId, "Artifact visual evidence Plan id");
  const taskId = evidenceId(owner.taskId, "Artifact visual evidence Task id");
  if (!Number.isSafeInteger(owner.attempt) || Number(owner.attempt) < 1) {
    fail("Artifact visual evidence Attempt is invalid");
  }
  const candidateCommitHash = gitObjectId(owner.candidateCommitHash, "Artifact visual evidence commit");
  const candidateTreeHash = gitObjectId(owner.candidateTreeHash, "Artifact visual evidence tree");
  if (candidateCommitHash.length !== candidateTreeHash.length) {
    fail("Artifact visual evidence mixes Git object formats");
  }
  const contextPackHash = sha256(owner.contextPackHash, "Artifact visual evidence Context Pack hash");
  const contextPackId = text(owner.contextPackId, "Artifact visual evidence Context Pack id", 512);
  if (contextPackId !== `context-pack-${contextPackHash}`) {
    fail("Artifact visual evidence Context Pack identity is not content-addressed");
  }
  if (expected !== null && (projectId !== expected.projectId
    || workspaceId !== expected.workspaceId
    || planId !== expected.planId
    || taskId !== expected.taskId
    || Number(owner.attempt) !== expected.attempt
    || candidateCommitHash !== expected.candidateCommitHash
    || candidateTreeHash !== expected.candidateTreeHash
    || contextPackId !== expected.contextPackId
    || contextPackHash !== expected.contextPackHash)) {
    fail("Artifact visual evidence owner does not match the fenced Generation Task candidate");
  }
  return owner;
}

interface ArtifactRunManifestContext {
  owner: ExpectedEvidenceOwner;
  frames: readonly Record<string, unknown>[];
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
  requireSourceVisualEvidence: GenerationTaskSourceVisualEvidenceRequirement;
  round: number;
  candidateCommitHash: string;
  candidateTreeHash: string;
  passed: boolean;
  score: number;
}

function artifactRunEvaluationManifest(
  value: unknown,
  input: ArtifactRunManifestContext,
): Record<string, unknown> {
  const label = `Artifact run evaluation manifest ${input.round}`;
  const manifest = record(value, label);
  const hasRuntimeChecks = manifest.runtimeChecks !== undefined;
  const hasReviewSummary = manifest.reviewSummary !== undefined;
  const hasVisualEvidence = manifest.visualEvidence !== undefined;
  const hasSourceCaptureResult = manifest.sourceCaptureResult !== undefined;
  const hasSourceVisualEvidence = manifest.sourceVisualEvidence !== undefined;
  exactFields(manifest, [
    "protocol", "candidate", "round", "passed", "score", "qualityState",
    "findingsDigest", "frameResults",
    ...(hasRuntimeChecks ? ["runtimeChecks"] : []),
    ...(hasReviewSummary ? ["reviewSummary"] : []),
    ...(hasVisualEvidence ? ["visualEvidence"] : []),
    ...(hasSourceCaptureResult ? ["sourceCaptureResult"] : []),
    ...(hasSourceVisualEvidence ? ["sourceVisualEvidence"] : []),
  ], label);
  if ((input.requireRuntimeChecks && !hasRuntimeChecks)
    || (input.requireVisualReview && (!hasReviewSummary || !hasVisualEvidence))) {
    fail(`${label} omits evidence required by the immutable QA profile`);
  }
  const candidate = record(manifest.candidate, `${label} candidate`);
  exactFields(candidate, ["commitHash", "treeHash"], `${label} candidate`);
  const commitHash = gitObjectId(candidate.commitHash, `${label} candidate commit`);
  const treeHash = gitObjectId(candidate.treeHash, `${label} candidate tree`);
  sha256(manifest.findingsDigest, `${label} findings digest`);
  if (manifest.protocol !== "dezin.artifact-run-evaluation-manifest.v1"
    || manifest.round !== input.round
    || manifest.passed !== input.passed
    || manifest.score !== input.score
    || commitHash !== input.candidateCommitHash
    || treeHash !== input.candidateTreeHash
    || commitHash.length !== treeHash.length
    || (manifest.qualityState !== "passed"
      && manifest.qualityState !== "needs-attention"
      && manifest.qualityState !== "failed")
    || (input.passed ? manifest.qualityState === "failed" : manifest.qualityState !== "failed")) {
    fail(`${label} identity or outcome is invalid`);
  }

  const frameResults = array(manifest.frameResults, `${label} Frame results`);
  if (frameResults.length !== input.frames.length || frameResults.length > MAX_FRAME_COUNT) {
    fail(`${label} Frame results do not exactly cover the immutable Task Frames`);
  }
  const frameAttemptIds = new Set<string>();
  const frameIdentities = new Map<string, ReturnType<typeof captureIdentity>>();
  const normalizedFrameResults: Record<string, unknown>[] = [];
  for (let index = 0; index < frameResults.length; index += 1) {
    const result = record(frameResults[index], `${label} Frame result ${index}`);
    const hasCaptureIdentity = result.captureIdentity !== undefined;
    exactFields(result, [
      "frameId", "frameAttemptId", "width", "height", "status", "reviewed",
      ...(hasCaptureIdentity ? ["captureIdentity"] : []),
    ], `${label} Frame result ${index}`);
    const plannedFrame = input.frames[index]!;
    const frameId = renderFrameId(result.frameId, `${label} Frame result ${index} id`);
    const frameAttemptId = evidenceId(
      result.frameAttemptId,
      `${label} Frame result ${index} Attempt id`,
    );
    if (frameId !== plannedFrame.id || result.width !== plannedFrame.width
      || result.height !== plannedFrame.height
      || (result.status !== "passed" && result.status !== "failed")
      || typeof result.reviewed !== "boolean"
      || frameAttemptIds.has(frameAttemptId)
      || ((result.status === "passed" || result.reviewed === true) && !hasCaptureIdentity)) {
      fail(`${label} Frame result ${index} is invalid`);
    }
    frameAttemptIds.add(frameAttemptId);
    if (hasCaptureIdentity) {
      frameIdentities.set(frameId, captureIdentity(
        result.captureIdentity,
        `${label} Frame result ${index} PNG identity`,
        { width: Number(plannedFrame.width), height: Number(plannedFrame.height) },
      ));
    }
    normalizedFrameResults.push(result);
  }

  if (hasRuntimeChecks) {
    const runtimeChecks = array(manifest.runtimeChecks, `${label} runtime checks`);
    if (runtimeChecks.length !== input.frames.length) fail(`${label} runtime checks are incomplete`);
    for (let index = 0; index < runtimeChecks.length; index += 1) {
      const check = record(runtimeChecks[index], `${label} runtime check ${index}`);
      exactFields(check, ["id", "status"], `${label} runtime check ${index}`);
      const result = normalizedFrameResults[index]!;
      if (check.id !== `frame:${String(result.frameId)}` || check.status !== result.status) {
        fail(`${label} runtime check ${index} diverges from its Frame result`);
      }
    }
  }

  if (hasReviewSummary !== hasVisualEvidence) {
    fail(`${label} review summary and Frame descriptors must be retained together`);
  }
  let review: Record<string, unknown> | null = null;
  let summaries: unknown[] = [];
  let sourceSummary: unknown;
  if (hasReviewSummary) {
    review = record(manifest.reviewSummary, `${label} review summary`);
    const hasSourceSummary = review.sourceEvidence !== undefined;
    exactFields(review, [
      "status", "fidelity", "evidence", ...(hasSourceSummary ? ["sourceEvidence"] : []),
    ], `${label} review summary`);
    if ((review.status !== "passed" && review.status !== "failed")
      || typeof review.fidelity !== "number" || !Number.isFinite(review.fidelity)
      || review.fidelity < 0 || review.fidelity > 1
      || (input.passed && review.status !== "passed")) {
      fail(`${label} review summary is invalid`);
    }
    summaries = array(review.evidence, `${label} review Frame summaries`);
    if (summaries.length !== input.frames.length) fail(`${label} review Frame summaries are incomplete`);
    sourceSummary = hasSourceSummary ? review.sourceEvidence : undefined;
  }

  const storageKeys = new Set<string>();
  if (hasVisualEvidence) {
    const descriptors = array(manifest.visualEvidence, `${label} Frame descriptors`);
    if (descriptors.length !== input.frames.length) fail(`${label} Frame descriptors are incomplete`);
    for (let index = 0; index < descriptors.length; index += 1) {
      const plannedFrame = input.frames[index]!;
      const result = normalizedFrameResults[index]!;
      const summary = record(summaries[index], `${label} Frame review summary ${index}`);
      exactFields(summary, [
        "frameId", "frameAttemptId", "sha256", "byteLength", "storageKey",
      ], `${label} Frame review summary ${index}`);
      const frameId = renderFrameId(summary.frameId, `${label} Frame review summary ${index} id`);
      const frameAttemptId = evidenceId(
        summary.frameAttemptId,
        `${label} Frame review summary ${index} Attempt id`,
      );
      const checksum = sha256(summary.sha256, `${label} Frame review summary ${index} checksum`);
      if (!Number.isSafeInteger(summary.byteLength) || Number(summary.byteLength) < 1) {
        fail(`${label} Frame review summary ${index} byte length is invalid`);
      }
      const storageKey = text(summary.storageKey, `${label} Frame review summary ${index} storage key`, 4_096);
      const identity = frameIdentities.get(frameId);
      if (frameId !== plannedFrame.id || frameId !== result.frameId
        || frameAttemptId !== result.frameAttemptId || result.reviewed !== true
        || !identity || identity.sha256 !== checksum
        || identity.byteLength !== Number(summary.byteLength)
        || storageKeys.has(storageKey)) {
        fail(`${label} Frame review summary ${index} is inconsistent`);
      }
      storageKeys.add(storageKey);

      const descriptor = record(descriptors[index], `${label} Frame descriptor ${index}`);
      exactFields(descriptor, [
        "protocol", "owner", "frame", "round", "mediaType", "sha256", "byteLength", "storageKey",
      ], `${label} Frame descriptor ${index}`);
      evidenceOwner(descriptor.owner, input.owner);
      const descriptorFrame = record(descriptor.frame, `${label} Frame descriptor ${index} Frame`);
      if (!isDeepStrictEqual(descriptorFrame, { ...plannedFrame, frameAttemptId })) {
        fail(`${label} Frame descriptor ${index} diverges from the immutable Task Frame`);
      }
      const expectedStorageKey = [
        "generation-task-evidence",
        input.owner.projectId,
        input.owner.workspaceId,
        input.owner.planId,
        input.owner.taskId,
        `attempt-${input.owner.attempt}`,
        "visual",
        `round-${input.round}-${generationTaskVisualEvidenceFrameStorageSegment(frameId)}-${checksum}.png`,
      ].join("/");
      if (descriptor.protocol !== "dezin.generation-task-visual-evidence.v1"
        || descriptor.round !== input.round || descriptor.mediaType !== "image/png"
        || descriptor.sha256 !== checksum || descriptor.byteLength !== summary.byteLength
        || descriptor.storageKey !== storageKey || storageKey !== expectedStorageKey) {
        fail(`${label} Frame descriptor ${index} is inconsistent`);
      }
    }
  }

  const sourcePartCount = [
    hasSourceCaptureResult,
    hasSourceVisualEvidence,
    sourceSummary !== undefined,
  ].filter(Boolean).length;
  if ((requiresSourceVisualEvidence(input.requireSourceVisualEvidence) && sourcePartCount !== 3)
    || (input.requireSourceVisualEvidence === false && sourcePartCount !== 0)
    || (input.requireSourceVisualEvidence === null && sourcePartCount !== 0 && sourcePartCount !== 3)) {
    fail(`${label} source evidence is incomplete or unauthorized`);
  }
  if (sourcePartCount === 3) {
    const result = record(manifest.sourceCaptureResult, `${label} source capture result`);
    exactFields(result, [
      "scope", "sourceAttemptId", "width", "height", "status", "reviewed", "captureIdentity",
    ], `${label} source capture result`);
    const sourceAttemptId = evidenceId(result.sourceAttemptId, `${label} source Attempt id`);
    if (result.scope !== "source" || (result.status !== "passed" && result.status !== "failed")
      || result.reviewed !== true
      || !isExactRenderFrameCaptureViewport(result.width, result.height)
      || frameAttemptIds.has(sourceAttemptId)
      || (input.passed && result.status !== "passed")) {
      fail(`${label} source capture result is invalid`);
    }
    const identity = captureIdentity(result.captureIdentity, `${label} source PNG identity`, {
      width: Number(result.width),
      height: Number(result.height),
    });
    const summary = record(sourceSummary, `${label} source review summary`);
    exactFields(summary, [
      "scope", "sourceAttemptId", "width", "height", "sha256", "byteLength", "storageKey",
    ], `${label} source review summary`);
    const checksum = sha256(summary.sha256, `${label} source review checksum`);
    if (!Number.isSafeInteger(summary.byteLength) || Number(summary.byteLength) < 1) {
      fail(`${label} source review byte length is invalid`);
    }
    const storageKey = text(summary.storageKey, `${label} source review storage key`, 4_096);
    if (summary.scope !== "source" || summary.sourceAttemptId !== sourceAttemptId
      || summary.width !== result.width || summary.height !== result.height
      || identity.sha256 !== checksum || identity.byteLength !== Number(summary.byteLength)
      || storageKeys.has(storageKey)) {
      fail(`${label} source review summary is inconsistent`);
    }
    const descriptor = record(manifest.sourceVisualEvidence, `${label} source descriptor`);
    exactFields(descriptor, [
      "protocol", "owner", "capture", "sourceAuthority", "round", "mediaType", "sha256",
      "byteLength", "storageKey",
    ], `${label} source descriptor`);
    evidenceOwner(descriptor.owner, input.owner);
    const descriptorCapture = record(descriptor.capture, `${label} source descriptor capture`);
    if (!isDeepStrictEqual(descriptorCapture, {
      scope: "source",
      sourceAttemptId,
      width: Number(result.width),
      height: Number(result.height),
    })) fail(`${label} source descriptor capture is inconsistent`);
    const expectedStorageKey = [
      "generation-task-evidence",
      input.owner.projectId,
      input.owner.workspaceId,
      input.owner.planId,
      input.owner.taskId,
      `attempt-${input.owner.attempt}`,
      "visual",
      `round-${input.round}-source-${checksum}.png`,
    ].join("/");
    const descriptorAuthority = sourceVisualEvidenceAuthority(
      descriptor.sourceAuthority,
      `${label} source descriptor authority`,
    );
    if (descriptor.protocol !== "dezin.generation-task-source-visual-evidence.v1"
      || descriptor.round !== input.round || descriptor.mediaType !== "image/png"
      || descriptor.sha256 !== checksum || descriptor.byteLength !== summary.byteLength
      || descriptor.storageKey !== storageKey || storageKey !== expectedStorageKey
      || (requiresSourceVisualEvidence(input.requireSourceVisualEvidence)
        && !isDeepStrictEqual(descriptorAuthority, input.requireSourceVisualEvidence))) {
      fail(`${label} source descriptor is inconsistent`);
    }
  }
  if (input.passed && normalizedFrameResults.some((result) => result.status !== "passed")) {
    fail(`${label} passed outcome retains a failed Frame`);
  }
  return manifest;
}

function artifactRunQualityEvidence(
  value: unknown,
  expected: ExpectedEvidenceOwner | null,
  quality: ValidatedArtifactQuality,
  frames: readonly Record<string, unknown>[],
  requireRuntimeChecks: boolean,
  requireVisualReview: boolean,
  requireSourceVisualEvidence: GenerationTaskSourceVisualEvidenceRequirement,
): { evidence: Record<string, unknown>; owner: ExpectedEvidenceOwner | null } {
  const envelope = record(value, "Artifact candidate evidence");
  if (envelope.protocol !== "dezin.artifact-run.v1") {
    if (expected !== null && !Array.isArray(envelope.visualEvidence)) {
      fail("Fenced Artifact evidence requires an immutable run envelope or exact visual ownership");
    }
    return { evidence: envelope, owner: expected };
  }
  let envelopeBytes: number;
  try {
    envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  } catch {
    fail("Artifact run evidence could not be measured safely");
  }
  if (envelopeBytes > MAX_ARTIFACT_RUN_EVIDENCE_BYTES) {
    fail("Artifact run evidence exceeds its byte budget");
  }

  const qualityEvidence = record(envelope.qualityEvidence, "Artifact run quality evidence");
  const hasRuntimeChecks = qualityEvidence.runtimeChecks !== undefined;
  const hasVisualReview = qualityEvidence.visualReview !== undefined;
  exactFields(envelope, [
    ...(hasRuntimeChecks ? ["runtimeChecks"] : []),
    ...(hasVisualReview ? ["visualReview"] : []),
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
  ], "Artifact run evidence");
  const projectId = evidenceId(envelope.projectId, "Artifact run Project id");
  const taskId = evidenceId(envelope.taskId, "Artifact run Task id");
  const planId = evidenceId(envelope.planId, "Artifact run Plan id");
  const workspaceId = evidenceId(envelope.workspaceId, "Artifact run Workspace id");
  if (!Number.isSafeInteger(envelope.attempt) || Number(envelope.attempt) < 1
    || !Number.isSafeInteger(envelope.attemptCreatedAt) || Number(envelope.attemptCreatedAt) < 0) {
    fail("Artifact run Attempt identity is invalid");
  }
  const inputHash = sha256(envelope.inputHash, "Artifact run input hash");
  const contextPackHash = sha256(envelope.contextPackHash, "Artifact run Context Pack hash");
  const contextPackId = text(envelope.contextPackId, "Artifact run Context Pack id", 512);
  if (contextPackId !== `context-pack-${contextPackHash}`) {
    fail("Artifact run Context Pack identity is not content-addressed");
  }
  const sourceBase = record(envelope.sourceBase, "Artifact run Source Base");
  exactFields(sourceBase, ["commitHash", "treeHash"], "Artifact run Source Base");
  const sourceCommitHash = gitObjectId(sourceBase.commitHash, "Artifact run Source Base commit");
  const sourceTreeHash = gitObjectId(sourceBase.treeHash, "Artifact run Source Base tree");
  if (sourceCommitHash.length !== sourceTreeHash.length) {
    fail("Artifact run Source Base mixes Git object formats");
  }
  const candidateRetentionRef = text(
    envelope.candidateRetentionRef,
    "Artifact run candidate retention ref",
    512,
  );
  if (!/^refs\/dezin\/generation-attempts\/artifacts\/[0-9a-f]{64}$/.test(candidateRetentionRef)) {
    fail("Artifact run candidate retention ref is invalid");
  }
  if (!Number.isSafeInteger(envelope.selectedRound) || Number(envelope.selectedRound) < 0
    || !Array.isArray(envelope.versions) || envelope.versions.length === 0
    || envelope.versions.length > 256) {
    fail("Artifact run version history is invalid");
  }
  const selectedRound = Number(envelope.selectedRound);
  const candidate = record(qualityEvidence.candidate, "Artifact run selected candidate");
  const selectedCommitHash = gitObjectId(candidate.commitHash, "Artifact run selected candidate commit");
  const selectedTreeHash = gitObjectId(candidate.treeHash, "Artifact run selected candidate tree");
  let selectedVersion: Record<string, unknown> | null = null;
  let selectedManifest: Record<string, unknown> | null = null;
  for (let index = 0; index < envelope.versions.length; index += 1) {
    const version = record(envelope.versions[index], `Artifact run version ${index}`);
    exactFields(version, [
      "round", "commitHash", "treeHash", "passed", "score", "evaluationManifest",
    ],
      `Artifact run version ${index}`);
    const commitHash = gitObjectId(version.commitHash, `Artifact run version ${index} commit`);
    const treeHash = gitObjectId(version.treeHash, `Artifact run version ${index} tree`);
    if (commitHash.length !== treeHash.length
      || commitHash.length !== sourceCommitHash.length
      || treeHash.length !== sourceTreeHash.length
      || version.round !== index
      || typeof version.passed !== "boolean"
      || typeof version.score !== "number" || !Number.isFinite(version.score)
      || version.score < 0 || version.score > 100) {
      fail(`Artifact run version ${index} is invalid`);
    }
    const manifestOwner: ExpectedEvidenceOwner = {
      projectId,
      workspaceId,
      planId,
      taskId,
      attempt: Number(envelope.attempt),
      attemptCreatedAt: Number(envelope.attemptCreatedAt),
      inputHash,
      sourceBase: { commitHash: sourceCommitHash, treeHash: sourceTreeHash },
      candidateRetentionRef,
      candidateCommitHash: commitHash,
      candidateTreeHash: treeHash,
      contextPackId,
      contextPackHash,
    };
    const manifest = artifactRunEvaluationManifest(version.evaluationManifest, {
      owner: manifestOwner,
      frames,
      requireRuntimeChecks,
      requireVisualReview,
      requireSourceVisualEvidence,
      round: index,
      candidateCommitHash: commitHash,
      candidateTreeHash: treeHash,
      passed: version.passed,
      score: Number(version.score),
    });
    if (index === selectedRound) {
      selectedVersion = version;
      selectedManifest = manifest;
    }
  }
  if (selectedVersion === null || selectedManifest === null || selectedVersion.passed !== true
    || selectedVersion.commitHash !== selectedCommitHash
    || selectedVersion.treeHash !== selectedTreeHash
    || selectedVersion.score !== quality.score
    || qualityEvidence.round !== selectedRound
    || selectedManifest.qualityState !== quality.state
    || selectedManifest.findingsDigest !== quality.findingsDigest) {
    fail("Artifact run selected version does not match its quality evidence");
  }
  for (const [manifestField, qualityField] of [
    ["frameResults", "frameResults"],
    ["runtimeChecks", "runtimeChecks"],
    ["reviewSummary", "visualReview"],
    ["visualEvidence", "visualEvidence"],
    ["sourceCaptureResult", "sourceCaptureResult"],
    ["sourceVisualEvidence", "sourceVisualEvidence"],
  ] as const) {
    const manifestHasField = Object.hasOwn(selectedManifest, manifestField);
    const qualityHasField = Object.hasOwn(qualityEvidence, qualityField);
    if (manifestHasField !== qualityHasField
      || (manifestHasField
        && !isDeepStrictEqual(selectedManifest[manifestField], qualityEvidence[qualityField]))) {
      fail(`Artifact run selected evaluation manifest diverges from ${qualityField}`);
    }
  }
  if ((hasRuntimeChecks && !isDeepStrictEqual(envelope.runtimeChecks, qualityEvidence.runtimeChecks))
    || (hasVisualReview && !isDeepStrictEqual(envelope.visualReview, qualityEvidence.visualReview))) {
    fail("Artifact run quality summary diverges from its exact quality evidence");
  }
  if (expected !== null && (projectId !== expected.projectId
    || taskId !== expected.taskId
    || planId !== expected.planId
    || workspaceId !== expected.workspaceId
    || Number(envelope.attempt) !== expected.attempt
    || Number(envelope.attemptCreatedAt) !== expected.attemptCreatedAt
    || inputHash !== expected.inputHash
    || sourceCommitHash !== expected.sourceBase.commitHash
    || sourceTreeHash !== expected.sourceBase.treeHash
    || candidateRetentionRef !== expected.candidateRetentionRef
    || contextPackId !== expected.contextPackId
    || contextPackHash !== expected.contextPackHash
    || selectedCommitHash !== expected.candidateCommitHash
    || selectedTreeHash !== expected.candidateTreeHash)) {
    fail("Artifact run evidence does not match the fenced Generation Task candidate");
  }
  return {
    evidence: qualityEvidence,
    owner: {
      projectId,
      workspaceId,
      planId,
      taskId,
      attempt: Number(envelope.attempt),
      attemptCreatedAt: Number(envelope.attemptCreatedAt),
      inputHash,
      sourceBase: { commitHash: sourceCommitHash, treeHash: sourceTreeHash },
      candidateRetentionRef,
      candidateCommitHash: selectedCommitHash,
      candidateTreeHash: selectedTreeHash,
      contextPackId,
      contextPackHash,
    },
  };
}

function validateEvidence(value: unknown, input: {
  requireRuntimeChecks: boolean;
  requireVisualReview: boolean;
  requireSourceVisualEvidence: GenerationTaskSourceVisualEvidenceRequirement;
  frames: readonly Record<string, unknown>[];
  expectedOwner: ExpectedEvidenceOwner | null;
  quality: ValidatedArtifactQuality;
}): void {
  const unwrapped = artifactRunQualityEvidence(
    value,
    input.expectedOwner,
    input.quality,
    input.frames,
    input.requireRuntimeChecks,
    input.requireVisualReview,
    input.requireSourceVisualEvidence,
  );
  const evidence = unwrapped.evidence;
  const evidenceFence = unwrapped.owner;
  const baseFields = ["protocol", "candidate", "contextPack", "frames", "frameResults", "round"];
  const hasRuntimeChecks = evidence.runtimeChecks !== undefined;
  const hasVisualReview = evidence.visualReview !== undefined;
  const hasVisualEvidence = evidence.visualEvidence !== undefined;
  const hasSourceCaptureResult = evidence.sourceCaptureResult !== undefined;
  const hasSourceVisualEvidence = evidence.sourceVisualEvidence !== undefined;
  exactFields(evidence, [
    ...baseFields,
    ...(hasRuntimeChecks ? ["runtimeChecks"] : []),
    ...(hasVisualReview ? ["visualReview"] : []),
    ...(hasVisualEvidence ? ["visualEvidence"] : []),
    ...(hasSourceCaptureResult ? ["sourceCaptureResult"] : []),
    ...(hasSourceVisualEvidence ? ["sourceVisualEvidence"] : []),
  ], "Artifact candidate evidence");
  if (evidence.protocol !== "dezin.standard-artifact-quality.v1") {
    fail("Artifact candidate evidence protocol is invalid");
  }
  const candidate = record(evidence.candidate, "Artifact candidate evidence identity");
  exactFields(candidate, ["commitHash", "treeHash"], "Artifact candidate evidence identity");
  const candidateCommitHash = gitObjectId(candidate.commitHash, "Artifact candidate evidence commit");
  const candidateTreeHash = gitObjectId(candidate.treeHash, "Artifact candidate evidence tree");
  if (candidateCommitHash.length !== candidateTreeHash.length) {
    fail("Artifact candidate evidence mixes Git object formats");
  }
  const contextPack = record(evidence.contextPack, "Artifact candidate evidence Context Pack");
  exactFields(contextPack, ["id", "hash"], "Artifact candidate evidence Context Pack");
  const contextPackHash = sha256(contextPack.hash, "Artifact candidate evidence Context Pack hash");
  const contextPackId = text(contextPack.id, "Artifact candidate evidence Context Pack id", 512);
  if (contextPackId !== `context-pack-${contextPackHash}`) {
    fail("Artifact candidate evidence Context Pack identity is not content-addressed");
  }
  if (evidenceFence !== null && (candidateCommitHash !== evidenceFence.candidateCommitHash
    || candidateTreeHash !== evidenceFence.candidateTreeHash
    || contextPackId !== evidenceFence.contextPackId
    || contextPackHash !== evidenceFence.contextPackHash)) {
    fail("Artifact candidate evidence identity does not match its fenced candidate");
  }
  if (!Number.isSafeInteger(evidence.round) || Number(evidence.round) < 0) {
    fail("Artifact candidate evidence round is invalid");
  }
  if (!isDeepStrictEqual(evidence.frames, input.frames)) {
    fail("Artifact candidate evidence Frames diverge from the immutable Task plan");
  }

  const runtimeChecks = evidence.runtimeChecks;
  if (input.requireRuntimeChecks || runtimeChecks !== undefined) {
    if (!Array.isArray(runtimeChecks) || runtimeChecks.length !== input.frames.length) {
      fail("Artifact candidate requires one runtime check per immutable Task Frame");
    }
    const expectedIds = input.frames.map((frame) => `frame:${String(frame.id)}`);
    const ids: string[] = [];
    for (let index = 0; index < runtimeChecks.length; index += 1) {
      const check = runtimeChecks[index] as Record<string, unknown>;
      exactFields(check, ["id", "status"], `Artifact runtime check ${index}`);
      const id = text(check.id, `Artifact runtime check ${index} id`, 512);
      ids.push(id);
      if (check.status !== "passed") fail(`Artifact runtime check ${id} did not pass`);
    }
    if (!isDeepStrictEqual(ids, expectedIds)) {
      fail("Artifact runtime checks do not exactly cover the immutable Task Frames");
    }
  }

  const visualReview = evidence.visualReview;
  const reviewedFrameAttemptIds = new Map<string, string>();
  const reviewedFrameIdentities = new Map<string, { sha256: string; byteLength: number }>();
  if (input.requireVisualReview || requiresSourceVisualEvidence(input.requireSourceVisualEvidence)
    || visualReview !== undefined
    || hasSourceCaptureResult || hasSourceVisualEvidence) {
    if (visualReview === null || typeof visualReview !== "object" || Array.isArray(visualReview)) {
      fail("Artifact candidate requires visual-review evidence");
    }
    const review = visualReview as Record<string, unknown>;
    const hasSourceReviewEvidence = review.sourceEvidence !== undefined;
    exactFields(review, [
      "status", "fidelity", "evidence",
      ...(hasSourceReviewEvidence ? ["sourceEvidence"] : []),
    ], "Artifact visual review");
    if (review.status !== "passed") fail("Artifact visual review did not pass");
    if (typeof review.fidelity !== "number" || !Number.isFinite(review.fidelity)
      || review.fidelity < 0 || review.fidelity > 1) {
      fail("Artifact visual review fidelity must be between 0 and 1");
    }
    if (!Array.isArray(review.evidence) || review.evidence.length !== input.frames.length
      || !Array.isArray(evidence.visualEvidence)
      || evidence.visualEvidence.length !== input.frames.length) {
      fail("Artifact visual review requires one durable descriptor per immutable Task Frame");
    }
    const summaries = review.evidence as Array<Record<string, unknown>>;
    const descriptors = evidence.visualEvidence as Array<Record<string, unknown>>;
    const frameAttemptIds = new Set<string>();
    const storageKeys = new Set<string>();
    for (let index = 0; index < input.frames.length; index += 1) {
      const plannedFrame = input.frames[index]!;
      const summary = summaries[index]!;
      exactFields(summary, [
        "frameId", "frameAttemptId", "sha256", "byteLength", "storageKey",
      ], `Artifact visual review evidence ${index}`);
      const frameId = renderFrameId(summary.frameId, `Artifact visual review evidence ${index} Frame id`);
      const frameAttemptId = evidenceId(
        summary.frameAttemptId,
        `Artifact visual review evidence ${index} Frame Attempt id`,
      );
      const checksum = sha256(summary.sha256, `Artifact visual review evidence ${frameId} checksum`);
      if (!Number.isSafeInteger(summary.byteLength) || Number(summary.byteLength) < 1) {
        fail(`Artifact visual review evidence ${frameId} byte length is invalid`);
      }
      const key = text(summary.storageKey, `Artifact visual review evidence ${frameId} storage key`, 4_096);
      if (frameId !== plannedFrame.id || frameAttemptIds.has(frameAttemptId) || storageKeys.has(key)) {
        fail("Artifact visual review evidence does not uniquely cover the immutable Task Frames");
      }
      frameAttemptIds.add(frameAttemptId);
      storageKeys.add(key);
      reviewedFrameAttemptIds.set(frameId, frameAttemptId);
      reviewedFrameIdentities.set(frameId, {
        sha256: checksum,
        byteLength: Number(summary.byteLength),
      });

      const descriptor = descriptors[index]!;
      exactFields(descriptor, [
        "protocol", "owner", "frame", "round", "mediaType", "sha256", "byteLength", "storageKey",
      ], `Artifact visual evidence descriptor ${index}`);
      if (descriptor.protocol !== "dezin.generation-task-visual-evidence.v1"
        || descriptor.mediaType !== "image/png"
        || descriptor.round !== evidence.round
        || descriptor.sha256 !== checksum
        || descriptor.byteLength !== summary.byteLength
        || descriptor.storageKey !== key) {
        fail(`Artifact visual evidence descriptor ${frameId} does not match its review summary`);
      }
      const owner = evidenceOwner(descriptor.owner, evidenceFence);
      if (owner.candidateCommitHash !== candidateCommitHash
        || owner.candidateTreeHash !== candidateTreeHash
        || owner.contextPackId !== contextPackId
        || owner.contextPackHash !== contextPackHash) {
        fail(`Artifact visual evidence descriptor ${frameId} does not match its quality envelope`);
      }
      const descriptorFrame = record(descriptor.frame, `Artifact visual evidence descriptor ${frameId} Frame`);
      if (!isDeepStrictEqual(descriptorFrame, { ...plannedFrame, frameAttemptId })) {
        fail(`Artifact visual evidence descriptor ${frameId} does not match its immutable Task Frame`);
      }
      const expectedStorageKey = [
        "generation-task-evidence",
        owner.projectId,
        owner.workspaceId,
        owner.planId,
        owner.taskId,
        `attempt-${owner.attempt}`,
        "visual",
        `round-${String(evidence.round)}-${generationTaskVisualEvidenceFrameStorageSegment(frameId)}-${checksum}.png`,
      ].join("/");
      if (key !== expectedStorageKey) {
        fail(`Artifact visual evidence descriptor ${frameId} storage ownership is invalid`);
      }
    }

    const sourceEvidencePartCount = [
      hasSourceCaptureResult,
      hasSourceVisualEvidence,
      hasSourceReviewEvidence,
    ].filter(Boolean).length;
    if ((requiresSourceVisualEvidence(input.requireSourceVisualEvidence)
      && sourceEvidencePartCount !== 3)
      || (input.requireSourceVisualEvidence === false && sourceEvidencePartCount !== 0)
      || (input.requireSourceVisualEvidence === null
        && sourceEvidencePartCount !== 0 && sourceEvidencePartCount !== 3)) {
      fail("Artifact source visual evidence must include its exact capture, review, and descriptor");
    }
    if (sourceEvidencePartCount === 3) {
      const result = record(evidence.sourceCaptureResult, "Artifact source capture result");
      exactFields(result, [
        "scope", "sourceAttemptId", "width", "height", "status", "reviewed", "captureIdentity",
      ], "Artifact source capture result");
      const sourceAttemptId = evidenceId(
        result.sourceAttemptId,
        "Artifact source capture Attempt id",
      );
      if (result.scope !== "source" || result.status !== "passed" || result.reviewed !== true) {
        fail("Artifact source capture must be independently reviewed and passed");
      }
      if (!isExactRenderFrameCaptureViewport(result.width, result.height)) {
        fail("Artifact source capture dimensions are invalid");
      }
      if (frameAttemptIds.has(sourceAttemptId)) {
        fail("Artifact source capture Attempt identity collides with a Task Frame");
      }
      const sourceCapture = {
        scope: "source",
        sourceAttemptId,
        width: Number(result.width),
        height: Number(result.height),
      };
      const sourceCaptureIdentity = captureIdentity(
        result.captureIdentity,
        "Artifact source capture PNG identity",
        { width: sourceCapture.width, height: sourceCapture.height },
      );

      const sourceSummary = record(
        review.sourceEvidence,
        "Artifact source visual review evidence",
      );
      exactFields(sourceSummary, [
        "scope", "sourceAttemptId", "width", "height", "sha256", "byteLength", "storageKey",
      ], "Artifact source visual review evidence");
      const sourceChecksum = sha256(
        sourceSummary.sha256,
        "Artifact source visual review evidence checksum",
      );
      if (!Number.isSafeInteger(sourceSummary.byteLength) || Number(sourceSummary.byteLength) < 1) {
        fail("Artifact source visual review evidence byte length is invalid");
      }
      if (sourceCaptureIdentity.sha256 !== sourceChecksum
        || sourceCaptureIdentity.byteLength !== Number(sourceSummary.byteLength)) {
        fail("Artifact source capture PNG identity does not match its review summary");
      }
      const sourceStorageKey = text(
        sourceSummary.storageKey,
        "Artifact source visual review evidence storage key",
        4_096,
      );
      const summaryCapture = {
        scope: sourceSummary.scope,
        sourceAttemptId: sourceSummary.sourceAttemptId,
        width: sourceSummary.width,
        height: sourceSummary.height,
      };
      if (!isDeepStrictEqual(summaryCapture, sourceCapture)) {
        fail("Artifact source visual review evidence does not match its capture result");
      }

      const sourceDescriptor = record(
        evidence.sourceVisualEvidence,
        "Artifact source visual evidence descriptor",
      );
      exactFields(sourceDescriptor, [
        "protocol", "owner", "capture", "sourceAuthority", "round", "mediaType", "sha256",
        "byteLength", "storageKey",
      ], "Artifact source visual evidence descriptor");
      if (sourceDescriptor.protocol !== "dezin.generation-task-source-visual-evidence.v1"
        || sourceDescriptor.mediaType !== "image/png"
        || sourceDescriptor.round !== evidence.round
        || sourceDescriptor.sha256 !== sourceChecksum
        || sourceDescriptor.byteLength !== sourceSummary.byteLength
        || sourceDescriptor.storageKey !== sourceStorageKey) {
        fail("Artifact source visual evidence descriptor does not match its review summary");
      }
      const sourceOwner = evidenceOwner(sourceDescriptor.owner, evidenceFence);
      if (sourceOwner.candidateCommitHash !== candidateCommitHash
        || sourceOwner.candidateTreeHash !== candidateTreeHash
        || sourceOwner.contextPackId !== contextPackId
        || sourceOwner.contextPackHash !== contextPackHash) {
        fail("Artifact source visual evidence descriptor does not match its quality envelope");
      }
      const descriptorCapture = record(
        sourceDescriptor.capture,
        "Artifact source visual evidence descriptor capture",
      );
      exactFields(descriptorCapture, [
        "scope", "sourceAttemptId", "width", "height",
      ], "Artifact source visual evidence descriptor capture");
      if (!isDeepStrictEqual(descriptorCapture, sourceCapture)) {
        fail("Artifact source visual evidence descriptor does not match its capture result");
      }
      const descriptorAuthority = sourceVisualEvidenceAuthority(
        sourceDescriptor.sourceAuthority,
        "Artifact source visual evidence descriptor authority",
      );
      if (requiresSourceVisualEvidence(input.requireSourceVisualEvidence)
        && !isDeepStrictEqual(descriptorAuthority, input.requireSourceVisualEvidence)) {
        fail("Artifact source visual evidence descriptor does not match its exact source authority");
      }
      const expectedSourceStorageKey = [
        "generation-task-evidence",
        sourceOwner.projectId,
        sourceOwner.workspaceId,
        sourceOwner.planId,
        sourceOwner.taskId,
        `attempt-${sourceOwner.attempt}`,
        "visual",
        `round-${String(evidence.round)}-source-${sourceChecksum}.png`,
      ].join("/");
      if (sourceStorageKey !== expectedSourceStorageKey || storageKeys.has(sourceStorageKey)) {
        fail("Artifact source visual evidence storage ownership is invalid");
      }
    }
  } else if (hasVisualEvidence) {
    fail("Artifact visual evidence cannot exist without a visual review");
  }

  const frameResults = evidence.frameResults;
  if (!Array.isArray(frameResults)) fail("Artifact candidate Frame results must be an array");
  const requiresFrameResults = input.requireRuntimeChecks || input.requireVisualReview
    || hasRuntimeChecks || hasVisualReview;
  if (frameResults.length !== (requiresFrameResults ? input.frames.length : 0)) {
    fail("Artifact candidate Frame results do not exactly cover the evaluated Task Frames");
  }
  for (let index = 0; index < frameResults.length; index += 1) {
    const result = frameResults[index] as Record<string, unknown>;
    const hasCaptureIdentity = result.captureIdentity !== undefined;
    exactFields(result, [
      "frameId", "frameAttemptId", "width", "height", "status", "reviewed",
      ...(hasCaptureIdentity ? ["captureIdentity"] : []),
    ], `Artifact candidate Frame result ${index}`);
    const frame = input.frames[index]!;
    if (result.frameId !== frame.id || result.width !== frame.width || result.height !== frame.height
      || result.status !== "passed"
      || typeof result.reviewed !== "boolean"
      || (hasVisualReview && (result.reviewed !== true
        || result.frameAttemptId !== reviewedFrameAttemptIds.get(String(frame.id))
        || !hasCaptureIdentity))) {
      fail(`Artifact candidate Frame result ${index} does not match its immutable Task Frame`);
    }
    evidenceId(result.frameAttemptId, `Artifact candidate Frame result ${index} Attempt id`);
    if (hasCaptureIdentity) {
      const reviewedIdentity = reviewedFrameIdentities.get(String(frame.id));
      captureIdentity(result.captureIdentity, `Artifact candidate Frame result ${index} PNG identity`, {
        width: Number(frame.width),
        height: Number(frame.height),
        ...(reviewedIdentity ?? {}),
      });
    }
  }
}

export function validateGenerationTaskArtifactQualityGate(
  unsafeInput: GenerationTaskArtifactQualityGateInput,
): void {
  try {
    const input = record(unsafeInput, "Generation Task Artifact quality gate input");
    exactFields(input, [
      "requireSourceVisualEvidence", "qaProfile", "plannedFrames", "renderSpec", "quality",
      "evidence", "expectedEvidenceOwner",
    ],
      "Generation Task Artifact quality gate input");
    const sourceRequirement = sourceVisualEvidenceRequirement(input.requireSourceVisualEvidence);
    const profile = validateProfile(input.qaProfile);
    const frames = validateFrames({
      plannedFrames: input.plannedFrames,
      renderSpec: input.renderSpec,
      requiredFrameIds: profile.requiredFrameIds,
    });
    const quality = validateQuality(input.quality, profile.blockingSeverities);
    validateEvidence(input.evidence, {
      ...profile,
      requireSourceVisualEvidence: sourceRequirement,
      frames,
      quality,
      expectedOwner: expectedEvidenceOwner(input.expectedEvidenceOwner),
    });
  } catch (error) {
    if (error instanceof GenerationTaskQualityGateError) throw error;
    fail("Generation Task Artifact quality evidence could not be validated safely");
  }
}
