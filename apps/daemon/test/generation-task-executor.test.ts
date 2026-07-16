import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeGenerationTaskIntent,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskCapacityClass,
  type GenerationTaskClaim,
  type GenerationTaskKind,
  type GenerationTaskTarget,
} from "../../../packages/core/src/index.ts";
import {
  GenerationTaskExecutionError,
  GenerationTaskExecutor,
  type ArtifactPreparedCandidate,
  type PrototypeValidationResult,
  type ResourcePreparedCandidate,
} from "../src/orchestration/generation-task-executor.ts";

const WORKSPACE_ID = "workspace-executor";
const PLAN_ID = "plan-executor";
const TASK_ID = "task-executor";
const MAX_OUTPUT_BYTES = 8_000_000;
const QUALITY = {
  requiredFrameIds: ["desktop"],
  blockingSeverities: ["P0", "P1"] as Array<"P0" | "P1">,
  requireRuntimeChecks: true,
  requireVisualReview: true,
};

function payloadFor(kind: GenerationTaskKind, target: GenerationTaskTarget): Record<string, unknown> {
  if (kind === "page" || kind === "component") {
    assert.equal(target.type, "artifact");
    return {
      version: 1,
      artifactPlan: {
        operation: "revise",
        nodeId: `node-${target.id}`,
        artifactId: target.id,
        kind,
        name: `Generated ${kind}`,
        trackId: target.trackId,
        baseRevisionId: `base-${target.id}`,
        dependsOnArtifactIds: [],
        capabilityIds: ["generate"],
        responsiveFrameIds: ["desktop"],
      },
      dependencyPlans: [],
      responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
    };
  }
  if (kind === "resource") {
    assert.equal(target.type, "resource");
    return {
      version: 1,
      operation: {
        operation: "revise",
        nodeId: `node-${target.id}`,
        resourceId: target.id,
        kind: "asset",
        title: "Generated asset",
        revisionPolicy: { kind: "generate" },
      },
    };
  }
  if (kind === "prototype-validation") {
    return {
      version: 1,
      prototypeIntents: [],
      responsiveFrames: [],
      artifactIds: [],
    };
  }
  if (kind === "checkpoint") {
    return {
      version: 1,
      proposalId: "proposal-executor",
      proposalRevision: 1,
      baseSnapshotId: "snapshot-base",
    };
  }
  return { version: 1 };
}

function targetFor(kind: GenerationTaskKind): GenerationTaskTarget {
  if (kind === "resource") return { type: "resource", workspaceId: WORKSPACE_ID, id: "resource-1" };
  if (kind === "prototype-validation" || kind === "checkpoint" || kind === "propagation-publish") {
    return { type: "workspace", workspaceId: WORKSPACE_ID, id: WORKSPACE_ID };
  }
  return {
    type: "artifact",
    workspaceId: WORKSPACE_ID,
    id: kind === "component" ? "component-1" : "page-1",
    trackId: kind === "component" ? "component-track-1" : "page-track-1",
  };
}

function taskFixture(
  kind: GenerationTaskKind,
  overrides: Partial<GenerationTask> = {},
): GenerationTask {
  const target = overrides.target ?? targetFor(kind);
  return {
    ...normalizeGenerationTaskIntent({
      id: TASK_ID,
      ordinal: 0,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      kind,
      target,
      dependencyIds: [],
      payload: overrides.payload ?? payloadFor(kind, target),
      capabilities: kind === "checkpoint" ? [] : ["generate"],
      qaProfile: QUALITY,
      resourceLimits: {
        timeoutMs: 120_000,
        maxAgentTurns: 8,
        maxRepairRounds: 2,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        capacityClasses: kind === "checkpoint" ? [] : ["agent"],
      },
    }),
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
    createdAt: 10_000,
    finishedAt: null,
    ...overrides,
  };
}

const CAPACITY_CLAIM_KEYS = {
  agent: "capacity:agent:1",
  "render-qa": "capacity:render-qa:1",
  image: "capacity:image:1",
} as const satisfies Record<GenerationTaskCapacityClass, GenerationTaskClaim["claimKey"]>;

function writerClaimKey(task: GenerationTask): GenerationTaskClaim["claimKey"] | null {
  const workspace = Buffer.from(task.workspaceId, "utf8").toString("hex");
  if (task.target.type === "artifact") {
    return `writer:artifact:${workspace}:${Buffer.from(task.target.id, "utf8").toString("hex")}`;
  }
  if (task.target.type === "resource") {
    return `writer:resource:${workspace}:${Buffer.from(task.target.id, "utf8").toString("hex")}`;
  }
  return task.kind === "checkpoint" ? `writer:checkpoint:${workspace}` : null;
}

