import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  generationTaskArtifactCandidateRetentionRef,
  GenerationTaskLeaseFenceError,
  GenerationTaskQualityGateError,
  Store,
  type GenerationPlanEvent,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptLease,
  type StageGenerationTaskCandidateResult,
  type StoreClock,
} from "../src/index.ts";

interface PublishGenerationTaskCandidateInput {
  lease: GenerationTaskAttemptLease;
}

interface GenerationTaskCandidatePublicationStoreContract {
  publishGenerationTaskCandidateForProject(
    projectId: string,
    planId: string,
    input: PublishGenerationTaskCandidateInput,
  ): unknown;
}

interface ControlledClock {
  clock: StoreClock;
  set(now: number): void;
}

function publicationApi(store: Store): GenerationTaskCandidatePublicationStoreContract {
  return store.workspace as unknown as GenerationTaskCandidatePublicationStoreContract;
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
    responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function createPublicationFixture(label: string) {
  const control = controlledClock(`candidate-publication-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Candidate publication ${label}`, mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const artifactId = `publication-page-${label}`;
  const trackId = `publication-page-track-${label}`;
  const nodeId = `publication-page-node-${label}`;
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [{
      id: `add-publication-page-${label}`,
      type: "add-node",
      node: {
        id: nodeId,
        kind: "page",
        name: "Generated publication page",
        artifactId,
        createIdentity: { initialTrackId: trackId },
      },
    }],
  });
  const withArtifact = store.workspace.getWorkspace(project.id)!;
  const baseRevision = store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash: checksum(`${label}:base-commit`),
    sourceTreeHash: checksum(`${label}:base-tree`),
    kernelRevisionId: withArtifact.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const baseSnapshot = store.workspace.publishArtifactRevision(baseRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
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
    generation: {
      ...emptyGeneration(),
      artifactPlans: [{
        operation: "revise",
        nodeId,
        artifactId,
        kind: "page",
        name: "Generated publication page",
        trackId,
        baseRevisionId: baseRevision.id,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      }],
    },
    rationale: "Publish an immutable generated Page candidate",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const task = compiled.tasks.find((candidate) => candidate.kind === "page");
  assert.ok(task);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    task.id,
  );
  assert.equal(observation.baseRevisionId, baseRevision.id);
  assert.equal(observation.expectedSnapshotId, baseSnapshot.id);
  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  assert.ok(kernel);
  const baseRevisionChecksum = store.workspace.getArtifactRevisionContextChecksum(baseRevision.id);
  assert.ok(baseRevisionChecksum);
  const contextHash = checksum(`${label}:context-pack`);
  const context = store.workspace.persistContextPack({
    id: `context-pack-${contextHash}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "artifact", id: artifactId },
    intent: "generate",
    messageChecksum: checksum(`${label}:message`),
    items: [
      {
        ref: { kind: "kernel", id: kernel.id, revisionId: kernel.id },
        resolvedKind: "kernel-revision",
        kernelRevisionId: kernel.id,
        checksum: kernel.checksum,
        reason: "design-kernel",
        trustLevel: "system",
        boundary: {},
        tokenEstimate: 1,
        provenance: {},
        provided: true,
      },
      {
        ref: { kind: "artifact", id: artifactId, revisionId: baseRevision.id },
        resolvedKind: "artifact-revision",
        artifactRevisionId: baseRevision.id,
        checksum: baseRevisionChecksum,
        reason: "target-base",
        trustLevel: "trusted",
        boundary: {},
        tokenEstimate: 1,
        provenance: {},
        provided: true,
      },
    ],
    omissions: [],
    tokenEstimate: 2,
    manifestPath: `context-packs/candidate-publication-${label}.json`,
    hash: contextHash,
  });
  const attempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...observation,
      contextPackId: context.id,
      sourceCommitHash: baseRevision.sourceCommitHash,
      sourceTreeHash: baseRevision.sourceTreeHash,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `candidate-publication-worker-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  control.set(100_001);
  const candidate = {
    kind: "artifact" as const,
    sourceCommitHash: checksum(`${label}:candidate-commit`),
    sourceTreeHash: checksum(`${label}:candidate-tree`),
    renderSpec: {
      frames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    },
    quality: { state: "passed", score: 98, findings: [] },
  };
  const qualityEvidence = {
    protocol: "dezin.standard-artifact-quality.v1",
    candidate: {
      commitHash: candidate.sourceCommitHash,
      treeHash: candidate.sourceTreeHash,
    },
    contextPack: { id: context.id, hash: context.hash },
    frames: candidate.renderSpec.frames,
    frameResults: [],
    round: 0,
  };
  const evidence = {
    protocol: "dezin.artifact-run.v1",
    projectId: project.id,
    taskId: task.id,
    planId: task.planId,
    workspaceId: task.workspaceId,
    attempt: attempt.attempt,
    attemptCreatedAt: attempt.createdAt,
    inputHash: attempt.inputHash,
    contextPackId: context.id,
    contextPackHash: context.hash,
    sourceBase: {
      commitHash: attempt.sourceCommitHash,
      treeHash: attempt.sourceTreeHash,
    },
    candidateRetentionRef: generationTaskArtifactCandidateRetentionRef(attempt),
    selectedRound: 0,
    versions: [{
      round: 0,
      commitHash: candidate.sourceCommitHash,
      treeHash: candidate.sourceTreeHash,
      passed: true,
      score: candidate.quality.score,
    }],
    qualityEvidence,
  };
  const staged = store.workspace.stageGenerationTaskCandidateForProject(
    project.id,
    compiled.plan.id,
    { lease: claim.lease, candidate, evidence },
  );
  assert.equal(staged.attempt.status, "candidate-ready");

  return {
    control,
    store,
    project,
    workspace,
    plan: compiled.plan,
    task,
    attempt,
    claim,
    staged,
    evidence,
    artifactId,
    trackId,
    nodeId,
    baseRevision,
    baseSnapshot,
  };
}

type PublicationFixture = ReturnType<typeof createPublicationFixture>;

function publicationInput(fixture: PublicationFixture): PublishGenerationTaskCandidateInput {
  return { lease: fixture.claim.lease };
}

function durablePublicationState(fixture: PublicationFixture) {
  const { store } = fixture;
  return {
    workspace: store.db.prepare(
      "SELECT * FROM project_workspaces WHERE id = ?",
    ).get(fixture.workspace.id),
    plan: store.db.prepare(
      "SELECT * FROM generation_plans WHERE id = ?",
    ).get(fixture.plan.id),
    task: store.db.prepare(
      "SELECT * FROM generation_tasks WHERE id = ? AND plan_id = ?",
    ).get(fixture.task.id, fixture.plan.id),
    attempts: store.db.prepare(
      "SELECT * FROM generation_task_attempts WHERE task_id = ? ORDER BY attempt",
    ).all(fixture.task.id),
    claims: store.db.prepare(
      "SELECT * FROM generation_task_claims WHERE task_id = ? ORDER BY claim_key",
    ).all(fixture.task.id),
    events: store.db.prepare(
      "SELECT * FROM generation_plan_events WHERE plan_id = ? ORDER BY sequence",
    ).all(fixture.plan.id),
    track: store.db.prepare(
      "SELECT * FROM artifact_tracks WHERE id = ?",
    ).get(fixture.trackId),
    revisions: store.db.prepare(
      "SELECT * FROM artifact_revisions WHERE artifact_id = ? ORDER BY sequence",
    ).all(fixture.artifactId),
    snapshots: store.db.prepare(
      "SELECT * FROM workspace_snapshots WHERE workspace_id = ? ORDER BY sequence",
    ).all(fixture.workspace.id),
    snapshotArtifacts: store.db.prepare(
      `SELECT * FROM workspace_snapshot_artifacts
       WHERE workspace_id = ? ORDER BY snapshot_id, artifact_id`,
    ).all(fixture.workspace.id),
    graphRevisions: store.db.prepare(
      "SELECT * FROM workspace_graph_revisions WHERE workspace_id = ? ORDER BY revision",
    ).all(fixture.workspace.id),
  };
}

function currentTaskAndAttempt(fixture: PublicationFixture): {
  task: GenerationTask;
  attempt: GenerationTaskAttempt;
} {
  const task = fixture.store.workspace.getGenerationPlanDetailForProject(
    fixture.project.id,
    fixture.plan.id,
  ).tasks.find((candidate) => candidate.id === fixture.task.id);
  assert.ok(task);
  const attempt = fixture.store.workspace.getGenerationTaskAttemptForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.task.id,
    task.currentAttempt,
  );
  assert.ok(attempt);
  return { task, attempt };
}

function taskEvents(fixture: PublicationFixture, type: GenerationPlanEvent["type"]): GenerationPlanEvent[] {
  return fixture.store.workspace.listGenerationPlanEventsForProject(
    fixture.project.id,
    fixture.plan.id,
    { after: 0, limit: 1_000 },
  ).filter((event) => event.taskId === fixture.task.id && event.type === type);
}

function assertClaimsReleased(fixture: PublicationFixture): void {
  assert.deepEqual(
    fixture.store.db.prepare(
      "SELECT * FROM generation_task_claims WHERE task_id = ? ORDER BY claim_key",
    ).all(fixture.task.id),
    [],
  );
}

function assertCandidateRetained(
  staged: StageGenerationTaskCandidateResult,
  attempt: GenerationTaskAttempt,
): void {
  assert.equal(attempt.candidateRevisionId, staged.artifactRevision.id);
  assert.equal(attempt.candidateResourceRevisionId, null);
  assert.deepEqual(attempt.candidateEvidence, staged.attempt.candidateEvidence);
  assert.equal(attempt.candidateEvidenceHash, staged.attempt.candidateEvidenceHash);
}

function driftSnapshotOnly(fixture: PublicationFixture) {
  const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
  const drift = fixture.store.workspace.applyGraphCommands(fixture.project.id, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: `rename-while-candidate-waits-${fixture.task.id}`,
      type: "rename-node",
      nodeId: fixture.nodeId,
      name: "Page renamed while candidate waits",
    }],
  });
  assert.equal(fixture.store.workspace.getTrack(fixture.trackId)?.headRevisionId, fixture.baseRevision.id);
  return drift.snapshot;
}

