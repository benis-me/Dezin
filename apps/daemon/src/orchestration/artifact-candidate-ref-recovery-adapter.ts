import type {
  ArtifactCandidateRefRecoveryCursor as CoreArtifactCandidateRefRecoveryCursor,
  ArtifactCandidateRefRecoveryEntry as CoreArtifactCandidateRefRecoveryEntry,
  ArtifactCandidateRefRecoveryPage as CoreArtifactCandidateRefRecoveryPage,
} from "../../../../packages/core/src/index.ts";
import {
  artifactCandidateRetentionDescriptor,
  verifyRetainedArtifactRevisionEvidenceBundle,
} from "./artifact-candidate-retention.ts";
import {
  ArtifactCandidateRefConflictError,
  ArtifactCandidateRevisionRefNotRetainedError,
  ArtifactCandidateValidationError,
  artifactRevisionEvidenceRef,
  artifactRevisionHistoryRef,
  artifactRevisionRef,
  releaseArtifactCandidateAttemptRef,
  releaseOrphanArtifactCandidateAttemptRef,
  type ArtifactRevisionEvidenceBundleReceipt,
} from "./artifact-candidate-transaction.ts";
import {
  recoverArtifactCandidateRefs,
  type ArtifactCandidateRefRecoveryEvent,
  type ArtifactCandidateRefRecoverySummary,
} from "./artifact-candidate-ref-recovery.ts";
import type { GenerationTaskEvidenceLifecycle } from "./generation-task-evidence-lifecycle.ts";

export interface ArtifactCandidateEvidenceCleanupErrorIdentity {
  readonly taskId: string;
  readonly attempt: number;
  readonly revisionId: string;
}

export interface ArtifactCandidateRefRecoveryAdapterOptions {
  readonly store: {
    listArtifactCandidateRefRecoveryEntries(
      limit: number,
      cursor?: CoreArtifactCandidateRefRecoveryCursor | null,
    ): CoreArtifactCandidateRefRecoveryPage | Promise<CoreArtifactCandidateRefRecoveryPage>;
  };
  readonly repositoryDirForWorkspace: (workspaceId: string) => string | Promise<string>;
  readonly limit?: number;
  readonly observe?: (event: ArtifactCandidateRefRecoveryEvent) => void;
  readonly evidenceLifecycle?: Pick<
    GenerationTaskEvidenceLifecycle,
    "quarantineDurablePublishedEvidence"
  >;
  readonly reportEvidenceCleanupError?: (
    error: unknown,
    identity: ArtifactCandidateEvidenceCleanupErrorIdentity,
  ) => void;
}

