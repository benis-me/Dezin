import assert from "node:assert/strict";
import test from "node:test";
import { compileGenerationPlan, GenerationPlanCompileError } from "../src/generation-plan.ts";
import type {
  GenerationPlan,
  WorkspaceGenerationPayload,
  WorkspaceProposal,
} from "../src/workspace-types.ts";

function workspaceGeneration(proposal: WorkspaceProposal): WorkspaceGenerationPayload {
  if (proposal.generation.kind !== "workspace-generation") {
    throw new Error("fixture must contain workspace-generation data");
  }
  return proposal.generation;
}

function approvedPlanFixture(): { shell: GenerationPlan; proposal: WorkspaceProposal } {
  const shell: GenerationPlan = {
    id: "plan-1",
    workspaceId: "workspace-1",
    proposalId: "proposal-1",
    proposalRevision: 3,
    baseSnapshotId: "snapshot-1",
    status: "approved",
    constructionSealed: false,
    compileError: null,
    createdAt: 1_000,
    finishedAt: null,
  };
  const proposal: WorkspaceProposal = {
    id: "proposal-1",
    workspaceId: "workspace-1",
    revision: 3,
    kind: "workspace-generation",
    baseGraphRevision: 4,
    baseSnapshotId: "snapshot-1",
    baseGraph: {
      workspaceId: "workspace-1",
      revision: 4,
      nodes: [],
      edges: [],
    },
    layoutId: "default",
    baseLayoutChecksum: "layout-checksum-1",
    baseLayout: {
      workspaceId: "workspace-1",
      layoutId: "default",
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "layout-checksum-1",
    },
    status: "approved",
    operations: [],
    layoutOperations: [],
    rationale: "Build a reusable card and two product pages.",
    assumptions: [],
    generation: {
      kind: "workspace-generation",
      resourceOperations: [
        {
          operation: "create",
          nodeId: "node-copy",
          resourceId: "resource-copy",
          kind: "research",
          title: "Product copy",
          revisionPolicy: { kind: "generate" },
        },
        {
          operation: "create",
          nodeId: "node-images",
          resourceId: "resource-images",
          kind: "moodboard",
          title: "Product imagery",
          revisionPolicy: { kind: "generate" },
        },
        {
          operation: "reuse",
          nodeId: "node-brand",
          resourceId: "resource-brand",
          kind: "file",
          title: "Brand brief",
          revisionPolicy: { kind: "exact", resourceRevisionId: "brand-revision-1" },
        },
      ],
      artifactPlans: [
        {
          operation: "create",
          nodeId: "node-home",
          artifactId: "page-home",
          kind: "page",
          name: "Home",
          trackId: "track-home",
          baseRevisionId: null,
          dependsOnArtifactIds: ["component-card"],
          capabilityIds: ["cap-visual", "cap-text"],
          responsiveFrameIds: ["desktop"],
        },
        {
          operation: "create",
          nodeId: "node-card",
          artifactId: "component-card",
          kind: "component",
          name: "Product card",
          trackId: "track-card",
          baseRevisionId: null,
          dependsOnArtifactIds: [],
          capabilityIds: ["cap-text"],
          responsiveFrameIds: ["desktop"],
        },
        {
          operation: "create",
          nodeId: "node-about",
          artifactId: "page-about",
          kind: "page",
          name: "About",
          trackId: "track-about",
          baseRevisionId: null,
          dependsOnArtifactIds: [],
          capabilityIds: ["cap-text"],
          responsiveFrameIds: ["desktop"],
        },
      ],
      dependencyPlans: [
        {
          kind: "resource",
          ownerArtifactId: "component-card",
          resourceId: "resource-images",
        },
        {
          kind: "resource",
          ownerArtifactId: "page-home",
          resourceId: "resource-copy",
        },
        {
          kind: "resource",
          ownerArtifactId: "page-home",
          resourceId: "resource-brand",
        },
        {
          kind: "component-instance",
          ownerArtifactId: "page-home",
          instanceId: "instance-card",
          componentArtifactId: "component-card",
          componentRevisionId: null,
          sourceLocator: { designNodeId: "card-slot" },
          overrides: {},
          status: "linked",
        },
      ],
      prototypeIntents: [
        {
          edgeId: "edge-home-about",
          sourceArtifactId: "page-home",
          targetArtifactId: "page-about",
          trigger: "click",
        },
      ],
      capabilities: [
        { id: "cap-text", kind: "text", required: true },
        { id: "cap-visual", kind: "visual-qa", required: true },
      ],
      responsiveFrames: [
        { id: "desktop", name: "Desktop", width: 1_440, height: 900 },
      ],
      qualityProfile: {
        requiredFrameIds: ["desktop"],
        blockingSeverities: ["P0"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
    },
    review: { kind: "approved", mode: "generate" },
    createdByRunId: "run-1",
    createdAt: 900,
    updatedAt: 1_000,
  };
  return { shell, proposal };
}

function targetId(task: ReturnType<typeof compileGenerationPlan>["tasks"][number]): string {
  return task.target.id;
}

test("compiles an approved Workspace Proposal into a deterministic immutable task DAG", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const compiled = compileGenerationPlan(fixture);
  const repeated = compileGenerationPlan({
    shell: { ...fixture.shell },
    proposal: {
      ...fixture.proposal,
      generation: {
        ...generation,
        resourceOperations: [...generation.resourceOperations].reverse(),
        artifactPlans: [...generation.artifactPlans].reverse().map((plan) => ({
          ...plan,
          dependsOnArtifactIds: [...plan.dependsOnArtifactIds].reverse(),
          capabilityIds: [...plan.capabilityIds].reverse(),
          responsiveFrameIds: [...plan.responsiveFrameIds].reverse(),
        })),
        dependencyPlans: [...generation.dependencyPlans].reverse(),
        prototypeIntents: [...generation.prototypeIntents].reverse(),
        capabilities: [...generation.capabilities].reverse(),
      },
    },
  });

  assert.deepEqual(repeated, compiled);
  assert.equal(compiled.id, fixture.shell.id);
  assert.equal(compiled.tasks.length, 7);
  assert.deepEqual(
    compiled.tasks.map((task) => task.kind),
    ["resource", "resource", "component", "page", "page", "prototype-validation", "checkpoint"],
  );
  assert.equal(compiled.tasks.filter((task) => task.kind === "resource").length, 2);
  assert.equal(compiled.tasks.some((task) => targetId(task) === "resource-brand"), false);

  const byTarget = new Map(compiled.tasks.map((task) => [targetId(task), task]));
  const copy = byTarget.get("resource-copy");
  const images = byTarget.get("resource-images");
  const card = byTarget.get("component-card");
  const home = byTarget.get("page-home");
  const about = byTarget.get("page-about");
  const validation = byTarget.get("workspace-1");
  assert.ok(copy);
  assert.ok(images);
  assert.ok(card);
  assert.ok(home);
  assert.ok(about);
  assert.ok(validation);
  assert.equal(card.target.type, "artifact");
  assert.equal(card.target.type === "artifact" ? card.target.trackId : null, "track-card");
  assert.deepEqual(card.dependencyIds, [images.id]);
  assert.deepEqual(home.dependencyIds, [card.id, copy.id].sort());
  assert.deepEqual(about.dependencyIds, []);

  const validationTask = compiled.tasks.find((task) => task.kind === "prototype-validation");
  const checkpointTask = compiled.tasks.find((task) => task.kind === "checkpoint");
  assert.ok(validationTask);
  assert.ok(checkpointTask);
  assert.deepEqual(
    validationTask.dependencyIds,
    compiled.tasks
      .filter((task) => task.kind !== "prototype-validation" && task.kind !== "checkpoint")
      .map((task) => task.id)
      .sort(),
  );
  assert.deepEqual(checkpointTask.dependencyIds, [validationTask.id]);
  assert.equal(validationTask.target.type, "workspace");
  assert.equal(checkpointTask.target.type, "workspace");

  assert.deepEqual(
    compiled.dependencies,
    compiled.tasks.flatMap((task) => task.dependencyIds.map((dependencyTaskId, ordinal) => ({
      planId: compiled.id,
      taskId: task.id,
      dependencyTaskId,
      ordinal,
    }))),
  );
  for (const task of compiled.tasks) {
    assert.match(task.id, /^gt_[a-f0-9]{40}$/);
    assert.match(task.intentHash, /^[a-f0-9]{64}$/);
    assert.match(task.idempotencyKey, /^generation-task:[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(task), true);
    assert.equal(Object.isFrozen(task.payload), true);
    assert.equal(Object.isFrozen(task.dependencyIds), true);
  }
  assert.deepEqual(compiled.tasks.map((task) => task.ordinal), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.tasks), true);
  assert.equal(Object.isFrozen(compiled.dependencies), true);
});

test("rejects an Artifact dependency that is absent from both the approved plan and base graph", () => {
  const fixture = approvedPlanFixture();
  workspaceGeneration(fixture.proposal).artifactPlans[0]!.dependsOnArtifactIds.push("missing-component");

  assert.throws(
    () => compileGenerationPlan(fixture),
    (error: unknown) => error instanceof GenerationPlanCompileError
      && error.code === "invalid-reference"
      && /missing generation dependency Artifact missing-component/.test(error.message),
  );
});

test("keeps the validation and checkpoint chain for an empty approved generation", () => {
  const fixture = approvedPlanFixture();
  fixture.proposal.generation = {
    kind: "workspace-generation",
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

  const compiled = compileGenerationPlan(fixture);
  assert.deepEqual(compiled.tasks.map((task) => task.kind), ["prototype-validation", "checkpoint"]);
  assert.deepEqual(compiled.tasks.map((task) => task.ordinal), [0, 1]);
  assert.deepEqual(compiled.tasks[0]!.dependencyIds, []);
  assert.deepEqual(compiled.tasks[1]!.dependencyIds, [compiled.tasks[0]!.id]);
});

test("accepts the post-approval shell Snapshot for a Proposal with structural operations", () => {
  const fixture = approvedPlanFixture();
  fixture.proposal.baseGraph.nodes.push({
    id: "node-existing-resource",
    workspaceId: fixture.proposal.workspaceId,
    kind: "resource",
    resourceId: "resource-existing",
    name: "Existing brief",
  });
  fixture.proposal.operations = [{
    id: "command-rename-resource",
    type: "rename-node",
    nodeId: "node-existing-resource",
    name: "Renamed brief",
  }];
  fixture.shell.baseSnapshotId = "snapshot-after-approval";

  const compiled = compileGenerationPlan(fixture);
  const checkpoint = compiled.tasks.find((task) => task.kind === "checkpoint");
  assert.ok(checkpoint);
  assert.equal(compiled.baseSnapshotId, "snapshot-after-approval");
  assert.equal(checkpoint.payload.baseSnapshotId, "snapshot-after-approval");
});

test("rejects shell, Proposal revision, Workspace, base Snapshot, status, and approval-mode mismatches", () => {
  const cases: Array<{
    label: string;
    mutate: (fixture: ReturnType<typeof approvedPlanFixture>) => void;
    code: GenerationPlanCompileError["code"];
  }> = [
    {
      label: "shell status",
      mutate: (fixture) => { fixture.shell.status = "queued"; },
      code: "shell-not-approved",
    },
    {
      label: "sealed shell",
      mutate: (fixture) => { fixture.shell.constructionSealed = true; },
      code: "shell-not-approved",
    },
    {
      label: "Proposal status",
      mutate: (fixture) => { fixture.proposal.status = "draft"; },
      code: "proposal-not-approved",
    },
    {
      label: "approval mode",
      mutate: (fixture) => { fixture.proposal.review = { kind: "approved", mode: "structure-only" }; },
      code: "proposal-not-approved",
    },
    {
      label: "Proposal id",
      mutate: (fixture) => { fixture.shell.proposalId = "other-proposal"; },
      code: "proposal-identity-mismatch",
    },
    {
      label: "Proposal revision",
      mutate: (fixture) => { fixture.shell.proposalRevision += 1; },
      code: "proposal-identity-mismatch",
    },
    {
      label: "Workspace",
      mutate: (fixture) => { fixture.shell.workspaceId = "other-workspace"; },
      code: "proposal-identity-mismatch",
    },
    {
      label: "base Snapshot",
      mutate: (fixture) => { fixture.shell.baseSnapshotId = "other-snapshot"; },
      code: "proposal-base-mismatch",
    },
  ];

  for (const testCase of cases) {
    const fixture = approvedPlanFixture();
    testCase.mutate(fixture);
    assert.throws(
      () => compileGenerationPlan(fixture),
      (error: unknown) => error instanceof GenerationPlanCompileError && error.code === testCase.code,
      testCase.label,
    );
  }
});

test("rejects duplicate task targets before hashing or persistence", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  generation.resourceOperations.push({
    ...generation.resourceOperations[0]!,
  });

  assert.throws(
    () => compileGenerationPlan(fixture),
    (error: unknown) => error instanceof GenerationPlanCompileError
      && error.code === "duplicate-id"
      && /duplicate Resource operation id resource-copy/.test(error.message),
  );
});

test("rejects cycles in the compiled immutable task graph", () => {
  const fixture = approvedPlanFixture();
  const component = workspaceGeneration(fixture.proposal).artifactPlans.find(
    (plan) => plan.artifactId === "component-card",
  );
  assert.ok(component);
  component.dependsOnArtifactIds.push("page-home");

  assert.throws(
    () => compileGenerationPlan(fixture),
    (error: unknown) => error instanceof GenerationPlanCompileError
      && error.code === "cyclic-task-graph"
      && /cannot form a cycle/.test(error.message),
  );
});