function claimSetFixture(
  task: GenerationTask,
  lease: GenerationTaskAttemptClaim["lease"],
  leaseExpiresAt: number,
  createdAt: number,
): GenerationTaskClaim[] {
  const writer = writerClaimKey(task);
  const keys: GenerationTaskClaim["claimKey"][] = [
    ...task.resourceLimits.capacityClasses.map((capacityClass) => CAPACITY_CLAIM_KEYS[capacityClass]),
    ...(writer === null ? [] : [writer]),
  ];
  return keys.sort().map((claimKey) => ({
    ...lease,
    planId: task.planId,
    claimKey,
    claimKind: claimKey.startsWith("capacity:") ? "capacity" : "writer",
    leaseExpiresAt,
    createdAt,
  }));
}

function claimFixture(
  kind: GenerationTaskKind,
  input: {
    task?: GenerationTask;
    executionMode?: GenerationTaskAttempt["executionMode"];
  } = {},
): GenerationTaskAttemptClaim {
  const task = input.task ?? taskFixture(kind);
  const lease = {
    taskId: task.id,
    workspaceId: task.workspaceId,
    attempt: task.currentAttempt,
    ownerId: "daemon-executor",
    leaseToken: "lease-executor",
  };
  const publicationOnly = input.executionMode === "publication-only";
  const attempt: GenerationTaskAttempt = {
    taskId: task.id,
    planId: task.planId,
    workspaceId: task.workspaceId,
    attempt: task.currentAttempt,
    target: task.target,
    baseRevisionId: task.target.type === "workspace" ? null : `base-${task.target.id}`,
    expectedSnapshotId: "snapshot-executor",
    contextPackId: task.kind === "page" || task.kind === "component" || task.kind === "resource"
      || task.kind === "propagation-candidate"
      ? "context-executor"
      : null,
    kernelRevisionId: "kernel-executor",
    payload: task.payload,
    dependencyOutputs: [],
    resourcePins: [],
    componentPins: [],
    inputHash: "input-hash-executor",
    retryContextPolicy: "same-context",
    executionMode: input.executionMode ?? "full",
    attemptOrigin: publicationOnly ? "publication-retry" : "materialized",
    predecessorAttempt: publicationOnly ? task.currentAttempt - 1 : null,
    automaticRetryIndex: publicationOnly ? 1 : 0,
    status: "running",
    blockedReason: null,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    candidateRevisionId: publicationOnly && task.target.type === "artifact" ? "candidate-artifact" : null,
    candidateResourceRevisionId: publicationOnly && task.target.type === "resource" ? "candidate-resource" : null,
    candidateEvidence: publicationOnly ? { verified: true } : null,
    candidateEvidenceHash: publicationOnly ? "candidate-evidence-hash" : null,
    lease,
    leaseExpiresAt: 130_000,
    heartbeatAt: 100_000,
    createdAt: 10_000,
    startedAt: 100_000,
    finishedAt: null,
  };
  return {
    task,
    attempt,
    lease,
    claims: claimSetFixture(task, lease, attempt.leaseExpiresAt!, attempt.startedAt!),
  };
}

function artifactResultFor(claim: GenerationTaskAttemptClaim): ArtifactPreparedCandidate {
  const task = claim.task;
  assert.ok(task.kind === "page" || task.kind === "component");
  assert.equal(task.target.type, "artifact");
  return {
    kind: "artifact-candidate",
    taskId: task.id,
    workspaceId: task.workspaceId,
    artifactId: task.target.id,
    trackId: task.target.trackId,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    renderSpec: {
      frames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    },
    quality: { state: "passed", score: 100, findings: [] },
    evidence: {
      runtimeChecks: [{ id: "load", status: "passed" }],
      visualReview: { status: "passed", fidelity: 0.99 },
    },
  };
}

