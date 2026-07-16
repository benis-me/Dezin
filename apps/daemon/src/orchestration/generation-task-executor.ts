import { isDeepStrictEqual } from "node:util";
import {
  GenerationTaskLeaseFenceError,
  normalizeCreateResourceRevisionCandidateInput,
  type CreateResourceRevisionCandidateInput,
  type GenerationTask,
  type GenerationTaskAttemptClaim,
  type GenerationTaskCapacityClass,
  type GenerationTaskFailureClass,
  type GenerationTaskKind,
} from "../../../../packages/core/src/index.ts";
import { validateGenerationTaskArtifactQualityGate } from "../../../../packages/core/src/generation-task-quality.ts";
import {
  classifyGenerationTaskError,
  GENERATION_TASK_FAILURE_CLASSES,
  reflectedGenerationTaskErrorString,
} from "./generation-task-failure.ts";
import { validateGenerationTaskPayload } from "./generation-task-contracts.ts";

export interface ArtifactPreparedCandidate {
  kind: "artifact-candidate";
  taskId: string;
  workspaceId: string;
  artifactId: string;
  trackId: string;
  sourceCommitHash: string;
  sourceTreeHash: string;
  renderSpec: Record<string, unknown>;
  quality: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

export interface ResourcePreparedCandidate {
  kind: "resource-candidate";
  taskId: string;
  workspaceId: string;
  resourceId: string;
  revision: CreateResourceRevisionCandidateInput;
  evidence: Record<string, unknown>;
}

export interface PrototypeValidationResult {
  kind: "snapshot-validation";
  taskId: string;
  workspaceId: string;
  snapshotId: string;
  graphRevision: number;
  artifactRevisionIds: string[];
  resourceRevisionIds: string[];
  evidence: Record<string, unknown>;
}

export type PreparedGenerationTaskResult =
  | ArtifactPreparedCandidate
  | ResourcePreparedCandidate
  | PrototypeValidationResult;

export interface ArtifactGenerationTaskLeafExecutor {
  execute(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<ArtifactPreparedCandidate>;
}

export interface ResourceGenerationTaskLeafExecutor {
  execute(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<ResourcePreparedCandidate>;
  /**
   * Best-effort storage reconciliation after every prepared-candidate outcome.
   * The implementation may delete only when the durable Store atomically proves
   * that neither candidate state nor a Resource Revision references the payload.
   */
  cleanupIfUnreferenced(
    claim: GenerationTaskAttemptClaim,
    candidate: ResourcePreparedCandidate,
  ): Promise<boolean>;
}

export interface PrototypeValidationTaskLeafExecutor {
  execute(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<PrototypeValidationResult>;
}

export interface GenerationTaskPublicationPort {
  publishPreparedResult(
    claim: GenerationTaskAttemptClaim,
    result: PreparedGenerationTaskResult,
    signal: AbortSignal,
  ): Promise<void>;
  publishRecordedCandidate(claim: GenerationTaskAttemptClaim, signal: AbortSignal): Promise<void>;
  publishCheckpoint(claim: GenerationTaskAttemptClaim, signal: AbortSignal): Promise<void>;
  finishFailure(claim: GenerationTaskAttemptClaim, failure: GenerationTaskExecutionFailure): Promise<void>;
}

export interface GenerationTaskExecutorOptions {
  readonly artifacts: ArtifactGenerationTaskLeafExecutor;
  readonly resources: ResourceGenerationTaskLeafExecutor;
  /** Adapter boundary for the exact immutable-Snapshot validator. */
  readonly prototypeValidation: PrototypeValidationTaskLeafExecutor;
  readonly publication: GenerationTaskPublicationPort;
  readonly reportError?: (error: unknown) => void;
}

export interface GenerationTaskExecutionFailure {
  failureClass: GenerationTaskFailureClass;
  error: Record<string, unknown>;
}

type GenerationTaskOwner = "artifact" | "resource" | "prototype-validation" | "checkpoint" | "task-13";

const TASK_EXECUTION_CONTRACT = {
  resource: { owner: "resource", requiresContext: true, publicationOnly: true },
  component: { owner: "artifact", requiresContext: true, publicationOnly: true },
  page: { owner: "artifact", requiresContext: true, publicationOnly: true },
  "prototype-validation": {
    owner: "prototype-validation",
    requiresContext: false,
    publicationOnly: false,
  },
  checkpoint: { owner: "checkpoint", requiresContext: false, publicationOnly: false },
  "propagation-candidate": { owner: "task-13", requiresContext: true, publicationOnly: false },
  "propagation-publish": { owner: "task-13", requiresContext: false, publicationOnly: false },
} as const satisfies Record<GenerationTaskKind, {
  owner: GenerationTaskOwner;
  requiresContext: boolean;
  publicationOnly: boolean;
}>;

const MAX_PERSISTED_ERROR_BYTES = 64 * 1024;
const MAX_PREPARED_EVIDENCE_BYTES = 1024 * 1024;
const MAX_CONTRACT_JSON_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

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

interface JsonBoundaryState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function canonicalJsonValue(
  value: unknown,
  label: string,
  state: JsonBoundaryState,
  depth = 0,
): unknown {
  state.nodes += 1;
  contract(state.nodes <= MAX_JSON_NODES && depth <= MAX_JSON_DEPTH,
    `${label} exceeds the JSON boundary budget`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    contract(isWellFormedUtf16(value), `${label} contains malformed Unicode`);
    return value;
  }
  if (typeof value === "number") {
    contract(Number.isFinite(value), `${label} numbers must be finite`);
    return value;
  }
  contract(typeof value === "object", `${label} must contain only JSON values`);
  contract(!state.ancestors.has(value), `${label} cannot contain cycles`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      contract(Object.getPrototypeOf(value) === Array.prototype, `${label} must be a plain array`);
      contract(Object.keys(descriptors).every((key) => key === "length" || /^\d+$/.test(key)),
        `${label} must be a dense data array`);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        contract(descriptor !== undefined && descriptor.enumerable && "value" in descriptor,
          `${label} must be a dense data array`);
        result.push(canonicalJsonValue(descriptor.value, `${label}[${index}]`, state, depth + 1));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    contract(prototype === Object.prototype || prototype === null, `${label} must be a plain object`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    contract(keys.every((key) => typeof key === "string"), `${label} cannot contain symbol fields`);
    const result: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      contract(key !== "__proto__" && key !== "prototype" && key !== "constructor",
        `${label} contains an unsafe field ${key}`);
      const descriptor = descriptors[key]!;
      contract(descriptor.enumerable && "value" in descriptor, `${label}.${key} must be data`);
      result[key] = canonicalJsonValue(descriptor.value, `${label}.${key}`, state, depth + 1);
    }
    return result;
  } catch (error) {
    if (error instanceof GenerationTaskExecutorContractError) throw error;
    throw new GenerationTaskExecutorContractError(`${label} could not be inspected safely`);
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalJsonRecord(value: unknown, label: string, maxBytes: number): Record<string, unknown> {
  const normalized = canonicalJsonValue(value, label, { ancestors: new WeakSet<object>(), nodes: 0 });
  contract(normalized !== null && typeof normalized === "object" && !Array.isArray(normalized),
    `${label} must be an object`);
  const encoded = JSON.stringify(normalized);
  contract(Buffer.byteLength(encoded, "utf8") <= maxBytes, `${label} exceeds its byte budget`);
  return normalized as Record<string, unknown>;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    return canonicalJsonRecord(value, label, MAX_PERSISTED_ERROR_BYTES);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : `${label} is invalid`);
  }
}

export class GenerationTaskExecutionError extends Error {
  readonly failureClass: GenerationTaskFailureClass;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(input: {
    failureClass: GenerationTaskFailureClass;
    message: string;
    details?: Record<string, unknown>;
  }) {
    if (!GENERATION_TASK_FAILURE_CLASSES.has(input.failureClass)) {
      throw new TypeError(`Unsupported Generation Task failure class: ${input.failureClass}`);
    }
    super(input.message);
    this.name = "GenerationTaskExecutionError";
    this.failureClass = input.failureClass;
    this.details = Object.freeze(jsonRecord(input.details ?? {}, "Generation Task failure details"));
  }
}

export class GenerationTaskExecutorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationTaskExecutorContractError";
  }
}

function contract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GenerationTaskExecutorContractError(message);
}

function freezeExecutionAuthority(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    contract(prototype === Object.prototype || prototype === Array.prototype || prototype === null,
      "Generation claim authority must contain only plain data");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    contract(Object.getOwnPropertySymbols(value).length === 0,
      "Generation claim authority cannot contain symbol fields");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === "length") continue;
      contract(descriptor.enumerable && "value" in descriptor,
        "Generation claim authority must contain only enumerable data fields");
      freezeExecutionAuthority(descriptor.value, seen);
    }
    Object.freeze(value);
  } catch (error) {
    if (error instanceof GenerationTaskExecutorContractError) throw error;
    throw new GenerationTaskExecutorContractError("Generation claim authority could not be frozen safely");
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = canonicalJsonRecord(value, label, MAX_CONTRACT_JSON_BYTES);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  contract(isDeepStrictEqual(actual, expected), `${label} payload fields are invalid`);
  return record;
}

