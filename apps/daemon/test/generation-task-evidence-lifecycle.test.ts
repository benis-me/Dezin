import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  artifactRevisionEvidenceRef,
  type
  ArtifactRevisionEvidenceBundleReceipt,
} from "../src/orchestration/artifact-candidate-transaction.ts";
import {
  GenerationTaskEvidenceLifecycle,
} from "../src/orchestration/generation-task-evidence-lifecycle.ts";
import {
  persistGenerationTaskVisualEvidenceBatch,
  type GenerationTaskVisualEvidenceDescriptor,
} from "../src/orchestration/generation-task-visual-evidence.ts";
import { sharinganFixturePng } from "./support/sharingan-capture-fixture.ts";

const FRAME = {
  id: "desktop",
  name: "Desktop",
  width: 640,
  height: 480,
  frameAttemptId: "quality-round-0-frame-0",
};

function owner(round: number) {
  const contextPackHash = "3".repeat(64);
  return {
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-1",
    attempt: 1,
    candidateCommitHash: String(round + 1).repeat(40),
    candidateTreeHash: String(round + 4).repeat(40),
    contextPackId: `context-pack-${contextPackHash}`,
    contextPackHash,
  };
}

function identity(bytes: Buffer) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    width: FRAME.width,
    height: FRAME.height,
  };
}

async function persistRound(
  dataDir: string,
  sourcePath: string,
  round: number,
): Promise<GenerationTaskVisualEvidenceDescriptor> {
  const result = await persistGenerationTaskVisualEvidenceBatch({
    dataDir,
    owner: owner(round),
    round,
    signal: new AbortController().signal,
    frames: [{
      frame: { ...FRAME, frameAttemptId: `quality-round-${round}-frame-0` },
      sourcePath,
      expectedIdentity: identity(sharinganFixturePng(FRAME.width, FRAME.height)),
    }],
  });
  return result.frames[0]!;
}

function storedPath(dataDir: string, descriptor: GenerationTaskVisualEvidenceDescriptor): string {
  return join(dataDir, ...descriptor.storageKey.split("/"));
}

function artifactCandidateEvidence(
  descriptors: readonly GenerationTaskVisualEvidenceDescriptor[],
): Record<string, unknown> {
  return {
    protocol: "dezin.artifact-run.v1",
    versions: descriptors.map((descriptor, round) => ({
      round,
      evaluationManifest: {
        protocol: "dezin.artifact-run-evaluation-manifest.v1",
        visualEvidence: [descriptor],
      },
    })),
    qualityEvidence: {
      protocol: "dezin.standard-artifact-quality.v1",
      visualEvidence: [descriptors.at(-1)!],
    },
  };
}

function durableReceipt(
  descriptors: readonly GenerationTaskVisualEvidenceDescriptor[],
): ArtifactRevisionEvidenceBundleReceipt {
  return {
    ref: artifactRevisionEvidenceRef("workspace-1", "artifact-revision-1"),
    commitHash: "a".repeat(40),
    treeHash: "b".repeat(40),
    manifestSha256: "c".repeat(64),
    subject: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      revisionId: "artifact-revision-1",
      artifactId: "artifact-1",
      trackId: "track-main",
      candidate: {
        commitHash: "1".repeat(40),
        treeHash: "4".repeat(40),
      },
      contextPackHash: "3".repeat(64),
      attempt: {
        workspaceId: "workspace-1",
        taskId: "task-1",
        attempt: 1,
        inputHash: "e".repeat(64),
        createdAt: 1_700_000_000_000,
        sourceCommitHash: "5".repeat(40),
        sourceTreeHash: "6".repeat(40),
      },
      candidateEvidenceSha256: "f".repeat(64),
      entries: descriptors.map((descriptor) => ({
        kind: "frame" as const,
        round: descriptor.round,
        storageKey: descriptor.storageKey,
        sha256: descriptor.sha256,
        byteLength: descriptor.byteLength,
        descriptor: structuredClone(descriptor) as unknown as Readonly<Record<string, unknown>>,
      })),
    },
  };
}

test("evidence recovery quarantines then removes terminal Attempt files with no candidate owner", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-orphan-"));
  const sourcePath = join(dataDir, "source.png");
  const png = sharinganFixturePng(FRAME.width, FRAME.height);
  writeFileSync(sourcePath, png);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const descriptor = await persistRound(dataDir, sourcePath, 0);
  const store = {
    getGenerationTaskAttemptForProject() {
      return {
        taskId: "task-1",
        planId: "plan-1",
        workspaceId: "workspace-1",
        attempt: 1,
        status: "failed",
        candidateEvidence: null,
      };
    },
  };
  const lifecycle = new GenerationTaskEvidenceLifecycle({ dataDir, store });

  const first = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(first, { scanned: 1, retained: 0, quarantined: 1, restored: 0, removed: 0, failed: 0 });
  assert.equal(existsSync(storedPath(dataDir, descriptor)), false);

  const second = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(second, { scanned: 1, retained: 0, quarantined: 0, restored: 0, removed: 1, failed: 0 });
  assert.equal(existsSync(storedPath(dataDir, descriptor)), false);
});