function driftArtifactHead(fixture: PublicationFixture, label: string) {
  const competing = fixture.store.workspace.createArtifactRevision({
    artifactId: fixture.artifactId,
    trackId: fixture.trackId,
    parentRevisionId: fixture.baseRevision.id,
    sourceCommitHash: checksum(`${label}:competing-commit`),
    sourceTreeHash: checksum(`${label}:competing-tree`),
    kernelRevisionId: fixture.staged.attempt.kernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 96, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const snapshot = fixture.store.workspace.publishArtifactRevision(competing.id, {
    expectedHeadRevisionId: fixture.baseRevision.id,
    expectedSnapshotId: fixture.staged.attempt.expectedSnapshotId,
  });
  return { competing, snapshot };
}

function assertNeedsRebase(
  fixture: PublicationFixture,
  conflict: {
    pointer: "artifact-head" | "active-snapshot";
    expectedId: string;
    actualId: string;
  },
): void {
  const { task, attempt } = currentTaskAndAttempt(fixture);
  assert.equal(task.status, "needs-rebase");
  assert.equal(attempt.status, "needs-rebase");
  assert.equal(task.failureClass, "publication-conflict");
  assert.equal(attempt.failureClass, "publication-conflict");
  assert.deepEqual(task.error, attempt.error);
  assert.equal(attempt.error?.pointer, conflict.pointer);
  assert.equal(attempt.error?.expectedId, conflict.expectedId);
  assert.equal(attempt.error?.actualId, conflict.actualId);
  assert.equal(typeof attempt.error?.code, "string");
  assertCandidateRetained(fixture.staged, attempt);
  assert.equal(task.resultRevisionId, null);
  assert.equal(task.resultResourceRevisionId, null);
  assert.equal(task.resultSnapshotId, null);
  assert.equal(attempt.lease, null);
  assert.equal(attempt.leaseExpiresAt, null);
  assert.equal(attempt.heartbeatAt, null);
  assert.ok(attempt.finishedAt !== null);
  assertClaimsReleased(fixture);

  const events = taskEvents(fixture, "task-needs-rebase");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.attempt, attempt.attempt);
  assert.equal(events[0]?.payload.pointer, conflict.pointer);
  assert.equal(events[0]?.payload.expectedId, conflict.expectedId);
  assert.equal(events[0]?.payload.actualId, conflict.actualId);
  assert.equal(events[0]?.payload.candidateRevisionId, fixture.staged.artifactRevision.id);
  assert.equal(events[0]?.payload.candidateResourceRevisionId, null);
  assert.equal(events[0]?.payload.candidateEvidenceHash, fixture.staged.attempt.candidateEvidenceHash);
  assert.equal(taskEvents(fixture, "task-succeeded").length, 0);
}

test("publishing a recorded Artifact candidate atomically moves Head and active Snapshot", () => {
  const fixture = createPublicationFixture("success");
  try {
    const before = durablePublicationState(fixture);
    publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      publicationInput(fixture),
    );

    const { task, attempt } = currentTaskAndAttempt(fixture);
    assert.equal(task.status, "succeeded");
    assert.equal(attempt.status, "succeeded");
    assert.equal(task.resultRevisionId, fixture.staged.artifactRevision.id);
    assert.equal(task.resultResourceRevisionId, null);
    assert.ok(task.resultSnapshotId);
    assert.equal(attempt.failureClass, null);
    assert.equal(attempt.error, null);
    assertCandidateRetained(fixture.staged, attempt);
    assert.equal(attempt.lease, null);
    assert.equal(attempt.leaseExpiresAt, null);
    assert.equal(attempt.heartbeatAt, null);
    assert.ok(attempt.finishedAt !== null);
    assert.equal(task.finishedAt, attempt.finishedAt);
    assertClaimsReleased(fixture);

    const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const track = fixture.store.workspace.getTrack(fixture.trackId);
    assert.ok(track);
    assert.equal(track.headRevisionId, fixture.staged.artifactRevision.id);
    assert.equal(workspace.activeSnapshotId, task.resultSnapshotId);
    const snapshots = fixture.store.workspace.listSnapshots(fixture.project.id);
    const published = snapshots.find((snapshot) => snapshot.id === task.resultSnapshotId);
    assert.ok(published);
    assert.equal(published.parentSnapshotId, fixture.staged.attempt.expectedSnapshotId);
    assert.equal(published.reason, "artifact-published");
    assert.deepEqual(published.provenance, {
      kind: "artifact-publication",
      revisionId: fixture.staged.artifactRevision.id,
      planId: fixture.plan.id,
      taskId: fixture.task.id,
    });
    assert.equal(published.artifactTracks[fixture.artifactId], fixture.trackId);
    assert.equal(published.artifactRevisions[fixture.artifactId], fixture.staged.artifactRevision.id);

    const after = durablePublicationState(fixture);
    assert.equal(after.revisions.length, before.revisions.length, "publication must reuse the staged Revision");
    assert.equal(after.snapshots.length, before.snapshots.length + 1);
    assert.equal(taskEvents(fixture, "task-candidate-ready").length, 1);
    const successEvents = taskEvents(fixture, "task-succeeded");
    assert.equal(successEvents.length, 1);
    assert.equal(successEvents[0]?.payload.attempt, attempt.attempt);
    assert.equal(successEvents[0]?.payload.resultRevisionId, fixture.staged.artifactRevision.id);
    assert.equal(successEvents[0]?.payload.resultResourceRevisionId, null);
    assert.equal(successEvents[0]?.payload.resultSnapshotId, published.id);
    assert.equal(successEvents[0]?.payload.candidateEvidenceHash, fixture.staged.attempt.candidateEvidenceHash);
  } finally {
    fixture.store.close();
  }
});

