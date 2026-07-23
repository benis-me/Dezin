import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type {
  ArtifactCandidateRefRecoveryEntry,
  ArtifactRevisionRecord,
  GenerationTaskAttemptClaim,
} from "../../../packages/core/src/index.ts";
import { generationTaskCandidateEvidenceHash } from "../../../packages/core/src/index.ts";
import {
  ArtifactCandidateRetentionError,
  GitArtifactCandidateRetention,
  artifactCandidateRetentionDescriptor,
} from "../src/orchestration/artifact-candidate-retention.ts";
import { generationTaskVisualEvidenceFrameStorageSegment } from "../src/orchestration/generation-task-visual-evidence.ts";
import { stableStringify } from "../src/context/context-types.ts";
import { createArtifactCandidateRefRecovery } from "../src/orchestration/artifact-candidate-ref-recovery-adapter.ts";
import { MAX_PNG_EVIDENCE_BYTES } from "../src/png-evidence.ts";
import {
  artifactCandidateAttemptRef,
  artifactRevisionEvidenceRef,
  artifactRevisionHistoryRef,
  artifactRevisionRef,
  beginArtifactCandidateTransaction,
  type ArtifactCandidateAttempt,
  type ArtifactCandidateIdentity,
} from "../src/orchestration/artifact-candidate-transaction.ts";
import { sharinganFixturePng } from "./support/sharingan-capture-fixture.ts";

const SOURCE_AUTHORITY = Object.freeze({
  resourceId: "resource-sharingan-1",
  revisionId: "resource-revision-sharingan-1",
  revisionChecksum: "9".repeat(64),
});

const EVIDENCE_FRAME = Object.freeze({
  id: "desktop",
  name: "Desktop",
  width: 1_440,
  height: 900,
});
const EVIDENCE_PNG = sharinganFixturePng(EVIDENCE_FRAME.width, EVIDENCE_FRAME.height);
const EVIDENCE_PNG_SHA256 = createHash("sha256").update(EVIDENCE_PNG).digest("hex");

function writeEvidenceFile(dataDir: string | undefined, storageKey: string): void {
  if (dataDir === undefined) return;
  const path = join(dataDir, ...storageKey.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, EVIDENCE_PNG);
}

