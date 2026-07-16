import assert from "node:assert/strict";
import test from "node:test";

import type {
  ArtifactRevisionRecord,
  GenerationTaskAttemptClaim,
} from "../../../packages/core/src/index.ts";
import type { ArtifactCandidateRetentionPort } from "../src/orchestration/artifact-candidate-retention.ts";
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
      kind: "page",
      target: { type: "artifact", workspaceId: "workspace-1", id: "artifact-home", trackId: "track-main" },
    },
    attempt: {
      taskId: "task-page-home",
      planId: "plan-1",
      workspaceId: "workspace-1",
      attempt: 2,
      executionMode: "full",
      candidateRevisionId: null,
      candidateEvidence: null,
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

function artifactRevision(): ArtifactRevisionRecord {
  return {
    id: "artifact-revision-home",
    workspaceId: "workspace-1",
    artifactId: "artifact-home",
    trackId: "track-main",
    sequence: 1,
    parentRevisionId: null,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    artifactRoot: ".",
    kernelRevisionId: "kernel-1",
    renderSpec: { frames: [{ id: "desktop" }] },
    quality: { state: "passed" },
    contextPackHash: "c".repeat(64),
    producedByRunId: null,
    legacyRunId: null,
    createdAt: 100,
  };
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
    getArtifactRevision(revisionId) {
      calls.push({ name: "get-artifact-revision", args: [revisionId] });
      return revisionId === artifactRevision().id ? artifactRevision() : null;
    },
    stageGenerationTaskCandidateForProject(...args) {
      calls.push({ name: "stage", args });
      const input = args[2];
      return input.candidate.kind === "artifact"
        ? { attempt: {} as never, artifactRevision: artifactRevision(), resourceRevision: null }
        : { attempt: {} as never, artifactRevision: null, resourceRevision: {} as never };
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

function recordingRetention(
  calls: Array<{ name: string; args: unknown[] }>,
): ArtifactCandidateRetentionPort {
  return {
    async promote(...args) {
      calls.push({ name: "promote", args });
    },
    async release(...args) {
      calls.push({ name: "release", args });
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
    artifactRetention: recordingRetention(calls),
    projectIdForWorkspace: (workspaceId: string) => {
      assert.equal(workspaceId, "workspace-1");
      return "project-1";
    },
    notifyPlan: (planId: string) => notifications.push(planId),
  };
  const publication = new GenerationTaskPublication(options);
  options.store = recordingStore([]);

  await publication.publishPreparedResult(claim, result, new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.name), ["stage", "promote", "release", "publish"]);
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
  assert.deepEqual(calls[3]?.args, ["project-1", "plan-1", { lease: claim.lease }]);
  assert.deepEqual(notifications, ["plan-1", "plan-1"]);
});

test("GenerationTaskPublication routes Resource and validation results without leaking wrapper fields", async () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const publication = new GenerationTaskPublication({
    store: recordingStore(calls),
    artifactRetention: recordingRetention(calls),
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
    return { attempt: {} as never, artifactRevision: artifactRevision(), resourceRevision: null };
  };
  store.publishGenerationTaskCandidateForProject = () => {
    calls.push("publish");
    return {} as never;
  };
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: recordingRetention([]),
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
    artifactRetention: recordingRetention(calls),
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {
      throw new Error("best-effort listener unavailable");
    },
  });
  const failure: GenerationTaskExecutionFailure = {
    failureClass: "qa",
    error: { code: "visual-regression" },
  };
  const publicationClaim = {
    ...claim,
    attempt: {
      ...claim.attempt,
      executionMode: "publication-only" as const,
      candidateRevisionId: artifactRevision().id,
      candidateEvidence: artifactResult().evidence,
    },
  };

  await publication.publishRecordedCandidate(publicationClaim, new AbortController().signal);
  await publication.publishCheckpoint(claim, new AbortController().signal);
  await publication.finishFailure(claim, failure);

  assert.deepEqual(calls.map((call) => call.name), [
    "get-artifact-revision",
    "promote",
    "release",
    "publish",
    "checkpoint",
    "failure",
  ]);
  assert.deepEqual(calls[5]?.args, ["project-1", "plan-1", {
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
    artifactRetention: recordingRetention([]),
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

test("Artifact publication releases the Attempt ref before an atomic Core publish can lose its response", async () => {
  const claim = claimFixture();
  const calls: string[] = [];
  const store = recordingStore([]);
  store.stageGenerationTaskCandidateForProject = () => {
    calls.push("stage");
    return { attempt: {} as never, artifactRevision: artifactRevision(), resourceRevision: null };
  };
  store.publishGenerationTaskCandidateForProject = () => {
    calls.push("publish-committed");
    throw new Error("response lost after commit");
  };
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: {
      async promote() { calls.push("promote"); },
      async release() { calls.push("release"); },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });

  await assert.rejects(
    publication.publishPreparedResult(claim, artifactResult(), new AbortController().signal),
    /response lost after commit/,
  );
  assert.deepEqual(calls, ["stage", "promote", "release", "publish-committed"]);
});

test("Artifact publication never enters Core when durable Attempt-ref release fails", async () => {
  const claim = claimFixture();
  const calls: string[] = [];
  const store = recordingStore([]);
  store.publishGenerationTaskCandidateForProject = () => {
    calls.push("publish");
    return {} as never;
  };
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: {
      async promote() { calls.push("promote"); },
      async release() {
        calls.push("release");
        throw new Error("ref release failed");
      },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });

  await assert.rejects(
    publication.publishPreparedResult(claim, artifactResult(), new AbortController().signal),
    /ref release failed/,
  );
  assert.deepEqual(calls, ["promote", "release"]);
});

test("publication-only response loss cannot strand its original Attempt ref", async () => {
  const claim = claimFixture();
  const calls: string[] = [];
  const store = recordingStore([]);
  store.publishGenerationTaskCandidateForProject = () => {
    calls.push("publish-committed");
    throw new Error("publication replay response lost");
  };
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: {
      async promote() { calls.push("promote"); },
      async release() { calls.push("release"); },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });
  const publicationClaim = {
    ...claim,
    attempt: {
      ...claim.attempt,
      executionMode: "publication-only" as const,
      candidateRevisionId: artifactRevision().id,
      candidateEvidence: artifactResult().evidence,
    },
  };

  await assert.rejects(
    publication.publishRecordedCandidate(publicationClaim, new AbortController().signal),
    /publication replay response lost/,
  );
  assert.deepEqual(calls, ["promote", "release", "publish-committed"]);
});
