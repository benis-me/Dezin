import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentRunner,
  AgentTurnInput,
  AgentTurnResult,
} from "../../../packages/agent/src/index.ts";
import type { GenerationTaskAttemptClaim } from "../../../packages/core/src/index.ts";
import { validateGenerationTaskArtifactQualityGate } from "../../../packages/core/src/index.ts";
import {
  ArtifactRunExecutor,
  ArtifactRunExecutorError,
  type ArtifactRunCandidateTransactionPort,
  type ArtifactRunPreparation,
} from "../src/orchestration/artifact-run-executor.ts";
import { artifactCandidateAttemptRef } from "../src/orchestration/artifact-candidate-transaction.ts";
import {
  SharinganCaptureReferenceError,
  type SharinganCaptureBundleFence,
} from "../src/orchestration/sharingan-capture-reference.ts";
import type {
  StandardArtifactCandidateIdentity,
  StandardArtifactQualityResult,
} from "../src/orchestration/standard-artifact-execution.ts";

type MutableArtifactRunPreparation = {
  -readonly [Key in keyof ArtifactRunPreparation]: ArtifactRunPreparation[Key];
};

const CONTEXT_HASH = "c".repeat(64);
const SOURCE_COMMIT = "1".repeat(40);
const SOURCE_TREE = "2".repeat(40);
const CANDIDATE_A = { commitHash: "3".repeat(40), treeHash: "4".repeat(40) };
const CANDIDATE_B = { commitHash: "5".repeat(40), treeHash: "6".repeat(40) };
const ATTEMPT_REF = artifactCandidateAttemptRef({
  workspaceId: "workspace-1",
  taskId: "task-page-checkout",
  attempt: 1,
  inputHash: "9".repeat(64),
  createdAt: 10,
  sourceCommitHash: SOURCE_COMMIT,
  sourceTreeHash: SOURCE_TREE,
});

class Runner implements AgentRunner {
  readonly id = "artifact-run-test";
  readonly inputs: AgentTurnInput[] = [];
  private readonly outputs: AgentTurnResult[];

  constructor(outputs: AgentTurnResult[]) {
    this.outputs = [...outputs];
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.inputs.push(input);
    return this.outputs.shift() ?? { text: "done", artifactHtml: "" };
  }
}

class Transaction implements ArtifactRunCandidateTransactionPort {
  readonly dir = "/tmp/dezin-artifact-run-test";
  readonly attemptRef: string;
  readonly commits: string[] = [];
  readonly restored: StandardArtifactCandidateIdentity[] = [];
  disposeCount = 0;
  disposeError: Error | null = null;
  private readonly fingerprints: string[];
  private readonly candidates: StandardArtifactCandidateIdentity[];

  constructor(input: {
    fingerprints: string[];
    candidates: StandardArtifactCandidateIdentity[];
    attemptRef?: string;
  }) {
    this.fingerprints = [...input.fingerprints];
    this.candidates = [...input.candidates];
    this.attemptRef = input.attemptRef ?? ATTEMPT_REF;
  }

  async fingerprint(): Promise<string> {
    return this.fingerprints.shift() ?? "stable";
  }

  async commit(message: string): Promise<StandardArtifactCandidateIdentity> {
    this.commits.push(message);
    const result = this.candidates.shift();
    assert.ok(result);
    return result;
  }

  async restore(candidate: StandardArtifactCandidateIdentity): Promise<void> {
    this.restored.push(candidate);
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    if (this.disposeError) throw this.disposeError;
  }
}

class CaptureFence implements SharinganCaptureBundleFence {
  readonly protocol = "dezin.sharingan-capture-fence.v1" as const;
  readonly worktreeDir = "/tmp/dezin-artifact-run-test";
  readonly mountPath = ".sharingan" as const;
  readonly fingerprint = "b".repeat(64);
  readonly reference;
  tampered = false;
  assetsHidden = false;
  assetIsolationCount = 0;
  verifyCount = 0;

