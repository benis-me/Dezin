import assert from "node:assert/strict";
import test from "node:test";
import {
  Store,
  type StoreClock,
} from "../src/index.ts";

function fakeClock(): StoreClock {
  let now = 20_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `generation-store-id-${++id}`,
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
    responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function createApprovedPlanShell(store: Store) {
  const project = store.createProject({ name: "Generation Plan store", mode: "standard" });
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
    rationale: "Compile an empty but executable workspace checkpoint",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  return { project, workspace, proposal, approved, plan: approved.plan };
}

function createApprovedComponentPlanShell(
  store: Store,
  instanceIds: readonly string[],
) {
  const project = store.createProject({ name: "Generation component identities", mode: "standard" });
  const initialWorkspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: initialWorkspace.graphRevision,
    expectedSnapshotId: initialWorkspace.activeSnapshotId,
    commands: [
      {
        id: "add-generation-owner",
        type: "add-node",
        node: {
          id: "generation-owner-node",
          kind: "page",
          name: "Generation owner",
          artifactId: "generation-owner",
          createIdentity: { initialTrackId: "generation-owner-track" },
        },
      },
      {
        id: "add-generation-other-owner",
        type: "add-node",
        node: {
          id: "generation-other-owner-node",
          kind: "page",
          name: "Generation other owner",
          artifactId: "generation-other-owner",
          createIdentity: { initialTrackId: "generation-other-owner-track" },
        },
      },
      {
        id: "add-generation-component",
        type: "add-node",
        node: {
          id: "generation-component-node",
          kind: "component",
          name: "Generation component",
          artifactId: "generation-component",
          createIdentity: { initialTrackId: "generation-component-track" },
        },
      },
    ],
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  assert.equal(workspace.activeSnapshotId, graph.snapshot.id);
  const createBaseRevision = (artifactId: string, trackId: string) => store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash: `commit-${artifactId}`,
    sourceTreeHash: `tree-${artifactId}`,
    kernelRevisionId: workspace.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: `context-${artifactId}`,
    dependencies: [],
    resourcePins: [],
  });
  const ownerRevision = createBaseRevision("generation-owner", "generation-owner-track");
  const componentRevision = createBaseRevision("generation-component", "generation-component-track");
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
      artifactPlans: [
        {
          operation: "revise",
          nodeId: "generation-owner-node",
          artifactId: "generation-owner",
          kind: "page",
          name: "Generation owner",
          trackId: "generation-owner-track",
          baseRevisionId: ownerRevision.id,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: ["desktop"],
        },
        {
          operation: "revise",
          nodeId: "generation-component-node",
          artifactId: "generation-component",
          kind: "component",
          name: "Generation component",
          trackId: "generation-component-track",
          baseRevisionId: componentRevision.id,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: ["desktop"],
        },
      ],
      dependencyPlans: instanceIds.map((instanceId) => ({
        kind: "component-instance" as const,
        ownerArtifactId: "generation-owner",
        instanceId,
        componentArtifactId: "generation-component",
        componentRevisionId: null,
        sourceLocator: { designNodeId: `slot-${instanceId}` },
        overrides: {},
        status: "linked" as const,
      })),
    },
    rationale: "Compile stable component identities before generation starts",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  return { project, workspace, proposal, approved, plan: approved.plan };
}

test("an approved Plan shell compiles exactly once into a normalized durable DAG", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan } = createApprovedPlanShell(store);

  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
  assert.equal(compiled.plan.status, "queued");
  assert.deepEqual(compiled.tasks.map(({ kind }) => kind), ["prototype-validation", "checkpoint"]);
  assert.deepEqual(compiled.tasks[0]?.dependencyIds, []);
  assert.deepEqual(compiled.tasks[1]?.dependencyIds, [compiled.tasks[0]!.id]);
  assert.equal(compiled.dependencies.length, 1);
  assert.deepEqual(compiled.dependencies[0], {
    taskId: compiled.tasks[1]!.id,
    dependencyTaskId: compiled.tasks[0]!.id,
    planId: plan.id,
    ordinal: 0,
  });
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 })
      .map(({ sequence, type, taskId }) => ({ sequence, type, taskId })),
    [{ sequence: 1, type: "plan-queued", taskId: null }],
  );

  const replay = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
  assert.deepEqual(replay, compiled);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_tasks WHERE plan_id = ?")
      .get(plan.id) as { count: number }).count),
    2,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_plan_events WHERE plan_id = ?")
      .get(plan.id) as { count: number }).count),
    1,
  );
  store.close();
});

test("Plan compilation enforces Project ownership and approved-shell status without partial rows", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan } = createApprovedPlanShell(store);
  const foreign = store.createProject({ name: "Foreign compiler", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(foreign.id);

  assert.throws(
    () => store.workspace.compileApprovedGenerationPlanForProject(foreign.id, plan.id),
    /another Project|ownership/i,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_tasks WHERE plan_id = ?")
      .get(plan.id) as { count: number }).count),
    0,
  );
  assert.equal(store.workspace.getGenerationPlan(plan.id)?.status, "approved");

  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
  assert.equal(compiled.plan.status, "queued");
  assert.throws(
    () => store.workspace.markGenerationPlanCompileFailedIfApprovedForProject(
      project.id,
      plan.id,
      { code: "compiler-bug", message: "must not rewrite a queued Plan" },
    ),
    /approved|state/i,
  );
  assert.deepEqual(store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id), compiled);
  store.close();
});

