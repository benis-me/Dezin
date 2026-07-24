import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GenerationTaskLeaseFenceError,
  Store,
  generationTaskCandidateEvidenceHash,
  type CreateResourceRevisionCandidateInput,
  type GenerationPlanEvent,
  type GenerationTask,
  type GenerationTaskAttempt,
  type GenerationTaskAttemptLease,
  type ResourceRevision,
  type StoreClock,
  type WorkspaceSnapshotRecord,
} from "../src/index.ts";

interface ControlledClock {
  clock: StoreClock;
  set(now: number): void;
}

interface GenerationTaskResourceCandidateInput {
  kind: "resource";
  /** Redundant executor output identity, fenced against the immutable Attempt target. */
  resourceId: string;
  revision: CreateResourceRevisionCandidateInput;
}

interface StageGenerationTaskResourceCandidateInput {
  lease: GenerationTaskAttemptLease;
  candidate: GenerationTaskResourceCandidateInput;
  evidence: Record<string, unknown>;
}

interface StageGenerationTaskResourceCandidateResult {
  attempt: GenerationTaskAttempt;
  artifactRevision: null;
  resourceRevision: ResourceRevision;
}

type ResourcePublicationConflict = {
  pointer: "resource-head" | "active-snapshot";
  expectedId: string | null;
  actualId: string | null;
};

type PublishGenerationTaskResourceCandidateResult =
  | {
      status: "succeeded";
      task: GenerationTask;
      attempt: GenerationTaskAttempt;
      artifactRevision: null;
      resourceRevision: ResourceRevision;
      snapshot: WorkspaceSnapshotRecord;
      conflict: null;
    }
  | {
      status: "needs-rebase";
      task: GenerationTask;
      attempt: GenerationTaskAttempt;
      artifactRevision: null;
      resourceRevision: ResourceRevision;
      snapshot: null;
      conflict: ResourcePublicationConflict;
    };

interface GenerationTaskResourceCandidateStoreContract {
  stageGenerationTaskCandidateForProject(
    projectId: string,
    planId: string,
    input: StageGenerationTaskResourceCandidateInput,
  ): StageGenerationTaskResourceCandidateResult;
  publishGenerationTaskCandidateForProject(
    projectId: string,
    planId: string,
    input: { lease: GenerationTaskAttemptLease },
  ): PublishGenerationTaskResourceCandidateResult;
  tryClaimResourcePayloadCleanup(input: ResourcePayloadCleanupInput): ResourcePayloadCleanupClaim | null;
  completeResourcePayloadCleanup(input: ResourcePayloadCleanupInput): ResourcePayloadCleanupClaim;
  beginResourcePayloadStaging(input: ResourcePayloadStagingBeginInput): ResourcePayloadStagingJournal;
  classifyResourcePayloadStaging(
    input: ResourcePayloadCleanupInput & {
      lease: GenerationTaskAttemptLease;
      storageDisposition: "owned-created" | "preexisting";
    },
  ): ResourcePayloadStagingJournal;
  completeResourcePayloadStaging(
    input: ResourcePayloadCleanupInput & {
      lease: GenerationTaskAttemptLease;
      receiptChecksum: string;
    },
  ): ResourcePayloadStagingJournal;
  listResourcePayloadRecoveryEntries(input: {
    cursor?: ResourcePayloadRecoveryCursor | null;
    limit?: number;
  }): ResourcePayloadRecoveryPage;
}

interface ResourcePayloadCleanupInput {
  taskId: string;
  attempt: number;
  inputHash: string;
  workspaceId: string;
  resourceId: string;
  revisionId: string;
}

interface ResourcePayloadCleanupClaim extends ResourcePayloadCleanupInput {
  planId: string;
  status: "claimed" | "completed";
  claimedAt: number;
  completedAt: number | null;
}

interface ResourcePayloadStagingBeginInput extends ResourcePayloadCleanupInput {
  lease: GenerationTaskAttemptLease;
  manifestPath: string;
  payloadChecksum: string;
  manifestChecksum: string;
  receiptChecksum: string;
  byteSize: number;
  mimeType: string;
}

interface ResourcePayloadStagingJournal extends Omit<ResourcePayloadStagingBeginInput, "lease"> {
  ownerId: string;
  leaseToken: string;
  sequence: number;
  planId: string;
  status: "prepared" | "receipt-committed";
  storageDisposition: "owned-created" | "preexisting" | null;
  createdAt: number;
  classifiedAt: number | null;
  receiptCommittedAt: number | null;
}

interface ResourcePayloadRecoveryCursor {
  afterSequence: number;
  throughSequence: number;
}

interface ResourcePayloadRecoveryPage {
  entries: Array<{
    journal: ResourcePayloadStagingJournal;
    cleanup: ResourcePayloadCleanupClaim | null;
  }>;
  nextCursor: ResourcePayloadRecoveryCursor | null;
}