  constructor(overrides: { revisionId?: string } = {}) {
    this.reference = Object.freeze({
      workspaceId: "workspace-1",
      contextPackId: `context-pack-${CONTEXT_HASH}`,
      contextPackHash: CONTEXT_HASH,
      resourceId: "capture-1",
      revisionId: overrides.revisionId ?? "capture-revision-1",
      revisionChecksum: "a".repeat(64),
    });
  }

  async verify(): Promise<void> {
    this.verifyCount += 1;
    if (this.tampered) {
      throw new SharinganCaptureReferenceError(
        "bundle-fingerprint-mismatch",
        "pinned capture changed",
      );
    }
  }

  async withoutMaterializedBundle<Result>(operation: () => Promise<Result>): Promise<Result> {
    return operation();
  }

  async withoutMaterializedAssets<Result>(operation: () => Promise<Result>): Promise<Result> {
    assert.equal(this.assetsHidden, false);
    this.assetsHidden = true;
    this.assetIsolationCount += 1;
    try {
      return await operation();
    } finally {
      this.assetsHidden = false;
    }
  }

  async dispose(): Promise<void> {}
}

function claim(overrides: {
  contextPackId?: string;
  sourceCommitHash?: string;
  sourceTreeHash?: string;
  maxRepairRounds?: number;
  maxAgentTurns?: number;
  sharingan?: boolean;
} = {}): GenerationTaskAttemptClaim {
  const contextPackId = overrides.contextPackId ?? `context-pack-${CONTEXT_HASH}`;
  const sourceCommitHash = overrides.sourceCommitHash ?? SOURCE_COMMIT;
  const sourceTreeHash = overrides.sourceTreeHash ?? SOURCE_TREE;
  const taskPayload = {
    version: 2,
    artifactPlan: {
      operation: "create",
      nodeId: "node-page-checkout",
      artifactId: "page-checkout",
      kind: "page",
      name: "Checkout",
      trackId: "track-main",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: [],
      responsiveFrameIds: [],
    },
    dependencyPlans: [],
    responsiveFrames: [],
    brief: {
      proposalRationale: "Build one exact checkout design",
      assumptions: [],
      targetInstructions: { operation: "create", kind: "page", name: "Checkout" },
    },
    capabilityDescriptors: [],
  };
  return {
    task: {
      id: "task-page-checkout",
      ordinal: 0,
      workspaceId: "workspace-1",
      planId: "plan-1",
      kind: "page",
      target: { type: "artifact", workspaceId: "workspace-1", id: "page-checkout", trackId: "track-main" },
      dependencyIds: [],
      payload: taskPayload,
      capabilities: [],
      qaProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
      resourceLimits: {
        timeoutMs: 60_000,
        maxAgentTurns: overrides.maxAgentTurns ?? 2,
        maxRepairRounds: overrides.maxRepairRounds ?? 1,
        maxOutputBytes: 1024 * 1024,
        capacityClasses: ["agent", "render-qa"],
      },
      intentHash: "7".repeat(64),
      idempotencyKey: "8".repeat(64),
      status: "running",
      blockedReason: null,
      blockedByTaskId: null,
      pendingContextPolicy: null,
      currentAttempt: 1,
      materializationFailures: 0,
      failureClass: null,
      error: null,
      nextEligibleAt: null,
      resultRevisionId: null,
      resultResourceRevisionId: null,
      resultSnapshotId: null,
      createdAt: 10,
      finishedAt: null,
    },
    attempt: {
      taskId: "task-page-checkout",
      planId: "plan-1",
      workspaceId: "workspace-1",
      attempt: 1,
      target: { type: "artifact", workspaceId: "workspace-1", id: "page-checkout", trackId: "track-main" },
      baseRevisionId: null,
      expectedSnapshotId: "snapshot-1",
      contextPackId,
      kernelRevisionId: "kernel-1",
      sourceCommitHash,
      sourceTreeHash,
      payload: structuredClone(taskPayload),
      dependencyOutputs: [],
      resourcePins: overrides.sharingan
        ? [{ ordinal: 0, resourceId: "capture-1", revisionId: "capture-revision-1", sourceTaskId: null }]
        : [],
      componentPins: [],
      retryContextPolicy: "same-context",
      executionMode: "full",
      inputHash: "9".repeat(64),
      attemptOrigin: "materialized",
      predecessorAttempt: null,
      automaticRetryIndex: 0,
      status: "running",
      blockedReason: null,
      failureClass: null,
      error: null,
      nextEligibleAt: null,
      candidateRevisionId: null,
      candidateResourceRevisionId: null,
      candidateEvidence: null,
      candidateEvidenceHash: null,
      lease: { taskId: "task-page-checkout", workspaceId: "workspace-1", attempt: 1, ownerId: "owner", leaseToken: "token" },
      leaseExpiresAt: 100,
      heartbeatAt: 50,
      createdAt: 10,
      startedAt: 40,
      finishedAt: null,
    },
    lease: { taskId: "task-page-checkout", workspaceId: "workspace-1", attempt: 1, ownerId: "owner", leaseToken: "token" },
    claims: [],
  } as unknown as GenerationTaskAttemptClaim;
}