test("evidence recovery retains every referenced round and isolates only unbound extras", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-owned-"));
  const sourcePath = join(dataDir, "source.png");
  const png = sharinganFixturePng(FRAME.width, FRAME.height);
  writeFileSync(sourcePath, png);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const failedRound = await persistRound(dataDir, sourcePath, 0);
  const selectedRound = await persistRound(dataDir, sourcePath, 1);
  const unboundRound = await persistRound(dataDir, sourcePath, 2);
  const attempt = {
    taskId: "task-1",
    planId: "plan-1",
    workspaceId: "workspace-1",
    attempt: 1,
    status: "candidate-ready",
    candidateEvidence: artifactCandidateEvidence([failedRound, selectedRound]),
  };
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: { getGenerationTaskAttemptForProject() { return attempt; } },
  });

  const result = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(result, { scanned: 3, retained: 2, quarantined: 1, restored: 0, removed: 0, failed: 0 });
  assert.equal(existsSync(storedPath(dataDir, failedRound)), true, "failed non-selected round is owned history");
  assert.equal(existsSync(storedPath(dataDir, selectedRound)), true, "selected round is owned history");
  assert.equal(existsSync(storedPath(dataDir, unboundRound)), false, "unbound extra is isolated");
});

test("quarantined evidence is restored when an exact candidate owner appears before deletion", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-restore-"));
  const sourcePath = join(dataDir, "source.png");
  const png = sharinganFixturePng(FRAME.width, FRAME.height);
  writeFileSync(sourcePath, png);
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const descriptor = await persistRound(dataDir, sourcePath, 0);
  let candidateEvidence: Record<string, unknown> | null = null;
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: {
      getGenerationTaskAttemptForProject() {
        return {
          taskId: "task-1",
          planId: "plan-1",
          workspaceId: "workspace-1",
          attempt: 1,
          status: candidateEvidence === null ? "failed" : "candidate-ready",
          candidateEvidence,
        };
      },
    },
  });
  await lifecycle.recover(new AbortController().signal);
  assert.equal(existsSync(storedPath(dataDir, descriptor)), false);
  candidateEvidence = artifactCandidateEvidence([descriptor]);

  const result = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(result, { scanned: 1, retained: 0, quarantined: 0, restored: 1, removed: 0, failed: 0 });
  assert.equal(existsSync(storedPath(dataDir, descriptor)), true);
});

test("verified immutable publication quarantines only its exact mutable cache and never restores it", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-published-cache-"));
  const sourcePath = join(dataDir, "source.png");
  writeFileSync(sourcePath, sharinganFixturePng(FRAME.width, FRAME.height));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = await persistRound(dataDir, sourcePath, 0);
  const selected = await persistRound(dataDir, sourcePath, 1);
  const candidateEvidence = artifactCandidateEvidence([first, selected]);
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: {
      getGenerationTaskAttemptForProject() {
        return {
          taskId: "task-1",
          planId: "plan-1",
          workspaceId: "workspace-1",
          attempt: 1,
          status: "succeeded",
          candidateEvidence,
        };
      },
    },
  });

  const isolated = await lifecycle.quarantineDurablePublishedEvidence({
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-1",
    attempt: 1,
    receipt: durableReceipt([first, selected]),
  }, new AbortController().signal);
  assert.deepEqual(isolated, {
    scanned: 2,
    retained: 0,
    quarantined: 2,
    restored: 0,
    removed: 0,
    failed: 0,
  });
  assert.equal(existsSync(storedPath(dataDir, first)), false);
  assert.equal(existsSync(storedPath(dataDir, selected)), false);

  const replayed = await lifecycle.quarantineDurablePublishedEvidence({
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-1",
    attempt: 1,
    receipt: durableReceipt([first, selected]),
  }, new AbortController().signal);
  assert.deepEqual(replayed, {
    scanned: 2,
    retained: 0,
    quarantined: 2,
    restored: 0,
    removed: 0,
    failed: 0,
  });

  const recovered = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(recovered, {
    scanned: 2,
    retained: 0,
    quarantined: 0,
    restored: 0,
    removed: 2,
    failed: 0,
  });
  assert.equal(existsSync(storedPath(dataDir, first)), false);
  assert.equal(existsSync(storedPath(dataDir, selected)), false);

  const alreadyRemoved = await lifecycle.quarantineDurablePublishedEvidence({
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-1",
    attempt: 1,
    receipt: durableReceipt([first, selected]),
  }, new AbortController().signal);
  assert.deepEqual(alreadyRemoved, {
    scanned: 2,
    retained: 0,
    quarantined: 0,
    restored: 0,
    removed: 2,
    failed: 0,
  });
});

