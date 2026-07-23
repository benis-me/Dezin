import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generationTaskArtifactCandidateRetentionRef,
  validateGenerationTaskArtifactQualityGate,
  type QualityFinding,
  type Settings,
} from "../../../packages/core/src/index.ts";
import type { ContextPack } from "../src/context/context-types.ts";
import type { ArtifactRunInfrastructureInput } from "../src/orchestration/artifact-run-preparation.ts";
import { visualQaFrameAttemptId } from "../src/visual-qa.ts";
import { generationTaskVisualEvidenceFrameStorageSegment } from "../src/orchestration/generation-task-visual-evidence.ts";
import {
  ProductionStandardArtifactQualityEvaluator,
  ProductionStandardArtifactQualityEvaluatorError,
  inspectStandardArtifactCandidate,
  type ProductionStandardArtifactQualityEvaluatorDependencies,
} from "../src/orchestration/standard-artifact-quality-evaluator.ts";

const CONTEXT_HASH = "c".repeat(64);
const CANDIDATE = { commitHash: "3".repeat(40), treeHash: "4".repeat(40) };
const SOURCE_AUTHORITY = Object.freeze({
  resourceId: "capture-1",
  revisionId: "capture-revision-1",
  revisionChecksum: "e".repeat(64),
});
const FRAME = {
  id: "checkout-desktop",
  name: "Checkout desktop",
  width: 1440,
  height: 900,
  initialState: "payment",
  fixture: { cartCount: 2 },
  background: "#ffffff",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("candidate inspection excludes both fenced Sharingan materialization roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-quality-sharingan-sidecar-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@dezin.local");
    writeFileSync(join(root, "package.json"), "{}\n");
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "base");
    const candidate = {
      commitHash: git(root, "rev-parse", "HEAD"),
      treeHash: git(root, "rev-parse", "HEAD^{tree}"),
    };
    mkdirSync(join(root, ".sharingan"), { recursive: true });
    writeFileSync(join(root, ".sharingan", "pages.json"), "{\"pages\":[]}\n");
    mkdirSync(join(root, "public", "_assets"), { recursive: true });
    writeFileSync(join(root, "public", "_assets", "source.png"), "immutable source asset\n");

    const withSidecar = await inspectStandardArtifactCandidate({
      repositoryDir: root,
      worktreeDir: root,
      candidate,
      immutableSharinganSidecar: true,
      signal: new AbortController().signal,
    });
    assert.equal(withSidecar.status, "");

    writeFileSync(join(root, "package.json"), "{\"changed\":true}\n");
    const withSourceMutation = await inspectStandardArtifactCandidate({
      repositoryDir: root,
      worktreeDir: root,
      candidate,
      immutableSharinganSidecar: true,
      signal: new AbortController().signal,
    });
    assert.match(withSourceMutation.status, /package\.json/);
    assert.doesNotMatch(withSourceMutation.status, /\.sharingan/);
    assert.doesNotMatch(withSourceMutation.status, /public\/_assets/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function infrastructure(input: {
  sharingan?: boolean;
  blockingSeverities?: Array<"P0" | "P1" | "P2">;
  requireRuntimeChecks?: boolean;
  requireVisualReview?: boolean;
} = {}): ArtifactRunInfrastructureInput {
  const payload = {
    version: 2,
    artifactPlan: {
      operation: "create",
      nodeId: "node-checkout",
      artifactId: "artifact-checkout",
      kind: "page",
      name: "Checkout",
      trackId: "track-main",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: ["visual"],
      responsiveFrameIds: [FRAME.id],
    },
    dependencyPlans: [],
    responsiveFrames: [FRAME],
    brief: {
      proposalRationale: "Design a precise, calm checkout",
      assumptions: [],
      targetInstructions: { operation: "create", kind: "page", name: "Checkout" },
    },
    capabilityDescriptors: [{ id: "visual", kind: "visual-qa", required: true }],
  };
  const contextPack: ContextPack = {
    id: `context-pack-${CONTEXT_HASH}`,
    workspaceId: "workspace-1",
    graphRevision: 3,
    target: { type: "artifact", id: "artifact-checkout" },
    intent: "generate",
    messageChecksum: "d".repeat(64),
    items: input.sharingan ? [{
      ordinal: 0,
      contextClass: "explicit",
      ref: {
        kind: "resource",
        id: "capture-1",
        resourceKind: "sharingan-capture",
        revisionId: "capture-revision-1",
      },
      resolvedKind: "resource-revision",
      content: "Captured source",
      checksum: "e".repeat(64),
      reason: "Exact visual source",
      trustLevel: "untrusted",
      capabilities: [],
      boundary: { source: "capture", readOnly: true, mayGrantCapabilities: false },
      tokenEstimate: 4,
      provenance: { source: "capture" },
      provided: true,
    }] : [],
    omissions: [],
    tokenEstimate: 4,
    manifestPath: `context-packs/workspace/${CONTEXT_HASH}.json`,
    hash: CONTEXT_HASH,
    createdAt: 1_700_000_000_000,
  };
  return {
    projectId: "project-1",
    claim: {
      task: {
        id: "task-checkout",
        planId: "plan-1",
        workspaceId: "workspace-1",
        kind: "page",
        target: {
          type: "artifact",
          workspaceId: "workspace-1",
          id: "artifact-checkout",
          trackId: "track-main",
        },
        payload,
        capabilities: ["visual"],
        qaProfile: {
          requiredFrameIds: [FRAME.id],
          blockingSeverities: input.blockingSeverities ?? ["P0", "P1"],
          requireRuntimeChecks: input.requireRuntimeChecks ?? true,
          requireVisualReview: input.requireVisualReview ?? true,
        },
      },
      attempt: {
        taskId: "task-checkout",
        planId: "plan-1",
        workspaceId: "workspace-1",
        attempt: 1,
        inputHash: "a".repeat(64),
        createdAt: 1_700_000_000_000,
        contextPackId: contextPack.id,
        sourceCommitHash: "1".repeat(40),
        sourceTreeHash: "2".repeat(40),
        resourcePins: input.sharingan ? [{
          resourceId: SOURCE_AUTHORITY.resourceId,
          revisionId: SOURCE_AUTHORITY.revisionId,
        }] : [],
        componentPins: [],
      },
    } as unknown as ArtifactRunInfrastructureInput["claim"],
    contextPack,
    hasExactSharinganCapture: input.sharingan === true,
    sharinganReference: input.sharingan ? {
      workspaceId: "workspace-1",
      contextPackId: contextPack.id,
      contextPackHash: contextPack.hash,
      ...SOURCE_AUTHORITY,
    } : null,
    repositoryDir: "/repo",
    worktreeDir: "/repo/worktree",
  };
}

const settings = {
  visualQaEnabled: false,
  agentCommand: "claude",
  model: "claude-sonnet",
  visualQaAgentCommand: "",
  visualQaModel: "",
} as Settings;

function reviewedFinding() {
  return {
    severity: "P2" as const,
    id: "visual-reviewed",
    message: "Visual review completed.",
    fix: "No action required.",
  };
}

function visualReport(
  input: Parameters<ProductionStandardArtifactQualityEvaluatorDependencies["visualQa"]>[0],
  findings: QualityFinding[] = [reviewedFinding()],
) {
  return {
    findings,
    frames: input.renderFrames.map((frame, index) => ({
      frameId: frame.id,
      frameAttemptId: visualQaFrameAttemptId(input.frameAttemptIdPrefix, frame, index),
      width: frame.width,
      height: frame.height,
      status: "passed" as const,
      screenshotPath: `/captures/${frame.id}.png`,
      captureIdentity: {
        sha256: "e".repeat(64),
        byteLength: 67,
        width: frame.width,
        height: frame.height,
      },
      reviewed: input.runtimeOnly !== true,
    })),
    ...(input.isSharingan ? {
      sourceCapture: {
        scope: "source" as const,
        sourceAttemptId: `${input.frameAttemptIdPrefix}-source`,
        width: 1440,
        height: 900,
        status: "passed" as const,
        screenshotPath: input.screenshotPath,
        captureIdentity: {
          sha256: "f".repeat(64),
          byteLength: 67,
          width: 1440,
          height: 900,
        },
        reviewed: input.runtimeOnly !== true,
      },
    } : {}),
  };
}

function dependencies(overrides: Partial<ProductionStandardArtifactQualityEvaluatorDependencies> = {}) {
  const calls = {
    inspect: 0,
    acquire: 0,
    release: 0,
    visual: 0,
    persist: 0,
    persistSource: 0,
    references: 0,
    visualInput: null as Parameters<ProductionStandardArtifactQualityEvaluatorDependencies["visualQa"]>[0] | null,
    runtimeInput: null as Parameters<ProductionStandardArtifactQualityEvaluatorDependencies["acquireRuntime"]>[0] | null,
  };
  const value: ProductionStandardArtifactQualityEvaluatorDependencies = {
    async inspectCandidate(input) {
      calls.inspect += 1;
      return { ...input.candidate, status: "" };
    },
    async acquireRuntime(input) {
      calls.acquire += 1;
      calls.runtimeInput = input;
      return {
        leaseId: "lease-1",
        url: `http://127.0.0.1:4173/#dezin-bridge=${"n".repeat(43)}`,
        bridgeNonce: "n".repeat(43),
        expiresAt: Date.now() + 60_000,
        async release() { calls.release += 1; },
      };
    },
    async collectLintSurface() { return "export const checkout = true;"; },
    lint() { return []; },
    async visualQa(input) {
      calls.visual += 1;
      calls.visualInput = input;
      return visualReport(input);
    },
    async persistEvidence(input) {
      calls.persist += 1;
      const sha256 = "e".repeat(64);
      return {
        protocol: "dezin.generation-task-visual-evidence.v1" as const,
        owner: input.owner,
        frame: input.frame,
        round: input.round,
        mediaType: "image/png" as const,
        sha256,
        byteLength: 67,
        storageKey: [
          "generation-task-evidence",
          input.owner.projectId,
          input.owner.workspaceId,
          input.owner.planId,
          input.owner.taskId,
          `attempt-${input.owner.attempt}`,
          "visual",
          `round-${input.round}-${generationTaskVisualEvidenceFrameStorageSegment(input.frame.id)}-${sha256}.png`,
        ].join("/"),
      };
    },
    async persistSourceEvidence(input) {
      calls.persistSource += 1;
      const sha256 = "f".repeat(64);
      return {
        protocol: "dezin.generation-task-source-visual-evidence.v1" as const,
        owner: input.owner,
        capture: input.capture,
        sourceAuthority: input.sourceAuthority,
        round: input.round,
        mediaType: "image/png" as const,
        sha256,
        byteLength: 67,
        storageKey: [
          "generation-task-evidence",
          input.owner.projectId,
          input.owner.workspaceId,
          input.owner.planId,
          input.owner.taskId,
          `attempt-${input.owner.attempt}`,
          "visual",
          `round-${input.round}-source-${sha256}.png`,
        ].join("/"),
      };
    },
    sharinganReference() {
      calls.references += 1;
      return undefined;
    },
    ...overrides,
  };
  return { calls, value };
}

test("production evaluator audits the exact immutable frames and emits publishable gate evidence", async () => {
  const infra = infrastructure();
  const deps = dependencies();
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });
  const signal = new AbortController().signal;

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal,
  });

  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.deepEqual(result.renderSpec, { frames: [FRAME] });
  assert.deepEqual(result.quality, {
    state: "passed",
    score: 100,
    findings: [],
  });
  assert.deepEqual(result.repairFindings, []);
  assert.deepEqual(result.evidence.runtimeChecks, [{
    id: `frame:${FRAME.id}`,
    status: "passed",
  }]);
  assert.equal((result.evidence.visualReview as { status: string }).status, "passed");
  assert.equal((result.evidence.visualReview as { fidelity: number }).fidelity, 1);
  assert.equal((result.evidence.visualReview as { evidence: unknown[] }).evidence.length, 1);
  assert.deepEqual(result.evidence.contextPack, {
    id: infra.contextPack.id,
    hash: infra.contextPack.hash,
  });
  assert.deepEqual(deps.calls.visualInput?.renderFrames, [FRAME]);
  assert.equal(deps.calls.visualInput?.signal, signal);
  assert.equal(deps.calls.visualInput?.settings.visualQaEnabled, true);
  assert.equal(deps.calls.visualInput?.renderUrl, `http://127.0.0.1:4173/#dezin-bridge=${"n".repeat(43)}`);
  assert.ok(deps.calls.visualInput?.screenshotEvidenceRoot,
    "the evaluator must grant the visual reviewer one exact daemon-owned capture root");
  assert.equal(
    deps.calls.visualInput?.screenshotPath,
    join(deps.calls.visualInput!.screenshotEvidenceRoot!, "screenshot.png"),
  );
  assert.notEqual(deps.calls.visualInput?.screenshotEvidenceRoot, infra.worktreeDir,
    "generated capture authority stays separate from candidate/source evidence authority");
  assert.equal(deps.calls.runtimeInput?.projectId, "project-1");
  assert.equal((result.evidence.visualEvidence as Array<{ owner: { projectId: string }; frame: { id: string } }>)[0]?.owner.projectId, "project-1");
  assert.equal((result.evidence.visualEvidence as Array<{ frame: { id: string } }>)[0]?.frame.id, FRAME.id);
  assert.equal(deps.calls.inspect, 2, "candidate identity and source cleanliness are checked before and after QA");
  assert.equal(deps.calls.acquire, 1);
  assert.equal(deps.calls.release, 1);
  assert.equal(deps.calls.persist, 1);
});

