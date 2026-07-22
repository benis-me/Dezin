import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, type StoreClock } from "../src/index.ts";

function clock(): StoreClock {
  let now = 10_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `version-workflow-${++id}`,
  };
}

function createArtifactWorkspace({ driftKernel = false }: { driftKernel?: boolean } = {}) {
  const store = new Store(":memory:", clock());
  const project = store.createProject({ name: "Artifact versions", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "add-page",
      type: "add-node",
      node: {
        id: "page-node",
        kind: "page",
        name: "Storefront",
        artifactId: "page-artifact",
        createIdentity: { initialTrackId: "page-main" },
      },
    }],
  });
  const createRevision = (parentRevisionId: string | null, source: string) => (
    store.workspace.createArtifactRevision({
      artifactId: "page-artifact",
      trackId: "page-main",
      parentRevisionId,
      sourceCommitHash: `commit-${source}`,
      sourceTreeHash: `tree-${source}`,
      kernelRevisionId: workspace.activeKernelRevisionId,
      renderSpec: { frames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }], source },
      quality: { state: "passed", score: source === "first" ? 91 : 97, findings: [] },
      contextPackHash: `context-${source}`,
      dependencies: [],
      resourcePins: [],
    })
  );
  const first = createRevision(null, "first");
  const firstSnapshot = store.workspace.publishArtifactRevision(first.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
  });
  const second = createRevision(first.id, "second");
  const secondSnapshot = store.workspace.publishArtifactRevision(second.id, {
    expectedHeadRevisionId: first.id,
    expectedSnapshotId: firstSnapshot.id,
  });
  if (!driftKernel) return { store, project, first, second, secondSnapshot };
  const nextKernel = store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: { accent: "#2563eb" },
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Version action current Kernel",
    terminology: {},
    exclusions: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  });
  const currentSnapshot = store.workspace.publishKernelRevision(nextKernel.id, {
    expectedKernelRevisionId: workspace.activeKernelRevisionId,
    expectedSnapshotId: secondSnapshot.id,
  });
  return { store, project, first, second, secondSnapshot: currentSnapshot, nextKernel };
}

test("restoring an Artifact version rebases onto the current Kernel and requires fresh validation", () => {
  const { store, project, first, second, secondSnapshot, nextKernel } = createArtifactWorkspace({ driftKernel: true });
  try {
    const result = store.workspace.restoreArtifactRevisionForProject(project.id, "page-artifact", {
      sourceRevisionId: first.id,
      expectedHeadRevisionId: second.id,
      expectedSnapshotId: secondSnapshot.id,
    });

    assert.equal(result.action, "restore-as-new-revision");
    assert.notEqual(result.revision.id, first.id);
    assert.equal(result.revision.trackId, "page-main");
    assert.equal(result.revision.parentRevisionId, second.id);
    assert.equal(result.revision.sourceCommitHash, first.sourceCommitHash);
    assert.equal(result.revision.sourceTreeHash, first.sourceTreeHash);
    assert.deepEqual(result.revision.renderSpec, first.renderSpec);
    assert.equal(result.revision.kernelRevisionId, nextKernel?.id);
    assert.deepEqual(result.revision.quality, {
      state: "unassessed",
      score: null,
      findings: [],
      reason: "restored-needs-revalidation",
    });
    assert.equal(result.revision.contextPackHash, null);
    assert.equal(result.snapshot.reason, "artifact-restored");
    assert.deepEqual(result.snapshot.provenance, { kind: "restore", restoredRevisionId: first.id });
    assert.equal(result.snapshot.artifactRevisions["page-artifact"], result.revision.id);
    assert.equal(store.workspace.getTrack("page-main")?.headRevisionId, result.revision.id);
    assert.deepEqual(store.workspace.getArtifactRevision(first.id), first);
    assert.deepEqual(store.workspace.getArtifactRevision(second.id), second);

    const revisionCount = store.workspace.listRevisions(project.id, "page-artifact").length;
    assert.throws(() => store.workspace.restoreArtifactRevisionForProject(project.id, "page-artifact", {
      sourceRevisionId: first.id,
      expectedHeadRevisionId: second.id,
      expectedSnapshotId: secondSnapshot.id,
    }), /pointer|Head|Snapshot/i);
    assert.equal(store.workspace.listRevisions(project.id, "page-artifact").length, revisionCount);
  } finally {
    store.close();
  }
});

test("forking an Artifact version creates a current-Kernel Track that requires fresh validation", () => {
  const { store, project, first, second, secondSnapshot, nextKernel } = createArtifactWorkspace({ driftKernel: true });
  try {
    const result = store.workspace.forkArtifactTrackForProject(project.id, "page-artifact", {
      sourceRevisionId: first.id,
      name: "Homepage exploration",
      expectedHeadRevisionId: second.id,
      expectedSnapshotId: secondSnapshot.id,
    });

    assert.equal(result.action, "fork-track");
    assert.equal(result.track.name, "Homepage exploration");
    assert.notEqual(result.track.id, "page-main");
    assert.equal(result.track.headRevisionId, result.revision.id);
    assert.equal(result.revision.trackId, result.track.id);
    assert.equal(result.revision.parentRevisionId, null);
    assert.equal(result.revision.sequence, 1);
    assert.equal(result.revision.sourceCommitHash, first.sourceCommitHash);
    assert.equal(result.revision.kernelRevisionId, nextKernel?.id);
    assert.deepEqual(result.revision.quality, {
      state: "unassessed",
      score: null,
      findings: [],
      reason: "forked-needs-revalidation",
    });
    assert.equal(result.revision.contextPackHash, null);
    assert.equal(result.snapshot.provenance.kind, "restore");
    assert.equal(result.snapshot.artifactTracks["page-artifact"], result.track.id);
    assert.equal(result.snapshot.artifactRevisions["page-artifact"], result.revision.id);
    assert.equal(store.workspace.getArtifact("page-artifact")?.activeTrackId, result.track.id);
    assert.equal(store.workspace.getTrack("page-main")?.headRevisionId, second.id);
    assert.deepEqual(store.workspace.getArtifactRevision(first.id), first);
    assert.deepEqual(store.workspace.getArtifactRevision(second.id), second);
  } finally {
    store.close();
  }
});