function quality(input: {
  passed: boolean;
  score: number;
  repairs?: Array<Record<string, unknown>>;
}): StandardArtifactQualityResult {
  const findings = input.repairs ?? [];
  const frames = [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }];
  return {
    passed: input.passed,
    score: input.score,
    renderSpec: { frames },
    quality: { state: input.passed ? "passed" : "failed", score: input.score, findings },
    evidence: {},
    repairFindings: findings,
  };
}

function exactQualityEvidence(
  candidate: StandardArtifactCandidateIdentity,
  round: number,
): Record<string, unknown> {
  const frame = { id: "desktop", name: "Desktop", width: 1_440, height: 900 };
  const frameAttemptId = `quality-round-${round}-desktop`;
  const sha256 = `${round === 0 ? "a" : "b"}`.repeat(64);
  const storageKey = [
    "generation-task-evidence",
    "project-1",
    "workspace-1",
    "plan-1",
    "task-page-checkout",
    "attempt-1",
    "visual",
    `round-${round}-desktop-${sha256}.png`,
  ].join("/");
  const summary = {
    frameId: frame.id,
    frameAttemptId,
    sha256,
    byteLength: 1_024,
    storageKey,
  };
  return {
    protocol: "dezin.standard-artifact-quality.v1",
    candidate,
    contextPack: { id: `context-pack-${CONTEXT_HASH}`, hash: CONTEXT_HASH },
    frames: [frame],
    frameResults: [{
      frameId: frame.id,
      frameAttemptId,
      width: frame.width,
      height: frame.height,
      status: "passed",
      reviewed: true,
    }],
    round,
    runtimeChecks: [{ id: "frame:desktop", status: "passed" }],
    visualReview: { status: "passed", fidelity: 0.98, evidence: [summary] },
    visualEvidence: [{
      protocol: "dezin.generation-task-visual-evidence.v1",
      owner: {
        projectId: "project-1",
        workspaceId: "workspace-1",
        planId: "plan-1",
        taskId: "task-page-checkout",
        attempt: 1,
        candidateCommitHash: candidate.commitHash,
        candidateTreeHash: candidate.treeHash,
        contextPackId: `context-pack-${CONTEXT_HASH}`,
        contextPackHash: CONTEXT_HASH,
      },
      frame: { ...frame, frameAttemptId },
      round,
      mediaType: "image/png",
      sha256,
      byteLength: 1_024,
      storageKey,
    }],
  };
}

