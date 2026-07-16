import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationTaskAttemptClaim } from "../../../packages/core/src/index.ts";
import {
  GenerationTaskPublication,
  type GenerationTaskPublicationStorePort,
} from "../src/orchestration/task-publication.ts";
import type {
  ArtifactPreparedCandidate,
  GenerationTaskExecutionFailure,
  PrototypeValidationResult,
  ResourcePreparedCandidate,
} from "../src/orchestration/generation-task-executor.ts";

function claimFixture(): GenerationTaskAttemptClaim {
  return {
    task: {
      id: "task-page-home",
      planId: "plan-1",
      workspaceId: "workspace-1",
    },
    attempt: {
      taskId: "task-page-home",
      planId: "plan-1",
      workspaceId: "workspace-1",
      attempt: 2,
    },
    lease: {
      taskId: "task-page-home",
      workspaceId: "workspace-1",
      attempt: 2,
      ownerId: "daemon-owner",
      leaseToken: "lease-token",
    },
    claims: [],
  } as unknown as GenerationTaskAttemptClaim;
}

function artifactResult(): ArtifactPreparedCandidate {
  return {
    kind: "artifact-candidate",
    taskId: "task-page-home",
    workspaceId: "workspace-1",
    artifactId: "artifact-home",
    trackId: "track-main",
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    renderSpec: { frames: [{ id: "desktop" }] },
    quality: { state: "passed" },
    evidence: { protocol: "artifact-qa-v1" },
  };
}

function resourceResult(): ResourcePreparedCandidate {
  return {
    kind: "resource-candidate",
    taskId: "task-resource-copy",
    workspaceId: "workspace-1",
    resourceId: "resource-copy",
    revision: {
      revisionId: "resource-revision-copy",
      parentRevisionId: null,
      manifestPath: "resource-revisions/copy/manifest.json",
      summary: "Prepared copy research",
      metadata: { adapter: "research" },
      checksum: "c".repeat(64),
      provenance: { source: "research-adapter" },
      createdByRunId: null,
    },
    evidence: { protocol: "resource-adapter-v1" },
  };
}

function validationResult(): PrototypeValidationResult {
  return {
    kind: "snapshot-validation",
    taskId: "task-prototype-validation",
    workspaceId: "workspace-1",
    snapshotId: "snapshot-validated",
    graphRevision: 7,
    artifactRevisionIds: ["artifact-revision-home"],
    resourceRevisionIds: ["resource-revision-copy"],
    evidence: { protocol: "dezin-prototype-validation-v1" },
  };
}

function recordingStore(calls: Array<{ name: string; args: unknown[] }>): GenerationTaskPublicationStorePort {
  return {
    stageGenerationTaskCandidateForProject(...args) {
      calls.push({ name: "stage", args });
      return {} as never;
    },
    publishGenerationTaskCandidateForProject(...args) {
      calls.push({ name: "publish", args });
      return {} as never;
    },
    completeGenerationTaskValidationForProject(...args) {
      calls.push({ name: "validation", args });
      return {} as never;
    },
    publishGenerationPlanCheckpointForProject(...args) {
      calls.push({ name: "checkpoint", args });
      return {} as never;
    },
    finishGenerationTaskAttemptForProject(...args) {
      calls.push({ name: "failure", args });
      return {} as never;
    },
  };
}

test("GenerationTaskPublication stages then publishes an exact Artifact result", async () => {
  const claim = claimFixture();
  const result = artifactResult();
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const notifications: string[] = [];
  const options = {
    store: recordingStore(calls),
    projectIdForWorkspace: (workspaceId: string) => {
      assert.equal(workspaceId, "workspace-1");
      return "project-1";
    },
    notifyPlan: (planId: string) => notifications.push(planId),
  };
  const publication = new GenerationTaskPublication(options);
  options.store = recordingStore([]);

  await publication.publishPreparedResult(claim, result, new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.name), ["stage", "publish"]);
  assert.deepEqual(calls[0]?.args, ["project-1", "plan-1", {
    lease: claim.lease,
    candidate: {
      kind: "artifact",
      sourceCommitHash: result.sourceCommitHash,
      sourceTreeHash: result.sourceTreeHash,
      renderSpec: result.renderSpec,
      quality: result.quality,
    },
    evidence: result.evidence,
  }]);
  assert.deepEqual(calls[1]?.args, ["project-1", "plan-1", { lease: claim.lease }]);
  assert.deepEqual(notifications, ["plan-1", "plan-1"]);
});