test("production evaluator preserves a Viewer-safe Unicode Frame id while validating its hashed evidence locator", async () => {
  const unicodeFrame = { ...FRAME, id: "结账 · 宽屏", name: "结账宽屏" };
  const infra = infrastructure();
  const payload = infra.claim.task.payload as {
    artifactPlan: { responsiveFrameIds: string[] };
    responsiveFrames: Array<typeof FRAME>;
  };
  payload.artifactPlan.responsiveFrameIds = [unicodeFrame.id];
  payload.responsiveFrames = [unicodeFrame];
  (infra.claim.task.qaProfile as { requiredFrameIds: string[] }).requiredFrameIds = [unicodeFrame.id];
  const deps = dependencies();
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, true);
  const [descriptor] = result.evidence.visualEvidence as Array<{
    frame: { id: string };
    storageKey: string;
  }>;
  assert.equal(descriptor?.frame.id, unicodeFrame.id);
  assert.match(
    descriptor?.storageKey ?? "",
    new RegExp(`/round-0-frame-[a-f0-9]{64}-${"e".repeat(64)}\\.png$`),
  );
});

test("production evaluator applies persisted rule and selector quality ignores only to advisory findings", async () => {
  const infra = infrastructure();
  const deps = dependencies({
    lint() {
      return [{
        severity: "P2",
        id: "low-contrast",
        message: "CTA contrast is below the project threshold.",
        fix: "Increase foreground contrast.",
        selector: ".checkout-cta",
      }];
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    qualityIgnores: [{ ruleId: "low-contrast", selector: ".checkout-cta" }],
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.quality.findings, []);
  assert.deepEqual(result.repairFindings, []);
});

test("production evaluator never lets a persisted ignore weaken the immutable blocking floor", async () => {
  const infra = infrastructure();
  const deps = dependencies({
    lint() {
      return [{
        severity: "P1",
        id: "low-contrast",
        message: "CTA contrast is below the project threshold.",
        fix: "Increase foreground contrast.",
        selector: ".checkout-cta",
      }];
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    qualityIgnores: [{ ruleId: "low-contrast", selector: ".checkout-cta" }],
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, false);
  const quality = result.quality as { state: string; findings: Array<{ id: string }> };
  assert.equal(quality.state, "failed");
  assert.equal(quality.findings[0]?.id, "low-contrast");
  assert.equal(result.repairFindings[0]?.id, "low-contrast");
});

test("production evaluator rejects an unsafe Store Project owner before acquiring runtime", () => {
  const infra = infrastructure();
  assert.throws(
    () => new ProductionStandardArtifactQualityEvaluator({
      infrastructure: infra,
      projectId: "../substituted-project",
      settings,
      dataDir: "/data",
      agentCommand: "claude",
      dependencies: dependencies().value,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "invalid-input",
  );
});

test("production evaluator rejects Sharingan boolean state without its immutable reference", () => {
  const infra = infrastructure({ sharingan: true });
  assert.throws(
    () => new ProductionStandardArtifactQualityEvaluator({
      infrastructure: { ...infra, sharinganReference: null },
      projectId: "project-1",
      settings,
      dataDir: "/data",
      agentCommand: "claude",
      dependencies: dependencies().value,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "invalid-input",
  );
});

test("production evaluator classifies capture storage allocation failure as retryable storage infrastructure", async () => {
  const infra = infrastructure();
  const deps = dependencies();
  Object.assign(deps.value, {
    async createCaptureDir() {
      throw new Error("scratch volume unavailable");
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "evidence-unavailable"
      && error.failureClass === "storage"
      && /scratch volume unavailable/.test(error.message),
  );
  assert.equal(deps.calls.acquire, 0);
});

test("runtime infrastructure failure is typed for bounded retry and a successor evaluation can pass", async () => {
  const infra = infrastructure();
  let acquisitions = 0;
  const deps = dependencies({
    async acquireRuntime() {
      acquisitions += 1;
      if (acquisitions === 1) throw new Error("vite failed to compile");
      return {
        leaseId: "lease-successor",
        url: `http://127.0.0.1:4173/#dezin-bridge=${"n".repeat(43)}`,
        bridgeNonce: "n".repeat(43),
        expiresAt: Date.now() + 60_000,
        async release() {},
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.failureClass === "build-infrastructure",
  );
  const successor = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });
  assert.equal(successor.passed, true);
  assert.equal(deps.calls.visual, 1);
});

test("runtime-only quality checks probe every exact Frame instead of treating lease acquisition as success", async () => {
  const infra = infrastructure({ requireRuntimeChecks: true, requireVisualReview: false });
  const runtimeFinding = {
    severity: "P1" as const,
    id: `visual-runtime-error@${FRAME.id}`,
    message: "The exact payment Frame throws during mount.",
    fix: "Repair the payment-state mount error.",
  };
  const deps = dependencies({
    async visualQa(input) {
      assert.equal(input.runtimeOnly, true);
      return {
        findings: [runtimeFinding],
        frames: [{
          frameId: FRAME.id,
          frameAttemptId: `${input.frameAttemptIdPrefix}-0-${FRAME.id}`,
          width: FRAME.width,
          height: FRAME.height,
          status: "failed",
          screenshotPath: `/captures/${FRAME.id}.png`,
          captureIdentity: {
            sha256: "e".repeat(64),
            byteLength: 67,
            width: FRAME.width,
            height: FRAME.height,
          },
          reviewed: false,
        }],
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.evidence.runtimeChecks, [{ id: `frame:${FRAME.id}`, status: "failed" }]);
  assert.equal(Object.hasOwn(result.evidence, "visualEvidence"), false);
  assert.deepEqual(result.repairFindings, [{ ...runtimeFinding, reviewStatus: "active", reviewRound: 0 }]);
  assert.equal(deps.calls.persist, 0);
});

test("a passing runtime-only assessment crosses the exact Core quality gate without visual evidence", async () => {
  const infra = infrastructure({ requireRuntimeChecks: true, requireVisualReview: false });
  const deps = dependencies({
    async visualQa(input) {
      assert.equal(input.runtimeOnly, true);
      return {
        findings: [],
        frames: input.renderFrames.map((frame, index) => ({
          frameId: frame.id,
          frameAttemptId: `${input.frameAttemptIdPrefix}-${index}-${frame.id}`,
          width: frame.width,
          height: frame.height,
          status: "passed" as const,
          screenshotPath: `/captures/${frame.id}.png`,
          captureIdentity: {
            sha256: "e".repeat(64),
            byteLength: 67,
            width: frame.width,
            height: frame.height,
          },
          reviewed: false,
        })),
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, true);
  assert.equal(deps.calls.persist, 0);
  assert.equal(Object.hasOwn(result.evidence, "visualEvidence"), false);
  assert.equal(Object.hasOwn(result.evidence, "visualReview"), false);
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate({
    requireSourceVisualEvidence: false,
    qaProfile: infra.claim.task.qaProfile,
    plannedFrames: (infra.claim.task.payload as { responsiveFrames: unknown[] }).responsiveFrames,
    renderSpec: result.renderSpec,
    quality: result.quality,
    evidence: result.evidence,
    expectedEvidenceOwner: null,
  }));
});

test("the Standard Artifact baseline mounts every Frame even when optional QA flags are disabled", async (t) => {
  await t.test("a mounted candidate emits exact runtime evidence accepted by Core", async () => {
    const infra = infrastructure({
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    });
    let visualCalls = 0;
    const deps = dependencies({
      async visualQa(input) {
        visualCalls += 1;
        assert.equal(input.runtimeOnly, true);
        return {
          findings: [],
          frames: input.renderFrames.map((frame, index) => ({
            frameId: frame.id,
            frameAttemptId: `${input.frameAttemptIdPrefix}-${index}-${frame.id}`,
            width: frame.width,
            height: frame.height,
            status: "passed" as const,
            screenshotPath: `/captures/${frame.id}.png`,
            captureIdentity: {
              sha256: "e".repeat(64),
              byteLength: 67,
              width: frame.width,
              height: frame.height,
            },
            reviewed: false,
          })),
        };
      },
    });
    const evaluator = new ProductionStandardArtifactQualityEvaluator({
      infrastructure: infra,
      projectId: "project-1",
      settings,
      dataDir: "/data",
      agentCommand: "claude",
      dependencies: deps.value,
    });

    const result = await evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    });

    assert.equal(deps.calls.acquire, 1);
    assert.equal(visualCalls, 1);
    assert.equal(result.passed, true);
    assert.deepEqual(result.evidence.runtimeChecks, [{ id: `frame:${FRAME.id}`, status: "passed" }]);
    assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate({
      requireSourceVisualEvidence: false,
      qaProfile: infra.claim.task.qaProfile,
      plannedFrames: (infra.claim.task.payload as { responsiveFrames: unknown[] }).responsiveFrames,
      renderSpec: result.renderSpec,
      quality: result.quality,
      evidence: result.evidence,
      expectedEvidenceOwner: null,
    }));
  });

  await t.test("a mount failure cannot pass even when no severity is configured as blocking", async () => {
    const infra = infrastructure({
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    });
    const runtimeFailure = {
      severity: "P2" as const,
      id: `visual-runtime-error@${FRAME.id}`,
      message: "The generated Frame throws while mounting.",
      fix: "Repair the runtime error before publication.",
    };
    const deps = dependencies({
      async visualQa(input) {
        return {
          findings: [runtimeFailure],
          frames: input.renderFrames.map((frame, index) => ({
            frameId: frame.id,
            frameAttemptId: `${input.frameAttemptIdPrefix}-${index}-${frame.id}`,
            width: frame.width,
            height: frame.height,
            status: "failed" as const,
            reviewed: false,
          })),
        };
      },
    });
    const evaluator = new ProductionStandardArtifactQualityEvaluator({
      infrastructure: infra,
      projectId: "project-1",
      settings,
      dataDir: "/data",
      agentCommand: "claude",
      dependencies: deps.value,
    });

    const result = await evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    });

    assert.equal(result.passed, false);
    assert.throws(() => validateGenerationTaskArtifactQualityGate({
      requireSourceVisualEvidence: false,
      qaProfile: infra.claim.task.qaProfile,
      plannedFrames: (infra.claim.task.payload as { responsiveFrames: unknown[] }).responsiveFrames,
      renderSpec: result.renderSpec,
      quality: result.quality,
      evidence: result.evidence,
      expectedEvidenceOwner: null,
    }));
  });
});

test("missing durable Frame evidence fails closed as retryable storage infrastructure", async () => {
  const infra = infrastructure();
  const deps = dependencies({ async persistEvidence() { return undefined; } });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.failureClass === "storage",
  );
});

test("reviewer infrastructure failure is typed as provider while genuine design findings remain repairable", async () => {
  const infra = infrastructure();
  const deps = dependencies({
    async visualQa(input) {
      return {
        findings: [{
          severity: "P1",
          id: `visual-agent-review-failed@${FRAME.id}`,
          message: "Reviewer transport failed.",
          fix: "Retry the reviewer.",
        }],
        frames: [{
          frameId: FRAME.id,
          frameAttemptId: `${input.frameAttemptIdPrefix}-0-${FRAME.id}`,
          width: FRAME.width,
          height: FRAME.height,
          status: "passed",
          screenshotPath: `/captures/${FRAME.id}.png`,
          captureIdentity: {
            sha256: "e".repeat(64),
            byteLength: 67,
            width: FRAME.width,
            height: FRAME.height,
          },
          reviewed: false,
        }],
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });
  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.failureClass === "provider",
  );
});

test("the immutable QA profile may make a P2 contract blocking and repairable", async () => {
  const infra = infrastructure({ blockingSeverities: ["P0", "P1", "P2"] });
  const improvement = {
    severity: "P2" as const,
    id: "visual-improve-checkout-hierarchy",
    message: "The order summary hierarchy is too flat.",
    fix: "Strengthen the total and reduce tertiary labels.",
    selector: "[data-dezin-id=\"order-summary\"]",
  };
  const deps = dependencies({
    async visualQa(input) { return visualReport(input, [improvement, reviewedFinding()]); },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.repairFindings, [{
    ...improvement,
    reviewStatus: "active",
    reviewRound: 0,
  }]);
  assert.equal((result.evidence.visualReview as { status: string }).status, "failed");
  assert.equal((result.evidence.visualReview as { fidelity: number }).fidelity, 1);
  assert.equal((result.evidence.visualReview as { evidence: unknown[] }).evidence.length, 1);
});

test("Sharingan forces exact source review and treats every mismatch as repairable", async () => {
  const infra = infrastructure({
    sharingan: true,
    requireRuntimeChecks: false,
    requireVisualReview: false,
  });
  const mismatch = {
    severity: "P2" as const,
    id: "visual-source-header-spacing",
    message: "The generated header is 10 px taller than the captured source.",
    fix: "Reduce the header block height by 10 px.",
    selector: "header",
  };
  const reference = {
    screenshotPath: "/repo/worktree/.sharingan/source.png",
    renderMapPath: "/repo/worktree/.sharingan/render-map.json",
  };
  const deps = dependencies({
    sharinganReference() {
      return reference;
    },
    async visualQa(input) {
      assert.equal(input.isSharingan, true);
      assert.deepEqual(input.sharinganReference, reference);
      assert.equal(input.settings.visualQaEnabled, true);
      return visualReport(input, [mismatch, reviewedFinding()]);
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.repairFindings, [{
    ...mismatch,
    reviewStatus: "active",
    reviewRound: 0,
  }]);
  assert.equal((result.evidence.visualReview as { status: string }).status, "failed");
  assert.equal((result.evidence.visualReview as { fidelity: number }).fidelity, result.score / 100);
  assert.equal((result.evidence.visualReview as { evidence: unknown[] }).evidence.length, 1);
  assert.deepEqual(result.evidence.sourceCaptureResult, {
    scope: "source",
    sourceAttemptId: "quality-round-0-source",
    width: 1440,
    height: 900,
    status: "passed",
    reviewed: true,
    captureIdentity: {
      sha256: "f".repeat(64),
      byteLength: 67,
      width: 1440,
      height: 900,
    },
  });
  assert.equal(
    (result.evidence.sourceVisualEvidence as { protocol: string }).protocol,
    "dezin.generation-task-source-visual-evidence.v1",
  );
  assert.deepEqual(
    (result.evidence.sourceVisualEvidence as { sourceAuthority: unknown }).sourceAuthority,
    SOURCE_AUTHORITY,
  );
  assert.deepEqual(
    (result.evidence.visualReview as { evidence: Array<{ frameId: string }> }).evidence.map((entry) => entry.frameId),
    [FRAME.id],
    "source evidence remains outside the immutable Task Frame evidence array",
  );
  assert.equal(
    (result.evidence.visualReview as { sourceEvidence: { sourceAttemptId: string } }).sourceEvidence.sourceAttemptId,
    "quality-round-0-source",
  );
  assert.equal(deps.calls.persist, 1, "Task Frame evidence is persisted independently");
  assert.equal(deps.calls.persistSource, 1, "source-parity evidence is persisted independently");
});

test("a passing Sharingan assessment crosses the Core gate with independently bound source evidence", async () => {
  const infra = infrastructure({ sharingan: true });
  const deps = dependencies({
    sharinganReference() {
      return {
        screenshotPath: "/repo/worktree/.sharingan/source.png",
        renderMapPath: "/repo/worktree/.sharingan/render-map.json",
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, true);
  const attempt = infra.claim.attempt;
  assert.doesNotThrow(() => validateGenerationTaskArtifactQualityGate({
    requireSourceVisualEvidence: SOURCE_AUTHORITY,
    qaProfile: infra.claim.task.qaProfile,
    plannedFrames: (infra.claim.task.payload as { responsiveFrames: unknown[] }).responsiveFrames,
    renderSpec: result.renderSpec,
    quality: result.quality,
    evidence: result.evidence,
    expectedEvidenceOwner: {
      projectId: "project-1",
      workspaceId: infra.claim.task.workspaceId,
      planId: infra.claim.task.planId,
      taskId: infra.claim.task.id,
      attempt: attempt.attempt,
      candidateCommitHash: CANDIDATE.commitHash,
      candidateTreeHash: CANDIDATE.treeHash,
      contextPackId: infra.contextPack.id,
      contextPackHash: infra.contextPack.hash,
      inputHash: attempt.inputHash,
      attemptCreatedAt: attempt.createdAt,
      sourceBase: {
        commitHash: attempt.sourceCommitHash,
        treeHash: attempt.sourceTreeHash,
      },
      candidateRetentionRef: generationTaskArtifactCandidateRetentionRef({
        workspaceId: infra.claim.task.workspaceId,
        taskId: infra.claim.task.id,
        attempt: attempt.attempt,
        inputHash: attempt.inputHash,
      }),
    },
  }));
});

test("Sharingan rejects any stale or inexact source capture before durable evidence persistence", async (t) => {
  const cases = [
    { name: "missing", omit: true, patch: {} },
    { name: "wrong attempt", patch: { sourceAttemptId: "quality-round-0-source-stale" } },
    { name: "undersized viewport", patch: { width: 319 } },
    { name: "oversized viewport", patch: { height: 3_001 } },
    { name: "stale screenshot", patch: { screenshotPath: "/captures/stale-source.png" } },
    { name: "unreviewed", patch: { reviewed: false } },
    { name: "missing capture identity", patch: { captureIdentity: undefined } },
    {
      name: "capture pixels do not cover source viewport",
      patch: { captureIdentity: { sha256: "f".repeat(64), byteLength: 67, width: 1439, height: 900 } },
    },
    {
      name: "capture hash is malformed",
      patch: { captureIdentity: { sha256: "not-a-sha", byteLength: 67, width: 1440, height: 900 } },
    },
  ] as const;

  for (const current of cases) {
    await t.test(current.name, async () => {
      const infra = infrastructure({ sharingan: true });
      const deps = dependencies({
        sharinganReference() {
          return {
            screenshotPath: "/repo/worktree/.sharingan/source.png",
            renderMapPath: "/repo/worktree/.sharingan/render-map.json",
          };
        },
        async visualQa(input) {
          const report = visualReport(input);
          return {
            ...report,
            sourceCapture: "omit" in current && current.omit
              ? undefined
              : { ...report.sourceCapture!, ...current.patch },
          } as ReturnType<typeof visualReport>;
        },
      });
      const evaluator = new ProductionStandardArtifactQualityEvaluator({
        infrastructure: infra,
        projectId: "project-1",
        settings,
        dataDir: "/data",
        agentCommand: "claude",
        dependencies: deps.value,
      });

      await assert.rejects(
        evaluator.evaluate({
          candidate: CANDIDATE,
          dir: infra.worktreeDir,
          round: 0,
          signal: new AbortController().signal,
        }),
        (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
          && error.code === "visual-infrastructure"
          && error.failureClass === "provider",
      );
      assert.equal(deps.calls.persistSource, 0);
      assert.equal(deps.calls.persist, 0);
    });
  }
});

test("non-Sharingan quality evaluation rejects injected source-scoped evidence", async () => {
  const infra = infrastructure();
  const deps = dependencies({
    async visualQa(input) {
      return {
        ...visualReport(input),
        sourceCapture: {
          scope: "source",
          sourceAttemptId: `${input.frameAttemptIdPrefix}-source`,
          width: 1440,
          height: 900,
          status: "passed",
          screenshotPath: input.screenshotPath,
          reviewed: true,
        },
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "visual-infrastructure",
  );
  assert.equal(deps.calls.persistSource, 0);
  assert.equal(deps.calls.persist, 0);
});

test("quality evaluation rejects a captured Frame without one exact byte and pixel identity", async () => {
  const infra = infrastructure();
  const deps = dependencies({
    async visualQa(input) {
      const report = visualReport(input);
      return {
        ...report,
        frames: report.frames.map((frame) => ({ ...frame, captureIdentity: undefined })),
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
    && error.code === "visual-infrastructure");
  assert.equal(deps.calls.persist, 0);
});

test("quality evaluation rejects a durable Frame descriptor for bytes not supplied to the reviewer", async () => {
  const infra = infrastructure();
  const deps = dependencies({
    async persistEvidence(input) {
      const sha256 = "a".repeat(64);
      return {
        protocol: "dezin.generation-task-visual-evidence.v1",
        owner: input.owner,
        frame: input.frame,
        round: input.round,
        mediaType: "image/png",
        sha256,
        byteLength: input.expectedIdentity.byteLength + 1,
        storageKey: [
          "generation-task-evidence",
          input.owner.projectId,
          input.owner.workspaceId,
          input.owner.planId,
          input.owner.taskId,
          `attempt-${input.owner.attempt}`,
          "visual",
          `round-${input.round}-${input.frame.id}-${sha256}.png`,
        ].join("/"),
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
    && error.code === "evidence-unavailable"
    && error.failureClass === "storage");
});

test("Sharingan rejects a durable source descriptor that is not bound to the reviewed capture", async () => {
  const infra = infrastructure({ sharingan: true });
  const deps = dependencies({
    sharinganReference() {
      return {
        screenshotPath: "/repo/worktree/.sharingan/source.png",
        renderMapPath: "/repo/worktree/.sharingan/render-map.json",
      };
    },
    async persistSourceEvidence(input) {
      const sha256 = "f".repeat(64);
      return {
        protocol: "dezin.generation-task-source-visual-evidence.v1",
        owner: input.owner,
        capture: { ...input.capture, width: input.capture.width + 1 },
        sourceAuthority: input.sourceAuthority,
        round: input.round,
        mediaType: "image/png",
        sha256,
        byteLength: 67,
        storageKey: [
          "generation-task-evidence",
          input.owner.projectId,
          input.owner.workspaceId,
          input.owner.planId,
          input.owner.taskId,
          `attempt-${input.owner.attempt}`,
          "visual",
          `round-${input.round}-source-${sha256}.png`,
        ].join("/"),
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "evidence-unavailable"
      && error.failureClass === "storage",
  );
  assert.equal(deps.calls.persist, 0, "Frame evidence is not emitted after source binding fails");
});

test("Sharingan rejects a durable descriptor with unrelated source authority", async () => {
  const infra = infrastructure({ sharingan: true });
  const deps = dependencies({
    sharinganReference() {
      return {
        screenshotPath: "/repo/worktree/.sharingan/source.png",
        renderMapPath: "/repo/worktree/.sharingan/render-map.json",
      };
    },
    async persistSourceEvidence(input) {
      const sha256 = "f".repeat(64);
      return {
        protocol: "dezin.generation-task-source-visual-evidence.v1",
        owner: input.owner,
        capture: input.capture,
        sourceAuthority: {
          ...input.sourceAuthority,
          revisionChecksum: "0".repeat(64),
        },
        round: input.round,
        mediaType: "image/png",
        sha256,
        byteLength: 67,
        storageKey: [
          "generation-task-evidence",
          input.owner.projectId,
          input.owner.workspaceId,
          input.owner.planId,
          input.owner.taskId,
          `attempt-${input.owner.attempt}`,
          "visual",
          `round-${input.round}-source-${sha256}.png`,
        ].join("/"),
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "evidence-unavailable"
      && error.failureClass === "storage",
  );
  assert.equal(deps.calls.persist, 0);
});

test("a reviewed failed Sharingan source capture remains durable quality evidence", async () => {
  const infra = infrastructure({ sharingan: true });
  const sourceRuntimeFailure = {
    severity: "P1" as const,
    id: "visual-runtime-error@source",
    message: "The source-parity viewport overflowed during capture.",
    fix: "Repair the source viewport overflow.",
  };
  const deps = dependencies({
    sharinganReference() {
      return {
        screenshotPath: "/repo/worktree/.sharingan/source.png",
        renderMapPath: "/repo/worktree/.sharingan/render-map.json",
      };
    },
    async visualQa(input) {
      const report = visualReport(input, [sourceRuntimeFailure, reviewedFinding()]);
      return {
        ...report,
        sourceCapture: { ...report.sourceCapture!, status: "failed" as const },
      };
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  const result = await evaluator.evaluate({
    candidate: CANDIDATE,
    dir: infra.worktreeDir,
    round: 0,
    signal: new AbortController().signal,
  });

  assert.equal(result.passed, false);
  assert.equal((result.evidence.sourceCaptureResult as { status: string }).status, "failed");
  assert.equal(deps.calls.persistSource, 1);
  assert.equal(deps.calls.persist, 1);
  assert.equal(
    (result.evidence.sourceVisualEvidence as { protocol: string }).protocol,
    "dezin.generation-task-source-visual-evidence.v1",
  );
});

test("candidate substitution and dirty source are rejected before runtime execution", async () => {
  const infra = infrastructure();
  const substituted = dependencies({
    async inspectCandidate(input) {
      return { ...input.candidate, commitHash: "9".repeat(40), status: "" };
    },
  });
  const substitutedEvaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: substituted.value,
  });
  await assert.rejects(
    substitutedEvaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "candidate-mismatch",
  );
  assert.equal(substituted.calls.acquire, 0);

  const dirty = dependencies({
    async inspectCandidate(input) {
      return { ...input.candidate, status: " M src/App.tsx" };
    },
  });
  const dirtyEvaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: dirty.value,
  });
  await assert.rejects(
    dirtyEvaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "source-dirty",
  );
  assert.equal(dirty.calls.acquire, 0);
});

test("candidate integrity is rechecked after the final static quality boundary", async () => {
  const infra = infrastructure();
  let staticQualityRan = false;
  const deps = dependencies({
    async inspectCandidate(input) {
      return {
        ...input.candidate,
        status: staticQualityRan ? " M src/App.tsx" : "",
      };
    },
    async collectLintSurface() {
      staticQualityRan = true;
      return "export const checkout = true;";
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "source-dirty",
  );
});

test("static quality infrastructure failure is typed for bounded retry", async () => {
  const infra = infrastructure();
  const deps = dependencies({
    async collectLintSurface() {
      throw new Error("worktree read unavailable");
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProductionStandardArtifactQualityEvaluatorError
      && error.code === "quality-infrastructure"
      && error.failureClass === "build-infrastructure"
      && /worktree read unavailable/.test(error.message),
  );
});

test("abort during visual review propagates the exact reason and still releases the lease", async () => {
  const infra = infrastructure();
  const controller = new AbortController();
  const reason = new DOMException("stop exact QA", "AbortError");
  const deps = dependencies({
    async visualQa() {
      controller.abort(reason);
      throw reason;
    },
  });
  const evaluator = new ProductionStandardArtifactQualityEvaluator({
    infrastructure: infra,
    projectId: "project-1",
    settings,
    dataDir: "/data",
    agentCommand: "claude",
    dependencies: deps.value,
  });

  await assert.rejects(
    evaluator.evaluate({
      candidate: CANDIDATE,
      dir: infra.worktreeDir,
      round: 0,
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  assert.equal(deps.calls.release, 1);
  assert.equal(deps.calls.persist, 0);
});
