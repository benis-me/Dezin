import assert from "node:assert/strict";
import test from "node:test";

import { Store, type StoreClock } from "../src/index.ts";

function fakeClock(): StoreClock {
  let now = 30_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `generation-materialization-id-${++id}`,
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

function createCompiledEmptyPlan(store: Store) {
  const project = store.createProject({ name: "Attempt materialization", mode: "standard" });
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
    rationale: "Materialize validation and checkpoint attempts",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const validation = compiled.tasks.find((task) => task.kind === "prototype-validation");
  const checkpoint = compiled.tasks.find((task) => task.kind === "checkpoint");
  assert.ok(validation);
  assert.ok(checkpoint);
  return { project, workspace, proposal, plan: compiled.plan, validation, checkpoint };
}

test("root Task materialization freezes one immutable Attempt and replays idempotently", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan, validation, checkpoint } = createCompiledEmptyPlan(store);

  assert.deepEqual(
    store.workspace.listGenerationTaskIdsReadyForMaterializationForProject(project.id, plan.id),
    [validation.id],
  );
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    plan.id,
    validation.id,
  );
  assert.equal(observation.attempt, 1);
  assert.equal(observation.taskId, validation.id);
  assert.equal(observation.expectedSnapshotId, plan.baseSnapshotId);
  assert.equal(observation.kernelRevisionId, store.workspace.getWorkspace(project.id)?.activeKernelRevisionId);
  assert.equal(observation.baseRevisionId, null);
  assert.equal(Object.hasOwn(observation, "sourceCommitHash"), false);
  assert.equal(Object.hasOwn(observation, "sourceTreeHash"), false);
  assert.deepEqual(observation.dependencyOutputs, []);
  assert.deepEqual(observation.resourcePins, []);
  assert.deepEqual(observation.componentPins, []);

  const input = {
    ...observation,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context" as const,
    executionMode: "full" as const,
  };
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, input);
  assert.equal(attempt.status, "queued");
  assert.equal(attempt.inputHash.length, 64);
  assert.deepEqual(
    store.workspace.getGenerationTaskAttemptForProject(project.id, plan.id, validation.id, 1),
    attempt,
  );
  assert.deepEqual(store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, input), attempt);
  assert.throws(
    () => store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, {
      ...input,
      executionMode: "publication-only",
    }),
    /already exists with different immutable input/i,
  );

  const detail = store.workspace.getGenerationPlanDetailForProject(project.id, plan.id);
  assert.equal(detail.tasks.find((task) => task.id === validation.id)?.currentAttempt, 1);
  assert.equal(detail.tasks.find((task) => task.id === validation.id)?.status, "queued");
  assert.equal(detail.tasks.find((task) => task.id === checkpoint.id)?.status, "materialization-pending");
  const events = store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 });
  assert.deepEqual(events.map((event) => event.type), ["plan-queued", "task-materialized"]);
  assert.equal(events[1]?.payload.attempt, 1);
  assert.equal(events[1]?.payload.inputHash, attempt.inputHash);
  assert.equal(events[1]?.payload.sourceCommitHash, null);
  assert.equal(events[1]?.payload.sourceTreeHash, null);

  const foreign = store.createProject({ name: "Foreign attempt reader", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(foreign.id);
  assert.throws(
    () => store.workspace.getGenerationTaskAttemptForProject(foreign.id, plan.id, validation.id, 1),
    /another Project|ownership/i,
  );
  store.close();
});

