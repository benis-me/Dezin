import assert from "node:assert/strict";
import test from "node:test";

import { Store, type StoreClock } from "../src/index.ts";

function fakeClock(): StoreClock {
  let now = 90_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `materialization-integrity-id-${++id}`,
  };
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

function createCompiledResourcePlan(store: Store) {
  const project = store.createProject({ name: "Resource base integrity", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Approved research base",
    defaultPinPolicy: "follow-head",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const baseRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId: "approved-resource-base-revision",
      parentRevisionId: null,
      manifestPath: "resource-revisions/approved-base/manifest.json",
      summary: "Approved Resource base",
      metadata: { stage: "approved-base" },
      checksum: "1".repeat(64),
      provenance: { source: "integrity-regression-fixture" },
    },
  );
  store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, baseRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
    reason: "publish approved Resource base",
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
      resourceOperations: [{
        operation: "revise",
        nodeId: created.node.id,
        resourceId: created.resource.id,
        kind: created.resource.kind,
        title: created.resource.title,
        revisionPolicy: { kind: "generate" },
      }],
    },
    rationale: "Revise the exact Resource base approved by this Proposal",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const task = compiled.tasks.find((candidate) => candidate.kind === "resource");
  assert.ok(task);
  return {
    project,
    workspace,
    resource: created.resource,
    baseRevision,
    plan: compiled.plan,
    task,
  };
}

function advanceResourceHead(
  store: Store,
  fixture: ReturnType<typeof createCompiledResourcePlan>,
) {
  const workspace = store.workspace.getWorkspace(fixture.project.id)!;
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    fixture.project.id,
    fixture.resource.id,
    {
      revisionId: "concurrent-resource-revision",
      parentRevisionId: fixture.baseRevision.id,
      manifestPath: "resource-revisions/concurrent/manifest.json",
      summary: "Concurrent Resource Head",
      metadata: { stage: "concurrent" },
      checksum: "2".repeat(64),
      provenance: { source: "concurrent-publication" },
    },
  );
  return store.workspace.publishResourceRevisionForProject(
    fixture.project.id,
    fixture.resource.id,
    revision.id,
    {
      expectedHeadRevisionId: fixture.baseRevision.id,
      expectedSnapshotId: workspace.activeSnapshotId,
      reason: "concurrent Resource publication",
    },
  );
}

function persistResourceContextPack(
  store: Store,
  fixture: ReturnType<typeof createCompiledResourcePlan>,
  observation: ReturnType<Store["workspace"]["observeGenerationTaskMaterializationForProject"]>,
  intent: "generate" | "repair",
) {
  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  assert.ok(kernel);
  return store.workspace.persistContextPack({
    id: `${intent}-resource-context-pack`,
    workspaceId: fixture.workspace.id,
    graphRevision: fixture.workspace.graphRevision,
    target: { type: "resource", id: fixture.resource.id },
    intent,
    messageChecksum: (intent === "generate" ? "3" : "4").repeat(64),
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
        ref: {
          kind: "resource",
          id: fixture.resource.id,
          resourceKind: fixture.resource.kind,
          revisionId: fixture.baseRevision.id,
        },
        resolvedKind: "resource-revision",
        resourceRevisionId: fixture.baseRevision.id,
        checksum: fixture.baseRevision.checksum,
        reason: "approved-target-base",
        trustLevel: "trusted",
        boundary: {},
        tokenEstimate: 1,
        provenance: {},
        provided: true,
      },
    ],
    omissions: [],
    tokenEstimate: 2,
    manifestPath: `context-packs/${intent}-resource.json`,
    hash: (intent === "generate" ? "5" : "6").repeat(64),
  });
}

function createMaterializedValidationTask(store: Store) {
  const project = store.createProject({ name: "Durable Attempt integrity", mode: "standard" });
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
    rationale: "Exercise durable Attempt read invariants",
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
  return { project, plan: compiled.plan, task, attempt };
}

function attemptCount(store: Store, taskId: string): number {
  return Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_task_attempts WHERE task_id = ?",
  ).get(taskId) as { count: number }).count);
}