function resourceCandidateApi(store: Store): GenerationTaskResourceCandidateStoreContract {
  return store.workspace as unknown as GenerationTaskResourceCandidateStoreContract;
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

function createResourceCandidateFixture(label: string, databasePath = ":memory:") {
  const control = controlledClock(`resource-candidate-${label}`);
  const store = new Store(databasePath, control.clock);
  const project = store.createProject({ name: `Resource candidate ${label}`, mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "research",
    title: `Research brief ${label}`,
    defaultPinPolicy: "follow-head",
    baseGraphRevision: foundation.graphRevision,
    expectedSnapshotId: foundation.activeSnapshotId,
  });
  const baseRevision = store.workspace.createResourceRevisionCandidateForProject(
    project.id,
    created.resource.id,
    {
      revisionId: `resource-base-revision-${label}`,
      parentRevisionId: null,
      manifestPath: `resource-revisions/${label}/base/manifest.json`,
      summary: `Initial research ${label}`,
      metadata: { phase: "base", label },
      checksum: checksum(`${label}:resource-base`),
      provenance: { source: "resource-candidate-fixture" },
    },
  );
  const baseSnapshot = store.workspace.publishResourceRevisionForProject(
    project.id,
    created.resource.id,
    baseRevision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: "Publish Resource candidate fixture base",
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
        operation: "revise",
        nodeId: created.node.id,
        resourceId: created.resource.id,
        kind: created.resource.kind,
        title: created.resource.title,
        revisionPolicy: { kind: "generate" },
      }],
    },
    rationale: "Generate one immutable Resource successor",
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
  assert.equal(observation.expectedSnapshotId, baseSnapshot.id);
  assert.deepEqual(observation.target, {
    type: "resource",
    workspaceId: workspace.id,
    id: created.resource.id,
  });
  const kernel = store.workspace.getKernelRevision(observation.kernelRevisionId);
  assert.ok(kernel);
  const contextPack = store.workspace.persistContextPack({
    id: `resource-candidate-context-${label}`,
    workspaceId: workspace.id,
    graphRevision: workspace.graphRevision,
    target: { type: "resource", id: created.resource.id },
    intent: "generate",
    messageChecksum: checksum(`${label}:message`),
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
    manifestPath: `context-packs/resource-candidate-${label}.json`,
    hash: checksum(`${label}:context-pack`),
  });
  const attempt = store.workspace.createGenerationTaskAttemptForProject(
    project.id,
    compiled.plan.id,
    {
      ...observation,
      contextPackId: contextPack.id,
      sourceCommitHash: null,
      sourceTreeHash: null,
      retryContextPolicy: "same-context",
      executionMode: "full",
    },
  );
  const claim = store.workspace.tryClaimGenerationTaskAttempt({
    taskId: task.id,
    attempt: attempt.attempt,
    ownerId: `resource-candidate-worker-${label}`,
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
    task,
    attempt,
    claim,
    resource: created.resource,
    nodeId: created.node.id,
    baseRevision,
    baseSnapshot,
    contextPack,
  };
}

type ResourceCandidateFixture = ReturnType<typeof createResourceCandidateFixture>;

function resourceCandidateInput(
  fixture: ResourceCandidateFixture,
  label: string,
): StageGenerationTaskResourceCandidateInput {
  return {
    lease: fixture.claim.lease,
    candidate: {
      kind: "resource",
      resourceId: fixture.resource.id,
      revision: {
        revisionId: `generated-resource-revision-${label}`,
        parentRevisionId: fixture.attempt.baseRevisionId,
        manifestPath: `resource-revisions/${label}/generated/manifest.json`,
        summary: `Generated research ${label}`,
        metadata: { adapter: "research", label },
        checksum: checksum(`${label}:generated-resource`),
        provenance: {
          source: "resource-generation-adapter",
          adapter: "research",
        },
        createdByRunId: null,
      },
    },
    evidence: {
      adapterChecks: [{ id: "schema", status: "passed" }],
      quality: { status: "passed", score: 0.98 },
    },
  };
}

function expectedAttemptProvenance(
  fixture: ResourceCandidateFixture,
): Record<string, unknown> {
  return {
    kind: "generation-task-candidate",
    workspaceId: fixture.workspace.id,
    planId: fixture.plan.id,
    taskId: fixture.task.id,
    attempt: fixture.attempt.attempt,
    inputHash: fixture.attempt.inputHash,
    contextPackId: fixture.contextPack.id,
    contextPackHash: fixture.contextPack.hash,
    kernelRevisionId: fixture.attempt.kernelRevisionId,
  };
}

function candidateEvents(fixture: ResourceCandidateFixture): GenerationPlanEvent[] {
  return fixture.store.workspace.listGenerationPlanEventsForProject(
    fixture.project.id,
    fixture.plan.id,
    { after: 0, limit: 1_000 },
  ).filter((event) => event.taskId === fixture.task.id && event.type === "task-candidate-ready");
}

function taskEvents(
  fixture: ResourceCandidateFixture,
  type: GenerationPlanEvent["type"],
): GenerationPlanEvent[] {
  return fixture.store.workspace.listGenerationPlanEventsForProject(
    fixture.project.id,
    fixture.plan.id,
    { after: 0, limit: 1_000 },
  ).filter((event) => event.taskId === fixture.task.id && event.type === type);
}

function durableState(fixture: ResourceCandidateFixture) {
  return {
    workspace: fixture.store.db.prepare(
      "SELECT * FROM project_workspaces WHERE id = ?",
    ).get(fixture.workspace.id),
    resource: fixture.store.db.prepare(
      "SELECT * FROM resources WHERE id = ? AND workspace_id = ?",
    ).get(fixture.resource.id, fixture.workspace.id),
    revisions: fixture.store.db.prepare(
      "SELECT * FROM resource_revisions WHERE resource_id = ? ORDER BY sequence",
    ).all(fixture.resource.id),
    snapshots: fixture.store.db.prepare(
      "SELECT * FROM workspace_snapshots WHERE workspace_id = ? ORDER BY sequence",
    ).all(fixture.workspace.id),
    snapshotResources: fixture.store.db.prepare(
      `SELECT * FROM workspace_snapshot_resources
       WHERE workspace_id = ? ORDER BY snapshot_id, resource_id`,
    ).all(fixture.workspace.id),
    task: fixture.store.db.prepare(
      "SELECT * FROM generation_tasks WHERE id = ? AND plan_id = ?",
    ).get(fixture.task.id, fixture.plan.id),
    attempts: fixture.store.db.prepare(
      "SELECT * FROM generation_task_attempts WHERE task_id = ? ORDER BY attempt",
    ).all(fixture.task.id),
    claims: fixture.store.db.prepare(
      "SELECT * FROM generation_task_claims WHERE task_id = ? ORDER BY claim_key",
    ).all(fixture.task.id),
    events: fixture.store.db.prepare(
      "SELECT * FROM generation_plan_events WHERE plan_id = ? ORDER BY sequence",
    ).all(fixture.plan.id),
  };
}

function currentTaskAndAttempt(fixture: ResourceCandidateFixture): {
  task: GenerationTask;
  attempt: GenerationTaskAttempt;
} {
  const task = fixture.store.workspace.getGenerationPlanDetailForProject(
    fixture.project.id,
    fixture.plan.id,
  ).tasks.find((candidate) => candidate.id === fixture.task.id);
  assert.ok(task);
  const attempt = fixture.store.workspace.getGenerationTaskAttemptForProject(
    fixture.project.id,
    fixture.plan.id,
    fixture.task.id,
    task.currentAttempt,
  );
  assert.ok(attempt);
  return { task, attempt };
}