test("publication revalidates persisted candidate quality before moving any pointer", () => {
  const fixture = createPublicationFixture("quality-revalidation");
  try {
    fixture.store.db.exec("DROP TRIGGER artifact_revision_update_immutable");
    fixture.store.db.prepare(
      "UPDATE artifact_revisions SET quality_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({ state: "failed", score: 0, findings: [] }),
      fixture.staged.artifactRevision.id,
    );
    const before = durablePublicationState(fixture);

    assert.throws(
      () => publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        publicationInput(fixture),
      ),
      (error) => error instanceof GenerationTaskQualityGateError,
    );
    assert.deepEqual(durablePublicationState(fixture), before);
  } finally {
    fixture.store.close();
  }
});

test("Head or Snapshot CAS drift preserves the candidate and records one needs-rebase outcome", async (t) => {
  await t.test("snapshot-only drift", () => {
    const fixture = createPublicationFixture("snapshot-drift");
    try {
      const drift = driftSnapshotOnly(fixture);
      const before = durablePublicationState(fixture);
      publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        publicationInput(fixture),
      );

      const after = durablePublicationState(fixture);
      assert.equal(after.snapshots.length, before.snapshots.length);
      assert.equal(fixture.store.workspace.getWorkspace(fixture.project.id)?.activeSnapshotId, drift.id);
      assert.equal(fixture.store.workspace.getTrack(fixture.trackId)?.headRevisionId, fixture.baseRevision.id);
      assertNeedsRebase(fixture, {
        pointer: "active-snapshot",
        expectedId: fixture.staged.attempt.expectedSnapshotId,
        actualId: drift.id,
      });
    } finally {
      fixture.store.close();
    }
  });

  await t.test("target Head drift", () => {
    const fixture = createPublicationFixture("head-drift");
    try {
      const drift = driftArtifactHead(fixture, "head-drift");
      const before = durablePublicationState(fixture);
      publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        publicationInput(fixture),
      );

      const after = durablePublicationState(fixture);
      assert.equal(after.snapshots.length, before.snapshots.length);
      assert.equal(fixture.store.workspace.getWorkspace(fixture.project.id)?.activeSnapshotId, drift.snapshot.id);
      assert.equal(fixture.store.workspace.getTrack(fixture.trackId)?.headRevisionId, drift.competing.id);
      assertNeedsRebase(fixture, {
        pointer: "artifact-head",
        expectedId: fixture.baseRevision.id,
        actualId: drift.competing.id,
      });
    } finally {
      fixture.store.close();
    }
  });
});

