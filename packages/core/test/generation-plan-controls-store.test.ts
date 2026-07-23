import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  GenerationTaskMaterializationConflictError,
  generationTaskArtifactCandidateRetentionRef,
  Store,
  type GenerationTask,
  type GenerationTaskAttemptClaim,
  type RenderFrameSpec,
  type StoreClock,
} from "../src/index.ts";

interface ControlledClock {
  clock: StoreClock;
  set(now: number): void;
}

function controlledClock(label: string): ControlledClock {
  let now = 40_000;
  let id = 0;
  return {
    clock: {
      now: () => now,
      id: () => `${label}-${++id}`,
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

function createControlFixture(label: string, database = ":memory:") {
  const control = controlledClock(`plan-control-${label}`);
  const store = new Store(database, control.clock);
  const project = store.createProject({ name: `Plan controls ${label}`, mode: "standard" });
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
    rationale: `Exercise durable Plan controls ${label}`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const detail = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const validation = detail.tasks.find((task) => task.kind === "prototype-validation");
  const checkpoint = detail.tasks.find((task) => task.kind === "checkpoint");
  assert.ok(validation);
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.dependencyIds, [validation.id]);
  return { control, store, project, workspace, plan: detail.plan, validation, checkpoint };
}

function createDiamondRetryFixture(label: string) {
  const control = controlledClock(`plan-diamond-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Plan diamond ${label}`, mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const artifacts = {
    a: {
      artifactId: `diamond-a-${label}`,
      nodeId: `diamond-node-a-${label}`,
      trackId: `diamond-track-a-${label}`,
      name: "Diamond root A",
    },
    b: {
      artifactId: `diamond-b-${label}`,
      nodeId: `diamond-node-b-${label}`,
      trackId: `diamond-track-b-${label}`,
      name: "Diamond root B",
    },
    sibling: {
      artifactId: `diamond-sibling-${label}`,
      nodeId: `diamond-node-sibling-${label}`,
      trackId: `diamond-track-sibling-${label}`,
      name: "Successful sibling",
    },
  } as const;
  const artifactValues = Object.values(artifacts);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: artifactValues.map((artifact) => ({
      id: `add-${artifact.nodeId}`,
      type: "add-node" as const,
      node: {
        id: artifact.nodeId,
        kind: "page" as const,
        name: artifact.name,
        artifactId: artifact.artifactId,
        createIdentity: { initialTrackId: artifact.trackId },
      },
    })),
    layoutOperations: [],
    generation: {
      ...emptyGeneration(),
      artifactPlans: artifactValues.map((artifact) => ({
        operation: "create" as const,
        nodeId: artifact.nodeId,
        artifactId: artifact.artifactId,
        kind: "page" as const,
        name: artifact.name,
        trackId: artifact.trackId,
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      })),
    },
    rationale: `Exercise multi-root retry graph ${label}`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const detail = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const taskFor = (artifactId: string): GenerationTask => {
    const task = detail.tasks.find((candidate) => (
      candidate.target.type === "artifact" && candidate.target.id === artifactId
    ));
    assert.ok(task);
    return task;
  };
  const roots = {
    a: taskFor(artifacts.a.artifactId),
    b: taskFor(artifacts.b.artifactId),
  } as const;
  const sibling = taskFor(artifacts.sibling.artifactId);
  const validation = detail.tasks.find((task) => task.kind === "prototype-validation");
  const checkpoint = detail.tasks.find((task) => task.kind === "checkpoint");
  assert.ok(validation);
  assert.ok(checkpoint);
  assert.deepEqual(
    new Set(validation.dependencyIds),
    new Set([roots.a.id, roots.b.id, sibling.id]),
  );
  assert.deepEqual(checkpoint.dependencyIds, [validation.id]);
  let now = 100_000;
  return {
    control,
    store,
    project,
    plan: detail.plan,
    roots,
    sibling,
    validation,
    checkpoint,
    nextNow() {
      now += 1;
      control.set(now);
      return now;
    },
  };
}

type DiamondRetryFixture = ReturnType<typeof createDiamondRetryFixture>;

function startDiamondArtifactTask(
  fixture: DiamondRetryFixture,
  taskId: string,
  label: string,
) {
  const before = fixture.store.workspace.getGenerationPlanDetailForProject(
    fixture.project.id,
    fixture.plan.id,
  );
  const task = before.tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task);
  assert.equal(task.target.type, "artifact");
  const observation = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
    fixture.project.id,
    fixture.plan.id,
    task.id,
  );
  const workspace = fixture.store.workspace.getWorkspace(fixture.project.id);
  const kernel = fixture.store.workspace.getKernelRevision(observation.kernelRevisionId);
  assert.ok(workspace);
  assert.ok(kernel);
  const contextHash = checksum(`${label}:${task.id}:${task.currentAttempt + 1}:context`);
  const context = fixture.store.workspace.persistContextPack({
    id: `context-pack-${contextHash}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "artifact", id: task.target.id },
    intent: "generate",
    messageChecksum: checksum(`${label}:${task.id}:message`),
    items: [{
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
    }],
    omissions: [],
    tokenEstimate: 1,
    manifestPath: `context-packs/${label}-${task.id}.json`,
    hash: contextHash,
  });
  const attempt = fixture.store.workspace.createGenerationTaskAttemptForProject(
    fixture.project.id,
    fixture.plan.id,
    {
      ...observation,
      contextPackId: context.id,
      sourceCommitHash: checksum(`${label}:${task.id}:source-commit`),
      sourceTreeHash: checksum(`${label}:${task.id}:source-tree`),
      retryContextPolicy: task.pendingContextPolicy ?? "same-context",
      executionMode: "full",
    },
  );
  const claim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `diamond-worker-${label}-${task.id}`,
    now: fixture.nextNow(),
    leaseMs: 30_000,
  });
  assert.ok(claim);
  return { task, attempt, claim, context };
}

function finishDiamondArtifactTask(
  fixture: DiamondRetryFixture,
  running: ReturnType<typeof startDiamondArtifactTask>,
  label: string,
): GenerationTask {
  const { task, attempt, claim, context } = running;
  fixture.nextNow();
  const frames = (attempt.payload as { responsiveFrames?: RenderFrameSpec[] }).responsiveFrames;
  assert.ok(frames && frames.length > 0);
  const candidate = {
    kind: "artifact" as const,
    sourceCommitHash: checksum(`${label}:${task.id}:candidate-commit`),
    sourceTreeHash: checksum(`${label}:${task.id}:candidate-tree`),
    renderSpec: { frames },
    quality: { state: "passed" as const, score: 100, findings: [] },
  };
  const visualEvidence = frames.map((frame) => {
    const sha256 = checksum(`${label}:${task.id}:visual:${frame.id}`);
    const frameAttemptId = `quality-round-0-${frame.id}`;
    return {
      protocol: "dezin.generation-task-visual-evidence.v1",
      owner: {
        projectId: fixture.project.id,
        workspaceId: task.workspaceId,
        planId: task.planId,
        taskId: task.id,
        attempt: attempt.attempt,
        candidateCommitHash: candidate.sourceCommitHash,
        candidateTreeHash: candidate.sourceTreeHash,
        contextPackId: context.id,
        contextPackHash: context.hash,
      },
      frame: { ...frame, frameAttemptId },
      round: 0,
      mediaType: "image/png",
      sha256,
      byteLength: 1_024,
      storageKey: [
        "generation-task-evidence",
        fixture.project.id,
        task.workspaceId,
        task.planId,
        task.id,
        `attempt-${attempt.attempt}`,
        "visual",
        `round-0-${frame.id}-${sha256}.png`,
      ].join("/"),
    };
  });
  const qualityEvidence = {
    protocol: "dezin.standard-artifact-quality.v1",
    candidate: {
      commitHash: candidate.sourceCommitHash,
      treeHash: candidate.sourceTreeHash,
    },
    contextPack: { id: context.id, hash: context.hash },
    frames: candidate.renderSpec.frames,
    frameResults: frames.map((frame, index) => ({
      frameId: frame.id,
      frameAttemptId: `quality-round-0-${frame.id}`,
      width: frame.width,
      height: frame.height,
      status: "passed",
      reviewed: true,
      captureIdentity: {
        sha256: visualEvidence[index]!.sha256,
        byteLength: visualEvidence[index]!.byteLength,
        width: frame.width,
        height: frame.height,
      },
    })),
    round: 0,
    runtimeChecks: frames.map((frame) => ({ id: `frame:${frame.id}`, status: "passed" })),
    visualReview: {
      status: "passed",
      fidelity: 1,
      evidence: visualEvidence.map(({ frame, sha256, byteLength, storageKey }) => ({
        frameId: frame.id,
        frameAttemptId: frame.frameAttemptId,
        sha256,
        byteLength,
        storageKey,
      })),
    },
    visualEvidence,
  };
  const evaluationManifest = {
    protocol: "dezin.artifact-run-evaluation-manifest.v1",
    candidate: qualityEvidence.candidate,
    round: 0,
    passed: true,
    score: candidate.quality.score,
    qualityState: candidate.quality.state,
    findingsDigest: checksum(JSON.stringify(candidate.quality.findings)),
    frameResults: qualityEvidence.frameResults,
    runtimeChecks: qualityEvidence.runtimeChecks,
    reviewSummary: qualityEvidence.visualReview,
    visualEvidence: qualityEvidence.visualEvidence,
  };
  fixture.store.workspace.stageGenerationTaskCandidateForProject(
    fixture.project.id,
    fixture.plan.id,
    {
      lease: claim.lease,
      candidate,
      evidence: {
        runtimeChecks: qualityEvidence.runtimeChecks,
        visualReview: qualityEvidence.visualReview,
        protocol: "dezin.artifact-run.v1",
        projectId: fixture.project.id,
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
          evaluationManifest,
        }],
        qualityEvidence,
      },
    },
  );
  const published = fixture.store.workspace.publishGenerationTaskCandidateForProject(
    fixture.project.id,
    fixture.plan.id,
    { lease: claim.lease },
  );
  assert.equal(published.status, "succeeded");
  const succeeded = fixture.store.workspace.getGenerationPlanDetailForProject(
    fixture.project.id,
    fixture.plan.id,
  ).tasks.find((candidateTask) => candidateTask.id === task.id);
  assert.ok(succeeded);
  assert.equal(succeeded.status, "succeeded");
  return succeeded;
}

function succeedDiamondArtifactTask(
  fixture: DiamondRetryFixture,
  taskId: string,
  label: string,
): GenerationTask {
  return finishDiamondArtifactTask(
    fixture,
    startDiamondArtifactTask(fixture, taskId, label),
    label,
  );
}

function failDiamondRoot(fixture: DiamondRetryFixture, task: GenerationTask, label: string): void {
  fixture.nextNow();
  fixture.store.workspace.recordGenerationTaskMaterializationFailureForProject(
    fixture.project.id,
    fixture.plan.id,
    {
      taskId: task.id,
      expectedFailureCount: task.materializationFailures,
      failureClass: "qa",
      error: { code: `QA_${label.toUpperCase()}_FAILED`, message: `Root ${label} failed QA` },
      nextEligibleAt: null,
    },
  );
}

function createApprovedShellFixture(label: string) {
  const control = controlledClock(`plan-shell-control-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Plan shell controls ${label}`, mode: "standard" });
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
    rationale: `Exercise approved shell cancellation ${label}`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  return { control, store, project, plan: approved.plan };
}

function materializeValidation(fixture: ReturnType<typeof createControlFixture>) {
  const observation = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.validation.id,
  );
  const attempt = fixture.store.workspace.createGenerationTaskAttemptForProject(
    fixture.project.id,
    fixture.plan.id,
    {
      ...observation,
      contextPackId: null,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  return { observation, attempt };
}

function claimValidation(
  fixture: ReturnType<typeof createControlFixture>,
  attempt: ReturnType<typeof materializeValidation>["attempt"],
): GenerationTaskAttemptClaim {
  fixture.control.set(100_000);
  const claim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
    taskId: fixture.validation.id,
    attempt: attempt.attempt,
    ownerId: `control-worker-${fixture.validation.id}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  return claim;
}

function events(fixture: ReturnType<typeof createControlFixture>) {
  return fixture.store.workspace.listGenerationPlanEventsForProject(
    fixture.project.id,
    fixture.plan.id,
    { after: 0, limit: 1_000 },
  );
}

function attemptClaimCount(
  fixture: ReturnType<typeof createControlFixture>,
  taskId: string,
  attempt: number,
): number {
  const row = fixture.store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
  ).get(taskId, attempt) as { count: number };
  return row.count;
}

test("manual retry advances the durable execution epoch and fences an old asynchronous observation", () => {
  const fixture = createControlFixture("epoch-fence");
  try {
    const stale = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.validation.id,
    );
    assert.equal(stale.executionEpoch, 0);
    fixture.store.workspace.recordGenerationTaskMaterializationFailureForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        taskId: fixture.validation.id,
        expectedFailureCount: 0,
        failureClass: "context",
        error: { code: "CONTEXT_MISSING", message: "Required Context is unavailable" },
        nextEligibleAt: null,
      },
    );

    const retried = fixture.store.workspace.retryGenerationTaskForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.validation.id,
      { mode: "latest-context" },
    );
    assert.equal(retried.plan.executionEpoch, 1);
    const task = retried.tasks.find((candidate) => candidate.id === fixture.validation.id);
    assert.equal(task?.status, "materialization-pending");
    assert.equal(task?.pendingContextPolicy, "latest-context");

    assert.throws(
      () => fixture.store.workspace.createGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          ...stale,
          contextPackId: null,
          sourceCommitHash: null,
          sourceTreeHash: null,
          retryContextPolicy: "latest-context",
          executionMode: "full",
        },
      ),
      /execution epoch|stale/i,
    );
    const fresh = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.validation.id,
    );
    assert.equal(fresh.executionEpoch, 1);
  } finally {
    fixture.store.close();
  }
});