function assertClaimsReleased(fixture: ResourceCandidateFixture): void {
  assert.deepEqual(
    fixture.store.db.prepare(
      "SELECT * FROM generation_task_claims WHERE task_id = ? ORDER BY claim_key",
    ).all(fixture.task.id),
    [],
  );
}

function stageFixtureCandidate(
  fixture: ResourceCandidateFixture,
  label: string,
): StageGenerationTaskResourceCandidateResult {
  return resourceCandidateApi(fixture.store).stageGenerationTaskCandidateForProject(
    fixture.project.id,
    fixture.plan.id,
    resourceCandidateInput(fixture, label),
  );
}

function resourcePayloadJournalInput(
  fixture: ResourceCandidateFixture,
  revisionId: string,
): ResourcePayloadStagingBeginInput {
  return {
    taskId: fixture.task.id,
    attempt: fixture.attempt.attempt,
    inputHash: fixture.attempt.inputHash,
    workspaceId: fixture.workspace.id,
    resourceId: fixture.resource.id,
    revisionId,
    lease: fixture.claim.lease,
    manifestPath: `resource-revisions/${checksum(fixture.workspace.id)}/${checksum(revisionId)}/manifest.json`,
    payloadChecksum: checksum(`${revisionId}:payload`),
    manifestChecksum: checksum(`${revisionId}:manifest`),
    receiptChecksum: checksum(`${revisionId}:receipt`),
    byteSize: 128,
    mimeType: "text/plain",
  };
}

function resourcePayloadIdentity(input: ResourcePayloadCleanupInput): ResourcePayloadCleanupInput {
  return {
    taskId: input.taskId,
    attempt: input.attempt,
    inputHash: input.inputHash,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    revisionId: input.revisionId,
  };
}

test("journals exact Resource payload staging before storage and exposes a bounded restart inventory", () => {
  const fixture = createResourceCandidateFixture("payload-journal-lifecycle");
  try {
    const api = resourceCandidateApi(fixture.store);
    const input = resourcePayloadJournalInput(
      fixture,
      "generated-resource-revision-payload-journal-lifecycle",
    );

    const prepared = api.beginResourcePayloadStaging(input);
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.storageDisposition, null);
    assert.equal(prepared.planId, fixture.plan.id);
    assert.deepEqual(api.beginResourcePayloadStaging(input), prepared, "lost begin response must replay exactly");

    const firstPage = api.listResourcePayloadRecoveryEntries({ limit: 1 });
    assert.deepEqual(firstPage.entries, [{ journal: prepared, cleanup: null }]);
    assert.deepEqual(firstPage.nextCursor, {
      afterSequence: prepared.sequence,
      throughSequence: prepared.sequence,
    });
    assert.deepEqual(
      api.listResourcePayloadRecoveryEntries({ cursor: firstPage.nextCursor, limit: 1 }),
      { entries: [], nextCursor: null },
    );

    fixture.control.set(100_002);
    const classified = api.classifyResourcePayloadStaging({
      ...resourcePayloadIdentity(input),
      lease: input.lease,
      storageDisposition: "owned-created",
    });
    assert.equal(classified.storageDisposition, "owned-created");
    assert.equal(classified.classifiedAt, 100_002);

    fixture.control.set(100_003);
    const committed = api.completeResourcePayloadStaging({
      ...resourcePayloadIdentity(input),
      lease: input.lease,
      receiptChecksum: input.receiptChecksum,
    });
    assert.equal(committed.status, "receipt-committed");
    assert.equal(committed.receiptCommittedAt, 100_003);
    assert.deepEqual(
      api.completeResourcePayloadStaging({
        ...resourcePayloadIdentity(input),
        lease: input.lease,
        receiptChecksum: input.receiptChecksum,
      }),
      committed,
      "lost completion response must replay exactly",
    );
    fixture.store.deleteProject(fixture.project.id);
    assert.equal(fixture.store.getProject(fixture.project.id), null);
  } finally {
    fixture.store.close();
  }
});

test("Resource payload staging journal rejects identity substitution and fences referenced candidates", () => {
  const fixture = createResourceCandidateFixture("payload-journal-fence");
  try {
    const api = resourceCandidateApi(fixture.store);
    const input = resourcePayloadJournalInput(
      fixture,
      "generated-resource-revision-payload-journal-fence",
    );
    api.beginResourcePayloadStaging(input);
    assert.throws(
      () => api.beginResourcePayloadStaging({ ...input, payloadChecksum: checksum("substituted") }),
      /collides|identity|checksum/i,
    );
    api.classifyResourcePayloadStaging({
      ...resourcePayloadIdentity(input),
      lease: input.lease,
      storageDisposition: "owned-created",
    });
    api.completeResourcePayloadStaging({
      ...resourcePayloadIdentity(input),
      lease: input.lease,
      receiptChecksum: input.receiptChecksum,
    });

    const staged = api.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        ...resourceCandidateInput(fixture, "payload-journal-fence"),
        candidate: {
          ...resourceCandidateInput(fixture, "payload-journal-fence").candidate,
          revision: {
            ...resourceCandidateInput(fixture, "payload-journal-fence").candidate.revision,
            revisionId: input.revisionId,
            manifestPath: input.manifestPath,
            checksum: input.manifestChecksum,
          },
        },
      },
    );
    assert.equal(staged.resourceRevision.id, input.revisionId);
    assert.equal(api.tryClaimResourcePayloadCleanup(resourcePayloadIdentity(input)), null);
    assert.deepEqual(api.listResourcePayloadRecoveryEntries({ limit: 10 }), {
      entries: [],
      nextCursor: null,
    });
  } finally {
    fixture.store.close();
  }
});

test("a stale Resource payload worker cannot create a staging journal", () => {
  const fixture = createResourceCandidateFixture("payload-journal-stale-lease");
  try {
    const api = resourceCandidateApi(fixture.store);
    const input = resourcePayloadJournalInput(
      fixture,
      "generated-resource-revision-payload-journal-stale-lease",
    );
    assert.throws(
      () => api.beginResourcePayloadStaging({
        ...input,
        lease: { ...input.lease, leaseToken: `${input.lease.leaseToken}-stale` },
      }),
      /lease|active|fence|owner/i,
    );
    const journalCount = fixture.store.db.prepare(
      "SELECT COUNT(*) AS count FROM resource_payload_staging_journal",
    ).get() as { count: number };
    assert.equal(journalCount.count, 0);
  } finally {
    fixture.store.close();
  }
});

