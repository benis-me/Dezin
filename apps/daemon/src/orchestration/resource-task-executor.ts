import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";
import {
  GenerationTaskQualityGateError,
  type GenerationTask,
  type GenerationTaskAttemptClaim,
  type GenerationTaskAttemptLease,
  type GenerationTaskProgressPhase,
  type ResourceGenerationTaskPayloadV2,
  type ResourceKind,
  type WorkspaceGenerationCapability,
} from "../../../../packages/core/src/index.ts";
import { resourceRevisionManifestRelativePath } from "../resource-revision-payload.ts";
import type {
  ResourceGenerationTaskLeafExecutor,
  ResourcePreparedCandidate,
} from "./generation-task-executor.ts";
import {
  GenerationTaskPayloadContractError,
  validateFrozenGenerationTaskAgent,
  validateMoodboardImageExecutionAuthority,
} from "./generation-task-contracts.ts";
import type { ResearchRevisionTaskAuthority } from "../research-resource-revision.ts";

const CONTEXT_PACK_ID = /^context-pack-([a-f0-9]{64})$/;

export interface ResourceGenerationAdapterIdentity {
  readonly id: string;
  readonly version: number;
  readonly kind: ResourceKind;
}

export interface ResourceGenerationAdapterOutput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly summary: string;
  readonly metadata: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
}

export interface ResourceGenerationAdapterInput {
  readonly taskId: string;
  readonly planId: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly parentRevisionId: string | null;
  readonly contextPackId: string;
  readonly operation: "create" | "revise";
  readonly nodeId: string;
  readonly title: string;
  readonly resourceKind: ResourceKind;
  readonly brief: ResourceGenerationTaskPayloadV2["brief"];
  readonly capabilityDescriptors: readonly WorkspaceGenerationCapability[];
  /** Exact frozen outer deadline compiled into this immutable Task. */
  readonly taskTimeoutMs: number;
  /** Exact frozen Attempt-wide quality-repair ceiling compiled into this immutable Task. */
  readonly maxRepairRounds: number;
  /** Exact frozen payload budget compiled into this immutable Task. */
  readonly maxOutputBytes: number;
  /** Emits one bounded designer-facing phase; production binds it to this exact leased Attempt. */
  readonly reportProgress?: (phase: GenerationTaskProgressPhase) => void | Promise<void>;
  readonly signal: AbortSignal;
}

export interface ResourceGenerationAdapter {
  readonly identity: ResourceGenerationAdapterIdentity;
  generate(input: ResourceGenerationAdapterInput): Promise<ResourceGenerationAdapterOutput>;
}

export interface ResourceTaskProgressPort {
  record(
    claim: GenerationTaskAttemptClaim,
    phase: GenerationTaskProgressPhase,
  ): void | Promise<void>;
}

export interface ResourceTaskPayloadScope {
  readonly taskId: string;
  /** Exact immutable Plan owner. Required by Research payload validation. */
  readonly planId?: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly adapter: ResourceGenerationAdapterIdentity;
  readonly maxOutputBytes: number;
  readonly contextPackId?: string;
  readonly contextPackHash?: string;
  readonly researchTaskAuthority?: ResearchRevisionTaskAuthority;
  readonly lease?: GenerationTaskAttemptLease;
  readonly signal: AbortSignal;
}

export interface ResourceTaskPayloadStageInput {
  readonly taskId: string;
  /** Exact immutable Plan owner. Required by Research payload validation. */
  readonly planId?: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly adapter: ResourceGenerationAdapterIdentity;
  readonly maxOutputBytes: number;
  readonly contextPackId: string;
  readonly contextPackHash: string;
  readonly researchTaskAuthority?: ResearchRevisionTaskAuthority;
  readonly lease: GenerationTaskAttemptLease;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly summary: string;
  readonly metadata: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export interface ResourceTaskPayloadReceipt {
  readonly protocol: "dezin.resource-task-payload-receipt.v1";
  readonly taskId: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly adapter: ResourceGenerationAdapterIdentity;
  readonly manifestPath: string;
  readonly manifestChecksum: string;
  readonly payloadChecksum: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly summary: string;
  readonly metadata: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
}

export interface ResourceTaskPayloadStagingPort {
  /** Finds a durable attempt-scoped receipt before invoking a nondeterministic adapter. */
  find(input: ResourceTaskPayloadScope): Promise<ResourceTaskPayloadReceipt | null>;
  /**
   * Validates the complete adapter-authored payload against daemon authority
   * before any durable staging write. Research generation fails closed when
   * this capability is unavailable.
   */
  validate?(input: ResourceTaskPayloadStageInput): Promise<void>;
  /** Seals bytes and the receipt atomically/idempotently for the exact scope. */
  stage(input: ResourceTaskPayloadStageInput): Promise<ResourceTaskPayloadReceipt>;
  /**
   * May remove owned bytes only after confirming no candidate row or Resource
   * Revision references the receipt's revisionId. A false return keeps storage.
   */
  cleanupIfUnreferenced(receipt: ResourceTaskPayloadReceipt): Promise<boolean>;
}

export type ResourceTaskAdapterErrorCode =
  | "RESOURCE_ADAPTER_REGISTRATION_INVALID"
  | "RESOURCE_ADAPTER_DUPLICATE"
  | "RESOURCE_ADAPTER_VERSION_UNAVAILABLE"
  | "RESOURCE_ADAPTER_KIND_UNAVAILABLE"
  | "RESOURCE_ADAPTER_UNAVAILABLE"
  | "RESOURCE_ADAPTER_OUTPUT_INVALID";

export class ResourceTaskAdapterError extends Error {
  readonly failureClass = "adapter" as const;
  readonly code: ResourceTaskAdapterErrorCode;

