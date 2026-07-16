import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_FRAME_COUNT = 64;
const MAX_FRAME_DIMENSION = 16_384;
const MAX_FRAME_PIXELS = 268_435_456;

export interface GenerationTaskArtifactQualityGateInput {
  qaProfile: unknown;
  plannedFrames: unknown;
  renderSpec: unknown;
  quality: unknown;
  evidence: unknown;
  /** Core supplies this fence; daemon-only preflight may pass null. */
  expectedEvidenceOwner: unknown;
}

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

function validateFrame(value: unknown, index: number): Record<string, unknown> {
  const frame = value as Record<string, unknown>;
  const allowed = new Set(["id", "name", "width", "height", "initialState", "fixture", "background"]);
  if (Object.keys(frame).some((key) => !allowed.has(key))) {
    fail(`Artifact RenderSpec Frame ${index} contains unsupported fields`);
  }
  const id = text(frame.id, `Artifact RenderSpec Frame ${index} id`, 256);
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
    || (frame.width as number) < 1 || (frame.height as number) < 1
    || (frame.width as number) > MAX_FRAME_DIMENSION || (frame.height as number) > MAX_FRAME_DIMENSION
    || (frame.width as number) * (frame.height as number) > MAX_FRAME_PIXELS) {
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

function validateQuality(
  value: unknown,
  blockingSeverities: readonly string[],
): number {
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
  return quality.score;
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

function artifactRunQualityEvidence(
  value: unknown,
  expected: ExpectedEvidenceOwner | null,
  qualityScore: number,
): { evidence: Record<string, unknown>; owner: ExpectedEvidenceOwner | null } {
  const envelope = record(value, "Artifact candidate evidence");
  if (envelope.protocol !== "dezin.artifact-run.v1") {
    if (expected !== null && !Array.isArray(envelope.visualEvidence)) {
      fail("Fenced Artifact evidence requires an immutable run envelope or exact visual ownership");
    }
    return { evidence: envelope, owner: expected };
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
    || envelope.versions.length > 1_000) {
    fail("Artifact run version history is invalid");
  }
  const selectedRound = Number(envelope.selectedRound);
  const candidate = record(qualityEvidence.candidate, "Artifact run selected candidate");
  const selectedCommitHash = gitObjectId(candidate.commitHash, "Artifact run selected candidate commit");
  const selectedTreeHash = gitObjectId(candidate.treeHash, "Artifact run selected candidate tree");
  let selectedVersion: Record<string, unknown> | null = null;
  for (let index = 0; index < envelope.versions.length; index += 1) {
    const version = envelope.versions[index] as Record<string, unknown>;
    exactFields(version, ["round", "commitHash", "treeHash", "passed", "score"],
      `Artifact run version ${index}`);
    const commitHash = gitObjectId(version.commitHash, `Artifact run version ${index} commit`);
    const treeHash = gitObjectId(version.treeHash, `Artifact run version ${index} tree`);
    if (commitHash.length !== treeHash.length || version.round !== index
      || typeof version.passed !== "boolean"
      || typeof version.score !== "number" || !Number.isFinite(version.score)
      || version.score < 0 || version.score > 100) {
      fail(`Artifact run version ${index} is invalid`);
    }
    if (index === selectedRound) selectedVersion = version;
  }
  if (selectedVersion === null || selectedVersion.passed !== true
    || selectedVersion.commitHash !== selectedCommitHash
    || selectedVersion.treeHash !== selectedTreeHash
    || selectedVersion.score !== qualityScore
    || qualityEvidence.round !== selectedRound) {
    fail("Artifact run selected version does not match its quality evidence");
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
  frames: readonly Record<string, unknown>[];
  expectedOwner: ExpectedEvidenceOwner | null;
  qualityScore: number;
}): void {
  const unwrapped = artifactRunQualityEvidence(value, input.expectedOwner, input.qualityScore);
  const evidence = unwrapped.evidence;
  const evidenceFence = unwrapped.owner;
  const baseFields = ["protocol", "candidate", "contextPack", "frames", "frameResults", "round"];
  const hasRuntimeChecks = evidence.runtimeChecks !== undefined;
  const hasVisualReview = evidence.visualReview !== undefined;
  const hasVisualEvidence = evidence.visualEvidence !== undefined;
  exactFields(evidence, [
    ...baseFields,
    ...(hasRuntimeChecks ? ["runtimeChecks"] : []),
    ...(hasVisualReview ? ["visualReview"] : []),
    ...(hasVisualEvidence ? ["visualEvidence"] : []),
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
  if (input.requireVisualReview || visualReview !== undefined) {
    if (visualReview === null || typeof visualReview !== "object" || Array.isArray(visualReview)) {
      fail("Artifact candidate requires visual-review evidence");
    }
    const review = visualReview as Record<string, unknown>;
    exactFields(review, ["status", "fidelity", "evidence"], "Artifact visual review");
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
      const frameId = evidenceId(summary.frameId, `Artifact visual review evidence ${index} Frame id`);
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
        `round-${String(evidence.round)}-${frameId}-${checksum}.png`,
      ].join("/");
      if (key !== expectedStorageKey) {
        fail(`Artifact visual evidence descriptor ${frameId} storage ownership is invalid`);
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
    exactFields(result, [
      "frameId", "frameAttemptId", "width", "height", "status", "reviewed",
    ], `Artifact candidate Frame result ${index}`);
    const frame = input.frames[index]!;
    if (result.frameId !== frame.id || result.width !== frame.width || result.height !== frame.height
      || result.status !== "passed"
      || typeof result.reviewed !== "boolean"
      || (hasVisualReview && (result.reviewed !== true
        || result.frameAttemptId !== reviewedFrameAttemptIds.get(String(frame.id))))) {
      fail(`Artifact candidate Frame result ${index} does not match its immutable Task Frame`);
    }
    evidenceId(result.frameAttemptId, `Artifact candidate Frame result ${index} Attempt id`);
  }
}

export function validateGenerationTaskArtifactQualityGate(
  unsafeInput: GenerationTaskArtifactQualityGateInput,
): void {
  try {
    const input = record(unsafeInput, "Generation Task Artifact quality gate input");
    exactFields(input, [
      "qaProfile", "plannedFrames", "renderSpec", "quality", "evidence", "expectedEvidenceOwner",
    ],
      "Generation Task Artifact quality gate input");
    const profile = validateProfile(input.qaProfile);
    const frames = validateFrames({
      plannedFrames: input.plannedFrames,
      renderSpec: input.renderSpec,
      requiredFrameIds: profile.requiredFrameIds,
    });
    const qualityScore = validateQuality(input.quality, profile.blockingSeverities);
    validateEvidence(input.evidence, {
      ...profile,
      frames,
      qualityScore,
      expectedOwner: expectedEvidenceOwner(input.expectedEvidenceOwner),
    });
  } catch (error) {
    if (error instanceof GenerationTaskQualityGateError) throw error;
    fail("Generation Task Artifact quality evidence could not be validated safely");
  }
}
