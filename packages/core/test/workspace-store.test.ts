import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  WorkspaceStore,
  WorkspaceStoreCodecError,
  type ArtifactRevisionRecord,
  type ArtifactTrackRecord,
  type StoreClock,
  type WorkspaceArtifactRecord,
  type WorkspaceSnapshotRecord,
} from "../src/index.ts";
import { asProjectWorkspace } from "../src/workspace-codecs.ts";
import { WorkspaceGraphValidationError } from "../src/workspace-graph.ts";

const REQUIRED_WORKSPACE_TABLES = [
  "project_workspaces",
  "workspace_artifacts",
  "artifact_tracks",
  "shared_design_kernel_revisions",
  "artifact_revisions",
  "component_instances",
  "artifact_revision_dependencies",
  "resources",
  "resource_revisions",
  "workspace_nodes",
  "workspace_edges",
  "workspace_graph_revisions",
  "workspace_graph_commands",
  "workspace_layout_nodes",
  "workspace_layout_viewports",
  "workspace_snapshots",
  "workspace_snapshot_artifacts",
  "workspace_snapshot_resources",
] as const;

function fakeClock(): StoreClock {
  let now = 1_000;
  let id = 0;
  return {
    now: () => ++now,
    id: () => `workspace-id-${++id}`,
  };
}

function requiredWorkspaceTables(db: DatabaseSync): string[] {
  const names = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
  return REQUIRED_WORKSPACE_TABLES.filter((name) => names.has(name));
}

function createLegacyStoreFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-workspace-migration-")), "legacy.db");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill_id TEXT,
      design_system_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      repair_rounds INTEGER NOT NULL DEFAULT 0,
      lint_passed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      lint_passed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE variants (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO projects VALUES ('legacy-project', 'Legacy', 'skill', 'system', 10, 11);
    INSERT INTO conversations VALUES ('legacy-conversation', 'legacy-project', 'Chat', 12);
    INSERT INTO runs VALUES ('legacy-run', 'legacy-project', 'legacy-conversation', 'succeeded', 2, 1, 13, 14);
    INSERT INTO variants VALUES ('legacy-variant', 'legacy-project', 'A', 15);
    INSERT INTO artifacts VALUES ('legacy-artifact', 'legacy-project', 'index.html', 1, 16);
  `);
  db.close();
  return file;
}

function insertArtifact(
  db: DatabaseSync,
  workspaceId: string,
  id: string,
  kind: "page" | "component" = "page",
  activeTrackId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO workspace_artifacts
       (id, workspace_id, kind, name, source_root, active_track_id, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 10, 11)`,
  ).run(id, workspaceId, kind, `Name ${id}`, `artifacts/${id}`, activeTrackId);
}

function insertTrack(
  db: DatabaseSync,
  artifactId: string,
  id: string,
  headRevisionId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO artifact_tracks (id, artifact_id, name, head_revision_id, legacy_variant_id, created_at)
     VALUES (?, ?, ?, ?, NULL, 12)`,
  ).run(id, artifactId, `Track ${id}`, headRevisionId);
}

function insertRevision(
  db: DatabaseSync,
  input: {
    id: string;
    workspaceId: string;
    artifactId: string;
    trackId: string;
    kernelRevisionId: string;
    sequence?: number;
    parentRevisionId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO artifact_revisions (
       id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
       source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
       render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
       legacy_run_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 13)`,
  ).run(
    input.id,
    input.workspaceId,
    input.artifactId,
    input.trackId,
    input.sequence ?? 1,
    input.parentRevisionId ?? null,
    `commit-${input.id}`,
    `tree-${input.id}`,
    `artifacts/${input.artifactId}`,
    input.kernelRevisionId,
    JSON.stringify({ frames: [{ id: "desktop", width: 1440, height: 900 }] }),
    JSON.stringify({ state: "passed", score: 98, findings: [] }),
  );
}

function insertResource(db: DatabaseSync, workspaceId: string, id: string, headRevisionId: string | null = null): void {
  db.prepare(
    `INSERT INTO resources (
       id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at
     ) VALUES (?, ?, 'research', ?, ?, 'follow-head', NULL, 14, 15)`,
  ).run(id, workspaceId, `Title ${id}`, headRevisionId);
}

function insertResourceRevision(
  db: DatabaseSync,
  workspaceId: string,
  resourceId: string,
  id: string,
  sequence = 1,
): void {
  db.prepare(
    `INSERT INTO resource_revisions (
       id, workspace_id, resource_id, sequence, manifest_path, summary,
       metadata_json, checksum, provenance_json, created_by_run_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '{}', NULL, 16)`,
  ).run(id, workspaceId, resourceId, sequence, `resources/${id}.json`, `Summary ${id}`, `checksum-${id}`);
}

function assertRejectedWithoutChanging(db: DatabaseSync, table: string, action: () => void): void {
  const before = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  assert.throws(action, /constraint|ownership|belongs|delete workspace/i);
  const after = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  assert.equal(after, before, `${table} changed after a rejected ownership write`);
}

