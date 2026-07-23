import type {
  AnyPublishGenerationTaskCandidateResult,
  AnyStageGenerationTaskCandidateInput,
  AnyStageGenerationTaskCandidateResult,
  ArtifactRevisionRecord,
  CompleteGenerationTaskValidationInput,
  CompleteGenerationTaskValidationResult,
  FinishGenerationTaskAttemptFailureInput,
  FinishGenerationTaskAttemptResult,
  GenerationTaskAttemptClaim,
  PublishGenerationPlanCheckpointInput,
  PublishGenerationPlanCheckpointResult,
  PublishGenerationTaskCandidateInput,
} from "../../../../packages/core/src/index.ts";
import type {
  GenerationTaskExecutionFailure,
  GenerationTaskPublicationPort,
  PreparedGenerationTaskResult,
} from "./generation-task-executor.ts";
import type { ArtifactCandidateRetentionPort } from "./artifact-candidate-retention.ts";
import type { ArtifactRevisionEvidenceBundleReceipt } from "./artifact-candidate-transaction.ts";
import type {
  GenerationTaskEvidenceLifecycle,
} from "./generation-task-evidence-lifecycle.ts";

export interface GenerationTaskPublicationStorePort {
  getArtifactRevision(revisionId: string): ArtifactRevisionRecord | null;
  stageGenerationTaskCandidateForProject(
    projectId: string,
    planId: string,
    input: AnyStageGenerationTaskCandidateInput,
  ): AnyStageGenerationTaskCandidateResult;
  publishGenerationTaskCandidateForProject(
    projectId: string,
    planId: string,
    input: PublishGenerationTaskCandidateInput,
  ): AnyPublishGenerationTaskCandidateResult;
  completeGenerationTaskValidationForProject(
    projectId: string,
    planId: string,
    input: CompleteGenerationTaskValidationInput,
  ): CompleteGenerationTaskValidationResult;
  publishGenerationPlanCheckpointForProject(
    projectId: string,
    planId: string,
    input: PublishGenerationPlanCheckpointInput,
  ): PublishGenerationPlanCheckpointResult;
  finishGenerationTaskAttemptForProject(
    projectId: string,
    planId: string,
    input: FinishGenerationTaskAttemptFailureInput,
  ): FinishGenerationTaskAttemptResult;
}

