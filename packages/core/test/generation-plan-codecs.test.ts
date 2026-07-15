import assert from "node:assert/strict";
import test from "node:test";
import {
  asGenerationTaskAttempt,
  asGenerationTask,
  asGenerationPlanEvent,
  generationTaskCandidateEvidenceHash,
  generationTaskAttemptInputHash,
  generationTaskIntentHash,
  normalizeGenerationTaskAttemptInput,
  normalizeGenerationTaskAttemptLease,
  normalizeGenerationTaskIntent,
  normalizeListGenerationPlanEventsInput,
} from "../src/index.ts";

function attemptInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "task-page-home",
    planId: "plan-1",
    workspaceId: "workspace-1",
    attempt: 1,
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact-home",
      trackId: "track-main",
    },
    baseRevisionId: "revision-home-1",
    expectedSnapshotId: "snapshot-1",
    contextPackId: "context-pack-1",
    kernelRevisionId: "kernel-1",
    payload: { operation: "revise" },
    dependencyOutputs: [
      {
        taskId: "task-validation-z",
        resultRevisionId: null,
        resultResourceRevisionId: null,
        resultSnapshotId: "snapshot-validation-z",
      },
      {
        taskId: "task-component-z",
        resultRevisionId: "component-revision-z",
        resultResourceRevisionId: null,
        resultSnapshotId: null,
      },
      {
        taskId: "task-resource-z",
        resultRevisionId: null,
        resultResourceRevisionId: "resource-revision-z",
        resultSnapshotId: null,
      },
    ],
    resourcePins: [
      { resourceId: "resource-z", revisionId: "resource-revision-z", sourceTaskId: "task-resource-z" },
      { resourceId: "resource-a", revisionId: "resource-revision-a", sourceTaskId: null },
    ],
    componentPins: [
      {
        instanceId: "instance-z",
        ownerArtifactId: "artifact-home",
        componentArtifactId: "component-z",
        revisionId: "component-revision-z",
        sourceTaskId: "task-component-z",
        variantKey: null,
        stateKey: "active",
        sourceLocator: { selector: "#z", designNodeId: "node-z" },
        overrides: { b: 2, a: 1 },
        status: "linked",
      },
      {
        instanceId: "instance-a",
        ownerArtifactId: "artifact-home",
        componentArtifactId: "component-a",
        revisionId: "component-revision-a",
        sourceTaskId: null,
        variantKey: "compact",
        stateKey: null,
        sourceLocator: { designNodeId: "node-a", sourcePath: "src/a.tsx" },
        overrides: {},
        status: "detached",
      },
    ],
    retryContextPolicy: "same-context",
    executionMode: "full",
    ...overrides,
  };
}

function taskIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-page-home",
    ordinal: 3,
    workspaceId: "workspace-1",
    planId: "plan-1",
    kind: "page",
    target: {
      type: "artifact",
      workspaceId: "workspace-1",
      id: "artifact-home",
      trackId: "track-main",
    },
    dependencyIds: ["task-component-card", "task-resource-copy"],
    payload: { z: 1, nested: { beta: true, alpha: "first" }, a: 2 },
    capabilities: ["visual-qa", "browser"],
    qaProfile: {
      requiredFrameIds: ["mobile", "desktop"],
      blockingSeverities: ["P1", "P0"],
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
    resourceLimits: {
      timeoutMs: 120_000,
      maxAgentTurns: 8,
      maxRepairRounds: 2,
      maxOutputBytes: 8_000_000,
      capacityClasses: ["render-qa", "agent"],
    },
    ...overrides,
  };
}