function preparation(input: {
  transaction: Transaction;
  runner: Runner;
  qualities: StandardArtifactQualityResult[];
  contextPackId?: string;
  contextPackHash?: string;
  sourceCommitHash?: string;
  sourceTreeHash?: string;
  sharinganCapture?: SharinganCaptureBundleFence;
  onEvaluate?: () => void;
}): ArtifactRunPreparation {
  const qualities = [...input.qualities];
  return {
    projectId: "project-1",
    runner: input.runner,
    transaction: input.transaction,
    evaluator: {
      async evaluate(evaluation) {
        const result = qualities.shift();
        assert.ok(result);
        input.onEvaluate?.();
        return {
          ...result,
          evidence: exactQualityEvidence(evaluation.candidate, evaluation.round),
        };
      },
    },
    contextPackId: input.contextPackId ?? `context-pack-${CONTEXT_HASH}`,
    contextPackHash: input.contextPackHash ?? CONTEXT_HASH,
    sourceCommitHash: input.sourceCommitHash ?? SOURCE_COMMIT,
    sourceTreeHash: input.sourceTreeHash ?? SOURCE_TREE,
    systemPrompt: "Build the frozen Page plan using the exact Context Pack.",
    initialMessage: "Create the approved checkout Artifact.",
    history: [{ role: "user", content: "Approved direction" }],
    env: { DEZIN_TASK_ID: "task-page-checkout" },
    ...(input.sharinganCapture === undefined ? {} : { sharinganCapture: input.sharinganCapture }),
    buildRepairPrompt: ({ round, prior }) => (
      prior.quality.repairFindings.length > 0 ? `Repair exact findings, round ${round}.` : null
    ),
  };
}

test("ArtifactRunExecutor returns the selected immutable candidate with bounded audit evidence", async () => {
  const transaction = new Transaction({
    fingerprints: ["base", "draft", "draft", "repair"],
    candidates: [CANDIDATE_A, CANDIDATE_B],
  });
  const runner = new Runner([
    { text: "draft", artifactHtml: "" },
    { text: "repair", artifactHtml: "" },
  ]);
  const events: string[] = [];
  const reported: unknown[] = [];
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner,
          qualities: [
            quality({ passed: false, score: 88, repairs: [{ id: "overflow" }] }),
            quality({ passed: true, score: 97 }),
          ],
        });
      },
    },
    onEvent: (_claim, event) => {
      events.push(`${event.type}:${event.round}`);
      if (event.type === "activity") throw new Error("observer failure");
    },
    reportError: (error) => reported.push(error),
  });

  const result = await executor.execute(claim(), new AbortController().signal);

  assert.equal(result.sourceCommitHash, CANDIDATE_B.commitHash);
  assert.equal(result.sourceTreeHash, CANDIDATE_B.treeHash);
  assert.equal(result.artifactId, "page-checkout");
  assert.equal(result.trackId, "track-main");
  assert.deepEqual(result.quality, { state: "passed", score: 97, findings: [] });
  const selectedQualityEvidence = exactQualityEvidence(CANDIDATE_B, 1);
  assert.deepEqual(result.evidence, {
    runtimeChecks: selectedQualityEvidence.runtimeChecks,
    visualReview: selectedQualityEvidence.visualReview,
    protocol: "dezin.artifact-run.v1",
    projectId: "project-1",
    taskId: "task-page-checkout",
    planId: "plan-1",
    workspaceId: "workspace-1",
    attempt: 1,
    attemptCreatedAt: 10,
    inputHash: "9".repeat(64),
    contextPackId: `context-pack-${CONTEXT_HASH}`,
    contextPackHash: CONTEXT_HASH,
    sourceBase: { commitHash: SOURCE_COMMIT, treeHash: SOURCE_TREE },
    candidateRetentionRef: transaction.attemptRef,
    selectedRound: 1,
    versions: [
      { round: 0, commitHash: CANDIDATE_A.commitHash, treeHash: CANDIDATE_A.treeHash, passed: false, score: 88 },
      { round: 1, commitHash: CANDIDATE_B.commitHash, treeHash: CANDIDATE_B.treeHash, passed: true, score: 97 },
    ],
    qualityEvidence: selectedQualityEvidence,
  });
  validateGenerationTaskArtifactQualityGate({
    qaProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
    plannedFrames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    renderSpec: result.renderSpec,
    quality: result.quality,
    evidence: result.evidence,
    expectedEvidenceOwner: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      taskId: "task-page-checkout",
      attempt: 1,
      inputHash: "9".repeat(64),
      attemptCreatedAt: 10,
      sourceBase: { commitHash: SOURCE_COMMIT, treeHash: SOURCE_TREE },
      candidateRetentionRef: transaction.attemptRef,
      candidateCommitHash: CANDIDATE_B.commitHash,
      candidateTreeHash: CANDIDATE_B.treeHash,
      contextPackId: `context-pack-${CONTEXT_HASH}`,
      contextPackHash: CONTEXT_HASH,
    },
  });
  assert.equal(transaction.disposeCount, 1);
  assert.deepEqual(transaction.restored, []);
  assert.equal(runner.inputs[1]?.message, "Repair exact findings, round 1.");
  assert.ok(events.includes("quality:1"));
  assert.deepEqual(reported, []);
});

