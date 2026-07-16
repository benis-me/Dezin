import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSharinganCaptureBundleFence,
  fenceArtifactCandidateTransaction,
  SharinganCaptureReferenceError,
  type ImmutableSharinganCaptureReference,
} from "../src/orchestration/sharingan-capture-reference.ts";

const REFERENCE: ImmutableSharinganCaptureReference = Object.freeze({
  workspaceId: "workspace-1",
  contextPackId: `context-pack-${"a".repeat(64)}`,
  contextPackHash: "a".repeat(64),
  resourceId: "capture-1",
  revisionId: "capture-revision-1",
  revisionChecksum: "b".repeat(64),
});

async function fixture(): Promise<{
  root: string;
  worktree: string;
  fence: Awaited<ReturnType<typeof createSharinganCaptureBundleFence>>;
}> {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-reference-"));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, ".sharingan", "entry"), { recursive: true });
  await writeFile(
    join(worktree, ".sharingan", "pages.json"),
    JSON.stringify({ pages: [{ id: "entry", screenshot: "entry/source.png" }] }),
  );
  await writeFile(join(worktree, ".sharingan", "entry", "source.png"), Buffer.from("exact-source-pixels"));
  const fence = await createSharinganCaptureBundleFence({
    reference: REFERENCE,
    worktreeDir: worktree,
    signal: new AbortController().signal,
  });
  return { root, worktree, fence };
}

test("the immutable Sharingan fence detects missing and byte-substituted bundle content", async () => {
  const input = await fixture();
  try {
    assert.match(input.fence.fingerprint, /^[0-9a-f]{64}$/);
    await input.fence.verify(new AbortController().signal);

    await writeFile(join(input.worktree, ".sharingan", "entry", "source.png"), Buffer.from("substituted"));
    await assert.rejects(
      input.fence.verify(new AbortController().signal),
      (error) => error instanceof SharinganCaptureReferenceError
        && error.code === "bundle-fingerprint-mismatch"
        && error.failureClass === "context",
    );

    rmSync(join(input.worktree, ".sharingan"), { recursive: true, force: true });
    await assert.rejects(
      input.fence.verify(new AbortController().signal),
      (error) => error instanceof SharinganCaptureReferenceError
        && error.code === "bundle-missing"
        && error.failureClass === "context",
    );
  } finally {
    await input.fence.dispose().catch(() => {});
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("candidate fingerprint, commit, and restore never observe or retain the reference sidecar", async () => {
  const input = await fixture();
  const observed: Array<{ operation: string; bundleVisible: boolean }> = [];
  const transaction = fenceArtifactCandidateTransaction({
    dir: input.worktree,
    attemptRef: "refs/dezin/generation-attempts/artifacts/fixture",
    async fingerprint() {
      observed.push({
        operation: "fingerprint",
        bundleVisible: await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8")
          .then(() => true, () => false),
      });
      return "project-tree";
    },
    async commit() {
      observed.push({
        operation: "commit",
        bundleVisible: await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8")
          .then(() => true, () => false),
      });
      return { commitHash: "1".repeat(40), treeHash: "2".repeat(40) };
    },
    async restore() {
      observed.push({
        operation: "restore",
        bundleVisible: await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8")
          .then(() => true, () => false),
      });
      await mkdir(input.worktree, { recursive: true });
    },
    async dispose() {},
  }, input.fence);

  try {
    assert.equal(await transaction.fingerprint(new AbortController().signal), "project-tree");
    await transaction.commit("candidate", new AbortController().signal);
    await transaction.restore({ commitHash: "1".repeat(40), treeHash: "2".repeat(40) }, new AbortController().signal);
    assert.deepEqual(observed, [
      { operation: "fingerprint", bundleVisible: false },
      { operation: "commit", bundleVisible: false },
      { operation: "restore", bundleVisible: false },
    ]);
    assert.match(await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8"), /entry/);
    await input.fence.verify(new AbortController().signal);
  } finally {
    await transaction.dispose().catch(() => {});
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("commit and restore failures still restore the exact reference sidecar", async (t) => {
  for (const operation of ["commit", "restore"] as const) {
    await t.test(operation, async () => {
      const input = await fixture();
      const transaction = fenceArtifactCandidateTransaction({
        dir: input.worktree,
        attemptRef: "refs/dezin/generation-attempts/artifacts/fixture",
        async fingerprint() { return "project-tree"; },
        async commit() { throw new Error("commit failed"); },
        async restore() { throw new Error("restore failed"); },
        async dispose() {},
      }, input.fence);
      try {
        if (operation === "commit") {
          await assert.rejects(
            transaction.commit("candidate", new AbortController().signal),
            /commit failed/,
          );
        } else {
          await assert.rejects(
            transaction.restore(
              { commitHash: "1".repeat(40), treeHash: "2".repeat(40) },
              new AbortController().signal,
            ),
            /restore failed/,
          );
        }
        await input.fence.verify(new AbortController().signal);
        assert.match(await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8"), /entry/);
      } finally {
        await transaction.dispose().catch(() => {});
        rmSync(input.root, { recursive: true, force: true });
      }
    });
  }
});
