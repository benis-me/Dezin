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
      agent: {
        providerId: "codebuddy",
        command: "codebuddy",
        model: "gpt-5.6-sol",
      },
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

function approvedPrototypeV2Fixture(): { shell: GenerationPlan; proposal: WorkspaceProposal } {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const pageContact = {
    operation: "create" as const,
    nodeId: "node-contact",
    artifactId: "page-contact",
    kind: "page" as const,
    name: "Contact",
    trackId: "track-contact",
    baseRevisionId: null,
    dependsOnArtifactIds: [],
    capabilityIds: ["cap-text"],
    responsiveFrameIds: ["desktop"],
    prototypeRequirements: {
      outgoing: [],
      incoming: [{
        edgeId: "edge-home-contact",
        sourceArtifactId: "page-home",
        sourceMarkerId: "marker-home-contact",
        targetState: "contact-ready",
      }],
    },
  };
  fixture.proposal = {
    ...fixture.proposal,
    baseGraph: {
      workspaceId: fixture.proposal.workspaceId,
      revision: fixture.proposal.baseGraphRevision,
      nodes: [
        {
          id: "node-home",
          workspaceId: fixture.proposal.workspaceId,
          kind: "page",
          name: "Home",
          artifactId: "page-home",
        },
        {
          id: "node-about",
          workspaceId: fixture.proposal.workspaceId,
          kind: "page",
          name: "About",
          artifactId: "page-about",
        },
        {
          id: "node-contact",
          workspaceId: fixture.proposal.workspaceId,
          kind: "page",
          name: "Contact",
          artifactId: "page-contact",
        },
      ],
      edges: [
        {
          id: "edge-home-about",
          workspaceId: fixture.proposal.workspaceId,
          sourceNodeId: "node-home",
          targetNodeId: "node-about",
          kind: "prototype",
          prototype: { status: "planned" },
        },
        {
          id: "edge-home-contact",
          workspaceId: fixture.proposal.workspaceId,
          sourceNodeId: "node-home",
          targetNodeId: "node-contact",
          kind: "prototype",
          prototype: { status: "planned" },
        },
      ],
    },
    generation: {
      ...generation,
      version: 2,
      artifactPlans: [
        ...generation.artifactPlans.map((plan) => {
          if (plan.artifactId === "page-home") {
            return {
              ...plan,
              prototypeRequirements: {
                outgoing: [
                  {
                    edgeId: "edge-home-contact",
                    sourceMarkerId: "marker-home-contact",
                    trigger: "submit" as const,
                  },
                  {
                    edgeId: "edge-home-about",
                    sourceMarkerId: "marker-home-about",
                    trigger: "click" as const,
                  },
                ],
                incoming: [],
              },
            };
          }
          if (plan.artifactId === "page-about") {
            return {
              ...plan,
              prototypeRequirements: {
                outgoing: [],
                incoming: [{
                  edgeId: "edge-home-about",
                  sourceArtifactId: "page-home",
                  sourceMarkerId: "marker-home-about",
                  targetState: "about-ready",
                }],
              },
            };
          }
          return plan;
        }),
        pageContact,
      ],
      prototypeIntents: [
        {
          edgeId: "edge-home-contact",
          sourceArtifactId: "page-home",
          targetArtifactId: "page-contact",
          sourceMarkerId: "marker-home-contact",
          trigger: "submit",
          targetState: "contact-ready",
          transition: { type: "fade", durationMs: 180 },
        },
        {
          edgeId: "edge-home-about",
          sourceArtifactId: "page-home",
          targetArtifactId: "page-about",
          sourceMarkerId: "marker-home-about",
          trigger: "click",
          targetState: "about-ready",
        },
      ],
    } as WorkspaceGenerationPayload,
  };
  return fixture;
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

test("copies the frozen proposal Agent into every executable Artifact and Resource leaf", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const agent = {
    providerId: "codebuddy" as const,
    command: "codebuddy" as const,
    model: "gpt-5.6-sol",
  };
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: {
      ...fixture.proposal,
      generation: { ...generation, agent },
    },
  });

  const executable = compiled.tasks.filter(
    (task) => task.kind === "resource" || task.kind === "page" || task.kind === "component",
  );
  assert.ok(executable.length > 0);
  assert.ok(executable.every((task) => {
    assert.deepEqual((task.payload as { agent?: unknown }).agent, agent);
    return true;
  }));
  assert.ok(executable
    .filter((task) => task.kind === "resource")
    .every((task) => task.resourceLimits.timeoutMs === 25 * 60_000));
  assert.ok(executable
    .filter((task) => task.kind === "page" || task.kind === "component")
    .every((task) => task.resourceLimits.timeoutMs === 30 * 60_000));
  assert.ok(executable
    .filter((task) => task.kind === "page" || task.kind === "component")
    .every((task) => task.resourceLimits.maxRepairRounds === 8),
  "compiled Artifact tasks must retain the bounded eight-round production repair ceiling");

  for (const [extraFrameCount, expectedTimeoutMs] of [
    [1, 35 * 60_000],
    [4, 45 * 60_000],
  ] as const) {
    const extraFrames = Array.from({ length: extraFrameCount }, (_, index) => ({
      id: `adaptive-${index}`,
      name: `Adaptive ${index}`,
      width: 1_024,
      height: 768,
    }));
    const responsiveFrames = [...generation.responsiveFrames, ...extraFrames];
    const requiredFrameIds = responsiveFrames.map((frame) => frame.id);
    const adaptive = compileGenerationPlan({
      shell: fixture.shell,
      proposal: {
        ...fixture.proposal,
        generation: {
          ...generation,
          agent,
          responsiveFrames,
          qualityProfile: { ...generation.qualityProfile, requiredFrameIds },
          artifactPlans: generation.artifactPlans.map((plan) => ({
            ...plan,
            responsiveFrameIds: requiredFrameIds,
          })),
        },
      },
    });
    assert.ok(adaptive.tasks
      .filter((task) => task.kind === "page" || task.kind === "component")
      .every((task) => task.resourceLimits.timeoutMs === expectedTimeoutMs));
  }
});