test("Plan cancellation is atomic, keeps live claims fenced, and terminalizes exactly once after acknowledgement", () => {
  const fixture = createControlFixture("cancel");
  try {
    const { attempt } = materializeValidation(fixture);
    const claim = claimValidation(fixture, attempt);
    fixture.control.set(100_001);

    const requested = fixture.store.workspace.cancelGenerationPlanForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(requested.plan.status, "running");
    assert.equal(requested.plan.executionEpoch, 1);
    assert.equal(
      requested.tasks.find((task) => task.id === fixture.validation.id)?.status,
      "cancel-requested",
    );
    assert.equal(
      requested.tasks.find((task) => task.id === fixture.checkpoint.id)?.status,
      "cancelled",
    );
    assert.ok(attemptClaimCount(fixture, fixture.validation.id, attempt.attempt) > 0);
    assert.equal(events(fixture).filter((event) => event.type === "plan-cancel-requested").length, 1);

    const replay = fixture.store.workspace.cancelGenerationPlanForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.deepEqual(replay, requested);
    assert.equal(events(fixture).filter((event) => event.type === "plan-cancel-requested").length, 1);

    const heartbeat = fixture.store.workspace.heartbeatGenerationTaskAttempt(
      claim.lease,
      100_002,
      30_000,
    );
    assert.equal(heartbeat.task.status, "cancel-requested");
    assert.equal(heartbeat.attempt.status, "cancel-requested");

    fixture.control.set(100_003);
    const acknowledged = fixture.store.workspace.finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        lease: claim.lease,
        failure: {
          failureClass: "cancelled",
          error: { code: "USER_CANCELLED", message: "Generation Plan cancelled" },
        },
      },
    );
    assert.equal(acknowledged.status, "cancelled");
    assert.equal(acknowledged.sourceAttempt.status, "cancelled");
    assert.equal(attemptClaimCount(fixture, fixture.validation.id, attempt.attempt), 0);
    const terminal = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(terminal.plan.status, "cancelled");
    assert.equal(terminal.tasks.find((task) => task.id === fixture.validation.id)?.status, "cancelled");
    assert.equal(events(fixture).filter((event) => event.type === "plan-cancelled").length, 1);
    assert.equal(events(fixture).at(-1)?.type, "plan-cancelled");

    const terminalReplay = fixture.store.workspace.cancelGenerationPlanForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.deepEqual(terminalReplay, terminal);
    assert.equal(events(fixture).filter((event) => event.type === "plan-cancelled").length, 1);
  } finally {
    fixture.store.close();
  }
});