  constructor(code: ResourceTaskAdapterErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ResourceTaskAdapterError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type ResourceTaskContractErrorCode =
  | "RESOURCE_TASK_PAYLOAD_VERSION_UNSUPPORTED"
  | "RESOURCE_TASK_PAYLOAD_INVALID"
  | "RESOURCE_TASK_ATTEMPT_INVALID";

export class ResourceTaskContractError extends Error {
  readonly failureClass = "design" as const;
  readonly code: ResourceTaskContractErrorCode;

  constructor(code: ResourceTaskContractErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ResourceTaskContractError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type ResourceTaskPayloadErrorCode =
  | "RESOURCE_PAYLOAD_LOOKUP_FAILED"
  | "RESOURCE_PAYLOAD_STAGE_FAILED"
  | "RESOURCE_PAYLOAD_RECEIPT_INVALID"
  | "RESOURCE_PAYLOAD_CLEANUP_FAILED";

export class ResourceTaskPayloadError extends Error {
  readonly failureClass = "storage" as const;
  readonly code: ResourceTaskPayloadErrorCode;

  constructor(code: ResourceTaskPayloadErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ResourceTaskPayloadError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class VersionedResourceGenerationAdapterRegistry {
  readonly #adapters = new Map<string, ResourceGenerationAdapter>();
  readonly #identities: ResourceGenerationAdapterIdentity[] = [];

  constructor(adapters: readonly ResourceGenerationAdapter[]) {
    let values: readonly ResourceGenerationAdapter[];
    try {
      values = [...adapters];
    } catch (error) {
      throw new ResourceTaskAdapterError(
        "RESOURCE_ADAPTER_REGISTRATION_INVALID",
        "Resource generation adapter registry input could not be inspected",
        error,
      );
    }
    for (const adapter of values) {
      const identity = registryIdentity(adapter);
      const key = adapterKey(identity);
      if (this.#adapters.has(key)) {
        throw new ResourceTaskAdapterError(
          "RESOURCE_ADAPTER_DUPLICATE",
          `Duplicate Resource generation adapter registration: ${printAdapter(identity)}`,
        );
      }
      const generate = registryGenerate(adapter);
      const pinnedIdentity = Object.freeze({ ...identity });
      const pinnedAdapter = Object.freeze({
        identity: pinnedIdentity,
        generate: (input: ResourceGenerationAdapterInput) => Reflect.apply(generate, adapter, [input]),
      } satisfies ResourceGenerationAdapter);
      this.#adapters.set(key, pinnedAdapter);
      this.#identities.push(pinnedIdentity);
    }
    Object.freeze(this.#identities);
  }

  require(identity: ResourceGenerationAdapterIdentity): ResourceGenerationAdapter {
    const adapter = this.#adapters.get(adapterKey(identity));
    if (!adapter) {
      if (this.#identities.some((candidate) => candidate.id === identity.id
        && candidate.kind === identity.kind)) {
        throw new ResourceTaskAdapterError(
          "RESOURCE_ADAPTER_VERSION_UNAVAILABLE",
          `Resource generation adapter version is unavailable: ${printAdapter(identity)}`,
        );
      }
      if (this.#identities.some((candidate) => candidate.id === identity.id
        && candidate.version === identity.version)) {
        throw new ResourceTaskAdapterError(
          "RESOURCE_ADAPTER_KIND_UNAVAILABLE",
          `Resource generation adapter kind is unavailable: ${printAdapter(identity)}`,
        );
      }
      throw new ResourceTaskAdapterError(
        "RESOURCE_ADAPTER_UNAVAILABLE",
        `Resource generation adapter is unavailable: ${printAdapter(identity)}`,
      );
    }
    return adapter;
  }
}

export class ResourceTaskExecutor implements ResourceGenerationTaskLeafExecutor {
  readonly options: {
    adapters: VersionedResourceGenerationAdapterRegistry;
    staging: ResourceTaskPayloadStagingPort;
    progress?: ResourceTaskProgressPort;
  };
  readonly #receiptByCandidate = new WeakMap<ResourcePreparedCandidate, ResourceTaskPayloadReceipt>();

  constructor(options: {
    adapters: VersionedResourceGenerationAdapterRegistry;
    staging: ResourceTaskPayloadStagingPort;
    progress?: ResourceTaskProgressPort;
  }) {
    this.options = Object.freeze({
      adapters: options.adapters,
      staging: options.staging,
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    });
  }

  async execute(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<ResourcePreparedCandidate> {
    checkAbort(signal);
    validateAttemptClaim(claim);
    const contextPackId = claim.attempt.contextPackId as string;
    const contextPackHash = CONTEXT_PACK_ID.exec(contextPackId)![1]!;
    const payload = parseResourceGenerationTaskPayloadV2(claim.task);
    const researchTaskAuthority = payload.operation.kind === "research"
      ? buildResearchRevisionTaskAuthority(payload)
      : undefined;
    const revisionId = attemptRevisionId(claim);
    const scope: ResourceTaskPayloadScope = {
      taskId: claim.task.id,
      planId: claim.task.planId,
      attempt: claim.attempt.attempt,
      inputHash: claim.attempt.inputHash,
      workspaceId: claim.task.workspaceId,
      resourceId: payload.operation.resourceId,
      revisionId,
      parentRevisionId: claim.attempt.baseRevisionId,
      adapter: payload.adapter,
      maxOutputBytes: claim.task.resourceLimits.maxOutputBytes,
      contextPackId,
      contextPackHash,
      ...(researchTaskAuthority === undefined ? {} : { researchTaskAuthority }),
      lease: claim.lease,
      signal,
    };
    const outputBudget = claim.task.resourceLimits.maxOutputBytes;
    let replayReceipt: ResourceTaskPayloadReceipt | null;
    try {
      replayReceipt = await this.options.staging.find(scope);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof ResourceTaskPayloadError || hasDeclaredFailureClass(error)) throw error;
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_LOOKUP_FAILED",
        "Attempt-scoped Resource payload receipt lookup failed",
        error,
      );
    }
    checkAbort(signal);
    if (replayReceipt !== null) {
      const normalized = validateResourceTaskPayloadReceipt(replayReceipt, scope);
      enforceResearchDecisionGradeGate(
        payload.operation.kind,
        normalized.metadata,
        normalized.evidence,
      );
      await this.options.progress?.record(claim, "publishing");
      checkAbort(signal);
      return this.preparedCandidate(claim, payload, normalized);
    }
    const adapter = this.options.adapters.require(payload.adapter);
    let rawOutput: unknown;
    try {
      rawOutput = await adapter.generate(Object.freeze({
        taskId: claim.task.id,
        planId: claim.task.planId,
        attempt: claim.attempt.attempt,
        inputHash: claim.attempt.inputHash,
        workspaceId: claim.task.workspaceId,
        resourceId: payload.operation.resourceId,
        parentRevisionId: claim.attempt.baseRevisionId,
        contextPackId,
        operation: payload.operation.operation,
        nodeId: payload.operation.nodeId,
        title: payload.operation.title,
        resourceKind: payload.operation.kind,
        brief: payload.brief,
        capabilityDescriptors: payload.capabilityDescriptors,
        taskTimeoutMs: claim.task.resourceLimits.timeoutMs,
        maxRepairRounds: claim.task.resourceLimits.maxRepairRounds,
        maxOutputBytes: claim.task.resourceLimits.maxOutputBytes,
        reportProgress: async (phase) => {
          checkAbort(signal);
          await this.options.progress?.record(claim, phase);
          checkAbort(signal);
        },
        signal,
      } satisfies ResourceGenerationAdapterInput));
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof ResourceTaskAdapterError || hasDeclaredFailureClass(error)) throw error;
      throw new ResourceTaskAdapterError(
        "RESOURCE_ADAPTER_OUTPUT_INVALID",
        `Resource generation adapter ${printAdapter(payload.adapter)} failed before returning valid output`,
        error,
      );
    }
    checkAbort(signal);
    const output = normalizeAdapterOutput(rawOutput, outputBudget);
    enforceResearchDecisionGradeGate(payload.operation.kind, output.metadata, output.evidence);
    if (payload.operation.kind === "research"
      && typeof this.options.staging.validate !== "function") {
      throw new ResourceTaskAdapterError(
        "RESOURCE_ADAPTER_OUTPUT_INVALID",
        "Research adapter output cannot be published without complete payload validation",
      );
    }
    checkAbort(signal);
    await this.options.progress?.record(claim, "publishing");
    checkAbort(signal);
    let stagedReceipt: ResourceTaskPayloadReceipt;
    try {
      stagedReceipt = await this.options.staging.stage({
        ...scope,
        contextPackId,
        contextPackHash,
        lease: claim.lease,
        bytes: new Uint8Array(output.bytes),
        mimeType: output.mimeType,
        summary: output.summary,
        metadata: structuredClone(output.metadata),
        provenance: structuredClone(output.provenance),
        evidence: structuredClone(output.evidence),
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof ResourceTaskPayloadError || hasDeclaredFailureClass(error)) throw error;
      throw new ResourceTaskPayloadError(
        "RESOURCE_PAYLOAD_STAGE_FAILED",
        "Attempt-scoped Resource payload staging failed",
        error,
      );
    }
    try {
      checkAbort(signal);
      const normalized = validateResourceTaskPayloadReceipt(stagedReceipt, scope, output);
      return this.preparedCandidate(claim, payload, normalized);
    } catch (error) {
      if (cleanupEligibleReceipt(stagedReceipt, scope)) {
        await this.options.staging.cleanupIfUnreferenced(stagedReceipt).catch(() => false);
      }
      throw error;
    }
  }

  async cleanupIfUnreferenced(
    claim: GenerationTaskAttemptClaim,
    candidate: ResourcePreparedCandidate,
  ): Promise<boolean> {
    const receipt = this.#receiptByCandidate.get(candidate);
    if (receipt === undefined
      || candidate.taskId !== claim.task.id
      || candidate.workspaceId !== claim.task.workspaceId
      || candidate.resourceId !== claim.task.target.id) {
      return false;
    }
    return this.options.staging.cleanupIfUnreferenced(receipt);
  }

  private preparedCandidate(
    claim: GenerationTaskAttemptClaim,
    payload: ResourceGenerationTaskPayloadV2,
    receipt: ResourceTaskPayloadReceipt,
  ): ResourcePreparedCandidate {
    const candidate = buildPreparedCandidate(claim, payload, receipt);
    this.#receiptByCandidate.set(candidate, receipt);
    return candidate;
  }
}

function buildResearchRevisionTaskAuthority(
  payload: ResourceGenerationTaskPayloadV2,
): ResearchRevisionTaskAuthority {
  const targetInstructions = payload.brief.targetInstructions;
  return Object.freeze({
    operation: payload.operation.operation,
    nodeId: payload.operation.nodeId,
    title: payload.operation.title,
    brief: Object.freeze({
      proposalRationale: payload.brief.proposalRationale,
      assumptions: Object.freeze([...payload.brief.assumptions]),
      targetInstructions: Object.freeze({
        operation: targetInstructions.operation,
        kind: "research" as const,
        title: targetInstructions.title,
        ...(targetInstructions.instructions === undefined
          ? {}
          : { instructions: targetInstructions.instructions }),
      }),
    }),
  });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

const RESEARCH_DECISION_GRADE_CRITERIA_FIELDS = [
  "minimumVerifiedWebSourceCount",
  "minimumEvidenceFindingCount",
  "minimumEvidenceDirectionCount",
  "requiresGroundednessVerifier",
] as const;
const RESEARCH_DECISION_GRADE_OBSERVED_FIELDS = [
  "verifiedWebSourceCount",
  "evidenceFindingCount",
  "evidenceDirectionCount",
  "groundednessVerifierAvailable",
] as const;
const RESEARCH_DECISION_GRADE_BLOCKERS = new Set([
  "groundedness-verifier-unavailable",
  "insufficient-verified-web-sources",
  "insufficient-evidence-findings",
  "insufficient-evidence-directions",
]);
const RESEARCH_WEB_EVIDENCE_FAILURE_REASONS = [
  "retriever-unavailable",
  "network-failed",
  "http-status",
  "unsupported-media-type",
  "content-extraction-failed",
  "excerpt-mismatch",
  "representation-invalid",
  "binding-unavailable",
  "binding-rejected",
  "binding-invalid",
] as const;
const RESEARCH_WEB_EVIDENCE_FAILURE_REASON_SET = new Set<string>(
  RESEARCH_WEB_EVIDENCE_FAILURE_REASONS,
);
const MAX_RESEARCH_EVIDENCE_RECEIPTS = 64;
const MAX_RESEARCH_EVIDENCE_RECEIPT_FIELDS = 32;
const MAX_RESEARCH_DECISION_GRADE_COUNT = 1_000_000;
const MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_DIAGNOSTICS = 16;
const MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_DIAGNOSTICS_BYTES = 16 * 1_024;
const MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_OPTION_COUNT = 4;
const MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_QUOTE_COUNT = 256 * 8;
const MAX_RESEARCH_CANONICAL_EXCERPT_BYTES = 8 * 1_024;
const SHA256 = /^[a-f0-9]{64}$/;
const RESEARCH_CANONICAL_EXCERPT_REPAIR_DIAGNOSTIC_FIELDS = [
  "decision",
  "optionCount",
  "quoteCount",
  "matchingOptionCount",
  "candidateExcerptByteLength",
  "candidateExcerptIdentityHash",
  "sourceIdentityHash",
  "requestedUrlHash",
  "sourceIdSameAsFirstPass",
  "requestedUrlSameAsFirstPass",
  "selectedOptionIdentityHash",
  "canonicalUrlSameAsFirstPass",
  "canonicalTextChecksumSameAsFirstPass",
  "receiptReason",
] as const;
const RESEARCH_CANONICAL_EXCERPT_REPAIR_DECISIONS = new Set([
  "reference-hit",
  "exact-option-hit",
  "preserved-old-unique-hit",
  "preserved-old-zero",
  "preserved-old-ambiguous",
  "changed-unresolved",
]);
const RESEARCH_CANONICAL_EXCERPT_REPAIR_RECEIPT_REASONS = new Set([
  "verified",
  ...RESEARCH_WEB_EVIDENCE_FAILURE_REASONS,
]);
const RESEARCH_EVIDENCE_COVERAGE_FIELDS = [
  "protocol",
  "repairMode",
  "firstPassGate",
  "finalPass",
] as const;
const RESEARCH_EVIDENCE_COVERAGE_FIRST_PASS_GATE_FIELDS = [
  "observed",
  "blockers",
] as const;
const RESEARCH_EVIDENCE_COVERAGE_FINAL_PASS_FIELDS = [
  "webSourceCount",
  "verifiedWebReceiptCount",
  "unverifiedWebReceiptCount",
  "verifiedWebSupportReceiptCount",
  "groundednessSelectedWebSupportReceiptCount",
  "groundednessSelectedWebSourceCount",
  "groundednessSelectedWebCanonicalComponentCount",
  "evidenceFindingCount",
  "evidenceDirectionCount",
  "qualifyingDecisionGradeDirectionCount",
  "maximumDirectionEvidenceFindingCount",
  "maximumDirectionVerifiedWebComponentCount",
] as const;
const RESEARCH_EVIDENCE_COVERAGE_REPAIR_MODES = new Set([
  "none",
  "full-replacement",
  "direction-only",
]);

interface ResearchDecisionGradeObservation {
  readonly verifiedWebSourceCount: number;
  readonly evidenceFindingCount: number;
  readonly evidenceDirectionCount: number;
  readonly groundednessVerifierAvailable: boolean;
}

function invalidResearchDecisionGradeGate(message: string, cause?: unknown): never {
  throw new ResourceTaskAdapterError(
    "RESOURCE_ADAPTER_OUTPUT_INVALID",
    message,
    cause,
  );
}

function researchDecisionGradeRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || nodeUtilTypes.isProxy(value)) {
      return invalidResearchDecisionGradeGate(`${label} must be an exact object`);
    }
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.some((key) => typeof key !== "string")
      || keys.length !== fields.length
      || fields.some((field) => !keys.includes(field))) {
      return invalidResearchDecisionGradeGate(`${label} fields are invalid`);
    }
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalidResearchDecisionGradeGate(`${label}.${field} must be an own data field`);
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    return invalidResearchDecisionGradeGate(`${label} could not be inspected`, error);
  }
}

function researchDecisionGradeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 0 || value > MAX_RESEARCH_DECISION_GRADE_COUNT) {
    return invalidResearchDecisionGradeGate(`${label} must be a bounded non-negative safe integer`);
  }
  return value;
}