test("gives frozen Codex generation enough bounded time for Resource review and visual Artifact QA", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const agent = {
    providerId: "codex" as const,
    command: "codex" as const,
    model: "gpt-5.4-mini",
  };
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: {
      ...fixture.proposal,
      generation: { ...generation, agent },
    },
  });

  assert.ok(compiled.tasks
    .filter((task) => task.kind === "resource")
    .every((task) => task.resourceLimits.timeoutMs === 25 * 60_000));
  assert.ok(compiled.tasks
    .filter((task) => task.kind === "page" || task.kind === "component")
    .every((task) => task.resourceLimits.timeoutMs === 30 * 60_000));
});

test("freezes one provider-independent Resource deadline that covers every Moodboard image and review", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: {
      ...fixture.proposal,
      generation: {
        ...generation,
        agent: {
          providerId: "anthropic",
          command: "claude",
          model: "claude-sonnet-4-5",
        },
      },
    },
  });

  const resourceTasks = compiled.tasks.filter((task) => task.kind === "resource");
  assert.ok(resourceTasks.length > 0);
  assert.ok(resourceTasks.every((task) => task.resourceLimits.timeoutMs === (
    (7 * 60_000)
    + (8 * 90_000)
    + (8 * 30_000)
    + (2 * 60_000)
  )));
  const research = resourceTasks.find((task) => task.target.id === "resource-copy");
  const moodboard = resourceTasks.find((task) => task.target.id === "resource-images");
  assert.ok(research);
  assert.ok(moodboard);
  assert.equal(research.resourceLimits.maxOutputBytes, 8 * 1024 * 1024);
  assert.equal(
    moodboard.resourceLimits.maxOutputBytes,
    48 * 1024 * 1024,
    "Moodboard must budget the immutable bundle plus up to eight high-quality PNG Assets",
  );
});

test("rejects executable generation that does not freeze its Agent selection", () => {
  const fixture = approvedPlanFixture();
  delete workspaceGeneration(fixture.proposal).agent;

  assert.throws(
    () => compileGenerationPlan(fixture),
    (error: unknown) => error instanceof GenerationPlanCompileError
      && error.code === "invalid-reference"
      && /freeze an Agent selection/.test(error.message),
  );
});

