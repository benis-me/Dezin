import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeProbeCli } from "../src/sharingan-probe-cli.ts";
import {
  createSharinganCaptureBundleFence,
  fenceArtifactCandidateTransaction,
  resolveSharinganFingerprintOpenFlags,
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
  await mkdir(join(worktree, "public", "_assets"), { recursive: true });
  await writeFile(join(worktree, "public", "_assets", "source-logo.png"), Buffer.from("exact-source-logo"));
  await writeFile(join(worktree, "public", "candidate-owned.txt"), Buffer.from("candidate-owned-public-file"));
  const fence = await createSharinganCaptureBundleFence({
    reference: REFERENCE,
    worktreeDir: worktree,
    signal: new AbortController().signal,
  });
  return { root, worktree, fence };
}

test("Sharingan fingerprinting fails closed without non-blocking no-follow file opens", () => {
  assert.equal(resolveSharinganFingerprintOpenFlags({ O_NOFOLLOW: 1, O_NONBLOCK: undefined }), null);
  assert.equal(resolveSharinganFingerprintOpenFlags({ O_NOFOLLOW: undefined, O_NONBLOCK: 1 }), null);
  assert.equal(resolveSharinganFingerprintOpenFlags({ O_NOFOLLOW: 1, O_NONBLOCK: 2 }), 3);
});

