import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  GenerationTaskQualityGateError,
  validateGenerationTaskArtifactQualityGate,
} from "../src/generation-task-quality.ts";

function validInput() {
  const frames = [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }];
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
    `round-0-desktop-${sha256}.png`,
  ].join("/");
  const visualEvidence = [{
    protocol: "dezin.generation-task-visual-evidence.v1",
    owner,
    frame: { ...frames[0]!, frameAttemptId: "quality-round-0-desktop" },
    round: 0,
    mediaType: "image/png",
    sha256,
    byteLength: 1_024,
    storageKey,
  }];
  return {
    qaProfile: {
      requiredFrameIds: ["desktop"],
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
        frameId: "desktop",
        frameAttemptId: "quality-round-0-desktop",
        width: 1_440,
        height: 900,
        status: "passed",
        reviewed: true,
      }],
      round: 0,
      runtimeChecks: [{ id: "frame:desktop", status: "passed" }],
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

function validRunInput() {
  const input = validInput();
  const qualityEvidence = input.evidence;
  const inputHash = "f".repeat(64);
  const attemptCreatedAt = 10;
  const sourceBase = { commitHash: "e".repeat(40), treeHash: "f".repeat(40) };
  const candidateRetentionRef = canonicalCandidateRetentionRef({
    workspaceId: input.expectedEvidenceOwner.workspaceId,
    taskId: input.expectedEvidenceOwner.taskId,
    attempt: input.expectedEvidenceOwner.attempt,
    inputHash,
  });
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
      }],
      qualityEvidence,
    },
  };
}

test("Generation Task Artifact quality gate accepts exact high-quality evidence", () => {
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(validInput()));
});

test("Generation Task Artifact quality gate accepts an exact immutable run/version envelope", () => {
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(validRunInput()));
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
