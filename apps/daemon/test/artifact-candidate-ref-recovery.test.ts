import assert from "node:assert/strict";
import { test } from "node:test";

import {
  recoverArtifactCandidateRefs,
  type ArtifactCandidateRefRecoveryEntry,
  type ArtifactCandidateRefRecoveryEvent,
} from "../src/orchestration/artifact-candidate-ref-recovery.ts";

type RetainedRecoveryEntry = Extract<
  ArtifactCandidateRefRecoveryEntry,
  { retentionKind: "retained-candidate" }
>;

function entry(
  overrides: Partial<RetainedRecoveryEntry> = {},
): RetainedRecoveryEntry {
  const base: RetainedRecoveryEntry = {
    retentionKind: "retained-candidate",
    task: {
      id: "task-page-home",
      planId: "plan-1",
      workspaceId: "workspace-1",
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-home",
        trackId: "track-main",
      },
    },
    attempt: {
      taskId: "task-page-home",
      planId: "plan-1",
      workspaceId: "workspace-1",
      attempt: 1,
      status: "succeeded",
      inputHash: "a".repeat(64),
      createdAt: 1_700_000_000_000,
      sourceCommitHash: "b".repeat(40),
      sourceTreeHash: "c".repeat(40),
      materializationSealed: true,
      lease: null,
      finishedAt: 1_700_000_000_100,
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-home",
        trackId: "track-main",
      },
      candidateRevisionId: "revision-home-1",
      candidateResourceRevisionId: null,
      candidateEvidence: { protocol: "dezin.artifact-run.v1" },
      candidateEvidenceHash: "d".repeat(64),
    },
    revision: {
      id: "revision-home-1",
      workspaceId: "workspace-1",
      artifactId: "artifact-home",
      trackId: "track-main",
      sourceCommitHash: "c".repeat(40),
      sourceTreeHash: "d".repeat(40),
    },
  };
  return { ...base, ...overrides } as RetainedRecoveryEntry;
}

function orphanEntry(attemptNumber = 1): ArtifactCandidateRefRecoveryEntry {
  const candidate = entry();
  return {
    retentionKind: "orphan-attempt",
    task: candidate.task,
    attempt: {
      ...candidate.attempt,
      attempt: attemptNumber,
      status: "failed",
      candidateRevisionId: null,
      candidateResourceRevisionId: null,
      candidateEvidence: null,
      candidateEvidenceHash: null,
    },
    revision: null,
  };
}

test("recoverArtifactCandidateRefs only admits terminal exact Artifact candidates to atomic ref release", async () => {
  const exact = entry();
  const running = entry({
    attempt: { ...entry().attempt, attempt: 2, status: "running" },
  });
  const missingRevision = {
    ...entry(),
    attempt: {
      ...entry().attempt,
      attempt: 3,
      status: "failed",
      candidateRevisionId: null,
      candidateResourceRevisionId: null,
      candidateEvidence: null,
      candidateEvidenceHash: null,
    },
    revision: null,
  } as unknown as ArtifactCandidateRefRecoveryEntry;
  const mismatchedRevision = entry({
    attempt: { ...entry().attempt, attempt: 4, status: "cancelled" },
    revision: { ...entry().revision!, artifactId: "artifact-other" },
  });
  const released: string[] = [];
  const events: ArtifactCandidateRefRecoveryEvent[] = [];

  const summary = await recoverArtifactCandidateRefs({
    store: {
      listArtifactCandidateRefRecoveryEntries: () => ({
        entries: [exact, running, missingRevision, mismatchedRevision],
        nextCursor: null,
      }),
    },
    retention: {
      async releaseAttemptRef(candidate) {
        released.push(`${candidate.attempt.taskId}:${candidate.attempt.attempt}`);
        return "released";
      },
    },
    observe: (event) => events.push(event),
  }, new AbortController().signal);

  assert.deepEqual(released, ["task-page-home:1"]);
  assert.deepEqual(summary, {
    scanned: 4,
    eligible: 1,
    released: 1,
    alreadyReleased: 0,
    retained: 0,
    skipped: 3,
    failed: 0,
  });
  assert.deepEqual(events.map(({ outcome, reason }) => ({ outcome, reason })), [
    { outcome: "released", reason: null },
    { outcome: "skipped", reason: "attempt-not-terminal" },
    { outcome: "skipped", reason: "candidate-revision-not-recorded" },
    { outcome: "skipped", reason: "candidate-revision-identity-mismatch" },
  ]);
});