test("dependent Task materialization freezes the exact succeeded predecessor output tuple", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan, validation, checkpoint } = createCompiledEmptyPlan(store);

  assert.throws(
    () => store.workspace.observeGenerationTaskMaterializationForProject(
      project.id,
      plan.id,
      checkpoint.id,
    ),
    /dependencies.*succeeded|not ready/i,
  );
  const validationObservation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    plan.id,
    validation.id,
  );
  store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, {
    ...validationObservation,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  store.db.prepare(
    `UPDATE generation_task_attempts
     SET status = 'succeeded', started_at = 30_099, finished_at = 30_100
     WHERE task_id = ? AND attempt = 1`,
  ).run(validation.id);
  store.db.prepare(
    `UPDATE generation_tasks
     SET status = 'succeeded', finished_at = 30_100
     WHERE id = ? AND plan_id = ?`,
  ).run(validation.id, plan.id);
  store.db.prepare(
    `INSERT INTO generation_plan_events
       (plan_id, workspace_id, sequence, task_id, type, payload_json, created_at)
     VALUES (?, ?, 3, ?, 'task-succeeded', '{}', 30_100)`,
  ).run(plan.id, plan.workspaceId, validation.id);

  assert.deepEqual(
    store.workspace.listGenerationTaskIdsReadyForMaterializationForProject(project.id, plan.id),
    [checkpoint.id],
  );
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    plan.id,
    checkpoint.id,
  );
  assert.deepEqual(observation.dependencyOutputs, [{
    taskId: validation.id,
    resultRevisionId: null,
    resultResourceRevisionId: null,
    resultSnapshotId: null,
  }]);
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, {
    ...observation,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  assert.equal(attempt.status, "queued");
  assert.deepEqual(
    attempt.dependencyOutputs.map(({ ordinal: _ordinal, ...output }) => output),
    observation.dependencyOutputs,
  );
  store.close();
});

test("a stale materialization observation rolls back the Attempt, Task pointer, pins, and event", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan, validation } = createCompiledEmptyPlan(store);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    plan.id,
    validation.id,
  );
  store.workspace.publishSnapshot(project.id, {
    expectedSnapshotId: observation.expectedSnapshotId,
    reason: "concurrent-checkpoint",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "concurrent-proposal",
      planId: "concurrent-plan",
      checkpointId: "concurrent-checkpoint",
    },
  });

  assert.throws(
    () => store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, {
      ...observation,
      contextPackId: null,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
    /active Snapshot|stale|expected Snapshot/i,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_task_attempts WHERE task_id = ?")
      .get(validation.id) as { count: number }).count),
    0,
  );
  assert.equal(
    Number((store.db.prepare("SELECT current_attempt FROM generation_tasks WHERE id = ?")
      .get(validation.id) as { current_attempt: number }).current_attempt),
    0,
  );
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 })
      .map((event) => event.type),
    ["plan-queued"],
  );
  store.close();
});

test("Artifact create materialization freezes a daemon-resolved Source Base without inventing Git facts in Core", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Created Artifact Source Base", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [{
      id: "add-source-base-page",
      type: "add-node",
      node: {
        id: "source-base-page-node",
        kind: "page",
        name: "Source Base Page",
        artifactId: "source-base-page",
        createIdentity: { initialTrackId: "source-base-page-track" },
      },
    }],
    layoutOperations: [],
    generation: {
      ...emptyGeneration(),
      artifactPlans: [{
        operation: "create",
        nodeId: "source-base-page-node",
        artifactId: "source-base-page",
        kind: "page",
        name: "Source Base Page",
        trackId: "source-base-page-track",
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      }],
    },
    rationale: "Freeze daemon Git identity before the first Artifact Attempt",
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
  assert.equal(observation.baseRevisionId, null);
  assert.equal(Object.hasOwn(observation, "sourceCommitHash"), false);
  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  const activeWorkspace = store.workspace.getWorkspace(project.id);
  assert.ok(kernel);
  assert.ok(activeWorkspace);
  const pack = store.workspace.persistContextPack({
    id: "source-base-page-context",
    workspaceId: activeWorkspace.id,
    graphRevision: activeWorkspace.graphRevision,
    target: { type: "artifact", id: "source-base-page" },
    intent: "generate",
    messageChecksum: "7".repeat(64),
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
    manifestPath: "context-packs/source-base-page.json",
    hash: "8".repeat(64),
  });
  const sourceCommitHash = "5".repeat(40);
  const sourceTreeHash = "6".repeat(40);
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
    ...observation,
    contextPackId: pack.id,
    sourceCommitHash,
    sourceTreeHash,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  assert.equal(attempt.sourceCommitHash, sourceCommitHash);
  assert.equal(attempt.sourceTreeHash, sourceTreeHash);
  const event = store.workspace.listGenerationPlanEventsForProject(
    project.id,
    compiled.plan.id,
    { after: 0, limit: 100 },
  ).find((candidate) => candidate.type === "task-materialized");
  assert.equal(event?.payload.sourceCommitHash, sourceCommitHash);
  assert.equal(event?.payload.sourceTreeHash, sourceTreeHash);
  store.close();
});

