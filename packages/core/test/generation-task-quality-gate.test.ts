import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  GenerationTaskQualityGateError,
  validateGenerationTaskArtifactQualityGate,
  type GenerationTaskSourceVisualEvidenceAuthority,
} from "../src/generation-task-quality.ts";
import { generationTaskVisualEvidenceFrameStorageSegment } from "../src/render-frame.ts";

const SOURCE_AUTHORITY: GenerationTaskSourceVisualEvidenceAuthority = Object.freeze({
  resourceId: "resource-sharingan-1",
  revisionId: "resource-revision-sharingan-1",
  revisionChecksum: "7".repeat(64),
});

function validInput(frameId = "desktop") {
  const frames = [{ id: frameId, name: "Desktop", width: 1_440, height: 900 }];
  const frameAttemptId = frameId === "desktop" ? "quality-round-0-desktop" : "quality-round-0-frame";
  const contextPackHash = "c".repeat(64);
  const owner = {
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-page-1",
    attempt: 1,
    candidateCommitHash: "a".repeat(40),
    candidateTreeHash: "b".repeat(40),
    contextPackId: `context-pack-${contextPackHash}`,
    contextPackHash,
  };
  const inputHash = "f".repeat(64);
  const attemptCreatedAt = 10;
  const sourceBase = { commitHash: "e".repeat(40), treeHash: "f".repeat(40) };
  const candidateRetentionRef = canonicalCandidateRetentionRef({
    workspaceId: owner.workspaceId,
    taskId: owner.taskId,
    attempt: owner.attempt,
    inputHash,
  });
  const sha256 = "d".repeat(64);
  const storageKey = [
    "generation-task-evidence",
    owner.projectId,
    owner.workspaceId,
    owner.planId,
    owner.taskId,
    `attempt-${owner.attempt}`,
    "visual",
    `round-0-${generationTaskVisualEvidenceFrameStorageSegment(frameId)}-${sha256}.png`,
  ].join("/");
  const visualEvidence = [{
    protocol: "dezin.generation-task-visual-evidence.v1",
    owner,
    frame: { ...frames[0]!, frameAttemptId },
    round: 0,
    mediaType: "image/png",
    sha256,
    byteLength: 1_024,
    storageKey,
  }];
  return {
    requireSourceVisualEvidence: false,
    qaProfile: {
      requiredFrameIds: [frameId],
      blockingSeverities: ["P0", "P1"] as Array<"P0" | "P1">,
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
    plannedFrames: frames,
    renderSpec: { frames },
    quality: { state: "passed", score: 98, findings: [] },
    evidence: {
      protocol: "dezin.standard-artifact-quality.v1",
      candidate: {
        commitHash: owner.candidateCommitHash,
        treeHash: owner.candidateTreeHash,
      },
      contextPack: { id: owner.contextPackId, hash: owner.contextPackHash },
      frames,
      frameResults: [{
        frameId,
        frameAttemptId,
        width: 1_440,
        height: 900,
        status: "passed",
        reviewed: true,
        captureIdentity: {
          sha256,
          byteLength: 1_024,
          width: 1_440,
          height: 1_200,
        },
      }],
      round: 0,
      runtimeChecks: [{ id: `frame:${frameId}`, status: "passed" }],
      visualReview: {
        status: "passed",
        fidelity: 0.98,
        evidence: visualEvidence.map(({ frame, sha256: checksum, byteLength, storageKey: key }) => ({
          frameId: frame.id,
          frameAttemptId: frame.frameAttemptId,
          sha256: checksum,
          byteLength,
          storageKey: key,
        })),
      },
      visualEvidence,
    },
    expectedEvidenceOwner: {
      projectId: owner.projectId,
      workspaceId: owner.workspaceId,
      planId: owner.planId,
      taskId: owner.taskId,
      attempt: owner.attempt,
      candidateCommitHash: owner.candidateCommitHash,
      candidateTreeHash: owner.candidateTreeHash,
      contextPackId: owner.contextPackId,
      contextPackHash: owner.contextPackHash,
      inputHash,
      attemptCreatedAt,
      sourceBase,
      candidateRetentionRef,
    },
  };
}

function validSourceEvidenceInput() {
  const input = validInput();
  const sourceAttemptId = "visual-qa-source";
  const width = 1_440;
  const height = 1_800;
  const sha256 = "9".repeat(64);
  const byteLength = 2_048;
  const storageKey = [
    "generation-task-evidence",
    input.expectedEvidenceOwner.projectId,
    input.expectedEvidenceOwner.workspaceId,
    input.expectedEvidenceOwner.planId,
    input.expectedEvidenceOwner.taskId,
    `attempt-${input.expectedEvidenceOwner.attempt}`,
    "visual",
    `round-0-source-${sha256}.png`,
  ].join("/");
  const capture = { scope: "source", sourceAttemptId, width, height };
  const sourceVisualEvidence = {
    protocol: "dezin.generation-task-source-visual-evidence.v1",
    owner: input.evidence.visualEvidence[0]!.owner,
    capture,
    sourceAuthority: SOURCE_AUTHORITY,
    round: 0,
    mediaType: "image/png",
    sha256,
    byteLength,
    storageKey,
  };
  return {
    ...input,
    requireSourceVisualEvidence: SOURCE_AUTHORITY,
    evidence: {
      ...input.evidence,
      sourceCaptureResult: {
        ...capture,
        status: "passed",
        reviewed: true,
        captureIdentity: { sha256, byteLength, width, height },
      },
      visualReview: {
        ...input.evidence.visualReview,
        sourceEvidence: {
          ...capture,
          sha256,
          byteLength,
          storageKey,
        },
      },
      sourceVisualEvidence,
    },
  };
}

function canonicalCandidateRetentionRef(input: {
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

function validRunInput(
  input: ReturnType<typeof validInput> | ReturnType<typeof validSourceEvidenceInput> = validInput(),
) {
  const qualityEvidence = input.evidence;
  const optionalQualityEvidence = qualityEvidence as Record<string, unknown>;
  const inputHash = "f".repeat(64);
  const attemptCreatedAt = 10;
  const sourceBase = { commitHash: "e".repeat(40), treeHash: "f".repeat(40) };
  const candidateRetentionRef = canonicalCandidateRetentionRef({
    workspaceId: input.expectedEvidenceOwner.workspaceId,
    taskId: input.expectedEvidenceOwner.taskId,
    attempt: input.expectedEvidenceOwner.attempt,
    inputHash,
  });
  const evaluationManifest = {
    protocol: "dezin.artifact-run-evaluation-manifest.v1",
    candidate: structuredClone(qualityEvidence.candidate),
    round: 0,
    passed: true,
    score: 98,
    qualityState: "passed",
    findingsDigest: createHash("sha256").update(JSON.stringify([])).digest("hex"),
    frameResults: structuredClone(qualityEvidence.frameResults),
    runtimeChecks: structuredClone(qualityEvidence.runtimeChecks),
    reviewSummary: structuredClone(qualityEvidence.visualReview),
    visualEvidence: structuredClone(qualityEvidence.visualEvidence),
    ...(optionalQualityEvidence.sourceCaptureResult ? {
      sourceCaptureResult: structuredClone(optionalQualityEvidence.sourceCaptureResult),
    } : {}),
    ...(optionalQualityEvidence.sourceVisualEvidence ? {
      sourceVisualEvidence: structuredClone(optionalQualityEvidence.sourceVisualEvidence),
    } : {}),
  };
  return {
    ...input,
    expectedEvidenceOwner: {
      ...input.expectedEvidenceOwner,
      inputHash,
      attemptCreatedAt,
      sourceBase,
      candidateRetentionRef,
    },
    evidence: {
      runtimeChecks: qualityEvidence.runtimeChecks,
      visualReview: qualityEvidence.visualReview,
      protocol: "dezin.artifact-run.v1",
      projectId: input.expectedEvidenceOwner.projectId,
      taskId: input.expectedEvidenceOwner.taskId,
      planId: input.expectedEvidenceOwner.planId,
      workspaceId: input.expectedEvidenceOwner.workspaceId,
      attempt: input.expectedEvidenceOwner.attempt,
      attemptCreatedAt,
      inputHash,
      contextPackId: input.expectedEvidenceOwner.contextPackId,
      contextPackHash: input.expectedEvidenceOwner.contextPackHash,
      sourceBase,
      candidateRetentionRef,
      selectedRound: 0,
      versions: [{
        round: 0,
        commitHash: input.expectedEvidenceOwner.candidateCommitHash,
        treeHash: input.expectedEvidenceOwner.candidateTreeHash,
        passed: true,
        score: 98,
        evaluationManifest,
      }],
      qualityEvidence,
    },
  };
}

function validRunInputWithFailedRound() {
  const input = validRunInput();
  const selectedCandidate = structuredClone(input.evidence.qualityEvidence.candidate);
  const failedCandidate = {
    commitHash: "1".repeat(40),
    treeHash: "2".repeat(40),
  };
  const evidenceForRound = (
    candidate: typeof selectedCandidate,
    round: number,
    status: "passed" | "failed",
  ) => {
    const evidence = structuredClone(input.evidence.qualityEvidence);
    const frameAttemptId = `quality-round-${round}-desktop`;
    const storageKey = evidence.visualEvidence[0]!.storageKey.replace(
      "round-0-desktop-",
      `round-${round}-desktop-`,
    );
    evidence.candidate = candidate;
    evidence.round = round;
    evidence.frameResults = evidence.frameResults.map((result) => ({
      ...result,
      frameAttemptId,
      status,
    }));
    evidence.runtimeChecks = evidence.runtimeChecks.map((check) => ({ ...check, status }));
    evidence.visualReview = {
      ...evidence.visualReview,
      status,
      evidence: evidence.visualReview.evidence.map((summary) => ({
        ...summary,
        frameAttemptId,
        storageKey,
      })),
    };
    evidence.visualEvidence = evidence.visualEvidence.map((descriptor) => ({
      ...descriptor,
      owner: {
        ...descriptor.owner,
        candidateCommitHash: candidate.commitHash,
        candidateTreeHash: candidate.treeHash,
      },
      frame: { ...descriptor.frame, frameAttemptId },
      round,
      storageKey,
    }));
    return evidence;
  };
  const failedEvidence = evidenceForRound(failedCandidate, 0, "failed");
  const selectedEvidence = evidenceForRound(selectedCandidate, 1, "passed");
  const manifest = (
    evidence: typeof failedEvidence,
    passed: boolean,
    score: number,
  ) => ({
    protocol: "dezin.artifact-run-evaluation-manifest.v1",
    candidate: structuredClone(evidence.candidate),
    round: evidence.round,
    passed,
    score,
    qualityState: passed ? "passed" : "failed",
    findingsDigest: createHash("sha256").update(JSON.stringify([])).digest("hex"),
    frameResults: structuredClone(evidence.frameResults),
    runtimeChecks: structuredClone(evidence.runtimeChecks),
    reviewSummary: structuredClone(evidence.visualReview),
    visualEvidence: structuredClone(evidence.visualEvidence),
  });
  return {
    ...input,
    evidence: {
      ...input.evidence,
      runtimeChecks: selectedEvidence.runtimeChecks,
      visualReview: selectedEvidence.visualReview,
      selectedRound: 1,
      versions: [{
        round: 0,
        ...failedCandidate,
        passed: false,
        score: 80,
        evaluationManifest: manifest(failedEvidence, false, 80),
      }, {
        round: 1,
        ...selectedCandidate,
        passed: true,
        score: 98,
        evaluationManifest: manifest(selectedEvidence, true, 98),
      }],
      qualityEvidence: selectedEvidence,
    },
  };
}

test("Generation Task Artifact quality gate accepts exact high-quality evidence", () => {
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(validInput()));
});

test("Generation Task Artifact quality gate preserves a Unicode Frame id with its canonical hashed storage segment", () => {
  const input = validInput("结账 · 宽屏");
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(input));
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(validRunInput(input)));
});

