export type ArtifactCandidateRefRecoveryAttemptStatus =
  | "queued"
  | "running"
  | "cancel-requested"
  | "candidate-ready"
  | "succeeded"
  | "retryable-failed"
  | "failed"
  | "needs-rebase"
  | "cancelled";

export interface ArtifactCandidateRefRecoveryTarget {
  readonly type: string;
  readonly workspaceId: string;
  readonly id: string;
  readonly trackId?: string;
}

interface ArtifactCandidateRefRecoveryTask {
  readonly id: string;
  readonly planId: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly target: ArtifactCandidateRefRecoveryTarget;
}

interface ArtifactCandidateRefRecoveryAttemptBase {
  readonly taskId: string;
  readonly planId: string;
  readonly workspaceId: string;
  readonly attempt: number;
  readonly status: ArtifactCandidateRefRecoveryAttemptStatus;
  readonly target: ArtifactCandidateRefRecoveryTarget;
  readonly inputHash: string;
  readonly createdAt: number;
  readonly sourceCommitHash: string | null;
  readonly sourceTreeHash: string | null;
  readonly materializationSealed: true;
  readonly lease: null;
  readonly finishedAt: number;
}

interface ArtifactCandidateRefRecoveryRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly trackId: string;
  readonly sourceCommitHash: string;
  readonly sourceTreeHash: string;
}

export type ArtifactCandidateRefRecoveryEntry =
  | {
    readonly retentionKind: "retained-candidate";
    readonly task: ArtifactCandidateRefRecoveryTask;
    readonly attempt: ArtifactCandidateRefRecoveryAttemptBase & {
      readonly candidateRevisionId: string;
      readonly candidateResourceRevisionId: null;
      readonly candidateEvidence: Record<string, unknown>;
      readonly candidateEvidenceHash: string;
    };
    readonly revision: ArtifactCandidateRefRecoveryRevision;
  }
  | {
    readonly retentionKind: "orphan-attempt";
    readonly task: ArtifactCandidateRefRecoveryTask;
    readonly attempt: ArtifactCandidateRefRecoveryAttemptBase & {
      readonly candidateRevisionId: null;
      readonly candidateResourceRevisionId: null;
      readonly candidateEvidence: null;
      readonly candidateEvidenceHash: null;
    };
    readonly revision: null;
  };

export interface ArtifactCandidateRefRecoveryCursor {
  readonly planId: string;
  readonly taskOrdinal: number;
  readonly taskId: string;
  readonly attempt: number;
}

export interface ArtifactCandidateRefRecoveryPage {
  readonly entries: readonly ArtifactCandidateRefRecoveryEntry[];
  readonly nextCursor: ArtifactCandidateRefRecoveryCursor | null;
}

export type ArtifactCandidateRefReleaseDisposition =
  | "released"
  | "already-released"
  | "revision-ref-missing"
  | "revision-ref-conflict"
  | "revision-history-ref-missing"
  | "revision-history-ref-conflict"
  | "revision-evidence-ref-missing"
  | "revision-evidence-ref-conflict";

export interface ArtifactCandidateRefRecoverySummary {
  scanned: number;
  eligible: number;
  released: number;
  alreadyReleased: number;
  retained: number;
  skipped: number;
  failed: number;
}

export type ArtifactCandidateRefRecoverySkipReason =
  | "attempt-not-terminal"
  | "attempt-identity-invalid"
  | "orphan-attempt-not-empty"
  | "candidate-revision-not-recorded"
  | "candidate-revision-not-found"
  | "candidate-identity-mismatch"
  | "candidate-revision-identity-mismatch";

export interface ArtifactCandidateRefRecoveryEvent {
  readonly taskId: string;
  readonly attempt: number;
  readonly outcome: "released" | "already-released" | "retained" | "skipped" | "failed";
  readonly reason: ArtifactCandidateRefRecoverySkipReason | ArtifactCandidateRefReleaseDisposition | null;
  readonly error?: unknown;
}