function createPinnedPagePlan(store: Store) {
  const project = store.createProject({ name: "Pinned Page materialization", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [
      {
        id: "add-pinned-page",
        type: "add-node",
        node: {
          id: "pinned-page-node",
          kind: "page",
          name: "Pinned Page",
          artifactId: "pinned-page",
          createIdentity: { initialTrackId: "pinned-page-track" },
        },
      },
      {
        id: "add-pinned-component",
        type: "add-node",
        node: {
          id: "pinned-component-node",
          kind: "component",
          name: "Pinned Component",
          artifactId: "pinned-component",
          createIdentity: { initialTrackId: "pinned-component-track" },
        },
      },
    ],
  });
  const active = store.workspace.getWorkspace(project.id)!;
  const createRevision = (artifactId: string, trackId: string) => store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash: artifactId === "pinned-page" ? "1".repeat(40) : "3".repeat(40),
    sourceTreeHash: artifactId === "pinned-page" ? "2".repeat(40) : "4".repeat(40),
    kernelRevisionId: active.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const pageRevision = createRevision("pinned-page", "pinned-page-track");
  const pageSnapshot = store.workspace.publishArtifactRevision(pageRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const componentRevision = createRevision("pinned-component", "pinned-component-track");
  const componentSnapshot = store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: pageSnapshot.id,
  });
  const createdResource = store.workspace.createResourceForProject(project.id, {
    kind: "asset",
    title: "Pinned Asset",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: componentSnapshot.graphRevision,
    expectedSnapshotId: componentSnapshot.id,
  });
  const resourceRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    createdResource.resource.id,
    {
      revisionId: "pinned-asset-revision",
      parentRevisionId: null,
      manifestPath: "resource-revisions/pinned-asset/manifest.json",
      summary: "Exact pinned asset",
      metadata: { mimeType: "image/png" },
      checksum: "a".repeat(64),
      provenance: { source: "fixture" },
    },
  );
  const resourceSnapshot = store.workspace.publishResourceRevisionForProject(
    project.id,
    createdResource.resource.id,
    resourceRevision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: createdResource.snapshot.id,
      reason: "publish exact fixture",
    },
  );
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
        operation: "reuse",
        nodeId: createdResource.node.id,
        resourceId: createdResource.resource.id,
        kind: createdResource.resource.kind,
        title: createdResource.resource.title,
        revisionPolicy: { kind: "exact", resourceRevisionId: resourceRevision.id },
      }],
      artifactPlans: [{
        operation: "revise",
        nodeId: "pinned-page-node",
        artifactId: "pinned-page",
        kind: "page",
        name: "Pinned Page",
        trackId: "pinned-page-track",
        baseRevisionId: pageRevision.id,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      }],
      dependencyPlans: [
        {
          kind: "resource",
          ownerArtifactId: "pinned-page",
          resourceId: createdResource.resource.id,
        },
        {
          kind: "component-instance",
          ownerArtifactId: "pinned-page",
          instanceId: "pinned-instance-a",
          componentArtifactId: "pinned-component",
          componentRevisionId: componentRevision.id,
          variantKey: "compact",
          stateKey: "idle",
          sourceLocator: { designNodeId: "slot-a", selector: "[data-slot='a']" },
          overrides: { label: "First" },
          status: "linked",
        },
        {
          kind: "component-instance",
          ownerArtifactId: "pinned-page",
          instanceId: "pinned-instance-b",
          componentArtifactId: "pinned-component",
          componentRevisionId: componentRevision.id,
          variantKey: "wide",
          stateKey: "active",
          sourceLocator: { designNodeId: "slot-b", selector: "[data-slot='b']" },
          overrides: { label: "Second", emphasis: true },
          status: "detached",
        },
      ],
    },
    rationale: "Freeze distinct Component instance state and Resource context",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const pageTask = compiled.tasks.find((task) => task.kind === "page");
  assert.ok(pageTask);
  assert.equal(resourceSnapshot.id, workspace.activeSnapshotId);
  return {
    project,
    workspace,
    plan: compiled.plan,
    pageTask,
    pageRevision,
    componentRevision,
    resource: createdResource.resource,
    resourceRevision,
  };
}