test("Generation Task Artifact quality gate accepts exact independently reviewed source evidence", () => {
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(validSourceEvidenceInput()));
});

test("Generation Task Artifact quality gate rejects partial source evidence groups", () => {
  for (const omit of ["capture", "descriptor", "summary"] as const) {
    const input = validSourceEvidenceInput();
    if (omit === "capture") {
      const { sourceCaptureResult: _omitted, ...evidence } = input.evidence;
      assert.throws(
        () => validateGenerationTaskArtifactQualityGate({ ...input, evidence }),
        GenerationTaskQualityGateError,
        omit,
      );
    } else if (omit === "descriptor") {
      const { sourceVisualEvidence: _omitted, ...evidence } = input.evidence;
      assert.throws(
        () => validateGenerationTaskArtifactQualityGate({ ...input, evidence }),
        GenerationTaskQualityGateError,
        omit,
      );
    } else {
      const { sourceEvidence: _omitted, ...visualReview } = input.evidence.visualReview;
      assert.throws(
        () => validateGenerationTaskArtifactQualityGate({
          ...input,
          evidence: { ...input.evidence, visualReview },
        }),
        GenerationTaskQualityGateError,
        omit,
      );
    }
  }
});

test("Generation Task Artifact quality gate requires the complete source evidence group from frozen Task facts", () => {
  const input = validSourceEvidenceInput();
  const {
    sourceCaptureResult: _capture,
    sourceVisualEvidence: _descriptor,
    visualReview: sourceReview,
    ...remainingEvidence
  } = input.evidence;
  const { sourceEvidence: _summary, ...visualReview } = sourceReview;
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate({
      ...input,
      evidence: { ...remainingEvidence, visualReview },
    }),
    GenerationTaskQualityGateError,
  );
});

