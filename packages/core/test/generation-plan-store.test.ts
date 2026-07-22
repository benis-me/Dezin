import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface EmptyArtifactShell {
  artifactId: string;
  nodeId: string;
  trackId: string;
  name: string;
}

function addEmptyPageShell(store: Store, projectId: string, shell: EmptyArtifactShell) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  return store.workspace.applyGraphCommands(projectId, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: `add-${shell.nodeId}`,
      type: "add-node" as const,
      node: {
        id: shell.nodeId,
        kind: "page" as const,
        name: shell.name,
        artifactId: shell.artifactId,
        createIdentity: { initialTrackId: shell.trackId },
      },
    }],
  });
}

function createEmptyShellProposal(store: Store, projectId: string, shell: EmptyArtifactShell) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  const layout = store.workspace.getLayout(projectId);
  return store.workspace.createProposal({
    projectId,
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
        operation: "create" as const,
        nodeId: shell.nodeId,
        artifactId: shell.artifactId,
        kind: "page" as const,
        name: shell.name,
        trackId: shell.trackId,
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      }],
    },
    rationale: "Claim one exact active empty Artifact shell",
    assumptions: [],
  });
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
  const ownerSnapshot = store.workspace.publishArtifactRevision(ownerRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: ownerSnapshot.id,
  });
  const proposalWorkspace = store.workspace.getWorkspace(project.id)!;
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: proposalWorkspace.graphRevision,
    baseSnapshotId: proposalWorkspace.activeSnapshotId,
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
  return { project, workspace: proposalWorkspace, proposal, approved, plan: approved.plan };
}

test("an approved Plan shell compiles exactly once into a normalized durable DAG", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan } = createApprovedPlanShell(store);

  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id);
  assert.equal(compiled.plan.status, "queued");
  assert.deepEqual(store.workspace.listActiveGenerationPlanIdsForProject(project.id), [plan.id]);
  assert.ok((store.db.prepare("PRAGMA index_list('generation_plans')").all() as Array<{ name: string }>)
    .some((index) => index.name === "idx_generation_plans_active"));
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

test("an exact Research direction selection survives restart inside the immutable Artifact Task intent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-research-selection-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "store.db");
  const store = new Store(databasePath, fakeClock());
  const project = store.createProject({ name: "Durable Research selection", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const research = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Existing Research",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    research.resource.id,
    {
      revisionId: "research-revision-selected",
      parentRevisionId: null,
      manifestPath: "resource-revisions/research-selected/manifest.json",
      summary: "Existing immutable Research",
      metadata: { mimeType: "application/json" },
      checksum: "a".repeat(64),
      provenance: { source: "test" },
    },
  );
  const resourceSnapshot = store.workspace.publishResourceRevisionForProject(
    project.id,
    research.resource.id,
    revision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: research.snapshot.id,
      reason: "seed selected Research",
    },
  );
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: research.snapshot.graphRevision,
    expectedSnapshotId: resourceSnapshot.id,
    commands: [{
      id: "add-selected-page-shell",
      type: "add-node",
      node: {
        id: "selected-page-node",
        kind: "page",
        name: "Selected Page",
        artifactId: "selected-page",
        createIdentity: { initialTrackId: "selected-page-track" },
      },
    }],
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  const layout = store.workspace.getLayout(project.id);
  const selection = {
    protocol: "dezin.research-direction-selection.v1" as const,
    version: 1 as const,
    resourceId: research.resource.id,
    revisionId: revision.id,
    directionId: "quiet-editorial",
  };
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
        operation: "reuse",
        nodeId: research.node.id,
        resourceId: research.resource.id,
        kind: "research",
        title: research.resource.title,
        revisionPolicy: { kind: "exact", resourceRevisionId: revision.id },
      }],
      artifactPlans: [{
        operation: "create",
        nodeId: "selected-page-node",
        artifactId: "selected-page",
        kind: "page",
        name: "Selected Page",
        trackId: "selected-page-track",
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
        researchDirectionSelection: selection,
      }],
      dependencyPlans: [{
        kind: "resource",
        ownerArtifactId: "selected-page",
        resourceId: research.resource.id,
      }],
    },
    rationale: "Use the exact explicitly selected direction",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const page = compiled.tasks.find((task) => task.target.id === "selected-page");
  assert.ok(page);
  assert.deepEqual((page.payload.artifactPlan as Record<string, unknown>).researchDirectionSelection, selection);
  store.close();

  const restarted = new Store(databasePath, fakeClock());
  t.after(() => restarted.close());
  const restartedPage = restarted.workspace
    .getGenerationPlanDetailForProject(project.id, approved.plan.id)
    .tasks.find((task) => task.target.id === "selected-page");
  assert.ok(restartedPage);
  assert.deepEqual(
    (restartedPage.payload.artifactPlan as Record<string, unknown>).researchDirectionSelection,
    selection,
  );
  assert.throws(
    () => restarted.db.prepare(
      `UPDATE generation_tasks
       SET payload_json = json_set(
         payload_json,
         '$.artifactPlan.researchDirectionSelection.directionId',
         'forged-after-restart'
       )
       WHERE id = ?`,
    ).run(restartedPage.id),
    /immutable/i,
  );
});

