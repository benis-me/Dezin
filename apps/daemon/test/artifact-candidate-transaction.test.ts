import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ArtifactCandidateRefConflictError,
  ArtifactCandidateValidationError,
  artifactCandidateAttemptRef,
  artifactRevisionEvidenceRef,
  artifactRevisionHistoryRef,
  artifactRevisionRef,
  beginArtifactCandidateTransaction,
  prepareArtifactRevisionEvidenceBundle,
  promoteArtifactCandidateRef,
  releaseArtifactCandidateAttemptRef,
  verifyArtifactCandidateObject,
  verifyArtifactRevisionEvidenceBundle,
  type ArtifactCandidateAttempt,
  type ArtifactCandidateIdentity,
  type PrepareArtifactRevisionEvidenceBundleInput,
} from "../src/orchestration/artifact-candidate-transaction.ts";

function expectedArtifactRevisionHistoryRef(revisionId: string): string {
  return `refs/dezin/artifact-revision-history/${createHash("sha256").update(revisionId).digest("hex")}`;
}

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

function gitInput(cwd: string, args: readonly string[], input: string | Buffer): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return execFileSync("git", args, { cwd, encoding: "utf8", env, input }).trim();
}

interface RepositoryFixture {
  root: string;
  baseCommitHash: string;
  baseTreeHash: string;
  liveCommitHash: string;
  attempt: ArtifactCandidateAttempt;
}

function repositoryFixture(options: {
  advanceHead?: boolean;
  objectFormat?: "sha1" | "sha256";
} = {}): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "dezin-artifact-candidate-repo-"));
  git(root, "init", "-q", `--object-format=${options.objectFormat ?? "sha1"}`);
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  writeFileSync(join(root, "page.txt"), "base\n");
  git(root, "add", "page.txt");
  git(root, "commit", "-q", "-m", "base");
  const baseCommitHash = git(root, "rev-parse", "HEAD");
  const baseTreeHash = git(root, "rev-parse", "HEAD^{tree}");
  let liveCommitHash = baseCommitHash;
  if (options.advanceHead) {
    writeFileSync(join(root, "page.txt"), "live\n");
    git(root, "add", "page.txt");
    git(root, "commit", "-q", "-m", "live");
    liveCommitHash = git(root, "rev-parse", "HEAD");
  }
  return {
    root,
    baseCommitHash,
    baseTreeHash,
    liveCommitHash,
    attempt: {
      workspaceId: "workspace-1",
      taskId: "task-page-1",
      attempt: 1,
      inputHash: "a".repeat(64),
      createdAt: 1_700_000_000_000,
      sourceCommitHash: baseCommitHash,
      sourceTreeHash: baseTreeHash,
    },
  };
}

function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function evidenceBundleInput(
  fixture: RepositoryFixture,
  candidate: ArtifactCandidateIdentity,
  revisionId: string,
): PrepareArtifactRevisionEvidenceBundleInput {
  const bytes = Buffer.from("strict visual evidence\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = [
    "generation-task-evidence",
    "project-1",
    fixture.attempt.workspaceId,
    "plan-1",
    fixture.attempt.taskId,
    `attempt-${fixture.attempt.attempt}`,
    "visual",
    `round-0-desktop-${sha256}.png`,
  ].join("/");
  return {
    repositoryDir: fixture.root,
    projectId: "project-1",
    workspaceId: fixture.attempt.workspaceId,
    revisionId,
    artifactId: "artifact-page-1",
    trackId: "track-main",
    candidate,
    contextPackHash: "c".repeat(64),
    attempt: fixture.attempt,
    candidateEvidenceSha256: "e".repeat(64),
    entries: [{
      kind: "frame",
      round: 0,
      storageKey,
      sha256,
      byteLength: bytes.byteLength,
      descriptor: {
        protocol: "dezin.generation-task-visual-evidence.v1",
        round: 0,
        mediaType: "image/png",
        sha256,
        byteLength: bytes.byteLength,
        storageKey,
      },
      bytes,
    }],
  };
}

