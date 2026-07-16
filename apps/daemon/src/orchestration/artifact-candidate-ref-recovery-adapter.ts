import type {
  ArtifactCandidateRefRecoveryCursor as CoreArtifactCandidateRefRecoveryCursor,
  ArtifactCandidateRefRecoveryEntry as CoreArtifactCandidateRefRecoveryEntry,
  ArtifactCandidateRefRecoveryPage as CoreArtifactCandidateRefRecoveryPage,
} from "../../../../packages/core/src/index.ts";
import {
  artifactCandidateRetentionDescriptor,
} from "./artifact-candidate-retention.ts";
import {
  ArtifactCandidateRefConflictError,
  ArtifactCandidateRevisionRefNotRetainedError,
  artifactRevisionHistoryRef,
  artifactRevisionRef,
  releaseArtifactCandidateAttemptRef,
  releaseOrphanArtifactCandidateAttemptRef,
} from "./artifact-candidate-transaction.ts";
import {
  recoverArtifactCandidateRefs,
  type ArtifactCandidateRefRecoveryEvent,
  type ArtifactCandidateRefRecoverySummary,
} from "./artifact-candidate-ref-recovery.ts";

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
      signal,
    });
    checkAbort(signal);
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