test("GenerationTaskPublication routes Resource and validation results without leaking wrapper fields", async () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const publication = new GenerationTaskPublication({
    store: recordingStore(calls),
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });
  const resourceClaim = {
    ...claimFixture(),
    task: { ...claimFixture().task, id: "task-resource-copy" },
    lease: { ...claimFixture().lease, taskId: "task-resource-copy" },
  };
  const resource = resourceResult();
  await publication.publishPreparedResult(
    resourceClaim,
    resource,
    new AbortController().signal,
  );
  const validationClaim = {
    ...claimFixture(),
    task: { ...claimFixture().task, id: "task-prototype-validation" },
    lease: { ...claimFixture().lease, taskId: "task-prototype-validation" },
  };
  const validation = validationResult();
  await publication.publishPreparedResult(
    validationClaim,
    validation,
    new AbortController().signal,
  );

  assert.deepEqual(calls.map((call) => call.name), ["stage", "publish", "validation"]);
  assert.deepEqual(calls[0]?.args, ["project-1", "plan-1", {
    lease: resourceClaim.lease,
    candidate: {
      kind: "resource",
      resourceId: resource.resourceId,
      revision: resource.revision,
    },
    evidence: resource.evidence,
  }]);
  assert.deepEqual(calls[2]?.args, ["project-1", "plan-1", {
    lease: validationClaim.lease,
    validation: {
      snapshotId: validation.snapshotId,
      graphRevision: validation.graphRevision,
      artifactRevisionIds: validation.artifactRevisionIds,
      resourceRevisionIds: validation.resourceRevisionIds,
      evidence: validation.evidence,
    },
  }]);
});

test("GenerationTaskPublication preserves candidate-ready state when aborted after staging", async () => {
  const claim = claimFixture();
  const controller = new AbortController();
  const calls: string[] = [];
  const store = recordingStore([]);
  store.stageGenerationTaskCandidateForProject = () => {
    calls.push("stage");
    controller.abort(new Error("stop after durable staging"));
    return {} as never;
  };
  store.publishGenerationTaskCandidateForProject = () => {
    calls.push("publish");
    return {} as never;
  };
  const publication = new GenerationTaskPublication({
    store,
    projectIdForWorkspace: () => "project-1",
    notifyPlan: () => calls.push("notify"),
  });

  await assert.rejects(
    () => publication.publishPreparedResult(claim, artifactResult(), controller.signal),
    /stop after durable staging/i,
  );
  assert.deepEqual(calls, ["stage", "notify"]);
});

test("GenerationTaskPublication routes publication-only, checkpoint, and failure terminal writes", async () => {
  const claim = claimFixture();
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const publication = new GenerationTaskPublication({
    store: recordingStore(calls),
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {
      throw new Error("best-effort listener unavailable");
    },
  });
  const failure: GenerationTaskExecutionFailure = {
    failureClass: "qa",
    error: { code: "visual-regression" },
  };

  await publication.publishRecordedCandidate(claim, new AbortController().signal);
  await publication.publishCheckpoint(claim, new AbortController().signal);
  await publication.finishFailure(claim, failure);

  assert.deepEqual(calls.map((call) => call.name), ["publish", "checkpoint", "failure"]);
  assert.deepEqual(calls[2]?.args, ["project-1", "plan-1", {
    lease: claim.lease,
    failure,
  }]);
});

test("GenerationTaskPublication never performs a second write after a Store error", async () => {
  const claim = claimFixture();
  let publishes = 0;
  let failures = 0;
  const store = recordingStore([]);
  store.stageGenerationTaskCandidateForProject = () => {
    throw new Error("stage transaction failed");
  };
  store.publishGenerationTaskCandidateForProject = () => {
    publishes += 1;
    return {} as never;
  };
  store.finishGenerationTaskAttemptForProject = () => {
    failures += 1;
    return {} as never;
  };
  const publication = new GenerationTaskPublication({
    store,
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });

  await assert.rejects(
    () => publication.publishPreparedResult(claim, artifactResult(), new AbortController().signal),
    /stage transaction failed/i,
  );
  assert.equal(publishes, 0);
  assert.equal(failures, 0);
});