export interface ArtifactCandidateRefRecoveryOptions {
  readonly store: {
    listArtifactCandidateRefRecoveryEntries(
      limit: number,
      cursor?: ArtifactCandidateRefRecoveryCursor | null,
    ): ArtifactCandidateRefRecoveryPage | Promise<ArtifactCandidateRefRecoveryPage>;
  };
  readonly retention: {
    /**
     * Retained candidates require exact immutable selected, history-head, and
     * evidence Revision refs before their Attempt ref is deleted. Orphans require the
     * terminal/no-candidate Core proof and an atomic compare-delete of only
     * their canonical Attempt ref.
     */
    releaseAttemptRef(
      entry: ArtifactCandidateRefRecoveryEntry,
      signal: AbortSignal,
    ): Promise<ArtifactCandidateRefReleaseDisposition>;
  };
  readonly limit?: number;
  readonly observe?: (event: ArtifactCandidateRefRecoveryEvent) => void;
}

const TERMINAL_ATTEMPT_STATUSES = new Set<ArtifactCandidateRefRecoveryAttemptStatus>([
  "succeeded",
  "retryable-failed",
  "failed",
  "needs-rebase",
  "cancelled",
]);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Artifact candidate ref recovery aborted", "AbortError");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function positiveLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("Artifact candidate ref recovery limit must be a safe integer between 1 and 1000");
  }
  return limit;
}

function skipReason(entry: ArtifactCandidateRefRecoveryEntry): ArtifactCandidateRefRecoverySkipReason | null {
  if (!TERMINAL_ATTEMPT_STATUSES.has(entry.attempt.status)) return "attempt-not-terminal";
  const { task, attempt } = entry;
  if ((task.kind !== "page" && task.kind !== "component")
    || task.id !== attempt.taskId
    || task.planId !== attempt.planId
    || task.workspaceId !== attempt.workspaceId
    || task.target.type !== "artifact"
    || attempt.target.type !== "artifact"
    || task.target.workspaceId !== task.workspaceId
    || attempt.target.workspaceId !== attempt.workspaceId
    || task.target.id !== attempt.target.id
    || task.target.trackId !== attempt.target.trackId) {
    return "candidate-identity-mismatch";
  }
  if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1
    || !Number.isSafeInteger(attempt.createdAt) || attempt.createdAt < 0
    || attempt.materializationSealed !== true
    || attempt.lease !== null
    || !Number.isSafeInteger(attempt.finishedAt) || attempt.finishedAt < attempt.createdAt
    || !/^[0-9a-f]{64}$/.test(attempt.inputHash)
    || attempt.sourceCommitHash === null
    || attempt.sourceTreeHash === null
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(attempt.sourceCommitHash)
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(attempt.sourceTreeHash)
    || attempt.sourceCommitHash.length !== attempt.sourceTreeHash.length) {
    return "attempt-identity-invalid";
  }
  if (entry.retentionKind === "orphan-attempt") {
    if (attempt.candidateRevisionId !== null
      || attempt.candidateResourceRevisionId !== null
      || attempt.candidateEvidence !== null
      || attempt.candidateEvidenceHash !== null
      || entry.revision !== null) {
      return "orphan-attempt-not-empty";
    }
    return null;
  }
  const { revision } = entry;
  if (typeof attempt.candidateRevisionId !== "string"
    || attempt.candidateRevisionId.length === 0
    || attempt.candidateResourceRevisionId !== null
    || attempt.candidateEvidence === null
    || typeof attempt.candidateEvidence !== "object"
    || typeof attempt.candidateEvidenceHash !== "string"
    || !/^[0-9a-f]{64}$/.test(attempt.candidateEvidenceHash)) {
    return "candidate-revision-not-recorded";
  }
  if (revision === null) return "candidate-revision-not-found";
  if (attempt.candidateRevisionId !== revision.id
    || revision.workspaceId !== attempt.workspaceId
    || revision.artifactId !== attempt.target.id
    || revision.trackId !== attempt.target.trackId) {
    return "candidate-revision-identity-mismatch";
  }
  return null;
}