function resourceResultFor(claim: GenerationTaskAttemptClaim): ResourcePreparedCandidate {
  const task = claim.task;
  assert.equal(task.kind, "resource");
  assert.equal(task.target.type, "resource");
  return {
    kind: "resource-candidate",
    taskId: task.id,
    workspaceId: task.workspaceId,
    resourceId: task.target.id,
    revision: {
      revisionId: "resource-candidate-revision",
      parentRevisionId: claim.attempt.baseRevisionId,
      manifestPath: "resource-revisions/candidate/manifest.json",
      summary: "Generated asset",
      metadata: {},
      checksum: "c".repeat(64),
      provenance: { planId: task.planId, taskId: task.id },
    },
    evidence: { frozen: true },
  };
}

function prototypeResultFor(claim: GenerationTaskAttemptClaim): PrototypeValidationResult {
  const task = claim.task;
  assert.equal(task.kind, "prototype-validation");
  return {
    kind: "snapshot-validation",
    taskId: task.id,
    workspaceId: task.workspaceId,
    snapshotId: claim.attempt.expectedSnapshotId,
    graphRevision: 4,
    artifactRevisionIds: [],
    resourceRevisionIds: [],
    evidence: { validated: true },
  };
}

function harness(input: {
  leafError?: unknown;
  publicationError?: unknown;
  artifactResultFactory?: (claim: GenerationTaskAttemptClaim) => ArtifactPreparedCandidate;
  resourceResultFactory?: (claim: GenerationTaskAttemptClaim) => ResourcePreparedCandidate;
  prototypeResultFactory?: (claim: GenerationTaskAttemptClaim) => PrototypeValidationResult;
} = {}) {
  const calls: Array<{ port: string; values: unknown[] }> = [];
  const executeLeaf = async <Result>(
    port: string,
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
    prepare: () => Result,
  ): Promise<Result> => {
    calls.push({ port, values: [claim, signal] });
    if (input.leafError !== undefined) throw input.leafError;
    return prepare();
  };
  const executor = new GenerationTaskExecutor({
    artifacts: {
      execute: (claim, signal) => executeLeaf("artifact", claim, signal,
        () => input.artifactResultFactory?.(claim) ?? artifactResultFor(claim)),
    },
    resources: {
      execute: (claim, signal) => executeLeaf("resource", claim, signal,
        () => input.resourceResultFactory?.(claim) ?? resourceResultFor(claim)),
    },
    prototypeValidation: {
      execute: (claim, signal) => executeLeaf("prototype", claim, signal,
        () => input.prototypeResultFactory?.(claim) ?? prototypeResultFor(claim)),
    },
    publication: {
      async publishPreparedResult(...values) {
        calls.push({ port: "publish-prepared", values });
        if (input.publicationError !== undefined) throw input.publicationError;
      },
      async publishRecordedCandidate(...values) {
        calls.push({ port: "publish-recorded", values });
        if (input.publicationError !== undefined) throw input.publicationError;
      },
      async publishCheckpoint(...values) {
        calls.push({ port: "publish-checkpoint", values });
        if (input.publicationError !== undefined) throw input.publicationError;
      },
      async finishFailure(...values) {
        calls.push({ port: "finish-failure", values });
      },
    },
  });
  return { calls, executor };
}

const FULL_EXECUTION_ROUTES = {
  page: ["artifact", "publish-prepared"],
  component: ["artifact", "publish-prepared"],
  resource: ["resource", "publish-prepared"],
  "prototype-validation": ["prototype", "publish-prepared"],
  checkpoint: ["publish-checkpoint"],
  "propagation-candidate": ["finish-failure"],
  "propagation-publish": ["finish-failure"],
} as const satisfies Record<GenerationTaskKind, readonly string[]>;

for (const kind of Object.keys(FULL_EXECUTION_ROUTES) as GenerationTaskKind[]) {
  test(`GenerationTaskExecutor routes one full ${kind} claim through its exact owner and publication`, async () => {
    const claim = claimFixture(kind);
    const signal = new AbortController().signal;
    const { calls, executor } = harness();

    await executor.execute(claim, signal);

    assert.deepEqual(calls.map((call) => call.port), FULL_EXECUTION_ROUTES[kind]);
    for (const call of calls) {
      assert.strictEqual(call.values[0], claim);
      if (call.port !== "finish-failure") assert.strictEqual(call.values.at(-1), signal);
    }
  });
}

const PUBLICATION_ONLY_KINDS = ["page", "component", "resource"] as const satisfies
  readonly GenerationTaskKind[];

