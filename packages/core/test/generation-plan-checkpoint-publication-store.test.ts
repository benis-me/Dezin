import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildGenerationTaskPrototypeValidationResult,
  GenerationTaskLeaseFenceError,
  Store,
  type GenerationPlan,
  type GenerationPlanEvent,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskAttemptLease,
  type StoreClock,
  type WorkspaceSnapshot,
} from "../src/index.ts";

interface ControlledClock {
  clock: StoreClock;
  set(now: number): void;
}

interface PublishGenerationPlanCheckpointInput {
  lease: GenerationTaskAttemptLease;
}

interface GenerationPlanCheckpointConflict {
  pointer: "active-snapshot";
  expectedId: string;
  actualId: string;
}

type PublishGenerationPlanCheckpointResult =
  | {
      status: "succeeded";
      task: GenerationTask;
      attempt: GenerationTaskAttempt;
      plan: GenerationPlan;
      snapshot: WorkspaceSnapshot;
      conflict: null;
    }
  | {
      status: "needs-rebase";
      task: GenerationTask;
      attempt: GenerationTaskAttempt;
      plan: GenerationPlan;
      snapshot: null;
      conflict: GenerationPlanCheckpointConflict;
    };

interface GenerationPlanCheckpointPublicationStoreContract {
  publishGenerationPlanCheckpointForProject(
    projectId: string,
    planId: string,
    input: PublishGenerationPlanCheckpointInput,
  ): PublishGenerationPlanCheckpointResult;
}

function checkpointApi(store: Store): GenerationPlanCheckpointPublicationStoreContract {
  return store.workspace as unknown as GenerationPlanCheckpointPublicationStoreContract;
}

