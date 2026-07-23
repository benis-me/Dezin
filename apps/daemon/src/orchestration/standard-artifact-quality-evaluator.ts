import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  getProvider,
  providerFamily,
} from "../../../../packages/agent/src/index.ts";
import type {
  ArtifactGenerationTaskPayloadV2,
  GenerationTaskFailureClass,
  QualityFinding,
  RenderFrameSpec,
  Settings,
} from "../../../../packages/core/src/index.ts";
import {
  applyIgnores,
  lintArtifact,
  type QualityIgnore,
} from "../../../../packages/quality/src/index.ts";
import type { PreviewLease } from "../preview-lease.ts";
import { previewLeaseManager, requirePreviewLease } from "../preview-lease.ts";
import { ensureDevServer } from "../project-runtime.ts";
import {
  floorScore,
  isQualityInfrastructureFinding,
  markVisualReviewRound,
  producedDesignReview,
  reviewerAgentCommand,
  reviewerModel,
  standardRepairableDefects,
  standardRunPassed,
} from "../run-policy.ts";
import { sharinganReviewReference } from "../sharingan-capture.ts";
import {
  auditVisualArtifactReport,
  visualQaFrameAttemptId,
  visualQaSourceAttemptId,
  type VisualQaInput,
  type VisualQaReport,
  type VisualQaSourceCaptureResult,
} from "../visual-qa.ts";
import type { ArtifactRunInfrastructureInput } from "./artifact-run-preparation.ts";
import { verifyArtifactCandidateObject } from "./artifact-candidate-transaction.ts";
import { collectStandardLintSurface } from "../standard-lint-surface.ts";
import type { PngEvidenceIdentity } from "../png-evidence.ts";
import { validateGenerationTaskPayload } from "./generation-task-contracts.ts";
import {
  generationTaskVisualEvidenceFrameStorageSegment,
  persistGenerationTaskVisualEvidenceBatch,
  persistGenerationTaskSourceVisualEvidence,
  persistGenerationTaskVisualEvidence,
  type GenerationTaskSourceVisualEvidenceDescriptor,
  type GenerationTaskVisualEvidenceDescriptor,
  type PersistGenerationTaskVisualEvidenceBatchInput,
  type PersistGenerationTaskVisualEvidenceBatchResult,
  type PersistGenerationTaskSourceVisualEvidenceInput,
  type PersistGenerationTaskVisualEvidenceInput,
} from "./generation-task-visual-evidence.ts";
import type {
  StandardArtifactCandidateIdentity,
  StandardArtifactQualityEvaluatorPort,
  StandardArtifactQualityResult,
} from "./standard-artifact-execution.ts";
import { inspectCandidateSidecarReferences } from "./standard-artifact-sidecar-reference.ts";

const MAX_FINDINGS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUNTIME_FAILURE_IDS = new Set([
  "visual-artifact-missing",
  "visual-blank-page",
  "visual-runtime-error",
]);
const BUILD_INFRASTRUCTURE_FINDING_PREFIXES = [
  "visual-chrome-unavailable",
  "visual-render-failed",
  "visual-screenshot-missing",
] as const;
const PROVIDER_FINDING_PREFIXES = [
  "visual-agent-review-failed",
  "visual-review-unassessed",
] as const;

export interface StandardArtifactVisualQaInput extends VisualQaInput {
  /** Exact immutable Task Frames, including state/fixture bridge payloads. */
  renderFrames: RenderFrameSpec[];
  signal: AbortSignal;
  frameAttemptIdPrefix: string;
  runtimeOnly: boolean;
}

export interface StandardArtifactCandidateInspection
  extends StandardArtifactCandidateIdentity {
  /** Empty only when source/index remain exact and the committed tree is self-contained. */
  status: string;
}

export interface ProductionStandardArtifactQualityEvaluatorDependencies {
  inspectCandidate(input: {
    repositoryDir: string;
    worktreeDir: string;
    candidate: StandardArtifactCandidateIdentity;
    /** True only while the exact immutable Sharingan roots are materialized. */
    immutableSharinganSidecar: boolean;
    signal: AbortSignal;
  }): Promise<StandardArtifactCandidateInspection>;
  acquireRuntime(input: {
    projectId: string;
    projectDir: string;
    runtimeKey: string;
    candidate: StandardArtifactCandidateIdentity;
    signal: AbortSignal;
  }): Promise<PreviewLease>;
  collectLintSurface(root: string): Promise<string>;
  lint(
    source: string,
    options: { mode: "standard"; provider: string; isSharingan: boolean },
  ): QualityFinding[];
  visualQa(input: StandardArtifactVisualQaInput): Promise<VisualQaReport>;
  persistEvidence(
    input: PersistGenerationTaskVisualEvidenceInput,
  ): Promise<GenerationTaskVisualEvidenceDescriptor | undefined>;
  persistSourceEvidence?(
    input: PersistGenerationTaskSourceVisualEvidenceInput,
  ): Promise<GenerationTaskSourceVisualEvidenceDescriptor | undefined>;
  /** Production atomic persistence boundary for one complete visual-review round. */
  persistEvidenceBatch?(
    input: PersistGenerationTaskVisualEvidenceBatchInput,
  ): Promise<PersistGenerationTaskVisualEvidenceBatchResult>;
  /** Overrideable scratch allocation boundary for storage fault handling/tests. */
  createCaptureDir?(): Promise<string>;
  sharinganReference(
    projectDir: string,
    options: { expectedRequestedUrl?: string; requireCurrentSchema?: boolean },
  ): { screenshotPath: string; renderMapPath: string; assetsSummary?: string } | undefined;
}