for (const kind of PUBLICATION_ONLY_KINDS) {
  test(`GenerationTaskExecutor resumes a publication-only ${kind} candidate without invoking a generator`, async () => {
    const claim = claimFixture(kind, { executionMode: "publication-only" });
    const signal = new AbortController().signal;
    const { calls, executor } = harness();

    await executor.execute(claim, signal);

    assert.deepEqual(calls.map((call) => call.port), ["publish-recorded"]);
    assert.strictEqual(calls[0]?.values[0], claim);
    assert.strictEqual(calls[0]?.values[1], signal);
  });
}

test("GenerationTaskExecutor rejects an already-aborted claim before invoking any port", async () => {
  const claim = claimFixture("page");
  const controller = new AbortController();
  const reason = new Error("Runtime scope stopped");
  controller.abort(reason);
  const { calls, executor } = harness();

  await assert.rejects(executor.execute(claim, controller.signal), (error) => error === reason);
  assert.deepEqual(calls, []);
});

test("GenerationTaskExecutor rejects mismatched Task, Attempt, and lease identity before invoking any port", async () => {
  const valid = claimFixture("page");
  const corrupt = {
    ...valid,
    lease: { ...valid.lease, taskId: "foreign-task" },
  };
  const { calls, executor } = harness();

  await assert.rejects(executor.execute(corrupt, new AbortController().signal), /identity|lease/i);
  assert.deepEqual(calls, []);
});

const EXACT_CLAIM_SET_CORRUPTIONS = [
  {
    name: "a partial claim set",
    corrupt(claim: GenerationTaskAttemptClaim): GenerationTaskAttemptClaim {
      return { ...claim, claims: claim.claims.filter((candidate) => candidate.claimKind === "writer") };
    },
  },
  {
    name: "a duplicate claim",
    corrupt(claim: GenerationTaskAttemptClaim): GenerationTaskAttemptClaim {
      return { ...claim, claims: [...claim.claims, claim.claims[0]!] };
    },
  },
  {
    name: "the wrong writer key",
    corrupt(claim: GenerationTaskAttemptClaim): GenerationTaskAttemptClaim {
      const workspace = Buffer.from(claim.task.workspaceId, "utf8").toString("hex");
      const foreignArtifact = Buffer.from("foreign-artifact", "utf8").toString("hex");
      return {
        ...claim,
        claims: claim.claims.map((candidate) => candidate.claimKind === "writer"
          ? { ...candidate, claimKey: `writer:artifact:${workspace}:${foreignArtifact}` }
          : candidate),
      };
    },
  },
  {
    name: "a target that aliases another Workspace",
    corrupt(claim: GenerationTaskAttemptClaim): GenerationTaskAttemptClaim {
      const target = { ...claim.task.target, workspaceId: "workspace-foreign" };
      return {
        ...claim,
        task: { ...claim.task, target },
        attempt: { ...claim.attempt, target },
      };
    },
  },
  {
    name: "a claim expiry that differs from the Attempt lease",
    corrupt(claim: GenerationTaskAttemptClaim): GenerationTaskAttemptClaim {
      return {
        ...claim,
        claims: claim.claims.map((candidate) => ({
          ...candidate,
          leaseExpiresAt: candidate.leaseExpiresAt + 1,
        })),
      };
    },
  },
  {
    name: "claim creation times that differ from the Attempt start",
    corrupt(claim: GenerationTaskAttemptClaim): GenerationTaskAttemptClaim {
      return {
        ...claim,
        claims: claim.claims.map((candidate) => ({
          ...candidate,
          createdAt: candidate.createdAt + 1,
        })),
      };
    },
  },
] as const;

for (const { name, corrupt } of EXACT_CLAIM_SET_CORRUPTIONS) {
  test(`GenerationTaskExecutor rejects ${name} before invoking any port`, async () => {
    const { calls, executor } = harness();

    await assert.rejects(
      executor.execute(corrupt(claimFixture("page")), new AbortController().signal),
    );

    assert.deepEqual(calls, []);
  });
}

test("GenerationTaskExecutor records a typed leaf failure exactly once", async () => {
  const failure = new GenerationTaskExecutionError({
    failureClass: "design",
    message: "Candidate violates the approved direction",
    details: { findingIds: ["contract-drift"] },
  });
  const { calls, executor } = harness({ leafError: failure });

  await executor.execute(claimFixture("page"), new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.port), ["artifact", "finish-failure"]);
  assert.deepEqual(calls[1]?.values[1], {
    failureClass: "design",
    error: {
      name: "GenerationTaskExecutionError",
      message: failure.message,
      details: { findingIds: ["contract-drift"] },
    },
  });
});