function retention(
  root: string,
  sourceAuthorityForRevision: ConstructorParameters<typeof GitArtifactCandidateRetention>[0]["sourceAuthorityForRevision"]
    = () => SOURCE_AUTHORITY,
): GitArtifactCandidateRetention {
  return new GitArtifactCandidateRetention({
    repositoryDirForWorkspace: () => root,
    dataDir: root,
    sourceAuthorityForRevision,
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function refExists(cwd: string, ref: string): boolean {
  return spawnSync("git", ["rev-parse", "--verify", ref], { cwd, stdio: "ignore" }).status === 0;
}

function fixture(): {
  root: string;
  attempt: ArtifactCandidateAttempt;
} {
  const root = mkdtempSync(join(tmpdir(), "dezin-artifact-retention-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  writeFileSync(join(root, "page.txt"), "base\n");
  git(root, "add", "page.txt");
  git(root, "commit", "-q", "-m", "base");
  return {
    root,
    attempt: {
      workspaceId: "workspace-1",
      taskId: "task-page-1",
      attempt: 1,
      inputHash: "a".repeat(64),
      createdAt: 1_700_000_000_000,
      sourceCommitHash: git(root, "rev-parse", "HEAD"),
      sourceTreeHash: git(root, "rev-parse", "HEAD^{tree}"),
    },
  };
}

function claim(
  attempt: ArtifactCandidateAttempt,
  options: {
    executionMode?: "full" | "publication-only";
    attemptNumber?: number;
    candidateEvidence?: Record<string, unknown>;
    frame?: typeof EVIDENCE_FRAME | {
      id: string;
      name: string;
      width: number;
      height: number;
      initialState?: string;
      fixture?: Record<string, unknown>;
      background?: string;
    };
  } = {},
): GenerationTaskAttemptClaim {
  const attemptNumber = options.attemptNumber ?? attempt.attempt;
  const executionMode = options.executionMode ?? "full";
  const candidateEvidence = executionMode === "publication-only"
    ? (options.candidateEvidence ?? null)
    : null;
  const candidateRevisionId = executionMode === "publication-only" ? "revision-page-1" : null;
  return {
    task: {
      id: attempt.taskId,
      planId: "plan-1",
      workspaceId: attempt.workspaceId,
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: attempt.workspaceId,
        id: "artifact-page-1",
        trackId: "track-main",
      },
      payload: {
        responsiveFrames: [options.frame ?? EVIDENCE_FRAME],
      },
      qaProfile: {
        requiredFrameIds: [(options.frame ?? EVIDENCE_FRAME).id],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
    },
    attempt: {
      taskId: attempt.taskId,
      planId: "plan-1",
      workspaceId: attempt.workspaceId,
      attempt: attemptNumber,
      executionMode,
      attemptOrigin: executionMode === "publication-only" ? "publication-retry" : "materialized",
      predecessorAttempt: executionMode === "publication-only" ? attemptNumber - 1 : null,
      automaticRetryIndex: executionMode === "publication-only" ? 1 : 0,
      inputHash: executionMode === "publication-only" ? "b".repeat(64) : attempt.inputHash,
      createdAt: executionMode === "publication-only" ? attempt.createdAt + 1 : attempt.createdAt,
      sourceCommitHash: attempt.sourceCommitHash,
      sourceTreeHash: attempt.sourceTreeHash,
      contextPackId: `context-pack-${"c".repeat(64)}`,
      resourcePins: [{
        resourceId: SOURCE_AUTHORITY.resourceId,
        revisionId: SOURCE_AUTHORITY.revisionId,
      }],
      candidateRevisionId,
      candidateResourceRevisionId: null,
      candidateEvidence,
      candidateEvidenceHash: candidateEvidence === null ? null : generationTaskCandidateEvidenceHash({
        taskId: attempt.taskId,
        planId: "plan-1",
        workspaceId: attempt.workspaceId,
        attempt: attemptNumber,
        candidateRevisionId,
        candidateResourceRevisionId: null,
        candidateEvidence,
      }),
      target: {
        type: "artifact",
        workspaceId: attempt.workspaceId,
        id: "artifact-page-1",
        trackId: "track-main",
      },
    },
  } as unknown as GenerationTaskAttemptClaim;
}

function revision(candidate: ArtifactCandidateIdentity): ArtifactRevisionRecord {
  return {
    id: "revision-page-1",
    workspaceId: "workspace-1",
    artifactId: "artifact-page-1",
    trackId: "track-main",
    sequence: 1,
    parentRevisionId: null,
    sourceCommitHash: candidate.commitHash,
    sourceTreeHash: candidate.treeHash,
    artifactRoot: ".",
    kernelRevisionId: "kernel-1",
    renderSpec: { frames: [] },
    quality: { state: "passed", score: 98, findings: [] },
    contextPackHash: "c".repeat(64),
    producedByRunId: null,
    legacyRunId: null,
    createdAt: 1_700_000_000_100,
  };
}

function evidence(
  attempt: ArtifactCandidateAttempt,
  selected: ArtifactCandidateIdentity,
  versions: readonly ArtifactCandidateIdentity[] = [selected],
  dataDir?: string,
  frame: typeof EVIDENCE_FRAME | {
    id: string;
    name: string;
    width: number;
    height: number;
    initialState?: string;
    fixture?: Record<string, unknown>;
    background?: string;
  } = EVIDENCE_FRAME,
): Record<string, unknown> {
  const selectedRound = versions.findIndex((version) => (
    version.commitHash === selected.commitHash && version.treeHash === selected.treeHash
  ));
  assert.notEqual(selectedRound, -1);
  const manifests = versions.map((version, round) => {
    const candidate = { commitHash: version.commitHash, treeHash: version.treeHash };
    const passed = round === selectedRound;
    const frameAttemptId = `quality-round-${round}-frame-0`;
    const sourceAttemptId = `quality-round-${round}-source`;
    const frameSha = EVIDENCE_PNG_SHA256;
    const sourceSha = EVIDENCE_PNG_SHA256;
    const owner = {
      projectId: "project-1",
      workspaceId: attempt.workspaceId,
      planId: "plan-1",
      taskId: attempt.taskId,
      attempt: attempt.attempt,
      candidateCommitHash: version.commitHash,
      candidateTreeHash: version.treeHash,
      contextPackId: `context-pack-${"c".repeat(64)}`,
      contextPackHash: "c".repeat(64),
    };
    const frameStorageKey = [
      "generation-task-evidence",
      owner.projectId,
      owner.workspaceId,
      owner.planId,
      owner.taskId,
      `attempt-${owner.attempt}`,
      "visual",
      `round-${round}-${generationTaskVisualEvidenceFrameStorageSegment(frame.id)}-${frameSha}.png`,
    ].join("/");
    const sourceStorageKey = [
      "generation-task-evidence",
      owner.projectId,
      owner.workspaceId,
      owner.planId,
      owner.taskId,
      `attempt-${owner.attempt}`,
      "visual",
      `round-${round}-source-${sourceSha}.png`,
    ].join("/");
    writeEvidenceFile(dataDir, frameStorageKey);
    writeEvidenceFile(dataDir, sourceStorageKey);
    const reviewSummary = {
      status: passed ? "passed" : "failed",
      fidelity: passed ? 0.98 : 0.4,
      evidence: [{
        frameId: frame.id,
        frameAttemptId,
        sha256: frameSha,
        byteLength: EVIDENCE_PNG.byteLength,
        storageKey: frameStorageKey,
      }],
      sourceEvidence: {
        scope: "source",
        sourceAttemptId,
        width: frame.width,
        height: frame.height,
        sha256: sourceSha,
        byteLength: EVIDENCE_PNG.byteLength,
        storageKey: sourceStorageKey,
      },
    };
    return {
      protocol: "dezin.artifact-run-evaluation-manifest.v1",
      candidate,
      round,
      passed,
      score: passed ? 98 : 80,
      qualityState: passed ? "passed" : "failed",
      findingsDigest: createHash("sha256")
        .update(stableStringify(passed ? [] : [{ id: "failed-round" }]))
        .digest("hex"),
      frameResults: [{
        frameId: frame.id,
        frameAttemptId,
        width: frame.width,
        height: frame.height,
        status: passed ? "passed" : "failed",
        reviewed: true,
        captureIdentity: {
          sha256: frameSha,
          byteLength: EVIDENCE_PNG.byteLength,
          width: EVIDENCE_FRAME.width,
          height: EVIDENCE_FRAME.height,
        },
      }],
      runtimeChecks: [{ id: `frame:${frame.id}`, status: passed ? "passed" : "failed" }],
      reviewSummary,
      visualEvidence: [{
        protocol: "dezin.generation-task-visual-evidence.v1",
        owner,
        frame: { ...frame, frameAttemptId },
        round,
        mediaType: "image/png",
        sha256: frameSha,
        byteLength: EVIDENCE_PNG.byteLength,
        storageKey: frameStorageKey,
      }],
      sourceCaptureResult: {
        scope: "source",
        sourceAttemptId,
        width: frame.width,
        height: frame.height,
        status: passed ? "passed" : "failed",
        reviewed: true,
        captureIdentity: {
          sha256: sourceSha,
          byteLength: EVIDENCE_PNG.byteLength,
          width: EVIDENCE_FRAME.width,
          height: EVIDENCE_FRAME.height,
        },
      },
      sourceVisualEvidence: {
        protocol: "dezin.generation-task-source-visual-evidence.v1",
        owner,
        capture: {
          scope: "source",
          sourceAttemptId,
          width: frame.width,
          height: frame.height,
        },
        sourceAuthority: SOURCE_AUTHORITY,
        round,
        mediaType: "image/png",
        sha256: sourceSha,
        byteLength: EVIDENCE_PNG.byteLength,
        storageKey: sourceStorageKey,
      },
    };
  });
  const selectedManifest = manifests[selectedRound]!;
  const runtimeChecks = structuredClone(selectedManifest.runtimeChecks);
  const visualReview = structuredClone(selectedManifest.reviewSummary);
  const qualityEvidence = {
    protocol: "dezin.standard-artifact-quality.v1",
    candidate: { commitHash: selected.commitHash, treeHash: selected.treeHash },
    contextPack: { id: `context-pack-${"c".repeat(64)}`, hash: "c".repeat(64) },
    frames: [frame],
    frameResults: structuredClone(selectedManifest.frameResults),
    round: selectedRound,
    runtimeChecks: structuredClone(runtimeChecks),
    visualReview: structuredClone(visualReview),
    visualEvidence: structuredClone(selectedManifest.visualEvidence),
    sourceCaptureResult: structuredClone(selectedManifest.sourceCaptureResult),
    sourceVisualEvidence: structuredClone(selectedManifest.sourceVisualEvidence),
  };
  return {
    runtimeChecks,
    visualReview,
    protocol: "dezin.artifact-run.v1",
    projectId: "project-1",
    taskId: attempt.taskId,
    planId: "plan-1",
    workspaceId: attempt.workspaceId,
    attempt: attempt.attempt,
    attemptCreatedAt: attempt.createdAt,
    inputHash: attempt.inputHash,
    contextPackId: `context-pack-${"c".repeat(64)}`,
    contextPackHash: "c".repeat(64),
    sourceBase: {
      commitHash: attempt.sourceCommitHash,
      treeHash: attempt.sourceTreeHash,
    },
    candidateRetentionRef: artifactCandidateAttemptRef(attempt),
    selectedRound,
    versions: versions.map((version, round) => ({
      round,
      commitHash: version.commitHash,
      treeHash: version.treeHash,
      passed: round === selectedRound,
      score: round === selectedRound ? 98 : 80,
      evaluationManifest: manifests[round],
    })),
    qualityEvidence,
  };
}

function retainedEvidenceStorageKey(
  value: Record<string, unknown>,
  round: number,
  scope: "frame" | "source",
): string {
  const version = (value.versions as Array<Record<string, unknown>>)[round]!;
  const manifest = version.evaluationManifest as Record<string, unknown>;
  const descriptor = scope === "frame"
    ? (manifest.visualEvidence as Array<Record<string, unknown>>)[0]!
    : manifest.sourceVisualEvidence as Record<string, unknown>;
  return String(descriptor.storageKey);
}

function recoveryEntry(
  attempt: ArtifactCandidateAttempt,
  artifactRevision: ArtifactRevisionRecord,
  candidateEvidence = evidence(attempt, {
    commitHash: artifactRevision.sourceCommitHash,
    treeHash: artifactRevision.sourceTreeHash,
  }),
): ArtifactCandidateRefRecoveryEntry {
  const source = claim(attempt);
  return {
    retentionKind: "retained-candidate",
    task: source.task,
    attempt: {
      ...source.attempt,
      status: "succeeded",
      candidateRevisionId: artifactRevision.id,
      candidateResourceRevisionId: null,
      candidateEvidence,
      candidateEvidenceHash: generationTaskCandidateEvidenceHash({
        taskId: source.task.id,
        planId: source.task.planId,
        workspaceId: source.task.workspaceId,
        attempt: source.attempt.attempt,
        candidateRevisionId: artifactRevision.id,
        candidateResourceRevisionId: null,
        candidateEvidence,
      }),
      materializationSealed: true,
      lease: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: attempt.createdAt + 100,
    },
    revision: artifactRevision,
  } as ArtifactCandidateRefRecoveryEntry;
}

function orphanRecoveryEntry(
  attempt: ArtifactCandidateAttempt,
): ArtifactCandidateRefRecoveryEntry {
  const source = claim(attempt);
  return {
    retentionKind: "orphan-attempt",
    task: source.task,
    attempt: {
      ...source.attempt,
      status: "failed",
      candidateRevisionId: null,
      candidateResourceRevisionId: null,
      candidateEvidence: null,
      candidateEvidenceHash: null,
      materializationSealed: true,
      lease: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: attempt.createdAt + 100,
    },
    revision: null,
  } as ArtifactCandidateRefRecoveryEntry;
}

test("retention validates every bounded evaluation manifest and selected quality binding", async (t) => {
  const input = fixture();
  try {
    const failed = { commitHash: "d".repeat(40), treeHash: "e".repeat(40) };
    const selected = { commitHash: "f".repeat(40), treeHash: "0".repeat(40) };
    const exactEvidence = evidence(input.attempt, selected, [failed, selected]);
    const subject = {
      task: claim(input.attempt).task,
      attempt: claim(input.attempt).attempt,
      artifactRevision: revision(selected),
      evidence: exactEvidence,
    };

    assert.doesNotThrow(() => artifactCandidateRetentionDescriptor(subject));

    const cases: Array<{ name: string; mutate(value: Record<string, unknown>): void }> = [
      {
        name: "failed manifest removed",
        mutate(value) {
          delete ((value.versions as Array<Record<string, unknown>>)[0]!).evaluationManifest;
        },
      },
      {
        name: "failed required visual audit group removed",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          delete manifest.reviewSummary;
          delete manifest.visualEvidence;
          delete manifest.sourceCaptureResult;
          delete manifest.sourceVisualEvidence;
        },
      },
      {
        name: "failed required runtime checks removed",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          delete manifest.runtimeChecks;
        },
      },
      {
        name: "failed manifest round substituted",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          manifest.round = 1;
        },
      },
      {
        name: "failed Frame owner substituted",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          const descriptor = (manifest.visualEvidence as Array<Record<string, unknown>>)[0]!;
          (descriptor.owner as Record<string, unknown>).candidateCommitHash = selected.commitHash;
        },
      },
      {
        name: "failed source storage key substituted",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          (manifest.sourceVisualEvidence as Record<string, unknown>).storageKey = "generation-task-evidence/tampered.png";
        },
      },
      {
        name: "failed source authority is unrelated to immutable Resource pins",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          const descriptor = manifest.sourceVisualEvidence as Record<string, unknown>;
          descriptor.sourceAuthority = {
            ...descriptor.sourceAuthority as Record<string, unknown>,
            resourceId: "resource-sharingan-foreign",
          };
        },
      },
      {
        name: "source authority changes between retained rounds",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          const descriptor = manifest.sourceVisualEvidence as Record<string, unknown>;
          descriptor.sourceAuthority = {
            ...descriptor.sourceAuthority as Record<string, unknown>,
            revisionChecksum: "8".repeat(64),
          };
        },
      },
      {
        name: "selected source authority substitution remains invalid when manifest and quality agree",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[1]!)
            .evaluationManifest as Record<string, unknown>;
          const authority = {
            ...((manifest.sourceVisualEvidence as Record<string, unknown>)
              .sourceAuthority as Record<string, unknown>),
            revisionId: "resource-revision-sharingan-foreign",
          };
          (manifest.sourceVisualEvidence as Record<string, unknown>).sourceAuthority = authority;
          const qualityEvidence = value.qualityEvidence as Record<string, unknown>;
          (qualityEvidence.sourceVisualEvidence as Record<string, unknown>).sourceAuthority = {
            ...authority,
          };
        },
      },
      {
        name: "failed Frame descriptor diverges from immutable Task Frame",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          const descriptor = (manifest.visualEvidence as Array<Record<string, unknown>>)[0]!;
          (descriptor.frame as Record<string, unknown>).name = "Substituted";
        },
      },
      {
        name: "failed Frame capture identity diverges from review summary",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          const result = (manifest.frameResults as Array<Record<string, unknown>>)[0]!;
          (result.captureIdentity as Record<string, unknown>).sha256 = "0".repeat(64);
        },
      },
      {
        name: "selected review diverges from top-level quality evidence",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[1]!)
            .evaluationManifest as Record<string, unknown>;
          manifest.reviewSummary = {
            ...(manifest.reviewSummary as Record<string, unknown>),
            status: "failed",
          };
        },
      },
      {
        name: "selected manifest removed",
        mutate(value) {
          delete ((value.versions as Array<Record<string, unknown>>)[1]!).evaluationManifest;
        },
      },
      {
        name: "unbounded Frame descriptor list",
        mutate(value) {
          const manifest = ((value.versions as Array<Record<string, unknown>>)[0]!)
            .evaluationManifest as Record<string, unknown>;
          manifest.visualEvidence = Array.from(
            { length: 65 },
            () => structuredClone((manifest.visualEvidence as Array<Record<string, unknown>>)[0]),
          );
        },
      },
    ];
    for (const entry of cases) {
      await t.test(entry.name, () => {
        const tampered = structuredClone(exactEvidence);
        entry.mutate(tampered);
        assert.throws(
          () => artifactCandidateRetentionDescriptor({ ...subject, evidence: tampered }),
          ArtifactCandidateRetentionError,
        );
      });
    }
    await t.test("nested accessors fail closed without invocation", () => {
      const hostile = structuredClone(exactEvidence);
      const manifest = ((hostile.versions as Array<Record<string, unknown>>)[0]!)
        .evaluationManifest as Record<string, unknown>;
      let invoked = false;
      Object.defineProperty(manifest, "hostile", {
        enumerable: true,
        get() {
          invoked = true;
          return true;
        },
      });
      assert.throws(
        () => artifactCandidateRetentionDescriptor({ ...subject, evidence: hostile }),
        ArtifactCandidateRetentionError,
      );
      assert.equal(invoked, false);
    });
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("production Artifact ref recovery releases an exact redundant Attempt ref and restart is idempotent", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const artifactRevision = revision(candidate);
    const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
    const candidateRetention = retention(input.root);
    const publicationReceipt = await candidateRetention.promote({
      claim: claim(input.attempt),
      artifactRevision,
      evidence: candidateEvidence,
    }, new AbortController().signal);
    const entries = [recoveryEntry(input.attempt, artifactRevision, candidateEvidence)];
    const requestedLimits: number[] = [];
    const cleanupInputs: unknown[] = [];
    const createRecovery = () => createArtifactCandidateRefRecovery({
      store: {
        listArtifactCandidateRefRecoveryEntries(limit) {
          requestedLimits.push(limit);
          return { entries, nextCursor: null };
        },
      },
      repositoryDirForWorkspace: () => input.root,
      limit: 17,
      evidenceLifecycle: {
        async quarantineDurablePublishedEvidence(cleanupInput) {
          cleanupInputs.push(cleanupInput);
          return {
            scanned: 0,
            retained: 0,
            quarantined: 0,
            restored: 0,
            removed: 0,
            failed: 0,
          };
        },
      },
    });

    const first = await createRecovery().recover(new AbortController().signal);
    const afterRestart = await createRecovery().recover(new AbortController().signal);

    assert.deepEqual(requestedLimits, [17, 17]);
    assert.equal(first.released, 1);
    assert.equal(afterRestart.alreadyReleased, 1);
    assert.deepEqual(cleanupInputs, [
      {
        projectId: publicationReceipt.subject.projectId,
        workspaceId: publicationReceipt.subject.workspaceId,
        planId: entries[0]!.task.planId,
        taskId: publicationReceipt.subject.attempt.taskId,
        attempt: publicationReceipt.subject.attempt.attempt,
        receipt: publicationReceipt,
      },
      {
        projectId: publicationReceipt.subject.projectId,
        workspaceId: publicationReceipt.subject.workspaceId,
        planId: entries[0]!.task.planId,
        taskId: publicationReceipt.subject.attempt.taskId,
        attempt: publicationReceipt.subject.attempt.attempt,
        receipt: publicationReceipt,
      },
    ]);
    assert.equal(refExists(input.root, transaction.attemptRef), false);
    assert.equal(git(input.root, "rev-parse", artifactRevisionRef(artifactRevision.id)), candidate.commitHash);
    assert.equal(git(input.root, "rev-parse", artifactRevisionHistoryRef(artifactRevision.id)), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("needs-rebase ref recovery preserves mutable evidence for publication-only retry", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: input.root,
    attempt: input.attempt,
  });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate before publication crash\n");
    const candidate = await transaction.commit("generate before publication crash", new AbortController().signal);
    await transaction.dispose();
    const artifactRevision = revision(candidate);
    const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
    const candidateRetention = retention(input.root);
    const retentionInput = {
      claim: claim(input.attempt),
      artifactRevision,
      evidence: candidateEvidence,
    };
    const receipt = await candidateRetention.promote(
      retentionInput,
      new AbortController().signal,
    );
    await candidateRetention.release(
      retentionInput,
      receipt,
      new AbortController().signal,
    );
    const entry = recoveryEntry(input.attempt, artifactRevision, candidateEvidence);
    entry.attempt.status = "needs-rebase";
    let cleanupCalls = 0;
    const recovery = createArtifactCandidateRefRecovery({
      store: {
        listArtifactCandidateRefRecoveryEntries: () => ({ entries: [entry], nextCursor: null }),
      },
      repositoryDirForWorkspace: () => input.root,
      evidenceLifecycle: {
        async quarantineDurablePublishedEvidence() {
          cleanupCalls += 1;
          unlinkSync(join(
            input.root,
            ...retainedEvidenceStorageKey(candidateEvidence, 0, "frame").split("/"),
          ));
          unlinkSync(join(
            input.root,
            ...retainedEvidenceStorageKey(candidateEvidence, 0, "source").split("/"),
          ));
          return {
            scanned: 2,
            retained: 0,
            quarantined: 2,
            restored: 0,
            removed: 0,
            failed: 0,
          };
        },
      },
    });

    const recovered = await recovery.recover(new AbortController().signal);
    assert.equal(recovered.alreadyReleased, 1);
    assert.equal(cleanupCalls, 0);

    const publicationRetryInput = {
      claim: claim(input.attempt, {
        executionMode: "publication-only",
        attemptNumber: 2,
        candidateEvidence,
      }),
      artifactRevision,
      evidence: candidateEvidence,
    };
    assert.deepEqual(
      await candidateRetention.promote(publicationRetryInput, new AbortController().signal),
      receipt,
    );
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("production Artifact ref recovery reports post-release evidence cleanup failure without changing success", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const artifactRevision = revision(candidate);
    const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
    const candidateRetention = retention(input.root);
    await candidateRetention.promote({
      claim: claim(input.attempt),
      artifactRevision,
      evidence: candidateEvidence,
    }, new AbortController().signal);
    const cleanupError = new Error("simulated durable cache quarantine failure");
    const reported: Array<{ error: unknown; taskId: string; attempt: number; revisionId: string }> = [];
    const recovery = createArtifactCandidateRefRecovery({
      store: { listArtifactCandidateRefRecoveryEntries: () => ({
        entries: [recoveryEntry(input.attempt, artifactRevision, candidateEvidence)],
        nextCursor: null,
      }) },
      repositoryDirForWorkspace: () => input.root,
      evidenceLifecycle: {
        async quarantineDurablePublishedEvidence() {
          throw cleanupError;
        },
      },
      reportEvidenceCleanupError(error, identity) {
        reported.push({ error, ...identity });
        throw new Error("observer failure must also be isolated");
      },
    });

    const summary = await recovery.recover(new AbortController().signal);

    assert.equal(summary.released, 1);
    assert.deepEqual(reported, [{
      error: cleanupError,
      taskId: input.attempt.taskId,
      attempt: input.attempt.attempt,
      revisionId: artifactRevision.id,
    }]);
    assert.equal(refExists(input.root, transaction.attemptRef), false);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("production Artifact ref recovery cleans a committed orphan Attempt after abort-before-Core-stage and restart is idempotent", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate then abort\n");
    const candidate = await transaction.commit("generate before abort", new AbortController().signal);
    await transaction.dispose();
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);

    const entries = [orphanRecoveryEntry(input.attempt)];
    let publishedEvidenceCleanupCalls = 0;
    const createRecovery = () => createArtifactCandidateRefRecovery({
      store: { listArtifactCandidateRefRecoveryEntries: () => ({ entries, nextCursor: null }) },
      repositoryDirForWorkspace: () => input.root,
      evidenceLifecycle: {
        async quarantineDurablePublishedEvidence() {
          publishedEvidenceCleanupCalls += 1;
          return {
            scanned: 0,
            retained: 0,
            quarantined: 0,
            restored: 0,
            removed: 0,
            failed: 0,
          };
        },
      },
    });

    const first = await createRecovery().recover(new AbortController().signal);
    assert.equal(first.released, 1);
    assert.equal(refExists(input.root, transaction.attemptRef), false);

    const afterRestart = await createRecovery().recover(new AbortController().signal);
    assert.equal(afterRestart.alreadyReleased, 1);
    assert.equal(publishedEvidenceCleanupCalls, 0);
    assert.equal(refExists(input.root, transaction.attemptRef), false);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("production Artifact ref recovery retains the Attempt unless all three Revision retention refs are exact", async (t) => {
  const cases = [
    { mode: "selected-missing", expected: "revision-ref-missing" },
    { mode: "selected-conflicting", expected: "revision-ref-conflict" },
    { mode: "history-missing", expected: "revision-history-ref-missing" },
    { mode: "history-conflicting", expected: "revision-history-ref-conflict" },
    { mode: "evidence-missing", expected: "revision-evidence-ref-missing" },
    { mode: "evidence-conflicting", expected: "revision-evidence-ref-conflict" },
  ] as const;
  for (const { mode, expected } of cases) {
    await t.test(mode, async () => {
      const input = fixture();
      const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
      try {
        writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
        const candidate = await transaction.commit("generate", new AbortController().signal);
        await transaction.dispose();
        const artifactRevision = revision(candidate);
        const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
        const candidateRetention = retention(input.root);
        const receipt = await candidateRetention.promote({
          claim: claim(input.attempt),
          artifactRevision,
          evidence: candidateEvidence,
        }, new AbortController().signal);
        const selectedRef = artifactRevisionRef(artifactRevision.id);
        const historyRef = artifactRevisionHistoryRef(artifactRevision.id);
        const targetRef = mode.startsWith("selected")
          ? selectedRef
          : mode.startsWith("history")
            ? historyRef
            : artifactRevisionEvidenceRef(artifactRevision.workspaceId, artifactRevision.id);
        const exactOld = mode.startsWith("evidence") ? receipt.commitHash : candidate.commitHash;
        if (mode.endsWith("missing")) {
          git(input.root, "update-ref", "-d", targetRef, exactOld);
        } else {
          git(input.root, "update-ref", targetRef, input.attempt.sourceCommitHash, exactOld);
        }
        const events: Array<{ outcome: string; reason: string | null }> = [];
        const recovery = createArtifactCandidateRefRecovery({
          store: { listArtifactCandidateRefRecoveryEntries: () => ({
            entries: [recoveryEntry(input.attempt, artifactRevision, candidateEvidence)],
            nextCursor: null,
          }) },
          repositoryDirForWorkspace: () => input.root,
          observe: ({ outcome, reason }) => events.push({ outcome, reason }),
        });

        const summary = await recovery.recover(new AbortController().signal);

        assert.equal(summary.retained, 1);
        assert.equal(summary.released, 0);
        assert.deepEqual(events, [{ outcome: "retained", reason: expected }]);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      } finally {
        await transaction.dispose();
        rmSync(input.root, { recursive: true, force: true });
      }
    });
  }
});

test("production Artifact ref recovery rejects incoherent Core identity and tampered origin evidence without deleting a ref", async (t) => {
  const cases: Array<{
    name: string;
    mutate(entry: ArtifactCandidateRefRecoveryEntry): void;
    expected: "skipped" | "failed";
  }> = [
    {
      name: "Revision identity",
      mutate(value) {
        if (value.retentionKind !== "retained-candidate") assert.fail("expected retained candidate");
        value.revision.artifactId = "artifact-other";
      },
      expected: "skipped",
    },
    {
      name: "origin evidence",
      mutate(value) { value.attempt.candidateEvidence!.candidateRetentionRef = "refs/dezin/tampered"; },
      expected: "failed",
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const input = fixture();
      const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
      try {
        writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
        const candidate = await transaction.commit("generate", new AbortController().signal);
        await transaction.dispose();
        const candidateEntry = recoveryEntry(input.attempt, revision(candidate));
        testCase.mutate(candidateEntry);
        const recovery = createArtifactCandidateRefRecovery({
          store: { listArtifactCandidateRefRecoveryEntries: () => ({
            entries: [candidateEntry],
            nextCursor: null,
          }) },
          repositoryDirForWorkspace: () => input.root,
        });

        const summary = await recovery.recover(new AbortController().signal);

        assert.equal(summary[testCase.expected], 1);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      } finally {
        await transaction.dispose();
        rmSync(input.root, { recursive: true, force: true });
      }
    });
  }
});

test("Git retention promotes an earlier best candidate retained by a later Attempt head", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: input.root,
    attempt: input.attempt,
  });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "best\n");
    const best = await transaction.commit("round 0", new AbortController().signal);
    writeFileSync(join(transaction.dir, "page.txt"), "regressed\n");
    const later = await transaction.commit("round 1", new AbortController().signal);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), later.commitHash);
    await transaction.restore(best, new AbortController().signal);
    await transaction.dispose();

    let authorityAvailable = true;
    const candidateRetention = retention(input.root, () => {
      if (!authorityAvailable) throw new Error("authority lookup must not run during release");
      return SOURCE_AUTHORITY;
    });
    const retentionInput = {
      claim: claim(input.attempt),
      artifactRevision: revision(best),
      evidence: evidence(input.attempt, best, [best, later], input.root),
    };
    const parsed = artifactCandidateRetentionDescriptor({
      task: retentionInput.claim.task,
      attempt: retentionInput.claim.attempt,
      artifactRevision: retentionInput.artifactRevision,
      evidence: retentionInput.evidence,
    });
    assert.deepEqual(parsed.visualEvidence.map((entry) => entry.descriptor.round), [0, 1]);
    assert.deepEqual(parsed.sourceVisualEvidence.map((entry) => entry.descriptor.round), [0, 1]);

    const receipt = await candidateRetention.promote(retentionInput, new AbortController().signal);
    assert.equal(git(input.root, "rev-parse", artifactRevisionRef("revision-page-1")), best.commitHash);
    assert.equal(git(input.root, "rev-parse", artifactRevisionHistoryRef("revision-page-1")), later.commitHash);
    assert.equal(git(input.root, "rev-parse", receipt.ref), receipt.commitHash);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), later.commitHash);

    rmSync(join(input.root, "generation-task-evidence"), { recursive: true, force: true });
    authorityAvailable = false;
    await candidateRetention.release(retentionInput, receipt, new AbortController().signal);
    assert.deepEqual(
      await candidateRetention.verifyPublication(
        retentionInput,
        receipt,
        new AbortController().signal,
      ),
      receipt,
    );
    assert.equal(refExists(input.root, transaction.attemptRef), false);
    git(input.root, "reflog", "expire", "--expire=now", "--all");
    git(input.root, "gc", "--prune=now");
    for (const version of [best, later]) {
      assert.equal(git(input.root, "cat-file", "-t", version.commitHash), "commit");
      assert.equal(git(input.root, "cat-file", "-t", version.treeHash), "tree");
    }
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("Git retention preserves a Viewer-safe Unicode Frame id while hashing only its storage segment", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: input.root,
    attempt: input.attempt,
  });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "unicode frame candidate\n");
    const candidate = await transaction.commit("unicode frame", new AbortController().signal);
    await transaction.dispose();
    const unicodeFrame = {
      id: "桌面 / 主",
      name: "主桌面 / Desktop",
      width: 390,
      height: 844,
      initialState: "Empty state / 空",
      fixture: { locale: "zh-CN", empty: true },
      background: "linear-gradient(135deg, #ffffff, #eef2ff)",
    };
    const exactClaim = claim(input.attempt, { frame: unicodeFrame });
    const artifactRevision = revision(candidate);
    const candidateEvidence = evidence(
      input.attempt,
      candidate,
      [candidate],
      input.root,
      unicodeFrame,
    );
    const parsed = artifactCandidateRetentionDescriptor({
      task: exactClaim.task,
      attempt: exactClaim.attempt,
      artifactRevision,
      evidence: candidateEvidence,
    });
    assert.equal(parsed.visualEvidence[0]?.descriptor.frame.id, unicodeFrame.id);
    assert.match(
      parsed.visualEvidence[0]?.descriptor.storageKey ?? "",
      new RegExp(`-frame-${createHash("sha256").update(unicodeFrame.id, "utf8").digest("hex")}-`),
    );

    const candidateRetention = retention(input.root);
    await candidateRetention.verify({
      claim: exactClaim,
      candidate: {
        workspaceId: artifactRevision.workspaceId,
        artifactId: artifactRevision.artifactId,
        trackId: artifactRevision.trackId,
        sourceCommitHash: artifactRevision.sourceCommitHash,
        sourceTreeHash: artifactRevision.sourceTreeHash,
        quality: artifactRevision.quality,
      },
      evidence: candidateEvidence,
    }, new AbortController().signal);
    await candidateRetention.promote({
      claim: exactClaim,
      artifactRevision,
      evidence: candidateEvidence,
    }, new AbortController().signal);
    assert.equal(
      git(input.root, "rev-parse", artifactRevisionRef(artifactRevision.id)),
      candidate.commitHash,
    );
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("Git retention publishes a runtime-only Artifact with an immutable manifest and zero PNG entries", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: input.root,
    attempt: input.attempt,
  });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "runtime-only candidate\n");
    const candidate = await transaction.commit("runtime only", new AbortController().signal);
    await transaction.dispose();
    const candidateEvidence = evidence(input.attempt, candidate);
    delete candidateEvidence.visualReview;
    const version = (candidateEvidence.versions as Array<Record<string, unknown>>)[0]!;
    const manifest = version.evaluationManifest as Record<string, unknown>;
    for (const field of [
      "reviewSummary",
      "visualEvidence",
      "sourceCaptureResult",
      "sourceVisualEvidence",
    ]) delete manifest[field];
    for (const result of manifest.frameResults as Array<Record<string, unknown>>) {
      result.reviewed = false;
    }
    const qualityEvidence = candidateEvidence.qualityEvidence as Record<string, unknown>;
    for (const field of [
      "visualReview",
      "visualEvidence",
      "sourceCaptureResult",
      "sourceVisualEvidence",
    ]) delete qualityEvidence[field];
    qualityEvidence.frameResults = structuredClone(manifest.frameResults);
    const exactClaim = claim(input.attempt);
    exactClaim.task.qaProfile.requireVisualReview = false;
    const retentionInput = {
      claim: exactClaim,
      artifactRevision: revision(candidate),
      evidence: candidateEvidence,
    };
    const candidateRetention = retention(input.root);

    const receipt = await candidateRetention.promote(
      retentionInput,
      new AbortController().signal,
    );

    assert.deepEqual(receipt.subject.entries, []);
    await candidateRetention.release(
      retentionInput,
      receipt,
      new AbortController().signal,
    );
    assert.deepEqual(
      await candidateRetention.verifyPublication(
        retentionInput,
        receipt,
        new AbortController().signal,
      ),
      receipt,
    );
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("Git retention reopens every selected and non-selected PNG before moving a ref", async (t) => {
  const cases = [
    { name: "selected Frame is missing", round: 0, scope: "frame", mutation: "missing" },
    { name: "non-selected source is missing", round: 1, scope: "source", mutation: "missing" },
    { name: "selected source was replaced", round: 0, scope: "source", mutation: "replacement" },
    { name: "final file is a same-bytes symlink", round: 0, scope: "frame", mutation: "symlink" },
    { name: "final file has a same-bytes hardlink alias", round: 0, scope: "frame", mutation: "hardlink" },
    { name: "non-selected source is oversized", round: 1, scope: "source", mutation: "oversize" },
    { name: "storage ancestor is a same-bytes symlink", round: 0, scope: "frame", mutation: "ancestor-symlink" },
  ] as const;
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const input = fixture();
      const outside = mkdtempSync(join(tmpdir(), "dezin-artifact-retention-outside-"));
      const transaction = await beginArtifactCandidateTransaction({
        repositoryDir: input.root,
        attempt: input.attempt,
      });
      try {
        writeFileSync(join(transaction.dir, "page.txt"), "best\n");
        const best = await transaction.commit("round 0", new AbortController().signal);
        writeFileSync(join(transaction.dir, "page.txt"), "later\n");
        const later = await transaction.commit("round 1", new AbortController().signal);
        await transaction.restore(best, new AbortController().signal);
        await transaction.dispose();
        const candidateEvidence = evidence(input.attempt, best, [best, later], input.root);
        const path = join(
          input.root,
          ...retainedEvidenceStorageKey(
            candidateEvidence,
            testCase.round,
            testCase.scope,
          ).split("/"),
        );
        if (testCase.mutation === "replacement") {
          writeFileSync(path, sharinganFixturePng(EVIDENCE_FRAME.width + 1, EVIDENCE_FRAME.height));
        } else if (testCase.mutation === "missing") {
          unlinkSync(path);
        } else if (testCase.mutation === "oversize") {
          truncateSync(path, MAX_PNG_EVIDENCE_BYTES + 1);
        } else if (testCase.mutation === "symlink") {
          const outsidePath = join(outside, "same.png");
          renameSync(path, outsidePath);
          symlinkSync(outsidePath, path, "file");
        } else if (testCase.mutation === "hardlink") {
          try {
            linkSync(path, join(outside, "alias.png"));
          } catch (error) {
            if (["ENOSYS", "EPERM", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
              t.skip("hardlinks are unavailable on this filesystem");
              return;
            }
            throw error;
          }
        } else {
          const directory = dirname(path);
          const outsideDirectory = join(outside, "visual");
          renameSync(directory, outsideDirectory);
          symlinkSync(outsideDirectory, directory, "dir");
        }

        await assert.rejects(
          retention(input.root).promote({
            claim: claim(input.attempt),
            artifactRevision: revision(best),
            evidence: candidateEvidence,
          }, new AbortController().signal),
          /evidence|PNG|content identity/i,
        );
        assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
        assert.equal(refExists(input.root, artifactRevisionHistoryRef("revision-page-1")), false);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), later.commitHash);
      } finally {
        await transaction.dispose();
        rmSync(input.root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test("Git retention resolves source authority from the trusted Resource Revision", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
    const manifest = ((candidateEvidence.versions as Array<Record<string, unknown>>)[0]!)
      .evaluationManifest as Record<string, unknown>;
    const forgedAuthority = { ...SOURCE_AUTHORITY, revisionChecksum: "8".repeat(64) };
    (manifest.sourceVisualEvidence as Record<string, unknown>).sourceAuthority = forgedAuthority;
    ((candidateEvidence.qualityEvidence as Record<string, unknown>)
      .sourceVisualEvidence as Record<string, unknown>).sourceAuthority = forgedAuthority;
    const lookups: Array<{ workspaceId: string; resourceId: string; revisionId: string }> = [];
    const trustedRevision = {
      id: SOURCE_AUTHORITY.revisionId,
      resourceId: SOURCE_AUTHORITY.resourceId,
      checksum: SOURCE_AUTHORITY.revisionChecksum,
    };

    await assert.rejects(
      retention(input.root, (lookup) => {
        lookups.push(lookup);
        return {
          resourceId: trustedRevision.resourceId,
          revisionId: trustedRevision.id,
          revisionChecksum: trustedRevision.checksum,
        };
      }).promote({
        claim: claim(input.attempt),
        artifactRevision: revision(candidate),
        evidence: candidateEvidence,
      }, new AbortController().signal),
      /authority|Resource Revision|descriptor/i,
    );
    assert.deepEqual(lookups, [{
      workspaceId: "workspace-1",
      resourceId: SOURCE_AUTHORITY.resourceId,
      revisionId: SOURCE_AUTHORITY.revisionId,
    }]);
    assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
    assert.equal(refExists(input.root, artifactRevisionHistoryRef("revision-page-1")), false);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("Git retention aborts between evidence checks without moving a ref", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
    const controller = new AbortController();
    const reason = new Error("stop before source PNG verification");
    const candidateRetention = retention(input.root, () => {
      controller.abort(reason);
      return SOURCE_AUTHORITY;
    });

    await assert.rejects(
      candidateRetention.promote({
        claim: claim(input.attempt),
        artifactRevision: revision(candidate),
        evidence: candidateEvidence,
      }, controller.signal),
      (error: unknown) => error === reason,
    );
    assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
    assert.equal(refExists(input.root, artifactRevisionHistoryRef("revision-page-1")), false);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("publication-only retention uses the original full-execution Attempt evidence", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const candidateRetention = retention(input.root);
    const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
    const retentionInput = {
      claim: claim(input.attempt, {
        executionMode: "publication-only",
        attemptNumber: 2,
        candidateEvidence,
      }),
      artifactRevision: revision(candidate),
      evidence: candidateEvidence,
    };
    const receipt = await candidateRetention.promote(retentionInput, new AbortController().signal);
    await candidateRetention.release(retentionInput, receipt, new AbortController().signal);
    assert.equal(git(input.root, "rev-parse", artifactRevisionRef("revision-page-1")), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("publication-only retention revalidates predecessor evidence before moving a ref", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "best\n");
    const best = await transaction.commit("round 0", new AbortController().signal);
    writeFileSync(join(transaction.dir, "page.txt"), "later\n");
    const later = await transaction.commit("round 1", new AbortController().signal);
    await transaction.restore(best, new AbortController().signal);
    await transaction.dispose();
    const candidateEvidence = evidence(input.attempt, best, [best, later], input.root);
    unlinkSync(join(
      input.root,
      ...retainedEvidenceStorageKey(candidateEvidence, 1, "source").split("/"),
    ));
    const publicationRetryClaim = claim(input.attempt, {
      executionMode: "publication-only",
      attemptNumber: 2,
      candidateEvidence,
    });

    await assert.rejects(
      retention(input.root).promote({
        claim: publicationRetryClaim,
        artifactRevision: revision(best),
        evidence: candidateEvidence,
      }, new AbortController().signal),
      /evidence|PNG|content identity/i,
    );
    assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
    assert.equal(refExists(input.root, artifactRevisionHistoryRef("revision-page-1")), false);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), later.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("retention rejects tampered origin evidence before moving a Git ref", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const candidateRetention = retention(input.root);
    const tampered = evidence(input.attempt, candidate);
    tampered.candidateRetentionRef = "refs/dezin/tampered";
    await assert.rejects(
      candidateRetention.promote({
        claim: claim(input.attempt),
        artifactRevision: revision(candidate),
        evidence: tampered,
      }, new AbortController().signal),
      ArtifactCandidateRetentionError,
    );
    assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("retention requires promoted quality-gate evidence to mirror its immutable audit envelope", async (t) => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const candidateRetention = retention(input.root);
    const cases: Array<{ name: string; mutate(value: Record<string, unknown>): void }> = [
      {
        name: "root runtime checks differ",
        mutate(value) { value.runtimeChecks = [{ id: "build", status: "failed" }]; },
      },
      {
        name: "root visual review is missing",
        mutate(value) { delete value.visualReview; },
      },
      {
        name: "audit visual review is missing",
        mutate(value) {
          delete (value.qualityEvidence as Record<string, unknown>).visualReview;
        },
      },
      {
        name: "unknown promoted field",
        mutate(value) { value.unreviewed = true; },
      },
      {
        name: "selected version substitution",
        mutate(value) {
          const versions = value.versions as Array<Record<string, unknown>>;
          versions[0] = { ...versions[0], commitHash: input.attempt.sourceCommitHash };
        },
      },
      {
        name: "non-contiguous version round",
        mutate(value) {
          const versions = value.versions as Array<Record<string, unknown>>;
          versions[0] = { ...versions[0], round: 1 };
        },
      },
      {
        name: "empty version history",
        mutate(value) { value.versions = []; },
      },
    ];
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const tampered = evidence(input.attempt, candidate);
        entry.mutate(tampered);
        await assert.rejects(
          candidateRetention.promote({
            claim: claim(input.attempt),
            artifactRevision: revision(candidate),
            evidence: tampered,
          }, new AbortController().signal),
          ArtifactCandidateRetentionError,
        );
        assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      });
    }
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("publication-only retention rejects an incoherent Core lineage before moving a Git ref", async (t) => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const candidateRetention = retention(input.root);
    const candidateEvidence = evidence(input.attempt, candidate, [candidate], input.root);
    const baseClaim = claim(input.attempt, {
      executionMode: "publication-only",
      attemptNumber: 2,
      candidateEvidence,
    });
    const cases: Array<{ name: string; mutate(value: GenerationTaskAttemptClaim): void }> = [
      {
        name: "wrong origin",
        mutate(value) { value.attempt.attemptOrigin = "same-input-retry"; },
      },
      {
        name: "non-adjacent predecessor",
        mutate(value) { value.attempt.predecessorAttempt = 0; },
      },
      {
        name: "substituted candidate Revision",
        mutate(value) { value.attempt.candidateRevisionId = "revision-other"; },
      },
      {
        name: "substituted evidence",
        mutate(value) { value.attempt.candidateEvidence = { ...candidateEvidence, selectedRound: 7 }; },
      },
      {
        name: "forged evidence hash",
        mutate(value) { value.attempt.candidateEvidenceHash = "f".repeat(64); },
      },
      {
        name: "substituted Context Pack",
        mutate(value) { value.attempt.contextPackId = `context-pack-${"d".repeat(64)}`; },
      },
    ];
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const candidateClaim = structuredClone(baseClaim);
        entry.mutate(candidateClaim);
        await assert.rejects(
          candidateRetention.promote({
            claim: candidateClaim,
            artifactRevision: revision(candidate),
            evidence: candidateEvidence,
          }, new AbortController().signal),
          ArtifactCandidateRetentionError,
        );
        assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      });
    }
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});