function researchDecisionGradeBlockers(
  value: unknown,
  label = "Research adapter decision-grade blockers",
): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > RESEARCH_DECISION_GRADE_BLOCKERS.size) {
    return invalidResearchDecisionGradeGate(`${label} are invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const blockers: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "string"
      || !RESEARCH_DECISION_GRADE_BLOCKERS.has(descriptor.value)) {
      return invalidResearchDecisionGradeGate(`${label} are invalid`);
    }
    blockers.push(descriptor.value);
  }
  if (new Set(blockers).size !== blockers.length) {
    return invalidResearchDecisionGradeGate(`${label} are invalid`);
  }
  return blockers;
}

function expectedResearchDecisionGradeBlockers(
  observed: ResearchDecisionGradeObservation,
): string[] {
  return [
    ...(observed.groundednessVerifierAvailable ? [] : ["groundedness-verifier-unavailable"]),
    ...(observed.verifiedWebSourceCount < 2 ? ["insufficient-verified-web-sources"] : []),
    ...(observed.evidenceFindingCount < 2 ? ["insufficient-evidence-findings"] : []),
    ...(observed.evidenceDirectionCount < 1 ? ["insufficient-evidence-directions"] : []),
  ];
}

function researchCanonicalExcerptRepairDiagnostics(
  evidence: Record<string, unknown>,
): readonly Readonly<Record<string, unknown>>[] {
  const rawDiagnostics = evidence.canonicalExcerptRepairDiagnostics;
  if (rawDiagnostics === undefined) return Object.freeze([]);
  try {
    if (!Array.isArray(rawDiagnostics)
      || nodeUtilTypes.isProxy(rawDiagnostics)
      || Object.getPrototypeOf(rawDiagnostics) !== Array.prototype
      || rawDiagnostics.length > MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_DIAGNOSTICS) {
      return invalidResearchDecisionGradeGate(
        "Research adapter canonical excerpt repair diagnostics are invalid",
      );
    }
    const keys = Reflect.ownKeys(rawDiagnostics);
    const arrayDescriptors = Object.getOwnPropertyDescriptors(rawDiagnostics);
    if (keys.some((key) => typeof key !== "string")
      || keys.length !== rawDiagnostics.length + 1
      || !keys.includes("length")) {
      return invalidResearchDecisionGradeGate(
        "Research adapter canonical excerpt repair diagnostics are invalid",
      );
    }
    const diagnostics: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < rawDiagnostics.length; index += 1) {
      const descriptor = arrayDescriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalidResearchDecisionGradeGate(
          "Research adapter canonical excerpt repair diagnostics are invalid",
        );
      }
      const exact = researchDecisionGradeRecord(
        descriptor.value,
        RESEARCH_CANONICAL_EXCERPT_REPAIR_DIAGNOSTIC_FIELDS,
        `Research adapter canonical excerpt repair diagnostic ${index}`,
      );
      const optionCount = researchDecisionGradeCount(
        exact.optionCount,
        `Research adapter canonical excerpt repair diagnostic ${index} option count`,
      );
      const quoteCount = researchDecisionGradeCount(
        exact.quoteCount,
        `Research adapter canonical excerpt repair diagnostic ${index} quote count`,
      );
      const matchingOptionCount = researchDecisionGradeCount(
        exact.matchingOptionCount,
        `Research adapter canonical excerpt repair diagnostic ${index} matching option count`,
      );
      const candidateExcerptByteLength = researchDecisionGradeCount(
        exact.candidateExcerptByteLength,
        `Research adapter canonical excerpt repair diagnostic ${index} candidate excerpt byte length`,
      );
      const selectedOptionIdentityHash = exact.selectedOptionIdentityHash;
      if (typeof exact.decision !== "string"
        || !RESEARCH_CANONICAL_EXCERPT_REPAIR_DECISIONS.has(exact.decision)
        || optionCount > MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_OPTION_COUNT
        || quoteCount > MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_QUOTE_COUNT
        || matchingOptionCount > optionCount
        || candidateExcerptByteLength < 1
        || candidateExcerptByteLength > MAX_RESEARCH_CANONICAL_EXCERPT_BYTES
        || typeof exact.candidateExcerptIdentityHash !== "string"
        || !SHA256.test(exact.candidateExcerptIdentityHash)
        || typeof exact.sourceIdentityHash !== "string"
        || !SHA256.test(exact.sourceIdentityHash)
        || typeof exact.requestedUrlHash !== "string"
        || !SHA256.test(exact.requestedUrlHash)
        || typeof exact.sourceIdSameAsFirstPass !== "boolean"
        || typeof exact.requestedUrlSameAsFirstPass !== "boolean"
        || (selectedOptionIdentityHash !== null
          && (typeof selectedOptionIdentityHash !== "string"
            || !SHA256.test(selectedOptionIdentityHash)))
        || typeof exact.canonicalUrlSameAsFirstPass !== "boolean"
        || typeof exact.canonicalTextChecksumSameAsFirstPass !== "boolean"
        || typeof exact.receiptReason !== "string"
        || !RESEARCH_CANONICAL_EXCERPT_REPAIR_RECEIPT_REASONS.has(exact.receiptReason)) {
        return invalidResearchDecisionGradeGate(
          `Research adapter canonical excerpt repair diagnostic ${index} values are invalid`,
        );
      }
      const selectedDecision = exact.decision === "reference-hit"
        || exact.decision === "exact-option-hit"
        || exact.decision === "preserved-old-unique-hit";
      const ambiguousDecision = exact.decision === "preserved-old-ambiguous";
      if ((selectedDecision && (matchingOptionCount !== 1 || selectedOptionIdentityHash === null))
        || (ambiguousDecision && (matchingOptionCount < 2 || selectedOptionIdentityHash !== null))
        || (!selectedDecision && !ambiguousDecision
          && (matchingOptionCount !== 0 || selectedOptionIdentityHash !== null))) {
        return invalidResearchDecisionGradeGate(
          `Research adapter canonical excerpt repair diagnostic ${index} decision is inconsistent`,
        );
      }
      diagnostics.push(Object.freeze({
        decision: exact.decision,
        optionCount,
        quoteCount,
        matchingOptionCount,
        candidateExcerptByteLength,
        candidateExcerptIdentityHash: exact.candidateExcerptIdentityHash,
        sourceIdentityHash: exact.sourceIdentityHash,
        requestedUrlHash: exact.requestedUrlHash,
        sourceIdSameAsFirstPass: exact.sourceIdSameAsFirstPass,
        requestedUrlSameAsFirstPass: exact.requestedUrlSameAsFirstPass,
        selectedOptionIdentityHash,
        canonicalUrlSameAsFirstPass: exact.canonicalUrlSameAsFirstPass,
        canonicalTextChecksumSameAsFirstPass: exact.canonicalTextChecksumSameAsFirstPass,
        receiptReason: exact.receiptReason,
      }));
    }
    if (Buffer.byteLength(JSON.stringify(diagnostics), "utf8")
      > MAX_RESEARCH_CANONICAL_EXCERPT_REPAIR_DIAGNOSTICS_BYTES) {
      return invalidResearchDecisionGradeGate(
        "Research adapter canonical excerpt repair diagnostics exceed their bounded size",
      );
    }
    return Object.freeze(diagnostics);
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    return invalidResearchDecisionGradeGate(
      "Research adapter canonical excerpt repair diagnostics could not be inspected",
      error,
    );
  }
}

function researchWebEvidenceFailureReasonCounts(
  evidence: Record<string, unknown>,
): Readonly<Record<string, number>> {
  const rawReceipts = evidence.receipts;
  if (rawReceipts === undefined) return Object.freeze({});
  try {
    if (!Array.isArray(rawReceipts)
      || Object.getPrototypeOf(rawReceipts) !== Array.prototype
      || rawReceipts.length > MAX_RESEARCH_EVIDENCE_RECEIPTS) {
      return invalidResearchDecisionGradeGate(
        "Research adapter Web evidence failure diagnostics are invalid",
      );
    }
    const arrayDescriptors = Object.getOwnPropertyDescriptors(rawReceipts);
    const counts = new Map<string, number>();
    for (let index = 0; index < rawReceipts.length; index += 1) {
      const itemDescriptor = arrayDescriptors[String(index)];
      if (itemDescriptor === undefined || !itemDescriptor.enumerable
        || !("value" in itemDescriptor)
        || itemDescriptor.get !== undefined || itemDescriptor.set !== undefined) {
        return invalidResearchDecisionGradeGate(
          "Research adapter Web evidence failure diagnostics are invalid",
        );
      }
      const receipt = itemDescriptor.value;
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
        return invalidResearchDecisionGradeGate(
          "Research adapter Web evidence failure diagnostics are invalid",
        );
      }
      const prototype = Object.getPrototypeOf(receipt);
      const keys = Reflect.ownKeys(receipt);
      const descriptors = Object.getOwnPropertyDescriptors(receipt);
      if ((prototype !== Object.prototype && prototype !== null)
        || keys.length > MAX_RESEARCH_EVIDENCE_RECEIPT_FIELDS
        || keys.some((key) => typeof key !== "string")
        || keys.some((key) => {
          const descriptor = descriptors[String(key)];
          return descriptor === undefined || !descriptor.enumerable
            || !("value" in descriptor)
            || descriptor.get !== undefined || descriptor.set !== undefined;
        })) {
        return invalidResearchDecisionGradeGate(
          "Research adapter Web evidence failure diagnostics are invalid",
        );
      }
      const sourceKind = descriptors.sourceKind?.value;
      const verification = descriptors.verification?.value;
      if (sourceKind !== "context" && sourceKind !== "web" && sourceKind !== "user") {
        return invalidResearchDecisionGradeGate(
          "Research adapter Web evidence failure diagnostics are invalid",
        );
      }
      if (verification !== "verified" && verification !== "unverified") {
        return invalidResearchDecisionGradeGate(
          "Research adapter Web evidence failure diagnostics are invalid",
        );
      }
      if (sourceKind !== "web" || verification === "verified") continue;
      const reason = descriptors.reason?.value;
      if (typeof reason !== "string" || !RESEARCH_WEB_EVIDENCE_FAILURE_REASON_SET.has(reason)) {
        return invalidResearchDecisionGradeGate(
          "Research adapter Web evidence failure diagnostics are invalid",
        );
      }
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return Object.freeze(Object.fromEntries(
      RESEARCH_WEB_EVIDENCE_FAILURE_REASONS.flatMap((reason) => {
        const count = counts.get(reason);
        return count === undefined ? [] : [[reason, count] as const];
      }),
    ));
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    return invalidResearchDecisionGradeGate(
      "Research adapter Web evidence failure diagnostics could not be inspected",
      error,
    );
  }
}

function researchEvidenceCoverage(
  evidence: Record<string, unknown>,
  finalGateObserved: ResearchDecisionGradeObservation,
): Readonly<Record<string, unknown>> | null {
  const rawCoverage = evidence.researchEvidenceCoverage;
  if (rawCoverage === undefined) return null;
  const coverage = researchDecisionGradeRecord(
    rawCoverage,
    RESEARCH_EVIDENCE_COVERAGE_FIELDS,
    "Research adapter evidence coverage",
  );
  if (coverage.protocol !== "dezin.research-evidence-coverage.v1"
    || typeof coverage.repairMode !== "string"
    || !RESEARCH_EVIDENCE_COVERAGE_REPAIR_MODES.has(coverage.repairMode)) {
    return invalidResearchDecisionGradeGate(
      "Research adapter evidence coverage identity is invalid",
    );
  }
  const firstPassGate = coverage.firstPassGate === null
    ? null
    : researchDecisionGradeRecord(
        coverage.firstPassGate,
        RESEARCH_EVIDENCE_COVERAGE_FIRST_PASS_GATE_FIELDS,
        "Research adapter evidence coverage first-pass gate",
      );
  if ((coverage.repairMode === "none") !== (firstPassGate === null)) {
    return invalidResearchDecisionGradeGate(
      "Research adapter evidence coverage repair mode is inconsistent",
    );
  }
  let normalizedFirstPassGate: Readonly<Record<string, unknown>> | null = null;
  if (firstPassGate !== null) {
    const observed = researchDecisionGradeRecord(
      firstPassGate.observed,
      RESEARCH_DECISION_GRADE_OBSERVED_FIELDS,
      "Research adapter evidence coverage first-pass observation",
    );
    if (typeof observed.groundednessVerifierAvailable !== "boolean") {
      return invalidResearchDecisionGradeGate(
        "Research adapter evidence coverage first-pass observation is invalid",
      );
    }
    const normalizedObserved: ResearchDecisionGradeObservation = Object.freeze({
      verifiedWebSourceCount: researchDecisionGradeCount(
        observed.verifiedWebSourceCount,
        "Research adapter evidence coverage first-pass verified Web source count",
      ),
      evidenceFindingCount: researchDecisionGradeCount(
        observed.evidenceFindingCount,
        "Research adapter evidence coverage first-pass evidence finding count",
      ),
      evidenceDirectionCount: researchDecisionGradeCount(
        observed.evidenceDirectionCount,
        "Research adapter evidence coverage first-pass evidence direction count",
      ),
      groundednessVerifierAvailable: observed.groundednessVerifierAvailable,
    });
    const blockers = researchDecisionGradeBlockers(
      firstPassGate.blockers,
      "Research adapter evidence coverage first-pass blockers",
    );
    if (blockers.length === 0
      || !isDeepStrictEqual(blockers, expectedResearchDecisionGradeBlockers(normalizedObserved))) {
      return invalidResearchDecisionGradeGate(
        "Research adapter evidence coverage first-pass gate is inconsistent",
      );
    }
    normalizedFirstPassGate = Object.freeze({
      observed: normalizedObserved,
      blockers: Object.freeze(blockers),
    });
  }
  const finalPass = researchDecisionGradeRecord(
    coverage.finalPass,
    RESEARCH_EVIDENCE_COVERAGE_FINAL_PASS_FIELDS,
    "Research adapter evidence coverage final pass",
  );
  const normalizedFinalPass = Object.freeze(Object.fromEntries(
    RESEARCH_EVIDENCE_COVERAGE_FINAL_PASS_FIELDS.map((field) => [
      field,
      researchDecisionGradeCount(
        finalPass[field],
        `Research adapter evidence coverage final-pass ${field}`,
      ),
    ]),
  )) as Readonly<Record<(typeof RESEARCH_EVIDENCE_COVERAGE_FINAL_PASS_FIELDS)[number], number>>;
  if (normalizedFinalPass.verifiedWebReceiptCount
      + normalizedFinalPass.unverifiedWebReceiptCount !== normalizedFinalPass.webSourceCount
    || normalizedFinalPass.groundednessSelectedWebSupportReceiptCount
      > normalizedFinalPass.verifiedWebSupportReceiptCount
    || normalizedFinalPass.groundednessSelectedWebSourceCount
      > normalizedFinalPass.groundednessSelectedWebSupportReceiptCount
    || normalizedFinalPass.groundednessSelectedWebSourceCount
      > normalizedFinalPass.verifiedWebReceiptCount
    || normalizedFinalPass.groundednessSelectedWebCanonicalComponentCount
      > normalizedFinalPass.groundednessSelectedWebSourceCount
    || normalizedFinalPass.evidenceFindingCount !== finalGateObserved.evidenceFindingCount
    || normalizedFinalPass.qualifyingDecisionGradeDirectionCount
      !== finalGateObserved.evidenceDirectionCount
    || normalizedFinalPass.groundednessSelectedWebCanonicalComponentCount
      !== finalGateObserved.verifiedWebSourceCount
    || normalizedFinalPass.qualifyingDecisionGradeDirectionCount
      > normalizedFinalPass.evidenceDirectionCount
    || normalizedFinalPass.maximumDirectionEvidenceFindingCount
      > normalizedFinalPass.evidenceFindingCount
    || normalizedFinalPass.maximumDirectionVerifiedWebComponentCount
      > normalizedFinalPass.groundednessSelectedWebCanonicalComponentCount
    || (normalizedFinalPass.evidenceDirectionCount === 0
      && (normalizedFinalPass.maximumDirectionEvidenceFindingCount !== 0
        || normalizedFinalPass.maximumDirectionVerifiedWebComponentCount !== 0))
    || (normalizedFinalPass.qualifyingDecisionGradeDirectionCount > 0
      && (normalizedFinalPass.maximumDirectionEvidenceFindingCount < 2
        || normalizedFinalPass.maximumDirectionVerifiedWebComponentCount < 2))) {
    return invalidResearchDecisionGradeGate(
      "Research adapter evidence coverage final pass is inconsistent",
    );
  }
  return Object.freeze({
    protocol: "dezin.research-evidence-coverage.v1",
    repairMode: coverage.repairMode,
    firstPassGate: normalizedFirstPassGate,
    finalPass: normalizedFinalPass,
  });
}

function enforceResearchDecisionGradeGate(
  resourceKind: ResourceKind,
  metadata: Record<string, unknown>,
  evidence: Record<string, unknown>,
): void {
  if (resourceKind !== "research") return;
  const gate = metadata.decisionGradeGate;
  if (metadata.format !== "dezin-research-resource-bundle"
    || (metadata.version !== 3 && metadata.version !== 4)
    || (metadata.qualityState !== "grounded" && metadata.qualityState !== "needs-review")
    || gate === null || typeof gate !== "object" || Array.isArray(gate)
    || (Object.getPrototypeOf(gate) !== Object.prototype && Object.getPrototypeOf(gate) !== null)) {
    throw new ResourceTaskAdapterError(
      "RESOURCE_ADAPTER_OUTPUT_INVALID",
      "Research adapter output is missing its canonical decision-grade quality gate",
    );
  }
  const exact = researchDecisionGradeRecord(
    gate,
    ["protocol", "criteria", "observed", "accepted", "blockers"],
    "Research adapter decision-grade quality gate",
  );
  const criteria = researchDecisionGradeRecord(
    exact.criteria,
    RESEARCH_DECISION_GRADE_CRITERIA_FIELDS,
    "Research adapter decision-grade criteria",
  );
  const observed = researchDecisionGradeRecord(
    exact.observed,
    RESEARCH_DECISION_GRADE_OBSERVED_FIELDS,
    "Research adapter decision-grade observation",
  );
  const normalizedCriteria = {
    minimumVerifiedWebSourceCount: researchDecisionGradeCount(
      criteria.minimumVerifiedWebSourceCount,
      "Research adapter minimum verified Web source count",
    ),
    minimumEvidenceFindingCount: researchDecisionGradeCount(
      criteria.minimumEvidenceFindingCount,
      "Research adapter minimum evidence finding count",
    ),
    minimumEvidenceDirectionCount: researchDecisionGradeCount(
      criteria.minimumEvidenceDirectionCount,
      "Research adapter minimum evidence direction count",
    ),
    requiresGroundednessVerifier: criteria.requiresGroundednessVerifier,
  };
  const groundednessVerifierAvailable = observed.groundednessVerifierAvailable;
  if (exact.protocol !== "dezin.research-decision-grade-gate.v2"
    || typeof exact.accepted !== "boolean"
    || normalizedCriteria.minimumVerifiedWebSourceCount !== 2
    || normalizedCriteria.minimumEvidenceFindingCount !== 2
    || normalizedCriteria.minimumEvidenceDirectionCount !== 1
    || normalizedCriteria.requiresGroundednessVerifier !== true
    || typeof groundednessVerifierAvailable !== "boolean") {
    return invalidResearchDecisionGradeGate(
      "Research adapter decision-grade quality gate is invalid",
    );
  }
  const normalizedObserved: ResearchDecisionGradeObservation = {
    verifiedWebSourceCount: researchDecisionGradeCount(
      observed.verifiedWebSourceCount,
      "Research adapter observed verified Web source count",
    ),
    evidenceFindingCount: researchDecisionGradeCount(
      observed.evidenceFindingCount,
      "Research adapter observed evidence finding count",
    ),
    evidenceDirectionCount: researchDecisionGradeCount(
      observed.evidenceDirectionCount,
      "Research adapter observed evidence direction count",
    ),
    groundednessVerifierAvailable,
  };
  const blockers = researchDecisionGradeBlockers(exact.blockers);
  const expectedBlockers = expectedResearchDecisionGradeBlockers(normalizedObserved);
  const accepted = exact.accepted === true;
  if (!isDeepStrictEqual(blockers, expectedBlockers)
    || accepted !== (expectedBlockers.length === 0)
    || metadata.qualityState !== (accepted ? "grounded" : "needs-review")) {
    return invalidResearchDecisionGradeGate(
      "Research adapter decision-grade quality gate is inconsistent",
    );
  }
  const canonicalExcerptRepairDiagnostics =
    researchCanonicalExcerptRepairDiagnostics(evidence);
  const normalizedResearchEvidenceCoverage = researchEvidenceCoverage(
    evidence,
    normalizedObserved,
  );
  if (accepted && (canonicalExcerptRepairDiagnostics.length > 0
    || normalizedResearchEvidenceCoverage !== null)) {
    return invalidResearchDecisionGradeGate(
      "Accepted Research adapter output cannot expose rejection-only diagnostics",
    );
  }
  if (!accepted) {
    const webEvidenceFailureReasonCounts = researchWebEvidenceFailureReasonCounts(evidence);
    throw new GenerationTaskQualityGateError(
      `Research decision-grade gate rejected this candidate: ${blockers.length > 0
        ? blockers.join(", ")
        : "unspecified-decision-grade-blocker"}`,
      {
        protocol: "dezin.research-decision-grade-rejection.v1",
        criteria: normalizedCriteria,
        observed: normalizedObserved,
        blockers,
        ...(Object.keys(webEvidenceFailureReasonCounts).length === 0
          ? {}
          : { webEvidenceFailureReasonCounts }),
        ...(canonicalExcerptRepairDiagnostics.length === 0
          ? {}
          : { canonicalExcerptRepairDiagnostics }),
        ...(normalizedResearchEvidenceCoverage === null
          ? {}
          : { researchEvidenceCoverage: normalizedResearchEvidenceCoverage }),
      },
    );
  }
}

function buildPreparedCandidate(
  claim: GenerationTaskAttemptClaim,
  payload: ResourceGenerationTaskPayloadV2,
  receipt: ResourceTaskPayloadReceipt,
): ResourcePreparedCandidate {
  const payloadIdentity = {
    mimeType: receipt.mimeType,
    byteSize: receipt.byteSize,
    checksum: receipt.payloadChecksum,
  };
  return {
    kind: "resource-candidate",
    taskId: claim.task.id,
    workspaceId: claim.task.workspaceId,
    resourceId: payload.operation.resourceId,
    revision: {
      revisionId: receipt.revisionId,
      parentRevisionId: claim.attempt.baseRevisionId,
      manifestPath: receipt.manifestPath,
      summary: receipt.summary,
      metadata: { mimeType: receipt.mimeType, adapter: receipt.metadata, payload: payloadIdentity },
      checksum: receipt.manifestChecksum,
      provenance: {
        kind: "generation-task-resource",
        planId: claim.task.planId,
        taskId: claim.task.id,
        attempt: claim.attempt.attempt,
        inputHash: claim.attempt.inputHash,
        adapter: payload.adapter,
        adapterProvenance: receipt.provenance,
      },
    },
    evidence: {
      taskId: claim.task.id,
      attempt: claim.attempt.attempt,
      inputHash: claim.attempt.inputHash,
      adapter: payload.adapter,
      payload: payloadIdentity,
      adapterEvidence: receipt.evidence,
    },
  };
}

const RECEIPT_FIELDS = [
  "protocol",
  "taskId",
  "attempt",
  "inputHash",
  "workspaceId",
  "resourceId",
  "revisionId",
  "parentRevisionId",
  "adapter",
  "manifestPath",
  "manifestChecksum",
  "payloadChecksum",
  "byteSize",
  "mimeType",
  "summary",
  "metadata",
  "provenance",
  "evidence",
] as const;
const RECEIPT_CHECKSUM = /^[a-f0-9]{64}$/;

export function validateResourceTaskPayloadReceipt(
  value: unknown,
  scope: ResourceTaskPayloadScope,
  output?: ResourceGenerationAdapterOutput,
): ResourceTaskPayloadReceipt {
  const outputBudget = scope.maxOutputBytes;
  try {
    const receipt = receiptRecord(value, RECEIPT_FIELDS, "Resource payload receipt");
    const adapter = receiptRecord(receipt.adapter, ["id", "version", "kind"], "Resource payload receipt adapter");
    const normalizedAdapter: ResourceGenerationAdapterIdentity = {
      id: receiptText(adapter.id, "adapter id", 128),
      version: Number(adapter.version),
      kind: adapter.kind as ResourceKind,
    };
    if (receipt.protocol !== "dezin.resource-task-payload-receipt.v1"
      || receipt.taskId !== scope.taskId || receipt.attempt !== scope.attempt
      || receipt.inputHash !== scope.inputHash || receipt.workspaceId !== scope.workspaceId
      || receipt.resourceId !== scope.resourceId || receipt.revisionId !== scope.revisionId
      || receipt.parentRevisionId !== scope.parentRevisionId
      || !isDeepStrictEqual(normalizedAdapter, scope.adapter)
      || receipt.manifestPath !== resourceRevisionManifestRelativePath(scope.workspaceId, scope.revisionId)
      || typeof receipt.manifestChecksum !== "string" || !RECEIPT_CHECKSUM.test(receipt.manifestChecksum)
      || typeof receipt.payloadChecksum !== "string" || !RECEIPT_CHECKSUM.test(receipt.payloadChecksum)
      || !Number.isSafeInteger(receipt.byteSize) || Number(receipt.byteSize) < 0
      || Number(receipt.byteSize) > outputBudget) {
      return receiptInvalid("Resource payload receipt does not match its exact Attempt scope");
    }
    const mimeType = receiptText(receipt.mimeType, "MIME type", 127);
    if (mimeType !== mimeType.toLowerCase() || !MIME.test(mimeType)) {
      return receiptInvalid("Resource payload receipt MIME type is invalid");
    }
    const summary = receiptText(receipt.summary, "summary", 32_000);
    const metadata = portableAdapterRecord(receipt.metadata, "receipt metadata", outputBudget);
    const provenance = portableAdapterRecord(receipt.provenance, "receipt provenance", outputBudget);
    const evidence = portableAdapterRecord(
      receipt.evidence,
      "receipt evidence",
      Math.min(outputBudget, MAX_ADAPTER_EVIDENCE_BYTES),
    );
    if (output !== undefined && (Number(receipt.byteSize) !== output.bytes.byteLength
      || mimeType !== output.mimeType || summary !== output.summary
      || !isDeepStrictEqual(metadata, output.metadata)
      || !isDeepStrictEqual(provenance, output.provenance)
      || !isDeepStrictEqual(evidence, output.evidence))) {
      return receiptInvalid("Resource payload receipt does not match the staged adapter output");
    }
    const jsonBytes = Buffer.byteLength(JSON.stringify({
      adapter: normalizedAdapter,
      mimeType,
      summary,
      metadata,
      provenance,
      evidence,
    }), "utf8");
    if (jsonBytes > outputBudget - Number(receipt.byteSize)) {
      return receiptInvalid("Resource payload receipt exceeds its Task output budget");
    }
    return Object.freeze({
      protocol: "dezin.resource-task-payload-receipt.v1",
      taskId: scope.taskId,
      attempt: scope.attempt,
      inputHash: scope.inputHash,
      workspaceId: scope.workspaceId,
      resourceId: scope.resourceId,
      revisionId: scope.revisionId,
      parentRevisionId: scope.parentRevisionId,
      adapter: Object.freeze({ ...normalizedAdapter }),
      manifestPath: receipt.manifestPath as string,
      manifestChecksum: receipt.manifestChecksum as string,
      payloadChecksum: receipt.payloadChecksum as string,
      byteSize: Number(receipt.byteSize),
      mimeType,
      summary,
      metadata,
      provenance,
      evidence,
    });
  } catch (error) {
    if (error instanceof ResourceTaskPayloadError) throw error;
    throw new ResourceTaskPayloadError(
      "RESOURCE_PAYLOAD_RECEIPT_INVALID",
      "Resource payload receipt could not be validated",
      error,
    );
  }
}

function receiptInvalid(message: string, cause?: unknown): never {
  throw new ResourceTaskPayloadError("RESOURCE_PAYLOAD_RECEIPT_INVALID", message, cause);
}

function receiptRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return receiptInvalid(`${label} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return receiptInvalid(`${label} must be a plain object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length !== fields.length
      || fields.some((field) => !keys.includes(field))) {
      return receiptInvalid(`${label} fields are not exact`);
    }
    const result: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return receiptInvalid(`${label} field ${field} must be an own data property`);
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof ResourceTaskPayloadError) throw error;
    return receiptInvalid(`${label} could not be inspected`, error);
  }
}

function receiptText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || !isWellFormedUtf16(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    return receiptInvalid(`Resource payload receipt ${label} is invalid`);
  }
  return value;
}

function cleanupEligibleReceipt(value: unknown, scope: ResourceTaskPayloadScope): value is ResourceTaskPayloadReceipt {
  try {
    const receipt = receiptRecord(value, RECEIPT_FIELDS, "Resource payload cleanup receipt");
    const adapter = receiptRecord(receipt.adapter, ["id", "version", "kind"], "Resource payload cleanup adapter");
    return receipt.protocol === "dezin.resource-task-payload-receipt.v1"
      && receipt.taskId === scope.taskId && receipt.attempt === scope.attempt
      && receipt.inputHash === scope.inputHash && receipt.workspaceId === scope.workspaceId
      && receipt.resourceId === scope.resourceId && receipt.revisionId === scope.revisionId
      && receipt.manifestPath === resourceRevisionManifestRelativePath(scope.workspaceId, scope.revisionId)
      && typeof receipt.manifestChecksum === "string" && RECEIPT_CHECKSUM.test(receipt.manifestChecksum)
      && typeof receipt.payloadChecksum === "string" && RECEIPT_CHECKSUM.test(receipt.payloadChecksum)
      && adapter.id === scope.adapter.id && adapter.version === scope.adapter.version
      && adapter.kind === scope.adapter.kind;
  } catch {
    return false;
  }
}

function validateAttemptClaim(claim: GenerationTaskAttemptClaim): void {
  const task = claim.task;
  const attempt = claim.attempt;
  if (task.kind !== "resource" || task.target.type !== "resource"
    || attempt.taskId !== task.id || attempt.planId !== task.planId
    || attempt.workspaceId !== task.workspaceId || attempt.attempt !== task.currentAttempt
    || attempt.status !== "running" || attempt.executionMode !== "full"
    || attempt.contextPackId === null || CONTEXT_PACK_ID.exec(attempt.contextPackId) === null
    || attempt.lease === null
    || !isDeepStrictEqual(attempt.target, task.target)
    || !isDeepStrictEqual(attempt.payload, task.payload)
    || !isDeepStrictEqual(claim.lease, attempt.lease)
    || claim.lease.taskId !== task.id || claim.lease.workspaceId !== task.workspaceId
    || claim.lease.attempt !== attempt.attempt) {
    throw new ResourceTaskContractError(
      "RESOURCE_TASK_ATTEMPT_INVALID",
      "Resource Task claim does not match its exact immutable running Attempt",
    );
  }
}

const RESOURCE_KINDS = new Set<ResourceKind>([
  "research",
  "moodboard",
  "sharingan-capture",
  "file",
  "asset",
  "effect",
  "external-reference",
]);
const CAPABILITY_KINDS = new Set<WorkspaceGenerationCapability["kind"]>([
  "text",
  "image",
  "video",
  "browser",
  "visual-qa",
]);
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const ADAPTER_OUTPUT_FIELDS = [
  "bytes",
  "mimeType",
  "summary",
  "metadata",
  "provenance",
  "evidence",
] as const;
const MAX_ADAPTER_JSON_DEPTH = 64;
const MAX_ADAPTER_JSON_NODES = 100_000;
const MAX_ADAPTER_EVIDENCE_BYTES = 1024 * 1024;
const UNSAFE_PORTABLE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DECLARED_FAILURE_CLASSES = new Set([
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

function adapterKey(identity: ResourceGenerationAdapterIdentity): string {
  return `${identity.id}\0${identity.version}\0${identity.kind}`;
}

function registryIdentity(adapter: unknown): ResourceGenerationAdapterIdentity {
  try {
    if (adapter === null || (typeof adapter !== "object" && typeof adapter !== "function")) {
      throw new TypeError("adapter must be an object");
    }
    const identity = registryDataProperty(adapter, "identity");
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)
      || (Object.getPrototypeOf(identity) !== Object.prototype && Object.getPrototypeOf(identity) !== null)) {
      throw new TypeError("adapter identity must be a plain object");
    }
    const keys = Reflect.ownKeys(identity);
    if (keys.length !== 3 || keys.some((key) => typeof key !== "string")
      || !keys.includes("id") || !keys.includes("version") || !keys.includes("kind")) {
      throw new TypeError("adapter identity fields are not exact");
    }
    const id = registryDataProperty(identity, "id");
    const version = registryDataProperty(identity, "version");
    const kind = registryDataProperty(identity, "kind");
    if (typeof id !== "string" || id.length === 0 || id !== id.trim() || id.length > 128
      || !/^[a-z0-9][a-z0-9._-]*$/.test(id)
      || !Number.isSafeInteger(version) || Number(version) < 1 || Number(version) > 1_000_000
      || typeof kind !== "string" || !RESOURCE_KINDS.has(kind as ResourceKind)) {
      throw new TypeError("adapter identity is invalid");
    }
    return { id, version: Number(version), kind: kind as ResourceKind };
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    throw new ResourceTaskAdapterError(
      "RESOURCE_ADAPTER_REGISTRATION_INVALID",
      "Resource generation adapter registration has an invalid identity",
      error,
    );
  }
}

function registryGenerate(adapter: ResourceGenerationAdapter): ResourceGenerationAdapter["generate"] {
  try {
    const generate = registryDataProperty(adapter, "generate");
    if (typeof generate !== "function") throw new TypeError("adapter generate must be a function");
    return generate as ResourceGenerationAdapter["generate"];
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    throw new ResourceTaskAdapterError(
      "RESOURCE_ADAPTER_REGISTRATION_INVALID",
      "Resource generation adapter registration must provide a data-function generate method",
      error,
    );
  }
}

function registryDataProperty(value: object, key: string): unknown {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new TypeError(`Resource generation adapter ${key} cannot be an accessor`);
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new TypeError(`Resource generation adapter ${key} is missing`);
}

function printAdapter(identity: ResourceGenerationAdapterIdentity): string {
  return `${identity.id}@${identity.version}/${identity.kind}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Resource generation aborted", "AbortError");
}

function hasDeclaredFailureClass(error: unknown): boolean {
  try {
    const failureClass = error !== null && (typeof error === "object" || typeof error === "function")
      ? Reflect.get(error, "failureClass")
      : null;
    return typeof failureClass === "string" && DECLARED_FAILURE_CLASSES.has(failureClass);
  } catch {
    return false;
  }
}

function adapterOutputInvalid(message: string, cause?: unknown): never {
  throw new ResourceTaskAdapterError("RESOURCE_ADAPTER_OUTPUT_INVALID", message, cause);
}

function normalizeAdapterOutput(
  value: unknown,
  outputBudget: number,
): ResourceGenerationAdapterOutput {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return adapterOutputInvalid("Resource generation adapter output must be an object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return adapterOutputInvalid("Resource generation adapter output must be a plain object");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")
      || keys.length !== ADAPTER_OUTPUT_FIELDS.length
      || ADAPTER_OUTPUT_FIELDS.some((field) => !keys.includes(field))) {
      return adapterOutputInvalid("Resource generation adapter output fields are not exact");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const field of ADAPTER_OUTPUT_FIELDS) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return adapterOutputInvalid(`Resource generation adapter output ${field} must be a data field`);
      }
    }
    const bytesValue = descriptors.bytes!.value;
    if (!(bytesValue instanceof Uint8Array)) {
      return adapterOutputInvalid("Resource generation adapter bytes must be a Uint8Array");
    }
    const bytes = new Uint8Array(bytesValue);
    const mimeTypeValue = descriptors.mimeType!.value;
    if (typeof mimeTypeValue !== "string" || mimeTypeValue.length > 127
      || mimeTypeValue !== mimeTypeValue.trim() || mimeTypeValue !== mimeTypeValue.toLowerCase()
      || !MIME.test(mimeTypeValue)) {
      return adapterOutputInvalid("Resource generation adapter MIME type is invalid");
    }
    const summary = adapterText(descriptors.summary!.value, "summary", 32_000);
    const metadata = portableAdapterRecord(descriptors.metadata!.value, "metadata", outputBudget);
    const provenance = portableAdapterRecord(descriptors.provenance!.value, "provenance", outputBudget);
    const evidence = portableAdapterRecord(
      descriptors.evidence!.value,
      "evidence",
      Math.min(outputBudget, MAX_ADAPTER_EVIDENCE_BYTES),
    );
    if (mimeTypeValue.startsWith("text/") || mimeTypeValue === "application/json"
      || mimeTypeValue === "image/svg+xml") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        return adapterOutputInvalid("Text Resource generation output must be valid UTF-8", error);
      }
      if (!isWellFormedUtf16(text)) {
        return adapterOutputInvalid("Text Resource generation output must contain valid Unicode");
      }
      if (mimeTypeValue === "application/json") {
        try {
          const parsed = JSON.parse(text) as unknown;
          portableAdapterValue(parsed, "JSON Resource payload", outputBudget);
        } catch (error) {
          if (error instanceof ResourceTaskAdapterError) throw error;
          return adapterOutputInvalid("JSON Resource generation output is invalid", error);
        }
      }
    }
    const jsonBytes = Buffer.byteLength(JSON.stringify({
      mimeType: mimeTypeValue,
      summary,
      metadata,
      provenance,
      evidence,
    }), "utf8");
    if (!Number.isSafeInteger(outputBudget) || outputBudget < 1
      || bytes.byteLength > outputBudget || jsonBytes > outputBudget - bytes.byteLength) {
      return adapterOutputInvalid("Resource generation adapter output exceeds its Task output budget");
    }
    return Object.freeze({
      bytes,
      mimeType: mimeTypeValue,
      summary,
      metadata,
      provenance,
      evidence,
    });
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    return adapterOutputInvalid("Resource generation adapter output could not be inspected", error);
  }
}