test("GenerationTaskExecutor terminalizes an unknown leaf error instead of retry-looping it", async () => {
  const { calls, executor } = harness({ leafError: new Error("unexpected executor defect") });

  await executor.execute(claimFixture("resource"), new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.port), ["resource", "finish-failure"]);
  assert.equal((calls[1]?.values[1] as { failureClass?: string }).failureClass, "unknown");
});

test("GenerationTaskExecutor terminalizes a revoked Proxy leaf failure exactly once", async () => {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const { calls, executor } = harness({ leafError: revocable.proxy });

  await executor.execute(claimFixture("page"), new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.port), ["artifact", "finish-failure"]);
  assert.equal(calls.filter((call) => call.port === "finish-failure").length, 1);
  assert.deepEqual(calls[1]?.values[1], {
    failureClass: "unknown",
    error: {
      name: "Error",
      message: "Unknown Generation Task execution failure",
    },
  });
});

test("GenerationTaskExecutor safely omits hostile Context missing refs and terminalizes once", async () => {
  const missing = new Proxy([], {
    get() {
      throw new Error("hostile missing refs getter");
    },
  });
  const { calls, executor } = harness({
    leafError: {
      name: "ContextIntegrityError",
      message: "Context Pack is incomplete",
      missing,
    },
  });

  await executor.execute(claimFixture("component"), new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.port), ["artifact", "finish-failure"]);
  assert.equal(calls.filter((call) => call.port === "finish-failure").length, 1);
  assert.deepEqual(calls[1]?.values[1], {
    failureClass: "context",
    error: {
      name: "ContextIntegrityError",
      message: "Context Pack is incomplete",
    },
  });
});

for (const { name, error, expectedFailureClass } of [
  {
    name: "a structural cross-realm provider error",
    error: { name: "RemoteError", message: "Provider request failed", failureClass: "provider" },
    expectedFailureClass: "provider",
  },
  {
    name: "an ENOSPC storage error",
    error: { name: "SystemError", message: "No space left on device", code: "ENOSPC" },
    expectedFailureClass: "storage",
  },
] as const) {
  test(`GenerationTaskExecutor preserves the classifier for ${name}`, async () => {
    const { calls, executor } = harness({ leafError: error });

    await executor.execute(claimFixture("page"), new AbortController().signal);

    assert.deepEqual(calls.map((call) => call.port), ["artifact", "finish-failure"]);
    assert.equal(
      (calls[1]?.values[1] as { failureClass?: string }).failureClass,
      expectedFailureClass,
    );
  });
}

const INVALID_EVIDENCE = [
  {
    name: "cyclic",
    create(): Record<string, unknown> {
      const evidence: Record<string, unknown> = {};
      evidence.self = evidence;
      return evidence;
    },
  },
  {
    name: "over-budget",
    create(): Record<string, unknown> {
      return { payload: "x".repeat(MAX_OUTPUT_BYTES) };
    },
  },
] as const;

for (const { name, create } of INVALID_EVIDENCE) {
  test(`GenerationTaskExecutor terminalizes ${name} evidence exactly once before publication`, async () => {
    const { calls, executor } = harness({
      artifactResultFactory(claim) {
        return { ...artifactResultFor(claim), evidence: create() };
      },
    });

    await executor.execute(claimFixture("page"), new AbortController().signal);

    assert.deepEqual(calls.map((call) => call.port), ["artifact", "finish-failure"]);
    assert.equal(calls.filter((call) => call.port === "finish-failure").length, 1);
    assert.equal(calls.some((call) => call.port.startsWith("publish-")), false);
  });
}