test("preserves unique per-Artifact design instructions in the sealed leaf brief", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const instructions = [
    "Lead with the editorial story grid and one quiet itinerary call to action.",
    "Use the shared Product card component for every story preview.",
    "Include populated, empty, and saved states without changing the global visual direction.",
  ].join(" ");
  const normalized = normalizeWorkspaceProposalGeneration({
    ...generation,
    artifactPlans: generation.artifactPlans.map((plan) => plan.artifactId === "page-home"
      ? { ...plan, instructions }
      : plan),
  });
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: { ...fixture.proposal, generation: normalized },
  });
  const home = compiled.tasks.find((task) => task.target.id === "page-home");
  assert.ok(home);

  assert.equal((home.payload.artifactPlan as Record<string, unknown>).instructions, instructions);
  assert.equal(
    ((home.payload.brief as Record<string, unknown>).targetInstructions as Record<string, unknown>).instructions,
    instructions,
  );
});

test("preserves bounded per-Resource instructions in the operation and sealed leaf brief", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  const instructions = [
    "Produce exactly three visual references, one for each approved direction.",
    "For every direction, cite the decisive evidence and record asset-count compliance.",
  ].join(" ");
  const normalized = normalizeWorkspaceProposalGeneration({
    ...generation,
    resourceOperations: generation.resourceOperations.map((operation) => (
      operation.resourceId === "resource-copy"
        ? { ...operation, instructions }
        : operation
    )),
  });
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: { ...fixture.proposal, generation: normalized },
  });
  const resource = compiled.tasks.find((task) => task.target.id === "resource-copy");
  assert.ok(resource);

  assert.equal((resource.payload.operation as Record<string, unknown>).instructions, instructions);
  assert.equal(
    ((resource.payload.brief as Record<string, unknown>).targetInstructions as Record<string, unknown>)
      .instructions,
    instructions,
  );
});

test("bounds Resource instructions while preserving instruction-free reuse and historical operations", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);

  assert.throws(
    () => normalizeWorkspaceProposalGeneration({
      ...generation,
      resourceOperations: generation.resourceOperations.map((operation) => (
        operation.resourceId === "resource-copy"
          ? { ...operation, instructions: "x".repeat(2_001) }
          : operation
      )),
    }),
    /instructions.*bounded to 2000 UTF-8 bytes/i,
  );
  assert.doesNotThrow(() => normalizeWorkspaceProposalGeneration(generation));
  const normalized = normalizeWorkspaceProposalGeneration(generation);
  assert.equal(normalized.kind, "workspace-generation");
  assert.equal(
    normalized.kind === "workspace-generation"
      ? normalized.resourceOperations.find((operation) => operation.operation === "reuse")?.instructions
      : "unexpected",
    undefined,
  );
});