test("an approved unsealed Plan shell can be cancelled during the approval-to-compilation recovery window", () => {
  const fixture = createApprovedShellFixture("approved");
  try {
    assert.equal(fixture.plan.status, "approved");
    assert.equal(fixture.plan.constructionSealed, false);
    const cancelled = fixture.store.workspace.cancelGenerationPlanForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(cancelled.plan.status, "cancelled");
    assert.equal(cancelled.plan.constructionSealed, false);
    assert.equal(cancelled.plan.executionEpoch, 1);
    assert.deepEqual(cancelled.tasks, []);
    const history = fixture.store.workspace.listGenerationPlanEventsForProject(
      fixture.project.id,
      fixture.plan.id,
      { after: 0, limit: 100 },
    );
    assert.deepEqual(history.map((event) => event.type), [
      "plan-cancel-requested",
      "plan-cancelled",
    ]);
    assert.deepEqual(
      fixture.store.workspace.cancelGenerationPlanForProject(
        fixture.project.id,
        fixture.plan.id,
      ),
      cancelled,
    );
    assert.throws(
      () => fixture.store.workspace.compileApprovedGenerationPlanForProject(
        fixture.project.id,
        fixture.plan.id,
      ),
      /cancelled|state/i,
    );
  } finally {
    fixture.store.close();
  }
});

