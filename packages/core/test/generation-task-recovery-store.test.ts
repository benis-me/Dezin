import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generationTaskCandidateEvidenceHash,
  Store,
  type FinishGenerationTaskAttemptFailureInput,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptClaim,
  type GenerationTaskAttemptLease,
  type StoreClock,
} from "../src/index.ts";

interface GenerationTaskRecoveryStoreContract {
  finishGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    input: FinishGenerationTaskAttemptFailureInput,
  ): unknown;
  recoverExpiredGenerationTaskAttempts(now: number, limit?: number): unknown;
  listReadyGenerationTaskAttempts(limit?: number): GenerationTaskAttempt[];
  tryClaimGenerationTaskAttempt(input: {
    taskId: string;
    attempt: number;
    ownerId: string;
    now: number;
    leaseMs: number;
  }): GenerationTaskAttemptClaim | null;
  heartbeatGenerationTaskAttempt(
    lease: GenerationTaskAttemptLease,
    now: number,
    leaseMs: number,
  ): GenerationTaskAttemptClaim;
  releaseGenerationTaskAttemptClaims(lease: GenerationTaskAttemptLease): boolean;
}

function recoveryApi(store: Store): GenerationTaskRecoveryStoreContract {
  return store.workspace as unknown as GenerationTaskRecoveryStoreContract;
}

function fakeClock(prefix: string, initialNow = 50_000): StoreClock {
  let now = initialNow;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `${prefix}-${++id}`,
  };
}

