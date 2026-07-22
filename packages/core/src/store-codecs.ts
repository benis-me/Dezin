import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import type {
  Artifact,
  Conversation,
  Effect,
  EffectParamDefinition,
  EffectPreset,
  ExtensionCredentialRecord,
  ExtensionScope,
  Message,
  MessageRole,
  Moodboard,
  MoodboardAsset,
  MoodboardConversation,
  MoodboardMessage,
  MoodboardNode,
  Project,
  QualityFinding,
  Run,
  RunFeedback,
  RunStatus,
  Variant,
} from "./types.ts";
import {
  compareBinary,
  isWellFormedUtf16,
  WorkspaceStoreCodecError,
} from "./workspace-codecs.ts";
import type {
  ArtifactQualityProfile,
  ComponentInstanceDependencyStatus,
  DesignNodeLocator,
  GenerationTaskAttempt,
  GenerationTaskAttemptComponentPin,
  GenerationTaskAttemptComponentPinInput,
  GenerationTaskAttemptDependencyOutput,
  GenerationTaskAttemptDependencyOutputInput,
  GenerationTaskAttemptHashInput,
  GenerationTaskAttemptInput,
  GenerationTaskAttemptLease,
  GenerationTaskAttemptResourcePin,
  GenerationTaskAttemptResourcePinInput,
  GenerationTaskAttemptStatus,
  GenerationTaskArtifactCandidateInput,
  GenerationTaskResourceCandidateInput,
  GenerationTaskCapacityClass,
  GenerationTaskCapacityClaimKey,
  GenerationTaskCandidateEvidenceHashInput,
  GenerationTaskClaim,
  GenerationTaskClaimKey,
  GenerationTaskIntent,
  GenerationTaskIntentInput,
  GenerationTaskKind,
  GenerationTaskMaterializationFailure,
  GenerationTask,
  GenerationTaskDependency,
  GenerationTaskFailureClass,
  CompleteGenerationTaskValidationInput,
  FinishGenerationTaskAttemptFailureInput,
  GenerationTaskResourceLimits,
  GenerationTaskRetryContextPolicy,
  GenerationTaskStatus,
  GenerationTaskTarget,
  GenerationTaskWriterClaimKey,
  HeartbeatGenerationTaskAttemptInput,
  GenerationPlanEvent,
  GenerationPlanEventType,
  ListGenerationPlanEventsInput,
  RecordGenerationTaskMaterializationFailureInput,
  PublishGenerationTaskCandidateInput,
  PublishGenerationPlanCheckpointInput,
  AnyStageGenerationTaskCandidateInput,
  StageGenerationTaskCandidateInput,
  TryClaimGenerationTaskAttemptInput,
} from "./workspace-types.ts";

export type Row = Record<string, unknown>;

const GENERATION_TASK_KINDS = new Set<GenerationTaskKind>([
  "resource",
  "component",
  "page",
  "prototype-validation",
  "checkpoint",
  "propagation-candidate",
  "propagation-publish",
]);
const GENERATION_CAPACITY_CLASSES = new Set<GenerationTaskCapacityClass>([
  "agent",
  "render-qa",
  "image",
]);
const GENERATION_TASK_STATUSES = new Set<GenerationTaskStatus>([
  "materialization-pending",
  "retry-wait",
  "blocked-context",
  "queued",
  "running",
  "candidate-ready",
  "needs-rebase",
  "awaiting-context-refresh",
  "cancel-requested",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);
const GENERATION_TASK_ATTEMPT_STATUSES = new Set<GenerationTaskAttemptStatus>([
  "queued",
  "running",
  "cancel-requested",
  "candidate-ready",
  "succeeded",
  "retryable-failed",
  "failed",
  "needs-rebase",
  "cancelled",
]);
const GENERATION_FAILURE_CLASSES = new Set<GenerationTaskFailureClass>([
  "context",
  "adapter",
  "storage",
  "provider",
  "agent-transport",
  "build-infrastructure",
  "design",
  "build",
  "qa",
  "publication-conflict",
  "cancelled",
  "unknown",
]);
const GENERATION_PLAN_EVENT_TYPES = new Set<GenerationPlanEventType>([
  "plan-queued",
  "plan-compile-failed",
  "plan-cancel-requested",
  "task-materialization-failed",
  "task-blocked-context",
  "task-materialized",
  "task-running",
  "task-candidate-ready",
  "task-needs-rebase",
  "task-rebase-disposition",
  "task-retry-requested",
  "task-retry-wait",
  "task-succeeded",
  "task-failed",
  "task-blocked",
  "task-cancel-requested",
  "task-cancelled",
  "plan-succeeded",
  "plan-failed",
  "plan-cancelled",
]);
const GENERATION_JSON_MAX_DEPTH = 64;
const GENERATION_JSON_MAX_NODES = 100_000;
const GENERATION_TASK_MAX_LEASE_MS = 300_000;
const GENERATION_CAPACITY_CLAIM_KEYS = new Set<GenerationTaskCapacityClaimKey>([
  "capacity:agent:1",
  "capacity:agent:2",
  "capacity:agent:3",
  "capacity:render-qa:1",
  "capacity:render-qa:2",
  "capacity:image:1",
  "capacity:image:2",
]);

function generationRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be a non-proxy plain object`);
  }
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new WorkspaceStoreCodecError(`${label} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceStoreCodecError(`${label} must be a plain object`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new WorkspaceStoreCodecError(`${label} cannot contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new WorkspaceStoreCodecError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function generationArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be a non-proxy array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new WorkspaceStoreCodecError(`${label} must use the standard array prototype`);
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new WorkspaceStoreCodecError(`${label} has an invalid length`);
  }
  const length = lengthDescriptor.value as number;
  for (const key of keys) {
    if (typeof key !== "string") throw new WorkspaceStoreCodecError(`${label} cannot contain symbol fields`);
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= length) {
      throw new WorkspaceStoreCodecError(`${label} has unexpected field ${key}`);
    }
  }
  const output = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new WorkspaceStoreCodecError(`${label} must contain dense enumerable data`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function generationAllowFields(input: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new WorkspaceStoreCodecError(`${label} contains unsupported field ${field}`);
  }
}

function generationCanonicalString(value: unknown, label: string): string {
  if (typeof value !== "string" || !isWellFormedUtf16(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be a well-formed string`);
  }
  const normalized = value.trim();
  if (!normalized) throw new WorkspaceStoreCodecError(`${label} must be non-empty`);
  return normalized;
}

function generationGitObjectId(value: unknown, label: string): string {
  const objectId = generationExactString(value, label);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
    throw new WorkspaceStoreCodecError(`${label} must be a lowercase 40- or 64-character git object id`);
  }
  return objectId;
}

function generationExactString(value: unknown, label: string): string {
  const normalized = generationCanonicalString(value, label);
  if (normalized !== value) throw new WorkspaceStoreCodecError(`${label} must be canonical`);
  return normalized;
}

function generationSafeInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new WorkspaceStoreCodecError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