test("Artifact materialization preserves distinct Component instances and requires complete exact Context", () => {
  const store = new Store(":memory:", fakeClock());
  const fixture = createPinnedPagePlan(store);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.pageTask.id,
  );
  assert.equal(observation.baseRevisionId, fixture.pageRevision.id);
  assert.deepEqual(observation.resourcePins, [{
    resourceId: fixture.resource.id,
    revisionId: fixture.resourceRevision.id,
    sourceTaskId: null,
  }]);
  assert.deepEqual(
    observation.componentPins.map((pin) => ({
      instanceId: pin.instanceId,
      revisionId: pin.revisionId,
      variantKey: pin.variantKey,
      stateKey: pin.stateKey,
      overrides: pin.overrides,
      status: pin.status,
    })),
    [
      {
        instanceId: "pinned-instance-a",
        revisionId: fixture.componentRevision.id,
        variantKey: "compact",
        stateKey: "idle",
        overrides: { label: "First" },
        status: "linked",
      },
      {
        instanceId: "pinned-instance-b",
        revisionId: fixture.componentRevision.id,
        variantKey: "wide",
        stateKey: "active",
        overrides: { emphasis: true, label: "Second" },
        status: "detached",
      },
    ],
  );

  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  const pageChecksum = store.workspace.getArtifactRevisionContextChecksum(fixture.pageRevision.id);
  const componentChecksum = store.workspace.getArtifactRevisionContextChecksum(fixture.componentRevision.id);
  assert.ok(kernel);
  assert.ok(pageChecksum);
  assert.ok(componentChecksum);
  const contextItems = [
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
    {
      ref: { kind: "artifact" as const, id: "pinned-page", revisionId: fixture.pageRevision.id },
      resolvedKind: "artifact-revision" as const,
      artifactRevisionId: fixture.pageRevision.id,
      checksum: pageChecksum,
      reason: "target-base",
      trustLevel: "trusted" as const,
      boundary: {},
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    },
    {
      ref: { kind: "artifact" as const, id: "pinned-component", revisionId: fixture.componentRevision.id },
      resolvedKind: "artifact-revision" as const,
      artifactRevisionId: fixture.componentRevision.id,
      checksum: componentChecksum,
      reason: "component-pin",
      trustLevel: "trusted" as const,
      boundary: {},
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    },
    {
      ref: {
        kind: "resource" as const,
        id: fixture.resource.id,
        resourceKind: fixture.resource.kind,
        revisionId: fixture.resourceRevision.id,
      },
      resolvedKind: "resource-revision" as const,
      resourceRevisionId: fixture.resourceRevision.id,
      checksum: fixture.resourceRevision.checksum,
      reason: "resource-pin",
      trustLevel: "trusted" as const,
      boundary: {},
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    },
  ];
  const incompletePack = store.workspace.persistContextPack({
    id: "pinned-page-incomplete-pack",
    workspaceId: fixture.workspace.id,
    graphRevision: fixture.workspace.graphRevision,
    target: { type: "artifact", id: "pinned-page" },
    intent: "generate",
    messageChecksum: "b".repeat(64),
    items: contextItems.slice(0, 2),
    omissions: [],
    tokenEstimate: 2,
    manifestPath: "context-packs/pinned-page-incomplete.json",
    hash: "c".repeat(64),
  });
  assert.throws(
    () => store.workspace.createGenerationTaskAttemptForProject(fixture.project.id, fixture.plan.id, {
      ...observation,
      contextPackId: incompletePack.id,
      sourceCommitHash: fixture.pageRevision.sourceCommitHash,
      sourceTreeHash: fixture.pageRevision.sourceTreeHash,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
    /Context Pack omits.*required|Component Revision|Resource/i,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_task_attempts WHERE task_id = ?")
      .get(fixture.pageTask.id) as { count: number }).count),
    0,
  );

  const completePack = store.workspace.persistContextPack({
    id: "pinned-page-complete-pack",
    workspaceId: fixture.workspace.id,
    graphRevision: fixture.workspace.graphRevision,
    target: { type: "artifact", id: "pinned-page" },
    intent: "generate",
    messageChecksum: "d".repeat(64),
    items: contextItems,
    omissions: [],
    tokenEstimate: 4,
    manifestPath: "context-packs/pinned-page-complete.json",
    hash: "e".repeat(64),
  });
  assert.throws(
    () => store.workspace.createGenerationTaskAttemptForProject(fixture.project.id, fixture.plan.id, {
      ...observation,
      contextPackId: completePack.id,
      sourceCommitHash: "f".repeat(40),
      sourceTreeHash: fixture.pageRevision.sourceTreeHash,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
    /Source Base|base Revision|source commit/i,
  );
  assert.equal(
    Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_attempts WHERE task_id = ?",
    ).get(fixture.pageTask.id) as { count: number }).count),
    0,
    "a mismatched base Revision pair must roll back the entire materialization",
  );
  const attempt = store.workspace.createGenerationTaskAttemptForProject(fixture.project.id, fixture.plan.id, {
    ...observation,
    contextPackId: completePack.id,
    sourceCommitHash: fixture.pageRevision.sourceCommitHash,
    sourceTreeHash: fixture.pageRevision.sourceTreeHash,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  assert.equal(attempt.contextPackId, completePack.id);
  assert.equal(attempt.componentPins.length, 2);
  assert.equal(attempt.resourcePins.length, 1);
  assert.notDeepEqual(attempt.componentPins[0]?.overrides, attempt.componentPins[1]?.overrides);
  assert.throws(
    () => store.workspace.createGenerationTaskAttemptForProject(fixture.project.id, fixture.plan.id, {
      ...observation,
      contextPackId: completePack.id,
      sourceCommitHash: "9".repeat(40),
      sourceTreeHash: fixture.pageRevision.sourceTreeHash,
      retryContextPolicy: "same-context",
      executionMode: "full",
    }),
    /already exists with different immutable input/i,
  );
  store.close();
});

