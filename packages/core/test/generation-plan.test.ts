import assert from "node:assert/strict";
import test from "node:test";
import { compileGenerationPlan, GenerationPlanCompileError } from "../src/generation-plan.ts";
import {
  generationTaskIntentHash,
  normalizeGenerationTaskIntent,
} from "../src/store-codecs.ts";
import { normalizeWorkspaceProposalGeneration } from "../src/workspace-codecs.ts";
import type {
  GenerationPlan,
  GenerationTaskIntent,
  GenerationTaskIntentInput,
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
    assumptions: ["Use the approved product taxonomy.", "Keep the visual language editorial."],
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

function taskInput(task: GenerationTaskIntent): GenerationTaskIntentInput {
  return {
    id: task.id,
    ordinal: task.ordinal,
    workspaceId: task.workspaceId,
    planId: task.planId,
    kind: task.kind,
    target: structuredClone(task.target),
    dependencyIds: [...task.dependencyIds],
    payload: structuredClone(task.payload),
    capabilities: [...task.capabilities],
    qaProfile: structuredClone(task.qaProfile),
    resourceLimits: structuredClone(task.resourceLimits),
  };
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
  assert.deepEqual(home.dependencyIds, [about.id, card.id, copy.id].sort());
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

test("serializes prototype-connected Page generation so later Context can observe an earlier Revision", () => {
  const compiled = compileGenerationPlan(approvedPlanFixture());
  const about = compiled.tasks.find((task) => task.target.id === "page-about");
  const home = compiled.tasks.find((task) => task.target.id === "page-home");
  assert.ok(about);
  assert.ok(home);

  // Navigation direction is intentionally irrelevant. Stable Artifact order
  // chooses the spanning order when the existing Task DAG imposes no Page order.
  assert.equal(about.dependencyIds.includes(home.id), false);
  assert.equal(home.dependencyIds.includes(about.id), true);
});

test("uses an acyclic stable spanning order for bidirectional and cyclic prototype navigation", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  generation.artifactPlans.push({
    operation: "create",
    nodeId: "node-contact",
    artifactId: "page-contact",
    kind: "page",
    name: "Contact",
    trackId: "track-contact",
    baseRevisionId: null,
    dependsOnArtifactIds: [],
    capabilityIds: ["cap-text"],
    responsiveFrameIds: ["desktop"],
  });
  const aboutPlan = generation.artifactPlans.find((plan) => plan.artifactId === "page-about")!;
  aboutPlan.dependsOnArtifactIds = ["page-home"];
  generation.prototypeIntents.push(
    {
      edgeId: "edge-about-home",
      sourceArtifactId: "page-about",
      targetArtifactId: "page-home",
      trigger: "click",
    },
    {
      edgeId: "edge-about-contact",
      sourceArtifactId: "page-about",
      targetArtifactId: "page-contact",
      trigger: "click",
    },
    {
      edgeId: "edge-contact-home",
      sourceArtifactId: "page-contact",
      targetArtifactId: "page-home",
      trigger: "click",
    },
  );

  const compiled = compileGenerationPlan(fixture);
  const repeated = compileGenerationPlan({
    shell: { ...fixture.shell },
    proposal: {
      ...fixture.proposal,
      generation: {
        ...generation,
        prototypeIntents: [...generation.prototypeIntents].reverse(),
      },
    },
  });
  assert.deepEqual(repeated, compiled);

  const pages = new Map(compiled.tasks
    .filter((task) => task.kind === "page")
    .map((task) => [task.target.id, task]));
  const about = pages.get("page-about")!;
  const contact = pages.get("page-contact")!;
  const home = pages.get("page-home")!;
  assert.equal(contact.dependencyIds.includes(home.id), false);
  assert.equal(home.dependencyIds.includes(contact.id), true);
  assert.equal(about.dependencyIds.includes(home.id), true);
  assert.equal(about.dependencyIds.includes(contact.id), false);
});

test("compiles an exact dispatch Context Pack identity into only its scoped Artifact and Resource leaves", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const artifactDispatchContextPackId = `context-pack-${"a".repeat(64)}`;
  const resourceDispatchContextPackId = `context-pack-${"b".repeat(64)}`;
  const normalized = normalizeWorkspaceProposalGeneration({
    ...generation,
    artifactPlans: generation.artifactPlans.map((plan) => plan.artifactId === "page-home"
      ? { ...plan, dispatchContextPackId: artifactDispatchContextPackId }
      : plan),
    resourceOperations: generation.resourceOperations.map((operation) => operation.resourceId === "resource-copy"
      ? { ...operation, dispatchContextPackId: resourceDispatchContextPackId }
      : operation),
  });
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: { ...fixture.proposal, generation: normalized },
  });
  const pageTask = compiled.tasks.find((task) => task.target.id === "page-home");
  const resourceTask = compiled.tasks.find((task) => task.target.id === "resource-copy");
  assert.ok(pageTask);
  assert.ok(resourceTask);
  assert.equal(
    (pageTask.payload.artifactPlan as Record<string, unknown>).dispatchContextPackId,
    artifactDispatchContextPackId,
  );
  assert.equal(
    (resourceTask.payload.operation as Record<string, unknown>).dispatchContextPackId,
    resourceDispatchContextPackId,
  );
  assert.equal(JSON.stringify(pageTask.payload).includes(resourceDispatchContextPackId), false);
  assert.equal(JSON.stringify(resourceTask.payload).includes(artifactDispatchContextPackId), false);

  assert.throws(
    () => normalizeWorkspaceProposalGeneration({
      ...generation,
      artifactPlans: generation.artifactPlans.map((plan, index) => index === 0
        ? { ...plan, dispatchContextPackId: " context-pack-substituted " }
        : plan),
    }),
    /dispatch Context Pack id|canonical/i,
  );
  assert.throws(
    () => normalizeWorkspaceProposalGeneration({
      ...generation,
      resourceOperations: generation.resourceOperations.map((operation) => operation.operation === "reuse"
        ? { ...operation, dispatchContextPackId: resourceDispatchContextPackId }
        : operation),
    }),
    /reuse cannot bind.*dispatch Context Pack/i,
  );
});