test("wrong, expired, stale, and incomplete claim fences make publication a zero-write rejection", async (t) => {
  await t.test("wrong lease token", () => {
    const fixture = createPublicationFixture("wrong-token");
    try {
      const before = durablePublicationState(fixture);
      assert.throws(
        () => publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
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
      assert.deepEqual(durablePublicationState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("expired current lease", () => {
    const fixture = createPublicationFixture("expired-token");
    try {
      assert.ok(fixture.staged.attempt.leaseExpiresAt);
      fixture.control.set(fixture.staged.attempt.leaseExpiresAt);
      const before = durablePublicationState(fixture);
      assert.throws(
        () => publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durablePublicationState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("stale predecessor lease after recovery and takeover", () => {
    const fixture = createPublicationFixture("stale-token");
    try {
      assert.ok(fixture.staged.attempt.leaseExpiresAt);
      fixture.control.set(fixture.staged.attempt.leaseExpiresAt);
      fixture.store.workspace.recoverExpiredGenerationTaskAttempts(
        fixture.staged.attempt.leaseExpiresAt,
      );
      const recoveredTask = fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      ).tasks.find((candidate) => candidate.id === fixture.task.id);
      assert.ok(recoveredTask);
      const successor = fixture.store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.task.id,
        recoveredTask.currentAttempt,
      );
      assert.ok(successor);
      assert.equal(successor.executionMode, "publication-only");
      assert.ok(recoveredTask.nextEligibleAt);
      const replacement = fixture.store.workspace.tryClaimGenerationTaskAttempt({
        taskId: fixture.task.id,
        attempt: successor.attempt,
        ownerId: "replacement-publication-worker",
        now: recoveredTask.nextEligibleAt,
        leaseMs: 30_000,
      });
      assert.ok(replacement);
      fixture.control.set(recoveredTask.nextEligibleAt + 1);
      const before = durablePublicationState(fixture);
      assert.throws(
        () => publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durablePublicationState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("missing required claim", () => {
    const fixture = createPublicationFixture("missing-claim");
    try {
      fixture.store.db.exec("DROP TRIGGER generation_task_claim_delete_live_guard");
      const deleted = fixture.store.db.prepare(
        `DELETE FROM generation_task_claims
         WHERE claim_key = (
           SELECT claim_key FROM generation_task_claims
           WHERE task_id = ? ORDER BY claim_key LIMIT 1
         )`,
      ).run(fixture.task.id);
      assert.equal(Number(deleted.changes), 1);
      const before = durablePublicationState(fixture);
      assert.throws(
        () => publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        /claim|lease|fence/i,
      );
      assert.deepEqual(durablePublicationState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("a failed terminal event append rolls back publication and conflict transitions", async (t) => {
  await t.test("task-succeeded event failure", () => {
    const fixture = createPublicationFixture("success-event-rollback");
    try {
      fixture.store.db.exec(
        `CREATE TRIGGER reject_generation_task_success_event
         BEFORE INSERT ON generation_plan_events
         WHEN NEW.type = 'task-succeeded'
         BEGIN
           SELECT RAISE(ABORT, 'injected task-succeeded event failure');
         END`,
      );
      const before = durablePublicationState(fixture);
      assert.throws(
        () => publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        /injected task-succeeded event failure/,
      );
      assert.deepEqual(durablePublicationState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("task-needs-rebase event failure", () => {
    const fixture = createPublicationFixture("rebase-event-rollback");
    try {
      driftSnapshotOnly(fixture);
      fixture.store.db.exec(
        `CREATE TRIGGER reject_generation_task_rebase_event
         BEFORE INSERT ON generation_plan_events
         WHEN NEW.type = 'task-needs-rebase'
         BEGIN
           SELECT RAISE(ABORT, 'injected task-needs-rebase event failure');
         END`,
      );
      const before = durablePublicationState(fixture);
      assert.throws(
        () => publicationApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        /injected task-needs-rebase event failure/,
      );
      assert.deepEqual(durablePublicationState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("an exact lost-response replay does not append another Snapshot or success event", () => {
  const fixture = createPublicationFixture("replay");
  try {
    const api = publicationApi(fixture.store);
    const input = publicationInput(fixture);
    const first = api.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    const afterFirst = durablePublicationState(fixture);
    const replay = api.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );

    assert.deepEqual(replay, first);
    assert.deepEqual(durablePublicationState(fixture), afterFirst);
    assert.equal(taskEvents(fixture, "task-succeeded").length, 1);
  } finally {
    fixture.store.close();
  }
});

test("a claimed publication-only successor reuses the staged candidate after lease recovery", () => {
  const fixture = createPublicationFixture("publication-retry");
  try {
    assert.ok(fixture.staged.attempt.leaseExpiresAt);
    fixture.control.set(fixture.staged.attempt.leaseExpiresAt);
    fixture.store.workspace.recoverExpiredGenerationTaskAttempts(
      fixture.staged.attempt.leaseExpiresAt,
    );
    const recoveredTask = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id);
    assert.ok(recoveredTask);
    assert.ok(recoveredTask.nextEligibleAt);
    const successor = fixture.store.workspace.getGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      recoveredTask.currentAttempt,
    );
    assert.ok(successor);
    assert.equal(successor.executionMode, "publication-only");
    assert.equal(successor.candidateRevisionId, fixture.staged.artifactRevision.id);
    const replacement = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.task.id,
      attempt: successor.attempt,
      ownerId: "publication-retry-worker",
      now: recoveredTask.nextEligibleAt,
      leaseMs: 30_000,
    });
    assert.ok(replacement);
    fixture.control.set(recoveredTask.nextEligibleAt + 1);
    const beforeRevisionCount = Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id = ?",
    ).get(fixture.artifactId) as { count: number }).count);

    const result = fixture.store.workspace.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      { lease: replacement.lease },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.artifactRevision.id, fixture.staged.artifactRevision.id);
    assert.equal(
      Number((fixture.store.db.prepare(
        "SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id = ?",
      ).get(fixture.artifactId) as { count: number }).count),
      beforeRevisionCount,
    );
    assert.equal(taskEvents(fixture, "task-succeeded").length, 1);
  } finally {
    fixture.store.close();
  }
});

test("multiple publication-only lease takeovers retain one original candidate provenance chain", () => {
  const fixture = createPublicationFixture("publication-retry-chain");
  try {
    assert.ok(fixture.staged.attempt.leaseExpiresAt);
    fixture.control.set(fixture.staged.attempt.leaseExpiresAt);
    fixture.store.workspace.recoverExpiredGenerationTaskAttempts(fixture.staged.attempt.leaseExpiresAt);
    let task = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id);
    assert.ok(task?.nextEligibleAt);
    const firstReplacement = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.task.id,
      attempt: task.currentAttempt,
      ownerId: "publication-retry-chain-worker-1",
      now: task.nextEligibleAt,
      leaseMs: 30_000,
    });
    assert.ok(firstReplacement?.attempt.leaseExpiresAt);

    fixture.control.set(firstReplacement.attempt.leaseExpiresAt);
    fixture.store.workspace.recoverExpiredGenerationTaskAttempts(firstReplacement.attempt.leaseExpiresAt);
    task = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id);
    assert.ok(task?.nextEligibleAt);
    const secondReplacement = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.task.id,
      attempt: task.currentAttempt,
      ownerId: "publication-retry-chain-worker-2",
      now: task.nextEligibleAt,
      leaseMs: 30_000,
    });
    assert.ok(secondReplacement);
    assert.equal(secondReplacement.attempt.executionMode, "publication-only");
    assert.equal(secondReplacement.attempt.attemptOrigin, "publication-retry");
    assert.equal(secondReplacement.attempt.predecessorAttempt, firstReplacement.attempt.attempt);
    assert.equal(secondReplacement.attempt.candidateRevisionId, fixture.staged.artifactRevision.id);
    fixture.control.set(task.nextEligibleAt + 1);

    const result = fixture.store.workspace.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      { lease: secondReplacement.lease },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.artifactRevision.id, fixture.staged.artifactRevision.id);
    assert.equal(taskEvents(fixture, "task-succeeded").length, 1);
    assert.equal(
      Number((fixture.store.db.prepare(
        "SELECT COUNT(*) AS count FROM artifact_revisions WHERE artifact_id = ?",
      ).get(fixture.artifactId) as { count: number }).count),
      2,
      "the base and one immutable candidate are the only Artifact Revisions",
    );
  } finally {
    fixture.store.close();
  }
});