test("staging a Resource candidate atomically records an Attempt-derived immutable Revision", () => {
  const fixture = createResourceCandidateFixture("stage-success");
  try {
    const input = resourceCandidateInput(fixture, "stage-success");
    const before = durableState(fixture);
    const result = resourceCandidateApi(fixture.store).stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );

    assert.equal(result.artifactRevision, null);
    assert.equal(result.resourceRevision.id, input.candidate.revision.revisionId);
    assert.equal(result.resourceRevision.workspaceId, fixture.attempt.workspaceId);
    assert.equal(result.resourceRevision.resourceId, fixture.attempt.target.id);
    assert.equal(result.resourceRevision.parentRevisionId, fixture.attempt.baseRevisionId);
    assert.equal(result.resourceRevision.manifestPath, input.candidate.revision.manifestPath);
    assert.equal(result.resourceRevision.summary, input.candidate.revision.summary);
    assert.deepEqual(result.resourceRevision.metadata, input.candidate.revision.metadata);
    assert.equal(result.resourceRevision.checksum, input.candidate.revision.checksum);
    assert.equal(result.resourceRevision.createdByRunId, null);
    assert.deepEqual(result.resourceRevision.provenance, {
      ...input.candidate.revision.provenance,
      generationTask: expectedAttemptProvenance(fixture),
    });

    const expectedEvidenceHash = generationTaskCandidateEvidenceHash({
      taskId: fixture.task.id,
      planId: fixture.plan.id,
      workspaceId: fixture.workspace.id,
      attempt: fixture.attempt.attempt,
      candidateRevisionId: null,
      candidateResourceRevisionId: result.resourceRevision.id,
      candidateEvidence: input.evidence,
    });
    assert.equal(result.attempt.status, "candidate-ready");
    assert.equal(result.attempt.candidateRevisionId, null);
    assert.equal(result.attempt.candidateResourceRevisionId, result.resourceRevision.id);
    assert.deepEqual(result.attempt.candidateEvidence, input.evidence);
    assert.equal(result.attempt.candidateEvidenceHash, expectedEvidenceHash);
    assert.deepEqual(result.attempt.lease, fixture.claim.lease);

    const { task } = currentTaskAndAttempt(fixture);
    assert.equal(task.status, "candidate-ready");
    assert.equal(task.resultRevisionId, null);
    assert.equal(task.resultResourceRevisionId, null);
    assert.equal(task.resultSnapshotId, null);
    assert.equal(fixture.store.workspace.getResourceForProject(
      fixture.project.id,
      fixture.resource.id,
    )?.headRevisionId, fixture.baseRevision.id);
    assert.equal(fixture.store.workspace.getWorkspace(
      fixture.project.id,
    )?.activeSnapshotId, fixture.baseSnapshot.id);

    const after = durableState(fixture);
    assert.equal(after.revisions.length, before.revisions.length + 1);
    assert.equal(after.snapshots.length, before.snapshots.length);
    const events = candidateEvents(fixture);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.payload, {
      attempt: fixture.attempt.attempt,
      candidateRevisionId: null,
      candidateResourceRevisionId: result.resourceRevision.id,
      candidateEvidenceHash: expectedEvidenceHash,
    });
    assert.throws(
      () => fixture.store.db.prepare(
        "UPDATE resource_revisions SET summary = 'mutated' WHERE id = ?",
      ).run(result.resourceRevision.id),
      /immutable|revision/i,
    );
  } finally {
    fixture.store.close();
  }
});