test("compiles only an exact immutable Research Revision direction selection into its owning Artifact leaf", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const selection = {
    protocol: "dezin.research-direction-selection.v1" as const,
    version: 1 as const,
    resourceId: "resource-brand",
    revisionId: "brand-revision-1",
    directionId: "quiet-editorial",
  };
  const normalized = normalizeWorkspaceProposalGeneration({
    ...generation,
    resourceOperations: generation.resourceOperations.map((operation) => operation.resourceId === selection.resourceId
      ? { ...operation, kind: "research" as const }
      : operation),
    artifactPlans: generation.artifactPlans.map((plan) => plan.artifactId === "page-home"
      ? { ...plan, researchDirectionSelection: selection }
      : plan),
  });
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: { ...fixture.proposal, generation: normalized },
  });
  const home = compiled.tasks.find((task) => task.target.id === "page-home");
  assert.ok(home);
  assert.deepEqual(
    (home.payload.artifactPlan as Record<string, unknown>).researchDirectionSelection,
    selection,
  );

  const generatedSelection = normalizeWorkspaceProposalGeneration({
    ...generation,
    artifactPlans: generation.artifactPlans.map((plan) => plan.artifactId === "page-home"
      ? {
          ...plan,
          researchDirectionSelection: {
            ...selection,
            resourceId: "resource-copy",
            revisionId: "future-revision-cannot-be-known",
          },
        }
      : plan),
  });
  assert.throws(
    () => compileGenerationPlan({
      shell: fixture.shell,
      proposal: { ...fixture.proposal, generation: generatedSelection },
    }),
    /selected Research.*exact existing Revision/i,
  );
});

test("freezes auditable v2 briefs, complete capabilities, and Resource adapter identity", () => {
  const fixture = approvedPlanFixture();
  const compiled = compileGenerationPlan(fixture);
  const byTarget = new Map(compiled.tasks.map((task) => [task.target.id, task]));
  const card = byTarget.get("component-card");
  const home = byTarget.get("page-home");
  const copy = byTarget.get("resource-copy");
  assert.ok(card);
  assert.ok(home);
  assert.ok(copy);

  assert.deepEqual(card.payload, {
    version: 2,
    artifactPlan: {
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
    dependencyPlans: [{
      kind: "resource",
      ownerArtifactId: "component-card",
      resourceId: "resource-images",
    }],
    responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1_440, height: 900 }],
    brief: {
      proposalRationale: fixture.proposal.rationale,
      assumptions: fixture.proposal.assumptions,
      targetInstructions: {
        operation: "create",
        kind: "component",
        name: "Product card",
      },
    },
    capabilityDescriptors: [{ id: "cap-text", kind: "text", required: true }],
  });
  assert.deepEqual((home.payload.brief as any).targetInstructions, {
    operation: "create",
    kind: "page",
    name: "Home",
  });
  assert.deepEqual(copy.payload, {
    version: 2,
    operation: {
      operation: "create",
      nodeId: "node-copy",
      resourceId: "resource-copy",
      kind: "research",
      title: "Product copy",
      revisionPolicy: { kind: "generate" },
    },
    brief: {
      proposalRationale: fixture.proposal.rationale,
      assumptions: fixture.proposal.assumptions,
      targetInstructions: {
        operation: "create",
        kind: "research",
        title: "Product copy",
      },
    },
    capabilityDescriptors: [
      { id: "cap-text", kind: "text", required: true },
      { id: "cap-visual", kind: "visual-qa", required: true },
    ],
    adapter: {
      id: "dezin.resource-adapter.research",
      version: 1,
      kind: "research",
    },
  });
});