function adjustableClock(prefix: string, initialNow = 50_000): {
  clock: StoreClock;
  setNextNow(value: number): void;
} {
  let now = initialNow;
  let id = 0;
  return {
    clock: {
      now: () => ++now,
      id: () => `${prefix}-${++id}`,
    },
    setNextNow(value: number) {
      now = value - 1;
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

function appendTaskEvent(
  store: Store,
  input: {
    planId: string;
    workspaceId: string;
    taskId: string;
    type: "task-candidate-ready" | "task-cancel-requested";
    payload: Record<string, unknown>;
    createdAt: number;
  },
): void {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return value;
  };
  const sequence = Number((store.db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM generation_plan_events WHERE plan_id = ?",
  ).get(input.planId) as { sequence: number }).sequence) + 1;
  store.db.prepare(
    `INSERT INTO generation_plan_events (
       plan_id, workspace_id, sequence, task_id, type, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.planId,
    input.workspaceId,
    sequence,
    input.taskId,
    input.type,
    JSON.stringify(canonicalize(input.payload)),
    input.createdAt,
  );
}

function claimAttempt(
  api: GenerationTaskRecoveryStoreContract,
  attempt: Pick<GenerationTaskAttempt, "taskId" | "attempt">,
  ownerId: string,
  now: number,
  leaseMs = 30_000,
): GenerationTaskAttemptClaim {
  const claimed = api.tryClaimGenerationTaskAttempt({
    taskId: attempt.taskId,
    attempt: attempt.attempt,
    ownerId,
    now,
    leaseMs,
  });
  assert.ok(claimed, `Attempt ${attempt.taskId}/${attempt.attempt} should be claimable at ${now}`);
  return claimed;
}

function retryInput(attempt: GenerationTaskAttempt) {
  return {
    target: attempt.target,
    baseRevisionId: attempt.baseRevisionId,
    sourceCommitHash: attempt.sourceCommitHash,
    sourceTreeHash: attempt.sourceTreeHash,
    expectedSnapshotId: attempt.expectedSnapshotId,
    contextPackId: attempt.contextPackId,
    kernelRevisionId: attempt.kernelRevisionId,
    payload: attempt.payload,
    dependencyOutputs: attempt.dependencyOutputs,
    resourcePins: attempt.resourcePins,
    componentPins: attempt.componentPins,
    retryContextPolicy: attempt.retryContextPolicy,
    executionMode: attempt.executionMode,
  };
}

function retryInputWithoutMode(attempt: GenerationTaskAttempt) {
  const { executionMode: _executionMode, ...input } = retryInput(attempt);
  return input;
}

function legacyAttemptInputHash(attempt: GenerationTaskAttempt): string {
  return createHash("sha256")
    .update("dezin:generation-task-attempt-input:v1\0")
    .update(JSON.stringify({
      taskId: attempt.taskId,
      planId: attempt.planId,
      workspaceId: attempt.workspaceId,
      attempt: attempt.attempt,
      target: attempt.target,
      baseRevisionId: attempt.baseRevisionId,
      expectedSnapshotId: attempt.expectedSnapshotId,
      contextPackId: attempt.contextPackId,
      kernelRevisionId: attempt.kernelRevisionId,
      payload: attempt.payload,
      dependencyOutputs: attempt.dependencyOutputs,
      resourcePins: attempt.resourcePins,
      componentPins: attempt.componentPins,
      retryContextPolicy: attempt.retryContextPolicy,
      executionMode: attempt.executionMode,
    }))
    .digest("hex");
}

function emulateMigratedArtifactAttemptWithoutSourceBase(
  store: Store,
  attempt: GenerationTaskAttempt,
): void {
  const legacyInputHash = legacyAttemptInputHash(attempt);
  store.db.exec(`
    DROP TRIGGER generation_task_attempt_input_update_immutable;
    DROP TRIGGER generation_plan_event_update_immutable;
  `);
  store.db.prepare(
    `UPDATE generation_task_attempts
     SET source_commit_hash = NULL, source_tree_hash = NULL, input_hash = ?
     WHERE task_id = ? AND attempt = ?`,
  ).run(legacyInputHash, attempt.taskId, attempt.attempt);
  const row = store.db.prepare(
    `SELECT sequence, payload_json FROM generation_plan_events
     WHERE plan_id = ? AND task_id = ? AND type = 'task-materialized'`,
  ).get(attempt.planId, attempt.taskId) as { sequence: number; payload_json: string };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  payload.inputHash = legacyInputHash;
  delete payload.sourceCommitHash;
  delete payload.sourceTreeHash;
  const canonicalPayload = JSON.stringify(Object.fromEntries(
    Object.entries(payload).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
  store.db.prepare(
    `UPDATE generation_plan_events SET payload_json = ?
     WHERE plan_id = ? AND sequence = ?`,
  ).run(canonicalPayload, attempt.planId, row.sequence);
}

function attemptCount(store: Store, taskId: string): number {
  return Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_task_attempts WHERE task_id = ?",
  ).get(taskId) as { count: number }).count);
}

function claimCount(store: Store, taskId: string, attempt: number): number {
  return Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
  ).get(taskId, attempt) as { count: number }).count);
}

function taskState(store: Store, taskId: string) {
  return { ...(store.db.prepare(
    `SELECT status, current_attempt, next_eligible_at, blocked_by_task_id, finished_at
     FROM generation_tasks WHERE id = ?`,
  ).get(taskId) as {
    status: string;
    current_attempt: number;
    next_eligible_at: number | null;
    blocked_by_task_id: string | null;
    finished_at: number | null;
  }) };
}

function createQueuedValidationAttempt(store: Store, label: string) {
  const project = store.createProject({ name: `Recovery validation ${label}`, mode: "standard" });
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
    rationale: `Recover expired validation ${label}`,
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
  return { project, workspace, plan: compiled.plan, task, attempt };
}

function createPinnedPageAttempt(
  store: Store,
  label: string,
) {
  const project = store.createProject({ name: `Recovery pinned Page ${label}`, mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const artifactId = `recovery-page-${label}`;
  const trackId = `recovery-page-track-${label}`;
  const nodeId = `recovery-page-node-${label}`;
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
    commands: [{
      id: `add-recovery-page-${label}`,
      type: "add-node",
      node: {
        id: nodeId,
        kind: "page",
        name: `Recovery Page ${label}`,
        artifactId,
        createIdentity: { initialTrackId: trackId },
      },
    }],
  });
  const afterGraph = store.workspace.getWorkspace(project.id)!;
  const baseRevision = store.workspace.createArtifactRevision({
    artifactId,
    trackId,
    parentRevisionId: null,
    sourceCommitHash: checksum(`base-commit-${label}`),
    sourceTreeHash: checksum(`base-tree-${label}`),
    kernelRevisionId: afterGraph.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 100, findings: [] },
    contextPackHash: null,
    dependencies: [],
    resourcePins: [],
  });
  const pageSnapshot = store.workspace.publishArtifactRevision(baseRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const createdResource = store.workspace.createResourceForProject(project.id, {
    kind: "asset",
    title: `Recovery pinned Asset ${label}`,
    defaultPinPolicy: "pin-current",
    baseGraphRevision: pageSnapshot.graphRevision,
    expectedSnapshotId: pageSnapshot.id,
  });
  const resourceRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    createdResource.resource.id,
    {
      revisionId: `recovery-resource-revision-${label}`,
      parentRevisionId: null,
      manifestPath: `resource-revisions/recovery-${label}/manifest.json`,
      summary: `Pinned recovery Asset ${label}`,
      metadata: { fixture: "generation-task-recovery-store", label },
      checksum: checksum(`recovery-resource:${label}`),
      provenance: { source: "generation-task-recovery-store-test" },
    },
  );
  store.workspace.publishResourceRevisionForProject(
    project.id,
    createdResource.resource.id,
    resourceRevision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: createdResource.snapshot.id,
      reason: `Publish recovery Resource ${label}`,
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
        nodeId,
        artifactId,
        kind: "page",
        name: `Recovery Page ${label}`,
        trackId,
        baseRevisionId: baseRevision.id,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: ["desktop"],
      }],
      dependencyPlans: [{
        kind: "resource",
        ownerArtifactId: artifactId,
        resourceId: createdResource.resource.id,
      }],
    },
    rationale: `Freeze retry input and Resource pin ${label}`,
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
  assert.deepEqual(observation.resourcePins, [{
    resourceId: createdResource.resource.id,
    revisionId: resourceRevision.id,
    sourceTaskId: null,
  }]);
  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  const baseChecksum = store.workspace.getArtifactRevisionContextChecksum(baseRevision.id);
  assert.ok(kernel);
  assert.ok(baseChecksum);
  const contextPack = store.workspace.persistContextPack({
    id: `recovery-page-context-${label}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "artifact", id: artifactId },
    intent: "generate",
    messageChecksum: checksum(`recovery-message:${label}`),
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
        ref: { kind: "artifact", id: artifactId, revisionId: baseRevision.id },
        resolvedKind: "artifact-revision",
        artifactRevisionId: baseRevision.id,
        checksum: baseChecksum,
        reason: "target-base",
        trustLevel: "trusted",
        boundary: {},
        tokenEstimate: 1,
        provenance: {},
        provided: true,
      },
      {
        ref: {
          kind: "resource",
          id: createdResource.resource.id,
          resourceKind: createdResource.resource.kind,
          revisionId: resourceRevision.id,
        },
        resolvedKind: "resource-revision",
        resourceRevisionId: resourceRevision.id,
        checksum: resourceRevision.checksum,
        reason: "resource-pin",
        trustLevel: "trusted",
        boundary: {},
        tokenEstimate: 1,
        provenance: {},
        provided: true,
      },
    ],
    omissions: [],
    tokenEstimate: 3,
    manifestPath: `context-packs/recovery-page-${label}.json`,
    hash: checksum(`recovery-context:${label}`),
  });
  const attempt = store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
    ...observation,
    contextPackId: contextPack.id,
    sourceCommitHash: baseRevision.sourceCommitHash,
    sourceTreeHash: baseRevision.sourceTreeHash,
    retryContextPolicy: "same-context",
    executionMode: "full",
  });
  assert.equal(attempt.resourcePins.length, 1);
  return {
    project,
    workspace,
    plan: compiled.plan,
    task,
    attempt,
    artifactId,
    trackId,
    baseRevision,
    resourceRevision,
    contextPack,
  };
}