test("opening a pre-control database widens the event CHECK and preserves its Plan history", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-generation-control-migration-"));
  const database = join(directory, "control.db");
  const fixture = createControlFixture("event-migration", database);
  const projectId = fixture.project.id;
  const planId = fixture.plan.id;
  fixture.store.close();

  try {
    const legacy = new DatabaseSync(database);
    legacy.exec("PRAGMA foreign_keys = ON");
    try {
      legacy.exec(`
        SAVEPOINT downgrade_generation_plan_events;
        DROP TRIGGER IF EXISTS generation_plan_execution_epoch_guard;
        DROP TRIGGER IF EXISTS generation_plan_event_insert_guard;
        DROP TRIGGER IF EXISTS generation_plan_event_update_immutable;
        DROP TRIGGER IF EXISTS generation_plan_event_delete_history_guard;
        DROP TRIGGER IF EXISTS generation_task_claim_insert_guard;
        DROP TRIGGER IF EXISTS generation_task_result_write_once;
        CREATE TABLE generation_plan_events_before_controls (
          plan_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK(sequence > 0 AND sequence <= 9007199254740991),
          task_id TEXT,
          type TEXT NOT NULL CHECK(type IN (
            'plan-queued','plan-compile-failed','task-materialization-failed','task-blocked-context',
            'task-materialized','task-running','task-candidate-ready','task-needs-rebase',
            'task-retry-wait','task-succeeded','task-failed','task-blocked','task-cancel-requested',
            'task-cancelled','plan-succeeded','plan-failed','plan-cancelled'
          )),
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json) = 1),
          created_at INTEGER NOT NULL,
          FOREIGN KEY(plan_id, workspace_id)
            REFERENCES generation_plans(id, workspace_id) ON DELETE CASCADE,
          FOREIGN KEY(task_id, plan_id, workspace_id)
            REFERENCES generation_tasks(id, plan_id, workspace_id) ON DELETE CASCADE,
          CHECK(
            (type LIKE 'task-%' AND task_id IS NOT NULL) OR
            (type LIKE 'plan-%' AND task_id IS NULL)
          ),
          PRIMARY KEY(plan_id, sequence)
        );
        INSERT INTO generation_plan_events_before_controls (
          plan_id, workspace_id, sequence, task_id, type, payload_json, created_at
        )
        SELECT plan_id, workspace_id, sequence, task_id, type, payload_json, created_at
        FROM generation_plan_events;
        DROP TABLE generation_plan_events;
        ALTER TABLE generation_plan_events_before_controls RENAME TO generation_plan_events;
        RELEASE downgrade_generation_plan_events;
      `);
    } finally {
      legacy.close();
    }

    const reopened = new Store(database, fixture.control.clock);
    try {
      const before = reopened.workspace.listGenerationPlanEventsForProject(projectId, planId);
      assert.deepEqual(before.map((event) => event.type), ["plan-queued"]);
      const cancelled = reopened.workspace.cancelGenerationPlanForProject(projectId, planId);
      assert.equal(cancelled.plan.status, "cancelled");
      const after = reopened.workspace.listGenerationPlanEventsForProject(projectId, planId);
      assert.equal(after[0]?.type, "plan-queued");
      assert.equal(after.filter((event) => event.type === "plan-cancel-requested").length, 1);
      assert.equal(after.at(-1)?.type, "plan-cancelled");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const order of [
  { first: "a", second: "b" },
  { first: "b", second: "a" },
] as const) {
  test(`manual retry recomputes a shared failure DAG when retrying ${order.first.toUpperCase()} then ${order.second.toUpperCase()}`, () => {
    const fixture = createDiamondRetryFixture(`retry-${order.first}-${order.second}`);
    try {
      const succeededSibling = succeedDiamondArtifactTask(
        fixture,
        fixture.sibling.id,
        `sibling-${order.first}-${order.second}`,
      );
      failDiamondRoot(fixture, fixture.roots.a, "a");
      failDiamondRoot(fixture, fixture.roots.b, "b");

      const terminal = fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      );
      assert.equal(terminal.plan.status, "failed");
      assert.equal(terminal.tasks.find((task) => task.id === fixture.roots.a.id)?.status, "failed");
      assert.equal(terminal.tasks.find((task) => task.id === fixture.roots.b.id)?.status, "failed");
      assert.equal(
        terminal.tasks.find((task) => task.id === fixture.validation.id)?.blockedByTaskId,
        fixture.roots.a.id,
      );
      assert.equal(
        terminal.tasks.find((task) => task.id === fixture.checkpoint.id)?.blockedByTaskId,
        fixture.roots.a.id,
      );

      const firstRoot = fixture.roots[order.first];
      const remainingRoot = fixture.roots[order.second];
      const firstRetry = fixture.store.workspace.retryGenerationTaskForProject(
        fixture.project.id,
        fixture.plan.id,
        firstRoot.id,
        { mode: "latest-context", now: fixture.nextNow() },
      );
      const retryEpoch = firstRetry.plan.executionEpoch;
      assert.equal(firstRetry.plan.status, "queued");
      assert.equal(retryEpoch, 1);
      const durableRemainingRoot = firstRetry.tasks.find((task) => task.id === remainingRoot.id);
      assert.equal(durableRemainingRoot?.status, "failed");
      for (const descendant of [fixture.validation, fixture.checkpoint]) {
        const blocked = firstRetry.tasks.find((task) => task.id === descendant.id);
        assert.equal(blocked?.status, "blocked");
        assert.equal(blocked?.blockedByTaskId, remainingRoot.id);
        assert.equal(blocked?.blockedReason, `Blocked by failed prerequisite ${remainingRoot.id}`);
        assert.equal(blocked?.failureClass, durableRemainingRoot?.failureClass);
        assert.deepEqual(blocked?.error, durableRemainingRoot?.error);
      }
      const firstRetryEvent = fixture.store.workspace.listGenerationPlanEventsForProject(
        fixture.project.id,
        fixture.plan.id,
        { after: 0, limit: 1_000 },
      ).find((event) => event.type === "task-retry-requested" && event.taskId === firstRoot.id);
      assert.deepEqual(firstRetryEvent?.payload.reopenedTaskIds, []);

      const secondRetry = fixture.store.workspace.retryGenerationTaskForProject(
        fixture.project.id,
        fixture.plan.id,
        remainingRoot.id,
        { mode: "latest-context", now: fixture.nextNow() },
      );
      assert.equal(secondRetry.plan.status, "queued");
      assert.equal(
        secondRetry.plan.executionEpoch,
        retryEpoch,
        "retrying another root from the same failed Plan must not stale the first retry",
      );
      assert.equal(
        secondRetry.tasks.find((task) => task.id === fixture.validation.id)?.status,
        "materialization-pending",
      );
      assert.equal(
        secondRetry.tasks.find((task) => task.id === fixture.checkpoint.id)?.status,
        "materialization-pending",
      );
      const secondRetryEvent = fixture.store.workspace.listGenerationPlanEventsForProject(
        fixture.project.id,
        fixture.plan.id,
        { after: 0, limit: 1_000 },
      ).find((event) => event.type === "task-retry-requested" && event.taskId === remainingRoot.id);
      assert.deepEqual(
        secondRetryEvent?.payload.reopenedTaskIds,
        [fixture.validation.id, fixture.checkpoint.id],
      );

      succeedDiamondArtifactTask(
        fixture,
        firstRoot.id,
        `first-${order.first}-${order.second}`,
      );
      succeedDiamondArtifactTask(
        fixture,
        remainingRoot.id,
        `second-${order.first}-${order.second}`,
      );
      const continued = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.validation.id,
      );
      assert.equal(continued.taskId, fixture.validation.id);
      assert.equal(continued.executionEpoch, retryEpoch);

      const final = fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      );
      assert.deepEqual(
        final.tasks.find((task) => task.id === fixture.sibling.id),
        succeededSibling,
      );
      assert.equal(final.tasks.find((task) => task.id === fixture.roots.a.id)?.status, "succeeded");
      assert.equal(final.tasks.find((task) => task.id === fixture.roots.b.id)?.status, "succeeded");
      assert.equal(final.tasks.find((task) => task.id === fixture.validation.id)?.status, "materialization-pending");
      const history = fixture.store.workspace.listGenerationPlanEventsForProject(
        fixture.project.id,
        fixture.plan.id,
        { after: 0, limit: 1_000 },
      );
      assert.equal(
        history.filter((event) => event.type === "task-succeeded" && event.taskId === fixture.sibling.id).length,
        1,
      );
      assert.equal(
        history.filter((event) => event.type === "task-failed" && event.taskId === fixture.roots.a.id).length,
        1,
      );
      assert.equal(
        history.filter((event) => event.type === "task-failed" && event.taskId === fixture.roots.b.id).length,
        1,
      );
      assert.deepEqual(
        history
          .filter((event) => event.type === "task-retry-requested")
          .map((event) => event.payload.executionEpoch),
        [retryEpoch, retryEpoch],
      );
    } finally {
      fixture.store.close();
    }
  });
}

