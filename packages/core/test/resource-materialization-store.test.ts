import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Store,
  type CommitResourceMaterializationInput,
  type CreatePublishedResourceForProjectInput,
  type ResourceMaterializationRequestFacts,
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

test("Resource materialization receipt durably replays the exact first publication", () => {
  const root = mkdtempSync(join(tmpdir(), "dezin-resource-materialization-"));
  const databasePath = join(root, "store.sqlite");
  try {
    const firstStore = new Store(databasePath);
    const project = firstStore.createProject({ name: "Durable receipt", mode: "standard" });
    const initial = firstStore.workspace.ensureWorkspaceRecord(project.id);
    const publication: CreatePublishedResourceForProjectInput = {
      resourceId: "durable-resource-id",
      nodeId: "durable-resource-node-id",
      commandId: "durable-resource-command-id",
      kind: "file",
      title: "Reference image",
      defaultPinPolicy: "pin-current",
      baseGraphRevision: initial.graphRevision,
      expectedSnapshotId: initial.activeSnapshotId,
      revision: {
        revisionId: "durable-resource-revision-id",
        parentRevisionId: null,
        manifestPath: "resource-revisions/durable-resource-revision-id/manifest.json",
        summary: "Frozen uploaded reference",
        metadata: { mimeType: "image/png" },
        checksum: "c".repeat(64),
        provenance: { source: "home-attachment" },
      },
      reason: "Attach the Home reference to the first Workspace Agent turn",
    };
    const request: ResourceMaterializationRequestFacts = {
      kind: publication.kind,
      title: publication.title,
      defaultPinPolicy: publication.defaultPinPolicy,
      source: { type: "uploaded-file", uploadedFileId: ".refs/reference.png" },
      reason: publication.reason,
    };
    const commit: CommitResourceMaterializationInput = {
      projectId: project.id,
      idempotencyKey: "home-reference-1",
      request,
      publication,
    };
    const first = firstStore.workspace.commitResourceMaterializationForProject(commit);
    assert.equal(first.created, true);
    firstStore.close();

    const reopened = new Store(databasePath);
    const replay = reopened.workspace.commitResourceMaterializationForProject(commit);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(reopened.workspace.listResources(project.id).length, 1);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Resource materialization replay wins before a stale graph and Snapshot fence", () => {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Stale replay", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const request: ResourceMaterializationRequestFacts = {
    kind: "file",
    title: "First attachment",
    defaultPinPolicy: "pin-current",
    source: { uploadedFileId: ".refs/first.png", type: "uploaded-file" },
    reason: "Attach exact Home context",
  };
  const publication: CreatePublishedResourceForProjectInput = {
    resourceId: "stale-replay-resource",
    nodeId: "stale-replay-node",
    commandId: "stale-replay-command",
    kind: request.kind,
    title: request.title,
    defaultPinPolicy: request.defaultPinPolicy,
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    revision: {
      revisionId: "stale-replay-revision",
      parentRevisionId: null,
      manifestPath: "resource-revisions/stale-replay-revision/manifest.json",
      summary: "First exact payload",
      metadata: {},
      checksum: "d".repeat(64),
      provenance: {},
    },
    reason: request.reason,
  };
  const first = store.workspace.commitResourceMaterializationForProject({
    projectId: project.id,
    idempotencyKey: "stale-replay-key",
    request,
    publication,
  });
  const afterFirst = store.workspace.getWorkspace(project.id)!;
  store.workspace.createResourceForProject(project.id, {
    kind: "file",
    title: "Unrelated Resource",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: afterFirst.graphRevision,
    expectedSnapshotId: afterFirst.activeSnapshotId,
  });

  const replay = store.workspace.commitResourceMaterializationForProject({
    projectId: project.id,
    idempotencyKey: "stale-replay-key",
    request: {
      ...request,
      source: { type: "uploaded-file", uploadedFileId: ".refs/first.png" },
    },
    publication: {
      ...publication,
      resourceId: "must-not-be-created",
      nodeId: "must-not-be-created-node",
      commandId: "must-not-be-created-command",
      revision: {
        ...publication.revision,
        revisionId: "must-not-be-created-revision",
        manifestPath: "resource-revisions/must-not-be-created-revision/manifest.json",
      },
    },
  });

  assert.equal(replay.created, false);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(store.workspace.getResourceForProject(project.id, "must-not-be-created"), null);
  store.close();
});

test("Resource materialization idempotency key rejects a divergent immutable request", () => {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "Divergent receipt", mode: "standard" });
  const initial = store.workspace.ensureWorkspaceRecord(project.id);
  const request: ResourceMaterializationRequestFacts = {
    kind: "file",
    title: "Original attachment",
    defaultPinPolicy: "pin-current",
    source: { type: "uploaded-file", uploadedFileId: ".refs/original.png" },
    reason: "Attach original context",
  };
  const publication: CreatePublishedResourceForProjectInput = {
    resourceId: "divergent-resource",
    nodeId: "divergent-node",
    commandId: "divergent-command",
    kind: request.kind,
    title: request.title,
    defaultPinPolicy: request.defaultPinPolicy,
    baseGraphRevision: initial.graphRevision,
    expectedSnapshotId: initial.activeSnapshotId,
    revision: {
      revisionId: "divergent-revision",
      parentRevisionId: null,
      manifestPath: "resource-revisions/divergent-revision/manifest.json",
      summary: "Original payload",
      metadata: {},
      checksum: "e".repeat(64),
      provenance: {},
    },
    reason: request.reason,
  };
  const first = store.workspace.commitResourceMaterializationForProject({
    projectId: project.id,
    idempotencyKey: "divergent-key",
    request,
    publication,
  });
  assert.deepEqual(
    store.workspace.getResourceMaterializationReceiptForProject(
      project.id,
      "divergent-key",
      request,
    ),
    first.receipt,
  );

  assert.throws(
    () => store.workspace.getResourceMaterializationReceiptForProject(
      project.id,
      "divergent-key",
      {
        ...request,
        source: { type: "uploaded-file", uploadedFileId: ".refs/different.png" },
      },
    ),
    (error: unknown) => (
      error instanceof Error
      && error.name === "ResourceMaterializationConflictError"
      && /different immutable request/.test(error.message)
    ),
  );
  assert.equal(store.workspace.listResources(project.id).length, 1);
  store.close();
});