test("Artifact Revision evidence bundle is deterministic, exact, and atomically retained", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Evidence candidate" });
    const revisionId = "revision-evidence-1";
    const bundleInput = evidenceBundleInput(fixture, candidate, revisionId);
    const prepared = await prepareArtifactRevisionEvidenceBundle(bundleInput);
    const replay = await prepareArtifactRevisionEvidenceBundle(bundleInput);
    assert.deepEqual(replay, prepared);
    assert.equal(prepared.ref, artifactRevisionEvidenceRef(fixture.attempt.workspaceId, revisionId));
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", prepared.ref), "");

    await promoteArtifactCandidateRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
      evidence: prepared,
    });

    assert.equal(git(fixture.root, "rev-parse", artifactRevisionRef(revisionId)), candidate.commitHash);
    assert.equal(git(fixture.root, "rev-parse", artifactRevisionHistoryRef(revisionId)), candidate.commitHash);
    assert.equal(git(fixture.root, "rev-parse", prepared.ref), prepared.commitHash);
    assert.deepEqual(
      await verifyArtifactRevisionEvidenceBundle({
        ...bundleInput,
        entries: bundleInput.entries.map(({ bytes: _bytes, ...entry }) => entry),
      }),
      prepared,
    );
    assert.deepEqual(
      git(fixture.root, "ls-tree", "-r", "--name-only", prepared.treeHash).split("\n"),
      [
        "manifest.json",
        `png/sha256/${bundleInput.entries[0]!.sha256.slice(0, 2)}/${bundleInput.entries[0]!.sha256}.png`,
      ],
    );
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("Artifact Revision evidence bundle retains runtime-only candidates with an empty PNG inventory", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Evidence candidate" });
    const input = evidenceBundleInput(fixture, candidate, "revision-empty-evidence");
    const prepared = await prepareArtifactRevisionEvidenceBundle({ ...input, entries: [] });
    assert.deepEqual(prepared.subject.entries, []);
    assert.deepEqual(
      git(fixture.root, "ls-tree", "-r", "--name-only", prepared.treeHash).split("\n"),
      ["manifest.json"],
    );
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("Artifact Revision evidence bundle rejects contradictory identities for one SHA-256 blob", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Evidence candidate" });
    const input = evidenceBundleInput(fixture, candidate, "revision-contradictory-evidence");
    const original = input.entries[0]!;
    const contradictoryLength = original.byteLength + 1;
    await assert.rejects(
      prepareArtifactRevisionEvidenceBundle({
        ...input,
        entries: [
          original,
          {
            ...original,
            kind: "source",
            storageKey: `${original.storageKey}.source`,
            byteLength: contradictoryLength,
            descriptor: {
              ...original.descriptor,
              storageKey: `${original.storageKey}.source`,
              byteLength: contradictoryLength,
            },
          },
        ],
      }),
      /same SHA-256|contradictory/i,
    );
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("Artifact Revision evidence descriptors fail with a domain validation error", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Invalid evidence descriptor" });
    const input = evidenceBundleInput(fixture, candidate, "revision-invalid-evidence-descriptor");
    await assert.rejects(
      prepareArtifactRevisionEvidenceBundle({
        ...input,
        entries: [{ ...input.entries[0]!, descriptor: undefined as never }],
      }),
      ArtifactCandidateValidationError,
    );
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("Attempt ref is retained when the exact Artifact Revision evidence ref is missing", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Evidence candidate" });
    const revisionId = "revision-evidence-release-missing";
    const prepared = await prepareArtifactRevisionEvidenceBundle(
      evidenceBundleInput(fixture, candidate, revisionId),
    );
    await promoteArtifactCandidateRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
      evidence: prepared,
    });
    git(fixture.root, "update-ref", "-d", prepared.ref, prepared.commitHash);

    await assert.rejects(
      releaseArtifactCandidateAttemptRef({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        revisionId,
        candidate,
        history: [candidate],
        historyHead: candidate,
        evidence: prepared,
      }),
      /evidence|retention ref/i,
    );
    assert.equal(git(fixture.root, "rev-parse", candidate.attemptRef), candidate.commitHash);
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("Attempt ref is retained when the Artifact Revision evidence ref conflicts", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Evidence candidate" });
    const revisionId = "revision-evidence-release-conflict";
    const prepared = await prepareArtifactRevisionEvidenceBundle(
      evidenceBundleInput(fixture, candidate, revisionId),
    );
    await promoteArtifactCandidateRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
      evidence: prepared,
    });
    git(fixture.root, "update-ref", prepared.ref, fixture.baseCommitHash, prepared.commitHash);

    await assert.rejects(
      releaseArtifactCandidateAttemptRef({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        revisionId,
        candidate,
        history: [candidate],
        historyHead: candidate,
        evidence: prepared,
      }),
      /evidence|retention ref/i,
    );
    assert.equal(git(fixture.root, "rev-parse", candidate.attemptRef), candidate.commitHash);
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("promotion repairs an exact legacy Revision/history pair with its verified evidence bundle", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Legacy evidence candidate" });
    const revisionId = "revision-evidence-legacy-repair";
    const prepared = await prepareArtifactRevisionEvidenceBundle(
      evidenceBundleInput(fixture, candidate, revisionId),
    );
    git(fixture.root, "update-ref", artifactRevisionRef(revisionId), candidate.commitHash);
    git(fixture.root, "update-ref", artifactRevisionHistoryRef(revisionId), candidate.commitHash);
    git(fixture.root, "update-ref", "-d", candidate.attemptRef, candidate.commitHash);

    assert.equal(await promoteArtifactCandidateRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
      evidence: prepared,
    }), artifactRevisionRef(revisionId));
    assert.equal(git(fixture.root, "rev-parse", prepared.ref), prepared.commitHash);
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", candidate.attemptRef), "");
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("promotion rejects a self-consistent evidence commit whose tree contains an extra entry", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Extra-tree evidence candidate" });
    const revisionId = "revision-evidence-extra-tree";
    const prepared = await prepareArtifactRevisionEvidenceBundle(
      evidenceBundleInput(fixture, candidate, revisionId),
    );
    const extraBlob = gitInput(
      fixture.root,
      ["hash-object", "-w", "--stdin"],
      "not declared by the evidence manifest\n",
    );
    const forgedTree = gitInput(
      fixture.root,
      ["mktree"],
      `${git(fixture.root, "ls-tree", prepared.treeHash)}\n100644 blob ${extraBlob}\textra.bin\n`,
    );
    const timestampSeconds = Math.floor(fixture.attempt.createdAt / 1_000);
    const identity = `Dezin Evidence <daemon@dezin.local> ${timestampSeconds} +0000`;
    const forgedCommit = gitInput(
      fixture.root,
      ["hash-object", "-w", "-t", "commit", "--stdin"],
      [
        `tree ${forgedTree}`,
        `parent ${candidate.commitHash}`,
        `author ${identity}`,
        `committer ${identity}`,
        "",
        `Dezin Artifact Revision evidence ${prepared.manifestSha256}`,
        "",
      ].join("\n"),
    );

    await assert.rejects(
      promoteArtifactCandidateRef({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        revisionId,
        candidate,
        history: [candidate],
        historyHead: candidate,
        evidence: { ...prepared, treeHash: forgedTree, commitHash: forgedCommit },
      }),
      /extra entries|exactly match/i,
    );
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", artifactRevisionRef(revisionId)), "");
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", prepared.ref), "");
    assert.equal(git(fixture.root, "rev-parse", candidate.attemptRef), candidate.commitHash);
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("retained evidence survives source deletion, idempotent lifecycle replay, and Git GC", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Durable evidence candidate" });
    const revisionId = "revision-evidence-gc";
    const mutableEvidenceDir = join(fixture.root, "mutable-evidence-cache");
    const mutableEvidencePath = join(mutableEvidenceDir, "desktop.png");
    mkdirSync(mutableEvidenceDir);
    writeFileSync(mutableEvidencePath, "mutable evidence bytes\n");
    const bytes = readFileSync(mutableEvidencePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const baseInput = evidenceBundleInput(fixture, candidate, revisionId);
    const baseEntry = baseInput.entries[0]!;
    const storageKey = baseEntry.storageKey.replace(baseEntry.sha256, sha256);
    const bundleInput: PrepareArtifactRevisionEvidenceBundleInput = {
      ...baseInput,
      entries: [{
        ...baseEntry,
        storageKey,
        sha256,
        byteLength: bytes.byteLength,
        descriptor: {
          ...baseEntry.descriptor,
          storageKey,
          sha256,
          byteLength: bytes.byteLength,
        },
        bytes,
      }],
    };
    const prepared = await prepareArtifactRevisionEvidenceBundle(bundleInput);
    rmSync(mutableEvidenceDir, { recursive: true, force: true });

    const lifecycle = {
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
      evidence: prepared,
    } as const;
    assert.equal(await promoteArtifactCandidateRef(lifecycle), artifactRevisionRef(revisionId));
    assert.equal(await promoteArtifactCandidateRef(lifecycle), artifactRevisionRef(revisionId));
    assert.equal(await releaseArtifactCandidateAttemptRef(lifecycle), true);
    assert.equal(await releaseArtifactCandidateAttemptRef(lifecycle), false);

    git(fixture.root, "reflog", "expire", "--expire=now", "--all");
    git(fixture.root, "gc", "--prune=now");
    assert.deepEqual(
      await verifyArtifactRevisionEvidenceBundle({
        repositoryDir: fixture.root,
        ...prepared.subject,
      }),
      prepared,
    );
    assert.equal(git(fixture.root, "cat-file", "-t", prepared.commitHash), "commit");
    assert.equal(git(fixture.root, "cat-file", "-t", prepared.treeHash), "tree");
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", candidate.attemptRef), "");
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("Artifact Revision evidence lifecycle supports SHA-256 Git repositories", async () => {
  const fixture = repositoryFixture({ objectFormat: "sha256" });
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "SHA-256 evidence candidate" });
    const revisionId = "revision-evidence-sha256";
    const prepared = await prepareArtifactRevisionEvidenceBundle(
      evidenceBundleInput(fixture, candidate, revisionId),
    );
    assert.equal(candidate.commitHash.length, 64);
    assert.equal(candidate.treeHash.length, 64);
    assert.equal(prepared.commitHash.length, 64);
    assert.equal(prepared.treeHash.length, 64);

    const lifecycle = {
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
      evidence: prepared,
    } as const;
    await promoteArtifactCandidateRef(lifecycle);
    assert.equal(await releaseArtifactCandidateAttemptRef(lifecycle), true);
    assert.deepEqual(
      await verifyArtifactRevisionEvidenceBundle({
        repositoryDir: fixture.root,
        ...prepared.subject,
      }),
      prepared,
    );
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("candidate transaction materializes and commits the immutable Attempt base without reading live HEAD", async () => {
  const fixture = repositoryFixture({ advanceHead: true });
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    assert.equal(readFileSync(join(transaction.worktreeDir, "page.txt"), "utf8"), "base\n");
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Generate page" });

    assert.equal(git(fixture.root, "rev-parse", "HEAD"), fixture.liveCommitHash);
    assert.equal(git(fixture.root, "rev-parse", `${candidate.commitHash}^`), fixture.baseCommitHash);
    assert.equal(git(fixture.root, "rev-parse", `${candidate.commitHash}^{tree}`), candidate.treeHash);
    assert.equal(git(fixture.root, "rev-parse", candidate.attemptRef), candidate.commitHash);
    assert.equal(candidate.attemptRef, artifactCandidateAttemptRef(fixture.attempt));
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("attempt ref keeps the candidate readable after disposal, worktree pruning, and immediate GC", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
  const candidate = await transaction.commitCandidate({ message: "Generate page" });
  const worktreeDir = transaction.worktreeDir;
  await transaction.dispose();

  try {
    assert.throws(() => readFileSync(join(worktreeDir, "page.txt")), /ENOENT/);
    git(fixture.root, "worktree", "prune");
    git(fixture.root, "reflog", "expire", "--expire=now", "--all");
    git(fixture.root, "gc", "--prune=now");
    assert.equal(git(fixture.root, "cat-file", "-t", candidate.commitHash), "commit");
    assert.equal(git(fixture.root, "cat-file", "-t", candidate.treeHash), "tree");
  } finally {
    removeFixture(fixture.root);
  }
});

test("candidate plumbing ignores inherited Git overrides, replace refs, hooks, signing, and clean or smudge filters", async () => {
  const fixture = repositoryFixture();
  const markerDir = mkdtempSync(join(tmpdir(), "dezin-artifact-candidate-markers-"));
  const filterMarker = join(markerDir, "filter-ran");
  const hookMarker = join(markerDir, "hook-ran");
  const signingMarker = join(markerDir, "signing-ran");
  const filterScript = join(markerDir, "filter.sh");
  const hookScript = join(fixture.root, ".git", "hooks", "pre-commit");
  const referenceHookScript = join(fixture.root, ".git", "hooks", "reference-transaction");
  const signingScript = join(markerDir, "sign.sh");
  writeFileSync(filterScript, `#!/bin/sh\ntouch "${filterMarker}"\ncat\n`, { mode: 0o755 });
  writeFileSync(signingScript, `#!/bin/sh\ntouch "${signingMarker}"\nexit 72\n`, { mode: 0o755 });

  writeFileSync(join(fixture.root, ".gitattributes"), "page.txt filter=hostile\n");
  git(fixture.root, "add", ".gitattributes");
  git(fixture.root, "commit", "-q", "-m", "attributes");
  const attackedBase = git(fixture.root, "rev-parse", "HEAD");
  const attackedTree = git(fixture.root, "rev-parse", "HEAD^{tree}");
  const decoy = fixture.baseCommitHash;
  git(fixture.root, "config", "filter.hostile.clean", filterScript);
  git(fixture.root, "config", "filter.hostile.smudge", filterScript);
  git(fixture.root, "config", "filter.hostile.required", "true");
  git(fixture.root, "config", "commit.gpgSign", "true");
  git(fixture.root, "config", "gpg.program", signingScript);
  git(fixture.root, "update-ref", `refs/replace/${attackedBase}`, decoy);
  writeFileSync(hookScript, `#!/bin/sh\ntouch "${hookMarker}"\nexit 71\n`, { mode: 0o755 });
  writeFileSync(referenceHookScript, `#!/bin/sh\ntouch "${hookMarker}"\nexit 73\n`, { mode: 0o755 });

  const inherited = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_DIR = join(markerDir, "missing-git-dir");
  process.env.GIT_WORK_TREE = markerDir;
  process.env.GIT_INDEX_FILE = join(markerDir, "hostile-index");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "alias.commit";
  process.env.GIT_CONFIG_VALUE_0 = "!false";
  let transaction: Awaited<ReturnType<typeof beginArtifactCandidateTransaction>> | undefined;
  try {
    transaction = await beginArtifactCandidateTransaction({
      repositoryDir: fixture.root,
      attempt: {
        ...fixture.attempt,
        sourceCommitHash: attackedBase,
        sourceTreeHash: attackedTree,
      },
    });
    assert.equal(readFileSync(join(transaction.worktreeDir, "page.txt"), "utf8"), "base\n");
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const candidate = await transaction.commitCandidate({ message: "Hostile repository" });
    assert.equal(git(fixture.root, "--no-replace-objects", "rev-parse", `${candidate.commitHash}^`), attackedBase);
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), attackedBase);
    assert.throws(() => readFileSync(filterMarker), /ENOENT/);
    assert.throws(() => readFileSync(hookMarker), /ENOENT/);
    assert.throws(() => readFileSync(signingMarker), /ENOENT/);
  } finally {
    await transaction?.dispose();
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeFixture(fixture.root);
    removeFixture(markerDir);
  }
});

test("same Attempt converges idempotently and rejects a competing candidate without moving the durable ref", async () => {
  const fixture = repositoryFixture();
  const first = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  const replay = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  const competing = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  try {
    writeFileSync(join(first.worktreeDir, "page.txt"), "same\n");
    writeFileSync(join(replay.worktreeDir, "page.txt"), "same\n");
    writeFileSync(join(competing.worktreeDir, "page.txt"), "different\n");
    const [left, right] = await Promise.all([
      first.commitCandidate({ message: "Same result" }),
      replay.commitCandidate({ message: "Same result" }),
    ]);
    assert.deepEqual(right, left);
    await assert.rejects(
      competing.commitCandidate({ message: "Different result" }),
      ArtifactCandidateRefConflictError,
    );
    assert.equal(git(fixture.root, "rev-parse", left.attemptRef), left.commitHash);
  } finally {
    await Promise.all([first.dispose(), replay.dispose(), competing.dispose()]);
    removeFixture(fixture.root);
  }
});

test("response loss after Attempt ref creation replays the exact candidate", async () => {
  const fixture = repositoryFixture();
  let loseResponse = true;
  const transaction = await beginArtifactCandidateTransaction(
    { repositoryDir: fixture.root, attempt: fixture.attempt },
    {
      checkpoint(phase) {
        if (phase === "after-attempt-ref" && loseResponse) {
          loseResponse = false;
          throw new Error("simulated response loss");
        }
      },
    },
  );
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    await assert.rejects(transaction.commitCandidate({ message: "Replay me" }), /simulated response loss/);
    const retained = git(fixture.root, "rev-parse", artifactCandidateAttemptRef(fixture.attempt));
    const replayed = await transaction.commitCandidate({ message: "Replay me" });
    assert.equal(replayed.commitHash, retained);
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("an aborted candidate commit leaves source refs and the Attempt ref untouched", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  try {
    writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
    const controller = new AbortController();
    controller.abort(new Error("cancel candidate commit"));
    await assert.rejects(
      transaction.commitCandidate({ message: "Must not commit", signal: controller.signal }),
      /cancel candidate commit/,
    );
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), fixture.liveCommitHash);
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", transaction.attemptRef), "");
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("quality-loop commits advance the Attempt ref linearly while restore changes only worktree bytes", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  try {
    assert.equal(transaction.dir, transaction.worktreeDir);
    assert.equal(await transaction.fingerprint(new AbortController().signal), fixture.baseTreeHash);

    writeFileSync(join(transaction.dir, "page.txt"), "round one\n");
    const first = await transaction.commit("Round one", new AbortController().signal);
    writeFileSync(join(transaction.dir, "page.txt"), "round two\n");
    const second = await transaction.commit("Round two", new AbortController().signal);

    assert.equal(git(fixture.root, "--no-replace-objects", "rev-parse", `${first.commitHash}^`), fixture.baseCommitHash);
    assert.equal(git(fixture.root, "--no-replace-objects", "rev-parse", `${second.commitHash}^`), first.commitHash);
    assert.equal(git(fixture.root, "rev-parse", artifactCandidateAttemptRef(fixture.attempt)), second.commitHash);

    await transaction.restore(first, new AbortController().signal);
    assert.equal(readFileSync(join(transaction.dir, "page.txt"), "utf8"), "round one\n");
    assert.equal(git(fixture.root, "rev-parse", artifactCandidateAttemptRef(fixture.attempt)), second.commitHash);

    writeFileSync(join(transaction.dir, "page.txt"), "selected plus repair\n");
    const third = await transaction.commit("Repair selected", new AbortController().signal);
    assert.equal(git(fixture.root, "--no-replace-objects", "rev-parse", `${third.commitHash}^`), second.commitHash);
    assert.equal(git(fixture.root, "rev-parse", artifactCandidateAttemptRef(fixture.attempt)), third.commitHash);
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("an earlier selected Revision retains its complete Attempt history after release and immediate GC", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "best\n");
    const best = await transaction.commit("Best candidate", new AbortController().signal);
    writeFileSync(join(transaction.dir, "page.txt"), "later regression\n");
    const later = await transaction.commit("Later regression", new AbortController().signal);
    await transaction.restore(best, new AbortController().signal);

    const revisionId = "revision-selected-best";
    const revisionRef = await promoteArtifactCandidateRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate: best,
      history: [best, later],
      historyHead: later,
    });
    const historyRef = expectedArtifactRevisionHistoryRef(revisionId);
    assert.equal(git(fixture.root, "rev-parse", revisionRef), best.commitHash);
    assert.equal(git(fixture.root, "rev-parse", historyRef), later.commitHash);
    assert.equal(git(fixture.root, "rev-parse", transaction.attemptRef), later.commitHash);

    assert.equal(await releaseArtifactCandidateAttemptRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate: best,
      history: [best, later],
      historyHead: later,
    }), true);
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", transaction.attemptRef), "");
    assert.equal(git(fixture.root, "rev-parse", revisionRef), best.commitHash);
    assert.equal(git(fixture.root, "rev-parse", historyRef), later.commitHash);

    await transaction.dispose();
    git(fixture.root, "reflog", "expire", "--expire=now", "--all");
    git(fixture.root, "gc", "--prune=now");
    for (const version of [best, later]) {
      assert.equal(git(fixture.root, "cat-file", "-t", version.commitHash), "commit");
      assert.equal(git(fixture.root, "cat-file", "-t", version.treeHash), "tree");
    }
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("exports the canonical per-Revision history ref for the version viewer", () => {
  assert.equal(
    artifactRevisionHistoryRef("revision-viewer-1"),
    expectedArtifactRevisionHistoryRef("revision-viewer-1"),
  );
});

test("release retains the Attempt ref unless both selected and history Revision refs are exact", async (t) => {
  for (const mode of ["missing", "conflicting"] as const) {
    await t.test(mode, async () => {
      const fixture = repositoryFixture();
      const transaction = await beginArtifactCandidateTransaction({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
      });
      try {
        writeFileSync(join(transaction.dir, "page.txt"), "best\n");
        const best = await transaction.commit("Best candidate", new AbortController().signal);
        writeFileSync(join(transaction.dir, "page.txt"), "later\n");
        const later = await transaction.commit("Later candidate", new AbortController().signal);
        const revisionId = `revision-history-${mode}`;
        await promoteArtifactCandidateRef({
          repositoryDir: fixture.root,
          attempt: fixture.attempt,
          revisionId,
          candidate: best,
          history: [best, later],
          historyHead: later,
        });
        const historyRef = expectedArtifactRevisionHistoryRef(revisionId);
        if (mode === "missing") git(fixture.root, "update-ref", "-d", historyRef, later.commitHash);
        else git(fixture.root, "update-ref", historyRef, fixture.baseCommitHash, later.commitHash);

        await assert.rejects(
          releaseArtifactCandidateAttemptRef({
            repositoryDir: fixture.root,
            attempt: fixture.attempt,
            revisionId,
            candidate: best,
            history: [best, later],
            historyHead: later,
          }),
          /history|retention ref/i,
        );
        assert.equal(git(fixture.root, "rev-parse", transaction.attemptRef), later.commitHash);
      } finally {
        await transaction.dispose();
        removeFixture(fixture.root);
      }
    });
  }
});

test("promotion fails closed on a partial or conflicting Revision retention pair", async (t) => {
  for (const mode of ["selected-only", "conflicting-history"] as const) {
    await t.test(mode, async () => {
      const fixture = repositoryFixture();
      const transaction = await beginArtifactCandidateTransaction({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
      });
      try {
        writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
        const candidate = await transaction.commit("Candidate", new AbortController().signal);
        const revisionId = `revision-partial-${mode}`;
        const revisionRef = artifactRevisionRef(revisionId);
        const historyRef = expectedArtifactRevisionHistoryRef(revisionId);
        if (mode === "selected-only") {
          git(fixture.root, "update-ref", revisionRef, candidate.commitHash);
        } else {
          git(fixture.root, "update-ref", historyRef, fixture.baseCommitHash);
        }

        await assert.rejects(
          promoteArtifactCandidateRef({
            repositoryDir: fixture.root,
            attempt: fixture.attempt,
            revisionId,
            candidate,
            history: [candidate],
            historyHead: candidate,
          }),
          ArtifactCandidateRefConflictError,
        );
        assert.equal(git(fixture.root, "rev-parse", transaction.attemptRef), candidate.commitHash);
        if (mode === "selected-only") {
          assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", historyRef), "");
        } else {
          assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", revisionRef), "");
        }
      } finally {
        await transaction.dispose();
        removeFixture(fixture.root);
      }
    });
  }
});

test("promotion rejects a substituted version even when the selected and final history head are exact", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({
    repositoryDir: fixture.root,
    attempt: fixture.attempt,
  });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "best\n");
    const best = await transaction.commit("Best candidate", new AbortController().signal);
    writeFileSync(join(transaction.dir, "page.txt"), "later\n");
    const later = await transaction.commit("Later candidate", new AbortController().signal);
    const substitutedCommit = git(
      fixture.root,
      "commit-tree",
      best.treeHash,
      "-p",
      fixture.baseCommitHash,
      "-m",
      "substituted version",
    );
    const revisionId = "revision-substituted-version";

    await assert.rejects(
      promoteArtifactCandidateRef({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        revisionId,
        candidate: best,
        historyHead: later,
        history: [
          best,
          { commitHash: substitutedCommit, treeHash: best.treeHash },
          later,
        ],
      } as Parameters<typeof promoteArtifactCandidateRef>[0] & {
        history: ArtifactCandidateIdentity[];
      }),
      /version history|linear/i,
    );
    assert.equal(
      git(fixture.root, "for-each-ref", "--format=%(objectname)", artifactRevisionRef(revisionId)),
      "",
    );
    assert.equal(git(fixture.root, "rev-parse", transaction.attemptRef), later.commitHash);
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("the immutable base itself cannot be promoted as an Artifact candidate", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    await transaction.commit("Real candidate", new AbortController().signal);
    await assert.rejects(
      promoteArtifactCandidateRef({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        revisionId: "revision-must-not-be-base",
        candidate: {
          commitHash: fixture.baseCommitHash,
          treeHash: fixture.baseTreeHash,
        },
        historyHead: {
          commitHash: fixture.baseCommitHash,
          treeHash: fixture.baseTreeHash,
        },
        history: [{
          commitHash: fixture.baseCommitHash,
          treeHash: fixture.baseTreeHash,
        }],
      }),
      /outside the generated candidate lineage/,
    );
    assert.equal(
      git(fixture.root, "for-each-ref", "--format=%(objectname)", artifactRevisionRef("revision-must-not-be-base")),
      "",
    );
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("repository graft metadata cannot forge the selected candidate ancestry", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  try {
    writeFileSync(join(transaction.dir, "page.txt"), "candidate\n");
    const candidate = await transaction.commit("Real candidate", new AbortController().signal);
    const forgedHead = git(
      fixture.root,
      "commit-tree",
      fixture.baseTreeHash,
      "-p",
      fixture.baseCommitHash,
      "-m",
      "forged unrelated head",
    );
    git(fixture.root, "config", "advice.graftFileDeprecated", "false");
    writeFileSync(join(fixture.root, ".git", "info", "grafts"), `${forgedHead} ${candidate.commitHash}\n`);
    git(fixture.root, "update-ref", transaction.attemptRef, forgedHead, candidate.commitHash);

    await assert.rejects(
      promoteArtifactCandidateRef({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        revisionId: "revision-graft-forgery",
        candidate,
        history: [candidate, { commitHash: forgedHead, treeHash: fixture.baseTreeHash }],
        historyHead: { commitHash: forgedHead, treeHash: fixture.baseTreeHash },
      }),
      /not a descendant of the selected candidate|version history/,
    );
    assert.equal(
      git(fixture.root, "for-each-ref", "--format=%(objectname)", artifactRevisionRef("revision-graft-forgery")),
      "",
    );
  } finally {
    await transaction.dispose();
    removeFixture(fixture.root);
  }
});

test("promotion and Attempt-ref release are CAS-idempotent and never create an unreachable revision", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
  const candidate = await transaction.commitCandidate({ message: "Promote me" });
  await transaction.dispose();
  const revisionId = "revision-page-2";
  try {
    const first = await promoteArtifactCandidateRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
    });
    const replay = await promoteArtifactCandidateRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
    });
    assert.equal(first, artifactRevisionRef(revisionId));
    assert.equal(replay, first);

    assert.equal(await releaseArtifactCandidateAttemptRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
    }), true);
    assert.equal(await releaseArtifactCandidateAttemptRef({
      repositoryDir: fixture.root,
      attempt: fixture.attempt,
      revisionId,
      candidate,
      history: [candidate],
      historyHead: candidate,
    }), false);
    assert.equal(git(fixture.root, "for-each-ref", "--format=%(objectname)", candidate.attemptRef), "");
    assert.equal(git(fixture.root, "rev-parse", first), candidate.commitHash);
    assert.deepEqual(
      await verifyArtifactCandidateObject({
        repositoryDir: fixture.root,
        commitHash: candidate.commitHash,
        treeHash: candidate.treeHash,
      }),
      { commitHash: candidate.commitHash, treeHash: candidate.treeHash },
    );
  } finally {
    removeFixture(fixture.root);
  }
});