test("recoverArtifactCandidateRefs retains the Attempt ref when either exact Revision retention ref is absent or conflicting", async () => {
  const dispositions = [
    "revision-ref-missing",
    "revision-ref-conflict",
    "revision-history-ref-missing",
    "revision-history-ref-conflict",
  ] as const;
  let call = 0;

  const summary = await recoverArtifactCandidateRefs({
    store: {
      listArtifactCandidateRefRecoveryEntries: () => ({
        entries: [
          entry(),
          entry({ attempt: { ...entry().attempt, attempt: 2 } }),
          entry({ attempt: { ...entry().attempt, attempt: 3 } }),
          entry({ attempt: { ...entry().attempt, attempt: 4 } }),
        ],
        nextCursor: null,
      }),
    },
    retention: {
      async releaseAttemptRef() {
        return dispositions[call++]!;
      },
    },
  }, new AbortController().signal);

  assert.equal(call, 4);
  assert.deepEqual(summary, {
    scanned: 4,
    eligible: 4,
    released: 0,
    alreadyReleased: 0,
    retained: 4,
    skipped: 0,
    failed: 0,
  });
});

test("recoverArtifactCandidateRefs admits an exact terminal orphan Attempt to atomic ref cleanup", async () => {
  const orphan = orphanEntry();
  const released: ArtifactCandidateRefRecoveryEntry[] = [];

  const summary = await recoverArtifactCandidateRefs({
    store: {
      listArtifactCandidateRefRecoveryEntries: () => ({ entries: [orphan], nextCursor: null }),
    },
    retention: {
      async releaseAttemptRef(candidate) {
        released.push(candidate);
        return "released";
      },
    },
  }, new AbortController().signal);

  assert.deepEqual(released, [orphan]);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.released, 1);
  assert.equal(summary.skipped, 0);
});

test("recoverArtifactCandidateRefs rejects an orphan discriminator with retained candidate state", async () => {
  const retained = entry();
  const incoherent = {
    ...retained,
    retentionKind: "orphan-attempt",
  } as unknown as ArtifactCandidateRefRecoveryEntry;
  let releaseCalls = 0;

  const summary = await recoverArtifactCandidateRefs({
    store: {
      listArtifactCandidateRefRecoveryEntries: () => ({ entries: [incoherent], nextCursor: null }),
    },
    retention: {
      async releaseAttemptRef() {
        releaseCalls += 1;
        return "released";
      },
    },
  }, new AbortController().signal);

  assert.equal(releaseCalls, 0);
  assert.equal(summary.eligible, 0);
  assert.equal(summary.skipped, 1);
});

test("recoverArtifactCandidateRefs requires sealed, released, and finished terminal Attempt proof", async () => {
  const incoherent = {
    ...orphanEntry(),
    attempt: {
      ...orphanEntry().attempt,
      materializationSealed: false,
      lease: { token: "still-owned" },
      finishedAt: null,
    },
  } as unknown as ArtifactCandidateRefRecoveryEntry;
  let releaseCalls = 0;

  const summary = await recoverArtifactCandidateRefs({
    store: {
      listArtifactCandidateRefRecoveryEntries: () => ({ entries: [incoherent], nextCursor: null }),
    },
    retention: {
      async releaseAttemptRef() {
        releaseCalls += 1;
        return "released";
      },
    },
  }, new AbortController().signal);

  assert.equal(releaseCalls, 0);
  assert.equal(summary.eligible, 0);
  assert.equal(summary.skipped, 1);
});