test("the fingerprint fence rejects a regular-to-FIFO swap without blocking", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-reference-fifo-"));
  const worktree = join(root, "worktree");
  const pages = join(worktree, ".sharingan", "pages.json");
  await mkdir(join(worktree, ".sharingan"), { recursive: true });
  await writeFile(pages, "{\"pages\":[]}\n");
  let swapped = false;
  try {
    await assert.rejects(
      createSharinganCaptureBundleFence({
        reference: REFERENCE,
        worktreeDir: worktree,
        signal: new AbortController().signal,
        async afterFingerprintFileLstat(path) {
          if (swapped || !path.endsWith("/.sharingan/pages.json")) return;
          swapped = true;
          await rm(path);
          execFileSync("/usr/bin/mkfifo", [path]);
        },
      }),
      (error) => error instanceof SharinganCaptureReferenceError && error.code === "bundle-unsafe",
    );
    assert.equal(swapped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

    await writeFile(join(input.worktree, ".sharingan", "entry", "source.png"), Buffer.from("exact-source-pixels"));
    await writeFile(join(input.worktree, "public", "_assets", "source-logo.png"), Buffer.from("substituted-logo"));
    await assert.rejects(
      input.fence.verify(new AbortController().signal),
      (error) => error instanceof SharinganCaptureReferenceError
        && error.code === "bundle-fingerprint-mismatch",
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

test("the immutable Sharingan fence rejects an unbounded directory hierarchy before hashing", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-reference-depth-"));
  const worktree = join(root, "worktree");
  let directory = join(worktree, ".sharingan");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "pages.json"), "{}\n");
  for (let index = 0; index < 65; index += 1) {
    directory = join(directory, `depth-${index}`);
    await mkdir(directory);
  }
  try {
    await assert.rejects(
      createSharinganCaptureBundleFence({
        reference: REFERENCE,
        worktreeDir: worktree,
        signal: new AbortController().signal,
      }),
      (error) => error instanceof SharinganCaptureReferenceError && error.code === "bundle-unbounded",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("immutable source-scaffold emits bounded JSON without changing either pinned root or worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-sharingan-derived-scaffold-"));
  const worktree = join(root, "worktree");
  const captureDir = join(worktree, ".sharingan", "entry");
  await Promise.all([
    mkdir(captureDir, { recursive: true }),
    mkdir(join(worktree, "public", "_assets"), { recursive: true }),
  ]);
  writeProbeCli(worktree, "http://127.0.0.1:9/api/sharingan/immutable");
  await Promise.all([
    writeFile(join(worktree, ".sharingan", "pages.json"), JSON.stringify({
      entryUrl: "https://example.test/source",
      pages: [{
        url: "https://example.test/source",
        renderMap: ".sharingan/entry/render-map.json",
        assets: ".sharingan/entry/assets.json",
      }],
    })),
    writeFile(join(captureDir, "render-map.json"), JSON.stringify({
      viewport: { width: 1440, height: 900 },
      document: { width: 1440, height: 900 },
      elements: [],
    })),
    writeFile(join(captureDir, "assets.json"), "[]\n"),
    writeFile(join(worktree, "public", "_assets", "source-logo.png"), "exact-source-logo"),
  ]);
  const fence = await createSharinganCaptureBundleFence({
    reference: REFERENCE,
    worktreeDir: worktree,
    signal: new AbortController().signal,
  });
  try {
    const rawScaffold = execFileSync("node", [
      join(worktree, ".sharingan", "probe.mjs"),
      "source-scaffold",
      "--stdout",
    ], { cwd: worktree, encoding: "utf8" });
    await fence.verify(new AbortController().signal);
    const scaffold = JSON.parse(rawScaffold) as {
      protocol?: string;
      source?: { pageUrl?: string };
      regionPlan?: { sourceUrl?: string };
    };
    assert.equal(scaffold.protocol, "dezin.sharingan-source-scaffold.v1");
    assert.equal(scaffold.source?.pageUrl, "https://example.test/source");
    assert.equal(scaffold.regionPlan?.sourceUrl, "https://example.test/source");
    assert.equal(
      await readFile(join(worktree, ".sharingan", "region-plan.json"), "utf8").then(() => true, () => false),
      false,
    );
    assert.equal(
      await readFile(join(worktree, ".sharingan", "source-scaffold", "App.jsx"), "utf8").then(() => true, () => false),
      false,
    );
    assert.equal(
      await readFile(join(worktree, ".dezin", "sharingan-source", "source-scaffold", "App.jsx"), "utf8")
        .then(() => true, () => false),
      false,
    );
  } finally {
    await fence.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate fingerprint, commit, and restore never observe either materialized reference root", async () => {
  const input = await fixture();
  const observed: Array<{ operation: string; bundleVisible: boolean; assetsVisible: boolean }> = [];
  const transaction = fenceArtifactCandidateTransaction({
    dir: input.worktree,
    attemptRef: "refs/dezin/generation-attempts/artifacts/fixture",
    async fingerprint() {
      observed.push({
        operation: "fingerprint",
        bundleVisible: await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8")
          .then(() => true, () => false),
        assetsVisible: await readFile(join(input.worktree, "public", "_assets", "source-logo.png"), "utf8")
          .then(() => true, () => false),
      });
      return "project-tree";
    },
    async commit() {
      observed.push({
        operation: "commit",
        bundleVisible: await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8")
          .then(() => true, () => false),
        assetsVisible: await readFile(join(input.worktree, "public", "_assets", "source-logo.png"), "utf8")
          .then(() => true, () => false),
      });
      return { commitHash: "1".repeat(40), treeHash: "2".repeat(40) };
    },
    async restore() {
      observed.push({
        operation: "restore",
        bundleVisible: await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8")
          .then(() => true, () => false),
        assetsVisible: await readFile(join(input.worktree, "public", "_assets", "source-logo.png"), "utf8")
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
      { operation: "fingerprint", bundleVisible: false, assetsVisible: false },
      { operation: "commit", bundleVisible: false, assetsVisible: false },
      { operation: "restore", bundleVisible: false, assetsVisible: false },
    ]);
    assert.match(await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8"), /entry/);
    assert.equal(await readFile(join(input.worktree, "public", "_assets", "source-logo.png"), "utf8"), "exact-source-logo");
    assert.equal(await readFile(join(input.worktree, "public", "candidate-owned.txt"), "utf8"), "candidate-owned-public-file");
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

test("candidate-owned public mutations survive atomic source-asset isolation", async () => {
  const input = await fixture();
  const transaction = fenceArtifactCandidateTransaction({
    dir: input.worktree,
    attemptRef: "refs/dezin/generation-attempts/artifacts/fixture",
    async fingerprint() {
      await writeFile(join(input.worktree, "public", "generated.png"), "candidate output\n");
      return "project-tree";
    },
    async commit() { throw new Error("not used"); },
    async restore() {},
    async dispose() {},
  }, input.fence);
  try {
    await transaction.fingerprint(new AbortController().signal);
    assert.equal(await readFile(join(input.worktree, "public", "generated.png"), "utf8"), "candidate output\n");
    assert.equal(await readFile(join(input.worktree, "public", "_assets", "source-logo.png"), "utf8"), "exact-source-logo");
    await input.fence.verify(new AbortController().signal);
  } finally {
    await transaction.dispose().catch(() => {});
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("asset-hidden QA keeps immutable capture evidence readable and restores the runtime sidecar", async () => {
  const input = await fixture();
  try {
    await input.fence.withoutMaterializedAssets(async () => {
      assert.match(await readFile(join(input.worktree, ".sharingan", "pages.json"), "utf8"), /entry/);
      await assert.rejects(readFile(join(input.worktree, "public", "_assets", "source-logo.png")));
      assert.equal(
        await readFile(join(input.worktree, "public", "candidate-owned.txt"), "utf8"),
        "candidate-owned-public-file",
      );
    }, new AbortController().signal);
    assert.equal(await readFile(join(input.worktree, "public", "_assets", "source-logo.png"), "utf8"), "exact-source-logo");
    await input.fence.verify(new AbortController().signal);
  } finally {
    await input.fence.dispose().catch(() => {});
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("a candidate cannot redirect public source-asset cleanup through a symlink", async () => {
  const input = await fixture();
  const external = mkdtempSync(join(tmpdir(), "dezin-sharingan-external-"));
  await mkdir(join(external, "_assets"), { recursive: true });
  await writeFile(join(external, "_assets", "owner.txt"), "external owner\n");
  const transaction = fenceArtifactCandidateTransaction({
    dir: input.worktree,
    attemptRef: "refs/dezin/generation-attempts/artifacts/fixture",
    async fingerprint() {
      await rm(join(input.worktree, "public"), { recursive: true, force: true });
      await symlink(external, join(input.worktree, "public"));
      return "malicious-tree";
    },
    async commit() { throw new Error("not used"); },
    async restore() {},
    async dispose() {},
  }, input.fence);
  try {
    await assert.rejects(
      transaction.fingerprint(new AbortController().signal),
      (error) => error instanceof SharinganCaptureReferenceError
        && (error.code === "bundle-operation-conflict" || error.code === "bundle-cleanup-failed" || error.code === "bundle-unsafe"),
    );
    assert.equal(await readFile(join(external, "_assets", "owner.txt"), "utf8"), "external owner\n");
    assert.equal(await readFile(join(input.worktree, "public", "_assets", "source-logo.png"), "utf8"), "exact-source-logo");
  } finally {
    await transaction.dispose().catch(() => {});
    rmSync(input.root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