function createPublicationOnlyAttempt(store: Store, label: string) {
  const fixture = createPinnedPageAttempt(store, label);
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: fixture.task.id,
    attempt: fixture.attempt.attempt,
    ownerId: `publication-only-setup-${label}`,
    now: 90_000,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  store.db.prepare(
    `UPDATE generation_task_attempts
     SET status = 'needs-rebase', failure_class = 'publication-conflict',
         error_json = '{"code":"publication-conflict"}',
         owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, finished_at = 90_001
     WHERE task_id = ? AND attempt = ?`,
  ).run(fixture.task.id, fixture.attempt.attempt);
  store.db.prepare(
    `UPDATE generation_tasks
     SET status = 'needs-rebase', failure_class = 'publication-conflict',
         error_json = '{"code":"publication-conflict"}'
     WHERE id = ? AND plan_id = ?`,
  ).run(fixture.task.id, fixture.plan.id);
  store.db.prepare(
    "DELETE FROM generation_task_claims WHERE task_id = ? AND attempt = ?",
  ).run(fixture.task.id, fixture.attempt.attempt);
  store.workspace.recordGenerationTaskMaterializationFailureForProject(
    fixture.project.id,
    fixture.plan.id,
    {
      taskId: fixture.task.id,
      expectedFailureCount: 0,
      failureClass: "provider",
      error: { code: "publication-adapter-unavailable" },
      nextEligibleAt: null,
    },
  );
  store.db.prepare(
    "UPDATE generation_tasks SET next_eligible_at = 0 WHERE id = ?",
  ).run(fixture.task.id);
  const observation = store.workspace.observeGenerationTaskMaterializationForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.task.id,
  );
  const attempt = store.workspace.createGenerationTaskAttemptForProject(
    fixture.project.id,
    fixture.plan.id,
    {
      ...observation,
      contextPackId: fixture.contextPack.id,
      sourceCommitHash: fixture.attempt.sourceCommitHash,
      sourceTreeHash: fixture.attempt.sourceTreeHash,
      retryContextPolicy: "same-context",
      executionMode: "publication-only",
    },
  );
  assert.equal(attempt.executionMode, "publication-only");
  return { ...fixture, attempt };
}

function markCandidateReady(
  store: Store,
  fixture: ReturnType<typeof createPinnedPageAttempt>,
  claim: GenerationTaskAttemptClaim,
  now: number,
) {
  const candidate = store.workspace.createArtifactRevision({
    artifactId: fixture.artifactId,
    trackId: fixture.trackId,
    parentRevisionId: fixture.baseRevision.id,
    sourceCommitHash: `candidate-commit-${fixture.task.id}`,
    sourceTreeHash: `candidate-tree-${fixture.task.id}`,
    kernelRevisionId: fixture.attempt.kernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1_440, height: 900 }] },
    quality: { state: "passed", score: 98, findings: [] },
    contextPackHash: fixture.contextPack.hash,
    dependencies: [],
    resourcePins: [{
      resourceId: fixture.attempt.resourcePins[0]!.resourceId,
      resourceRevisionId: fixture.attempt.resourcePins[0]!.revisionId,
    }],
  });
  const evidence = { checks: ["build", "runtime", "visual"], quality: "passed" };
  const evidenceHash = generationTaskCandidateEvidenceHash({
    taskId: fixture.task.id,
    planId: fixture.plan.id,
    workspaceId: fixture.workspace.id,
    attempt: claim.attempt.attempt,
    candidateRevisionId: candidate.id,
    candidateResourceRevisionId: null,
    candidateEvidence: evidence,
  });
  store.db.prepare(
    `UPDATE generation_task_attempts
     SET status = 'candidate-ready', candidate_revision_id = ?, candidate_evidence_json = ?,
         candidate_evidence_hash = ?
     WHERE task_id = ? AND attempt = ? AND status = 'running'`,
  ).run(
    candidate.id,
    JSON.stringify(evidence),
    evidenceHash,
    fixture.task.id,
    claim.attempt.attempt,
  );
  store.db.prepare(
    "UPDATE generation_tasks SET status = 'candidate-ready' WHERE id = ? AND status = 'running'",
  ).run(fixture.task.id);
  appendTaskEvent(store, {
    planId: fixture.plan.id,
    workspaceId: fixture.workspace.id,
    taskId: fixture.task.id,
    type: "task-candidate-ready",
    payload: {
      attempt: claim.attempt.attempt,
      candidateRevisionId: candidate.id,
      candidateResourceRevisionId: null,
      candidateEvidenceHash: evidenceHash,
    },
    createdAt: now,
  });
  return { candidate, evidence, evidenceHash };
}

interface ResourceRecoveryTarget {
  nodeId: string;
  resourceId: string;
  kind: "research";
  title: string;
  baseRevisionId: string;
  baseRevisionChecksum: string;
}