test("Generation Task Artifact quality gate rejects source evidence for a non-Sharingan frozen Task", () => {
  const sourceInput = validSourceEvidenceInput();
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate({
      ...sourceInput,
      requireSourceVisualEvidence: false,
    }),
    GenerationTaskQualityGateError,
  );
});

test("Generation Task Artifact quality gate requires an exact Core authority or explicit daemon preflight", () => {
  const input = validInput();
  const { requireSourceVisualEvidence: _omitted, ...missingAuthority } = input;
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate(missingAuthority as typeof input),
    GenerationTaskQualityGateError,
  );
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate({
      ...input,
      requireSourceVisualEvidence: "false",
    }),
    GenerationTaskQualityGateError,
  );
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate({
      ...input,
      requireSourceVisualEvidence: true,
    }),
    GenerationTaskQualityGateError,
  );
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate({
    ...input,
    requireSourceVisualEvidence: null,
  }));
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate({
    ...validSourceEvidenceInput(),
    requireSourceVisualEvidence: null,
  }));
});

test("Generation Task Artifact quality gate rejects unreviewed or failed source captures", () => {
  for (const resultPatch of [
    { reviewed: false },
    { status: "failed" },
  ]) {
    const input = validSourceEvidenceInput();
    assert.throws(
      () => validateGenerationTaskArtifactQualityGate({
        ...input,
        evidence: {
          ...input.evidence,
          sourceCaptureResult: { ...input.evidence.sourceCaptureResult, ...resultPatch },
        },
      }),
      GenerationTaskQualityGateError,
      JSON.stringify(resultPatch),
    );
  }
});