test("fresh stores create every normalized workspace table", () => {
  const store = new Store(":memory:", fakeClock());
  assert.deepEqual(requiredWorkspaceTables(store.db), REQUIRED_WORKSPACE_TABLES);
  assert.ok(store.workspace instanceof WorkspaceStore);

  const artifacts: WorkspaceArtifactRecord[] = store.workspace.listArtifacts("missing-project");
  const tracks: ArtifactTrackRecord[] = store.workspace.listTracks("missing-project", "missing-artifact");
  const revisions: ArtifactRevisionRecord[] = store.workspace.listRevisions("missing-project", "missing-artifact");
  const snapshots: WorkspaceSnapshotRecord[] = store.workspace.listSnapshots("missing-project");
  assert.deepEqual({ artifacts, tracks, revisions, snapshots }, {
    artifacts: [],
    tracks: [],
    revisions: [],
    snapshots: [],
  });

  const workspaceIndexes = store.db.prepare("PRAGMA index_list(component_instances)").all() as Array<{ name: string }>;
  assert.ok(
    workspaceIndexes.some(({ name }) => name === "idx_component_instances_workspace"),
    "component_instances needs a workspace-leading cascade index",
  );
  store.close();
});

test("workspace scalar codecs reject corrupt values instead of coercing them", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Codec boundary", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);

  store.db.prepare("UPDATE projects SET mode = 'corrupt-mode' WHERE id = ?").run(project.id);
  assert.throws(() => store.workspace.getWorkspace(project.id), WorkspaceStoreCodecError);
  store.db.prepare("UPDATE projects SET mode = 'standard' WHERE id = ?").run(project.id);

  const validRow = {
    id: workspace.id,
    project_id: project.id,
    mode: "standard",
    graph_revision: 0,
    active_snapshot_id: workspace.activeSnapshotId,
    active_kernel_revision_id: workspace.activeKernelRevisionId,
    created_at: 1,
    updated_at: 1,
  };
  for (const corrupt of ["", null, false, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => asProjectWorkspace({ ...validRow, updated_at: corrupt }),
      WorkspaceStoreCodecError,
      `updated_at ${String(corrupt)} must fail closed`,
    );
  }
  for (const corrupt of ["", null, false, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => asProjectWorkspace({ ...validRow, graph_revision: corrupt }),
      WorkspaceStoreCodecError,
      `graph_revision ${String(corrupt)} must fail closed`,
    );
  }
  store.close();
});

test("workspace schema migrates a legacy database without changing legacy rows", () => {
  const store = new Store(createLegacyStoreFile(), fakeClock());

  assert.deepEqual(requiredWorkspaceTables(store.db), REQUIRED_WORKSPACE_TABLES);
  assert.deepEqual(store.listProjects().map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt })), [
    { id: "legacy-project", name: "Legacy", createdAt: 10, updatedAt: 11 },
  ]);
  assert.deepEqual(store.listRuns("legacy-project").map(({ id, status, repairRounds, lintPassed, createdAt, finishedAt }) => ({
    id,
    status,
    repairRounds,
    lintPassed,
    createdAt,
    finishedAt,
  })), [
    {
      id: "legacy-run",
      status: "succeeded",
      repairRounds: 2,
      lintPassed: true,
      createdAt: 13,
      finishedAt: 14,
    },
  ]);
  assert.deepEqual(store.listVariants("legacy-project").map(({ id, name, createdAt }) => ({ id, name, createdAt })), [
    { id: "legacy-variant", name: "A", createdAt: 15 },
  ]);
  assert.deepEqual(store.listArtifacts("legacy-project").map(({ id, path, lintPassed, createdAt }) => ({
    id,
    path,
    lintPassed,
    createdAt,
  })), [
    { id: "legacy-artifact", path: "index.html", lintPassed: true, createdAt: 16 },
  ]);
  store.close();
});

test("ensureWorkspaceRecord atomically seeds graph zero, Kernel one, Snapshot one, and active pointers", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Standard", mode: "standard" });

  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  assert.equal(workspace.mode, "standard");
  assert.equal(workspace.graphRevision, 0);
  assert.ok(workspace.activeKernelRevisionId);
  assert.ok(workspace.activeSnapshotId);
  assert.deepEqual(store.workspace.ensureWorkspaceRecord(project.id), workspace);
  assert.deepEqual(store.workspace.getGraph(project.id), {
    workspaceId: workspace.id,
    revision: 0,
    nodes: [],
    edges: [],
  });
  assert.deepEqual(store.workspace.getGraphRevision(project.id, 0), {
    workspaceId: workspace.id,
    revision: 0,
    nodes: [],
    edges: [],
  });

  const kernel = store.db
    .prepare("SELECT * FROM shared_design_kernel_revisions WHERE id = ?")
    .get(workspace.activeKernelRevisionId) as Record<string, unknown>;
  assert.equal(kernel.workspace_id, workspace.id);
  assert.equal(kernel.sequence, 1);
  assert.equal(kernel.parent_revision_id, null);
  assert.deepEqual(JSON.parse(String(kernel.payload_json)), {
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "",
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
  const snapshots = store.workspace.listSnapshots(project.id);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.id, workspace.activeSnapshotId);
  assert.equal(snapshots[0]?.sequence, 1);
  assert.equal(snapshots[0]?.graphRevision, 0);
  assert.deepEqual(snapshots[0]?.graph, store.workspace.getGraphRevision(project.id, 0));
  assert.deepEqual(snapshots[0]?.artifactRevisions, {});
  assert.deepEqual(snapshots[0]?.resourceRevisions, {});
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);

  assert.throws(() => store.workspace.ensureWorkspaceRecord("missing-project"), /project not found/);
  store.close();
});

