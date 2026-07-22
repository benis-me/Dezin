import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GenerationTaskSourceBaseRequest } from "../src/orchestration/generation-plan-service.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(root: string, body: string): { commitHash: string; treeHash: string } {
  writeFileSync(join(root, "index.html"), `${body}\n`, "utf8");
  git(root, "add", "index.html");
  git(root, "commit", "-q", "-m", body);
  return {
    commitHash: git(root, "rev-parse", "HEAD^{commit}"),
    treeHash: git(root, "rev-parse", "HEAD^{tree}"),
  };
}

function sourceRequest(baseRevisionId: string | null): GenerationTaskSourceBaseRequest {
  return {
    projectId: "project-1",
    planId: "plan-1",
    task: {
      id: "task-page",
      planId: "plan-1",
      workspaceId: "workspace-1",
      kind: "page",
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-page",
        trackId: "track-page",
      },
    },
    observation: {
      taskId: "task-page",
      planId: "plan-1",
      workspaceId: "workspace-1",
      attempt: 1,
      target: {
        type: "artifact",
        workspaceId: "workspace-1",
        id: "artifact-page",
        trackId: "track-page",
      },
      baseRevisionId,
      expectedSnapshotId: "snapshot-1",
      kernelRevisionId: "kernel-1",
      payload: {},
      dependencyOutputs: [],
      resourcePins: [],
      componentPins: [],
    },
  } as unknown as GenerationTaskSourceBaseRequest;
}

test("Git Source Base resolution uses the exact durable Artifact Revision instead of a newer live HEAD", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-source-base-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  const base = commit(root, "base");
  const live = commit(root, "live-head");
  assert.notEqual(base.commitHash, live.commitHash);

  const module = await import("../src/orchestration/git-source-base-resolver.ts");
  const resolver = new module.GitArtifactSourceBaseResolver({
    workspace: {
      getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }),
      getArtifact: () => ({
        id: "artifact-page",
        workspaceId: "workspace-1",
        kind: "page",
        activeTrackId: "track-page",
        archivedAt: null,
      }),
      getArtifactRevision: (id: string) => id === "revision-base" ? {
        id,
        workspaceId: "workspace-1",
        artifactId: "artifact-page",
        trackId: "track-page",
        sourceCommitHash: base.commitHash,
        sourceTreeHash: base.treeHash,
      } : null,
    },
    repositoryDirForWorkspace: () => root,
  });

  const resolved = await resolver.resolve(
    sourceRequest("revision-base"),
    new AbortController().signal,
  );

  assert.deepEqual(resolved, {
    sourceCommitHash: base.commitHash,
    sourceTreeHash: base.treeHash,
  });
  assert.equal(Object.isFrozen(resolved), true);
});

test("Git Source Base resolution snapshots one exact commit/tree for a new Artifact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-source-base-create-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  const initial = commit(root, "initial");

  const module = await import("../src/orchestration/git-source-base-resolver.ts");
  const resolver = new module.GitArtifactSourceBaseResolver({
    workspace: {
      getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }),
      getArtifact: () => ({
        id: "artifact-page",
        workspaceId: "workspace-1",
        kind: "page",
        activeTrackId: "track-page",
        archivedAt: null,
      }),
      getArtifactRevision: () => null,
    },
    repositoryDirForWorkspace: () => root,
  });

  const resolved = await resolver.resolve(sourceRequest(null), new AbortController().signal);
  commit(root, "later");

  assert.deepEqual(resolved, {
    sourceCommitHash: initial.commitHash,
    sourceTreeHash: initial.treeHash,
  });
});

test("Git Source Base resolution fails closed when durable Revision identity does not match Git", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dezin-source-base-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@dezin.local");
  const base = commit(root, "base");

  const module = await import("../src/orchestration/git-source-base-resolver.ts");
  const resolver = new module.GitArtifactSourceBaseResolver({
    workspace: {
      getWorkspace: () => ({ id: "workspace-1", projectId: "project-1" }),
      getArtifact: () => ({
        id: "artifact-page",
        workspaceId: "workspace-1",
        kind: "page",
        activeTrackId: "track-page",
        archivedAt: null,
      }),
      getArtifactRevision: () => ({
        id: "revision-base",
        workspaceId: "workspace-1",
        artifactId: "artifact-page",
        trackId: "track-page",
        sourceCommitHash: base.commitHash,
        sourceTreeHash: "f".repeat(40),
      }),
    },
    repositoryDirForWorkspace: () => root,
  });

  await assert.rejects(
    resolver.resolve(sourceRequest("revision-base"), new AbortController().signal),
    /tree.*does not match|Source Base.*mismatch/i,
  );
});
