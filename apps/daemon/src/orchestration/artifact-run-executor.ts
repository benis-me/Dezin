import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";
import { resolve } from "node:path";

import type {
  AgentRunner,
  TurnRole,
} from "../../../../packages/agent/src/index.ts";
import type {
  GenerationTaskAttemptClaim,
  GenerationTaskFailureClass,
} from "../../../../packages/core/src/index.ts";
import type {
  ArtifactGenerationTaskLeafExecutor,
  ArtifactPreparedCandidate,
} from "./generation-task-executor.ts";
import { stableStringify } from "../context/context-types.ts";
import { validateGenerationTaskPayload } from "./generation-task-contracts.ts";
import { artifactCandidateAttemptRef } from "./artifact-candidate-transaction.ts";
import type { SharinganCaptureBundleFence } from "./sharingan-capture-reference.ts";
import {
  executeStandardArtifact,
  type StandardArtifactCandidateTransactionPort,
  type StandardArtifactExecutionEvent,
  type StandardArtifactExecutionVersion,
  type StandardArtifactQualityEvaluatorPort,
} from "./standard-artifact-execution.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SAFE_OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTEXT_PACK_PREFIX = "context-pack-";
const MAX_PROMPT_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 10_000;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_ENTRY_BYTES = 1024 * 1024;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_KEY_BYTES = 1024;
const MAX_ENV_VALUE_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;
const MAX_EVALUATION_VERSIONS = 256;
const MAX_EVALUATION_FRAMES = 64;
const MAX_EVALUATION_FINDINGS_BYTES = 1024 * 1024;
const MAX_ARTIFACT_RUN_EVIDENCE_BYTES = 1024 * 1024;

export interface ArtifactRunCandidateTransactionPort
  extends StandardArtifactCandidateTransactionPort {
  /** Durable ref that retains every sequential candidate for this Attempt. */
  readonly attemptRef: string;
  /** Removes only the isolated worktree. The Attempt ref must survive. */
  dispose(): Promise<void>;
}

export interface ArtifactRunPreparation {
  readonly projectId: string;
  readonly runner: AgentRunner;
  readonly transaction: ArtifactRunCandidateTransactionPort;
  readonly evaluator: StandardArtifactQualityEvaluatorPort;
  readonly contextPackId: string;
  readonly contextPackHash: string;
  readonly sourceCommitHash: string;
  readonly sourceTreeHash: string;
  readonly systemPrompt: string;
  readonly initialMessage: string;
  readonly history?: readonly Readonly<{ role: TurnRole; content: string }>[];
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Present only when an exact pinned Sharingan Capture Revision was materialized. */
  readonly sharinganCapture?: SharinganCaptureBundleFence;
  readonly buildRepairPrompt: (input: {
    round: number;
    maxRepairRounds: number;
    prior: StandardArtifactExecutionVersion;
  }) => string | null;
}

export interface ArtifactRunPreparationPort {
  prepare(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<ArtifactRunPreparation>;
}

export interface ArtifactRunExecutorOptions {
  readonly preparation: ArtifactRunPreparationPort;
  /** Best-effort observation only; durable Task state is owned by TaskPublication. */
  readonly onEvent?: (
    claim: GenerationTaskAttemptClaim,
    event: StandardArtifactExecutionEvent,
  ) => void;
  readonly reportError?: (error: unknown) => void;
}

export class ArtifactRunExecutorError extends Error {
  readonly code:
    | "invalid-claim"
    | "invalid-preparation"
    | "context-mismatch"
    | "source-base-mismatch"
    | "reference-mismatch"
    | "invalid-evidence";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: ArtifactRunExecutorError["code"],
    message: string,
    failureClass: GenerationTaskFailureClass = "build-infrastructure",
  ) {
    super(message);
    this.name = "ArtifactRunExecutorError";
    this.code = code;
    this.failureClass = failureClass;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact generation aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES) {
    throw new ArtifactRunExecutorError("invalid-preparation", `${label} must be a non-empty string`);
  }
  return value;
}