test("ArtifactRunExecutor restores the best passing round before returning it", async () => {
  const transaction = new Transaction({
    fingerprints: ["base", "good", "good", "regressed"],
    candidates: [CANDIDATE_A, CANDIDATE_B],
  });
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner: new Runner([{ text: "good", artifactHtml: "" }, { text: "worse", artifactHtml: "" }]),
          qualities: [
            quality({ passed: true, score: 96, repairs: [{ id: "polish" }] }),
            quality({ passed: false, score: 99 }),
          ],
        });
      },
    },
  });

  const result = await executor.execute(claim(), new AbortController().signal);
  assert.equal(result.sourceCommitHash, CANDIDATE_A.commitHash);
  assert.deepEqual(transaction.restored, [CANDIDATE_A]);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor rejects a substituted Context Pack and still disposes the worktree", async () => {
  const transaction = new Transaction({ fingerprints: [], candidates: [] });
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner: new Runner([]),
          qualities: [],
          contextPackId: `context-pack-${"d".repeat(64)}`,
          contextPackHash: "d".repeat(64),
        });
      },
    },
  });

  await assert.rejects(
    executor.execute(claim(), new AbortController().signal),
    (error) => error instanceof ArtifactRunExecutorError
      && error.code === "context-mismatch"
      && error.failureClass === "context",
  );
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor rejects a source-base substitution before the Agent turn", async () => {
  const transaction = new Transaction({ fingerprints: [], candidates: [] });
  const runner = new Runner([]);
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner,
          qualities: [],
          sourceTreeHash: "a".repeat(40),
        });
      },
    },
  });

  await assert.rejects(
    executor.execute(claim(), new AbortController().signal),
    (error) => error instanceof ArtifactRunExecutorError && error.code === "source-base-mismatch",
  );
  assert.equal(runner.inputs.length, 0);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor rejects a substituted Sharingan Resource Revision fence before the Agent turn", async () => {
  const transaction = new Transaction({ fingerprints: [], candidates: [] });
  const runner = new Runner([]);
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner,
          qualities: [],
          sharinganCapture: new CaptureFence({ revisionId: "capture-revision-foreign" }),
        });
      },
    },
  });

  await assert.rejects(
    executor.execute(claim({ sharingan: true }), new AbortController().signal),
    (error) => error instanceof ArtifactRunExecutorError
      && error.code === "reference-mismatch"
      && error.failureClass === "context",
  );
  assert.equal(runner.inputs.length, 0);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor fails closed when the Agent tampers with the pinned Sharingan bundle", async () => {
  const fence = new CaptureFence();
  const transaction = new Transaction({ fingerprints: ["base"], candidates: [] });
  const runner = new Runner([{ text: "tampered", artifactHtml: "" }]);
  const originalRunTurn = runner.runTurn.bind(runner);
  runner.runTurn = async (input) => {
    const result = await originalRunTurn(input);
    fence.tampered = true;
    return result;
  };
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({ transaction, runner, qualities: [], sharinganCapture: fence });
      },
    },
  });

  await assert.rejects(
    executor.execute(claim({ sharingan: true }), new AbortController().signal),
    (error) => error instanceof ArtifactRunExecutorError
      && error.code === "reference-mismatch"
      && error.failureClass === "context",
  );
  assert.equal(fence.verifyCount, 3);
  assert.equal(transaction.commits.length, 0);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor fails closed when QA tampers with the pinned Sharingan bundle", async () => {
  const fence = new CaptureFence();
  const transaction = new Transaction({
    fingerprints: ["base", "candidate"],
    candidates: [CANDIDATE_A],
  });
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner: new Runner([{ text: "candidate", artifactHtml: "" }]),
          qualities: [quality({ passed: true, score: 100 })],
          sharinganCapture: fence,
          onEvaluate: () => { fence.tampered = true; },
        });
      },
    },
  });

  await assert.rejects(
    executor.execute(claim({ sharingan: true }), new AbortController().signal),
    (error) => error instanceof ArtifactRunExecutorError
      && error.code === "reference-mismatch"
      && error.failureClass === "context",
  );
  assert.equal(fence.verifyCount, 5);
  assert.equal(transaction.commits.length, 1);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor hides runtime-served Sharingan assets for the complete QA evaluation", async () => {
  const fence = new CaptureFence();
  const transaction = new Transaction({
    fingerprints: ["base", "candidate"],
    candidates: [CANDIDATE_A],
  });
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner: new Runner([{ text: "candidate", artifactHtml: "" }]),
          qualities: [quality({ passed: true, score: 100 })],
          sharinganCapture: fence,
          onEvaluate: () => { assert.equal(fence.assetsHidden, true); },
        });
      },
    },
  });

  await executor.execute(claim({ sharingan: true }), new AbortController().signal);
  assert.equal(fence.assetIsolationCount, 1);
  assert.equal(fence.assetsHidden, false);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor disposes when prepare returns a transaction at the abort boundary", async () => {
  const transaction = new Transaction({ fingerprints: [], candidates: [] });
  const runner = new Runner([]);
  const controller = new AbortController();
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        const result = preparation({ transaction, runner, qualities: [] });
        controller.abort(new Error("stop after preparation"));
        return result;
      },
    },
  });

  await assert.rejects(executor.execute(claim(), controller.signal), /stop after preparation/);
  assert.equal(runner.inputs.length, 0);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor preserves abort as the primary cause when disposal also fails", async () => {
  const transaction = new Transaction({ fingerprints: [], candidates: [] });
  const cleanupError = new Error("worktree cleanup failed after abort");
  transaction.disposeError = cleanupError;
  const runner = new Runner([]);
  const controller = new AbortController();
  const abortError = new Error("stop after preparation");
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        const result = preparation({ transaction, runner, qualities: [] });
        controller.abort(abortError);
        return result;
      },
    },
  });

  await assert.rejects(
    executor.execute(claim(), controller.signal),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, abortError);
      assert.deepEqual(error.errors, [abortError, cleanupError]);
      return true;
    },
  );
  assert.equal(runner.inputs.length, 0);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor rejects a valid-looking ref not derived from the immutable Attempt", async () => {
  const transaction = new Transaction({
    fingerprints: [],
    candidates: [],
    attemptRef: `refs/dezin/generation-attempts/artifacts/${"f".repeat(64)}`,
  });
  const runner = new Runner([]);
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({ transaction, runner, qualities: [] });
      },
    },
  });

  await assert.rejects(
    executor.execute(claim(), new AbortController().signal),
    (error) => error instanceof ArtifactRunExecutorError && error.code === "invalid-preparation",
  );
  assert.equal(runner.inputs.length, 0);
  assert.equal(transaction.disposeCount, 1);
});