test("Generation Task Artifact quality gate rejects tampered source evidence bindings", () => {
  type SourceInput = ReturnType<typeof validSourceEvidenceInput>;
  const mutations: Array<{ name: string; mutate: (input: SourceInput) => SourceInput }> = [
    {
      name: "capture result fields",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceCaptureResult: { ...input.evidence.sourceCaptureResult, injected: true },
        },
      }),
    },
    {
      name: "descriptor protocol",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceVisualEvidence: {
            ...input.evidence.sourceVisualEvidence,
            protocol: "dezin.generation-task-visual-evidence.v1",
          },
        },
      }),
    },
    {
      name: "descriptor owner",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceVisualEvidence: {
            ...input.evidence.sourceVisualEvidence,
            owner: { ...input.evidence.sourceVisualEvidence.owner, projectId: "project-foreign" },
          },
        },
      }),
    },
    {
      name: "descriptor round",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceVisualEvidence: { ...input.evidence.sourceVisualEvidence, round: 1 },
        },
      }),
    },
    {
      name: "descriptor capture Attempt",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceVisualEvidence: {
            ...input.evidence.sourceVisualEvidence,
            capture: {
              ...input.evidence.sourceVisualEvidence.capture,
              sourceAttemptId: "visual-qa-source-foreign",
            },
          },
        },
      }),
    },
    {
      name: "descriptor source authority",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceVisualEvidence: {
            ...input.evidence.sourceVisualEvidence,
            sourceAuthority: {
              ...input.evidence.sourceVisualEvidence.sourceAuthority,
              resourceId: "resource-sharingan-foreign",
            },
          },
        },
      }),
    },
    {
      name: "review capture width",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          visualReview: {
            ...input.evidence.visualReview,
            sourceEvidence: { ...input.evidence.visualReview.sourceEvidence, width: 1_439 },
          },
        },
      }),
    },
    {
      name: "capture result height",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceCaptureResult: { ...input.evidence.sourceCaptureResult, height: 1_799 },
        },
      }),
    },
    {
      name: "review checksum",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          visualReview: {
            ...input.evidence.visualReview,
            sourceEvidence: {
              ...input.evidence.visualReview.sourceEvidence,
              sha256: "8".repeat(64),
            },
          },
        },
      }),
    },
    {
      name: "descriptor byte length",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceVisualEvidence: { ...input.evidence.sourceVisualEvidence, byteLength: 2_047 },
        },
      }),
    },
    {
      name: "review storage key",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          visualReview: {
            ...input.evidence.visualReview,
            sourceEvidence: {
              ...input.evidence.visualReview.sourceEvidence,
              storageKey: `${input.evidence.visualReview.sourceEvidence.storageKey}.foreign`,
            },
          },
        },
      }),
    },
    {
      name: "capture identity checksum",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceCaptureResult: {
            ...input.evidence.sourceCaptureResult,
            captureIdentity: {
              ...input.evidence.sourceCaptureResult.captureIdentity,
              sha256: "0".repeat(64),
            },
          },
        },
      }),
    },
    {
      name: "undersized source capture identity",
      mutate: (input) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceCaptureResult: {
            ...input.evidence.sourceCaptureResult,
            captureIdentity: {
              ...input.evidence.sourceCaptureResult.captureIdentity,
              height: input.evidence.sourceCaptureResult.height - 1,
            },
          },
        },
      }),
    },
  ];

  for (const { name, mutate } of mutations) {
    assert.throws(
      () => validateGenerationTaskArtifactQualityGate(mutate(validSourceEvidenceInput())),
      GenerationTaskQualityGateError,
      name,
    );
  }
});