function inspectOwnData(
  value: unknown,
  label: string,
  prototypes: readonly (object | null)[],
): Record<PropertyKey, PropertyDescriptor> {
  if (value === null || typeof value !== "object" || nodeUtilTypes.isProxy(value)) {
    throw new ArtifactRunExecutorError("invalid-preparation", `${label} must be non-proxy plain data`);
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new ArtifactRunExecutorError("invalid-preparation", `${label} could not be inspected safely`);
  }
  if (!prototypes.includes(prototype)) {
    throw new ArtifactRunExecutorError("invalid-preparation", `${label} has an invalid prototype`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (typeof key !== "string" || !("value" in descriptor)) {
      throw new ArtifactRunExecutorError("invalid-preparation", `${label} must contain only data fields`);
    }
  }
  return descriptors;
}

function exactEnumerableDataRecord(value: unknown, label: string): Record<string, unknown> {
  const descriptors = inspectOwnData(value, label, [Object.prototype, null]);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      throw new ArtifactRunExecutorError("invalid-preparation", `${label}.${key} must be enumerable data`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function cloneHistory(
  history: ArtifactRunPreparation["history"],
  budgetBytes: number,
): Array<{ role: TurnRole; content: string }> {
  if (history === undefined) return [];
  if (nodeUtilTypes.isProxy(history) || !Array.isArray(history)) {
    throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run history must be an array");
  }
  const descriptors = inspectOwnData(history, "Artifact run history", [Array.prototype]);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HISTORY_ENTRIES) {
    throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run history is unbounded");
  }
  const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run history contains extra fields");
  }
  let totalBytes = 0;
  const result: Array<{ role: TurnRole; content: string }> = [];
  for (let index = 0; index < length; index += 1) {
    const itemDescriptor = descriptors[String(index)];
    if (!itemDescriptor || !itemDescriptor.enumerable || !("value" in itemDescriptor)) {
      throw new ArtifactRunExecutorError(
        "invalid-preparation",
        `Artifact run history entry ${index} is invalid`,
      );
    }
    const entry = exactEnumerableDataRecord(
      itemDescriptor.value,
      `Artifact run history entry ${index}`,
    );
    const keys = Object.keys(entry).sort();
    if (!isDeepStrictEqual(keys, ["content", "role"])
      || (entry.role !== "user" && entry.role !== "assistant")
      || typeof entry.content !== "string") {
      throw new ArtifactRunExecutorError(
        "invalid-preparation",
        `Artifact run history entry ${index} is invalid`,
      );
    }
    const entryBytes = Buffer.byteLength(entry.content, "utf8");
    if (entryBytes > MAX_HISTORY_ENTRY_BYTES || entryBytes > budgetBytes
      || totalBytes > budgetBytes - entryBytes) {
      throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run history exceeds its input budget");
    }
    totalBytes += entryBytes;
    result.push({ role: entry.role, content: entry.content });
  }
  return result;
}

function cloneEnv(env: ArtifactRunPreparation["env"]): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  if (!env || typeof env !== "object" || Array.isArray(env) || nodeUtilTypes.isProxy(env)) {
    throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run environment must be an object");
  }
  const descriptors = inspectOwnData(env, "Artifact run environment", [Object.prototype, null]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_ENV_ENTRIES) {
    throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run environment is unbounded");
  }
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  let totalBytes = 0;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run environment cannot contain symbols");
    }
    const descriptor = descriptors[key]!;
    const value = "value" in descriptor ? descriptor.value : undefined;
    const keyBytes = Buffer.byteLength(key, "utf8");
    const valueBytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
    if (!descriptor.enumerable || !("value" in descriptor)
      || key.length === 0 || key.includes("=") || key.includes("\0")
      || keyBytes > MAX_ENV_KEY_BYTES || valueBytes > MAX_ENV_VALUE_BYTES
      || (value !== undefined && (typeof value !== "string" || value.includes("\0")))
      || totalBytes > MAX_ENV_BYTES - keyBytes - valueBytes) {
      throw new ArtifactRunExecutorError(
        "invalid-preparation",
        `Artifact run environment variable ${key} must be a string`,
      );
    }
    totalBytes += keyBytes + valueBytes;
    result[key] = value;
  }
  return result;
}