function adapterText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || !isWellFormedUtf16(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    return adapterOutputInvalid(`Resource generation adapter ${label} is invalid`);
  }
  return value;
}

function portableAdapterRecord(
  value: unknown,
  label: string,
  maxBytes: number,
): Record<string, unknown> {
  const cloned = portableAdapterValue(value, label, maxBytes);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    return adapterOutputInvalid(`Resource generation adapter ${label} must be an object`);
  }
  return cloned as Record<string, unknown>;
}

function portableAdapterValue(value: unknown, label: string, maxBytes: number): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_ADAPTER_JSON_NODES || depth > MAX_ADAPTER_JSON_DEPTH) {
      return adapterOutputInvalid(`Resource generation adapter ${label} is too complex`);
    }
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if (!isWellFormedUtf16(candidate)) {
        return adapterOutputInvalid(`Resource generation adapter ${label} contains invalid Unicode`);
      }
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        return adapterOutputInvalid(`Resource generation adapter ${label} contains an invalid number`);
      }
      return candidate;
    }
    if (typeof candidate !== "object") {
      return adapterOutputInvalid(`Resource generation adapter ${label} is not portable JSON`);
    }
    if (nodeUtilTypes.isProxy(candidate)) {
      return adapterOutputInvalid(`Resource generation adapter ${label} cannot contain a Proxy`);
    }
    if (seen.has(candidate)) {
      return adapterOutputInvalid(`Resource generation adapter ${label} contains a cycle or alias`);
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const keys = Reflect.ownKeys(candidate);
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0) {
        return adapterOutputInvalid(`Resource generation adapter ${label} array length is invalid`);
      }
      const length = Number(lengthDescriptor.value);
      const expected = new Set<string>([
        "length",
        ...Array.from({ length }, (_, index) => String(index)),
      ]);
      if (keys.some((key) => typeof key !== "string" || !expected.has(key)) || keys.length !== expected.size) {
        return adapterOutputInvalid(`Resource generation adapter ${label} contains a sparse or extended array`);
      }
      return Array.from({ length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)
          || descriptor.get !== undefined || descriptor.set !== undefined) {
          return adapterOutputInvalid(
            `Resource generation adapter ${label}[${index}] must be a data field`,
          );
        }
        return visit(descriptor.value, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      return adapterOutputInvalid(`Resource generation adapter ${label} contains a non-plain object`);
    }
    const keys = Reflect.ownKeys(candidate);
    if (keys.some((key) => typeof key !== "string" || !isWellFormedUtf16(key)
      || UNSAFE_PORTABLE_JSON_KEYS.has(key))) {
      return adapterOutputInvalid(`Resource generation adapter ${label} contains an invalid key`);
    }
    const result: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const key of (keys as string[]).sort()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return adapterOutputInvalid(`Resource generation adapter ${label}.${key} must be a data field`);
      }
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  try {
    const cloned = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > maxBytes) {
      return adapterOutputInvalid(`Resource generation adapter ${label} exceeds its byte limit`);
    }
    return cloned;
  } catch (error) {
    if (error instanceof ResourceTaskAdapterError) throw error;
    return adapterOutputInvalid(`Resource generation adapter ${label} could not be inspected`, error);
  }
}