test("Generation Task Artifact quality gate accepts an exact immutable run/version envelope", () => {
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(validRunInput()));
});

test("Generation Task Artifact run envelope preserves exact independent source evidence", () => {
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(
    validRunInput(validSourceEvidenceInput()),
  ));
});

test("Generation Task Artifact run envelope rejects deleting a required failed-round visual audit group", () => {
  const input = validRunInputWithFailedRound();
  const failedManifest = input.evidence.versions[0]!.evaluationManifest;
  delete (failedManifest as Partial<typeof failedManifest>).reviewSummary;
  delete (failedManifest as Partial<typeof failedManifest>).visualEvidence;
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate(input),
    GenerationTaskQualityGateError,
  );
});

test("Generation Task Artifact run envelope rejects deleting required failed-round runtime checks", () => {
  const input = validRunInputWithFailedRound();
  const failedManifest = input.evidence.versions[0]!.evaluationManifest;
  delete (failedManifest as Partial<typeof failedManifest>).runtimeChecks;
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate(input),
    GenerationTaskQualityGateError,
  );
});

test("Generation Task Artifact run envelope rejects missing, tampered, or divergent evaluation manifests", () => {
  for (const { name, mutate } of [
    {
      name: "missing manifest",
      mutate(input: ReturnType<typeof validRunInput>) {
        const { evaluationManifest: _omitted, ...version } = input.evidence.versions[0]!;
        return { ...input, evidence: { ...input.evidence, versions: [version] } };
      },
    },
    {
      name: "manifest candidate",
      mutate(input: ReturnType<typeof validRunInput>) {
        const version = input.evidence.versions[0]!;
        return {
          ...input,
          evidence: {
            ...input.evidence,
            versions: [{
              ...version,
              evaluationManifest: {
                ...version.evaluationManifest,
                candidate: { ...version.evaluationManifest.candidate, commitHash: "0".repeat(40) },
              },
            }],
          },
        };
      },
    },
    {
      name: "selected Frame descriptors",
      mutate(input: ReturnType<typeof validRunInput>) {
        const version = input.evidence.versions[0]!;
        return {
          ...input,
          evidence: {
            ...input.evidence,
            versions: [{
              ...version,
              evaluationManifest: { ...version.evaluationManifest, visualEvidence: [] },
            }],
          },
        };
      },
    },
    {
      name: "findings digest",
      mutate(input: ReturnType<typeof validRunInput>) {
        const version = input.evidence.versions[0]!;
        return {
          ...input,
          evidence: {
            ...input.evidence,
            versions: [{
              ...version,
              evaluationManifest: { ...version.evaluationManifest, findingsDigest: "0".repeat(64) },
            }],
          },
        };
      },
    },
  ] as const) {
    assert.throws(
      () => validateGenerationTaskArtifactQualityGate(mutate(validRunInput())),
      GenerationTaskQualityGateError,
      name,
    );
  }
});