function validateClaim(claim: GenerationTaskAttemptClaim): void {
  const { task, attempt } = claim;
  if ((task.kind !== "page" && task.kind !== "component")
    || task.target.type !== "artifact"
    || attempt.executionMode !== "full"
    || attempt.target.type !== "artifact"
    || attempt.taskId !== task.id
    || attempt.workspaceId !== task.workspaceId
    || attempt.target.id !== task.target.id
    || attempt.target.trackId !== task.target.trackId
    || !isDeepStrictEqual(attempt.payload, task.payload)
    || attempt.contextPackId === null) {
    throw new ArtifactRunExecutorError(
      "invalid-claim",
      "ArtifactRunExecutor requires one full Page or Component Attempt with an exact Context Pack",
    );
  }
  validateGenerationTaskPayload(task);
}

function validatePreparation(
  claim: GenerationTaskAttemptClaim,
  preparation: ArtifactRunPreparation,
): {
  projectId: string;
  history: Array<{ role: TurnRole; content: string }>;
  env: NodeJS.ProcessEnv | undefined;
  systemPrompt: string;
  initialMessage: string;
  sharinganCapture: SharinganCaptureBundleFence | undefined;
} {
  if (!preparation || typeof preparation !== "object" || Array.isArray(preparation)
    || !preparation.runner || typeof preparation.runner.runTurn !== "function"
    || !preparation.transaction || typeof preparation.transaction.fingerprint !== "function"
    || typeof preparation.transaction.commit !== "function"
    || typeof preparation.transaction.restore !== "function"
    || typeof preparation.transaction.dispose !== "function"
    || typeof preparation.transaction.dir !== "string" || preparation.transaction.dir.length === 0
    || typeof preparation.transaction.attemptRef !== "string"
    || !preparation.transaction.attemptRef.startsWith("refs/dezin/")
    || !preparation.evaluator || typeof preparation.evaluator.evaluate !== "function"
    || typeof preparation.buildRepairPrompt !== "function") {
    throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run preparation ports are invalid");
  }

  const contextPackId = requireString(preparation.contextPackId, "Artifact run Context Pack id");
  const contextPackHash = requireString(preparation.contextPackHash, "Artifact run Context Pack hash");
  if (!SHA256.test(contextPackHash)
    || contextPackId !== `${CONTEXT_PACK_PREFIX}${contextPackHash}`
    || contextPackId !== claim.attempt.contextPackId) {
    throw new ArtifactRunExecutorError(
      "context-mismatch",
      "Artifact run preparation does not match the Attempt Context Pack",
      "context",
    );
  }

  const sourceCommitHash = requireString(preparation.sourceCommitHash, "Artifact run source commit");
  const sourceTreeHash = requireString(preparation.sourceTreeHash, "Artifact run source tree");
  if (!GIT_OBJECT_ID.test(sourceCommitHash) || !GIT_OBJECT_ID.test(sourceTreeHash)
    || sourceCommitHash !== claim.attempt.sourceCommitHash
    || sourceTreeHash !== claim.attempt.sourceTreeHash) {
    throw new ArtifactRunExecutorError(
      "source-base-mismatch",
      "Artifact run preparation does not match the immutable Attempt source base",
    );
  }
  const expectedAttemptRef = artifactCandidateAttemptRef({
    workspaceId: claim.task.workspaceId,
    taskId: claim.task.id,
    attempt: claim.attempt.attempt,
    inputHash: claim.attempt.inputHash,
    createdAt: claim.attempt.createdAt,
    sourceCommitHash,
    sourceTreeHash,
  });
  if (preparation.transaction.attemptRef !== expectedAttemptRef) {
    throw new ArtifactRunExecutorError(
      "invalid-preparation",
      "Artifact candidate retention ref does not match the immutable Attempt",
    );
  }

  const sharinganCapture = preparation.sharinganCapture;
  if (sharinganCapture !== undefined) {
    const reference = sharinganCapture?.reference;
    const pins = reference && typeof reference.resourceId === "string"
      ? claim.attempt.resourcePins.filter((pin) => pin.resourceId === reference.resourceId)
      : [];
    if (sharinganCapture.protocol !== "dezin.sharingan-capture-fence.v1"
      || sharinganCapture.mountPath !== ".sharingan"
      || typeof sharinganCapture.fingerprint !== "string" || !SHA256.test(sharinganCapture.fingerprint)
      || typeof sharinganCapture.worktreeDir !== "string"
      || resolve(sharinganCapture.worktreeDir) !== resolve(preparation.transaction.dir)
      || typeof sharinganCapture.verify !== "function"
      || typeof sharinganCapture.withoutMaterializedBundle !== "function"
      || typeof sharinganCapture.withoutMaterializedAssets !== "function"
      || typeof sharinganCapture.dispose !== "function"
      || !reference
      || reference.workspaceId !== claim.task.workspaceId
      || reference.contextPackId !== contextPackId
      || reference.contextPackHash !== contextPackHash
      || typeof reference.resourceId !== "string" || reference.resourceId.length === 0
      || typeof reference.revisionId !== "string" || reference.revisionId.length === 0
      || typeof reference.revisionChecksum !== "string" || !SHA256.test(reference.revisionChecksum)
      || pins.length !== 1 || pins[0]!.revisionId !== reference.revisionId) {
      throw new ArtifactRunExecutorError(
        "reference-mismatch",
        "Artifact run Sharingan Capture fence does not match the immutable Context Pack and Attempt pin",
        "context",
      );
    }
  }

  const historyBudgetBytes = Math.max(
    16 * 1024,
    Math.min(MAX_HISTORY_BYTES, claim.task.resourceLimits.maxOutputBytes),
  );
  const projectId = requireString(preparation.projectId, "Artifact run Project id");
  if (!SAFE_OWNER_ID.test(projectId)) {
    throw new ArtifactRunExecutorError("invalid-preparation", "Artifact run Project owner is invalid");
  }

  return {
    projectId,
    history: cloneHistory(preparation.history, historyBudgetBytes),
    env: cloneEnv(preparation.env),
    systemPrompt: requireString(preparation.systemPrompt, "Artifact run system prompt"),
    initialMessage: requireString(preparation.initialMessage, "Artifact run initial message"),
    sharinganCapture,
  };
}