test("manual retry can start while an independent sibling Attempt remains running", () => {
  const fixture = createDiamondRetryFixture("retry-during-running-sibling");
  try {
    const runningSibling = startDiamondArtifactTask(
      fixture,
      fixture.sibling.id,
      "running-sibling",
    );
    const beforeFailure = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    const siblingBeforeRetry = beforeFailure.tasks.find((task) => task.id === fixture.sibling.id);
    assert.ok(siblingBeforeRetry);
    assert.equal(beforeFailure.plan.status, "running");
    assert.equal(siblingBeforeRetry.status, "running");
    assert.equal(runningSibling.attempt.executionEpoch, 0);

    failDiamondRoot(fixture, fixture.roots.a, "a-running-sibling");
    const activeFailure = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(activeFailure.plan.status, "running");
    assert.equal(
      activeFailure.tasks.find((task) => task.id === fixture.roots.a.id)?.status,
      "failed",
    );
    assert.equal(
      activeFailure.tasks.find((task) => task.id === fixture.sibling.id)?.status,
      "running",
    );

    const retried = fixture.store.workspace.retryGenerationTaskForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.roots.a.id,
      { mode: "latest-context", now: fixture.nextNow() },
    );
    assert.equal(retried.plan.status, "running");
    assert.equal(retried.plan.executionEpoch, 1);
    assert.equal(
      retried.tasks.find((task) => task.id === fixture.roots.a.id)?.status,
      "materialization-pending",
    );
    assert.deepEqual(
      retried.tasks.find((task) => task.id === fixture.sibling.id),
      siblingBeforeRetry,
      "opening a retry window must not mutate an independent live sibling",
    );

    failDiamondRoot(fixture, fixture.roots.b, "b-after-retry-window");
    const laterFailure = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(laterFailure.plan.status, "running");
    assert.equal(
      laterFailure.tasks.find((task) => task.id === fixture.roots.b.id)?.status,
      "failed",
    );
    const laterRetry = fixture.store.workspace.retryGenerationTaskForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.roots.b.id,
      { mode: "latest-context", now: fixture.nextNow() },
    );
    assert.equal(laterRetry.plan.executionEpoch, 2);
    assert.deepEqual(
      laterRetry.tasks.find((task) => task.id === fixture.sibling.id),
      siblingBeforeRetry,
      "a failure created after the prior retry window must still preserve an independent live sibling",
    );

    const heartbeat = fixture.store.workspace.heartbeatGenerationTaskAttempt(
      runningSibling.claim.lease,
      fixture.nextNow(),
      30_000,
    );
    assert.equal(heartbeat.task.status, "running");
    assert.equal(heartbeat.attempt.status, "running");
    assert.equal(heartbeat.attempt.executionEpoch, 0);
    const succeededSibling = finishDiamondArtifactTask(
      fixture,
      runningSibling,
      "running-sibling",
    );
    assert.equal(succeededSibling.status, "succeeded");

    for (const root of [fixture.roots.a, fixture.roots.b]) {
      const freshRetryObservation = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
        fixture.project.id,
        fixture.plan.id,
        root.id,
      );
      assert.equal(freshRetryObservation.executionEpoch, 2);
    }
    assert.deepEqual(
      fixture.store.workspace.listGenerationPlanEventsForProject(
        fixture.project.id,
        fixture.plan.id,
        { after: 0, limit: 1_000 },
      ).filter((event) => event.type === "task-retry-requested")
        .map((event) => event.payload.executionEpoch),
      [1, 2],
    );
  } finally {
    fixture.store.close();
  }
});