test("Artifact create may only claim an exact owned active shell with a null Head and zero Revisions", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Empty shell admission", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const revisionOnly = {
    artifactId: "revision-only-shell",
    nodeId: "revision-only-shell-node",
    trackId: "revision-only-shell-track",
    name: "Revision only shell",
  };
  const headed = {
    artifactId: "headed-shell",
    nodeId: "headed-shell-node",
    trackId: "headed-shell-track",
    name: "Headed shell",
  };
  const inactive = {
    artifactId: "inactive-shell",
    nodeId: "inactive-shell-node",
    trackId: "inactive-shell-track",
    name: "Inactive shell",
  };
  const archived = {
    artifactId: "archived-shell",
    nodeId: "archived-shell-node",
    trackId: "archived-shell-track",
    name: "Archived shell",
  };
  for (const shell of [revisionOnly, headed, inactive, archived]) {
    addEmptyPageShell(store, project.id, shell);
  }
  const workspace = store.workspace.getWorkspace(project.id)!;
  const createRevision = (shell: EmptyArtifactShell, byte: string) => store.workspace.createArtifactRevision({
    artifactId: shell.artifactId,
    trackId: shell.trackId,
    parentRevisionId: null,
    sourceCommitHash: byte.repeat(40),
    sourceTreeHash: byte.repeat(40),
    kernelRevisionId: workspace.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  createRevision(revisionOnly, "1");
  const headedRevision = createRevision(headed, "2");
  const headedSnapshot = store.workspace.publishArtifactRevision(headedRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: headedSnapshot.id,
    commands: [{ id: "archive-empty-shell", type: "archive-node", nodeId: archived.nodeId }],
  });
  store.db.prepare(
    `INSERT INTO artifact_tracks
       (id, artifact_id, name, head_revision_id, legacy_variant_id, created_at)
     VALUES ('inactive-shell-other-track', ?, 'other', NULL, NULL, ?)`,
  ).run(inactive.artifactId, 30_000);
  store.db.prepare(
    "UPDATE workspace_artifacts SET active_track_id = 'inactive-shell-other-track' WHERE id = ?",
  ).run(inactive.artifactId);

  for (const shell of [revisionOnly, headed, inactive]) {
    const proposal = createEmptyShellProposal(store, project.id, shell);
    assert.throws(
      () => store.workspace.approveProposalForProject(project.id, proposal.id, "generate"),
      /exact owned active empty shell/i,
    );
  }
  const archivedProposal = createEmptyShellProposal(store, project.id, archived);
  assert.throws(
    () => store.workspace.approveProposalForProject(project.id, archivedProposal.id, "generate"),
    /missing generation dependency Artifact/i,
  );

  const foreignProject = store.createProject({ name: "Foreign shell owner", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(foreignProject.id);
  const foreign = {
    artifactId: "foreign-empty-shell",
    nodeId: "foreign-empty-shell-node",
    trackId: "foreign-empty-shell-track",
    name: "Foreign empty shell",
  };
  addEmptyPageShell(store, foreignProject.id, foreign);
  const foreignProposal = createEmptyShellProposal(store, project.id, foreign);
  assert.throws(
    () => store.workspace.approveProposalForProject(project.id, foreignProposal.id, "generate"),
    /missing generation dependency Artifact/i,
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
  assert.deepEqual(store.workspace.listActiveGenerationPlanIdsForProject(project.id), []);
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

test("recovery compilation terminalizes a pre-admission approved shell with an unsupported generated Resource", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, proposal, plan } = createApprovedPlanShell(store);
  const legacyGeneration = {
    ...emptyGeneration(),
    resourceOperations: [{
      operation: "create" as const,
      nodeId: "legacy-file-node",
      resourceId: "legacy-file",
      kind: "file" as const,
      title: "Legacy generated file",
      revisionPolicy: { kind: "generate" as const },
    }],
  };
  const audit = store.db.prepare(
    "SELECT payload_json FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = ?",
  ).get(proposal.id, proposal.revision) as { payload_json: string };
  const legacyAudit = JSON.parse(audit.payload_json) as Record<string, unknown>;
  legacyAudit.generation = legacyGeneration;
  store.db.exec("DROP TRIGGER workspace_proposal_audit_update_immutable");
  store.db.prepare(
    "UPDATE workspace_proposals SET generation_payload_json = ? WHERE id = ?",
  ).run(JSON.stringify(legacyGeneration), proposal.id);
  store.db.prepare(
    "UPDATE workspace_proposal_audit SET payload_json = ? WHERE proposal_id = ? AND revision = ?",
  ).run(JSON.stringify(legacyAudit), proposal.id, proposal.revision);

  assert.throws(
    () => store.workspace.compileApprovedGenerationPlanForProject(project.id, plan.id),
    /explicit owned source|cannot be Agent-generated/i,
  );
  const failed = store.workspace.getGenerationPlanForProject(project.id, plan.id);
  assert.equal(failed.status, "compile-failed");
  assert.equal(failed.constructionSealed, false);
  assert.equal(failed.compileError?.code, "unsupported-resource-kind");
  const compileDetails = failed.compileError?.details;
  assert.ok(compileDetails !== null && typeof compileDetails === "object" && !Array.isArray(compileDetails));
  assert.equal((compileDetails as Record<string, unknown>).resourceKind, "file");
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_tasks WHERE plan_id = ?")
      .get(plan.id) as { count: number }).count),
    0,
  );
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 10 })
      .map((event) => event.type),
    ["plan-compile-failed"],
  );
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