function controlledClock(prefix: string): ControlledClock {
  let now = 50_000;
  let id = 0;
  return {
    clock: {
      now: () => now,
      id: () => `${prefix}-${++id}`,
    },
    set(value: number) {
      now = value;
    },
  };
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyGeneration() {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function createCheckpointFixture(label: string, databasePath = ":memory:") {
  const control = controlledClock(`checkpoint-publication-${label}`);
  const store = new Store(databasePath, control.clock);
  const project = store.createProject({ name: `Checkpoint publication ${label}`, mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);

  const resource = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: `Checkpoint research ${label}`,
    defaultPinPolicy: "follow-head",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const resourceRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    resource.resource.id,
    {
      revisionId: `checkpoint-resource-revision-${label}`,
      parentRevisionId: null,
      manifestPath: `resource-revisions/${label}/manifest.json`,
      summary: `Checkpoint source material ${label}`,
      metadata: { label, role: "checkpoint-contract" },
      checksum: checksum(`${label}:resource`),
      provenance: { source: "checkpoint-publication-fixture" },
    },
  );
  const resourceSnapshot = store.workspace.publishResourceRevisionForProject(
    project.id,
    resource.resource.id,
    resourceRevision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: resource.snapshot.id,
      reason: "Seed checkpoint Resource mapping",
    },
  );

  const artifactId = `checkpoint-page-${label}`;
  const trackId = `checkpoint-page-track-${label}`;
  const nodeId = `checkpoint-page-node-${label}`;
  const peerArtifactId = `checkpoint-peer-page-${label}`;
  const peerTrackId = `checkpoint-peer-page-track-${label}`;
  const peerNodeId = `checkpoint-peer-page-node-${label}`;
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: resourceSnapshot.graphRevision,
    expectedSnapshotId: resourceSnapshot.id,
    commands: [
      {
        id: `add-checkpoint-page-${label}`,
        type: "add-node",
        node: {
          id: nodeId,
          kind: "page",
          name: `Checkpoint Page ${label}`,
          artifactId,
          createIdentity: { initialTrackId: trackId },
        },
      },
      {
        id: `add-checkpoint-peer-page-${label}`,
        type: "add-node",
        node: {
          id: peerNodeId,
          kind: "page",
          name: `Checkpoint Peer Page ${label}`,
          artifactId: peerArtifactId,
          createIdentity: { initialTrackId: peerTrackId },
        },
      },
    ],
  });
  const withArtifact = store.workspace.getWorkspace(project.id)!;
  const artifactRevision = store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash: checksum(`${label}:artifact-commit`),
    sourceTreeHash: checksum(`${label}:artifact-tree`),
    kernelRevisionId: withArtifact.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [{ resourceId: resource.resource.id, resourceRevisionId: resourceRevision.id }],
  });
  const baseSnapshot = store.workspace.publishArtifactRevision(artifactRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  assert.equal(baseSnapshot.artifactRevisions[artifactId], artifactRevision.id);
  assert.equal(baseSnapshot.resourceRevisions[resource.resource.id], resourceRevision.id);

  const workspace = store.workspace.getWorkspace(project.id)!;
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: emptyGeneration(),
    rationale: "Seal the generated workspace as one immutable checkpoint",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const validation = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation");
  const checkpoint = compiled.tasks.find((candidate) => candidate.kind === "checkpoint");
  assert.ok(validation);
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.dependencyIds, [validation.id]);

  const validationObservation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    validation.id,
  );
  const validationAttempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...validationObservation,
      contextPackId: null,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const validationClaim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: validation.id,
    attempt: validationAttempt.attempt,
    ownerId: `validation-worker-${label}`,
    now: 60_000,
    leaseMs: 30_000,
  });
  assert.ok(validationClaim);
  control.set(60_001);
  const validationResult = store.workspace.completeGenerationTaskValidationForProject(
    project.id,
    compiled.plan.id,
    {
      lease: validationClaim.lease,
      validation: buildGenerationTaskPrototypeValidationResult({
        task: validationClaim.task,
        attempt: validationClaim.attempt,
        snapshot: baseSnapshot,
        artifactRevisions: [],
        resourceRevisions: [],
      }),
    },
  );

  const checkpointObservation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    checkpoint.id,
  );
  assert.equal(checkpointObservation.expectedSnapshotId, baseSnapshot.id);
  assert.deepEqual(checkpointObservation.dependencyOutputs, [{
    taskId: validation.id,
    resultRevisionId: null,
    resultResourceRevisionId: null,
    resultSnapshotId: baseSnapshot.id,
  }]);
  const attempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...checkpointObservation,
      contextPackId: null,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: checkpoint.id,
    attempt: attempt.attempt,
    ownerId: `checkpoint-worker-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  assert.equal(claim.claims.length, 1);
  assert.equal(claim.claims[0]?.claimKind, "writer");
  assert.match(claim.claims[0]?.claimKey ?? "", /^writer:checkpoint:/);
  control.set(100_001);

  return {
    control,
    store,
    project,
    workspace,
    proposal,
    plan: compiled.plan,
    validation,
    validationAttempt,
    validationResult,
    checkpoint,
    attempt,
    claim,
    nodeId,
    peerNodeId,
    artifactId,
    trackId,
    artifactRevision,
    resourceId: resource.resource.id,
    resourceRevision,
    baseSnapshot,
  };
}

type CheckpointFixture = ReturnType<typeof createCheckpointFixture>;

function checkpointInput(claim: GenerationTaskAttemptClaim): PublishGenerationPlanCheckpointInput {
  return { lease: claim.lease };
}

function rawRows(
  store: Store,
  sql: string,
  ...params: Array<string | number | null>
): Array<Record<string, unknown>> {
  return (store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>)
    .map((row) => ({ ...row }));
}

function durableCheckpointState(fixture: CheckpointFixture) {
  const { store } = fixture;
  return {
    workspace: rawRows(store, "SELECT * FROM project_workspaces WHERE id = ?", fixture.workspace.id),
    plan: rawRows(store, "SELECT * FROM generation_plans WHERE id = ?", fixture.plan.id),
    tasks: rawRows(
      store,
      "SELECT * FROM generation_tasks WHERE plan_id = ? ORDER BY ordinal",
      fixture.plan.id,
    ),
    attempts: rawRows(
      store,
      "SELECT * FROM generation_task_attempts WHERE plan_id = ? ORDER BY task_id, attempt",
      fixture.plan.id,
    ),
    dependencyOutputs: rawRows(
      store,
      `SELECT output.* FROM generation_task_attempt_dependency_outputs output
       JOIN generation_tasks task ON task.id = output.task_id
       WHERE task.plan_id = ? ORDER BY output.task_id, output.attempt, output.ordinal`,
      fixture.plan.id,
    ),
    claims: rawRows(
      store,
      `SELECT claim.* FROM generation_task_claims claim
       JOIN generation_tasks task ON task.id = claim.task_id
       WHERE task.plan_id = ? ORDER BY claim.task_id, claim.attempt, claim.claim_key`,
      fixture.plan.id,
    ),
    events: rawRows(
      store,
      "SELECT * FROM generation_plan_events WHERE plan_id = ? ORDER BY sequence",
      fixture.plan.id,
    ),
    snapshots: rawRows(
      store,
      "SELECT * FROM workspace_snapshots WHERE workspace_id = ? ORDER BY sequence",
      fixture.workspace.id,
    ),
    snapshotArtifacts: rawRows(
      store,
      `SELECT * FROM workspace_snapshot_artifacts
       WHERE workspace_id = ? ORDER BY snapshot_id, artifact_id`,
      fixture.workspace.id,
    ),
    snapshotResources: rawRows(
      store,
      `SELECT * FROM workspace_snapshot_resources
       WHERE workspace_id = ? ORDER BY snapshot_id, resource_id`,
      fixture.workspace.id,
    ),
    graphRevisions: rawRows(
      store,
      "SELECT * FROM workspace_graph_revisions WHERE workspace_id = ? ORDER BY revision",
      fixture.workspace.id,
    ),
    validationResults: rawRows(
      store,
      `SELECT * FROM generation_task_validation_results
       WHERE plan_id = ? ORDER BY task_id, attempt`,
      fixture.plan.id,
    ),
  };
}

function checkpointOutcome(fixture: CheckpointFixture): {
  plan: GenerationPlan;
  task: GenerationTask;
  attempt: GenerationTaskAttempt;
  snapshot: WorkspaceSnapshot;
} {
  const detail = fixture.store.workspace.getGenerationPlanDetailForProject(
    fixture.project.id,
    fixture.plan.id,
  );
  const task = detail.tasks.find((candidate) => candidate.id === fixture.checkpoint.id);
  assert.ok(task);
  const attempt = fixture.store.workspace.getGenerationTaskAttemptForProject(
    fixture.project.id,
    fixture.plan.id,
    task.id,
    task.currentAttempt,
  );
  assert.ok(attempt);
  assert.ok(task.resultSnapshotId);
  const snapshot = fixture.store.workspace.listSnapshots(fixture.project.id)
    .find((candidate) => candidate.id === task.resultSnapshotId);
  assert.ok(snapshot);
  return { plan: detail.plan, task, attempt, snapshot };
}

function generationEvents(
  fixture: CheckpointFixture,
  type: GenerationPlanEvent["type"],
): GenerationPlanEvent[] {
  return fixture.store.workspace.listGenerationPlanEventsForProject(
    fixture.project.id,
    fixture.plan.id,
    { after: 0, limit: 1_000 },
  ).filter((event) => event.type === type);
}

function assertIdenticalCheckpoint(
  fixture: CheckpointFixture,
  parent: WorkspaceSnapshot,
  snapshot: WorkspaceSnapshot,
): void {
  assert.equal(snapshot.parentSnapshotId, parent.id);
  assert.equal(snapshot.sequence, parent.sequence + 1);
  assert.equal(snapshot.reason, "plan-checkpoint");
  assert.deepEqual(snapshot.provenance, {
    kind: "plan-checkpoint",
    proposalId: fixture.proposal.id,
    planId: fixture.plan.id,
    checkpointId: fixture.checkpoint.id,
    validatedSnapshotId: fixture.validationResult.validation.snapshotId,
    validationEvidenceHash: fixture.validationResult.evidenceHash,
  });
  assert.equal(snapshot.graphRevision, parent.graphRevision);
  assert.equal(snapshot.kernelRevisionId, parent.kernelRevisionId);
  assert.deepEqual(snapshot.graph, parent.graph);
  assert.deepEqual(snapshot.artifactTracks, parent.artifactTracks);
  assert.deepEqual(snapshot.artifactRevisions, parent.artifactRevisions);
  assert.deepEqual(snapshot.resourceRevisions, parent.resourceRevisions);
  assert.equal(snapshot.artifactRevisions[fixture.artifactId], fixture.artifactRevision.id);
  assert.equal(snapshot.resourceRevisions[fixture.resourceId], fixture.resourceRevision.id);
}

function assertSuccessfulCheckpoint(
  fixture: CheckpointFixture,
  parent: WorkspaceSnapshot,
  result: PublishGenerationPlanCheckpointResult,
): void {
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") assert.fail("checkpoint publication unexpectedly needs rebase");
  const { plan, task, attempt, snapshot } = checkpointOutcome(fixture);
  assert.equal(plan.status, "succeeded");
  assert.equal(task.status, "succeeded");
  assert.equal(attempt.status, "succeeded");
  assert.equal(task.resultRevisionId, null);
  assert.equal(task.resultResourceRevisionId, null);
  assert.equal(task.resultSnapshotId, snapshot.id);
  assert.equal(task.finishedAt, attempt.finishedAt);
  assert.equal(plan.finishedAt, attempt.finishedAt);
  assert.ok(attempt.finishedAt !== null);
  assert.equal(attempt.lease, null);
  assert.equal(attempt.leaseExpiresAt, null);
  assert.equal(attempt.heartbeatAt, null);
  assert.equal(attempt.failureClass, null);
  assert.equal(attempt.error, null);
  assert.deepEqual(
    fixture.store.db.prepare(
      "SELECT * FROM generation_task_claims WHERE task_id = ? ORDER BY claim_key",
    ).all(task.id),
    [],
  );
  assert.equal(fixture.store.workspace.getWorkspace(fixture.project.id)?.activeSnapshotId, snapshot.id);
  assertIdenticalCheckpoint(fixture, parent, snapshot);
  assert.equal(result.task.id, task.id);
  assert.equal(result.attempt.attempt, attempt.attempt);
  assert.equal(result.plan.id, plan.id);
  assert.equal(result.snapshot.id, snapshot.id);
  assert.equal(result.conflict, null);

  const taskEvents = generationEvents(fixture, "task-succeeded")
    .filter((event) => event.taskId === fixture.checkpoint.id);
  const planEvents = generationEvents(fixture, "plan-succeeded");
  assert.equal(taskEvents.length, 1);
  assert.equal(planEvents.length, 1);
  assert.equal(taskEvents[0]?.payload.attempt, attempt.attempt);
  assert.equal(taskEvents[0]?.payload.resultRevisionId, null);
  assert.equal(taskEvents[0]?.payload.resultResourceRevisionId, null);
  assert.equal(taskEvents[0]?.payload.resultSnapshotId, snapshot.id);
  assert.equal(
    taskEvents[0]?.payload.validatedSnapshotId,
    fixture.validationResult.validation.snapshotId,
  );
  assert.equal(
    taskEvents[0]?.payload.validationEvidenceHash,
    fixture.validationResult.evidenceHash,
  );
  assert.equal(typeof taskEvents[0]?.payload.publicationFenceHash, "string");
  assert.equal((taskEvents[0]?.payload.publicationFenceHash as string).length, 64);
  assert.equal(planEvents[0]?.taskId, null);
  assert.equal(planEvents[0]?.payload.checkpointId, fixture.checkpoint.id);
  assert.equal(planEvents[0]?.payload.resultSnapshotId, snapshot.id);
  assert.equal(
    planEvents[0]?.payload.validatedSnapshotId,
    fixture.validationResult.validation.snapshotId,
  );
  assert.equal(
    planEvents[0]?.payload.validationEvidenceHash,
    fixture.validationResult.evidenceHash,
  );
  const events = fixture.store.workspace.listGenerationPlanEventsForProject(
    fixture.project.id,
    fixture.plan.id,
    { after: 0, limit: 1_000 },
  );
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["task-succeeded", "plan-succeeded"]);
}

function driftActiveSnapshotAfterClaim(fixture: CheckpointFixture): WorkspaceSnapshot {
  const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
  const drift = fixture.store.workspace.applyGraphCommands(fixture.project.id, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: `rename-during-checkpoint-${fixture.checkpoint.id}`,
      type: "rename-node",
      nodeId: fixture.nodeId,
      name: "Concurrent useful Page rename",
    }],
  });
  assert.notEqual(drift.snapshot.id, fixture.attempt.expectedSnapshotId);
  assert.equal(drift.snapshot.parentSnapshotId, fixture.attempt.expectedSnapshotId);
  return drift.snapshot;
}

function assertCheckpointNeedsRebase(
  fixture: CheckpointFixture,
  activeSnapshot: WorkspaceSnapshot,
): void {
  const beforeSnapshotCount = fixture.store.workspace.listSnapshots(fixture.project.id).length;
  const result = checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
    fixture.project.id,
    fixture.plan.id,
    checkpointInput(fixture.claim),
  );
  assert.equal(result.status, "needs-rebase");
  if (result.status !== "needs-rebase") assert.fail("harmful drift was checkpointed");
  assert.deepEqual(result.conflict, {
    pointer: "active-snapshot",
    expectedId: fixture.validationResult.validation.snapshotId,
    actualId: activeSnapshot.id,
  });
  assert.equal(result.plan.status, "running");
  assert.equal(result.task.status, "needs-rebase");
  assert.equal(result.attempt.status, "needs-rebase");
  assert.equal(result.task.resultSnapshotId, null);
  assert.equal(
    fixture.store.workspace.getWorkspace(fixture.project.id)?.activeSnapshotId,
    activeSnapshot.id,
  );
  assert.equal(
    fixture.store.workspace.listSnapshots(fixture.project.id).length,
    beforeSnapshotCount,
  );
  assert.equal(generationEvents(fixture, "plan-succeeded").length, 0);
  assert.equal(
    generationEvents(fixture, "task-succeeded")
      .filter((event) => event.taskId === fixture.checkpoint.id).length,
    0,
  );
  const rebaseEvents = generationEvents(fixture, "task-needs-rebase")
    .filter((event) => event.taskId === fixture.checkpoint.id);
  assert.equal(rebaseEvents.length, 1);
  assert.equal(
    rebaseEvents[0]?.payload.validatedSnapshotId,
    fixture.validationResult.validation.snapshotId,
  );
  assert.equal(
    rebaseEvents[0]?.payload.validationEvidenceHash,
    fixture.validationResult.evidenceHash,
  );
}

function publishArtifactDrift(
  fixture: CheckpointFixture,
  frames: Array<Record<string, unknown>>,
): WorkspaceSnapshot {
  const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
  const revision = fixture.store.workspace.createArtifactRevision({
    artifactId: fixture.artifactId,
    trackId: fixture.trackId,
    parentRevisionId: fixture.artifactRevision.id,
    sourceCommitHash: checksum(`${fixture.checkpoint.id}:artifact-drift:${JSON.stringify(frames)}`),
    sourceTreeHash: checksum(`${fixture.checkpoint.id}:artifact-tree-drift:${JSON.stringify(frames)}`),
    kernelRevisionId: workspace.activeKernelRevisionId,
    renderSpec: { frames },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [{
      resourceId: fixture.resourceId,
      resourceRevisionId: fixture.resourceRevision.id,
    }],
  });
  return fixture.store.workspace.publishArtifactRevision(revision.id, {
    expectedHeadRevisionId: fixture.artifactRevision.id,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
}

test("checkpoint publication requires the exact unexpired lease and complete writer claim", async (t) => {
  await t.test("wrong lease token", () => {
    const fixture = createCheckpointFixture("wrong-token");
    try {
      const before = durableCheckpointState(fixture);
      assert.throws(
        () => checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
          fixture.project.id,
          fixture.plan.id,
          {
            lease: {
              ...fixture.claim.lease,
              leaseToken: `${fixture.claim.lease.leaseToken}-wrong`,
            },
          },
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableCheckpointState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("lease expiry equality", () => {
    const fixture = createCheckpointFixture("expired");
    try {
      assert.ok(fixture.claim.attempt.leaseExpiresAt);
      fixture.control.set(fixture.claim.attempt.leaseExpiresAt);
      const before = durableCheckpointState(fixture);
      assert.throws(
        () => checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
          fixture.project.id,
          fixture.plan.id,
          checkpointInput(fixture.claim),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableCheckpointState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("missing writer claim", () => {
    const fixture = createCheckpointFixture("missing-claim");
    try {
      fixture.store.db.exec("DROP TRIGGER generation_task_claim_delete_live_guard");
      const deleted = fixture.store.db.prepare(
        `DELETE FROM generation_task_claims
         WHERE task_id = ? AND attempt = ? AND claim_kind = 'writer'`,
      ).run(fixture.checkpoint.id, fixture.attempt.attempt);
      assert.equal(Number(deleted.changes), 1);
      const before = durableCheckpointState(fixture);
      assert.throws(
        () => checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
          fixture.project.id,
          fixture.plan.id,
          checkpointInput(fixture.claim),
        ),
        /claim|lease|fence/i,
      );
      assert.deepEqual(durableCheckpointState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("checkpoint publication atomically seals the current Workspace mapping and Generation Plan", () => {
  const fixture = createCheckpointFixture("success");
  try {
    const parent = fixture.store.workspace.listSnapshots(fixture.project.id)
      .find((snapshot) => snapshot.id === fixture.baseSnapshot.id);
    assert.ok(parent);
    const before = durableCheckpointState(fixture);
    const result = checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
      fixture.project.id,
      fixture.plan.id,
      checkpointInput(fixture.claim),
    );

    assertSuccessfulCheckpoint(fixture, parent, result);
    const after = durableCheckpointState(fixture);
    assert.equal(after.snapshots.length, before.snapshots.length + 1);
    assert.equal(
      after.snapshotArtifacts.length,
      before.snapshotArtifacts.length + Object.keys(parent.artifactRevisions).length,
    );
    assert.equal(
      after.snapshotResources.length,
      before.snapshotResources.length + Object.keys(parent.resourceRevisions).length,
    );
  } finally {
    fixture.store.close();
  }
});

test("Snapshot progress committed after claim is safely checkpointed from the latest active Snapshot", () => {
  const fixture = createCheckpointFixture("concurrent-snapshot");
  try {
    const frozenSnapshotId = fixture.attempt.expectedSnapshotId;
    const concurrent = driftActiveSnapshotAfterClaim(fixture);
    const before = durableCheckpointState(fixture);
    const result = checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
      fixture.project.id,
      fixture.plan.id,
      checkpointInput(fixture.claim),
    );

    assert.notEqual(concurrent.id, frozenSnapshotId);
    assertSuccessfulCheckpoint(fixture, concurrent, result);
    const after = durableCheckpointState(fixture);
    assert.equal(after.snapshots.length, before.snapshots.length + 1);
    assert.equal(after.graphRevisions.length, before.graphRevisions.length);
  } finally {
    fixture.store.close();
  }
});

test("checkpoint publication refuses semantically harmful drift after validation", async (t) => {
  await t.test("Kernel", () => {
    const fixture = createCheckpointFixture("kernel-drift");
    try {
      const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
      const kernel = fixture.store.workspace.createKernelRevision({
        workspaceId: workspace.id,
        parentRevisionId: workspace.activeKernelRevisionId,
        tokens: { accent: "#ff3366" },
        typography: {},
        sharedAssetRevisionIds: [],
        brief: "Unvalidated Kernel drift",
        terminology: {},
        exclusions: [],
        responsiveFrames: [],
        qualityProfile: {
          requiredFrameIds: [],
          blockingSeverities: [],
          requireRuntimeChecks: false,
          requireVisualReview: false,
        },
      });
      const drift = fixture.store.workspace.publishKernelRevision(kernel.id, {
        expectedKernelRevisionId: workspace.activeKernelRevisionId,
        expectedSnapshotId: workspace.activeSnapshotId,
      });
      assertCheckpointNeedsRebase(fixture, drift);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("Artifact Revision mapping", () => {
    const fixture = createCheckpointFixture("artifact-drift");
    try {
      assertCheckpointNeedsRebase(fixture, publishArtifactDrift(fixture, [
        { id: "desktop", width: 1_440, height: 900 },
      ]));
    } finally {
      fixture.store.close();
    }
  });

  await t.test("Resource Revision mapping", () => {
    const fixture = createCheckpointFixture("resource-drift");
    try {
      const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
      const revision = fixture.store.workspace.createResourceRevisionCandidateForProject(
        fixture.project.id,
        fixture.resourceId,
        {
          revisionId: `resource-drift-${fixture.checkpoint.id}`,
          parentRevisionId: fixture.resourceRevision.id,
          manifestPath: `resource-revisions/${fixture.checkpoint.id}/drift.json`,
          summary: "Unvalidated Resource drift",
          metadata: {},
          checksum: checksum(`${fixture.checkpoint.id}:resource-drift`),
          provenance: { source: "checkpoint-drift-test" },
        },
      );
      const drift = fixture.store.workspace.publishResourceRevisionForProject(
        fixture.project.id,
        fixture.resourceId,
        revision.id,
        {
          expectedHeadRevisionId: fixture.resourceRevision.id,
          expectedSnapshotId: workspace.activeSnapshotId,
          reason: "Unvalidated Resource drift",
        },
      );
      assertCheckpointNeedsRebase(fixture, drift);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("prototype edge", () => {
    const fixture = createCheckpointFixture("prototype-drift");
    try {
      const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
      const drift = fixture.store.workspace.applyGraphCommands(fixture.project.id, {
        baseGraphRevision: workspace.graphRevision,
        expectedSnapshotId: workspace.activeSnapshotId,
        commands: [{
          id: `prototype-drift-${fixture.checkpoint.id}`,
          type: "add-edge",
          edge: {
            id: `prototype-edge-drift-${fixture.checkpoint.id}`,
            workspaceId: workspace.id,
            kind: "prototype",
            sourceNodeId: fixture.nodeId,
            targetNodeId: fixture.peerNodeId,
          },
        }],
      });
      assertCheckpointNeedsRebase(fixture, drift.snapshot);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("RenderSpec Frames", () => {
    const fixture = createCheckpointFixture("frame-drift");
    try {
      assertCheckpointNeedsRebase(fixture, publishArtifactDrift(fixture, [
        { id: "mobile", width: 390, height: 844 },
      ]));
    } finally {
      fixture.store.close();
    }
  });
});

test("harmful checkpoint drift reconciles into a fresh validation and checkpoint round", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-checkpoint-revalidation-"));
  const databasePath = join(directory, "workspace.db");
  const fixture = createCheckpointFixture("harmful-drift-roundtrip", databasePath);
  try {
    const beforeDrift = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const revision = fixture.store.workspace.createResourceRevisionCandidateForProject(
      fixture.project.id,
      fixture.resourceId,
      {
        revisionId: `resource-drift-${fixture.checkpoint.id}`,
        parentRevisionId: fixture.resourceRevision.id,
        manifestPath: `resource-revisions/${fixture.checkpoint.id}/roundtrip.json`,
        summary: "Resource authority changed after the first validation",
        metadata: { roundtrip: true },
        checksum: checksum(`${fixture.checkpoint.id}:resource-drift-roundtrip`),
        provenance: { source: "checkpoint-drift-roundtrip-test" },
      },
    );
    const drift = fixture.store.workspace.publishResourceRevisionForProject(
      fixture.project.id,
      fixture.resourceId,
      revision.id,
      {
        expectedHeadRevisionId: fixture.resourceRevision.id,
        expectedSnapshotId: beforeDrift.activeSnapshotId,
        reason: "Advance validation authority to S2",
      },
    );
    assert.notEqual(drift.id, fixture.validationResult.validation.snapshotId);
    assertCheckpointNeedsRebase(fixture, drift);

    const disposition = fixture.store.workspace.reconcileGenerationTaskNeedsRebaseForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.checkpoint.id,
    );
    assert.equal(disposition.kind, "full");
    if (disposition.kind !== "full") assert.fail("checkpoint drift must require a full round");
    assert.equal(disposition.status, "materialization-pending");
    assert.equal(disposition.rebaseCount, 1);

    const afterDisposition = durableCheckpointState(fixture);
    fixture.store.close();
    fixture.store = new Store(databasePath, fixture.control.clock);
    assert.deepEqual(
      fixture.store.workspace.reconcileGenerationTaskNeedsRebaseForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.checkpoint.id,
      ),
      disposition,
    );
    assert.deepEqual(durableCheckpointState(fixture), afterDisposition);

    let detail = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    const validationTask = detail.tasks.find((candidate) => candidate.id === fixture.validation.id);
    const checkpointTask = detail.tasks.find((candidate) => candidate.id === fixture.checkpoint.id);
    assert.ok(validationTask);
    assert.ok(checkpointTask);
    assert.equal(validationTask.status, "materialization-pending");
    assert.equal(validationTask.resultSnapshotId, null);
    assert.equal(checkpointTask.status, "materialization-pending");
    assert.deepEqual(
      fixture.store.workspace.listGenerationTaskIdsReadyForMaterializationForProject(
        fixture.project.id,
        fixture.plan.id,
      ),
      [fixture.validation.id],
    );

    const validationObservation = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.validation.id,
    );
    assert.equal(validationObservation.attempt, fixture.validationAttempt.attempt + 1);
    assert.equal(validationObservation.expectedSnapshotId, drift.id);
    const secondValidationAttempt = fixture.store.workspace.createGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        ...validationObservation,
        contextPackId: null,
        sourceCommitHash: null,
        sourceTreeHash: null,
        retryContextPolicy: "same-context",
        executionMode: "full",
      },
    );
    fixture.control.set(110_000);
    const validationClaim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.validation.id,
      attempt: secondValidationAttempt.attempt,
      ownerId: "checkpoint-revalidation-worker",
      now: 110_000,
      leaseMs: 30_000,
    });
    assert.ok(validationClaim);
    fixture.control.set(110_001);
    const secondValidationResult = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        lease: validationClaim.lease,
        validation: buildGenerationTaskPrototypeValidationResult({
          task: validationClaim.task,
          attempt: validationClaim.attempt,
          snapshot: drift,
          artifactRevisions: [],
          resourceRevisions: [],
        }),
      },
    );
    assert.equal(secondValidationResult.snapshot.id, drift.id);
    assert.notEqual(secondValidationResult.evidenceHash, fixture.validationResult.evidenceHash);

    const checkpointObservation = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.checkpoint.id,
    );
    assert.equal(checkpointObservation.attempt, fixture.attempt.attempt + 1);
    assert.equal(checkpointObservation.expectedSnapshotId, drift.id);
    assert.deepEqual(checkpointObservation.dependencyOutputs, [{
      taskId: fixture.validation.id,
      resultRevisionId: null,
      resultResourceRevisionId: null,
      resultSnapshotId: drift.id,
    }]);
    const secondCheckpointAttempt = fixture.store.workspace.createGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        ...checkpointObservation,
        contextPackId: null,
        sourceCommitHash: null,
        sourceTreeHash: null,
        retryContextPolicy: "same-context",
        executionMode: "full",
      },
    );
    fixture.control.set(120_000);
    const checkpointClaim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.checkpoint.id,
      attempt: secondCheckpointAttempt.attempt,
      ownerId: "checkpoint-roundtrip-worker",
      now: 120_000,
      leaseMs: 30_000,
    });
    assert.ok(checkpointClaim);
    fixture.control.set(120_001);
    const result = checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
      fixture.project.id,
      fixture.plan.id,
      checkpointInput(checkpointClaim),
    );
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") assert.fail("freshly validated checkpoint did not publish");
    assert.equal(result.snapshot.parentSnapshotId, drift.id);
    assert.deepEqual(result.snapshot.provenance, {
      kind: "plan-checkpoint",
      proposalId: fixture.proposal.id,
      planId: fixture.plan.id,
      checkpointId: fixture.checkpoint.id,
      validatedSnapshotId: drift.id,
      validationEvidenceHash: secondValidationResult.evidenceHash,
    });

    detail = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(
      detail.tasks.find((candidate) => candidate.id === fixture.validation.id)?.currentAttempt,
      fixture.validationAttempt.attempt + 1,
    );
    assert.equal(
      detail.tasks.find((candidate) => candidate.id === fixture.checkpoint.id)?.currentAttempt,
      fixture.attempt.attempt + 1,
    );
    assert.deepEqual(
      rawRows(
        fixture.store,
        `SELECT attempt, snapshot_id FROM generation_task_validation_results
         WHERE task_id = ? ORDER BY attempt`,
        fixture.validation.id,
      ),
      [
        { attempt: fixture.validationAttempt.attempt, snapshot_id: fixture.baseSnapshot.id },
        { attempt: secondValidationAttempt.attempt, snapshot_id: drift.id },
      ],
    );
  } finally {
    fixture.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Plan cancellation preserves immutable checkpoint revalidation evidence before its fresh Attempt materializes", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-checkpoint-revalidation-cancel-"));
  const databasePath = join(directory, "workspace.db");
  const fixture = createCheckpointFixture("cancel-pending-revalidation", databasePath);
  try {
    const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const kernel = fixture.store.workspace.createKernelRevision({
      workspaceId: workspace.id,
      parentRevisionId: workspace.activeKernelRevisionId,
      tokens: { accent: "#ff0055" },
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "Cancel the fresh checkpoint validation round",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    });
    const drift = fixture.store.workspace.publishKernelRevision(kernel.id, {
      expectedKernelRevisionId: workspace.activeKernelRevisionId,
      expectedSnapshotId: workspace.activeSnapshotId,
    });
    assertCheckpointNeedsRebase(fixture, drift);
    const disposition = fixture.store.workspace.reconcileGenerationTaskNeedsRebaseForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.checkpoint.id,
    );
    assert.equal(disposition.kind, "full");

    const validationAttemptHistory = rawRows(
      fixture.store,
      `SELECT * FROM generation_task_attempts
       WHERE task_id = ? ORDER BY attempt`,
      fixture.validation.id,
    );
    const checkpointAttemptHistory = rawRows(
      fixture.store,
      `SELECT * FROM generation_task_attempts
       WHERE task_id = ? ORDER BY attempt`,
      fixture.checkpoint.id,
    );
    const validationEvidenceHistory = rawRows(
      fixture.store,
      `SELECT * FROM generation_task_validation_results
       WHERE task_id = ? ORDER BY attempt`,
      fixture.validation.id,
    );
    const snapshotCount = fixture.store.workspace.listSnapshots(fixture.project.id).length;

    fixture.control.set(130_000);
    const cancelled = fixture.store.workspace.cancelGenerationPlanForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(cancelled.plan.status, "cancelled");
    assert.equal(cancelled.plan.finishedAt, 130_000);
    const cancelledValidation = cancelled.tasks.find((task) => task.id === fixture.validation.id);
    const cancelledCheckpoint = cancelled.tasks.find((task) => task.id === fixture.checkpoint.id);
    assert.ok(cancelledValidation);
    assert.ok(cancelledCheckpoint);
    assert.equal(cancelledValidation.status, "cancelled");
    assert.equal(cancelledValidation.currentAttempt, fixture.validationAttempt.attempt);
    assert.equal(cancelledValidation.resultSnapshotId, null);
    assert.equal(cancelledCheckpoint.status, "cancelled");
    assert.equal(cancelledCheckpoint.currentAttempt, fixture.attempt.attempt);
    assert.equal(cancelledCheckpoint.resultSnapshotId, null);
    assert.equal(
      fixture.store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.validation.id,
        fixture.validationAttempt.attempt,
      )?.status,
      "succeeded",
    );
    assert.equal(
      fixture.store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.checkpoint.id,
        fixture.attempt.attempt,
      )?.status,
      "needs-rebase",
    );
    assert.deepEqual(
      rawRows(
        fixture.store,
        `SELECT * FROM generation_task_attempts
         WHERE task_id = ? ORDER BY attempt`,
        fixture.validation.id,
      ),
      validationAttemptHistory,
    );
    assert.deepEqual(
      rawRows(
        fixture.store,
        `SELECT * FROM generation_task_attempts
         WHERE task_id = ? ORDER BY attempt`,
        fixture.checkpoint.id,
      ),
      checkpointAttemptHistory,
    );
    assert.deepEqual(
      rawRows(
        fixture.store,
        `SELECT * FROM generation_task_validation_results
         WHERE task_id = ? ORDER BY attempt`,
        fixture.validation.id,
      ),
      validationEvidenceHistory,
    );
    assert.equal(
      fixture.store.workspace.getWorkspace(fixture.project.id)?.activeSnapshotId,
      drift.id,
    );
    assert.equal(fixture.store.workspace.listSnapshots(fixture.project.id).length, snapshotCount);
    assert.deepEqual(
      generationEvents(fixture, "task-cancelled")
        .filter((event) => event.taskId === fixture.validation.id
          || event.taskId === fixture.checkpoint.id)
        .map((event) => ({ taskId: event.taskId, attempt: event.payload.attempt })),
      [
        { taskId: fixture.validation.id, attempt: fixture.validationAttempt.attempt },
        { taskId: fixture.checkpoint.id, attempt: fixture.attempt.attempt },
      ],
    );
    assert.equal(generationEvents(fixture, "plan-cancel-requested").length, 1);
    assert.equal(generationEvents(fixture, "plan-cancelled").length, 1);

    const durableCancellation = durableCheckpointState(fixture);
    fixture.store.close();
    fixture.store = new Store(databasePath, fixture.control.clock);
    assert.deepEqual(
      fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      ),
      cancelled,
    );
    assert.deepEqual(
      fixture.store.workspace.cancelGenerationPlanForProject(
        fixture.project.id,
        fixture.plan.id,
      ),
      cancelled,
    );
    assert.deepEqual(durableCheckpointState(fixture), durableCancellation);
  } finally {
    fixture.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a forged cancelled checkpoint revalidation state has no cancellation authority", () => {
  const fixture = createCheckpointFixture("forged-cancelled-revalidation");
  try {
    const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const kernel = fixture.store.workspace.createKernelRevision({
      workspaceId: workspace.id,
      parentRevisionId: workspace.activeKernelRevisionId,
      tokens: { accent: "#7700ff" },
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "Forge a cancelled checkpoint validation round",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    });
    const drift = fixture.store.workspace.publishKernelRevision(kernel.id, {
      expectedKernelRevisionId: workspace.activeKernelRevisionId,
      expectedSnapshotId: workspace.activeSnapshotId,
    });
    assertCheckpointNeedsRebase(fixture, drift);
    fixture.store.workspace.reconcileGenerationTaskNeedsRebaseForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.checkpoint.id,
    );

    const forged = fixture.store.db.prepare(
      `UPDATE generation_tasks
       SET status = 'cancelled', blocked_reason = ?, blocked_by_task_id = NULL,
           pending_context_policy = NULL, failure_class = 'cancelled', error_json = ?,
           next_eligible_at = NULL, finished_at = ?
       WHERE id = ? AND status = 'materialization-pending'`,
    ).run(
      `Cancelled with Generation Plan ${fixture.plan.id}`,
      JSON.stringify({ code: "generation-plan-cancelled", planId: fixture.plan.id }),
      140_000,
      fixture.validation.id,
    );
    assert.equal(Number(forged.changes), 1);
    assert.throws(
      () => fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      ),
      /cancelled.*succeeded|checkpoint revalidation/i,
    );
  } finally {
    fixture.store.close();
  }
});

test("checkpoint revalidation authority reset is schema-fenced and transaction-atomic", () => {
  const fixture = createCheckpointFixture("revalidation-atomicity");
  try {
    const beforeForgery = durableCheckpointState(fixture);
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_tasks
         SET status = 'materialization-pending', pending_context_policy = 'same-context',
             result_snapshot_id = NULL, finished_at = NULL
         WHERE id = ?`,
      ).run(fixture.validation.id),
      /write-once/i,
    );
    assert.deepEqual(durableCheckpointState(fixture), beforeForgery);

    const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const kernel = fixture.store.workspace.createKernelRevision({
      workspaceId: workspace.id,
      parentRevisionId: workspace.activeKernelRevisionId,
      tokens: { accent: "#6633ff" },
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "Force a fresh validation round",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    });
    const drift = fixture.store.workspace.publishKernelRevision(kernel.id, {
      expectedKernelRevisionId: workspace.activeKernelRevisionId,
      expectedSnapshotId: workspace.activeSnapshotId,
    });
    assertCheckpointNeedsRebase(fixture, drift);
    fixture.store.db.exec(
      `CREATE TRIGGER reject_checkpoint_revalidation_task_move
       BEFORE UPDATE OF status ON generation_tasks
       WHEN OLD.id = '${fixture.checkpoint.id}'
         AND OLD.status = 'needs-rebase'
         AND NEW.status = 'materialization-pending'
       BEGIN
         SELECT RAISE(ABORT, 'injected checkpoint revalidation move failure');
       END`,
    );
    const beforeReconcile = durableCheckpointState(fixture);
    assert.throws(
      () => fixture.store.workspace.reconcileGenerationTaskNeedsRebaseForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.checkpoint.id,
      ),
      /injected checkpoint revalidation move failure/,
    );
    assert.deepEqual(durableCheckpointState(fixture), beforeReconcile);
  } finally {
    fixture.store.close();
  }
});