export function parseResourceGenerationTaskPayloadV2(task: GenerationTask): ResourceGenerationTaskPayloadV2 {
  if (task.kind !== "resource" || task.target.type !== "resource"
    || task.target.workspaceId !== task.workspaceId) {
    throw new ResourceTaskContractError(
      "RESOURCE_TASK_PAYLOAD_INVALID",
      "ResourceTaskExecutor requires a Resource Task with an exact Workspace target",
    );
  }
  let version: unknown;
  let hasAgent = false;
  let hasReviewerAuthorityAgent = false;
  let hasReviewer = false;
  let hasMoodboardImageAuthority = false;
  try {
    if (task.payload === null || typeof task.payload !== "object") {
      return invalidPayload("Resource Task payload must be an object");
    }
    const descriptor = Object.getOwnPropertyDescriptor(task.payload, "version");
    if (descriptor === undefined || !("value" in descriptor)
      || descriptor.get !== undefined || descriptor.set !== undefined) {
      return invalidPayload("Resource Task payload version must be an own data field");
    }
    version = descriptor.value;
    hasAgent = Object.getOwnPropertyDescriptor(task.payload, "agent") !== undefined;
    hasReviewerAuthorityAgent = Object.getOwnPropertyDescriptor(
      task.payload,
      "reviewerAuthorityAgent",
    ) !== undefined;
    hasReviewer = Object.getOwnPropertyDescriptor(task.payload, "reviewer") !== undefined;
    hasMoodboardImageAuthority = Object.getOwnPropertyDescriptor(
      task.payload,
      "moodboardImageAuthority",
    ) !== undefined;
  } catch (error) {
    return invalidPayload("Resource Task payload version could not be inspected", error);
  }
  if (version !== 2) {
    throw new ResourceTaskContractError(
      "RESOURCE_TASK_PAYLOAD_VERSION_UNSUPPORTED",
      "Resource Task payload version is unsupported; version 2 is required",
    );
  }
  const payload = exactRecord(
    task.payload,
    [
      "version",
      "operation",
      "brief",
      "capabilityDescriptors",
      "adapter",
      ...(hasAgent ? ["agent"] : []),
      ...(hasReviewerAuthorityAgent ? ["reviewerAuthorityAgent"] : []),
      ...(hasReviewer ? ["reviewer"] : []),
      ...(hasMoodboardImageAuthority ? ["moodboardImageAuthority"] : []),
    ],
    "Resource Task payload",
  );
  let agent: ResourceGenerationTaskPayloadV2["agent"];
  if (hasAgent) {
    try {
      agent = validateFrozenGenerationTaskAgent(payload.agent, "Resource Task Agent", "generator");
    } catch (error) {
      if (error instanceof GenerationTaskPayloadContractError) {
        invalidPayload(error.message, error);
      }
      throw error;
    }
  }
  let reviewerAuthorityAgent: ResourceGenerationTaskPayloadV2["reviewerAuthorityAgent"];
  if (hasReviewerAuthorityAgent) {
    try {
      reviewerAuthorityAgent = validateFrozenGenerationTaskAgent(
        payload.reviewerAuthorityAgent,
        "Resource Task reviewer-authority Agent",
        "generator",
      );
    } catch (error) {
      if (error instanceof GenerationTaskPayloadContractError) {
        invalidPayload(error.message, error);
      }
      throw error;
    }
  }
  let reviewer: ResourceGenerationTaskPayloadV2["reviewer"];
  if (hasReviewer) {
    try {
      reviewer = validateFrozenGenerationTaskAgent(
        payload.reviewer,
        "Resource Task reviewer",
        "reviewer",
        reviewerAuthorityAgent ?? agent,
      );
    } catch (error) {
      if (error instanceof GenerationTaskPayloadContractError) {
        invalidPayload(error.message, error);
      }
      throw error;
    }
  }
  const adapter = exactRecord(payload.adapter, ["id", "version", "kind"], "Resource Task adapter");
  const id = canonicalText(adapter.id, "Resource Task adapter id", 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)
    || adapter.version !== 1
    || typeof adapter.kind !== "string" || !RESOURCE_KINDS.has(adapter.kind as ResourceKind)) {
    invalidPayload("Resource Task adapter identity is invalid");
  }
  const rawOperation = payload.operation;
  const operationHasDispatchContext = rawOperation !== null && typeof rawOperation === "object"
    && Object.prototype.hasOwnProperty.call(rawOperation, "dispatchContextPackId");
  const operationHasInstructions = rawOperation !== null && typeof rawOperation === "object"
    && Object.prototype.hasOwnProperty.call(rawOperation, "instructions");
  const operation = exactRecord(rawOperation, [
    "operation",
    "nodeId",
    "resourceId",
    "kind",
    "title",
    ...(operationHasInstructions ? ["instructions"] : []),
    "revisionPolicy",
    ...(operationHasDispatchContext ? ["dispatchContextPackId"] : []),
  ], "Resource Task operation");
  if (operation.operation !== "create" && operation.operation !== "revise") {
    invalidPayload("Resource Task operation must be create or revise");
  }
  const nodeId = canonicalText(operation.nodeId, "Resource Task node id", 512);
  const resourceId = canonicalText(operation.resourceId, "Resource Task Resource id", 512);
  const title = canonicalText(operation.title, "Resource Task title", 4_096);
  const resourceInstructions = operationHasInstructions
    ? canonicalText(operation.instructions, "Resource Task instructions", 2_000)
    : undefined;
  const dispatchContextPackId = operation.dispatchContextPackId === undefined
    ? undefined
    : canonicalText(operation.dispatchContextPackId, "Resource Task dispatch Context Pack id", 77);
  if (dispatchContextPackId !== undefined && !/^context-pack-[0-9a-f]{64}$/.test(dispatchContextPackId)) {
    invalidPayload("Resource Task dispatch Context Pack id is invalid");
  }
  if (typeof operation.kind !== "string" || !RESOURCE_KINDS.has(operation.kind as ResourceKind)) {
    invalidPayload("Resource Task Resource kind is unsupported");
  }
  if (reviewerAuthorityAgent !== undefined && operation.kind !== "research") {
    invalidPayload("Resource Task reviewer-authority Agent is valid only for generated Research");
  }
  let moodboardImageAuthority: ResourceGenerationTaskPayloadV2["moodboardImageAuthority"];
  if (operation.kind === "moodboard") {
    if (!hasMoodboardImageAuthority) {
      invalidPayload("generated Moodboard Resource Task requires exact image execution authority");
    }
    try {
      moodboardImageAuthority = validateMoodboardImageExecutionAuthority(
        payload.moodboardImageAuthority,
        "Resource Task Moodboard image execution authority",
      );
    } catch (error) {
      if (error instanceof GenerationTaskPayloadContractError) {
        invalidPayload(error.message, error);
      }
      throw error;
    }
  } else if (hasMoodboardImageAuthority) {
    invalidPayload(
      "Moodboard image execution authority is valid only for generated Moodboard Resource Tasks",
    );
  }
  const revisionPolicy = exactRecord(
    operation.revisionPolicy,
    ["kind"],
    "Resource Task revision policy",
  );
  if (revisionPolicy.kind !== "generate") invalidPayload("Resource Task revision policy must be generate");
  if (resourceId !== task.target.id || adapter.kind !== operation.kind
    || id !== `dezin.resource-adapter.${operation.kind}`) {
    invalidPayload("Resource Task adapter kind or operation target does not match its Task");
  }
  const brief = exactRecord(
    payload.brief,
    ["proposalRationale", "assumptions", "targetInstructions"],
    "Resource Task brief",
  );
  const proposalRationale = canonicalText(
    brief.proposalRationale,
    "Resource Task Proposal rationale",
    32_000,
  );
  const assumptions = denseArray(brief.assumptions, "Resource Task assumptions")
    .map((assumption, index) => canonicalText(assumption, `Resource Task assumption[${index}]`, 32_000));
  const rawTargetInstructions = brief.targetInstructions;
  const targetHasInstructions = rawTargetInstructions !== null
    && typeof rawTargetInstructions === "object"
    && Object.prototype.hasOwnProperty.call(rawTargetInstructions, "instructions");
  const targetInstructions = exactRecord(
    rawTargetInstructions,
    ["operation", "kind", "title", ...(targetHasInstructions ? ["instructions"] : [])],
    "Resource Task target instructions",
  );
  const targetResourceInstructions = targetHasInstructions
    ? canonicalText(
        targetInstructions.instructions,
        "Resource Task target instructions brief",
        2_000,
      )
    : undefined;
  if (targetInstructions.operation !== operation.operation
    || targetInstructions.kind !== operation.kind
    || canonicalText(targetInstructions.title, "Resource Task target instructions title", 4_096) !== title
    || targetResourceInstructions !== resourceInstructions) {
    invalidPayload("Resource Task target instructions do not match its operation");
  }
  const capabilityDescriptors = denseArray(
    payload.capabilityDescriptors,
    "Resource Task capability descriptors",
  ).map((descriptor, index) => {
    const parsed = exactRecord(
      descriptor,
      ["id", "kind", "required"],
      `Resource Task capability descriptor[${index}]`,
    );
    const capabilityId = canonicalText(
      parsed.id,
      `Resource Task capability descriptor[${index}] id`,
      512,
    );
    if (typeof parsed.kind !== "string"
      || !CAPABILITY_KINDS.has(parsed.kind as WorkspaceGenerationCapability["kind"])
      || parsed.required !== true) {
      invalidPayload(`Resource Task capability descriptor[${index}] is invalid`);
    }
    return Object.freeze({
      id: capabilityId,
      kind: parsed.kind as WorkspaceGenerationCapability["kind"],
      required: true,
    });
  });
  const descriptorIds = capabilityDescriptors.map((descriptor) => descriptor.id);
  const sortedIds = [...descriptorIds].sort();
  if (new Set(descriptorIds).size !== descriptorIds.length
    || descriptorIds.some((descriptorId, index) => descriptorId !== sortedIds[index])
    || descriptorIds.length !== task.capabilities.length
    || descriptorIds.some((descriptorId, index) => descriptorId !== task.capabilities[index])) {
    invalidPayload("Resource Task capability descriptors do not match its sorted unique capabilities");
  }
  return Object.freeze({
    version: 2,
    ...(agent === undefined ? {} : { agent }),
    ...(reviewerAuthorityAgent === undefined ? {} : { reviewerAuthorityAgent }),
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(moodboardImageAuthority === undefined ? {} : { moodboardImageAuthority }),
    adapter: Object.freeze({
      id,
      version: Number(adapter.version),
      kind: adapter.kind as ResourceKind,
    }),
    operation: Object.freeze({
      operation: operation.operation,
      nodeId,
      resourceId,
      kind: operation.kind as ResourceKind,
      title,
      ...(resourceInstructions === undefined ? {} : { instructions: resourceInstructions }),
      revisionPolicy: Object.freeze({ kind: "generate" as const }),
      ...(dispatchContextPackId === undefined ? {} : { dispatchContextPackId }),
    }),
    brief: Object.freeze({
      proposalRationale,
      assumptions: Object.freeze(assumptions),
      targetInstructions: Object.freeze({
        operation: operation.operation,
        kind: operation.kind as ResourceKind,
        title,
        ...(resourceInstructions === undefined ? {} : { instructions: resourceInstructions }),
      }),
    }),
    capabilityDescriptors: Object.freeze(capabilityDescriptors),
  }) as ResourceGenerationTaskPayloadV2;
}