test("Attempt ref cannot be released until the exact revision ref durably retains the candidate", async () => {
  const fixture = repositoryFixture();
  const transaction = await beginArtifactCandidateTransaction({ repositoryDir: fixture.root, attempt: fixture.attempt });
  writeFileSync(join(transaction.worktreeDir, "page.txt"), "candidate\n");
  const candidate = await transaction.commitCandidate({ message: "Retain me" });
  await transaction.dispose();
  try {
    await assert.rejects(
      releaseArtifactCandidateAttemptRef({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        revisionId: "missing-revision",
        candidate,
        history: [candidate],
        historyHead: candidate,
      }),
      /durable revision ref does not retain the candidate/,
    );
    assert.equal(git(fixture.root, "rev-parse", candidate.attemptRef), candidate.commitHash);
  } finally {
    removeFixture(fixture.root);
  }
});

test("invalid exact tree, a nested repository path, and a pre-aborted signal fail without durable writes", async () => {
  const fixture = repositoryFixture();
  const nested = join(fixture.root, "nested");
  mkdirSync(nested);
  const wrongTree = "0".repeat(fixture.baseTreeHash.length);
  try {
    await assert.rejects(
      beginArtifactCandidateTransaction({
        repositoryDir: fixture.root,
        attempt: { ...fixture.attempt, sourceTreeHash: wrongTree },
      }),
      /tree/i,
    );
    await assert.rejects(
      beginArtifactCandidateTransaction({ repositoryDir: nested, attempt: fixture.attempt }),
      /repository root/i,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled before checkout"));
    await assert.rejects(
      beginArtifactCandidateTransaction({
        repositoryDir: fixture.root,
        attempt: fixture.attempt,
        signal: controller.signal,
      }),
      /cancelled before checkout/,
    );
    assert.equal(
      git(fixture.root, "for-each-ref", "--format=%(objectname)", artifactCandidateAttemptRef(fixture.attempt)),
      "",
    );
  } finally {
    removeFixture(fixture.root);
  }
});
