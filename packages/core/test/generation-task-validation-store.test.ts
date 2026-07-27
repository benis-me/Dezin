import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generationTaskCandidateEvidenceHash,
  generationTaskPrototypeRuntimeReceiptNonce,
  GenerationTaskLeaseFenceError,
  Store,
  type GenerationTaskAttemptClaim,
  type CompleteGenerationTaskValidationInput,
  type GenerationTaskPrototypeMarkerProof,
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

function emptyGeneration() {
  return {
    kind: "workspace-generation" as const,
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
}

function createFixture(label: string) {
  const control = controlledClock(`validation-publication-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Validation publication ${label}`, mode: "standard" });
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
    rationale: `Validate immutable Snapshot ${label}`,
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
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `validation-owner-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  const snapshot = store.workspace.listSnapshots(project.id)
    .find((candidate) => candidate.id === attempt.expectedSnapshotId);
  assert.ok(snapshot);
  control.set(100_001);
  const input: CompleteGenerationTaskValidationInput = {
    lease: claim.lease,
    validation: {
      snapshotId: snapshot.id,
      graphRevision: snapshot.graphRevision,
      artifactRevisionIds: [],
      resourceRevisionIds: [],
      evidence: {
        protocol: "dezin-prototype-validation-v1",
        snapshot: {
          id: snapshot.id,
          graphRevision: snapshot.graphRevision,
          kernelRevisionId: snapshot.kernelRevisionId,
        },
        dependencies: [],
        artifacts: [],
        resources: [],
        prototypeEdges: [],
        frames: [],
      },
    },
  };
  return { control, store, project, workspace, plan: compiled.plan, task, attempt, claim, snapshot, input };
}

function claimCount(store: Store, claim: GenerationTaskAttemptClaim): number {
  return Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
  ).get(claim.task.id, claim.attempt.attempt) as { count: number }).count);
}

interface PrototypeFinalizationStoreApi {
  completeGenerationTaskPrototypeFinalizationForProject(
    projectId: string,
    planId: string,
    input: {
      lease: GenerationTaskAttemptClaim["lease"];
      finalization: {
        baseSnapshotId: string;
        baseGraphRevision: number;
        artifactRevisionIds: string[];
        resourceRevisionIds: string[];
        markerProofs: GenerationTaskPrototypeMarkerProof[];
      };
    },
  ): ReturnType<Store["workspace"]["completeGenerationTaskValidationForProject"]>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finalizationMarkerProof(input: {
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  markerId: string;
  sourceCommitHash: string;
  sourceTreeHash: string;
  frames: Array<{ id: string; width: number; height: number }>;
  taskId: string;
  attempt: number;
  edgeId: string;
}): GenerationTaskPrototypeMarkerProof {
  const manifest = {
    protocol: "dezin.artifact-element-selection-manifest.v1" as const,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    artifactRevisionId: input.revisionId,
    assemblyHash: sha256(`assembly:${input.revisionId}`),
    designNodeId: input.markerId,
    sourceArtifactId: input.artifactId,
    sourceArtifactRevisionId: input.revisionId,
    sourceCommitHash: input.sourceCommitHash,
    sourceTreeHash: input.sourceTreeHash,
    sourcePath: "src/Home.tsx",
  };
  const canonical = Object.fromEntries(Object.entries(manifest).sort(([left], [right]) => (
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  )));
  const dependencyLockHash = sha256(`dependency-lock:${input.revisionId}`);
  const runtimeIdentityHash = sha256(JSON.stringify({
    protocol: "dezin.artifact-preview-runtime-identity.v1",
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    artifactRevisionId: input.revisionId,
    assemblyHash: manifest.assemblyHash,
    sourceTreeHash: input.sourceTreeHash,
    dependencyLockHash,
  }));
  const runtime = {
    protocol: "dezin.artifact-prototype-runtime-proof.v1" as const,
    runtimeIdentityHash,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    artifactRevisionId: input.revisionId,
    assemblyHash: manifest.assemblyHash,
    designNodeId: input.markerId,
    trigger: "click" as const,
    sourceTreeHash: input.sourceTreeHash,
    dependencyLockHash,
    receiptNonce: generationTaskPrototypeRuntimeReceiptNonce(
      input.taskId,
      input.attempt,
      input.edgeId,
      input.markerId,
    ),
    frames: input.frames
      .map((frame) => ({
        frameId: frame.id,
        width: frame.width,
        height: frame.height,
        tagName: "button",
        role: null,
        action: "button" as const,
        visible: true as const,
      }))
      .sort((left, right) => left.frameId.localeCompare(right.frameId)),
  };
  return {
    ...manifest,
    selectionManifestHash: sha256(JSON.stringify(canonical)),
    runtimeProof: {
      ...runtime,
      receiptHash: sha256(JSON.stringify(runtime)),
    },
  };
}

function createV2FinalizationFixture(label: string) {
  const control = controlledClock(`prototype-finalization-${label}`);
  const store = new Store(":memory:", control.clock);
  const project = store.createProject({ name: `Prototype finalization ${label}`, mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const pages = [
    { id: "home", name: "Home" },
    { id: "details", name: "Details" },
    { id: "checkout", name: "Checkout" },
  ] as const;
  const edges = [
    { id: "edge-home-checkout", target: "checkout", markerId: "marker-home-checkout" },
    { id: "edge-home-details", target: "details", markerId: "marker-home-details" },
  ] as const;
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [
      ...pages.map((page) => ({
        id: `add-node-${page.id}`,
        type: "add-node" as const,
        node: {
          id: `node-${page.id}`,
          kind: "page" as const,
          name: page.name,
          artifactId: `page-${page.id}`,
          createIdentity: { initialTrackId: `track-${page.id}` },
        },
      })),
      ...edges.map((edge) => ({
        id: `add-${edge.id}`,
        type: "add-edge" as const,
        edge: {
          id: edge.id,
          workspaceId: foundation.id,
          kind: "prototype" as const,
          sourceNodeId: "node-home",
          targetNodeId: `node-${edge.target}`,
        },
      })),
    ],
  });
  const frames = [
    { id: "desktop", name: "Desktop", width: 1_440, height: 900 },
    { id: "mobile", name: "Mobile", width: 390, height: 844 },
  ];
  let activeSnapshotId = graph.snapshot.id;
  const baseRevisions = new Map<string, string>();
  for (const page of pages) {
    const workspace = store.workspace.getWorkspace(project.id)!;
    const revision = store.workspace.createArtifactRevision({
      artifactId: `page-${page.id}`,
      trackId: `track-${page.id}`,
      parentRevisionId: null,
      sourceCommitHash: sha256(`${label}:${page.id}:base-commit`),
      sourceTreeHash: sha256(`${label}:${page.id}:base-tree`),
      kernelRevisionId: workspace.activeKernelRevisionId,
      renderSpec: { frames },
      quality: { state: "passed", score: 100, findings: [] },
      contextPackHash: null,
      dependencies: [],
      resourcePins: [],
    });
    const snapshot = store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: activeSnapshotId,
    });
    activeSnapshotId = snapshot.id;
    baseRevisions.set(page.id, revision.id);
  }
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
      version: 2,
      artifactPlans: pages.map((page) => ({
        operation: "revise" as const,
        nodeId: `node-${page.id}`,
        artifactId: `page-${page.id}`,
        kind: "page" as const,
        name: page.name,
        trackId: `track-${page.id}`,
        baseRevisionId: baseRevisions.get(page.id)!,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: frames.map((frame) => frame.id),
        ...(page.id === "home"
          ? {
              prototypeRequirements: {
                outgoing: edges.map((edge) => ({
                  edgeId: edge.id,
                  sourceMarkerId: edge.markerId,
                  trigger: "click" as const,
                })),
                incoming: [],
              },
            }
          : {}),
      })),
      prototypeIntents: edges.map((edge) => ({
        edgeId: edge.id,
        sourceArtifactId: "page-home",
        targetArtifactId: `page-${edge.target}`,
        trigger: "click" as const,
        sourceMarkerId: edge.markerId,
      })),
      responsiveFrames: frames,
      qualityProfile: {
        requiredFrameIds: frames.map((frame) => frame.id),
        blockingSeverities: ["P0", "P1", "P2"],
        requireRuntimeChecks: true,
        requireVisualReview: true,
      },
    },
    rationale: "Bind every generated prototype edge only after immutable marker proof",
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const artifactTasks = compiled.tasks.filter((task) => task.kind === "page");
  assert.equal(artifactTasks.length, pages.length);
  const generatedRevisions = new Map<string, ReturnType<typeof store.workspace.createArtifactRevision>>();
  for (const [pageIndex, page] of pages.entries()) {
    const task = artifactTasks.find((candidate) => candidate.target.id === `page-${page.id}`)!;
    const observation = store.workspace.observeGenerationTaskMaterializationForProject(
      project.id,
      compiled.plan.id,
      task.id,
    );
    const frozenSnapshot = store.workspace.getSnapshotForProject(
      project.id,
      observation.expectedSnapshotId,
    )!;
    const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId)!;
    const baseRevisionId = baseRevisions.get(page.id)!;
    const baseRevision = store.workspace.getArtifactRevision(baseRevisionId)!;
    const baseChecksum = store.workspace.getArtifactRevisionContextChecksum(baseRevisionId)!;
    const contextHash = sha256(`${label}:${page.id}:context`);
    const context = store.workspace.persistContextPack({
      id: `context-pack-${contextHash}`,
      workspaceId: workspace.id,
      graphRevision: frozenSnapshot.graphRevision,
      target: { type: "artifact", id: `page-${page.id}` },
      intent: "generate",
      messageChecksum: sha256(`${label}:${page.id}:message`),
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
          ref: { kind: "artifact", id: `page-${page.id}`, revisionId: baseRevisionId },
          resolvedKind: "artifact-revision",
          artifactRevisionId: baseRevisionId,
          checksum: baseChecksum,
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
      manifestPath: `context-packs/${label}-${page.id}.json`,
      hash: contextHash,
    });
    const attempt = store.workspace.createGenerationTaskAttemptForProject(
      project.id,
      compiled.plan.id,
      {
        ...observation,
        contextPackId: context.id,
        sourceCommitHash: baseRevision.sourceCommitHash,
        sourceTreeHash: baseRevision.sourceTreeHash,
        retryContextPolicy: "same-context",
        executionMode: "full",
      },
    );
    const claimedAt = 70_000 + pageIndex * 1_000;
    control.set(claimedAt);
    const claim = store.workspace.tryClaimGenerationTaskAttempt({
      taskId: task.id,
      attempt: attempt.attempt,
      ownerId: `artifact-owner-${label}-${page.id}`,
      now: claimedAt,
      leaseMs: 30_000,
    });
    assert.ok(claim);
    const revision = store.workspace.createArtifactRevision({
      artifactId: `page-${page.id}`,
      trackId: `track-${page.id}`,
      parentRevisionId: baseRevisionId,
      sourceCommitHash: sha256(`${label}:${page.id}:generated-commit`),
      sourceTreeHash: sha256(`${label}:${page.id}:generated-tree`),
      kernelRevisionId: observation.kernelRevisionId,
      renderSpec: { frames },
      quality: { state: "passed", score: 100, findings: [] },
      contextPackHash: context.hash,
      dependencies: [],
      resourcePins: [],
    });
    const snapshot = store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: baseRevisionId,
      expectedSnapshotId: activeSnapshotId,
    });
    activeSnapshotId = snapshot.id;
    const candidateEvidence = { protocol: "prototype-finalization-test-artifact-v1" };
    const candidateEvidenceHash = generationTaskCandidateEvidenceHash({
      taskId: task.id,
      planId: compiled.plan.id,
      workspaceId: workspace.id,
      attempt: attempt.attempt,
      candidateRevisionId: revision.id,
      candidateResourceRevisionId: null,
      candidateEvidence,
    });
    const finishedAt = claimedAt + 1;
    const finishedAttempt = store.db.prepare(
      `UPDATE generation_task_attempts
       SET status = 'succeeded', candidate_revision_id = ?, candidate_evidence_json = ?,
           candidate_evidence_hash = ?, owner_id = NULL, lease_token = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL, finished_at = ?
       WHERE task_id = ? AND plan_id = ? AND attempt = ?`,
    ).run(
      revision.id,
      JSON.stringify(candidateEvidence),
      candidateEvidenceHash,
      finishedAt,
      task.id,
      compiled.plan.id,
      attempt.attempt,
    );
    assert.equal(Number(finishedAttempt.changes), 1);
    const updated = store.db.prepare(
      `UPDATE generation_tasks
       SET status = 'succeeded', result_revision_id = ?, result_snapshot_id = ?, finished_at = ?
       WHERE id = ? AND plan_id = ?`,
    ).run(revision.id, snapshot.id, finishedAt, task.id, compiled.plan.id);
    assert.equal(Number(updated.changes), 1);
    store.db.prepare("DELETE FROM generation_task_claims WHERE task_id = ? AND attempt = ?")
      .run(task.id, attempt.attempt);
    const eventSequence = Number((store.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM generation_plan_events WHERE plan_id = ?",
    ).get(compiled.plan.id) as { sequence: number }).sequence) + 1;
    store.db.prepare(
      `INSERT INTO generation_plan_events
         (plan_id, workspace_id, sequence, task_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'task-succeeded', ?, ?)`,
    ).run(
      compiled.plan.id,
      workspace.id,
      eventSequence,
      task.id,
      JSON.stringify({
        attempt: attempt.attempt,
        resultResourceRevisionId: null,
        resultRevisionId: revision.id,
        resultSnapshotId: snapshot.id,
      }),
      finishedAt,
    );
    generatedRevisions.set(page.id, revision);
  }
  const task = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation")!;
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
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `prototype-finalization-owner-${label}`,
    now: 100_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  control.set(100_001);
  const home = generatedRevisions.get("home")!;
  assert.deepEqual(
    [...generatedRevisions.values()].map((revision) => revision.renderSpec.frames),
    pages.map(() => frames),
  );
  assert.deepEqual((task.payload as { responsiveFrames?: unknown }).responsiveFrames, frames);
  const markerProofs = edges.map((edge) => finalizationMarkerProof({
    workspaceId: workspace.id,
    artifactId: "page-home",
    revisionId: home.id,
    markerId: edge.markerId,
    sourceCommitHash: home.sourceCommitHash,
    sourceTreeHash: home.sourceTreeHash,
    frames,
    taskId: task.id,
    attempt: attempt.attempt,
    edgeId: edge.id,
  }));
  const input = {
    lease: claim.lease,
    finalization: {
      baseSnapshotId: observation.expectedSnapshotId,
      baseGraphRevision: store.workspace.getSnapshotForProject(
        project.id,
        observation.expectedSnapshotId,
      )!.graphRevision,
      artifactRevisionIds: observation.dependencyOutputs
        .flatMap((output) => output.resultRevisionId === null ? [] : [output.resultRevisionId])
        .sort(),
      resourceRevisionIds: [],
      markerProofs,
    },
  };
  return {
    control,
    store,
    project,
    workspace,
    plan: compiled.plan,
    task,
    attempt,
    claim,
    edges,
    input,
  };
}

test("prototype validation success atomically records its exact immutable Snapshot and evidence", () => {
  const fixture = createFixture("success");
  try {
    const result = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.input,
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.task.status, "succeeded");
    assert.equal(result.attempt.status, "succeeded");
    assert.equal(result.task.resultSnapshotId, fixture.snapshot.id);
    assert.equal(result.snapshot.id, fixture.snapshot.id);
    assert.match(result.evidenceHash, /^[0-9a-f]{64}$/);
    assert.equal(claimCount(fixture.store, fixture.claim), 0);
    assert.equal(
      fixture.store.workspace.getGenerationPlanForProject(fixture.project.id, fixture.plan.id).status,
      "running",
      "the checkpoint remains responsible for successful Plan terminalization",
    );
    const events = fixture.store.workspace.listGenerationPlanEventsForProject(
      fixture.project.id,
      fixture.plan.id,
      { after: 0, limit: 1_000 },
    ).filter((event) => event.type === "task-succeeded" && event.taskId === fixture.task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.resultSnapshotId, fixture.snapshot.id);
    assert.equal(events[0]?.payload.validationEvidenceHash, result.evidenceHash);
    assert.equal(Object.hasOwn(events[0]!.payload, "validationEvidence"), false);
    const validation = fixture.store.workspace.getGenerationTaskValidationResultForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      fixture.attempt.attempt,
    );
    assert.deepEqual(validation, result.validation);
    assert.deepEqual(validation?.evidence, fixture.input.validation.evidence);
  } finally {
    fixture.store.close();
  }
});

test("v2 prototype finalization atomically binds every proven edge and records the new Snapshot", () => {
  const fixture = createV2FinalizationFixture("success");
  try {
    const api = fixture.store.workspace as unknown as PrototypeFinalizationStoreApi;
    const baseSnapshotCount = fixture.store.workspace.listSnapshots(fixture.project.id).length;

    const result = api.completeGenerationTaskPrototypeFinalizationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.input,
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.snapshot.parentSnapshotId, fixture.input.finalization.baseSnapshotId);
    assert.equal(result.snapshot.graphRevision, fixture.input.finalization.baseGraphRevision + 1);
    assert.equal(fixture.store.workspace.listSnapshots(fixture.project.id).length, baseSnapshotCount + 1);
    assert.equal(
      fixture.store.workspace.getWorkspace(fixture.project.id)?.activeSnapshotId,
      result.snapshot.id,
    );
    for (const edgeFixture of fixture.edges) {
      const edge = result.snapshot.graph.edges.find((candidate) => candidate.id === edgeFixture.id);
      assert.ok(edge && edge.kind === "prototype");
      assert.equal(edge.prototype.status, "interactive");
      assert.deepEqual(edge.prototype.binding.sourceLocator, {
        designNodeId: edgeFixture.markerId,
      });
      assert.equal(Object.hasOwn(edge.prototype.binding.sourceLocator, "sourcePath"), false);
      assert.equal(Object.hasOwn(edge.prototype.binding.sourceLocator, "selector"), false);
    }
    const evidence = result.validation.evidence as {
      protocol: string;
      prototypeEdges: Array<{
        sourceMarkerId: string;
        markerProof: GenerationTaskPrototypeMarkerProof;
      }>;
    };
    assert.equal(evidence.protocol, "dezin-prototype-finalization-v2");
    assert.deepEqual(
      evidence.prototypeEdges.map((edge) => edge.sourceMarkerId),
      fixture.edges.map((edge) => edge.markerId),
    );
    assert.ok(evidence.prototypeEdges.every((edge) => edge.markerProof.sourcePath === "src/Home.tsx"));
    assert.equal(claimCount(fixture.store, fixture.claim), 0);

    const replay = api.completeGenerationTaskPrototypeFinalizationForProject(
      fixture.project.id,
      fixture.plan.id,
      structuredClone(fixture.input),
    );
    assert.deepEqual(replay, result);
    assert.equal(fixture.store.workspace.listSnapshots(fixture.project.id).length, baseSnapshotCount + 1);

    const conflicting = structuredClone(fixture.input);
    conflicting.finalization.markerProofs[0]!.assemblyHash = sha256("conflicting-assembly");
    assert.throws(
      () => api.completeGenerationTaskPrototypeFinalizationForProject(
        fixture.project.id,
        fixture.plan.id,
        conflicting,
      ),
      GenerationTaskLeaseFenceError,
    );
  } finally {
    fixture.store.close();
  }
});

test("v2 prototype finalization rejects runtime receipts that are not trigger-compatible without mutation", () => {
  const fixture = createV2FinalizationFixture("runtime-trigger");
  try {
    const api = fixture.store.workspace as unknown as PrototypeFinalizationStoreApi;
    const beforeWorkspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const beforeSnapshots = fixture.store.workspace.listSnapshots(fixture.project.id).length;
    const input = structuredClone(fixture.input);
    const runtime = input.finalization.markerProofs[0]!.runtimeProof;
    runtime.frames[0]!.action = "form";
    const { receiptHash: _ignored, ...receipt } = runtime;
    runtime.receiptHash = sha256(JSON.stringify(receipt));

    assert.throws(
      () => api.completeGenerationTaskPrototypeFinalizationForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ),
      /not trigger-compatible/i,
    );
    const afterWorkspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    assert.equal(afterWorkspace.graphRevision, beforeWorkspace.graphRevision);
    assert.equal(afterWorkspace.activeSnapshotId, beforeWorkspace.activeSnapshotId);
    assert.equal(fixture.store.workspace.listSnapshots(fixture.project.id).length, beforeSnapshots);
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("v2 prototype finalization rolls every edge, graph Revision, Snapshot, validation, and claim back together", () => {
  const fixture = createV2FinalizationFixture("rollback");
  try {
    const api = fixture.store.workspace as unknown as PrototypeFinalizationStoreApi;
    const beforeWorkspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    const beforeSnapshots = fixture.store.workspace.listSnapshots(fixture.project.id).length;
    fixture.store.db.exec(`
      CREATE TRIGGER reject_prototype_finalization_event
      BEFORE INSERT ON generation_plan_events
      WHEN NEW.type = 'task-succeeded' AND NEW.task_id = '${fixture.task.id}'
      BEGIN SELECT RAISE(ABORT, 'reject prototype finalization event'); END;
    `);

    assert.throws(
      () => api.completeGenerationTaskPrototypeFinalizationForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.input,
      ),
      /reject prototype finalization event/i,
    );

    const afterWorkspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    assert.equal(afterWorkspace.graphRevision, beforeWorkspace.graphRevision);
    assert.equal(afterWorkspace.activeSnapshotId, beforeWorkspace.activeSnapshotId);
    assert.equal(fixture.store.workspace.listSnapshots(fixture.project.id).length, beforeSnapshots);
    const graph = fixture.store.workspace.getGraph(fixture.project.id);
    for (const edgeFixture of fixture.edges) {
      const edge = graph.edges.find((candidate) => candidate.id === edgeFixture.id);
      assert.ok(edge && edge.kind === "prototype");
      assert.deepEqual(edge.prototype, { status: "planned" });
    }
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
    ).get(fixture.task.id) as { count: number }).count), 0);
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("a lost validation response replays only for the exact lease and result fence", () => {
  const fixture = createFixture("replay");
  try {
    const first = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.input,
    );
    const replay = fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      structuredClone(fixture.input),
    );
    assert.deepEqual(replay, first);

    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        { ...fixture.input, lease: { ...fixture.input.lease, leaseToken: "wrong-replay-token" } },
      ),
      GenerationTaskLeaseFenceError,
    );
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          ...fixture.input,
          validation: { ...fixture.input.validation, graphRevision: fixture.input.validation.graphRevision + 1 },
        },
      ),
      GenerationTaskLeaseFenceError,
    );
    const events = fixture.store.workspace.listGenerationPlanEventsForProject(
      fixture.project.id,
      fixture.plan.id,
      { after: 0, limit: 1_000 },
    ).filter((event) => event.type === "task-succeeded" && event.taskId === fixture.task.id);
    assert.equal(events.length, 1);
  } finally {
    fixture.store.close();
  }
});

test("validation rejects semantic drift without changing the live Attempt or its claims", () => {
  const fixture = createFixture("drift");
  try {
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          ...fixture.input,
          validation: {
            ...fixture.input.validation,
            artifactRevisionIds: ["foreign-artifact-revision"],
          },
        },
      ),
      /Revision set|dependency|validation/i,
    );
    assert.equal(
      fixture.store.workspace.getGenerationPlanDetailForProject(
        fixture.project.id,
        fixture.plan.id,
      ).tasks.find((task) => task.id === fixture.task.id)?.status,
      "running",
    );
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("validation rejects incomplete deterministic evidence without writing terminal state", () => {
  const fixture = createFixture("incomplete-evidence");
  try {
    const evidence = structuredClone(fixture.input.validation.evidence);
    delete evidence.frames;
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          ...fixture.input,
          validation: { ...fixture.input.validation, evidence },
        },
      ),
      /validation|evidence|frames/i,
    );
    const task = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id);
    assert.equal(task?.status, "running");
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
    ).get(fixture.task.id) as { count: number }).count), 0);
  } finally {
    fixture.store.close();
  }
});

test("validation rejects tampered prototype edge and Frame evidence without writing terminal state", async (t) => {
  for (const [label, field, value] of [
    ["prototype-edge", "prototypeEdges", [{ edgeId: "unvalidated-edge" }]],
    ["frame", "frames", [{ id: "unvalidated-frame" }]],
  ] as const) {
    await t.test(label, () => {
      const fixture = createFixture(`tampered-${label}`);
      try {
        assert.throws(
          () => fixture.store.workspace.completeGenerationTaskValidationForProject(
            fixture.project.id,
            fixture.plan.id,
            {
              ...fixture.input,
              validation: {
                ...fixture.input.validation,
                evidence: {
                  ...fixture.input.validation.evidence,
                  [field]: value,
                },
              },
            },
          ),
          /validation|evidence|prototype|frame/i,
        );
        const task = fixture.store.workspace.getGenerationPlanDetailForProject(
          fixture.project.id,
          fixture.plan.id,
        ).tasks.find((candidate) => candidate.id === fixture.task.id);
        assert.equal(task?.status, "running");
        assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
        assert.equal(Number((fixture.store.db.prepare(
          "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
        ).get(fixture.task.id) as { count: number }).count), 0);
      } finally {
        fixture.store.close();
      }
    });
  }
});

test("validation event persistence failure rolls state and claim release back", () => {
  const fixture = createFixture("rollback");
  try {
    fixture.store.db.exec(`
      CREATE TRIGGER reject_validation_success_event
      BEFORE INSERT ON generation_plan_events
      WHEN NEW.type = 'task-succeeded' AND NEW.task_id = '${fixture.task.id}'
      BEGIN SELECT RAISE(ABORT, 'reject validation success event'); END;
    `);
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.input,
      ),
      /reject validation success event/i,
    );
    const task = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id)!;
    assert.equal(task.status, "running");
    assert.equal(task.resultSnapshotId, null);
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("validation completion rejects the exact lease expiry boundary", () => {
  const fixture = createFixture("expiry");
  try {
    fixture.control.set(130_000);
    assert.throws(
      () => fixture.store.workspace.completeGenerationTaskValidationForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.input,
      ),
      GenerationTaskLeaseFenceError,
    );
    assert.equal(claimCount(fixture.store, fixture.claim), fixture.claim.claims.length);
  } finally {
    fixture.store.close();
  }
});

test("validation result history is immutable but Project root deletion still cascades", () => {
  const fixture = createFixture("history-cascade");
  try {
    fixture.store.workspace.completeGenerationTaskValidationForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.input,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        "UPDATE generation_task_validation_results SET graph_revision = graph_revision + 1 WHERE task_id = ?",
      ).run(fixture.task.id),
      /immutable/i,
    );
    assert.throws(
      () => fixture.store.db.prepare(
        "DELETE FROM generation_task_validation_results WHERE task_id = ?",
      ).run(fixture.task.id),
      /immutable/i,
    );

    fixture.store.deleteProject(fixture.project.id);
    assert.equal(fixture.store.getProject(fixture.project.id), null);
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
    ).get(fixture.task.id) as { count: number }).count), 0);
  } finally {
    fixture.store.close();
  }
});

test("schema replay reopens a persistent Store after installing validation triggers", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-validation-schema-"));
  const file = join(directory, "store.sqlite");
  try {
    new Store(file, controlledClock("validation-schema-first").clock).close();
    new Store(file, controlledClock("validation-schema-second").clock).close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite rejects an oversized direct validation result before it can poison the Attempt", () => {
  const fixture = createFixture("direct-oversize");
  try {
    const oversizedEvidence = JSON.stringify({
      protocol: "dezin-prototype-validation-v1",
      snapshot: {
        id: fixture.snapshot.id,
        graphRevision: fixture.snapshot.graphRevision,
        kernelRevisionId: fixture.snapshot.kernelRevisionId,
      },
      padding: "x".repeat(1024 * 1024),
    });
    assert.throws(
      () => fixture.store.db.prepare(
        `INSERT INTO generation_task_validation_results (
           task_id, plan_id, workspace_id, attempt, snapshot_id, graph_revision,
           artifact_revision_ids_json, resource_revision_ids_json, evidence_json,
           evidence_hash, validation_fence_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)`,
      ).run(
        fixture.task.id,
        fixture.plan.id,
        fixture.workspace.id,
        fixture.attempt.attempt,
        fixture.snapshot.id,
        fixture.snapshot.graphRevision,
        oversizedEvidence,
        "d".repeat(64),
        "e".repeat(64),
        100_001,
      ),
      /stale|inconsistent/i,
    );
    assert.equal(Number((fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM generation_task_validation_results WHERE task_id = ?",
    ).get(fixture.task.id) as { count: number }).count), 0);
  } finally {
    fixture.store.close();
  }
});