export interface GenerationTaskPublicationOptions {
  readonly store: GenerationTaskPublicationStorePort;
  readonly artifactRetention: ArtifactCandidateRetentionPort;
  readonly projectIdForWorkspace: (workspaceId: string) => string;
  /** Best-effort wake-up only; durable Plan events remain the source of truth. */
  readonly notifyPlan: (planId: string) => void;
  /** Two-stage cleanup for visual evidence that never acquired a candidate owner. */
  readonly evidenceLifecycle?: Pick<
    GenerationTaskEvidenceLifecycle,
    "quarantineAttempt" | "quarantineDurablePublishedEvidence"
  >;
  /** Observability only; post-commit cache cleanup can never roll back publication. */
  readonly reportEvidenceCleanupError?: (error: unknown) => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Generation Task publication aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported prepared Generation Task result: ${String(value)}`);
}

/**
 * The only daemon adapter allowed to turn a prepared leaf result into durable
 * Generation Task state. Each Core call is already atomic and replay-fenced;
 * this adapter deliberately never translates a publication error into a second
 * failure write because the first transaction may have committed before its
 * response was lost.
 */
export class GenerationTaskPublication implements GenerationTaskPublicationPort {
  private readonly store: GenerationTaskPublicationStorePort;
  private readonly artifactRetention: ArtifactCandidateRetentionPort;
  private readonly projectIdForWorkspace: (workspaceId: string) => string;
  private readonly notifyPlan: (planId: string) => void;
  private readonly evidenceLifecycle: GenerationTaskPublicationOptions["evidenceLifecycle"];
  private readonly reportEvidenceCleanupError: NonNullable<
    GenerationTaskPublicationOptions["reportEvidenceCleanupError"]
  >;

  constructor(options: GenerationTaskPublicationOptions) {
    this.store = options.store;
    this.artifactRetention = options.artifactRetention;
    this.projectIdForWorkspace = options.projectIdForWorkspace;
    this.notifyPlan = options.notifyPlan;
    this.evidenceLifecycle = options.evidenceLifecycle;
    this.reportEvidenceCleanupError = options.reportEvidenceCleanupError ?? (() => {});
  }

  async publishPreparedResult(
    claim: GenerationTaskAttemptClaim,
    result: PreparedGenerationTaskResult,
    signal: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const projectId = this.projectIdForWorkspace(claim.task.workspaceId);
    switch (result.kind) {
      case "artifact-candidate":
        {
          await this.artifactRetention.verify({
            claim,
            candidate: {
              workspaceId: result.workspaceId,
              artifactId: result.artifactId,
              trackId: result.trackId,
              sourceCommitHash: result.sourceCommitHash,
              sourceTreeHash: result.sourceTreeHash,
              quality: result.quality,
            },
            evidence: result.evidence,
          }, signal);
          checkAbort(signal);
          const staged = this.store.stageGenerationTaskCandidateForProject(projectId, claim.task.planId, {
            lease: claim.lease,
            candidate: {
              kind: "artifact",
              sourceCommitHash: result.sourceCommitHash,
              sourceTreeHash: result.sourceTreeHash,
              renderSpec: result.renderSpec,
              quality: result.quality,
            },
            evidence: result.evidence,
          });
          if (staged.artifactRevision === null || staged.resourceRevision !== null) {
            throw new TypeError("Artifact Task staging returned a non-Artifact Revision");
          }
          this.notifyBestEffort(claim.task.planId);
          checkAbort(signal);
          const retentionInput = {
            claim,
            artifactRevision: staged.artifactRevision,
            evidence: result.evidence,
          };
          const receipt = await this.artifactRetention.promote(retentionInput, signal);
          checkAbort(signal);
          await this.artifactRetention.release(retentionInput, receipt, signal);
          checkAbort(signal);
          const verifiedReceipt = await this.artifactRetention.verifyPublication(
            retentionInput,
            receipt,
            signal,
          );
          checkAbort(signal);
          const publication = this.store.publishGenerationTaskCandidateForProject(projectId, claim.task.planId, {
            lease: claim.lease,
          });
          this.notifyBestEffort(claim.task.planId);
          if (publication.status === "succeeded") {
            await this.cleanupPublishedEvidence(claim, verifiedReceipt);
          }
          return;
        }
      case "resource-candidate":
        this.store.stageGenerationTaskCandidateForProject(projectId, claim.task.planId, {
          lease: claim.lease,
          candidate: {
            kind: "resource",
            resourceId: result.resourceId,
            revision: result.revision,
          },
          evidence: result.evidence,
        });
        this.notifyBestEffort(claim.task.planId);
        checkAbort(signal);
        this.store.publishGenerationTaskCandidateForProject(projectId, claim.task.planId, {
          lease: claim.lease,
        });
        this.notifyBestEffort(claim.task.planId);
        return;
      case "snapshot-validation":
        this.store.completeGenerationTaskValidationForProject(projectId, claim.task.planId, {
          lease: claim.lease,
          validation: {
            snapshotId: result.snapshotId,
            graphRevision: result.graphRevision,
            artifactRevisionIds: result.artifactRevisionIds,
            resourceRevisionIds: result.resourceRevisionIds,
            evidence: result.evidence,
          },
        });
        this.notifyBestEffort(claim.task.planId);
        return;
      default:
        return assertNever(result);
    }
  }

  async publishRecordedCandidate(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const projectId = this.projectIdForWorkspace(claim.task.workspaceId);
    if (claim.task.target.type === "artifact") {
      const revisionId = claim.attempt.candidateRevisionId;
      const evidence = claim.attempt.candidateEvidence;
      if (revisionId === null || evidence === null) {
        throw new TypeError("Artifact publication retry has no recorded candidate");
      }
      const artifactRevision = this.store.getArtifactRevision(revisionId);
      if (artifactRevision === null) {
        throw new TypeError("Artifact publication retry candidate Revision is missing");
      }
      const retentionInput = { claim, artifactRevision, evidence };
      const receipt = await this.artifactRetention.promote(retentionInput, signal);
      checkAbort(signal);
      await this.artifactRetention.release(retentionInput, receipt, signal);
      checkAbort(signal);
      const verifiedReceipt = await this.artifactRetention.verifyPublication(
        retentionInput,
        receipt,
        signal,
      );
      checkAbort(signal);
      const publication = this.store.publishGenerationTaskCandidateForProject(projectId, claim.task.planId, {
        lease: claim.lease,
      });
      this.notifyBestEffort(claim.task.planId);
      if (publication.status === "succeeded") {
        await this.cleanupPublishedEvidence(claim, verifiedReceipt);
      }
      return;
    }
    this.store.publishGenerationTaskCandidateForProject(projectId, claim.task.planId, {
      lease: claim.lease,
    });
    this.notifyBestEffort(claim.task.planId);
  }

  async publishCheckpoint(
    claim: GenerationTaskAttemptClaim,
    signal: AbortSignal,
  ): Promise<void> {
    checkAbort(signal);
    const projectId = this.projectIdForWorkspace(claim.task.workspaceId);
    this.store.publishGenerationPlanCheckpointForProject(projectId, claim.task.planId, {
      lease: claim.lease,
    });
    this.notifyBestEffort(claim.task.planId);
  }

  async finishFailure(
    claim: GenerationTaskAttemptClaim,
    failure: GenerationTaskExecutionFailure,
  ): Promise<void> {
    const projectId = this.projectIdForWorkspace(claim.task.workspaceId);
    this.store.finishGenerationTaskAttemptForProject(projectId, claim.task.planId, {
      lease: claim.lease,
      failure: {
        failureClass: failure.failureClass,
        error: failure.error,
      },
    });
    this.notifyBestEffort(claim.task.planId);
    if ((claim.task.kind === "page" || claim.task.kind === "component")
      && this.evidenceLifecycle !== undefined) {
      await this.evidenceLifecycle.quarantineAttempt({
        projectId,
        workspaceId: claim.task.workspaceId,
        planId: claim.task.planId,
        taskId: claim.task.id,
        attempt: claim.attempt.attempt,
      }, new AbortController().signal);
    }
  }

  private notifyBestEffort(planId: string): void {
    try {
      this.notifyPlan(planId);
    } catch {
      // Durable events and polling preserve correctness when listeners fail.
    }
  }

  private async cleanupPublishedEvidence(
    claim: GenerationTaskAttemptClaim,
    receipt: ArtifactRevisionEvidenceBundleReceipt,
  ): Promise<void> {
    if (this.evidenceLifecycle === undefined) return;
    try {
      await this.evidenceLifecycle.quarantineDurablePublishedEvidence({
        projectId: receipt.subject.projectId,
        workspaceId: receipt.subject.workspaceId,
        planId: claim.task.planId,
        taskId: receipt.subject.attempt.taskId,
        attempt: receipt.subject.attempt.attempt,
        receipt,
      }, new AbortController().signal);
    } catch (error) {
      try {
        this.reportEvidenceCleanupError(error);
      } catch {
        // Publication already committed; observability cannot change its outcome.
      }
    }
  }
}
