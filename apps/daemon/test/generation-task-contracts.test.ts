import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileGenerationPlan,
  type GenerationPlan,
  type GenerationTask,
  type GenerationTaskIntent,
  type WorkspaceProposal,
} from "../../../packages/core/src/index.ts";
import {
  GenerationTaskPayloadContractError,
  validateGenerationTaskPayload,
} from "../src/orchestration/generation-task-contracts.ts";

function approvedPlanFixture(): { shell: GenerationPlan; proposal: WorkspaceProposal } {
  const shell: GenerationPlan = {
    id: "plan-contract",
    workspaceId: "workspace-contract",
    proposalId: "proposal-contract",
    proposalRevision: 2,
    baseSnapshotId: "snapshot-contract",
    status: "approved",
    constructionSealed: false,
    compileError: null,
    createdAt: 1_000,
    finishedAt: null,
  };
  const proposal: WorkspaceProposal = {
    id: shell.proposalId,
    workspaceId: shell.workspaceId,
    revision: shell.proposalRevision,
    kind: "workspace-generation",
    baseGraphRevision: 4,
    baseSnapshotId: shell.baseSnapshotId,
    baseGraph: {
      workspaceId: shell.workspaceId,
      revision: 4,
      nodes: [],
      edges: [],
    },
    layoutId: "default",
    baseLayoutChecksum: "layout-contract",
    baseLayout: {
      workspaceId: shell.workspaceId,
      layoutId: "default",
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      checksum: "layout-contract",
    },
    status: "approved",
    operations: [],
    layoutOperations: [],
    generation: {
      kind: "workspace-generation",
      resourceOperations: [{
        operation: "create",
        nodeId: "node-research",
        resourceId: "resource-research",
        kind: "research",
        title: "Audience research",
        revisionPolicy: { kind: "generate" },
      }],
      artifactPlans: [
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
          responsiveFrameIds: ["mobile", "desktop"],
        },
        {
          operation: "revise",
          nodeId: "node-home",
          artifactId: "page-home",
          kind: "page",
          name: "Home",
          trackId: "track-home",
          baseRevisionId: "revision-home-1",
          dependsOnArtifactIds: ["component-card"],
          capabilityIds: ["cap-visual", "cap-text"],
          responsiveFrameIds: ["mobile", "desktop"],
        },
        {
          operation: "create",
          nodeId: "node-detail",
          artifactId: "page-detail",
          kind: "page",
          name: "Detail",
          trackId: "track-detail",
          baseRevisionId: null,
          dependsOnArtifactIds: [],
          capabilityIds: ["cap-text"],
          responsiveFrameIds: ["mobile", "desktop"],
        },
      ],
      dependencyPlans: [
        {
          kind: "resource",
          ownerArtifactId: "component-card",
          resourceId: "resource-research",
        },
        {
          kind: "component-instance",
          ownerArtifactId: "page-home",
          instanceId: "instance-card",
          componentArtifactId: "component-card",
          componentRevisionId: null,
          variantKey: "featured",
          stateKey: "expanded",
          sourceLocator: {
            designNodeId: "hero-card",
            sourcePath: "src/Home.tsx",
            selector: "[data-design-node='hero-card']",
          },
          overrides: {
            copy: { title: "New arrivals", badges: ["New", 2, true, null] },
          },
          status: "linked",
        },
      ],
      prototypeIntents: [{
        edgeId: "edge-home-detail",
        sourceArtifactId: "page-home",
        targetArtifactId: "page-detail",
        sourceLocator: {
          designNodeId: "hero-card",
          sourcePath: "src/Home.tsx",
          selector: "[data-design-node='hero-card']",
        },
        trigger: "click",
        targetState: "expanded",
        transition: { type: "slide", durationMs: 240, easing: "ease-out" },
      }],
      capabilities: [
        { id: "cap-text", kind: "text", required: true },
        { id: "cap-visual", kind: "visual-qa", required: false },
      ],
      responsiveFrames: [
        {
          id: "mobile",
          name: "Mobile",
          width: 390,
          height: 844,
          initialState: "expanded",
          fixture: {
            locale: "en",
            products: [{ id: "sku-1", available: true }],
            " padded fixture key ": "preserved by the Viewer bridge contract",
          },
          background: "#f7f7f5",
        },
        { id: "desktop", name: "Desktop", width: 1_440, height: 900 },
      ],
      qualityProfile: {
        requiredFrameIds: ["desktop", "mobile"],
        blockingSeverities: ["P0", "P1"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
    },
    rationale: "Build a linked component and page flow.",
    assumptions: [],
    review: { kind: "approved", mode: "generate" },
    createdByRunId: "run-contract",
    createdAt: 900,
    updatedAt: 1_000,
  };
  return { shell, proposal };
}

function runningTask(intent: GenerationTaskIntent): GenerationTask {
  return {
    ...intent,
    status: "running",
    blockedReason: null,
    blockedByTaskId: null,
    pendingContextPolicy: null,
    currentAttempt: 1,
    materializationFailures: 0,
    failureClass: null,
    error: null,
    nextEligibleAt: null,
    resultRevisionId: null,
    resultResourceRevisionId: null,
    resultSnapshotId: null,
    createdAt: 1_100,
    finishedAt: null,
  };
}

function compiledTasks(): GenerationTask[] {
  return compileGenerationPlan(approvedPlanFixture()).tasks.map(runningTask);
}

function taskOfKind(kind: GenerationTask["kind"]): GenerationTask {
  const task = compiledTasks().find((candidate) => candidate.kind === kind);
  assert.ok(task, `missing ${kind} fixture`);
  return task;
}

function taskOfTarget(targetId: string): GenerationTask {
  const task = compiledTasks().find((candidate) => candidate.target.id === targetId);
  assert.ok(task, `missing ${targetId} fixture`);
  return task;
}

function clonePayload(task: GenerationTask): Record<string, unknown> {
  return structuredClone(task.payload);
}

function withPayload(task: GenerationTask, payload: Record<string, unknown>): GenerationTask {
  return { ...task, payload };
}

function expectContractError(task: GenerationTask, pattern: RegExp): void {
  assert.throws(
    () => validateGenerationTaskPayload(task),
    (error: unknown) => error instanceof GenerationTaskPayloadContractError && pattern.test(error.message),
  );
}

function expectLegacyV1Disposition(task: GenerationTask): void {
  assert.throws(
    () => validateGenerationTaskPayload(task),
    (error: unknown) => error instanceof GenerationTaskPayloadContractError
      && error.code === "GENERATION_TASK_PAYLOAD_LEGACY_V1"
      && error.disposition === "recompile-required"
      && error.failureClass === "build"
      && /legacy.*v1.*recompil/i.test(error.message),
  );
}

test("accepts every fully populated payload frozen by compileGenerationPlan", () => {
  const tasks = compiledTasks();
  assert.deepEqual(
    tasks.map((task) => task.kind),
    ["resource", "component", "page", "page", "prototype-validation", "checkpoint"],
  );
  for (const task of tasks) validateGenerationTaskPayload(task);
});

test("rejects readable legacy v1 leaf payloads with an explicit recompile disposition", () => {
  const page = taskOfTarget("page-home");
  const pageV2 = clonePayload(page) as any;
  expectLegacyV1Disposition(withPayload(page, {
    version: 1,
    artifactPlan: pageV2.artifactPlan,
    dependencyPlans: pageV2.dependencyPlans,
    responsiveFrames: pageV2.responsiveFrames,
  }));

  const resource = taskOfKind("resource");
  const resourceV2 = clonePayload(resource) as any;
  expectLegacyV1Disposition(withPayload(resource, {
    version: 1,
    operation: resourceV2.operation,
  }));
});

test("accepts exact version-only placeholders for reserved propagation kinds", () => {
  const page = taskOfKind("page");
  const checkpoint = taskOfKind("checkpoint");
  assert.equal(page.target.type, "artifact");
  assert.equal(checkpoint.target.type, "workspace");
  validateGenerationTaskPayload({ ...page, kind: "propagation-candidate", payload: { version: 1 } });
  validateGenerationTaskPayload({ ...checkpoint, kind: "propagation-publish", payload: { version: 1 } });
});

test("rejects unsupported versions, missing fields, extra fields, and future task kinds", () => {
  const resource = taskOfKind("resource");
  expectContractError(withPayload(resource, { ...clonePayload(resource), version: 3 }), /version/i);
  const missing = clonePayload(resource);
  delete missing.operation;
  expectContractError(withPayload(resource, missing), /fields/i);
  expectContractError(withPayload(resource, { ...clonePayload(resource), surprise: true }), /fields/i);
  expectContractError({ ...resource, kind: "future-kind" as GenerationTask["kind"] }, /unsupported.*future-kind/i);
});

test("validates Artifact plans, identities, sorted unique sets, and dependency unions recursively", () => {
  const page = taskOfTarget("page-home");
  assert.equal(page.target.type, "artifact");

  for (const [mutate, pattern] of [
    [(payload: any) => { payload.artifactPlan.operation = "reuse"; }, /operation/i],
    [(payload: any) => { payload.artifactPlan.nodeId = " node-home "; }, /canonical/i],
    [(payload: any) => { payload.artifactPlan.kind = "component"; }, /kind.*task/i],
    [(payload: any) => { payload.artifactPlan.artifactId = "page-other"; }, /target/i],
    [(payload: any) => { payload.artifactPlan.trackId = "track-other"; }, /track/i],
    [(payload: any) => { payload.artifactPlan.baseRevisionId = ""; }, /base revision/i],
    [(payload: any) => { payload.artifactPlan.dispatchContextPackId = `context-pack-${"A".repeat(64)}`; }, /dispatch context pack/i],
    [(payload: any) => { payload.artifactPlan.capabilityIds = ["cap-visual", "cap-text"]; }, /sorted/i],
    [(payload: any) => { payload.artifactPlan.responsiveFrameIds = ["desktop", "desktop"]; }, /unique/i],
    [(payload: any) => { payload.artifactPlan.extra = true; }, /fields/i],
    [(payload: any) => { payload.dependencyPlans[0].ownerArtifactId = "page-other"; }, /owner/i],
    [(payload: any) => { payload.dependencyPlans[0].variantKey = null; }, /variant/i],
    [(payload: any) => { payload.dependencyPlans[0].status = "stale"; }, /status/i],
    [(payload: any) => { payload.dependencyPlans[0].sourceLocator.selector = " "; }, /selector/i],
    [(payload: any) => { payload.dependencyPlans[0].sourceLocator.extra = true; }, /fields/i],
    [(payload: any) => { payload.dependencyPlans[0].overrides.copy.bad = Number.NaN; }, /finite/i],
    [(payload: any) => { payload.dependencyPlans.unshift({ kind: "resource", ownerArtifactId: "page-home", resourceId: "resource-a" }); }, /sorted/i],
    [(payload: any) => { payload.responsiveFrames.reverse(); }, /sorted/i],
    [(payload: any) => { payload.responsiveFrames[0].width = 0; }, /positive/i],
    [(payload: any) => { payload.responsiveFrames[0].width = 1440.5; }, /integer|capture/i],
    [(payload: any) => { payload.responsiveFrames[0].height = 16_385; }, /capture|dimension|16384/i],
    [(payload: any) => {
      payload.responsiveFrames[0].width = 8_193;
      payload.responsiveFrames[0].height = 8_192;
    }, /pixel|capture/i],
    [(payload: any) => { payload.responsiveFrames[0].name = "n".repeat(513); }, /name|512|length/i],
    [(payload: any) => { payload.responsiveFrames[0].initialState = "bad\nstate"; }, /control/i],
    [(payload: any) => { payload.responsiveFrames[0].extra = true; }, /fields/i],
    [(payload: any) => { payload.responsiveFrames.pop(); }, /frame ids/i],
    [(payload: any) => { payload.brief.proposalRationale = " "; }, /rationale/i],
    [(payload: any) => { payload.brief.assumptions[0] = " assumption "; }, /canonical/i],
    [(payload: any) => { payload.brief.targetInstructions.name = "Different page"; }, /instructions.*name/i],
    [(payload: any) => { payload.brief.targetInstructions.kind = "component"; }, /instructions.*kind/i],
    [(payload: any) => { payload.brief.targetInstructions.extra = true; }, /fields/i],
    [(payload: any) => { payload.capabilityDescriptors[0].kind = "audio"; }, /capability kind/i],
    [(payload: any) => { payload.capabilityDescriptors[0].required = "yes"; }, /required/i],
    [(payload: any) => { payload.capabilityDescriptors[0].extra = true; }, /fields/i],
    [(payload: any) => { payload.capabilityDescriptors.pop(); }, /Task capabilities/i],
  ] as const) {
    const payload = clonePayload(page);
    mutate(payload);
    expectContractError(withPayload(page, payload), pattern);
  }
});

test("validates the exact versioned Research direction selection and its owned dependency", () => {
  const component = taskOfTarget("component-card");
  const payload = clonePayload(component);
  (payload.artifactPlan as Record<string, unknown>).researchDirectionSelection = {
    protocol: "dezin.research-direction-selection.v1",
    version: 1,
    resourceId: "resource-research",
    revisionId: "research-revision-1",
    directionId: "quiet-editorial",
  };
  validateGenerationTaskPayload(withPayload(component, payload));

  for (const [mutate, pattern] of [
    [(value: any) => { value.artifactPlan.researchDirectionSelection.protocol = "dezin.research-direction-selection.v2"; }, /protocol/i],
    [(value: any) => { value.artifactPlan.researchDirectionSelection.directionId = " selected "; }, /canonical/i],
    [(value: any) => { value.artifactPlan.researchDirectionSelection.resourceId = "resource-other"; }, /owned Resource dependency/i],
    [(value: any) => { value.artifactPlan.researchDirectionSelection.extra = true; }, /fields/i],
  ] as const) {
    const invalid = structuredClone(payload);
    mutate(invalid);
    expectContractError(withPayload(component, invalid), pattern);
  }
});

test("validates Resource operation and generate policy recursively", () => {
  const resource = taskOfKind("resource");
  for (const [mutate, pattern] of [
    [(payload: any) => { payload.operation.operation = "reuse"; }, /operation/i],
    [(payload: any) => { payload.operation.resourceId = "resource-other"; }, /target/i],
    [(payload: any) => { payload.operation.kind = "unknown"; }, /resource kind/i],
    [(payload: any) => { payload.operation.title = " "; }, /title/i],
    [(payload: any) => { payload.operation.dispatchContextPackId = `context-pack-${"A".repeat(64)}`; }, /dispatch context pack/i],
    [(payload: any) => { payload.operation.revisionPolicy.kind = "exact"; }, /generate/i],
    [(payload: any) => { payload.operation.revisionPolicy.revisionId = "revision-1"; }, /fields/i],
    [(payload: any) => { payload.operation.extra = true; }, /fields/i],
    [(payload: any) => { payload.brief.targetInstructions.title = "Different research"; }, /instructions.*title/i],
    [(payload: any) => { payload.brief.targetInstructions.kind = "file"; }, /instructions.*kind/i],
    [(payload: any) => { payload.capabilityDescriptors[0].required = false; }, /required/i],
    [(payload: any) => { payload.adapter.id = "dezin.resource-adapter.file"; }, /adapter id/i],
    [(payload: any) => { payload.adapter.version = 2; }, /adapter version/i],
    [(payload: any) => { payload.adapter.kind = "file"; }, /adapter kind/i],
    [(payload: any) => { payload.adapter.extra = true; }, /fields/i],
  ] as const) {
    const payload = clonePayload(resource);
    mutate(payload);
    expectContractError(withPayload(resource, payload), pattern);
  }
});

test("validates Prototype intents, transitions, Frames, and Artifact ids recursively", () => {
  const prototype = taskOfKind("prototype-validation");
  for (const [mutate, pattern] of [
    [(payload: any) => { payload.prototypeIntents[0].edgeId = " edge "; }, /canonical/i],
    [(payload: any) => { payload.prototypeIntents[0].trigger = "hover"; }, /trigger/i],
    [(payload: any) => { payload.prototypeIntents[0].transition.type = "spring"; }, /transition type/i],
    [(payload: any) => { payload.prototypeIntents[0].transition.durationMs = -1; }, /duration/i],
    [(payload: any) => { payload.prototypeIntents[0].transition.easing = ""; }, /easing/i],
    [(payload: any) => { payload.prototypeIntents[0].transition.extra = true; }, /fields/i],
    [(payload: any) => { payload.prototypeIntents.push(structuredClone(payload.prototypeIntents[0])); }, /unique/i],
    [(payload: any) => { payload.artifactIds.push(payload.artifactIds[0]); }, /unique/i],
    [(payload: any) => { payload.artifactIds[0] = ""; }, /artifact ids/i],
    [(payload: any) => { payload.responsiveFrames[0].fixture = { bad: undefined }; }, /json/i],
  ] as const) {
    const payload = clonePayload(prototype);
    mutate(payload);
    expectContractError(withPayload(prototype, payload), pattern);
  }
});

test("validates Checkpoint scalars and reserved propagation payloads exactly", () => {
  const checkpoint = taskOfKind("checkpoint");
  for (const [mutate, pattern] of [
    [(payload: any) => { payload.proposalId = " proposal "; }, /canonical/i],
    [(payload: any) => { payload.proposalRevision = 0; }, /proposal revision/i],
    [(payload: any) => { payload.proposalRevision = 1.5; }, /proposal revision/i],
    [(payload: any) => { payload.baseSnapshotId = ""; }, /snapshot/i],
  ] as const) {
    const payload = clonePayload(checkpoint);
    mutate(payload);
    expectContractError(withPayload(checkpoint, payload), pattern);
  }

  const page = taskOfTarget("page-home");
  expectContractError(
    { ...page, kind: "propagation-candidate", payload: { version: 1, batchId: "not-yet-supported" } },
    /fields/i,
  );
  expectContractError(
    { ...checkpoint, kind: "propagation-publish", payload: {} },
    /fields/i,
  );
});

test("rejects non-plain records, accessors, sparse arrays, cycles, and Viewer fixture budget overflows", () => {
  const resource = taskOfKind("resource");
  expectContractError(withPayload(resource, new Proxy(clonePayload(resource), {})), /proxy/i);

  const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
  Object.assign(inherited, clonePayload(resource));
  expectContractError(withPayload(resource, inherited), /plain object|inherited/i);

  const accessor = clonePayload(resource);
  Object.defineProperty(accessor, "version", { enumerable: true, get: () => 1 });
  expectContractError(withPayload(resource, accessor), /data properties/i);

  const page = taskOfTarget("page-home");
  const sparse = clonePayload(page);
  (sparse.artifactPlan as any).capabilityIds = new Array(1);
  expectContractError(withPayload(page, sparse), /dense/i);

  const cyclic = clonePayload(page);
  (cyclic.dependencyPlans as any[])[0]!.overrides.loop = cyclic;
  expectContractError(withPayload(page, cyclic), /cycles/i);

  const oversizedFixture = clonePayload(page);
  (oversizedFixture.responsiveFrames as any[])[0]!.fixture = {
    values: Array.from({ length: 257 }, (_, index) => index),
  };
  expectContractError(withPayload(page, oversizedFixture), /member limit/i);
});