test("manual retry rejects an active Plan cancellation as a typed conflict", () => {
  const fixture = createDiamondRetryFixture("retry-during-cancellation");
  try {
    startDiamondArtifactTask(fixture, fixture.sibling.id, "cancelling-sibling");
    failDiamondRoot(fixture, fixture.roots.a, "a-cancelling-sibling");
    const cancelling = fixture.store.workspace.cancelGenerationPlanForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.nextNow(),
    );
    assert.equal(cancelling.plan.status, "running");
    assert.equal(
      cancelling.tasks.find((task) => task.id === fixture.sibling.id)?.status,
      "cancel-requested",
    );

    assert.throws(
      () => fixture.store.workspace.retryGenerationTaskForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.roots.a.id,
        { mode: "latest-context", now: fixture.nextNow() },
      ),
      (error: unknown) => {
        assert.ok(error instanceof GenerationTaskMaterializationConflictError);
        assert.match(error.message, /cancellation/i);
        return true;
      },
    );
  } finally {
    fixture.store.close();
  }
});

test("manual same-context retry preserves history and reopens only descendants blocked by the selected Task", () => {
  const fixture = createControlFixture("retry-subtree");
  try {
    const { attempt } = materializeValidation(fixture);
    const claim = claimValidation(fixture, attempt);
    fixture.control.set(100_001);
    fixture.store.workspace.finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        lease: claim.lease,
        failure: {
          failureClass: "qa",
          error: { code: "QA_FAILED", message: "Validation did not pass" },
        },
      },
    );
    const failed = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(failed.plan.status, "failed");
    assert.equal(failed.tasks.find((task) => task.id === fixture.validation.id)?.status, "failed");
    assert.equal(failed.tasks.find((task) => task.id === fixture.checkpoint.id)?.blockedByTaskId, fixture.validation.id);

    fixture.control.set(100_100);
    const retried = fixture.store.workspace.retryGenerationTaskForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.validation.id,
      { mode: "same-context" },
    );
    assert.equal(retried.plan.status, "queued");
    assert.equal(retried.plan.finishedAt, null);
    assert.equal(retried.plan.executionEpoch, 1);
    const selected = retried.tasks.find((task) => task.id === fixture.validation.id);
    const descendant = retried.tasks.find((task) => task.id === fixture.checkpoint.id);
    assert.equal(selected?.status, "materialization-pending");
    assert.equal(selected?.pendingContextPolicy, "same-context");
    assert.equal(descendant?.status, "materialization-pending");
    assert.equal(descendant?.blockedByTaskId, null);
    assert.equal(descendant?.finishedAt, null);
    assert.equal(
      fixture.store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.validation.id,
        attempt.attempt,
      )?.status,
      "failed",
    );
    const retryEvents = events(fixture).filter((event) => event.type === "task-retry-requested");
    assert.equal(retryEvents.length, 1);
    assert.deepEqual(retryEvents[0]?.payload.reopenedTaskIds, [fixture.checkpoint.id]);
    assert.equal(retryEvents[0]?.payload.mode, "same-context");

    const replay = fixture.store.workspace.retryGenerationTaskForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.validation.id,
      { mode: "same-context" },
    );
    assert.deepEqual(replay, retried);
    assert.equal(events(fixture).filter((event) => event.type === "task-retry-requested").length, 1);
    assert.throws(
      () => fixture.store.workspace.retryGenerationTaskForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.validation.id,
        { mode: "latest-context" },
      ),
      /already requested|state|mode/i,
    );

    const observation = fixture.store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.validation.id,
    );
    assert.equal(observation.executionEpoch, 1);
    assert.equal(observation.requiredContextPackId, null);
    const successor = fixture.store.workspace.createGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        ...observation,
        contextPackId: observation.requiredContextPackId,
        sourceCommitHash: null,
        sourceTreeHash: null,
        retryContextPolicy: "same-context",
        executionMode: "full",
      },
    );
    assert.equal(successor.attempt, attempt.attempt + 1);
    assert.equal(successor.attemptOrigin, "materialized");
    assert.equal(successor.predecessorAttempt, null);
    assert.equal(successor.automaticRetryIndex, 0);
    assert.equal(successor.executionEpoch, 1);
  } finally {
    fixture.store.close();
  }
});

test("same-context retry rejects Tasks that never completed an immutable Attempt", () => {
  const fixture = createControlFixture("retry-without-attempt");
  try {
    fixture.store.workspace.recordGenerationTaskMaterializationFailureForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        taskId: fixture.validation.id,
        expectedFailureCount: 0,
        failureClass: "context",
        error: { code: "CONTEXT_MISSING", message: "No reusable Context exists" },
        nextEligibleAt: null,
      },
    );
    assert.throws(
      () => fixture.store.workspace.retryGenerationTaskForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.validation.id,
        { mode: "same-context" },
      ),
      /same-context.*attempt|complete attempt/i,
    );
    const detail = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    );
    assert.equal(detail.plan.executionEpoch, 0);
    assert.equal(detail.tasks.find((task) => task.id === fixture.validation.id)?.status, "blocked-context");
    assert.equal(events(fixture).filter((event) => event.type === "task-retry-requested").length, 0);
  } finally {
    fixture.store.close();
  }
});