interface GenerationJsonState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function generationCanonicalJson(
  value: unknown,
  label: string,
  state: GenerationJsonState = { ancestors: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > GENERATION_JSON_MAX_NODES || depth > GENERATION_JSON_MAX_DEPTH) {
    throw new WorkspaceStoreCodecError(`${label} exceeds the JSON boundary budget`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!isWellFormedUtf16(value)) throw new WorkspaceStoreCodecError(`${label} contains malformed Unicode`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkspaceStoreCodecError(`${label} numbers must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new WorkspaceStoreCodecError(`${label} must contain only JSON values`);
  if (nodeUtilTypes.isProxy(value)) throw new WorkspaceStoreCodecError(`${label} cannot contain proxies`);
  if (state.ancestors.has(value)) throw new WorkspaceStoreCodecError(`${label} cannot contain cycles`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return generationArray(value, label).map((entry, index) => (
        generationCanonicalJson(entry, `${label}[${index}]`, state, depth + 1)
      ));
    }
    const input = generationRecord(value, label);
    const output: Record<string, unknown> = {};
    const keys = Object.keys(input).sort(compareBinary);
    for (const key of keys) {
      if (!isWellFormedUtf16(key)) throw new WorkspaceStoreCodecError(`${label} contains malformed keys`);
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new WorkspaceStoreCodecError(`${label} contains unsafe field ${key}`);
      }
      output[key] = generationCanonicalJson(input[key], `${label}.${key}`, state, depth + 1);
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function generationCanonicalObject(value: unknown, label: string): Record<string, unknown> {
  const normalized = generationCanonicalJson(value, label);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new WorkspaceStoreCodecError(`${label} must be a JSON object`);
  }
  return normalized as Record<string, unknown>;
}

function generationCanonicalJsonText(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new WorkspaceStoreCodecError(`${label} must be JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new WorkspaceStoreCodecError(`${label} must contain valid JSON`);
  }
  const canonical = generationCanonicalJson(parsed, label);
  if (JSON.stringify(canonical) !== value) {
    throw new WorkspaceStoreCodecError(`${label} must use canonical JSON encoding`);
  }
  return canonical;
}

function generationCanonicalObjectText(value: unknown, label: string): Record<string, unknown> {
  const parsed = generationCanonicalJsonText(value, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceStoreCodecError(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function generationCanonicalArrayText(value: unknown, label: string): unknown[] {
  const parsed = generationCanonicalJsonText(value, label);
  if (!Array.isArray(parsed)) throw new WorkspaceStoreCodecError(`${label} must contain a JSON array`);
  return parsed;
}

function generationUniqueStrings(value: unknown, label: string): string[] {
  const normalized = generationArray(value, label).map((entry, index) => (
    generationCanonicalString(entry, `${label}[${index}]`)
  ));
  normalized.sort(compareBinary);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      throw new WorkspaceStoreCodecError(`${label} must not contain duplicates`);
    }
  }
  return normalized;
}

function normalizeGenerationTaskTarget(value: unknown): GenerationTaskTarget {
  const input = generationRecord(value, "Generation Task target");
  if (input.type === "artifact") {
    generationAllowFields(input, ["type", "workspaceId", "id", "trackId"], "Generation Task Artifact target");
    return {
      type: input.type,
      workspaceId: generationCanonicalString(input.workspaceId, "Generation Task target Workspace id"),
      id: generationCanonicalString(input.id, "Generation Task target Artifact id"),
      trackId: generationCanonicalString(input.trackId, "Generation Task target Track id"),
    };
  }
  if (input.type !== "workspace" && input.type !== "resource") {
    throw new WorkspaceStoreCodecError("Generation Task target type is unsupported");
  }
  generationAllowFields(input, ["type", "workspaceId", "id"], `Generation Task ${input.type} target`);
  return {
    type: input.type,
    workspaceId: generationCanonicalString(input.workspaceId, "Generation Task target Workspace id"),
    id: generationCanonicalString(input.id, `Generation Task target ${input.type} id`),
  };
}

function normalizeGenerationQaProfile(value: unknown): ArtifactQualityProfile {
  const input = generationRecord(value, "Generation Task QA profile");
  generationAllowFields(input, [
    "requiredFrameIds",
    "blockingSeverities",
    "requireRuntimeChecks",
    "requireVisualReview",
  ], "Generation Task QA profile");
  const blockingSeverities = generationUniqueStrings(input.blockingSeverities, "Generation Task blocking severities");
  if (blockingSeverities.some((severity) => severity !== "P0" && severity !== "P1" && severity !== "P2")) {
    throw new WorkspaceStoreCodecError("Generation Task blocking severity is unsupported");
  }
  if (typeof input.requireRuntimeChecks !== "boolean" || typeof input.requireVisualReview !== "boolean") {
    throw new WorkspaceStoreCodecError("Generation Task QA requirements must be booleans");
  }
  return {
    requiredFrameIds: generationUniqueStrings(input.requiredFrameIds, "Generation Task required Frame ids"),
    blockingSeverities: blockingSeverities as ArtifactQualityProfile["blockingSeverities"],
    requireRuntimeChecks: input.requireRuntimeChecks,
    requireVisualReview: input.requireVisualReview,
  };
}

function normalizeGenerationResourceLimits(value: unknown): GenerationTaskResourceLimits {
  const input = generationRecord(value, "Generation Task resource limits");
  generationAllowFields(input, [
    "timeoutMs",
    "maxAgentTurns",
    "maxRepairRounds",
    "maxOutputBytes",
    "capacityClasses",
  ], "Generation Task resource limits");
  const capacityClasses = generationUniqueStrings(input.capacityClasses, "Generation Task capacity classes");
  if (capacityClasses.some((entry) => !GENERATION_CAPACITY_CLASSES.has(entry as GenerationTaskCapacityClass))) {
    throw new WorkspaceStoreCodecError("Generation Task capacity class is unsupported");
  }
  return {
    timeoutMs: generationSafeInteger(input.timeoutMs, "Generation Task timeoutMs", 1),
    maxAgentTurns: generationSafeInteger(input.maxAgentTurns, "Generation Task maxAgentTurns", 1),
    maxRepairRounds: generationSafeInteger(input.maxRepairRounds, "Generation Task maxRepairRounds", 0),
    maxOutputBytes: generationSafeInteger(input.maxOutputBytes, "Generation Task maxOutputBytes", 1),
    capacityClasses: capacityClasses as GenerationTaskCapacityClass[],
  };
}

function generationTaskKind(value: unknown): GenerationTaskKind {
  if (typeof value !== "string" || !GENERATION_TASK_KINDS.has(value as GenerationTaskKind)) {
    throw new WorkspaceStoreCodecError("Generation Task kind is unsupported");
  }
  return value as GenerationTaskKind;
}

function generationHash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`dezin:${domain}:v1\0`)
    .update(JSON.stringify(value))
    .digest("hex");
}

function generationTaskIntentPayload(input: GenerationTaskIntentInput): Record<string, unknown> {
  return {
    id: input.id,
    ordinal: input.ordinal,
    workspaceId: input.workspaceId,
    planId: input.planId,
    kind: input.kind,
    target: input.target,
    dependencyIds: input.dependencyIds,
    payload: input.payload,
    capabilities: input.capabilities,
    qaProfile: input.qaProfile,
    resourceLimits: input.resourceLimits,
  };
}

export function generationTaskIntentHash(input: GenerationTaskIntentInput): string {
  return generationHash("generation-task-intent", generationTaskIntentPayload(input));
}

export function generationTaskIdempotencyKey(input: GenerationTaskIntentInput): string {
  return `generation-task:${generationHash("generation-task-idempotency", {
    workspaceId: input.workspaceId,
    planId: input.planId,
    taskId: input.id,
    intentHash: generationTaskIntentHash(input),
  })}`;
}

export function normalizeGenerationTaskIntent(value: unknown): GenerationTaskIntent {
  const input = generationRecord(value, "Generation Task intent");
  generationAllowFields(input, [
    "id",
    "ordinal",
    "workspaceId",
    "planId",
    "kind",
    "target",
    "dependencyIds",
    "payload",
    "capabilities",
    "qaProfile",
    "resourceLimits",
  ], "Generation Task intent");
  const workspaceId = generationCanonicalString(input.workspaceId, "Generation Task Workspace id");
  const target = normalizeGenerationTaskTarget(input.target);
  if (target.workspaceId !== workspaceId) {
    throw new WorkspaceStoreCodecError("Generation Task target Workspace does not match the task Workspace");
  }
  if (target.type === "workspace" && target.id !== workspaceId) {
    throw new WorkspaceStoreCodecError("Generation Task Workspace target id must match the task Workspace");
  }
  const kind = generationTaskKind(input.kind);
  if ((kind === "resource") !== (target.type === "resource")) {
    throw new WorkspaceStoreCodecError("Resource Generation Tasks must target a Resource and only Resource Tasks may do so");
  }
  if ((kind === "component" || kind === "page" || kind === "propagation-candidate") !== (target.type === "artifact")) {
    throw new WorkspaceStoreCodecError("Artifact Generation Task kind and target are inconsistent");
  }
  if ((kind === "prototype-validation" || kind === "checkpoint" || kind === "propagation-publish") !== (target.type === "workspace")) {
    throw new WorkspaceStoreCodecError("Workspace Generation Task kind and target are inconsistent");
  }
  const normalized: GenerationTaskIntentInput = {
    id: generationCanonicalString(input.id, "Generation Task id"),
    ordinal: generationSafeInteger(input.ordinal, "Generation Task ordinal", 0),
    workspaceId,
    planId: generationCanonicalString(input.planId, "Generation Task Plan id"),
    kind,
    target,
    dependencyIds: generationUniqueStrings(input.dependencyIds, "Generation Task dependencies"),
    payload: generationCanonicalObject(input.payload, "Generation Task payload"),
    capabilities: generationUniqueStrings(input.capabilities, "Generation Task capabilities"),
    qaProfile: normalizeGenerationQaProfile(input.qaProfile),
    resourceLimits: normalizeGenerationResourceLimits(input.resourceLimits),
  };
  if (normalized.dependencyIds.includes(normalized.id)) {
    throw new WorkspaceStoreCodecError("Generation Task cannot depend on itself");
  }
  return {
    ...normalized,
    intentHash: generationTaskIntentHash(normalized),
    idempotencyKey: generationTaskIdempotencyKey(normalized),
  };
}

function generationNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return generationCanonicalString(value, label);
}

function normalizeGenerationDesignNodeLocator(value: unknown, label: string): DesignNodeLocator {
  const input = generationRecord(value, label);
  generationAllowFields(input, ["designNodeId", "sourcePath", "selector"], label);
  const output: DesignNodeLocator = {
    designNodeId: generationCanonicalString(input.designNodeId, `${label} designNodeId`),
  };
  if (Object.hasOwn(input, "sourcePath")) {
    output.sourcePath = generationCanonicalString(input.sourcePath, `${label} sourcePath`);
  }
  if (Object.hasOwn(input, "selector")) {
    output.selector = generationCanonicalString(input.selector, `${label} selector`);
  }
  return output;
}

function normalizeGenerationDependencyOutput(
  value: unknown,
  index: number,
): GenerationTaskAttemptDependencyOutputInput {
  const label = `Generation Task Attempt Dependency output at index ${index}`;
  const input = generationRecord(value, label);
  generationAllowFields(input, [
    "taskId",
    "resultRevisionId",
    "resultResourceRevisionId",
    "resultSnapshotId",
  ], label);
  const output: GenerationTaskAttemptDependencyOutputInput = {
    taskId: generationCanonicalString(input.taskId, `${label} Task id`),
    resultRevisionId: generationNullableString(input.resultRevisionId, `${label} result Revision id`),
    resultResourceRevisionId: generationNullableString(
      input.resultResourceRevisionId,
      `${label} result Resource Revision id`,
    ),
    resultSnapshotId: generationNullableString(input.resultSnapshotId, `${label} result Snapshot id`),
  };
  return output;
}

function normalizeGenerationResourcePin(
  value: unknown,
  index: number,
): GenerationTaskAttemptResourcePinInput {
  const label = `Generation Task Attempt Resource pin at index ${index}`;
  const input = generationRecord(value, label);
  generationAllowFields(input, ["resourceId", "revisionId", "sourceTaskId"], label);
  return {
    resourceId: generationCanonicalString(input.resourceId, `${label} Resource id`),
    revisionId: generationCanonicalString(input.revisionId, `${label} Revision id`),
    sourceTaskId: generationNullableString(input.sourceTaskId, `${label} source Task id`),
  };
}

function normalizeGenerationComponentPin(
  value: unknown,
  index: number,
): GenerationTaskAttemptComponentPinInput {
  const label = `Generation Task Attempt Component pin at index ${index}`;
  const input = generationRecord(value, label);
  generationAllowFields(input, [
    "instanceId",
    "ownerArtifactId",
    "componentArtifactId",
    "revisionId",
    "sourceTaskId",
    "variantKey",
    "stateKey",
    "sourceLocator",
    "overrides",
    "status",
  ], label);
  if (input.status !== "linked" && input.status !== "detached") {
    throw new WorkspaceStoreCodecError(`${label} status is unsupported`);
  }
  return {
    instanceId: generationCanonicalString(input.instanceId, `${label} instance id`),
    ownerArtifactId: generationCanonicalString(input.ownerArtifactId, `${label} owner Artifact id`),
    componentArtifactId: generationCanonicalString(input.componentArtifactId, `${label} Component Artifact id`),
    revisionId: generationCanonicalString(input.revisionId, `${label} Component Revision id`),
    sourceTaskId: generationNullableString(input.sourceTaskId, `${label} source Task id`),
    variantKey: generationNullableString(input.variantKey, `${label} variant key`),
    stateKey: generationNullableString(input.stateKey, `${label} state key`),
    sourceLocator: normalizeGenerationDesignNodeLocator(input.sourceLocator, `${label} source locator`),
    overrides: generationCanonicalObject(input.overrides, `${label} overrides`),
    status: input.status as ComponentInstanceDependencyStatus,
  };
}

function withCanonicalDependencyOutputOrdinals(
  outputs: GenerationTaskAttemptDependencyOutputInput[],
): GenerationTaskAttemptDependencyOutput[] {
  outputs.sort((left, right) => compareBinary(left.taskId, right.taskId));
  return outputs.map((output, ordinal) => {
    if (ordinal > 0 && output.taskId === outputs[ordinal - 1]?.taskId) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt Dependency outputs must have unique Task ids");
    }
    return { ordinal, ...output };
  });
}

function withCanonicalResourceOrdinals(
  pins: GenerationTaskAttemptResourcePinInput[],
): GenerationTaskAttemptResourcePin[] {
  pins.sort((left, right) => compareBinary(left.resourceId, right.resourceId));
  return pins.map((pin, ordinal) => {
    if (ordinal > 0 && pin.resourceId === pins[ordinal - 1]?.resourceId) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt Resource pins must have unique Resource ids");
    }
    return { ordinal, ...pin };
  });
}

function withCanonicalComponentOrdinals(
  pins: GenerationTaskAttemptComponentPinInput[],
): GenerationTaskAttemptComponentPin[] {
  pins.sort((left, right) => compareBinary(left.instanceId, right.instanceId));
  return pins.map((pin, ordinal) => {
    if (ordinal > 0 && pin.instanceId === pins[ordinal - 1]?.instanceId) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt Component pins must have unique instance ids");
    }
    return { ordinal, ...pin, designNodeId: pin.sourceLocator.designNodeId };
  });
}