function createTwoResourceAttempts(store: Store, label: string) {
  const project = store.createProject({ name: `Recovery sibling ${label}`, mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const resources: ResourceRecoveryTarget[] = [];
  for (let index = 0; index < 2; index += 1) {
    const current = store.workspace.getWorkspace(project.id)!;
    const created = store.workspace.createResourceForProject(project.id, {
      kind: "research",
      title: `${label} Research ${index + 1}`,
      defaultPinPolicy: "follow-head",
      baseGraphRevision: current.graphRevision,
      expectedSnapshotId: current.activeSnapshotId,
    });
    const revision = store.workspace.createResourceRevisionCandidateForProject(
      project.id,
      created.resource.id,
      {
        revisionId: `${label}-base-resource-${index + 1}`,
        parentRevisionId: null,
        manifestPath: `resource-revisions/${label}-${index + 1}/manifest.json`,
        summary: `${label} base Research ${index + 1}`,
        metadata: { fixture: label, index },
        checksum: checksum(`${label}:resource:${index + 1}`),
        provenance: { source: "generation-task-recovery-store-test" },
      },
    );
    store.workspace.publishResourceRevisionForProject(project.id, created.resource.id, revision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: `Publish ${label} base Research ${index + 1}`,
    });
    resources.push({
      nodeId: created.node.id,
      resourceId: created.resource.id,
      kind: "research",
      title: created.resource.title,
      baseRevisionId: revision.id,
      baseRevisionChecksum: revision.checksum,
    });
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
      resourceOperations: resources.map((resource) => ({
        operation: "revise" as const,
        nodeId: resource.nodeId,
        resourceId: resource.resourceId,
        kind: resource.kind,
        title: resource.title,
        revisionPolicy: { kind: "generate" as const },
      })),
    },
    rationale: `Keep independent recovery sibling ${label} runnable`,
    assumptions: [],
  });
  const approved = store.workspace.approveProposalForProject(project.id, proposal.id, "generate");
  assert.ok(approved.plan);
  const compiled = store.workspace.compileApprovedGenerationPlanForProject(project.id, approved.plan.id);
  const tasks = compiled.tasks.filter((candidate) => candidate.kind === "resource");
  const validation = compiled.tasks.find((candidate) => candidate.kind === "prototype-validation");
  const checkpoint = compiled.tasks.find((candidate) => candidate.kind === "checkpoint");
  assert.equal(tasks.length, 2);
  assert.ok(validation);
  assert.ok(checkpoint);
  const attempts = tasks.map((task, index) => {
    const observation = store.workspace.observeGenerationTaskMaterializationForProject(
      project.id,
      compiled.plan.id,
      task.id,
    );
    const resource = resources.find((candidate) => candidate.resourceId === task.target.id);
    const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
    assert.ok(resource);
    assert.ok(kernel);
    const contextPack = store.workspace.persistContextPack({
      id: `${label}-resource-context-${index + 1}`,
      workspaceId: workspace.id,
      graphRevision: workspace.graphRevision,
      target: { type: "resource", id: resource.resourceId },
      intent: "generate",
      messageChecksum: checksum(`${label}:message:${index + 1}`),
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
            id: resource.resourceId,
            resourceKind: resource.kind,
            revisionId: resource.baseRevisionId,
          },
          resolvedKind: "resource-revision",
          resourceRevisionId: resource.baseRevisionId,
          checksum: resource.baseRevisionChecksum,
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
      manifestPath: `context-packs/${label}-resource-${index + 1}.json`,
      hash: checksum(`${label}:context:${index + 1}`),
    });
    return store.workspace.createGenerationTaskAttemptForProject(project.id, compiled.plan.id, {
      ...observation,
      contextPackId: contextPack.id,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    });
  });
  return {
    project,
    workspace,
    plan: compiled.plan,
    tasks,
    attempts,
    validation,
    checkpoint,
  };
}