test("durable Plan reads reject a terminal status that disagrees with Tasks and event history", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan } = createApprovedPlanShell(store);
  store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
  store.db.exec(`
    DROP TRIGGER generation_plan_status_transition_guard;
    DROP TRIGGER generation_plan_terminal_state_guard;
  `);
  store.db.prepare(
    "UPDATE generation_plans SET status = 'succeeded', finished_at = 99_999 WHERE id = ?",
  ).run(plan.id);

  assert.throws(
    () => store.workspace.getGenerationPlanForProject(project.id, plan.id),
    /terminal.*event|non-terminal Task/i,
  );
  assert.throws(
    () => store.workspace.getGenerationPlan(plan.id),
    /terminal.*event|non-terminal Task/i,
  );
  assert.throws(
    () => store.workspace.listGenerationPlans(project.id),
    /terminal.*event|non-terminal Task/i,
  );
  store.close();
});

test("Plan compilation creates or exactly reuses stable Component Instance identities and replay is idempotent", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, workspace, plan } = createApprovedComponentPlanShell(store, [
    "instance-created-by-compiler",
    "instance-reused-by-compiler",
  ]);
  store.db.prepare(
    `INSERT INTO component_instances
       (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "instance-reused-by-compiler",
    workspace.id,
    "generation-owner",
    "generation-component",
    19_999,
  );

  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
  assert.equal(compiled.plan.status, "queued");
  const identities = (store.db.prepare(
    `SELECT id, workspace_id, owner_artifact_id, component_artifact_id
     FROM component_instances WHERE id LIKE 'instance-%' ORDER BY id COLLATE BINARY ASC`,
  ).all() as Array<{
    id: string;
    workspace_id: string;
    owner_artifact_id: string;
    component_artifact_id: string;
  }>).map((row) => ({ ...row }));
  assert.deepEqual(identities, [
    {
      id: "instance-created-by-compiler",
      workspace_id: workspace.id,
      owner_artifact_id: "generation-owner",
      component_artifact_id: "generation-component",
    },
    {
      id: "instance-reused-by-compiler",
      workspace_id: workspace.id,
      owner_artifact_id: "generation-owner",
      component_artifact_id: "generation-component",
    },
  ]);

  assert.deepEqual(store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id), compiled);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM component_instances WHERE id LIKE 'instance-%'")
      .get() as { count: number }).count),
    2,
  );
  store.close();
});

test("a Component Instance identity collision rolls back construction and terminalizes compilation", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, workspace, plan } = createApprovedComponentPlanShell(store, [
    "a-instance-created-before-collision",
    "z-instance-collision",
  ]);
  store.db.prepare(
    `INSERT INTO component_instances
       (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "z-instance-collision",
    workspace.id,
    "generation-other-owner",
    "generation-component",
    19_999,
  );

  assert.throws(
    () => store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id),
    /Component Instance z-instance-collision identity collision/i,
  );
  const failedPlan = store.workspace.getGenerationPlan(plan.id);
  assert.equal(failedPlan?.status, "compile-failed");
  assert.equal(failedPlan?.constructionSealed, false);
  assert.equal(failedPlan?.compileError?.code, "invalid-reference");
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM component_instances WHERE id = ?")
      .get("a-instance-created-before-collision") as { count: number }).count),
    0,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_tasks WHERE plan_id = ?")
      .get(plan.id) as { count: number }).count),
    0,
  );
  const events = store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "plan-compile-failed");
  assert.equal(events[0]?.payload.code, "invalid-reference");
  store.close();
});

test("Plan compilation fails closed on corrupted active Artifact identity without mutating durable Plan state", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan } = createApprovedComponentPlanShell(store, ["instance-invalid-kind"]);
  store.db.exec(`
    DROP TRIGGER workspace_artifact_kind_update_immutable;
    DROP TRIGGER workspace_artifact_identity_update_immutable;
  `);
  store.db.prepare(
    "UPDATE workspace_artifacts SET kind = 'page' WHERE id = 'generation-component'",
  ).run();

  assert.throws(
    () => store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id),
    /generation-component.*same-Workspace Component|component.*kind|exact owned Revision pin/i,
  );
  const unchangedPlan = store.workspace.getGenerationPlan(plan.id);
  assert.equal(unchangedPlan?.status, "approved");
  assert.equal(unchangedPlan?.constructionSealed, false);
  assert.equal(unchangedPlan?.compileError, null);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM component_instances WHERE id = ?")
      .get("instance-invalid-kind") as { count: number }).count),
    0,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_tasks WHERE plan_id = ?")
      .get(plan.id) as { count: number }).count),
    0,
  );
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 }),
    [],
  );
  store.close();
});