test("Generation Task Artifact quality gate fences run Plan identity and selected version", () => {
  for (const mutate of [
    (input: ReturnType<typeof validRunInput>) => ({
      ...input,
      evidence: { ...input.evidence, projectId: "project-foreign" },
    }),
    (input: ReturnType<typeof validRunInput>) => ({
      ...input,
      evidence: { ...input.evidence, planId: "plan-foreign" },
    }),
    (input: ReturnType<typeof validRunInput>) => ({
      ...input,
      evidence: {
        ...input.evidence,
        versions: input.evidence.versions.map((version) => ({
          ...version,
          commitHash: "9".repeat(40),
        })),
      },
    }),
    (input: ReturnType<typeof validRunInput>) => ({
      ...input,
      evidence: {
        ...input.evidence,
        versions: input.evidence.versions.map((version) => ({ ...version, score: 97 })),
      },
    }),
    (input: ReturnType<typeof validRunInput>) => ({
      ...input,
      evidence: {
        ...input.evidence,
        qualityEvidence: { ...input.evidence.qualityEvidence, round: 1 },
      },
    }),
  ]) {
    assert.throws(
      () => validateGenerationTaskArtifactQualityGate(mutate(validRunInput())),
      GenerationTaskQualityGateError,
    );
  }
});

test("Generation Task Artifact quality gate fences the exact authoritative Attempt envelope", () => {
  for (const { name, mutate } of [
    {
      name: "input hash",
      mutate: (input: ReturnType<typeof validRunInput>) => ({
        ...input,
        evidence: { ...input.evidence, inputHash: "0".repeat(64) },
      }),
    },
    {
      name: "creation timestamp",
      mutate: (input: ReturnType<typeof validRunInput>) => ({
        ...input,
        evidence: { ...input.evidence, attemptCreatedAt: input.evidence.attemptCreatedAt + 1 },
      }),
    },
    {
      name: "Source Base commit",
      mutate: (input: ReturnType<typeof validRunInput>) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceBase: { ...input.evidence.sourceBase, commitHash: "1".repeat(40) },
        },
      }),
    },
    {
      name: "Source Base tree",
      mutate: (input: ReturnType<typeof validRunInput>) => ({
        ...input,
        evidence: {
          ...input.evidence,
          sourceBase: { ...input.evidence.sourceBase, treeHash: "2".repeat(40) },
        },
      }),
    },
    {
      name: "candidate retention ref",
      mutate: (input: ReturnType<typeof validRunInput>) => ({
        ...input,
        evidence: {
          ...input.evidence,
          candidateRetentionRef: `refs/dezin/generation-attempts/artifacts/${"3".repeat(64)}`,
        },
      }),
    },
  ] as const) {
    assert.throws(
      () => validateGenerationTaskArtifactQualityGate(mutate(validRunInput())),
      (error: unknown) => error instanceof GenerationTaskQualityGateError
        && error.message === "Artifact run evidence does not match the fenced Generation Task candidate",
      name,
    );
  }
});

test("Generation Task Artifact run envelope self-fences durable evidence before Core ownership", () => {
  const input = validRunInput();
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate({
      ...input,
      expectedEvidenceOwner: null,
      evidence: {
        ...input.evidence,
        qualityEvidence: {
          ...input.evidence.qualityEvidence,
          visualEvidence: input.evidence.qualityEvidence.visualEvidence.map((descriptor) => ({
            ...descriptor,
            owner: { ...descriptor.owner, projectId: "project-foreign" },
          })),
        },
      },
    }),
    GenerationTaskQualityGateError,
  );
});