test("expired running attempts atomically append exact immutable successors with 1s/4s/16s backoff and no Attempt 5", () => {
  const store = new Store(":memory:", fakeClock("recovery-exact-clone"));
  try {
    const fixture = createPinnedPageAttempt(store, "exact-clone");
    const api = recoveryApi(store);
    let claimed = claimAttempt(api, fixture.attempt, "exact-clone-owner-1", 100_000);
    let expiry = 130_000;
    const expectedDelays = [1_000, 4_000, 16_000] as const;
    const beforeDrift = store.workspace.getWorkspace(fixture.project.id)!;
    store.workspace.createResourceForProject(fixture.project.id, {
      kind: "research",
      title: "Independent Snapshot drift during execution",
      defaultPinPolicy: "follow-head",
      baseGraphRevision: beforeDrift.graphRevision,
      expectedSnapshotId: beforeDrift.activeSnapshotId,
    });
    assert.notEqual(
      store.workspace.getWorkspace(fixture.project.id)!.activeSnapshotId,
      fixture.attempt.expectedSnapshotId,
      "recovery fixture must prove exact retry does not re-observe the active Snapshot",
    );

    for (let index = 0; index < 4; index += 1) {
      const expiredAttempt = claimed.attempt;
      api.recoverExpiredGenerationTaskAttempts(expiry);
      const finished = store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.task.id,
        expiredAttempt.attempt,
      );
      assert.ok(finished);
      assert.equal(claimCount(store, fixture.task.id, expiredAttempt.attempt), 0);
      assert.equal(finished.lease, null);
      assert.equal(finished.finishedAt, expiry);

      if (index < expectedDelays.length) {
        const nextEligibleAt = expiry + expectedDelays[index]!;
        assert.equal(finished.status, "retryable-failed");
        assert.equal(finished.nextEligibleAt, nextEligibleAt);
        const successor = store.workspace.getGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          fixture.task.id,
          expiredAttempt.attempt + 1,
        );
        assert.ok(successor, "recovery must durably append the exact successor before returning");
        assert.equal(successor.status, "queued");
        assert.equal(successor.attempt, expiredAttempt.attempt + 1);
        assert.deepEqual(retryInput(successor), retryInput(expiredAttempt));
        assert.notEqual(successor.inputHash, expiredAttempt.inputHash);
        assert.equal(successor.resourcePins.length, 1, "non-empty exact Resource pins survive retry");
        assert.equal(
          Number((store.db.prepare(
            `SELECT materialization_sealed FROM generation_task_attempts
             WHERE task_id = ? AND attempt = ?`,
          ).get(fixture.task.id, successor.attempt) as { materialization_sealed: number }).materialization_sealed),
          1,
        );
        assert.deepEqual(taskState(store, fixture.task.id), {
          status: "retry-wait",
          current_attempt: successor.attempt,
          next_eligible_at: nextEligibleAt,
          blocked_by_task_id: null,
          finished_at: null,
        });
        assert.equal(api.tryClaimGenerationTaskAttempt({
          taskId: fixture.task.id,
          attempt: successor.attempt,
          ownerId: `too-early-${successor.attempt}`,
          now: nextEligibleAt - 1,
          leaseMs: 30_000,
        }), null);
        claimed = claimAttempt(
          api,
          successor,
          `exact-clone-owner-${successor.attempt}`,
          nextEligibleAt,
        );
        expiry = nextEligibleAt + 30_000;
      } else {
        assert.equal(finished.status, "failed");
        assert.equal(finished.nextEligibleAt, null);
        assert.deepEqual(taskState(store, fixture.task.id), {
          status: "failed",
          current_attempt: 4,
          next_eligible_at: null,
          blocked_by_task_id: null,
          finished_at: expiry,
        });
        assert.equal(attemptCount(store, fixture.task.id), 4);
        assert.equal(
          store.workspace.getGenerationTaskAttemptForProject(
            fixture.project.id,
            fixture.plan.id,
            fixture.task.id,
            5,
          ),
          null,
        );
      }
    }

    const eventCounts = store.db.prepare(
      `SELECT type, COUNT(*) AS count FROM generation_plan_events
       WHERE plan_id = ? AND task_id = ?
       GROUP BY type ORDER BY type`,
    ).all(fixture.plan.id, fixture.task.id) as Array<{ type: string; count: number }>;
    const countByType = new Map(eventCounts.map((row) => [row.type, Number(row.count)]));
    assert.equal(countByType.get("task-materialized"), 4);
    assert.equal(countByType.get("task-retry-wait"), 3);
    assert.equal(countByType.get("task-failed"), 1);
  } finally {
    store.close();
  }
});

test("legacy active Artifact Attempts without a Source Base terminalize instead of rolling back recovery", async (t) => {
  await t.test("fenced execution failure becomes terminal without a strict successor", () => {
    const { clock, setNextNow } = adjustableClock("legacy-source-failure");
    const store = new Store(":memory:", clock);
    try {
      const fixture = createPinnedPageAttempt(store, "legacy-source-failure");
      emulateMigratedArtifactAttemptWithoutSourceBase(store, fixture.attempt);
      const api = recoveryApi(store);
      const claim = claimAttempt(api, fixture.attempt, "legacy-source-failure-owner", 100_000);
      setNextNow(100_001);
      const result = store.workspace.finishGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        {
          lease: claim.lease,
          failure: {
            failureClass: "build-infrastructure",
            error: { code: "legacy-artifact-source-base-missing" },
          },
        },
      );
      assert.equal(result.status, "failed");
      assert.equal(result.successorAttempt, null);
      assert.equal(attemptCount(store, fixture.task.id), 1);
      assert.equal(claimCount(store, fixture.task.id, 1), 0);
      assert.equal(taskState(store, fixture.task.id).status, "failed");
    } finally {
      store.close();
    }
  });

  await t.test("expired lease recovery becomes terminal without a strict successor", () => {
    const store = new Store(":memory:", fakeClock("legacy-source-recovery"));
    try {
      const fixture = createPinnedPageAttempt(store, "legacy-source-recovery");
      emulateMigratedArtifactAttemptWithoutSourceBase(store, fixture.attempt);
      const api = recoveryApi(store);
      claimAttempt(api, fixture.attempt, "legacy-source-recovery-owner", 100_000, 10);
      const summary = api.recoverExpiredGenerationTaskAttempts(100_010) as {
        failedTaskIds: string[];
      };
      assert.deepEqual(summary.failedTaskIds, [fixture.task.id]);
      assert.equal(attemptCount(store, fixture.task.id), 1);
      assert.equal(claimCount(store, fixture.task.id, 1), 0);
      assert.equal(taskState(store, fixture.task.id).status, "failed");
    } finally {
      store.close();
    }
  });
});