test("ArtifactRunExecutor rejects hostile or unbounded history and environment data without invoking accessors", async (t) => {
  const cases: Array<{
    name: string;
    mutate(value: MutableArtifactRunPreparation): void;
    accessed?: { value: boolean };
  }> = [
    {
      name: "proxied history",
      mutate(value) {
        value.history = new Proxy([], {});
      },
    },
    {
      name: "history accessor",
      accessed: { value: false },
      mutate(value) {
        const accessed = cases[1]!.accessed!;
        value.history = [Object.defineProperty({}, "role", {
          enumerable: true,
          get() {
            accessed.value = true;
            return "user";
          },
        }) as { role: "user"; content: string }];
      },
    },
    {
      name: "oversized history item",
      mutate(value) {
        value.history = [{ role: "user", content: "x".repeat(1_048_577) }];
      },
    },
    {
      name: "environment accessor",
      accessed: { value: false },
      mutate(value) {
        const accessed = cases[3]!.accessed!;
        value.env = Object.defineProperty({}, "TOKEN", {
          enumerable: true,
          get() {
            accessed.value = true;
            return "secret";
          },
        });
      },
    },
    {
      name: "oversized environment",
      mutate(value) {
        value.env = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "value"]));
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const transaction = new Transaction({ fingerprints: [], candidates: [] });
      const runner = new Runner([]);
      const executor = new ArtifactRunExecutor({
        preparation: {
          async prepare() {
            const result = preparation({ transaction, runner, qualities: [] });
            entry.mutate(result as MutableArtifactRunPreparation);
            return result;
          },
        },
      });
      await assert.rejects(
        executor.execute(claim(), new AbortController().signal),
        (error) => error instanceof ArtifactRunExecutorError && error.code === "invalid-preparation",
      );
      assert.equal(entry.accessed?.value ?? false, false);
      assert.equal(runner.inputs.length, 0);
      assert.equal(transaction.disposeCount, 1);
    });
  }
});