function generationTaskAttemptHashPayload(input: GenerationTaskAttemptHashInput): Record<string, unknown> {
  return {
    taskId: input.taskId,
    planId: input.planId,
    workspaceId: input.workspaceId,
    attempt: input.attempt,
    executionEpoch: input.executionEpoch ?? 0,
    target: input.target,
    baseRevisionId: input.baseRevisionId,
    sourceCommitHash: input.sourceCommitHash,
    sourceTreeHash: input.sourceTreeHash,
    expectedSnapshotId: input.expectedSnapshotId,
    contextPackId: input.contextPackId,
    kernelRevisionId: input.kernelRevisionId,
    payload: input.payload,
    dependencyOutputs: input.dependencyOutputs,
    resourcePins: input.resourcePins,
    componentPins: input.componentPins,
    retryContextPolicy: input.retryContextPolicy,
    executionMode: input.executionMode,
  };
}

function generationTaskAttemptPreEpochHashPayload(
  input: GenerationTaskAttemptHashInput,
): Record<string, unknown> {
  const { executionEpoch: _executionEpoch, ...payload } = generationTaskAttemptHashPayload(input);
  return payload;
}

function generationTaskAttemptLegacyHashPayload(
  input: GenerationTaskAttemptHashInput,
): Record<string, unknown> {
  return {
    taskId: input.taskId,
    planId: input.planId,
    workspaceId: input.workspaceId,
    attempt: input.attempt,
    target: input.target,
    baseRevisionId: input.baseRevisionId,
    expectedSnapshotId: input.expectedSnapshotId,
    contextPackId: input.contextPackId,
    kernelRevisionId: input.kernelRevisionId,
    payload: input.payload,
    dependencyOutputs: input.dependencyOutputs,
    resourcePins: input.resourcePins,
    componentPins: input.componentPins,
    retryContextPolicy: input.retryContextPolicy,
    executionMode: input.executionMode,
  };
}

export function generationTaskAttemptInputHash(
  input: GenerationTaskAttemptHashInput | GenerationTaskAttemptInput,
): string {
  return generationHash("generation-task-attempt-input", generationTaskAttemptHashPayload(input));
}

function generationTaskAttemptLegacyInputHash(input: GenerationTaskAttemptHashInput): string {
  return generationHash(
    "generation-task-attempt-input",
    generationTaskAttemptLegacyHashPayload(input),
  );
}

function generationTaskAttemptPreEpochInputHash(input: GenerationTaskAttemptHashInput): string {
  return generationHash(
    "generation-task-attempt-input",
    generationTaskAttemptPreEpochHashPayload(input),
  );
}

function normalizeGenerationTaskCandidateEvidenceHashInput(
  value: GenerationTaskCandidateEvidenceHashInput,
): GenerationTaskCandidateEvidenceHashInput {
  const input = generationRecord(value, "Generation Task candidate evidence hash input");
  generationAllowFields(input, [
    "taskId",
    "planId",
    "workspaceId",
    "attempt",
    "candidateRevisionId",
    "candidateResourceRevisionId",
    "candidateEvidence",
  ], "Generation Task candidate evidence hash input");
  const candidateRevisionId = generationNullableString(
    input.candidateRevisionId,
    "Generation Task candidate Revision id",
  );
  const candidateResourceRevisionId = generationNullableString(
    input.candidateResourceRevisionId,
    "Generation Task candidate Resource Revision id",
  );
  if ((candidateRevisionId === null) === (candidateResourceRevisionId === null)) {
    throw new WorkspaceStoreCodecError("Generation Task candidate evidence must bind exactly one candidate Revision");
  }
  return {
    taskId: generationCanonicalString(input.taskId, "Generation Task candidate evidence Task id"),
    planId: generationCanonicalString(input.planId, "Generation Task candidate evidence Plan id"),
    workspaceId: generationCanonicalString(input.workspaceId, "Generation Task candidate evidence Workspace id"),
    attempt: generationSafeInteger(input.attempt, "Generation Task candidate evidence attempt", 1),
    candidateRevisionId,
    candidateResourceRevisionId,
    candidateEvidence: generationCanonicalObject(
      input.candidateEvidence,
      "Generation Task candidate evidence",
    ),
  };
}

export function generationTaskCandidateEvidenceHash(
  input: GenerationTaskCandidateEvidenceHashInput,
): string {
  return generationHash(
    "generation-task-candidate-evidence",
    normalizeGenerationTaskCandidateEvidenceHashInput(input),
  );
}

function normalizeGenerationTaskAttemptInputInternal(
  value: unknown,
  options: { allowLegacyArtifactSourceBase: boolean },
): GenerationTaskAttemptInput {
  const input = generationRecord(value, "Generation Task Attempt input");
  generationAllowFields(input, [
    "taskId",
    "planId",
    "workspaceId",
    "attempt",
    "executionEpoch",
    "target",
    "baseRevisionId",
    "sourceCommitHash",
    "sourceTreeHash",
    "expectedSnapshotId",
    "contextPackId",
    "kernelRevisionId",
    "payload",
    "dependencyOutputs",
    "resourcePins",
    "componentPins",
    "retryContextPolicy",
    "executionMode",
    "requiredContextPackId",
  ], "Generation Task Attempt input");
  const workspaceId = generationCanonicalString(input.workspaceId, "Generation Task Attempt Workspace id");
  const target = normalizeGenerationTaskTarget(input.target);
  if (target.workspaceId !== workspaceId) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt target Workspace does not match its Workspace");
  }
  if (target.type === "workspace" && target.id !== workspaceId) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Workspace target id must match its Workspace");
  }
  if (input.retryContextPolicy !== "same-context" && input.retryContextPolicy !== "latest-context") {
    throw new WorkspaceStoreCodecError("Generation Task Attempt retry Context policy is unsupported");
  }
  if (input.executionMode !== "full" && input.executionMode !== "publication-only") {
    throw new WorkspaceStoreCodecError("Generation Task Attempt execution mode is unsupported");
  }
  const sourceCommitHash = input.sourceCommitHash === null
    ? null
    : generationGitObjectId(input.sourceCommitHash, "Generation Task Attempt Source Base commit hash");
  const sourceTreeHash = input.sourceTreeHash === null
    ? null
    : generationGitObjectId(input.sourceTreeHash, "Generation Task Attempt Source Base tree hash");
  if ((sourceCommitHash === null) !== (sourceTreeHash === null)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Source Base commit and tree must be one pair");
  }
  if (sourceCommitHash !== null && sourceTreeHash !== null
    && sourceCommitHash.length !== sourceTreeHash.length) {
    throw new WorkspaceStoreCodecError(
      "Generation Task Attempt Source Base commit and tree must use the same Git object format",
    );
  }
  if (target.type === "artifact") {
    if (sourceCommitHash === null && !options.allowLegacyArtifactSourceBase) {
      throw new WorkspaceStoreCodecError("Artifact Generation Task Attempt requires an immutable Source Base pair");
    }
  } else if (sourceCommitHash !== null) {
    throw new WorkspaceStoreCodecError("Non-Artifact Generation Task Attempt Source Base must be null");
  }
  const dependencyOutputs = withCanonicalDependencyOutputOrdinals(
    generationArray(input.dependencyOutputs, "Generation Task Attempt Dependency outputs")
      .map(normalizeGenerationDependencyOutput),
  );
  const resourcePins = withCanonicalResourceOrdinals(
    generationArray(input.resourcePins, "Generation Task Attempt Resource pins").map(normalizeGenerationResourcePin),
  );
  const componentPins = withCanonicalComponentOrdinals(
    generationArray(input.componentPins, "Generation Task Attempt Component pins").map(normalizeGenerationComponentPin),
  );
  if (target.type !== "artifact" && componentPins.length > 0) {
    throw new WorkspaceStoreCodecError("Only Artifact Generation Task Attempts may pin Component instances");
  }
  if (target.type === "artifact" && componentPins.some((pin) => pin.ownerArtifactId !== target.id)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Component pin owner does not match the target Artifact");
  }
  const taskId = generationCanonicalString(input.taskId, "Generation Task Attempt Task id");
  if (dependencyOutputs.some((output) => output.taskId === taskId)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt cannot depend on itself");
  }
  const normalized: GenerationTaskAttemptHashInput = {
    taskId,
    planId: generationCanonicalString(input.planId, "Generation Task Attempt Plan id"),
    workspaceId,
    attempt: generationSafeInteger(input.attempt, "Generation Task Attempt number", 1),
    executionEpoch: input.executionEpoch === undefined
      ? 0
      : generationSafeInteger(input.executionEpoch, "Generation Task Attempt execution epoch", 0),
    target,
    baseRevisionId: generationNullableString(input.baseRevisionId, "Generation Task Attempt base Revision id"),
    sourceCommitHash,
    sourceTreeHash,
    expectedSnapshotId: generationCanonicalString(input.expectedSnapshotId, "Generation Task Attempt expected Snapshot id"),
    contextPackId: generationNullableString(input.contextPackId, "Generation Task Attempt Context Pack id"),
    kernelRevisionId: generationCanonicalString(input.kernelRevisionId, "Generation Task Attempt Kernel Revision id"),
    payload: generationCanonicalObject(input.payload, "Generation Task Attempt payload"),
    dependencyOutputs,
    resourcePins,
    componentPins,
    retryContextPolicy: input.retryContextPolicy,
    executionMode: input.executionMode,
  };
  return { ...normalized, inputHash: generationTaskAttemptInputHash(normalized) };
}

export function normalizeGenerationTaskAttemptInput(value: unknown): GenerationTaskAttemptInput {
  return normalizeGenerationTaskAttemptInputInternal(value, { allowLegacyArtifactSourceBase: false });
}

export function normalizeGenerationTaskAttemptLease(value: unknown): GenerationTaskAttemptLease {
  const input = generationRecord(value, "Generation Task Attempt lease");
  generationAllowFields(input, [
    "taskId",
    "workspaceId",
    "attempt",
    "ownerId",
    "leaseToken",
  ], "Generation Task Attempt lease");
  return {
    taskId: generationCanonicalString(input.taskId, "Generation Task Attempt lease task id"),
    workspaceId: generationCanonicalString(input.workspaceId, "Generation Task Attempt lease Workspace id"),
    attempt: generationSafeInteger(input.attempt, "Generation Task Attempt lease attempt", 1),
    ownerId: generationCanonicalString(input.ownerId, "Generation Task Attempt lease owner id"),
    leaseToken: generationCanonicalString(input.leaseToken, "Generation Task Attempt lease token"),
  };
}

export function normalizeFinishGenerationTaskAttemptFailureInput(
  value: unknown,
): FinishGenerationTaskAttemptFailureInput {
  const input = generationRecord(value, "Finish Generation Task Attempt failure input");
  generationAllowFields(input, ["lease", "failure"], "Finish Generation Task Attempt failure input");
  const failure = generationRecord(input.failure, "Generation Task execution failure");
  generationAllowFields(failure, ["failureClass", "error"], "Generation Task execution failure");
  return {
    lease: normalizeGenerationTaskAttemptLease(input.lease),
    failure: {
      failureClass: generationRequiredFailureClass(
        failure.failureClass,
        "Generation Task execution failure class",
      ),
      error: generationCanonicalObject(failure.error, "Generation Task execution failure error"),
    },
  };
}