test("a sealed recovery successor becomes claimable without re-entering materialization", () => {
  const controlled = adjustableClock("recovery-no-rematerialize");
  const store = new Store(":memory:", controlled.clock);
  try {
    const fixture = createPinnedPageAttempt(store, "no-rematerialize");
    const api = recoveryApi(store);
    claimAttempt(api, fixture.attempt, "no-rematerialize-owner", 100_000);
    api.recoverExpiredGenerationTaskAttempts(130_000);

    const successor = store.workspace.getGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      2,
    );
    assert.ok(successor);
    controlled.setNextNow(131_000);
    assert.deepEqual(
      store.workspace.listGenerationTaskIdsReadyForMaterializationForProject(
        fixture.project.id,
        fixture.plan.id,
      ),
      [],
      "due backoff must expose the sealed successor only to the claim path",
    );
    assert.throws(
      () => store.workspace.observeGenerationTaskMaterializationForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.task.id,
      ),
      /not ready|state|backoff/i,
    );
    assert.throws(
      () => store.db.prepare(
        `INSERT INTO generation_task_attempts (
           task_id, plan_id, workspace_id, attempt, target_artifact_id, target_track_id,
           target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
           kernel_revision_id, execution_mode, payload_json, input_hash,
           pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
           retry_context_policy, status, materialization_sealed, created_at
         ) SELECT task_id, plan_id, workspace_id, attempt + 1, target_artifact_id, target_track_id,
                  target_resource_id, base_revision_id, expected_snapshot_id, context_pack_id,
                  kernel_revision_id, execution_mode, payload_json, 'forged-rematerialization',
                  pinned_resource_revision_ids_json, component_dependency_revision_ids_json,
                  retry_context_policy, 'queued', 0, 131001
           FROM generation_task_attempts WHERE task_id = ? AND attempt = 2`,
      ).run(fixture.task.id),
      /input|target ownership|invalid/i,
      "SQLite must reject a materialized Attempt layered over a sealed queued successor",
    );
    assert.equal(attemptCount(store, fixture.task.id), 2);
    const ready = api.listReadyGenerationTaskAttempts();
    assert.equal(ready.some((attempt) => attempt.taskId === fixture.task.id && attempt.attempt === 2), true);
  } finally {
    store.close();
  }
});

test("candidate-ready and publication-only expiries never schedule another full generation", async (t) => {
  await t.test("candidate-ready recovery retains the candidate and switches to publication-only", () => {
    const controlled = adjustableClock("recovery-candidate");
    const store = new Store(":memory:", controlled.clock);
    try {
      const fixture = createPinnedPageAttempt(store, "candidate");
      const api = recoveryApi(store);
      const claimed = claimAttempt(api, fixture.attempt, "candidate-owner", 100_000);
      const candidate = markCandidateReady(store, fixture, claimed, 110_000);

      api.recoverExpiredGenerationTaskAttempts(130_000);

      const successor = store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.task.id,
        2,
      );
      assert.ok(successor);
      assert.equal(successor.executionMode, "publication-only");
      assert.deepEqual(retryInputWithoutMode(successor), retryInputWithoutMode(fixture.attempt));
      assert.equal(successor.candidateRevisionId, candidate.candidate.id);
      assert.deepEqual(successor.candidateEvidence, candidate.evidence);
      assert.equal(successor.candidateResourceRevisionId, null);
      assert.equal(successor.candidateEvidenceHash, generationTaskCandidateEvidenceHash({
        taskId: fixture.task.id,
        planId: fixture.plan.id,
        workspaceId: fixture.workspace.id,
        attempt: 2,
        candidateRevisionId: candidate.candidate.id,
        candidateResourceRevisionId: null,
        candidateEvidence: candidate.evidence,
      }));
      assert.notEqual(successor.candidateEvidenceHash, candidate.evidenceHash);
      controlled.setNextNow(131_000);
      assert.deepEqual(
        store.workspace.listGenerationTaskIdsReadyForMaterializationForProject(
          fixture.project.id,
          fixture.plan.id,
        ),
        [],
        "a publication-only successor must retain its candidate instead of rematerializing full execution",
      );
      assert.equal(
        api.listReadyGenerationTaskAttempts().some(
          (attempt) => attempt.taskId === fixture.task.id
            && attempt.attempt === successor.attempt
            && attempt.executionMode === "publication-only",
        ),
        true,
      );
    } finally {
      store.close();
    }
  });

  await t.test("an already publication-only Attempt remains publication-only after expiry", () => {
    const store = new Store(":memory:", fakeClock("recovery-publication-only"));
    try {
      const fixture = createPublicationOnlyAttempt(store, "publication-only");
      const api = recoveryApi(store);
      claimAttempt(api, fixture.attempt, "publication-owner", 100_000);

      api.recoverExpiredGenerationTaskAttempts(130_000);

      const successor = store.workspace.getGenerationTaskAttemptForProject(
        fixture.project.id,
        fixture.plan.id,
        fixture.task.id,
        fixture.attempt.attempt + 1,
      );
      assert.ok(successor);
      assert.equal(successor.executionMode, "publication-only");
      assert.deepEqual(retryInput(successor), retryInput(fixture.attempt));
    } finally {
      store.close();
    }
  });
});