export interface ProductionStandardArtifactQualityEvaluatorOptions {
  infrastructure: ArtifactRunInfrastructureInput;
  /** Real Store Project owner resolved by the orchestration composition boundary. */
  projectId: string;
  settings: Settings;
  dataDir: string;
  agentCommand: string;
  model?: string;
  directionSpec?: string;
  expectedSharinganRequestedUrl?: string;
  qualityIgnores?: readonly Readonly<QualityIgnore>[];
  dependencies?: ProductionStandardArtifactQualityEvaluatorDependencies;
}

export class ProductionStandardArtifactQualityEvaluatorError extends Error {
  readonly code:
    | "invalid-input"
    | "candidate-mismatch"
    | "source-dirty"
    | "invalid-findings"
    | "runtime-unavailable"
    | "visual-infrastructure"
    | "quality-infrastructure"
    | "evidence-unavailable"
    | "sharingan-evidence"
    | "cleanup-failed";
  readonly failureClass: GenerationTaskFailureClass;

  constructor(
    code: ProductionStandardArtifactQualityEvaluatorError["code"],
    message: string,
    failureClass: GenerationTaskFailureClass = "build-infrastructure",
  ) {
    super(message);
    this.name = "ProductionStandardArtifactQualityEvaluatorError";
    this.code = code;
    this.failureClass = failureClass;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Standard Artifact quality evaluation aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"] as const) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function gitOutput(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      [
        "-c", "core.fsmonitor=false",
        "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        signal,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout.trim());
      },
    );
  });
}

export async function inspectStandardArtifactCandidate(input: {
  repositoryDir: string;
  worktreeDir: string;
  candidate: StandardArtifactCandidateIdentity;
  /** Defaults false so ordinary projects may own `public/_assets`. */
  immutableSharinganSidecar?: boolean;
  signal: AbortSignal;
}): Promise<StandardArtifactCandidateInspection> {
  const exact = await verifyArtifactCandidateObject({
    repositoryDir: input.repositoryDir,
    commitHash: input.candidate.commitHash,
    treeHash: input.candidate.treeHash,
    signal: input.signal,
  });
  checkAbort(input.signal);
  const statusPathspec = [
    ".",
    ":(exclude).sharingan",
    ":(exclude).sharingan/**",
    ...(input.immutableSharinganSidecar === true ? [
      ":(exclude)public/_assets",
      ":(exclude)public/_assets/**",
    ] : []),
  ];
  const [commitHash, treeHash, status] = await Promise.all([
    gitOutput(input.worktreeDir, ["rev-parse", "--verify", "HEAD^{commit}"], input.signal),
    gitOutput(input.worktreeDir, ["rev-parse", "--verify", "HEAD^{tree}"], input.signal),
    gitOutput(
      input.worktreeDir,
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ...statusPathspec,
      ],
      input.signal,
    ),
  ]);
  checkAbort(input.signal);
  if (commitHash !== exact.commitHash || treeHash !== exact.treeHash) {
    return { commitHash, treeHash, status };
  }
  const sidecarReferenceStatus = input.immutableSharinganSidecar === true
    ? await inspectCandidateSidecarReferences({
      repositoryDir: input.repositoryDir,
      commitHash: exact.commitHash,
      signal: input.signal,
    })
    : "";
  checkAbort(input.signal);
  return {
    ...exact,
    status: [status, sidecarReferenceStatus].filter((value) => value !== "").join("\n"),
  };
}

const DEFAULT_DEPENDENCIES: ProductionStandardArtifactQualityEvaluatorDependencies = Object.freeze({
  inspectCandidate: inspectStandardArtifactCandidate,
  async acquireRuntime(input: Parameters<ProductionStandardArtifactQualityEvaluatorDependencies["acquireRuntime"]>[0]) {
    return ensureDevServer(
      input.projectId,
      input.projectDir,
      input.runtimeKey,
      input.signal,
      previewLeaseManager,
      {
        immutableSource: true,
        disposeOnIdle: true,
      },
    );
  },
  collectLintSurface: collectStandardLintSurface,
  lint(
    source: string,
    options: { mode: "standard"; provider: string; isSharingan: boolean },
  ) {
    return lintArtifact(source, options) as QualityFinding[];
  },
  visualQa: auditVisualArtifactReport,
  persistEvidence: persistGenerationTaskVisualEvidence,
  persistSourceEvidence: persistGenerationTaskSourceVisualEvidence,
  persistEvidenceBatch: persistGenerationTaskVisualEvidenceBatch,
  sharinganReference: sharinganReviewReference,
});

function artifactPayload(input: ArtifactRunInfrastructureInput): ArtifactGenerationTaskPayloadV2 {
  const { claim, contextPack } = input;
  validateGenerationTaskPayload(claim.task);
  const task = claim.task;
  if ((task.kind !== "page" && task.kind !== "component")
    || task.target.type !== "artifact"
    || task.payload.version !== 2
    || claim.attempt.contextPackId !== contextPack.id
    || contextPack.id !== `context-pack-${contextPack.hash}`
    || !/^[0-9a-f]{64}$/.test(contextPack.hash)
    || contextPack.workspaceId !== task.workspaceId
    || contextPack.target.type !== "artifact"
    || contextPack.target.id !== task.target.id
    || contextPack.intent !== "generate") {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "invalid-input",
      "Production Standard Artifact quality evaluator requires one exact v2 Artifact Task and Context Pack",
      "context",
    );
  }
  return task.payload as ArtifactGenerationTaskPayloadV2;
}

function propertyValue(
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || descriptor.get || descriptor.set) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "invalid-findings",
      `Quality finding field ${key} must be an owned data property`,
      "qa",
    );
  }
  return descriptor.value;
}