export interface ArtifactCandidateRefRecovery {
  recover(signal: AbortSignal): Promise<ArtifactCandidateRefRecoverySummary>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact candidate ref recovery aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function repositoryDir(
  options: ArtifactCandidateRefRecoveryAdapterOptions,
  workspaceId: string,
  signal: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  const dir = await options.repositoryDirForWorkspace(workspaceId);
  checkAbort(signal);
  return dir;
}

async function cleanupPublishedEvidence(
  options: ArtifactCandidateRefRecoveryAdapterOptions,
  entry: Extract<CoreArtifactCandidateRefRecoveryEntry, { retentionKind: "retained-candidate" }>,
  receipt: ArtifactRevisionEvidenceBundleReceipt,
): Promise<void> {
  if (options.evidenceLifecycle === undefined || entry.attempt.status !== "succeeded") return;
  try {
    await options.evidenceLifecycle.quarantineDurablePublishedEvidence({
      projectId: receipt.subject.projectId,
      workspaceId: receipt.subject.workspaceId,
      planId: entry.task.planId,
      taskId: receipt.subject.attempt.taskId,
      attempt: receipt.subject.attempt.attempt,
      receipt,
    }, new AbortController().signal);
  } catch (error) {
    try {
      options.reportEvidenceCleanupError?.(error, {
        taskId: entry.task.id,
        attempt: entry.attempt.attempt,
        revisionId: entry.revision.id,
      });
    } catch {
      // The exact Core/Git publication proof is already durable; observation is best effort.
    }
  }
}

async function releaseRecoveryEntry(
  options: ArtifactCandidateRefRecoveryAdapterOptions,
  entry: CoreArtifactCandidateRefRecoveryEntry,
  signal: AbortSignal,
): Promise<
  | "released"
  | "already-released"
  | "revision-ref-missing"
  | "revision-ref-conflict"
  | "revision-history-ref-missing"
  | "revision-history-ref-conflict"
  | "revision-evidence-ref-missing"
  | "revision-evidence-ref-conflict"
> {
  const dir = await repositoryDir(options, entry.task.workspaceId, signal);
  if (entry.retentionKind === "orphan-attempt") {
    const released = await releaseOrphanArtifactCandidateAttemptRef({
      repositoryDir: dir,
      attempt: {
        workspaceId: entry.task.workspaceId,
        taskId: entry.task.id,
        attempt: entry.attempt.attempt,
        inputHash: entry.attempt.inputHash,
        createdAt: entry.attempt.createdAt,
        sourceCommitHash: entry.attempt.sourceCommitHash,
        sourceTreeHash: entry.attempt.sourceTreeHash,
      },
      signal,
    });
    checkAbort(signal);
    return released ? "released" : "already-released";
  }

  const descriptor = artifactCandidateRetentionDescriptor({
    task: entry.task,
    attempt: entry.attempt,
    artifactRevision: entry.revision,
    evidence: entry.attempt.candidateEvidence,
  });
  let evidenceReceipt: ArtifactRevisionEvidenceBundleReceipt;
  try {
    evidenceReceipt = await verifyRetainedArtifactRevisionEvidenceBundle({
      repositoryDir: dir,
      task: entry.task,
      attempt: entry.attempt,
      artifactRevision: entry.revision,
      evidence: entry.attempt.candidateEvidence,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof ArtifactCandidateRevisionRefNotRetainedError
      && error.ref === artifactRevisionEvidenceRef(entry.task.workspaceId, entry.revision.id)) {
      return error.state === "missing"
        ? "revision-evidence-ref-missing"
        : "revision-evidence-ref-conflict";
    }
    if (error instanceof ArtifactCandidateValidationError) {
      return "revision-evidence-ref-conflict";
    }
    throw error;
  }
  try {
    const released = await releaseArtifactCandidateAttemptRef({
      repositoryDir: dir,
      attempt: descriptor.attempt,
      revisionId: entry.revision.id,
      candidate: {
        commitHash: entry.revision.sourceCommitHash,
        treeHash: entry.revision.sourceTreeHash,
        attemptRef: descriptor.attemptRef,
      },
      history: descriptor.history,
      historyHead: descriptor.historyHead,
      evidence: evidenceReceipt,
      signal,
    });
    checkAbort(signal);
    await cleanupPublishedEvidence(options, entry, evidenceReceipt);
    return released ? "released" : "already-released";
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof ArtifactCandidateRevisionRefNotRetainedError) {
      if (error.ref === artifactRevisionHistoryRef(entry.revision.id)) {
        return error.state === "missing"
          ? "revision-history-ref-missing"
          : "revision-history-ref-conflict";
      }
      return error.state === "missing" ? "revision-ref-missing" : "revision-ref-conflict";
    }
    if (error instanceof ArtifactCandidateRefConflictError) {
      if (error.ref === artifactRevisionRef(entry.revision.id)) return "revision-ref-conflict";
      if (error.ref === artifactRevisionHistoryRef(entry.revision.id)) {
        return "revision-history-ref-conflict";
      }
    }
    throw error;
  }
}

/** Binds the Core recovery relation to the repository-safe Git ref adapter. */
export function createArtifactCandidateRefRecovery(
  options: ArtifactCandidateRefRecoveryAdapterOptions,
): ArtifactCandidateRefRecovery {
  return {
    recover(signal) {
      return recoverArtifactCandidateRefs({
        store: {
          async listArtifactCandidateRefRecoveryEntries(limit, cursor) {
            return options.store.listArtifactCandidateRefRecoveryEntries(limit, cursor);
          },
        },
        retention: {
          releaseAttemptRef(entry, releaseSignal) {
            return releaseRecoveryEntry(
              options,
              entry as CoreArtifactCandidateRefRecoveryEntry,
              releaseSignal,
            );
          },
        },
        limit: options.limit,
        observe: options.observe,
      }, signal);
    },
  };
}