test("first Resource observation rejects a Head and Snapshot that drifted from the approved base", (t) => {
  const store = new Store(":memory:", fakeClock());
  t.after(() => store.close());
  const fixture = createCompiledResourcePlan(store);
  advanceResourceHead(store, fixture);

  let caught: unknown;
  try {
    store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(attemptCount(store, fixture.task.id), 0);
  assert.ok(caught instanceof Error, "the first observation must fail closed after Resource base drift");
  assert.match(caught.message, /approved.*base|Head changed after approval|base.*approval/i);
});

test("Resource materialization rejects a previously observed base after Head and Snapshot drift", (t) => {
  const store = new Store(":memory:", fakeClock());
  t.after(() => store.close());
  const fixture = createCompiledResourcePlan(store);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.task.id,
  );
  const pack = persistResourceContextPack(store, fixture, observation, "generate");
  advanceResourceHead(store, fixture);

  assert.throws(
    () => store.workspace.createGenerationTaskAttemptForProject(fixture.project.id, fixture.plan.id, {
      ...observation,
      contextPackId: pack.id,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
    /stale|Snapshot|approved.*base|Head changed/i,
  );
  assert.equal(attemptCount(store, fixture.task.id), 0);
});

test("repair Context Pack is rejected explicitly before Generation Attempt persistence", (t) => {
  const store = new Store(":memory:", fakeClock());
  t.after(() => store.close());
  const fixture = createCompiledResourcePlan(store);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.task.id,
  );
  const pack = persistResourceContextPack(store, fixture, observation, "repair");

  let caught: unknown;
  try {
    store.workspace.createGenerationTaskAttemptForProject(fixture.project.id, fixture.plan.id, {
      ...observation,
      contextPackId: pack.id,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(attemptCount(store, fixture.task.id), 0);
  assert.ok(caught instanceof Error, "repair intent must be rejected");
  assert.equal(caught.name, "GenerationTaskMaterializationConflictError");
  assert.match(caught.message, /Context Pack|intent/i);
  assert.match(caught.message, /generate/i);
});

test("durable Plan read rejects a current Attempt without its task-materialized event", (t) => {
  const store = new Store(":memory:", fakeClock());
  t.after(() => store.close());
  const fixture = createMaterializedValidationTask(store);
  store.db.exec("DROP TRIGGER generation_plan_event_delete_history_guard");
  const deleted = store.db.prepare(
    "DELETE FROM generation_plan_events WHERE plan_id = ? AND task_id = ? AND type = 'task-materialized'",
  ).run(fixture.plan.id, fixture.task.id);
  assert.equal(Number(deleted.changes), 1);

  assert.throws(
    () => store.workspace.getGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      fixture.attempt.attempt,
    ),
    /materialized event|Attempt.*event/i,
  );
  assert.throws(
    () => store.workspace.getGenerationPlanDetailForProject(fixture.project.id, fixture.plan.id),
    /materialized event|Attempt.*event/i,
  );
});

test("SQLite rejects a Task running transition without a claimed current Attempt", (t) => {
  const store = new Store(":memory:", fakeClock());
  t.after(() => store.close());
  const fixture = createMaterializedValidationTask(store);
  assert.equal(fixture.attempt.status, "queued");
  assert.throws(
    () => store.db.prepare(
      "UPDATE generation_tasks SET status = 'running' WHERE id = ? AND plan_id = ?",
    ).run(fixture.task.id, fixture.plan.id),
    /Task|Attempt|claim|running/i,
  );
  const detail = store.workspace.getGenerationPlanDetailForProject(fixture.project.id, fixture.plan.id);
  assert.equal(detail.tasks.find((task) => task.id === fixture.task.id)?.status, "queued");
});

test("SQLite rejects control and blocked states with incompatible current Attempts", (t) => {
  const store = new Store(":memory:", fakeClock());
  t.after(() => store.close());
  const fixture = createMaterializedValidationTask(store);
  for (const status of ["blocked", "blocked-context", "awaiting-context-refresh"] as const) {
    assert.throws(
      () => store.db.prepare(
        "UPDATE generation_tasks SET status = ? WHERE id = ? AND plan_id = ?",
      ).run(status, fixture.task.id, fixture.plan.id),
      /Task.*state.*incoherent|status transition/i,
    );
    const detail = store.workspace.getGenerationPlanDetailForProject(fixture.project.id, fixture.plan.id);
    assert.equal(detail.tasks.find((task) => task.id === fixture.task.id)?.status, "queued");
  }
});