function invalidPayload(message: string, cause?: unknown): never {
  throw new ResourceTaskContractError("RESOURCE_TASK_PAYLOAD_INVALID", message, cause);
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidPayload(`${label} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidPayload(`${label} must be a plain object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")
      || keys.length !== fields.length
      || fields.some((field) => !keys.includes(field))) {
      return invalidPayload(`${label} fields are not exact`);
    }
    const result: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalidPayload(`${label} field ${field} must be an own data property`);
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof ResourceTaskContractError) throw error;
    return invalidPayload(`${label} could not be inspected`, error);
  }
}

function denseArray(value: unknown, label: string): unknown[] {
  try {
    if (!Array.isArray(value)) return invalidPayload(`${label} must be an array`);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0) {
      return invalidPayload(`${label} length is invalid`);
    }
    const length = Number(lengthDescriptor.value);
    const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    if (keys.some((key) => typeof key !== "string" || !expected.has(key)) || keys.length !== expected.size) {
      return invalidPayload(`${label} must be dense and contain no extra fields`);
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalidPayload(`${label}[${index}] must be an own data property`);
      }
      return descriptor.value;
    });
  } catch (error) {
    if (error instanceof ResourceTaskContractError) throw error;
    return invalidPayload(`${label} could not be inspected`, error);
  }
}

function canonicalText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || !isWellFormedUtf16(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    return invalidPayload(`${label} is invalid`);
  }
  return value;
}

function isWellFormedUtf16(value: string): boolean {
  const native = value as string & { isWellFormed?: () => boolean };
  if (typeof native.isWellFormed === "function") return native.isWellFormed();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function attemptRevisionId(claim: GenerationTaskAttemptClaim): string {
  const digest = createHash("sha256")
    .update("dezin.resource-generation-revision.v1\0")
    .update(claim.task.workspaceId)
    .update("\0")
    .update(claim.task.id)
    .update("\0")
    .update(String(claim.attempt.attempt))
    .update("\0")
    .update(claim.attempt.inputHash)
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