test("cancel-requested expiry becomes cancelled, releases claims, and never creates a successor", () => {
  const store = new Store(":memory:", fakeClock("recovery-cancel"));
  try {
    const fixture = createQueuedValidationAttempt(store, "cancel");
    const api = recoveryApi(store);
    const claimed = claimAttempt(api, fixture.attempt, "cancel-owner", 100_000);
    store.db.prepare(
      `UPDATE generation_task_attempts SET status = 'cancel-requested'
       WHERE task_id = ? AND attempt = ? AND status = 'running'`,
    ).run(fixture.task.id, claimed.attempt.attempt);
    store.db.prepare(
      "UPDATE generation_tasks SET status = 'cancel-requested' WHERE id = ? AND status = 'running'",
    ).run(fixture.task.id);
    appendTaskEvent(store, {
      planId: fixture.plan.id,
      workspaceId: fixture.workspace.id,
      taskId: fixture.task.id,
      type: "task-cancel-requested",
      payload: { attempt: claimed.attempt.attempt, reason: "user-cancelled" },
      createdAt: 110_000,
    });

    api.recoverExpiredGenerationTaskAttempts(130_000);

    const cancelled = store.workspace.getGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      1,
    );
    assert.ok(cancelled);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.lease, null);
    assert.equal(cancelled.finishedAt, 130_000);
    assert.equal(taskState(store, fixture.task.id).status, "cancelled");
    assert.equal(attemptCount(store, fixture.task.id), 1);
    assert.equal(claimCount(store, fixture.task.id, 1), 0);
    assert.throws(
      () => api.heartbeatGenerationTaskAttempt(claimed.lease, 130_000, 30_000),
      /lease|expired|stale|fence/i,
    );
    assert.equal(
      Number((store.db.prepare(
        `SELECT COUNT(*) AS count FROM generation_plan_events
         WHERE plan_id = ? AND task_id = ? AND type = 'task-cancelled'`,
      ).get(fixture.plan.id, fixture.task.id) as { count: number }).count),
      1,
    );
  } finally {
    store.close();
  }
});

test("the last live Task cancellation terminalizes an already-failed Plan exactly once", () => {
  const control = adjustableClock("recovery-failed-plan-settlement");
  const store = new Store(":memory:", control.clock);
  try {
    const fixture = createTwoResourceAttempts(store, "failed-plan-settlement");
    const api = recoveryApi(store);
    const failedTask = fixture.tasks[0]!;
    const liveTask = fixture.tasks[1]!;
    const failedClaim = claimAttempt(api, fixture.attempts[0]!, "failed-plan-owner", 100_000);
    const liveClaim = claimAttempt(api, fixture.attempts[1]!, "live-plan-owner", 100_000);
    control.setNextNow(100_001);

    api.finishGenerationTaskAttemptForProject(fixture.project.id, fixture.plan.id, {
      lease: failedClaim.lease,
      failure: {
        failureClass: "design",
        error: { code: "terminal-design-failure" },
      },
    });

    assert.equal(taskState(store, failedTask.id).status, "failed");
    assert.equal(taskState(store, liveTask.id).status, "running");
    assert.equal(
      store.workspace.getGenerationPlanForProject(fixture.project.id, fixture.plan.id).status,
      "running",
      "the Plan must stay live until its independent running Task settles",
    );

    const requestedAttempt = store.db.prepare(
      `UPDATE generation_task_attempts SET status = 'cancel-requested'
       WHERE task_id = ? AND attempt = ? AND status = 'running'`,
    ).run(liveTask.id, liveClaim.attempt.attempt);
    assert.equal(Number(requestedAttempt.changes), 1);
    const requestedTask = store.db.prepare(
      "UPDATE generation_tasks SET status = 'cancel-requested' WHERE id = ? AND status = 'running'",
    ).run(liveTask.id);
    assert.equal(Number(requestedTask.changes), 1);
    appendTaskEvent(store, {
      planId: fixture.plan.id,
      workspaceId: fixture.workspace.id,
      taskId: liveTask.id,
      type: "task-cancel-requested",
      payload: { attempt: liveClaim.attempt.attempt, reason: "plan-already-failed" },
      createdAt: 100_002,
    });

    api.recoverExpiredGenerationTaskAttempts(130_000);

    assert.equal(taskState(store, liveTask.id).status, "cancelled");
    assert.equal(claimCount(store, liveTask.id, liveClaim.attempt.attempt), 0);
    const plan = store.workspace.getGenerationPlanForProject(fixture.project.id, fixture.plan.id);
    assert.equal(
      plan.status,
      "failed",
      "all Tasks are terminal, so the prior failure must now terminalize the Plan",
    );
    assert.equal(plan.finishedAt, 130_000);
    const planFailedEvents = store.workspace.listGenerationPlanEventsForProject(
      fixture.project.id,
      fixture.plan.id,
      { after: 0, limit: 1_000 },
    ).filter((event) => event.type === "plan-failed");
    assert.equal(planFailedEvents.length, 1);
    assert.deepEqual(planFailedEvents[0]?.payload, {
      failedTaskId: failedTask.id,
      failureClass: "design",
    });
  } finally {
    store.close();
  }
});

test("a lease is live immediately before expiry and expired when lease_expires_at equals now", () => {
  const store = new Store(":memory:", fakeClock("recovery-expiry-boundary"));
  try {
    const fixture = createQueuedValidationAttempt(store, "expiry-boundary");
    const api = recoveryApi(store);
    claimAttempt(api, fixture.attempt, "boundary-owner", 100_000);

    api.recoverExpiredGenerationTaskAttempts(129_999);
    assert.equal(
      (store.db.prepare(
        "SELECT status FROM generation_task_attempts WHERE task_id = ? AND attempt = 1",
      ).get(fixture.task.id) as { status: string }).status,
      "running",
    );
    assert.ok(claimCount(store, fixture.task.id, 1) > 0);
    assert.equal(attemptCount(store, fixture.task.id), 1);

    api.recoverExpiredGenerationTaskAttempts(130_000);
    assert.equal(
      (store.db.prepare(
        "SELECT status FROM generation_task_attempts WHERE task_id = ? AND attempt = 1",
      ).get(fixture.task.id) as { status: string }).status,
      "retryable-failed",
    );
    assert.equal(claimCount(store, fixture.task.id, 1), 0);
    assert.equal(attemptCount(store, fixture.task.id), 2);
  } finally {
    store.close();
  }
});

