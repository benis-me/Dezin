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

  constructor(options: GenerationTaskPublicationOptions) {
    this.store = options.store;
    this.artifactRetention = options.artifactRetention;
    this.projectIdForWorkspace = options.projectIdForWorkspace;
    this.notifyPlan = options.notifyPlan;
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
          await this.artifactRetention.promote({
            claim,
            artifactRevision: staged.artifactRevision,
            evidence: result.evidence,
          }, signal);
          checkAbort(signal);
          await this.artifactRetention.release({
            claim,
            artifactRevision: staged.artifactRevision,
            evidence: result.evidence,
          }, signal);
          checkAbort(signal);
          this.store.publishGenerationTaskCandidateForProject(projectId, claim.task.planId, {
            lease: claim.lease,
          });
          this.notifyBestEffort(claim.task.planId);
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
      await this.artifactRetention.promote({ claim, artifactRevision, evidence }, signal);
      checkAbort(signal);
      await this.artifactRetention.release({ claim, artifactRevision, evidence }, signal);
      checkAbort(signal);
      this.store.publishGenerationTaskCandidateForProject(projectId, claim.task.planId, {
        lease: claim.lease,
      });
      this.notifyBestEffort(claim.task.planId);
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
  }

  private notifyBestEffort(planId: string): void {
    try {
      this.notifyPlan(planId);
    } catch {
      // Durable events and polling preserve correctness when listeners fail.
    }
  }
}
