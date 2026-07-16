import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GenerationTaskQualityGateError,
  validateGenerationTaskArtifactQualityGate,
} from "../src/generation-task-quality.ts";

function validInput() {
  const frames = [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }];
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
      runtimeChecks: [{ id: "load", status: "passed" }],
      visualReview: { status: "passed", fidelity: 0.98 },
    },
  };
}

test("Generation Task Artifact quality gate accepts exact high-quality evidence", () => {
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate(validInput()));
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
          runtimeChecks: [{ id: "load", status: "failed" }],
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
