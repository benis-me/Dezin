import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeGenerationTaskIntent,
  type ArtifactRevisionRecord,
  type GenerationTask,
  type GenerationTaskAttemptClaim,
  type ResourceRevision,
  type WorkspaceSnapshotRecord,
} from "../../../packages/core/src/index.ts";
import {
  GenerationTaskExecutor,
  type GenerationTaskExecutorOptions,
  type PreparedGenerationTaskResult,
} from "../src/orchestration/generation-task-executor.ts";
import {
  PrototypeValidationExecutor,
  PrototypeValidationError,
  type PrototypeValidationStorePort,
} from "../src/orchestration/prototype-validation-executor.ts";

const WORKSPACE_ID = "workspace-prototype-validation";
const PLAN_ID = "plan-prototype-validation";
const TASK_ID = "task-prototype-validation";
const SNAPSHOT_ID = "snapshot-prototype-validation";
const KERNEL_REVISION_ID = "kernel-prototype-validation";

const FRAMES = [
  {
    id: "desktop",
    name: "Desktop",
    width: 1440,
    height: 900,
    initialState: "details-ready",
  },
  {
    id: "mobile",
    name: "Mobile",
    width: 390,
    height: 844,
    initialState: "details-ready",
  },
] as const;

const PROTOTYPE_INTENT = {
  edgeId: "edge-home-details",
  sourceArtifactId: "page-home",
  targetArtifactId: "page-details",
  sourceLocator: {
    designNodeId: "home-primary-cta",
    sourcePath: "src/pages/Home.tsx",
    selector: "[data-design-node-id='home-primary-cta']",
  },
  trigger: "click",
  targetState: "details-ready",
  transition: { type: "fade", durationMs: 180, easing: "ease-out" },
} as const;