test("recoverArtifactCandidateRefs isolates response-loss per item and a restarted pass converges idempotently", async () => {
  let durableAttemptRefPresent = true;
  let calls = 0;
  const options = {
    store: {
      listArtifactCandidateRefRecoveryEntries: () => ({ entries: [entry()], nextCursor: null }),
    },
    retention: {
      async releaseAttemptRef() {
        calls += 1;
        if (durableAttemptRefPresent) {
          durableAttemptRefPresent = false;
          throw new Error("response lost after atomic ref transaction");
        }
        return "already-released" as const;
      },
    },
  };

  const first = await recoverArtifactCandidateRefs(options, new AbortController().signal);
  const afterRestart = await recoverArtifactCandidateRefs(options, new AbortController().signal);

  assert.equal(calls, 2);
  assert.equal(durableAttemptRefPresent, false);
  assert.deepEqual(first, {
    scanned: 1,
    eligible: 1,
    released: 0,
    alreadyReleased: 0,
    retained: 0,
    skipped: 0,
    failed: 1,
  });
  assert.deepEqual(afterRestart, {
    scanned: 1,
    eligible: 1,
    released: 0,
    alreadyReleased: 1,
    retained: 0,
    skipped: 0,
    failed: 0,
  });
});

test("recoverArtifactCandidateRefs stops before another ref mutation when aborted", async () => {
  const controller = new AbortController();
  const attempted: number[] = [];
  const reason = new Error("daemon shutdown");

  await assert.rejects(
    recoverArtifactCandidateRefs({
      store: {
        listArtifactCandidateRefRecoveryEntries: () => ({
          entries: [
            entry(),
            entry({ attempt: { ...entry().attempt, attempt: 2 } }),
          ],
          nextCursor: null,
        }),
      },
      retention: {
        async releaseAttemptRef(candidate) {
          attempted.push(candidate.attempt.attempt);
          controller.abort(reason);
          return "released";
        },
      },
    }, controller.signal),
    (error: unknown) => error === reason,
  );

  assert.deepEqual(attempted, [1]);
});

test("recoverArtifactCandidateRefs paginates past an unreleasable full prefix and revisits safely on the next pass", async () => {
  const first = entry({ attempt: { ...entry().attempt, attempt: 1 } });
  const second = entry({ attempt: { ...entry().attempt, attempt: 2 } });
  const tail = entry({ attempt: { ...entry().attempt, attempt: 3 } });
  const cursor = {
    planId: "plan-1",
    taskOrdinal: 0,
    taskId: "task-page-home",
    attempt: 2,
  } as const;
  let tailPresent = true;
  const visited: number[] = [];
  const store = {
    listArtifactCandidateRefRecoveryEntries(_limit: number, after = null) {
      return after === null
        ? { entries: [first, second], nextCursor: cursor }
        : { entries: [tail], nextCursor: null };
    },
  };
  const retention = {
    async releaseAttemptRef(candidate: ArtifactCandidateRefRecoveryEntry) {
      visited.push(candidate.attempt.attempt);
      if (candidate.attempt.attempt <= 2) return "revision-ref-missing" as const;
      if (tailPresent) {
        tailPresent = false;
        return "released" as const;
      }
      return "already-released" as const;
    },
  };

  const firstPass = await recoverArtifactCandidateRefs(
    { store, retention, limit: 2 },
    new AbortController().signal,
  );
  const secondPass = await recoverArtifactCandidateRefs(
    { store, retention, limit: 2 },
    new AbortController().signal,
  );

  assert.deepEqual(visited, [1, 2, 3, 1, 2, 3]);
  assert.equal(firstPass.retained, 2);
  assert.equal(firstPass.released, 1);
  assert.equal(secondPass.retained, 2);
  assert.equal(secondPass.alreadyReleased, 1);
});