test("missing required Context records an isolated actionable blocked-context failure", () => {
  const store = new Store(":memory:", fakeClock());
  const fixture = createPinnedPagePlan(store);
  const failure = store.workspace.recordGenerationTaskMaterializationFailureForProject(
    fixture.project.id,
    fixture.plan.id,
    {
      taskId: fixture.pageTask.id,
      expectedFailureCount: 0,
      failureClass: "context",
      error: {
        code: "missing-required-context",
        message: "Component pin pinned-instance-a was not provided",
        refs: ["pinned-instance-a"],
      },
      nextEligibleAt: null,
    },
  );
  assert.equal(failure.sequence, 1);
  assert.equal(failure.failureClass, "context");
  assert.equal(failure.nextEligibleAt, null);
  assert.deepEqual(
    store.workspace.listGenerationTaskMaterializationFailuresForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    ),
    [failure],
  );
  const detail = store.workspace.getGenerationPlanDetailForProject(fixture.project.id, fixture.plan.id);
  const failedTask = detail.tasks.find((task) => task.id === fixture.pageTask.id);
  assert.equal(failedTask?.status, "blocked-context");
  assert.equal(failedTask?.pendingContextPolicy, "latest-context");
  assert.equal(failedTask?.blockedReason, "Component pin pinned-instance-a was not provided");
  assert.equal(failedTask?.currentAttempt, 0);
  assert.equal(failedTask?.materializationFailures, 1);
  assert.ok(detail.tasks.filter((task) => task.id !== fixture.pageTask.id)
    .every((task) => task.status === "materialization-pending"));
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM generation_task_attempts WHERE task_id = ?")
      .get(fixture.pageTask.id) as { count: number }).count),
    0,
  );
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(fixture.project.id, fixture.plan.id, { after: 0, limit: 100 })
      .slice(-2)
      .map((event) => event.type),
    ["task-materialization-failed", "task-blocked-context"],
  );
  store.close();
});