async function verifySharinganCapture(
  fence: SharinganCaptureBundleFence | undefined,
  signal: AbortSignal,
  phase: string,
): Promise<void> {
  if (fence === undefined) return;
  checkAbort(signal);
  try {
    await fence.verify(signal);
    checkAbort(signal);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof ArtifactRunExecutorError && error.code === "reference-mismatch") throw error;
    throw new ArtifactRunExecutorError(
      "reference-mismatch",
      `Pinned Sharingan Capture bundle failed exact fingerprint verification ${phase}`,
      "context",
    );
  }
}

function fenceRunner(
  runner: AgentRunner,
  fence: SharinganCaptureBundleFence | undefined,
  signal: AbortSignal,
): AgentRunner {
  if (fence === undefined) return runner;
  return Object.freeze({
    id: runner.id,
    async runTurn(input: Parameters<AgentRunner["runTurn"]>[0]) {
      await verifySharinganCapture(fence, signal, "before the Agent turn");
      try {
        const result = await runner.runTurn(input);
        await verifySharinganCapture(fence, signal, "after the Agent turn");
        return result;
      } catch (error) {
        if (error instanceof ArtifactRunExecutorError && error.code === "reference-mismatch") throw error;
        await verifySharinganCapture(fence, signal, "after the failed Agent turn");
        throw error;
      }
    },
  });
}