const ARTIFACT_QUALITY_GATE_VIOLATIONS = [
  {
    name: "missing a required responsive Frame",
    mutate(result: ArtifactPreparedCandidate): ArtifactPreparedCandidate {
      return {
        ...result,
        renderSpec: {
          frames: [{ id: "mobile", name: "Mobile", width: 390, height: 844 }],
        },
      };
    },
  },
  {
    name: "a failed quality state",
    mutate(result: ArtifactPreparedCandidate): ArtifactPreparedCandidate {
      return { ...result, quality: { state: "failed", score: 42, findings: [] } };
    },
  },
  {
    name: "an active blocking finding",
    mutate(result: ArtifactPreparedCandidate): ArtifactPreparedCandidate {
      return {
        ...result,
        quality: {
          state: "needs-attention",
          score: 80,
          findings: [{
            severity: "P1",
            id: "contrast-regression",
            message: "Primary action is illegible",
            fix: "Restore accessible contrast",
            reviewStatus: "active",
          }],
        },
      };
    },
  },
  {
    name: "a failed required runtime check",
    mutate(result: ArtifactPreparedCandidate): ArtifactPreparedCandidate {
      return {
        ...result,
        evidence: {
          ...result.evidence,
          runtimeChecks: [{ id: "load", status: "failed" }],
        },
      };
    },
  },
  {
    name: "a missing required visual review",
    mutate(result: ArtifactPreparedCandidate): ArtifactPreparedCandidate {
      const { visualReview: _visualReview, ...evidence } = result.evidence;
      return { ...result, evidence };
    },
  },
] as const;

for (const { name, mutate } of ARTIFACT_QUALITY_GATE_VIOLATIONS) {
  test(`GenerationTaskExecutor terminalizes an Artifact candidate with ${name} before publication`, async () => {
    const { calls, executor } = harness({
      artifactResultFactory(claim) {
        return mutate(artifactResultFor(claim));
      },
    });

    await executor.execute(claimFixture("page"), new AbortController().signal);

    assert.deepEqual(calls.map((call) => call.port), ["artifact", "finish-failure"]);
    assert.equal(calls.filter((call) => call.port === "finish-failure").length, 1);
    assert.equal(calls.some((call) => call.port.startsWith("publish-")), false);
  });
}

const MALFORMED_RESOURCE_REVISIONS = [
  {
    name: "unsafe manifest path and checksum",
    mutate(revision: ResourcePreparedCandidate["revision"]): ResourcePreparedCandidate["revision"] {
      return { ...revision, manifestPath: "../../outside.json", checksum: "not-a-checksum" };
    },
  },
  {
    name: "parent outside the immutable Attempt base",
    mutate(revision: ResourcePreparedCandidate["revision"]): ResourcePreparedCandidate["revision"] {
      return { ...revision, parentRevisionId: "foreign-parent" };
    },
  },
  {
    name: "non-exact Revision fields",
    mutate(revision: ResourcePreparedCandidate["revision"]): ResourcePreparedCandidate["revision"] {
      return { ...revision, unexpected: true } as ResourcePreparedCandidate["revision"];
    },
  },
] as const;

for (const { name, mutate } of MALFORMED_RESOURCE_REVISIONS) {
  test(`GenerationTaskExecutor terminalizes a Resource candidate with ${name} before publication`, async () => {
    const { calls, executor } = harness({
      resourceResultFactory(claim) {
        const result = resourceResultFor(claim);
        return { ...result, revision: mutate(result.revision) };
      },
    });

    await executor.execute(claimFixture("resource"), new AbortController().signal);

    assert.deepEqual(calls.map((call) => call.port), ["resource", "finish-failure"]);
    assert.equal(calls.filter((call) => call.port === "finish-failure").length, 1);
    assert.equal(calls.some((call) => call.port.startsWith("publish-")), false);
  });
}

const WRONG_PROTOTYPE_REVISION_SETS = [
  {
    name: "a foreign Artifact Revision",
    artifactRevisionIds: ["artifact-revision-foreign"],
    resourceRevisionIds: ["resource-revision-exact"],
  },
  {
    name: "a missing Resource Revision",
    artifactRevisionIds: ["artifact-revision-exact"],
    resourceRevisionIds: [],
  },
  {
    name: "a duplicate Resource Revision",
    artifactRevisionIds: ["artifact-revision-exact"],
    resourceRevisionIds: ["resource-revision-exact", "resource-revision-exact"],
  },
] as const;