function finding(value: unknown, index: number): QualityFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "invalid-findings",
      `Quality finding ${index} must be a plain object`,
      "qa",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const severity = propertyValue(descriptors, "severity");
  const id = propertyValue(descriptors, "id");
  const message = propertyValue(descriptors, "message");
  const fix = propertyValue(descriptors, "fix");
  if ((severity !== "P0" && severity !== "P1" && severity !== "P2")
    || typeof id !== "string" || id.length === 0 || id.length > 512
    || typeof message !== "string" || message.length === 0
    || typeof fix !== "string" || fix.length === 0) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "invalid-findings",
      `Quality finding ${index} is malformed`,
      "qa",
    );
  }
  const allowed = new Set([
    "severity", "id", "message", "fix", "snippet", "selector", "screenshotPath",
    "screenshotUrl", "reviewSummary", "reviewStatus", "reviewRound", "corroborated",
  ]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "invalid-findings",
      `Quality finding ${id} contains unsupported fields`,
      "qa",
    );
  }
  const result: QualityFinding = { severity, id, message, fix };
  for (const key of [
    "snippet", "selector", "screenshotPath", "screenshotUrl", "reviewSummary",
  ] as const) {
    if (!descriptors[key]) continue;
    const current = propertyValue(descriptors, key);
    if (typeof current !== "string") {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "invalid-findings",
        `Quality finding ${id} field ${key} is invalid`,
        "qa",
      );
    }
    result[key] = current;
  }
  if (descriptors.reviewStatus) {
    const current = propertyValue(descriptors, "reviewStatus");
    if (current !== "active" && current !== "resolved") {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "invalid-findings",
        `Quality finding ${id} review status is invalid`,
        "qa",
      );
    }
    result.reviewStatus = current;
  }
  if (descriptors.reviewRound) {
    const current = propertyValue(descriptors, "reviewRound");
    if (!Number.isSafeInteger(current) || Number(current) < 0) {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "invalid-findings",
        `Quality finding ${id} review round is invalid`,
        "qa",
      );
    }
    result.reviewRound = Number(current);
  }
  if (descriptors.corroborated) {
    const current = propertyValue(descriptors, "corroborated");
    if (typeof current !== "boolean") {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "invalid-findings",
        `Quality finding ${id} corroboration is invalid`,
        "qa",
      );
    }
    result.corroborated = current;
  }
  return result;
}

function canonicalFindings(values: unknown): QualityFinding[] {
  if (!Array.isArray(values) || values.length > MAX_FINDINGS) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "invalid-findings",
      "Quality findings must be a bounded array",
      "qa",
    );
  }
  const counts = new Map<string, number>();
  return values.map((value, index) => {
    const next = finding(value, index);
    const count = (counts.get(next.id) ?? 0) + 1;
    counts.set(next.id, count);
    if (count === 1) return next;
    const suffix = `#${count}`;
    return { ...next, id: `${next.id.slice(0, 512 - suffix.length)}${suffix}` };
  });
}

function runtimeFailed(findings: readonly QualityFinding[]): boolean {
  return findings.some((item) => [...RUNTIME_FAILURE_IDS].some((id) =>
    item.id === id || item.id.startsWith(`${id}@`)));
}

function hasPrefix(finding: QualityFinding, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => finding.id === prefix || finding.id.startsWith(`${prefix}@`));
}

function throwInfrastructureFinding(findings: readonly QualityFinding[]): void {
  const provider = findings.find((finding) => hasPrefix(finding, PROVIDER_FINDING_PREFIXES));
  if (provider) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "visual-infrastructure",
      provider.message,
      "provider",
    );
  }
  const source = findings.find((finding) => finding.id.startsWith("visual-source-evidence-"));
  if (source) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "sharingan-evidence",
      source.message,
      "context",
    );
  }
  const infrastructure = findings.find((finding) => hasPrefix(
    finding,
    BUILD_INFRASTRUCTURE_FINDING_PREFIXES,
  ));
  if (infrastructure) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "visual-infrastructure",
      infrastructure.message,
      "build-infrastructure",
    );
  }
}

function exactFrameResults(
  report: VisualQaReport,
  frames: readonly RenderFrameSpec[],
  attemptPrefix: string,
): VisualQaReport["frames"] {
  if (!Array.isArray(report.frames) || report.frames.length !== frames.length) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "visual-infrastructure",
      "Exact Frame QA did not return one runtime result per immutable Task Frame",
    );
  }
  const seen = new Set<string>();
  return frames.map((frame, index) => {
    const current = report.frames.find((result) => result.frameId === frame.id);
    const captureIdentity = current?.captureIdentity === undefined
      ? undefined
      : exactCaptureIdentity(current.captureIdentity, frame.width, frame.height, `Frame ${frame.id}`);
    const hasScreenshot = typeof current?.screenshotPath === "string" && current.screenshotPath.length > 0;
    if (!current || seen.has(current.frameId)
      || current.frameAttemptId !== visualQaFrameAttemptId(attemptPrefix, frame, index)
      || current.width !== frame.width || current.height !== frame.height
      || (current.status !== "passed" && current.status !== "failed")
      || typeof current.reviewed !== "boolean"
      || hasScreenshot !== Boolean(captureIdentity)
      || (current.status === "passed" && !hasScreenshot)) {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "visual-infrastructure",
        `Exact Frame QA result for ${frame.id} is missing or does not match its immutable contract`,
      );
    }
    seen.add(current.frameId);
    return current;
  });
}

function exactCaptureIdentity(
  value: PngEvidenceIdentity,
  minimumWidth: number,
  minimumHeight: number,
  label: string,
): PngEvidenceIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 4
    || !Object.hasOwn(value, "sha256")
    || !Object.hasOwn(value, "byteLength")
    || !Object.hasOwn(value, "width")
    || !Object.hasOwn(value, "height")
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 57 || value.byteLength > 16 * 1024 * 1024
    || !Number.isSafeInteger(value.width) || value.width < minimumWidth || value.width > 32_768
    || !Number.isSafeInteger(value.height) || value.height < minimumHeight || value.height > 32_768) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "visual-infrastructure",
      `${label} capture identity is missing or does not cover its immutable viewport`,
      "provider",
    );
  }
  return structuredClone(value);
}