function taskFixture(): GenerationTask {
  return {
    ...normalizeGenerationTaskIntent({
      id: TASK_ID,
      ordinal: 3,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      kind: "prototype-validation",
      target: { type: "workspace", workspaceId: WORKSPACE_ID, id: WORKSPACE_ID },
      dependencyIds: ["task-home", "task-details", "task-brand"],
      payload: {
        version: 1,
        prototypeIntents: [PROTOTYPE_INTENT],
        responsiveFrames: FRAMES,
        artifactIds: ["page-details", "page-home"],
      },
      capabilities: ["visual-qa"],
      qaProfile: {
        requiredFrameIds: ["desktop", "mobile"],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
      resourceLimits: {
        timeoutMs: 120_000,
        maxAgentTurns: 1,
        maxRepairRounds: 0,
        maxOutputBytes: 8_000_000,
        capacityClasses: ["render-qa"],
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
    createdAt: 1_000,
    finishedAt: null,
  };
}

function claimFixture(): GenerationTaskAttemptClaim {
  const task = taskFixture();
  const lease = {
    taskId: task.id,
    workspaceId: task.workspaceId,
    attempt: task.currentAttempt,
    ownerId: "daemon-prototype-validator",
    leaseToken: "prototype-validation-lease",
  };
  return {
    task,
    attempt: {
      taskId: task.id,
      planId: task.planId,
      workspaceId: task.workspaceId,
      attempt: task.currentAttempt,
      target: task.target,
      baseRevisionId: null,
      sourceCommitHash: null,
      sourceTreeHash: null,
      expectedSnapshotId: SNAPSHOT_ID,
      contextPackId: null,
      kernelRevisionId: KERNEL_REVISION_ID,
      payload: task.payload,
      dependencyOutputs: [
        {
          ordinal: 0,
          taskId: "task-home",
          resultRevisionId: "revision-home",
          resultResourceRevisionId: null,
          resultSnapshotId: "snapshot-after-home",
        },
        {
          ordinal: 1,
          taskId: "task-details",
          resultRevisionId: "revision-details",
          resultResourceRevisionId: null,
          resultSnapshotId: "snapshot-after-details",
        },
        {
          ordinal: 2,
          taskId: "task-brand",
          resultRevisionId: null,
          resultResourceRevisionId: "resource-revision-brand",
          resultSnapshotId: SNAPSHOT_ID,
        },
      ],
      resourcePins: [],
      componentPins: [],
      inputHash: "prototype-validation-input-hash",
      retryContextPolicy: "same-context",
      executionMode: "full",
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
      lease,
      leaseExpiresAt: 130_000,
      heartbeatAt: 100_000,
      createdAt: 10_000,
      startedAt: 100_000,
      finishedAt: null,
    },
    lease,
    claims: [{
      ...lease,
      planId: PLAN_ID,
      claimKey: "capacity:render-qa:1",
      claimKind: "capacity",
      leaseExpiresAt: 130_000,
      createdAt: 100_000,
    }],
  };
}

function artifactRevision(
  artifactId: "page-home" | "page-details",
  revisionId: "revision-home" | "revision-details",
): ArtifactRevisionRecord {
  const suffix = artifactId === "page-home" ? "home" : "details";
  return {
    id: revisionId,
    workspaceId: WORKSPACE_ID,
    artifactId,
    trackId: `track-${suffix}`,
    sequence: 2,
    parentRevisionId: `base-${suffix}`,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    artifactRoot: `artifacts/${artifactId}`,
    kernelRevisionId: KERNEL_REVISION_ID,
    renderSpec: { frames: structuredClone(FRAMES) },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: `context-${suffix}`,
    producedByRunId: null,
    legacyRunId: null,
    createdAt: 20_000,
  };
}

function resourceRevision(): ResourceRevision {
  return {
    id: "resource-revision-brand",
    workspaceId: WORKSPACE_ID,
    resourceId: "resource-brand",
    sequence: 2,
    parentRevisionId: "resource-brand-base",
    manifestPath: "resource-revisions/resource-brand/2/manifest.json",
    summary: "Approved brand source",
    metadata: {},
    checksum: "c".repeat(64),
    provenance: { planId: PLAN_ID, taskId: "task-brand" },
    createdByRunId: null,
    createdAt: 19_000,
  };
}

function snapshotFixture(): WorkspaceSnapshotRecord {
  return {
    id: SNAPSHOT_ID,
    workspaceId: WORKSPACE_ID,
    sequence: 8,
    parentSnapshotId: "snapshot-before-validation",
    graphRevision: 7,
    kernelRevisionId: KERNEL_REVISION_ID,
    reason: "resource-published",
    provenance: {
      kind: "resource-publication",
      resourceRevisionId: "resource-revision-brand",
      planId: PLAN_ID,
      taskId: "task-brand",
    },
    createdByRunId: null,
    createdAt: 30_000,
    graph: {
      workspaceId: WORKSPACE_ID,
      revision: 7,
      nodes: [
        {
          id: "node-home",
          workspaceId: WORKSPACE_ID,
          kind: "page",
          name: "Home",
          artifactId: "page-home",
        },
        {
          id: "node-details",
          workspaceId: WORKSPACE_ID,
          kind: "page",
          name: "Details",
          artifactId: "page-details",
        },
        {
          id: "node-brand",
          workspaceId: WORKSPACE_ID,
          kind: "resource",
          name: "Brand",
          resourceId: "resource-brand",
        },
      ],
      edges: [{
        id: PROTOTYPE_INTENT.edgeId,
        workspaceId: WORKSPACE_ID,
        kind: "prototype",
        sourceNodeId: "node-home",
        targetNodeId: "node-details",
        prototype: {
          status: "interactive",
          binding: {
            sourceArtifactId: PROTOTYPE_INTENT.sourceArtifactId,
            sourceRevisionId: "revision-home",
            sourceLocator: structuredClone(PROTOTYPE_INTENT.sourceLocator),
            trigger: PROTOTYPE_INTENT.trigger,
            targetArtifactId: PROTOTYPE_INTENT.targetArtifactId,
            targetState: PROTOTYPE_INTENT.targetState,
            transition: structuredClone(PROTOTYPE_INTENT.transition),
          },
        },
      }],
    },
    artifactTracks: {
      "page-home": "track-home",
      "page-details": "track-details",
    },
    artifactRevisions: {
      "page-home": "revision-home",
      "page-details": "revision-details",
    },
    resourceRevisions: { "resource-brand": "resource-revision-brand" },
  };
}

function harness(overrides: {
  snapshot?: WorkspaceSnapshotRecord | null;
  artifacts?: Map<string, ArtifactRevisionRecord>;
  resources?: Map<string, ResourceRevision>;
  onReadSnapshot?: (signal: AbortSignal) => void;
} = {}) {
  const snapshot = overrides.snapshot === undefined ? snapshotFixture() : overrides.snapshot;
  const artifacts = overrides.artifacts ?? new Map([
    ["revision-home", artifactRevision("page-home", "revision-home")],
    ["revision-details", artifactRevision("page-details", "revision-details")],
  ]);
  const resources = overrides.resources ?? new Map([
    ["resource-revision-brand", resourceRevision()],
  ]);
  const reads: string[] = [];
  const store: PrototypeValidationStorePort = {
    readSnapshot(workspaceId, snapshotId, signal) {
      reads.push(`snapshot:${workspaceId}:${snapshotId}`);
      overrides.onReadSnapshot?.(signal);
      return snapshot;
    },
    readArtifactRevision(workspaceId, revisionId) {
      reads.push(`artifact:${workspaceId}:${revisionId}`);
      return artifacts.get(revisionId) ?? null;
    },
    readResourceRevision(workspaceId, revisionId) {
      reads.push(`resource:${workspaceId}:${revisionId}`);
      return resources.get(revisionId) ?? null;
    },
  };
  return { executor: new PrototypeValidationExecutor({ store }), reads };
}

test("PrototypeValidationExecutor resolves one immutable Snapshot into strict deterministic evidence", async () => {
  const { executor, reads } = harness();

  const result = await executor.execute(claimFixture(), new AbortController().signal);

  assert.deepEqual(reads, [
    `snapshot:${WORKSPACE_ID}:${SNAPSHOT_ID}`,
    `artifact:${WORKSPACE_ID}:revision-details`,
    `artifact:${WORKSPACE_ID}:revision-home`,
    `resource:${WORKSPACE_ID}:resource-revision-brand`,
  ]);
  assert.deepEqual(result, {
    kind: "snapshot-validation",
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    snapshotId: SNAPSHOT_ID,
    graphRevision: 7,
    artifactRevisionIds: ["revision-details", "revision-home"],
    resourceRevisionIds: ["resource-revision-brand"],
    evidence: {
      protocol: "dezin-prototype-validation-v1",
      snapshot: {
        id: SNAPSHOT_ID,
        graphRevision: 7,
        kernelRevisionId: KERNEL_REVISION_ID,
      },
      dependencies: [
        {
          ordinal: 0,
          taskId: "task-home",
          kind: "artifact",
          revisionId: "revision-home",
          resultSnapshotId: "snapshot-after-home",
        },
        {
          ordinal: 1,
          taskId: "task-details",
          kind: "artifact",
          revisionId: "revision-details",
          resultSnapshotId: "snapshot-after-details",
        },
        {
          ordinal: 2,
          taskId: "task-brand",
          kind: "resource",
          revisionId: "resource-revision-brand",
          resultSnapshotId: SNAPSHOT_ID,
        },
      ],
      artifacts: [
        {
          artifactId: "page-details",
          revisionId: "revision-details",
          trackId: "track-details",
          frameIds: ["desktop", "mobile"],
        },
        {
          artifactId: "page-home",
          revisionId: "revision-home",
          trackId: "track-home",
          frameIds: ["desktop", "mobile"],
        },
      ],
      resources: [{ resourceId: "resource-brand", revisionId: "resource-revision-brand" }],
      prototypeEdges: [{
        edgeId: "edge-home-details",
        sourceArtifactId: "page-home",
        sourceRevisionId: "revision-home",
        sourceLocator: PROTOTYPE_INTENT.sourceLocator,
        targetArtifactId: "page-details",
        targetRevisionId: "revision-details",
        trigger: "click",
        targetState: "details-ready",
        transition: PROTOTYPE_INTENT.transition,
        frameIds: ["desktop", "mobile"],
      }],
      frames: structuredClone(FRAMES),
    },
  });
});

test("PrototypeValidationExecutor detaches evidence from its read-only claim and Store inputs", async () => {
  const claim = claimFixture();
  const snapshot = snapshotFixture();
  const { executor } = harness({ snapshot });

  const result = await executor.execute(claim, new AbortController().signal);
  const evidence = structuredClone(result.evidence);
  const payload = claim.task.payload as {
    prototypeIntents: Array<{ transition: { durationMs: number } }>;
  };
  payload.prototypeIntents[0]!.transition.durationMs = 999;
  const edge = snapshot.graph.edges[0]!;
  assert.equal(edge.kind, "prototype");
  assert.equal(edge.prototype.status, "interactive");
  edge.prototype.binding.transition!.durationMs = 777;

  assert.deepEqual(result.evidence, evidence);
});

for (const { name, mutateClaim, mutateSnapshot } of [
  {
    name: "an Artifact output absent from the payload Artifact set",
    mutateClaim(claim: GenerationTaskAttemptClaim) {
      claim.task.payload.artifactIds = ["page-home"];
      claim.attempt.payload = claim.task.payload;
    },
  },
  {
    name: "a dependency output carrying both Revision kinds",
    mutateClaim(claim: GenerationTaskAttemptClaim) {
      claim.attempt.dependencyOutputs[0]!.resultResourceRevisionId = "resource-revision-brand";
    },
  },
  {
    name: "an Artifact Revision outside the exact Snapshot pointer",
    mutateSnapshot(snapshot: WorkspaceSnapshotRecord) {
      snapshot.artifactRevisions["page-home"] = "revision-home-stale";
    },
  },
  {
    name: "a Resource Revision outside the exact Snapshot pointer",
    mutateSnapshot(snapshot: WorkspaceSnapshotRecord) {
      snapshot.resourceRevisions["resource-brand"] = "resource-revision-stale";
    },
  },
] as const) {
  test(`PrototypeValidationExecutor fails closed for ${name}`, async () => {
    const claim = claimFixture();
    mutateClaim?.(claim);
    const snapshot = snapshotFixture();
    mutateSnapshot?.(snapshot);
    const { executor } = harness({ snapshot });

    await assert.rejects(
      executor.execute(claim, new AbortController().signal),
      (error) => error instanceof PrototypeValidationError && error.failureClass === "qa",
    );
  });
}

for (const { name, mutate } of [
  {
    name: "a planned prototype edge",
    mutate(snapshot: WorkspaceSnapshotRecord) {
      const edge = snapshot.graph.edges[0]!;
      assert.equal(edge.kind, "prototype");
      edge.prototype = { status: "planned" };
    },
  },
  {
    name: "a prototype binding pinned to a stale source Revision",
    mutate(snapshot: WorkspaceSnapshotRecord) {
      const edge = snapshot.graph.edges[0]!;
      assert.equal(edge.kind, "prototype");
      assert.equal(edge.prototype.status, "interactive");
      edge.prototype.binding.sourceRevisionId = "revision-home-stale";
    },
  },
  {
    name: "an unresolved prototype target state",
    mutate(snapshot: WorkspaceSnapshotRecord, artifacts: Map<string, ArtifactRevisionRecord>) {
      const target = artifacts.get("revision-details")!;
      target.renderSpec = {
        frames: structuredClone(FRAMES).map((frame) => ({ ...frame, initialState: "default" })),
      };
    },
  },
  {
    name: "a missing immutable responsive Frame",
    mutate(snapshot: WorkspaceSnapshotRecord, artifacts: Map<string, ArtifactRevisionRecord>) {
      const source = artifacts.get("revision-home")!;
      source.renderSpec = { frames: structuredClone(FRAMES).slice(0, 1) };
    },
  },
] as const) {
  test(`PrototypeValidationExecutor rejects ${name}`, async () => {
    const snapshot = snapshotFixture();
    const artifacts = new Map([
      ["revision-home", artifactRevision("page-home", "revision-home")],
      ["revision-details", artifactRevision("page-details", "revision-details")],
    ]);
    mutate(snapshot, artifacts);
    const { executor } = harness({ snapshot, artifacts });

    await assert.rejects(
      executor.execute(claimFixture(), new AbortController().signal),
      (error) => error instanceof PrototypeValidationError && error.failureClass === "qa",
    );
  });
}

test("PrototypeValidationExecutor rejects missing immutable records instead of falling back to current state", async () => {
  for (const fixture of [
    harness({ snapshot: null }),
    harness({ artifacts: new Map([["revision-home", artifactRevision("page-home", "revision-home")]]) }),
    harness({ resources: new Map() }),
  ]) {
    await assert.rejects(
      fixture.executor.execute(claimFixture(), new AbortController().signal),
      (error) => error instanceof PrototypeValidationError && error.failureClass === "qa",
    );
  }
});

test("PrototypeValidationExecutor rejects a wrong Task kind before reading Store state", async () => {
  const claim = claimFixture();
  claim.task = { ...claim.task, kind: "checkpoint" };
  const { executor, reads } = harness();

  await assert.rejects(executor.execute(claim, new AbortController().signal), PrototypeValidationError);
  assert.deepEqual(reads, []);
});

test("PrototypeValidationExecutor observes AbortSignal before and after Store reads", async () => {
  const alreadyAborted = new AbortController();
  const initialReason = new Error("validation scope already stopped");
  alreadyAborted.abort(initialReason);
  const initial = harness();
  await assert.rejects(executorCall(initial.executor, alreadyAborted.signal), (error) => error === initialReason);
  assert.deepEqual(initial.reads, []);

  const duringRead = new AbortController();
  const readReason = new Error("validation scope stopped during Snapshot read");
  const inFlight = harness({
    onReadSnapshot() {
      duringRead.abort(readReason);
    },
  });
  await assert.rejects(executorCall(inFlight.executor, duringRead.signal), (error) => error === readReason);
  assert.deepEqual(inFlight.reads, [`snapshot:${WORKSPACE_ID}:${SNAPSHOT_ID}`]);
});

function executorCall(executor: PrototypeValidationExecutor, signal: AbortSignal) {
  return executor.execute(claimFixture(), signal);
}

function dispatcherHarness(validator: PrototypeValidationExecutor) {
  const calls: Array<{
    port: "publish-prepared" | "publish-recorded" | "publish-checkpoint" | "finish-failure";
    result?: PreparedGenerationTaskResult;
    failure?: { failureClass: string; error: Record<string, unknown> };
  }> = [];
  const options: GenerationTaskExecutorOptions = {
    artifacts: {
      async execute() {
        throw new Error("Artifact adapter must not own prototype validation");
      },
    },
    resources: {
      async execute() {
        throw new Error("Resource adapter must not own prototype validation");
      },
      async cleanupIfUnreferenced() {
        return false;
      },
    },
    prototypeValidation: validator,
    publication: {
      async publishPreparedResult(_claim, result) {
        calls.push({ port: "publish-prepared", result });
      },
      async publishRecordedCandidate() {
        calls.push({ port: "publish-recorded" });
      },
      async publishCheckpoint() {
        calls.push({ port: "publish-checkpoint" });
      },
      async finishFailure(_claim, failure) {
        calls.push({ port: "finish-failure", failure });
      },
    },
  };
  return { calls, options, executor: new GenerationTaskExecutor(options) };
}

test("GenerationTaskExecutor dispatches prototype-validation through the concrete read-only validator", async () => {
  const validation = harness();
  const dispatcher = dispatcherHarness(validation.executor);

  await dispatcher.executor.execute(claimFixture(), new AbortController().signal);

  assert.equal(validation.reads[0], `snapshot:${WORKSPACE_ID}:${SNAPSHOT_ID}`);
  assert.deepEqual(dispatcher.calls.map((call) => call.port), ["publish-prepared"]);
  assert.equal(dispatcher.calls[0]?.result?.kind, "snapshot-validation");
  assert.equal(dispatcher.calls[0]?.result?.evidence.protocol, "dezin-prototype-validation-v1");
});

test("GenerationTaskExecutor preserves the concrete validator QA failure classification", async () => {
  const snapshot = snapshotFixture();
  const edge = snapshot.graph.edges[0]!;
  assert.equal(edge.kind, "prototype");
  edge.prototype = { status: "planned" };
  const validation = harness({ snapshot });
  const dispatcher = dispatcherHarness(validation.executor);

  await dispatcher.executor.execute(claimFixture(), new AbortController().signal);

  assert.deepEqual(dispatcher.calls.map((call) => call.port), ["finish-failure"]);
  assert.equal(dispatcher.calls[0]?.failure?.failureClass, "qa");
  assert.equal(dispatcher.calls[0]?.failure?.error.name, "PrototypeValidationError");
  assert.match(String(dispatcher.calls[0]?.failure?.error.message), /not interactive/i);
});

test("GenerationTaskExecutor pins the prototype validator adapter selected at construction", async () => {
  const validation = harness();
  const dispatcher = dispatcherHarness(validation.executor);
  const mutableOptions = dispatcher.options as {
    prototypeValidation: GenerationTaskExecutorOptions["prototypeValidation"];
  };
  mutableOptions.prototypeValidation = {
    async execute() {
      throw new PrototypeValidationError("replacement adapter must not be observed");
    },
  };

  await dispatcher.executor.execute(claimFixture(), new AbortController().signal);

  assert.equal(validation.reads[0], `snapshot:${WORKSPACE_ID}:${SNAPSHOT_ID}`);
  assert.deepEqual(dispatcher.calls.map((call) => call.port), ["publish-prepared"]);
});