test("a primary execution failure is preserved and disposal failure is durably exposed", async () => {
  const transaction = new Transaction({ fingerprints: ["same", "same"], candidates: [] });
  transaction.disposeError = new Error("dispose failed");
  const reported: unknown[] = [];
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner: new Runner([{ text: "no change", artifactHtml: "" }]),
          qualities: [],
        });
      },
    },
    reportError: (error) => reported.push(error),
  });

  await assert.rejects(
    executor.execute(claim(), new AbortController().signal),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, error.errors[0]);
      assert.match(String(error.errors[0]), /without changing project files/);
      assert.equal(error.errors[1], transaction.disposeError);
      assert.match(error.message, /cleanup failed/i);
      return true;
    },
  );
  assert.equal(transaction.disposeCount, 1);
  assert.deepEqual(reported, [transaction.disposeError]);
});

test("a disposal failure after successful execution fails the leaf instead of claiming completion", async () => {
  const transaction = new Transaction({
    fingerprints: ["base", "candidate"],
    candidates: [CANDIDATE_A],
  });
  transaction.disposeError = new Error("worktree cleanup failed");
  const executor = new ArtifactRunExecutor({
    preparation: {
      async prepare() {
        return preparation({
          transaction,
          runner: new Runner([{ text: "done", artifactHtml: "" }]),
          qualities: [quality({ passed: true, score: 100 })],
        });
      },
    },
  });

  await assert.rejects(
    executor.execute(claim({ maxRepairRounds: 0, maxAgentTurns: 1 }), new AbortController().signal),
    /worktree cleanup failed/,
  );
});