function exactSourceCaptureResult(
  report: VisualQaReport,
  attemptPrefix: string,
  screenshotPath: string,
  sharingan: boolean,
): VisualQaSourceCaptureResult | undefined {
  const current = report.sourceCapture;
  if (!sharingan) {
    if (current !== undefined) {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "visual-infrastructure",
        "Visual QA returned source-scoped evidence for a non-Sharingan Task",
      );
    }
    return undefined;
  }
  if (!current || current.scope !== "source"
    || current.sourceAttemptId !== visualQaSourceAttemptId(attemptPrefix)
    || !Number.isSafeInteger(current.width) || current.width < 320 || current.width > 3_000
    || !Number.isSafeInteger(current.height) || current.height < 320 || current.height > 3_000
    || (current.status !== "passed" && current.status !== "failed")
    || current.screenshotPath !== screenshotPath
    || !current.captureIdentity
    || current.reviewed !== true) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "visual-infrastructure",
      "Sharingan source-parity QA did not return one exact reviewed source capture",
      "provider",
    );
  }
  return {
    ...structuredClone(current),
    captureIdentity: exactCaptureIdentity(
      current.captureIdentity,
      current.width,
      current.height,
      "Sharingan source-parity",
    ),
  };
}

function exactEvidence(
  descriptor: GenerationTaskVisualEvidenceDescriptor,
  expected: PersistGenerationTaskVisualEvidenceInput,
): GenerationTaskVisualEvidenceDescriptor {
  const prefix = [
    "generation-task-evidence",
    expected.owner.projectId,
    expected.owner.workspaceId,
    expected.owner.planId,
    expected.owner.taskId,
    `attempt-${expected.owner.attempt}`,
    "visual",
    `round-${expected.round}-${generationTaskVisualEvidenceFrameStorageSegment(expected.frame.id)}-`,
  ].join("/");
  if (!descriptor || descriptor.protocol !== "dezin.generation-task-visual-evidence.v1"
    || !isDeepStrictEqual(descriptor.owner, expected.owner)
    || !isDeepStrictEqual(descriptor.frame, expected.frame)
    || descriptor.round !== expected.round
    || descriptor.mediaType !== "image/png"
    || descriptor.sha256 !== expected.expectedIdentity.sha256
    || descriptor.byteLength !== expected.expectedIdentity.byteLength
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256)
    || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1
    || descriptor.storageKey !== `${prefix}${descriptor.sha256}.png`) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "evidence-unavailable",
      `Durable visual evidence for Frame ${expected.frame.id} has invalid ownership or content identity`,
      "storage",
    );
  }
  return structuredClone(descriptor);
}

function exactSourceEvidence(
  descriptor: GenerationTaskSourceVisualEvidenceDescriptor,
  expected: PersistGenerationTaskSourceVisualEvidenceInput,
): GenerationTaskSourceVisualEvidenceDescriptor {
  const prefix = [
    "generation-task-evidence",
    expected.owner.projectId,
    expected.owner.workspaceId,
    expected.owner.planId,
    expected.owner.taskId,
    `attempt-${expected.owner.attempt}`,
    "visual",
    `round-${expected.round}-source-`,
  ].join("/");
  if (!descriptor || descriptor.protocol !== "dezin.generation-task-source-visual-evidence.v1"
    || !isDeepStrictEqual(descriptor.owner, expected.owner)
    || !isDeepStrictEqual(descriptor.capture, expected.capture)
    || !isDeepStrictEqual(descriptor.sourceAuthority, expected.sourceAuthority)
    || descriptor.round !== expected.round
    || descriptor.mediaType !== "image/png"
    || descriptor.sha256 !== expected.expectedIdentity.sha256
    || descriptor.byteLength !== expected.expectedIdentity.byteLength
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256)
    || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1
    || descriptor.storageKey !== `${prefix}${descriptor.sha256}.png`) {
    throw new ProductionStandardArtifactQualityEvaluatorError(
      "evidence-unavailable",
      "Durable Sharingan source visual evidence has invalid ownership or content identity",
      "storage",
    );
  }
  return structuredClone(descriptor);
}

function actionableVisualFindings(findings: readonly QualityFinding[]): QualityFinding[] {
  return findings.filter((item) => item.id !== "visual-reviewed");
}

function repairFindings(
  findings: QualityFinding[],
  sharingan: boolean,
  blockingSeverities: readonly QualityFinding["severity"][],
): QualityFinding[] {
  const repairs = standardRepairableDefects(findings, sharingan);
  const seen = new Set(repairs.map((item) => item.id));
  const blocking = new Set(blockingSeverities);
  for (const item of findings) {
    if (seen.has(item.id) || item.id === "visual-reviewed" || isQualityInfrastructureFinding(item)) continue;
    if (item.id.startsWith("visual-improve") || blocking.has(item.severity)) {
      repairs.push(item);
      seen.add(item.id);
    }
  }
  return repairs;
}

/**
 * Production adapter for the shared Artifact execution loop. It binds every
 * assessment to the exact candidate object, immutable Task Frames/Context Pack,
 * nonce-bound preview runtime, visual critic, and durable screenshot evidence.
 */
