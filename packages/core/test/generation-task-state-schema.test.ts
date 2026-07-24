import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Store,
  type CompleteGenerationTaskValidationInput,
  type GenerationTaskAttemptLease,
  type StoreClock,
} from "../src/index.ts";

function controlledClock(label: string): { clock: StoreClock; set(value: number): void } {
  let now = 100_000;
  let sequence = 0;
  return {
    clock: {
      now: () => now,
      id: () => `${label}-${++sequence}`,
    },
    set(value: number) {
      now = value;
    },
  };
}

function emptyGeneration() {
  return {
    kind: "workspace-generation" as const,
    agent: { providerId: "codebuddy" as const, command: "codebuddy" as const, model: "gpt-5.6-sol" },
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

function createQueuedValidation(label: string) {
  const control = controlledClock(`generation-state-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Generation state ${label}`, mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
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
    rationale: "Exercise the durable Generation Task state machine",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const task = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation");
  assert.ok(task);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    task.id,
  );
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
    ...observation,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  const snapshot = store.workspace.listSnapshots(project.id)
    .find((candidate) => candidate.id === attempt.expectedSnapshotId);
  assert.ok(snapshot);
  return { attempt, compiled, control, project, snapshot, store, task, workspace };
}

function validationInput(
  fixture: ReturnType<typeof createQueuedValidation>,
  lease: GenerationTaskAttemptLease,
): CompleteGenerationTaskValidationInput {
  return {
    lease,
    validation: {
      snapshotId: fixture.snapshot.id,
      graphRevision: fixture.snapshot.graphRevision,
      artifactRevisionIds: [],
      resourceRevisionIds: [],
      evidence: {
        protocol: "dezin-prototype-validation-v1",
        snapshot: {
          id: fixture.snapshot.id,
          graphRevision: fixture.snapshot.graphRevision,
          kernelRevisionId: fixture.snapshot.kernelRevisionId,
        },
        dependencies: [],
        artifacts: [],
        resources: [],
        prototypeEdges: [],
        frames: [],
      },
    },
  };
}

test("raw SQL cannot skip queued/running authority or forge Generation Task success", () => {
  const fixture = createQueuedValidation("success-fence");
  try {
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_task_attempts
         SET status = 'succeeded', started_at = 100001, finished_at = 100002
         WHERE task_id = ? AND attempt = ?`,
      ).run(fixture.task.id, fixture.attempt.attempt),
      /attempt|transition|success|authority|state/i,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_tasks
         SET status = 'succeeded', result_snapshot_id = ?, finished_at = 100002
         WHERE id = ?`,
      ).run(fixture.snapshot.id, fixture.task.id),
      /task|transition|attempt|success|state/i,
    );

    const claim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.task.id,
      attempt: fixture.attempt.attempt,
      ownerId: "state-worker",
      now: 100_010,
      leaseMs: 30_000,
    });
    assert.ok(claim);
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_task_attempts
         SET status = 'succeeded', owner_id = NULL, lease_token = NULL,
             lease_expires_at = NULL, heartbeat_at = NULL, finished_at = 100011
         WHERE task_id = ? AND attempt = ?`,
      ).run(fixture.task.id, fixture.attempt.attempt),
      /validation|success|authority|attempt|state/i,
      "a live lease alone must not authorize a Validation success",
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_tasks
         SET status = 'succeeded', result_snapshot_id = ?, finished_at = 100011
         WHERE id = ?`,
      ).run(fixture.snapshot.id, fixture.task.id),
      /attempt|success|authority|task|state/i,
    );

    fixture.control.set(100_011);
    const completed = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.compiled.plan.id,
      validationInput(fixture, claim.lease),
    );
    assert.equal(completed.task.status, "succeeded");
    assert.equal(completed.attempt.status, "succeeded");

    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_task_attempts
         SET status = 'running', owner_id = 'rollback-worker', lease_token = 'rollback-lease',
             lease_expires_at = 200000, heartbeat_at = 100012, finished_at = NULL
         WHERE task_id = ? AND attempt = ?`,
      ).run(fixture.task.id, fixture.attempt.attempt),
      /terminal|transition|attempt|state|immutable/i,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_tasks
         SET status = 'running', result_snapshot_id = NULL, finished_at = NULL
         WHERE id = ?`,
      ).run(fixture.task.id),
      /terminal|transition|result|task|state|write-once/i,
    );
  } finally {
    fixture.store.close();
  }
});

test("raw SQL cannot split candidate, terminal, lease, and current-Attempt shape", () => {
  const fixture = createQueuedValidation("shape-fence");
  try {
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_task_attempts
         SET status = 'candidate-ready', candidate_evidence_json = '{}',
             candidate_evidence_hash = ?
         WHERE task_id = ? AND attempt = ?`,
      ).run("a".repeat(64), fixture.task.id, fixture.attempt.attempt),
      /candidate|attempt|transition|state|shape/i,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_task_attempts SET finished_at = 100001
         WHERE task_id = ? AND attempt = ?`,
      ).run(fixture.task.id, fixture.attempt.attempt),
      /attempt|finished|state|shape/i,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_tasks
         SET status = 'failed', failure_class = 'design', error_json = '{}', finished_at = 100001
         WHERE id = ?`,
      ).run(fixture.task.id),
      /failure|journal|attempt|task|state|transition/i,
      "materialization failure must be backed by its immutable journal",
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_tasks SET current_attempt = 0 WHERE id = ?`,
      ).run(fixture.task.id),
      /current attempt|successor|attempt|state shape/i,
    );

    const claim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.task.id,
      attempt: fixture.attempt.attempt,
      ownerId: "shape-worker",
      now: 100_010,
      leaseMs: 30_000,
    });
    assert.ok(claim);
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_task_attempts
         SET candidate_evidence_json = '{}', candidate_evidence_hash = ?
         WHERE task_id = ? AND attempt = ?`,
      ).run("b".repeat(64), fixture.task.id, fixture.attempt.attempt),
      /candidate|attempt|state|shape/i,
      "a full running Attempt cannot carry candidate evidence before candidate-ready",
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_tasks SET status = 'candidate-ready' WHERE id = ?`,
      ).run(fixture.task.id),
      /candidate|attempt|task|state|shape/i,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        `UPDATE generation_task_attempts SET lease_token = 'foreign-lease'
         WHERE task_id = ? AND attempt = ?`,
      ).run(fixture.task.id, fixture.attempt.attempt),
      /lease|fence|attempt/i,
    );
  } finally {
    fixture.store.close();
  }
});