test("ensureWorkspaceRecord rolls back every seed row if a later insert fails", () => {
  const ids = ["project-1", "workspace-1", "kernel-shared", "snapshot-1", "project-2", "workspace-2", "kernel-shared"];
  const store = new Store(":memory:", {
    now: (() => {
      let now = 2_000;
      return () => ++now;
    })(),
    id: () => ids.shift() ?? "unexpected-id",
  });
  const first = store.createProject({ name: "First", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(first.id);
  const second = store.createProject({ name: "Second", mode: "standard" });

  assert.throws(() => store.workspace.ensureWorkspaceRecord(second.id), /constraint/i);
  assert.equal(store.workspace.getWorkspace(second.id), null);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM workspace_graph_revisions WHERE workspace_id = 'workspace-2'").get() as { count: number }).count),
    0,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM workspace_snapshots WHERE workspace_id = 'workspace-2'").get() as { count: number }).count),
    0,
  );
  store.close();
});

test("WorkspaceStore reads normalized records defensively and snapshots resolve immutable graph history", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Read model", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "artifact-page");
  insertTrack(store.db, "artifact-page", "track-main");
  insertRevision(store.db, {
    id: "revision-page-1",
    workspaceId: workspace.id,
    artifactId: "artifact-page",
    trackId: "track-main",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = ? WHERE id = ?").run("revision-page-1", "track-main");
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = ? WHERE id = ?").run("track-main", "artifact-page");
  insertResource(store.db, workspace.id, "resource-research");
  insertResourceRevision(store.db, workspace.id, "resource-research", "resource-revision-1");
  store.db.prepare("UPDATE resources SET head_revision_id = ? WHERE id = ?").run("resource-revision-1", "resource-research");
  store.db.prepare(
    `INSERT INTO workspace_nodes (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('node-page', ?, 'page', 'artifact-page', NULL, NULL, 20, 21),
            ('node-resource', ?, 'resource', NULL, 'resource-research', NULL, 20, 21)`,
  ).run(workspace.id, workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_edges
       (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
     VALUES ('edge-informs', ?, 'informs', 'node-resource', 'node-page', '{}', 22, 23)`,
  ).run(workspace.id);

  const historicalGraph = {
    workspaceId: workspace.id,
    revision: 1,
    nodes: [{
      id: "node-page",
      workspaceId: workspace.id,
      kind: "page",
      name: "Historical page name",
      artifactId: "artifact-page",
    }],
    edges: [],
  };
  store.db.prepare(
    `INSERT INTO workspace_graph_revisions
       (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
     VALUES (?, 1, ?, '[]', 'graph-1', 24)`,
  ).run(workspace.id, JSON.stringify(historicalGraph.nodes));
  store.db.prepare(
    `INSERT INTO workspace_snapshots
       (id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id, reason, provenance_json, created_by_run_id, created_at)
     VALUES ('snapshot-2', ?, 2, ?, 1, ?, 'test-checkpoint', '{"kind":"test"}', NULL, 25)`,
  ).run(workspace.id, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     VALUES (?, 'snapshot-2', 'artifact-page', 'track-main', 'revision-page-1')`,
  ).run(workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_resources (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, 'snapshot-2', 'resource-research', 'resource-revision-1')`,
  ).run(workspace.id);
  store.db.prepare(
    "UPDATE project_workspaces SET graph_revision = 1, active_snapshot_id = 'snapshot-2' WHERE id = ?",
  ).run(workspace.id);

  assert.deepEqual(store.workspace.getWorkspace(project.id), {
    ...workspace,
    graphRevision: 1,
    activeSnapshotId: "snapshot-2",
  });
  assert.deepEqual(store.workspace.getGraph(project.id), {
    workspaceId: workspace.id,
    revision: 1,
    nodes: [
      {
        id: "node-page",
        workspaceId: workspace.id,
        kind: "page",
        name: "Name artifact-page",
        artifactId: "artifact-page",
      },
      {
        id: "node-resource",
        workspaceId: workspace.id,
        kind: "resource",
        name: "Title resource-research",
        resourceId: "resource-research",
      },
    ],
    edges: [{
      id: "edge-informs",
      workspaceId: workspace.id,
      kind: "informs",
      sourceNodeId: "node-resource",
      targetNodeId: "node-page",
    }],
  });
  assert.deepEqual(store.workspace.getGraphRevision(project.id, 1), historicalGraph);

  assert.deepEqual(store.workspace.listArtifacts(project.id), [{
    id: "artifact-page",
    workspaceId: workspace.id,
    kind: "page",
    name: "Name artifact-page",
    sourceRoot: "artifacts/artifact-page",
    activeTrackId: "track-main",
    archivedAt: null,
    createdAt: 10,
    updatedAt: 11,
  }]);
  assert.deepEqual(store.workspace.listTracks(project.id, "artifact-page"), [{
    id: "track-main",
    artifactId: "artifact-page",
    name: "Track track-main",
    headRevisionId: "revision-page-1",
    legacyVariantId: null,
    createdAt: 12,
  }]);
  assert.deepEqual(store.workspace.listRevisions(project.id, "artifact-page"), [{
    id: "revision-page-1",
    workspaceId: workspace.id,
    artifactId: "artifact-page",
    trackId: "track-main",
    sequence: 1,
    parentRevisionId: null,
    sourceCommitHash: "commit-revision-page-1",
    sourceTreeHash: "tree-revision-page-1",
    artifactRoot: "artifacts/artifact-page",
    kernelRevisionId: workspace.activeKernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1440, height: 900 }] },
    quality: { state: "passed", score: 98, findings: [] },
    contextPackHash: null,
    producedByRunId: null,
    legacyRunId: null,
    createdAt: 13,
  }]);
  const snapshots = store.workspace.listSnapshots(project.id);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[1]?.graph, historicalGraph);
  assert.deepEqual(snapshots[1]?.artifactRevisions, { "artifact-page": "revision-page-1" });
  assert.deepEqual(snapshots[1]?.artifactTracks, { "artifact-page": "track-main" });
  assert.deepEqual(snapshots[1]?.resourceRevisions, { "resource-research": "resource-revision-1" });
  assert.deepEqual(snapshots[1]?.provenance, { kind: "test" });

  store.db.prepare(
    `INSERT INTO workspace_graph_revisions
       (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
     VALUES (?, 2, '{}', '[]', 'bad-graph', 26)`,
  ).run(workspace.id);
  assert.throws(() => store.workspace.getGraphRevision(project.id, 2), WorkspaceGraphValidationError);
  store.close();
});

test("WorkspaceStore list ordering is stable across tied timestamps and multiple Tracks", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Stable ordering", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);

  insertArtifact(store.db, workspace.id, "artifact-z");
  insertArtifact(store.db, workspace.id, "artifact-a");
  assert.deepEqual(
    store.workspace.listArtifacts(project.id).map(({ id }) => id),
    ["artifact-a", "artifact-z"],
  );

  insertTrack(store.db, "artifact-a", "track-z");
  insertTrack(store.db, "artifact-a", "track-a");
  assert.deepEqual(
    store.workspace.listTracks(project.id, "artifact-a").map(({ id }) => id),
    ["track-a", "track-z"],
  );

  insertRevision(store.db, {
    id: "revision-z",
    workspaceId: workspace.id,
    artifactId: "artifact-a",
    trackId: "track-z",
    kernelRevisionId: workspace.activeKernelRevisionId,
    sequence: 1,
  });
  insertRevision(store.db, {
    id: "revision-a",
    workspaceId: workspace.id,
    artifactId: "artifact-a",
    trackId: "track-a",
    kernelRevisionId: workspace.activeKernelRevisionId,
    sequence: 7,
  });
  assert.deepEqual(
    store.workspace.listRevisions(project.id, "artifact-a").map(({ id }) => id),
    ["revision-a", "revision-z"],
  );
  store.close();
});

test("composite foreign keys reject cross-owner graph, revision, component pin, command, and Snapshot rows", () => {
  const store = new Store(":memory:", fakeClock());
  const project1 = store.createProject({ name: "One", mode: "standard" });
  const project2 = store.createProject({ name: "Two", mode: "standard" });
  const workspace1 = store.workspace.ensureWorkspaceRecord(project1.id);
  const workspace2 = store.workspace.ensureWorkspaceRecord(project2.id);

  insertArtifact(store.db, workspace1.id, "artifact-1");
  insertArtifact(store.db, workspace2.id, "artifact-2");
  insertArtifact(store.db, workspace1.id, "component-1", "component");
  insertArtifact(store.db, workspace1.id, "component-other", "component");
  insertTrack(store.db, "artifact-1", "track-1");
  insertTrack(store.db, "artifact-2", "track-2");
  insertTrack(store.db, "component-1", "component-track-1");
  insertTrack(store.db, "component-other", "component-track-other");
  insertRevision(store.db, {
    id: "revision-1",
    workspaceId: workspace1.id,
    artifactId: "artifact-1",
    trackId: "track-1",
    kernelRevisionId: workspace1.activeKernelRevisionId,
  });
  insertRevision(store.db, {
    id: "revision-2",
    workspaceId: workspace2.id,
    artifactId: "artifact-2",
    trackId: "track-2",
    kernelRevisionId: workspace2.activeKernelRevisionId,
  });
  insertRevision(store.db, {
    id: "component-revision-1",
    workspaceId: workspace1.id,
    artifactId: "component-1",
    trackId: "component-track-1",
    kernelRevisionId: workspace1.activeKernelRevisionId,
  });
  insertRevision(store.db, {
    id: "component-revision-other",
    workspaceId: workspace1.id,
    artifactId: "component-other",
    trackId: "component-track-other",
    kernelRevisionId: workspace1.activeKernelRevisionId,
  });
  insertResource(store.db, workspace1.id, "resource-1");
  insertResource(store.db, workspace2.id, "resource-2");
  insertResourceRevision(store.db, workspace1.id, "resource-1", "resource-revision-1");
  insertResourceRevision(store.db, workspace2.id, "resource-2", "resource-revision-2");

  assertRejectedWithoutChanging(store.db, "workspace_nodes", () => {
    store.db.prepare(
      `INSERT INTO workspace_nodes
         (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
       VALUES ('cross-node', ?, 'page', 'artifact-1', NULL, NULL, 1, 1)`,
    ).run(workspace2.id);
  });
  store.db.prepare(
    `INSERT INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('node-1', ?, 'page', 'artifact-1', NULL, NULL, 1, 1),
            ('node-2', ?, 'page', 'artifact-2', NULL, NULL, 1, 1)`,
  ).run(workspace1.id, workspace2.id);
  assertRejectedWithoutChanging(store.db, "workspace_edges", () => {
    store.db.prepare(
      `INSERT INTO workspace_edges
         (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
       VALUES ('cross-edge', ?, 'prototype', 'node-1', 'node-2', '{"status":"planned"}', 1, 1)`,
    ).run(workspace1.id);
  });
  assertRejectedWithoutChanging(store.db, "artifact_revisions", () => {
    insertRevision(store.db, {
      id: "cross-track-revision",
      workspaceId: workspace1.id,
      artifactId: "artifact-1",
      trackId: "track-2",
      kernelRevisionId: workspace1.activeKernelRevisionId,
    });
  });
  assertRejectedWithoutChanging(store.db, "artifact_revisions", () => {
    insertRevision(store.db, {
      id: "cross-kernel-revision",
      workspaceId: workspace1.id,
      artifactId: "artifact-1",
      trackId: "track-1",
      kernelRevisionId: workspace2.activeKernelRevisionId,
      sequence: 2,
    });
  });
  assertRejectedWithoutChanging(store.db, "resource_revisions", () => {
    insertResourceRevision(store.db, workspace2.id, "resource-1", "cross-resource-revision", 2);
  });
  assertRejectedWithoutChanging(store.db, "component_instances", () => {
    store.db.prepare(
      `INSERT INTO component_instances
         (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
       VALUES ('cross-instance', ?, 'artifact-1', 'artifact-2', 1)`,
    ).run(workspace1.id);
  });
  store.db.prepare(
    `INSERT INTO component_instances
       (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
     VALUES ('instance-1', ?, 'artifact-1', 'component-1', 1)`,
  ).run(workspace1.id);
  assertRejectedWithoutChanging(store.db, "artifact_revision_dependencies", () => {
    store.db.prepare(
      `INSERT INTO artifact_revision_dependencies (
         workspace_id, owner_artifact_id, revision_id, instance_id,
         component_artifact_id, component_revision_id, variant_key, state_key,
         design_node_id, source_locator_json, overrides_json, status
       ) VALUES (?, 'artifact-1', 'revision-1', 'instance-1', 'component-other',
                 'component-revision-other', NULL, NULL, 'node', '{}', '{}', 'linked')`,
    ).run(workspace1.id);
  });
  assertRejectedWithoutChanging(store.db, "workspace_snapshots", () => {
    store.db.prepare(
      `INSERT INTO workspace_snapshots
         (id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
          reason, provenance_json, created_by_run_id, created_at)
       VALUES ('cross-kernel-snapshot', ?, 2, NULL, 0, ?, 'bad', '{}', NULL, 1)`,
    ).run(workspace1.id, workspace2.activeKernelRevisionId);
  });
  assertRejectedWithoutChanging(store.db, "workspace_snapshot_artifacts", () => {
    store.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       VALUES (?, ?, 'artifact-2', 'track-2', 'revision-2')`,
    ).run(workspace1.id, workspace1.activeSnapshotId);
  });
  assertRejectedWithoutChanging(store.db, "workspace_snapshot_resources", () => {
    store.db.prepare(
      `INSERT INTO workspace_snapshot_resources
         (workspace_id, snapshot_id, resource_id, revision_id)
       VALUES (?, ?, 'resource-2', 'resource-revision-2')`,
    ).run(workspace1.id, workspace1.activeSnapshotId);
  });
  assertRejectedWithoutChanging(store.db, "workspace_graph_commands", () => {
    store.db.prepare(
      `INSERT INTO workspace_graph_commands (
         workspace_id, command_id, base_revision, result_revision, expected_snapshot_id,
         batch_hash, batch_index, batch_size, result_snapshot_id, payload_json, created_at
       ) VALUES (?, 'command-cross', 0, 0, ?, 'hash', 0, 1, ?, '{}', 1)`,
    ).run(workspace1.id, workspace2.activeSnapshotId, workspace1.activeSnapshotId);
  });
  store.close();
});

test("ownership triggers cover insert and update paths for every cyclic or mutable pointer", () => {
  const store = new Store(":memory:", fakeClock());
  const project1 = store.createProject({ name: "One", mode: "standard" });
  const project2 = store.createProject({ name: "Two", mode: "standard" });
  const workspace1 = store.workspace.ensureWorkspaceRecord(project1.id);
  const workspace2 = store.workspace.ensureWorkspaceRecord(project2.id);
  insertArtifact(store.db, workspace1.id, "artifact-1");
  insertArtifact(store.db, workspace2.id, "artifact-2");
  insertTrack(store.db, "artifact-1", "track-1");
  insertTrack(store.db, "artifact-2", "track-2");
  insertRevision(store.db, {
    id: "revision-1",
    workspaceId: workspace1.id,
    artifactId: "artifact-1",
    trackId: "track-1",
    kernelRevisionId: workspace1.activeKernelRevisionId,
  });
  insertRevision(store.db, {
    id: "revision-2",
    workspaceId: workspace2.id,
    artifactId: "artifact-2",
    trackId: "track-2",
    kernelRevisionId: workspace2.activeKernelRevisionId,
  });
  insertResource(store.db, workspace1.id, "resource-1");
  insertResource(store.db, workspace2.id, "resource-2");
  insertResourceRevision(store.db, workspace1.id, "resource-1", "resource-revision-1");
  insertResourceRevision(store.db, workspace2.id, "resource-2", "resource-revision-2");

  const pointerFailure = (action: () => void) => assert.throws(action, /ownership|belongs/i);

  store.db.exec("INSERT INTO projects (id, name, mode, sharingan, created_at, updated_at) VALUES ('project-3', 'Three', 'standard', 0, 1, 1)");
  pointerFailure(() => store.db.prepare(
    `INSERT INTO project_workspaces
       (id, project_id, graph_revision, active_snapshot_id, active_kernel_revision_id, created_at, updated_at)
     VALUES ('workspace-bad-snapshot', 'project-3', 0, ?, NULL, 1, 1)`,
  ).run(workspace2.activeSnapshotId));
  store.db.exec("INSERT INTO projects (id, name, mode, sharingan, created_at, updated_at) VALUES ('project-4', 'Four', 'standard', 0, 1, 1)");
  pointerFailure(() => store.db.prepare(
    `INSERT INTO project_workspaces
       (id, project_id, graph_revision, active_snapshot_id, active_kernel_revision_id, created_at, updated_at)
     VALUES ('workspace-bad-kernel', 'project-4', 0, NULL, ?, 1, 1)`,
  ).run(workspace2.activeKernelRevisionId));
  pointerFailure(() => store.db.prepare("UPDATE project_workspaces SET active_snapshot_id = ? WHERE id = ?")
    .run(workspace2.activeSnapshotId, workspace1.id));
  pointerFailure(() => store.db.prepare("UPDATE project_workspaces SET active_kernel_revision_id = ? WHERE id = ?")
    .run(workspace2.activeKernelRevisionId, workspace1.id));

  pointerFailure(() => insertArtifact(store.db, workspace1.id, "artifact-bad-track", "page", "track-2"));
  pointerFailure(() => store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'track-2' WHERE id = 'artifact-1'").run());
  pointerFailure(() => insertTrack(store.db, "artifact-1", "track-bad-head", "revision-2"));
  pointerFailure(() => store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'revision-2' WHERE id = 'track-1'").run());
  pointerFailure(() => insertResource(store.db, workspace1.id, "resource-bad-head", "resource-revision-2"));
  pointerFailure(() => store.db.prepare("UPDATE resources SET head_revision_id = 'resource-revision-2' WHERE id = 'resource-1'").run());

  pointerFailure(() => store.db.prepare(
    `INSERT INTO shared_design_kernel_revisions
       (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
     VALUES ('kernel-bad-parent', ?, 2, ?, '{}', 'bad', 1)`,
  ).run(workspace1.id, workspace2.activeKernelRevisionId));
  store.db.prepare(
    `INSERT INTO shared_design_kernel_revisions
       (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
     VALUES ('kernel-child', ?, 2, ?, '{}', 'child', 1)`,
  ).run(workspace1.id, workspace1.activeKernelRevisionId);
  pointerFailure(() => store.db.prepare("UPDATE shared_design_kernel_revisions SET parent_revision_id = ? WHERE id = 'kernel-child'")
    .run(workspace2.activeKernelRevisionId));

  pointerFailure(() => insertRevision(store.db, {
    id: "revision-bad-parent",
    workspaceId: workspace1.id,
    artifactId: "artifact-1",
    trackId: "track-1",
    kernelRevisionId: workspace1.activeKernelRevisionId,
    sequence: 2,
    parentRevisionId: "revision-2",
  }));
  insertRevision(store.db, {
    id: "revision-child",
    workspaceId: workspace1.id,
    artifactId: "artifact-1",
    trackId: "track-1",
    kernelRevisionId: workspace1.activeKernelRevisionId,
    sequence: 2,
    parentRevisionId: "revision-1",
  });
  pointerFailure(() => store.db.prepare("UPDATE artifact_revisions SET parent_revision_id = 'revision-2' WHERE id = 'revision-child'").run());

  pointerFailure(() => store.db.prepare(
    `INSERT INTO workspace_snapshots
       (id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
        reason, provenance_json, created_by_run_id, created_at)
     VALUES ('snapshot-bad-parent', ?, 2, ?, 0, ?, 'bad', '{}', NULL, 1)`,
  ).run(workspace1.id, workspace2.activeSnapshotId, workspace1.activeKernelRevisionId));
  store.db.prepare(
    `INSERT INTO workspace_snapshots
       (id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
        reason, provenance_json, created_by_run_id, created_at)
     VALUES ('snapshot-child', ?, 2, ?, 0, ?, 'child', '{}', NULL, 1)`,
  ).run(workspace1.id, workspace1.activeSnapshotId, workspace1.activeKernelRevisionId);
  pointerFailure(() => store.db.prepare("UPDATE workspace_snapshots SET parent_snapshot_id = ? WHERE id = 'snapshot-child'")
    .run(workspace2.activeSnapshotId));

  store.close();
});

test("direct Workspace deletion is guarded while Store.deleteProject still performs the root cascade", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Delete", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);

  assert.throws(
    () => store.db.prepare("DELETE FROM project_workspaces WHERE id = ?").run(workspace.id),
    /delete workspace/i,
  );
  assert.ok(store.workspace.getWorkspace(project.id));

  insertArtifact(store.db, workspace.id, "delete-page", "page");
  insertArtifact(store.db, workspace.id, "delete-component", "component");
  insertTrack(store.db, "delete-page", "delete-page-track");
  insertTrack(store.db, "delete-component", "delete-component-track");
  insertRevision(store.db, {
    id: "delete-page-revision",
    workspaceId: workspace.id,
    artifactId: "delete-page",
    trackId: "delete-page-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  insertRevision(store.db, {
    id: "delete-component-revision",
    workspaceId: workspace.id,
    artifactId: "delete-component",
    trackId: "delete-component-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'delete-page-track' WHERE id = 'delete-page'").run();
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'delete-component-track' WHERE id = 'delete-component'").run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'delete-page-revision' WHERE id = 'delete-page-track'").run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'delete-component-revision' WHERE id = 'delete-component-track'").run();
  store.db.prepare(
    `INSERT INTO component_instances
       (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
     VALUES ('delete-instance', ?, 'delete-page', 'delete-component', 1)`,
  ).run(workspace.id);
  store.db.prepare(
    `INSERT INTO artifact_revision_dependencies (
       workspace_id, owner_artifact_id, revision_id, instance_id, component_artifact_id,
       component_revision_id, variant_key, state_key, design_node_id,
       source_locator_json, overrides_json, status
     ) VALUES (?, 'delete-page', 'delete-page-revision', 'delete-instance', 'delete-component',
               'delete-component-revision', NULL, NULL, 'component-node', '{}', '{}', 'linked')`,
  ).run(workspace.id);
  insertResource(store.db, workspace.id, "delete-resource");
  insertResourceRevision(store.db, workspace.id, "delete-resource", "delete-resource-revision");
  store.db.prepare("UPDATE resources SET head_revision_id = 'delete-resource-revision' WHERE id = 'delete-resource'").run();
  store.db.prepare(
    `INSERT INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('delete-page-node', ?, 'page', 'delete-page', NULL, NULL, 1, 1),
            ('delete-component-node', ?, 'component', 'delete-component', NULL, NULL, 1, 1),
            ('delete-resource-node', ?, 'resource', NULL, 'delete-resource', NULL, 1, 1)`,
  ).run(workspace.id, workspace.id, workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_edges
       (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
     VALUES ('delete-uses-edge', ?, 'uses', 'delete-page-node', 'delete-component-node', '{}', 1, 1),
            ('delete-informs-edge', ?, 'informs', 'delete-resource-node', 'delete-page-node', '{}', 1, 1)`,
  ).run(workspace.id, workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_graph_commands (
       workspace_id, command_id, base_revision, result_revision, expected_snapshot_id,
       batch_hash, batch_index, batch_size, result_snapshot_id, payload_json, created_at
     ) VALUES (?, 'delete-command', 0, 0, ?, 'delete-hash', 0, 1, ?, '{}', 1)`,
  ).run(workspace.id, workspace.activeSnapshotId, workspace.activeSnapshotId);
  store.db.prepare(
    `INSERT INTO workspace_layout_nodes
       (workspace_id, layout_id, object_id, object_kind, x, y, width, height,
        parent_group_id, label, collapsed, updated_at)
     VALUES (?, 'default', 'delete-page-node', 'node', 0, 0, NULL, NULL, NULL, NULL, 0, 1)`,
  ).run(workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_layout_viewports (workspace_id, layout_id, x, y, zoom, updated_at)
     VALUES (?, 'default', 0, 0, 1, 1)`,
  ).run(workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts
       (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     VALUES (?, ?, 'delete-page', 'delete-page-track', 'delete-page-revision'),
            (?, ?, 'delete-component', 'delete-component-track', 'delete-component-revision')`,
  ).run(workspace.id, workspace.activeSnapshotId, workspace.id, workspace.activeSnapshotId);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_resources (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, ?, 'delete-resource', 'delete-resource-revision')`,
  ).run(workspace.id, workspace.activeSnapshotId);

  store.deleteProject(project.id);
  assert.equal(store.getProject(project.id), null);
  assert.equal(store.workspace.getWorkspace(project.id), null);
  for (const table of REQUIRED_WORKSPACE_TABLES) {
    const count = Number((store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    assert.equal(count, 0, `${table} survived the root Project cascade`);
  }
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("the active graph pointer cannot reference a missing Workspace graph revision", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Graph pointer", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);

  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET graph_revision = 999 WHERE id = ?").run(workspace.id),
    /constraint/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id)?.graphRevision, 0);
  store.close();
});

test("workspace node kind must match its owned Artifact kind on insert and update", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Node kinds", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "page-1", "page");
  insertArtifact(store.db, workspace.id, "component-1", "component");

  assert.throws(
    () => store.db.prepare(
      `INSERT INTO workspace_nodes
         (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
       VALUES ('bad-node', ?, 'page', 'component-1', NULL, NULL, 1, 1)`,
    ).run(workspace.id),
    /kind ownership/i,
  );
  store.db.prepare(
    `INSERT INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('page-node', ?, 'page', 'page-1', NULL, NULL, 1, 1)`,
  ).run(workspace.id);
  assert.throws(
    () => store.db.prepare("UPDATE workspace_nodes SET artifact_id = 'component-1' WHERE id = 'page-node'").run(),
    /kind ownership/i,
  );
  assert.equal(
    (store.db.prepare("SELECT artifact_id FROM workspace_nodes WHERE id = 'page-node'").get() as { artifact_id: string }).artifact_id,
    "page-1",
  );
  assert.throws(
    () => store.db.prepare("UPDATE workspace_artifacts SET kind = 'component' WHERE id = 'page-1'").run(),
    /kind/i,
  );

  assert.throws(
    () => store.db.prepare(
      `INSERT INTO component_instances
         (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
       VALUES ('bad-page-instance', ?, 'page-1', 'page-1', 1)`,
    ).run(workspace.id),
    /component kind/i,
  );
  store.db.prepare(
    `INSERT INTO component_instances
       (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
     VALUES ('valid-component-instance', ?, 'page-1', 'component-1', 1)`,
  ).run(workspace.id);
  assert.throws(
    () => store.db.prepare(
      "UPDATE component_instances SET component_artifact_id = 'page-1' WHERE id = 'valid-component-instance'",
    ).run(),
    /component kind/i,
  );
  store.close();
});

test("active, Head, and parent pointers cannot dangle when their owned target is deleted", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Pointer targets", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);

  assert.throws(
    () => store.db.prepare("DELETE FROM workspace_snapshots WHERE id = ?").run(workspace.activeSnapshotId),
    /constraint/i,
  );
  assert.throws(
    () => store.db.prepare("DELETE FROM shared_design_kernel_revisions WHERE id = ?").run(workspace.activeKernelRevisionId),
    /constraint/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET active_snapshot_id = NULL WHERE id = ?").run(workspace.id),
    /active snapshot/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET active_kernel_revision_id = NULL WHERE id = ?").run(workspace.id),
    /active kernel/i,
  );
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);

  insertArtifact(store.db, workspace.id, "artifact-parent");
  insertTrack(store.db, "artifact-parent", "track-parent");
  insertRevision(store.db, {
    id: "revision-parent",
    workspaceId: workspace.id,
    artifactId: "artifact-parent",
    trackId: "track-parent",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  insertRevision(store.db, {
    id: "revision-child",
    workspaceId: workspace.id,
    artifactId: "artifact-parent",
    trackId: "track-parent",
    kernelRevisionId: workspace.activeKernelRevisionId,
    sequence: 2,
    parentRevisionId: "revision-parent",
  });
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'track-parent' WHERE id = 'artifact-parent'").run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'revision-child' WHERE id = 'track-parent'").run();
  assert.throws(() => store.db.prepare("DELETE FROM artifact_tracks WHERE id = 'track-parent'").run(), /constraint/i);
  assert.throws(() => store.db.prepare("DELETE FROM artifact_revisions WHERE id = 'revision-parent'").run(), /constraint/i);
  assert.ok(store.db.prepare("SELECT id FROM artifact_revisions WHERE id = 'revision-child'").get());

  insertResource(store.db, workspace.id, "resource-head");
  insertResourceRevision(store.db, workspace.id, "resource-head", "resource-head-revision");
  store.db.prepare("UPDATE resources SET head_revision_id = 'resource-head-revision' WHERE id = 'resource-head'").run();
  assert.throws(
    () => store.db.prepare("DELETE FROM resource_revisions WHERE id = 'resource-head-revision'").run(),
    /constraint/i,
  );
  store.close();
});

test("workspace codecs reject corrupt immutable JSON instead of silently replacing it", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Corrupt JSON", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "artifact-json");
  insertTrack(store.db, "artifact-json", "track-json");
  insertRevision(store.db, {
    id: "revision-json",
    workspaceId: workspace.id,
    artifactId: "artifact-json",
    trackId: "track-json",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });

  store.db.prepare("UPDATE artifact_revisions SET render_spec_json = '{' WHERE id = 'revision-json'").run();
  assert.throws(() => store.workspace.listRevisions(project.id, "artifact-json"), /valid JSON/i);
  store.db.prepare("UPDATE artifact_revisions SET render_spec_json = '{}' WHERE id = 'revision-json'").run();
  store.db.prepare("UPDATE workspace_snapshots SET provenance_json = '[]' WHERE id = ?").run(workspace.activeSnapshotId);
  assert.throws(() => store.workspace.listSnapshots(project.id), /JSON object/i);

  insertResource(store.db, workspace.id, "resource-json");
  store.db.prepare(
    `INSERT INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('artifact-json-node', ?, 'page', 'artifact-json', NULL, NULL, 20, 20),
            ('resource-json-node', ?, 'resource', NULL, 'resource-json', NULL, 20, 20)`,
  ).run(workspace.id, workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_edges
       (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
     VALUES ('edge-json', ?, 'informs', 'resource-json-node', 'artifact-json-node', '{', 21, 21)`,
  ).run(workspace.id);
  assert.throws(() => store.workspace.getGraph(project.id), /valid JSON|canonical empty object/i);
  store.db.prepare("UPDATE workspace_edges SET payload_json = '{\"unexpected\":true}' WHERE id = 'edge-json'").run();
  assert.throws(() => store.workspace.getGraph(project.id), /canonical empty object/i);
  store.db.prepare("UPDATE workspace_edges SET payload_json = '{}' WHERE id = 'edge-json'").run();
  assert.equal(store.workspace.getGraph(project.id).edges.length, 1);
  store.close();
});