test("two Store connections recover one expired lease idempotently and the old token cannot touch its successor", () => {
  const dir = mkdtempSync(join(tmpdir(), "dezin-generation-recovery-race-"));
  const file = join(dir, "recovery.db");
  const bootstrap = new Store(file, fakeClock("recovery-race-bootstrap"));
  const fixture = createQueuedValidationAttempt(bootstrap, "two-store");
  const staleClaim = claimAttempt(recoveryApi(bootstrap), fixture.attempt, "old-owner", 100_000);
  bootstrap.close();

  const first = new Store(file, fakeClock("recovery-race-first"));
  const second = new Store(file, fakeClock("recovery-race-second"));
  try {
    assert.doesNotThrow(() => recoveryApi(first).recoverExpiredGenerationTaskAttempts(130_000));
    assert.doesNotThrow(() => recoveryApi(second).recoverExpiredGenerationTaskAttempts(130_000));
    assert.equal(attemptCount(first, fixture.task.id), 2);
    assert.equal(claimCount(first, fixture.task.id, 1), 0);
    assert.equal(
      Number((first.db.prepare(
        `SELECT COUNT(*) AS count FROM generation_plan_events
         WHERE plan_id = ? AND task_id = ? AND type = 'task-materialized'
           AND json_extract(payload_json, '$.attempt') = 2`,
      ).get(fixture.plan.id, fixture.task.id) as { count: number }).count),
      1,
    );
    assert.equal(
      Number((first.db.prepare(
        `SELECT COUNT(*) AS count FROM generation_plan_events
         WHERE plan_id = ? AND task_id = ? AND type = 'task-retry-wait'
           AND json_extract(payload_json, '$.reason') = 'lease-expired'`,
      ).get(fixture.plan.id, fixture.task.id) as { count: number }).count),
      1,
    );

    const successor = first.workspace.getGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      2,
    );
    assert.ok(successor);
    const replacement = claimAttempt(recoveryApi(first), successor, "new-owner", 131_000);
    assert.notEqual(replacement.lease.leaseToken, staleClaim.lease.leaseToken);
    assert.throws(
      () => recoveryApi(second).heartbeatGenerationTaskAttempt(staleClaim.lease, 131_000, 30_000),
      /lease|expired|stale|fence/i,
    );
    assert.equal(recoveryApi(second).releaseGenerationTaskAttemptClaims(staleClaim.lease), false);
    assert.deepEqual((first.db.prepare(
      `SELECT DISTINCT owner_id, lease_token FROM generation_task_claims
       WHERE task_id = ? AND attempt = 2`,
    ).all(fixture.task.id) as Array<{ owner_id: string; lease_token: string }>).map((row) => ({ ...row })), [{
      owner_id: replacement.lease.ownerId,
      lease_token: replacement.lease.leaseToken,
    }]);
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal expiry blocks descendants but leaves an independent queued sibling runnable", () => {
  const store = new Store(":memory:", fakeClock("recovery-isolation"));
  try {
    const fixture = createTwoResourceAttempts(store, "recovery-isolation");
    const api = recoveryApi(store);
    const failedTask = fixture.tasks[0]!;
    const siblingTask = fixture.tasks[1]!;
    let claimed = claimAttempt(api, fixture.attempts[0]!, "isolation-owner-1", 100_000);
    let expiry = 130_000;
    const retryDelays = [1_000, 4_000, 16_000] as const;

    for (let index = 0; index < 4; index += 1) {
      api.recoverExpiredGenerationTaskAttempts(expiry);
      if (index < retryDelays.length) {
        const dueAt = expiry + retryDelays[index]!;
        const successor = store.workspace.getGenerationTaskAttemptForProject(
          fixture.project.id,
          fixture.plan.id,
          failedTask.id,
          claimed.attempt.attempt + 1,
        );
        assert.ok(successor);
        claimed = claimAttempt(api, successor, `isolation-owner-${successor.attempt}`, dueAt);
        expiry = dueAt + 30_000;
      }
    }

    assert.deepEqual(taskState(store, failedTask.id), {
      status: "failed",
      current_attempt: 4,
      next_eligible_at: null,
      blocked_by_task_id: null,
      finished_at: expiry,
    });
    assert.deepEqual(taskState(store, siblingTask.id), {
      status: "queued",
      current_attempt: 1,
      next_eligible_at: null,
      blocked_by_task_id: null,
      finished_at: null,
    });
    assert.equal(taskState(store, fixture.validation.id).status, "blocked");
    assert.equal(taskState(store, fixture.validation.id).blocked_by_task_id, failedTask.id);
    assert.equal(taskState(store, fixture.checkpoint.id).status, "blocked");
    assert.equal(taskState(store, fixture.checkpoint.id).blocked_by_task_id, failedTask.id);
    assert.equal(store.workspace.getGenerationPlanForProject(fixture.project.id, fixture.plan.id).status, "running");
    assert.deepEqual(
      api.listReadyGenerationTaskAttempts().map((attempt) => attempt.taskId),
      [siblingTask.id],
    );
    assert.equal(
      Number((store.db.prepare(
        `SELECT COUNT(*) AS count FROM generation_plan_events
         WHERE plan_id = ? AND type = 'task-blocked'`,
      ).get(fixture.plan.id) as { count: number }).count),
      2,
    );
    assert.equal(
      Number((store.db.prepare(
        `SELECT COUNT(*) AS count FROM generation_plan_events
         WHERE plan_id = ? AND type = 'plan-failed'`,
      ).get(fixture.plan.id) as { count: number }).count),
      0,
    );
  } finally {
    store.close();
  }
});