function assertNever(value: never): never {
  throw new GenerationTaskExecutorContractError(`Unsupported Generation Task kind: ${String(value)}`);
}

const CAPACITY_SLOTS = {
  agent: 3,
  "render-qa": 2,
  image: 2,
} as const satisfies Record<GenerationTaskCapacityClass, number>;

function generationClaimKeyId(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function requiredWriterClaimKeys(task: GenerationTask): string[] {
  const workspaceKey = generationClaimKeyId(task.workspaceId);
  if (task.target.type === "artifact") {
    return [`writer:artifact:${workspaceKey}:${generationClaimKeyId(task.target.id)}`];
  }
  if (task.target.type === "resource") {
    return [`writer:resource:${workspaceKey}:${generationClaimKeyId(task.target.id)}`];
  }
  if (task.kind === "checkpoint") return [`writer:checkpoint:${workspaceKey}`];
  return [];
}

function validateExactClaimSet(claim: GenerationTaskAttemptClaim): void {
  const { task, attempt, lease, claims } = claim;
  contract(claims.length > 0, "Generation claim has no durable claims");
  const claimKeys = new Set<string>();
  const capacityClasses = new Map<GenerationTaskCapacityClass, number>();
  const writerKeys: string[] = [];
  for (const candidate of claims) {
    contract(!claimKeys.has(candidate.claimKey), "Generation claim contains a duplicate key");
    claimKeys.add(candidate.claimKey);
    contract(candidate.taskId === lease.taskId
      && candidate.planId === task.planId
      && candidate.workspaceId === lease.workspaceId
      && candidate.attempt === lease.attempt
      && candidate.ownerId === lease.ownerId
      && candidate.leaseToken === lease.leaseToken,
    "Generation claim durable claims are inconsistent");
    contract(candidate.leaseExpiresAt === attempt.leaseExpiresAt,
      "Generation claim expiry does not match its Attempt");
    contract(candidate.createdAt === attempt.startedAt,
      "Generation claim start does not match its Attempt");
    if (candidate.claimKind === "capacity") {
      const match = /^capacity:(agent|render-qa|image):([1-3])$/.exec(candidate.claimKey);
      contract(match !== null, "Generation capacity claim key is invalid");
      const capacityClass = match[1] as GenerationTaskCapacityClass;
      const slot = Number(match[2]);
      contract(slot >= 1 && slot <= CAPACITY_SLOTS[capacityClass],
        "Generation capacity claim slot is invalid");
      contract(!capacityClasses.has(capacityClass),
        `Generation claim contains duplicate ${capacityClass} capacity`);
      capacityClasses.set(capacityClass, slot);
    } else {
      contract(candidate.claimKind === "writer", "Generation claim kind is invalid");
      writerKeys.push(candidate.claimKey);
    }
  }
  const expectedCapacityClasses = [...task.resourceLimits.capacityClasses].sort();
  contract(new Set(expectedCapacityClasses).size === expectedCapacityClasses.length,
    "Generation Task requests duplicate capacity classes");
  contract(isDeepStrictEqual([...capacityClasses.keys()].sort(), expectedCapacityClasses),
    "Generation claim does not hold its exact capacity set");
  contract(isDeepStrictEqual(writerKeys.sort(), requiredWriterClaimKeys(task).sort()),
    "Generation claim does not hold its exact writer set");
  contract(claims.length === expectedCapacityClasses.length + requiredWriterClaimKeys(task).length,
    "Generation claim set contains extra claims");
}

function validateClaim(claim: GenerationTaskAttemptClaim): void {
  const { task, attempt, lease, claims } = claim;
  contract(task !== undefined, "Generation claim Task is missing");
  contract(task.status === "running" && attempt.status === "running", "Generation claim is not running");
  contract(task.id === attempt.taskId && task.id === lease.taskId, "Generation claim Task identity is inconsistent");
  contract(task.planId === attempt.planId, "Generation claim Plan identity is inconsistent");
  contract(task.workspaceId === attempt.workspaceId && task.workspaceId === lease.workspaceId,
    "Generation claim Workspace identity is inconsistent");
  contract(task.target.workspaceId === task.workspaceId,
    "Generation Task target belongs to a different Workspace");
  contract(task.target.type !== "workspace"
    || (task.target.id === task.workspaceId && task.target.workspaceId === task.workspaceId),
  "Generation Workspace target identity is inconsistent");
  contract(task.currentAttempt === attempt.attempt && task.currentAttempt === lease.attempt,
    "Generation claim Attempt identity is inconsistent");
  contract(isDeepStrictEqual(task.target, attempt.target), "Generation claim target is inconsistent");
  contract(isDeepStrictEqual(task.payload, attempt.payload), "Generation claim payload is inconsistent");
  contract(attempt.lease !== null && isDeepStrictEqual(attempt.lease, lease), "Generation claim lease is inconsistent");
  contract(attempt.startedAt !== null && attempt.heartbeatAt !== null && attempt.leaseExpiresAt !== null,
    "Generation claim Attempt lease times are incomplete");
  contract(Number.isSafeInteger(attempt.startedAt) && Number.isSafeInteger(attempt.heartbeatAt)
    && Number.isSafeInteger(attempt.leaseExpiresAt)
    && attempt.createdAt <= attempt.startedAt
    && attempt.startedAt <= attempt.heartbeatAt
    && attempt.heartbeatAt < attempt.leaseExpiresAt,
  "Generation claim Attempt lease times are incoherent");
  validateExactClaimSet(claim);
  const needsContext = TASK_EXECUTION_CONTRACT[task.kind].requiresContext;
  contract(needsContext ? attempt.contextPackId !== null : attempt.contextPackId === null,
    "Generation claim Context Pack does not match its Task kind");

  if (attempt.executionMode === "publication-only") {
    contract(TASK_EXECUTION_CONTRACT[task.kind].publicationOnly,
      "publication-only execution requires an Artifact or Resource Task");
    contract(attempt.candidateEvidence !== null && attempt.candidateEvidenceHash !== null,
      "publication-only execution requires recorded candidate evidence");
    contract(task.target.type === "artifact"
      ? attempt.candidateRevisionId !== null && attempt.candidateResourceRevisionId === null
      : attempt.candidateResourceRevisionId !== null && attempt.candidateRevisionId === null,
    "publication-only execution candidate does not match its target");
  } else {
    contract(attempt.candidateRevisionId === null
      && attempt.candidateResourceRevisionId === null
      && attempt.candidateEvidence === null
      && attempt.candidateEvidenceHash === null,
    "full execution cannot start with recorded candidate evidence");
  }
  validateGenerationTaskPayload(task);
}

function validatePreparedResult(
  claim: GenerationTaskAttemptClaim,
  result: PreparedGenerationTaskResult,
): PreparedGenerationTaskResult {
  const task = claim.task;
  const outputBudget = Math.min(task.resourceLimits.maxOutputBytes, MAX_CONTRACT_JSON_BYTES);
  if (task.kind === "page" || task.kind === "component") {
    const candidate = exactObject(result, [
      "kind",
      "taskId",
      "workspaceId",
      "artifactId",
      "trackId",
      "sourceCommitHash",
      "sourceTreeHash",
      "renderSpec",
      "quality",
      "evidence",
    ], "Artifact prepared result");
    contract(task.target.type === "artifact" && candidate.kind === "artifact-candidate",
      "Artifact Task returned the wrong prepared result kind");
    contract(candidate.taskId === task.id && candidate.workspaceId === task.workspaceId,
      "prepared result identity does not match its Task");
    contract(candidate.artifactId === task.target.id && candidate.trackId === task.target.trackId,
      "Artifact candidate target does not match its Task");
    contract(typeof candidate.sourceCommitHash === "string"
      && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(candidate.sourceCommitHash),
      "Artifact candidate commit hash is invalid");
    contract(typeof candidate.sourceTreeHash === "string"
      && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(candidate.sourceTreeHash),
      "Artifact candidate tree hash is invalid");
    const normalized: ArtifactPreparedCandidate = {
      kind: "artifact-candidate",
      taskId: task.id,
      workspaceId: task.workspaceId,
      artifactId: task.target.id,
      trackId: task.target.trackId,
      sourceCommitHash: candidate.sourceCommitHash,
      sourceTreeHash: candidate.sourceTreeHash,
      renderSpec: canonicalJsonRecord(candidate.renderSpec, "Artifact render spec", outputBudget),
      quality: canonicalJsonRecord(candidate.quality, "Artifact quality result", outputBudget),
      evidence: canonicalJsonRecord(
        candidate.evidence,
        "Artifact candidate evidence",
        Math.min(outputBudget, MAX_PREPARED_EVIDENCE_BYTES),
      ),
    };
    validateGenerationTaskArtifactQualityGate({
      qaProfile: task.qaProfile,
      plannedFrames: task.payload.responsiveFrames,
      renderSpec: normalized.renderSpec,
      quality: normalized.quality,
      evidence: normalized.evidence,
      expectedEvidenceOwner: null,
    });
    contract(Buffer.byteLength(JSON.stringify(normalized), "utf8") <= outputBudget,
      "Artifact prepared result exceeds its Task output budget");
    return normalized;
  }
  if (task.kind === "resource") {
    const candidate = exactObject(result, [
      "kind",
      "taskId",
      "workspaceId",
      "resourceId",
      "revision",
      "evidence",
    ], "Resource prepared result");
    contract(task.target.type === "resource" && candidate.kind === "resource-candidate",
      "Resource Task returned the wrong prepared result kind");
    contract(candidate.taskId === task.id && candidate.workspaceId === task.workspaceId,
      "prepared result identity does not match its Task");
    contract(candidate.resourceId === task.target.id, "Resource candidate target does not match its Task");
    const revision = normalizeCreateResourceRevisionCandidateInput(candidate.revision);
    contract(revision.parentRevisionId === claim.attempt.baseRevisionId,
      "Resource candidate parent does not match its immutable Attempt base");
    const normalized: ResourcePreparedCandidate = {
      kind: "resource-candidate",
      taskId: task.id,
      workspaceId: task.workspaceId,
      resourceId: task.target.id,
      revision,
      evidence: canonicalJsonRecord(
        candidate.evidence,
        "Resource candidate evidence",
        Math.min(outputBudget, MAX_PREPARED_EVIDENCE_BYTES),
      ),
    };
    contract(Buffer.byteLength(JSON.stringify(normalized), "utf8") <= outputBudget,
      "Resource prepared result exceeds its Task output budget");
    return normalized;
  }
  contract(task.kind === "prototype-validation",
    "Only prototype validation may return a Snapshot validation result");
  const validation = exactObject(result, [
    "kind",
    "taskId",
    "workspaceId",
    "snapshotId",
    "graphRevision",
    "artifactRevisionIds",
    "resourceRevisionIds",
    "evidence",
  ], "Prototype validation result");
  contract(validation.kind === "snapshot-validation",
    "Prototype validation returned the wrong prepared result kind");
  contract(validation.taskId === task.id && validation.workspaceId === task.workspaceId,
    "prepared result identity does not match its Task");
  contract(validation.snapshotId === claim.attempt.expectedSnapshotId,
    "Prototype validation result does not match its immutable Snapshot");
  contract(Number.isSafeInteger(validation.graphRevision) && Number(validation.graphRevision) >= 0,
    "Prototype validation graph revision must be a non-negative safe integer");
  const artifactRevisionIds = canonicalStringArray(validation.artifactRevisionIds,
    "Prototype validation Artifact Revision ids");
  const resourceRevisionIds = canonicalStringArray(validation.resourceRevisionIds,
    "Prototype validation Resource Revision ids");
  const expectedArtifactRevisionIds = claim.attempt.dependencyOutputs
    .flatMap((output) => output.resultRevisionId === null ? [] : [output.resultRevisionId])
    .sort();
  const expectedResourceRevisionIds = claim.attempt.dependencyOutputs
    .flatMap((output) => output.resultResourceRevisionId === null ? [] : [output.resultResourceRevisionId])
    .sort();
  contract(isDeepStrictEqual(artifactRevisionIds, expectedArtifactRevisionIds),
    "Prototype validation Artifact Revision set is not exact");
  contract(isDeepStrictEqual(resourceRevisionIds, expectedResourceRevisionIds),
    "Prototype validation Resource Revision set is not exact");
  const normalized: PrototypeValidationResult = {
    kind: "snapshot-validation",
    taskId: task.id,
    workspaceId: task.workspaceId,
    snapshotId: claim.attempt.expectedSnapshotId,
    graphRevision: Number(validation.graphRevision),
    artifactRevisionIds,
    resourceRevisionIds,
    evidence: canonicalJsonRecord(
      validation.evidence,
      "Prototype validation evidence",
      Math.min(outputBudget, MAX_PREPARED_EVIDENCE_BYTES),
    ),
  };
  contract(Buffer.byteLength(JSON.stringify(normalized), "utf8") <= outputBudget,
    "Prototype validation result exceeds its Task output budget");
  return normalized;
}

function canonicalStringArray(value: unknown, label: string): string[] {
  const normalized = canonicalJsonValue(value, label, { ancestors: new WeakSet<object>(), nodes: 0 });
  contract(Array.isArray(normalized), `${label} must be an array`);
  contract(normalized.every((entry) => typeof entry === "string" && entry.length > 0),
    `${label} must contain non-empty strings`);
  const values = normalized as string[];
  const sorted = [...values].sort();
  contract(new Set(values).size === values.length && isDeepStrictEqual(values, sorted),
    `${label} must be a unique canonical set`);
  return values;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Generation Task execution aborted", "AbortError");
}

function reflectedString(value: unknown, key: string): string | null {
  return reflectedGenerationTaskErrorString(value, key);
}

function reflectedValue(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

function classifiedFailureClass(error: unknown): GenerationTaskFailureClass {
  return classifyGenerationTaskError(error);
}

function isLeaseFenceError(error: unknown): error is GenerationTaskLeaseFenceError {
  try {
    return error instanceof GenerationTaskLeaseFenceError;
  } catch {
    return false;
  }
}

function safeErrorText(error: unknown): string {
  const reflected = reflectedString(error, "message");
  if (reflected !== null) return reflected.slice(0, 4_096);
  try {
    return String(error).slice(0, 4_096);
  } catch {
    return "Unknown Generation Task execution failure";
  }
}

function safeContextFailureRefs(value: unknown): string[] | null {
  try {
    const normalized = canonicalJsonValue(
      value,
      "Generation Task missing Context refs",
      { ancestors: new WeakSet<object>(), nodes: 0 },
    );
    if (!Array.isArray(normalized)
      || !normalized.every((entry) => typeof entry === "string")) {
      return null;
    }
    return normalized.slice(0, 256).map((entry) => entry.slice(0, 2_000));
  } catch {
    return null;
  }
}

function serializeExecutionFailure(error: unknown): GenerationTaskExecutionFailure {
  const failureClass = classifiedFailureClass(error);
  const name = reflectedString(error, "name") || "Error";
  const code = reflectedString(error, "code");
  const missing = reflectedValue(error, "missing");
  const details = reflectedValue(error, "details");
  const payload: Record<string, unknown> = {
    name: name.slice(0, 256),
    message: safeErrorText(error),
    ...(code === null ? {} : { code: code.slice(0, 256) }),
  };
  const contextRefs = failureClass === "context" ? safeContextFailureRefs(missing) : null;
  if (contextRefs !== null) {
    payload.refs = contextRefs;
  }
  if (details !== undefined) {
    try {
      payload.details = canonicalJsonRecord(details, "Generation Task failure details", 48 * 1024);
    } catch {
      // A malformed optional detail object must not prevent the durable failure transition.
    }
  }
  try {
    return { failureClass, error: jsonRecord(payload, "Generation Task execution failure") };
  } catch {
    return {
      failureClass,
      error: { name: "Error", message: "Generation Task failure metadata exceeded its safe boundary" },
    };
  }
}

/**
 * Exhaustive application-level dispatcher for one exact durable claim.
 * Leaf executors prepare isolated output; only the publication port may commit
 * candidate/task state. Publication errors are never reclassified because the
 * transaction may have committed before its response was lost.
 */
export class GenerationTaskExecutor {
  private readonly options: GenerationTaskExecutorOptions;

  constructor(options: GenerationTaskExecutorOptions) {
    // Pin adapter ownership at composition time. Mutating the caller's options
    // object must never redirect an already-admitted durable claim.
    this.options = Object.freeze({
      artifacts: options.artifacts,
      resources: options.resources,
      prototypeValidation: options.prototypeValidation,
      publication: options.publication,
      reportError: options.reportError,
    });
  }

  async execute(claim: GenerationTaskAttemptClaim, signal: AbortSignal): Promise<void> {
    validateClaim(claim);
    freezeExecutionAuthority(claim);
    if (signal.aborted) throw abortReason(signal);

    if (claim.attempt.executionMode === "publication-only") {
      await this.options.publication.publishRecordedCandidate(claim, signal);
      return;
    }
    if (claim.task.kind === "checkpoint") {
      await this.options.publication.publishCheckpoint(claim, signal);
      return;
    }

    let result: PreparedGenerationTaskResult;
    let normalizedResult: PreparedGenerationTaskResult;
    let resourceCandidate: ResourcePreparedCandidate | null = null;
    try {
      switch (claim.task.kind) {
        case "page":
        case "component":
          result = await this.options.artifacts.execute(claim, signal);
          break;
        case "resource":
          result = await this.options.resources.execute(claim, signal);
          resourceCandidate = result;
          break;
        case "prototype-validation":
          result = await this.options.prototypeValidation.execute(claim, signal);
          break;
        case "propagation-candidate":
        case "propagation-publish":
          throw new GenerationTaskExecutorContractError(
            `Generation Task kind ${claim.task.kind} is reserved for Task 13`,
          );
        default:
          return assertNever(claim.task.kind);
      }
      if (signal.aborted) throw abortReason(signal);
      normalizedResult = validatePreparedResult(claim, result);
    } catch (error) {
      await this.cleanupResourceCandidate(claim, resourceCandidate);
      if (signal.aborted) throw abortReason(signal);
      if (isLeaseFenceError(error)) throw error;
      await this.options.publication.finishFailure(claim, serializeExecutionFailure(error));
      return;
    }

    try {
      await this.options.publication.publishPreparedResult(claim, normalizedResult, signal);
    } finally {
      await this.cleanupResourceCandidate(claim, resourceCandidate);
    }
  }

  private async cleanupResourceCandidate(
    claim: GenerationTaskAttemptClaim,
    candidate: ResourcePreparedCandidate | null,
  ): Promise<void> {
    if (candidate === null) return;
    try {
      await this.options.resources.cleanupIfUnreferenced(claim, candidate);
    } catch (error) {
      // The receipt remains a durable orphan journal for startup recovery. A
      // cleanup observer must never mask a publication response-loss boundary
      // or prevent the exact fenced failure transition.
      try {
        this.options.reportError?.(error);
      } catch {
        // Observational only.
      }
    }
  }
}
