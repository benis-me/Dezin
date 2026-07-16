import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ArtifactCandidateRefRecoveryEntry,
  ArtifactRevisionRecord,
  GenerationTaskAttemptClaim,
} from "../../../packages/core/src/index.ts";
import { generationTaskCandidateEvidenceHash } from "../../../packages/core/src/index.ts";
import {
  ArtifactCandidateRetentionError,
  GitArtifactCandidateRetention,
} from "../src/orchestration/artifact-candidate-retention.ts";
import { createArtifactCandidateRefRecovery } from "../src/orchestration/artifact-candidate-ref-recovery-adapter.ts";
import {
  artifactCandidateAttemptRef,
  artifactRevisionHistoryRef,
  artifactRevisionRef,
  beginArtifactCandidateTransaction,
  type ArtifactCandidateAttempt,
  type ArtifactCandidateIdentity,
} from "../src/orchestration/artifact-candidate-transaction.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function refExists(cwd: string, ref: string): boolean {
  return spawnSync("git", ["rev-parse", "--verify", ref], { cwd, stdio: "ignore" }).status === 0;
}

function fixture(): {
  root: string;
  attempt: ArtifactCandidateAttempt;
} {
  const root = mkdtempSync(join(tmpdir(), "dezin-artifact-retention-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  writeFileSync(join(root, "page.txt"), "base\n");
  git(root, "add", "page.txt");
  git(root, "commit", "-q", "-m", "base");
  return {
    root,
    attempt: {
      workspaceId: "workspace-1",
      taskId: "task-page-1",
      attempt: 1,
      inputHash: "a".repeat(64),
      createdAt: 1_700_000_000_000,
      sourceCommitHash: git(root, "rev-parse", "HEAD"),
      sourceTreeHash: git(root, "rev-parse", "HEAD^{tree}"),
    },
  };
}

function claim(
  attempt: ArtifactCandidateAttempt,
  options: {
    executionMode?: "full" | "publication-only";
    attemptNumber?: number;
    candidateEvidence?: Record<string, unknown>;
  } = {},
): GenerationTaskAttemptClaim {
  const attemptNumber = options.attemptNumber ?? attempt.attempt;
  const executionMode = options.executionMode ?? "full";
  const candidateEvidence = executionMode === "publication-only"
    ? (options.candidateEvidence ?? null)
    : null;
  const candidateRevisionId = executionMode === "publication-only" ? "revision-page-1" : null;
  return {
    task: {
      id: attempt.taskId,
      planId: "plan-1",
      workspaceId: attempt.workspaceId,
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: attempt.workspaceId,
        id: "artifact-page-1",
        trackId: "track-main",
      },
    },
    attempt: {
      taskId: attempt.taskId,
      planId: "plan-1",
      workspaceId: attempt.workspaceId,
      attempt: attemptNumber,
      executionMode,
      attemptOrigin: executionMode === "publication-only" ? "publication-retry" : "materialized",
      predecessorAttempt: executionMode === "publication-only" ? attemptNumber - 1 : null,
      automaticRetryIndex: executionMode === "publication-only" ? 1 : 0,
      inputHash: executionMode === "publication-only" ? "b".repeat(64) : attempt.inputHash,
      createdAt: executionMode === "publication-only" ? attempt.createdAt + 1 : attempt.createdAt,
      sourceCommitHash: attempt.sourceCommitHash,
      sourceTreeHash: attempt.sourceTreeHash,
      contextPackId: `context-pack-${"c".repeat(64)}`,
      candidateRevisionId,
      candidateResourceRevisionId: null,
      candidateEvidence,
      candidateEvidenceHash: candidateEvidence === null ? null : generationTaskCandidateEvidenceHash({
        taskId: attempt.taskId,
        planId: "plan-1",
        workspaceId: attempt.workspaceId,
        attempt: attemptNumber,
        candidateRevisionId,
        candidateResourceRevisionId: null,
        candidateEvidence,
      }),
      target: {
        type: "artifact",
        workspaceId: attempt.workspaceId,
        id: "artifact-page-1",
        trackId: "track-main",
      },
    },
  } as unknown as GenerationTaskAttemptClaim;
}

function revision(candidate: ArtifactCandidateIdentity): ArtifactRevisionRecord {
  return {
    id: "revision-page-1",
    workspaceId: "workspace-1",
    artifactId: "artifact-page-1",
    trackId: "track-main",
    sequence: 1,
    parentRevisionId: null,
    sourceCommitHash: candidate.commitHash,
    sourceTreeHash: candidate.treeHash,
    artifactRoot: ".",
    kernelRevisionId: "kernel-1",
    renderSpec: { frames: [] },
    quality: { state: "passed", score: 98, findings: [] },
    contextPackHash: "c".repeat(64),
    producedByRunId: null,
    legacyRunId: null,
    createdAt: 1_700_000_000_100,
  };
}

function evidence(
  attempt: ArtifactCandidateAttempt,
  selected: ArtifactCandidateIdentity,
  versions: readonly ArtifactCandidateIdentity[] = [selected],
): Record<string, unknown> {
  const runtimeChecks = [{ id: "build", status: "passed" }];
  const visualReview = { status: "passed", fidelity: 0.98 };
  const selectedRound = versions.findIndex((version) => (
    version.commitHash === selected.commitHash && version.treeHash === selected.treeHash
  ));
  assert.notEqual(selectedRound, -1);
  return {
    runtimeChecks,
    visualReview,
    protocol: "dezin.artifact-run.v1",
    projectId: "project-1",
    taskId: attempt.taskId,
    planId: "plan-1",
    workspaceId: attempt.workspaceId,
    attempt: attempt.attempt,
    attemptCreatedAt: attempt.createdAt,
    inputHash: attempt.inputHash,
    contextPackId: `context-pack-${"c".repeat(64)}`,
    contextPackHash: "c".repeat(64),
    sourceBase: {
      commitHash: attempt.sourceCommitHash,
      treeHash: attempt.sourceTreeHash,
    },
    candidateRetentionRef: artifactCandidateAttemptRef(attempt),
    selectedRound,
    versions: versions.map((version, round) => ({
      round,
      commitHash: version.commitHash,
      treeHash: version.treeHash,
      passed: round === selectedRound,
      score: round === selectedRound ? 98 : 80,
    })),
    qualityEvidence: {
      runtimeChecks: structuredClone(runtimeChecks),
      visualReview: structuredClone(visualReview),
    },
  };
}

function recoveryEntry(
  attempt: ArtifactCandidateAttempt,
  artifactRevision: ArtifactRevisionRecord,
  candidateEvidence = evidence(attempt, {
    commitHash: artifactRevision.sourceCommitHash,
    treeHash: artifactRevision.sourceTreeHash,
  }),
): ArtifactCandidateRefRecoveryEntry {
  const source = claim(attempt);
  return {
    retentionKind: "retained-candidate",
    task: source.task,
    attempt: {
      ...source.attempt,
      status: "succeeded",
      candidateRevisionId: artifactRevision.id,
      candidateResourceRevisionId: null,
      candidateEvidence,
      candidateEvidenceHash: generationTaskCandidateEvidenceHash({
        taskId: source.task.id,
        planId: source.task.planId,
        workspaceId: source.task.workspaceId,
        attempt: source.attempt.attempt,
        candidateRevisionId: artifactRevision.id,
        candidateResourceRevisionId: null,
        candidateEvidence,
      }),
      materializationSealed: true,
      lease: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: attempt.createdAt + 100,
    },
    revision: artifactRevision,
  } as ArtifactCandidateRefRecoveryEntry;
}

function orphanRecoveryEntry(
  attempt: ArtifactCandidateAttempt,
): ArtifactCandidateRefRecoveryEntry {
  const source = claim(attempt);
  return {
    retentionKind: "orphan-attempt",
    task: source.task,
    attempt: {
      ...source.attempt,
      status: "failed",
      candidateRevisionId: null,
      candidateResourceRevisionId: null,
      candidateEvidence: null,
      candidateEvidenceHash: null,
      materializationSealed: true,
      lease: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: attempt.createdAt + 100,
    },
    revision: null,
  } as ArtifactCandidateRefRecoveryEntry;
}

test("production Artifact ref recovery releases an exact redundant Attempt ref and restart is idempotent", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const artifactRevision = revision(candidate);
    const candidateEvidence = evidence(input.attempt, candidate);
    const retention = new GitArtifactCandidateRetention({ repositoryDirForWorkspace: () => input.root });
    await retention.promote({
      claim: claim(input.attempt),
      artifactRevision,
      evidence: candidateEvidence,
    }, new AbortController().signal);
    const entries = [recoveryEntry(input.attempt, artifactRevision, candidateEvidence)];
    const requestedLimits: number[] = [];
    const createRecovery = () => createArtifactCandidateRefRecovery({
      store: {
        listArtifactCandidateRefRecoveryEntries(limit) {
          requestedLimits.push(limit);
          return { entries, nextCursor: null };
        },
      },
      repositoryDirForWorkspace: () => input.root,
      limit: 17,
    });

    const first = await createRecovery().recover(new AbortController().signal);
    const afterRestart = await createRecovery().recover(new AbortController().signal);

    assert.deepEqual(requestedLimits, [17, 17]);
    assert.equal(first.released, 1);
    assert.equal(afterRestart.alreadyReleased, 1);
    assert.equal(refExists(input.root, transaction.attemptRef), false);
    assert.equal(git(input.root, "rev-parse", artifactRevisionRef(artifactRevision.id)), candidate.commitHash);
    assert.equal(git(input.root, "rev-parse", artifactRevisionHistoryRef(artifactRevision.id)), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("production Artifact ref recovery cleans a committed orphan Attempt after abort-before-Core-stage and restart is idempotent", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate then abort\n");
    const candidate = await transaction.commit("generate before abort", new AbortController().signal);
    await transaction.dispose();
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);

    const entries = [orphanRecoveryEntry(input.attempt)];
    const createRecovery = () => createArtifactCandidateRefRecovery({
      store: { listArtifactCandidateRefRecoveryEntries: () => ({ entries, nextCursor: null }) },
      repositoryDirForWorkspace: () => input.root,
    });

    const first = await createRecovery().recover(new AbortController().signal);
    assert.equal(first.released, 1);
    assert.equal(refExists(input.root, transaction.attemptRef), false);

    const afterRestart = await createRecovery().recover(new AbortController().signal);
    assert.equal(afterRestart.alreadyReleased, 1);
    assert.equal(refExists(input.root, transaction.attemptRef), false);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("production Artifact ref recovery retains the Attempt unless both Revision retention refs are exact", async (t) => {
  const cases = [
    { mode: "selected-missing", expected: "revision-ref-missing" },
    { mode: "selected-conflicting", expected: "revision-ref-conflict" },
    { mode: "history-missing", expected: "revision-history-ref-missing" },
    { mode: "history-conflicting", expected: "revision-history-ref-conflict" },
  ] as const;
  for (const { mode, expected } of cases) {
    await t.test(mode, async () => {
      const input = fixture();
      const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
      try {
        writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
        const candidate = await transaction.commit("generate", new AbortController().signal);
        await transaction.dispose();
        const artifactRevision = revision(candidate);
        const candidateEvidence = evidence(input.attempt, candidate);
        const retention = new GitArtifactCandidateRetention({ repositoryDirForWorkspace: () => input.root });
        await retention.promote({
          claim: claim(input.attempt),
          artifactRevision,
          evidence: candidateEvidence,
        }, new AbortController().signal);
        const selectedRef = artifactRevisionRef(artifactRevision.id);
        const historyRef = artifactRevisionHistoryRef(artifactRevision.id);
        const targetRef = mode.startsWith("selected") ? selectedRef : historyRef;
        if (mode.endsWith("missing")) {
          git(input.root, "update-ref", "-d", targetRef, candidate.commitHash);
        } else {
          git(input.root, "update-ref", targetRef, input.attempt.sourceCommitHash, candidate.commitHash);
        }
        const events: Array<{ outcome: string; reason: string | null }> = [];
        const recovery = createArtifactCandidateRefRecovery({
          store: { listArtifactCandidateRefRecoveryEntries: () => ({
            entries: [recoveryEntry(input.attempt, artifactRevision, candidateEvidence)],
            nextCursor: null,
          }) },
          repositoryDirForWorkspace: () => input.root,
          observe: ({ outcome, reason }) => events.push({ outcome, reason }),
        });

        const summary = await recovery.recover(new AbortController().signal);

        assert.equal(summary.retained, 1);
        assert.equal(summary.released, 0);
        assert.deepEqual(events, [{ outcome: "retained", reason: expected }]);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      } finally {
        await transaction.dispose();
        rmSync(input.root, { recursive: true, force: true });
      }
    });
  }
});

test("production Artifact ref recovery rejects incoherent Core identity and tampered origin evidence without deleting a ref", async (t) => {
  const cases: Array<{
    name: string;
    mutate(entry: ArtifactCandidateRefRecoveryEntry): void;
    expected: "skipped" | "failed";
  }> = [
    {
      name: "Revision identity",
      mutate(value) {
        if (value.retentionKind !== "retained-candidate") assert.fail("expected retained candidate");
        value.revision.artifactId = "artifact-other";
      },
      expected: "skipped",
    },
    {
      name: "origin evidence",
      mutate(value) { value.attempt.candidateEvidence!.candidateRetentionRef = "refs/dezin/tampered"; },
      expected: "failed",
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const input = fixture();
      const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
      try {
        writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
        const candidate = await transaction.commit("generate", new AbortController().signal);
        await transaction.dispose();
        const candidateEntry = recoveryEntry(input.attempt, revision(candidate));
        testCase.mutate(candidateEntry);
        const recovery = createArtifactCandidateRefRecovery({
          store: { listArtifactCandidateRefRecoveryEntries: () => ({
            entries: [candidateEntry],
            nextCursor: null,
          }) },
          repositoryDirForWorkspace: () => input.root,
        });

        const summary = await recovery.recover(new AbortController().signal);

        assert.equal(summary[testCase.expected], 1);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      } finally {
        await transaction.dispose();
        rmSync(input.root, { recursive: true, force: true });
      }
    });
  }
});

test("Git retention promotes an earlier best candidate retained by a later Attempt head", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: input.root,
    attempt: input.attempt,
  });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "best\n");
    const best = await transaction.commit("round 0", new AbortController().signal);
    writeFileSync(join(transaction.dir, "page.txt"), "regressed\n");
    const later = await transaction.commit("round 1", new AbortController().signal);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), later.commitHash);
    await transaction.restore(best, new AbortController().signal);
    await transaction.dispose();

    const retention = new GitArtifactCandidateRetention({
      repositoryDirForWorkspace: () => input.root,
    });
    const retentionInput = {
      claim: claim(input.attempt),
      artifactRevision: revision(best),
      evidence: evidence(input.attempt, best, [best, later]),
    };
    await retention.promote(retentionInput, new AbortController().signal);
    assert.equal(git(input.root, "rev-parse", artifactRevisionRef("revision-page-1")), best.commitHash);
    assert.equal(git(input.root, "rev-parse", artifactRevisionHistoryRef("revision-page-1")), later.commitHash);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), later.commitHash);

    await retention.release(retentionInput, new AbortController().signal);
    assert.equal(refExists(input.root, transaction.attemptRef), false);
    git(input.root, "reflog", "expire", "--expire=now", "--all");
    git(input.root, "gc", "--prune=now");
    for (const version of [best, later]) {
      assert.equal(git(input.root, "cat-file", "-t", version.commitHash), "commit");
      assert.equal(git(input.root, "cat-file", "-t", version.treeHash), "tree");
    }
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("publication-only retention uses the original full-execution Attempt evidence", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const retention = new GitArtifactCandidateRetention({ repositoryDirForWorkspace: () => input.root });
    const retentionInput = {
      claim: claim(input.attempt, {
        executionMode: "publication-only",
        attemptNumber: 2,
        candidateEvidence: evidence(input.attempt, candidate),
      }),
      artifactRevision: revision(candidate),
      evidence: evidence(input.attempt, candidate),
    };
    await retention.promote(retentionInput, new AbortController().signal);
    await retention.release(retentionInput, new AbortController().signal);
    assert.equal(git(input.root, "rev-parse", artifactRevisionRef("revision-page-1")), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("retention rejects tampered origin evidence before moving a Git ref", async () => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const retention = new GitArtifactCandidateRetention({ repositoryDirForWorkspace: () => input.root });
    const tampered = evidence(input.attempt, candidate);
    tampered.candidateRetentionRef = "refs/dezin/tampered";
    await assert.rejects(
      retention.promote({
        claim: claim(input.attempt),
        artifactRevision: revision(candidate),
        evidence: tampered,
      }, new AbortController().signal),
      ArtifactCandidateRetentionError,
    );
    assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
    assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("retention requires promoted quality-gate evidence to mirror its immutable audit envelope", async (t) => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const retention = new GitArtifactCandidateRetention({ repositoryDirForWorkspace: () => input.root });
    const cases: Array<{ name: string; mutate(value: Record<string, unknown>): void }> = [
      {
        name: "root runtime checks differ",
        mutate(value) { value.runtimeChecks = [{ id: "build", status: "failed" }]; },
      },
      {
        name: "root visual review is missing",
        mutate(value) { delete value.visualReview; },
      },
      {
        name: "audit visual review is missing",
        mutate(value) {
          delete (value.qualityEvidence as Record<string, unknown>).visualReview;
        },
      },
      {
        name: "unknown promoted field",
        mutate(value) { value.unreviewed = true; },
      },
      {
        name: "selected version substitution",
        mutate(value) {
          const versions = value.versions as Array<Record<string, unknown>>;
          versions[0] = { ...versions[0], commitHash: input.attempt.sourceCommitHash };
        },
      },
      {
        name: "non-contiguous version round",
        mutate(value) {
          const versions = value.versions as Array<Record<string, unknown>>;
          versions[0] = { ...versions[0], round: 1 };
        },
      },
      {
        name: "empty version history",
        mutate(value) { value.versions = []; },
      },
    ];
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const tampered = evidence(input.attempt, candidate);
        entry.mutate(tampered);
        await assert.rejects(
          retention.promote({
            claim: claim(input.attempt),
            artifactRevision: revision(candidate),
            evidence: tampered,
          }, new AbortController().signal),
          ArtifactCandidateRetentionError,
        );
        assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      });
    }
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("publication-only retention rejects an incoherent Core lineage before moving a Git ref", async (t) => {
  const input = fixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: input.root, attempt: input.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("generate", new AbortController().signal);
    await transaction.dispose();
    const retention = new GitArtifactCandidateRetention({ repositoryDirForWorkspace: () => input.root });
    const candidateEvidence = evidence(input.attempt, candidate);
    const baseClaim = claim(input.attempt, {
      executionMode: "publication-only",
      attemptNumber: 2,
      candidateEvidence,
    });
    const cases: Array<{ name: string; mutate(value: GenerationTaskAttemptClaim): void }> = [
      {
        name: "wrong origin",
        mutate(value) { value.attempt.attemptOrigin = "same-input-retry"; },
      },
      {
        name: "non-adjacent predecessor",
        mutate(value) { value.attempt.predecessorAttempt = 0; },
      },
      {
        name: "substituted candidate Revision",
        mutate(value) { value.attempt.candidateRevisionId = "revision-other"; },
      },
      {
        name: "substituted evidence",
        mutate(value) { value.attempt.candidateEvidence = { ...candidateEvidence, selectedRound: 7 }; },
      },
      {
        name: "forged evidence hash",
        mutate(value) { value.attempt.candidateEvidenceHash = "f".repeat(64); },
      },
      {
        name: "substituted Context Pack",
        mutate(value) { value.attempt.contextPackId = `context-pack-${"d".repeat(64)}`; },
      },
    ];
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const candidateClaim = structuredClone(baseClaim);
        entry.mutate(candidateClaim);
        await assert.rejects(
          retention.promote({
            claim: candidateClaim,
            artifactRevision: revision(candidate),
            evidence: candidateEvidence,
          }, new AbortController().signal),
          ArtifactCandidateRetentionError,
        );
        assert.equal(refExists(input.root, artifactRevisionRef("revision-page-1")), false);
        assert.equal(git(input.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
      });
    }
  } finally {
    await transaction.dispose();
    rmSync(input.root, { recursive: true, force: true });
  }
});