function normalizeGenerationValidationRevisionIds(value: unknown, label: string): string[] {
  const ids = generationArray(value, label).map((entry, index) => (
    generationExactString(entry, `${label}[${index}]`)
  ));
  const sorted = [...ids].sort(compareBinary);
  if (new Set(ids).size !== ids.length) {
    throw new WorkspaceStoreCodecError(`${label} must be unique`);
  }
  return sorted;
}

export function normalizeCompleteGenerationTaskValidationInput(
  value: unknown,
): CompleteGenerationTaskValidationInput {
  const input = generationRecord(value, "complete Generation Task validation input");
  generationAllowFields(
    input,
    ["lease", "validation"],
    "complete Generation Task validation input",
  );
  const validation = generationRecord(input.validation, "Generation Task validation result");
  generationAllowFields(validation, [
    "snapshotId",
    "graphRevision",
    "artifactRevisionIds",
    "resourceRevisionIds",
    "evidence",
  ], "Generation Task validation result");
  return {
    lease: normalizeGenerationTaskAttemptLease(input.lease),
    validation: {
      snapshotId: generationExactString(
        validation.snapshotId,
        "Generation Task validation Snapshot id",
      ),
      graphRevision: generationSafeInteger(
        validation.graphRevision,
        "Generation Task validation graph revision",
        0,
      ),
      artifactRevisionIds: normalizeGenerationValidationRevisionIds(
        validation.artifactRevisionIds,
        "Generation Task validation Artifact Revision ids",
      ),
      resourceRevisionIds: normalizeGenerationValidationRevisionIds(
        validation.resourceRevisionIds,
        "Generation Task validation Resource Revision ids",
      ),
      evidence: generationCanonicalObject(
        validation.evidence,
        "Generation Task validation evidence",
      ),
    },
  };
}

export function normalizePublishGenerationPlanCheckpointInput(
  value: unknown,
): PublishGenerationPlanCheckpointInput {
  const input = generationRecord(value, "Publish Generation Plan checkpoint input");
  generationAllowFields(input, ["lease"], "Publish Generation Plan checkpoint input");
  return { lease: normalizeGenerationTaskAttemptLease(input.lease) };
}

function normalizeGenerationTaskArtifactCandidateInput(
  value: unknown,
): GenerationTaskArtifactCandidateInput {
  const input = generationRecord(value, "Generation Task Artifact candidate");
  generationAllowFields(input, [
    "kind",
    "sourceCommitHash",
    "sourceTreeHash",
    "renderSpec",
    "quality",
  ], "Generation Task Artifact candidate");
  if (input.kind !== "artifact") {
    throw new WorkspaceStoreCodecError("Generation Task candidate kind is unsupported");
  }
  return {
    kind: input.kind,
    sourceCommitHash: generationGitObjectId(
      input.sourceCommitHash,
      "Generation Task Artifact candidate source commit hash",
    ),
    sourceTreeHash: generationGitObjectId(
      input.sourceTreeHash,
      "Generation Task Artifact candidate source tree hash",
    ),
    renderSpec: generationCanonicalObject(
      input.renderSpec,
      "Generation Task Artifact candidate render spec",
    ),
    quality: generationCanonicalObject(
      input.quality,
      "Generation Task Artifact candidate quality",
    ),
  };
}

function normalizeGenerationTaskResourceCandidateInput(
  value: unknown,
): GenerationTaskResourceCandidateInput {
  const input = generationRecord(value, "Generation Task Resource candidate");
  generationAllowFields(input, ["kind", "resourceId", "revision"], "Generation Task Resource candidate");
  if (input.kind !== "resource") {
    throw new WorkspaceStoreCodecError("Generation Task candidate kind is unsupported");
  }
  const revision = generationRecord(input.revision, "Generation Task Resource candidate Revision");
  generationAllowFields(revision, [
    "revisionId",
    "parentRevisionId",
    "manifestPath",
    "summary",
    "metadata",
    "checksum",
    "provenance",
    "createdByRunId",
  ], "Generation Task Resource candidate Revision");
  const provenance = generationCanonicalObject(
    revision.provenance,
    "Generation Task Resource candidate provenance",
  );
  if (Object.hasOwn(provenance, "generationTask")) {
    throw new WorkspaceStoreCodecError(
      "Generation Task Resource candidate provenance contains reserved field generationTask",
    );
  }
  const candidateChecksum = generationExactString(
    revision.checksum,
    "Generation Task Resource candidate checksum",
  );
  if (!/^[0-9a-f]{64}$/.test(candidateChecksum)) {
    throw new WorkspaceStoreCodecError(
      "Generation Task Resource candidate checksum must be a lowercase SHA-256 digest",
    );
  }
  if (revision.createdByRunId !== undefined && revision.createdByRunId !== null) {
    throw new WorkspaceStoreCodecError(
      "Generation Task Resource candidate cannot claim a legacy Run",
    );
  }
  return {
    kind: input.kind,
    resourceId: generationExactString(input.resourceId, "Generation Task Resource candidate Resource id"),
    revision: {
      revisionId: generationExactString(
        revision.revisionId,
        "Generation Task Resource candidate Revision id",
      ),
      parentRevisionId: revision.parentRevisionId === null
        ? null
        : generationExactString(
          revision.parentRevisionId,
          "Generation Task Resource candidate parent Revision id",
        ),
      manifestPath: generationExactString(
        revision.manifestPath,
        "Generation Task Resource candidate manifest path",
      ),
      summary: generationCanonicalString(
        revision.summary,
        "Generation Task Resource candidate summary",
      ),
      metadata: generationCanonicalObject(
        revision.metadata,
        "Generation Task Resource candidate metadata",
      ),
      checksum: candidateChecksum,
      provenance,
      createdByRunId: null,
    },
  };
}

export function normalizeStageGenerationTaskCandidateInput(
  value: unknown,
): AnyStageGenerationTaskCandidateInput {
  const input = generationRecord(value, "stage Generation Task candidate input");
  generationAllowFields(
    input,
    ["lease", "candidate", "evidence"],
    "stage Generation Task candidate input",
  );
  const lease = normalizeGenerationTaskAttemptLease(input.lease);
  const evidence = generationCanonicalObject(input.evidence, "Generation Task candidate evidence");
  if (generationRecord(input.candidate, "Generation Task candidate").kind === "resource") {
    return {
      lease,
      candidate: normalizeGenerationTaskResourceCandidateInput(input.candidate),
      evidence,
    };
  }
  return {
    lease,
    candidate: normalizeGenerationTaskArtifactCandidateInput(input.candidate),
    evidence,
  };
}

export function normalizePublishGenerationTaskCandidateInput(
  value: unknown,
): PublishGenerationTaskCandidateInput {
  const input = generationRecord(value, "publish Generation Task candidate input");
  generationAllowFields(input, ["lease"], "publish Generation Task candidate input");
  return { lease: normalizeGenerationTaskAttemptLease(input.lease) };
}

function generationLeaseMs(value: unknown, label: string): number {
  const leaseMs = generationSafeInteger(value, label, 1);
  if (leaseMs > GENERATION_TASK_MAX_LEASE_MS) {
    throw new WorkspaceStoreCodecError(`${label} must not exceed ${GENERATION_TASK_MAX_LEASE_MS}`);
  }
  return leaseMs;
}

function generationLeaseWindow(
  nowValue: unknown,
  leaseMsValue: unknown,
  label: string,
): { now: number; leaseMs: number } {
  const now = generationSafeInteger(nowValue, `${label} time`, 0);
  const leaseMs = generationLeaseMs(leaseMsValue, `${label} lease ms`);
  if (now > Number.MAX_SAFE_INTEGER - leaseMs) {
    throw new WorkspaceStoreCodecError(`${label} lease expiry must be a safe integer`);
  }
  return { now, leaseMs };
}

export function normalizeTryClaimGenerationTaskAttemptInput(
  value: unknown,
): TryClaimGenerationTaskAttemptInput {
  const input = generationRecord(value, "claim Generation Task Attempt input");
  generationAllowFields(input, ["taskId", "attempt", "ownerId", "now", "leaseMs"], "claim Generation Task Attempt input");
  const leaseWindow = generationLeaseWindow(input.now, input.leaseMs, "claim Generation Task Attempt");
  return {
    taskId: generationCanonicalString(input.taskId, "claim Generation Task Attempt Task id"),
    attempt: generationSafeInteger(input.attempt, "claim Generation Task Attempt number", 1),
    ownerId: generationCanonicalString(input.ownerId, "claim Generation Task Attempt owner id"),
    ...leaseWindow,
  };
}

export function normalizeHeartbeatGenerationTaskAttemptInput(
  value: unknown,
): HeartbeatGenerationTaskAttemptInput {
  const input = generationRecord(value, "heartbeat Generation Task Attempt input");
  generationAllowFields(input, [
    "taskId",
    "workspaceId",
    "attempt",
    "ownerId",
    "leaseToken",
    "now",
    "leaseMs",
  ], "heartbeat Generation Task Attempt input");
  const leaseWindow = generationLeaseWindow(input.now, input.leaseMs, "heartbeat Generation Task Attempt");
  return {
    ...normalizeGenerationTaskAttemptLease({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      attempt: input.attempt,
      ownerId: input.ownerId,
      leaseToken: input.leaseToken,
    }),
    ...leaseWindow,
  };
}

