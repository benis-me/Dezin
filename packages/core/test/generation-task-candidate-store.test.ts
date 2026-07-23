import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  generationTaskArtifactCandidateRetentionRef,
  generationTaskCandidateEvidenceHash,
  GenerationTaskLeaseFenceError,
  GenerationTaskQualityGateError,
  Store,
  type GenerationTaskAttemptClaim,
  type RenderFrameSpec,
  type StageGenerationTaskCandidateInput,
  type StoreClock,
} from "../src/index.ts";

interface ControlledClock {
  clock: StoreClock;
  set(now: number): void;
}

function controlledClock(prefix: string): ControlledClock {
  let now = 50_000;
  let id = 0;
  return {
    clock: {
      now: () => now,
      id: () => `${prefix}-${++id}`,
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

type CandidateResourceKind = "asset" | "sharingan-capture";

interface CandidateContextResource {
  id: string;
  kind: CandidateResourceKind;
  revisionId: string;
  revisionChecksum: string;
}

interface CandidateFixtureOptions {
  primaryResourceKind?: CandidateResourceKind;
  extraSharinganResourceCount?: number;
  pinExtraSharinganResources?: boolean;
  includeSharinganOmission?: boolean;
  sharinganOmissionDeclaredKind?: CandidateResourceKind;
  duplicatePrimaryContextResource?: boolean;
}

function persistArtifactContextPack(
  store: Store,
  input: {
    id: string;
    workspaceId: string;
    graphRevision: number;
    targetArtifactId: string;
    kernelRevisionId: string;
    artifacts: Array<{ artifactId: string; revisionId: string; reason: string }>;
    resource?: CandidateContextResource;
    resources?: CandidateContextResource[];
    omissions?: Array<{
      ref: {
        kind: "resource";
        id: string;
        resourceKind: CandidateResourceKind;
        revisionId?: string;
      };
      reason: string;
      tokenEstimate: number;
    }>;
  },
) {
  const kernel = store.workspace.getKernelRevision(input.kernelRevisionId);
  assert.ok(kernel);
  const artifactItems = input.artifacts.map((artifact) => {
    const artifactChecksum = store.workspace.getArtifactRevisionContextChecksum(artifact.revisionId);
    assert.ok(artifactChecksum);
    return {
      ref: { kind: "artifact" as const, id: artifact.artifactId, revisionId: artifact.revisionId },
      resolvedKind: "artifact-revision" as const,
      artifactRevisionId: artifact.revisionId,
      checksum: artifactChecksum,
      reason: artifact.reason,
      trustLevel: "trusted" as const,
      boundary: {},
      tokenEstimate: 1,
      provenance: {},
      provided: true,
    };
  });
  const resources = [
    ...(input.resource === undefined ? [] : [input.resource]),
    ...(input.resources ?? []),
  ];
  const resourceItems = resources.map((resource) => ({
    ref: {
      kind: "resource" as const,
      id: resource.id,
      resourceKind: resource.kind,
      revisionId: resource.revisionId,
    },
    resolvedKind: "resource-revision" as const,
    resourceRevisionId: resource.revisionId,
    checksum: resource.revisionChecksum,
    reason: "resource-pin",
    trustLevel: "trusted" as const,
    boundary: {},
    tokenEstimate: 1,
    provenance: {},
    provided: true,
  }));
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
    ...resourceItems,
  ];
  const hash = checksum(`${input.id}:pack`);
  return store.workspace.persistContextPack({
    id: `context-pack-${hash}`,
    workspaceId: input.workspaceId,
    graphRevision: input.graphRevision,
    target: { type: "artifact", id: input.targetArtifactId },
    intent: "generate",
    messageChecksum: checksum(`${input.id}:message`),
    items,
    omissions: input.omissions ?? [],
    tokenEstimate: items.length,
    manifestPath: `context-packs/${input.id}.json`,
    hash,
  });
}

function createCandidateFixture(
  label: string,
  resourceKindOrOptions: CandidateResourceKind | CandidateFixtureOptions = "asset",
) {
  const options = typeof resourceKindOrOptions === "string"
    ? { primaryResourceKind: resourceKindOrOptions }
    : resourceKindOrOptions;
  const resourceKind = options.primaryResourceKind ?? "asset";
  const extraSharinganResourceCount = options.extraSharinganResourceCount ?? 0;
  if (!Number.isSafeInteger(extraSharinganResourceCount) || extraSharinganResourceCount < 0) {
    throw new Error("Candidate fixture extra Sharingan Resource count is invalid");
  }
  const control = controlledClock(`candidate-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Candidate staging ${label}`, mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [
      {
        id: `add-component-${label}`,
        type: "add-node",
        node: {
          id: `candidate-component-node-${label}`,
          kind: "component",
          name: "Generated Card",
          artifactId: `candidate-component-${label}`,
          createIdentity: { initialTrackId: `candidate-component-track-${label}` },
        },
      },
      {
        id: `add-page-${label}`,
        type: "add-node",
        node: {
          id: `candidate-page-node-${label}`,
          kind: "page",
          name: "Generated Page",
          artifactId: `candidate-page-${label}`,
          createIdentity: { initialTrackId: `candidate-page-track-${label}` },
        },
      },
    ],
  });
  const withArtifacts = store.workspace.getWorkspace(project.id)!;
  const createBaseRevision = (artifactId: string, trackId: string) => store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash: checksum(`${artifactId}:base-commit`),
    sourceTreeHash: checksum(`${artifactId}:base-tree`),
    kernelRevisionId: withArtifacts.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const pageRevision = createBaseRevision(`candidate-page-${label}`, `candidate-page-track-${label}`);
  const pageSnapshot = store.workspace.publishArtifactRevision(pageRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const componentRevision = createBaseRevision(
    `candidate-component-${label}`,
    `candidate-component-track-${label}`,
  );
  const componentSnapshot = store.workspace.publishArtifactRevision(componentRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: pageSnapshot.id,
  });
  let resourceBaseSnapshot = componentSnapshot;
  const createFixtureResource = (kind: CandidateResourceKind, suffix: string) => {
    const created = store.workspace.createResourceForProject(project.id, {
      kind,
      title: `Exact candidate ${kind} ${suffix}`,
      defaultPinPolicy: "pin-current",
      baseGraphRevision: resourceBaseSnapshot.graphRevision,
      expectedSnapshotId: resourceBaseSnapshot.id,
    });
    const revision = store.workspace.createResourceRevisionCandidateForProject(
      project.id,
      created.resource.id,
      {
        revisionId: suffix === "primary"
          ? `candidate-resource-revision-${label}`
          : `candidate-resource-revision-${label}-${suffix}`,
        parentRevisionId: null,
        manifestPath: `resource-revisions/${label}/${suffix}/manifest.json`,
        summary: "Exact resource input",
        metadata: { mimeType: "image/png" },
        checksum: checksum(`${label}:resource-revision:${suffix}`),
        provenance: { source: "generation-task-candidate-store-test" },
      },
    );
    resourceBaseSnapshot = store.workspace.publishResourceRevisionForProject(
      project.id,
      created.resource.id,
      revision.id,
      {
        expectedHeadRevisionId: null,
        expectedSnapshotId: created.snapshot.id,
        reason: "Publish exact candidate resource",
      },
    );
    return { created, revision };
  };
  const primaryResource = createFixtureResource(resourceKind, "primary");
  const extraSharinganResources = Array.from(
    { length: extraSharinganResourceCount },
    (_, index) => createFixtureResource("sharingan-capture", `sharingan-${index + 1}`),
  );
  const pinnedResources = [
    primaryResource,
    ...(options.pinExtraSharinganResources ? extraSharinganResources : []),
  ];
  const contextResources = [
    primaryResource,
    ...(options.duplicatePrimaryContextResource ? [primaryResource] : []),
    ...extraSharinganResources,
  ];
  const createdResource = primaryResource.created;
  const resourceRevision = primaryResource.revision;

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
      resourceOperations: pinnedResources.map(({ created, revision }) => ({
        operation: "reuse",
        nodeId: created.node.id,
        resourceId: created.resource.id,
        kind: created.resource.kind,
        title: created.resource.title,
        revisionPolicy: { kind: "exact" as const, resourceRevisionId: revision.id },
      })),
      artifactPlans: [
        {
          operation: "revise",
          nodeId: `candidate-component-node-${label}`,
          artifactId: `candidate-component-${label}`,
          kind: "component",
          name: "Generated Card",
          trackId: `candidate-component-track-${label}`,
          baseRevisionId: componentRevision.id,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: ["desktop"],
        },
        {
          operation: "revise",
          nodeId: `candidate-page-node-${label}`,
          artifactId: `candidate-page-${label}`,
          kind: "page",
          name: "Generated Page",
          trackId: `candidate-page-track-${label}`,
          baseRevisionId: pageRevision.id,
          dependsOnArtifactIds: [`candidate-component-${label}`],
          capabilityIds: [],
          responsiveFrameIds: ["desktop"],
        },
      ],
      dependencyPlans: [
        {
          kind: "component-instance",
          ownerArtifactId: `candidate-page-${label}`,
          instanceId: `candidate-card-instance-${label}`,
          componentArtifactId: `candidate-component-${label}`,
          componentRevisionId: null,
          variantKey: "featured",
          stateKey: "default",
          sourceLocator: { designNodeId: `candidate-card-slot-${label}`, selector: "[data-slot='card']" },
          overrides: { emphasis: "high" },
          status: "linked",
        },
        ...pinnedResources.map(({ created }) => ({
          kind: "resource",
          ownerArtifactId: `candidate-page-${label}`,
          resourceId: created.resource.id,
        } as const)),
      ],
    },
    rationale: "Stage a Page only after its Component output is pinned",
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

  const componentObservation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    componentTask.id,
  );
  const componentContext = persistArtifactContextPack(store, {
    id: `candidate-component-context-${label}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    targetArtifactId: `candidate-component-${label}`,
    kernelRevisionId: componentObservation.kernelRevisionId,
    artifacts: [{
      artifactId: `candidate-component-${label}`,
      revisionId: componentRevision.id,
      reason: "target-base",
    }],
  });
  const componentAttempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...componentObservation,
      contextPackId: componentContext.id,
      sourceCommitHash: componentRevision.sourceCommitHash,
      sourceTreeHash: componentRevision.sourceTreeHash,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const componentClaim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: componentTask.id,
    attempt: componentAttempt.attempt,
    ownerId: `candidate-component-owner-${label}`,
    now: 70_000,
    leaseMs: 30_000,
  });
  assert.ok(componentClaim);
  const componentSuccessor = store.workspace.createArtifactRevision({
    artifactId: `candidate-component-${label}`,
    trackId: `candidate-component-track-${label}`,
    parentRevisionId: componentRevision.id,
    sourceCommitHash: checksum(`${label}:component-successor-commit`),
    sourceTreeHash: checksum(`${label}:component-successor-tree`),
    kernelRevisionId: componentAttempt.kernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: componentContext.hash,
    dependencies: [],
    resourcePins: [],
  });
  const componentSuccessorSnapshot = store.workspace.publishArtifactRevision(componentSuccessor.id, {
    expectedHeadRevisionId: componentRevision.id,
    expectedSnapshotId: componentAttempt.expectedSnapshotId,
  });
  const componentEvidence = { checks: ["runtime", "visual"], quality: "passed" };
  const componentEvidenceHash = generationTaskCandidateEvidenceHash({
    taskId: componentTask.id,
    planId: compiled.plan.id,
    workspaceId: workspace.id,
    attempt: componentAttempt.attempt,
    candidateRevisionId: componentSuccessor.id,
    candidateResourceRevisionId: null,
    candidateEvidence: componentEvidence,
  });
  store.db.prepare(
    `UPDATE generation_task_attempts
     SET status = 'succeeded', candidate_revision_id = ?, candidate_evidence_json = ?,
         candidate_evidence_hash = ?, owner_id = NULL, lease_token = NULL,
         lease_expires_at = NULL, heartbeat_at = NULL, finished_at = 70_001
     WHERE task_id = ? AND plan_id = ? AND attempt = ?`,
  ).run(
    componentSuccessor.id,
    JSON.stringify(componentEvidence),
    componentEvidenceHash,
    componentTask.id,
    compiled.plan.id,
    componentAttempt.attempt,
  );
  store.db.prepare(
    `UPDATE generation_tasks
     SET status = 'succeeded', result_revision_id = ?, result_snapshot_id = ?, finished_at = 70_001
     WHERE id = ? AND plan_id = ?`,
  ).run(componentSuccessor.id, componentSuccessorSnapshot.id, componentTask.id, compiled.plan.id);
  store.db.prepare(
    "DELETE FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
  ).run(componentTask.id, componentAttempt.attempt);
  const sequence = Number((store.db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM generation_plan_events WHERE plan_id = ?",
  ).get(compiled.plan.id) as { sequence: number }).sequence) + 1;
  store.db.prepare(
    `INSERT INTO generation_plan_events
       (plan_id, workspace_id, sequence, task_id, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, 'task-succeeded', ?, 70_001)`,
  ).run(
    compiled.plan.id,
    workspace.id,
    sequence,
    componentTask.id,
    JSON.stringify({
      attempt: componentAttempt.attempt,
      resultRevisionId: componentSuccessor.id,
      resultSnapshotId: componentSuccessorSnapshot.id,
    }),
  );

  const pageObservation = store.workspace.observeGenerationTaskMaterializationForProject(
    project.id,
    compiled.plan.id,
    pageTask.id,
  );
  assert.equal(pageObservation.baseRevisionId, pageRevision.id);
  assert.equal(pageObservation.expectedSnapshotId, componentSuccessorSnapshot.id);
  assert.deepEqual(pageObservation.dependencyOutputs, [{
    taskId: componentTask.id,
    resultRevisionId: componentSuccessor.id,
    resultResourceRevisionId: null,
    resultSnapshotId: componentSuccessorSnapshot.id,
  }]);
  assert.equal(pageObservation.componentPins[0]?.revisionId, componentSuccessor.id);
  assert.deepEqual(pageObservation.resourcePins, pinnedResources
    .map(({ created, revision }) => ({
      resourceId: created.resource.id,
      revisionId: revision.id,
      sourceTaskId: null,
    }))
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId)));
  const pageContext = persistArtifactContextPack(store, {
    id: `candidate-page-context-${label}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    targetArtifactId: `candidate-page-${label}`,
    kernelRevisionId: pageObservation.kernelRevisionId,
    artifacts: [
      { artifactId: `candidate-page-${label}`, revisionId: pageRevision.id, reason: "target-base" },
      {
        artifactId: `candidate-component-${label}`,
        revisionId: componentSuccessor.id,
        reason: "generated-component-pin",
      },
    ],
    resources: contextResources.map(({ created, revision }) => ({
      id: created.resource.id,
      kind: created.resource.kind as CandidateResourceKind,
      revisionId: revision.id,
      revisionChecksum: revision.checksum,
    })),
    omissions: options.includeSharinganOmission ? [{
      ref: {
        kind: "resource",
        id: `omitted-sharingan-resource-${label}`,
        resourceKind: options.sharinganOmissionDeclaredKind ?? "sharingan-capture",
        revisionId: `omitted-sharingan-revision-${label}`,
      },
      reason: "omitted Sharingan source",
      tokenEstimate: 1,
    }] : [],
  });
  const pageAttempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...pageObservation,
      contextPackId: pageContext.id,
      sourceCommitHash: pageRevision.sourceCommitHash,
      sourceTreeHash: pageRevision.sourceTreeHash,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: pageTask.id,
    attempt: pageAttempt.attempt,
    ownerId: `candidate-worker-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  control.set(100_001);

  return {
    control,
    store,
    project,
    workspace,
    plan: compiled.plan,
    componentTask,
    pageTask,
    pageRevision,
    componentSuccessor,
    resource: createdResource.resource,
    resourceRevision,
    extraSharinganResources,
    pageContext,
    claim,
  };
}

function candidateInput(
  label: string,
  claim: GenerationTaskAttemptClaim,
  projectId: string,
  includeSourceVisualEvidence = false,
): StageGenerationTaskCandidateInput {
  const contextPackId = claim.attempt.contextPackId;
  if (!contextPackId?.startsWith("context-pack-")) {
    throw new Error("Artifact candidate fixture requires a content-addressed Context Pack");
  }
  const frames = (claim.attempt.payload as { responsiveFrames?: RenderFrameSpec[] }).responsiveFrames;
  if (!frames || frames.length === 0) {
    throw new Error("Artifact candidate fixture requires immutable Task Frames");
  }
  const candidate = {
    kind: "artifact" as const,
    sourceCommitHash: checksum(`${label}:candidate-commit`),
    sourceTreeHash: checksum(`${label}:candidate-tree`),
    renderSpec: { frames },
    quality: { state: "passed" as const, score: 97, findings: [] },
  };
  const visualEvidence = frames.map((frame) => {
    const sha256 = checksum(`${label}:visual:${frame.id}`);
    const frameAttemptId = `quality-round-0-${frame.id}`;
    const storageKey = [
      "generation-task-evidence",
      projectId,
      claim.task.workspaceId,
      claim.task.planId,
      claim.task.id,
      `attempt-${claim.attempt.attempt}`,
      "visual",
      `round-0-${frame.id}-${sha256}.png`,
    ].join("/");
    return {
      protocol: "dezin.generation-task-visual-evidence.v1",
      owner: {
        projectId,
        workspaceId: claim.task.workspaceId,
        planId: claim.task.planId,
        taskId: claim.task.id,
        attempt: claim.attempt.attempt,
        candidateCommitHash: candidate.sourceCommitHash,
        candidateTreeHash: candidate.sourceTreeHash,
        contextPackId,
        contextPackHash: contextPackId.slice("context-pack-".length),
      },
      frame: { ...frame, frameAttemptId },
      round: 0,
      mediaType: "image/png",
      sha256,
      byteLength: 1_024,
      storageKey,
    };
  });
  const sourceSha256 = checksum(`${label}:visual:source`);
  const sourceByteLength = 2_048;
  const sourceCapture = {
    scope: "source" as const,
    sourceAttemptId: "quality-round-0-source",
    width: 1_440,
    height: 1_800,
  };
  const sourceStorageKey = [
    "generation-task-evidence",
    projectId,
    claim.task.workspaceId,
    claim.task.planId,
    claim.task.id,
    `attempt-${claim.attempt.attempt}`,
    "visual",
    `round-0-source-${sourceSha256}.png`,
  ].join("/");
  const sourceReviewEvidence = {
    ...sourceCapture,
    sha256: sourceSha256,
    byteLength: sourceByteLength,
    storageKey: sourceStorageKey,
  };
  const sourcePin = claim.attempt.resourcePins[0];
  const sourceAuthority = sourcePin ? {
    resourceId: sourcePin.resourceId,
    revisionId: sourcePin.revisionId,
    revisionChecksum: checksum(`${label}:resource-revision:primary`),
  } : null;
  const visualReview = {
    status: "passed",
    fidelity: 0.97,
    evidence: visualEvidence.map(({ frame, sha256, byteLength, storageKey }) => ({
      frameId: frame.id,
      frameAttemptId: frame.frameAttemptId,
      sha256,
      byteLength,
      storageKey,
    })),
    ...(includeSourceVisualEvidence ? { sourceEvidence: sourceReviewEvidence } : {}),
  };
  const qualityEvidence = {
    protocol: "dezin.standard-artifact-quality.v1",
    candidate: {
      commitHash: candidate.sourceCommitHash,
      treeHash: candidate.sourceTreeHash,
    },
    contextPack: {
      id: contextPackId,
      hash: contextPackId.slice("context-pack-".length),
    },
    frames: candidate.renderSpec.frames,
    frameResults: frames.map((frame) => ({
      frameId: frame.id,
      frameAttemptId: `quality-round-0-${frame.id}`,
      width: frame.width,
      height: frame.height,
      status: "passed",
      reviewed: true,
      captureIdentity: {
        sha256: checksum(`${label}:visual:${frame.id}`),
        byteLength: 1_024,
        width: frame.width,
        height: frame.height,
      },
    })),
    round: 0,
    runtimeChecks: frames.map((frame) => ({ id: `frame:${frame.id}`, status: "passed" })),
    visualReview,
    visualEvidence,
    ...(includeSourceVisualEvidence ? {
      sourceCaptureResult: {
        ...sourceCapture,
        status: "passed",
        reviewed: true,
        captureIdentity: {
          sha256: sourceSha256,
          byteLength: sourceByteLength,
          width: sourceCapture.width,
          height: sourceCapture.height,
        },
      },
      sourceVisualEvidence: {
        protocol: "dezin.generation-task-source-visual-evidence.v1",
        owner: visualEvidence[0]!.owner,
        capture: sourceCapture,
        sourceAuthority,
        round: 0,
        mediaType: "image/png",
        sha256: sourceSha256,
        byteLength: sourceByteLength,
        storageKey: sourceStorageKey,
      },
    } : {}),
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
    ...(includeSourceVisualEvidence ? {
      sourceCaptureResult: qualityEvidence.sourceCaptureResult,
      sourceVisualEvidence: qualityEvidence.sourceVisualEvidence,
    } : {}),
  };
  return {
    lease: {
      taskId: "replaced-by-fixture",
      workspaceId: "replaced-by-fixture",
      attempt: 1,
      ownerId: "replaced-by-fixture",
      leaseToken: "replaced-by-fixture",
    },
    candidate,
    evidence: {
      runtimeChecks: qualityEvidence.runtimeChecks,
      visualReview: qualityEvidence.visualReview,
      protocol: "dezin.artifact-run.v1",
      projectId,
      taskId: claim.task.id,
      planId: claim.task.planId,
      workspaceId: claim.task.workspaceId,
      attempt: claim.attempt.attempt,
      attemptCreatedAt: claim.attempt.createdAt,
      inputHash: claim.attempt.inputHash,
      contextPackId,
      contextPackHash: contextPackId.slice("context-pack-".length),
      sourceBase: {
        commitHash: claim.attempt.sourceCommitHash,
        treeHash: claim.attempt.sourceTreeHash,
      },
      candidateRetentionRef: generationTaskArtifactCandidateRetentionRef(claim.attempt),
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
  };
}

function inputForClaim(
  label: string,
  claim: GenerationTaskAttemptClaim,
  projectId: string,
  includeSourceVisualEvidence = false,
): StageGenerationTaskCandidateInput {
  return {
    ...candidateInput(label, claim, projectId, includeSourceVisualEvidence),
    lease: claim.lease,
  };
}

function candidateDurableState(store: Store, projectId: string, planId: string, taskId: string) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  const task = store.workspace.getGenerationPlanDetailForProject(projectId, planId)
    .tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task);
  const targetArtifact = task.target.type === "artifact"
    ? store.workspace.getArtifact(task.target.id)
    : null;
  return {
    activeSnapshotId: workspace.activeSnapshotId,
    activeHeadRevisionId: targetArtifact?.activeTrackId
      ? store.workspace.getTrack(targetArtifact.activeTrackId)?.headRevisionId ?? null
      : null,
    artifactRevisionCount: Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_revisions",
    ).get() as { count: number }).count),
    candidateEvents: store.workspace.listGenerationPlanEventsForProject(projectId, planId, {
      after: 0,
      limit: 1_000,
    }).filter((event) => event.type === "task-candidate-ready"),
    attempts: (store.db.prepare(
      `SELECT task_id, attempt, status, candidate_revision_id, candidate_resource_revision_id,
              candidate_evidence_json, candidate_evidence_hash, owner_id, lease_token,
              lease_expires_at, heartbeat_at
       FROM generation_task_attempts WHERE plan_id = ? ORDER BY task_id, attempt`,
    ).all(planId) as Array<Record<string, unknown>>).map((row) => ({ ...row })),
    claims: (store.db.prepare(
      `SELECT task_id, attempt, owner_id, lease_token, claim_key, claim_kind, lease_expires_at
       FROM generation_task_claims WHERE plan_id = ? ORDER BY claim_key`,
    ).all(planId) as Array<Record<string, unknown>>).map((row) => ({ ...row })),
    task: {
      status: task.status,
      currentAttempt: task.currentAttempt,
      resultRevisionId: task.resultRevisionId,
      resultResourceRevisionId: task.resultResourceRevisionId,
      resultSnapshotId: task.resultSnapshotId,
    },
  };
}

test("Artifact candidate ref recovery entries are exact, stably ordered, and limited", () => {
  const fixture = createCandidateFixture("ref-recovery-order");
  try {
    const beforePage = fixture.store.workspace.listArtifactCandidateRefRecoveryEntries();
    assert.deepEqual(beforePage.entries.map((entry) => entry.task.id), [fixture.componentTask.id]);
    const component = beforePage.entries[0];
    assert.equal(component?.retentionKind, "retained-candidate");
    if (component?.retentionKind !== "retained-candidate") assert.fail("expected retained Component");
    assert.equal(component.attempt.status, "succeeded");
    assert.equal(component.attempt.materializationSealed, true);
    assert.equal(component.attempt.lease, null);
    assert.equal(component.attempt.candidateRevisionId, fixture.componentSuccessor.id);
    assert.equal(component.revision.id, fixture.componentSuccessor.id);
    assert.equal(beforePage.nextCursor, null);

    const staged = fixture.store.workspace.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      inputForClaim("ref-recovery-order", fixture.claim, fixture.project.id),
    );
    const published = fixture.store.workspace.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      { lease: fixture.claim.lease },
    );
    assert.equal(published.status, "succeeded");

    const page = fixture.store.workspace.listArtifactCandidateRefRecoveryEntries(100);
    assert.deepEqual(page.entries.map((entry) => entry.task.id), [
      fixture.componentTask.id,
      fixture.pageTask.id,
    ]);
    assert.deepEqual(page.entries.map((entry) => entry.attempt.attempt), [1, 1]);
    const generatedPage = page.entries[1];
    assert.equal(generatedPage?.retentionKind, "retained-candidate");
    if (generatedPage?.retentionKind !== "retained-candidate") assert.fail("expected retained Page");
    assert.equal(generatedPage.attempt.candidateRevisionId, staged.artifactRevision.id);
    assert.equal(generatedPage.revision.id, staged.artifactRevision.id);
    assert.equal(page.nextCursor, null);
    const first = fixture.store.workspace.listArtifactCandidateRefRecoveryEntries(1);
    assert.deepEqual(first.entries.map((entry) => entry.task.id), [fixture.componentTask.id]);
    assert.ok(first.nextCursor);
    const second = fixture.store.workspace.listArtifactCandidateRefRecoveryEntries(1, first.nextCursor);
    assert.deepEqual(second.entries.map((entry) => entry.task.id), [fixture.pageTask.id]);
    const exhausted = fixture.store.workspace.listArtifactCandidateRefRecoveryEntries(1, second.nextCursor);
    assert.deepEqual(exhausted.entries, []);
    assert.equal(exhausted.nextCursor, null);
    assert.throws(
      () => fixture.store.workspace.listArtifactCandidateRefRecoveryEntries(0),
      /limit must be a safe integer >= 1/i,
    );
    assert.throws(
      () => fixture.store.workspace.listArtifactCandidateRefRecoveryEntries(1_001),
      /limit must not exceed 1000/i,
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate ref recovery includes an exact terminal orphan Attempt with no candidate", () => {
  const fixture = createCandidateFixture("ref-recovery-missing-revision");
  try {
    fixture.store.workspace.finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        lease: fixture.claim.lease,
        failure: {
          failureClass: "cancelled",
          error: { code: "TEST_CANCELLED", message: "cancel before candidate staging" },
        },
      },
    );

    const entries = fixture.store.workspace.listArtifactCandidateRefRecoveryEntries().entries;
    assert.deepEqual(entries.map((entry) => entry.task.id), [
      fixture.componentTask.id,
      fixture.pageTask.id,
    ]);
    assert.equal(entries[0]?.retentionKind, "retained-candidate");
    const orphan = entries[1];
    assert.equal(orphan?.retentionKind, "orphan-attempt");
    if (orphan?.retentionKind !== "orphan-attempt") {
      assert.fail("expected a terminal orphan Artifact Attempt recovery entry");
    }
    assert.equal(orphan.revision, null);
    assert.equal(orphan.attempt.status, "failed");
    assert.equal(orphan.attempt.candidateRevisionId, null);
    assert.equal(orphan.attempt.candidateResourceRevisionId, null);
    assert.equal(orphan.attempt.candidateEvidence, null);
    assert.equal(orphan.attempt.candidateEvidenceHash, null);
    assert.equal(orphan.attempt.sourceCommitHash, fixture.pageRevision.sourceCommitHash);
    assert.equal(orphan.attempt.sourceTreeHash, fixture.pageRevision.sourceTreeHash);
    assert.equal(orphan.attempt.materializationSealed, true);
    assert.equal(orphan.attempt.lease, null);
    assert.notEqual(orphan.attempt.finishedAt, null);
  } finally {
    fixture.store.close();
  }
});

test("staging an Artifact candidate atomically seals a derived Revision without publishing it", () => {
  const fixture = createCandidateFixture("success");
  try {
    const input = inputForClaim("success", fixture.claim, fixture.project.id);
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    const result = fixture.store.workspace.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );

    assert.equal(result.resourceRevision, null);
    assert.equal(result.artifactRevision.artifactId, fixture.pageTask.target.id);
    assert.equal(
      result.artifactRevision.trackId,
      fixture.claim.attempt.target.type === "artifact"
        ? fixture.claim.attempt.target.trackId
        : undefined,
    );
    assert.equal(result.artifactRevision.parentRevisionId, fixture.claim.attempt.baseRevisionId);
    assert.equal(result.artifactRevision.kernelRevisionId, fixture.claim.attempt.kernelRevisionId);
    assert.equal(result.artifactRevision.contextPackHash, fixture.pageContext.hash);
    assert.equal(result.artifactRevision.sourceCommitHash, input.candidate.sourceCommitHash);
    assert.equal(result.artifactRevision.sourceTreeHash, input.candidate.sourceTreeHash);
    assert.deepEqual(result.artifactRevision.renderSpec, input.candidate.renderSpec);
    assert.deepEqual(result.artifactRevision.quality, input.candidate.quality);
    assert.equal(
      (fixture.store.db.prepare("SELECT sealed FROM artifact_revisions WHERE id = ?")
        .get(result.artifactRevision.id) as { sealed: number }).sealed,
      1,
    );
    assert.deepEqual(
      fixture.store.workspace.listArtifactRevisionDependencies(result.artifactRevision.id),
      fixture.claim.attempt.componentPins.map((pin) => ({
        workspaceId: fixture.claim.attempt.workspaceId,
        ownerArtifactId: fixture.pageTask.target.id,
        revisionId: result.artifactRevision.id,
        instanceId: pin.instanceId,
        componentArtifactId: pin.componentArtifactId,
        componentRevisionId: pin.revisionId,
        variantKey: pin.variantKey,
        stateKey: pin.stateKey,
        sourceLocator: pin.sourceLocator,
        overrides: pin.overrides,
        status: pin.status,
      })),
    );
    assert.deepEqual(
      fixture.store.workspace.listArtifactRevisionResourcePins(result.artifactRevision.id),
      fixture.claim.attempt.resourcePins.map((pin) => ({
        workspaceId: fixture.claim.attempt.workspaceId,
        ownerArtifactId: fixture.pageTask.target.id,
        revisionId: result.artifactRevision.id,
        resourceId: pin.resourceId,
        resourceRevisionId: pin.revisionId,
      })),
    );

    const expectedEvidenceHash = generationTaskCandidateEvidenceHash({
      taskId: fixture.pageTask.id,
      planId: fixture.plan.id,
      workspaceId: fixture.workspace.id,
      attempt: fixture.claim.attempt.attempt,
      candidateRevisionId: result.artifactRevision.id,
      candidateResourceRevisionId: null,
      candidateEvidence: input.evidence,
    });
    assert.equal(result.attempt.status, "candidate-ready");
    assert.equal(result.attempt.candidateRevisionId, result.artifactRevision.id);
    assert.equal(result.attempt.candidateResourceRevisionId, null);
    assert.deepEqual(result.attempt.candidateEvidence, input.evidence);
    assert.equal(result.attempt.candidateEvidenceHash, expectedEvidenceHash);
    assert.deepEqual(result.attempt.lease, fixture.claim.lease);
    assert.equal(result.attempt.leaseExpiresAt, fixture.claim.attempt.leaseExpiresAt);
    assert.equal(result.attempt.heartbeatAt, fixture.claim.attempt.heartbeatAt);

    const after = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    assert.equal(after.activeSnapshotId, before.activeSnapshotId);
    assert.equal(after.activeHeadRevisionId, before.activeHeadRevisionId);
    assert.equal(after.artifactRevisionCount, before.artifactRevisionCount + 1);
    assert.deepEqual(after.claims, before.claims);
    assert.equal(after.task.status, "candidate-ready");
    assert.equal(after.task.resultRevisionId, null);
    assert.equal(after.task.resultSnapshotId, null);
    assert.equal(after.candidateEvents.length, before.candidateEvents.length + 1);
    assert.deepEqual(after.candidateEvents.at(-1), {
      planId: fixture.plan.id,
      sequence: after.candidateEvents.at(-1)?.sequence,
      taskId: fixture.pageTask.id,
      type: "task-candidate-ready",
      payload: {
        attempt: fixture.claim.attempt.attempt,
        candidateRevisionId: result.artifactRevision.id,
        candidateResourceRevisionId: null,
        candidateEvidenceHash: expectedEvidenceHash,
      },
      createdAt: after.candidateEvents.at(-1)?.createdAt,
    });
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging requires source evidence from an exact Sharingan pin and Context", () => {
  const fixture = createCandidateFixture("sharingan-source-required", "sharingan-capture");
  try {
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        inputForClaim("sharingan-source-required", fixture.claim, fixture.project.id),
      ),
      GenerationTaskQualityGateError,
    );
    assert.deepEqual(
      candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      ),
      before,
      "failed source evidence validation must not stage any candidate state",
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging rejects an unpinned Sharingan Context source with zero writes", () => {
  const fixture = createCandidateFixture("sharingan-context-unpinned", {
    primaryResourceKind: "asset",
    extraSharinganResourceCount: 1,
    pinExtraSharinganResources: false,
  });
  try {
    assert.equal(
      fixture.claim.attempt.resourcePins.some((pin) => (
        fixture.extraSharinganResources.some(({ created }) => created.resource.id === pin.resourceId)
      )),
      false,
    );
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        inputForClaim("sharingan-context-unpinned", fixture.claim, fixture.project.id),
      ),
      /Sharingan Capture.*exactly match|source authority/i,
    );
    assert.deepEqual(
      candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      ),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging rejects multiple exact Sharingan pins with zero writes", () => {
  const fixture = createCandidateFixture("sharingan-pins-ambiguous", {
    primaryResourceKind: "sharingan-capture",
    extraSharinganResourceCount: 1,
    pinExtraSharinganResources: true,
  });
  try {
    assert.equal(fixture.claim.attempt.resourcePins.length, 2);
    assert.equal(
      fixture.pageContext.items.filter((item) => item.ref.kind === "resource"
        && item.ref.resourceKind === "sharingan-capture").length,
      2,
    );
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        inputForClaim(
          "sharingan-pins-ambiguous",
          fixture.claim,
          fixture.project.id,
          true,
        ),
      ),
      /Sharingan Capture source authority is ambiguous/i,
    );
    assert.deepEqual(
      candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      ),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging rejects multiple Sharingan Context sources with one pin and zero writes", () => {
  const fixture = createCandidateFixture("sharingan-context-ambiguous", {
    primaryResourceKind: "sharingan-capture",
    extraSharinganResourceCount: 1,
    pinExtraSharinganResources: false,
  });
  try {
    assert.equal(fixture.claim.attempt.resourcePins.length, 1);
    assert.equal(
      fixture.pageContext.items.filter((item) => item.ref.kind === "resource"
        && item.ref.resourceKind === "sharingan-capture").length,
      2,
    );
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        inputForClaim(
          "sharingan-context-ambiguous",
          fixture.claim,
          fixture.project.id,
          true,
        ),
      ),
      /Sharingan Capture source authority is ambiguous/i,
    );
    assert.deepEqual(
      candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      ),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging rejects Sharingan omissions beside an exact source with zero writes", () => {
  const fixture = createCandidateFixture("sharingan-source-omitted", {
    primaryResourceKind: "sharingan-capture",
    includeSharinganOmission: true,
  });
  try {
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        inputForClaim(
          "sharingan-source-omitted",
          fixture.claim,
          fixture.project.id,
          true,
        ),
      ),
      /Sharingan Capture source authority is ambiguous/i,
    );
    assert.deepEqual(
      candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      ),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging re-resolves an omitted Resource kind before trusting source authority", () => {
  const fixture = createCandidateFixture("sharingan-omission-kind-drift", {
    primaryResourceKind: "asset",
    includeSharinganOmission: true,
    sharinganOmissionDeclaredKind: "asset",
  });
  try {
    const omission = fixture.pageContext.omissions[0];
    assert.ok(omission?.ref.kind === "resource");
    fixture.store.db.prepare(
      `INSERT INTO resources (
         id, workspace_id, kind, title, head_revision_id, default_pin_policy,
         archived_at, created_at, updated_at
       ) VALUES (?, ?, 'sharingan-capture', 'Late Sharingan source', NULL,
         'follow-head', NULL, 100000, 100000)`,
    ).run(omission.ref.id, fixture.workspace.id);
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );

    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        inputForClaim("sharingan-omission-kind-drift", fixture.claim, fixture.project.id),
      ),
      /Context Pack omission.*Resource kind|Sharingan Capture source authority|ownership/i,
    );
    assert.deepEqual(
      candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      ),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate replay and publication revalidate late omitted Resource identity drift", () => {
  const fixture = createCandidateFixture("sharingan-omission-publication-drift", {
    primaryResourceKind: "asset",
    includeSharinganOmission: true,
    sharinganOmissionDeclaredKind: "asset",
  });
  try {
    const input = inputForClaim(
      "sharingan-omission-publication-drift",
      fixture.claim,
      fixture.project.id,
    );
    const staged = fixture.store.workspace.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    assert.equal(staged.attempt.status, "candidate-ready");
    const omission = fixture.pageContext.omissions[0];
    assert.ok(omission?.ref.kind === "resource");
    fixture.store.db.prepare(
      `INSERT INTO resources (
         id, workspace_id, kind, title, head_revision_id, default_pin_policy,
         archived_at, created_at, updated_at
       ) VALUES (?, ?, 'sharingan-capture', 'Late Sharingan source', NULL,
         'follow-head', NULL, 100000, 100000)`,
    ).run(omission.ref.id, fixture.workspace.id);
    const beforeReplay = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );

    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ),
      /Context Pack omission.*Resource kind|Sharingan Capture source authority|ownership/i,
    );
    assert.throws(
      () => fixture.store.workspace.publishGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        { lease: fixture.claim.lease },
      ),
      /Context Pack omission.*Resource kind|Sharingan Capture source authority|ownership/i,
    );
    assert.deepEqual(
      candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      ),
      beforeReplay,
    );
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging and publication revalidate one exact Sharingan source", () => {
  const fixture = createCandidateFixture("sharingan-source-exact", "sharingan-capture");
  try {
    const input = inputForClaim(
      "sharingan-source-exact",
      fixture.claim,
      fixture.project.id,
      true,
    );
    const staged = fixture.store.workspace.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    assert.equal(staged.attempt.status, "candidate-ready");
    assert.deepEqual(staged.attempt.candidateEvidence, input.evidence);

    const published = fixture.store.workspace.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      { lease: fixture.claim.lease },
    );
    assert.equal(published.status, "succeeded");
    assert.equal(published.artifactRevision.id, staged.artifactRevision.id);

    const replayed = fixture.store.workspace.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      { lease: fixture.claim.lease },
    );
    assert.equal(replayed.status, "succeeded");
    assert.equal(replayed.artifactRevision.id, staged.artifactRevision.id);
  } finally {
    fixture.store.close();
  }
});

test("Artifact source authority coalesces the same exact Sharingan Revision across Context classes", () => {
  const fixture = createCandidateFixture("sharingan-source-cross-class", {
    primaryResourceKind: "sharingan-capture",
    duplicatePrimaryContextResource: true,
  });
  try {
    assert.equal(
      fixture.pageContext.items.filter((item) => item.ref.kind === "resource"
        && item.ref.resourceKind === "sharingan-capture").length,
      2,
      "Core receives the class-erased duplicate of one exact daemon Context authority",
    );
    const staged = fixture.store.workspace.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      inputForClaim(
        "sharingan-source-cross-class",
        fixture.claim,
        fixture.project.id,
        true,
      ),
    );
    assert.equal(staged.attempt.status, "candidate-ready");
  } finally {
    fixture.store.close();
  }
});

test("Artifact candidate staging rejects unrelated or fabricated Sharingan source authority", () => {
  const fixture = createCandidateFixture("sharingan-source-authority-forged", "sharingan-capture");
  try {
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    for (const [field, value] of [
      ["resourceId", "resource-sharingan-foreign"],
      ["revisionId", "resource-revision-sharingan-foreign"],
      ["revisionChecksum", "0".repeat(64)],
    ] as const) {
      const input = inputForClaim(
        "sharingan-source-authority-forged",
        fixture.claim,
        fixture.project.id,
        true,
      );
      const evidence = input.evidence as {
        qualityEvidence: {
          sourceVisualEvidence: {
            sourceAuthority: Record<string, string>;
          };
        };
      };
      evidence.qualityEvidence.sourceVisualEvidence.sourceAuthority = {
        ...evidence.qualityEvidence.sourceVisualEvidence.sourceAuthority,
        [field]: value,
      };
      assert.throws(
        () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          input,
        ),
        /source descriptor|source authority/i,
        field,
      );
      assert.deepEqual(
        candidateDurableState(
          fixture.store,
          fixture.project.id,
          fixture.plan.id,
          fixture.pageTask.id,
        ),
        before,
        `${field} substitution must not stage candidate state`,
      );
    }
  } finally {
    fixture.store.close();
  }
});

test("staging preserves a detached candidate when the target Head advances after materialization", () => {
  const fixture = createCandidateFixture("head-drift");
  try {
    assert.equal(fixture.claim.attempt.target.type, "artifact");
    if (fixture.claim.attempt.target.type !== "artifact") return;
    const driftRevision = fixture.store.workspace.createArtifactRevision({
      artifactId: fixture.claim.attempt.target.id,
      trackId: fixture.claim.attempt.target.trackId,
      parentRevisionId: fixture.claim.attempt.baseRevisionId,
      sourceCommitHash: checksum("head-drift:direct-edit-commit"),
      sourceTreeHash: checksum("head-drift:direct-edit-tree"),
      kernelRevisionId: fixture.claim.attempt.kernelRevisionId,
      renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 99, findings: [] },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    const beforeDrift = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const driftSnapshot = fixture.store.workspace.publishArtifactRevision(driftRevision.id, {
      expectedHeadRevisionId: fixture.claim.attempt.baseRevisionId,
      expectedSnapshotId: beforeDrift.activeSnapshotId,
    });

    const result = fixture.store.workspace.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      inputForClaim("head-drift", fixture.claim, fixture.project.id),
    );
    assert.equal(result.attempt.status, "candidate-ready");
    assert.equal(result.artifactRevision.parentRevisionId, fixture.claim.attempt.baseRevisionId);
    assert.notEqual(result.artifactRevision.parentRevisionId, driftRevision.id);
    assert.equal(
      fixture.store.workspace.getTrack(fixture.claim.attempt.target.trackId)?.headRevisionId,
      driftRevision.id,
      "candidate staging must leave publication conflict detection to the later CAS transaction",
    );
    assert.equal(
      fixture.store.workspace.getWorkspace(fixture.project.id)?.activeSnapshotId,
      driftSnapshot.id,
    );
  } finally {
    fixture.store.close();
  }
});

test("staging preserves a detached root candidate when a concurrent root publishes after materialization", () => {
  const label = "detached-root-head-drift";
  const control = controlledClock(`candidate-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: "Detached root candidate", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const layout = store.workspace.getLayout(project.id);
  const artifactId = `candidate-page-${label}`;
  const trackId = `candidate-page-track-${label}`;
  const nodeId = `candidate-page-node-${label}`;
  const proposal = store.workspace.createProposal({
    projectId: project.id,
    kind: "workspace-generation",
    baseGraphRevision: foundation.graphRevision,
    baseSnapshotId: foundation.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations: [{
      id: `add-page-${label}`,
      type: "add-node",
      node: {
        id: nodeId,
        kind: "page",
        name: "Generated root Page",
        artifactId,
        createIdentity: { initialTrackId: trackId },
      },
    }],
    layoutOperations: [],
    generation: {
      ...emptyGeneration(),
      artifactPlans: [{
        operation: "create",
        nodeId,
        artifactId,
        kind: "page",
        name: "Generated root Page",
        trackId,
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      }],
    },
    rationale: "Keep generation detached until its exact root can publish",
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
  const workspace = store.workspace.getWorkspace(project.id)!;
  const context = persistArtifactContextPack(store, {
    id: `candidate-page-context-${label}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    targetArtifactId: artifactId,
    kernelRevisionId: observation.kernelRevisionId,
    artifacts: [],
  });
  const attempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...observation,
      contextPackId: context.id,
      sourceCommitHash: checksum(`${label}:attempt-source-commit`),
      sourceTreeHash: checksum(`${label}:attempt-source-tree`),
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `candidate-worker-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  control.set(100_001);

  try {
    const competing = store.workspace.createArtifactRevision({
      artifactId,
      trackId,
      parentRevisionId: null,
      sourceCommitHash: checksum(`${label}:competing-commit`),
      sourceTreeHash: checksum(`${label}:competing-tree`),
      kernelRevisionId: attempt.kernelRevisionId,
      renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
      quality: { state: "passed", score: 99, findings: [] },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    const competingSnapshot = store.workspace.publishArtifactRevision(competing.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: attempt.expectedSnapshotId,
    });

    const staged = store.workspace.stageGenerationTaskCandidateForProject(
      project.id,
      compiled.plan.id,
      inputForClaim(label, claim, project.id),
    );
    assert.equal(staged.artifactRevision.parentRevisionId, null);
    assert.notEqual(staged.artifactRevision.id, competing.id);
    assert.equal(store.workspace.getTrack(trackId)?.headRevisionId, competing.id);
    assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, competingSnapshot.id);

    const published = store.workspace.publishGenerationTaskCandidateForProject(
      project.id,
      compiled.plan.id,
      { lease: claim.lease },
    );
    assert.equal(published.status, "needs-rebase");
    assert.deepEqual(published.conflict, {
      pointer: "artifact-head",
      expectedId: null,
      actualId: competing.id,
    });
    assert.equal(published.artifactRevision.id, staged.artifactRevision.id);
    assert.equal(store.workspace.getTrack(trackId)?.headRevisionId, competing.id);
    assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, competingSnapshot.id);
  } finally {
    store.close();
  }
});

test("candidate staging rejects non-git object hashes before making any durable write", () => {
  const fixture = createCandidateFixture("invalid-git-hash");
  try {
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    const input = inputForClaim("invalid-git-hash", fixture.claim, fixture.project.id);
    input.candidate = { ...input.candidate, sourceCommitHash: "not-a-git-object-id" };
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ),
      /git object|source commit hash|lowercase hex/i,
    );
    assert.deepEqual(
      candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("candidate staging rejects failed quality before making any durable write", () => {
  const fixture = createCandidateFixture("failed-quality");
  try {
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    const input = inputForClaim("failed-quality", fixture.claim, fixture.project.id);
    input.candidate = {
      ...input.candidate,
      quality: { state: "failed", score: 42, findings: [] },
    };
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ),
      (error) => error instanceof GenerationTaskQualityGateError,
    );
    assert.deepEqual(
      candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("candidate staging fences visual evidence to the authoritative Store Project", () => {
  const fixture = createCandidateFixture("foreign-evidence-project");
  try {
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    const input = inputForClaim(
      "foreign-evidence-project",
      fixture.claim,
      fixture.project.id,
    );
    input.evidence = { ...input.evidence, projectId: "project-foreign" };
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ),
      (error) => error instanceof GenerationTaskQualityGateError,
    );
    assert.deepEqual(
      candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("candidate staging rolls back the Revision and state when the ready event cannot commit", () => {
  const fixture = createCandidateFixture("rollback");
  try {
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    fixture.store.db.exec(
      `CREATE TRIGGER reject_candidate_ready_event
       BEFORE INSERT ON generation_plan_events
       WHEN NEW.type = 'task-candidate-ready'
       BEGIN
         SELECT RAISE(ABORT, 'injected candidate-ready event failure');
       END`,
    );
    assert.throws(
      () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        inputForClaim("rollback", fixture.claim, fixture.project.id),
      ),
      /injected candidate-ready event failure/,
    );
    assert.deepEqual(
      candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
      before,
    );
  } finally {
    fixture.store.close();
  }
});

test("wrong, expired, and stale lease tokens fence candidate staging with zero writes", async (t) => {
  await t.test("wrong lease token", () => {
    const fixture = createCandidateFixture("wrong-token");
    try {
      const input = inputForClaim("wrong-token", fixture.claim, fixture.project.id);
      input.lease = { ...input.lease, leaseToken: `${input.lease.leaseToken}-wrong` };
      const before = candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      );
      assert.throws(
        () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          input,
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(
        candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
        before,
      );
    } finally {
      fixture.store.close();
    }
  });

  await t.test("expired current lease", () => {
    const fixture = createCandidateFixture("expired-token");
    try {
      assert.ok(fixture.claim.attempt.leaseExpiresAt);
      fixture.control.set(fixture.claim.attempt.leaseExpiresAt);
      const before = candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      );
      assert.throws(
        () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          inputForClaim("expired-token", fixture.claim, fixture.project.id),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(
        candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
        before,
      );
    } finally {
      fixture.store.close();
    }
  });

  await t.test("stale lease after recovery and takeover", () => {
    const fixture = createCandidateFixture("stale-token");
    try {
      assert.ok(fixture.claim.attempt.leaseExpiresAt);
      fixture.control.set(fixture.claim.attempt.leaseExpiresAt);
      const recovery = fixture.store.workspace.recoverExpiredGenerationTaskAttempts(
        fixture.claim.attempt.leaseExpiresAt,
      );
      assert.deepEqual(recovery.retriedTaskIds, [fixture.pageTask.id]);
      const detail = fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      );
      const recoveredTask = detail.tasks.find((task) => task.id === fixture.pageTask.id);
      assert.ok(recoveredTask);
      const successor = fixture.store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
        recoveredTask.currentAttempt,
      );
      assert.ok(successor);
      assert.ok(recoveredTask.nextEligibleAt);
      const takeoverNow = recoveredTask.nextEligibleAt;
      const replacement = fixture.store.workspace.tryClaimGenerationTaskAttempt({
        taskId: fixture.pageTask.id,
        attempt: successor.attempt,
        ownerId: "replacement-worker",
        now: takeoverNow,
        leaseMs: 30_000,
      });
      assert.ok(replacement);
      fixture.control.set(takeoverNow + 1);
      const before = candidateDurableState(
        fixture.store,
        fixture.project.id,
        fixture.plan.id,
        fixture.pageTask.id,
      );
      assert.throws(
        () => fixture.store.workspace.stageGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          inputForClaim("stale-token", fixture.claim, fixture.project.id),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(
        candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
        before,
      );
    } finally {
      fixture.store.close();
    }
  });
});

test("candidate staging replays an exact lost response and rejects a different input", () => {
  const fixture = createCandidateFixture("replay");
  try {
    const api = fixture.store.workspace;
    const input = inputForClaim("replay", fixture.claim, fixture.project.id);
    const before = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    const first = api.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    const afterFirst = candidateDurableState(
      fixture.store,
      fixture.project.id,
      fixture.plan.id,
      fixture.pageTask.id,
    );
    const replay = api.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    assert.deepEqual(replay, first);
    assert.deepEqual(
      candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
      afterFirst,
    );
    assert.equal(afterFirst.artifactRevisionCount, before.artifactRevisionCount + 1);
    assert.equal(afterFirst.candidateEvents.length, before.candidateEvents.length + 1);

    const differentCandidate: StageGenerationTaskCandidateInput = {
      ...input,
      candidate: { ...input.candidate, sourceTreeHash: checksum("different-tree") },
    };
    assert.throws(
      () => api.stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        differentCandidate,
      ),
      /candidate|conflict|different|replay/i,
    );
    assert.deepEqual(
      candidateDurableState(fixture.store, fixture.project.id, fixture.plan.id, fixture.pageTask.id),
      afterFirst,
    );
  } finally {
    fixture.store.close();
  }
});
