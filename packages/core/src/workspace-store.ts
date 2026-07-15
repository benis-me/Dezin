import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { StoreClock } from "./store.ts";
import type {
  ApprovedProposalResult,
  AgentScope,
  AgentIntent,
  ArtifactPublicationExpectation,
  ContextItemRef,
  ContextOmission,
  ContextPack,
  ContextPackItemUsage,
  ContextPackTarget,
  ContextTrustLevel,
  CreateGenerationTaskAttemptInput,
  CreateResourceForProjectInput,
  CreateResourceForProjectResult,
  CreateResourceRevisionCandidateInput,
  CreateWorkspaceProposalInput,
  CreateArtifactRevisionInput,
  CreateKernelRevisionInput,
  GenerationPlan,
  GenerationPlanDetail,
  GenerationPlanEvent,
  GenerationTask,
  GenerationTaskAttempt,
  GenerationTaskAttemptComponentPinInput,
  GenerationTaskAttemptDependencyOutputInput,
  GenerationTaskAttemptInput,
  GenerationTaskAttemptResourcePinInput,
  GenerationTaskAttemptClaim,
  GenerationTaskClaim,
  GenerationTaskDependency,
  GenerationTaskExecutionLease,
  GenerationTaskExecutionMode,
  GenerationTaskMaterializationObservation,
  GenerationTaskMaterializationFailure,
  GenerationTaskAttemptLease,
  HeartbeatGenerationTaskAttemptInput,
  KernelImpactAnalysis,
  KernelPublicationExpectation,
  LegacyWorkspaceFacts,
  LegacyWorkspaceSeed,
  ListGenerationPlanEventsInput,
  NewWorkspaceNode,
  ProjectWorkspace,
  PersistContextPackInput,
  PersistContextPackItemInput,
  RecordContextPackItemUsageInput,
  RecordGenerationTaskMaterializationFailureInput,
  ResolvedContextItem,
  ResolvedContextKind,
  Resource,
  ResourceKind,
  ResourcePinPolicy,
  ResourcePublicationExpectation,
  ResourceRevision,
  SharedDesignKernelRevision,
  WorkspaceArtifactNode,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceGraphMutationInput,
  WorkspaceGraphMutationResult,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceLayoutPatch,
  WorkspaceNode,
  WorkspaceProposal,
  WorkspaceProposalApprovalMode,
  WorkspaceProposalReview,
  WorkspaceGenerationPayload,
  WorkspaceResourceNode,
  WorkspaceSnapshotProvenance,
  WorkspaceSnapshotPublicationInput,
  UpdateWorkspaceProposalInput,
  UpdateResourceForProjectInput,
  UpdateResourceForProjectResult,
  TryClaimGenerationTaskAttemptInput,
} from "./workspace-types.ts";
import {
  assertAcyclicTaskGraph,
  compileGenerationPlan,
  GenerationPlanCompileError,
} from "./generation-plan.ts";
import {
  applyWorkspaceGraphCommands,
  normalizeWorkspaceGraphCommands,
  validateWorkspaceGraph,
  WorkspaceCommandReplayConflictError,
  WorkspaceGraphValidationError,
  WorkspaceRevisionConflictError,
} from "./workspace-graph.ts";
import {
  asArtifactRevision,
  asArtifactRevisionDependency,
  asArtifactRevisionResourcePin,
  asArtifactTrack,
  asGenerationPlan,
  asProjectWorkspace,
  asSharedDesignKernelRevision,
  asWorkspaceArtifact,
  asWorkspaceEdge,
  asWorkspaceGraphRevision,
  asWorkspaceLayoutValue,
  asWorkspaceNode,
  asWorkspaceProposal,
  asWorkspaceProposalAudit,
  asWorkspaceSnapshotBase,
  compareBinary,
  isWellFormedUtf16,
  normalizeArtifactPublicationExpectation,
  normalizeCreateArtifactRevisionInput,
  normalizeCreateKernelRevisionInput,
  normalizeCreateWorkspaceProposalInput,
  normalizeKernelPublicationExpectation,
  normalizeLegacyWorkspaceSeed,
  normalizeWorkspaceGraphMutationInput,
  normalizeWorkspaceLayoutId,
  normalizeWorkspaceLayoutPatch,
  normalizeWorkspaceProposalApprovalMode,
  normalizeWorkspaceSnapshotPublicationInput,
  normalizeUpdateWorkspaceProposalInput,
  workspaceLayoutChecksum,
  WorkspaceStoreCodecError,
  type ArtifactRevisionDependencyRecord,
  type ArtifactRevisionRecord,
  type ArtifactRevisionResourcePinRecord,
  type ArtifactTrackRecord,
  type WorkspaceArtifactRecord,
  type WorkspaceBundle,
  type WorkspaceProposalRecord,
  type WorkspaceSnapshotRecord,
} from "./workspace-codecs.ts";
import {
  asGenerationTaskAttempt,
  asGenerationTaskClaim,
  asGenerationPlanEvent,
  asGenerationTask,
  asGenerationTaskMaterializationFailure,
  normalizeGenerationTaskAttemptInput,
  normalizeGenerationTaskAttemptLease,
  normalizeHeartbeatGenerationTaskAttemptInput,
  normalizeGenerationTaskIntent,
  normalizeRecordGenerationTaskMaterializationFailureInput,
  normalizeListGenerationPlanEventsInput,
  normalizeTryClaimGenerationTaskAttemptInput,
  type Row,
} from "./store-codecs.ts";

const DEFAULT_KERNEL_PAYLOAD = {
  tokens: {},
  typography: {},
  sharedAssetRevisionIds: [],
  brief: "",
  terminology: {},
  exclusions: [],
  responsiveFrames: [],
  qualityProfile: {
    requiredFrameIds: [],
    blockingSeverities: [],
    requireRuntimeChecks: false,
    requireVisualReview: false,
  },
} as const;

const GENERATION_TASK_CAPACITY_LIMITS = {
  agent: 3,
  "render-qa": 2,
  image: 2,
} as const;

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generationClaimKeyId(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

export function artifactRevisionContextChecksum(input: {
  revision: ArtifactRevisionRecord;
  dependencies: readonly ArtifactRevisionDependencyRecord[];
  resourcePins: readonly ArtifactRevisionResourcePinRecord[];
}): string {
  return checksum(canonicalJsonText({
    revision: input.revision,
    dependencies: [...input.dependencies].sort((left, right) => compareBinary(left.instanceId, right.instanceId)),
    resourcePins: [...input.resourcePins].sort((left, right) => compareBinary(left.resourceId, right.resourceId)),
  }, "Artifact Revision Context checksum input"));
}

function boundaryObject(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  let prototype: object | null;
  let keys: Array<string | symbol>;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkspaceStoreCodecError(`${label} must be an object`);
    }
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (error instanceof WorkspaceStoreCodecError) throw error;
    throw new WorkspaceStoreCodecError(`${label} must be an inspectable plain object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceStoreCodecError(`${label} must be a plain object`);
  }
  const allowed = new Set([...required, ...optional]);
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new WorkspaceStoreCodecError(`${label} contains unsupported field ${String(key)}`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new WorkspaceStoreCodecError(`${label} contains an unreadable field ${key}`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new WorkspaceStoreCodecError(`${label} field ${key} must be an enumerable data property`);
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(record, field)) throw new WorkspaceStoreCodecError(`${label} is missing field ${field}`);
  }
  return record;
}

function boundaryString(value: unknown, label: string, maxLength = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !isWellFormedUtf16(value)) {
    throw new WorkspaceStoreCodecError(`${label} is invalid`);
  }
  return value;
}

function boundaryId(value: unknown, label: string): string {
  const result = boundaryString(value, label, 256);
  if (result.trim() !== result || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new WorkspaceStoreCodecError(`${label} is invalid`);
  }
  return result;
}

function boundaryText(value: unknown, label: string, maxLength: number): string {
  const result = boundaryString(value, label, maxLength).trim();
  if (result.length === 0) throw new WorkspaceStoreCodecError(`${label} is invalid`);
  return result;
}

function boundarySafeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new WorkspaceStoreCodecError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function boundaryChecksum(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function boundaryRelativePath(value: unknown, label: string): string {
  const result = boundaryString(value, label, 1_024);
  const segments = result.split("/");
  if (result.trim() !== result
    || result.startsWith("/")
    || result.includes("\\")
    || /[\u0000-\u001f\u007f<>:"|?*]/.test(result)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."
      || /[ .]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new WorkspaceStoreCodecError(`${label} must be a canonical relative path`);
  }
  return result;
}

interface JsonBoundaryState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  textUnits: number;
}

function boundaryJsonArray(value: object, label: string): unknown[] {
  let prototype: object | null;
  let keys: PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new WorkspaceStoreCodecError(`${label} must be an inspectable array`);
  }
  if (prototype !== Array.prototype) throw new WorkspaceStoreCodecError(`${label} must use the standard array prototype`);
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > 10_000) {
    throw new WorkspaceStoreCodecError(`${label} exceeds the JSON array budget`);
  }
  const length = lengthDescriptor.value;
  for (const key of keys) {
    if (typeof key !== "string") throw new WorkspaceStoreCodecError(`${label} cannot contain symbol fields`);
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      throw new WorkspaceStoreCodecError(`${label} contains unsupported field ${key}`);
    }
  }
  const result = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new WorkspaceStoreCodecError(`${label} contains an unreadable item`);
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new WorkspaceStoreCodecError(`${label} must contain dense enumerable data items`);
    }
    result[index] = descriptor.value;
  }
  return result;
}

function boundaryJsonValue(value: unknown, label: string, state: JsonBoundaryState, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 64) throw new WorkspaceStoreCodecError(`${label} exceeds the JSON budget`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    state.textUnits += value.length;
    if (!isWellFormedUtf16(value) || value.length > 1_000_000 || state.textUnits > 4_000_000) {
      throw new WorkspaceStoreCodecError(`${label} contains invalid or oversized text`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkspaceStoreCodecError(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object" || value === null) throw new WorkspaceStoreCodecError(`${label} must contain JSON values`);
  if (state.ancestors.has(value)) throw new WorkspaceStoreCodecError(`${label} contains a cycle`);
  state.ancestors.add(value);
  try {
    let isArray: boolean;
    try {
      isArray = Array.isArray(value);
    } catch {
      throw new WorkspaceStoreCodecError(`${label} must be inspectable JSON`);
    }
    if (isArray) {
      const values = boundaryJsonArray(value, label);
      const result = new Array<unknown>(values.length);
      for (let index = 0; index < values.length; index += 1) {
        result[index] = boundaryJsonValue(values[index], `${label}[${index}]`, state, depth + 1);
      }
      return result;
    }
    let objectKeys: PropertyKey[];
    try {
      objectKeys = Reflect.ownKeys(value);
    } catch {
      throw new WorkspaceStoreCodecError(`${label} must be inspectable JSON`);
    }
    const record = boundaryObject(
      value,
      label,
      [],
      objectKeys.filter((key): key is string => typeof key === "string"),
    );
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareBinary)) {
      state.textUnits += key.length;
      if (!isWellFormedUtf16(key) || state.textUnits > 4_000_000) {
        throw new WorkspaceStoreCodecError(`${label} contains invalid or oversized keys`);
      }
      Object.defineProperty(result, key, {
        value: boundaryJsonValue(record[key], `${label}.${key}`, state, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function boundaryJsonObject(value: unknown, label: string): Record<string, unknown> {
  const result = boundaryJsonValue(value, label, { ancestors: new WeakSet<object>(), nodes: 0, textUnits: 0 });
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new WorkspaceStoreCodecError(`${label} must be a JSON object`);
  }
  return result as Record<string, unknown>;
}

function canonicalJsonText(value: unknown, label: string): string {
  return JSON.stringify(boundaryJsonValue(value, label, { ancestors: new WeakSet<object>(), nodes: 0, textUnits: 0 }));
}

function resourceKind(value: unknown, label: string): ResourceKind {
  if (value === "research" || value === "moodboard" || value === "sharingan-capture"
    || value === "file" || value === "asset" || value === "effect" || value === "external-reference") {
    return value;
  }
  throw new WorkspaceStoreCodecError(`${label} is unsupported`);
}

function resourcePinPolicy(value: unknown, label: string): ResourcePinPolicy {
  if (value === "follow-head" || value === "pin-current" || value === "manual") return value;
  throw new WorkspaceStoreCodecError(`${label} is unsupported`);
}

export function normalizeCreateResourceForProjectInput(value: unknown): CreateResourceForProjectInput {
  const input = boundaryObject(value, "Create Resource input", [
    "kind", "title", "defaultPinPolicy", "baseGraphRevision", "expectedSnapshotId",
  ]);
  return {
    kind: resourceKind(input.kind, "Resource kind"),
    title: boundaryText(input.title, "Resource title", 500),
    defaultPinPolicy: resourcePinPolicy(input.defaultPinPolicy, "Resource default pin policy"),
    baseGraphRevision: boundarySafeInteger(input.baseGraphRevision, "Resource base graph revision"),
    expectedSnapshotId: boundaryId(input.expectedSnapshotId, "Resource expected Snapshot id"),
  };
}

export function normalizeUpdateResourceForProjectInput(value: unknown): UpdateResourceForProjectInput {
  const envelope = boundaryObject(value, "Update Resource input", ["action"], [
    "title", "baseGraphRevision", "expectedSnapshotId", "expectedDefaultPinPolicy",
    "defaultPinPolicy", "consumerImpactConfirmed",
  ]);
  if (envelope.action === "rename") {
    const input = boundaryObject(value, "Rename Resource input", [
      "action", "title", "baseGraphRevision", "expectedSnapshotId",
    ]);
    return {
      action: "rename",
      title: boundaryText(input.title, "Resource title", 500),
      baseGraphRevision: boundarySafeInteger(input.baseGraphRevision, "Resource base graph revision"),
      expectedSnapshotId: boundaryId(input.expectedSnapshotId, "Resource expected Snapshot id"),
    };
  }
  if (envelope.action === "set-default-pin-policy") {
    const input = boundaryObject(value, "Resource pin policy input", [
      "action", "expectedDefaultPinPolicy", "defaultPinPolicy",
    ]);
    return {
      action: "set-default-pin-policy",
      expectedDefaultPinPolicy: resourcePinPolicy(input.expectedDefaultPinPolicy, "expected Resource pin policy"),
      defaultPinPolicy: resourcePinPolicy(input.defaultPinPolicy, "Resource pin policy"),
    };
  }
  if (envelope.action === "archive") {
    const input = boundaryObject(value, "Archive Resource input", [
      "action", "baseGraphRevision", "expectedSnapshotId", "consumerImpactConfirmed",
    ]);
    if (input.consumerImpactConfirmed !== true) {
      throw new WorkspaceStoreCodecError("Resource archive requires consumer impact confirmation");
    }
    return {
      action: "archive",
      baseGraphRevision: boundarySafeInteger(input.baseGraphRevision, "Resource base graph revision"),
      expectedSnapshotId: boundaryId(input.expectedSnapshotId, "Resource expected Snapshot id"),
      consumerImpactConfirmed: true,
    };
  }
  throw new WorkspaceStoreCodecError("Resource update action is unsupported");
}

export function normalizeCreateResourceRevisionCandidateInput(
  value: unknown,
): CreateResourceRevisionCandidateInput {
  const input = boundaryObject(value, "Resource Revision candidate", [
    "revisionId", "parentRevisionId", "manifestPath", "summary", "metadata", "checksum", "provenance",
  ], ["createdByRunId"]);
  return {
    revisionId: boundaryId(input.revisionId, "Resource Revision id"),
    parentRevisionId: input.parentRevisionId === null
      ? null
      : boundaryId(input.parentRevisionId, "Resource Revision parent id"),
    manifestPath: boundaryRelativePath(input.manifestPath, "Resource Revision manifest path"),
    summary: boundaryText(input.summary, "Resource Revision summary", 32_000),
    metadata: boundaryJsonObject(input.metadata, "Resource Revision metadata"),
    checksum: boundaryChecksum(input.checksum, "Resource Revision checksum"),
    provenance: boundaryJsonObject(input.provenance, "Resource Revision provenance"),
    createdByRunId: input.createdByRunId == null
      ? null
      : boundaryId(input.createdByRunId, "Resource Revision creating Run id"),
  };
}

export function normalizeResourcePublicationExpectation(value: unknown): ResourcePublicationExpectation {
  const input = boundaryObject(value, "Resource publication expectation", [
    "expectedHeadRevisionId", "expectedSnapshotId", "reason",
  ], ["runId", "planId", "taskId"]);
  return {
    expectedHeadRevisionId: input.expectedHeadRevisionId === null
      ? null
      : boundaryId(input.expectedHeadRevisionId, "expected Resource Head Revision id"),
    expectedSnapshotId: boundaryId(input.expectedSnapshotId, "expected Resource Snapshot id"),
    reason: boundaryText(input.reason, "Resource publication reason", 2_000),
    ...(input.runId === undefined ? {} : { runId: boundaryId(input.runId, "Resource publication Run id") }),
    ...(input.planId === undefined ? {} : { planId: boundaryId(input.planId, "Resource publication Plan id") }),
    ...(input.taskId === undefined ? {} : { taskId: boundaryId(input.taskId, "Resource publication Task id") }),
  };
}

export function normalizeContextPackTarget(value: unknown): ContextPackTarget {
  const input = boundaryObject(value, "Context Pack target", ["type", "id"]);
  if (input.type !== "workspace" && input.type !== "artifact" && input.type !== "resource") {
    throw new WorkspaceStoreCodecError("Context Pack target type is unsupported");
  }
  return { type: input.type, id: boundaryId(input.id, "Context Pack target id") };
}

export function normalizeAgentScope(value: unknown): AgentScope {
  return normalizeContextPackTarget(value);
}

function normalizeContextItemRef(value: unknown, label: string): ContextItemRef {
  const envelope = boundaryObject(value, label, ["kind", "id"], ["resourceKind", "revisionId"]);
  if (envelope.kind === "resource") {
    const input = boundaryObject(value, label, ["kind", "id", "resourceKind"], ["revisionId"]);
    return {
      kind: "resource",
      id: boundaryId(input.id, `${label} id`),
      resourceKind: resourceKind(input.resourceKind, `${label} Resource kind`),
      ...(input.revisionId === undefined
        ? {}
        : { revisionId: boundaryId(input.revisionId, `${label} Revision id`) }),
    };
  }
  if (envelope.kind === "artifact" || envelope.kind === "kernel") {
    const input = boundaryObject(value, label, ["kind", "id"], ["revisionId"]);
    return {
      kind: envelope.kind,
      id: boundaryId(input.id, `${label} id`),
      ...(input.revisionId === undefined
        ? {}
        : { revisionId: boundaryId(input.revisionId, `${label} Revision id`) }),
    };
  }
  if (envelope.kind === "inline") {
    const input = boundaryObject(value, label, ["kind", "id"]);
    return { kind: "inline", id: boundaryId(input.id, `${label} id`) };
  }
  throw new WorkspaceStoreCodecError(`${label} kind is unsupported`);
}

function agentIntent(value: unknown, label: string): AgentIntent {
  if (value === "plan" || value === "generate" || value === "edit"
    || value === "repair" || value === "analyze-impact") return value;
  throw new WorkspaceStoreCodecError(`${label} is unsupported`);
}

function normalizeContextOmission(value: unknown, index: number): ContextOmission {
  const input = boundaryObject(value, `Context omission ${index}`, ["ref", "reason", "tokenEstimate"]);
  return {
    ref: normalizeContextItemRef(input.ref, `Context omission ${index} ref`),
    reason: boundaryText(input.reason, `Context omission ${index} reason`, 2_000),
    tokenEstimate: boundarySafeInteger(input.tokenEstimate, `Context omission ${index} token estimate`),
  };
}

function resolvedContextKind(value: unknown, label: string): ResolvedContextKind {
  if (value === "artifact-revision" || value === "resource-revision" || value === "kernel-revision" || value === "inline") {
    return value;
  }
  throw new WorkspaceStoreCodecError(`${label} is unsupported`);
}

function contextTrustLevel(value: unknown, label: string): ContextTrustLevel {
  if (value === "system" || value === "trusted" || value === "untrusted") return value;
  throw new WorkspaceStoreCodecError(`${label} is unsupported`);
}

function normalizePersistContextPackItem(value: unknown, index: number): PersistContextPackItemInput {
  const label = `Context Pack item ${index}`;
  const input = boundaryObject(value, label, [
    "ref", "resolvedKind", "checksum", "reason", "trustLevel", "boundary",
    "tokenEstimate", "provenance", "provided",
  ], ["artifactRevisionId", "resourceRevisionId", "kernelRevisionId"]);
  if (typeof input.provided !== "boolean") throw new WorkspaceStoreCodecError(`${label} provided must be boolean`);
  const nullableId = (field: string): string | null => input[field] == null
    ? null
    : boundaryId(input[field], `${label} ${field}`);
  const resolvedKind = resolvedContextKind(input.resolvedKind, `${label} resolved kind`);
  const artifactRevisionId = nullableId("artifactRevisionId");
  const resourceRevisionId = nullableId("resourceRevisionId");
  const kernelRevisionId = nullableId("kernelRevisionId");
  const ownershipIsCoherent = (resolvedKind === "artifact-revision"
      && artifactRevisionId !== null && resourceRevisionId === null && kernelRevisionId === null)
    || (resolvedKind === "resource-revision"
      && artifactRevisionId === null && resourceRevisionId !== null && kernelRevisionId === null)
    || (resolvedKind === "kernel-revision"
      && artifactRevisionId === null && resourceRevisionId === null && kernelRevisionId !== null)
    || (resolvedKind === "inline"
      && artifactRevisionId === null && resourceRevisionId === null && kernelRevisionId === null);
  if (!ownershipIsCoherent) throw new WorkspaceStoreCodecError(`${label} exact Revision pin is incoherent`);
  return {
    ref: normalizeContextItemRef(input.ref, `${label} ref`),
    resolvedKind,
    artifactRevisionId,
    resourceRevisionId,
    kernelRevisionId,
    checksum: boundaryChecksum(input.checksum, `${label} checksum`),
    reason: boundaryText(input.reason, `${label} reason`, 2_000),
    trustLevel: contextTrustLevel(input.trustLevel, `${label} trust level`),
    boundary: boundaryJsonObject(input.boundary, `${label} boundary`),
    tokenEstimate: boundarySafeInteger(input.tokenEstimate, `${label} token estimate`),
    provenance: boundaryJsonObject(input.provenance, `${label} provenance`),
    provided: input.provided,
  };
}

export function normalizePersistContextPackInput(value: unknown): PersistContextPackInput {
  const input = boundaryObject(value, "Context Pack", [
    "id", "workspaceId", "graphRevision", "target", "items", "omissions",
    "intent", "messageChecksum", "tokenEstimate", "manifestPath", "hash",
  ]);
  if (!Array.isArray(input.items) || input.items.length > 2_048) {
    throw new WorkspaceStoreCodecError("Context Pack items must be a bounded array");
  }
  if (!Array.isArray(input.omissions) || input.omissions.length > 2_048) {
    throw new WorkspaceStoreCodecError("Context Pack omissions must be a bounded array");
  }
  const items = input.items.map(normalizePersistContextPackItem);
  const tokenEstimate = boundarySafeInteger(input.tokenEstimate, "Context Pack token estimate");
  let resolvedTokenEstimate = 0;
  for (const item of items) {
    if (item.tokenEstimate > Number.MAX_SAFE_INTEGER - resolvedTokenEstimate) {
      throw new WorkspaceStoreCodecError("Context Pack item token estimate total exceeds the safe integer range");
    }
    resolvedTokenEstimate += item.tokenEstimate;
  }
  if (resolvedTokenEstimate !== tokenEstimate) {
    throw new WorkspaceStoreCodecError("Context Pack token estimate must equal the resolved item total");
  }
  return {
    id: boundaryId(input.id, "Context Pack id"),
    workspaceId: boundaryId(input.workspaceId, "Context Pack Workspace id"),
    graphRevision: boundarySafeInteger(input.graphRevision, "Context Pack graph revision"),
    target: normalizeContextPackTarget(input.target),
    intent: agentIntent(input.intent, "Context Pack intent"),
    messageChecksum: boundaryChecksum(input.messageChecksum, "Context Pack message checksum"),
    items,
    omissions: input.omissions.map(normalizeContextOmission),
    tokenEstimate,
    manifestPath: boundaryRelativePath(input.manifestPath, "Context Pack manifest path"),
    hash: boundaryChecksum(input.hash, "Context Pack hash"),
  };
}

export function normalizeRecordContextPackItemUsageInput(
  value: unknown,
): RecordContextPackItemUsageInput {
  const input = boundaryObject(value, "Context Pack usage", [
    "contextPackId", "workspaceId", "ordinal", "usageKind", "evidence",
  ], ["runId"]);
  if (input.usageKind !== "observed-read" && input.usageKind !== "agent-declared-used") {
    throw new WorkspaceStoreCodecError("Context Pack usage kind is unsupported");
  }
  return {
    contextPackId: boundaryId(input.contextPackId, "Context Pack usage pack id"),
    workspaceId: boundaryId(input.workspaceId, "Context Pack usage Workspace id"),
    ordinal: boundarySafeInteger(input.ordinal, "Context Pack usage ordinal"),
    usageKind: input.usageKind,
    runId: input.runId == null ? null : boundaryId(input.runId, "Context Pack usage Run id"),
    evidence: boundaryJsonObject(input.evidence, "Context Pack usage evidence"),
  };
}

function requireWorkspace(workspace: ProjectWorkspace | null, projectId: string): ProjectWorkspace {
  if (!workspace) throw new Error(`workspace not found for project: ${projectId}`);
  return workspace;
}

function requiredCell(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUtf16(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseJsonCell(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new WorkspaceStoreCodecError(`${label} must be JSON text`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new WorkspaceStoreCodecError(`${label} must contain valid JSON`);
  }
}

function legacyTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceStoreCodecError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function legacyNullableString(value: unknown, label: string): string | null {
  return value == null ? null : requiredCell(value, label);
}

function legacyNullableText(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !isWellFormedUtf16(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be Unicode text or null`);
  }
  return value;
}

function legacyText(value: unknown, label: string): string {
  if (typeof value !== "string" || !isWellFormedUtf16(value)) {
    throw new WorkspaceStoreCodecError(`${label} must be Unicode text`);
  }
  return value;
}

function asOwnedArtifactRevision(row: Row): ArtifactRevisionRecord {
  const revision = asArtifactRevision(row);
  if (revision.artifactRoot !== requiredCell(row.owning_source_root, "owning Artifact source root")) {
    throw new WorkspaceGraphValidationError(
      `Artifact Revision ${revision.id} root does not match its owning Artifact source root`,
    );
  }
  return revision;
}

function storedTimestamp(value: unknown, label: string): number {
  return boundarySafeInteger(value, label);
}

function storedJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkspaceStoreCodecError(`${label} must be JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new WorkspaceStoreCodecError(`${label} must contain valid JSON`);
  }
  const normalized = boundaryJsonObject(parsed, label);
  if (JSON.stringify(normalized) !== value) throw new WorkspaceStoreCodecError(`${label} must be canonical JSON`);
  return normalized;
}

function storedJsonArray(value: unknown, label: string): unknown[] {
  if (typeof value !== "string") throw new WorkspaceStoreCodecError(`${label} must be JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new WorkspaceStoreCodecError(`${label} must contain valid JSON`);
  }
  const normalized = boundaryJsonValue(parsed, label, { ancestors: new WeakSet<object>(), nodes: 0, textUnits: 0 });
  if (!Array.isArray(normalized)) throw new WorkspaceStoreCodecError(`${label} must be a JSON array`);
  if (JSON.stringify(normalized) !== value) throw new WorkspaceStoreCodecError(`${label} must be canonical JSON`);
  return normalized;
}

function asResource(row: Row): Resource {
  const title = boundaryText(row.title, "Resource title", 500);
  if (title !== row.title) throw new WorkspaceStoreCodecError("Resource title must be canonical");
  if (row.archived_at !== null && row.archived_at !== undefined) {
    storedTimestamp(row.archived_at, "Resource archived_at");
  }
  return {
    id: boundaryId(row.id, "Resource id"),
    workspaceId: boundaryId(row.workspace_id, "Resource Workspace id"),
    kind: resourceKind(row.kind, "Resource kind"),
    title,
    headRevisionId: row.head_revision_id == null
      ? null
      : boundaryId(row.head_revision_id, "Resource Head Revision id"),
    defaultPinPolicy: resourcePinPolicy(row.default_pin_policy, "Resource default pin policy"),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    createdAt: storedTimestamp(row.created_at, "Resource created_at"),
    updatedAt: storedTimestamp(row.updated_at, "Resource updated_at"),
  };
}

function asResourceRevision(row: Row): ResourceRevision {
  const sequence = boundarySafeInteger(row.sequence, "Resource Revision sequence", 1);
  const summary = boundaryText(row.summary, "Resource Revision summary", 32_000);
  if (summary !== row.summary) throw new WorkspaceStoreCodecError("Resource Revision summary must be canonical");
  return {
    id: boundaryId(row.id, "Resource Revision id"),
    workspaceId: boundaryId(row.workspace_id, "Resource Revision Workspace id"),
    resourceId: boundaryId(row.resource_id, "Resource Revision Resource id"),
    sequence,
    parentRevisionId: row.parent_revision_id == null
      ? null
      : boundaryId(row.parent_revision_id, "Resource Revision parent id"),
    manifestPath: boundaryRelativePath(row.manifest_path, "Resource Revision manifest path"),
    summary,
    metadata: storedJsonObject(row.metadata_json, "Resource Revision metadata"),
    checksum: boundaryChecksum(row.checksum, "Resource Revision checksum"),
    provenance: storedJsonObject(row.provenance_json, "Resource Revision provenance"),
    createdByRunId: row.created_by_run_id == null
      ? null
      : boundaryId(row.created_by_run_id, "Resource Revision creating Run id"),
    createdAt: storedTimestamp(row.created_at, "Resource Revision created_at"),
  };
}

function asResolvedContextItem(row: Row): ResolvedContextItem {
  const ref = normalizeContextItemRef(
    storedJsonObject(row.ref_json, "Context Pack item ref"),
    "Context Pack item ref",
  );
  const resolvedKind = resolvedContextKind(row.resolved_kind, "Context Pack item resolved kind");
  if (row.provided !== 0 && row.provided !== 1) {
    throw new WorkspaceStoreCodecError("Context Pack item provided flag is invalid");
  }
  return {
    ordinal: boundarySafeInteger(row.ordinal, "Context Pack item ordinal"),
    ref,
    resolvedKind,
    artifactRevisionId: row.artifact_revision_id == null
      ? null
      : boundaryId(row.artifact_revision_id, "Context Pack Artifact Revision id"),
    resourceRevisionId: row.resource_revision_id == null
      ? null
      : boundaryId(row.resource_revision_id, "Context Pack Resource Revision id"),
    kernelRevisionId: row.kernel_revision_id == null
      ? null
      : boundaryId(row.kernel_revision_id, "Context Pack Kernel Revision id"),
    checksum: boundaryChecksum(row.checksum, "Context Pack item checksum"),
    reason: boundaryText(row.reason, "Context Pack item reason", 2_000),
    trustLevel: contextTrustLevel(row.trust_level, "Context Pack item trust level"),
    boundary: storedJsonObject(row.boundary_json, "Context Pack item boundary"),
    tokenEstimate: boundarySafeInteger(row.token_estimate, "Context Pack item token estimate"),
    provenance: storedJsonObject(row.provenance_json, "Context Pack item provenance"),
    provided: row.provided === 1,
  };
}

function asContextOmissions(value: unknown): ContextOmission[] {
  return storedJsonArray(value, "Context Pack omissions").map(normalizeContextOmission);
}

function asContextPack(row: Row, itemRows: Row[]): ContextPack {
  if (row.sealed !== 1) throw new WorkspaceStoreCodecError("Context Pack is not sealed");
  const target = normalizeContextPackTarget({ type: row.scope_type, id: row.scope_id });
  const items = itemRows.map(asResolvedContextItem);
  for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
    if (items[ordinal]?.ordinal !== ordinal) {
      throw new WorkspaceStoreCodecError("Context Pack item ordinals must be contiguous");
    }
  }
  const tokenEstimate = boundarySafeInteger(row.token_estimate, "Context Pack token estimate");
  let resolvedTokenEstimate = 0;
  for (const item of items) {
    if (item.tokenEstimate > Number.MAX_SAFE_INTEGER - resolvedTokenEstimate) {
      throw new WorkspaceStoreCodecError("Context Pack item token estimate total exceeds the safe integer range");
    }
    resolvedTokenEstimate += item.tokenEstimate;
  }
  if (resolvedTokenEstimate !== tokenEstimate) {
    throw new WorkspaceStoreCodecError("Context Pack token estimate does not match its resolved items");
  }
  return {
    id: boundaryId(row.id, "Context Pack id"),
    workspaceId: boundaryId(row.workspace_id, "Context Pack Workspace id"),
    graphRevision: boundarySafeInteger(row.graph_revision, "Context Pack graph revision"),
    target,
    intent: agentIntent(row.intent, "Context Pack intent"),
    messageChecksum: boundaryChecksum(row.message_checksum, "Context Pack message checksum"),
    items,
    omissions: asContextOmissions(row.omissions_json),
    tokenEstimate,
    manifestPath: boundaryRelativePath(row.manifest_path, "Context Pack manifest path"),
    hash: boundaryChecksum(row.hash, "Context Pack hash"),
    createdAt: storedTimestamp(row.created_at, "Context Pack created_at"),
  };
}

function contextPackMatchesPersistInput(pack: ContextPack, input: PersistContextPackInput): boolean {
  return pack.id === input.id
    && pack.workspaceId === input.workspaceId
    && pack.graphRevision === input.graphRevision
    && pack.intent === input.intent
    && pack.messageChecksum === input.messageChecksum
    && pack.tokenEstimate === input.tokenEstimate
    && pack.manifestPath === input.manifestPath
    && pack.hash === input.hash
    && isDeepStrictEqual(pack.target, input.target)
    && isDeepStrictEqual(pack.omissions, input.omissions)
    && isDeepStrictEqual(
      pack.items.map(({ ordinal: _ordinal, ...item }) => item),
      input.items,
    );
}

function asContextPackItemUsage(row: Row): ContextPackItemUsage {
  return {
    contextPackId: boundaryId(row.context_pack_id, "Context Pack usage pack id"),
    workspaceId: boundaryId(row.workspace_id, "Context Pack usage Workspace id"),
    ordinal: boundarySafeInteger(row.ordinal, "Context Pack usage ordinal"),
    sequence: boundarySafeInteger(row.sequence, "Context Pack usage sequence", 1),
    usageKind: row.usage_kind === "observed-read" || row.usage_kind === "agent-declared-used"
      ? row.usage_kind
      : (() => { throw new WorkspaceStoreCodecError("Context Pack usage kind is invalid"); })(),
    runId: row.run_id == null ? null : boundaryId(row.run_id, "Context Pack usage Run id"),
    evidence: storedJsonObject(row.evidence_json, "Context Pack usage evidence"),
    recordedAt: storedTimestamp(row.recorded_at, "Context Pack usage recorded_at"),
  };
}

function safePathSegment(value: string): string {
  if (value.length <= 90 && /^(?!\.{1,2}$)[a-z0-9_-]+$/.test(value)) return `raw-${value}`;
  return `hash-${checksum(`workspace-path-segment-v1\0${value}`)}`;
}

function artifactSourceRoot(workspaceId: string, artifactId: string): string {
  return `workspaces/${safePathSegment(workspaceId)}/artifacts/${safePathSegment(artifactId)}`;
}

function artifactHasValidSourceRoot(artifact: WorkspaceArtifactRecord): boolean {
  return artifact.legacyWrapped
    ? artifact.kind === "page" && artifact.sourceRoot === "."
    : artifact.sourceRoot === artifactSourceRoot(artifact.workspaceId, artifact.id);
}

function graphsAreSemanticallyEqual(left: WorkspaceGraph, right: WorkspaceGraph): boolean {
  const byId = <T extends { id: string }>(values: readonly T[]): T[] => (
    [...values].sort((a, b) => compareBinary(a.id, b.id))
  );
  return left.workspaceId === right.workspaceId
    && left.revision === right.revision
    && isDeepStrictEqual(byId(left.nodes), byId(right.nodes))
    && isDeepStrictEqual(byId(left.edges), byId(right.edges));
}

interface GraphCommandRow extends Row {
  workspace_id: string;
  command_id: string;
  base_revision: number;
  result_revision: number;
  expected_snapshot_id: string;
  batch_hash: string;
  batch_index: number;
  batch_size: number;
  result_snapshot_id: string;
  payload_json: string;
}

interface SnapshotArtifactOverride {
  artifactId: string;
  trackId: string;
  revisionId: string | null;
}

interface SnapshotResourceOverride {
  resourceId: string;
  revisionId: string;
}

interface SnapshotCreationInput {
  expectedSnapshotId: string;
  graphRevision: number;
  kernelRevisionId?: string;
  reason: string;
  provenance: WorkspaceSnapshotProvenance;
  artifactOverrides?: readonly SnapshotArtifactOverride[];
  resourceOverrides?: readonly SnapshotResourceOverride[];
  artifactRemovals?: readonly string[];
  resourceRemovals?: readonly string[];
  createdByRunId?: string | null;
}

interface GraphCommandsInTransactionInput {
  expectedSnapshotId: string;
  commands: readonly WorkspaceGraphCommand[];
  reason: string;
  provenance: WorkspaceSnapshotProvenance;
}

export interface WorkspaceProposalConflictSummary {
  graphChanged: boolean;
  snapshotChanged: boolean;
  layoutChanged: boolean;
  expectedGraphRevision: number;
  actualGraphRevision: number;
  expectedSnapshotId: string;
  actualSnapshotId: string;
  expectedLayoutChecksum: string;
  actualLayoutChecksum: string;
}

interface ProposalConflictOutcome {
  kind: "conflict";
  proposal: WorkspaceProposal;
  summary: WorkspaceProposalConflictSummary;
}

interface ProposalApprovedOutcome {
  kind: "approved";
  result: ApprovedProposalResult;
}

type WorkspaceSnapshotBaseRecord = ReturnType<typeof asWorkspaceSnapshotBase>;

interface WorkspaceReadContext {
  artifactRevisions: Map<string, ArtifactRevisionRecord>;
  validatedArtifactRevisionIds: Set<string>;
  visitingArtifactRevisionIds: Set<string>;
  resourceRevisions: Map<string, ResourceRevision>;
  validatedResourceRevisionIds: Set<string>;
  visitingResourceRevisionIds: Set<string>;
  kernelRevisions: Map<string, SharedDesignKernelRevision>;
  validatedKernelRevisionIds: Set<string>;
  visitingKernelRevisionIds: Set<string>;
  snapshotBases: Map<string, WorkspaceSnapshotBaseRecord>;
  validatedSnapshotBaseIds: Set<string>;
  visitingSnapshotBaseIds: Set<string>;
  snapshotRecords: Map<string, WorkspaceSnapshotRecord>;
  visitingSnapshotRecordIds: Set<string>;
}

function createWorkspaceReadContext(): WorkspaceReadContext {
  return {
    artifactRevisions: new Map(),
    validatedArtifactRevisionIds: new Set(),
    visitingArtifactRevisionIds: new Set(),
    resourceRevisions: new Map(),
    validatedResourceRevisionIds: new Set(),
    visitingResourceRevisionIds: new Set(),
    kernelRevisions: new Map(),
    validatedKernelRevisionIds: new Set(),
    visitingKernelRevisionIds: new Set(),
    snapshotBases: new Map(),
    validatedSnapshotBaseIds: new Set(),
    visitingSnapshotBaseIds: new Set(),
    snapshotRecords: new Map(),
    visitingSnapshotRecordIds: new Set(),
  };
}

export type WorkspacePointerKind =
  | "artifact-head"
  | "resource-head"
  | "resource-pin-policy"
  | "kernel-head"
  | "active-snapshot";

export class WorkspacePointerConflictError extends Error {
  readonly pointer: WorkspacePointerKind;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly expectedId: string | null;
  readonly actualId: string | null;

  constructor(input: {
    pointer: WorkspacePointerKind;
    workspaceId: string;
    ownerId: string;
    expectedId: string | null;
    actualId: string | null;
  }) {
    super(`${input.pointer} conflict for ${input.ownerId}: expected ${input.expectedId ?? "null"}, current ${input.actualId ?? "null"}`);
    this.name = "WorkspacePointerConflictError";
    this.pointer = input.pointer;
    this.workspaceId = input.workspaceId;
    this.ownerId = input.ownerId;
    this.expectedId = input.expectedId;
    this.actualId = input.actualId;
  }
}

export class WorkspaceResourceNotFoundError extends Error {
  readonly resourceId: string;

  constructor(resourceId: string) {
    super(`Resource not found: ${resourceId}`);
    this.name = "WorkspaceResourceNotFoundError";
    this.resourceId = resourceId;
  }
}

export class WorkspaceResourceOwnershipError extends Error {
  readonly resourceId: string;
  readonly expectedProjectId: string;
  readonly actualProjectId: string;

  constructor(resourceId: string, expectedProjectId: string, actualProjectId: string) {
    super(`Resource ${resourceId} belongs to another Project`);
    this.name = "WorkspaceResourceOwnershipError";
    this.resourceId = resourceId;
    this.expectedProjectId = expectedProjectId;
    this.actualProjectId = actualProjectId;
  }
}

export class LegacyWorkspaceSeedDriftError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`legacy Workspace seed changed before publication: ${projectId}`);
    this.name = "LegacyWorkspaceSeedDriftError";
    this.projectId = projectId;
  }
}

export class WorkspaceLayoutConflictError extends WorkspaceRevisionConflictError {
  readonly expectedLayoutChecksum: string;
  readonly actualLayoutChecksum: string;

  constructor(graphRevision: number, expectedLayoutChecksum: string, actualLayoutChecksum: string) {
    super(graphRevision, graphRevision);
    this.name = "WorkspaceLayoutConflictError";
    this.message = `workspace layout conflict: expected ${expectedLayoutChecksum}, current ${actualLayoutChecksum}`;
    this.expectedLayoutChecksum = expectedLayoutChecksum;
    this.actualLayoutChecksum = actualLayoutChecksum;
  }
}

export class WorkspaceProposalNotFoundError extends Error {
  readonly proposalId: string;

  constructor(proposalId: string) {
    super(`Workspace Proposal not found: ${proposalId}`);
    this.name = "WorkspaceProposalNotFoundError";
    this.proposalId = proposalId;
  }
}

export class WorkspaceProposalOwnershipError extends Error {
  readonly proposalId: string;
  readonly expectedProjectId: string;
  readonly actualProjectId: string;

  constructor(proposalId: string, expectedProjectId: string, actualProjectId: string) {
    super(`Workspace Proposal ${proposalId} belongs to another Project`);
    this.name = "WorkspaceProposalOwnershipError";
    this.proposalId = proposalId;
    this.expectedProjectId = expectedProjectId;
    this.actualProjectId = actualProjectId;
  }
}

export class WorkspaceProposalRevisionConflictError extends Error {
  readonly proposalId: string;
  readonly expectedProposalRevision: number;
  readonly actualProposalRevision: number;

  constructor(proposalId: string, expectedProposalRevision: number, actualProposalRevision: number) {
    super(`Workspace Proposal revision conflict for ${proposalId}: expected ${expectedProposalRevision}, current ${actualProposalRevision}`);
    this.name = "WorkspaceProposalRevisionConflictError";
    this.proposalId = proposalId;
    this.expectedProposalRevision = expectedProposalRevision;
    this.actualProposalRevision = actualProposalRevision;
  }
}

export class WorkspaceProposalStateConflictError extends Error {
  readonly proposalId: string;
  readonly status: WorkspaceProposal["status"];

  constructor(proposalId: string, status: WorkspaceProposal["status"]) {
    super(`Workspace Proposal ${proposalId} is ${status} and is not editable`);
    this.name = "WorkspaceProposalStateConflictError";
    this.proposalId = proposalId;
    this.status = status;
  }
}

export class WorkspaceProposalValidationError extends WorkspaceGraphValidationError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceProposalValidationError";
  }
}

export class WorkspaceProposalConflictError extends WorkspaceRevisionConflictError {
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly summary: WorkspaceProposalConflictSummary;

  constructor(proposal: WorkspaceProposal, summary: WorkspaceProposalConflictSummary) {
    super(summary.expectedGraphRevision, summary.actualGraphRevision, {
      expectedSnapshotId: summary.expectedSnapshotId,
      actualSnapshotId: summary.actualSnapshotId,
    });
    this.name = "WorkspaceProposalConflictError";
    this.proposalId = proposal.id;
    this.proposalRevision = proposal.revision;
    this.summary = summary;
  }
}

export class GenerationPlanNotFoundError extends Error {
  readonly planId: string;

  constructor(planId: string) {
    super(`Generation Plan not found: ${planId}`);
    this.name = "GenerationPlanNotFoundError";
    this.planId = planId;
  }
}

export class GenerationPlanOwnershipError extends Error {
  readonly planId: string;
  readonly expectedProjectId: string;
  readonly actualProjectId: string;

  constructor(planId: string, expectedProjectId: string, actualProjectId: string) {
    super(`Generation Plan ${planId} belongs to another Project`);
    this.name = "GenerationPlanOwnershipError";
    this.planId = planId;
    this.expectedProjectId = expectedProjectId;
    this.actualProjectId = actualProjectId;
  }
}

export class GenerationPlanStateConflictError extends Error {
  readonly planId: string;
  readonly status: GenerationPlan["status"];

  constructor(planId: string, status: GenerationPlan["status"]) {
    super(`Generation Plan ${planId} is ${status}, expected approved`);
    this.name = "GenerationPlanStateConflictError";
    this.planId = planId;
    this.status = status;
  }
}

export class GenerationTaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Generation Task not found: ${taskId}`);
    this.name = "GenerationTaskNotFoundError";
    this.taskId = taskId;
  }
}

export class GenerationTaskMaterializationConflictError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(`Generation Task ${taskId} materialization conflict: ${message}`);
    this.name = "GenerationTaskMaterializationConflictError";
    this.taskId = taskId;
  }
}

export class GenerationTaskLeaseFenceError extends Error {
  readonly taskId: string;
  readonly attempt: number;

  constructor(taskId: string, attempt: number, message: string) {
    super(`Generation Task ${taskId}/${attempt} lease fence rejected: ${message}`);
    this.name = "GenerationTaskLeaseFenceError";
    this.taskId = taskId;
    this.attempt = attempt;
  }
}

export class WorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly clock: StoreClock;
  private activeReadContext: WorkspaceReadContext | null = null;

  constructor(db: DatabaseSync, clock: StoreClock) {
    this.db = db;
    this.clock = clock;
  }

  readLegacyStandardWorkspaceFacts(projectId: string): LegacyWorkspaceFacts {
    return this.transactionRead(() => {
      const project = this.db.prepare(
        `SELECT id, name, skill_id, design_system_id, mode, sharingan, source_url,
                created_at, updated_at, archived_at, active_variant_id
         FROM projects WHERE id = ?`,
      ).get(projectId) as Row | undefined;
      if (!project) throw new Error(`project not found: ${projectId}`);
      const variants = this.db.prepare(
        `SELECT id, project_id, name, created_at
         FROM variants WHERE project_id = ?
         ORDER BY created_at ASC, id COLLATE BINARY ASC`,
      ).all(projectId) as Row[];
      const successfulRuns = this.db.prepare(
        `SELECT id, project_id, variant_id, status, commit_hash, created_at, finished_at
         FROM runs WHERE project_id = ? AND status = 'succeeded'
         ORDER BY created_at ASC, id COLLATE BINARY ASC`,
      ).all(projectId) as Row[];
      if (project.mode !== "standard" && project.mode !== "prototype" && project.mode != null) {
        throw new WorkspaceStoreCodecError("legacy Project mode must be standard prototype or null");
      }
      if (project.sharingan !== 0 && project.sharingan !== 1) {
        throw new WorkspaceStoreCodecError("legacy Project sharingan must be zero or one");
      }
      return {
        project: {
          id: requiredCell(project.id, "legacy Project id"),
          name: legacyText(project.name, "legacy Project name"),
          mode: project.mode === "standard" ? "standard" : "prototype",
          skillId: legacyNullableText(project.skill_id, "legacy Project skill id"),
          designSystemId: legacyNullableText(project.design_system_id, "legacy Project design system id"),
          sharingan: project.sharingan === 1,
          sourceUrl: legacyNullableText(project.source_url, "legacy Project source URL"),
          createdAt: legacyTimestamp(project.created_at, "legacy Project created_at"),
          updatedAt: legacyTimestamp(project.updated_at, "legacy Project updated_at"),
          archivedAt: project.archived_at == null
            ? null
            : legacyTimestamp(project.archived_at, "legacy Project archived_at"),
          activeVariantId: legacyNullableString(project.active_variant_id, "legacy active Variant id"),
        },
        variants: variants.map((variant) => ({
          id: requiredCell(variant.id, "legacy Variant id"),
          projectId: requiredCell(variant.project_id, "legacy Variant Project id"),
          name: legacyText(variant.name, "legacy Variant name"),
          createdAt: legacyTimestamp(variant.created_at, "legacy Variant created_at"),
        })),
        successfulRuns: successfulRuns.map((run) => ({
          id: requiredCell(run.id, "legacy Run id"),
          projectId: requiredCell(run.project_id, "legacy Run Project id"),
          variantId: run.variant_id == null ? null : requiredCell(run.variant_id, "legacy Run Variant id"),
          status: "succeeded",
          commitHash: legacyNullableText(run.commit_hash, "legacy Run commit hash"),
          createdAt: legacyTimestamp(run.created_at, "legacy Run created_at"),
          finishedAt: run.finished_at == null ? null : legacyTimestamp(run.finished_at, "legacy Run finished_at"),
        })),
      };
    });
  }

  getBundleByProjectId(projectId: string): WorkspaceBundle | null {
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return null;
      const graph = this.getGraph(projectId);
      const snapshots = this.listSnapshots(projectId);
      const activeSnapshot = snapshots.find((snapshot) => snapshot.id === workspace.activeSnapshotId);
      if (!activeSnapshot) throw new WorkspaceGraphValidationError("Workspace active Snapshot is not resolvable");
      const activeKernelRevision = this.requireKernelRevision(workspace.activeKernelRevisionId);
      const artifacts = this.listArtifacts(projectId);
      if (artifacts.some((artifact) => artifact.legacyWrapped) && workspace.mode !== "standard") {
        throw new WorkspaceGraphValidationError("legacy-wrapped Workspace must belong to a Standard Project");
      }
      const tracks = artifacts.flatMap((artifact) => this.listTracks(projectId, artifact.id));
      const revisions = artifacts.flatMap((artifact) => this.listRevisions(projectId, artifact.id));
      const bundle = { workspace, graph, activeSnapshot, activeKernelRevision, artifacts, tracks, revisions, snapshots };
      if (artifacts.some((artifact) => artifact.legacyWrapped)) {
        this.requireCompletedLegacyStandardWorkspaceBundle(bundle);
      }
      return bundle;
    });
  }

  ensureLegacyStandardWorkspace(unsafeSeed: LegacyWorkspaceSeed): WorkspaceBundle {
    const seed = normalizeLegacyWorkspaceSeed(unsafeSeed);
    return this.transactionImmediate(() => {
      let workspace = this.getWorkspace(seed.project.id);
      if (workspace) {
        const wrapped = this.db.prepare(
          "SELECT 1 FROM workspace_artifacts WHERE workspace_id = ? AND legacy_wrapped = 1 LIMIT 1",
        ).get(workspace.id);
        if (wrapped) {
          const existing = this.getBundleByProjectId(seed.project.id);
          if (!existing || existing.workspace.mode !== "standard") {
            throw new WorkspaceGraphValidationError("legacy-wrapped Workspace is not a valid Standard Workspace");
          }
          return existing;
        }
      }

      const currentFacts = this.readLegacyStandardWorkspaceFacts(seed.project.id);
      const expectedFacts: LegacyWorkspaceFacts = {
        project: seed.project,
        variants: seed.variants,
        successfulRuns: seed.successfulRuns.map(({ gitSnapshot: _gitSnapshot, ...run }) => run),
      };
      if (!isDeepStrictEqual(currentFacts, expectedFacts)) {
        throw new LegacyWorkspaceSeedDriftError(seed.project.id);
      }
      const knownVariantIds = new Set(seed.variants.map((variant) => variant.id));
      for (const run of seed.successfulRuns) {
        if (run.variantId !== null && !knownVariantIds.has(run.variantId)) {
          throw new WorkspaceGraphValidationError(`legacy Run ${run.id} references an unknown Variant`);
        }
      }

      if (!workspace) {
        workspace = this.insertWorkspaceFoundationInTransaction(seed.project.id);
      } else {
        this.requireEmptyWorkspaceFoundation(workspace);
      }

      const now = this.clock.now();
      const artifactId = this.clock.id();
      const nodeId = this.clock.id();
      this.db.prepare(
        `INSERT INTO workspace_artifacts (
           id, workspace_id, kind, name, source_root, legacy_wrapped,
           active_track_id, archived_at, created_at, updated_at
         ) VALUES (?, ?, 'page', ?, '.', 1, NULL, NULL, ?, ?)`,
      ).run(artifactId, workspace.id, seed.project.name.trim() || "Legacy page", now, now);

      const tracksByVariant = new Map<string, string>();
      const trackIds: string[] = [];
      for (const variant of seed.variants) {
        const trackId = this.clock.id();
        this.db.prepare(
          `INSERT INTO artifact_tracks
             (id, artifact_id, name, head_revision_id, legacy_variant_id, created_at)
           VALUES (?, ?, ?, NULL, ?, ?)`,
        ).run(
          trackId,
          artifactId,
          variant.name.trim() || `Legacy variant ${variant.id}`,
          variant.id,
          variant.createdAt,
        );
        tracksByVariant.set(variant.id, trackId);
        trackIds.push(trackId);
      }
      const needsUnassigned = seed.variants.length === 0
        || seed.successfulRuns.some((run) => run.variantId === null && run.gitSnapshot.status === "verified");
      let unassignedTrackId: string | null = null;
      if (needsUnassigned) {
        unassignedTrackId = this.clock.id();
        this.db.prepare(
          `INSERT INTO artifact_tracks
             (id, artifact_id, name, head_revision_id, legacy_variant_id, created_at)
           VALUES (?, ?, 'Legacy unassigned', NULL, NULL, ?)`,
        ).run(unassignedTrackId, artifactId, now);
        trackIds.push(unassignedTrackId);
      }

      let activeTrackId: string | null = null;
      if (seed.project.activeVariantId !== null) {
        activeTrackId = tracksByVariant.get(seed.project.activeVariantId) ?? null;
      }
      const firstVariant = seed.variants[0];
      if (activeTrackId === null && firstVariant) {
        activeTrackId = tracksByVariant.get(firstVariant.id) ?? null;
      }
      if (activeTrackId === null) activeTrackId = unassignedTrackId;
      if (activeTrackId === null) throw new WorkspaceGraphValidationError("legacy Page has no selectable Track");

      const runsByTrack = new Map<string, typeof seed.successfulRuns>();
      for (const trackId of trackIds) runsByTrack.set(trackId, []);
      for (const run of seed.successfulRuns) {
        if (run.gitSnapshot.status !== "verified") continue;
        const trackId = run.variantId === null ? unassignedTrackId : tracksByVariant.get(run.variantId) ?? null;
        if (trackId === null) throw new WorkspaceGraphValidationError(`legacy Run ${run.id} has no Track`);
        runsByTrack.get(trackId)!.push(run);
      }
      for (const [trackId, runs] of runsByTrack) {
        let parentRevisionId: string | null = null;
        for (let index = 0; index < runs.length; index += 1) {
          const run = runs[index]!;
          if (run.gitSnapshot.status !== "verified") continue;
          const revisionId = this.clock.id();
          this.db.prepare(
            `INSERT INTO artifact_revisions (
               id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
               source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
               render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
               legacy_run_id, created_at, sealed
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '.', ?, ?, ?, NULL, NULL, ?, ?, 0)`,
          ).run(
            revisionId,
            workspace.id,
            artifactId,
            trackId,
            index + 1,
            parentRevisionId,
            run.gitSnapshot.sourceCommitHash,
            run.gitSnapshot.sourceTreeHash,
            workspace.activeKernelRevisionId,
            JSON.stringify({ frames: [] }),
            JSON.stringify({ state: "unassessed", score: null, findings: [] }),
            run.id,
            run.createdAt,
          );
          this.requireOneChange(
            this.db.prepare("UPDATE artifact_revisions SET sealed = 1 WHERE id = ? AND sealed = 0").run(revisionId),
            `seal legacy Artifact Revision ${revisionId}`,
          );
          this.requireOneChange(
            this.db.prepare("UPDATE artifact_tracks SET head_revision_id = ? WHERE id = ? AND head_revision_id IS ?")
              .run(revisionId, trackId, parentRevisionId),
            `advance legacy Artifact Track ${trackId}`,
          );
          parentRevisionId = revisionId;
        }
      }

      this.requireOneChange(
        this.db.prepare("UPDATE workspace_artifacts SET active_track_id = ? WHERE id = ? AND active_track_id IS NULL")
          .run(activeTrackId, artifactId),
        `activate legacy Artifact Track ${activeTrackId}`,
      );
      this.db.prepare(
        `INSERT INTO workspace_nodes
           (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
         VALUES (?, ?, 'page', ?, NULL, NULL, ?, ?)`,
      ).run(nodeId, workspace.id, artifactId, now, now);
      const graph: WorkspaceGraph = {
        workspaceId: workspace.id,
        revision: 1,
        nodes: this.listNodes(workspace.id),
        edges: this.listEdges(workspace.id),
      };
      validateWorkspaceGraph(graph);
      this.insertImmutableGraphRevision(graph);
      const activeHead = this.requireTrack(activeTrackId).headRevisionId;
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: workspace.activeSnapshotId,
        graphRevision: 1,
        reason: "legacy-standard-wrap",
        provenance: { kind: "legacy-migration", migration: "legacy-standard-v1" },
        artifactOverrides: [{ artifactId, trackId: activeTrackId, revisionId: activeHead }],
      });
      this.requireOneChange(
        this.db.prepare(
          `UPDATE project_workspaces
           SET graph_revision = 1, active_snapshot_id = ?, updated_at = ?
           WHERE id = ? AND graph_revision = 0 AND active_snapshot_id = ? AND active_kernel_revision_id = ?`,
        ).run(
          snapshot.id,
          this.clock.now(),
          workspace.id,
          workspace.activeSnapshotId,
          workspace.activeKernelRevisionId,
        ),
        `activate legacy Workspace Snapshot ${snapshot.id}`,
      );
      const bundle = this.getBundleByProjectId(seed.project.id);
      if (!bundle) throw new WorkspaceGraphValidationError("legacy Workspace bundle was not published");
      return bundle;
    });
  }

  ensureWorkspaceRecord(projectId: string): ProjectWorkspace {
    const existing = this.getWorkspace(projectId);
    if (existing) return existing;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const concurrent = this.getWorkspace(projectId);
      if (concurrent) {
        this.db.exec("COMMIT");
        return concurrent;
      }
      this.insertWorkspaceFoundationInTransaction(projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the seed error if SQLite already ended the transaction.
      }
      throw error;
    }

    return requireWorkspace(this.getWorkspace(projectId), projectId);
  }

  getWorkspace(projectId: string): ProjectWorkspace | null {
    const row = this.db.prepare(
      `SELECT w.*, p.mode
       FROM project_workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE w.project_id = ?`,
    ).get(projectId) as Row | undefined;
    return row ? asProjectWorkspace(row) : null;
  }

  getGraph(projectId: string): WorkspaceGraph {
    return this.transactionRead(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const graph: WorkspaceGraph = {
        workspaceId: workspace.id,
        revision: workspace.graphRevision,
        nodes: this.listNodes(workspace.id),
        edges: this.listEdges(workspace.id),
      };
      validateWorkspaceGraph(graph);
      const immutable = this.requireGraphRevision(workspace.id, workspace.graphRevision);
      if (!graphsAreSemanticallyEqual(graph, immutable)) {
        throw new WorkspaceGraphValidationError(
          "mutable workspace graph does not match immutable graph revision",
        );
      }
      return graph;
    });
  }

  getGraphRevision(projectId: string, revision: number): WorkspaceGraph {
    const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
    return this.requireGraphRevision(workspace.id, revision);
  }

  listResources(projectId: string, options: { includeArchived?: boolean } = {}): Resource[] {
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return [];
      const rows = this.db.prepare(
        `SELECT * FROM resources
         WHERE workspace_id = ? ${options.includeArchived ? "" : "AND archived_at IS NULL"}
         ORDER BY created_at ASC, id COLLATE BINARY ASC`,
      ).all(workspace.id) as Row[];
      return rows.map(asResource);
    });
  }

  getResourceForProject(projectId: string, resourceId: string): Resource | null {
    return this.transactionRead(() => {
      const row = this.db.prepare(
        `SELECT resource.*, workspace.project_id
         FROM resources resource
         JOIN project_workspaces workspace ON workspace.id = resource.workspace_id
         WHERE resource.id = ?`,
      ).get(resourceId) as Row | undefined;
      if (!row) return null;
      const actualProjectId = requiredCell(row.project_id, "Resource owning Project id");
      if (actualProjectId !== projectId) {
        throw new WorkspaceResourceOwnershipError(resourceId, projectId, actualProjectId);
      }
      return asResource(row);
    });
  }

  createResourceForProject(
    projectId: string,
    unsafeInput: CreateResourceForProjectInput,
  ): CreateResourceForProjectResult {
    const input = normalizeCreateResourceForProjectInput(unsafeInput);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const current = this.getGraph(projectId);
      if (current.revision !== input.baseGraphRevision) {
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, current.revision);
      }
      const resourceId = this.clock.id();
      const nodeId = this.clock.id();
      const commandId = this.clock.id();
      const normalized = normalizeWorkspaceGraphMutationInput({
        baseGraphRevision: input.baseGraphRevision,
        expectedSnapshotId: input.expectedSnapshotId,
        commands: [{
          id: commandId,
          type: "add-node",
          node: {
            id: nodeId,
            kind: "resource",
            name: input.title,
            resourceId,
            createIdentity: {
              resourceKind: input.kind,
              defaultPinPolicy: input.defaultPinPolicy,
            },
          },
        }],
      });
      const result = this.applyGraphCommandsInTransaction(workspace, current, {
        expectedSnapshotId: normalized.expectedSnapshotId,
        commands: normalized.commands,
        reason: "resource-created",
        provenance: { kind: "graph-command", commandIds: [commandId] },
      });
      const resource = this.getResourceForProject(projectId, resourceId);
      const node = result.graph.nodes.find(
        (candidate): candidate is WorkspaceResourceNode => candidate.kind === "resource" && candidate.id === nodeId,
      );
      if (!resource || !node) throw new WorkspaceGraphValidationError("created Resource graph identity is not resolvable");
      return { resource, node, graph: result.graph, snapshot: result.snapshot };
    });
  }

  updateResourceForProject(
    projectId: string,
    resourceId: string,
    unsafeInput: Extract<UpdateResourceForProjectInput, { action: "rename" }>,
  ): { action: "rename"; resource: Resource; graph: WorkspaceGraph; snapshot: WorkspaceSnapshotRecord };
  updateResourceForProject(
    projectId: string,
    resourceId: string,
    unsafeInput: Extract<UpdateResourceForProjectInput, { action: "archive" }>,
  ): { action: "archive"; resource: Resource; graph: WorkspaceGraph; snapshot: WorkspaceSnapshotRecord };
  updateResourceForProject(
    projectId: string,
    resourceId: string,
    unsafeInput: Extract<UpdateResourceForProjectInput, { action: "set-default-pin-policy" }>,
  ): { action: "set-default-pin-policy"; resource: Resource };
  updateResourceForProject(
    projectId: string,
    resourceId: string,
    unsafeInput: UpdateResourceForProjectInput,
  ): UpdateResourceForProjectResult {
    const input = normalizeUpdateResourceForProjectInput(unsafeInput);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const resource = this.requireResourceForProject(projectId, resourceId);
      if (resource.archivedAt !== null) throw new WorkspaceGraphValidationError(`Resource ${resourceId} is archived`);
      if (input.action === "set-default-pin-policy") {
        this.guardPointer({
          pointer: "resource-pin-policy",
          workspaceId: workspace.id,
          ownerId: resource.id,
          expectedId: input.expectedDefaultPinPolicy,
          actualId: resource.defaultPinPolicy,
        });
        const updated = this.db.prepare(
          `UPDATE resources SET default_pin_policy = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND default_pin_policy = ? AND archived_at IS NULL`,
        ).run(input.defaultPinPolicy, this.clock.now(), resource.id, workspace.id, input.expectedDefaultPinPolicy);
        if (Number(updated.changes) !== 1) {
          const actual = this.requireResourceForProject(projectId, resourceId);
          throw new WorkspacePointerConflictError({
            pointer: "resource-pin-policy",
            workspaceId: workspace.id,
            ownerId: resource.id,
            expectedId: input.expectedDefaultPinPolicy,
            actualId: actual.defaultPinPolicy,
          });
        }
        return {
          action: "set-default-pin-policy",
          resource: this.requireResourceForProject(projectId, resourceId),
        };
      }

      const current = this.getGraph(projectId);
      if (current.revision !== input.baseGraphRevision) {
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, current.revision);
      }
      const node = current.nodes.find(
        (candidate): candidate is WorkspaceResourceNode => (
          candidate.kind === "resource" && candidate.resourceId === resourceId
        ),
      );
      if (!node) throw new WorkspaceGraphValidationError(`Resource ${resourceId} has no active graph node`);
      const commandId = this.clock.id();
      const command: WorkspaceGraphCommand = input.action === "rename"
        ? { id: commandId, type: "rename-node", nodeId: node.id, name: input.title }
        : { id: commandId, type: "archive-node", nodeId: node.id };
      const normalized = normalizeWorkspaceGraphMutationInput({
        baseGraphRevision: input.baseGraphRevision,
        expectedSnapshotId: input.expectedSnapshotId,
        commands: [command],
      });
      const result = this.applyGraphCommandsInTransaction(workspace, current, {
        expectedSnapshotId: normalized.expectedSnapshotId,
        commands: normalized.commands,
        reason: input.action === "rename" ? "resource-renamed" : "resource-archived",
        provenance: { kind: "graph-command", commandIds: [commandId] },
      });
      return {
        action: input.action,
        resource: this.requireResourceForProject(projectId, resourceId),
        graph: result.graph,
        snapshot: result.snapshot,
      };
    });
  }

  getResourceRevisionForProject(
    projectId: string,
    resourceId: string,
    revisionId: string,
  ): ResourceRevision | null {
    return this.transactionRead(() => {
      this.requireResourceForProject(projectId, resourceId);
      const row = this.db.prepare(
        "SELECT * FROM resource_revisions WHERE id = ?",
      ).get(revisionId) as Row | undefined;
      if (!row) return null;
      const revision = asResourceRevision(row);
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      if (revision.workspaceId !== workspace.id || revision.resourceId !== resourceId) {
        throw new WorkspaceResourceOwnershipError(resourceId, projectId, this.projectIdForWorkspace(revision.workspaceId));
      }
      this.validateResourceRevisionLineage(revision);
      return revision;
    });
  }

  listResourceRevisions(projectId: string, resourceId: string): ResourceRevision[] {
    return this.transactionRead(() => {
      const resource = this.requireResourceForProject(projectId, resourceId);
      const rows = this.db.prepare(
        `SELECT * FROM resource_revisions
         WHERE workspace_id = ? AND resource_id = ?
         ORDER BY sequence ASC, id COLLATE BINARY ASC`,
      ).all(resource.workspaceId, resourceId) as Row[];
      const revisions = rows.map(asResourceRevision);
      for (const revision of revisions) this.validateResourceRevisionLineage(revision);
      return revisions;
    });
  }

  createResourceRevisionCandidateForProject(
    projectId: string,
    resourceId: string,
    unsafeInput: CreateResourceRevisionCandidateInput,
  ): ResourceRevision {
    const input = normalizeCreateResourceRevisionCandidateInput(unsafeInput);
    return this.transactionImmediate(() => {
      const resource = this.requireResourceForProject(projectId, resourceId);
      if (resource.archivedAt !== null) throw new WorkspaceGraphValidationError(`Resource ${resource.id} is archived`);
      this.guardPointer({
        pointer: "resource-head",
        workspaceId: resource.workspaceId,
        ownerId: resource.id,
        expectedId: input.parentRevisionId,
        actualId: resource.headRevisionId,
      });
      if (this.db.prepare("SELECT 1 FROM resource_revisions WHERE id = ?").get(input.revisionId)) {
        throw new WorkspaceGraphValidationError(`Resource Revision identity collision: ${input.revisionId}`);
      }
      this.validateRunOwnership(resource.workspaceId, input.createdByRunId ?? null, "Resource Revision");
      const sequence = this.nextSafeSequence(
        "resource_revisions",
        "resource_id",
        resource.id,
        "Resource Revision",
      );
      this.db.prepare(
        `INSERT INTO resource_revisions (
           id, workspace_id, resource_id, sequence, parent_revision_id, manifest_path, summary,
           metadata_json, checksum, provenance_json, created_by_run_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.revisionId,
        resource.workspaceId,
        resource.id,
        sequence,
        input.parentRevisionId,
        input.manifestPath,
        input.summary,
        canonicalJsonText(input.metadata, "Resource Revision metadata"),
        input.checksum,
        canonicalJsonText(input.provenance, "Resource Revision provenance"),
        input.createdByRunId ?? null,
        this.clock.now(),
      );
      return this.requireResourceRevision(input.revisionId);
    });
  }

  publishResourceRevisionForProject(
    projectId: string,
    resourceId: string,
    revisionId: string,
    unsafeExpected: ResourcePublicationExpectation,
  ): WorkspaceSnapshotRecord {
    const expected = normalizeResourcePublicationExpectation(unsafeExpected);
    return this.transactionImmediate(() => {
      const resource = this.requireResourceForProject(projectId, resourceId);
      if (resource.archivedAt !== null) throw new WorkspaceGraphValidationError(`Resource ${resource.id} is archived`);
      const revision = this.requireResourceRevision(revisionId);
      if (revision.workspaceId !== resource.workspaceId || revision.resourceId !== resource.id) {
        throw new WorkspaceGraphValidationError("Resource Revision belongs to another Resource or Workspace");
      }
      this.guardPointer({
        pointer: "resource-head",
        workspaceId: resource.workspaceId,
        ownerId: resource.id,
        expectedId: expected.expectedHeadRevisionId,
        actualId: resource.headRevisionId,
      });
      if (revision.parentRevisionId !== expected.expectedHeadRevisionId) {
        throw new WorkspaceGraphValidationError("Resource Revision parent does not match the expected Head");
      }
      if (expected.runId !== undefined && expected.runId !== revision.createdByRunId) {
        throw new WorkspaceGraphValidationError("Resource publication Run does not match candidate provenance");
      }
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: expected.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      const parent = this.requireSnapshot(workspace.id, expected.expectedSnapshotId);
      const parentPin = parent.resourceRevisions[resource.id] ?? null;
      if (parentPin !== expected.expectedHeadRevisionId) {
        throw new WorkspaceGraphValidationError("Resource Head and base Snapshot pin are incoherent");
      }
      const graphNode = parent.graph.nodes.find(
        (node) => node.kind === "resource" && node.resourceId === resource.id,
      );
      if (!graphNode) throw new WorkspaceGraphValidationError("Resource publication requires an active graph node");
      const movedHead = this.db.prepare(
        `UPDATE resources SET head_revision_id = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND head_revision_id IS ? AND archived_at IS NULL`,
      ).run(revision.id, this.clock.now(), resource.id, workspace.id, expected.expectedHeadRevisionId);
      if (Number(movedHead.changes) !== 1) {
        const actual = this.requireResourceForProject(projectId, resourceId);
        throw new WorkspacePointerConflictError({
          pointer: "resource-head",
          workspaceId: workspace.id,
          ownerId: resource.id,
          expectedId: expected.expectedHeadRevisionId,
          actualId: actual.headRevisionId,
        });
      }
      const provenance: Extract<WorkspaceSnapshotProvenance, { kind: "resource-publication" }> = {
        kind: "resource-publication",
        resourceRevisionId: revision.id,
        ...(revision.createdByRunId === null ? {} : { runId: revision.createdByRunId }),
        ...(expected.planId === undefined ? {} : { planId: expected.planId }),
        ...(expected.taskId === undefined ? {} : { taskId: expected.taskId }),
      };
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: expected.expectedSnapshotId,
        graphRevision: workspace.graphRevision,
        reason: expected.reason,
        provenance,
        resourceOverrides: [{ resourceId: resource.id, revisionId: revision.id }],
        createdByRunId: revision.createdByRunId,
      });
      const movedSnapshot = this.db.prepare(
        `UPDATE project_workspaces SET active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND active_snapshot_id = ? AND graph_revision = ? AND active_kernel_revision_id = ?`,
      ).run(
        snapshot.id,
        this.clock.now(),
        workspace.id,
        expected.expectedSnapshotId,
        workspace.graphRevision,
        workspace.activeKernelRevisionId,
      );
      if (Number(movedSnapshot.changes) !== 1) {
        const actual = this.requireWorkspaceById(workspace.id);
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          workspaceId: workspace.id,
          ownerId: workspace.id,
          expectedId: expected.expectedSnapshotId,
          actualId: actual.activeSnapshotId,
        });
      }
      return snapshot;
    });
  }

  persistContextPack(unsafeInput: PersistContextPackInput): ContextPack {
    const input = normalizePersistContextPackInput(unsafeInput);
    return this.transactionImmediate(() => {
      this.requireWorkspaceById(input.workspaceId);
      this.requireGraphRevision(input.workspaceId, input.graphRevision);
      const existing = this.findContextPackByHash(input.workspaceId, input.hash);
      if (existing) {
        if (contextPackMatchesPersistInput(existing, input)) return existing;
        throw new WorkspaceGraphValidationError("Context Pack hash collision has different immutable content");
      }
      this.validateContextPackTargetOwnership(input.workspaceId, input.target);
      const now = this.clock.now();
      this.db.prepare(
        `INSERT INTO context_packs (
           id, workspace_id, scope_type, scope_id, graph_revision, intent,
           message_checksum, manifest_path, token_estimate, omissions_json,
           hash, created_at, sealed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        input.id,
        input.workspaceId,
        input.target.type,
        input.target.id,
        input.graphRevision,
        input.intent,
        input.messageChecksum,
        input.manifestPath,
        input.tokenEstimate,
        canonicalJsonText(input.omissions, "Context Pack omissions"),
        input.hash,
        now,
      );
      const insert = this.db.prepare(
        `INSERT INTO context_pack_items (
           context_pack_id, workspace_id, ordinal, ref_json, resolved_kind,
           artifact_revision_id, resource_revision_id, kernel_revision_id,
           checksum, reason, trust_level, boundary_json, token_estimate,
           provenance_json, provided
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let ordinal = 0; ordinal < input.items.length; ordinal += 1) {
        const item = input.items[ordinal]!;
        this.validateContextPackItemIdentity(input.workspaceId, item);
        insert.run(
          input.id,
          input.workspaceId,
          ordinal,
          canonicalJsonText(item.ref, `Context Pack item ${ordinal} ref`),
          item.resolvedKind,
          item.artifactRevisionId ?? null,
          item.resourceRevisionId ?? null,
          item.kernelRevisionId ?? null,
          item.checksum,
          item.reason,
          item.trustLevel,
          canonicalJsonText(item.boundary, `Context Pack item ${ordinal} boundary`),
          item.tokenEstimate,
          canonicalJsonText(item.provenance, `Context Pack item ${ordinal} provenance`),
          item.provided ? 1 : 0,
        );
      }
      const sealed = this.db.prepare(
        "UPDATE context_packs SET sealed = 1 WHERE id = ? AND workspace_id = ? AND sealed = 0",
      ).run(input.id, input.workspaceId);
      if (Number(sealed.changes) !== 1) throw new WorkspaceGraphValidationError(`Context Pack ${input.id} could not be sealed`);
      const result = this.getContextPack(input.workspaceId, input.id);
      if (!result) throw new WorkspaceGraphValidationError(`Context Pack ${input.id} is not resolvable`);
      return result;
    });
  }

  getContextPack(workspaceId: string, contextPackId: string): ContextPack | null {
    return this.transactionRead(() => {
      const row = this.db.prepare(
        "SELECT * FROM context_packs WHERE id = ? AND workspace_id = ?",
      ).get(contextPackId, workspaceId) as Row | undefined;
      if (!row) return null;
      const items = this.db.prepare(
        `SELECT * FROM context_pack_items
         WHERE context_pack_id = ? AND workspace_id = ? ORDER BY ordinal ASC`,
      ).all(contextPackId, workspaceId) as Row[];
      const pack = asContextPack(row, items);
      this.validateContextPackTargetOwnership(pack.workspaceId, pack.target, true);
      for (const item of pack.items) this.validateContextPackItemIdentity(pack.workspaceId, item);
      return pack;
    });
  }

  findContextPackByHash(workspaceId: string, hash: string): ContextPack | null {
    const normalizedWorkspaceId = boundaryId(workspaceId, "Context Pack Workspace id");
    const normalizedHash = boundaryChecksum(hash, "Context Pack hash");
    return this.transactionRead(() => {
      const row = this.db.prepare(
        "SELECT id FROM context_packs WHERE workspace_id = ? AND hash = ? AND sealed = 1",
      ).get(normalizedWorkspaceId, normalizedHash) as { id: string } | undefined;
      return row ? this.getContextPack(normalizedWorkspaceId, row.id) : null;
    });
  }

  recordContextPackItemUsage(unsafeInput: RecordContextPackItemUsageInput): ContextPackItemUsage {
    const input = normalizeRecordContextPackItemUsageInput(unsafeInput);
    return this.transactionImmediate(() => {
      const pack = this.getContextPack(input.workspaceId, input.contextPackId);
      if (!pack) throw new WorkspaceGraphValidationError(`Context Pack ${input.contextPackId} was not found`);
      const item = pack.items.find(({ ordinal }) => ordinal === input.ordinal);
      if (!item) {
        throw new WorkspaceGraphValidationError(`Context Pack item ${input.ordinal} was not found`);
      }
      if (!item.provided) {
        throw new WorkspaceGraphValidationError(`Context Pack item ${input.ordinal} was not provided to the Agent`);
      }
      this.validateRunOwnership(input.workspaceId, input.runId ?? null, "Context Pack usage");
      this.validateRunContextPackBinding(
        input.workspaceId,
        input.contextPackId,
        input.runId ?? null,
        "Context Pack usage",
      );
      const rows = this.db.prepare(
        `SELECT CAST(sequence AS TEXT) AS sequence_text, typeof(sequence) AS sequence_type
         FROM context_pack_item_usage
         WHERE context_pack_id = ? AND ordinal = ?`,
      ).all(input.contextPackId, input.ordinal) as Array<{ sequence_text: unknown; sequence_type: unknown }>;
      let maximum = 0n;
      for (const row of rows) {
        if (row.sequence_type !== "integer" || typeof row.sequence_text !== "string" || !/^[1-9][0-9]*$/.test(row.sequence_text)) {
          throw new WorkspaceGraphValidationError("Context Pack usage sequence is corrupt");
        }
        const sequence = BigInt(row.sequence_text);
        if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new WorkspaceGraphValidationError("Context Pack usage sequence exceeds the safe integer range");
        }
        if (sequence > maximum) maximum = sequence;
      }
      if (maximum >= BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WorkspaceGraphValidationError("Context Pack usage sequence is exhausted");
      }
      const sequence = Number(maximum + 1n);
      this.db.prepare(
        `INSERT INTO context_pack_item_usage (
           context_pack_id, workspace_id, ordinal, sequence, usage_kind, run_id, evidence_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.contextPackId,
        input.workspaceId,
        input.ordinal,
        sequence,
        input.usageKind,
        input.runId ?? null,
        canonicalJsonText(input.evidence, "Context Pack usage evidence"),
        this.clock.now(),
      );
      const row = this.db.prepare(
        `SELECT * FROM context_pack_item_usage
         WHERE context_pack_id = ? AND ordinal = ? AND sequence = ?`,
      ).get(input.contextPackId, input.ordinal, sequence) as Row;
      return asContextPackItemUsage(row);
    });
  }

  listContextPackItemUsage(
    workspaceId: string,
    contextPackId: string,
    ordinal?: number,
  ): ContextPackItemUsage[] {
    const normalizedWorkspaceId = boundaryId(workspaceId, "Context Pack usage Workspace id");
    const normalizedContextPackId = boundaryId(contextPackId, "Context Pack usage pack id");
    const normalizedOrdinal = ordinal === undefined
      ? undefined
      : boundarySafeInteger(ordinal, "Context Pack usage ordinal");
    return this.transactionRead(() => {
      const pack = this.getContextPack(normalizedWorkspaceId, normalizedContextPackId);
      if (!pack) return [];
      const rows = normalizedOrdinal === undefined
        ? this.db.prepare(
            `SELECT * FROM context_pack_item_usage
             WHERE workspace_id = ? AND context_pack_id = ?
             ORDER BY ordinal ASC, sequence ASC`,
          ).all(normalizedWorkspaceId, normalizedContextPackId)
        : this.db.prepare(
            `SELECT * FROM context_pack_item_usage
             WHERE workspace_id = ? AND context_pack_id = ? AND ordinal = ?
             ORDER BY sequence ASC`,
          ).all(normalizedWorkspaceId, normalizedContextPackId, normalizedOrdinal);
      const usage = (rows as Row[]).map(asContextPackItemUsage);
      const expectedSequenceByOrdinal = new Map<number, number>();
      for (const entry of usage) {
        const item = pack.items[entry.ordinal];
        if (!item || !item.provided) {
          throw new WorkspaceStoreCodecError("Context Pack usage references an item that was not provided");
        }
        const expectedSequence = (expectedSequenceByOrdinal.get(entry.ordinal) ?? 0) + 1;
        if (entry.sequence !== expectedSequence) {
          throw new WorkspaceStoreCodecError("Context Pack usage sequence is not contiguous");
        }
        expectedSequenceByOrdinal.set(entry.ordinal, expectedSequence);
      }
      return usage;
    });
  }

  applyGraphCommands(projectId: string, unsafeInput: WorkspaceGraphMutationInput): WorkspaceGraphMutationResult {
    const input = normalizeWorkspaceGraphMutationInput(unsafeInput);
    const payloads = input.commands.map((command) => JSON.stringify(command));
    const batchHash = checksum(`workspace-graph-command-batch-v1\0${JSON.stringify(input.commands)}`);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const replay = this.findExactGraphCommandReplay(workspace.id, input, payloads, batchHash);
      if (replay) return replay;
      const current = this.getGraph(projectId);
      if (current.revision !== input.baseGraphRevision) {
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, current.revision);
      }
      return this.applyGraphCommandsInTransaction(workspace, current, {
        expectedSnapshotId: input.expectedSnapshotId,
        commands: input.commands,
        reason: "graph-command",
        provenance: { kind: "graph-command", commandIds: input.commands.map((command) => command.id) },
      });
    });
  }

  getLayout(projectId: string, unsafeLayoutId = "default"): WorkspaceLayout {
    return this.transactionRead(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const layoutId = normalizeWorkspaceLayoutId(unsafeLayoutId);
      const graph = this.getGraph(projectId);
      this.validateLayoutGroups(workspace.id, layoutId, new Set(graph.nodes.map((node) => node.id)));
      return this.getLayoutByWorkspaceId(workspace.id, layoutId);
    });
  }

  saveLayout(projectId: string, unsafeInput: WorkspaceLayoutPatch): WorkspaceLayout {
    const input = normalizeWorkspaceLayoutPatch(unsafeInput);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      if (workspace.graphRevision !== input.graphRevision) {
        throw new WorkspaceRevisionConflictError(input.graphRevision, workspace.graphRevision);
      }
      const graph = this.getGraph(projectId);
      this.validateLayoutGroups(workspace.id, input.layoutId, new Set(graph.nodes.map((node) => node.id)));
      const currentLayout = this.getLayoutByWorkspaceId(workspace.id, input.layoutId);
      if (currentLayout.checksum !== input.baseLayoutChecksum) {
        throw new WorkspaceLayoutConflictError(
          input.graphRevision,
          input.baseLayoutChecksum,
          currentLayout.checksum,
        );
      }
      const guarded = this.db.prepare(
        `UPDATE project_workspaces SET updated_at = ?
         WHERE id = ? AND graph_revision = ?`,
      ).run(this.clock.now(), workspace.id, input.graphRevision);
      if (Number(guarded.changes) !== 1) {
        throw new WorkspaceRevisionConflictError(input.graphRevision, workspace.graphRevision);
      }
      this.applyLayoutCommandsInTransaction(workspace.id, graph, input.layoutId, input.commands);
      return this.getLayoutByWorkspaceId(workspace.id, input.layoutId);
    });
  }

  createProposal(unsafeInput: CreateWorkspaceProposalInput): WorkspaceProposalRecord {
    const input = normalizeCreateWorkspaceProposalInput(unsafeInput);
    if (input.kind === "component-propagation") {
      throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
    }
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(input.projectId), input.projectId);
      const graph = this.getGraph(input.projectId);
      if (graph.revision !== input.baseGraphRevision) {
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, graph.revision);
      }
      if (workspace.activeSnapshotId !== input.baseSnapshotId) {
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, graph.revision, {
          expectedSnapshotId: input.baseSnapshotId,
          actualSnapshotId: workspace.activeSnapshotId,
        });
      }
      const snapshot = this.requireSnapshot(workspace.id, input.baseSnapshotId);
      if (snapshot.graphRevision !== graph.revision) {
        throw new WorkspaceProposalValidationError("Workspace Proposal base Snapshot does not match its base graph");
      }
      this.validateRunOwnership(workspace.id, input.createdByRunId, "Workspace Proposal");
      this.validateLayoutGroups(workspace.id, input.layoutId, new Set(graph.nodes.map((node) => node.id)));
      const baseLayout = this.getLayoutByWorkspaceId(workspace.id, input.layoutId);
      if (baseLayout.checksum !== input.baseLayoutChecksum) {
        throw new WorkspaceLayoutConflictError(graph.revision, input.baseLayoutChecksum, baseLayout.checksum);
      }
      const id = this.clock.id();
      const now = this.clock.now();
      this.db.prepare(
        `INSERT INTO workspace_proposals (
           id, workspace_id, base_graph_revision, base_snapshot_id, revision, kind, status,
           operations_json, layout_id, base_layout_checksum, base_layout_json,
           layout_operations_json, rationale, assumptions_json, generation_payload_json,
           review_json, created_by_run_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        workspace.id,
        graph.revision,
        snapshot.id,
        input.kind,
        JSON.stringify(input.operations),
        input.layoutId,
        input.baseLayoutChecksum,
        JSON.stringify(baseLayout),
        JSON.stringify(input.layoutOperations),
        input.rationale,
        JSON.stringify(input.assumptions),
        JSON.stringify(input.generation),
        JSON.stringify({ kind: "none" }),
        input.createdByRunId,
        now,
        now,
      );
      const row = this.proposalRow(id);
      if (!row) throw new WorkspaceGraphValidationError(`Workspace Proposal ${id} was not inserted`);
      const proposal = this.decodeProposalCurrentRow(row);
      this.insertProposalAuditInTransaction(proposal);
      return this.requireProposalById(id);
    });
  }

  getProposal(proposalId: string): WorkspaceProposalRecord | null {
    return this.transactionRead(() => {
      const row = this.proposalRow(proposalId);
      return row ? this.decodeProposalRow(row) : null;
    });
  }

  getProposalForProject(projectId: string, proposalId: string): WorkspaceProposalRecord {
    return this.transactionRead(() => this.requireProposalForProject(projectId, proposalId));
  }

  assertProposalDurableIntegrityForProject(projectId: string, proposalId?: string): void {
    this.transactionRead(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const graph = this.getGraph(projectId);
      const activeSnapshotState = this.db.prepare(
        "SELECT workspace_id, sealed FROM workspace_snapshots WHERE id = ?",
      ).get(workspace.activeSnapshotId) as { workspace_id: string; sealed: number } | undefined;
      if (!activeSnapshotState
        || activeSnapshotState.workspace_id !== workspace.id
        || activeSnapshotState.sealed !== 1) {
        throw new WorkspaceGraphValidationError(
          "Workspace active Snapshot must be a sealed Snapshot owned by the current Workspace",
        );
      }
      const activeSnapshot = this.requireSnapshot(workspace.id, workspace.activeSnapshotId);
      if (activeSnapshot.graphRevision !== graph.revision
        || activeSnapshot.kernelRevisionId !== workspace.activeKernelRevisionId
        || !graphsAreSemanticallyEqual(activeSnapshot.graph, graph)) {
        throw new WorkspaceGraphValidationError(
          "Workspace active Snapshot does not match its current graph and Kernel pointers",
        );
      }
      this.requireKernelRevision(workspace.activeKernelRevisionId);
      this.validateCanonicalGraphResourceIdentities(workspace.id, graph);

      if (proposalId !== undefined) {
        const proposal = this.requireProposalForProject(projectId, proposalId);
        const baseSnapshot = this.requireSnapshot(workspace.id, proposal.baseSnapshotId);
        if (baseSnapshot.graphRevision !== proposal.baseGraphRevision
          || !graphsAreSemanticallyEqual(baseSnapshot.graph, proposal.baseGraph)) {
          throw new WorkspaceGraphValidationError(
            `Workspace Proposal ${proposal.id} base Snapshot does not match its immutable base graph`,
          );
        }
      }
    });
  }

  listProposals(projectId: string): WorkspaceProposalRecord[] {
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return [];
      const rows = this.db.prepare(
        `SELECT proposal.*, workspace.project_id
         FROM workspace_proposals proposal
         JOIN project_workspaces workspace ON workspace.id = proposal.workspace_id
         WHERE proposal.workspace_id = ?
         ORDER BY proposal.updated_at DESC, proposal.id COLLATE BINARY ASC`,
      ).all(workspace.id) as Row[];
      return rows.map((row) => this.decodeProposalRow(row));
    });
  }

  getProposalRevision(proposalId: string, revision: number): WorkspaceProposalRecord | null {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new WorkspaceStoreCodecError("Workspace Proposal revision must be a positive safe integer");
    }
    return this.transactionRead(() => {
      const row = this.db.prepare(
        "SELECT * FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = ?",
      ).get(proposalId, revision) as Row | undefined;
      if (!row) return null;
      const audited = asWorkspaceProposalAudit(row);
      const currentRow = this.proposalRow(proposalId);
      if (!currentRow) throw new WorkspaceStoreCodecError(`Workspace Proposal ${proposalId} is missing`);
      const current = this.decodeProposalRow(currentRow);
      if (audited.revision > current.revision) {
        throw new WorkspaceStoreCodecError("Workspace Proposal audit revision is ahead of its current Proposal");
      }
      this.assertProposalAuditBaseCoherence(current, audited);
      return audited;
    });
  }

  updateProposal(proposalId: string, unsafeInput: UpdateWorkspaceProposalInput): WorkspaceProposalRecord {
    return this.updateProposalScoped(null, proposalId, unsafeInput);
  }

  updateProposalForProject(
    projectId: string,
    proposalId: string,
    unsafeInput: UpdateWorkspaceProposalInput,
  ): WorkspaceProposalRecord {
    return this.updateProposalScoped(projectId, proposalId, unsafeInput);
  }

  rejectProposal(proposalId: string): WorkspaceProposalRecord {
    return this.rejectProposalScoped(null, proposalId);
  }

  rejectProposalForProject(projectId: string, proposalId: string): WorkspaceProposalRecord {
    return this.rejectProposalScoped(projectId, proposalId);
  }

  approveProposal(
    proposalId: string,
    unsafeMode: WorkspaceProposalApprovalMode,
  ): ApprovedProposalResult {
    return this.approveProposalScoped(null, proposalId, unsafeMode);
  }

  approveProposalForProject(
    projectId: string,
    proposalId: string,
    unsafeMode: WorkspaceProposalApprovalMode,
  ): ApprovedProposalResult {
    return this.approveProposalScoped(projectId, proposalId, unsafeMode);
  }

  getGenerationPlan(planId: string): GenerationPlan | null {
    return this.transactionRead(() => {
      const row = this.db.prepare(
        `SELECT plan.id, workspace.project_id
         FROM generation_plans plan
         JOIN project_workspaces workspace ON workspace.id = plan.workspace_id
         WHERE plan.id = ?`,
      ).get(planId) as { id: string; project_id: string } | undefined;
      return row ? this.readGenerationPlanDetailForProject(row.project_id, row.id).plan : null;
    });
  }

  getGenerationPlanForProject(projectId: string, planId: string): GenerationPlan {
    return this.transactionRead(() => this.readGenerationPlanDetailForProject(projectId, planId).plan);
  }

  getGenerationPlanDetailForProject(projectId: string, planId: string): GenerationPlanDetail {
    return this.transactionRead(() => this.readGenerationPlanDetailForProject(projectId, planId));
  }

  compileApprovedGenerationPlanForProject(projectId: string, planId: string): GenerationPlanDetail {
    try {
      return this.transactionImmediate(() => {
        const shell = this.requireGenerationPlanForProject(projectId, planId);
        if (shell.constructionSealed) {
          if (shell.status === "approved" || shell.status === "compile-failed") {
            throw new WorkspaceStoreCodecError(
              `Generation Plan ${shell.id} construction seal is incoherent with status ${shell.status}`,
            );
          }
          return this.readGenerationPlanDetailForProject(projectId, planId);
        }
        if (shell.status !== "approved") {
          throw new GenerationPlanStateConflictError(shell.id, shell.status);
        }
        const proposal = this.requireProposalForProject(projectId, shell.proposalId);
        this.validateGenerationPlanShellSnapshotInTransaction(shell, proposal);
        const compiled = compileGenerationPlan({ shell, proposal });
        this.ensureGenerationComponentInstanceIdentitiesInTransaction(proposal);
        const insertTask = this.db.prepare(
        `INSERT INTO generation_tasks (
           id, ordinal, workspace_id, plan_id, kind, target_type, target_id,
           target_artifact_id, target_track_id, target_resource_id,
           payload_json, intent_hash, capabilities_json, qa_profile_json, resource_limits_json,
           idempotency_key, status, blocked_reason, blocked_by_task_id, pending_context_policy,
           current_attempt, materialization_failures, failure_class, error_json, next_eligible_at,
           result_revision_id, result_resource_revision_id, result_snapshot_id, created_at, finished_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           'materialization-pending', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL
         )`,
        );
        const createdAt = this.clock.now();
        for (const taskValue of compiled.tasks) {
          const { intentHash, idempotencyKey, ...intentInput } = taskValue;
          const task = normalizeGenerationTaskIntent(intentInput);
          if (task.intentHash !== intentHash || task.idempotencyKey !== idempotencyKey) {
            throw new WorkspaceStoreCodecError("compiled Generation Task derived identity is inconsistent");
          }
          if (task.planId !== shell.id || task.workspaceId !== shell.workspaceId) {
            throw new WorkspaceStoreCodecError("compiled Generation Task ownership does not match its Plan shell");
          }
          insertTask.run(
          task.id,
          task.ordinal,
          task.workspaceId,
          task.planId,
          task.kind,
          task.target.type,
          task.target.id,
          task.target.type === "artifact" ? task.target.id : null,
          task.target.type === "artifact" ? task.target.trackId : null,
          task.target.type === "resource" ? task.target.id : null,
          canonicalJsonText(task.payload, "Generation Task payload"),
          task.intentHash,
          canonicalJsonText(task.capabilities, "Generation Task capabilities"),
          canonicalJsonText(task.qaProfile, "Generation Task QA profile"),
          canonicalJsonText(task.resourceLimits, "Generation Task resource limits"),
          task.idempotencyKey,
          createdAt,
          );
        }
        const insertDependency = this.db.prepare(
        `INSERT INTO generation_task_dependencies (
           plan_id, workspace_id, task_id, dependency_task_id, ordinal
         ) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const dependency of compiled.dependencies) {
          insertDependency.run(
          dependency.planId,
          shell.workspaceId,
          dependency.taskId,
          dependency.dependencyTaskId,
          dependency.ordinal,
          );
        }
        const sealed = this.db.prepare(
        `UPDATE generation_plans
         SET status = 'queued', construction_sealed = 1
         WHERE id = ? AND workspace_id = ? AND status = 'approved' AND construction_sealed = 0`,
        ).run(shell.id, shell.workspaceId);
        if (Number(sealed.changes) !== 1) {
          const actual = this.requireGenerationPlanForProject(projectId, planId);
          throw new GenerationPlanStateConflictError(actual.id, actual.status);
        }
        this.appendGenerationPlanEventInTransaction({
          planId: shell.id,
          workspaceId: shell.workspaceId,
          taskId: null,
          type: "plan-queued",
          payload: { taskCount: compiled.tasks.length, dependencyCount: compiled.dependencies.length },
        });
        return this.readGenerationPlanDetailForProject(projectId, planId);
      });
    } catch (error) {
      if (!(error instanceof GenerationPlanCompileError)) throw error;
      const current = this.getGenerationPlan(planId);
      if (current?.status === "approved" && !current.constructionSealed) {
        try {
          this.markGenerationPlanCompileFailedIfApprovedForProject(projectId, planId, {
            code: error.code,
            message: error.message,
            details: error.details,
          });
        } catch (persistenceError) {
          throw new AggregateError(
            [error, persistenceError],
            `Generation Plan ${planId} compilation failed and its terminal state could not be persisted`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  markGenerationPlanCompileFailedIfApprovedForProject(
    projectId: string,
    planId: string,
    unsafeError: Record<string, unknown>,
  ): GenerationPlan {
    const error = boundaryJsonObject(unsafeError, "Generation Plan compile error");
    return this.transactionImmediate(() => {
      const plan = this.requireGenerationPlanForProject(projectId, planId);
      if (plan.status === "compile-failed" && !plan.constructionSealed
        && plan.compileError !== null && isDeepStrictEqual(plan.compileError, error)) {
        return plan;
      }
      if (plan.status !== "approved" || plan.constructionSealed) {
        throw new GenerationPlanStateConflictError(plan.id, plan.status);
      }
      const finishedAt = this.clock.now();
      const moved = this.db.prepare(
        `UPDATE generation_plans
         SET status = 'compile-failed', compile_error_json = ?, finished_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'approved' AND construction_sealed = 0`,
      ).run(
        canonicalJsonText(error, "Generation Plan compile error"),
        finishedAt,
        plan.id,
        plan.workspaceId,
      );
      if (Number(moved.changes) !== 1) {
        const actual = this.requireGenerationPlanForProject(projectId, planId);
        throw new GenerationPlanStateConflictError(actual.id, actual.status);
      }
      this.appendGenerationPlanEventInTransaction({
        planId: plan.id,
        workspaceId: plan.workspaceId,
        taskId: null,
        type: "plan-compile-failed",
        payload: error,
      });
      return this.requireGenerationPlanForProject(projectId, planId);
    });
  }

  listGenerationPlanEventsForProject(
    projectId: string,
    planId: string,
    unsafeInput: ListGenerationPlanEventsInput,
  ): GenerationPlanEvent[] {
    const input = normalizeListGenerationPlanEventsInput(unsafeInput);
    return this.transactionRead(() => {
      const plan = this.requireGenerationPlanForProject(projectId, planId);
      const summary = this.db.prepare(
        `SELECT COUNT(*) AS count, MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
         FROM generation_plan_events WHERE plan_id = ? AND workspace_id = ?`,
      ).get(plan.id, plan.workspaceId) as {
        count: number;
        first_sequence: number | null;
        last_sequence: number | null;
      };
      const count = boundarySafeInteger(summary.count, "Generation Plan event count");
      if ((count === 0 && (summary.first_sequence !== null || summary.last_sequence !== null))
        || (count > 0 && (summary.first_sequence !== 1 || summary.last_sequence !== count))) {
        throw new WorkspaceStoreCodecError(`Generation Plan ${plan.id} event sequence is not contiguous`);
      }
      if (input.after >= count) return [];
      const rows = this.db.prepare(
        `SELECT * FROM generation_plan_events
         WHERE plan_id = ? AND workspace_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      ).all(plan.id, plan.workspaceId, input.after, input.limit) as Row[];
      const events = rows.map(asGenerationPlanEvent);
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        if (event.planId !== plan.id || event.sequence !== input.after + index + 1) {
          throw new WorkspaceStoreCodecError("Generation Plan event page is not a contiguous owned cursor slice");
        }
      }
      return events;
    });
  }

  listGenerationPlans(projectId: string): GenerationPlan[] {
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return [];
      const rows = this.db.prepare(
        `SELECT id FROM generation_plans
         WHERE workspace_id = ? ORDER BY created_at ASC, id COLLATE BINARY ASC`,
      ).all(workspace.id) as Array<{ id: string }>;
      return rows.map((row) => this.readGenerationPlanDetailForProject(projectId, row.id).plan);
    });
  }

  listGenerationTaskIdsReadyForMaterializationForProject(
    projectId: string,
    planId: string,
  ): string[] {
    return this.transactionRead(() => {
      const detail = this.readGenerationPlanDetailForProject(projectId, planId);
      if (!detail.plan.constructionSealed
        || (detail.plan.status !== "queued" && detail.plan.status !== "running")) {
        return [];
      }
      const now = this.clock.now();
      const taskById = new Map(detail.tasks.map((task) => [task.id, task]));
      return detail.tasks
        .filter((task) => this.generationTaskCanMaterialize(task, taskById, now))
        .slice(0, 100)
        .map((task) => task.id);
    });
  }

  listReadyGenerationTaskAttempts(limitValue = 100): GenerationTaskAttempt[] {
    const limit = boundarySafeInteger(limitValue, "ready Generation Task Attempt limit", 1);
    if (limit > 1_000) {
      throw new WorkspaceStoreCodecError("ready Generation Task Attempt limit must not exceed 1000");
    }
    return this.transactionRead(() => {
      const rows = this.db.prepare(
        `SELECT task.id AS task_id, task.current_attempt AS attempt
         FROM generation_tasks task
         JOIN generation_plans plan
           ON plan.id = task.plan_id AND plan.workspace_id = task.workspace_id
         JOIN generation_task_attempts attempt
           ON attempt.task_id = task.id
          AND attempt.plan_id = task.plan_id
          AND attempt.workspace_id = task.workspace_id
          AND attempt.attempt = task.current_attempt
         WHERE task.status = 'queued'
           AND attempt.status = 'queued'
           AND attempt.materialization_sealed = 1
           AND plan.construction_sealed = 1
           AND plan.status IN ('queued','running')
           AND NOT EXISTS (
             SELECT 1 FROM generation_task_dependencies dependency
             JOIN generation_tasks predecessor
               ON predecessor.id = dependency.dependency_task_id
              AND predecessor.plan_id = dependency.plan_id
              AND predecessor.workspace_id = dependency.workspace_id
             WHERE dependency.task_id = task.id
               AND dependency.plan_id = task.plan_id
               AND predecessor.status <> 'succeeded'
           )
           AND NOT EXISTS (
             SELECT 1 FROM generation_task_claims claim
             WHERE claim.task_id = task.id AND claim.attempt = task.current_attempt
           )
         ORDER BY plan.created_at ASC, plan.id COLLATE BINARY ASC,
                  task.ordinal ASC, task.id COLLATE BINARY ASC
         LIMIT ?`,
      ).all(limit) as Array<{ task_id: string; attempt: number }>;
      return rows.map((row) => {
        const taskId = requiredCell(row.task_id, "ready Generation Task id");
        const attemptNumber = boundarySafeInteger(row.attempt, "ready Generation Task Attempt number", 1);
        const attempt = this.readGenerationTaskAttemptInTransaction(taskId, attemptNumber);
        if (attempt === null || attempt.status !== "queued" || attempt.lease !== null) {
          throw new WorkspaceStoreCodecError(
            `ready Generation Task ${taskId}/${attemptNumber} is not an unclaimed queued Attempt`,
          );
        }
        this.assertGenerationTaskMaterializedEventInTransaction(attempt);
        return attempt;
      });
    });
  }

  tryClaimGenerationTaskAttempt(
    unsafeInput: TryClaimGenerationTaskAttemptInput,
  ): GenerationTaskAttemptClaim | null {
    const input = normalizeTryClaimGenerationTaskAttemptInput(unsafeInput);
    return this.transactionImmediate(() => {
      const ownership = this.db.prepare(
        `SELECT task.plan_id, workspace.project_id
         FROM generation_tasks task
         JOIN project_workspaces workspace ON workspace.id = task.workspace_id
         WHERE task.id = ?`,
      ).get(input.taskId) as { plan_id: string; project_id: string } | undefined;
      if (!ownership) throw new GenerationTaskNotFoundError(input.taskId);
      const planId = requiredCell(ownership.plan_id, "claim Generation Task Plan id");
      const projectId = requiredCell(ownership.project_id, "claim Generation Task Project id");
      const detail = this.readGenerationPlanDetailForProject(projectId, planId);
      const task = detail.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task || task.currentAttempt !== input.attempt || task.status !== "queued"
        || (detail.plan.status !== "queued" && detail.plan.status !== "running")
        || task.dependencyIds.some((dependencyId) => (
          detail.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "succeeded"
        ))) {
        return null;
      }
      const attempt = this.readGenerationTaskAttemptInTransaction(task.id, input.attempt);
      if (attempt === null || attempt.status !== "queued" || attempt.lease !== null) return null;
      if (input.now < attempt.createdAt) {
        throw new WorkspaceStoreCodecError("Generation Task claim time precedes its immutable Attempt");
      }
      this.assertGenerationTaskMaterializedEventInTransaction(attempt);

      const capacityClaimKeys: string[] = [];
      const reservedClaimKeys = new Set<string>();
      for (const capacityClass of task.resourceLimits.capacityClasses) {
        let selected: string | null = null;
        for (let slot = 1; slot <= GENERATION_TASK_CAPACITY_LIMITS[capacityClass]; slot += 1) {
          const claimKey = `capacity:${capacityClass}:${slot}`;
          if (!reservedClaimKeys.has(claimKey)
            && !this.db.prepare("SELECT 1 FROM generation_task_claims WHERE claim_key = ?").get(claimKey)) {
            selected = claimKey;
            break;
          }
        }
        if (selected === null) return null;
        capacityClaimKeys.push(selected);
        reservedClaimKeys.add(selected);
      }
      const writerClaimKeys = this.generationTaskWriterClaimKeys(task);
      if (writerClaimKeys.some((claimKey) => (
        this.db.prepare("SELECT 1 FROM generation_task_claims WHERE claim_key = ?").get(claimKey)
      ))) {
        return null;
      }
      const now = input.now;
      if (now > Number.MAX_SAFE_INTEGER - input.leaseMs) {
        throw new WorkspaceStoreCodecError("Generation Task claim lease expiry is exhausted");
      }
      const leaseExpiresAt = now + input.leaseMs;
      const leaseToken = checksum([
        "dezin-generation-task-lease-v1",
        task.id,
        String(input.attempt),
        input.ownerId,
        this.clock.id(),
        String(now),
      ].join("\0"));
      const claimKeys = [...capacityClaimKeys, ...writerClaimKeys].sort(compareBinary);
      if (claimKeys.length === 0) {
        throw new WorkspaceStoreCodecError(`Generation Task ${task.id} has no durable execution claims`);
      }
      const insertClaim = this.db.prepare(
        `INSERT INTO generation_task_claims (
           claim_key, claim_kind, task_id, plan_id, attempt, workspace_id,
           owner_id, lease_token, lease_expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const claimKey of claimKeys) {
        insertClaim.run(
          claimKey,
          claimKey.startsWith("capacity:") ? "capacity" : "writer",
          task.id,
          task.planId,
          input.attempt,
          task.workspaceId,
          input.ownerId,
          leaseToken,
          leaseExpiresAt,
          now,
        );
      }
      const claimedAttempt = this.db.prepare(
        `UPDATE generation_task_attempts
         SET status = 'running', owner_id = ?, lease_token = ?, lease_expires_at = ?,
             heartbeat_at = ?, started_at = ?
         WHERE task_id = ? AND plan_id = ? AND workspace_id = ? AND attempt = ?
           AND status = 'queued' AND owner_id IS NULL AND lease_token IS NULL
           AND lease_expires_at IS NULL AND heartbeat_at IS NULL AND started_at IS NULL`,
      ).run(
        input.ownerId,
        leaseToken,
        leaseExpiresAt,
        now,
        now,
        task.id,
        task.planId,
        task.workspaceId,
        input.attempt,
      );
      if (Number(claimedAttempt.changes) !== 1) {
        throw new WorkspaceStoreCodecError("Generation Task claim lost its queued Attempt fence");
      }
      const claimedTask = this.db.prepare(
        `UPDATE generation_tasks SET status = 'running'
         WHERE id = ? AND plan_id = ? AND workspace_id = ?
           AND current_attempt = ? AND status = 'queued'`,
      ).run(task.id, task.planId, task.workspaceId, input.attempt);
      if (Number(claimedTask.changes) !== 1) {
        throw new WorkspaceStoreCodecError("Generation Task claim lost its queued Task fence");
      }
      if (detail.plan.status === "queued") {
        const runningPlan = this.db.prepare(
          `UPDATE generation_plans SET status = 'running'
           WHERE id = ? AND workspace_id = ? AND status = 'queued'`,
        ).run(task.planId, task.workspaceId);
        if (Number(runningPlan.changes) !== 1) {
          throw new WorkspaceStoreCodecError("Generation Task claim lost its queued Plan fence");
        }
      }
      this.appendGenerationPlanEventInTransaction({
        planId: task.planId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        type: "task-running",
        payload: {
          attempt: input.attempt,
          ownerId: input.ownerId,
          leaseExpiresAt,
          capacityClaimKeys,
          writerClaimKeys,
        },
      });
      const runningTask = this.readGenerationTaskForExecutionInTransaction(task.id);
      if (!runningTask) {
        throw new WorkspaceStoreCodecError("Generation Task disappeared after its claim transition");
      }
      return this.readGenerationTaskAttemptClaimInTransaction(runningTask, input.attempt);
    });
  }

  heartbeatGenerationTaskAttempt(
    unsafeLease: GenerationTaskAttemptLease,
    now: number,
    leaseMs: number,
  ): GenerationTaskAttemptClaim;
  heartbeatGenerationTaskAttempt(
    unsafeInput: HeartbeatGenerationTaskAttemptInput,
  ): GenerationTaskAttemptClaim;
  heartbeatGenerationTaskAttempt(
    unsafeInputOrLease: HeartbeatGenerationTaskAttemptInput | GenerationTaskAttemptLease,
    nowValue?: number,
    leaseMsValue?: number,
  ): GenerationTaskAttemptClaim {
    const unsafeInput = nowValue === undefined && leaseMsValue === undefined
      ? unsafeInputOrLease
      : { ...unsafeInputOrLease, now: nowValue, leaseMs: leaseMsValue };
    const input = normalizeHeartbeatGenerationTaskAttemptInput(unsafeInput);
    return this.transactionImmediate(() => {
      const task = this.readGenerationTaskForExecutionInTransaction(input.taskId);
      if (!task || task.workspaceId !== input.workspaceId || task.currentAttempt !== input.attempt) {
        throw new GenerationTaskLeaseFenceError(input.taskId, input.attempt, "Task identity is stale");
      }
      const attempt = this.readGenerationTaskAttemptInTransaction(input.taskId, input.attempt);
      const now = input.now;
      if (!attempt || !attempt.lease
        || attempt.lease.ownerId !== input.ownerId
        || attempt.lease.leaseToken !== input.leaseToken
        || attempt.leaseExpiresAt === null
        || attempt.leaseExpiresAt <= now
        || (attempt.status !== "running" && attempt.status !== "candidate-ready"
          && attempt.status !== "cancel-requested")) {
        throw new GenerationTaskLeaseFenceError(input.taskId, input.attempt, "Attempt lease is stale or expired");
      }
      const live = this.readGenerationTaskExecutionLeaseInTransaction(task, input.attempt);
      if (live.ownerId !== input.ownerId || live.leaseToken !== input.leaseToken
        || live.claims.some((claim) => claim.leaseExpiresAt <= now)) {
        throw new GenerationTaskLeaseFenceError(input.taskId, input.attempt, "Claim lease is stale or expired");
      }
      if (now < live.heartbeatAt) {
        throw new GenerationTaskLeaseFenceError(input.taskId, input.attempt, "Heartbeat time moved backwards");
      }
      if (now === live.heartbeatAt) {
        return this.readGenerationTaskAttemptClaimInTransaction(task, input.attempt);
      }
      if (now > Number.MAX_SAFE_INTEGER - input.leaseMs) {
        throw new WorkspaceStoreCodecError("Generation Task heartbeat lease expiry is exhausted");
      }
      const leaseExpiresAt = now + input.leaseMs;
      if (leaseExpiresAt <= live.leaseExpiresAt) {
        return this.readGenerationTaskAttemptClaimInTransaction(task, input.attempt);
      }
      const renewedClaims = this.db.prepare(
        `UPDATE generation_task_claims SET lease_expires_at = ?
         WHERE task_id = ? AND attempt = ? AND workspace_id = ?
           AND owner_id = ? AND lease_token = ? AND lease_expires_at = ?`,
      ).run(
        leaseExpiresAt,
        input.taskId,
        input.attempt,
        input.workspaceId,
        input.ownerId,
        input.leaseToken,
        live.leaseExpiresAt,
      );
      if (Number(renewedClaims.changes) !== live.claims.length) {
        throw new WorkspaceStoreCodecError("Generation Task heartbeat lost part of its claim fence");
      }
      const renewedAttempt = this.db.prepare(
        `UPDATE generation_task_attempts
         SET lease_expires_at = ?, heartbeat_at = ?
         WHERE task_id = ? AND attempt = ? AND workspace_id = ?
           AND owner_id = ? AND lease_token = ? AND lease_expires_at = ?`,
      ).run(
        leaseExpiresAt,
        now,
        input.taskId,
        input.attempt,
        input.workspaceId,
        input.ownerId,
        input.leaseToken,
        live.leaseExpiresAt,
      );
      if (Number(renewedAttempt.changes) !== 1) {
        throw new WorkspaceStoreCodecError("Generation Task heartbeat lost its Attempt fence");
      }
      return this.readGenerationTaskAttemptClaimInTransaction(task, input.attempt);
    });
  }

  releaseGenerationTaskAttemptClaims(unsafeLease: GenerationTaskAttemptLease): boolean {
    const lease = normalizeGenerationTaskAttemptLease(unsafeLease);
    return this.transactionImmediate(() => {
      const liveAttempt = this.db.prepare(
        `SELECT 1 FROM generation_task_attempts
         WHERE task_id = ? AND attempt = ? AND workspace_id = ?
           AND owner_id = ? AND lease_token = ?`,
      ).get(lease.taskId, lease.attempt, lease.workspaceId, lease.ownerId, lease.leaseToken);
      if (liveAttempt) return false;
      const deleted = this.db.prepare(
        `DELETE FROM generation_task_claims
         WHERE task_id = ? AND attempt = ? AND workspace_id = ?
           AND owner_id = ? AND lease_token = ?`,
      ).run(lease.taskId, lease.attempt, lease.workspaceId, lease.ownerId, lease.leaseToken);
      return Number(deleted.changes) > 0;
    });
  }

  observeGenerationTaskMaterializationForProject(
    projectId: string,
    planId: string,
    taskId: string,
  ): GenerationTaskMaterializationObservation {
    return this.transactionRead(() => this.observeGenerationTaskMaterializationInTransaction(
      projectId,
      planId,
      taskId,
    ));
  }

  createGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    unsafeInput: CreateGenerationTaskAttemptInput,
  ): GenerationTaskAttempt {
    const input = normalizeGenerationTaskAttemptInput(unsafeInput);
    if (input.planId !== planId) {
      throw new GenerationTaskMaterializationConflictError(input.taskId, "Plan identity does not match the route");
    }
    return this.transactionImmediate(() => {
      const plan = this.requireGenerationPlanForProject(projectId, planId);
      if (plan.workspaceId !== input.workspaceId) {
        throw new GenerationTaskMaterializationConflictError(input.taskId, "Workspace identity does not match its Plan");
      }
      const existing = this.readGenerationTaskAttemptInTransaction(
        input.taskId,
        input.attempt,
      );
      if (existing !== null) {
        if (!this.generationTaskAttemptInputMatches(existing, input)) {
          throw new GenerationTaskMaterializationConflictError(
            input.taskId,
            `Attempt ${input.attempt} already exists with different immutable input`,
          );
        }
        this.assertGenerationTaskMaterializedEventInTransaction(existing);
        return existing;
      }

      const observation = this.observeGenerationTaskMaterializationInTransaction(
        projectId,
        planId,
        input.taskId,
      );
      if (!this.generationTaskAttemptMatchesObservation(input, observation)) {
        throw new GenerationTaskMaterializationConflictError(
          input.taskId,
          "the observed Snapshot, base, dependency outputs, or pins are stale",
        );
      }
      const detail = this.readGenerationPlanDetailForProject(projectId, planId);
      const task = detail.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task) throw new GenerationTaskNotFoundError(input.taskId);
      const expectedPolicy = task.pendingContextPolicy ?? "same-context";
      const expectedMode = this.generationTaskMaterializationExecutionModeInTransaction(task);
      if (input.retryContextPolicy !== expectedPolicy || input.executionMode !== expectedMode) {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          `expected ${expectedPolicy}/${expectedMode} retry execution policy`,
        );
      }
      this.validateGenerationTaskAttemptContextInTransaction(task, input);

      const createdAt = this.clock.now();
      this.db.prepare(
        `INSERT INTO generation_task_attempts (
           task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
           target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
           kernel_revision_id, execution_mode, payload_json, input_hash,
           pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
           retry_context_policy, status, materialization_sealed, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      ).run(
        input.taskId,
        input.planId,
        input.workspaceId,
        input.attempt,
        input.target.type === "artifact" ? input.target.id : null,
        input.target.type === "artifact" ? input.target.trackId : null,
        input.target.type === "resource" ? input.target.id : null,
        input.baseRevisionId,
        input.expectedSnapshotId,
        input.contextPackId,
        input.kernelRevisionId,
        input.executionMode,
        canonicalJsonText(input.payload, "Generation Task Attempt payload"),
        input.inputHash,
        canonicalJsonText(
          input.resourcePins.map((pin) => pin.revisionId),
          "Generation Task Attempt Resource revision summary",
        ),
        canonicalJsonText(
          input.componentPins.map((pin) => pin.revisionId),
          "Generation Task Attempt Component revision summary",
        ),
        input.retryContextPolicy,
        createdAt,
      );
      const insertDependencyOutput = this.db.prepare(
         `INSERT INTO generation_task_attempt_dependency_outputs (
           task_id, plan_id, attempt, workspace_id, ordinal, dependency_task_id,
           result_revision_id, result_resource_revision_id, result_snapshot_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const output of input.dependencyOutputs) {
        insertDependencyOutput.run(
          input.taskId,
          input.planId,
          input.attempt,
          input.workspaceId,
          output.ordinal,
          output.taskId,
          output.resultRevisionId,
          output.resultResourceRevisionId,
          output.resultSnapshotId,
        );
      }
      const insertResourcePin = this.db.prepare(
        `INSERT INTO generation_task_attempt_resource_pins (
           task_id, plan_id, attempt, workspace_id, ordinal, resource_id, revision_id, source_task_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const pin of input.resourcePins) {
        insertResourcePin.run(
          input.taskId,
          input.planId,
          input.attempt,
          input.workspaceId,
          pin.ordinal,
          pin.resourceId,
          pin.revisionId,
          pin.sourceTaskId,
        );
      }
      const insertComponentPin = this.db.prepare(
        `INSERT INTO generation_task_attempt_component_pins (
           task_id, plan_id, attempt, workspace_id, ordinal, instance_id, owner_artifact_id,
           component_artifact_id, revision_id, source_task_id, variant_key, state_key,
           design_node_id, source_locator_json, overrides_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const pin of input.componentPins) {
        insertComponentPin.run(
          input.taskId,
          input.planId,
          input.attempt,
          input.workspaceId,
          pin.ordinal,
          pin.instanceId,
          pin.ownerArtifactId,
          pin.componentArtifactId,
          pin.revisionId,
          pin.sourceTaskId,
          pin.variantKey,
          pin.stateKey,
          pin.designNodeId,
          canonicalJsonText(pin.sourceLocator, "Generation Task Attempt Component source locator"),
          canonicalJsonText(pin.overrides, "Generation Task Attempt Component overrides"),
          pin.status,
        );
      }
      const sealed = this.db.prepare(
        `UPDATE generation_task_attempts SET materialization_sealed = 1
         WHERE task_id = ? AND plan_id = ? AND workspace_id = ? AND attempt = ?
           AND materialization_sealed = 0`,
      ).run(input.taskId, input.planId, input.workspaceId, input.attempt);
      if (Number(sealed.changes) !== 1) {
        throw new GenerationTaskMaterializationConflictError(task.id, "Attempt input could not be sealed");
      }
      const queued = this.db.prepare(
        `UPDATE generation_tasks
         SET status = 'queued', blocked_reason = NULL, blocked_by_task_id = NULL,
             pending_context_policy = NULL, failure_class = NULL, error_json = NULL,
             next_eligible_at = NULL, finished_at = NULL
         WHERE id = ? AND plan_id = ? AND workspace_id = ? AND status = ? AND current_attempt = ?`,
      ).run(task.id, plan.id, plan.workspaceId, task.status, input.attempt);
      if (Number(queued.changes) !== 1) {
        throw new GenerationTaskMaterializationConflictError(task.id, "Task state changed before queueing");
      }
      this.appendGenerationPlanEventInTransaction({
        planId: plan.id,
        workspaceId: plan.workspaceId,
        taskId: task.id,
        type: "task-materialized",
        payload: {
          attempt: input.attempt,
          inputHash: input.inputHash,
          expectedSnapshotId: input.expectedSnapshotId,
          baseRevisionId: input.baseRevisionId,
          contextPackId: input.contextPackId,
          kernelRevisionId: input.kernelRevisionId,
          retryContextPolicy: input.retryContextPolicy,
          executionMode: input.executionMode,
        },
      });
      const attempt = this.readGenerationTaskAttemptInTransaction(input.taskId, input.attempt);
      if (attempt === null || !this.generationTaskAttemptInputMatches(attempt, input)) {
        throw new WorkspaceStoreCodecError("Generation Task Attempt did not round-trip its immutable input");
      }
      return attempt;
    });
  }

  getGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    taskId: string,
    attempt: number,
  ): GenerationTaskAttempt | null {
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new WorkspaceStoreCodecError("Generation Task Attempt number must be a positive safe integer");
    }
    return this.transactionRead(() => {
      const plan = this.requireGenerationPlanForProject(projectId, planId);
      const owned = this.db.prepare(
        `SELECT 1 FROM generation_tasks
         WHERE id = ? AND plan_id = ? AND workspace_id = ?`,
      ).get(taskId, plan.id, plan.workspaceId);
      if (!owned) throw new GenerationTaskNotFoundError(taskId);
      const materialized = this.readGenerationTaskAttemptInTransaction(taskId, attempt);
      if (materialized !== null) this.assertGenerationTaskMaterializedEventInTransaction(materialized);
      return materialized;
    });
  }

  recordGenerationTaskMaterializationFailureForProject(
    projectId: string,
    planId: string,
    unsafeInput: RecordGenerationTaskMaterializationFailureInput,
  ): GenerationTaskMaterializationFailure {
    const input = normalizeRecordGenerationTaskMaterializationFailureInput(unsafeInput);
    return this.transactionImmediate(() => {
      const detail = this.readGenerationPlanDetailForProject(projectId, planId);
      const taskById = new Map(detail.tasks.map((task) => [task.id, task]));
      const task = taskById.get(input.taskId);
      if (!task) throw new GenerationTaskNotFoundError(input.taskId);
      if (task.materializationFailures > input.expectedFailureCount) {
        const existing = this.readGenerationTaskMaterializationFailureInTransaction(
          task.id,
          input.expectedFailureCount + 1,
        );
        if (existing === null
          || existing.failureClass !== input.failureClass
          || !isDeepStrictEqual(existing.error, input.error)
          || (input.nextEligibleAt !== null && existing.nextEligibleAt !== input.nextEligibleAt)) {
          throw new GenerationTaskMaterializationConflictError(
            task.id,
            "the expected materialization failure was already recorded with different immutable input",
          );
        }
        this.assertGenerationTaskMaterializationFailureEventsInTransaction(existing);
        return existing;
      }
      if (task.materializationFailures !== input.expectedFailureCount) {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          `expected ${input.expectedFailureCount} prior materialization failures, found ${task.materializationFailures}`,
        );
      }
      if (!detail.plan.constructionSealed
        || (detail.plan.status !== "queued" && detail.plan.status !== "running")) {
        throw new GenerationPlanStateConflictError(detail.plan.id, detail.plan.status);
      }
      const now = this.clock.now();
      if (!this.generationTaskCanMaterialize(task, taskById, now)) {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          "a materialization failure can only be recorded for currently ready work",
        );
      }
      if (input.expectedFailureCount >= Number.MAX_SAFE_INTEGER) {
        throw new GenerationTaskMaterializationConflictError(task.id, "failure sequence is exhausted");
      }
      const sequence = input.expectedFailureCount + 1;
      const transient = input.failureClass === "adapter"
        || input.failureClass === "storage"
        || input.failureClass === "provider"
        || input.failureClass === "agent-transport"
        || input.failureClass === "build-infrastructure";
      const retryDelays = [1_000, 4_000, 16_000] as const;
      const retryDelay = transient ? retryDelays[sequence - 1] ?? null : null;
      const nextEligibleAt = retryDelay === null ? null : now + retryDelay;
      if (input.nextEligibleAt !== null && input.nextEligibleAt !== nextEligibleAt) {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          `next eligible time must use the exact ${retryDelay ?? 0}ms materialization backoff`,
        );
      }
      const status = input.failureClass === "context"
        ? "blocked-context"
        : nextEligibleAt !== null
          ? "retry-wait"
          : "failed";
      this.db.prepare(
        `INSERT INTO generation_task_materialization_failures (
           task_id, plan_id, workspace_id, sequence, failure_class,
           error_json, next_eligible_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        task.planId,
        task.workspaceId,
        sequence,
        input.failureClass,
        canonicalJsonText(input.error, "Generation Task materialization failure error"),
        nextEligibleAt,
        now,
      );
      const moved = this.db.prepare(
        `UPDATE generation_tasks
         SET status = ?, blocked_reason = ?, blocked_by_task_id = NULL,
             pending_context_policy = ?, failure_class = ?, error_json = ?,
             next_eligible_at = ?, finished_at = ?
         WHERE id = ? AND plan_id = ? AND workspace_id = ? AND status = ?
           AND materialization_failures = ?`,
      ).run(
        status,
        status === "blocked-context"
          ? (typeof input.error.message === "string" ? input.error.message : "Required Context is unavailable")
          : null,
        status === "blocked-context" ? "latest-context" : null,
        input.failureClass,
        canonicalJsonText(input.error, "Generation Task materialization failure error"),
        nextEligibleAt,
        status === "failed" ? now : null,
        task.id,
        task.planId,
        task.workspaceId,
        task.status,
        sequence,
      );
      if (Number(moved.changes) !== 1) {
        throw new GenerationTaskMaterializationConflictError(task.id, "Task changed while recording its failure");
      }
      const eventPayload = {
        sequence,
        failureClass: input.failureClass,
        error: input.error,
        nextEligibleAt,
        status,
      };
      this.appendGenerationPlanEventInTransaction({
        planId: task.planId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        type: "task-materialization-failed",
        payload: eventPayload,
      });
      this.appendGenerationPlanEventInTransaction({
        planId: task.planId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        type: status === "blocked-context"
          ? "task-blocked-context"
          : status === "retry-wait"
            ? "task-retry-wait"
            : "task-failed",
        payload: eventPayload,
      });
      if (status === "failed") {
        const blockedTaskIds = new Set([task.id]);
        let discoveredDescendant = true;
        while (discoveredDescendant) {
          discoveredDescendant = false;
          for (const candidate of detail.tasks) {
            if (blockedTaskIds.has(candidate.id)
              || !candidate.dependencyIds.some((dependencyId) => blockedTaskIds.has(dependencyId))) {
              continue;
            }
            blockedTaskIds.add(candidate.id);
            discoveredDescendant = true;
          }
        }
        for (const candidate of detail.tasks) {
          if (candidate.id === task.id || !blockedTaskIds.has(candidate.id)) {
            continue;
          }
          if (candidate.status === "succeeded" || candidate.status === "failed"
            || candidate.status === "blocked" || candidate.status === "cancelled") {
            continue;
          }
          if (candidate.currentAttempt !== 0) {
            throw new GenerationTaskMaterializationConflictError(
              candidate.id,
              "a materialization-failed prerequisite cannot block a descendant that already has an Attempt",
            );
          }
          const blockedReason = `Blocked by failed prerequisite ${task.id}`;
          const blocked = this.db.prepare(
            `UPDATE generation_tasks
             SET status = 'blocked', blocked_reason = ?, blocked_by_task_id = ?,
                 pending_context_policy = NULL, failure_class = ?, error_json = ?,
                 next_eligible_at = NULL, finished_at = ?
             WHERE id = ? AND plan_id = ? AND workspace_id = ? AND status = ? AND current_attempt = 0`,
          ).run(
            blockedReason,
            task.id,
            input.failureClass,
            canonicalJsonText(input.error, "Generation Task materialization failure error"),
            now,
            candidate.id,
            candidate.planId,
            candidate.workspaceId,
            candidate.status,
          );
          if (Number(blocked.changes) !== 1) {
            throw new GenerationTaskMaterializationConflictError(
              candidate.id,
              "descendant changed while propagating a terminal materialization failure",
            );
          }
          this.appendGenerationPlanEventInTransaction({
            planId: candidate.planId,
            workspaceId: candidate.workspaceId,
            taskId: candidate.id,
            type: "task-blocked",
            payload: { blockedByTaskId: task.id, reason: blockedReason },
          });
        }
        const nonterminal = this.db.prepare(
          `SELECT COUNT(*) AS count FROM generation_tasks
           WHERE plan_id = ? AND workspace_id = ?
             AND status NOT IN ('succeeded','failed','blocked','cancelled')`,
        ).get(task.planId, task.workspaceId) as { count: number };
        if (boundarySafeInteger(nonterminal.count, "Generation Plan nonterminal Task count") === 0) {
          const terminalized = this.db.prepare(
            `UPDATE generation_plans SET status = 'failed', finished_at = ?
             WHERE id = ? AND workspace_id = ? AND status IN ('queued','running')`,
          ).run(now, task.planId, task.workspaceId);
          if (Number(terminalized.changes) !== 1) {
            throw new GenerationTaskMaterializationConflictError(
              task.id,
              "Plan changed while terminalizing its materialization failure",
            );
          }
          this.appendGenerationPlanEventInTransaction({
            planId: task.planId,
            workspaceId: task.workspaceId,
            taskId: null,
            type: "plan-failed",
            payload: { failedTaskId: task.id, failureClass: input.failureClass },
          });
        }
      }
      const row = this.db.prepare(
        `SELECT * FROM generation_task_materialization_failures
         WHERE task_id = ? AND sequence = ?`,
      ).get(task.id, sequence) as Row | undefined;
      if (!row) throw new WorkspaceStoreCodecError("Generation Task materialization failure was not persisted");
      const failure = asGenerationTaskMaterializationFailure(row, sequence);
      this.assertGenerationTaskMaterializationFailureEventsInTransaction(failure);
      return failure;
    });
  }

  listGenerationTaskMaterializationFailuresForProject(
    projectId: string,
    planId: string,
    taskId: string,
  ): GenerationTaskMaterializationFailure[] {
    return this.transactionRead(() => {
      const plan = this.requireGenerationPlanForProject(projectId, planId);
      const task = this.db.prepare(
        `SELECT materialization_failures FROM generation_tasks
         WHERE id = ? AND plan_id = ? AND workspace_id = ?`,
      ).get(taskId, plan.id, plan.workspaceId) as { materialization_failures: number } | undefined;
      if (!task) throw new GenerationTaskNotFoundError(taskId);
      const rows = this.db.prepare(
        `SELECT * FROM generation_task_materialization_failures
         WHERE task_id = ? AND plan_id = ? AND workspace_id = ?
         ORDER BY sequence ASC`,
      ).all(taskId, plan.id, plan.workspaceId) as Row[];
      const failures = rows.map((row, index) => asGenerationTaskMaterializationFailure(row, index + 1));
      if (failures.length !== task.materialization_failures) {
        throw new WorkspaceStoreCodecError(
          `Generation Task ${taskId} materialization failure count does not match its history`,
        );
      }
      return failures;
    });
  }

  getArtifact(artifactId: string): WorkspaceArtifactRecord | null {
    const row = this.db.prepare("SELECT * FROM workspace_artifacts WHERE id = ?").get(artifactId) as Row | undefined;
    return row ? asWorkspaceArtifact(row) : null;
  }

  getTrack(trackId: string): ArtifactTrackRecord | null {
    const row = this.db.prepare("SELECT * FROM artifact_tracks WHERE id = ?").get(trackId) as Row | undefined;
    return row ? asArtifactTrack(row) : null;
  }

  getArtifactRevision(revisionId: string): ArtifactRevisionRecord | null {
    return this.transactionRead(() => {
      const revision = this.loadArtifactRevision(revisionId);
      if (revision === null) return null;
      this.validateArtifactRevisionLineage(revision);
      return revision;
    });
  }

  getArtifactRevisionContextChecksum(revisionId: string): string | null {
    return this.transactionRead(() => {
      const revision = this.loadArtifactRevision(revisionId);
      if (revision === null) return null;
      this.validateArtifactRevisionLineage(revision);
      return this.computeArtifactRevisionContextChecksum(revision);
    });
  }

  listArtifactRevisionDependencies(revisionId: string): ArtifactRevisionDependencyRecord[] {
    return this.transactionRead(() => {
      const revision = this.requireArtifactRevision(revisionId);
      const rows = this.db.prepare(
        `SELECT * FROM artifact_revision_dependencies
         WHERE revision_id = ? ORDER BY instance_id ASC`,
      ).all(revisionId) as Row[];
      const dependencies = rows.map(asArtifactRevisionDependency);
      this.validateArtifactDependencyRecords(revision, dependencies);
      return dependencies;
    });
  }

  listArtifactRevisionResourcePins(revisionId: string): ArtifactRevisionResourcePinRecord[] {
    return this.transactionRead(() => {
      const revision = this.requireArtifactRevision(revisionId);
      const rows = this.db.prepare(
        `SELECT * FROM artifact_revision_resources
         WHERE revision_id = ? ORDER BY resource_id ASC`,
      ).all(revisionId) as Row[];
      const pins = rows.map(asArtifactRevisionResourcePin);
      this.validateArtifactResourcePinRecords(revision, pins);
      return pins;
    });
  }

  getKernelRevision(revisionId: string): SharedDesignKernelRevision | null {
    return this.transactionRead(() => {
      const revision = this.loadKernelRevision(revisionId);
      if (revision === null) return null;
      this.validateKernelRevisionLineage(revision);
      return revision;
    });
  }

  analyzeKernelImpact(revisionId: string, baseSnapshotId: string): KernelImpactAnalysis {
    return this.transactionRead(() => {
      const revision = this.requireKernelRevision(revisionId);
      const snapshot = this.requireSnapshot(revision.workspaceId, baseSnapshotId);
      return this.computeKernelImpact(revision, snapshot);
    });
  }

  createArtifactRevision(unsafeInput: CreateArtifactRevisionInput): ArtifactRevisionRecord {
    const input = normalizeCreateArtifactRevisionInput(unsafeInput);
    return this.transactionImmediate(() => {
      const artifact = this.requireArtifact(input.artifactId);
      const track = this.requireTrack(input.trackId);
      if (artifact.archivedAt !== null) throw new WorkspaceGraphValidationError(`Artifact ${artifact.id} is archived`);
      if (!artifactHasValidSourceRoot(artifact)) {
        throw new WorkspaceGraphValidationError(`Artifact ${artifact.id} does not have its server-derived source root`);
      }
      if (artifact.activeTrackId !== track.id || track.artifactId !== artifact.id) {
        throw new WorkspaceGraphValidationError(`Artifact Revision must target Artifact ${artifact.id}'s active Track`);
      }
      this.guardPointer({
        pointer: "artifact-head",
        workspaceId: artifact.workspaceId,
        ownerId: track.id,
        expectedId: input.parentRevisionId,
        actualId: track.headRevisionId,
      });
      const kernel = this.requireKernelRevision(input.kernelRevisionId);
      if (kernel.workspaceId !== artifact.workspaceId) {
        throw new WorkspaceGraphValidationError("Artifact Revision Kernel belongs to another Workspace");
      }
      this.validateRunOwnership(artifact.workspaceId, input.producedByRunId ?? null, "Artifact Revision");
      this.validateArtifactRevisionPins(artifact, input);
      const sequence = this.nextSafeSequence(
        "artifact_revisions",
        "track_id",
        track.id,
        "Artifact Revision",
      );
      const revisionId = this.clock.id();
      const now = this.clock.now();
      this.db.prepare(
        `INSERT INTO artifact_revisions (
           id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
           source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
           render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
           legacy_run_id, created_at, sealed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      ).run(
        revisionId,
        artifact.workspaceId,
        artifact.id,
        track.id,
        sequence,
        input.parentRevisionId,
        input.sourceCommitHash,
        input.sourceTreeHash,
        artifact.sourceRoot,
        input.kernelRevisionId,
        JSON.stringify(input.renderSpec),
        JSON.stringify(input.quality),
        input.contextPackHash ?? null,
        input.producedByRunId ?? null,
        now,
      );
      const insertDependency = this.db.prepare(
        `INSERT INTO artifact_revision_dependencies (
           workspace_id, owner_artifact_id, revision_id, instance_id, component_artifact_id,
           component_revision_id, variant_key, state_key, design_node_id,
           source_locator_json, overrides_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const dependency of input.dependencies) {
        const existing = this.db.prepare(
          "SELECT * FROM component_instances WHERE id = ?",
        ).get(dependency.instanceId) as Row | undefined;
        if (dependency.createInstanceIdentity === true) {
          if (existing) throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} already exists`);
          this.db.prepare(
            `INSERT INTO component_instances
               (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(dependency.instanceId, artifact.workspaceId, artifact.id, dependency.componentArtifactId, now);
        } else if (!existing) {
          throw new WorkspaceGraphValidationError(
            `Component Instance ${dependency.instanceId} does not exist; createInstanceIdentity is required`,
          );
        } else if (existing.workspace_id !== artifact.workspaceId
          || existing.owner_artifact_id !== artifact.id
          || existing.component_artifact_id !== dependency.componentArtifactId) {
          throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} identity collision`);
        }
        insertDependency.run(
          artifact.workspaceId,
          artifact.id,
          revisionId,
          dependency.instanceId,
          dependency.componentArtifactId,
          dependency.componentRevisionId,
          dependency.variantKey ?? null,
          dependency.stateKey ?? null,
          dependency.sourceLocator.designNodeId,
          JSON.stringify(dependency.sourceLocator),
          JSON.stringify(dependency.overrides),
          dependency.status,
        );
      }
      const insertResourcePin = this.db.prepare(
        `INSERT INTO artifact_revision_resources
           (workspace_id, owner_artifact_id, revision_id, resource_id, resource_revision_id)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const pin of input.resourcePins) {
        insertResourcePin.run(artifact.workspaceId, artifact.id, revisionId, pin.resourceId, pin.resourceRevisionId);
      }
      const sealed = this.db.prepare(
        "UPDATE artifact_revisions SET sealed = 1 WHERE id = ? AND sealed = 0",
      ).run(revisionId);
      if (Number(sealed.changes) !== 1) {
        throw new WorkspaceGraphValidationError(`Artifact Revision ${revisionId} could not be sealed`);
      }
      return this.requireArtifactRevision(revisionId);
    });
  }

  publishArtifactRevision(
    revisionId: string,
    unsafeExpected: ArtifactPublicationExpectation,
  ): WorkspaceSnapshotRecord {
    const expected = normalizeArtifactPublicationExpectation(unsafeExpected);
    return this.transactionImmediate(() => {
      const revision = this.requireArtifactRevision(revisionId);
      const artifact = this.requireArtifact(revision.artifactId);
      const track = this.requireTrack(revision.trackId);
      if (artifact.workspaceId !== revision.workspaceId
        || artifact.activeTrackId !== track.id
        || track.artifactId !== artifact.id) {
        throw new WorkspaceGraphValidationError("Artifact publication target is not the active Track");
      }
      if (!artifactHasValidSourceRoot(artifact)
        || revision.artifactRoot !== artifact.sourceRoot) {
        throw new WorkspaceGraphValidationError(
          "Artifact publication root must match the owning Artifact's server-derived source root",
        );
      }
      if (revision.parentRevisionId !== expected.expectedHeadRevisionId) {
        throw new WorkspaceGraphValidationError("Artifact Revision parent does not match the expected Head");
      }
      this.guardPointer({
        pointer: "artifact-head",
        workspaceId: revision.workspaceId,
        ownerId: track.id,
        expectedId: expected.expectedHeadRevisionId,
        actualId: track.headRevisionId,
      });
      const workspace = this.requireWorkspaceById(revision.workspaceId);
      this.validateArtifactCandidateForPublication(revision, expected.expectedHeadRevisionId);
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: expected.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      const parent = this.requireSnapshot(workspace.id, expected.expectedSnapshotId);
      if (revision.kernelRevisionId !== parent.kernelRevisionId) {
        throw new WorkspaceGraphValidationError(
          "Artifact publication Kernel must match the expected base Snapshot Kernel",
        );
      }
      const derived = this.deriveUsesGraphForArtifactPublication(workspace, parent, revision);
      if (derived.changed) {
        this.reconcileDerivedUsesEdges(derived.graph);
        this.insertImmutableGraphRevision(derived.graph);
      }
      const movedHead = this.db.prepare(
        `UPDATE artifact_tracks SET head_revision_id = ?
         WHERE id = ? AND artifact_id = ? AND head_revision_id IS ?`,
      ).run(revision.id, track.id, artifact.id, expected.expectedHeadRevisionId);
      if (Number(movedHead.changes) !== 1) {
        const actual = this.requireTrack(track.id);
        throw new WorkspacePointerConflictError({
          pointer: "artifact-head",
          workspaceId: workspace.id,
          ownerId: track.id,
          expectedId: expected.expectedHeadRevisionId,
          actualId: actual.headRevisionId,
        });
      }
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: expected.expectedSnapshotId,
        graphRevision: derived.graph.revision,
        reason: "artifact-published",
        provenance: {
          kind: "artifact-publication",
          revisionId: revision.id,
          ...(revision.producedByRunId === null ? {} : { runId: revision.producedByRunId }),
        },
        artifactOverrides: [{
          artifactId: revision.artifactId,
          trackId: revision.trackId,
          revisionId: revision.id,
        }],
        createdByRunId: revision.producedByRunId,
      });
      const movedSnapshot = this.db.prepare(
        `UPDATE project_workspaces
         SET graph_revision = ?, active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND graph_revision = ? AND active_snapshot_id IS ?`,
      ).run(
        derived.graph.revision,
        snapshot.id,
        this.clock.now(),
        workspace.id,
        workspace.graphRevision,
        expected.expectedSnapshotId,
      );
      if (Number(movedSnapshot.changes) !== 1) {
        const actual = this.requireWorkspaceById(workspace.id);
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          workspaceId: workspace.id,
          ownerId: workspace.id,
          expectedId: expected.expectedSnapshotId,
          actualId: actual.activeSnapshotId,
        });
      }
      return snapshot;
    });
  }

  createKernelRevision(unsafeInput: CreateKernelRevisionInput): SharedDesignKernelRevision {
    const input = normalizeCreateKernelRevisionInput(unsafeInput);
    return this.transactionImmediate(() => {
      const workspace = this.requireWorkspaceById(input.workspaceId);
      this.guardPointer({
        pointer: "kernel-head",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: input.parentRevisionId,
        actualId: workspace.activeKernelRevisionId,
      });
      this.validateKernelSharedAssets(workspace.id, input.sharedAssetRevisionIds);
      const sequence = this.nextSafeSequence(
        "shared_design_kernel_revisions",
        "workspace_id",
        workspace.id,
        "Shared Design Kernel Revision",
      );
      const payload = {
        tokens: input.tokens,
        typography: input.typography,
        sharedAssetRevisionIds: input.sharedAssetRevisionIds,
        brief: input.brief,
        terminology: input.terminology,
        exclusions: input.exclusions,
        responsiveFrames: input.responsiveFrames,
        qualityProfile: input.qualityProfile,
      };
      const payloadJson = JSON.stringify(payload);
      const revisionId = this.clock.id();
      this.db.prepare(
        `INSERT INTO shared_design_kernel_revisions
           (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revisionId,
        workspace.id,
        sequence,
        input.parentRevisionId,
        payloadJson,
        checksum(payloadJson),
        this.clock.now(),
      );
      return this.requireKernelRevision(revisionId);
    });
  }

  publishKernelRevision(
    revisionId: string,
    unsafeExpected: KernelPublicationExpectation,
  ): WorkspaceSnapshotRecord {
    const expected = normalizeKernelPublicationExpectation(unsafeExpected);
    return this.transactionImmediate(() => {
      const revision = this.requireKernelRevision(revisionId);
      const workspace = this.requireWorkspaceById(revision.workspaceId);
      if (revision.parentRevisionId !== expected.expectedKernelRevisionId) {
        throw new WorkspaceGraphValidationError("Kernel Revision parent does not match the expected active Kernel");
      }
      const parentKernel = this.requireKernelRevision(expected.expectedKernelRevisionId);
      if (parentKernel.workspaceId !== workspace.id || parentKernel.sequence >= revision.sequence) {
        throw new WorkspaceGraphValidationError(
          "Kernel Revision parent must be an earlier Revision in the same Workspace",
        );
      }
      this.guardPointer({
        pointer: "kernel-head",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: expected.expectedKernelRevisionId,
        actualId: workspace.activeKernelRevisionId,
      });
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: expected.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      const parent = this.requireSnapshot(workspace.id, expected.expectedSnapshotId);
      const impact = this.computeKernelImpact(revision, parent);
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: expected.expectedSnapshotId,
        graphRevision: workspace.graphRevision,
        kernelRevisionId: revision.id,
        reason: "kernel-published",
        provenance: { kind: "kernel-publication", kernelRevisionId: revision.id, impact },
      });
      const moved = this.db.prepare(
        `UPDATE project_workspaces
         SET active_kernel_revision_id = ?, active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND active_kernel_revision_id = ? AND active_snapshot_id = ? AND graph_revision = ?`,
      ).run(
        revision.id,
        snapshot.id,
        this.clock.now(),
        workspace.id,
        expected.expectedKernelRevisionId,
        expected.expectedSnapshotId,
        workspace.graphRevision,
      );
      if (Number(moved.changes) !== 1) {
        const actual = this.requireWorkspaceById(workspace.id);
        if (actual.activeKernelRevisionId !== expected.expectedKernelRevisionId) {
          throw new WorkspacePointerConflictError({
            pointer: "kernel-head",
            workspaceId: workspace.id,
            ownerId: workspace.id,
            expectedId: expected.expectedKernelRevisionId,
            actualId: actual.activeKernelRevisionId,
          });
        }
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          workspaceId: workspace.id,
          ownerId: workspace.id,
          expectedId: expected.expectedSnapshotId,
          actualId: actual.activeSnapshotId,
        });
      }
      return snapshot;
    });
  }

  createWorkspaceSnapshot(
    projectId: string,
    unsafeInput: WorkspaceSnapshotPublicationInput,
  ): WorkspaceSnapshotRecord {
    const input = normalizeWorkspaceSnapshotPublicationInput(unsafeInput);
    this.validatePublicCheckpointProvenance(input.provenance);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: input.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      this.validateRunOwnership(workspace.id, input.createdByRunId ?? null, "Workspace Snapshot");
      return this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: input.expectedSnapshotId,
        graphRevision: workspace.graphRevision,
        reason: input.reason,
        provenance: input.provenance,
        createdByRunId: input.createdByRunId ?? null,
      });
    });
  }

  publishSnapshot(
    projectId: string,
    unsafeInput: WorkspaceSnapshotPublicationInput,
  ): WorkspaceSnapshotRecord {
    const input = normalizeWorkspaceSnapshotPublicationInput(unsafeInput);
    this.validatePublicCheckpointProvenance(input.provenance);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: input.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      this.validateRunOwnership(workspace.id, input.createdByRunId ?? null, "Workspace Snapshot");
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: input.expectedSnapshotId,
        graphRevision: workspace.graphRevision,
        reason: input.reason,
        provenance: input.provenance,
        createdByRunId: input.createdByRunId ?? null,
      });
      const moved = this.db.prepare(
        `UPDATE project_workspaces SET active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND active_snapshot_id = ? AND graph_revision = ? AND active_kernel_revision_id = ?`,
      ).run(
        snapshot.id,
        this.clock.now(),
        workspace.id,
        input.expectedSnapshotId,
        workspace.graphRevision,
        workspace.activeKernelRevisionId,
      );
      if (Number(moved.changes) !== 1) {
        const actual = this.requireWorkspaceById(workspace.id);
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          workspaceId: workspace.id,
          ownerId: workspace.id,
          expectedId: input.expectedSnapshotId,
          actualId: actual.activeSnapshotId,
        });
      }
      return snapshot;
    });
  }

  listArtifacts(projectId: string): WorkspaceArtifactRecord[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.db.prepare(
      `SELECT * FROM workspace_artifacts
       WHERE workspace_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(workspace.id) as Row[];
    return rows.map(asWorkspaceArtifact);
  }

  listTracks(projectId: string, artifactId: string): ArtifactTrackRecord[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.db.prepare(
      `SELECT t.*
       FROM artifact_tracks t
       JOIN workspace_artifacts a ON a.id = t.artifact_id
       WHERE a.workspace_id = ? AND a.id = ?
       ORDER BY t.created_at ASC, t.id ASC`,
    ).all(workspace.id, artifactId) as Row[];
    return rows.map(asArtifactTrack);
  }

  listRevisions(projectId: string, artifactId: string): ArtifactRevisionRecord[] {
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return [];
      const rows = this.db.prepare(
        `SELECT revision.*, artifact.source_root AS owning_source_root
         FROM artifact_revisions revision
         JOIN workspace_artifacts artifact
           ON artifact.id = revision.artifact_id AND artifact.workspace_id = revision.workspace_id
         WHERE revision.workspace_id = ? AND revision.artifact_id = ?
         ORDER BY revision.created_at ASC, revision.id ASC`,
      ).all(workspace.id, artifactId) as Row[];
      const context = this.readContext();
      const revisions = rows.map((row) => {
        const revision = asOwnedArtifactRevision(row);
        context.artifactRevisions.set(revision.id, revision);
        return revision;
      });
      return revisions.map((revision) => {
        this.validateArtifactRevisionLineage(revision);
        return revision;
      });
    });
  }

  listSnapshots(projectId: string): WorkspaceSnapshotRecord[] {
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return [];
      const rows = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE workspace_id = ?
         ORDER BY sequence ASC, id ASC`,
      ).all(workspace.id) as Row[];
      const context = this.readContext();
      const snapshots = rows.map((row) => {
        const snapshot = asWorkspaceSnapshotBase(row);
        context.snapshotBases.set(snapshot.id, snapshot);
        return snapshot;
      });
      return snapshots.map((snapshot) => this.requireSnapshot(workspace.id, snapshot.id));
    });
  }

  private insertWorkspaceFoundationInTransaction(projectId: string): ProjectWorkspace {
    if (!this.db.isTransaction) throw new Error("Workspace foundation insertion requires a transaction");
    const project = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as Row | undefined;
    if (!project) throw new Error(`project not found: ${projectId}`);
    const workspaceId = this.clock.id();
    const kernelRevisionId = this.clock.id();
    const snapshotId = this.clock.id();
    const now = this.clock.now();
    const emptyNodes = "[]";
    const emptyEdges = "[]";
    const kernelPayload = JSON.stringify(DEFAULT_KERNEL_PAYLOAD);
    this.db.prepare(
      `INSERT INTO project_workspaces (
         id, project_id, graph_revision, active_snapshot_id,
         active_kernel_revision_id, created_at, updated_at
       ) VALUES (?, ?, 0, NULL, NULL, ?, ?)`,
    ).run(workspaceId, projectId, now, now);
    this.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES (?, 0, ?, ?, ?, ?)`,
    ).run(workspaceId, emptyNodes, emptyEdges, checksum(`${emptyNodes}\n${emptyEdges}`), now);
    this.db.prepare(
      `INSERT INTO shared_design_kernel_revisions
         (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
       VALUES (?, ?, 1, NULL, ?, ?, ?)`,
    ).run(kernelRevisionId, workspaceId, kernelPayload, checksum(kernelPayload), now);
    this.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision,
         kernel_revision_id, reason, provenance_json, created_by_run_id, created_at
       ) VALUES (?, ?, 1, NULL, 0, ?, 'workspace-created', ?, NULL, ?)`,
    ).run(snapshotId, workspaceId, kernelRevisionId, JSON.stringify({ kind: "workspace-created" }), now);
    this.requireOneChange(
      this.db.prepare(
        `UPDATE project_workspaces
         SET active_snapshot_id = ?, active_kernel_revision_id = ?
         WHERE id = ? AND active_snapshot_id IS NULL AND active_kernel_revision_id IS NULL`,
      ).run(snapshotId, kernelRevisionId, workspaceId),
      `activate Workspace foundation ${workspaceId}`,
    );
    return requireWorkspace(this.getWorkspace(projectId), projectId);
  }

  private requireEmptyWorkspaceFoundation(workspace: ProjectWorkspace): void {
    if (workspace.graphRevision !== 0) {
      throw new WorkspaceGraphValidationError("legacy migration requires an empty Workspace foundation");
    }
    const graph = this.getGraph(workspace.projectId);
    const snapshots = this.listSnapshots(workspace.projectId);
    const kernel = this.requireKernelRevision(workspace.activeKernelRevisionId);
    const count = (table: string): number => Number((this.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`,
    ).get(workspace.id) as { count: number }).count);
    const empty = graph.nodes.length === 0
      && graph.edges.length === 0
      && count("workspace_artifacts") === 0
      && count("resources") === 0
      && count("workspace_nodes") === 0
      && count("workspace_edges") === 0
      && count("workspace_layout_nodes") === 0
      && count("workspace_layout_viewports") === 0
      && count("workspace_graph_commands") === 0
      && count("workspace_graph_revisions") === 1
      && count("shared_design_kernel_revisions") === 1
      && snapshots.length === 1;
    const foundation = snapshots[0];
    const kernelPayload = {
      tokens: kernel.tokens,
      typography: kernel.typography,
      sharedAssetRevisionIds: kernel.sharedAssetRevisionIds,
      brief: kernel.brief,
      terminology: kernel.terminology,
      exclusions: kernel.exclusions,
      responsiveFrames: kernel.responsiveFrames,
      qualityProfile: kernel.qualityProfile,
    };
    if (!empty
      || !foundation
      || foundation.id !== workspace.activeSnapshotId
      || foundation.sequence !== 1
      || foundation.parentSnapshotId !== null
      || foundation.graphRevision !== 0
      || foundation.kernelRevisionId !== workspace.activeKernelRevisionId
      || foundation.reason !== "workspace-created"
      || foundation.createdByRunId !== null
      || foundation.provenance.kind !== "workspace-created"
      || Object.keys(foundation.artifactTracks).length !== 0
      || Object.keys(foundation.artifactRevisions).length !== 0
      || Object.keys(foundation.resourceRevisions).length !== 0
      || kernel.sequence !== 1
      || kernel.parentRevisionId !== null
      || !isDeepStrictEqual(kernelPayload, DEFAULT_KERNEL_PAYLOAD)) {
      throw new WorkspaceGraphValidationError("legacy migration requires the canonical empty Workspace foundation");
    }
  }

  private requireCompletedLegacyStandardWorkspaceBundle(bundle: WorkspaceBundle): void {
    const invalid = (detail: string): never => {
      throw new WorkspaceGraphValidationError(`completed legacy Workspace migration is invalid: ${detail}`);
    };
    if (bundle.workspace.mode !== "standard") invalid("Project mode is not Standard");
    if (bundle.workspace.graphRevision < 1) invalid("active graph precedes the migration graph");
    if (bundle.activeSnapshot.id !== bundle.workspace.activeSnapshotId
      || bundle.activeSnapshot.graphRevision !== bundle.workspace.graphRevision
      || bundle.activeSnapshot.kernelRevisionId !== bundle.workspace.activeKernelRevisionId
      || bundle.activeKernelRevision.id !== bundle.workspace.activeKernelRevisionId
      || !graphsAreSemanticallyEqual(bundle.activeSnapshot.graph, bundle.graph)) {
      invalid("current Workspace pointers are incoherent");
    }

    const wrappers = bundle.artifacts.filter((artifact) => artifact.legacyWrapped);
    if (wrappers.length !== 1) invalid("expected exactly one wrapped Page");
    const wrapper = wrappers[0]!;
    if (wrapper.kind !== "page" || wrapper.sourceRoot !== "." || wrapper.activeTrackId === null) {
      invalid("wrapped Page identity is incomplete");
    }
    const activeTrack = bundle.tracks.find((track) => track.id === wrapper.activeTrackId);
    if (!activeTrack || activeTrack.artifactId !== wrapper.id) {
      invalid("wrapped Page active Track is not owned by the Page");
    }

    const foundations = bundle.snapshots.filter((snapshot) => snapshot.sequence === 1);
    const migrations = bundle.snapshots.filter(
      (snapshot) => snapshot.provenance.kind === "legacy-migration"
        && snapshot.provenance.migration === "legacy-standard-v1",
    );
    if (foundations.length !== 1 || migrations.length !== 1) {
      invalid("canonical foundation or migration Snapshot is missing");
    }
    const foundation = foundations[0]!;
    const migration = migrations[0]!;
    if (foundation.parentSnapshotId !== null
      || foundation.graphRevision !== 0
      || foundation.reason !== "workspace-created"
      || foundation.createdByRunId !== null
      || foundation.provenance.kind !== "workspace-created"
      || foundation.graph.revision !== 0
      || foundation.graph.nodes.length !== 0
      || foundation.graph.edges.length !== 0
      || Object.keys(foundation.artifactTracks).length !== 0
      || Object.keys(foundation.artifactRevisions).length !== 0
      || Object.keys(foundation.resourceRevisions).length !== 0) {
      invalid("foundation Snapshot is not canonical");
    }
    if (migration.sequence !== 2
      || migration.parentSnapshotId !== foundation.id
      || migration.graphRevision !== 1
      || migration.kernelRevisionId !== foundation.kernelRevisionId
      || migration.reason !== "legacy-standard-wrap"
      || migration.createdByRunId !== null
      || migration.provenance.kind !== "legacy-migration"
      || migration.provenance.migration !== "legacy-standard-v1"
      || migration.graph.revision !== 1
      || migration.graph.nodes.length !== 1
      || migration.graph.edges.length !== 0
      || Object.keys(migration.artifactTracks).length !== 1
      || Object.keys(migration.artifactRevisions).length !== 1
      || Object.keys(migration.resourceRevisions).length !== 0) {
      invalid("migration Snapshot is not canonical");
    }
    const migrationNode = migration.graph.nodes[0];
    const migrationTrackId = migration.artifactTracks[wrapper.id];
    const migrationRevisionId = migration.artifactRevisions[wrapper.id];
    if (!migrationNode
      || migrationNode.kind !== "page"
      || migrationNode.artifactId !== wrapper.id
      || migrationTrackId === undefined
      || migrationRevisionId === undefined) {
      invalid("migration Snapshot does not map the wrapped Page exactly");
    }
    const migrationTrack = bundle.tracks.find((track) => track.id === migrationTrackId);
    if (!migrationTrack || migrationTrack.artifactId !== wrapper.id) {
      invalid("migration Snapshot Track is not owned by the wrapped Page");
    }
    if (migrationRevisionId !== null) {
      const migrationRevision = bundle.revisions.find((revision) => revision.id === migrationRevisionId);
      if (!migrationRevision
        || migrationRevision.artifactId !== wrapper.id
        || migrationRevision.trackId !== migrationTrackId) {
        invalid("migration Snapshot Revision is not owned by its mapped Track");
      }
    }

    const foundationKernel = this.requireKernelRevision(foundation.kernelRevisionId);
    const foundationKernelPayload = {
      tokens: foundationKernel.tokens,
      typography: foundationKernel.typography,
      sharedAssetRevisionIds: foundationKernel.sharedAssetRevisionIds,
      brief: foundationKernel.brief,
      terminology: foundationKernel.terminology,
      exclusions: foundationKernel.exclusions,
      responsiveFrames: foundationKernel.responsiveFrames,
      qualityProfile: foundationKernel.qualityProfile,
    };
    if (foundationKernel.workspaceId !== bundle.workspace.id
      || foundationKernel.sequence !== 1
      || foundationKernel.parentRevisionId !== null
      || !isDeepStrictEqual(foundationKernelPayload, DEFAULT_KERNEL_PAYLOAD)) {
      invalid("foundation Kernel is not canonical");
    }
  }

  private proposalRow(proposalId: string): Row | null {
    const row = this.db.prepare(
      `SELECT proposal.*, workspace.project_id
       FROM workspace_proposals proposal
       JOIN project_workspaces workspace ON workspace.id = proposal.workspace_id
       WHERE proposal.id = ?`,
    ).get(proposalId) as Row | undefined;
    return row ?? null;
  }

  private decodeProposalCurrentRow(row: Row): WorkspaceProposalRecord {
    const workspaceId = requiredCell(row.workspace_id, "Workspace Proposal Workspace id");
    const baseGraph = this.requireGraphRevision(
      workspaceId,
      typeof row.base_graph_revision === "number" ? row.base_graph_revision : Number.NaN,
    );
    const baseLayout = asWorkspaceLayoutValue(
      parseJsonCell(row.base_layout_json, "Workspace Proposal base layout"),
    );
    const proposal = asWorkspaceProposal(row, baseGraph, baseLayout);
    const baseSnapshot = this.requireSnapshot(workspaceId, proposal.baseSnapshotId);
    if (baseSnapshot.graphRevision !== proposal.baseGraphRevision) {
      throw new WorkspaceStoreCodecError(
        `Workspace Proposal ${proposal.id} base Snapshot does not match its base graph`,
      );
    }
    return proposal;
  }

  private decodeProposalRow(row: Row): WorkspaceProposalRecord {
    const proposal = this.decodeProposalCurrentRow(row);
    const auditHistory = this.db.prepare(
      `SELECT COUNT(*) AS count, MIN(revision) AS first_revision, MAX(revision) AS latest_revision
       FROM workspace_proposal_audit WHERE proposal_id = ?`,
    ).get(proposal.id) as { count: number; first_revision: number | null; latest_revision: number | null };
    if (auditHistory.count !== proposal.revision
      || auditHistory.first_revision !== 1
      || auditHistory.latest_revision !== proposal.revision) {
      throw new WorkspaceStoreCodecError(
        `Workspace Proposal ${proposal.id} current revision does not match its contiguous audit history`,
      );
    }
    const auditRow = this.db.prepare(
      "SELECT * FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = ?",
    ).get(proposal.id, proposal.revision) as Row | undefined;
    if (!auditRow) {
      throw new WorkspaceStoreCodecError(
        `Workspace Proposal ${proposal.id} is missing immutable audit revision ${proposal.revision}`,
      );
    }
    const audited = asWorkspaceProposalAudit(auditRow);
    this.assertProposalCurrentAuditCoherence(proposal, audited);
    return proposal;
  }

  private assertProposalCurrentAuditCoherence(
    proposal: WorkspaceProposalRecord,
    audited: WorkspaceProposalRecord,
  ): void {
    const {
      status: proposalStatus,
      review: proposalReview,
      updatedAt: proposalUpdatedAt,
      ...proposalRevisionPayload
    } = proposal;
    const {
      status: auditStatus,
      review: auditReview,
      updatedAt: auditUpdatedAt,
      ...auditRevisionPayload
    } = audited;
    if (auditStatus !== "draft" || auditReview.kind !== "none"
      || !isDeepStrictEqual(proposalRevisionPayload, auditRevisionPayload)) {
      throw new WorkspaceStoreCodecError(
        `Workspace Proposal ${proposal.id} mutable payload does not match immutable audit revision ${proposal.revision}`,
      );
    }
    const reviewMatchesStatus = (proposalStatus === "draft" && proposalReview.kind === "none")
      || (proposalStatus === "approved" && proposalReview.kind === "approved")
      || (proposalStatus === "rejected" && proposalReview.kind === "rejected")
      || (proposalStatus === "conflicted" && proposalReview.kind === "conflict")
      || (proposalStatus === "superseded" && proposalReview.kind === "none");
    const timestampIsCoherent = proposalStatus === "draft"
      ? proposalUpdatedAt === auditUpdatedAt
      : proposalUpdatedAt >= auditUpdatedAt;
    if (!reviewMatchesStatus || !timestampIsCoherent) {
      throw new WorkspaceStoreCodecError(
        `Workspace Proposal ${proposal.id} review state does not match immutable audit revision ${proposal.revision}`,
      );
    }
  }

  private assertProposalAuditBaseCoherence(
    current: WorkspaceProposalRecord,
    audited: WorkspaceProposalRecord,
  ): void {
    const currentBase = {
      id: current.id,
      workspaceId: current.workspaceId,
      kind: current.kind,
      baseGraphRevision: current.baseGraphRevision,
      baseSnapshotId: current.baseSnapshotId,
      baseGraph: current.baseGraph,
      layoutId: current.layoutId,
      baseLayoutChecksum: current.baseLayoutChecksum,
      baseLayout: current.baseLayout,
      createdByRunId: current.createdByRunId,
      createdAt: current.createdAt,
    };
    const auditBase = {
      id: audited.id,
      workspaceId: audited.workspaceId,
      kind: audited.kind,
      baseGraphRevision: audited.baseGraphRevision,
      baseSnapshotId: audited.baseSnapshotId,
      baseGraph: audited.baseGraph,
      layoutId: audited.layoutId,
      baseLayoutChecksum: audited.baseLayoutChecksum,
      baseLayout: audited.baseLayout,
      createdByRunId: audited.createdByRunId,
      createdAt: audited.createdAt,
    };
    if (!isDeepStrictEqual(currentBase, auditBase)) {
      throw new WorkspaceStoreCodecError(
        `Workspace Proposal ${current.id} audit revision ${audited.revision} has incoherent base anchors`,
      );
    }
  }

  private requireProposalById(proposalId: string): WorkspaceProposalRecord {
    const row = this.proposalRow(proposalId);
    if (!row) throw new WorkspaceProposalNotFoundError(proposalId);
    return this.decodeProposalRow(row);
  }

  private requireProposalForProject(projectId: string, proposalId: string): WorkspaceProposalRecord {
    const row = this.proposalRow(proposalId);
    if (!row) throw new WorkspaceProposalNotFoundError(proposalId);
    const actualProjectId = requiredCell(row.project_id, "Workspace Proposal Project id");
    if (actualProjectId !== projectId) {
      throw new WorkspaceProposalOwnershipError(proposalId, projectId, actualProjectId);
    }
    return this.decodeProposalRow(row);
  }

  private readGenerationPlanDetailForProject(projectId: string, planId: string): GenerationPlanDetail {
    const plan = this.requireGenerationPlanForProject(projectId, planId);
    const taskRows = this.db.prepare(
      `SELECT * FROM generation_tasks
       WHERE plan_id = ? AND workspace_id = ?
       ORDER BY ordinal ASC`,
    ).all(plan.id, plan.workspaceId) as Row[];
    const dependencyRows = this.db.prepare(
      `SELECT * FROM generation_task_dependencies
       WHERE plan_id = ? AND workspace_id = ?
       ORDER BY task_id COLLATE BINARY ASC, ordinal ASC`,
    ).all(plan.id, plan.workspaceId) as Row[];
    const events = (this.db.prepare(
      `SELECT * FROM generation_plan_events
       WHERE plan_id = ? AND workspace_id = ?
       ORDER BY sequence ASC`,
    ).all(plan.id, plan.workspaceId) as Row[]).map(asGenerationPlanEvent);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.planId !== plan.id || event.sequence !== index + 1) {
        throw new WorkspaceStoreCodecError(
          `Generation Plan ${plan.id} event history is not a contiguous owned sequence`,
        );
      }
    }
    if (!plan.constructionSealed) {
      if (taskRows.length !== 0 || dependencyRows.length !== 0) {
        throw new WorkspaceStoreCodecError(
          `unsealed Generation Plan ${plan.id} cannot expose partially constructed Tasks`,
        );
      }
      if (plan.status !== "approved" && plan.status !== "compile-failed") {
        throw new WorkspaceStoreCodecError(
          `unsealed Generation Plan ${plan.id} has invalid status ${plan.status}`,
        );
      }
      if (plan.status === "approved") {
        if (plan.compileError !== null || plan.finishedAt !== null || events.length !== 0) {
          throw new WorkspaceStoreCodecError(
            `approved Generation Plan ${plan.id} cannot expose terminal compilation state`,
          );
        }
      } else {
        const event = events[0];
        if (plan.compileError === null || plan.finishedAt === null || events.length !== 1
          || event?.type !== "plan-compile-failed"
          || event.taskId !== null
          || !isDeepStrictEqual(event.payload, plan.compileError)) {
          throw new WorkspaceStoreCodecError(
            `compile-failed Generation Plan ${plan.id} does not match its terminal event`,
          );
        }
      }
      return { plan, tasks: [], dependencies: [] };
    }
    if (plan.status === "approved" || plan.status === "compile-failed" || taskRows.length === 0) {
      throw new WorkspaceStoreCodecError(
        `sealed Generation Plan ${plan.id} has an invalid construction state`,
      );
    }
    const dependenciesByTask = new Map<string, Row[]>();
    for (const row of dependencyRows) {
      const taskId = requiredCell(row.task_id, "Generation Task dependency Task id");
      const rows = dependenciesByTask.get(taskId) ?? [];
      rows.push(row);
      dependenciesByTask.set(taskId, rows);
    }
    const tasks = taskRows.map((row, ordinal) => {
      const taskId = requiredCell(row.id, "Generation Task id");
      const task = asGenerationTask(row, dependenciesByTask.get(taskId) ?? []);
      if (task.ordinal !== ordinal || task.planId !== plan.id || task.workspaceId !== plan.workspaceId) {
        throw new WorkspaceStoreCodecError(
          `Generation Plan ${plan.id} Tasks do not have contiguous owned ordinals`,
        );
      }
      return task;
    });
    const taskIds = new Set(tasks.map((task) => task.id));
    const dependencies: GenerationTaskDependency[] = tasks.flatMap((task) => task.dependencyIds.map(
      (dependencyTaskId, ordinal) => {
        if (!taskIds.has(dependencyTaskId)) {
          throw new WorkspaceStoreCodecError(
            `Generation Task ${task.id} depends on Task ${dependencyTaskId} outside its Plan`,
          );
        }
        return { planId: plan.id, taskId: task.id, dependencyTaskId, ordinal };
      },
    ));
    if (dependencies.length !== dependencyRows.length) {
      throw new WorkspaceStoreCodecError(`Generation Plan ${plan.id} dependency rows are not fully owned by its Tasks`);
    }
    const attemptRequiredStatuses = new Set([
      "queued",
      "running",
      "candidate-ready",
      "needs-rebase",
      "cancel-requested",
      "succeeded",
    ]);
    for (const task of tasks) {
      if (task.currentAttempt === 0) {
        if (attemptRequiredStatuses.has(task.status)) {
          throw new WorkspaceStoreCodecError(
            `Generation Task ${task.id} status ${task.status} requires an immutable current Attempt`,
          );
        }
        continue;
      }
      const attempt = this.readGenerationTaskAttemptInTransaction(task.id, task.currentAttempt);
      if (attempt === null || attempt.planId !== plan.id || attempt.workspaceId !== plan.workspaceId) {
        throw new WorkspaceStoreCodecError(
          `Generation Task ${task.id} current Attempt pointer is not an exact owned materialization`,
        );
      }
      this.assertGenerationTaskAttemptStatusCoherence(task, attempt);
      this.assertGenerationTaskMaterializedEventInTransaction(attempt);
    }
    assertAcyclicTaskGraph(tasks);
    this.assertGenerationPlanExecutionSummary(plan, tasks, events);
    return { plan, tasks, dependencies };
  }

  private generationTaskCanMaterialize(
    task: GenerationTask,
    taskById: ReadonlyMap<string, GenerationTask>,
    now: number,
  ): boolean {
    const stateIsReady = task.status === "materialization-pending"
      || task.status === "awaiting-context-refresh"
      || task.status === "needs-rebase"
      || (task.status === "retry-wait" && task.nextEligibleAt !== null && task.nextEligibleAt <= now);
    return stateIsReady
      && task.currentAttempt < Number.MAX_SAFE_INTEGER
      && task.dependencyIds.every((dependencyId) => taskById.get(dependencyId)?.status === "succeeded");
  }

  private generationTaskMaterializationExecutionModeInTransaction(
    task: GenerationTask,
  ): GenerationTaskExecutionMode {
    if (task.status === "needs-rebase") return "publication-only";
    if (task.status === "retry-wait" && task.currentAttempt > 0 && task.materializationFailures > 0) {
      const currentAttempt = this.readGenerationTaskAttemptInTransaction(task.id, task.currentAttempt);
      if (currentAttempt?.status === "needs-rebase") return "publication-only";
    }
    return "full";
  }

  private observeGenerationTaskMaterializationInTransaction(
    projectId: string,
    planId: string,
    taskId: string,
  ): GenerationTaskMaterializationObservation {
    const detail = this.readGenerationPlanDetailForProject(projectId, planId);
    if (!detail.plan.constructionSealed
      || (detail.plan.status !== "queued" && detail.plan.status !== "running")) {
      throw new GenerationPlanStateConflictError(detail.plan.id, detail.plan.status);
    }
    const taskById = new Map(detail.tasks.map((task) => [task.id, task]));
    const task = taskById.get(taskId);
    if (!task) throw new GenerationTaskNotFoundError(taskId);
    if (!this.generationTaskCanMaterialize(task, taskById, this.clock.now())) {
      throw new GenerationTaskMaterializationConflictError(
        task.id,
        "Task is not ready because its state, backoff, or dependencies have not succeeded",
      );
    }
    const workspace = this.requireWorkspaceById(detail.plan.workspaceId);
    const snapshot = this.requireSnapshot(workspace.id, workspace.activeSnapshotId);
    if (snapshot.graphRevision !== workspace.graphRevision
      || snapshot.kernelRevisionId !== workspace.activeKernelRevisionId) {
      throw new GenerationTaskMaterializationConflictError(
        task.id,
        "active Snapshot does not match the active graph and Kernel",
      );
    }
    const proposal = this.requireProposalForProject(projectId, detail.plan.proposalId);
    if (proposal.revision !== detail.plan.proposalRevision
      || proposal.generation.kind !== "workspace-generation") {
      throw new GenerationTaskMaterializationConflictError(
        task.id,
        "approved Proposal revision no longer matches the Plan",
      );
    }
    const generation = proposal.generation as WorkspaceGenerationPayload;
    const dependencyTasks = task.dependencyIds.map((dependencyId) => {
      const dependency = taskById.get(dependencyId);
      if (!dependency || dependency.status !== "succeeded") {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          `dependency ${dependencyId} has not succeeded`,
        );
      }
      return dependency;
    });
    const dependencyOutputs: GenerationTaskAttemptDependencyOutputInput[] = dependencyTasks.map((dependency) => ({
      taskId: dependency.id,
      resultRevisionId: dependency.resultRevisionId,
      resultResourceRevisionId: dependency.resultResourceRevisionId,
      resultSnapshotId: dependency.resultSnapshotId,
    }));

    let baseRevisionId: string | null = null;
    if (task.target.type === "artifact") {
      if (snapshot.artifactTracks[task.target.id] !== task.target.trackId
        || !Object.hasOwn(snapshot.artifactRevisions, task.target.id)) {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          "active Snapshot does not contain the exact target Artifact Track",
        );
      }
      baseRevisionId = snapshot.artifactRevisions[task.target.id] ?? null;
      const artifactPlan = generation.artifactPlans.find((plan) => plan.artifactId === task.target.id);
      if (!artifactPlan || artifactPlan.trackId !== task.target.trackId || artifactPlan.kind !== task.kind) {
        throw new GenerationTaskMaterializationConflictError(task.id, "target Artifact is absent from the approved Plan");
      }
      if (task.currentAttempt === 0 && artifactPlan.baseRevisionId !== baseRevisionId) {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          "target Artifact Head changed after approval",
        );
      }
    } else if (task.target.type === "resource") {
      baseRevisionId = snapshot.resourceRevisions[task.target.id] ?? null;
      const operation = generation.resourceOperations.find((candidate) => candidate.resourceId === task.target.id);
      if (!operation || operation.revisionPolicy.kind !== "generate") {
        throw new GenerationTaskMaterializationConflictError(task.id, "target Resource is absent from the approved Plan");
      }
      if ((operation.operation === "create") !== (baseRevisionId === null)) {
        throw new GenerationTaskMaterializationConflictError(
          task.id,
          "target Resource base does not match the approved create or revise operation",
        );
      }
      if (task.currentAttempt === 0) {
        const approvedSnapshot = this.requireSnapshot(workspace.id, detail.plan.baseSnapshotId);
        const approvedBaseRevisionId = approvedSnapshot.resourceRevisions[task.target.id] ?? null;
        if (baseRevisionId !== approvedBaseRevisionId) {
          throw new GenerationTaskMaterializationConflictError(
            task.id,
            "target Resource Head changed after approval",
          );
        }
      }
    }

    const resourcePins: GenerationTaskAttemptResourcePinInput[] = [];
    const componentPins: GenerationTaskAttemptComponentPinInput[] = [];
    if (task.target.type === "artifact") {
      const dependencies = generation.dependencyPlans
        .filter((dependency) => dependency.ownerArtifactId === task.target.id)
        .sort((left, right) => compareBinary(
          left.kind === "resource" ? `resource:${left.resourceId}` : `component:${left.instanceId}`,
          right.kind === "resource" ? `resource:${right.resourceId}` : `component:${right.instanceId}`,
        ));
      for (const dependency of dependencies) {
        if (dependency.kind === "resource") {
          const operation = generation.resourceOperations.find(
            (candidate) => candidate.resourceId === dependency.resourceId,
          );
          if (!operation) {
            throw new GenerationTaskMaterializationConflictError(
              task.id,
              `Resource dependency ${dependency.resourceId} has no approved operation`,
            );
          }
          let revisionId: string | null = null;
          let sourceTaskId: string | null = null;
          if (operation.revisionPolicy.kind === "generate") {
            const source = dependencyTasks.find((candidate) => candidate.target.type === "resource"
              && candidate.target.id === dependency.resourceId);
            revisionId = source?.resultResourceRevisionId ?? null;
            sourceTaskId = source?.id ?? null;
          } else if (operation.revisionPolicy.kind === "exact") {
            revisionId = operation.revisionPolicy.resourceRevisionId;
          } else {
            revisionId = snapshot.resourceRevisions[dependency.resourceId] ?? null;
          }
          if (revisionId === null) {
            throw new GenerationTaskMaterializationConflictError(
              task.id,
              `Resource dependency ${dependency.resourceId} has no exact Revision result`,
            );
          }
          const revision = this.requireResourceRevision(revisionId);
          if (revision.workspaceId !== workspace.id || revision.resourceId !== dependency.resourceId) {
            throw new GenerationTaskMaterializationConflictError(
              task.id,
              `Resource dependency ${dependency.resourceId} Revision belongs to another target`,
            );
          }
          resourcePins.push({ resourceId: dependency.resourceId, revisionId, sourceTaskId });
          continue;
        }
        let revisionId = dependency.componentRevisionId;
        let sourceTaskId: string | null = null;
        if (revisionId === null) {
          const source = dependencyTasks.find((candidate) => candidate.target.type === "artifact"
            && candidate.target.id === dependency.componentArtifactId
            && candidate.kind === "component");
          revisionId = source?.resultRevisionId ?? null;
          sourceTaskId = source?.id ?? null;
        }
        if (revisionId === null) {
          throw new GenerationTaskMaterializationConflictError(
            task.id,
            `Component dependency ${dependency.componentArtifactId} has no exact Revision result`,
          );
        }
        const revision = this.requireArtifactRevision(revisionId);
        const identity = this.db.prepare(
          `SELECT 1 FROM component_instances
           WHERE id = ? AND workspace_id = ? AND owner_artifact_id = ? AND component_artifact_id = ?`,
        ).get(
          dependency.instanceId,
          workspace.id,
          dependency.ownerArtifactId,
          dependency.componentArtifactId,
        );
        if (!identity || revision.workspaceId !== workspace.id
          || revision.artifactId !== dependency.componentArtifactId) {
          throw new GenerationTaskMaterializationConflictError(
            task.id,
            `Component dependency ${dependency.instanceId} identity or Revision is invalid`,
          );
        }
        componentPins.push({
          instanceId: dependency.instanceId,
          ownerArtifactId: dependency.ownerArtifactId,
          componentArtifactId: dependency.componentArtifactId,
          revisionId,
          sourceTaskId,
          variantKey: dependency.variantKey ?? null,
          stateKey: dependency.stateKey ?? null,
          sourceLocator: dependency.sourceLocator,
          overrides: dependency.overrides,
          status: dependency.status,
        });
      }
    }
    return {
      taskId: task.id,
      planId: task.planId,
      workspaceId: task.workspaceId,
      attempt: task.currentAttempt + 1,
      target: task.target,
      baseRevisionId,
      expectedSnapshotId: snapshot.id,
      kernelRevisionId: snapshot.kernelRevisionId,
      payload: task.payload,
      dependencyOutputs,
      resourcePins,
      componentPins,
    };
  }

  private validateGenerationTaskAttemptContextInTransaction(
    task: GenerationTask,
    input: GenerationTaskAttemptInput,
  ): void {
    const agentTask = task.kind === "resource" || task.kind === "component"
      || task.kind === "page" || task.kind === "propagation-candidate";
    if (!agentTask) {
      if (input.contextPackId !== null) {
        throw new GenerationTaskMaterializationConflictError(task.id, "non-Agent Task cannot bind a Context Pack");
      }
      return;
    }
    if (input.contextPackId === null) {
      throw new GenerationTaskMaterializationConflictError(task.id, "Agent Task requires a Context Pack");
    }
    const pack = this.getContextPack(task.workspaceId, input.contextPackId);
    const expectedTarget: ContextPackTarget = { type: task.target.type, id: task.target.id };
    const snapshot = this.requireSnapshot(task.workspaceId, input.expectedSnapshotId);
    if (!pack || pack.workspaceId !== task.workspaceId
      || pack.graphRevision !== snapshot.graphRevision
      || !isDeepStrictEqual(pack.target, expectedTarget)) {
      throw new GenerationTaskMaterializationConflictError(
        task.id,
        "Context Pack is missing, stale, or scoped to another target",
      );
    }
    if (pack.intent !== "generate") {
      throw new GenerationTaskMaterializationConflictError(
        task.id,
        "Generation Task Attempt Context Pack intent must be generate",
      );
    }
    const providedKernelIds = new Set(pack.items
      .filter((item) => item.provided && item.kernelRevisionId !== null)
      .map((item) => item.kernelRevisionId!));
    const providedArtifactRevisionIds = new Set(pack.items
      .filter((item) => item.provided && item.artifactRevisionId !== null)
      .map((item) => item.artifactRevisionId!));
    const providedResourceRevisionIds = new Set(pack.items
      .filter((item) => item.provided && item.resourceRevisionId !== null)
      .map((item) => item.resourceRevisionId!));
    const requiredArtifactRevisionIds = new Set(input.componentPins.map((pin) => pin.revisionId));
    const requiredResourceRevisionIds = new Set(input.resourcePins.map((pin) => pin.revisionId));
    if (input.baseRevisionId !== null) {
      if (task.target.type === "artifact") requiredArtifactRevisionIds.add(input.baseRevisionId);
      if (task.target.type === "resource") requiredResourceRevisionIds.add(input.baseRevisionId);
    }
    if (!providedKernelIds.has(input.kernelRevisionId)
      || [...requiredArtifactRevisionIds].some((revisionId) => !providedArtifactRevisionIds.has(revisionId))
      || [...requiredResourceRevisionIds].some((revisionId) => !providedResourceRevisionIds.has(revisionId))) {
      throw new GenerationTaskMaterializationConflictError(
        task.id,
        "Context Pack omits a required Kernel, base, Resource, or Component Revision",
      );
    }
  }

  private generationTaskAttemptMatchesObservation(
    input: GenerationTaskAttemptInput,
    observation: GenerationTaskMaterializationObservation,
  ): boolean {
    return input.taskId === observation.taskId
      && input.planId === observation.planId
      && input.workspaceId === observation.workspaceId
      && input.attempt === observation.attempt
      && isDeepStrictEqual(input.target, observation.target)
      && input.baseRevisionId === observation.baseRevisionId
      && input.expectedSnapshotId === observation.expectedSnapshotId
      && input.kernelRevisionId === observation.kernelRevisionId
      && isDeepStrictEqual(input.payload, observation.payload)
      && isDeepStrictEqual(
        input.dependencyOutputs.map(({ ordinal: _ordinal, ...output }) => output),
        observation.dependencyOutputs,
      )
      && isDeepStrictEqual(
        input.resourcePins.map(({ ordinal: _ordinal, ...pin }) => pin),
        observation.resourcePins,
      )
      && isDeepStrictEqual(
        input.componentPins.map(({ ordinal: _ordinal, designNodeId: _designNodeId, ...pin }) => pin),
        observation.componentPins,
      );
  }

  private generationTaskAttemptInputMatches(
    attempt: GenerationTaskAttempt,
    input: GenerationTaskAttemptInput,
  ): boolean {
    return attempt.inputHash === input.inputHash
      && attempt.taskId === input.taskId
      && attempt.planId === input.planId
      && attempt.workspaceId === input.workspaceId
      && attempt.attempt === input.attempt
      && isDeepStrictEqual(attempt.target, input.target)
      && attempt.baseRevisionId === input.baseRevisionId
      && attempt.expectedSnapshotId === input.expectedSnapshotId
      && attempt.contextPackId === input.contextPackId
      && attempt.kernelRevisionId === input.kernelRevisionId
      && isDeepStrictEqual(attempt.payload, input.payload)
      && isDeepStrictEqual(attempt.dependencyOutputs, input.dependencyOutputs)
      && isDeepStrictEqual(attempt.resourcePins, input.resourcePins)
      && isDeepStrictEqual(attempt.componentPins, input.componentPins)
      && attempt.retryContextPolicy === input.retryContextPolicy
      && attempt.executionMode === input.executionMode;
  }

  private readGenerationTaskForExecutionInTransaction(taskId: string): GenerationTask | null {
    const row = this.db.prepare(
      "SELECT * FROM generation_tasks WHERE id = ?",
    ).get(taskId) as Row | undefined;
    if (!row) return null;
    const dependencyRows = this.db.prepare(
      `SELECT * FROM generation_task_dependencies
       WHERE task_id = ? AND plan_id = ? AND workspace_id = ?
       ORDER BY ordinal ASC`,
    ).all(
      taskId,
      requiredCell(row.plan_id, "Generation Task execution Plan id"),
      requiredCell(row.workspace_id, "Generation Task execution Workspace id"),
    ) as Row[];
    return asGenerationTask(row, dependencyRows);
  }

  private generationTaskWriterClaimKeys(task: GenerationTask): string[] {
    const workspaceKey = generationClaimKeyId(task.workspaceId);
    if (task.target.type === "artifact") {
      return [`writer:artifact:${workspaceKey}:${generationClaimKeyId(task.target.id)}`];
    }
    if (task.target.type === "resource") {
      return [`writer:resource:${workspaceKey}:${generationClaimKeyId(task.target.id)}`];
    }
    if (task.kind === "checkpoint") {
      return [`writer:checkpoint:${workspaceKey}`];
    }
    return [];
  }

  private readGenerationTaskExecutionLeaseInTransaction(
    task: GenerationTask,
    attemptNumber: number,
  ): GenerationTaskExecutionLease {
    const attempt = this.readGenerationTaskAttemptInTransaction(task.id, attemptNumber);
    if (!attempt || !attempt.lease || attempt.leaseExpiresAt === null || attempt.heartbeatAt === null
      || (attempt.status !== "running" && attempt.status !== "candidate-ready"
        && attempt.status !== "cancel-requested")) {
      throw new WorkspaceStoreCodecError(
        `Generation Task ${task.id}/${attemptNumber} does not have a coherent live Attempt lease`,
      );
    }
    if (task.currentAttempt !== attemptNumber
      || (task.status !== "running" && task.status !== "candidate-ready"
        && task.status !== "cancel-requested")) {
      throw new WorkspaceStoreCodecError(
        `Generation Task ${task.id}/${attemptNumber} current state does not match its live Attempt lease`,
      );
    }
    const claimRows = this.db.prepare(
      `SELECT * FROM generation_task_claims
       WHERE task_id = ? AND attempt = ?
       ORDER BY claim_key COLLATE BINARY ASC`,
    ).all(task.id, attemptNumber) as Row[];
    const claims = claimRows.map(asGenerationTaskClaim);
    const expectedWriterClaimKeys = this.generationTaskWriterClaimKeys(task).sort(compareBinary);
    const capacityClaims = new Map<string, GenerationTaskClaim>();
    const writerClaimKeys: string[] = [];
    let sharedCreatedAt: number | null = null;
    for (let index = 0; index < claims.length; index += 1) {
      const claim = claims[index]!;
      if (index > 0 && compareBinary(claims[index - 1]!.claimKey, claim.claimKey) >= 0) {
        throw new WorkspaceStoreCodecError("Generation Task claims are not in unique canonical binary order");
      }
      if (claim.taskId !== task.id || claim.planId !== task.planId
        || claim.workspaceId !== task.workspaceId || claim.attempt !== attemptNumber
        || claim.ownerId !== attempt.lease.ownerId
        || claim.leaseToken !== attempt.lease.leaseToken
        || claim.leaseExpiresAt !== attempt.leaseExpiresAt) {
        throw new WorkspaceStoreCodecError(
          `Generation Task ${task.id}/${attemptNumber} claim set does not match its Attempt fence`,
        );
      }
      if (sharedCreatedAt === null) sharedCreatedAt = claim.createdAt;
      if (claim.createdAt !== sharedCreatedAt || claim.leaseExpiresAt <= claim.createdAt) {
        throw new WorkspaceStoreCodecError(
          `Generation Task ${task.id}/${attemptNumber} claims do not share one positive lease interval`,
        );
      }
      if (claim.claimKind === "capacity") {
        const match = /^capacity:(agent|render-qa|image):([1-3])$/.exec(claim.claimKey);
        if (!match) {
          throw new WorkspaceStoreCodecError("Generation Task capacity Claim key is not canonical");
        }
        const capacityClass = match[1]!;
        if (capacityClaims.has(capacityClass)) {
          throw new WorkspaceStoreCodecError(
            `Generation Task ${task.id}/${attemptNumber} holds duplicate ${capacityClass} capacity`,
          );
        }
        capacityClaims.set(capacityClass, claim);
      } else {
        writerClaimKeys.push(claim.claimKey);
      }
    }
    const expectedCapacityClasses = [...task.resourceLimits.capacityClasses].sort(compareBinary);
    const actualCapacityClasses = [...capacityClaims.keys()].sort(compareBinary);
    if (!isDeepStrictEqual(actualCapacityClasses, expectedCapacityClasses)
      || !isDeepStrictEqual(writerClaimKeys, expectedWriterClaimKeys)
      || claims.length !== expectedCapacityClasses.length + expectedWriterClaimKeys.length) {
      throw new WorkspaceStoreCodecError(
        `Generation Task ${task.id}/${attemptNumber} does not hold its exact required claim set`,
      );
    }
    return {
      ...attempt.lease,
      planId: task.planId,
      leaseExpiresAt: attempt.leaseExpiresAt,
      heartbeatAt: attempt.heartbeatAt,
      claims,
    };
  }

  private readGenerationTaskAttemptClaimInTransaction(
    task: GenerationTask,
    attemptNumber: number,
  ): GenerationTaskAttemptClaim {
    const executionLease = this.readGenerationTaskExecutionLeaseInTransaction(task, attemptNumber);
    const attempt = this.readGenerationTaskAttemptInTransaction(task.id, attemptNumber);
    if (!attempt || !attempt.lease) {
      throw new WorkspaceStoreCodecError(
        `Generation Task ${task.id}/${attemptNumber} live Attempt disappeared while reading its claim`,
      );
    }
    return {
      attempt,
      lease: {
        taskId: executionLease.taskId,
        workspaceId: executionLease.workspaceId,
        attempt: executionLease.attempt,
        ownerId: executionLease.ownerId,
        leaseToken: executionLease.leaseToken,
      },
      claims: executionLease.claims,
    };
  }

  private readGenerationTaskAttemptInTransaction(
    taskId: string,
    attempt: number,
  ): GenerationTaskAttempt | null {
    const row = this.db.prepare(
      `SELECT * FROM generation_task_attempts WHERE task_id = ? AND attempt = ?`,
    ).get(taskId, attempt) as Row | undefined;
    if (!row) return null;
    const resourcePins = this.db.prepare(
      `SELECT * FROM generation_task_attempt_resource_pins
       WHERE task_id = ? AND attempt = ? ORDER BY ordinal ASC`,
    ).all(taskId, attempt) as Row[];
    const componentPins = this.db.prepare(
      `SELECT * FROM generation_task_attempt_component_pins
       WHERE task_id = ? AND attempt = ? ORDER BY ordinal ASC`,
    ).all(taskId, attempt) as Row[];
    const dependencyOutputs = this.db.prepare(
      `SELECT * FROM generation_task_attempt_dependency_outputs
       WHERE task_id = ? AND attempt = ? ORDER BY ordinal ASC`,
    ).all(taskId, attempt) as Row[];
    return asGenerationTaskAttempt(row, dependencyOutputs, resourcePins, componentPins);
  }

  private readGenerationTaskMaterializationFailureInTransaction(
    taskId: string,
    sequence: number,
  ): GenerationTaskMaterializationFailure | null {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
    const row = this.db.prepare(
      `SELECT * FROM generation_task_materialization_failures
       WHERE task_id = ? AND sequence = ?`,
    ).get(taskId, sequence) as Row | undefined;
    return row ? asGenerationTaskMaterializationFailure(row, sequence) : null;
  }

  private assertGenerationTaskAttemptStatusCoherence(
    task: GenerationTask,
    attempt: GenerationTaskAttempt,
  ): void {
    const allowedStatuses: Record<GenerationTask["status"], readonly GenerationTaskAttempt["status"][]> = {
      "materialization-pending": ["failed", "retryable-failed", "needs-rebase"],
      "retry-wait": ["failed", "retryable-failed", "needs-rebase"],
      "blocked-context": ["failed", "retryable-failed", "needs-rebase"],
      queued: ["queued"],
      running: ["running"],
      "candidate-ready": ["candidate-ready"],
      "needs-rebase": ["needs-rebase"],
      "awaiting-context-refresh": ["needs-rebase"],
      "cancel-requested": ["cancel-requested"],
      succeeded: ["succeeded"],
      failed: ["failed", "retryable-failed", "needs-rebase"],
      blocked: [],
      cancelled: ["cancelled"],
    };
    if (!allowedStatuses[task.status].includes(attempt.status)) {
      throw new WorkspaceStoreCodecError(
        `Generation Task ${task.id} status ${task.status} does not match current Attempt ${attempt.attempt} status ${attempt.status}`,
      );
    }
  }

  private assertGenerationTaskMaterializedEventInTransaction(attempt: GenerationTaskAttempt): void {
    const events = (this.db.prepare(
      `SELECT * FROM generation_plan_events
       WHERE plan_id = ? AND task_id = ? AND type = 'task-materialized'
       ORDER BY sequence ASC`,
    ).all(attempt.planId, attempt.taskId) as Row[]).map(asGenerationPlanEvent)
      .filter((event) => event.payload.attempt === attempt.attempt);
    const expectedPayload = {
      attempt: attempt.attempt,
      inputHash: attempt.inputHash,
      expectedSnapshotId: attempt.expectedSnapshotId,
      baseRevisionId: attempt.baseRevisionId,
      contextPackId: attempt.contextPackId,
      kernelRevisionId: attempt.kernelRevisionId,
      retryContextPolicy: attempt.retryContextPolicy,
      executionMode: attempt.executionMode,
    };
    if (events.length !== 1 || !isDeepStrictEqual(events[0]?.payload, expectedPayload)) {
      throw new WorkspaceStoreCodecError(
        `Generation Task Attempt ${attempt.taskId}/${attempt.attempt} does not match one materialized event`,
      );
    }
  }

  private assertGenerationTaskMaterializationFailureEventsInTransaction(
    failure: GenerationTaskMaterializationFailure,
  ): void {
    const status = failure.failureClass === "context"
      ? "blocked-context"
      : failure.nextEligibleAt === null
        ? "failed"
        : "retry-wait";
    const stateEventType = status === "blocked-context"
      ? "task-blocked-context"
      : status === "retry-wait"
        ? "task-retry-wait"
        : "task-failed";
    const expectedPayload = {
      sequence: failure.sequence,
      failureClass: failure.failureClass,
      error: failure.error,
      nextEligibleAt: failure.nextEligibleAt,
      status,
    };
    const events = (this.db.prepare(
      `SELECT * FROM generation_plan_events
       WHERE plan_id = ? AND task_id = ?
         AND type IN ('task-materialization-failed', ?)
       ORDER BY sequence ASC`,
    ).all(failure.planId, failure.taskId, stateEventType) as Row[])
      .map(asGenerationPlanEvent)
      .filter((event) => event.payload.sequence === failure.sequence);
    if (events.length !== 2
      || events[0]?.type !== "task-materialization-failed"
      || events[1]?.type !== stateEventType
      || events.some((event) => !isDeepStrictEqual(event.payload, expectedPayload))) {
      throw new WorkspaceStoreCodecError(
        `Generation Task materialization failure ${failure.taskId}/${failure.sequence} does not match its durable events`,
      );
    }
  }

  private assertGenerationPlanExecutionSummary(
    plan: GenerationPlan,
    tasks: readonly GenerationTask[],
    events: readonly GenerationPlanEvent[],
  ): void {
    const first = events[0];
    const queuedEvents = events.filter((event) => event.type === "plan-queued");
    const dependencyCount = tasks.reduce((count, task) => count + task.dependencyIds.length, 0);
    if (first?.type !== "plan-queued" || first.taskId !== null
      || queuedEvents.length !== 1
      || !isDeepStrictEqual(first.payload, { taskCount: tasks.length, dependencyCount })) {
      throw new WorkspaceStoreCodecError(
        `sealed Generation Plan ${plan.id} must begin with its exact durable queue event`,
      );
    }
    if (plan.compileError !== null) {
      throw new WorkspaceStoreCodecError(`sealed Generation Plan ${plan.id} cannot retain a compile error`);
    }
    const terminalEvents = events.filter((event) => event.type === "plan-succeeded"
      || event.type === "plan-failed"
      || event.type === "plan-cancelled"
      || event.type === "plan-compile-failed");
    const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
    if (!terminalStatuses.has(plan.status)) {
      if (plan.finishedAt !== null || terminalEvents.length !== 0) {
        throw new WorkspaceStoreCodecError(
          `non-terminal Generation Plan ${plan.id} cannot expose terminal execution history`,
        );
      }
      return;
    }
    const expectedEventType = plan.status === "succeeded"
      ? "plan-succeeded"
      : plan.status === "failed"
        ? "plan-failed"
        : "plan-cancelled";
    const last = events.at(-1);
    if (plan.finishedAt === null || terminalEvents.length !== 1
      || last?.type !== expectedEventType || last.taskId !== null) {
      throw new WorkspaceStoreCodecError(
        `terminal Generation Plan ${plan.id} does not match its final durable event`,
      );
    }
    const terminalTaskStatuses = new Set(["succeeded", "failed", "blocked", "cancelled"]);
    if (tasks.some((task) => !terminalTaskStatuses.has(task.status))) {
      throw new WorkspaceStoreCodecError(
        `terminal Generation Plan ${plan.id} retains a non-terminal Task`,
      );
    }
    if (plan.status === "succeeded" && tasks.some((task) => task.status !== "succeeded")) {
      throw new WorkspaceStoreCodecError(
        `succeeded Generation Plan ${plan.id} retains an unsuccessful Task`,
      );
    }
    if (plan.status === "failed" && !tasks.some((task) => task.status === "failed" || task.status === "blocked")) {
      throw new WorkspaceStoreCodecError(
        `failed Generation Plan ${plan.id} has no failed or blocked Task`,
      );
    }
    if (plan.status === "cancelled" && !tasks.some((task) => task.status === "cancelled")) {
      throw new WorkspaceStoreCodecError(
        `cancelled Generation Plan ${plan.id} has no cancelled Task`,
      );
    }
  }

  private validateGenerationPlanShellSnapshotInTransaction(
    shell: GenerationPlan,
    proposal: WorkspaceProposalRecord,
  ): void {
    if (!this.db.isTransaction) {
      throw new Error("Generation Plan shell Snapshot validation requires a transaction");
    }
    const snapshot = this.requireSnapshot(shell.workspaceId, shell.baseSnapshotId);
    if (proposal.operations.length === 0) {
      if (snapshot.id !== proposal.baseSnapshotId) {
        throw new GenerationPlanCompileError(
          "proposal-base-mismatch",
          `Generation Plan ${shell.id} does not reuse the no-op Proposal base Snapshot`,
          { planId: shell.id, expectedSnapshotId: proposal.baseSnapshotId, actualSnapshotId: snapshot.id },
        );
      }
      return;
    }
    const proposalBase = this.requireSnapshot(proposal.workspaceId, proposal.baseSnapshotId);
    let expectedGraph: WorkspaceGraph;
    try {
      expectedGraph = applyWorkspaceGraphCommands(proposal.baseGraph, proposal.operations);
    } catch (error) {
      throw new GenerationPlanCompileError(
        "invalid-reference",
        `Generation Plan ${shell.id} cannot reproduce its approved Proposal graph`,
        { planId: shell.id, reason: error instanceof Error ? error.message : String(error) },
      );
    }
    const provenance = snapshot.provenance;
    if (snapshot.workspaceId !== proposal.workspaceId
      || snapshot.parentSnapshotId !== proposal.baseSnapshotId
      || snapshot.graphRevision !== expectedGraph.revision
      || snapshot.kernelRevisionId !== proposalBase.kernelRevisionId
      || !graphsAreSemanticallyEqual(snapshot.graph, expectedGraph)
      || provenance.kind !== "proposal-approval"
      || provenance.proposalId !== proposal.id
      || provenance.proposalRevision !== proposal.revision
      || provenance.planId !== shell.id) {
      throw new GenerationPlanCompileError(
        "proposal-base-mismatch",
        `Generation Plan ${shell.id} post-approval Snapshot does not match its immutable Proposal`,
        { planId: shell.id, snapshotId: snapshot.id, proposalId: proposal.id },
      );
    }
  }

  private ensureGenerationComponentInstanceIdentitiesInTransaction(
    proposal: WorkspaceProposalRecord,
  ): void {
    if (!this.db.isTransaction) {
      throw new Error("Generation Component Instance identity synchronization requires a transaction");
    }
    if (proposal.generation.kind !== "workspace-generation") {
      throw new GenerationPlanCompileError(
        "unsupported-proposal",
        "Generation Component Instance identities require a workspace-generation Proposal",
        { proposalId: proposal.id, kind: proposal.generation.kind },
      );
    }
    const artifactPlanKindById = new Map(
      proposal.generation.artifactPlans.map((plan) => [plan.artifactId, plan.kind] as const),
    );
    const artifactRow = this.db.prepare(
      `SELECT workspace_id, kind, archived_at
       FROM workspace_artifacts WHERE id = ?`,
    );
    const instanceRow = this.db.prepare(
      `SELECT workspace_id, owner_artifact_id, component_artifact_id
       FROM component_instances WHERE id = ?`,
    );
    const insertInstance = this.db.prepare(
      `INSERT INTO component_instances
         (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const dependencies = proposal.generation.dependencyPlans
      .filter((dependency) => dependency.kind === "component-instance")
      .sort((left, right) => compareBinary(left.instanceId, right.instanceId));
    for (const dependency of dependencies) {
      const owner = artifactRow.get(dependency.ownerArtifactId) as {
        workspace_id: string;
        kind: string;
        archived_at: number | null;
      } | undefined;
      const plannedOwnerKind = artifactPlanKindById.get(dependency.ownerArtifactId);
      if (!owner
        || owner.workspace_id !== proposal.workspaceId
        || owner.archived_at !== null
        || (owner.kind !== "page" && owner.kind !== "component")
        || plannedOwnerKind !== owner.kind) {
        throw new GenerationPlanCompileError(
          "invalid-reference",
          `generation dependency owner ${dependency.ownerArtifactId} is not an active same-Workspace ${plannedOwnerKind ?? "Artifact"}`,
          { ownerArtifactId: dependency.ownerArtifactId, instanceId: dependency.instanceId },
        );
      }
      const component = artifactRow.get(dependency.componentArtifactId) as {
        workspace_id: string;
        kind: string;
        archived_at: number | null;
      } | undefined;
      if (!component
        || component.workspace_id !== proposal.workspaceId
        || component.kind !== "component"
        || component.archived_at !== null) {
        throw new GenerationPlanCompileError(
          "invalid-reference",
          `generation dependency Component ${dependency.componentArtifactId} is not an active same-Workspace Component`,
          { componentArtifactId: dependency.componentArtifactId, instanceId: dependency.instanceId },
        );
      }
      const existing = instanceRow.get(dependency.instanceId) as {
        workspace_id: string;
        owner_artifact_id: string;
        component_artifact_id: string;
      } | undefined;
      if (existing) {
        if (existing.workspace_id !== proposal.workspaceId
          || existing.owner_artifact_id !== dependency.ownerArtifactId
          || existing.component_artifact_id !== dependency.componentArtifactId) {
          throw new GenerationPlanCompileError(
            "invalid-reference",
            `Component Instance ${dependency.instanceId} identity collision`,
            { instanceId: dependency.instanceId },
          );
        }
        continue;
      }
      insertInstance.run(
        dependency.instanceId,
        proposal.workspaceId,
        dependency.ownerArtifactId,
        dependency.componentArtifactId,
        this.clock.now(),
      );
    }
  }

  private appendGenerationPlanEventInTransaction(input: {
    planId: string;
    workspaceId: string;
    taskId: string | null;
    type: GenerationPlanEvent["type"];
    payload: Record<string, unknown>;
  }): GenerationPlanEvent {
    if (!this.db.isTransaction) throw new Error("Generation Plan event append requires a transaction");
    const planRow = this.db.prepare(
      "SELECT workspace_id FROM generation_plans WHERE id = ?",
    ).get(input.planId) as { workspace_id: unknown } | undefined;
    if (!planRow || planRow.workspace_id !== input.workspaceId) {
      throw new WorkspaceStoreCodecError("Generation Plan event ownership does not match its Plan");
    }
    const isTaskEvent = input.type.startsWith("task-");
    if (isTaskEvent !== (input.taskId !== null)) {
      throw new WorkspaceStoreCodecError("Generation Plan event Task ownership does not match its type");
    }
    if (input.taskId !== null) {
      const task = this.db.prepare(
        `SELECT 1 FROM generation_tasks
         WHERE id = ? AND plan_id = ? AND workspace_id = ?`,
      ).get(input.taskId, input.planId, input.workspaceId);
      if (!task) throw new WorkspaceStoreCodecError("Generation Plan event Task belongs to another Plan");
    }
    const summary = this.db.prepare(
      `SELECT COUNT(*) AS count, MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
       FROM generation_plan_events WHERE plan_id = ? AND workspace_id = ?`,
    ).get(input.planId, input.workspaceId) as {
      count: number;
      first_sequence: number | null;
      last_sequence: number | null;
    };
    const count = boundarySafeInteger(summary.count, "Generation Plan event count");
    if ((count === 0 && (summary.first_sequence !== null || summary.last_sequence !== null))
      || (count > 0 && (summary.first_sequence !== 1 || summary.last_sequence !== count))) {
      throw new WorkspaceStoreCodecError(`Generation Plan ${input.planId} event sequence is not contiguous`);
    }
    if (count >= Number.MAX_SAFE_INTEGER) {
      throw new WorkspaceStoreCodecError(`Generation Plan ${input.planId} event sequence is exhausted`);
    }
    const sequence = count + 1;
    const payload = boundaryJsonObject(input.payload, "Generation Plan event payload");
    const createdAt = this.clock.now();
    this.db.prepare(
      `INSERT INTO generation_plan_events (
         plan_id, workspace_id, sequence, task_id, type, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.planId,
      input.workspaceId,
      sequence,
      input.taskId,
      input.type,
      canonicalJsonText(payload, "Generation Plan event payload"),
      createdAt,
    );
    const row = this.db.prepare(
      `SELECT * FROM generation_plan_events
       WHERE plan_id = ? AND workspace_id = ? AND sequence = ?`,
    ).get(input.planId, input.workspaceId, sequence) as Row | undefined;
    if (!row) throw new WorkspaceStoreCodecError("Generation Plan event was not durably appended");
    return asGenerationPlanEvent(row);
  }

  private requireGenerationPlanForProject(projectId: string, planId: string): GenerationPlan {
    const row = this.db.prepare(
      `SELECT plan.*, workspace.project_id
       FROM generation_plans plan
       JOIN project_workspaces workspace ON workspace.id = plan.workspace_id
       WHERE plan.id = ?`,
    ).get(planId) as Row | undefined;
    if (!row) throw new GenerationPlanNotFoundError(planId);
    const actualProjectId = requiredCell(row.project_id, "Generation Plan Project id");
    if (actualProjectId !== projectId) {
      throw new GenerationPlanOwnershipError(planId, projectId, actualProjectId);
    }
    return asGenerationPlan(row);
  }

  private requireDraftProposal(projectId: string | null, proposalId: string): WorkspaceProposalRecord {
    const proposal = projectId === null
      ? this.requireProposalById(proposalId)
      : this.requireProposalForProject(projectId, proposalId);
    if (proposal.status !== "draft") {
      throw new WorkspaceProposalStateConflictError(proposal.id, proposal.status);
    }
    return proposal;
  }

  private insertProposalAuditInTransaction(proposal: WorkspaceProposalRecord): void {
    if (!this.db.isTransaction) throw new Error("Workspace Proposal audit insertion requires a transaction");
    this.db.prepare(
      `INSERT INTO workspace_proposal_audit (proposal_id, revision, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(proposal.id, proposal.revision, JSON.stringify(proposal), proposal.updatedAt);
  }

  private updateProposalScoped(
    projectId: string | null,
    proposalId: string,
    unsafeInput: UpdateWorkspaceProposalInput,
  ): WorkspaceProposalRecord {
    const input = normalizeUpdateWorkspaceProposalInput(unsafeInput);
    return this.transactionImmediate(() => {
      const current = this.requireDraftProposal(projectId, proposalId);
      if (current.revision !== input.expectedProposalRevision) {
        throw new WorkspaceProposalRevisionConflictError(
          current.id,
          input.expectedProposalRevision,
          current.revision,
        );
      }
      if (input.generation.kind !== current.kind) {
        throw new WorkspaceProposalValidationError("Workspace Proposal kind cannot change during an edit");
      }
      if (current.kind === "component-propagation") {
        throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new WorkspaceProposalValidationError("Workspace Proposal revision is exhausted");
      }
      const next: WorkspaceProposalRecord = {
        ...current,
        revision: current.revision + 1,
        operations: [...input.operations],
        layoutOperations: [...input.layoutOperations],
        generation: input.generation,
        rationale: input.rationale,
        assumptions: [...input.assumptions],
        review: { kind: "none" },
        updatedAt: this.clock.now(),
      };
      this.insertProposalAuditInTransaction(next);
      const moved = this.db.prepare(
        `UPDATE workspace_proposals
         SET revision = ?, operations_json = ?, layout_operations_json = ?, rationale = ?,
             assumptions_json = ?, generation_payload_json = ?, review_json = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND status = 'draft'`,
      ).run(
        next.revision,
        JSON.stringify(next.operations),
        JSON.stringify(next.layoutOperations),
        next.rationale,
        JSON.stringify(next.assumptions),
        JSON.stringify(next.generation),
        JSON.stringify(next.review),
        next.updatedAt,
        next.id,
        current.revision,
      );
      if (Number(moved.changes) !== 1) {
        const actual = this.requireProposalById(next.id);
        if (actual.status !== "draft") throw new WorkspaceProposalStateConflictError(actual.id, actual.status);
        throw new WorkspaceProposalRevisionConflictError(next.id, current.revision, actual.revision);
      }
      return this.requireProposalById(next.id);
    });
  }

  private rejectProposalScoped(projectId: string | null, proposalId: string): WorkspaceProposalRecord {
    return this.transactionImmediate(() => {
      const proposal = this.requireDraftProposal(projectId, proposalId);
      return this.markProposalStatusInTransaction(proposal, "rejected", { kind: "rejected" });
    });
  }

  private approveProposalScoped(
    projectId: string | null,
    proposalId: string,
    unsafeMode: WorkspaceProposalApprovalMode,
  ): ApprovedProposalResult {
    const mode = normalizeWorkspaceProposalApprovalMode(unsafeMode);
    const outcome = this.transactionImmediate<ProposalApprovedOutcome | ProposalConflictOutcome>(() => {
      const proposal = this.requireDraftProposal(projectId, proposalId);
      if (proposal.kind === "component-propagation") {
        throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
      }
      const workspace = this.requireWorkspaceById(proposal.workspaceId);
      const graph = this.getGraph(workspace.projectId);
      const layout = this.getLayoutByWorkspaceId(workspace.id, proposal.layoutId);
      const summary: WorkspaceProposalConflictSummary = {
        graphChanged: graph.revision !== proposal.baseGraphRevision,
        snapshotChanged: workspace.activeSnapshotId !== proposal.baseSnapshotId,
        layoutChanged: layout.checksum !== proposal.baseLayoutChecksum,
        expectedGraphRevision: proposal.baseGraphRevision,
        actualGraphRevision: graph.revision,
        expectedSnapshotId: proposal.baseSnapshotId,
        actualSnapshotId: workspace.activeSnapshotId,
        expectedLayoutChecksum: proposal.baseLayoutChecksum,
        actualLayoutChecksum: layout.checksum,
      };
      if (summary.graphChanged || summary.snapshotChanged || summary.layoutChanged) {
        const review: WorkspaceProposalReview = {
          kind: "conflict",
          expectedGraphRevision: summary.expectedGraphRevision,
          actualGraphRevision: summary.actualGraphRevision,
          expectedSnapshotId: summary.expectedSnapshotId,
          actualSnapshotId: summary.actualSnapshotId,
          expectedLayoutChecksum: summary.expectedLayoutChecksum,
          actualLayoutChecksum: summary.actualLayoutChecksum,
          graphChanged: summary.graphChanged,
          snapshotChanged: summary.snapshotChanged,
          layoutChanged: summary.layoutChanged,
        };
        const conflicted = this.markProposalStatusInTransaction(proposal, "conflicted", review);
        return { kind: "conflict", proposal: conflicted, summary };
      }
      this.validateLayoutGroups(workspace.id, proposal.layoutId, new Set(graph.nodes.map((node) => node.id)));

      this.validateProposalForApproval(proposal);
      const planId = mode === "generate" ? this.clock.id() : null;
      let result: WorkspaceGraphMutationResult;
      if (proposal.operations.length === 0) {
        if (proposal.layoutOperations.length > 0) {
          this.applyLayoutCommandsInTransaction(
            workspace.id,
            graph,
            proposal.layoutId,
            proposal.layoutOperations,
          );
        }
        result = {
          graph,
          snapshot: this.requireSnapshot(workspace.id, proposal.baseSnapshotId),
        };
      } else {
        result = this.applyGraphCommandsInTransaction(workspace, graph, {
          expectedSnapshotId: proposal.baseSnapshotId,
          commands: proposal.operations,
          reason: "proposal-approval",
          provenance: {
            kind: "proposal-approval",
            proposalId: proposal.id,
            proposalRevision: proposal.revision,
            ...(planId === null ? {} : { planId }),
          },
        });
        if (proposal.layoutOperations.length > 0) {
          this.applyLayoutCommandsInTransaction(
            workspace.id,
            result.graph,
            proposal.layoutId,
            proposal.layoutOperations,
          );
        }
      }
      const approved = this.markProposalStatusInTransaction(proposal, "approved", { kind: "approved", mode });
      const plan = planId === null
        ? null
        : this.insertGenerationPlanShellInTransaction(planId, approved, result.snapshot.id);
      const approvedLayout = this.getLayoutByWorkspaceId(workspace.id, proposal.layoutId);
      return {
        kind: "approved",
        result: {
          proposal: approved,
          graph: result.graph,
          snapshot: result.snapshot,
          layout: approvedLayout,
          plan,
        },
      };
    });
    if (outcome.kind === "conflict") {
      throw new WorkspaceProposalConflictError(outcome.proposal, outcome.summary);
    }
    return outcome.result;
  }

  private markProposalStatusInTransaction(
    proposal: WorkspaceProposalRecord,
    status: WorkspaceProposal["status"],
    review: WorkspaceProposalReview,
  ): WorkspaceProposalRecord {
    const moved = this.db.prepare(
      `UPDATE workspace_proposals
       SET status = ?, review_json = ?, updated_at = ?
       WHERE id = ? AND revision = ? AND status = 'draft'`,
    ).run(status, JSON.stringify(review), this.clock.now(), proposal.id, proposal.revision);
    if (Number(moved.changes) !== 1) {
      const actual = this.requireProposalById(proposal.id);
      throw new WorkspaceProposalStateConflictError(actual.id, actual.status);
    }
    return this.requireProposalById(proposal.id);
  }

  private insertGenerationPlanShellInTransaction(
    planId: string,
    proposal: WorkspaceProposalRecord,
    baseSnapshotId: string,
  ): GenerationPlan {
    if (!this.db.isTransaction) throw new Error("Generation Plan insertion requires a transaction");
    if (proposal.status !== "approved") {
      throw new WorkspaceProposalStateConflictError(proposal.id, proposal.status);
    }
    const snapshot = this.requireSnapshot(proposal.workspaceId, baseSnapshotId);
    if (snapshot.workspaceId !== proposal.workspaceId) {
      throw new WorkspaceProposalValidationError("Generation Plan base Snapshot belongs to another Workspace");
    }
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO generation_plans (
         id, workspace_id, proposal_id, proposal_revision, base_snapshot_id,
         status, compile_error_json, created_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, 'approved', NULL, ?, NULL)`,
    ).run(planId, proposal.workspaceId, proposal.id, proposal.revision, snapshot.id, now);
    const plan = this.getGenerationPlan(planId);
    if (!plan) throw new WorkspaceGraphValidationError(`Generation Plan ${planId} was not inserted`);
    return plan;
  }

  private validateProposalForApproval(proposal: WorkspaceProposalRecord): WorkspaceGraph {
    let graph = proposal.baseGraph;
    if (proposal.operations.length > 0) {
      try {
        graph = applyWorkspaceGraphCommands(proposal.baseGraph, proposal.operations);
      } catch (error) {
        if (error instanceof WorkspaceGraphValidationError) {
          throw new WorkspaceProposalValidationError(error.message);
        }
        throw error;
      }
    }
    const names = new Set<string>();
    for (const node of graph.nodes) {
      if (names.has(node.name)) throw new WorkspaceProposalValidationError(`duplicate Workspace node name ${node.name}`);
      names.add(node.name);
    }
    if (proposal.generation.kind !== "workspace-generation") {
      throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
    }
    const artifactNodes = new Map(
      graph.nodes.filter((node): node is WorkspaceArtifactNode => node.kind === "page" || node.kind === "component")
        .map((node) => [node.artifactId, node]),
    );
    const resourceNodes = new Map(
      graph.nodes.filter((node): node is WorkspaceResourceNode => node.kind === "resource")
        .map((node) => [node.resourceId, node]),
    );

    this.validateProposalArtifactPlans(proposal, artifactNodes);
    const resourceResolution = this.validateProposalResourceOperations(proposal, resourceNodes);
    this.validateProposalDependencies(proposal, artifactNodes, resourceNodes, resourceResolution);
    this.validateProposalPrototypeIntents(proposal, graph);
    return graph;
  }

  private validateCanonicalGraphResourceIdentities(
    workspaceId: string,
    graph: WorkspaceGraph,
  ): void {
    const creationKinds = new Map<string, string>();
    const commandRows = this.db.prepare(
      `SELECT command_id, payload_json
       FROM workspace_graph_commands
       WHERE workspace_id = ?
       ORDER BY result_revision ASC, batch_index ASC, command_id COLLATE BINARY ASC`,
    ).all(workspaceId) as Array<{ command_id: string; payload_json: string }>;
    for (const row of commandRows) {
      const [command] = normalizeWorkspaceGraphCommands([
        parseJsonCell(row.payload_json, `Workspace graph command ${row.command_id}`),
      ]);
      if (command?.type !== "add-node" || command.node.kind !== "resource"
        || command.node.createIdentity === undefined) continue;
      const existing = creationKinds.get(command.node.resourceId);
      const kind = command.node.createIdentity.resourceKind;
      if (existing !== undefined && existing !== kind) {
        throw new WorkspaceGraphValidationError(
          `Resource ${command.node.resourceId} has conflicting immutable creation identities`,
        );
      }
      creationKinds.set(command.node.resourceId, kind);
    }

    const resourceRow = this.db.prepare(
      `SELECT kind, title, head_revision_id, archived_at
       FROM resources WHERE id = ? AND workspace_id = ?`,
    );
    const ownedHead = this.db.prepare(
      `SELECT 1 FROM resource_revisions
       WHERE id = ? AND resource_id = ? AND workspace_id = ?`,
    );
    for (const node of graph.nodes) {
      if (node.kind !== "resource") continue;
      const resource = resourceRow.get(node.resourceId, workspaceId) as {
        kind: string;
        title: string;
        head_revision_id: string | null;
        archived_at: number | null;
      } | undefined;
      if (!resource || resource.archived_at !== null || resource.title !== node.name) {
        throw new WorkspaceGraphValidationError(
          `Workspace graph Resource ${node.resourceId} does not match an active owned identity`,
        );
      }
      const creationKind = creationKinds.get(node.resourceId);
      if (creationKind !== undefined && resource.kind !== creationKind) {
        throw new WorkspaceGraphValidationError(
          `Workspace graph Resource ${node.resourceId} does not match its immutable creation identity`,
        );
      }
      if (resource.head_revision_id !== null
        && !ownedHead.get(resource.head_revision_id, node.resourceId, workspaceId)) {
        throw new WorkspaceGraphValidationError(
          `Workspace graph Resource ${node.resourceId} Head is not an exact owned Revision`,
        );
      }
    }
  }

  private validateProposalArtifactPlans(
    proposal: WorkspaceProposalRecord,
    artifactNodes: ReadonlyMap<string, WorkspaceArtifactNode>,
  ): void {
    if (proposal.generation.kind !== "workspace-generation") {
      throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
    }
    const proposedArtifactIdentities = new Map<string, { nodeId: string; trackId: string }>();
    for (const command of proposal.operations) {
      if (command.type !== "add-node"
        || command.node.kind === "resource"
        || command.node.createIdentity === undefined) continue;
      proposedArtifactIdentities.set(command.node.artifactId, {
        nodeId: command.node.id,
        trackId: command.node.createIdentity.initialTrackId,
      });
    }
    const capabilityIds = new Set(proposal.generation.capabilities.map((capability) => capability.id));
    const frameIds = new Set(proposal.generation.responsiveFrames.map((frame) => frame.id));
    const plannedTrackIds = new Set<string>();
    for (const plan of proposal.generation.artifactPlans) {
      const node = artifactNodes.get(plan.artifactId);
      if (!node || node.kind !== plan.kind || node.id !== plan.nodeId) {
        throw new WorkspaceProposalValidationError(`missing generation dependency Artifact ${plan.artifactId}`);
      }
      if (node.name !== plan.name) {
        throw new WorkspaceProposalValidationError(
          `generation Artifact plan ${plan.artifactId} name does not match its final graph node`,
        );
      }
      if (plannedTrackIds.has(plan.trackId)) {
        throw new WorkspaceProposalValidationError(`duplicate generation Artifact Track ${plan.trackId}`);
      }
      plannedTrackIds.add(plan.trackId);
      const artifact = this.db.prepare(
        "SELECT id, workspace_id, kind FROM workspace_artifacts WHERE id = ?",
      ).get(plan.artifactId) as { id: string; workspace_id: string; kind: string } | undefined;
      if (plan.operation === "create") {
        if (artifact) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact create plan ${plan.artifactId} already has a durable identity`,
          );
        }
        if (plan.baseRevisionId !== null) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact create plan ${plan.artifactId} cannot have a base Revision`,
          );
        }
        const proposedIdentity = proposedArtifactIdentities.get(plan.artifactId);
        if (!proposedIdentity || proposedIdentity.nodeId !== plan.nodeId
          || proposedIdentity.trackId !== plan.trackId) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact create plan ${plan.artifactId} does not match its proposed identity and Track`,
          );
        }
        if (this.db.prepare("SELECT 1 FROM artifact_tracks WHERE id = ?").get(plan.trackId)) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact create Track ${plan.trackId} already exists`,
          );
        }
      } else {
        if (!artifact || artifact.workspace_id !== proposal.workspaceId || artifact.kind !== plan.kind) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact revise plan ${plan.artifactId} requires an existing owned Artifact`,
          );
        }
        const track = this.db.prepare(
          `SELECT track.id
           FROM artifact_tracks track
           JOIN workspace_artifacts artifact ON artifact.id = track.artifact_id
           WHERE track.id = ? AND track.artifact_id = ? AND artifact.workspace_id = ?`,
        ).get(plan.trackId, plan.artifactId, proposal.workspaceId);
        if (!track) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact revise plan ${plan.artifactId} requires an existing owned Track ${plan.trackId}`,
          );
        }
        if (plan.baseRevisionId === null) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact revise plan ${plan.artifactId} requires an exact base Revision`,
          );
        }
        const revision = this.db.prepare(
          `SELECT 1 FROM artifact_revisions
           WHERE id = ? AND workspace_id = ? AND artifact_id = ? AND track_id = ? AND sealed = 1`,
        ).get(plan.baseRevisionId, proposal.workspaceId, plan.artifactId, plan.trackId);
        if (!revision) {
          throw new WorkspaceProposalValidationError(
            `generation Artifact revise plan ${plan.artifactId} base Revision is not owned by its Track`,
          );
        }
      }
      for (const dependencyId of plan.dependsOnArtifactIds) {
        if (!artifactNodes.has(dependencyId)) {
          throw new WorkspaceProposalValidationError(`missing generation dependency Artifact ${dependencyId}`);
        }
      }
      for (const capabilityId of plan.capabilityIds) {
        if (!capabilityIds.has(capabilityId)) {
          throw new WorkspaceProposalValidationError(`missing generation capability ${capabilityId}`);
        }
      }
      for (const frameId of plan.responsiveFrameIds) {
        if (!frameIds.has(frameId)) {
          throw new WorkspaceProposalValidationError(`missing generation responsive frame ${frameId}`);
        }
      }
    }
  }

  private validateProposalResourceOperations(
    proposal: WorkspaceProposalRecord,
    resourceNodes: ReadonlyMap<string, WorkspaceResourceNode>,
  ): { basePinnedResourceIds: ReadonlySet<string>; operationResourceIds: ReadonlySet<string> } {
    if (proposal.generation.kind !== "workspace-generation") {
      throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
    }
    const plannedResources = new Map<string, { nodeId: string; resourceKind: string }>();
    for (const command of proposal.operations) {
      if (command.type !== "add-node" || command.node.kind !== "resource"
        || command.node.createIdentity === undefined) continue;
      plannedResources.set(command.node.resourceId, {
        nodeId: command.node.id,
        resourceKind: command.node.createIdentity.resourceKind,
      });
    }
    const basePins = new Map(
      (this.db.prepare(
        `SELECT mapping.resource_id, mapping.revision_id
         FROM workspace_snapshot_resources mapping
         JOIN workspace_snapshots snapshot
           ON snapshot.id = mapping.snapshot_id
          AND snapshot.workspace_id = mapping.workspace_id
          AND snapshot.sealed = 1
         JOIN resource_revisions revision
           ON revision.id = mapping.revision_id
          AND revision.resource_id = mapping.resource_id
          AND revision.workspace_id = mapping.workspace_id
         JOIN resources resource
           ON resource.id = mapping.resource_id
          AND resource.workspace_id = mapping.workspace_id
         WHERE mapping.workspace_id = ? AND mapping.snapshot_id = ?
           AND snapshot.graph_revision = ?`,
      ).all(
        proposal.workspaceId,
        proposal.baseSnapshotId,
        proposal.baseGraphRevision,
      ) as Array<{ resource_id: string; revision_id: string }>).map(
        (row) => [row.resource_id, row.revision_id] as const,
      ),
    );
    const operationResourceIds = new Set<string>();
    for (const operation of proposal.generation.resourceOperations) {
      const node = resourceNodes.get(operation.resourceId);
      if (!node || node.id !== operation.nodeId || node.name !== operation.title) {
        throw new WorkspaceProposalValidationError(
          `missing generation dependency Resource ${operation.resourceId}`,
        );
      }
      const planned = plannedResources.get(operation.resourceId);
      const resource = this.db.prepare(
        "SELECT id, workspace_id, kind, archived_at FROM resources WHERE id = ?",
      ).get(operation.resourceId) as {
        id: string;
        workspace_id: string;
        kind: string;
        archived_at: number | null;
      } | undefined;
      const ownedResource = resource !== undefined
        && resource.workspace_id === proposal.workspaceId
        && resource.archived_at === null
        && resource.kind === operation.kind;
      if (operation.operation === "create") {
        if (operation.revisionPolicy.kind !== "generate" || resource !== undefined
          || basePins.has(operation.resourceId) || !planned
          || planned.nodeId !== operation.nodeId || planned.resourceKind !== operation.kind) {
          throw new WorkspaceProposalValidationError(
            `generation Resource create operation ${operation.resourceId} requires a new matching planned identity`,
          );
        }
      } else if (operation.operation === "revise") {
        if (operation.revisionPolicy.kind !== "generate" || planned !== undefined
          || !ownedResource || !basePins.has(operation.resourceId)) {
          throw new WorkspaceProposalValidationError(
            `generation Resource revise operation ${operation.resourceId} requires an owned base Snapshot pin`,
          );
        }
      } else {
        if (operation.revisionPolicy.kind === "generate" || planned !== undefined || !ownedResource) {
          throw new WorkspaceProposalValidationError(
            `generation Resource reuse operation ${operation.resourceId} requires an owned immutable pin`,
          );
        }
        if (operation.revisionPolicy.kind === "base-snapshot") {
          if (!basePins.has(operation.resourceId)) {
            throw new WorkspaceProposalValidationError(
              `missing base Snapshot Resource revision for ${operation.resourceId}`,
            );
          }
        } else {
          const revision = this.db.prepare(
            `SELECT revision.id
             FROM resource_revisions revision
             JOIN resources resource
               ON resource.id = revision.resource_id
              AND resource.workspace_id = revision.workspace_id
             WHERE revision.id = ? AND revision.resource_id = ? AND revision.workspace_id = ?
               AND resource.archived_at IS NULL`,
          ).get(
            operation.revisionPolicy.resourceRevisionId,
            operation.resourceId,
            proposal.workspaceId,
          );
          if (!revision) {
            throw new WorkspaceProposalValidationError(
              `missing generation dependency Resource Revision ${operation.revisionPolicy.resourceRevisionId}`,
            );
          }
        }
      }
      operationResourceIds.add(operation.resourceId);
    }
    return {
      basePinnedResourceIds: new Set(basePins.keys()),
      operationResourceIds,
    };
  }

  private validateProposalDependencies(
    proposal: WorkspaceProposalRecord,
    artifactNodes: ReadonlyMap<string, WorkspaceArtifactNode>,
    resourceNodes: ReadonlyMap<string, WorkspaceResourceNode>,
    resourceResolution: {
      basePinnedResourceIds: ReadonlySet<string>;
      operationResourceIds: ReadonlySet<string>;
    },
  ): void {
    if (proposal.generation.kind !== "workspace-generation") {
      throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
    }
    const plannedComponentArtifactIds = new Set(
      proposal.generation.artifactPlans
        .filter((plan) => plan.kind === "component")
        .map((plan) => plan.artifactId),
    );
    const componentDependencyTargets = new Map<string, Set<string>>();
    const componentDependencyIndegree = new Map<string, number>();
    for (const [artifactId, node] of artifactNodes) {
      if (node.kind === "component") {
        componentDependencyTargets.set(artifactId, new Set());
        componentDependencyIndegree.set(artifactId, 0);
      }
    }
    for (const dependency of proposal.generation.dependencyPlans) {
      const owner = artifactNodes.get(dependency.ownerArtifactId);
      if (!owner) {
        throw new WorkspaceProposalValidationError(`missing generation dependency owner ${dependency.ownerArtifactId}`);
      }
      if (dependency.kind === "resource") {
        if (!resourceNodes.has(dependency.resourceId)
          || (!resourceResolution.basePinnedResourceIds.has(dependency.resourceId)
            && !resourceResolution.operationResourceIds.has(dependency.resourceId))) {
          throw new WorkspaceProposalValidationError(`missing generation dependency Resource ${dependency.resourceId}`);
        }
      } else {
        const component = artifactNodes.get(dependency.componentArtifactId);
        if (!component || component.kind !== "component") {
          throw new WorkspaceProposalValidationError(
            `missing generation dependency Component ${dependency.componentArtifactId}`,
          );
        }
        if (dependency.componentRevisionId === null) {
          if (!plannedComponentArtifactIds.has(dependency.componentArtifactId)) {
            throw new WorkspaceProposalValidationError(
              `generation dependency Component ${dependency.componentArtifactId} has no planned Revision result`,
            );
          }
        } else {
          const revision = this.db.prepare(
            `SELECT revision.id
             FROM artifact_revisions revision
             JOIN workspace_artifacts artifact
               ON artifact.id = revision.artifact_id
              AND artifact.workspace_id = revision.workspace_id
             JOIN artifact_tracks track
               ON track.id = revision.track_id
              AND track.artifact_id = revision.artifact_id
             WHERE revision.id = ? AND revision.workspace_id = ?
               AND revision.artifact_id = ? AND revision.sealed = 1
               AND artifact.kind = 'component' AND artifact.archived_at IS NULL`,
          ).get(
            dependency.componentRevisionId,
            proposal.workspaceId,
            dependency.componentArtifactId,
          );
          if (!revision) {
            throw new WorkspaceProposalValidationError(
              `generation dependency Component Revision ${dependency.componentRevisionId} is not an exact owned pin`,
            );
          }
        }
        if (dependency.status === "linked" && owner.kind === "component") {
          const targets = componentDependencyTargets.get(dependency.ownerArtifactId)!;
          if (!targets.has(dependency.componentArtifactId)) {
            targets.add(dependency.componentArtifactId);
            componentDependencyIndegree.set(
              dependency.componentArtifactId,
              componentDependencyIndegree.get(dependency.componentArtifactId)! + 1,
            );
          }
        }
      }
    }
    const acyclicComponentIds = [...componentDependencyIndegree]
      .filter(([, indegree]) => indegree === 0)
      .map(([artifactId]) => artifactId);
    let acyclicComponentCount = 0;
    for (let index = 0; index < acyclicComponentIds.length; index += 1) {
      const artifactId = acyclicComponentIds[index]!;
      acyclicComponentCount += 1;
      for (const targetArtifactId of componentDependencyTargets.get(artifactId)!) {
        const indegree = componentDependencyIndegree.get(targetArtifactId)! - 1;
        componentDependencyIndegree.set(targetArtifactId, indegree);
        if (indegree === 0) {
          acyclicComponentIds.push(targetArtifactId);
        }
      }
    }
    if (acyclicComponentCount !== componentDependencyIndegree.size) {
      throw new WorkspaceProposalValidationError("generation Component dependency plans cannot form a cycle");
    }
  }

  private validateProposalPrototypeIntents(
    proposal: WorkspaceProposalRecord,
    graph: WorkspaceGraph,
  ): void {
    if (proposal.generation.kind !== "workspace-generation") {
      throw new WorkspaceProposalValidationError("component-propagation Proposals are unavailable until Task 13");
    }
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const intent of proposal.generation.prototypeIntents) {
      const edge = graph.edges.find((candidate) => candidate.id === intent.edgeId);
      const source = edge ? nodesById.get(edge.sourceNodeId) : undefined;
      const target = edge ? nodesById.get(edge.targetNodeId) : undefined;
      if (!edge || edge.kind !== "prototype" || source?.kind !== "page" || target?.kind !== "page"
        || source.artifactId !== intent.sourceArtifactId || target.artifactId !== intent.targetArtifactId) {
        throw new WorkspaceProposalValidationError(`missing generation prototype edge ${intent.edgeId}`);
      }
    }
  }

  private requireWorkspaceById(workspaceId: string): ProjectWorkspace {
    const row = this.db.prepare(
      `SELECT workspace.*, project.mode
       FROM project_workspaces workspace
       JOIN projects project ON project.id = workspace.project_id
       WHERE workspace.id = ?`,
    ).get(workspaceId) as Row | undefined;
    if (!row) throw new Error(`workspace not found: ${workspaceId}`);
    return asProjectWorkspace(row);
  }

  private projectIdForWorkspace(workspaceId: string): string {
    const row = this.db.prepare("SELECT project_id FROM project_workspaces WHERE id = ?")
      .get(workspaceId) as { project_id: unknown } | undefined;
    return row ? requiredCell(row.project_id, "Workspace Project id") : "unknown";
  }

  private requireResourceForProject(projectId: string, resourceId: string): Resource {
    const row = this.db.prepare(
      `SELECT resource.*, workspace.project_id
       FROM resources resource
       JOIN project_workspaces workspace ON workspace.id = resource.workspace_id
       WHERE resource.id = ?`,
    ).get(resourceId) as Row | undefined;
    if (!row) throw new WorkspaceResourceNotFoundError(resourceId);
    const actualProjectId = requiredCell(row.project_id, "Resource owning Project id");
    if (actualProjectId !== projectId) {
      throw new WorkspaceResourceOwnershipError(resourceId, projectId, actualProjectId);
    }
    return asResource(row);
  }

  private loadResourceRevision(revisionId: string): ResourceRevision | null {
    const context = this.readContext();
    const cached = context.resourceRevisions.get(revisionId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare("SELECT * FROM resource_revisions WHERE id = ?")
      .get(revisionId) as Row | undefined;
    if (!row) return null;
    const revision = asResourceRevision(row);
    context.resourceRevisions.set(revision.id, revision);
    return revision;
  }

  private requireResourceRevision(revisionId: string): ResourceRevision {
    const revision = this.loadResourceRevision(revisionId);
    if (!revision) throw new Error(`Resource Revision not found: ${revisionId}`);
    this.validateResourceRevisionLineage(revision);
    return revision;
  }

  private validateResourceRevisionLineage(revision: ResourceRevision): void {
    const context = this.readContext();
    if (context.validatedResourceRevisionIds.has(revision.id)) return;
    const path: ResourceRevision[] = [];
    let child = revision;
    try {
      while (!context.validatedResourceRevisionIds.has(child.id)) {
        if (context.visitingResourceRevisionIds.has(child.id)) {
          throw new WorkspaceGraphValidationError(`Resource Revision ${revision.id} parent lineage contains a cycle`);
        }
        context.visitingResourceRevisionIds.add(child.id);
        path.push(child);
        const resource = this.db.prepare(
          "SELECT 1 FROM resources WHERE id = ? AND workspace_id = ?",
        ).get(child.resourceId, child.workspaceId);
        if (!resource) {
          throw new WorkspaceGraphValidationError(`Resource Revision ${revision.id} owner is not resolvable`);
        }
        this.validateRunOwnership(child.workspaceId, child.createdByRunId, "Resource Revision");
        if (child.parentRevisionId === null) break;
        const parent = this.loadResourceRevision(child.parentRevisionId);
        if (!parent) {
          throw new WorkspaceGraphValidationError(`Resource Revision ${revision.id} parent is not resolvable`);
        }
        if (parent.workspaceId !== child.workspaceId
          || parent.resourceId !== child.resourceId
          || parent.sequence >= child.sequence) {
          throw new WorkspaceGraphValidationError(
            `Resource Revision ${revision.id} parent must be an earlier Revision of the same Resource`,
          );
        }
        child = parent;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        context.validatedResourceRevisionIds.add(path[index]!.id);
      }
    } finally {
      for (const traversed of path) context.visitingResourceRevisionIds.delete(traversed.id);
    }
  }

  private requireArtifact(artifactId: string): WorkspaceArtifactRecord {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    return artifact;
  }

  private requireTrack(trackId: string): ArtifactTrackRecord {
    const track = this.getTrack(trackId);
    if (!track) throw new Error(`Artifact Track not found: ${trackId}`);
    return track;
  }

  private loadArtifactRevision(revisionId: string): ArtifactRevisionRecord | null {
    const context = this.readContext();
    const cached = context.artifactRevisions.get(revisionId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      `SELECT revision.*, artifact.source_root AS owning_source_root
       FROM artifact_revisions revision
       JOIN workspace_artifacts artifact
         ON artifact.id = revision.artifact_id AND artifact.workspace_id = revision.workspace_id
       WHERE revision.id = ?`,
    ).get(revisionId) as Row | undefined;
    if (!row) return null;
    const revision = asOwnedArtifactRevision(row);
    context.artifactRevisions.set(revision.id, revision);
    return revision;
  }

  private computeArtifactRevisionContextChecksum(revision: ArtifactRevisionRecord): string {
    const dependencyRows = this.db.prepare(
      `SELECT * FROM artifact_revision_dependencies
       WHERE revision_id = ? ORDER BY instance_id ASC`,
    ).all(revision.id) as Row[];
    const dependencies = dependencyRows.map(asArtifactRevisionDependency);
    this.validateArtifactDependencyRecords(revision, dependencies);
    const resourceRows = this.db.prepare(
      `SELECT * FROM artifact_revision_resources
       WHERE revision_id = ? ORDER BY resource_id ASC`,
    ).all(revision.id) as Row[];
    const resourcePins = resourceRows.map(asArtifactRevisionResourcePin);
    this.validateArtifactResourcePinRecords(revision, resourcePins);
    return artifactRevisionContextChecksum({ revision, dependencies, resourcePins });
  }

  private requireArtifactRevision(revisionId: string): ArtifactRevisionRecord {
    const revision = this.loadArtifactRevision(revisionId);
    if (!revision) throw new Error(`Artifact Revision not found: ${revisionId}`);
    this.validateArtifactRevisionLineage(revision);
    return revision;
  }

  private loadKernelRevision(revisionId: string): SharedDesignKernelRevision | null {
    const context = this.readContext();
    const cached = context.kernelRevisions.get(revisionId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      "SELECT * FROM shared_design_kernel_revisions WHERE id = ?",
    ).get(revisionId) as Row | undefined;
    if (!row) return null;
    const revision = asSharedDesignKernelRevision(row);
    context.kernelRevisions.set(revision.id, revision);
    return revision;
  }

  private requireKernelRevision(revisionId: string): SharedDesignKernelRevision {
    const revision = this.loadKernelRevision(revisionId);
    if (!revision) throw new Error(`Shared Design Kernel Revision not found: ${revisionId}`);
    this.validateKernelRevisionLineage(revision);
    return revision;
  }

  private validateArtifactRevisionReferences(revision: ArtifactRevisionRecord): void {
    const artifact = this.requireArtifact(revision.artifactId);
    const track = this.requireTrack(revision.trackId);
    const kernel = this.requireKernelRevision(revision.kernelRevisionId);
    if (artifact.workspaceId !== revision.workspaceId
      || !artifactHasValidSourceRoot(artifact)
      || revision.artifactRoot !== artifact.sourceRoot
      || track.artifactId !== revision.artifactId
      || kernel.workspaceId !== revision.workspaceId) {
      throw new WorkspaceGraphValidationError(
        `Artifact Revision ${revision.id} has a cross-owner Track or Kernel reference`,
      );
    }
    this.validateRunOwnership(revision.workspaceId, revision.producedByRunId, "Artifact Revision");
  }

  private validateArtifactRevisionLineage(revision: ArtifactRevisionRecord): void {
    const context = this.readContext();
    if (context.validatedArtifactRevisionIds.has(revision.id)) return;
    const path: ArtifactRevisionRecord[] = [];
    let child = revision;
    try {
      while (!context.validatedArtifactRevisionIds.has(child.id)) {
        if (context.visitingArtifactRevisionIds.has(child.id)) {
          throw new WorkspaceGraphValidationError(`Artifact Revision ${revision.id} parent lineage contains a cycle`);
        }
        context.visitingArtifactRevisionIds.add(child.id);
        path.push(child);
        this.validateArtifactRevisionReferences(child);
        if (child.parentRevisionId === null) break;
        const parent = this.loadArtifactRevision(child.parentRevisionId);
        if (parent === null) {
          throw new WorkspaceGraphValidationError(`Artifact Revision ${revision.id} parent is not resolvable`);
        }
        if (parent.workspaceId !== child.workspaceId
          || parent.artifactId !== child.artifactId
          || parent.trackId !== child.trackId
          || parent.sequence >= child.sequence) {
          throw new WorkspaceGraphValidationError(
            `Artifact Revision ${revision.id} parent must be an earlier sealed Revision on the same Track`,
          );
        }
        child = parent;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        context.validatedArtifactRevisionIds.add(path[index]!.id);
      }
    } finally {
      for (const traversed of path) context.visitingArtifactRevisionIds.delete(traversed.id);
    }
  }

  private validateKernelRevisionLineage(revision: SharedDesignKernelRevision): void {
    const context = this.readContext();
    if (context.validatedKernelRevisionIds.has(revision.id)) return;
    const path: SharedDesignKernelRevision[] = [];
    let child = revision;
    try {
      while (!context.validatedKernelRevisionIds.has(child.id)) {
        if (context.visitingKernelRevisionIds.has(child.id)) {
          throw new WorkspaceGraphValidationError(`Kernel Revision ${revision.id} parent lineage contains a cycle`);
        }
        context.visitingKernelRevisionIds.add(child.id);
        path.push(child);
        this.validateKernelSharedAssets(child.workspaceId, child.sharedAssetRevisionIds);
        if (child.parentRevisionId === null) break;
        const parent = this.loadKernelRevision(child.parentRevisionId);
        if (parent === null) {
          throw new WorkspaceGraphValidationError(`Kernel Revision ${revision.id} parent is not resolvable`);
        }
        if (parent.workspaceId !== child.workspaceId || parent.sequence >= child.sequence) {
          throw new WorkspaceGraphValidationError(
            `Kernel Revision ${revision.id} parent must be an earlier Revision in the same Workspace`,
          );
        }
        child = parent;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        context.validatedKernelRevisionIds.add(path[index]!.id);
      }
    } finally {
      for (const traversed of path) context.visitingKernelRevisionIds.delete(traversed.id);
    }
  }

  private validateArtifactDependencyRecords(
    revision: ArtifactRevisionRecord,
    dependencies: readonly ArtifactRevisionDependencyRecord[],
  ): void {
    const instances = new Set<string>();
    for (const dependency of dependencies) {
      if (instances.has(dependency.instanceId)) {
        throw new WorkspaceGraphValidationError(`duplicate Component Instance ${dependency.instanceId}`);
      }
      instances.add(dependency.instanceId);
      if (dependency.workspaceId !== revision.workspaceId
        || dependency.ownerArtifactId !== revision.artifactId
        || dependency.revisionId !== revision.id
        || dependency.componentArtifactId === revision.artifactId) {
        throw new WorkspaceGraphValidationError(
          `Artifact Revision ${revision.id} has a cross-owner Component dependency`,
        );
      }
      const componentRevision = this.requireArtifactRevision(dependency.componentRevisionId);
      const component = this.requireArtifact(dependency.componentArtifactId);
      const componentTrack = this.requireTrack(componentRevision.trackId);
      const instance = this.db.prepare(
        `SELECT 1 FROM component_instances
         WHERE id = ? AND workspace_id = ? AND owner_artifact_id = ? AND component_artifact_id = ?`,
      ).get(
        dependency.instanceId,
        revision.workspaceId,
        revision.artifactId,
        dependency.componentArtifactId,
      );
      if (component.workspaceId !== revision.workspaceId
        || component.kind !== "component"
        || componentRevision.workspaceId !== revision.workspaceId
        || componentRevision.artifactId !== dependency.componentArtifactId
        || componentTrack.artifactId !== dependency.componentArtifactId
        || !instance) {
        throw new WorkspaceGraphValidationError(
          `Component Revision ${dependency.componentRevisionId} is not an exact stable same-Workspace pin`,
        );
      }
    }
  }

  private validateArtifactResourcePinRecords(
    revision: ArtifactRevisionRecord,
    pins: readonly ArtifactRevisionResourcePinRecord[],
  ): void {
    const resources = new Set<string>();
    for (const pin of pins) {
      if (resources.has(pin.resourceId)) {
        throw new WorkspaceGraphValidationError(`duplicate Artifact Revision Resource pin ${pin.resourceId}`);
      }
      resources.add(pin.resourceId);
      const owned = this.db.prepare(
        `SELECT 1
         FROM resource_revisions resource_revision
         JOIN resources resource
           ON resource.id = resource_revision.resource_id
          AND resource.workspace_id = resource_revision.workspace_id
         WHERE resource_revision.id = ? AND resource_revision.resource_id = ?
           AND resource_revision.workspace_id = ?`,
      ).get(pin.resourceRevisionId, pin.resourceId, revision.workspaceId);
      if (pin.workspaceId !== revision.workspaceId
        || pin.ownerArtifactId !== revision.artifactId
        || pin.revisionId !== revision.id
        || !owned) {
        throw new WorkspaceGraphValidationError(
          `Resource Revision ${pin.resourceRevisionId} is not an exact same-Workspace Resource pin`,
        );
      }
    }
  }

  private validateArtifactCandidateForPublication(
    revision: ArtifactRevisionRecord,
    expectedParentRevisionId: string | null,
  ): void {
    if (revision.parentRevisionId !== expectedParentRevisionId) {
      throw new WorkspaceGraphValidationError("Artifact Revision parent does not match the expected Head");
    }
    this.validateArtifactRevisionLineage(revision);
    this.listArtifactRevisionDependencies(revision.id);
    this.listArtifactRevisionResourcePins(revision.id);
  }

  private loadSnapshotBase(snapshotId: string): WorkspaceSnapshotBaseRecord | null {
    const context = this.readContext();
    const cached = context.snapshotBases.get(snapshotId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      "SELECT * FROM workspace_snapshots WHERE id = ?",
    ).get(snapshotId) as Row | undefined;
    if (!row) return null;
    const snapshot = asWorkspaceSnapshotBase(row);
    context.snapshotBases.set(snapshot.id, snapshot);
    return snapshot;
  }

  private validateSnapshotLineage(snapshot: WorkspaceSnapshotBaseRecord): void {
    const context = this.readContext();
    if (context.validatedSnapshotBaseIds.has(snapshot.id)) return;
    const path: WorkspaceSnapshotBaseRecord[] = [];
    let child = snapshot;
    try {
      while (!context.validatedSnapshotBaseIds.has(child.id)) {
        if (context.visitingSnapshotBaseIds.has(child.id)) {
          throw new WorkspaceGraphValidationError(`Workspace Snapshot ${snapshot.id} parent lineage contains a cycle`);
        }
        context.visitingSnapshotBaseIds.add(child.id);
        path.push(child);
        const kernel = this.requireKernelRevision(child.kernelRevisionId);
        if (kernel.workspaceId !== child.workspaceId) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} parent Kernel belongs to another Workspace`,
          );
        }
        this.validateRunOwnership(child.workspaceId, child.createdByRunId, "Workspace Snapshot");
        if (child.parentSnapshotId === null) break;
        const parent = this.loadSnapshotBase(child.parentSnapshotId);
        if (parent === null) {
          throw new WorkspaceGraphValidationError(`Workspace Snapshot ${snapshot.id} parent is not resolvable`);
        }
        if (parent.workspaceId !== child.workspaceId || parent.sequence >= child.sequence) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} parent must be an earlier sealed Snapshot in the same Workspace`,
          );
        }
        child = parent;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        context.validatedSnapshotBaseIds.add(path[index]!.id);
      }
    } finally {
      for (const traversed of path) context.visitingSnapshotBaseIds.delete(traversed.id);
    }
  }

  private guardPointer(input: {
    pointer: WorkspacePointerKind;
    workspaceId: string;
    ownerId: string;
    expectedId: string | null;
    actualId: string | null;
  }): void {
    if (input.expectedId !== input.actualId) throw new WorkspacePointerConflictError(input);
  }

  private nextSafeSequence(
    table: "artifact_revisions" | "resource_revisions" | "shared_design_kernel_revisions" | "workspace_snapshots",
    ownerColumn: "track_id" | "resource_id" | "workspace_id",
    ownerId: string,
    label: string,
  ): number {
    const rows = this.db.prepare(
      `SELECT CAST(sequence AS TEXT) AS sequence_text, typeof(sequence) AS sequence_type
       FROM ${table} WHERE ${ownerColumn} = ?`,
    ).all(ownerId) as Array<{ sequence_text: unknown; sequence_type: unknown }>;
    let max = 0n;
    for (const row of rows) {
      if (row.sequence_type !== "integer"
        || typeof row.sequence_text !== "string"
        || !/^[1-9][0-9]*$/.test(row.sequence_text)) {
        throw new WorkspaceGraphValidationError(`next ${label} sequence must be a positive safe integer`);
      }
      const sequence = BigInt(row.sequence_text);
      if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WorkspaceGraphValidationError(`next ${label} sequence must be a positive safe integer`);
      }
      if (sequence > max) max = sequence;
    }
    if (max >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WorkspaceGraphValidationError(`next ${label} sequence must be a positive safe integer`);
    }
    return Number(max) + 1;
  }

  private validateRunOwnership(workspaceId: string, runId: string | null, label: string): void {
    if (runId === null) return;
    const row = this.db.prepare(
      `SELECT 1
       FROM runs run
       JOIN project_workspaces workspace ON workspace.project_id = run.project_id
       WHERE workspace.id = ? AND run.id = ?`,
    ).get(workspaceId, runId);
    if (!row) throw new WorkspaceGraphValidationError(`${label} Run belongs to another Project or does not exist`);
  }

  private validateRunContextPackBinding(
    workspaceId: string,
    contextPackId: string,
    runId: string | null,
    label: string,
  ): void {
    if (runId === null) return;
    const row = this.db.prepare(
      `SELECT 1
       FROM runs run
       JOIN context_packs pack
         ON pack.id = ? AND pack.workspace_id = ?
       WHERE run.id = ?
         AND run.context_pack_id = pack.id
         AND run.context_pack_hash = pack.hash`,
    ).get(contextPackId, workspaceId, runId);
    if (!row) throw new WorkspaceGraphValidationError(`${label} Run is not bound to the exact Context Pack`);
  }

  private validateContextPackTargetOwnership(
    workspaceId: string,
    target: AgentScope,
    allowArchived = false,
  ): void {
    if (target.type === "workspace") {
      if (target.id !== workspaceId) {
        throw new WorkspaceGraphValidationError("Context Pack target belongs to another Workspace");
      }
      return;
    }
    const table = target.type === "artifact" ? "workspace_artifacts" : "resources";
    const row = this.db.prepare(
      `SELECT archived_at FROM ${table} WHERE id = ? AND workspace_id = ?`,
    ).get(target.id, workspaceId) as { archived_at: number | null } | undefined;
    if (!row) throw new WorkspaceGraphValidationError("Context Pack target belongs to another Workspace");
    if (!allowArchived && row.archived_at !== null) {
      throw new WorkspaceGraphValidationError("Context Pack target is archived");
    }
  }

  private validateContextPackItemIdentity(
    workspaceId: string,
    item: PersistContextPackItemInput,
  ): void {
    const exactRevisionId = item.resolvedKind === "artifact-revision"
      ? item.artifactRevisionId ?? null
      : item.resolvedKind === "resource-revision"
        ? item.resourceRevisionId ?? null
        : item.resolvedKind === "kernel-revision"
          ? item.kernelRevisionId ?? null
          : null;
    const refRevisionId = "revisionId" in item.ref ? item.ref.revisionId : undefined;
    if (item.resolvedKind !== "inline" && refRevisionId !== exactRevisionId) {
      throw new WorkspaceGraphValidationError("Context Pack ref Revision does not match its exact resolved pin");
    }
    if (item.resolvedKind === "inline" && item.ref.kind !== "inline") {
      throw new WorkspaceGraphValidationError("Context Pack inline item ref is invalid");
    }
    if (item.resolvedKind === "artifact-revision") {
      if (!item.artifactRevisionId) throw new WorkspaceGraphValidationError("Context Pack Artifact Revision pin is missing");
      const row = this.db.prepare(
        `SELECT revision.artifact_id
         FROM artifact_revisions revision
         WHERE revision.id = ? AND revision.workspace_id = ? AND revision.sealed = 1
           AND EXISTS (
             SELECT 1 FROM workspace_snapshot_artifacts mapping
             JOIN workspace_snapshots snapshot
               ON snapshot.id = mapping.snapshot_id AND snapshot.workspace_id = mapping.workspace_id
             WHERE mapping.revision_id = revision.id
               AND mapping.workspace_id = revision.workspace_id
               AND snapshot.sealed = 1
           )`,
      ).get(item.artifactRevisionId, workspaceId) as { artifact_id: string } | undefined;
      const revision = row ? this.loadArtifactRevision(item.artifactRevisionId) : null;
      if (!row || !revision || item.checksum !== this.computeArtifactRevisionContextChecksum(revision)
        || item.ref.kind !== "artifact" || item.ref.id !== row.artifact_id) {
        throw new WorkspaceGraphValidationError("Context Pack Artifact Revision ownership is invalid");
      }
      return;
    }
    if (item.resolvedKind === "resource-revision") {
      if (!item.resourceRevisionId) throw new WorkspaceGraphValidationError("Context Pack Resource Revision pin is missing");
      const row = this.db.prepare(
        `SELECT revision.resource_id, revision.checksum, resource.kind
         FROM resource_revisions revision
         JOIN resources resource
           ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
         WHERE revision.id = ? AND revision.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM workspace_snapshot_resources mapping
             JOIN workspace_snapshots snapshot
               ON snapshot.id = mapping.snapshot_id AND snapshot.workspace_id = mapping.workspace_id
             WHERE mapping.revision_id = revision.id
               AND mapping.workspace_id = revision.workspace_id
               AND snapshot.sealed = 1
           )`,
      ).get(item.resourceRevisionId, workspaceId) as {
        resource_id: string;
        checksum: string;
        kind: string;
      } | undefined;
      if (!row || item.checksum !== row.checksum || item.ref.kind !== "resource"
        || item.ref.id !== row.resource_id || item.ref.resourceKind !== row.kind) {
        throw new WorkspaceGraphValidationError("Context Pack Resource Revision ownership is invalid");
      }
      return;
    }
    if (item.resolvedKind === "kernel-revision") {
      if (!item.kernelRevisionId) throw new WorkspaceGraphValidationError("Context Pack Kernel Revision pin is missing");
      const row = this.db.prepare(
        `SELECT revision.id, revision.checksum
         FROM shared_design_kernel_revisions revision
         WHERE revision.id = ? AND revision.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM workspace_snapshots snapshot
             WHERE snapshot.kernel_revision_id = revision.id
               AND snapshot.workspace_id = revision.workspace_id
               AND snapshot.sealed = 1
           )`,
      ).get(item.kernelRevisionId, workspaceId) as { id: string; checksum: string } | undefined;
      if (!row || item.checksum !== row.checksum || item.ref.kind !== "kernel" || item.ref.id !== row.id) {
        throw new WorkspaceGraphValidationError("Context Pack Kernel Revision ownership is invalid");
      }
    }
  }

  private validateArtifactRevisionPins(
    artifact: WorkspaceArtifactRecord,
    input: CreateArtifactRevisionInput,
  ): void {
    for (const dependency of input.dependencies) {
      if (dependency.componentArtifactId === artifact.id) {
        throw new WorkspaceGraphValidationError("an Artifact cannot use itself as a Component dependency");
      }
      const component = this.db.prepare(
        `SELECT component.workspace_id, component.kind, revision.artifact_id AS revision_artifact_id
         FROM workspace_artifacts component
         JOIN artifact_revisions revision
           ON revision.artifact_id = component.id AND revision.workspace_id = component.workspace_id
         WHERE component.id = ? AND revision.id = ?`,
      ).get(dependency.componentArtifactId, dependency.componentRevisionId) as {
        workspace_id: string;
        kind: string;
        revision_artifact_id: string;
      } | undefined;
      if (!component
        || component.workspace_id !== artifact.workspaceId
        || component.kind !== "component"
        || component.revision_artifact_id !== dependency.componentArtifactId) {
        throw new WorkspaceGraphValidationError(
          `Component Revision ${dependency.componentRevisionId} is not an exact same-Workspace Component pin`,
        );
      }
      const instance = this.db.prepare(
        "SELECT * FROM component_instances WHERE id = ?",
      ).get(dependency.instanceId) as Row | undefined;
      if (dependency.createInstanceIdentity === true) {
        if (instance) throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} already exists`);
      } else if (!instance) {
        throw new WorkspaceGraphValidationError(
          `Component Instance ${dependency.instanceId} does not exist; createInstanceIdentity is required`,
        );
      } else if (instance.workspace_id !== artifact.workspaceId
        || instance.owner_artifact_id !== artifact.id
        || instance.component_artifact_id !== dependency.componentArtifactId) {
        throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} identity collision`);
      }
    }
    for (const pin of input.resourcePins) {
      const resource = this.db.prepare(
        `SELECT resource.workspace_id, revision.resource_id AS revision_resource_id
         FROM resources resource
         JOIN resource_revisions revision
           ON revision.resource_id = resource.id AND revision.workspace_id = resource.workspace_id
         WHERE resource.id = ? AND revision.id = ?`,
      ).get(pin.resourceId, pin.resourceRevisionId) as {
        workspace_id: string;
        revision_resource_id: string;
      } | undefined;
      if (!resource
        || resource.workspace_id !== artifact.workspaceId
        || resource.revision_resource_id !== pin.resourceId) {
        throw new WorkspaceGraphValidationError(
          `Resource Revision ${pin.resourceRevisionId} is not an exact same-Workspace Resource pin`,
        );
      }
    }
  }

  private validateKernelSharedAssets(workspaceId: string, revisionIds: readonly string[]): void {
    const seen = new Set<string>();
    for (const revisionId of revisionIds) {
      if (seen.has(revisionId)) throw new WorkspaceGraphValidationError(`duplicate shared Asset Revision ${revisionId}`);
      seen.add(revisionId);
      const row = this.db.prepare(
        `SELECT resource.workspace_id, resource.kind
         FROM resource_revisions revision
         JOIN resources resource
           ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
         WHERE revision.id = ?`,
      ).get(revisionId) as { workspace_id: string; kind: string } | undefined;
      if (!row || row.workspace_id !== workspaceId || row.kind !== "asset") {
        throw new WorkspaceGraphValidationError(
          `Shared Asset Revision ${revisionId} must belong to an Asset Resource in this Workspace`,
        );
      }
    }
  }

  private computeKernelImpact(
    target: SharedDesignKernelRevision,
    snapshot: WorkspaceSnapshotRecord,
  ): KernelImpactAnalysis {
    if (snapshot.workspaceId !== target.workspaceId
      || target.parentRevisionId !== snapshot.kernelRevisionId) {
      throw new WorkspaceGraphValidationError(
        "Kernel impact must compare a direct Kernel child against its exact base Snapshot",
      );
    }
    this.validateKernelSharedAssets(target.workspaceId, target.sharedAssetRevisionIds);
    const affectedArtifactRevisions: KernelImpactAnalysis["affectedArtifactRevisions"] = [];
    const mappings = Object.entries(snapshot.artifactRevisions)
      .sort(([left], [right]) => compareBinary(left, right));
    for (const [artifactId, revisionId] of mappings) {
      if (revisionId === null) continue;
      const revision = this.requireArtifactRevision(revisionId);
      const trackId = snapshot.artifactTracks[artifactId];
      if (trackId === undefined
        || revision.workspaceId !== target.workspaceId
        || revision.artifactId !== artifactId
        || revision.trackId !== trackId) {
        throw new WorkspaceGraphValidationError(`Kernel impact Artifact mapping ${artifactId} is corrupt`);
      }
      const pinnedKernel = this.getKernelRevision(revision.kernelRevisionId);
      if (!pinnedKernel || pinnedKernel.workspaceId !== target.workspaceId) {
        throw new WorkspaceGraphValidationError(
          `Kernel impact Artifact ${artifactId} has an invalid pinned Kernel Revision`,
        );
      }
      for (const dependency of this.listArtifactRevisionDependencies(revision.id)) {
        const componentRevision = this.getArtifactRevision(dependency.componentRevisionId);
        const instance = this.db.prepare(
          `SELECT 1 FROM component_instances
           WHERE id = ? AND workspace_id = ? AND owner_artifact_id = ? AND component_artifact_id = ?`,
        ).get(
          dependency.instanceId,
          target.workspaceId,
          artifactId,
          dependency.componentArtifactId,
        );
        if (!instance
          || !componentRevision
          || componentRevision.workspaceId !== target.workspaceId
          || componentRevision.artifactId !== dependency.componentArtifactId) {
          throw new WorkspaceGraphValidationError(
            `Kernel impact Artifact ${artifactId} has a corrupt Component dependency pin`,
          );
        }
      }
      for (const pin of this.listArtifactRevisionResourcePins(revision.id)) {
        const resource = this.db.prepare(
          `SELECT 1
           FROM resource_revisions revision
           JOIN resources resource
             ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
           WHERE revision.id = ? AND revision.resource_id = ? AND revision.workspace_id = ?`,
        ).get(pin.resourceRevisionId, pin.resourceId, target.workspaceId);
        if (!resource) {
          throw new WorkspaceGraphValidationError(
            `Kernel impact Artifact ${artifactId} has a corrupt Resource Revision pin`,
          );
        }
      }
      if (revision.kernelRevisionId !== target.id) {
        affectedArtifactRevisions.push({
          artifactId,
          revisionId: revision.id,
          pinnedKernelRevisionId: revision.kernelRevisionId,
        });
      }
    }
    return {
      workspaceId: target.workspaceId,
      baseSnapshotId: snapshot.id,
      fromKernelRevisionId: snapshot.kernelRevisionId,
      toKernelRevisionId: target.id,
      affectedArtifactRevisions,
    };
  }

  private validatePublicCheckpointProvenance(provenance: WorkspaceSnapshotProvenance): void {
    if (provenance.kind !== "plan-checkpoint") {
      throw new WorkspaceStoreCodecError(
        `public Snapshot checkpoint cannot claim ${provenance.kind} publication provenance`,
      );
    }
  }

  private deriveUsesGraphForArtifactPublication(
    workspace: ProjectWorkspace,
    parent: WorkspaceSnapshotRecord,
    revision: ArtifactRevisionRecord,
  ): { graph: WorkspaceGraph; changed: boolean } {
    if (parent.graphRevision !== workspace.graphRevision) {
      throw new WorkspaceGraphValidationError("active Snapshot graph does not match the Workspace graph pointer");
    }
    const current: WorkspaceGraph = {
      workspaceId: workspace.id,
      revision: workspace.graphRevision,
      nodes: this.listNodes(workspace.id),
      edges: this.listEdges(workspace.id),
    };
    validateWorkspaceGraph(current);
    if (!graphsAreSemanticallyEqual(current, parent.graph)) {
      throw new WorkspaceGraphValidationError("mutable Workspace graph does not match the active immutable graph");
    }
    const revisions = new Map(Object.entries(parent.artifactRevisions));
    revisions.set(revision.artifactId, revision.id);
    const artifactNodes = new Map<string, Extract<WorkspaceNode, { kind: "page" | "component" }>>();
    for (const node of current.nodes) {
      if (node.kind !== "resource") artifactNodes.set(node.artifactId, node);
    }
    const derived = new Map<string, WorkspaceGraph["edges"][number]>();
    for (const [ownerArtifactId, mappedRevisionId] of revisions) {
      if (mappedRevisionId === null) continue;
      const mappedRevision = this.requireArtifactRevision(mappedRevisionId);
      if (mappedRevision.workspaceId !== workspace.id || mappedRevision.artifactId !== ownerArtifactId) {
        throw new WorkspaceGraphValidationError(`Snapshot Artifact mapping ${ownerArtifactId} is corrupt`);
      }
      const ownerNode = artifactNodes.get(ownerArtifactId);
      if (!ownerNode) throw new WorkspaceGraphValidationError(`Artifact ${ownerArtifactId} has no active graph node`);
      for (const dependency of this.listArtifactRevisionDependencies(mappedRevisionId)) {
        if (dependency.status !== "linked") continue;
        const componentNode = artifactNodes.get(dependency.componentArtifactId);
        if (!componentNode || componentNode.kind !== "component") {
          throw new WorkspaceGraphValidationError(
            `linked Component ${dependency.componentArtifactId} has no active Component graph node`,
          );
        }
        const relationship = `${ownerArtifactId}\0${dependency.componentArtifactId}`;
        if (derived.has(relationship)) continue;
        const id = `derived-uses-${checksum(`uses-v1\0${workspace.id}\0${ownerArtifactId}\0${dependency.componentArtifactId}`)}`;
        derived.set(relationship, {
          id,
          workspaceId: workspace.id,
          kind: "uses",
          sourceNodeId: ownerNode.id,
          targetNodeId: componentNode.id,
        });
      }
    }
    const nonUses = current.edges.filter((edge) => edge.kind !== "uses");
    const nonUsesById = new Map(nonUses.map((edge) => [edge.id, edge]));
    for (const edge of derived.values()) {
      if (nonUsesById.has(edge.id)) {
        throw new WorkspaceGraphValidationError(`derived uses edge identity collision: ${edge.id}`);
      }
    }
    const desiredUses = [...derived.values()].sort((left, right) => compareBinary(left.id, right.id));
    const currentUses = current.edges
      .filter((edge) => edge.kind === "uses")
      .sort((left, right) => compareBinary(left.id, right.id));
    if (isDeepStrictEqual(currentUses, desiredUses)) return { graph: current, changed: false };
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw new WorkspaceGraphValidationError("workspace graph revision is exhausted and cannot advance");
    }
    const graph: WorkspaceGraph = {
      workspaceId: workspace.id,
      revision: current.revision + 1,
      nodes: current.nodes,
      edges: [...nonUses, ...desiredUses],
    };
    validateWorkspaceGraph(graph);
    return { graph, changed: true };
  }

  private reconcileDerivedUsesEdges(graph: WorkspaceGraph): void {
    this.db.prepare("DELETE FROM workspace_edges WHERE workspace_id = ? AND kind = 'uses'").run(graph.workspaceId);
    const insert = this.db.prepare(
      `INSERT INTO workspace_edges
         (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
       VALUES (?, ?, 'uses', ?, ?, '{}', ?, ?)`,
    );
    for (const edge of graph.edges) {
      if (edge.kind !== "uses") continue;
      const now = this.clock.now();
      insert.run(edge.id, graph.workspaceId, edge.sourceNodeId, edge.targetNodeId, now, now);
    }
  }

  private withWorkspaceReadContext<T>(operation: () => T): T {
    if (this.activeReadContext !== null) return operation();
    this.activeReadContext = createWorkspaceReadContext();
    try {
      return operation();
    } finally {
      this.activeReadContext = null;
    }
  }

  private readContext(): WorkspaceReadContext {
    if (this.activeReadContext === null) {
      throw new Error("WorkspaceStore immutable reads require a transaction-scoped context");
    }
    return this.activeReadContext;
  }

  private transactionImmediate<T>(operation: () => T): T {
    if (this.db.isTransaction) throw new Error("WorkspaceStore transaction wrapper cannot be nested");
    return this.withWorkspaceReadContext(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.db.isTransaction) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            // Preserve the operation error if SQLite already ended the transaction.
          }
        }
        throw error;
      }
    });
  }

  private transactionRead<T>(operation: () => T): T {
    return this.withWorkspaceReadContext(() => {
      if (this.db.isTransaction) return operation();
      this.db.exec("BEGIN");
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.db.isTransaction) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            // Preserve the read error if SQLite already ended the transaction.
          }
        }
        throw error;
      }
    });
  }

  private applyGraphCommandsInTransaction(
    workspace: ProjectWorkspace,
    current: WorkspaceGraph,
    input: GraphCommandsInTransactionInput,
  ): WorkspaceGraphMutationResult {
    if (!this.db.isTransaction) throw new Error("Workspace graph commands require a transaction");
    if (current.workspaceId !== workspace.id || current.revision !== workspace.graphRevision) {
      throw new WorkspaceGraphValidationError("Workspace graph transaction base is incoherent");
    }
    if (workspace.activeSnapshotId !== input.expectedSnapshotId) {
      throw new WorkspaceRevisionConflictError(current.revision, current.revision, {
        expectedSnapshotId: input.expectedSnapshotId,
        actualSnapshotId: workspace.activeSnapshotId,
      });
    }

    const payloads = input.commands.map((command) => JSON.stringify(command));
    const batchHash = checksum(`workspace-graph-command-batch-v1\0${JSON.stringify(input.commands)}`);
    const applied = applyWorkspaceGraphCommands(current, input.commands);
    this.persistGraphDelta(current, applied, input.commands);
    const next: WorkspaceGraph = {
      workspaceId: current.workspaceId,
      revision: applied.revision,
      nodes: this.listNodes(current.workspaceId),
      edges: this.listEdges(current.workspaceId),
    };
    validateWorkspaceGraph(next);
    if (!graphsAreSemanticallyEqual(applied, next)) {
      throw new WorkspaceGraphValidationError("durable workspace graph does not match applied commands");
    }
    this.insertImmutableGraphRevision(next);
    const mappingOverrides = this.snapshotOverridesForGraphDelta(workspace.id, current, next, input.commands);
    const snapshot = this.createSnapshotInTransaction(workspace.id, {
      expectedSnapshotId: input.expectedSnapshotId,
      graphRevision: next.revision,
      reason: input.reason,
      provenance: input.provenance,
      artifactOverrides: mappingOverrides.artifacts,
      resourceOverrides: mappingOverrides.resources,
      artifactRemovals: mappingOverrides.artifactRemovals,
      resourceRemovals: mappingOverrides.resourceRemovals,
    });
    const now = this.clock.now();
    const moved = this.db.prepare(
      `UPDATE project_workspaces
       SET graph_revision = ?, active_snapshot_id = ?, updated_at = ?
       WHERE id = ? AND graph_revision = ? AND active_snapshot_id IS ?`,
    ).run(next.revision, snapshot.id, now, workspace.id, current.revision, input.expectedSnapshotId);
    if (Number(moved.changes) !== 1) {
      const actual = this.requireWorkspaceById(workspace.id);
      throw new WorkspaceRevisionConflictError(current.revision, actual.graphRevision, {
        expectedSnapshotId: input.expectedSnapshotId,
        actualSnapshotId: actual.activeSnapshotId,
      });
    }
    const insertCommand = this.db.prepare(
      `INSERT INTO workspace_graph_commands (
         workspace_id, command_id, base_revision, result_revision, expected_snapshot_id,
         batch_hash, batch_index, batch_size, result_snapshot_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < input.commands.length; index += 1) {
      const command = input.commands[index];
      const payload = payloads[index];
      if (!command || payload === undefined) {
        throw new WorkspaceGraphValidationError(`missing normalized command at index ${index}`);
      }
      insertCommand.run(
        workspace.id,
        command.id,
        current.revision,
        next.revision,
        input.expectedSnapshotId,
        batchHash,
        index,
        input.commands.length,
        snapshot.id,
        payload,
        now,
      );
    }
    return { graph: next, snapshot };
  }

  private findExactGraphCommandReplay(
    workspaceId: string,
    input: WorkspaceGraphMutationInput,
    payloads: readonly string[],
    batchHash: string,
  ): WorkspaceGraphMutationResult | null {
    const findCommand = this.db.prepare(
      `SELECT * FROM workspace_graph_commands
       WHERE workspace_id = ? AND command_id = ?`,
    );
    const rows = input.commands.flatMap((command) => {
      const row = findCommand.get(workspaceId, command.id) as GraphCommandRow | undefined;
      return row ? [row] : [];
    });
    if (rows.length === 0) return null;
    const conflict = () => {
      throw new WorkspaceCommandReplayConflictError(input.commands.map((command) => command.id));
    };
    if (rows.length !== input.commands.length) return conflict();

    const first = rows[0];
    if (!first) return conflict();
    for (let index = 0; index < input.commands.length; index += 1) {
      const command = input.commands[index];
      const row = rows[index];
      if (!command || !row
        || row.command_id !== command.id
        || row.base_revision !== input.baseGraphRevision
        || row.expected_snapshot_id !== input.expectedSnapshotId
        || row.batch_hash !== batchHash
        || row.batch_index !== index
        || row.batch_size !== input.commands.length
        || row.payload_json !== payloads[index]
        || row.result_revision !== first.result_revision
        || row.result_snapshot_id !== first.result_snapshot_id) {
        return conflict();
      }
    }
    const storedBatchCount = Number((this.db.prepare(
      `SELECT COUNT(*) AS count FROM workspace_graph_commands
       WHERE workspace_id = ? AND batch_hash = ? AND base_revision = ?
         AND expected_snapshot_id IS ? AND result_revision = ? AND result_snapshot_id = ?`,
    ).get(
      workspaceId,
      batchHash,
      input.baseGraphRevision,
      input.expectedSnapshotId,
      first.result_revision,
      first.result_snapshot_id,
    ) as { count: number }).count);
    if (storedBatchCount !== input.commands.length) return conflict();
    const snapshot = this.requireSnapshot(workspaceId, first.result_snapshot_id);
    const expectedCommandIds = input.commands.map((command) => command.id);
    if (snapshot.graphRevision !== first.result_revision
      || snapshot.parentSnapshotId !== input.expectedSnapshotId
      || snapshot.provenance.kind !== "graph-command"
      || snapshot.provenance.commandIds.length !== expectedCommandIds.length
      || snapshot.provenance.commandIds.some((commandId, index) => commandId !== expectedCommandIds[index])) {
      return conflict();
    }
    return {
      graph: this.requireGraphRevision(workspaceId, first.result_revision),
      snapshot,
    };
  }

  private persistGraphDelta(
    current: WorkspaceGraph,
    next: WorkspaceGraph,
    commands: readonly WorkspaceGraphCommand[],
  ): void {
    const nodes = new Map(current.nodes.map((node) => [node.id, node]));
    for (const command of commands) {
      const now = this.clock.now();
      switch (command.type) {
        case "add-node": {
          if (this.db.prepare("SELECT 1 FROM workspace_nodes WHERE id = ?").get(command.node.id)) {
            throw new WorkspaceGraphValidationError(`workspace node identity collision: ${command.node.id}`);
          }
          if (this.db.prepare(
            `SELECT 1 FROM workspace_layout_nodes
             WHERE workspace_id = ? AND object_id = ? AND object_kind = 'group'
             LIMIT 1`,
          ).get(current.workspaceId, command.node.id)) {
            throw new WorkspaceGraphValidationError(`workspace node ${command.node.id} collides with a layout group`);
          }
          this.ensureNodeIdentity(current.workspaceId, command.node, now);
          this.db.prepare(
            `INSERT INTO workspace_nodes
               (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
          ).run(
            command.node.id,
            current.workspaceId,
            command.node.kind,
            command.node.kind === "resource" ? null : command.node.artifactId,
            command.node.kind === "resource" ? command.node.resourceId : null,
            now,
            now,
          );
          const added = next.nodes.find((node) => node.id === command.node.id)
            ?? ({ ...command.node, workspaceId: current.workspaceId } as WorkspaceNode);
          nodes.set(command.node.id, added);
          break;
        }
        case "rename-node": {
          const node = nodes.get(command.nodeId);
          if (!node) throw new WorkspaceGraphValidationError(`node ${command.nodeId} does not exist`);
          if (node.kind === "resource") {
            this.requireOneChange(
              this.db.prepare("UPDATE resources SET title = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(command.name, now, node.resourceId, current.workspaceId),
              `rename Resource ${node.resourceId}`,
            );
          } else {
            this.requireOneChange(
              this.db.prepare("UPDATE workspace_artifacts SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(command.name, now, node.artifactId, current.workspaceId),
              `rename Artifact ${node.artifactId}`,
            );
          }
          this.requireOneChange(
            this.db.prepare("UPDATE workspace_nodes SET updated_at = ? WHERE id = ? AND workspace_id = ?")
              .run(now, node.id, current.workspaceId),
            `rename node ${node.id}`,
          );
          nodes.set(command.nodeId, { ...node, name: command.name });
          break;
        }
        case "archive-node": {
          const node = nodes.get(command.nodeId);
          if (!node) throw new WorkspaceGraphValidationError(`node ${command.nodeId} does not exist`);
          this.requireOneChange(this.db.prepare(
            "UPDATE workspace_nodes SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND archived_at IS NULL",
          ).run(now, now, node.id, current.workspaceId), `archive node ${node.id}`);
          if (node.kind === "resource") {
            this.requireOneChange(
              this.db.prepare("UPDATE resources SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(now, now, node.resourceId, current.workspaceId),
              `archive Resource ${node.resourceId}`,
            );
          } else {
            this.requireOneChange(
              this.db.prepare("UPDATE workspace_artifacts SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(now, now, node.artifactId, current.workspaceId),
              `archive Artifact ${node.artifactId}`,
            );
          }
          this.db.prepare(
            "DELETE FROM workspace_layout_nodes WHERE workspace_id = ? AND object_id = ? AND object_kind = 'node'",
          ).run(current.workspaceId, node.id);
          this.db.prepare(
            `DELETE FROM workspace_edges
             WHERE workspace_id = ? AND (source_node_id = ? OR target_node_id = ?)`,
          ).run(current.workspaceId, node.id, node.id);
          nodes.delete(command.nodeId);
          break;
        }
        case "add-edge": {
          if (this.db.prepare("SELECT 1 FROM workspace_edges WHERE id = ?").get(command.edge.id)) {
            throw new WorkspaceGraphValidationError(`workspace edge identity collision: ${command.edge.id}`);
          }
          const payload = command.edge.kind === "prototype" ? JSON.stringify({ status: "planned" }) : "{}";
          this.db.prepare(
            `INSERT INTO workspace_edges
               (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            command.edge.id,
            current.workspaceId,
            command.edge.kind,
            command.edge.sourceNodeId,
            command.edge.targetNodeId,
            payload,
            now,
            now,
          );
          break;
        }
        case "remove-edge":
          this.requireOneChange(
            this.db.prepare("DELETE FROM workspace_edges WHERE id = ? AND workspace_id = ?")
              .run(command.edgeId, current.workspaceId),
            `remove edge ${command.edgeId}`,
          );
          break;
        case "bind-prototype": {
          const edge = this.db.prepare(
            "SELECT kind FROM workspace_edges WHERE id = ? AND workspace_id = ?",
          ).get(command.edgeId, current.workspaceId) as { kind: string } | undefined;
          if (edge?.kind !== "prototype") {
            throw new WorkspaceGraphValidationError(`edge ${command.edgeId} is not a prototype edge`);
          }
          this.requireOneChange(
            this.db.prepare("UPDATE workspace_edges SET payload_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
              .run(
                JSON.stringify({ status: "interactive", binding: command.binding }),
                now,
                command.edgeId,
                current.workspaceId,
              ),
            `bind prototype edge ${command.edgeId}`,
          );
          break;
        }
      }
    }
  }

  private ensureNodeIdentity(workspaceId: string, node: NewWorkspaceNode, now: number): void {
    if (node.kind === "resource") {
      const existing = this.db.prepare("SELECT * FROM resources WHERE id = ?").get(node.resourceId) as Row | undefined;
      if (existing) {
        if (node.createIdentity !== undefined) {
          throw new WorkspaceGraphValidationError(`Resource identity collision: ${node.resourceId}`);
        }
        const matches = existing.workspace_id === workspaceId
          && existing.title === node.name
          && existing.archived_at == null;
        if (!matches) throw new WorkspaceGraphValidationError(`Resource identity collision: ${node.resourceId}`);
        return;
      }
      if (!node.createIdentity) {
        throw new WorkspaceGraphValidationError(`Resource identity ${node.resourceId} does not exist in this Workspace`);
      }
      this.db.prepare(
        `INSERT INTO resources (
           id, workspace_id, kind, title, head_revision_id, default_pin_policy,
           archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      ).run(
        node.resourceId,
        workspaceId,
        node.createIdentity.resourceKind,
        node.name,
        node.createIdentity.defaultPinPolicy,
        now,
        now,
      );
      return;
    }

    const existing = this.db.prepare("SELECT * FROM workspace_artifacts WHERE id = ?").get(node.artifactId) as Row | undefined;
    const derivedRoot = artifactSourceRoot(workspaceId, node.artifactId);
    if (existing) {
      if (node.createIdentity !== undefined) {
        throw new WorkspaceGraphValidationError(`Artifact identity collision: ${node.artifactId}`);
      }
      const artifact = asWorkspaceArtifact(existing);
      if (artifact.workspaceId === workspaceId && !artifactHasValidSourceRoot(artifact)) {
        throw new WorkspaceGraphValidationError(`Artifact ${node.artifactId} source root is not server-derived`);
      }
      const matches = artifact.workspaceId === workspaceId
        && artifact.kind === node.kind
        && artifact.name === node.name
        && artifactHasValidSourceRoot(artifact)
        && artifact.archivedAt == null
        && artifact.activeTrackId != null;
      if (!matches) throw new WorkspaceGraphValidationError(`Artifact identity collision: ${node.artifactId}`);
      return;
    }
    if (!node.createIdentity) {
      throw new WorkspaceGraphValidationError(`Artifact identity ${node.artifactId} does not exist in this Workspace`);
    }
    if (this.db.prepare("SELECT 1 FROM artifact_tracks WHERE id = ?").get(node.createIdentity.initialTrackId)) {
      throw new WorkspaceGraphValidationError(`Artifact Track identity collision: ${node.createIdentity.initialTrackId}`);
    }
    this.db.prepare(
      `INSERT INTO workspace_artifacts (
         id, workspace_id, kind, name, source_root, active_track_id, archived_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(node.artifactId, workspaceId, node.kind, node.name, derivedRoot, now, now);
    this.db.prepare(
      `INSERT INTO artifact_tracks
         (id, artifact_id, name, head_revision_id, legacy_variant_id, created_at)
       VALUES (?, ?, 'main', NULL, NULL, ?)`,
    ).run(node.createIdentity.initialTrackId, node.artifactId, now);
    this.requireOneChange(
      this.db.prepare("UPDATE workspace_artifacts SET active_track_id = ? WHERE id = ?")
        .run(node.createIdentity.initialTrackId, node.artifactId),
      `activate initial Track for Artifact ${node.artifactId}`,
    );
  }

  private requireOneChange(result: { changes: number | bigint }, operation: string): void {
    if (Number(result.changes) !== 1) {
      throw new WorkspaceGraphValidationError(`workspace index changed unexpectedly during ${operation}`);
    }
  }

  private insertImmutableGraphRevision(graph: WorkspaceGraph): void {
    const nodesJson = JSON.stringify(graph.nodes);
    const edgesJson = JSON.stringify(graph.edges);
    this.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(graph.workspaceId, graph.revision, nodesJson, edgesJson, checksum(`${nodesJson}\n${edgesJson}`), this.clock.now());
  }

  private snapshotOverridesForGraphDelta(
    workspaceId: string,
    current: WorkspaceGraph,
    next: WorkspaceGraph,
    commands: readonly WorkspaceGraphCommand[],
  ): {
    artifacts: SnapshotArtifactOverride[];
    resources: SnapshotResourceOverride[];
    artifactRemovals: string[];
    resourceRemovals: string[];
  } {
    const currentNodeIds = new Set(current.nodes.map((node) => node.id));
    const nextNodeIds = new Set(next.nodes.map((node) => node.id));
    const artifacts: SnapshotArtifactOverride[] = [];
    const resources: SnapshotResourceOverride[] = [];
    for (const node of next.nodes) {
      if (currentNodeIds.has(node.id)) continue;
      if (node.kind === "resource") {
        const row = this.db.prepare(
          "SELECT head_revision_id FROM resources WHERE id = ? AND workspace_id = ?",
        ).get(node.resourceId, workspaceId) as { head_revision_id: string | null } | undefined;
        if (row?.head_revision_id) resources.push({ resourceId: node.resourceId, revisionId: row.head_revision_id });
      } else {
        const row = this.db.prepare(
          `SELECT a.active_track_id, t.head_revision_id
           FROM workspace_artifacts a
           JOIN artifact_tracks t ON t.id = a.active_track_id AND t.artifact_id = a.id
           WHERE a.id = ? AND a.workspace_id = ?`,
        ).get(node.artifactId, workspaceId) as { active_track_id: string; head_revision_id: string | null } | undefined;
        if (!row) throw new WorkspaceGraphValidationError(`Artifact ${node.artifactId} has no active Track`);
        artifacts.push({ artifactId: node.artifactId, trackId: row.active_track_id, revisionId: row.head_revision_id });
      }
    }
    const artifactRemovals = new Set<string>();
    const resourceRemovals = new Set<string>();
    for (const node of current.nodes) {
      if (nextNodeIds.has(node.id)) continue;
      if (node.kind === "resource") resourceRemovals.add(node.resourceId);
      else artifactRemovals.add(node.artifactId);
    }
    const lifecycleNodes = new Map<string, WorkspaceNode | NewWorkspaceNode>(
      current.nodes.map((node) => [node.id, node]),
    );
    for (const command of commands) {
      if (command.type === "add-node") {
        lifecycleNodes.set(command.node.id, command.node);
        continue;
      }
      if (command.type !== "archive-node") continue;
      const archived = lifecycleNodes.get(command.nodeId);
      if (!archived) {
        throw new WorkspaceGraphValidationError(`node ${command.nodeId} does not exist during Snapshot mapping update`);
      }
      if (archived.kind === "resource") resourceRemovals.add(archived.resourceId);
      else artifactRemovals.add(archived.artifactId);
      lifecycleNodes.delete(command.nodeId);
    }
    return {
      artifacts,
      resources,
      artifactRemovals: [...artifactRemovals],
      resourceRemovals: [...resourceRemovals],
    };
  }

  private createSnapshotInTransaction(workspaceId: string, input: SnapshotCreationInput): WorkspaceSnapshotRecord {
    const workspace = this.db.prepare(
      "SELECT graph_revision, active_snapshot_id, active_kernel_revision_id FROM project_workspaces WHERE id = ?",
    ).get(workspaceId) as {
      graph_revision: number;
      active_snapshot_id: string;
      active_kernel_revision_id: string;
    } | undefined;
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    if (workspace.active_snapshot_id !== input.expectedSnapshotId) {
      throw new WorkspaceRevisionConflictError(input.graphRevision, workspace.graph_revision, {
        expectedSnapshotId: input.expectedSnapshotId,
        actualSnapshotId: workspace.active_snapshot_id,
      });
    }
    const parent = this.requireSnapshot(workspaceId, input.expectedSnapshotId);
    const artifacts = new Map<string, { trackId: string; revisionId: string | null }>();
    for (const [artifactId, trackId] of Object.entries(parent.artifactTracks)) {
      if (!Object.hasOwn(parent.artifactRevisions, artifactId)) {
        throw new WorkspaceGraphValidationError(`Snapshot Artifact ${artifactId} has no Revision mapping`);
      }
      artifacts.set(artifactId, { trackId, revisionId: parent.artifactRevisions[artifactId] ?? null });
    }
    const artifactOverrideIds = new Set<string>();
    for (const override of input.artifactOverrides ?? []) {
      if (artifactOverrideIds.has(override.artifactId)) {
        throw new WorkspaceGraphValidationError(`duplicate Snapshot Artifact override ${override.artifactId}`);
      }
      artifactOverrideIds.add(override.artifactId);
      artifacts.set(override.artifactId, { trackId: override.trackId, revisionId: override.revisionId });
    }
    for (const artifactId of new Set(input.artifactRemovals ?? [])) artifacts.delete(artifactId);

    const resources = new Map(Object.entries(parent.resourceRevisions));
    const resourceOverrideIds = new Set<string>();
    for (const override of input.resourceOverrides ?? []) {
      if (resourceOverrideIds.has(override.resourceId)) {
        throw new WorkspaceGraphValidationError(`duplicate Snapshot Resource override ${override.resourceId}`);
      }
      resourceOverrideIds.add(override.resourceId);
      resources.set(override.resourceId, override.revisionId);
    }
    for (const resourceId of new Set(input.resourceRemovals ?? [])) resources.delete(resourceId);

    const kernelRevisionId = input.kernelRevisionId ?? parent.kernelRevisionId;
    const graph = this.requireGraphRevision(workspaceId, input.graphRevision);
    const kernel = this.requireKernelRevision(kernelRevisionId);
    if (graph.workspaceId !== workspaceId || kernel.workspaceId !== workspaceId) {
      throw new WorkspaceGraphValidationError("Workspace Snapshot graph or Kernel belongs to another Workspace");
    }
    this.validateSnapshotMappings(workspaceId, graph, artifacts, resources);
    this.validateRunOwnership(workspaceId, input.createdByRunId ?? null, "Workspace Snapshot");
    const sequence = this.nextSafeSequence(
      "workspace_snapshots",
      "workspace_id",
      workspaceId,
      "Workspace Snapshot",
    );
    const snapshotId = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      snapshotId,
      workspaceId,
      sequence,
      input.expectedSnapshotId,
      input.graphRevision,
      kernelRevisionId,
      input.reason,
      JSON.stringify(input.provenance),
      input.createdByRunId ?? null,
      now,
    );
    const insertArtifact = this.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [artifactId, mapping] of [...artifacts].sort(([left], [right]) => compareBinary(left, right))) {
      insertArtifact.run(workspaceId, snapshotId, artifactId, mapping.trackId, mapping.revisionId);
    }
    const insertResource = this.db.prepare(
      `INSERT INTO workspace_snapshot_resources
         (workspace_id, snapshot_id, resource_id, revision_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [resourceId, revisionId] of [...resources].sort(([left], [right]) => compareBinary(left, right))) {
      insertResource.run(workspaceId, snapshotId, resourceId, revisionId);
    }
    const sealed = this.db.prepare(
      "UPDATE workspace_snapshots SET sealed = 1 WHERE id = ? AND workspace_id = ? AND sealed = 0",
    ).run(snapshotId, workspaceId);
    if (Number(sealed.changes) !== 1) {
      throw new WorkspaceGraphValidationError(`Workspace Snapshot ${snapshotId} could not be sealed`);
    }
    return this.requireSnapshot(workspaceId, snapshotId);
  }

  private validateSnapshotMappings(
    workspaceId: string,
    graph: WorkspaceGraph,
    artifacts: ReadonlyMap<string, { trackId: string; revisionId: string | null }>,
    resources: ReadonlyMap<string, string>,
  ): void {
    const graphArtifacts = new Set<string>();
    const graphResources = new Set<string>();
    for (const node of graph.nodes) {
      if (node.kind === "resource") graphResources.add(node.resourceId);
      else graphArtifacts.add(node.artifactId);
    }
    if (graphArtifacts.size !== artifacts.size
      || [...graphArtifacts].some((artifactId) => !artifacts.has(artifactId))) {
      throw new WorkspaceGraphValidationError("Workspace Snapshot Artifact mapping keys must exactly match the graph");
    }
    for (const [artifactId, mapping] of artifacts) {
      const row = this.db.prepare(
        `SELECT artifact.active_track_id, track.head_revision_id, revision.id AS sealed_revision_id
         FROM workspace_artifacts artifact
         JOIN artifact_tracks track
           ON track.id = artifact.active_track_id AND track.artifact_id = artifact.id
         LEFT JOIN artifact_revisions revision
           ON revision.id = track.head_revision_id
          AND revision.workspace_id = artifact.workspace_id
          AND revision.artifact_id = artifact.id
          AND revision.track_id = track.id
          AND revision.sealed = 1
         WHERE artifact.id = ? AND artifact.workspace_id = ? AND artifact.archived_at IS NULL`,
      ).get(artifactId, workspaceId) as {
        active_track_id: string;
        head_revision_id: string | null;
        sealed_revision_id: string | null;
      } | undefined;
      if (!row
        || row.active_track_id !== mapping.trackId
        || row.head_revision_id !== mapping.revisionId
        || (row.head_revision_id !== null && row.sealed_revision_id !== row.head_revision_id)) {
        throw new WorkspaceGraphValidationError(
          `Workspace Snapshot Artifact mapping ${artifactId} must match its active Track and exact Head`,
        );
      }
    }
    for (const resourceId of graphResources) {
      const resource = this.db.prepare(
        `SELECT head_revision_id FROM resources
         WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
      ).get(resourceId, workspaceId) as { head_revision_id: string | null } | undefined;
      if (!resource) {
        throw new WorkspaceGraphValidationError(`Workspace Snapshot Resource ${resourceId} is not resolvable`);
      }
      const mappedRevisionId = resources.get(resourceId) ?? null;
      if (resource.head_revision_id !== mappedRevisionId) {
        throw new WorkspaceGraphValidationError(
          resource.head_revision_id === null
            ? `Workspace Snapshot Resource ${resourceId} cannot pin a Revision while its Head is null`
            : `Workspace Snapshot Resource ${resourceId} with a Head requires an explicit Snapshot pin matching its exact current Head`,
        );
      }
    }
    for (const [resourceId, revisionId] of resources) {
      if (!graphResources.has(resourceId)) {
        throw new WorkspaceGraphValidationError(`Workspace Snapshot Resource ${resourceId} has no active graph node`);
      }
      const row = this.db.prepare(
        `SELECT 1
         FROM resource_revisions revision
         JOIN resources resource
           ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
         WHERE revision.id = ? AND revision.resource_id = ?
           AND revision.workspace_id = ? AND resource.archived_at IS NULL`,
      ).get(revisionId, resourceId, workspaceId);
      if (!row) throw new WorkspaceGraphValidationError(`Workspace Snapshot Resource mapping ${resourceId} is not resolvable`);
    }
  }

  private requireSnapshot(workspaceId: string, snapshotId: string): WorkspaceSnapshotRecord {
    const context = this.readContext();
    const cached = context.snapshotRecords.get(snapshotId);
    if (cached !== undefined) {
      if (cached.workspaceId !== workspaceId) throw new Error(`Workspace Snapshot not found: ${snapshotId}`);
      return cached;
    }
    const snapshot = this.loadSnapshotBase(snapshotId);
    if (snapshot === null || snapshot.workspaceId !== workspaceId) {
      throw new Error(`Workspace Snapshot not found: ${snapshotId}`);
    }
    this.validateSnapshotLineage(snapshot);
    const pending: WorkspaceSnapshotBaseRecord[] = [];
    let cursor = snapshot;
    try {
      while (!context.snapshotRecords.has(cursor.id)) {
        if (context.visitingSnapshotRecordIds.has(cursor.id)) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} provenance lineage contains a cycle`,
          );
        }
        context.visitingSnapshotRecordIds.add(cursor.id);
        pending.push(cursor);
        const needsParentRecord = cursor.provenance.kind === "artifact-publication"
          || cursor.provenance.kind === "resource-publication"
          || cursor.provenance.kind === "kernel-publication";
        if (!needsParentRecord || cursor.parentSnapshotId === null) break;
        const parent = this.loadSnapshotBase(cursor.parentSnapshotId);
        if (parent === null || parent.workspaceId !== workspaceId) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} parent is not resolvable`,
          );
        }
        cursor = parent;
      }
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const base = pending[index]!;
        const record = this.buildSnapshotRecord(workspaceId, base);
        context.snapshotRecords.set(record.id, record);
      }
    } finally {
      for (const traversed of pending) context.visitingSnapshotRecordIds.delete(traversed.id);
    }
    return context.snapshotRecords.get(snapshotId)!;
  }

  private buildSnapshotRecord(
    workspaceId: string,
    snapshot: WorkspaceSnapshotBaseRecord,
  ): WorkspaceSnapshotRecord {
    const context = this.readContext();
    const artifactRows = this.db.prepare(
      `SELECT artifact_id, track_id, revision_id FROM workspace_snapshot_artifacts
       WHERE workspace_id = ? AND snapshot_id = ? ORDER BY artifact_id ASC`,
    ).all(workspaceId, snapshot.id) as Row[];
    const resourceRows = this.db.prepare(
      `SELECT resource_id, revision_id FROM workspace_snapshot_resources
       WHERE workspace_id = ? AND snapshot_id = ? ORDER BY resource_id ASC`,
    ).all(workspaceId, snapshot.id) as Row[];
    const graph = this.requireGraphRevision(workspaceId, snapshot.graphRevision);
    const artifactTracks = Object.fromEntries(artifactRows.map((mapping) => [
      requiredCell(mapping.artifact_id, "Snapshot Artifact id"),
      requiredCell(mapping.track_id, "Snapshot Artifact Track id"),
    ]));
    const artifactRevisions = Object.fromEntries(artifactRows.map((mapping) => [
      requiredCell(mapping.artifact_id, "Snapshot Artifact id"),
      mapping.revision_id == null ? null : requiredCell(mapping.revision_id, "Snapshot Artifact Revision id"),
    ]));
    const resourceRevisions = Object.fromEntries(resourceRows.map((mapping) => [
      requiredCell(mapping.resource_id, "Snapshot Resource id"),
      requiredCell(mapping.revision_id, "Snapshot Resource Revision id"),
    ]));
    this.validateStoredSnapshotMappings(
      workspaceId,
      graph,
      artifactTracks,
      artifactRevisions,
      resourceRevisions,
    );
    const record: WorkspaceSnapshotRecord = {
      ...snapshot,
      graph,
      artifactTracks,
      artifactRevisions,
      resourceRevisions,
    };
    if (record.provenance.kind === "artifact-publication") {
      if (record.parentSnapshotId === null) {
        throw new WorkspaceGraphValidationError(
          `Artifact publication Snapshot ${record.id} must be a direct successor`,
        );
      }
      const revision = this.requireArtifactRevision(record.provenance.revisionId);
      const parent = context.snapshotRecords.get(record.parentSnapshotId);
      if (parent === undefined) {
        throw new WorkspaceGraphValidationError(
          `Artifact publication Snapshot ${record.id} parent audit record is not resolvable`,
        );
      }
      const provenanceRunId = record.provenance.runId ?? null;
      if (revision.workspaceId !== workspaceId
        || record.artifactTracks[revision.artifactId] !== revision.trackId
        || record.artifactRevisions[revision.artifactId] !== revision.id
        || parent.artifactTracks[revision.artifactId] !== revision.trackId
        || parent.artifactRevisions[revision.artifactId] !== revision.parentRevisionId
        || provenanceRunId !== revision.producedByRunId
        || record.createdByRunId !== revision.producedByRunId) {
        throw new WorkspaceGraphValidationError(
          `Artifact publication Snapshot ${record.id} audit provenance does not match immutable history`,
        );
      }
    }
    if (record.provenance.kind === "resource-publication") {
      if (record.parentSnapshotId === null) {
        throw new WorkspaceGraphValidationError(
          `Resource publication Snapshot ${record.id} must be a direct successor`,
        );
      }
      const revision = this.requireResourceRevision(record.provenance.resourceRevisionId);
      const parent = context.snapshotRecords.get(record.parentSnapshotId);
      if (!parent) {
        throw new WorkspaceGraphValidationError(
          `Resource publication Snapshot ${record.id} parent audit record is not resolvable`,
        );
      }
      const expectedResourceRevisions = {
        ...parent.resourceRevisions,
        [revision.resourceId]: revision.id,
      };
      const sortedEntries = (value: Record<string, unknown>): Array<[string, unknown]> => (
        Object.entries(value).sort(([left], [right]) => compareBinary(left, right))
      );
      const provenanceRunId = record.provenance.runId ?? null;
      if (revision.workspaceId !== workspaceId
        || (parent.resourceRevisions[revision.resourceId] ?? null) !== revision.parentRevisionId
        || !isDeepStrictEqual(sortedEntries(record.resourceRevisions), sortedEntries(expectedResourceRevisions))
        || !isDeepStrictEqual(sortedEntries(record.artifactTracks), sortedEntries(parent.artifactTracks))
        || !isDeepStrictEqual(sortedEntries(record.artifactRevisions), sortedEntries(parent.artifactRevisions))
        || record.graphRevision !== parent.graphRevision
        || record.kernelRevisionId !== parent.kernelRevisionId
        || provenanceRunId !== revision.createdByRunId
        || record.createdByRunId !== revision.createdByRunId) {
        throw new WorkspaceGraphValidationError(
          `Resource publication Snapshot ${record.id} audit provenance does not match immutable history`,
        );
      }
    }
    if (record.provenance.kind === "kernel-publication") {
      const impact = record.provenance.impact;
      if (record.parentSnapshotId === null
        || record.provenance.kernelRevisionId !== record.kernelRevisionId
        || impact === undefined) {
        throw new WorkspaceGraphValidationError(
          `Kernel publication Snapshot ${record.id} has incomplete audit provenance`,
        );
      }
      const target = this.requireKernelRevision(record.kernelRevisionId);
      const parent = context.snapshotRecords.get(record.parentSnapshotId);
      if (parent === undefined) {
        throw new WorkspaceGraphValidationError(
          `Kernel publication Snapshot ${record.id} parent audit record is not resolvable`,
        );
      }
      const expectedImpact = this.computeKernelImpact(target, parent);
      if (!isDeepStrictEqual(impact, expectedImpact)) {
        throw new WorkspaceGraphValidationError(
          `Kernel publication Snapshot ${record.id} impact audit does not match immutable history`,
        );
      }
    }
    return record;
  }

  private validateStoredSnapshotMappings(
    workspaceId: string,
    graph: WorkspaceGraph,
    artifactTracks: Readonly<Record<string, string>>,
    artifactRevisions: Readonly<Record<string, string | null>>,
    resourceRevisions: Readonly<Record<string, string>>,
  ): void {
    const graphArtifacts = new Map(
      graph.nodes
        .filter((node): node is Extract<WorkspaceNode, { kind: "page" | "component" }> => node.kind !== "resource")
        .map((node) => [node.artifactId, node.kind] as const),
    );
    const graphArtifactIds = [...graphArtifacts.keys()].sort(compareBinary);
    const mappedArtifactIds = Object.keys(artifactTracks).sort(compareBinary);
    const revisionArtifactIds = Object.keys(artifactRevisions).sort(compareBinary);
    if (!isDeepStrictEqual(graphArtifactIds, mappedArtifactIds)
      || !isDeepStrictEqual(mappedArtifactIds, revisionArtifactIds)) {
      throw new WorkspaceGraphValidationError(
        "stored Workspace Snapshot Artifact mappings must exactly match its immutable graph",
      );
    }
    for (const artifactId of mappedArtifactIds) {
      const trackId = artifactTracks[artifactId];
      const revisionId = artifactRevisions[artifactId];
      const artifactKind = graphArtifacts.get(artifactId);
      if (trackId === undefined || revisionId === undefined || artifactKind === undefined) {
        throw new WorkspaceGraphValidationError(`stored Workspace Snapshot Artifact ${artifactId} is incomplete`);
      }
      const owned = revisionId === null
        ? this.db.prepare(
            `SELECT 1
             FROM artifact_tracks track
             JOIN workspace_artifacts artifact ON artifact.id = track.artifact_id
             WHERE track.id = ? AND track.artifact_id = ? AND artifact.workspace_id = ?
               AND artifact.kind = ?`,
          ).get(trackId, artifactId, workspaceId, artifactKind)
        : this.db.prepare(
            `SELECT 1
             FROM artifact_revisions revision
             JOIN artifact_tracks track
               ON track.id = revision.track_id AND track.artifact_id = revision.artifact_id
             JOIN workspace_artifacts artifact
               ON artifact.id = revision.artifact_id AND artifact.workspace_id = revision.workspace_id
             WHERE revision.id = ? AND revision.workspace_id = ?
               AND revision.artifact_id = ? AND revision.track_id = ? AND revision.sealed = 1
               AND artifact.kind = ?`,
          ).get(revisionId, workspaceId, artifactId, trackId, artifactKind);
      if (!owned) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Artifact mapping ${artifactId} is not an exact owned Revision pin`,
        );
      }
      if (revisionId !== null) {
        const revision = this.requireArtifactRevision(revisionId);
        if (revision.workspaceId !== workspaceId
          || revision.artifactId !== artifactId
          || revision.trackId !== trackId) {
          throw new WorkspaceGraphValidationError(
            `stored Workspace Snapshot Artifact mapping ${artifactId} is not an exact owned Revision pin`,
          );
        }
      }
    }
    const graphResourceIds = new Set(
      graph.nodes.filter((node) => node.kind === "resource").map((node) => node.resourceId),
    );
    for (const resourceId of graphResourceIds) {
      const identity = this.db.prepare(
        "SELECT 1 FROM resources WHERE id = ? AND workspace_id = ?",
      ).get(resourceId, workspaceId);
      if (!identity) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Resource ${resourceId} has no owned identity`,
        );
      }
    }
    for (const [resourceId, revisionId] of Object.entries(resourceRevisions)) {
      if (!graphResourceIds.has(resourceId)) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Resource ${resourceId} has no immutable graph node`,
        );
      }
      const owned = this.db.prepare(
        `SELECT 1 FROM resource_revisions
         WHERE id = ? AND resource_id = ? AND workspace_id = ?`,
      ).get(revisionId, resourceId, workspaceId);
      if (!owned) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Resource mapping ${resourceId} is not an exact owned Revision pin`,
        );
      }
    }
  }

  private getLayoutByWorkspaceId(workspaceId: string, layoutId: string): WorkspaceLayout {
    const rows = this.db.prepare(
      `SELECT * FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ?
       ORDER BY object_kind ASC, object_id ASC`,
    ).all(workspaceId, layoutId) as Row[];
    const storedNumber = (value: unknown, label: string): number => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
      return value;
    };
    const storedPositive = (value: unknown, label: string): number => {
      const number = storedNumber(value, label);
      if (number <= 0) throw new Error(`${label} must be positive`);
      return number;
    };
    const objects: WorkspaceLayout["objects"] = rows.map((row) => {
      const id = requiredCell(row.object_id, "layout object id");
      const parentGroupId = row.parent_group_id == null ? null : requiredCell(row.parent_group_id, "layout parent group id");
      const x = storedNumber(row.x, `layout object ${id} x`);
      const y = storedNumber(row.y, `layout object ${id} y`);
      if (row.object_kind === "node") return { id, kind: "node" as const, x, y, parentGroupId };
      if (row.object_kind !== "group") throw new Error(`unsupported layout object kind ${String(row.object_kind)}`);
      if (row.collapsed !== 0 && row.collapsed !== 1) throw new Error(`layout group ${id} collapsed is invalid`);
      return {
        id,
        kind: "group" as const,
        x,
        y,
        width: storedPositive(row.width, `layout group ${id} width`),
        height: storedPositive(row.height, `layout group ${id} height`),
        parentGroupId,
        label: requiredCell(row.label, `layout group ${id} label`),
        collapsed: row.collapsed === 1,
      };
    });
    const viewportRow = this.db.prepare(
      "SELECT * FROM workspace_layout_viewports WHERE workspace_id = ? AND layout_id = ?",
    ).get(workspaceId, layoutId) as Row | undefined;
    const layout = {
      workspaceId,
      layoutId,
      objects,
      viewport: viewportRow
        ? {
            x: storedNumber(viewportRow.x, "layout viewport x"),
            y: storedNumber(viewportRow.y, "layout viewport y"),
            zoom: storedPositive(viewportRow.zoom, "layout viewport zoom"),
          }
        : { x: 0, y: 0, zoom: 1 },
    };
    return { ...layout, checksum: workspaceLayoutChecksum(layout) };
  }

  private applyLayoutCommandsInTransaction(
    workspaceId: string,
    graph: WorkspaceGraph,
    layoutId: string,
    commands: readonly WorkspaceLayoutCommand[],
  ): void {
    const semanticNodeIds = new Set(graph.nodes.map((node) => node.id));
    const groupRow = (groupId: string) => this.db.prepare(
      `SELECT object_id FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
    ).get(workspaceId, layoutId, groupId) as Row | undefined;
    const anyObjectRow = (objectId: string) => this.db.prepare(
      `SELECT object_kind FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ? AND object_id = ?`,
    ).get(workspaceId, layoutId, objectId) as Row | undefined;
    const requireGroup = (groupId: string) => {
      if (!groupRow(groupId)) throw new WorkspaceGraphValidationError(`layout group ${groupId} does not exist`);
    };
    const ensureObject = (objectId: string, now: number): "node" | "group" => {
      const existing = anyObjectRow(objectId);
      if (existing?.object_kind === "group") return "group";
      if (existing?.object_kind === "node") {
        if (!semanticNodeIds.has(objectId)) {
          throw new WorkspaceGraphValidationError(`layout semantic object ${objectId} does not exist`);
        }
        return "node";
      }
      if (!semanticNodeIds.has(objectId)) {
        throw new WorkspaceGraphValidationError(`layout object ${objectId} does not exist`);
      }
      this.db.prepare(
        `INSERT INTO workspace_layout_nodes (
           workspace_id, layout_id, object_id, object_kind, x, y, width, height,
           parent_group_id, label, collapsed, updated_at
         ) VALUES (?, ?, ?, 'node', 0, 0, NULL, NULL, NULL, NULL, 0, ?)`,
      ).run(workspaceId, layoutId, objectId, now);
      return "node";
    };

    for (const command of commands) {
      const now = this.clock.now();
      switch (command.type) {
        case "add-group":
          if (this.db.prepare(
            "SELECT 1 FROM workspace_nodes WHERE workspace_id = ? AND id = ?",
          ).get(workspaceId, command.groupId)) {
            throw new WorkspaceGraphValidationError(
              `layout group ${command.groupId} collides with a reserved semantic node identity`,
            );
          }
          if (semanticNodeIds.has(command.groupId) || anyObjectRow(command.groupId)) {
            throw new WorkspaceGraphValidationError(`duplicate layout group id ${command.groupId}`);
          }
          this.db.prepare(
            `INSERT INTO workspace_layout_nodes (
               workspace_id, layout_id, object_id, object_kind, x, y, width, height,
               parent_group_id, label, collapsed, updated_at
             ) VALUES (?, ?, ?, 'group', ?, ?, ?, ?, NULL, ?, 0, ?)`,
          ).run(
            workspaceId,
            layoutId,
            command.groupId,
            command.bounds.x,
            command.bounds.y,
            command.bounds.width,
            command.bounds.height,
            command.label,
            now,
          );
          break;
        case "rename-group":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET label = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(command.label, now, workspaceId, layoutId, command.groupId);
          break;
        case "delete-group":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET parent_group_id = NULL, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND parent_group_id = ?`,
          ).run(now, workspaceId, layoutId, command.groupId);
          this.db.prepare(
            `DELETE FROM workspace_layout_nodes
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(workspaceId, layoutId, command.groupId);
          break;
        case "set-parent":
          ensureObject(command.objectId, now);
          if (command.parentGroupId !== null) requireGroup(command.parentGroupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET parent_group_id = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ?`,
          ).run(command.parentGroupId, now, workspaceId, layoutId, command.objectId);
          break;
        case "move":
          ensureObject(command.objectId, now);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET x = ?, y = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ?`,
          ).run(command.x, command.y, now, workspaceId, layoutId, command.objectId);
          break;
        case "resize-group":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET width = ?, height = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(command.width, command.height, now, workspaceId, layoutId, command.groupId);
          break;
        case "set-collapsed":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET collapsed = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(command.collapsed ? 1 : 0, now, workspaceId, layoutId, command.groupId);
          break;
        case "set-viewport":
          this.db.prepare(
            `INSERT INTO workspace_layout_viewports (workspace_id, layout_id, x, y, zoom, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, layout_id) DO UPDATE
             SET x = excluded.x, y = excluded.y, zoom = excluded.zoom, updated_at = excluded.updated_at`,
          ).run(workspaceId, layoutId, command.viewport.x, command.viewport.y, command.viewport.zoom, now);
          break;
      }
    }
    this.validateLayoutGroups(workspaceId, layoutId, semanticNodeIds);
  }

  private validateLayoutGroups(workspaceId: string, layoutId: string, semanticNodeIds: ReadonlySet<string>): void {
    const rows = this.db.prepare(
      `SELECT object_id, object_kind, parent_group_id FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ?`,
    ).all(workspaceId, layoutId) as Array<{ object_id: string; object_kind: string; parent_group_id: string | null }>;
    const groups = new Set(rows.filter((row) => row.object_kind === "group").map((row) => row.object_id));
    const reservedNodeIds = new Set((this.db.prepare(
      "SELECT id FROM workspace_nodes WHERE workspace_id = ?",
    ).all(workspaceId) as Array<{ id: string }>).map(({ id }) => id));
    const parents = new Map<string, string | null>();
    for (const row of rows) {
      if (row.object_kind !== "group" && row.object_kind !== "node") {
        throw new WorkspaceGraphValidationError(`unsupported layout object kind ${row.object_kind}`);
      }
      if (row.object_kind === "node" && !semanticNodeIds.has(row.object_id)) {
        throw new WorkspaceGraphValidationError(`layout semantic object ${row.object_id} does not exist`);
      }
      if (row.object_kind === "group" && reservedNodeIds.has(row.object_id)) {
        throw new WorkspaceGraphValidationError(`layout group ${row.object_id} collides with a semantic node identity`);
      }
      if (row.parent_group_id !== null && !groups.has(row.parent_group_id)) {
        throw new WorkspaceGraphValidationError(`layout parent group ${row.parent_group_id} does not exist`);
      }
      if (row.object_kind === "group") parents.set(row.object_id, row.parent_group_id);
    }
    const states = new Map<string, "visiting" | "done">();
    for (const groupId of groups) {
      if (states.get(groupId) === "done") continue;
      const path: string[] = [];
      let cursor: string | null | undefined = groupId;
      while (cursor !== null && cursor !== undefined && states.get(cursor) !== "done") {
        if (states.get(cursor) === "visiting") {
          throw new WorkspaceGraphValidationError("layout group parent cycle detected");
        }
        states.set(cursor, "visiting");
        path.push(cursor);
        cursor = parents.get(cursor);
      }
      for (const pathGroupId of path) states.set(pathGroupId, "done");
    }
  }

  private requireGraphRevision(workspaceId: string, revision: number): WorkspaceGraph {
    const row = this.db.prepare(
      `SELECT * FROM workspace_graph_revisions
       WHERE workspace_id = ? AND revision = ?`,
    ).get(workspaceId, revision) as Row | undefined;
    if (!row) throw new Error(`workspace graph revision not found: ${workspaceId}@${revision}`);
    return asWorkspaceGraphRevision(row);
  }

  private listNodes(workspaceId: string): WorkspaceGraph["nodes"] {
    const rows = this.db.prepare(
      `SELECT n.*, CASE WHEN n.kind = 'resource' THEN r.title ELSE a.name END AS name
       FROM workspace_nodes n
       LEFT JOIN workspace_artifacts a
         ON a.id = n.artifact_id AND a.workspace_id = n.workspace_id
       LEFT JOIN resources r
         ON r.id = n.resource_id AND r.workspace_id = n.workspace_id
       WHERE n.workspace_id = ? AND n.archived_at IS NULL
       ORDER BY n.created_at ASC, n.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(asWorkspaceNode);
  }

  private listEdges(workspaceId: string): WorkspaceGraph["edges"] {
    const rows = this.db.prepare(
      `SELECT e.*
       FROM workspace_edges e
       JOIN workspace_nodes source
         ON source.id = e.source_node_id AND source.workspace_id = e.workspace_id
       JOIN workspace_nodes target
         ON target.id = e.target_node_id AND target.workspace_id = e.workspace_id
       WHERE e.workspace_id = ?
         AND source.archived_at IS NULL
         AND target.archived_at IS NULL
       ORDER BY e.created_at ASC, e.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(asWorkspaceEdge);
  }
}