function fenceEvaluator(
  evaluator: StandardArtifactQualityEvaluatorPort,
  fence: SharinganCaptureBundleFence | undefined,
  signal: AbortSignal,
): StandardArtifactQualityEvaluatorPort {
  if (fence === undefined) return evaluator;
  return Object.freeze({
    async evaluate(input: Parameters<StandardArtifactQualityEvaluatorPort["evaluate"]>[0]) {
      await verifySharinganCapture(fence, signal, "before quality evaluation");
      try {
        const result = await fence.withoutMaterializedAssets(
          () => evaluator.evaluate(input),
          signal,
        );
        await verifySharinganCapture(fence, signal, "after quality evaluation");
        return result;
      } catch (error) {
        if (error instanceof ArtifactRunExecutorError && error.code === "reference-mismatch") throw error;
        await verifySharinganCapture(fence, signal, "after failed quality evaluation");
        throw error;
      }
    },
  });
}

function invalidEvaluation(message: string): never {
  throw new ArtifactRunExecutorError("invalid-evidence", message, "qa");
}

function evaluationRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)) {
    return invalidEvaluation(`${label} must be a non-proxy plain object`);
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    return invalidEvaluation(`${label} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidEvaluation(`${label} must be a plain object`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      return invalidEvaluation(`${label} must contain only enumerable data fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function evaluationArray(
  value: unknown,
  label: string,
  maximum = MAX_EVALUATION_FRAMES,
): unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalidEvaluation(`${label} must be a non-proxy array`);
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return invalidEvaluation(`${label} could not be inspected safely`);
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    return invalidEvaluation(`${label} exceeds its bounded length`);
  }
  const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    return invalidEvaluation(`${label} contains extra or sparse fields`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return invalidEvaluation(`${label}[${index}] must be enumerable data`);
    }
    return structuredClone(descriptor.value);
  });
}

function optionalEvaluationValue(
  record: Record<string, unknown>,
  key: string,
  clone: (value: unknown) => unknown,
): { present: boolean; value?: unknown } {
  if (!Object.hasOwn(record, key)) return { present: false };
  return { present: true, value: clone(record[key]) };
}

function evaluationManifest(version: StandardArtifactExecutionVersion): Record<string, unknown> {
  const evidence = evaluationRecord(version.quality.evidence, `Artifact round ${version.round} quality evidence`);
  const quality = evaluationRecord(version.quality.quality, `Artifact round ${version.round} quality result`);
  const candidate = evaluationRecord(evidence.candidate, `Artifact round ${version.round} evidence candidate`);
  if (evidence.protocol !== "dezin.standard-artifact-quality.v1"
    || evidence.round !== version.round
    || candidate.commitHash !== version.candidate.commitHash
    || candidate.treeHash !== version.candidate.treeHash
    || quality.score !== version.quality.score
    || (quality.state !== "passed" && quality.state !== "needs-attention" && quality.state !== "failed")) {
    return invalidEvaluation(`Artifact round ${version.round} quality identity is inconsistent`);
  }

  const findings = evaluationArray(
    quality.findings,
    `Artifact round ${version.round} quality findings`,
    10_000,
  );
  let canonicalFindings: string;
  try {
    canonicalFindings = stableStringify(findings);
  } catch {
    return invalidEvaluation(`Artifact round ${version.round} quality findings are not bounded canonical JSON`);
  }
  if (Buffer.byteLength(canonicalFindings, "utf8") > MAX_EVALUATION_FINDINGS_BYTES) {
    return invalidEvaluation(`Artifact round ${version.round} quality findings exceed their digest budget`);
  }
  const frameResults = evaluationArray(
    evidence.frameResults,
    `Artifact round ${version.round} Frame results`,
  );
  const runtimeChecks = optionalEvaluationValue(
    evidence,
    "runtimeChecks",
    (value) => evaluationArray(value, `Artifact round ${version.round} runtime checks`),
  );
  const visualReview = optionalEvaluationValue(
    evidence,
    "visualReview",
    (value) => structuredClone(evaluationRecord(value, `Artifact round ${version.round} visual review`)),
  );
  const visualEvidence = optionalEvaluationValue(
    evidence,
    "visualEvidence",
    (value) => evaluationArray(value, `Artifact round ${version.round} visual evidence`),
  );
  const sourceCaptureResult = optionalEvaluationValue(
    evidence,
    "sourceCaptureResult",
    (value) => structuredClone(evaluationRecord(value, `Artifact round ${version.round} source capture`)),
  );
  const sourceVisualEvidence = optionalEvaluationValue(
    evidence,
    "sourceVisualEvidence",
    (value) => structuredClone(evaluationRecord(value, `Artifact round ${version.round} source visual evidence`)),
  );
  const manifest: Record<string, unknown> = {
    protocol: "dezin.artifact-run-evaluation-manifest.v1",
    candidate: structuredClone(version.candidate),
    round: version.round,
    passed: version.quality.passed,
    score: version.quality.score,
    qualityState: quality.state,
    findingsDigest: createHash("sha256").update(canonicalFindings).digest("hex"),
    frameResults,
    ...(runtimeChecks.present ? { runtimeChecks: runtimeChecks.value } : {}),
    ...(visualReview.present ? { reviewSummary: visualReview.value } : {}),
    ...(visualEvidence.present ? { visualEvidence: visualEvidence.value } : {}),
    ...(sourceCaptureResult.present ? { sourceCaptureResult: sourceCaptureResult.value } : {}),
    ...(sourceVisualEvidence.present ? { sourceVisualEvidence: sourceVisualEvidence.value } : {}),
  };
  if (evaluationBytes(
    manifest,
    `Artifact round ${version.round} evaluation manifest`,
  ) > MAX_ARTIFACT_RUN_EVIDENCE_BYTES) {
    return invalidEvaluation(`Artifact round ${version.round} evaluation manifest exceeds its byte budget`);
  }
  return manifest;
}