test("durable publication receipt ownership is validated before any cache file moves", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-invalid-receipt-"));
  const sourcePath = join(dataDir, "source.png");
  writeFileSync(sourcePath, sharinganFixturePng(FRAME.width, FRAME.height));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = await persistRound(dataDir, sourcePath, 0);
  const second = await persistRound(dataDir, sourcePath, 1);
  const receipt = durableReceipt([first, second]);
  const changed: ArtifactRevisionEvidenceBundleReceipt = {
    ...receipt,
    subject: {
      ...receipt.subject,
      entries: receipt.subject.entries.map((entry, index) => index === 1
        ? {
          ...entry,
          storageKey: entry.storageKey.replace("/task-1/", "/task-substituted/"),
        }
        : entry),
    },
  };
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: { getGenerationTaskAttemptForProject() { return null; } },
  });

  await assert.rejects(lifecycle.quarantineDurablePublishedEvidence({
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-1",
    attempt: 1,
    receipt: changed,
  }, new AbortController().signal), /receipt|ownership/i);
  assert.equal(existsSync(storedPath(dataDir, first)), true);
  assert.equal(existsSync(storedPath(dataDir, second)), true);
});

test("runtime-only immutable publication with zero PNG entries is a successful cleanup no-op", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-runtime-only-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: { getGenerationTaskAttemptForProject() { return null; } },
  });

  assert.deepEqual(await lifecycle.quarantineDurablePublishedEvidence({
    projectId: "project-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    taskId: "task-1",
    attempt: 1,
    receipt: durableReceipt([]),
  }, new AbortController().signal), {
    scanned: 0,
    retained: 0,
    quarantined: 0,
    restored: 0,
    removed: 0,
    failed: 0,
  });
});

test("evidence recovery fails closed when Store returns an invalid non-null owner", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-invalid-owner-"));
  const sourcePath = join(dataDir, "source.png");
  writeFileSync(sourcePath, sharinganFixturePng(FRAME.width, FRAME.height));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const descriptor = await persistRound(dataDir, sourcePath, 0);
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: {
      getGenerationTaskAttemptForProject() {
        return {
          taskId: "substituted-task",
          planId: "plan-1",
          workspaceId: "workspace-1",
          attempt: 1,
          status: "failed",
          candidateEvidence: null,
        };
      },
    },
  });

  const result = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(result, { scanned: 1, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 1 });
  assert.equal(existsSync(storedPath(dataDir, descriptor)), true);
});

test("malformed candidate evidence retains the whole Attempt instead of accepting partial references", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-malformed-owner-"));
  const sourcePath = join(dataDir, "source.png");
  writeFileSync(sourcePath, sharinganFixturePng(FRAME.width, FRAME.height));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = await persistRound(dataDir, sourcePath, 0);
  const second = await persistRound(dataDir, sourcePath, 1);
  const malformed = artifactCandidateEvidence([first, second]);
  ((malformed.versions as Array<Record<string, unknown>>)[1]!.evaluationManifest as Record<string, unknown>)
    .visualEvidence = "not-an-array";
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: {
      getGenerationTaskAttemptForProject() {
        return {
          taskId: "task-1",
          planId: "plan-1",
          workspaceId: "workspace-1",
          attempt: 1,
          status: "candidate-ready",
          candidateEvidence: malformed,
        };
      },
    },
  });

  const result = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(result, { scanned: 0, retained: 0, quarantined: 0, restored: 0, removed: 0, failed: 1 });
  assert.equal(existsSync(storedPath(dataDir, first)), true);
  assert.equal(existsSync(storedPath(dataDir, second)), true);
});

test("recovery removes an empty interrupted quarantine reservation before retrying isolation", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-partial-quarantine-"));
  const sourcePath = join(dataDir, "source.png");
  writeFileSync(sourcePath, sharinganFixturePng(FRAME.width, FRAME.height));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const descriptor = await persistRound(dataDir, sourcePath, 0);
  const token = createHash("sha256").update(descriptor.storageKey, "utf8").digest("hex");
  mkdirSync(join(
    dataDir,
    "generation-task-evidence",
    "project-1",
    ".quarantine",
    token,
  ), { recursive: true });
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: {
      getGenerationTaskAttemptForProject() {
        return {
          taskId: "task-1",
          planId: "plan-1",
          workspaceId: "workspace-1",
          attempt: 1,
          status: "failed",
          candidateEvidence: null,
        };
      },
    },
  });

  const result = await lifecycle.recover(new AbortController().signal);
  assert.deepEqual(result, { scanned: 2, retained: 0, quarantined: 1, restored: 0, removed: 1, failed: 0 });
  assert.equal(existsSync(storedPath(dataDir, descriptor)), false);
});

test("evidence recovery rejects a symlinked storage root without touching its target", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "dezin-evidence-lifecycle-symlink-outside-"));
  const sentinel = join(outside, "sentinel.png");
  writeFileSync(sentinel, sharinganFixturePng(FRAME.width, FRAME.height));
  symlinkSync(outside, join(dataDir, "generation-task-evidence"), "dir");
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const lifecycle = new GenerationTaskEvidenceLifecycle({
    dataDir,
    store: { getGenerationTaskAttemptForProject() { return null; } },
  });

  await assert.rejects(lifecycle.recover(new AbortController().signal), /canonical directory/i);
  assert.equal(existsSync(sentinel), true);
});