test("keeps prototype navigation out of hard Task dependencies while retaining real dependencies", () => {
  const fixture = approvedPlanFixture();
  const generation = workspaceGeneration(fixture.proposal);
  generation.artifactPlans.push(
    {
      operation: "create",
      nodeId: "node-contact",
      artifactId: "page-contact",
      kind: "page",
      name: "Contact",
      trackId: "track-contact",
      baseRevisionId: null,
      dependsOnArtifactIds: ["page-about"],
      capabilityIds: ["cap-text"],
      responsiveFrameIds: ["desktop"],
    },
    {
      operation: "create",
      nodeId: "node-library",
      artifactId: "page-library",
      kind: "page",
      name: "Library",
      trackId: "track-library",
      baseRevisionId: null,
      dependsOnArtifactIds: [],
      capabilityIds: ["cap-text"],
      responsiveFrameIds: ["desktop"],
    },
  );
  const proposal: WorkspaceProposal = {
    ...fixture.proposal,
    operations: [
      {
        id: "add-home",
        type: "add-node",
        node: {
          id: "node-home",
          kind: "page",
          name: "Home",
          artifactId: "page-home",
          createIdentity: { initialTrackId: "track-home" },
        },
      },
      {
        id: "add-about",
        type: "add-node",
        node: {
          id: "node-about",
          kind: "page",
          name: "About",
          artifactId: "page-about",
          createIdentity: { initialTrackId: "track-about" },
        },
      },
      {
        id: "add-contact",
        type: "add-node",
        node: {
          id: "node-contact",
          kind: "page",
          name: "Contact",
          artifactId: "page-contact",
          createIdentity: { initialTrackId: "track-contact" },
        },
      },
      {
        id: "add-library",
        type: "add-node",
        node: {
          id: "node-library",
          kind: "page",
          name: "Library",
          artifactId: "page-library",
          createIdentity: { initialTrackId: "track-library" },
        },
      },
      {
        id: "add-home-about-edge",
        type: "add-edge",
        edge: {
          id: "edge-home-about",
          workspaceId: "workspace-1",
          sourceNodeId: "node-home",
          targetNodeId: "node-about",
          kind: "prototype",
        },
      },
      {
        id: "add-about-contact-edge",
        type: "add-edge",
        edge: {
          id: "edge-about-contact",
          workspaceId: "workspace-1",
          sourceNodeId: "node-about",
          targetNodeId: "node-contact",
          kind: "prototype",
        },
      },
      {
        id: "add-contact-library-edge",
        type: "add-edge",
        edge: {
          id: "edge-contact-library",
          workspaceId: "workspace-1",
          sourceNodeId: "node-contact",
          targetNodeId: "node-library",
          kind: "prototype",
        },
      },
    ],
    generation: {
      ...generation,
      prototypeIntents: [
        ...generation.prototypeIntents,
        {
          edgeId: "legacy-library-home",
          sourceArtifactId: "page-library",
          targetArtifactId: "page-home",
          trigger: "click",
        },
      ],
    },
  };

  const compiled = compileGenerationPlan({ shell: fixture.shell, proposal });
  const tasksByTarget = new Map(compiled.tasks.map((task) => [task.target.id, task]));
  const pageTasks = compiled.tasks.filter((task) => task.kind === "page");
  const pageTaskIds = new Set(pageTasks.map((task) => task.id));
  const home = tasksByTarget.get("page-home");
  const about = tasksByTarget.get("page-about");
  const contact = tasksByTarget.get("page-contact");
  const card = tasksByTarget.get("component-card");
  const copy = tasksByTarget.get("resource-copy");
  const images = tasksByTarget.get("resource-images");
  assert.ok(home);
  assert.ok(about);
  assert.ok(contact);
  assert.ok(card);
  assert.ok(copy);
  assert.ok(images);

  for (const page of pageTasks) {
    const expectedPageDependencies: string[] = page.target.id === "page-contact" ? [about.id] : [];
    assert.deepEqual(
      page.dependencyIds.filter((dependencyId) => pageTaskIds.has(dependencyId)),
      expectedPageDependencies,
      `${page.target.id} must not treat navigation as a generation prerequisite`,
    );
  }
  assert.ok(contact.dependencyIds.includes(about.id));
  assert.deepEqual(home.dependencyIds, [card.id, copy.id].sort());
  assert.deepEqual(card.dependencyIds, [images.id]);
});

