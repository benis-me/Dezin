import assert from "node:assert/strict";
import test from "node:test";

import {
  Store,
  type CreatePublishedResourceForProjectInput,
} from "../src/index.ts";

test("published Resource materialization rolls back its graph identity when Revision creation fails", () => {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Atomic Resource", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const existing = store.workspace.createResourceForProject(project.id, {
    kind: "file",
    title: "Existing Resource",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
  });
  store.workspace.createResourceRevisionCandidateForProject(project.id, existing.resource.id, {
    revisionId: "shared-revision-id",
    parentRevisionId: null,
    manifestPath: "resource-revisions/shared-revision-id/manifest.json",
    summary: "Existing immutable payload",
    metadata: {},
    checksum: "a".repeat(64),
    provenance: {},
  });

  const before = store.workspace.getWorkspace(project.id)!;
  const beforeGraph = store.workspace.getGraph(project.id);
  const beforeSnapshots = store.workspace.listSnapshots(project.id);
  const input: CreatePublishedResourceForProjectInput = {
    resourceId: "atomic-resource-id",
    nodeId: "atomic-resource-node-id",
    commandId: "atomic-resource-command-id",
    kind: "file",
    title: "Should not survive",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: before.graphRevision,
    expectedSnapshotId: before.activeSnapshotId,
    revision: {
      revisionId: "shared-revision-id",
      parentRevisionId: null,
      manifestPath: "resource-revisions/shared-revision-id/manifest.json",
      summary: "Colliding immutable payload",
      metadata: {},
      checksum: "b".repeat(64),
      provenance: {},
    },
    reason: "Attached to scoped Agent Context",
  };

  assert.throws(
    () => store.workspace.createPublishedResourceForProject(project.id, input),
    /Revision identity collision/i,
  );

  assert.equal(store.workspace.getResourceForProject(project.id, input.resourceId), null);
  assert.deepEqual(store.workspace.getGraph(project.id), beforeGraph);
  assert.deepEqual(store.workspace.getWorkspace(project.id), before);
  assert.deepEqual(store.workspace.listSnapshots(project.id), beforeSnapshots);
  store.close();
});