test("Resource candidate target, parent, and reserved provenance cannot escape the Attempt", async (t) => {
  await t.test("wrong target", () => {
    const fixture = createResourceCandidateFixture("wrong-target");
    try {
      const input = resourceCandidateInput(fixture, "wrong-target");
      input.candidate.resourceId = `${fixture.resource.id}-foreign`;
      const before = durableState(fixture);
      assert.throws(() => resourceCandidateApi(fixture.store).stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ), /target|resource|candidate/i);
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("wrong parent", () => {
    const fixture = createResourceCandidateFixture("wrong-parent");
    try {
      const input = resourceCandidateInput(fixture, "wrong-parent");
      input.candidate.revision.parentRevisionId = null;
      const before = durableState(fixture);
      assert.throws(() => resourceCandidateApi(fixture.store).stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ), /parent|base|candidate/i);
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("forged Generation Task provenance", () => {
    const fixture = createResourceCandidateFixture("forged-provenance");
    try {
      const input = resourceCandidateInput(fixture, "forged-provenance");
      input.candidate.revision.provenance = {
        ...input.candidate.revision.provenance,
        generationTask: {
          ...expectedAttemptProvenance(fixture),
          contextPackHash: checksum("foreign-context"),
        },
      };
      const before = durableState(fixture);
      assert.throws(() => resourceCandidateApi(fixture.store).stageGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        input,
      ), /provenance|reserved|candidate/i);
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("Resource candidate staging rejects stale, expired, and incomplete lease fences without writes", async (t) => {
  await t.test("wrong lease token", () => {
    const fixture = createResourceCandidateFixture("stage-wrong-token");
    try {
      const input = resourceCandidateInput(fixture, "stage-wrong-token");
      input.lease = { ...input.lease, leaseToken: `${input.lease.leaseToken}-wrong` };
      const before = durableState(fixture);
      assert.throws(
        () => resourceCandidateApi(fixture.store).stageGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          input,
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("expired lease", () => {
    const fixture = createResourceCandidateFixture("stage-expired-token");
    try {
      assert.ok(fixture.claim.attempt.leaseExpiresAt);
      fixture.control.set(fixture.claim.attempt.leaseExpiresAt);
      const before = durableState(fixture);
      assert.throws(
        () => stageFixtureCandidate(fixture, "stage-expired-token"),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("missing required claim", () => {
    const fixture = createResourceCandidateFixture("stage-missing-claim");
    try {
      fixture.store.db.exec("DROP TRIGGER generation_task_claim_delete_live_guard");
      const deleted = fixture.store.db.prepare(
        `DELETE FROM generation_task_claims
         WHERE claim_key = (
           SELECT claim_key FROM generation_task_claims
           WHERE task_id = ? ORDER BY claim_key LIMIT 1
         )`,
      ).run(fixture.task.id);
      assert.equal(Number(deleted.changes), 1);
      const before = durableState(fixture);
      assert.throws(
        () => stageFixtureCandidate(fixture, "stage-missing-claim"),
        /claim|lease|fence/i,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("an exact Resource candidate lost-response replay is idempotent and divergent replay is rejected", () => {
  const fixture = createResourceCandidateFixture("stage-replay");
  try {
    const api = resourceCandidateApi(fixture.store);
    const input = resourceCandidateInput(fixture, "stage-replay");
    const first = api.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    const afterFirst = durableState(fixture);
    const replay = api.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    assert.deepEqual(replay, first);
    assert.deepEqual(durableState(fixture), afterFirst);
    assert.equal(candidateEvents(fixture).length, 1);

    const divergent = resourceCandidateInput(fixture, "stage-replay");
    divergent.candidate.revision.summary = "Different immutable output";
    assert.throws(() => api.stageGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      divergent,
    ), /different|immutable|candidate|replay/i);
    assert.deepEqual(durableState(fixture), afterFirst);
  } finally {
    fixture.store.close();
  }
});

test("candidate-ready event failure rolls back Resource Revision insertion and state", () => {
  const fixture = createResourceCandidateFixture("stage-event-rollback");
  try {
    fixture.store.db.exec(
      `CREATE TRIGGER reject_resource_candidate_event
       BEFORE INSERT ON generation_plan_events
       WHEN NEW.type = 'task-candidate-ready'
       BEGIN
         SELECT RAISE(ABORT, 'injected Resource candidate event failure');
       END`,
    );
    const before = durableState(fixture);
    assert.throws(
      () => stageFixtureCandidate(fixture, "stage-event-rollback"),
      /injected Resource candidate event failure/,
    );
    assert.deepEqual(durableState(fixture), before);
  } finally {
    fixture.store.close();
  }
});

function createStagedResourceCandidateFixture(label: string) {
  const fixture = createResourceCandidateFixture(label);
  const staged = stageFixtureCandidate(fixture, label);
  return { ...fixture, staged };
}

type StagedResourceCandidateFixture = ReturnType<typeof createStagedResourceCandidateFixture>;

function publicationInput(fixture: StagedResourceCandidateFixture) {
  return { lease: fixture.claim.lease };
}

function driftSnapshotOnly(fixture: StagedResourceCandidateFixture) {
  const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
  const drift = fixture.store.workspace.applyGraphCommands(fixture.project.id, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: `rename-resource-during-publication-${fixture.task.id}`,
      type: "rename-node",
      nodeId: fixture.nodeId,
      name: "Research renamed during publication",
    }],
  });
  assert.equal(fixture.store.workspace.getResourceForProject(
    fixture.project.id,
    fixture.resource.id,
  )?.headRevisionId, fixture.baseRevision.id);
  return drift.snapshot;
}

function driftResourceHead(fixture: StagedResourceCandidateFixture, label: string) {
  const competing = fixture.store.workspace.createResourceRevisionCandidateForProject(
    fixture.project.id,
    fixture.resource.id,
    {
      revisionId: `competing-resource-revision-${label}`,
      parentRevisionId: fixture.baseRevision.id,
      manifestPath: `resource-revisions/${label}/competing/manifest.json`,
      summary: "Competing Resource revision",
      metadata: { source: "competing-publication" },
      checksum: checksum(`${label}:competing-resource`),
      provenance: { source: "competing-publication" },
    },
  );
  const snapshot = fixture.store.workspace.publishResourceRevisionForProject(
    fixture.project.id,
    fixture.resource.id,
    competing.id,
    {
      expectedHeadRevisionId: fixture.baseRevision.id,
      expectedSnapshotId: fixture.staged.attempt.expectedSnapshotId,
      reason: "Publish competing Resource revision",
    },
  );
  return { competing, snapshot };
}

function assertResourceNeedsRebase(
  fixture: StagedResourceCandidateFixture,
  conflict: ResourcePublicationConflict,
): void {
  const { task, attempt } = currentTaskAndAttempt(fixture);
  assert.equal(task.status, "needs-rebase");
  assert.equal(attempt.status, "needs-rebase");
  assert.equal(task.failureClass, "publication-conflict");
  assert.equal(attempt.failureClass, "publication-conflict");
  assert.deepEqual(task.error, attempt.error);
  assert.equal(attempt.error?.pointer, conflict.pointer);
  assert.equal(attempt.error?.expectedId, conflict.expectedId);
  assert.equal(attempt.error?.actualId, conflict.actualId);
  assert.equal(attempt.candidateRevisionId, null);
  assert.equal(attempt.candidateResourceRevisionId, fixture.staged.resourceRevision.id);
  assert.deepEqual(attempt.candidateEvidence, fixture.staged.attempt.candidateEvidence);
  assert.equal(attempt.candidateEvidenceHash, fixture.staged.attempt.candidateEvidenceHash);
  assert.equal(task.resultRevisionId, null);
  assert.equal(task.resultResourceRevisionId, null);
  assert.equal(task.resultSnapshotId, null);
  assert.equal(attempt.lease, null);
  assert.equal(attempt.leaseExpiresAt, null);
  assert.equal(attempt.heartbeatAt, null);
  assert.ok(attempt.finishedAt !== null);
  assertClaimsReleased(fixture);

  const events = taskEvents(fixture, "task-needs-rebase");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.payload, {
    attempt: attempt.attempt,
    pointer: conflict.pointer,
    expectedId: conflict.expectedId,
    actualId: conflict.actualId,
    candidateRevisionId: null,
    candidateResourceRevisionId: fixture.staged.resourceRevision.id,
    candidateEvidenceHash: fixture.staged.attempt.candidateEvidenceHash,
    publicationFenceHash: events[0]?.payload.publicationFenceHash,
  });
  assert.equal(typeof events[0]?.payload.publicationFenceHash, "string");
  assert.equal(taskEvents(fixture, "task-succeeded").length, 0);
}

test("publishing a recorded Resource candidate atomically moves Resource Head and active Snapshot", () => {
  const fixture = createStagedResourceCandidateFixture("publish-success");
  try {
    const before = durableState(fixture);
    const result = resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      publicationInput(fixture),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.artifactRevision, null);
    assert.equal(result.resourceRevision.id, fixture.staged.resourceRevision.id);
    assert.ok(result.snapshot);
    assert.equal(result.conflict, null);

    const { task, attempt } = currentTaskAndAttempt(fixture);
    assert.equal(task.status, "succeeded");
    assert.equal(attempt.status, "succeeded");
    assert.equal(task.resultRevisionId, null);
    assert.equal(task.resultResourceRevisionId, fixture.staged.resourceRevision.id);
    assert.equal(task.resultSnapshotId, result.snapshot.id);
    assert.equal(attempt.candidateRevisionId, null);
    assert.equal(attempt.candidateResourceRevisionId, fixture.staged.resourceRevision.id);
    assert.equal(attempt.lease, null);
    assert.equal(attempt.leaseExpiresAt, null);
    assert.equal(attempt.heartbeatAt, null);
    assert.ok(attempt.finishedAt !== null);
    assert.equal(task.finishedAt, attempt.finishedAt);
    assertClaimsReleased(fixture);

    const resource = fixture.store.workspace.getResourceForProject(
      fixture.project.id,
      fixture.resource.id,
    );
    const workspace = fixture.store.workspace.getWorkspace(fixture.project.id)!;
    assert.equal(resource?.headRevisionId, fixture.staged.resourceRevision.id);
    assert.equal(workspace.activeSnapshotId, result.snapshot.id);
    assert.equal(result.snapshot.parentSnapshotId, fixture.staged.attempt.expectedSnapshotId);
    assert.equal(result.snapshot.reason, "resource-published");
    assert.deepEqual(result.snapshot.provenance, {
      kind: "resource-publication",
      resourceRevisionId: fixture.staged.resourceRevision.id,
      planId: fixture.plan.id,
      taskId: fixture.task.id,
    });
    assert.equal(
      result.snapshot.resourceRevisions[fixture.resource.id],
      fixture.staged.resourceRevision.id,
    );

    const after = durableState(fixture);
    assert.equal(after.revisions.length, before.revisions.length);
    assert.equal(after.snapshots.length, before.snapshots.length + 1);
    assert.equal(candidateEvents(fixture).length, 1);
    const events = taskEvents(fixture, "task-succeeded");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.attempt, attempt.attempt);
    assert.equal(events[0]?.payload.resultRevisionId, null);
    assert.equal(events[0]?.payload.resultResourceRevisionId, fixture.staged.resourceRevision.id);
    assert.equal(events[0]?.payload.resultSnapshotId, result.snapshot.id);
    assert.equal(events[0]?.payload.candidateEvidenceHash, fixture.staged.attempt.candidateEvidenceHash);
    assert.equal(typeof events[0]?.payload.publicationFenceHash, "string");
  } finally {
    fixture.store.close();
  }
});

test("Resource Head or Snapshot drift preserves the candidate and records one needs-rebase outcome", async (t) => {
  await t.test("snapshot-only drift", () => {
    const fixture = createStagedResourceCandidateFixture("resource-snapshot-drift");
    try {
      const drift = driftSnapshotOnly(fixture);
      const before = durableState(fixture);
      const result = resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        publicationInput(fixture),
      );
      assert.equal(result.status, "needs-rebase");
      assert.deepEqual(result.conflict, {
        pointer: "active-snapshot",
        expectedId: fixture.staged.attempt.expectedSnapshotId,
        actualId: drift.id,
      });
      const after = durableState(fixture);
      assert.equal(after.revisions.length, before.revisions.length);
      assert.equal(after.snapshots.length, before.snapshots.length);
      assert.equal(fixture.store.workspace.getWorkspace(
        fixture.project.id,
      )?.activeSnapshotId, drift.id);
      assert.equal(fixture.store.workspace.getResourceForProject(
        fixture.project.id,
        fixture.resource.id,
      )?.headRevisionId, fixture.baseRevision.id);
      assertResourceNeedsRebase(fixture, result.conflict);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("target Resource Head drift", () => {
    const fixture = createStagedResourceCandidateFixture("resource-head-drift");
    try {
      const drift = driftResourceHead(fixture, "resource-head-drift");
      const before = durableState(fixture);
      const result = resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
        fixture.project.id,
        fixture.plan.id,
        publicationInput(fixture),
      );
      assert.equal(result.status, "needs-rebase");
      assert.deepEqual(result.conflict, {
        pointer: "resource-head",
        expectedId: fixture.baseRevision.id,
        actualId: drift.competing.id,
      });
      const after = durableState(fixture);
      assert.equal(after.revisions.length, before.revisions.length);
      assert.equal(after.snapshots.length, before.snapshots.length);
      assert.equal(fixture.store.workspace.getWorkspace(
        fixture.project.id,
      )?.activeSnapshotId, drift.snapshot.id);
      assert.equal(fixture.store.workspace.getResourceForProject(
        fixture.project.id,
        fixture.resource.id,
      )?.headRevisionId, drift.competing.id);
      assertResourceNeedsRebase(fixture, result.conflict);
    } finally {
      fixture.store.close();
    }
  });
});

test("Snapshot-only Resource drift appends a publication-only successor with retained payload evidence", () => {
  const fixture = createStagedResourceCandidateFixture("resource-rebase-publication-only");
  try {
    const latestSnapshot = driftSnapshotOnly(fixture);
    resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      publicationInput(fixture),
    );
    const disposition = fixture.store.workspace.reconcileGenerationTaskNeedsRebaseForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
    );
    assert.equal(disposition.kind, "publication-only");
    if (disposition.kind !== "publication-only") assert.fail("expected publication-only Resource rebase");
    assert.equal(disposition.successorAttempt.expectedSnapshotId, latestSnapshot.id);
    assert.equal(disposition.successorAttempt.candidateRevisionId, null);
    assert.equal(
      disposition.successorAttempt.candidateResourceRevisionId,
      fixture.staged.resourceRevision.id,
    );
    assert.deepEqual(
      disposition.successorAttempt.candidateEvidence,
      fixture.staged.attempt.candidateEvidence,
    );
    fixture.control.set(100_010);
    const claim = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.task.id,
      attempt: disposition.successorAttempt.attempt,
      ownerId: "resource-publication-only-rebase-worker",
      now: 100_010,
      leaseMs: 30_000,
    });
    assert.ok(claim);
    fixture.control.set(100_011);
    const published = resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      { lease: claim.lease },
    );
    assert.equal(published.status, "succeeded");
    assert.equal(currentTaskAndAttempt(fixture).task.status, "succeeded");
  } finally {
    fixture.store.close();
  }
});

test("Resource publication rejects wrong, expired, and incomplete claim fences without writes", async (t) => {
  await t.test("wrong lease token", () => {
    const fixture = createStagedResourceCandidateFixture("publish-wrong-token");
    try {
      const before = durableState(fixture);
      assert.throws(
        () => resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          {
            lease: {
              ...fixture.claim.lease,
              leaseToken: `${fixture.claim.lease.leaseToken}-wrong`,
            },
          },
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("expired lease", () => {
    const fixture = createStagedResourceCandidateFixture("publish-expired-token");
    try {
      assert.ok(fixture.staged.attempt.leaseExpiresAt);
      fixture.control.set(fixture.staged.attempt.leaseExpiresAt);
      const before = durableState(fixture);
      assert.throws(
        () => resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        (error) => error instanceof GenerationTaskLeaseFenceError,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("missing required claim", () => {
    const fixture = createStagedResourceCandidateFixture("publish-missing-claim");
    try {
      fixture.store.db.exec("DROP TRIGGER generation_task_claim_delete_live_guard");
      const deleted = fixture.store.db.prepare(
        `DELETE FROM generation_task_claims
         WHERE claim_key = (
           SELECT claim_key FROM generation_task_claims
           WHERE task_id = ? ORDER BY claim_key LIMIT 1
         )`,
      ).run(fixture.task.id);
      assert.equal(Number(deleted.changes), 1);
      const before = durableState(fixture);
      assert.throws(
        () => resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        /claim|lease|fence/i,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("terminal event failures roll back Resource publication and needs-rebase transitions", async (t) => {
  await t.test("task-succeeded event failure", () => {
    const fixture = createStagedResourceCandidateFixture("publish-event-rollback");
    try {
      fixture.store.db.exec(
        `CREATE TRIGGER reject_resource_success_event
         BEFORE INSERT ON generation_plan_events
         WHEN NEW.type = 'task-succeeded'
         BEGIN
           SELECT RAISE(ABORT, 'injected Resource success event failure');
         END`,
      );
      const before = durableState(fixture);
      assert.throws(
        () => resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        /injected Resource success event failure/,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });

  await t.test("task-needs-rebase event failure", () => {
    const fixture = createStagedResourceCandidateFixture("rebase-event-rollback");
    try {
      driftSnapshotOnly(fixture);
      fixture.store.db.exec(
        `CREATE TRIGGER reject_resource_rebase_event
         BEFORE INSERT ON generation_plan_events
         WHEN NEW.type = 'task-needs-rebase'
         BEGIN
           SELECT RAISE(ABORT, 'injected Resource rebase event failure');
         END`,
      );
      const before = durableState(fixture);
      assert.throws(
        () => resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
          fixture.project.id,
          fixture.plan.id,
          publicationInput(fixture),
        ),
        /injected Resource rebase event failure/,
      );
      assert.deepEqual(durableState(fixture), before);
    } finally {
      fixture.store.close();
    }
  });
});

test("an exact Resource publication lost-response replay creates no second Snapshot or event", () => {
  const fixture = createStagedResourceCandidateFixture("publish-replay");
  try {
    const api = resourceCandidateApi(fixture.store);
    const input = publicationInput(fixture);
    const first = api.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    const afterFirst = durableState(fixture);
    const replay = api.publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      input,
    );
    assert.deepEqual(replay, first);
    assert.deepEqual(durableState(fixture), afterFirst);
    assert.equal(taskEvents(fixture, "task-succeeded").length, 1);
  } finally {
    fixture.store.close();
  }
});

test("a claimed publication-only successor reuses the Resource candidate and its source provenance", () => {
  const fixture = createStagedResourceCandidateFixture("publication-successor");
  try {
    const sourceProvenance = fixture.staged.resourceRevision.provenance;
    assert.ok(fixture.staged.attempt.leaseExpiresAt);
    fixture.control.set(fixture.staged.attempt.leaseExpiresAt);
    fixture.store.workspace.recoverExpiredGenerationTaskAttempts(
      fixture.staged.attempt.leaseExpiresAt,
    );
    const recoveredTask = fixture.store.workspace.getGenerationPlanDetailForProject(
      fixture.project.id,
      fixture.plan.id,
    ).tasks.find((candidate) => candidate.id === fixture.task.id);
    assert.ok(recoveredTask);
    const successor = fixture.store.workspace.getGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      recoveredTask.currentAttempt,
    );
    assert.ok(successor);
    assert.equal(successor.executionMode, "publication-only");
    assert.equal(successor.candidateRevisionId, null);
    assert.equal(successor.candidateResourceRevisionId, fixture.staged.resourceRevision.id);
    assert.ok(recoveredTask.nextEligibleAt);
    const replacement = fixture.store.workspace.tryClaimGenerationTaskAttempt({
      taskId: fixture.task.id,
      attempt: successor.attempt,
      ownerId: "resource-publication-retry-worker",
      now: recoveredTask.nextEligibleAt,
      leaseMs: 30_000,
    });
    assert.ok(replacement);
    fixture.control.set(recoveredTask.nextEligibleAt + 1);
    const beforeRevisionCount = fixture.store.workspace.listResourceRevisions(
      fixture.project.id,
      fixture.resource.id,
    ).length;

    const result = resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      { lease: replacement.lease },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.resourceRevision.id, fixture.staged.resourceRevision.id);
    assert.deepEqual(result.resourceRevision.provenance, sourceProvenance);
    assert.equal(
      fixture.store.workspace.listResourceRevisions(fixture.project.id, fixture.resource.id).length,
      beforeRevisionCount,
    );
    assert.equal(taskEvents(fixture, "task-succeeded").length, 1);
  } finally {
    fixture.store.close();
  }
});

test("a terminal empty Resource Attempt durably claims and completes its exact payload tombstone", () => {
  const directory = mkdtempSync(join(tmpdir(), "dezin-resource-cleanup-claim-"));
  const databasePath = join(directory, "store.sqlite");
  const fixture = createResourceCandidateFixture("payload-cleanup-terminal", databasePath);
  const input: ResourcePayloadCleanupInput = {
    taskId: fixture.task.id,
    attempt: fixture.attempt.attempt,
    inputHash: fixture.attempt.inputHash,
    workspaceId: fixture.workspace.id,
    resourceId: fixture.resource.id,
    revisionId: "generated-resource-revision-payload-cleanup-terminal",
  };
  try {
    const api = resourceCandidateApi(fixture.store);
    const journalInput = resourcePayloadJournalInput(fixture, input.revisionId);
    api.beginResourcePayloadStaging(journalInput);
    api.classifyResourcePayloadStaging({
      ...input,
      lease: journalInput.lease,
      storageDisposition: "owned-created",
    });
    api.completeResourcePayloadStaging({
      ...input,
      lease: journalInput.lease,
      receiptChecksum: journalInput.receiptChecksum,
    });
    fixture.store.workspace.finishGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      {
        lease: fixture.claim.lease,
        failure: {
          failureClass: "cancelled",
          error: { code: "TEST_CANCELLED_AFTER_PAYLOAD_STAGE" },
        },
      },
    );
    assert.equal(typeof api.tryClaimResourcePayloadCleanup, "function");
    const claimed = api.tryClaimResourcePayloadCleanup(input);
    assert.deepEqual(claimed, {
      ...input,
      planId: fixture.plan.id,
      status: "claimed",
      claimedAt: 100_001,
      completedAt: null,
    });
    assert.deepEqual(api.tryClaimResourcePayloadCleanup(input), claimed);
    fixture.store.close();

    const restartControl = controlledClock("payload-cleanup-restart");
    restartControl.set(200_000);
    const reopened = new Store(databasePath, restartControl.clock);
    try {
      const restartedApi = resourceCandidateApi(reopened);
      assert.deepEqual(restartedApi.tryClaimResourcePayloadCleanup(input), claimed);
      const completed = restartedApi.completeResourcePayloadCleanup(input);
      assert.deepEqual(completed, {
        ...claimed,
        status: "completed",
        completedAt: 200_000,
      });
      assert.deepEqual(restartedApi.completeResourcePayloadCleanup(input), completed);
      assert.throws(
        () => reopened.workspace.createResourceRevisionCandidateForProject(
          fixture.project.id,
          fixture.resource.id,
          {
            revisionId: input.revisionId,
            parentRevisionId: fixture.baseRevision.id,
            manifestPath: "resource-revisions/payload-cleanup/tombstoned/manifest.json",
            summary: "Must not resurrect a deleted staged payload",
            metadata: {},
            checksum: checksum("payload-cleanup-tombstoned"),
            provenance: { source: "tombstone-regression" },
          },
        ),
        /cleanup|tombstone|deleted|revision/i,
      );
    } finally {
      reopened.close();
    }
  } finally {
    try { fixture.store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a Core-committed Resource candidate is retained even when its stage response is lost", () => {
  const fixture = createResourceCandidateFixture("payload-cleanup-retained");
  try {
    const staged = stageFixtureCandidate(fixture, "payload-cleanup-retained");
    const input: ResourcePayloadCleanupInput = {
      taskId: fixture.task.id,
      attempt: fixture.attempt.attempt,
      inputHash: fixture.attempt.inputHash,
      workspaceId: fixture.workspace.id,
      resourceId: fixture.resource.id,
      revisionId: staged.resourceRevision.id,
    };
    assert.equal(resourceCandidateApi(fixture.store).tryClaimResourcePayloadCleanup(input), null);
    const published = resourceCandidateApi(fixture.store).publishGenerationTaskCandidateForProject(
      fixture.project.id,
      fixture.plan.id,
      publicationInput({ ...fixture, staged }),
    );
    assert.equal(published.status, "succeeded");
    assert.equal(resourceCandidateApi(fixture.store).tryClaimResourcePayloadCleanup(input), null);
  } finally {
    fixture.store.close();
  }
});

test("lease recovery terminalizes an empty source Attempt before its payload can be claimed", () => {
  const fixture = createResourceCandidateFixture("payload-cleanup-lease-recovery");
  try {
    const input: ResourcePayloadCleanupInput = {
      taskId: fixture.task.id,
      attempt: fixture.attempt.attempt,
      inputHash: fixture.attempt.inputHash,
      workspaceId: fixture.workspace.id,
      resourceId: fixture.resource.id,
      revisionId: "generated-resource-revision-payload-cleanup-lease-recovery",
    };
    const api = resourceCandidateApi(fixture.store);
    const journalInput = resourcePayloadJournalInput(fixture, input.revisionId);
    api.beginResourcePayloadStaging(journalInput);
    api.classifyResourcePayloadStaging({
      ...input,
      lease: journalInput.lease,
      storageDisposition: "owned-created",
    });
    api.completeResourcePayloadStaging({
      ...input,
      lease: journalInput.lease,
      receiptChecksum: journalInput.receiptChecksum,
    });
    assert.ok(fixture.claim.attempt.leaseExpiresAt);
    fixture.control.set(fixture.claim.attempt.leaseExpiresAt);
    fixture.store.workspace.recoverExpiredGenerationTaskAttempts(
      fixture.claim.attempt.leaseExpiresAt,
    );
    const source = fixture.store.workspace.getGenerationTaskAttemptForProject(
      fixture.project.id,
      fixture.plan.id,
      fixture.task.id,
      fixture.attempt.attempt,
    );
    assert.ok(source);
    assert.equal(source.status, "retryable-failed");
    assert.equal(
      resourceCandidateApi(fixture.store).tryClaimResourcePayloadCleanup({
        ...input,
        resourceId: `${fixture.resource.id}-wrong`,
      }),
      null,
    );
    assert.equal(
      resourceCandidateApi(fixture.store).tryClaimResourcePayloadCleanup(input)?.status,
      "claimed",
    );
  } finally {
    fixture.store.close();
  }
});