function evaluationBytes(value: unknown, label: string): number {
  try {
    return Buffer.byteLength(stableStringify(value), "utf8");
  } catch {
    return invalidEvaluation(`${label} is not bounded canonical JSON`);
  }
}

function executionEvidence(
  claim: GenerationTaskAttemptClaim,
  preparation: ArtifactRunPreparation,
  versions: readonly StandardArtifactExecutionVersion[],
  selected: StandardArtifactExecutionVersion,
): Record<string, unknown> {
  if (versions.length < 1 || versions.length > MAX_EVALUATION_VERSIONS) {
    return invalidEvaluation("Artifact evaluation history exceeds its bounded version count");
  }
  const gateEvidence = selected.quality.evidence;
  const runtimeChecks = Object.getOwnPropertyDescriptor(gateEvidence, "runtimeChecks");
  const visualReview = Object.getOwnPropertyDescriptor(gateEvidence, "visualReview");
  const evidenceBase = {
    ...(runtimeChecks && "value" in runtimeChecks
      ? { runtimeChecks: structuredClone(runtimeChecks.value) }
      : {}),
    ...(visualReview && "value" in visualReview
      ? { visualReview: structuredClone(visualReview.value) }
      : {}),
    protocol: "dezin.artifact-run.v1",
    projectId: preparation.projectId,
    taskId: claim.task.id,
    planId: claim.task.planId,
    workspaceId: claim.task.workspaceId,
    attempt: claim.attempt.attempt,
    attemptCreatedAt: claim.attempt.createdAt,
    inputHash: claim.attempt.inputHash,
    contextPackId: preparation.contextPackId,
    contextPackHash: preparation.contextPackHash,
    sourceBase: {
      commitHash: preparation.sourceCommitHash,
      treeHash: preparation.sourceTreeHash,
    },
    candidateRetentionRef: preparation.transaction.attemptRef,
    selectedRound: selected.round,
    versions: [] as Record<string, unknown>[],
    qualityEvidence: structuredClone(gateEvidence),
  };
  let evidenceBytes = evaluationBytes(evidenceBase, "Artifact run evidence");
  for (const version of versions) {
    const retainedVersion = {
      round: version.round,
      commitHash: version.candidate.commitHash,
      treeHash: version.candidate.treeHash,
      passed: version.quality.passed,
      score: version.quality.score,
      evaluationManifest: evaluationManifest(version),
    };
    const retainedBytes = evaluationBytes(
      retainedVersion,
      `Artifact round ${version.round} retained evaluation`,
    );
    evidenceBytes += retainedBytes + (evidenceBase.versions.length === 0 ? 0 : 1);
    if (evidenceBytes > MAX_ARTIFACT_RUN_EVIDENCE_BYTES) {
      return invalidEvaluation("Artifact run evidence exceeds its prepared-candidate byte budget");
    }
    evidenceBase.versions.push(retainedVersion);
  }
  const evidence = evidenceBase;
  if (evaluationBytes(evidence, "Artifact run evidence") > MAX_ARTIFACT_RUN_EVIDENCE_BYTES) {
    return invalidEvaluation("Artifact run evidence exceeds its prepared-candidate byte budget");
  }
  return evidence;
}