function observe(
  listener: ArtifactCandidateRefRecoveryOptions["observe"],
  event: ArtifactCandidateRefRecoveryEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // Recovery observation is best-effort and cannot own ref safety.
  }
}

function eventIdentity(entry: ArtifactCandidateRefRecoveryEntry): Pick<
  ArtifactCandidateRefRecoveryEvent,
  "taskId" | "attempt"
> {
  return { taskId: entry.attempt.taskId, attempt: entry.attempt.attempt };
}

/**
 * Releases only redundant Artifact Attempt refs. The retention port owns the
 * atomic Git compare-and-delete, so this coordinator never implements a racy
 * "check then delete" sequence and never drops the only reachability root.
 */
export async function recoverArtifactCandidateRefs(
  options: ArtifactCandidateRefRecoveryOptions,
  signal: AbortSignal,
): Promise<ArtifactCandidateRefRecoverySummary> {
  checkAbort(signal);
  const limit = positiveLimit(options.limit);
  const summary: ArtifactCandidateRefRecoverySummary = {
    scanned: 0,
    eligible: 0,
    released: 0,
    alreadyReleased: 0,
    retained: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor: ArtifactCandidateRefRecoveryCursor | null = null;
  const seenCursors = new Set<string>();
  for (;;) {
    checkAbort(signal);
    const page = await options.store.listArtifactCandidateRefRecoveryEntries(limit, cursor);
    checkAbort(signal);
    if (page === null || typeof page !== "object" || !Array.isArray(page.entries)) {
      throw new Error("Artifact candidate ref recovery Store returned an invalid page");
    }
    for (const entry of page.entries) {
      checkAbort(signal);
      summary.scanned += 1;
      const reason = skipReason(entry);
      if (reason !== null) {
        summary.skipped += 1;
        observe(options.observe, {
          ...eventIdentity(entry),
          outcome: "skipped",
          reason,
        });
        continue;
      }

      summary.eligible += 1;
      try {
        const disposition = await options.retention
          .releaseAttemptRef(entry, signal);
        checkAbort(signal);
        if (disposition === "released") {
          summary.released += 1;
          observe(options.observe, {
            ...eventIdentity(entry),
            outcome: "released",
            reason: null,
          });
        } else if (disposition === "already-released") {
          summary.alreadyReleased += 1;
          observe(options.observe, {
            ...eventIdentity(entry),
            outcome: "already-released",
            reason: disposition,
          });
        } else {
          summary.retained += 1;
          observe(options.observe, {
            ...eventIdentity(entry),
            outcome: "retained",
            reason: disposition,
          });
        }
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        summary.failed += 1;
        observe(options.observe, {
          ...eventIdentity(entry),
          outcome: "failed",
          reason: null,
          error,
        });
      }
    }
    if (page.nextCursor === null) break;
    const nextCursor = page.nextCursor;
    if (typeof nextCursor !== "object"
      || typeof nextCursor.planId !== "string" || nextCursor.planId.length === 0
      || !Number.isSafeInteger(nextCursor.taskOrdinal) || nextCursor.taskOrdinal < 0
      || typeof nextCursor.taskId !== "string" || nextCursor.taskId.length === 0
      || !Number.isSafeInteger(nextCursor.attempt) || nextCursor.attempt < 1) {
      throw new Error("Artifact candidate ref recovery Store returned an invalid cursor");
    }
    const cursorKey = JSON.stringify([
      nextCursor.planId,
      nextCursor.taskOrdinal,
      nextCursor.taskId,
      nextCursor.attempt,
    ]);
    if (seenCursors.has(cursorKey)) {
      throw new Error("Artifact candidate ref recovery Store returned a non-progressing cursor");
    }
    seenCursors.add(cursorKey);
    cursor = nextCursor;
  }
  return summary;
}