test("Generation Task intent normalization is canonical and hashes domain identity", () => {
  const normalized = normalizeGenerationTaskIntent(taskIntent());
  assert.deepEqual(normalized.dependencyIds, ["task-component-card", "task-resource-copy"]);
  assert.deepEqual(normalized.capabilities, ["browser", "visual-qa"]);
  assert.deepEqual(normalized.qaProfile.requiredFrameIds, ["desktop", "mobile"]);
  assert.deepEqual(normalized.qaProfile.blockingSeverities, ["P0", "P1"]);
  assert.deepEqual(normalized.resourceLimits.capacityClasses, ["agent", "render-qa"]);
  assert.deepEqual(Object.keys(normalized.payload), ["a", "nested", "z"]);
  assert.match(normalized.intentHash, /^[a-f0-9]{64}$/);
  assert.match(normalized.idempotencyKey, /^generation-task:[a-f0-9]{64}$/);
  assert.equal(normalized.intentHash, generationTaskIntentHash(normalized));

  const reordered = normalizeGenerationTaskIntent(taskIntent({
    dependencyIds: ["task-resource-copy", "task-component-card"],
    capabilities: ["browser", "visual-qa"],
    payload: { a: 2, nested: { alpha: "first", beta: true }, z: 1 },
    qaProfile: {
      requiredFrameIds: ["desktop", "mobile"],
      blockingSeverities: ["P0", "P1"],
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
    resourceLimits: {
      timeoutMs: 120_000,
      maxAgentTurns: 8,
      maxRepairRounds: 2,
      maxOutputBytes: 8_000_000,
      capacityClasses: ["agent", "render-qa"],
    },
  }));
  assert.deepEqual(reordered, normalized);
});

test("Generation Task intent rejects a Workspace target that aliases another Workspace", () => {
  assert.throws(() => normalizeGenerationTaskIntent(taskIntent({
    kind: "checkpoint",
    target: { type: "workspace", workspaceId: "workspace-1", id: "workspace-2" },
  })), /Workspace target id must match/);
});

test("Generation Task row codec verifies normalized dependencies and immutable hashes", () => {
  const intent = normalizeGenerationTaskIntent(taskIntent());
  const row = {
    id: intent.id,
    ordinal: intent.ordinal,
    workspace_id: intent.workspaceId,
    plan_id: intent.planId,
    kind: intent.kind,
    target_type: intent.target.type,
    target_id: intent.target.id,
    target_artifact_id: intent.target.id,
    target_track_id: intent.target.type === "artifact" ? intent.target.trackId : null,
    target_resource_id: null,
    payload_json: JSON.stringify(intent.payload),
    intent_hash: intent.intentHash,
    capabilities_json: JSON.stringify(intent.capabilities),
    qa_profile_json: JSON.stringify({
      blockingSeverities: intent.qaProfile.blockingSeverities,
      requireRuntimeChecks: intent.qaProfile.requireRuntimeChecks,
      requireVisualReview: intent.qaProfile.requireVisualReview,
      requiredFrameIds: intent.qaProfile.requiredFrameIds,
    }),
    resource_limits_json: JSON.stringify({
      capacityClasses: intent.resourceLimits.capacityClasses,
      maxAgentTurns: intent.resourceLimits.maxAgentTurns,
      maxOutputBytes: intent.resourceLimits.maxOutputBytes,
      maxRepairRounds: intent.resourceLimits.maxRepairRounds,
      timeoutMs: intent.resourceLimits.timeoutMs,
    }),
    idempotency_key: intent.idempotencyKey,
    status: "materialization-pending",
    blocked_reason: null,
    blocked_by_task_id: null,
    pending_context_policy: null,
    current_attempt: 0,
    materialization_failures: 0,
    failure_class: null,
    error_json: null,
    next_eligible_at: null,
    result_revision_id: null,
    result_resource_revision_id: null,
    result_snapshot_id: null,
    created_at: 100,
    finished_at: null,
  };
  const dependencyRows = intent.dependencyIds.map((dependencyTaskId, ordinal) => ({
    plan_id: intent.planId,
    workspace_id: intent.workspaceId,
    task_id: intent.id,
    dependency_task_id: dependencyTaskId,
    ordinal,
  }));

  const task = asGenerationTask(row, dependencyRows);
  assert.equal(task.intentHash, intent.intentHash);
  assert.deepEqual(task.dependencyIds, intent.dependencyIds);
  assert.equal(task.status, "materialization-pending");
  assert.throws(
    () => asGenerationTask({ ...row, intent_hash: "0".repeat(64) }, dependencyRows),
    /intent hash does not match/,
  );
  assert.throws(
    () => asGenerationTask(row, dependencyRows.map((dependency) => ({ ...dependency, ordinal: 1 }))),
    /canonical ordinals/,
  );
});

test("Generation Task Attempt lease fences require the exact immutable tuple", () => {
  const lease = normalizeGenerationTaskAttemptLease({
    taskId: "task-page-home",
    workspaceId: "workspace-1",
    attempt: 2,
    ownerId: "scheduler-1",
    leaseToken: "opaque-token-2",
  });
  assert.deepEqual(lease, {
    taskId: "task-page-home",
    workspaceId: "workspace-1",
    attempt: 2,
    ownerId: "scheduler-1",
    leaseToken: "opaque-token-2",
  });
  assert.throws(() => normalizeGenerationTaskAttemptLease({
    ...lease,
    leaseExpiresAt: 123,
  }), /unsupported field leaseExpiresAt/);
  assert.throws(() => normalizeGenerationTaskAttemptLease({
    taskId: lease.taskId,
    workspaceId: lease.workspaceId,
    attempt: lease.attempt,
    ownerId: lease.ownerId,
  }), /lease token/);
});

test("Generation Task Attempt input canonicalizes exact dependency outputs, Resource pins, and Component pins", () => {
  const normalized = normalizeGenerationTaskAttemptInput(attemptInput());

  assert.deepEqual(normalized.dependencyOutputs, [
    {
      ordinal: 0,
      taskId: "task-component-z",
      resultRevisionId: "component-revision-z",
      resultResourceRevisionId: null,
      resultSnapshotId: null,
    },
    {
      ordinal: 1,
      taskId: "task-resource-z",
      resultRevisionId: null,
      resultResourceRevisionId: "resource-revision-z",
      resultSnapshotId: null,
    },
    {
      ordinal: 2,
      taskId: "task-validation-z",
      resultRevisionId: null,
      resultResourceRevisionId: null,
      resultSnapshotId: "snapshot-validation-z",
    },
  ]);
  assert.deepEqual(normalized.resourcePins, [
    { ordinal: 0, resourceId: "resource-a", revisionId: "resource-revision-a", sourceTaskId: null },
    { ordinal: 1, resourceId: "resource-z", revisionId: "resource-revision-z", sourceTaskId: "task-resource-z" },
  ]);
  assert.equal(normalized.componentPins[0]?.instanceId, "instance-a");
  assert.equal(normalized.componentPins[0]?.ordinal, 0);
  assert.equal(normalized.componentPins[0]?.designNodeId, "node-a");
  assert.equal(normalized.componentPins[1]?.instanceId, "instance-z");
  assert.equal(normalized.componentPins[1]?.ordinal, 1);
  assert.deepEqual(Object.keys(normalized.componentPins[1]?.overrides ?? {}), ["a", "b"]);
  assert.match(normalized.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(normalized.inputHash, generationTaskAttemptInputHash(normalized));
  assert.notEqual(
    normalized.inputHash,
    normalizeGenerationTaskAttemptInput(attemptInput({ planId: "plan-2" })).inputHash,
  );
  assert.notEqual(
    normalized.inputHash,
    normalizeGenerationTaskAttemptInput(attemptInput({
      dependencyOutputs: [
        {
          taskId: "task-component-z",
          resultRevisionId: "component-revision-rebased",
          resultResourceRevisionId: null,
          resultSnapshotId: null,
        },
      ],
    })).inputHash,
  );
  const revisionAndSnapshot = normalizeGenerationTaskAttemptInput(attemptInput({
    dependencyOutputs: [
      {
        taskId: "task-artifact-with-snapshot",
        resultRevisionId: "artifact-revision",
        resultResourceRevisionId: null,
        resultSnapshotId: "artifact-result-snapshot",
      },
      {
        taskId: "task-resource-with-snapshot",
        resultRevisionId: null,
        resultResourceRevisionId: "resource-revision",
        resultSnapshotId: "resource-result-snapshot",
      },
    ],
  }));
  assert.deepEqual(revisionAndSnapshot.dependencyOutputs, [
    {
      ordinal: 0,
      taskId: "task-artifact-with-snapshot",
      resultRevisionId: "artifact-revision",
      resultResourceRevisionId: null,
      resultSnapshotId: "artifact-result-snapshot",
    },
    {
      ordinal: 1,
      taskId: "task-resource-with-snapshot",
      resultRevisionId: null,
      resultResourceRevisionId: "resource-revision",
      resultSnapshotId: "resource-result-snapshot",
    },
  ]);
  assert.throws(() => normalizeGenerationTaskAttemptInput(attemptInput({
    dependencyOutputs: [
      {
        taskId: "task-duplicate",
        resultRevisionId: null,
        resultResourceRevisionId: null,
        resultSnapshotId: null,
      },
      {
        taskId: "task-duplicate",
        resultRevisionId: null,
        resultResourceRevisionId: null,
        resultSnapshotId: null,
      },
    ],
  })), /unique Task ids/i);
});

function durableAttemptFixture() {
  const input = normalizeGenerationTaskAttemptInput(attemptInput());
  const candidateEvidence = { checks: { build: true, visual: true }, score: 0.98 };
  const candidateRevisionId = "candidate-revision-home-2";
  const candidateEvidenceHash = generationTaskCandidateEvidenceHash({
    taskId: input.taskId,
    planId: input.planId,
    workspaceId: input.workspaceId,
    attempt: input.attempt,
    candidateRevisionId,
    candidateResourceRevisionId: null,
    candidateEvidence,
  });
  const row = {
    task_id: input.taskId,
    plan_id: input.planId,
    workspace_id: input.workspaceId,
    attempt: input.attempt,
    target_artifact_id: input.target.type === "artifact" ? input.target.id : null,
    target_track_id: input.target.type === "artifact" ? input.target.trackId : null,
    target_resource_id: null,
    base_revision_id: input.baseRevisionId,
    expected_snapshot_id: input.expectedSnapshotId,
    context_pack_id: input.contextPackId,
    kernel_revision_id: input.kernelRevisionId,
    materialization_sealed: 1,
    execution_mode: input.executionMode,
    payload_json: JSON.stringify(input.payload),
    input_hash: input.inputHash,
    pinned_resource_revision_ids_json: JSON.stringify(input.resourcePins.map((pin) => pin.revisionId)),
    component_dependency_revision_ids_json: JSON.stringify(input.componentPins.map((pin) => pin.revisionId)),
    retry_context_policy: input.retryContextPolicy,
    status: "candidate-ready",
    blocked_reason: null,
    failure_class: null,
    error_json: null,
    next_eligible_at: null,
    candidate_revision_id: candidateRevisionId,
    candidate_resource_revision_id: null,
    candidate_evidence_json: JSON.stringify(candidateEvidence),
    candidate_evidence_hash: candidateEvidenceHash,
    owner_id: "scheduler-1",
    lease_token: "lease-token-1",
    lease_expires_at: 1_000,
    heartbeat_at: 120,
    created_at: 100,
    started_at: 110,
    finished_at: null,
  };
  const dependencyOutputRows = input.dependencyOutputs.map((output) => ({
    task_id: input.taskId,
    plan_id: input.planId,
    attempt: input.attempt,
    workspace_id: input.workspaceId,
    ordinal: output.ordinal,
    dependency_task_id: output.taskId,
    result_revision_id: output.resultRevisionId,
    result_resource_revision_id: output.resultResourceRevisionId,
    result_snapshot_id: output.resultSnapshotId,
  }));
  const resourcePinRows = input.resourcePins.map((pin) => ({
    task_id: input.taskId,
    plan_id: input.planId,
    attempt: input.attempt,
    workspace_id: input.workspaceId,
    ordinal: pin.ordinal,
    resource_id: pin.resourceId,
    revision_id: pin.revisionId,
    source_task_id: pin.sourceTaskId,
  }));
  const componentPinRows = input.componentPins.map((pin) => ({
    task_id: input.taskId,
    plan_id: input.planId,
    attempt: input.attempt,
    workspace_id: input.workspaceId,
    ordinal: pin.ordinal,
    instance_id: pin.instanceId,
    owner_artifact_id: pin.ownerArtifactId,
    component_artifact_id: pin.componentArtifactId,
    revision_id: pin.revisionId,
    source_task_id: pin.sourceTaskId,
    variant_key: pin.variantKey,
    state_key: pin.stateKey,
    design_node_id: pin.designNodeId,
    source_locator_json: JSON.stringify(pin.sourceLocator),
    overrides_json: JSON.stringify(pin.overrides),
    status: pin.status,
  }));
  return {
    input,
    candidateEvidence,
    candidateEvidenceHash,
    row,
    dependencyOutputRows,
    resourcePinRows,
    componentPinRows,
  };
}

test("Generation Task Attempt row codec reconstructs immutable input, pins, candidate evidence, and leases", () => {
  const fixture = durableAttemptFixture();
  const attempt = asGenerationTaskAttempt(
    fixture.row,
    fixture.dependencyOutputRows,
    fixture.resourcePinRows,
    fixture.componentPinRows,
  );
  assert.equal(attempt.planId, fixture.input.planId);
  assert.equal(attempt.inputHash, fixture.input.inputHash);
  assert.deepEqual(attempt.dependencyOutputs, fixture.input.dependencyOutputs);
  assert.deepEqual(attempt.resourcePins, fixture.input.resourcePins);
  assert.deepEqual(attempt.componentPins, fixture.input.componentPins);
  assert.deepEqual(attempt.candidateEvidence, fixture.candidateEvidence);
  assert.equal(attempt.candidateEvidenceHash, fixture.candidateEvidenceHash);
  assert.deepEqual(attempt.lease, {
    taskId: fixture.input.taskId,
    workspaceId: fixture.input.workspaceId,
    attempt: fixture.input.attempt,
    ownerId: "scheduler-1",
    leaseToken: "lease-token-1",
  });

  const running = asGenerationTaskAttempt({
    ...fixture.row,
    status: "running",
    candidate_revision_id: null,
    candidate_evidence_json: null,
    candidate_evidence_hash: null,
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows);
  assert.deepEqual(running.lease, {
    taskId: fixture.input.taskId,
    workspaceId: fixture.input.workspaceId,
    attempt: fixture.input.attempt,
    ownerId: "scheduler-1",
    leaseToken: "lease-token-1",
  });
  assert.equal(running.leaseExpiresAt, 1_000);
  assert.equal(running.heartbeatAt, 120);
});

test("Generation Task Attempt row codec fails closed on corrupted durable boundaries", () => {
  const fixture = durableAttemptFixture();
  assert.throws(() => asGenerationTaskAttempt(
    fixture.row,
    fixture.dependencyOutputRows.map((output) => ({ ...output, ordinal: 1 })),
    fixture.resourcePinRows,
    fixture.componentPinRows,
  ), /Dependency outputs must have contiguous ordinals/);
  assert.throws(() => asGenerationTaskAttempt(
    fixture.row,
    fixture.dependencyOutputRows,
    fixture.resourcePinRows.map((pin) => ({ ...pin, ordinal: 1 })),
    fixture.componentPinRows,
  ), /Resource pins must have contiguous ordinals/);
  assert.throws(() => asGenerationTaskAttempt(
    fixture.row,
    fixture.dependencyOutputRows,
    fixture.resourcePinRows,
    fixture.componentPinRows.map((pin) => ({ ...pin, plan_id: "plan-foreign" })),
  ), /ownership does not match/);
  assert.throws(() => asGenerationTaskAttempt({
    ...fixture.row,
    pinned_resource_revision_ids_json: "[]",
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows), /Resource revision summary/);
  assert.throws(() => asGenerationTaskAttempt({
    ...fixture.row,
    payload_json: "{\"operation\": \"revise\"}",
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows), /canonical JSON encoding/);
  assert.throws(() => asGenerationTaskAttempt({
    ...fixture.row,
    input_hash: "0".repeat(64),
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows), /input hash does not match/);
  assert.throws(() => asGenerationTaskAttempt({
    ...fixture.row,
    candidate_evidence_hash: "0".repeat(64),
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows), /candidate evidence hash does not match/);
  assert.throws(() => asGenerationTaskAttempt({
    ...fixture.row,
    lease_token: null,
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows), /lease columns are inconsistent/);
  assert.throws(() => asGenerationTaskAttempt({
    ...fixture.row,
    status: "invented",
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows), /status is unsupported/);
  assert.throws(() => asGenerationTaskAttempt({
    ...fixture.row,
    materialization_sealed: 0,
  }, fixture.dependencyOutputRows, fixture.resourcePinRows, fixture.componentPinRows), /materialization must be sealed/i);
});

test("Generation Plan event codecs enforce the exhaustive task/plan event boundary", () => {
  assert.deepEqual(normalizeListGenerationPlanEventsInput({ after: 4, limit: 100 }), { after: 4, limit: 100 });
  const event = asGenerationPlanEvent({
    plan_id: "plan-1",
    workspace_id: "workspace-1",
    sequence: 5,
    task_id: "task-page-home",
    type: "task-running",
    payload_json: "{\"attempt\":1}",
    created_at: 200,
  });
  assert.deepEqual(event, {
    planId: "plan-1",
    sequence: 5,
    taskId: "task-page-home",
    type: "task-running",
    payload: { attempt: 1 },
    createdAt: 200,
  });
  assert.throws(() => asGenerationPlanEvent({
    plan_id: "plan-1",
    workspace_id: "workspace-1",
    sequence: 6,
    task_id: "task-page-home",
    type: "plan-failed",
    payload_json: "{}",
    created_at: 201,
  }), /Plan events cannot name a Task/);
});