/**
 * Production leaf orchestration for Page and Component Tasks. Infrastructure
 * preparation remains an injected adapter, but all execution policy, budgets,
 * candidate selection, evidence, and cleanup semantics are owned here.
 */
export class ArtifactRunExecutor implements ArtifactGenerationTaskLeafExecutor {
  private readonly options: Readonly<ArtifactRunExecutorOptions>;

  constructor(options: ArtifactRunExecutorOptions) {
    this.options = Object.freeze({
      preparation: options.preparation,
      onEvent: options.onEvent,
      reportError: options.reportError,
    });
  }

  async execute(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<ArtifactPreparedCandidate> {
    validateClaim(claim);
    const target = claim.task.target;
    if (target.type !== "artifact") {
      throw new ArtifactRunExecutorError("invalid-claim", "ArtifactRunExecutor target is not an Artifact");
    }
    let preparation: ArtifactRunPreparation | undefined;
    let transaction: ArtifactRunCandidateTransactionPort | undefined;
    let primaryError: unknown = null;
    try {
      checkAbort(signal);
      preparation = await this.options.preparation.prepare(claim, signal);
      transaction = preparation?.transaction;
      checkAbort(signal);
      const canonical = validatePreparation(claim, preparation);
      await verifySharinganCapture(canonical.sharinganCapture, signal, "before Artifact execution");
      const execution = await executeStandardArtifact({
        runner: fenceRunner(preparation.runner, canonical.sharinganCapture, signal),
        transaction: preparation.transaction,
        evaluator: fenceEvaluator(preparation.evaluator, canonical.sharinganCapture, signal),
        systemPrompt: canonical.systemPrompt,
        initialMessage: canonical.initialMessage,
        history: canonical.history,
        env: canonical.env,
        signal,
        maxRepairRounds: claim.task.resourceLimits.maxRepairRounds,
        maxTurns: claim.task.resourceLimits.maxAgentTurns,
        commitMessage: (round) => (
          `Dezin ${claim.task.kind} ${claim.task.id} attempt ${claim.attempt.attempt} round ${round}`
        ),
        buildRepairPrompt: preparation.buildRepairPrompt,
        onEvent: (event) => {
          try {
            this.options.onEvent?.(claim, event);
          } catch (error) {
            this.reportBestEffort(error);
          }
        },
      });
      checkAbort(signal);
      await verifySharinganCapture(canonical.sharinganCapture, signal, "after Artifact execution");
      const selected = execution.selected;
      return {
        kind: "artifact-candidate",
        taskId: claim.task.id,
        workspaceId: claim.task.workspaceId,
        artifactId: target.id,
        trackId: target.trackId,
        sourceCommitHash: selected.candidate.commitHash,
        sourceTreeHash: selected.candidate.treeHash,
        renderSpec: selected.quality.renderSpec,
        quality: selected.quality.quality,
        evidence: executionEvidence(claim, preparation, execution.versions, selected),
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (transaction && typeof transaction.dispose === "function") {
        try {
          await transaction.dispose();
        } catch (error) {
          if (primaryError === null) throw error;
          this.reportBestEffort(error);
          throw new AggregateError(
            [primaryError, error],
            "Artifact execution failed and candidate cleanup failed",
            { cause: primaryError },
          );
        }
      }
    }
  }

  private reportBestEffort(error: unknown): void {
    try {
      this.options.reportError?.(error);
    } catch {
      // Observation must never replace durable execution or cleanup failures.
    }
  }
}