export class ProductionStandardArtifactQualityEvaluator
implements StandardArtifactQualityEvaluatorPort {
  private readonly infrastructure: ArtifactRunInfrastructureInput;
  private readonly projectId: string;
  private readonly settings: Settings;
  private readonly dataDir: string;
  private readonly agentCommand: string;
  private readonly model: string | undefined;
  private readonly directionSpec: string | undefined;
  private readonly expectedSharinganRequestedUrl: string | undefined;
  private readonly qualityIgnores: readonly Readonly<QualityIgnore>[];
  private readonly dependencies: ProductionStandardArtifactQualityEvaluatorDependencies;
  private readonly payload: ArtifactGenerationTaskPayloadV2;
  private readonly sharingan: boolean;
  private readonly sourceAuthority: PersistGenerationTaskSourceVisualEvidenceInput["sourceAuthority"] | null;

  constructor(options: ProductionStandardArtifactQualityEvaluatorOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)
      || typeof options.dataDir !== "string" || options.dataDir.length === 0
      || typeof options.projectId !== "string" || !SAFE_OWNER_ID.test(options.projectId)
      || typeof options.agentCommand !== "string" || options.agentCommand.length === 0
      || !options.settings || typeof options.settings !== "object"
      || !options.infrastructure || typeof options.infrastructure !== "object"
      || typeof options.infrastructure.hasExactSharinganCapture !== "boolean") {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "invalid-input",
        "Production Standard Artifact quality evaluator options are invalid",
      );
    }
    const sharinganReference = options.infrastructure.sharinganReference;
    if ((sharinganReference !== null && (!sharinganReference
      || typeof sharinganReference !== "object"
      || !SAFE_OWNER_ID.test(sharinganReference.workspaceId)
      || !SAFE_OWNER_ID.test(sharinganReference.resourceId)
      || !SAFE_OWNER_ID.test(sharinganReference.revisionId)
      || !SHA256.test(sharinganReference.revisionChecksum)
      || !SHA256.test(sharinganReference.contextPackHash)
      || sharinganReference.contextPackId !== `context-pack-${sharinganReference.contextPackHash}`))
      || options.infrastructure.hasExactSharinganCapture !== (sharinganReference !== null)
      || (sharinganReference !== null
        && (sharinganReference.workspaceId !== options.infrastructure.claim.task.workspaceId
          || sharinganReference.contextPackId !== options.infrastructure.contextPack.id
          || sharinganReference.contextPackHash !== options.infrastructure.contextPack.hash))) {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "invalid-input",
        "Production Standard Artifact quality evaluator Sharingan authority is invalid",
      );
    }
    this.payload = artifactPayload(options.infrastructure);
    this.infrastructure = options.infrastructure;
    this.projectId = options.projectId;
    this.settings = structuredClone(options.settings);
    this.dataDir = options.dataDir;
    this.agentCommand = options.agentCommand;
    this.model = options.model;
    this.directionSpec = options.directionSpec;
    this.expectedSharinganRequestedUrl = options.expectedSharinganRequestedUrl;
    this.qualityIgnores = structuredClone(options.qualityIgnores ?? []);
    this.dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
    this.sharingan = sharinganReference !== null;
    this.sourceAuthority = sharinganReference === null ? null : {
      resourceId: sharinganReference.resourceId,
      revisionId: sharinganReference.revisionId,
      revisionChecksum: sharinganReference.revisionChecksum,
    };
  }

  async evaluate(input: {
    candidate: StandardArtifactCandidateIdentity;
    dir: string;
    round: number;
    signal: AbortSignal;
  }): Promise<StandardArtifactQualityResult> {
    this.validateEvaluationInput(input);
    checkAbort(input.signal);
    await this.assertExactCandidate(input.candidate, input.signal);
    checkAbort(input.signal);
    let captureDir: string;
    try {
      captureDir = await (this.dependencies.createCaptureDir?.()
        ?? mkdtemp(join(tmpdir(), "dezin-artifact-quality-")));
      checkAbort(input.signal);
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "evidence-unavailable",
        `Visual evidence scratch storage could not be allocated: ${error instanceof Error ? error.message : "storage failure"}`,
        "storage",
      );
    }
    const screenshotPath = join(captureDir, "screenshot.png");

    const reviewEnabled = this.settings.visualQaEnabled
      || this.infrastructure.claim.task.qaProfile.requireVisualReview
      || this.sharingan;
    // A Standard Artifact is never publishable from static inspection alone.
    // Always build/start the exact candidate and mount every immutable Frame;
    // the QA flags control critic review, not the execution-health baseline.
    const runtimeEnabled = true;
    const visualSettings = reviewEnabled && !this.settings.visualQaEnabled
      ? { ...this.settings, visualQaEnabled: true }
      : this.settings;
    const rawVisualFindings: QualityFinding[] = [];
    const durableEvidence: GenerationTaskVisualEvidenceDescriptor[] = [];
    let durableSourceEvidence: GenerationTaskSourceVisualEvidenceDescriptor | undefined;
    let frameResults: VisualQaReport["frames"] = [];
    let sourceCaptureResult: VisualQaSourceCaptureResult | undefined;
    let lease: PreviewLease | undefined;
    let primaryError: unknown = null;

    try {
      if (runtimeEnabled) {
        try {
          lease = requirePreviewLease(await this.dependencies.acquireRuntime({
            projectId: this.projectId,
            projectDir: input.dir,
            runtimeKey: [
              "artifact-quality",
              this.infrastructure.claim.task.id,
              this.infrastructure.claim.attempt.attempt,
              input.candidate.treeHash,
            ].join(":"),
            candidate: input.candidate,
            signal: input.signal,
          }), "Standard Artifact quality runtime");
          checkAbort(input.signal);
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          throw new ProductionStandardArtifactQualityEvaluatorError(
            "runtime-unavailable",
            `Visual QA could not open the exact candidate preview: ${error instanceof Error ? error.message : "dev server unavailable"}.`,
            "build-infrastructure",
          );
        }
        const reference = this.sharingan
          ? this.dependencies.sharinganReference(input.dir, {
              expectedRequestedUrl: this.expectedSharinganRequestedUrl,
              requireCurrentSchema: true,
            })
          : undefined;
        if (this.sharingan && !reference) {
          throw new ProductionStandardArtifactQualityEvaluatorError(
            "sharingan-evidence",
            "The exact Sharingan Capture Revision bundle is missing or invalid in the candidate worktree",
            "context",
          );
        }
        const attemptPrefix = `quality-round-${input.round}`;
        let report: VisualQaReport;
        try {
          report = await this.dependencies.visualQa({
            htmlPath: join(input.dir, "index.html"),
            projectRoot: input.dir,
            screenshotEvidenceRoot: captureDir,
            renderUrl: lease!.url,
            screenshotPath,
            settings: visualSettings,
            agentCommand: reviewerAgentCommand(visualSettings, this.agentCommand),
            model: reviewerModel(visualSettings, this.model, this.agentCommand),
            provider: providerFamily(getProvider(this.agentCommand)?.id, this.model),
            brief: this.payload.brief.proposalRationale,
            directionSpec: this.directionSpec,
            sharinganReference: reference,
            isSharingan: this.sharingan,
            conversationHistory: [],
            renderFrames: structuredClone(this.payload.responsiveFrames),
            signal: input.signal,
            frameAttemptIdPrefix: attemptPrefix,
            runtimeOnly: !reviewEnabled,
          });
          checkAbort(input.signal);
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          if (error instanceof ProductionStandardArtifactQualityEvaluatorError) throw error;
          throw new ProductionStandardArtifactQualityEvaluatorError(
            "visual-infrastructure",
            `Visual QA failed: ${error instanceof Error ? error.message : "unknown error"}.`,
            "build-infrastructure",
          );
        }
        rawVisualFindings.push(...canonicalFindings(report.findings));
        throwInfrastructureFinding(rawVisualFindings);
        frameResults = exactFrameResults(report, this.payload.responsiveFrames, attemptPrefix);
        sourceCaptureResult = exactSourceCaptureResult(
          report,
          attemptPrefix,
          screenshotPath,
          this.sharingan,
        );
        if (reviewEnabled && (!producedDesignReview(rawVisualFindings)
          || frameResults.some((frame) => !frame.reviewed))) {
          throw new ProductionStandardArtifactQualityEvaluatorError(
            "visual-infrastructure",
            "The visual reviewer did not assess every immutable Task Frame",
            "provider",
          );
        }
        const referenceAfter = this.sharingan
          ? this.dependencies.sharinganReference(input.dir, {
          expectedRequestedUrl: this.expectedSharinganRequestedUrl,
          requireCurrentSchema: true,
            })
          : undefined;
        if (this.sharingan && (!referenceAfter || !isDeepStrictEqual(referenceAfter, reference))) {
          throw new ProductionStandardArtifactQualityEvaluatorError(
            "sharingan-evidence",
            "The exact Sharingan Capture Revision bundle changed or disappeared during quality review",
            "context",
          );
        }
        // Runtime-only probes establish execution health but are not a design
        // review. Persist visual descriptors only when a reviewer actually
        // assessed every Frame; Core intentionally rejects visual evidence
        // without its matching visual-review authority.
        if (reviewEnabled) {
          const evidenceOwner = {
            projectId: this.projectId,
            workspaceId: this.infrastructure.claim.task.workspaceId,
            planId: this.infrastructure.claim.task.planId,
            taskId: this.infrastructure.claim.task.id,
            attempt: this.infrastructure.claim.attempt.attempt,
            candidateCommitHash: input.candidate.commitHash,
            candidateTreeHash: input.candidate.treeHash,
            contextPackId: this.infrastructure.contextPack.id,
            contextPackHash: this.infrastructure.contextPack.hash,
          };
          let sourcePersistenceInput: PersistGenerationTaskSourceVisualEvidenceInput | undefined;
          if (this.sharingan) {
            if (this.sourceAuthority === null) {
              throw new ProductionStandardArtifactQualityEvaluatorError(
                "invalid-input",
                "Sharingan quality evaluation has no exact source authority",
              );
            }
            sourcePersistenceInput = {
              dataDir: this.dataDir,
              owner: evidenceOwner,
              capture: {
                scope: "source",
                sourceAttemptId: sourceCaptureResult!.sourceAttemptId,
                width: sourceCaptureResult!.width,
                height: sourceCaptureResult!.height,
              },
              sourceAuthority: structuredClone(this.sourceAuthority),
              round: input.round,
              sourcePath: sourceCaptureResult!.screenshotPath!,
              expectedIdentity: sourceCaptureResult!.captureIdentity!,
            };
          }
          const framePersistenceInputs: PersistGenerationTaskVisualEvidenceInput[] = [];
          for (const [index, frame] of this.payload.responsiveFrames.entries()) {
            const result = frameResults[index]!;
            if (!result.screenshotPath) {
              throw new ProductionStandardArtifactQualityEvaluatorError(
                "evidence-unavailable",
                `Exact Frame ${frame.id} produced no durable screenshot source`,
                "storage",
              );
            }
            framePersistenceInputs.push({
              dataDir: this.dataDir,
              owner: evidenceOwner,
              frame: {
                ...structuredClone(frame),
                frameAttemptId: result.frameAttemptId,
              },
              round: input.round,
              sourcePath: result.screenshotPath,
              expectedIdentity: result.captureIdentity!,
            });
          }
          const persistBatch = this.dependencies.persistEvidenceBatch;
          if (persistBatch) {
            let batch: PersistGenerationTaskVisualEvidenceBatchResult;
            try {
              batch = await persistBatch({
                dataDir: this.dataDir,
                owner: evidenceOwner,
                round: input.round,
                signal: input.signal,
                frames: framePersistenceInputs.map((item) => ({
                  frame: item.frame,
                  sourcePath: item.sourcePath,
                  expectedIdentity: item.expectedIdentity,
                })),
                ...(sourcePersistenceInput === undefined ? {} : {
                  source: {
                    capture: sourcePersistenceInput.capture,
                    sourceAuthority: sourcePersistenceInput.sourceAuthority,
                    sourcePath: sourcePersistenceInput.sourcePath,
                    expectedIdentity: sourcePersistenceInput.expectedIdentity,
                  },
                }),
              });
            } catch (error) {
              if (input.signal.aborted) throw abortReason(input.signal);
              throw new ProductionStandardArtifactQualityEvaluatorError(
                "evidence-unavailable",
                `Visual evidence batch could not be retained: ${error instanceof Error ? error.message : "storage failure"}`,
                "storage",
              );
            }
            checkAbort(input.signal);
            if (batch.frames.length !== framePersistenceInputs.length
              || (sourcePersistenceInput === undefined) !== (batch.source === undefined)) {
              throw new ProductionStandardArtifactQualityEvaluatorError(
                "evidence-unavailable",
                "Visual evidence batch returned an incomplete descriptor set",
                "storage",
              );
            }
            for (const [index, persistenceInput] of framePersistenceInputs.entries()) {
              durableEvidence.push(exactEvidence(batch.frames[index]!, persistenceInput));
            }
            if (sourcePersistenceInput !== undefined) {
              durableSourceEvidence = exactSourceEvidence(batch.source!, sourcePersistenceInput);
            }
          } else {
            if (sourcePersistenceInput !== undefined) {
              const persistSourceEvidence = this.dependencies.persistSourceEvidence;
              if (!persistSourceEvidence) {
                throw new ProductionStandardArtifactQualityEvaluatorError(
                  "evidence-unavailable",
                  "Sharingan source visual evidence persistence is unavailable",
                  "storage",
                );
              }
              let descriptor: GenerationTaskSourceVisualEvidenceDescriptor | undefined;
              try {
                descriptor = await persistSourceEvidence(sourcePersistenceInput);
              } catch (error) {
                if (input.signal.aborted) throw abortReason(input.signal);
                throw new ProductionStandardArtifactQualityEvaluatorError(
                  "evidence-unavailable",
                  `Sharingan source visual evidence could not be retained: ${error instanceof Error ? error.message : "storage failure"}`,
                  "storage",
                );
              }
              checkAbort(input.signal);
              if (!descriptor) {
                throw new ProductionStandardArtifactQualityEvaluatorError(
                  "evidence-unavailable",
                  "Sharingan source visual evidence is empty or unavailable",
                  "storage",
                );
              }
              durableSourceEvidence = exactSourceEvidence(descriptor, sourcePersistenceInput);
            }
            for (const persistenceInput of framePersistenceInputs) {
              let descriptor: GenerationTaskVisualEvidenceDescriptor | undefined;
              try {
                descriptor = await this.dependencies.persistEvidence(persistenceInput);
              } catch (error) {
                if (input.signal.aborted) throw abortReason(input.signal);
                throw new ProductionStandardArtifactQualityEvaluatorError(
                  "evidence-unavailable",
                  `Visual evidence for Frame ${persistenceInput.frame.id} could not be retained: ${error instanceof Error ? error.message : "storage failure"}`,
                  "storage",
                );
              }
              checkAbort(input.signal);
              if (!descriptor) {
                throw new ProductionStandardArtifactQualityEvaluatorError(
                  "evidence-unavailable",
                  `Visual evidence for Frame ${persistenceInput.frame.id} is empty or unavailable`,
                  "storage",
                );
              }
              durableEvidence.push(exactEvidence(descriptor, persistenceInput));
            }
          }
        }
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      let cleanupError: unknown = null;
      try {
        await rm(captureDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
      try {
        await lease?.release();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== null && primaryError === null) {
        throw new ProductionStandardArtifactQualityEvaluatorError(
          "cleanup-failed",
          `Standard Artifact quality runtime cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`,
        );
      }
    }

    let staticFindings: QualityFinding[];
    try {
      const staticSurface = await this.dependencies.collectLintSurface(input.dir);
      checkAbort(input.signal);
      staticFindings = staticSurface.trim().length === 0
        ? []
        : canonicalFindings(this.dependencies.lint(staticSurface, {
            mode: "standard",
            provider: providerFamily(getProvider(this.agentCommand)?.id, this.model),
            isSharingan: this.sharingan,
          }));
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof ProductionStandardArtifactQualityEvaluatorError) throw error;
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "quality-infrastructure",
        `Static quality checks could not inspect the exact candidate: ${error instanceof Error ? error.message : "quality service unavailable"}`,
        "build-infrastructure",
      );
    }
    checkAbort(input.signal);
    await this.assertExactCandidate(input.candidate, input.signal);
    checkAbort(input.signal);
    const reviewed = producedDesignReview(rawVisualFindings);
    const visualFindings = markVisualReviewRound(
      actionableVisualFindings(rawVisualFindings),
      input.round,
    );
    const blocking = new Set(this.infrastructure.claim.task.qaProfile.blockingSeverities);
    const unsuppressed = [...staticFindings, ...visualFindings];
    const protectedFindings = unsuppressed.filter((item) => (
      blocking.has(item.severity)
      || isQualityInfrastructureFinding(item)
      || (this.infrastructure.claim.task.qaProfile.requireRuntimeChecks && runtimeFailed([item]))
      || (this.infrastructure.claim.task.qaProfile.requireVisualReview && item.id.startsWith("visual-"))
    ));
    const protectedSet = new Set(protectedFindings);
    const advisoryFindings = applyIgnores(
      unsuppressed.filter((item) => !protectedSet.has(item)),
      this.qualityIgnores.map((entry) => ({ ...entry })),
    );
    const findings = canonicalFindings([...protectedFindings, ...advisoryFindings]);
    const score = floorScore(findings);
    const profilePassed = !findings.some((item) => item.reviewStatus !== "resolved"
      && blocking.has(item.severity));
    const runtimePassed = !runtimeEnabled || (frameResults.length === this.payload.responsiveFrames.length
      && frameResults.every((frame) => frame.status === "passed")
      && !runtimeFailed(findings));
    const visualPassed = !reviewEnabled || (reviewed
      && !findings.some((item) => item.id.startsWith("visual-")
        && item.reviewStatus !== "resolved"
        && (this.sharingan || blocking.has(item.severity) || isQualityInfrastructureFinding(item))));
    const passed = standardRunPassed(findings, this.sharingan)
      && profilePassed
      && runtimePassed
      && (!this.infrastructure.claim.task.qaProfile.requireVisualReview || visualPassed)
      && (!this.sharingan || visualPassed);
    const activeFindings = findings.filter((item) => item.reviewStatus !== "resolved");
    const qualityState = activeFindings.length === 0
      ? passed ? "passed" : "failed"
      : passed
        ? "needs-attention"
        : "failed";
    const gateEvidence: Record<string, unknown> = {
      protocol: "dezin.standard-artifact-quality.v1",
      candidate: structuredClone(input.candidate),
      contextPack: {
        id: this.infrastructure.contextPack.id,
        hash: this.infrastructure.contextPack.hash,
      },
      frames: structuredClone(this.payload.responsiveFrames),
      frameResults: frameResults.map((frame) => ({
        frameId: frame.frameId,
        frameAttemptId: frame.frameAttemptId,
        width: frame.width,
        height: frame.height,
        status: frame.status,
        reviewed: frame.reviewed,
        ...(frame.captureIdentity ? { captureIdentity: structuredClone(frame.captureIdentity) } : {}),
      })),
      round: input.round,
      ...(runtimeEnabled ? {
        runtimeChecks: this.payload.responsiveFrames.map((frame, index) => ({
          id: `frame:${frame.id}`,
          status: frameResults[index]?.status === "passed" ? "passed" : "failed",
        })),
      } : {}),
      ...(reviewEnabled ? {
        visualReview: {
          status: visualPassed ? "passed" : "failed",
          fidelity: reviewed ? score / 100 : 0,
          evidence: durableEvidence.map((descriptor) => ({
            frameId: descriptor.frame.id,
            frameAttemptId: descriptor.frame.frameAttemptId,
            sha256: descriptor.sha256,
            byteLength: descriptor.byteLength,
            storageKey: descriptor.storageKey,
          })),
          ...(durableSourceEvidence ? {
            sourceEvidence: {
              scope: durableSourceEvidence.capture.scope,
              sourceAttemptId: durableSourceEvidence.capture.sourceAttemptId,
              width: durableSourceEvidence.capture.width,
              height: durableSourceEvidence.capture.height,
              sha256: durableSourceEvidence.sha256,
              byteLength: durableSourceEvidence.byteLength,
              storageKey: durableSourceEvidence.storageKey,
            },
          } : {}),
        },
      } : {}),
      ...(durableEvidence.length > 0 ? { visualEvidence: durableEvidence } : {}),
      ...(sourceCaptureResult ? {
        sourceCaptureResult: {
          scope: sourceCaptureResult.scope,
          sourceAttemptId: sourceCaptureResult.sourceAttemptId,
          width: sourceCaptureResult.width,
          height: sourceCaptureResult.height,
          status: sourceCaptureResult.status,
          reviewed: sourceCaptureResult.reviewed,
          captureIdentity: structuredClone(sourceCaptureResult.captureIdentity!),
        },
      } : {}),
      ...(durableSourceEvidence ? { sourceVisualEvidence: durableSourceEvidence } : {}),
    };
    return {
      passed,
      score,
      renderSpec: { frames: structuredClone(this.payload.responsiveFrames) },
      quality: {
        state: qualityState,
        score,
        findings,
      },
      evidence: gateEvidence,
      repairFindings: repairFindings(
        findings,
        this.sharingan,
        this.infrastructure.claim.task.qaProfile.blockingSeverities,
      ).map((finding) => ({ ...finding })),
    };
  }

  private validateEvaluationInput(input: {
    candidate: StandardArtifactCandidateIdentity;
    dir: string;
    round: number;
    signal: AbortSignal;
  }): void {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.dir !== "string"
      || resolve(input.dir) !== resolve(this.infrastructure.worktreeDir)
      || !Number.isSafeInteger(input.round) || input.round < 0
      || !input.signal || typeof input.signal.aborted !== "boolean"
      || !GIT_OBJECT_ID.test(input.candidate?.commitHash)
      || !GIT_OBJECT_ID.test(input.candidate?.treeHash)) {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "invalid-input",
        "Standard Artifact quality evaluation input does not match its owned worktree",
      );
    }
  }

  private async assertExactCandidate(
    candidate: StandardArtifactCandidateIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const inspected = await this.dependencies.inspectCandidate({
      repositoryDir: this.infrastructure.repositoryDir,
      worktreeDir: this.infrastructure.worktreeDir,
      candidate,
      immutableSharinganSidecar: this.sharingan,
      signal,
    });
    checkAbort(signal);
    if (inspected.commitHash !== candidate.commitHash || inspected.treeHash !== candidate.treeHash) {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "candidate-mismatch",
        "Standard Artifact quality evaluator observed a substituted candidate object",
      );
    }
    if (inspected.status !== "") {
      throw new ProductionStandardArtifactQualityEvaluatorError(
        "source-dirty",
        "Standard Artifact candidate source is not a clean, self-contained immutable tree",
      );
    }
  }
}
