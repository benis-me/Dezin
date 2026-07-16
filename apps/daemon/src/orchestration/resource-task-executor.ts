import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  GenerationTask,
  GenerationTaskAttemptClaim,
  GenerationTaskAttemptLease,
  ResourceGenerationTaskPayloadV2,
  ResourceKind,
  WorkspaceGenerationCapability,
} from "../../../../packages/core/src/index.ts";
import { resourceRevisionManifestRelativePath } from "../resource-revision-payload.ts";
import type {
  ResourceGenerationTaskLeafExecutor,
  ResourcePreparedCandidate,
} from "./generation-task-executor.ts";

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
  readonly signal: AbortSignal;
}

export interface ResourceGenerationAdapter {
  readonly identity: ResourceGenerationAdapterIdentity;
  generate(input: ResourceGenerationAdapterInput): Promise<ResourceGenerationAdapterOutput>;
}

export interface ResourceTaskPayloadScope {
  readonly taskId: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly adapter: ResourceGenerationAdapterIdentity;
  readonly maxOutputBytes: number;
  readonly lease?: GenerationTaskAttemptLease;
  readonly signal: AbortSignal;
}

export interface ResourceTaskPayloadStageInput {
  readonly taskId: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly adapter: ResourceGenerationAdapterIdentity;
  readonly maxOutputBytes: number;
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
  };
  readonly #receiptByCandidate = new WeakMap<ResourcePreparedCandidate, ResourceTaskPayloadReceipt>();

  constructor(options: {
    adapters: VersionedResourceGenerationAdapterRegistry;
    staging: ResourceTaskPayloadStagingPort;
  }) {
    this.options = Object.freeze({
      adapters: options.adapters,
      staging: options.staging,
    });
  }

  async execute(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<ResourcePreparedCandidate> {
    checkAbort(signal);
    validateAttemptClaim(claim);
    const payload = parseResourceGenerationTaskPayloadV2(claim.task);
    const revisionId = attemptRevisionId(claim);
    const scope: ResourceTaskPayloadScope = {
      taskId: claim.task.id,
      attempt: claim.attempt.attempt,
      inputHash: claim.attempt.inputHash,
      workspaceId: claim.task.workspaceId,
      resourceId: payload.operation.resourceId,
      revisionId,
      parentRevisionId: claim.attempt.baseRevisionId,
      adapter: payload.adapter,
      maxOutputBytes: claim.task.resourceLimits.maxOutputBytes,
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
        contextPackId: claim.attempt.contextPackId as string,
        operation: payload.operation.operation,
        nodeId: payload.operation.nodeId,
        title: payload.operation.title,
        resourceKind: payload.operation.kind,
        brief: payload.brief,
        capabilityDescriptors: payload.capabilityDescriptors,
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
    checkAbort(signal);
    let stagedReceipt: ResourceTaskPayloadReceipt;
    try {
      stagedReceipt = await this.options.staging.stage({
        ...scope,
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

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
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
      metadata: { adapter: receipt.metadata, payload: payloadIdentity },
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
    || attempt.contextPackId === null || attempt.lease === null
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
    ["version", "operation", "brief", "capabilityDescriptors", "adapter"],
    "Resource Task payload",
  );
  const adapter = exactRecord(payload.adapter, ["id", "version", "kind"], "Resource Task adapter");
  const id = canonicalText(adapter.id, "Resource Task adapter id", 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)
    || adapter.version !== 1
    || typeof adapter.kind !== "string" || !RESOURCE_KINDS.has(adapter.kind as ResourceKind)) {
    invalidPayload("Resource Task adapter identity is invalid");
  }
  const operation = exactRecord(payload.operation, [
    "operation",
    "nodeId",
    "resourceId",
    "kind",
    "title",
    "revisionPolicy",
  ], "Resource Task operation");
  if (operation.operation !== "create" && operation.operation !== "revise") {
    invalidPayload("Resource Task operation must be create or revise");
  }
  const nodeId = canonicalText(operation.nodeId, "Resource Task node id", 512);
  const resourceId = canonicalText(operation.resourceId, "Resource Task Resource id", 512);
  const title = canonicalText(operation.title, "Resource Task title", 4_096);
  if (typeof operation.kind !== "string" || !RESOURCE_KINDS.has(operation.kind as ResourceKind)) {
    invalidPayload("Resource Task Resource kind is unsupported");
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
  const instructions = exactRecord(
    brief.targetInstructions,
    ["operation", "kind", "title"],
    "Resource Task target instructions",
  );
  if (instructions.operation !== operation.operation || instructions.kind !== operation.kind
    || canonicalText(instructions.title, "Resource Task target instructions title", 4_096) !== title) {
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
      revisionPolicy: Object.freeze({ kind: "generate" as const }),
    }),
    brief: Object.freeze({
      proposalRationale,
      assumptions: Object.freeze(assumptions),
      targetInstructions: Object.freeze({
        operation: operation.operation,
        kind: operation.kind as ResourceKind,
        title,
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