test("Generation Task Artifact quality gate rejects ownerless non-visual evidence at a Core fence", () => {
  const input = validInput();
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate({
      ...input,
      qaProfile: {
        ...input.qaProfile,
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
      evidence: {
        protocol: input.evidence.protocol,
        candidate: input.evidence.candidate,
        contextPack: input.evidence.contextPack,
        frames: input.evidence.frames,
        frameResults: [],
        round: 0,
      },
    }),
    GenerationTaskQualityGateError,
  );
});

test("Generation Task Artifact quality gate permits explicitly non-blocking active findings", () => {
  const input = validInput();
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate({
    ...input,
    quality: {
      state: "needs-attention",
      score: 92,
      findings: [{
        severity: "P2",
        id: "minor-copy-wrap",
        message: "One secondary label wraps early",
        fix: "Increase its optional width",
        reviewStatus: "active",
      }],
    },
  }));
});

for (const { name, mutate } of [
  {
    name: "planned Frame drift",
    mutate(input: ReturnType<typeof validInput>) {
      return { ...input, renderSpec: { frames: [{ id: "mobile", name: "Mobile", width: 390, height: 844 }] } };
    },
  },
  {
    name: "failed quality",
    mutate(input: ReturnType<typeof validInput>) {
      return { ...input, quality: { state: "failed", score: 40, findings: [] } };
    },
  },
  {
    name: "blocking finding",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        quality: {
          state: "needs-attention",
          score: 80,
          findings: [{
            severity: "P1",
            id: "broken-hierarchy",
            message: "Hierarchy is broken",
            fix: "Restore the approved hierarchy",
          }],
        },
      };
    },
  },
  {
    name: "failed runtime evidence",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          runtimeChecks: [{ id: "frame:desktop", status: "failed" }],
        },
      };
    },
  },
  {
    name: "runtime Frame substitution",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          runtimeChecks: [{ id: "frame:mobile", status: "passed" }],
        },
      };
    },
  },
  {
    name: "visual Frame omission",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          visualReview: { ...input.evidence.visualReview, evidence: [] },
        },
      };
    },
  },
  {
    name: "visual summary checksum substitution",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          visualReview: {
            ...input.evidence.visualReview,
            evidence: input.evidence.visualReview.evidence.map((item) => ({
              ...item,
              sha256: "e".repeat(64),
            })),
          },
        },
      };
    },
  },
  {
    name: "Frame result Attempt substitution",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          frameResults: input.evidence.frameResults.map((item) => ({
            ...item,
            frameAttemptId: "quality-round-foreign-desktop",
          })),
        },
      };
    },
  },
  {
    name: "Frame capture identity substitution",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          frameResults: input.evidence.frameResults.map((item) => ({
            ...item,
            captureIdentity: { ...item.captureIdentity, sha256: "0".repeat(64) },
          })),
        },
      };
    },
  },
  {
    name: "undersized Frame capture identity",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          frameResults: input.evidence.frameResults.map((item) => ({
            ...item,
            captureIdentity: { ...item.captureIdentity, width: 1_439 },
          })),
        },
      };
    },
  },
  {
    name: "visual evidence owner substitution",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          visualEvidence: input.evidence.visualEvidence.map((item) => ({
            ...item,
            owner: { ...item.owner, projectId: "project-foreign" },
          })),
        },
      };
    },
  },
  {
    name: "zero-byte visual evidence",
    mutate(input: ReturnType<typeof validInput>) {
      return {
        ...input,
        evidence: {
          ...input.evidence,
          visualEvidence: input.evidence.visualEvidence.map((item) => ({
            ...item,
            byteLength: 0,
          })),
        },
      };
    },
  },
  {
    name: "missing visual evidence",
    mutate(input: ReturnType<typeof validInput>) {
      const { visualReview: _visualReview, ...evidence } = input.evidence;
      return { ...input, evidence };
    },
  },
] as const) {
  test(`Generation Task Artifact quality gate rejects ${name}`, () => {
    assert.throws(
      () => validateGenerationTaskArtifactQualityGate(mutate(validInput())),
      (error: unknown) => error instanceof GenerationTaskQualityGateError
        && error.failureClass === "qa",
    );
  });
}

test("Generation Task Artifact quality gate fails safely for hostile evidence", () => {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.throws(
    () => validateGenerationTaskArtifactQualityGate({ ...validInput(), evidence: revocable.proxy }),
    (error: unknown) => error instanceof GenerationTaskQualityGateError,
  );
});