test("checkpoint publication requires the validation result and its exact terminal event", async (t) => {
  await t.test("missing immutable result", () => {
    const fixture = createCheckpointFixture("missing-validation-result");
    try {
      fixture.store.db.exec("DROP TRIGGER generation_task_validation_result_delete_history_guard");
      fixture.store.db.prepare(
        "DELETE FROM generation_task_validation_results WHERE task_id = ? AND attempt = ?",
      ).run(fixture.validation.id, fixture.validationAttempt.attempt);
      const before = durableCheckpointState(fixture);
      assert.throws(
        () => checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
          fixture.project.id,
          fixture.plan.id,
          checkpointInput(fixture.claim),
        ),
        /validation dependency result is missing/i,
      );
      assert.deepEqual(durableCheckpointState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("missing terminal event", () => {
    const fixture = createCheckpointFixture("missing-validation-event");
    try {
      fixture.store.db.exec("DROP TRIGGER generation_plan_event_delete_history_guard");
      fixture.store.db.prepare(
        `DELETE FROM generation_plan_events
         WHERE plan_id = ? AND task_id = ? AND type = 'task-succeeded'`,
      ).run(fixture.plan.id, fixture.validation.id);
      const before = durableCheckpointState(fixture);
      assert.throws(
        () => checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
          fixture.project.id,
          fixture.plan.id,
          checkpointInput(fixture.claim),
        ),
        /validation terminal event is missing or ambiguous/i,
      );
      assert.deepEqual(durableCheckpointState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("either terminal event failure rolls back Snapshot, task, Plan, claim, and event writes", async (t) => {
  for (const type of ["task-succeeded", "plan-succeeded"] as const) {
    await t.test(type, () => {
      const fixture = createCheckpointFixture(`reject-${type}`);
      try {
        fixture.store.db.exec(
          `CREATE TRIGGER reject_checkpoint_${type.replace("-", "_")}
           BEFORE INSERT ON generation_plan_events
           WHEN NEW.type = '${type}'
           BEGIN
             SELECT RAISE(ABORT, 'injected checkpoint ${type} failure');
           END`,
        );
        const before = durableCheckpointState(fixture);
        assert.throws(
          () => checkpointApi(fixture.store).publishGenerationPlanCheckpointForProject(
            fixture.project.id,
            fixture.plan.id,
            checkpointInput(fixture.claim),
          ),
          new RegExp(`injected checkpoint ${type} failure`),
        );
        assert.deepEqual(durableCheckpointState(fixture), before);
      } finally {
        fixture.store.close();
      }
    });
  }
});

test("an exact lost-response replay is read-only while stale leases and foreign routes stay rejected", () => {
  const fixture = createCheckpointFixture("replay");
  try {
    const api = checkpointApi(fixture.store);
    const input = checkpointInput(fixture.claim);
    const first = api.publishGenerationPlanCheckpointForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    const afterFirst = durableCheckpointState(fixture);
    const replay = api.publishGenerationPlanCheckpointForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    assert.deepEqual(replay, first);
    assert.deepEqual(durableCheckpointState(fixture), afterFirst);
    assert.equal(
      generationEvents(fixture, "task-succeeded")
        .filter((event) => event.taskId === fixture.checkpoint.id).length,
      1,
    );
    assert.equal(generationEvents(fixture, "plan-succeeded").length, 1);

    assert.throws(
      () => api.publishGenerationPlanCheckpointForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          lease: {
            ...fixture.claim.lease,
            leaseToken: `${fixture.claim.lease.leaseToken}-stale`,
          },
        },
      ),
      (error) => error instanceof GenerationTaskLeaseFenceError,
    );
    assert.deepEqual(durableCheckpointState(fixture), afterFirst);

    const foreign = fixture.store.createProject({ name: "Foreign checkpoint replay route", mode: "standard" });
    fixture.store.workspace.ensureWorkspaceRecord(foreign.id);
    const beforeForeignRoute = durableCheckpointState(fixture);
    assert.throws(
      () => api.publishGenerationPlanCheckpointForProject(
        foreign.id,
        fixture.plan.id,
        input,
      ),
      /ownership|Project|route|Plan/i,
    );
    assert.deepEqual(durableCheckpointState(fixture), beforeForeignRoute);
  } finally {
    fixture.store.close();
  }
});
