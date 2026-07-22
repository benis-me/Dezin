import assert from "node:assert/strict";
import test from "node:test";

import { Store, type StoreClock } from "../src/index.ts";

function fakeClock(): StoreClock {
  let now = 10_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `resource-history-id-${++id}`,
  };
}

test("Resource Revision history uses bounded stable keyset pagination and exact Project ownership", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Resource history", mode: "standard" });
  const foreignProject = store.createProject({ name: "Foreign history", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  store.workspace.ensureWorkspaceRecord(foreignProject.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "file",
    title: "Long-lived brief",
    defaultPinPolicy: "pin-current",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
  });

  for (let index = 0; index < 55; index += 1) {
    store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
      revisionId: `resource-revision-${String(index + 1).padStart(2, "0")}`,
      parentRevisionId: null,
      manifestPath: `resource-revisions/${index + 1}/manifest.json`,
      summary: `Revision ${index + 1}`,
      metadata: {},
      checksum: String(index % 10).repeat(64),
      provenance: {},
    });
  }

  const first = store.workspace.listResourceRevisionHistoryPage(project.id, created.resource.id, { limit: 20 });
  assert.equal(first.items.length, 20);
  assert.deepEqual(
    first.items.map(({ id }) => id),
    Array.from({ length: 20 }, (_, index) => `resource-revision-${String(55 - index).padStart(2, "0")}`),
  );
  assert.deepEqual(first.nextCursor, {
    createdAt: first.items.at(-1)!.createdAt,
    id: "resource-revision-36",
  });

  const second = store.workspace.listResourceRevisionHistoryPage(project.id, created.resource.id, {
    limit: 20,
    cursor: first.nextCursor,
  });
  const third = store.workspace.listResourceRevisionHistoryPage(project.id, created.resource.id, {
    limit: 20,
    cursor: second.nextCursor,
  });
  assert.equal(second.items.length, 20);
  assert.equal(third.items.length, 15);
  assert.equal(third.nextCursor, null);
  const allIds = [...first.items, ...second.items, ...third.items].map(({ id }) => id);
  assert.equal(new Set(allIds).size, 55);
  assert.deepEqual(allIds, Array.from(
    { length: 55 },
    (_, index) => `resource-revision-${String(55 - index).padStart(2, "0")}`,
  ));

  for (const limit of [0, 51, 1.5, Number.NaN]) {
    assert.throws(
      () => store.workspace.listResourceRevisionHistoryPage(project.id, created.resource.id, { limit }),
      /limit.*1 to 50/i,
    );
  }
  assert.throws(
    () => store.workspace.listResourceRevisionHistoryPage(project.id, created.resource.id, {
      limit: 20,
      cursor: { createdAt: -1, id: "bad" },
    }),
    /cursor is invalid/i,
  );
  assert.throws(
    () => store.workspace.listResourceRevisionHistoryPage(foreignProject.id, created.resource.id, { limit: 20 }),
    /ownership|another Project/i,
  );
  store.close();
});

test("exact Resource view facts atomically bind Revision, current Head, and active Snapshot", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Resource view facts", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.createResourceForProject(project.id, {
    kind: "file",
    title: "Exact brief",
    defaultPinPolicy: "follow-head",
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  const revision = store.workspace.createResourceRevisionCandidateForProject(project.id, created.resource.id, {
    revisionId: "resource-view-revision-1",
    parentRevisionId: null,
    manifestPath: "resource-revisions/view/manifest.json",
    summary: "Exact brief",
    metadata: {},
    checksum: "a".repeat(64),
    provenance: {},
  });
  const published = store.workspace.publishResourceRevisionForProject(
    project.id,
    created.resource.id,
    revision.id,
    {
      expectedHeadRevisionId: null,
      expectedSnapshotId: created.snapshot.id,
      reason: "test exact facts",
    },
  );

  const facts = store.workspace.getResourceRevisionViewFactsForProject(
    project.id,
    created.resource.id,
    revision.id,
  );
  assert.equal(facts?.resource.headRevisionId, revision.id);
  assert.equal(facts?.revision.id, revision.id);
  assert.equal(facts?.snapshotId, published.id);
  store.close();
});