test("compiles retained planned prototype edges into deterministic v2 finalization and Artifact requirements", () => {
  const fixture = approvedPrototypeV2Fixture();
  const generation = workspaceGeneration(fixture.proposal);
  const canonical = normalizeWorkspaceProposalGeneration(generation);
  const compiled = compileGenerationPlan({
    shell: fixture.shell,
    proposal: { ...fixture.proposal, generation: canonical },
  });
  const normalized = normalizeWorkspaceProposalGeneration({
    ...generation,
    prototypeIntents: [...generation.prototypeIntents].reverse(),
    artifactPlans: generation.artifactPlans.map((plan) => {
      const requirements = (
        plan as typeof plan & {
          prototypeRequirements?: {
            outgoing: unknown[];
            incoming: unknown[];
          };
        }
      ).prototypeRequirements;
      return requirements === undefined
        ? plan
        : {
            ...plan,
            prototypeRequirements: {
              outgoing: [...requirements.outgoing].reverse(),
              incoming: [...requirements.incoming].reverse(),
            },
          };
    }),
  });
  const repeated = compileGenerationPlan({
    shell: fixture.shell,
    proposal: { ...fixture.proposal, generation: normalized },
  });

  assert.deepEqual(repeated, compiled, "v2 intent and requirement input ordering must not change task hashes");
  const home = compiled.tasks.find((task) => task.target.id === "page-home");
  const card = compiled.tasks.find((task) => task.target.id === "component-card");
  const validation = compiled.tasks.find((task) => task.kind === "prototype-validation");
  assert.ok(home);
  assert.ok(card);
  assert.ok(validation);
  assert.deepEqual(
    (
      home.payload.artifactPlan as Record<string, unknown> & {
        prototypeRequirements: { outgoing: Array<{ edgeId: string }> };
      }
    ).prototypeRequirements.outgoing.map((requirement) => requirement.edgeId),
    ["edge-home-about", "edge-home-contact"],
  );
  assert.equal(
    Object.hasOwn(card.payload.artifactPlan as Record<string, unknown>, "prototypeRequirements"),
    false,
    "an unrelated Component must not receive prototype implementation work",
  );
  assert.equal(validation.payload.version, 2);
  assert.deepEqual(
    (validation.payload.prototypeIntents as Array<{ edgeId: string }>).map((intent) => intent.edgeId),
    ["edge-home-about", "edge-home-contact"],
  );
  assert.deepEqual(
    validation.dependencyIds,
    compiled.tasks
      .filter((task) => task.kind !== "prototype-validation" && task.kind !== "checkpoint")
      .map((task) => task.id)
      .sort(),
  );
});

test("rejects incomplete, foreign, drifted, or client-authoritative v2 prototype plans", () => {
  const fixture = approvedPrototypeV2Fixture();
  const generation = workspaceGeneration(fixture.proposal);
  const cases: Array<{
    name: string;
    mutate: (value: WorkspaceGenerationPayload) => WorkspaceGenerationPayload;
    pattern: RegExp;
    code?: GenerationPlanCompileError["code"];
  }> = [
    {
      name: "missing retained edge intent",
      mutate: (value) => ({
        ...value,
        prototypeIntents: value.prototypeIntents.filter((intent) => intent.edgeId !== "edge-home-contact"),
      }),
      pattern: /missing.*prototype intent.*edge-home-contact/i,
    },
    {
      name: "foreign edge intent",
      mutate: (value) => ({
        ...value,
        prototypeIntents: [
          ...value.prototypeIntents,
          {
            edgeId: "edge-foreign",
            sourceArtifactId: "page-home",
            targetArtifactId: "page-about",
            sourceMarkerId: "marker-foreign",
            trigger: "click",
          } as typeof value.prototypeIntents[number],
        ],
      }),
      pattern: /missing.*prototype edge.*edge-foreign|foreign.*edge-foreign/i,
    },
    {
      name: "endpoint drift",
      mutate: (value) => ({
        ...value,
        prototypeIntents: value.prototypeIntents.map((intent) => intent.edgeId === "edge-home-about"
          ? { ...intent, sourceArtifactId: "page-contact" }
          : intent),
      }),
      pattern: /prototype.*endpoint|edge-home-about/i,
    },
    {
      name: "marker collision",
      mutate: (value) => ({
        ...value,
        prototypeIntents: value.prototypeIntents.map((intent) => ({
          ...intent,
          sourceMarkerId: "marker-collision",
        })),
        artifactPlans: value.artifactPlans.map((plan) => plan.prototypeRequirements === undefined
          ? plan
          : {
              ...plan,
              prototypeRequirements: {
                outgoing: plan.prototypeRequirements.outgoing.map((requirement) => ({
                  ...requirement,
                  sourceMarkerId: "marker-collision",
                })),
                incoming: plan.prototypeRequirements.incoming.map((requirement) => ({
                  ...requirement,
                  sourceMarkerId: "marker-collision",
                })),
              },
            }),
      }),
      pattern: /duplicate.*source marker|marker.*unique/i,
      code: "duplicate-id",
    },
    {
      name: "missing source Artifact requirement",
      mutate: (value) => ({
        ...value,
        artifactPlans: value.artifactPlans.map((plan) => plan.artifactId === "page-home"
          ? {
              ...plan,
              prototypeRequirements: {
                outgoing: [],
                incoming: [],
              },
            } as typeof plan
          : plan),
      }),
      pattern: /source.*requirement|marker requirement.*edge-home/i,
    },
  ];
  for (const entry of cases) {
    assert.throws(
      () => compileGenerationPlan({
        shell: fixture.shell,
        proposal: {
          ...fixture.proposal,
          generation: entry.mutate(structuredClone(generation)),
        },
      }),
      (error: unknown) => error instanceof GenerationPlanCompileError
        && error.code === (entry.code ?? "invalid-reference")
        && entry.pattern.test(error.message),
      entry.name,
    );
  }

  for (const forbidden of [
    { sourceLocator: { designNodeId: "client-authored" } },
    { sourceRevisionId: "client-revision" },
    { selector: "#client-authority" },
  ]) {
    assert.throws(
      () => normalizeWorkspaceProposalGeneration({
        ...generation,
        prototypeIntents: generation.prototypeIntents.map((intent, index) => index === 0
          ? { ...intent, ...forbidden }
          : intent),
      }),
      /unsupported field|locator|Revision|selector/i,
    );
  }
});

