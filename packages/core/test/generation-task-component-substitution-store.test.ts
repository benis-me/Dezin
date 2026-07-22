import assert from "node:assert/strict";
import test from "node:test";

import {
  generationTaskCandidateEvidenceHash,
  Store,
  type StoreClock,
} from "../src/index.ts";

function fakeClock(): StoreClock {
  let now = 60_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `component-substitution-id-${++id}`,
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

function createComponentPagePlan(store: Store) {
  const project = store.createProject({ name: "Generated Component substitution", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [
      {
        id: "add-substitution-component",
        type: "add-node",
        node: {
          id: "substitution-component-node",
          kind: "component",
          name: "Generated Card",
          artifactId: "substitution-component",
          createIdentity: { initialTrackId: "substitution-component-track" },
        },
      },
      {
        id: "add-substitution-page",
        type: "add-node",
        node: {
          id: "substitution-page-node",
          kind: "page",
          name: "Generated Page",
          artifactId: "substitution-page",
          createIdentity: { initialTrackId: "substitution-page-track" },
        },
      },
    ],
  });
  const workspace = store.workspace.getWorkspace(project.id)!;
  const createBaseRevision = (artifactId: string, trackId: string) => store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash: (artifactId === "substitution-page" ? "1" : "3").repeat(40),
    sourceTreeHash: (artifactId === "substitution-page" ? "2" : "4").repeat(40),
    kernelRevisionId: workspace.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const oldPageRevision = createBaseRevision("substitution-page", "substitution-page-track");
  const pageSnapshot = store.workspace.publishArtifactRevision(oldPageRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const oldComponentRevision = createBaseRevision(
    "substitution-component",
    "substitution-component-track",
  );
  store.workspace.publishArtifactRevision(oldComponentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: pageSnapshot.id,
  });

  const approvedWorkspace = store.workspace.getWorkspace(project.id)!;
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: approvedWorkspace.graphRevision,
    baseSnapshotId: approvedWorkspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [],
    layoutOperations: [],
    generation: {
      ...emptyGeneration(),
      artifactPlans: [
        {
          operation: "revise",
          nodeId: "substitution-component-node",
          artifactId: "substitution-component",
          kind: "component",
          name: "Generated Card",
          trackId: "substitution-component-track",
          baseRevisionId: oldComponentRevision.id,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: ["desktop"],
        },
        {
          operation: "revise",
          nodeId: "substitution-page-node",
          artifactId: "substitution-page",
          kind: "page",
          name: "Generated Page",
          trackId: "substitution-page-track",
          baseRevisionId: oldPageRevision.id,
          dependsOnArtifactIds: ["substitution-component"],
          capabilityIds: [],
          responsiveFrameIds: ["desktop"],
        },
      ],
      dependencyPlans: [{
        kind: "component-instance",
        ownerArtifactId: "substitution-page",
        instanceId: "generated-card-instance",
        componentArtifactId: "substitution-component",
        componentRevisionId: null,
        variantKey: "featured",
        stateKey: "default",
        sourceLocator: { designNodeId: "generated-card-slot", selector: "[data-slot='card']" },
        overrides: { emphasis: "high" },
        status: "linked",
      }],
    },
    rationale: "Generate the Component before substituting it into the Page",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const componentTask = compiled.tasks.find((task) => task.kind === "component");
  const pageTask = compiled.tasks.find((task) => task.kind === "page");
  assert.ok(componentTask);
  assert.ok(pageTask);
  assert.deepEqual(pageTask.dependencyIds, [componentTask.id]);
  return {
    project,
    workspace: approvedWorkspace,
    plan: compiled.plan,
    componentTask,
    pageTask,
    oldComponentRevision,
    oldPageRevision,
  };
}

function persistArtifactContextPack(
  store: Store,
  input: {
    id: string;
    workspaceId: string;
    graphRevision: number;
    targetArtifactId: string;
    kernelRevisionId: string;
    artifactRevisions: Array<{ artifactId: string; revisionId: string; reason: string }>;
    checksumCharacter: string;
  },
) {
  const kernel = store.workspace.getKernelRevision(input.kernelRevisionId);
  assert.ok(kernel);
  const artifactItems = input.artifactRevisions.map((revision) => {
    const checksum = store.workspace.getArtifactRevisionContextChecksum(revision.revisionId);
    assert.ok(checksum);
    return {
      ref: { kind: "artifact" as const, id: revision.artifactId, revisionId: revision.revisionId },
      resolvedKind: "artifact-revision" as const,
      artifactRevisionId: revision.revisionId,
      checksum,
      reason: revision.reason,
      trustLevel: "trusted" as const,
      boundary: {},
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    };
  });
  const items = [
    {
      ref: { kind: "kernel" as const, id: kernel.id, revisionId: kernel.id },
      resolvedKind: "kernel-revision" as const,
      kernelRevisionId: kernel.id,
      checksum: kernel.checksum,
      reason: "design-kernel",
      trustLevel: "system" as const,
      boundary: {},
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    },
    ...artifactItems,
  ];
  return store.workspace.persistContextPack({
    id: input.id,
    workspaceId: input.workspaceId,
    graphRevision: input.graphRevision,
    target: { type: "artifact", id: input.targetArtifactId },
    intent: "generate",
    messageChecksum: input.checksumCharacter.repeat(64),
    items,
    omissions: [],
    tokenEstimate: items.length,
    manifestPath: `context-packs/${input.id}.json`,
    hash: input.checksumCharacter.repeat(64),
  });
}

test("a generated Component successor substitutes the old Head in its dependent Page Attempt", () => {
  const store = new Store(":memory:", fakeClock());
  try {
    const fixture = createComponentPagePlan(store);
    const componentObservation = store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.componentTask.id,
    );
    assert.equal(componentObservation.baseRevisionId, fixture.oldComponentRevision.id);
    assert.deepEqual(componentObservation.dependencyOutputs, []);
    assert.deepEqual(componentObservation.componentPins, []);
    const componentContext = persistArtifactContextPack(store, {
      id: "generated-component-context",
      workspaceId: fixture.workspace.id,
      graphRevision: fixture.workspace.graphRevision,
      targetArtifactId: "substitution-component",
      kernelRevisionId: componentObservation.kernelRevisionId,
      artifactRevisions: [{
        artifactId: "substitution-component",
        revisionId: fixture.oldComponentRevision.id,
        reason: "target-base",
      }],
      checksumCharacter: "a",
    });
    const componentAttempt = store.workspace.createGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        ...componentObservation,
        contextPackId: componentContext.id,
        sourceCommitHash: fixture.oldComponentRevision.sourceCommitHash,
        sourceTreeHash: fixture.oldComponentRevision.sourceTreeHash,
        retryContextPolicy: "same-context",
        executionMode: "full",
      },
    );
    const componentClaim = store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.componentTask.id,
      attempt: componentAttempt.attempt,
      ownerId: "component-substitution-worker",
      now: 70_000,
      leaseMs: 30_000,
    });
    assert.ok(componentClaim);

    const successorRevision = store.workspace.createArtifactRevision({
      artifactId: "substitution-component",
      trackId: "substitution-component-track",
      parentRevisionId: fixture.oldComponentRevision.id,
      sourceCommitHash: "successor-component-commit",
      sourceTreeHash: "successor-component-tree",
      kernelRevisionId: componentObservation.kernelRevisionId,
      renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 100, findings: [] },
      contextPackHash: componentContext.hash,
      dependencies: [],
      resourcePins: [],
    });
    const successorSnapshot = store.workspace.publishArtifactRevision(successorRevision.id, {
      expectedHeadRevisionId: fixture.oldComponentRevision.id,
      expectedSnapshotId: componentAttempt.expectedSnapshotId,
    });
    assert.equal(
      store.workspace.getTrack("substitution-component-track")?.headRevisionId,
      successorRevision.id,
    );

    const candidateEvidence = { checks: ["runtime", "visual"], quality: "passed" };
    const candidateEvidenceHash = generationTaskCandidateEvidenceHash({
      taskId: fixture.componentTask.id,
      planId: fixture.plan.id,
      workspaceId: fixture.workspace.id,
      attempt: componentAttempt.attempt,
      candidateRevisionId: successorRevision.id,
      candidateResourceRevisionId: null,
      candidateEvidence,
    });
    store.db.prepare(
      `UPDATE generation_task_attempts
       SET status = 'succeeded', candidate_revision_id = ?, candidate_evidence_json = ?,
           candidate_evidence_hash = ?, owner_id = NULL, lease_token = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL, finished_at = 70_001
       WHERE task_id = ? AND plan_id = ? AND attempt = ?`,
    ).run(
      successorRevision.id,
      JSON.stringify(candidateEvidence),
      candidateEvidenceHash,
      fixture.componentTask.id,
      fixture.plan.id,
      componentAttempt.attempt,
    );
    store.db.prepare(
      `UPDATE generation_tasks
       SET status = 'succeeded', result_revision_id = ?, result_snapshot_id = ?, finished_at = 70_001
       WHERE id = ? AND plan_id = ?`,
    ).run(successorRevision.id, successorSnapshot.id, fixture.componentTask.id, fixture.plan.id);
    store.db.prepare(
      "DELETE FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
    ).run(fixture.componentTask.id, componentAttempt.attempt);
    const sequence = Number((store.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM generation_plan_events WHERE plan_id = ?",
    ).get(fixture.plan.id) as { sequence: number }).sequence) + 1;
    store.db.prepare(
      `INSERT INTO generation_plan_events
         (plan_id, workspace_id, sequence, task_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'task-succeeded', ?, 70_001)`,
    ).run(
      fixture.plan.id,
      fixture.workspace.id,
      sequence,
      fixture.componentTask.id,
      JSON.stringify({
        attempt: componentAttempt.attempt,
        resultRevisionId: successorRevision.id,
        resultSnapshotId: successorSnapshot.id,
      }),
    );

    const completedComponent = store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((task) => task.id === fixture.componentTask.id);
    assert.equal(completedComponent?.resultRevisionId, successorRevision.id);
    assert.equal(completedComponent?.resultSnapshotId, successorSnapshot.id);

    const pageObservation = store.workspace.observeGenerationTaskMaterializationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    assert.equal(pageObservation.expectedSnapshotId, successorSnapshot.id);
    assert.equal(pageObservation.baseRevisionId, fixture.oldPageRevision.id);
    assert.deepEqual(pageObservation.dependencyOutputs, [{
      taskId: fixture.componentTask.id,
      resultRevisionId: successorRevision.id,
      resultResourceRevisionId: null,
      resultSnapshotId: successorSnapshot.id,
    }]);
    assert.deepEqual(
      pageObservation.componentPins.map((pin) => ({
        instanceId: pin.instanceId,
        revisionId: pin.revisionId,
        sourceTaskId: pin.sourceTaskId,
      })),
      [{
        instanceId: "generated-card-instance",
        revisionId: successorRevision.id,
        sourceTaskId: fixture.componentTask.id,
      }],
    );
    assert.notEqual(pageObservation.componentPins[0]?.revisionId, fixture.oldComponentRevision.id);

    const currentWorkspace = store.workspace.getWorkspace(fixture.project.id)!;
    const pageContext = persistArtifactContextPack(store, {
      id: "generated-page-context",
      workspaceId: fixture.workspace.id,
      graphRevision: currentWorkspace.graphRevision,
      targetArtifactId: "substitution-page",
      kernelRevisionId: pageObservation.kernelRevisionId,
      artifactRevisions: [
        {
          artifactId: "substitution-page",
          revisionId: fixture.oldPageRevision.id,
          reason: "target-base",
        },
        {
          artifactId: "substitution-component",
          revisionId: successorRevision.id,
          reason: "generated-component-pin",
        },
      ],
      checksumCharacter: "b",
    });
    const pageAttempt = store.workspace.createGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        ...pageObservation,
        contextPackId: pageContext.id,
        sourceCommitHash: fixture.oldPageRevision.sourceCommitHash,
        sourceTreeHash: fixture.oldPageRevision.sourceTreeHash,
        retryContextPolicy: "same-context",
        executionMode: "full",
      },
    );
    assert.deepEqual(
      pageAttempt.dependencyOutputs.map(({ ordinal: _ordinal, ...output }) => output),
      pageObservation.dependencyOutputs,
    );
    assert.equal(pageAttempt.componentPins[0]?.revisionId, successorRevision.id);
    assert.equal(pageAttempt.componentPins[0]?.sourceTaskId, fixture.componentTask.id);
    assert.notEqual(pageAttempt.componentPins[0]?.revisionId, fixture.oldComponentRevision.id);
    assert.deepEqual(
      store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
        pageAttempt.attempt,
      ),
      pageAttempt,
    );
  } finally {
    store.close();
  }
});