for (const { name, artifactRevisionIds, resourceRevisionIds } of WRONG_PROTOTYPE_REVISION_SETS) {
  test(`GenerationTaskExecutor terminalizes prototype validation containing ${name}`, async () => {
    const fixture = claimFixture("prototype-validation");
    const claim: GenerationTaskAttemptClaim = {
      ...fixture,
      attempt: {
        ...fixture.attempt,
        dependencyOutputs: [
          {
            ordinal: 0,
            taskId: "component-upstream",
            resultRevisionId: "artifact-revision-exact",
            resultResourceRevisionId: null,
            resultSnapshotId: null,
          },
          {
            ordinal: 1,
            taskId: "resource-upstream",
            resultRevisionId: null,
            resultResourceRevisionId: "resource-revision-exact",
            resultSnapshotId: null,
          },
        ],
      },
    };
    const { calls, executor } = harness({
      prototypeResultFactory(exactClaim) {
        return {
          ...prototypeResultFor(exactClaim),
          artifactRevisionIds: [...artifactRevisionIds],
          resourceRevisionIds: [...resourceRevisionIds],
        };
      },
    });

    await executor.execute(claim, new AbortController().signal);

    assert.deepEqual(calls.map((call) => call.port), ["prototype", "finish-failure"]);
    assert.equal(calls.filter((call) => call.port === "finish-failure").length, 1);
    assert.equal(calls.some((call) => call.port.startsWith("publish-")), false);
  });
}

test("GenerationTaskExecutor propagates publication failure without attempting a second terminal write", async () => {
  const publicationError = new Error("candidate transaction response lost");
  const { calls, executor } = harness({ publicationError });

  await assert.rejects(
    executor.execute(claimFixture("component"), new AbortController().signal),
    (error) => error === publicationError,
  );
  assert.deepEqual(calls.map((call) => call.port), ["artifact", "publish-prepared"]);
});

test("GenerationTaskExecutor fails closed for propagation kinds until Task 13 owns them", async () => {
  const { calls, executor } = harness();

  await executor.execute(claimFixture("propagation-candidate"), new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.port), ["finish-failure"]);
  assert.equal((calls[0]?.values[1] as { failureClass?: string }).failureClass, "unknown");
});

test("GenerationTaskExecutor rejects malformed versioned payloads and kind-target mismatches", async () => {
  const validPage = taskFixture("page");
  const malformed = taskFixture("page", { payload: { ...validPage.payload, extra: true } });
  const wrongTarget: GenerationTask = { ...validPage,
    target: { type: "resource", workspaceId: WORKSPACE_ID, id: "resource-wrong" },
  };
  for (const claim of [claimFixture("page", { task: malformed }), claimFixture("page", { task: wrongTarget })]) {
    const { calls, executor } = harness();
    await assert.rejects(executor.execute(claim, new AbortController().signal), /payload|target/i);
    assert.deepEqual(calls, []);
  }
});

test("GenerationTaskExecutor preserves the authoritative Resource Attempt base across the leaf boundary", async () => {
  const claim = claimFixture("resource");
  const authoritativeClaim = structuredClone(claim);
  const forgedBaseRevisionId = "resource-revision-forged-base";
  const { calls, executor } = harness({
    resourceResultFactory(leafClaim) {
      leafClaim.attempt.baseRevisionId = forgedBaseRevisionId;
      const result = resourceResultFor(leafClaim);
      assert.equal(result.revision.parentRevisionId, forgedBaseRevisionId);
      return result;
    },
  });

  await executor.execute(claim, new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.port), ["resource", "finish-failure"]);
  assert.equal(calls.some((call) => call.port.startsWith("publish-")), false);
  assert.deepEqual(calls.find((call) => call.port === "finish-failure")?.values[0], authoritativeClaim);
  assert.deepEqual(claim, authoritativeClaim);
});

test("GenerationTaskExecutor preserves authoritative Prototype dependency outputs across the leaf boundary", async () => {
  const fixture = claimFixture("prototype-validation");
  const claim: GenerationTaskAttemptClaim = {
    ...fixture,
    attempt: {
      ...fixture.attempt,
      dependencyOutputs: [{
        ordinal: 0,
        taskId: "component-upstream",
        resultRevisionId: "artifact-revision-authoritative",
        resultResourceRevisionId: null,
        resultSnapshotId: null,
      }],
    },
  };
  const authoritativeClaim = structuredClone(claim);
  const forgedRevisionId = "artifact-revision-forged";
  const { calls, executor } = harness({
    prototypeResultFactory(leafClaim) {
      leafClaim.attempt.dependencyOutputs[0]!.resultRevisionId = forgedRevisionId;
      return {
        ...prototypeResultFor(leafClaim),
        artifactRevisionIds: [forgedRevisionId],
      };
    },
  });

  await executor.execute(claim, new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.port), ["prototype", "finish-failure"]);
  assert.equal(calls.some((call) => call.port.startsWith("publish-")), false);
  assert.deepEqual(calls.find((call) => call.port === "finish-failure")?.values[0], authoritativeClaim);
  assert.deepEqual(claim, authoritativeClaim);
});