test("materialization failure recording replays an exact lost response without duplicating history", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan, validation } = createCompiledEmptyPlan(store);
  const input = {
    taskId: validation.id,
    expectedFailureCount: 0,
    failureClass: "provider" as const,
    error: {
      code: "provider-unavailable",
      message: "Provider did not acknowledge the request",
    },
    nextEligibleAt: null,
  };

  const first = store.workspace.recordGenerationTaskMaterializationFailureForProject(
    project.id,
    plan.id,
    input,
  );
  const eventsAfterFirstResponse = store.workspace.listGenerationPlanEventsForProject(
    project.id,
    plan.id,
    { after: 0, limit: 100 },
  );

  const replay = store.workspace.recordGenerationTaskMaterializationFailureForProject(
    project.id,
    plan.id,
    input,
  );
  assert.deepEqual(replay, first);
  assert.equal(
    store.workspace.getGenerationPlanDetailForProject(project.id, plan.id)
      .tasks.find((task) => task.id === validation.id)?.materializationFailures,
    1,
  );
  assert.deepEqual(
    store.workspace.listGenerationTaskMaterializationFailuresForProject(project.id, plan.id, validation.id),
    [first],
  );
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 }),
    eventsAfterFirstResponse,
  );

  assert.throws(
    () => store.workspace.recordGenerationTaskMaterializationFailureForProject(
      project.id,
      plan.id,
      {
        ...input,
        error: {
          code: "provider-unavailable",
          message: "A different failure cannot reuse the same expected count",
        },
      },
    ),
    /expected failure count|different.*failure|conflict|already recorded/i,
  );
  assert.equal(
    store.workspace.listGenerationTaskMaterializationFailuresForProject(project.id, plan.id, validation.id).length,
    1,
  );
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 }),
    eventsAfterFirstResponse,
  );
  store.close();
});

test("a needs-rebase successor materialization failure preserves publication-only retry semantics", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan, validation } = createCompiledEmptyPlan(store);
  const firstObservation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    plan.id,
    validation.id,
  );
  const firstAttempt = store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, {
    ...firstObservation,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  store.db.prepare(
    `UPDATE generation_task_attempts
     SET status = 'needs-rebase', started_at = 30_100, finished_at = 30_101
     WHERE task_id = ? AND attempt = ?`,
  ).run(validation.id, firstAttempt.attempt);
  store.db.prepare(
    "UPDATE generation_tasks SET status = 'needs-rebase' WHERE id = ? AND plan_id = ?",
  ).run(validation.id, plan.id);

  const failure = store.workspace.recordGenerationTaskMaterializationFailureForProject(
    project.id,
    plan.id,
    {
      taskId: validation.id,
      expectedFailureCount: 0,
      failureClass: "provider",
      error: { code: "publication-adapter-unavailable" },
      nextEligibleAt: null,
    },
  );
  assert.equal(failure.sequence, 1);
  const retrying = store.workspace.getGenerationPlanDetailForProject(project.id, plan.id)
    .tasks.find((task) => task.id === validation.id);
  assert.equal(retrying?.status, "retry-wait");
  assert.equal(retrying?.currentAttempt, 1);
  assert.equal(
    store.workspace.getGenerationTaskAttemptForProject(project.id, plan.id, validation.id, 1)?.status,
    "needs-rebase",
  );

  store.db.prepare("UPDATE generation_tasks SET next_eligible_at = 0 WHERE id = ?").run(validation.id);
  const retryObservation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    plan.id,
    validation.id,
  );
  const retryAttempt = store.workspace.createGenerationTaskAttemptForProject(project.id, plan.id, {
    ...retryObservation,
    contextPackId: null,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "publication-only",
  });
  assert.equal(retryAttempt.attempt, 2);
  assert.equal(retryAttempt.executionMode, "publication-only");
  store.close();
});