test("round-trips v2 leaf intent and binds every frozen prompt input into intentHash", () => {
  const tasks = compileGenerationPlan(approvedPlanFixture()).tasks.filter(
    (task) => task.kind === "page" || task.kind === "component" || task.kind === "resource",
  );
  for (const task of tasks) {
    const roundTripped = normalizeGenerationTaskIntent(
      JSON.parse(JSON.stringify(taskInput(task))) as unknown,
    );
    assert.deepEqual(roundTripped, task);
  }

  const artifact = tasks.find((task) => task.kind === "page");
  const resource = tasks.find((task) => task.kind === "resource");
  assert.ok(artifact);
  assert.ok(resource);
  const mutations: Array<[GenerationTaskIntent, (payload: any) => void]> = [
    [artifact, (payload) => { payload.brief.proposalRationale = "A different approved direction."; }],
    [artifact, (payload) => { payload.brief.assumptions[0] = "A different assumption."; }],
    [artifact, (payload) => { payload.brief.targetInstructions.name = "Different page"; }],
    [artifact, (payload) => { payload.capabilityDescriptors[0].kind = "image"; }],
    [resource, (payload) => { payload.adapter.id = "dezin.resource-adapter.other"; }],
  ];
  for (const [task, mutate] of mutations) {
    const input = taskInput(task);
    mutate(input.payload);
    const normalized = normalizeGenerationTaskIntent(input);
    assert.notEqual(normalized.intentHash, task.intentHash);
    assert.equal(normalized.intentHash, generationTaskIntentHash(input));
  }
});

test("keeps historical v1 leaf payloads readable without compiling new v1 work", () => {
  const compiled = compileGenerationPlan(approvedPlanFixture());
  const artifact = compiled.tasks.find((task) => task.kind === "page");
  const resource = compiled.tasks.find((task) => task.kind === "resource");
  assert.ok(artifact);
  assert.ok(resource);

  const artifactV1 = taskInput(artifact);
  const artifactPayload = artifactV1.payload as any;
  artifactV1.payload = {
    version: 1,
    artifactPlan: artifactPayload.artifactPlan,
    dependencyPlans: artifactPayload.dependencyPlans,
    responsiveFrames: artifactPayload.responsiveFrames,
  };
  const resourceV1 = taskInput(resource);
  resourceV1.payload = {
    version: 1,
    operation: (resourceV1.payload as any).operation,
  };

  const restoredArtifact = normalizeGenerationTaskIntent(
    JSON.parse(JSON.stringify(artifactV1)) as unknown,
  );
  const restoredResource = normalizeGenerationTaskIntent(
    JSON.parse(JSON.stringify(resourceV1)) as unknown,
  );
  assert.equal(restoredArtifact.payload.version, 1);
  assert.equal(restoredResource.payload.version, 1);
  assert.equal(restoredArtifact.intentHash, generationTaskIntentHash(taskInput(restoredArtifact)));
  assert.equal(restoredResource.intentHash, generationTaskIntentHash(taskInput(restoredResource)));
  assert.equal(compiled.tasks.some((task) => (
    (task.kind === "page" || task.kind === "component" || task.kind === "resource")
      && task.payload.version !== 2
  )), false);
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

test("rejects empty or per-Artifact-incomplete responsive Frame contracts before queueing", async (t) => {
  await t.test("empty Artifact Frame set", () => {
    const fixture = approvedPlanFixture();
    workspaceGeneration(fixture.proposal).artifactPlans[0]!.responsiveFrameIds = [];
    assert.throws(
      () => compileGenerationPlan(fixture),
      (error: unknown) => error instanceof GenerationPlanCompileError
        && error.code === "invalid-reference"
        && /must include at least one responsive Frame/.test(error.message),
    );
  });

  await t.test("one Artifact omits a globally required Frame", () => {
    const fixture = approvedPlanFixture();
    const generation = workspaceGeneration(fixture.proposal);
    generation.responsiveFrames.push({ id: "mobile", name: "Mobile", width: 390, height: 844 });
    generation.qualityProfile.requiredFrameIds.push("mobile");
    generation.artifactPlans[0]!.responsiveFrameIds.push("mobile");
    assert.throws(
      () => compileGenerationPlan(fixture),
      (error: unknown) => error instanceof GenerationPlanCompileError
        && error.code === "invalid-reference"
        && /component-card.*missing required responsive Frame mobile/.test(error.message),
    );
  });
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

test("rejects generated Resource kinds that require an explicit owned source", () => {
  for (const kind of ["file", "asset", "effect", "external-reference"] as const) {
    const fixture = approvedPlanFixture();
    const operation = workspaceGeneration(fixture.proposal).resourceOperations[0]!;
    operation.kind = kind;

    assert.throws(
      () => compileGenerationPlan(fixture),
      (error: unknown) => error instanceof GenerationPlanCompileError
        && error.code === "unsupported-resource-kind"
        && error.details.resourceKind === kind
        && /explicit owned source|cannot be Agent-generated/i.test(error.message),
      kind,
    );
  }
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