test("keeps historical unversioned generation payloads byte-for-byte", () => {
  const historicalPayloads = [
    {
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
    },
    {
      kind: "workspace-generation",
      resourceOperations: [],
      artifactPlans: [],
      dependencyPlans: [],
      prototypeIntents: [{
        edgeId: "legacy-edge",
        sourceArtifactId: "legacy-source",
        targetArtifactId: "legacy-target",
        sourceLocator: { designNodeId: "legacy-cta" },
        trigger: "click",
        targetState: "legacy-ready",
        transition: { type: "fade", durationMs: 120, easing: "ease-out" },
      }],
      capabilities: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    },
  ] as const;

  for (const historical of historicalPayloads) {
    assert.equal(
      JSON.stringify(normalizeWorkspaceProposalGeneration(historical)),
      JSON.stringify(historical),
    );
  }
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
  const agent = workspaceGeneration(fixture.proposal).agent;
  assert.ok(card);
  assert.ok(home);
  assert.ok(copy);
  assert.ok(agent);

  assert.deepEqual(card.payload, {
    version: 2,
    agent,
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
    agent,
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

  await t.test("visual QA admits a bounded responsive state matrix", () => {
    const fixture = approvedPlanFixture();
    const generation = workspaceGeneration(fixture.proposal);
    const extraFrames = Array.from({ length: 15 }, (_, index) => ({
      id: `adaptive-${index}`,
      name: `Adaptive ${index}`,
      width: 1_024 - index * 80,
      height: 768 + index * 40,
      initialState: `state-${index}`,
    }));
    generation.responsiveFrames.push(...extraFrames);
    for (const plan of generation.artifactPlans) {
      plan.responsiveFrameIds.push(...extraFrames.map((frame) => frame.id));
    }

    assert.doesNotThrow(() => compileGenerationPlan(fixture));
  });

  await t.test("visual QA rejects a state matrix beyond the bounded per-Artifact Frame budget", () => {
    const fixture = approvedPlanFixture();
    const generation = workspaceGeneration(fixture.proposal);
    const extraFrames = Array.from({ length: 16 }, (_, index) => ({
      id: `adaptive-${index}`,
      name: `Adaptive ${index}`,
      width: 1_024,
      height: 768,
      initialState: `state-${index}`,
    }));
    generation.responsiveFrames.push(...extraFrames);
    for (const plan of generation.artifactPlans) {
      plan.responsiveFrameIds.push(...extraFrames.map((frame) => frame.id));
    }

    assert.throws(
      () => compileGenerationPlan(fixture),
      (error: unknown) => error instanceof GenerationPlanCompileError
        && error.code === "invalid-reference"
        && /at most 16 responsive Frames/.test(error.message),
    );
  });
});

test("keeps the validation and checkpoint chain for an empty approved generation", () => {
  const fixture = approvedPlanFixture();
  fixture.proposal.generation = {
    kind: "workspace-generation",
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