test("fourth transient materialization failure blocks descendants and terminalizes an exhausted Plan", () => {
  const store = new Store(":memory:", fakeClock());
  const { project, plan, validation, checkpoint } = createCompiledEmptyPlan(store);
  const expectedDelays = [1_000, 4_000, 16_000];
  for (let index = 0; index < 4; index += 1) {
    const failure = store.workspace.recordGenerationTaskMaterializationFailureForProject(
      project.id,
      plan.id,
      {
        taskId: validation.id,
        expectedFailureCount: index,
        failureClass: "provider",
        error: { code: "provider-unavailable", occurrence: index + 1 },
        nextEligibleAt: null,
      },
    );
    assert.equal(failure.sequence, index + 1);
    if (index < expectedDelays.length) {
      assert.equal(failure.nextEligibleAt! - failure.createdAt, expectedDelays[index]);
      const task = store.workspace.getGenerationPlanDetailForProject(project.id, plan.id)
        .tasks.find((candidate) => candidate.id === validation.id);
      assert.equal(task?.status, "retry-wait");
      assert.equal(task?.nextEligibleAt, failure.nextEligibleAt);
      store.db.prepare(
        "UPDATE generation_tasks SET next_eligible_at = 0 WHERE id = ?",
      ).run(validation.id);
    } else {
      assert.equal(failure.nextEligibleAt, null);
    }
  }
  const terminalEvents = store.workspace.listGenerationPlanEventsForProject(
    project.id,
    plan.id,
    { after: 0, limit: 100 },
  );
  const terminalReplay = store.workspace.recordGenerationTaskMaterializationFailureForProject(
    project.id,
    plan.id,
    {
      taskId: validation.id,
      expectedFailureCount: 3,
      failureClass: "provider",
      error: { code: "provider-unavailable", occurrence: 4 },
      nextEligibleAt: null,
    },
  );
  assert.equal(terminalReplay.sequence, 4);
  assert.deepEqual(
    store.workspace.listGenerationPlanEventsForProject(project.id, plan.id, { after: 0, limit: 100 }),
    terminalEvents,
  );
  const detail = store.workspace.getGenerationPlanDetailForProject(project.id, plan.id);
  const failedTask = detail.tasks.find((task) => task.id === validation.id);
  assert.equal(failedTask?.status, "failed");
  assert.equal(failedTask?.materializationFailures, 4);
  assert.equal(failedTask?.currentAttempt, 0);
  assert.ok(failedTask?.finishedAt !== null);
  assert.equal(
    store.workspace.listGenerationTaskMaterializationFailuresForProject(project.id, plan.id, validation.id).length,
    4,
  );
  const blockedCheckpoint = detail.tasks.find((task) => task.id === checkpoint.id);
  assert.equal(blockedCheckpoint?.status, "blocked");
  assert.equal(blockedCheckpoint?.blockedByTaskId, validation.id);
  assert.ok(blockedCheckpoint?.finishedAt !== null);
  assert.equal(detail.plan.status, "failed");
  assert.ok(detail.plan.finishedAt !== null);
  assert.deepEqual(
    store.workspace.listGenerationTaskIdsReadyForMaterializationForProject(project.id, plan.id),
    [],
  );
  const events = store.workspace.listGenerationPlanEventsForProject(
    project.id,
    plan.id,
    { after: 0, limit: 100 },
  );
  const blockedEvents = events.filter((event) => event.type === "task-blocked");
  assert.equal(blockedEvents.length, 1);
  assert.equal(blockedEvents[0]?.taskId, checkpoint.id);
  const failedPlanEvents = events.filter((event) => event.type === "plan-failed");
  assert.equal(failedPlanEvents.length, 1);
  assert.equal(failedPlanEvents[0]?.taskId, null);
  assert.equal(events.at(-1)?.type, "plan-failed");
  store.close();
});

test("Resource Task materialization freezes the active Resource base and Resource-scoped Context", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Resource Task materialization", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: "Research brief",
    defaultPinPolicy: "follow-head",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const baseRevision = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
    revisionId: "research-base-revision",
    parentRevisionId: null,
    manifestPath: "resource-revisions/research-base/manifest.json",
    summary: "Initial research",
    metadata: { source: "brief" },
    checksum: "1".repeat(64),
    provenance: { source: "fixture" },
  });
  store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, baseRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
    reason: "publish research base",
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
    rationale: "Generate a successor Research Revision",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const task = compiled.tasks.find((candidate) => candidate.kind === "resource");
  assert.ok(task);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    task.id,
  );
  assert.equal(observation.baseRevisionId, baseRevision.id);
  assert.deepEqual(observation.target, {
    type: "resource",
    workspaceId: workspace.id,
    id: created.resource.id,
  });
  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  assert.ok(kernel);
  const pack = store.workspace.persistContextPack({
    id: "resource-task-context-pack",
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "resource", id: created.resource.id },
    intent: "generate",
    messageChecksum: "2".repeat(64),
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
          id: created.resource.id,
          resourceKind: created.resource.kind,
          revisionId: baseRevision.id,
        },
        resolvedKind: "resource-revision",
        resourceRevisionId: baseRevision.id,
        checksum: baseRevision.checksum,
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
    manifestPath: "context-packs/resource-task.json",
    hash: "3".repeat(64),
  });
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
    ...observation,
    contextPackId: pack.id,
    sourceCommitHash: null,
    sourceTreeHash: null,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  assert.equal(attempt.baseRevisionId, baseRevision.id);
  assert.equal(attempt.contextPackId, pack.id);
  assert.deepEqual(attempt.resourcePins, []);
  assert.deepEqual(attempt.dependencyOutputs, []);
  store.close();
});
