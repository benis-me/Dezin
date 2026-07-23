import assert from "node:assert/strict";
import test from "node:test";

import type {
  ArtifactRevisionRecord,
  GenerationTaskAttemptClaim,
} from "../../../packages/core/src/index.ts";
import type { ArtifactCandidateRetentionPort } from "../src/orchestration/artifact-candidate-retention.ts";
import {
  artifactRevisionEvidenceRef,
  type ArtifactRevisionEvidenceBundleReceipt,
} from "../src/orchestration/artifact-candidate-transaction.ts";
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

function evidenceReceiptFixture(): ArtifactRevisionEvidenceBundleReceipt {
  return {
    ref: artifactRevisionEvidenceRef("workspace-1", "artifact-revision-home"),
    commitHash: "d".repeat(40),
    treeHash: "e".repeat(40),
    manifestSha256: "f".repeat(64),
    subject: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      revisionId: "artifact-revision-home",
      artifactId: "artifact-home",
      trackId: "track-main",
      candidate: { commitHash: "a".repeat(40), treeHash: "b".repeat(40) },
      contextPackHash: "c".repeat(64),
      attempt: {
        workspaceId: "workspace-1",
        taskId: "task-page-home",
        attempt: 2,
        inputHash: "1".repeat(64),
        createdAt: 100,
        sourceCommitHash: "2".repeat(40),
        sourceTreeHash: "3".repeat(40),
      },
      candidateEvidenceSha256: "4".repeat(64),
      entries: [],
    },
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
      return { status: "succeeded" } as never;
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
    async verify(...args) {
      calls.push({ name: "verify", args });
    },
    async verifyPublication(...args) {
      calls.push({ name: "verify-publication", args });
      return evidenceReceiptFixture();
    },
    async promote(...args) {
      calls.push({ name: "promote", args });
      return evidenceReceiptFixture();
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

  assert.deepEqual(calls.map((call) => call.name), [
    "verify", "stage", "promote", "release", "verify-publication", "publish",
  ]);
  assert.deepEqual(calls[1]?.args, ["project-1", "plan-1", {
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
  assert.deepEqual(calls[5]?.args, ["project-1", "plan-1", { lease: claim.lease }]);
  assert.deepEqual(notifications, ["plan-1", "plan-1"]);
});

test("post-publish mutable evidence cleanup is receipt-driven, ordered after notification, and best-effort", async () => {
  const order: string[] = [];
  const store = recordingStore([]);
  store.stageGenerationTaskCandidateForProject = () => {
    order.push("stage");
    return { attempt: {} as never, artifactRevision: artifactRevision(), resourceRevision: null };
  };
  store.publishGenerationTaskCandidateForProject = () => {
    order.push("publish");
    return { status: "succeeded" } as never;
  };
  const receipt = evidenceReceiptFixture();
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: {
      async verify() { order.push("verify"); },
      async promote() { order.push("promote"); return receipt; },
      async release(_input, exactReceipt) {
        assert.equal(exactReceipt, receipt);
        order.push("release");
      },
      async verifyPublication(_input, exactReceipt) {
        assert.equal(exactReceipt, receipt);
        order.push("verify-publication");
        return receipt;
      },
    },
    evidenceLifecycle: {
      async quarantineAttempt() {
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
      async quarantineDurablePublishedEvidence(input) {
        assert.equal(input.receipt, receipt);
        assert.deepEqual({
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          planId: input.planId,
          taskId: input.taskId,
          attempt: input.attempt,
        }, {
          projectId: "project-1",
          workspaceId: "workspace-1",
          planId: "plan-1",
          taskId: "task-page-home",
          attempt: 2,
        });
        order.push("cleanup");
        throw new Error("mutable cache is already absent");
      },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() { order.push("notify"); },
    reportEvidenceCleanupError(error) {
      assert.match(String(error), /already absent/);
      order.push("cleanup-reported");
    },
  });

  await publication.publishPreparedResult(
    claimFixture(),
    artifactResult(),
    new AbortController().signal,
  );

  assert.deepEqual(order, [
    "verify",
    "stage",
    "notify",
    "promote",
    "release",
    "verify-publication",
    "publish",
    "notify",
    "cleanup",
    "cleanup-reported",
  ]);
});

test("runtime-only publication treats a verified zero-PNG receipt as cleanup success", async () => {
  let cleanupCalls = 0;
  let cleanupErrors = 0;
  const receipt = evidenceReceiptFixture();
  const publication = new GenerationTaskPublication({
    store: recordingStore([]),
    artifactRetention: {
      async verify() {},
      async promote() { return receipt; },
      async release() {},
      async verifyPublication() { return receipt; },
    },
    evidenceLifecycle: {
      async quarantineAttempt() {
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
      async quarantineDurablePublishedEvidence(input) {
        assert.deepEqual(input.receipt.subject.entries, []);
        cleanupCalls += 1;
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
    reportEvidenceCleanupError() { cleanupErrors += 1; },
  });

  await publication.publishPreparedResult(
    claimFixture(),
    artifactResult(),
    new AbortController().signal,
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(cleanupErrors, 0);
});

test("full Artifact needs-rebase preserves mutable evidence for a publication-only successor", async () => {
  const claim = claimFixture();
  const receipt = evidenceReceiptFixture();
  const publicationOutcomes = ["needs-rebase", "succeeded"] as const;
  let publicationIndex = 0;
  let mutableEvidenceAvailable = true;
  let promoteCalls = 0;
  let cleanupCalls = 0;
  const store = recordingStore([]);
  store.publishGenerationTaskCandidateForProject = () => ({
    status: publicationOutcomes[publicationIndex++],
  }) as never;
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: {
      async verify() {
        assert.equal(mutableEvidenceAvailable, true);
      },
      async promote() {
        assert.equal(mutableEvidenceAvailable, true);
        promoteCalls += 1;
        return receipt;
      },
      async release() {},
      async verifyPublication() { return receipt; },
    },
    evidenceLifecycle: {
      async quarantineAttempt() {
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
      async quarantineDurablePublishedEvidence() {
        mutableEvidenceAvailable = false;
        cleanupCalls += 1;
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });

  await publication.publishPreparedResult(claim, artifactResult(), new AbortController().signal);

  assert.equal(mutableEvidenceAvailable, true);
  assert.equal(cleanupCalls, 0);
  await publication.publishRecordedCandidate({
    ...claim,
    attempt: {
      ...claim.attempt,
      executionMode: "publication-only",
      candidateRevisionId: artifactRevision().id,
      candidateEvidence: artifactResult().evidence,
    },
  }, new AbortController().signal);
  assert.equal(promoteCalls, 2);
  assert.equal(cleanupCalls, 1);
  assert.equal(mutableEvidenceAvailable, false);
});

test("publication-only Artifact needs-rebase preserves mutable evidence for the next publication retry", async () => {
  const claim = claimFixture();
  const publicationClaim = {
    ...claim,
    attempt: {
      ...claim.attempt,
      executionMode: "publication-only" as const,
      candidateRevisionId: artifactRevision().id,
      candidateEvidence: artifactResult().evidence,
    },
  };
  const receipt = evidenceReceiptFixture();
  const publicationOutcomes = ["needs-rebase", "succeeded"] as const;
  let publicationIndex = 0;
  let mutableEvidenceAvailable = true;
  let promoteCalls = 0;
  let cleanupCalls = 0;
  const store = recordingStore([]);
  store.publishGenerationTaskCandidateForProject = () => ({
    status: publicationOutcomes[publicationIndex++],
  }) as never;
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: {
      async verify() {},
      async promote() {
        assert.equal(mutableEvidenceAvailable, true);
        promoteCalls += 1;
        return receipt;
      },
      async release() {},
      async verifyPublication() { return receipt; },
    },
    evidenceLifecycle: {
      async quarantineAttempt() {
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
      async quarantineDurablePublishedEvidence() {
        mutableEvidenceAvailable = false;
        cleanupCalls += 1;
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });

  await publication.publishRecordedCandidate(publicationClaim, new AbortController().signal);

  assert.equal(mutableEvidenceAvailable, true);
  assert.equal(cleanupCalls, 0);
  await publication.publishRecordedCandidate(publicationClaim, new AbortController().signal);
  assert.equal(promoteCalls, 2);
  assert.equal(cleanupCalls, 1);
  assert.equal(mutableEvidenceAvailable, false);
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
    "verify-publication",
    "publish",
    "checkpoint",
    "failure",
  ]);
  assert.deepEqual(calls[6]?.args, ["project-1", "plan-1", {
    lease: claim.lease,
    failure,
  }]);
});

test("GenerationTaskPublication isolates unbound evidence only after the failure is durable", async () => {
  const claim = claimFixture();
  const order: string[] = [];
  const store = recordingStore([]);
  store.finishGenerationTaskAttemptForProject = () => {
    order.push("failure-durable");
    return {} as never;
  };
  const publication = new GenerationTaskPublication({
    store,
    artifactRetention: recordingRetention([]),
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
    evidenceLifecycle: {
      async quarantineDurablePublishedEvidence() {
        return { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 0 };
      },
      async quarantineAttempt(input, signal) {
        assert.equal(signal.aborted, false);
        assert.deepEqual(input, {
          projectId: "project-1",
          workspaceId: "workspace-1",
          planId: "plan-1",
          taskId: "task-page-home",
          attempt: 2,
        });
        order.push("evidence-quarantined");
        return { scanned: 1, retained: 0, quarantined: 1, restored: 0, removed: 0, failed: 0 };
      },
    },
  });

  await publication.finishFailure(claim, {
    failureClass: "qa",
    error: { code: "visual-regression" },
  });

  assert.deepEqual(order, ["failure-durable", "evidence-quarantined"]);
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
      async verify() { calls.push("verify"); },
      async verifyPublication() { calls.push("verify-publication"); return evidenceReceiptFixture(); },
      async promote() { calls.push("promote"); return evidenceReceiptFixture(); },
      async release() { calls.push("release"); },
    },
    projectIdForWorkspace: () => "project-1",
    notifyPlan() {},
  });

  await assert.rejects(
    publication.publishPreparedResult(claim, artifactResult(), new AbortController().signal),
    /response lost after commit/,
  );
  assert.deepEqual(calls, [
    "verify", "stage", "promote", "release", "verify-publication", "publish-committed",
  ]);
});

test("durable evidence rejection stops full and publication-only flows before release or Core publish", async (t) => {
  for (const mode of ["full", "publication-only"] as const) {
    await t.test(mode, async () => {
      const calls: Array<{ name: string; args: unknown[] }> = [];
      const publication = new GenerationTaskPublication({
        store: recordingStore(calls),
        artifactRetention: {
          async verify(...args) {
            calls.push({ name: "verify", args });
            throw new Error("durable PNG evidence unavailable");
          },
          async verifyPublication(...args) {
            calls.push({ name: "verify-publication", args });
            return evidenceReceiptFixture();
          },
          async promote(...args) {
            calls.push({ name: "promote", args });
            throw new Error("durable PNG evidence unavailable");
          },
          async release(...args) {
            calls.push({ name: "release", args });
          },
        },
        projectIdForWorkspace: () => "project-1",
        notifyPlan() {},
      });
      const claim = claimFixture();
      if (mode === "publication-only") {
        claim.attempt.executionMode = "publication-only";
        claim.attempt.candidateRevisionId = artifactRevision().id;
        claim.attempt.candidateEvidence = artifactResult().evidence;
      }

      await assert.rejects(
        mode === "full"
          ? publication.publishPreparedResult(
            claim,
            artifactResult(),
            new AbortController().signal,
          )
          : publication.publishRecordedCandidate(claim, new AbortController().signal),
        /durable PNG evidence unavailable/i,
      );
      assert.deepEqual(
        calls.map((call) => call.name),
        mode === "full" ? ["verify"] : ["get-artifact-revision", "promote"],
      );
    });
  }
});

test("evidence deleted by the ref-release hook is rechecked before either Core publish path", async (t) => {
  for (const mode of ["full", "publication-only"] as const) {
    await t.test(mode, async () => {
      const calls: string[] = [];
      let evidencePresent = true;
      const store = recordingStore([]);
      store.stageGenerationTaskCandidateForProject = () => {
        calls.push("stage");
        return { attempt: {} as never, artifactRevision: artifactRevision(), resourceRevision: null };
      };
      store.getArtifactRevision = () => {
        calls.push("get-artifact-revision");
        return artifactRevision();
      };
      store.publishGenerationTaskCandidateForProject = () => {
        calls.push("publish");
        return {} as never;
      };
      const publication = new GenerationTaskPublication({
        store,
        artifactRetention: {
          async verify() { calls.push("verify"); },
          async promote() { calls.push("promote"); return evidenceReceiptFixture(); },
          async release() {
            calls.push("release");
            evidencePresent = false;
          },
          async verifyPublication() {
            calls.push("verify-publication");
            if (!evidencePresent) throw new Error("PNG evidence deleted after ref release");
            return evidenceReceiptFixture();
          },
        },
        projectIdForWorkspace: () => "project-1",
        notifyPlan() {},
      });
      const exactClaim = claimFixture();
      if (mode === "publication-only") {
        exactClaim.attempt.executionMode = "publication-only";
        exactClaim.attempt.candidateRevisionId = artifactRevision().id;
        exactClaim.attempt.candidateEvidence = artifactResult().evidence;
      }

      await assert.rejects(
        mode === "full"
          ? publication.publishPreparedResult(
            exactClaim,
            artifactResult(),
            new AbortController().signal,
          )
          : publication.publishRecordedCandidate(exactClaim, new AbortController().signal),
        /deleted after ref release/i,
      );
      assert.deepEqual(calls, mode === "full"
        ? ["verify", "stage", "promote", "release", "verify-publication"]
        : ["get-artifact-revision", "promote", "release", "verify-publication"]);
      assert.equal(calls.includes("publish"), false);
    });
  }
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
      async verify() { calls.push("verify"); },
      async verifyPublication() { calls.push("verify-publication"); return evidenceReceiptFixture(); },
      async promote() { calls.push("promote"); return evidenceReceiptFixture(); },
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
  assert.deepEqual(calls, ["verify", "promote", "release"]);
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
      async verify() { calls.push("verify"); },
      async verifyPublication() { calls.push("verify-publication"); return evidenceReceiptFixture(); },
      async promote() { calls.push("promote"); return evidenceReceiptFixture(); },
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
  assert.deepEqual(calls, ["promote", "release", "verify-publication", "publish-committed"]);
});