function generationClaimIdHex(value: string, label: string): void {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be non-empty lowercase byte hex`);
  }
  const decoded = Buffer.from(value, "hex").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("hex") !== value) {
    throw new WorkspaceStoreCodecError(`${label} must encode well-formed UTF-8`);
  }
  generationExactString(decoded, label);
}

function generationTaskClaimKey(value: unknown, claimKind: "capacity" | "writer"): GenerationTaskClaimKey {
  const claimKey = generationExactString(value, "Generation Task Claim key");
  if (claimKind === "capacity") {
    if (!GENERATION_CAPACITY_CLAIM_KEYS.has(claimKey as GenerationTaskCapacityClaimKey)) {
      throw new WorkspaceStoreCodecError("Generation Task capacity Claim key is unsupported");
    }
    return claimKey as GenerationTaskCapacityClaimKey;
  }

  const parts = claimKey.split(":");
  const writerScope = parts[1];
  if (parts[0] !== "writer") {
    throw new WorkspaceStoreCodecError("Generation Task writer Claim key is unsupported");
  }
  if (writerScope === "artifact" || writerScope === "resource") {
    if (parts.length !== 4) {
      throw new WorkspaceStoreCodecError("Generation Task writer Claim key is unsupported");
    }
    generationClaimIdHex(parts[2]!, "Generation Task writer Claim Workspace id");
    generationClaimIdHex(parts[3]!, "Generation Task writer Claim target id");
    return claimKey as GenerationTaskWriterClaimKey;
  }
  if (writerScope === "checkpoint" || writerScope === "kernel" || writerScope === "source") {
    if (parts.length !== 3) {
      throw new WorkspaceStoreCodecError("Generation Task writer Claim key is unsupported");
    }
    generationClaimIdHex(parts[2]!, `Generation Task ${writerScope} writer Claim domain id`);
    return claimKey as GenerationTaskWriterClaimKey;
  }
  throw new WorkspaceStoreCodecError("Generation Task writer Claim key is unsupported");
}

export function asGenerationTaskClaim(rowValue: Row): GenerationTaskClaim {
  const row = generationRecord(rowValue, "Generation Task Claim row");
  generationAllowFields(row, [
    "claim_key",
    "claim_kind",
    "task_id",
    "plan_id",
    "attempt",
    "workspace_id",
    "owner_id",
    "lease_token",
    "lease_expires_at",
    "created_at",
  ], "Generation Task Claim row");
  if (row.claim_kind !== "capacity" && row.claim_kind !== "writer") {
    throw new WorkspaceStoreCodecError("Generation Task Claim kind is unsupported");
  }
  const claimKind = row.claim_kind;
  const claimKey = generationTaskClaimKey(row.claim_key, claimKind);
  const createdAt = generationSafeInteger(row.created_at, "Generation Task Claim created at", 0);
  const leaseExpiresAt = generationSafeInteger(
    row.lease_expires_at,
    "Generation Task Claim lease expires at",
    0,
  );
  if (leaseExpiresAt <= createdAt) {
    throw new WorkspaceStoreCodecError("Generation Task Claim lease must have a positive lifetime");
  }
  return {
    taskId: generationExactString(row.task_id, "Generation Task Claim Task id"),
    workspaceId: generationExactString(row.workspace_id, "Generation Task Claim Workspace id"),
    attempt: generationSafeInteger(row.attempt, "Generation Task Claim Attempt number", 1),
    ownerId: generationExactString(row.owner_id, "Generation Task Claim owner id"),
    leaseToken: generationExactString(row.lease_token, "Generation Task Claim lease token"),
    planId: generationExactString(row.plan_id, "Generation Task Claim Plan id"),
    claimKey,
    claimKind,
    leaseExpiresAt,
    createdAt,
  };
}

function generationStoredNullableString(value: unknown, label: string): string | null {
  return value === null ? null : generationExactString(value, label);
}

function generationStoredNullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : generationSafeInteger(value, label, 0);
}

function generationFailureClass(value: unknown, label: string): GenerationTaskFailureClass | null {
  if (value === null) return null;
  if (typeof value !== "string" || !GENERATION_FAILURE_CLASSES.has(value as GenerationTaskFailureClass)) {
    throw new WorkspaceStoreCodecError(`${label} is unsupported`);
  }
  return value as GenerationTaskFailureClass;
}

function generationRequiredFailureClass(value: unknown, label: string): GenerationTaskFailureClass {
  const failureClass = generationFailureClass(value, label);
  if (failureClass === null) throw new WorkspaceStoreCodecError(`${label} is required`);
  return failureClass;
}

export function normalizeRecordGenerationTaskMaterializationFailureInput(
  value: unknown,
): RecordGenerationTaskMaterializationFailureInput {
  const input = generationRecord(value, "Generation Task materialization failure input");
  generationAllowFields(input, [
    "taskId",
    "expectedFailureCount",
    "failureClass",
    "error",
    "nextEligibleAt",
  ], "Generation Task materialization failure input");
  return {
    taskId: generationCanonicalString(input.taskId, "Generation Task materialization failure Task id"),
    expectedFailureCount: generationSafeInteger(
      input.expectedFailureCount,
      "Generation Task materialization failure expected failure count",
      0,
    ),
    failureClass: generationRequiredFailureClass(
      input.failureClass,
      "Generation Task materialization failure class",
    ),
    error: generationCanonicalObject(input.error, "Generation Task materialization failure error"),
    nextEligibleAt: generationStoredNullableInteger(
      input.nextEligibleAt,
      "Generation Task materialization failure next eligible at",
    ),
  };
}

export function asGenerationTaskMaterializationFailure(
  rowValue: Row,
  expectedSequenceValue: number,
): GenerationTaskMaterializationFailure {
  const row = generationRecord(rowValue, "Generation Task materialization failure row");
  generationAllowFields(row, [
    "task_id",
    "plan_id",
    "workspace_id",
    "sequence",
    "failure_class",
    "error_json",
    "next_eligible_at",
    "created_at",
  ], "Generation Task materialization failure row");
  const expectedSequence = generationSafeInteger(
    expectedSequenceValue,
    "Generation Task materialization failure expected sequence",
    1,
  );
  const sequence = generationSafeInteger(
    row.sequence,
    "Generation Task materialization failure sequence",
    1,
  );
  if (sequence !== expectedSequence) {
    throw new WorkspaceStoreCodecError(
      "Generation Task materialization failures must have a contiguous sequence",
    );
  }
  const createdAt = generationSafeInteger(
    row.created_at,
    "Generation Task materialization failure created at",
    0,
  );
  const nextEligibleAt = generationStoredNullableInteger(
    row.next_eligible_at,
    "Generation Task materialization failure next eligible at",
  );
  if (nextEligibleAt !== null && nextEligibleAt < createdAt) {
    throw new WorkspaceStoreCodecError(
      "Generation Task materialization failure next eligible at cannot be before it was created",
    );
  }
  return {
    taskId: generationExactString(row.task_id, "Generation Task materialization failure Task id"),
    planId: generationExactString(row.plan_id, "Generation Task materialization failure Plan id"),
    workspaceId: generationExactString(
      row.workspace_id,
      "Generation Task materialization failure Workspace id",
    ),
    sequence,
    failureClass: generationRequiredFailureClass(
      row.failure_class,
      "Generation Task materialization failure class",
    ),
    error: generationCanonicalObjectText(
      row.error_json,
      "Generation Task materialization failure error",
    ),
    nextEligibleAt,
    createdAt,
  };
}

function generationPendingContextPolicy(value: unknown): GenerationTaskRetryContextPolicy | null {
  if (value === null) return null;
  if (value !== "same-context" && value !== "latest-context") {
    throw new WorkspaceStoreCodecError("Generation Task pending Context policy is unsupported");
  }
  return value;
}

function generationTaskTargetFromRow(row: Record<string, unknown>): GenerationTaskTarget {
  const workspaceId = generationExactString(row.workspace_id, "Generation Task Workspace id");
  const targetId = generationExactString(row.target_id, "Generation Task target id");
  const targetArtifactId = generationStoredNullableString(row.target_artifact_id, "Generation Task target Artifact id");
  const targetTrackId = generationStoredNullableString(row.target_track_id, "Generation Task target Track id");
  const targetResourceId = generationStoredNullableString(row.target_resource_id, "Generation Task target Resource id");
  if (row.target_type === "artifact") {
    if (targetArtifactId !== targetId || targetTrackId === null || targetResourceId !== null) {
      throw new WorkspaceStoreCodecError("Generation Task Artifact target columns are inconsistent");
    }
    return { type: "artifact", workspaceId, id: targetId, trackId: targetTrackId };
  }
  if (row.target_type === "resource") {
    if (targetResourceId !== targetId || targetArtifactId !== null || targetTrackId !== null) {
      throw new WorkspaceStoreCodecError("Generation Task Resource target columns are inconsistent");
    }
    return { type: "resource", workspaceId, id: targetId };
  }
  if (row.target_type !== "workspace") {
    throw new WorkspaceStoreCodecError("Generation Task target type is unsupported");
  }
  if (targetId !== workspaceId || targetArtifactId !== null || targetTrackId !== null || targetResourceId !== null) {
    throw new WorkspaceStoreCodecError("Generation Task Workspace target columns are inconsistent");
  }
  return { type: "workspace", workspaceId, id: targetId };
}

function asGenerationTaskDependencyRow(
  value: unknown,
  expected: { planId: string; workspaceId: string; taskId: string; ordinal: number },
): GenerationTaskDependency {
  const label = `Generation Task dependency at ordinal ${expected.ordinal}`;
  const row = generationRecord(value, label);
  generationAllowFields(row, ["plan_id", "workspace_id", "task_id", "dependency_task_id", "ordinal"], label);
  const result: GenerationTaskDependency = {
    planId: generationExactString(row.plan_id, `${label} Plan id`),
    taskId: generationExactString(row.task_id, `${label} Task id`),
    dependencyTaskId: generationExactString(row.dependency_task_id, `${label} dependency Task id`),
    ordinal: generationSafeInteger(row.ordinal, `${label} ordinal`, 0),
  };
  const workspaceId = generationExactString(row.workspace_id, `${label} Workspace id`);
  if (result.planId !== expected.planId || result.taskId !== expected.taskId || workspaceId !== expected.workspaceId) {
    throw new WorkspaceStoreCodecError(`${label} ownership does not match its Generation Task`);
  }
  if (result.ordinal !== expected.ordinal) {
    throw new WorkspaceStoreCodecError("Generation Task dependencies must have canonical ordinals");
  }
  if (result.dependencyTaskId === result.taskId) {
    throw new WorkspaceStoreCodecError("Generation Task cannot depend on itself");
  }
  return result;
}

export function asGenerationTask(rowValue: Row, dependencyRowsValue: readonly Row[]): GenerationTask {
  const row = generationRecord(rowValue, "Generation Task row");
  generationAllowFields(row, [
    "id", "ordinal", "workspace_id", "plan_id", "kind", "target_type", "target_id",
    "target_artifact_id", "target_track_id", "target_resource_id", "payload_json", "intent_hash",
    "capabilities_json", "qa_profile_json", "resource_limits_json", "idempotency_key", "status",
    "blocked_reason", "blocked_by_task_id", "pending_context_policy", "current_attempt",
    "materialization_failures", "rebase_count", "failure_class", "error_json", "next_eligible_at", "result_revision_id",
    "result_resource_revision_id", "result_snapshot_id", "created_at", "finished_at",
  ], "Generation Task row");
  const id = generationExactString(row.id, "Generation Task id");
  const workspaceId = generationExactString(row.workspace_id, "Generation Task Workspace id");
  const planId = generationExactString(row.plan_id, "Generation Task Plan id");
  const dependencyRows = generationArray(dependencyRowsValue, "Generation Task dependency rows");
  const dependencies = dependencyRows.map((dependency, ordinal) => asGenerationTaskDependencyRow(
    dependency,
    { planId, workspaceId, taskId: id, ordinal },
  ));
  const dependencyIds = dependencies.map((dependency) => dependency.dependencyTaskId);
  const sortedDependencyIds = [...dependencyIds].sort(compareBinary);
  if (dependencyIds.some((dependencyId, index) => dependencyId !== sortedDependencyIds[index])) {
    throw new WorkspaceStoreCodecError("Generation Task dependencies must use canonical binary order");
  }
  const intent = normalizeGenerationTaskIntent({
    id,
    ordinal: generationSafeInteger(row.ordinal, "Generation Task ordinal", 0),
    workspaceId,
    planId,
    kind: row.kind,
    target: generationTaskTargetFromRow(row),
    dependencyIds,
    payload: generationCanonicalObjectText(row.payload_json, "Generation Task payload"),
    capabilities: generationCanonicalArrayText(row.capabilities_json, "Generation Task capabilities"),
    qaProfile: generationCanonicalObjectText(row.qa_profile_json, "Generation Task QA profile"),
    resourceLimits: generationCanonicalObjectText(row.resource_limits_json, "Generation Task resource limits"),
  });
  if (generationExactString(row.intent_hash, "Generation Task intent hash") !== intent.intentHash) {
    throw new WorkspaceStoreCodecError("Generation Task intent hash does not match its immutable intent");
  }
  if (generationExactString(row.idempotency_key, "Generation Task idempotency key") !== intent.idempotencyKey) {
    throw new WorkspaceStoreCodecError("Generation Task idempotency key does not match its immutable intent");
  }
  if (typeof row.status !== "string" || !GENERATION_TASK_STATUSES.has(row.status as GenerationTaskStatus)) {
    throw new WorkspaceStoreCodecError("Generation Task status is unsupported");
  }
  const blockedByTaskId = generationStoredNullableString(row.blocked_by_task_id, "Generation Task blocking Task id");
  if (blockedByTaskId === id) throw new WorkspaceStoreCodecError("Generation Task cannot be blocked by itself");
  const error = row.error_json === null
    ? null
    : generationCanonicalObjectText(row.error_json, "Generation Task error");
  return {
    ...intent,
    status: row.status as GenerationTaskStatus,
    blockedReason: generationStoredNullableString(row.blocked_reason, "Generation Task blocked reason"),
    blockedByTaskId,
    pendingContextPolicy: generationPendingContextPolicy(row.pending_context_policy),
    currentAttempt: generationSafeInteger(row.current_attempt, "Generation Task current attempt", 0),
    materializationFailures: generationSafeInteger(
      row.materialization_failures,
      "Generation Task materialization failures",
      0,
    ),
    rebaseCount: generationSafeInteger(row.rebase_count ?? 0, "Generation Task rebase count", 0),
    failureClass: generationFailureClass(row.failure_class, "Generation Task failure class"),
    error,
    nextEligibleAt: generationStoredNullableInteger(row.next_eligible_at, "Generation Task next eligible at"),
    resultRevisionId: generationStoredNullableString(row.result_revision_id, "Generation Task result Revision id"),
    resultResourceRevisionId: generationStoredNullableString(
      row.result_resource_revision_id,
      "Generation Task result Resource Revision id",
    ),
    resultSnapshotId: generationStoredNullableString(row.result_snapshot_id, "Generation Task result Snapshot id"),
    createdAt: generationSafeInteger(row.created_at, "Generation Task created at", 0),
    finishedAt: generationStoredNullableInteger(row.finished_at, "Generation Task finished at"),
  };
}

function generationTaskAttemptTargetFromRow(row: Record<string, unknown>): GenerationTaskTarget {
  const workspaceId = generationExactString(row.workspace_id, "Generation Task Attempt Workspace id");
  const artifactId = generationStoredNullableString(
    row.target_artifact_id,
    "Generation Task Attempt target Artifact id",
  );
  const trackId = generationStoredNullableString(
    row.target_track_id,
    "Generation Task Attempt target Track id",
  );
  const resourceId = generationStoredNullableString(
    row.target_resource_id,
    "Generation Task Attempt target Resource id",
  );
  if (artifactId !== null || trackId !== null) {
    if (artifactId === null || trackId === null || resourceId !== null) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt target columns are inconsistent");
    }
    return { type: "artifact", workspaceId, id: artifactId, trackId };
  }
  if (resourceId !== null) return { type: "resource", workspaceId, id: resourceId };
  return { type: "workspace", workspaceId, id: workspaceId };
}

function asGenerationTaskAttemptDependencyOutputRow(
  value: unknown,
  expected: { taskId: string; planId: string; workspaceId: string; attempt: number; ordinal: number },
): GenerationTaskAttemptDependencyOutput {
  const label = `Generation Task Attempt Dependency output at ordinal ${expected.ordinal}`;
  const row = generationRecord(value, label);
  generationAllowFields(row, [
    "task_id",
    "plan_id",
    "attempt",
    "workspace_id",
    "ordinal",
    "dependency_task_id",
    "result_revision_id",
    "result_resource_revision_id",
    "result_snapshot_id",
  ], label);
  const ownership = {
    taskId: generationExactString(row.task_id, `${label} owning Task id`),
    planId: generationExactString(row.plan_id, `${label} Plan id`),
    workspaceId: generationExactString(row.workspace_id, `${label} Workspace id`),
    attempt: generationSafeInteger(row.attempt, `${label} attempt`, 1),
  };
  if (ownership.taskId !== expected.taskId || ownership.planId !== expected.planId
    || ownership.workspaceId !== expected.workspaceId || ownership.attempt !== expected.attempt) {
    throw new WorkspaceStoreCodecError(`${label} ownership does not match its Generation Task Attempt`);
  }
  const ordinal = generationSafeInteger(row.ordinal, `${label} ordinal`, 0);
  if (ordinal !== expected.ordinal) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Dependency outputs must have contiguous ordinals");
  }
  const normalized = normalizeGenerationDependencyOutput({
    taskId: generationExactString(row.dependency_task_id, `${label} dependency Task id`),
    resultRevisionId: row.result_revision_id === null
      ? null
      : generationExactString(row.result_revision_id, `${label} result Revision id`),
    resultResourceRevisionId: row.result_resource_revision_id === null
      ? null
      : generationExactString(row.result_resource_revision_id, `${label} result Resource Revision id`),
    resultSnapshotId: row.result_snapshot_id === null
      ? null
      : generationExactString(row.result_snapshot_id, `${label} result Snapshot id`),
  }, ordinal);
  return { ordinal, ...normalized };
}

function asGenerationTaskAttemptResourcePinRow(
  value: unknown,
  expected: { taskId: string; planId: string; workspaceId: string; attempt: number; ordinal: number },
): GenerationTaskAttemptResourcePin {
  const label = `Generation Task Attempt Resource pin at ordinal ${expected.ordinal}`;
  const row = generationRecord(value, label);
  generationAllowFields(row, [
    "task_id", "plan_id", "attempt", "workspace_id", "ordinal", "resource_id", "revision_id", "source_task_id",
  ], label);
  const ownership = {
    taskId: generationExactString(row.task_id, `${label} Task id`),
    planId: generationExactString(row.plan_id, `${label} Plan id`),
    workspaceId: generationExactString(row.workspace_id, `${label} Workspace id`),
    attempt: generationSafeInteger(row.attempt, `${label} attempt`, 1),
  };
  if (ownership.taskId !== expected.taskId || ownership.planId !== expected.planId
    || ownership.workspaceId !== expected.workspaceId || ownership.attempt !== expected.attempt) {
    throw new WorkspaceStoreCodecError(`${label} ownership does not match its Generation Task Attempt`);
  }
  const ordinal = generationSafeInteger(row.ordinal, `${label} ordinal`, 0);
  if (ordinal !== expected.ordinal) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Resource pins must have contiguous ordinals");
  }
  return {
    ordinal,
    resourceId: generationExactString(row.resource_id, `${label} Resource id`),
    revisionId: generationExactString(row.revision_id, `${label} Revision id`),
    sourceTaskId: generationStoredNullableString(row.source_task_id, `${label} source Task id`),
  };
}

function asGenerationTaskAttemptComponentPinRow(
  value: unknown,
  expected: { taskId: string; planId: string; workspaceId: string; attempt: number; ordinal: number },
): GenerationTaskAttemptComponentPin {
  const label = `Generation Task Attempt Component pin at ordinal ${expected.ordinal}`;
  const row = generationRecord(value, label);
  generationAllowFields(row, [
    "task_id", "plan_id", "attempt", "workspace_id", "ordinal", "instance_id", "owner_artifact_id",
    "component_artifact_id", "revision_id", "source_task_id", "variant_key", "state_key", "design_node_id",
    "source_locator_json", "overrides_json", "status",
  ], label);
  const ownership = {
    taskId: generationExactString(row.task_id, `${label} Task id`),
    planId: generationExactString(row.plan_id, `${label} Plan id`),
    workspaceId: generationExactString(row.workspace_id, `${label} Workspace id`),
    attempt: generationSafeInteger(row.attempt, `${label} attempt`, 1),
  };
  if (ownership.taskId !== expected.taskId || ownership.planId !== expected.planId
    || ownership.workspaceId !== expected.workspaceId || ownership.attempt !== expected.attempt) {
    throw new WorkspaceStoreCodecError(`${label} ownership does not match its Generation Task Attempt`);
  }
  const ordinal = generationSafeInteger(row.ordinal, `${label} ordinal`, 0);
  if (ordinal !== expected.ordinal) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Component pins must have contiguous ordinals");
  }
  const sourceLocator = normalizeGenerationDesignNodeLocator(
    generationCanonicalObjectText(row.source_locator_json, `${label} source locator`),
    `${label} source locator`,
  );
  const designNodeId = generationExactString(row.design_node_id, `${label} design node id`);
  if (sourceLocator.designNodeId !== designNodeId) {
    throw new WorkspaceStoreCodecError(`${label} design node id does not match its source locator`);
  }
  const normalized = normalizeGenerationComponentPin({
    instanceId: generationExactString(row.instance_id, `${label} instance id`),
    ownerArtifactId: generationExactString(row.owner_artifact_id, `${label} owner Artifact id`),
    componentArtifactId: generationExactString(
      row.component_artifact_id,
      `${label} Component Artifact id`,
    ),
    revisionId: generationExactString(row.revision_id, `${label} Component Revision id`),
    sourceTaskId: generationStoredNullableString(row.source_task_id, `${label} source Task id`),
    variantKey: generationStoredNullableString(row.variant_key, `${label} variant key`),
    stateKey: generationStoredNullableString(row.state_key, `${label} state key`),
    sourceLocator,
    overrides: generationCanonicalObjectText(row.overrides_json, `${label} overrides`),
    status: row.status,
  }, ordinal);
  return { ordinal, ...normalized, designNodeId };
}

function generationRevisionSummary(value: unknown, label: string): string[] {
  return generationCanonicalArrayText(value, label).map((entry, index) => (
    generationExactString(entry, `${label}[${index}]`)
  ));
}

function generationEqualStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function asGenerationTaskAttempt(
  rowValue: Row,
  dependencyOutputRowsValue: readonly Row[],
  resourcePinRowsValue: readonly Row[],
  componentPinRowsValue: readonly Row[],
): GenerationTaskAttempt {
  const row = generationRecord(rowValue, "Generation Task Attempt row");
  generationAllowFields(row, [
    "task_id", "plan_id", "workspace_id", "attempt", "execution_epoch", "target_artifact_id", "target_track_id",
    "target_resource_id", "base_revision_id", "source_commit_hash", "source_tree_hash",
    "expected_snapshot_id", "context_pack_id", "kernel_revision_id",
    "materialization_sealed", "attempt_origin", "predecessor_attempt", "automatic_retry_index",
    "execution_mode", "payload_json", "input_hash", "pinned_resource_revision_ids_json",
    "component_dependency_revision_ids_json", "retry_context_policy", "status", "blocked_reason",
    "failure_class", "error_json", "next_eligible_at", "candidate_revision_id",
    "candidate_resource_revision_id", "candidate_evidence_json", "candidate_evidence_hash", "owner_id",
    "lease_token", "lease_expires_at", "heartbeat_at", "created_at", "started_at", "finished_at",
  ], "Generation Task Attempt row");
  const taskId = generationExactString(row.task_id, "Generation Task Attempt Task id");
  const planId = generationExactString(row.plan_id, "Generation Task Attempt Plan id");
  const workspaceId = generationExactString(row.workspace_id, "Generation Task Attempt Workspace id");
  const attemptNumber = generationSafeInteger(row.attempt, "Generation Task Attempt number", 1);
  if (row.attempt_origin !== "materialized" && row.attempt_origin !== "same-input-retry"
    && row.attempt_origin !== "publication-retry") {
    throw new WorkspaceStoreCodecError("Generation Task Attempt origin is unsupported");
  }
  const attemptOrigin = row.attempt_origin;
  const predecessorAttempt = generationStoredNullableInteger(
    row.predecessor_attempt,
    "Generation Task Attempt predecessor number",
  );
  const automaticRetryIndex = generationSafeInteger(
    row.automatic_retry_index,
    "Generation Task Attempt automatic retry index",
    0,
  );
  if ((attemptOrigin === "materialized" && (predecessorAttempt !== null || automaticRetryIndex !== 0))
    || (attemptOrigin !== "materialized"
      && (attemptNumber < 2
        || predecessorAttempt !== attemptNumber - 1
        || automaticRetryIndex < 1
        || automaticRetryIndex > 3
        || automaticRetryIndex > attemptNumber - 1))
    || (attemptOrigin === "publication-retry" && row.execution_mode !== "publication-only")) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt lineage is incoherent");
  }
  const expectedOwnership = { taskId, planId, workspaceId, attempt: attemptNumber };
  if (row.materialization_sealed !== 1) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt materialization must be sealed");
  }
  const dependencyOutputRows = generationArray(
    dependencyOutputRowsValue,
    "Generation Task Attempt Dependency output rows",
  );
  const dependencyOutputs = dependencyOutputRows.map((output, ordinal) => asGenerationTaskAttemptDependencyOutputRow(
    output,
    { ...expectedOwnership, ordinal },
  ));
  const resourcePinRows = generationArray(
    resourcePinRowsValue,
    "Generation Task Attempt Resource pin rows",
  );
  const resourcePins = resourcePinRows.map((pin, ordinal) => asGenerationTaskAttemptResourcePinRow(
    pin,
    { ...expectedOwnership, ordinal },
  ));
  const componentPinRows = generationArray(
    componentPinRowsValue,
    "Generation Task Attempt Component pin rows",
  );
  const componentPins = componentPinRows.map((pin, ordinal) => asGenerationTaskAttemptComponentPinRow(
    pin,
    { ...expectedOwnership, ordinal },
  ));
  for (let ordinal = 1; ordinal < resourcePins.length; ordinal += 1) {
    if (compareBinary(resourcePins[ordinal - 1]!.resourceId, resourcePins[ordinal]!.resourceId) >= 0) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt Resource pins must use unique canonical binary order");
    }
  }
  for (let ordinal = 1; ordinal < dependencyOutputs.length; ordinal += 1) {
    if (compareBinary(dependencyOutputs[ordinal - 1]!.taskId, dependencyOutputs[ordinal]!.taskId) >= 0) {
      throw new WorkspaceStoreCodecError(
        "Generation Task Attempt Dependency outputs must use unique canonical binary order",
      );
    }
  }
  for (let ordinal = 1; ordinal < componentPins.length; ordinal += 1) {
    if (compareBinary(componentPins[ordinal - 1]!.instanceId, componentPins[ordinal]!.instanceId) >= 0) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt Component pins must use unique canonical binary order");
    }
  }
  const storedResourceRevisionIds = generationRevisionSummary(
    row.pinned_resource_revision_ids_json,
    "Generation Task Attempt Resource revision summary",
  );
  if (!generationEqualStringArrays(storedResourceRevisionIds, resourcePins.map((pin) => pin.revisionId))) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Resource revision summary does not match its pins");
  }
  const storedComponentRevisionIds = generationRevisionSummary(
    row.component_dependency_revision_ids_json,
    "Generation Task Attempt Component revision summary",
  );
  if (!generationEqualStringArrays(storedComponentRevisionIds, componentPins.map((pin) => pin.revisionId))) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt Component revision summary does not match its pins");
  }
  const target = generationTaskAttemptTargetFromRow(row);
  let input = normalizeGenerationTaskAttemptInputInternal({
    taskId,
    planId,
    workspaceId,
    attempt: attemptNumber,
    executionEpoch: generationSafeInteger(
      row.execution_epoch ?? 0,
      "Generation Task Attempt execution epoch",
      0,
    ),
    target,
    baseRevisionId: generationStoredNullableString(
      row.base_revision_id,
      "Generation Task Attempt base Revision id",
    ),
    sourceCommitHash: generationStoredNullableString(
      row.source_commit_hash,
      "Generation Task Attempt Source Base commit hash",
    ),
    sourceTreeHash: generationStoredNullableString(
      row.source_tree_hash,
      "Generation Task Attempt Source Base tree hash",
    ),
    expectedSnapshotId: generationExactString(
      row.expected_snapshot_id,
      "Generation Task Attempt expected Snapshot id",
    ),
    contextPackId: generationStoredNullableString(
      row.context_pack_id,
      "Generation Task Attempt Context Pack id",
    ),
    kernelRevisionId: generationExactString(
      row.kernel_revision_id,
      "Generation Task Attempt Kernel Revision id",
    ),
    payload: generationCanonicalObjectText(row.payload_json, "Generation Task Attempt payload"),
    dependencyOutputs: dependencyOutputs.map(({ ordinal: _ordinal, ...output }) => output),
    resourcePins: resourcePins.map(({ ordinal: _ordinal, ...pin }) => pin),
    componentPins: componentPins.map(({ ordinal: _ordinal, designNodeId: _designNodeId, ...pin }) => pin),
    retryContextPolicy: row.retry_context_policy,
    executionMode: row.execution_mode,
  }, { allowLegacyArtifactSourceBase: true });
  const storedInputHash = generationExactString(row.input_hash, "Generation Task Attempt input hash");
  if (storedInputHash !== input.inputHash) {
    if (storedInputHash !== generationTaskAttemptPreEpochInputHash(input)
      && (input.sourceCommitHash !== null
        || storedInputHash !== generationTaskAttemptLegacyInputHash(input))) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt input hash does not match its immutable input");
    }
    input = { ...input, inputHash: storedInputHash };
  }
  if (typeof row.status !== "string"
    || !GENERATION_TASK_ATTEMPT_STATUSES.has(row.status as GenerationTaskAttemptStatus)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt status is unsupported");
  }
  const status = row.status as GenerationTaskAttemptStatus;
  const candidateRevisionId = generationStoredNullableString(
    row.candidate_revision_id,
    "Generation Task Attempt candidate Revision id",
  );
  const candidateResourceRevisionId = generationStoredNullableString(
    row.candidate_resource_revision_id,
    "Generation Task Attempt candidate Resource Revision id",
  );
  const candidateEvidenceHash = generationStoredNullableString(
    row.candidate_evidence_hash,
    "Generation Task Attempt candidate evidence hash",
  );
  let candidateEvidence: Record<string, unknown> | null = null;
  const hasCandidateOutput = candidateRevisionId !== null || candidateResourceRevisionId !== null
    || row.candidate_evidence_json !== null || candidateEvidenceHash !== null;
  if (hasCandidateOutput) {
    if ((candidateRevisionId === null) === (candidateResourceRevisionId === null)
      || row.candidate_evidence_json === null || candidateEvidenceHash === null) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt candidate columns are inconsistent");
    }
    if ((candidateRevisionId !== null && target.type !== "artifact")
      || (candidateResourceRevisionId !== null && target.type !== "resource")) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt candidate does not match its target");
    }
    candidateEvidence = generationCanonicalObjectText(
      row.candidate_evidence_json,
      "Generation Task Attempt candidate evidence",
    );
    const expectedEvidenceHash = generationTaskCandidateEvidenceHash({
      taskId,
      planId,
      workspaceId,
      attempt: attemptNumber,
      candidateRevisionId,
      candidateResourceRevisionId,
      candidateEvidence,
    });
    if (candidateEvidenceHash !== expectedEvidenceHash) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt candidate evidence hash does not match its output");
    }
  }
  if (status === "candidate-ready" && !hasCandidateOutput) {
    throw new WorkspaceStoreCodecError("A candidate-ready Generation Task Attempt must retain candidate evidence");
  }
  const ownerId = generationStoredNullableString(row.owner_id, "Generation Task Attempt lease owner id");
  const leaseToken = generationStoredNullableString(row.lease_token, "Generation Task Attempt lease token");
  const leaseExpiresAt = generationStoredNullableInteger(
    row.lease_expires_at,
    "Generation Task Attempt lease expires at",
  );
  const heartbeatAt = generationStoredNullableInteger(row.heartbeat_at, "Generation Task Attempt heartbeat at");
  let lease: GenerationTaskAttemptLease | null = null;
  if (ownerId === null && leaseToken === null && leaseExpiresAt === null) {
    if (heartbeatAt !== null) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt lease columns are inconsistent");
    }
  } else {
    if (ownerId === null || leaseToken === null || leaseExpiresAt === null) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt lease columns are inconsistent");
    }
    lease = normalizeGenerationTaskAttemptLease({
      taskId,
      workspaceId,
      attempt: attemptNumber,
      ownerId,
      leaseToken,
    });
  }
  const requiresLiveLease = status === "running" || status === "cancel-requested" || status === "candidate-ready";
  if (requiresLiveLease !== (lease !== null)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt lease does not match its execution status");
  }
  const createdAt = generationSafeInteger(row.created_at, "Generation Task Attempt created at", 0);
  const startedAt = generationStoredNullableInteger(row.started_at, "Generation Task Attempt started at");
  const finishedAt = generationStoredNullableInteger(row.finished_at, "Generation Task Attempt finished at");
  if (startedAt !== null && startedAt < createdAt) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt started before it was created");
  }
  if (finishedAt !== null && finishedAt < (startedAt ?? createdAt)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt finished before it started");
  }
  if (heartbeatAt !== null && (heartbeatAt < (startedAt ?? createdAt) || heartbeatAt > leaseExpiresAt!)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt heartbeat is outside its lease interval");
  }
  if (leaseExpiresAt !== null && leaseExpiresAt < createdAt) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt lease expired before the Attempt was created");
  }
  const requiresStartedAt = status === "running" || status === "cancel-requested" || status === "candidate-ready"
    || status === "succeeded" || status === "retryable-failed" || status === "failed" || status === "needs-rebase";
  if (requiresStartedAt && startedAt === null) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt execution status requires started_at");
  }
  if (status === "queued" && startedAt !== null) {
    throw new WorkspaceStoreCodecError("A queued Generation Task Attempt cannot have started_at");
  }
  const isFinished = status === "succeeded" || status === "retryable-failed" || status === "failed"
    || status === "needs-rebase" || status === "cancelled";
  if (isFinished !== (finishedAt !== null)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt finished_at does not match its status");
  }
  const nextEligibleAt = generationStoredNullableInteger(
    row.next_eligible_at,
    "Generation Task Attempt next eligible at",
  );
  if ((status === "retryable-failed") !== (nextEligibleAt !== null)) {
    throw new WorkspaceStoreCodecError("Generation Task Attempt next eligible time does not match its status");
  }
  const error = row.error_json === null
    ? null
    : generationCanonicalObjectText(row.error_json, "Generation Task Attempt error");
  return {
    ...input,
    attemptOrigin,
    predecessorAttempt,
    automaticRetryIndex,
    status,
    blockedReason: generationStoredNullableString(row.blocked_reason, "Generation Task Attempt blocked reason"),
    failureClass: generationFailureClass(row.failure_class, "Generation Task Attempt failure class"),
    error,
    nextEligibleAt,
    candidateRevisionId,
    candidateResourceRevisionId,
    candidateEvidence,
    candidateEvidenceHash,
    lease,
    leaseExpiresAt,
    heartbeatAt,
    createdAt,
    startedAt,
    finishedAt,
  };
}

export function normalizeListGenerationPlanEventsInput(value: unknown): ListGenerationPlanEventsInput {
  const input = generationRecord(value, "list Generation Plan events input");
  generationAllowFields(input, ["after", "limit"], "list Generation Plan events input");
  const limit = generationSafeInteger(input.limit, "Generation Plan event limit", 1);
  if (limit > 1_000) throw new WorkspaceStoreCodecError("Generation Plan event limit must not exceed 1000");
  return {
    after: generationSafeInteger(input.after, "Generation Plan event cursor", 0),
    limit,
  };
}

export function asGenerationPlanEvent(rowValue: Row): GenerationPlanEvent {
  const row = generationRecord(rowValue, "Generation Plan event row");
  generationAllowFields(row, [
    "plan_id", "workspace_id", "sequence", "task_id", "type", "payload_json", "created_at",
  ], "Generation Plan event row");
  if (typeof row.type !== "string" || !GENERATION_PLAN_EVENT_TYPES.has(row.type as GenerationPlanEventType)) {
    throw new WorkspaceStoreCodecError("Generation Plan event type is unsupported");
  }
  const taskId = generationStoredNullableString(row.task_id, "Generation Plan event Task id");
  if (row.type.startsWith("plan-") && taskId !== null) {
    throw new WorkspaceStoreCodecError("Generation Plan events cannot name a Task");
  }
  if (row.type.startsWith("task-") && taskId === null) {
    throw new WorkspaceStoreCodecError("Generation Task events must name a Task");
  }
  generationExactString(row.workspace_id, "Generation Plan event Workspace id");
  return {
    planId: generationExactString(row.plan_id, "Generation Plan event Plan id"),
    sequence: generationSafeInteger(row.sequence, "Generation Plan event sequence", 1),
    taskId,
    type: row.type as GenerationPlanEventType,
    payload: generationCanonicalObjectText(row.payload_json, "Generation Plan event payload"),
    createdAt: generationSafeInteger(row.created_at, "Generation Plan event created at", 0),
  };
}

export function asProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    skillId: (r.skill_id as string | null) ?? null,
    designSystemId: (r.design_system_id as string | null) ?? null,
    mode: r.mode === "standard" ? "standard" : "prototype",
    sharingan: Number(r.sharingan ?? 0) === 1,
    sourceUrl: (r.source_url as string | null | undefined) ?? undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
  };
}

export function asExtensionCredential(r: Row): ExtensionCredentialRecord {
  const scopes = JSON.parse((r.scopes_json as string) || "[]") as unknown;
  return {
    id: r.id as string,
    tokenHash: r.token_hash as string,
    extensionId: r.extension_id as string,
    scopes: Array.isArray(scopes)
      ? scopes.filter((scope): scope is ExtensionScope => scope === "capture:write" || scope === "image:analyze")
      : [],
    createdAt: r.created_at as number,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    revokedAt: (r.revoked_at as number | null) ?? null,
  };
}
export function asConversation(r: Row): Conversation {
  const projectId = r.project_id as string;
  const scopeType = r.scope_type;
  const scopeId = r.scope_id;
  const scope: Conversation["scope"] | null = scopeType == null && scopeId == null
    ? { type: "workspace" as const, id: projectId }
    : (scopeType === "workspace" || scopeType === "artifact" || scopeType === "resource")
        && typeof scopeId === "string" && scopeId.length > 0
      ? { type: scopeType, id: scopeId }
      : null;
  if (scope === null) throw new Error("Conversation scope is invalid");
  return {
    id: r.id as string,
    projectId,
    title: r.title as string,
    scope,
    createdAt: Number(r.created_at),
  };
}
export function asVariant(r: Row): Variant {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    createdAt: Number(r.created_at),
  };
}
export function asMessage(r: Row): Message {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    role: r.role as MessageRole,
    content: r.content as string,
    createdAt: Number(r.created_at),
  };
}
export function asQualityFindings(value: unknown): QualityFinding[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is QualityFinding => {
      if (!f || typeof f !== "object") return false;
      const x = f as Record<string, unknown>;
      return (
        (x.severity === "P0" || x.severity === "P1" || x.severity === "P2") &&
        typeof x.id === "string" &&
        typeof x.message === "string" &&
        typeof x.fix === "string" &&
        (x.snippet === undefined || typeof x.snippet === "string")
      );
    });
  } catch {
    return [];
  }
}
export function parseRunFeedback(value: unknown): RunFeedback | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const p = JSON.parse(value) as { verdict?: unknown; gap?: unknown };
    if (p.verdict === "up" || p.verdict === "down") return { verdict: p.verdict, gap: typeof p.gap === "string" ? p.gap : undefined };
  } catch {
    /* ignore malformed feedback */
  }
  return null;
}

export function asRun(r: Row): Run {
  const attempt = Number(r.attempt ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Run attempt is invalid");
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: r.conversation_id as string,
    userMessageId: (r.user_message_id as string | null | undefined) ?? null,
    assistantMessageId: (r.assistant_message_id as string | null | undefined) ?? null,
    variantId: (r.variant_id as string | null | undefined) ?? null,
    commitHash: (r.commit_hash as string | null | undefined) ?? null,
    artifactId: (r.artifact_id as string | null | undefined) ?? null,
    artifactTrackId: (r.artifact_track_id as string | null | undefined) ?? null,
    planId: (r.plan_id as string | null | undefined) ?? null,
    taskId: (r.task_id as string | null | undefined) ?? null,
    baseRevisionId: (r.base_revision_id as string | null | undefined) ?? null,
    contextPackId: (r.context_pack_id as string | null | undefined) ?? null,
    contextPackHash: (r.context_pack_hash as string | null | undefined) ?? null,
    attempt,
    status: r.status as RunStatus,
    repairRounds: Number(r.repair_rounds),
    lintPassed: Number(r.lint_passed) === 1,
    score: r.score == null ? null : Number(r.score),
    findings: asQualityFindings(r.final_findings),
    model: (r.model as string | null | undefined) ?? null,
    agentCommand: (r.agent_command as string | null | undefined) ?? null,
    skillId: (r.skill_id as string | null | undefined) ?? null,
    feedback: parseRunFeedback(r.feedback),
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  };
}
export function asArtifact(r: Row): Artifact {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    path: r.path as string,
    lintPassed: Number(r.lint_passed) === 1,
    createdAt: Number(r.created_at),
  };
}
export function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
export function asMoodboard(r: Row): Moodboard {
  return {
    id: r.id as string,
    name: r.name as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    coverAssetId: (r.cover_asset_id as string | null | undefined) ?? null,
  };
}
export function asMoodboardNode(r: Row): MoodboardNode {
  const type =
    r.type === "video" || r.type === "note" || r.type === "section" || r.type === "image-generator"
      ? r.type
      : "image";
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    type,
    x: Number(r.x),
    y: Number(r.y),
    width: Number(r.width),
    height: Number(r.height),
    rotation: Number(r.rotation ?? 0),
    zIndex: Number(r.z_index ?? 0),
    data: asJsonObject(r.data_json),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
export function asMoodboardAsset(r: Row): MoodboardAsset {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    kind: r.kind === "video" ? "video" : "image",
    fileName: r.file_name as string,
    mimeType: r.mime_type as string,
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    source: r.source === "generated" ? "generated" : "upload",
    createdAt: Number(r.created_at),
  };
}
export function asMoodboardConversation(r: Row): MoodboardConversation {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    title: r.title as string,
    createdAt: Number(r.created_at),
    ...(r.turns == null ? {} : { turns: Number(r.turns) }),
  };
}
export function asMoodboardMessage(r: Row): MoodboardMessage {
  return {
    id: r.id as string,
    boardId: r.board_id as string,
    conversationId: (r.conversation_id as string | null) ?? undefined,
    role: r.role as MessageRole,
    content: r.content as string,
    createdAt: Number(r.created_at),
  };
}
export function asEffectParamValue(value: unknown): string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";
}
export function asEffectParameters(value: unknown): EffectParamDefinition[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((param): EffectParamDefinition[] => {
      const record = asJsonObject(JSON.stringify(param));
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const type =
        record.type === "color" || record.type === "select" || record.type === "boolean" || record.type === "number"
          ? record.type
          : "number";
      if (!id || !label) return [];
      const options = Array.isArray(record.options)
        ? record.options.flatMap((option): Array<{ label: string; value: string }> => {
            const optionRecord = option && typeof option === "object" && !Array.isArray(option) ? (option as Record<string, unknown>) : {};
            const valueText = typeof optionRecord.value === "string" ? optionRecord.value : "";
            const labelText = typeof optionRecord.label === "string" ? optionRecord.label : valueText;
            return valueText ? [{ label: labelText, value: valueText }] : [];
          })
        : undefined;
      return [
        {
          id,
          label,
          type,
          defaultValue: asEffectParamValue(record.defaultValue),
          ...(typeof record.min === "number" ? { min: record.min } : {}),
          ...(typeof record.max === "number" ? { max: record.max } : {}),
          ...(typeof record.step === "number" ? { step: record.step } : {}),
          ...(options?.length ? { options } : {}),
          ...(typeof record.description === "string" ? { description: record.description } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}
export function asEffectPresets(value: unknown): EffectPreset[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((preset): EffectPreset[] => {
      const record = preset && typeof preset === "object" && !Array.isArray(preset) ? (preset as Record<string, unknown>) : {};
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const rawValues = record.values && typeof record.values === "object" && !Array.isArray(record.values) ? (record.values as Record<string, unknown>) : {};
      if (!id || !name) return [];
      return [{ id, name, values: Object.fromEntries(Object.entries(rawValues).map(([key, val]) => [key, asEffectParamValue(val)])) }];
    });
  } catch {
    return [];
  }
}
export function asEffect(r: Row): Effect {
  return {
    id: r.id as string,
    name: r.name as string,
    origin: "custom",
    category: r.category as string,
    summary: r.summary as string,
    code: r.code as string,
    parameters: asEffectParameters(r.parameters_json),
    presets: asEffectPresets(r.presets_json),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
