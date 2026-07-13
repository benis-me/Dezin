import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  Store,
  WorkspaceCommandReplayConflictError,
  WorkspaceRevisionConflictError,
  WorkspaceStore,
  WorkspaceStoreCodecError,
  type ArtifactRevisionRecord,
  type ArtifactTrackRecord,
  type StoreClock,
  type WorkspaceArtifactRecord,
  type WorkspaceGraphCommand,
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

function rowCount(db: DatabaseSync, table: string, where = "1 = 1"): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count);
}

function expectedPathSegment(value: string): string {
  const digest = createHash("sha256").update(`workspace-path-segment-v1\0${value}`).digest("hex");
  return value.length <= 90 && /^(?!\.{1,2}$)[a-z0-9_-]+$/.test(value)
    ? `raw-${value}`
    : `hash-${digest}`;
}

function expectedArtifactSourceRoot(workspaceId: string, artifactId: string): string {
  return `workspaces/${expectedPathSegment(workspaceId)}/artifacts/${expectedPathSegment(artifactId)}`;
}

function seedSnapshotSuccessor(
  db: DatabaseSync,
  workspace: { id: string; activeSnapshotId: string; activeKernelRevisionId: string },
  id = "snapshot-external",
): void {
  const sequence = Number((db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workspace_snapshots WHERE workspace_id = ?",
  ).get(workspace.id) as { sequence: number }).sequence);
  db.prepare(
    `INSERT INTO workspace_snapshots (
       id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
       reason, provenance_json, created_by_run_id, created_at
     ) VALUES (?, ?, ?, ?, 0, ?, 'external-publication',
               '{"kind":"legacy-migration","migration":"stale-snapshot-fixture"}', NULL, 500)`,
  ).run(id, workspace.id, sequence, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
  db.prepare("UPDATE project_workspaces SET active_snapshot_id = ? WHERE id = ?").run(id, workspace.id);
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
     VALUES ('snapshot-2', ?, 2, ?, 1, ?, 'test-checkpoint',
             '{"kind":"legacy-migration","migration":"test-fixture"}', NULL, 25)`,
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
  assert.deepEqual(snapshots[1]?.provenance, { kind: "legacy-migration", migration: "test-fixture" });

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
  store.db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(
      () => store.db.prepare(
        `INSERT OR REPLACE INTO project_workspaces (
           id, project_id, graph_revision, active_snapshot_id, active_kernel_revision_id, created_at, updated_at
         )
         SELECT id, project_id, graph_revision, active_snapshot_id, active_kernel_revision_id, created_at, updated_at
         FROM project_workspaces WHERE id = ?`,
      ).run(workspace.id),
      /replace workspace/i,
    );
  } finally {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
  }
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
  assert.throws(() => store.workspace.listSnapshots(project.id), /must be an object/i);

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

test("graph commands commit once and exact replay returns the original immutable result", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Commands", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const input = {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: " command-page ",
      type: " add-node ",
      node: {
        id: " page-1 ",
        kind: " page ",
        name: " Home ",
        artifactId: " artifact-page-1 ",
        createIdentity: { initialTrackId: " track-main " },
      },
    }],
  };

  const first = store.workspace.applyGraphCommands(project.id, input as never);
  assert.equal(first.graph.revision, 1);
  assert.deepEqual(store.workspace.applyGraphCommands(project.id, input as never), first);
  assert.equal(store.workspace.listSnapshots(project.id).length, 2);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, first.snapshot.id);

  const second = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 1,
    expectedSnapshotId: first.snapshot.id,
    commands: [{ id: "command-rename", type: "rename-node", nodeId: "page-1", name: "Landing" }],
  });
  assert.equal(second.graph.revision, 2);
  const snapshotCount = store.workspace.listSnapshots(project.id).length;
  assert.deepEqual(store.workspace.applyGraphCommands(project.id, input as never), first);
  assert.equal(store.workspace.getGraph(project.id).revision, 2);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, second.snapshot.id);
  assert.equal(store.workspace.listSnapshots(project.id).length, snapshotCount);
  store.close();
});

test("graph publication canonicalizes tied-timestamp node and edge order to the durable index", () => {
  let id = 0;
  const store = new Store(":memory:", { now: () => 1_000, id: () => `constant-id-${++id}` });
  const project = store.createProject({ name: "Canonical graph order", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const result = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "add-node-z",
        type: "add-node",
        node: {
          id: "node-z",
          kind: "page",
          name: "Page Z",
          artifactId: "artifact-z",
          createIdentity: { initialTrackId: "track-z" },
        },
      },
      {
        id: "add-node-a",
        type: "add-node",
        node: {
          id: "node-a",
          kind: "page",
          name: "Page A",
          artifactId: "artifact-a",
          createIdentity: { initialTrackId: "track-a" },
        },
      },
      {
        id: "add-edge-z",
        type: "add-edge",
        edge: {
          id: "edge-z",
          workspaceId: workspace.id,
          kind: "prototype",
          sourceNodeId: "node-z",
          targetNodeId: "node-a",
        },
      },
      {
        id: "add-edge-a",
        type: "add-edge",
        edge: {
          id: "edge-a",
          workspaceId: workspace.id,
          kind: "prototype",
          sourceNodeId: "node-z",
          targetNodeId: "node-a",
        },
      },
    ],
  });
  assert.deepEqual(result.graph.nodes.map(({ id: nodeId }) => nodeId), ["node-a", "node-z"]);
  assert.deepEqual(result.graph.edges.map(({ id: edgeId }) => edgeId), ["edge-a", "edge-z"]);
  assert.deepEqual(store.workspace.getGraph(project.id), result.graph);
  assert.deepEqual(store.workspace.getGraphRevision(project.id, result.graph.revision), result.graph);
  store.close();
});

test("graph publication rolls back when the durable index misses an applied delta", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Durable delta assertion", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  store.db.exec(`
    CREATE TRIGGER ignore_test_graph_edge
    BEFORE INSERT ON workspace_edges
    BEGIN SELECT RAISE(IGNORE); END;
  `);
  const countsBefore = [
    "workspace_artifacts",
    "artifact_tracks",
    "workspace_nodes",
    "workspace_edges",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table));
  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "add-delta-source",
        type: "add-node",
        node: {
          id: "delta-source",
          kind: "page",
          name: "Source",
          artifactId: "delta-source-artifact",
          createIdentity: { initialTrackId: "delta-source-track" },
        },
      },
      {
        id: "add-delta-target",
        type: "add-node",
        node: {
          id: "delta-target",
          kind: "page",
          name: "Target",
          artifactId: "delta-target-artifact",
          createIdentity: { initialTrackId: "delta-target-track" },
        },
      },
      {
        id: "add-delta-edge",
        type: "add-edge",
        edge: {
          id: "delta-edge",
          workspaceId: workspace.id,
          kind: "prototype",
          sourceNodeId: "delta-source",
          targetNodeId: "delta-target",
        },
      },
    ],
  }), /durable workspace graph does not match applied commands/);
  assert.deepEqual([
    "workspace_artifacts",
    "artifact_tracks",
    "workspace_nodes",
    "workspace_edges",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table)), countsBefore);
  assert.equal(store.workspace.getGraph(project.id).revision, 0);
  store.close();
});

test("a valid bind-then-remove batch persists its intermediate prototype update atomically", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Intermediate graph state", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const first = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "add-source",
        type: "add-node",
        node: {
          id: "source-page",
          kind: "page",
          name: "Source",
          artifactId: "source-artifact",
          createIdentity: { initialTrackId: "source-track" },
        },
      },
      {
        id: "add-target",
        type: "add-node",
        node: {
          id: "target-page",
          kind: "page",
          name: "Target",
          artifactId: "target-artifact",
          createIdentity: { initialTrackId: "target-track" },
        },
      },
      {
        id: "add-prototype",
        type: "add-edge",
        edge: {
          id: "transient-prototype",
          workspaceId: workspace.id,
          kind: "prototype",
          sourceNodeId: "source-page",
          targetNodeId: "target-page",
        },
      },
    ],
  });
  const second = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 1,
    expectedSnapshotId: first.snapshot.id,
    commands: [
      {
        id: "bind-transient-prototype",
        type: "bind-prototype",
        edgeId: "transient-prototype",
        binding: {
          sourceArtifactId: "source-artifact",
          sourceRevisionId: "source-revision",
          sourceLocator: { designNodeId: "cta" },
          trigger: "click",
          targetArtifactId: "target-artifact",
        },
      },
      { id: "remove-transient-prototype", type: "remove-edge", edgeId: "transient-prototype" },
    ],
  });
  assert.deepEqual(second.graph.edges, []);
  assert.equal(rowCount(store.db, "workspace_edges"), 0);
  assert.deepEqual(store.workspace.getGraphRevision(project.id, 1).edges.map(({ id: edgeId }) => edgeId), [
    "transient-prototype",
  ]);
  store.close();
});

test("graph command batches reject edge forward references before any durable write", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Forward edge reference", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const countsBefore = [
    "workspace_artifacts",
    "artifact_tracks",
    "resources",
    "workspace_nodes",
    "workspace_edges",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table));
  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "forward-edge",
        type: "add-edge",
        edge: {
          id: "forward-informs",
          workspaceId: workspace.id,
          kind: "informs",
          sourceNodeId: "forward-resource",
          targetNodeId: "forward-page",
        },
      },
      {
        id: "forward-resource-command",
        type: "add-node",
        node: {
          id: "forward-resource",
          kind: "resource",
          name: "Research",
          resourceId: "forward-resource-identity",
          createIdentity: { resourceKind: "research", defaultPinPolicy: "pin-current" },
        },
      },
      {
        id: "forward-page-command",
        type: "add-node",
        node: {
          id: "forward-page",
          kind: "page",
          name: "Page",
          artifactId: "forward-page-artifact",
          createIdentity: { initialTrackId: "forward-page-track" },
        },
      },
    ],
  }), WorkspaceGraphValidationError);
  assert.deepEqual([
    "workspace_artifacts",
    "artifact_tracks",
    "resources",
    "workspace_nodes",
    "workspace_edges",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table)), countsBefore);
  store.close();
});

test("graph command replay identity binds the full canonical ordered batch", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Replay identity", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const commands: WorkspaceGraphCommand[] = [
    {
      id: "command-page-a",
      type: "add-node",
      node: {
        id: "page-a",
        kind: "page",
        name: "Page A",
        artifactId: "artifact-page-a",
        createIdentity: { initialTrackId: "track-page-a" },
      },
    },
    {
      id: "command-page-b",
      type: "add-node",
      node: {
        id: "page-b",
        kind: "page",
        name: "Page B",
        artifactId: "artifact-page-b",
        createIdentity: { initialTrackId: "track-page-b" },
      },
    },
  ];
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands,
  });

  const pageACommand = commands[0] as Extract<WorkspaceGraphCommand, { type: "add-node" }>;
  const replayConflicts: WorkspaceGraphCommand[][] = [
    [pageACommand],
    [commands[1]!, pageACommand],
    [{ ...pageACommand, node: { ...pageACommand.node, name: "Changed" } }, commands[1]!],
  ];
  for (const replayConflict of replayConflicts) {
    assert.throws(
      () => store.workspace.applyGraphCommands(project.id, {
        baseGraphRevision: 0,
        expectedSnapshotId: workspace.activeSnapshotId,
        commands: replayConflict,
      }),
      WorkspaceCommandReplayConflictError,
    );
  }
  assert.throws(
    () => store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: 1,
      expectedSnapshotId: store.workspace.getWorkspace(project.id)!.activeSnapshotId,
      commands,
    }),
    WorkspaceCommandReplayConflictError,
  );
  assert.throws(
    () => store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: 0,
      expectedSnapshotId: workspace.activeSnapshotId,
      commands: [commands[0]!, {
        id: "new-command-mixed-with-replay",
        type: "rename-node",
        nodeId: "page-b",
        name: "Mixed",
      }],
    }),
    WorkspaceCommandReplayConflictError,
  );
  assert.equal(store.workspace.getGraph(project.id).revision, 1);
  assert.equal(rowCount(store.db, "workspace_graph_commands"), 2);
  assert.equal(rowCount(store.db, "workspace_snapshots"), 2);
  const auditRows = store.db.prepare(
    "SELECT batch_hash, batch_index, batch_size, payload_json FROM workspace_graph_commands ORDER BY batch_index",
  ).all() as Array<{ batch_hash: string; batch_index: number; batch_size: number; payload_json: string }>;
  assert.match(auditRows[0]?.batch_hash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(auditRows[0]?.batch_hash, auditRows[1]?.batch_hash);
  assert.deepEqual(auditRows.map(({ batch_index, batch_size }) => ({ batch_index, batch_size })), [
    { batch_index: 0, batch_size: 2 },
    { batch_index: 1, batch_size: 2 },
  ]);
  assert.equal(JSON.parse(auditRows[0]!.payload_json).id, "command-page-a");
  store.close();
});

test("graph mutation and layout envelopes reject accessors and revoked proxies without writing", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Strict envelopes", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  let getterCalls = 0;
  const graphInput = {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
  } as Record<string, unknown>;
  Object.defineProperty(graphInput, "commands", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [];
    },
  });
  assert.throws(
    () => store.workspace.applyGraphCommands(project.id, graphInput as never),
    WorkspaceStoreCodecError,
  );
  assert.equal(getterCalls, 0);

  const layoutCommand = { type: "move", objectId: "missing", x: 1 } as Record<string, unknown>;
  Object.defineProperty(layoutCommand, "y", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 2;
    },
  });
  assert.throws(() => store.workspace.saveLayout(project.id, {
    graphRevision: 0,
    commands: [layoutCommand] as never,
  }), WorkspaceStoreCodecError);
  assert.equal(getterCalls, 0);

  const revokedGraphInput = Proxy.revocable({
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [],
  }, {});
  revokedGraphInput.revoke();
  assert.throws(
    () => store.workspace.applyGraphCommands(project.id, revokedGraphInput.proxy as never),
    WorkspaceStoreCodecError,
  );
  const revokedCommands = Proxy.revocable([], {});
  revokedCommands.revoke();
  assert.throws(() => store.workspace.saveLayout(project.id, {
    graphRevision: 0,
    commands: revokedCommands.proxy as never,
  }), WorkspaceStoreCodecError);
  assert.equal(rowCount(store.db, "workspace_graph_commands"), 0);
  assert.equal(rowCount(store.db, "workspace_layout_nodes"), 0);
  store.close();
});

test("stale graph and stale active Snapshot graph batches roll back every table", () => {
  const staleGraphStore = new Store(":memory:", fakeClock());
  const staleGraphProject = staleGraphStore.createProject({ name: "Stale graph", mode: "standard" });
  const staleGraphWorkspace = staleGraphStore.workspace.ensureWorkspaceRecord(staleGraphProject.id);
  const first = staleGraphStore.workspace.applyGraphCommands(staleGraphProject.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: staleGraphWorkspace.activeSnapshotId,
    commands: [{
      id: "command-first",
      type: "add-node",
      node: {
        id: "page-first",
        kind: "page",
        name: "First",
        artifactId: "artifact-first",
        createIdentity: { initialTrackId: "track-first" },
      },
    }],
  });
  const staleGraphCounts = [
    "workspace_artifacts", "artifact_tracks", "workspace_nodes", "workspace_graph_revisions",
    "workspace_graph_commands", "workspace_snapshots",
  ].map((table) => rowCount(staleGraphStore.db, table));
  assert.throws(() => staleGraphStore.workspace.applyGraphCommands(staleGraphProject.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: staleGraphWorkspace.activeSnapshotId,
    commands: [{
      id: "command-stale",
      type: "add-node",
      node: {
        id: "page-stale",
        kind: "page",
        name: "Stale",
        artifactId: "artifact-stale",
        createIdentity: { initialTrackId: "track-stale" },
      },
    }],
  }), WorkspaceRevisionConflictError);
  assert.deepEqual([
    "workspace_artifacts", "artifact_tracks", "workspace_nodes", "workspace_graph_revisions",
    "workspace_graph_commands", "workspace_snapshots",
  ].map((table) => rowCount(staleGraphStore.db, table)), staleGraphCounts);
  assert.equal(staleGraphStore.workspace.getWorkspace(staleGraphProject.id)?.activeSnapshotId, first.snapshot.id);
  staleGraphStore.close();

  const staleSnapshotStore = new Store(":memory:", fakeClock());
  const staleSnapshotProject = staleSnapshotStore.createProject({ name: "Stale Snapshot", mode: "standard" });
  const staleSnapshotWorkspace = staleSnapshotStore.workspace.ensureWorkspaceRecord(staleSnapshotProject.id);
  seedSnapshotSuccessor(staleSnapshotStore.db, staleSnapshotWorkspace);
  const staleSnapshotCounts = [
    "workspace_artifacts", "artifact_tracks", "workspace_nodes", "workspace_graph_revisions",
    "workspace_graph_commands", "workspace_snapshots",
  ].map((table) => rowCount(staleSnapshotStore.db, table));
  assert.throws(() => staleSnapshotStore.workspace.applyGraphCommands(staleSnapshotProject.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: staleSnapshotWorkspace.activeSnapshotId,
    commands: [{
      id: "command-stale-snapshot",
      type: "add-node",
      node: {
        id: "page-stale-snapshot",
        kind: "page",
        name: "Stale Snapshot",
        artifactId: "artifact-stale-snapshot",
        createIdentity: { initialTrackId: "track-stale-snapshot" },
      },
    }],
  }), WorkspaceRevisionConflictError);
  assert.deepEqual([
    "workspace_artifacts", "artifact_tracks", "workspace_nodes", "workspace_graph_revisions",
    "workspace_graph_commands", "workspace_snapshots",
  ].map((table) => rowCount(staleSnapshotStore.db, table)), staleSnapshotCounts);
  assert.deepEqual(staleSnapshotStore.workspace.getGraph(staleSnapshotProject.id), {
    workspaceId: staleSnapshotWorkspace.id,
    revision: 0,
    nodes: [],
    edges: [],
  });
  staleSnapshotStore.close();
});

test("graph deltas create, attach, rename, and archive durable identity shells atomically", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Identities", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertResource(store.db, workspace.id, "resource-existing");
  store.db.prepare("UPDATE resources SET title = 'Existing research' WHERE id = 'resource-existing'").run();

  const created = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "command-page",
        type: "add-node",
        node: {
          id: "page-node",
          kind: "page",
          name: "Home",
          artifactId: "artifact-page",
          createIdentity: { initialTrackId: "track-page" },
        },
      },
      {
        id: "command-component",
        type: "add-node",
        node: {
          id: "component-node",
          kind: "component",
          name: "Button",
          artifactId: "artifact-component",
          createIdentity: { initialTrackId: "track-component" },
        },
      },
      {
        id: "command-resource",
        type: "add-node",
        node: {
          id: "resource-node",
          kind: "resource",
          name: "Moodboard",
          resourceId: "resource-new",
          createIdentity: { resourceKind: "moodboard", defaultPinPolicy: "pin-current" },
        },
      },
      {
        id: "command-existing-resource",
        type: "add-node",
        node: {
          id: "resource-existing-node",
          kind: "resource",
          name: "Existing research",
          resourceId: "resource-existing",
        },
      },
      {
        id: "command-informs",
        type: "add-edge",
        edge: {
          id: "edge-informs",
          workspaceId: workspace.id,
          kind: "informs",
          sourceNodeId: "resource-node",
          targetNodeId: "page-node",
        },
      },
    ],
  });
  assert.equal(created.graph.nodes.length, 4);
  assert.deepEqual(store.workspace.listArtifacts(project.id).map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    sourceRoot: artifact.sourceRoot,
    activeTrackId: artifact.activeTrackId,
  })), [
    {
      id: "artifact-page",
      kind: "page",
      name: "Home",
      sourceRoot: expectedArtifactSourceRoot(workspace.id, "artifact-page"),
      activeTrackId: "track-page",
    },
    {
      id: "artifact-component",
      kind: "component",
      name: "Button",
      sourceRoot: expectedArtifactSourceRoot(workspace.id, "artifact-component"),
      activeTrackId: "track-component",
    },
  ]);
  assert.equal(rowCount(store.db, "resources"), 2);
  assert.equal(rowCount(store.db, "artifact_tracks"), 2);
  assert.deepEqual(created.snapshot.artifactRevisions, {
    "artifact-component": null,
    "artifact-page": null,
  });

  insertResourceRevision(store.db, workspace.id, "resource-new", "resource-new-revision");
  store.db.prepare(
    "UPDATE resources SET head_revision_id = 'resource-new-revision' WHERE id = 'resource-new'",
  ).run();
  store.db.prepare(
    `INSERT INTO workspace_snapshot_resources
       (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, ?, 'resource-new', 'resource-new-revision')`,
  ).run(workspace.id, created.snapshot.id);

  const renamed = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 1,
    expectedSnapshotId: created.snapshot.id,
    commands: [
      { id: "rename-page", type: "rename-node", nodeId: "page-node", name: "Landing" },
      { id: "rename-resource", type: "rename-node", nodeId: "resource-node", name: "Visual direction" },
      { id: "archive-component", type: "archive-node", nodeId: "component-node" },
      { id: "archive-resource", type: "archive-node", nodeId: "resource-node" },
    ],
  });
  assert.equal(renamed.graph.nodes.length, 2);
  assert.deepEqual(renamed.graph.edges, []);
  assert.equal(store.workspace.listArtifacts(project.id).find(({ id }) => id === "artifact-page")?.name, "Landing");
  assert.ok(store.workspace.listArtifacts(project.id).find(({ id }) => id === "artifact-component")?.archivedAt);
  assert.equal(
    (store.db.prepare("SELECT title FROM resources WHERE id = 'resource-new'").get() as { title: string }).title,
    "Visual direction",
  );
  assert.ok((store.db.prepare("SELECT archived_at FROM workspace_nodes WHERE id = 'component-node'").get() as {
    archived_at: number | null;
  }).archived_at);
  assert.ok((store.db.prepare("SELECT archived_at FROM resources WHERE id = 'resource-new'").get() as {
    archived_at: number | null;
  }).archived_at);
  assert.equal(rowCount(store.db, "workspace_edges"), 0);
  assert.equal(store.workspace.getGraphRevision(project.id, 1).nodes.length, 4);
  assert.deepEqual(store.workspace.getGraphRevision(project.id, 1).edges.map(({ id }) => id), ["edge-informs"]);
  assert.equal(renamed.snapshot.artifactRevisions["artifact-component"], undefined);
  assert.equal(renamed.snapshot.resourceRevisions["resource-new"], undefined);
  const parentSnapshot = store.workspace.listSnapshots(project.id).find(({ id }) => id === created.snapshot.id);
  assert.equal(parentSnapshot?.artifactRevisions["artifact-component"], null);
  assert.equal(parentSnapshot?.resourceRevisions["resource-new"], "resource-new-revision");
  store.close();
});

test("existing identity attachment pins its exact current heads without re-deriving old Snapshot pins", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Existing pins", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "existing-artifact");
  store.db.prepare("UPDATE workspace_artifacts SET source_root = ? WHERE id = 'existing-artifact'")
    .run(expectedArtifactSourceRoot(workspace.id, "existing-artifact"));
  insertTrack(store.db, "existing-artifact", "existing-track");
  insertRevision(store.db, {
    id: "existing-revision",
    workspaceId: workspace.id,
    artifactId: "existing-artifact",
    trackId: "existing-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'existing-track' WHERE id = 'existing-artifact'").run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'existing-revision' WHERE id = 'existing-track'").run();
  insertResource(store.db, workspace.id, "existing-resource");
  insertResourceRevision(store.db, workspace.id, "existing-resource", "existing-resource-revision");
  store.db.prepare("UPDATE resources SET head_revision_id = 'existing-resource-revision' WHERE id = 'existing-resource'").run();

  const result = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "attach-existing-artifact",
        type: "add-node",
        node: {
          id: "existing-artifact-node",
          kind: "page",
          name: "Name existing-artifact",
          artifactId: "existing-artifact",
        },
      },
      {
        id: "attach-existing-resource",
        type: "add-node",
        node: {
          id: "existing-resource-node",
          kind: "resource",
          name: "Title existing-resource",
          resourceId: "existing-resource",
        },
      },
    ],
  });
  assert.deepEqual(result.snapshot.artifactTracks, { "existing-artifact": "existing-track" });
  assert.deepEqual(result.snapshot.artifactRevisions, { "existing-artifact": "existing-revision" });
  assert.deepEqual(result.snapshot.resourceRevisions, { "existing-resource": "existing-resource-revision" });
  store.close();
});

test("attach-then-archive removes the transient identity mapping from only the child Snapshot", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Transient identity", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "detached-artifact");
  store.db.prepare("UPDATE workspace_artifacts SET source_root = ? WHERE id = 'detached-artifact'")
    .run(expectedArtifactSourceRoot(workspace.id, "detached-artifact"));
  insertTrack(store.db, "detached-artifact", "detached-track");
  insertRevision(store.db, {
    id: "detached-revision",
    workspaceId: workspace.id,
    artifactId: "detached-artifact",
    trackId: "detached-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  store.db.prepare(
    "UPDATE workspace_artifacts SET active_track_id = 'detached-track' WHERE id = 'detached-artifact'",
  ).run();
  store.db.prepare(
    "UPDATE artifact_tracks SET head_revision_id = 'detached-revision' WHERE id = 'detached-track'",
  ).run();
  store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts
       (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     VALUES (?, ?, 'detached-artifact', 'detached-track', 'detached-revision')`,
  ).run(workspace.id, workspace.activeSnapshotId);

  const result = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "attach-detached",
        type: "add-node",
        node: {
          id: "transient-node",
          kind: "page",
          name: "Name detached-artifact",
          artifactId: "detached-artifact",
        },
      },
      { id: "archive-detached", type: "archive-node", nodeId: "transient-node" },
    ],
  });
  assert.deepEqual(result.graph.nodes, []);
  assert.equal(result.snapshot.artifactRevisions["detached-artifact"], undefined);
  const parent = store.workspace.listSnapshots(project.id).find(({ id }) => id === workspace.activeSnapshotId);
  assert.equal(parent?.artifactRevisions["detached-artifact"], "detached-revision");
  assert.ok(store.workspace.listArtifacts(project.id).find(({ id }) => id === "detached-artifact")?.archivedAt);
  store.close();
});

test("server-derived Artifact source roots cannot traverse and have bounded path segments", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Safe roots", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const longId = "x".repeat(400);
  const unsafeId = "../escape";
  const unsafeDigest = createHash("sha256")
    .update(`workspace-path-segment-v1\0${unsafeId}`)
    .digest("hex");
  const literalHashId = `hash-${unsafeDigest}`;
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "unsafe-path-command",
        type: "add-node",
        node: {
          id: "unsafe-path-node",
          kind: "page",
          name: "Unsafe request",
          artifactId: unsafeId,
          createIdentity: { initialTrackId: "unsafe-path-track" },
        },
      },
      {
        id: "long-path-command",
        type: "add-node",
        node: {
          id: "long-path-node",
          kind: "component",
          name: "Long request",
          artifactId: longId,
          createIdentity: { initialTrackId: "long-path-track" },
        },
      },
      {
        id: "literal-hash-path-command",
        type: "add-node",
        node: {
          id: "literal-hash-path-node",
          kind: "component",
          name: "Literal hash request",
          artifactId: literalHashId,
          createIdentity: { initialTrackId: "literal-hash-path-track" },
        },
      },
      {
        id: "uppercase-path-command",
        type: "add-node",
        node: {
          id: "uppercase-path-node",
          kind: "component",
          name: "Uppercase path",
          artifactId: "Panel",
          createIdentity: { initialTrackId: "uppercase-path-track" },
        },
      },
      {
        id: "lowercase-path-command",
        type: "add-node",
        node: {
          id: "lowercase-path-node",
          kind: "component",
          name: "Lowercase path",
          artifactId: "panel",
          createIdentity: { initialTrackId: "lowercase-path-track" },
        },
      },
    ],
  });
  const artifacts = store.workspace.listArtifacts(project.id);
  for (const artifact of artifacts) {
    const segments = artifact.sourceRoot.split("/");
    assert.equal(segments.includes(".."), false);
    assert.equal(artifact.sourceRoot.includes("../escape"), false);
    assert.ok(segments.every((segment) => segment.length <= 100));
    assert.match(artifact.sourceRoot, /^workspaces\/[^/]+\/artifacts\/[^/]+$/);
  }
  const unsafeRoot = artifacts.find(({ id }) => id === unsafeId)?.sourceRoot;
  const literalHashRoot = artifacts.find(({ id }) => id === literalHashId)?.sourceRoot;
  assert.equal(unsafeRoot, expectedArtifactSourceRoot(workspace.id, unsafeId));
  assert.equal(literalHashRoot, expectedArtifactSourceRoot(workspace.id, literalHashId));
  assert.notEqual(unsafeRoot, literalHashRoot);
  const uppercaseRoot = artifacts.find(({ id }) => id === "Panel")?.sourceRoot;
  const lowercaseRoot = artifacts.find(({ id }) => id === "panel")?.sourceRoot;
  assert.ok(uppercaseRoot && lowercaseRoot);
  assert.notEqual(uppercaseRoot.toLowerCase(), lowercaseRoot.toLowerCase());
  store.close();
});

test("existing Artifact attachment rejects a non-derived source root without writing", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Existing source root", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "unsafe-existing");
  insertTrack(store.db, "unsafe-existing", "unsafe-existing-track");
  store.db.prepare(
    "UPDATE workspace_artifacts SET active_track_id = 'unsafe-existing-track', source_root = '../escape' WHERE id = 'unsafe-existing'",
  ).run();
  const countsBefore = [
    "workspace_nodes",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table));
  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "attach-unsafe-existing",
      type: "add-node",
      node: {
        id: "unsafe-existing-node",
        kind: "page",
        name: "Name unsafe-existing",
        artifactId: "unsafe-existing",
      },
    }],
  }), /source root/i);
  assert.deepEqual([
    "workspace_nodes",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table)), countsBefore);
  store.close();
});

test("identity collisions and a later invalid command roll back the entire graph batch", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Identity rollback", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "artifact-existing", "page");

  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "claim-existing",
      type: "add-node",
      node: {
        id: "claim-node",
        kind: "page",
        name: "Wrong name",
        artifactId: "artifact-existing",
      },
    }],
  }), WorkspaceGraphValidationError);

  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "create-before-failure",
        type: "add-node",
        node: {
          id: "new-node",
          kind: "page",
          name: "New",
          artifactId: "artifact-new",
          createIdentity: { initialTrackId: "track-new" },
        },
      },
      { id: "rename-missing", type: "rename-node", nodeId: "missing", name: "Missing" },
    ],
  }), WorkspaceGraphValidationError);
  assert.equal(rowCount(store.db, "workspace_nodes"), 0);
  assert.equal(rowCount(store.db, "workspace_artifacts"), 1);
  assert.equal(rowCount(store.db, "artifact_tracks"), 0);
  assert.equal(rowCount(store.db, "workspace_graph_commands"), 0);
  assert.equal(rowCount(store.db, "workspace_graph_revisions"), 1);
  assert.equal(rowCount(store.db, "workspace_snapshots"), 1);
  store.close();
});

test("graph publication copies complete Snapshot mappings and stores typed provenance", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Mappings", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "mapped-artifact");
  insertTrack(store.db, "mapped-artifact", "mapped-track");
  insertRevision(store.db, {
    id: "mapped-revision",
    workspaceId: workspace.id,
    artifactId: "mapped-artifact",
    trackId: "mapped-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  insertResource(store.db, workspace.id, "mapped-resource");
  insertResourceRevision(store.db, workspace.id, "mapped-resource", "mapped-resource-revision");
  store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts
       (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     VALUES (?, ?, 'mapped-artifact', 'mapped-track', 'mapped-revision')`,
  ).run(workspace.id, workspace.activeSnapshotId);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_resources
       (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, ?, 'mapped-resource', 'mapped-resource-revision')`,
  ).run(workspace.id, workspace.activeSnapshotId);

  const result = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "add-page",
      type: "add-node",
      node: {
        id: "page-node",
        kind: "page",
        name: "Page",
        artifactId: "new-page",
        createIdentity: { initialTrackId: "new-page-track" },
      },
    }],
  });
  assert.deepEqual(result.snapshot.artifactTracks, {
    "mapped-artifact": "mapped-track",
    "new-page": "new-page-track",
  });
  assert.deepEqual(result.snapshot.artifactRevisions, {
    "mapped-artifact": "mapped-revision",
    "new-page": null,
  });
  assert.deepEqual(result.snapshot.resourceRevisions, { "mapped-resource": "mapped-resource-revision" });
  assert.deepEqual(result.snapshot.provenance, { kind: "graph-command", commandIds: ["add-page"] });
  assert.equal(result.snapshot.parentSnapshotId, workspace.activeSnapshotId);
  store.close();
});

test("graph revisions and command replay rows are immutable while Project deletion still cascades", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Immutable graph audit", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "audit-command",
      type: "add-node",
      node: {
        id: "audit-page",
        kind: "page",
        name: "Audit",
        artifactId: "audit-artifact",
        createIdentity: { initialTrackId: "audit-track" },
      },
    }],
  });
  assert.throws(
    () => store.db.prepare("UPDATE workspace_graph_revisions SET checksum = 'changed' WHERE revision = 1").run(),
    /immutable/i,
  );
  assert.throws(
    () => store.db.prepare(
      `INSERT OR REPLACE INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       SELECT workspace_id, revision, nodes_json, edges_json, 'replaced', created_at
       FROM workspace_graph_revisions WHERE workspace_id = ? AND revision = 1`,
    ).run(workspace.id),
    /immutable/i,
  );
  assert.throws(
    () => store.db.prepare("DELETE FROM workspace_graph_revisions WHERE workspace_id = ? AND revision = 1").run(workspace.id),
    /immutable/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE workspace_graph_commands SET payload_json = '{}' WHERE command_id = 'audit-command'").run(),
    /immutable/i,
  );
  assert.throws(
    () => store.db.prepare(
      `INSERT OR REPLACE INTO workspace_graph_commands (
         workspace_id, command_id, base_revision, result_revision, expected_snapshot_id,
         batch_hash, batch_index, batch_size, result_snapshot_id, payload_json, created_at
       )
       SELECT workspace_id, command_id, base_revision, result_revision, expected_snapshot_id,
              batch_hash, batch_index, batch_size, result_snapshot_id, '{}', created_at
       FROM workspace_graph_commands WHERE workspace_id = ? AND command_id = 'audit-command'`,
    ).run(workspace.id),
    /immutable/i,
  );
  assert.throws(
    () => store.db.prepare("DELETE FROM workspace_graph_commands WHERE command_id = 'audit-command'").run(),
    /immutable/i,
  );
  store.deleteProject(project.id);
  assert.equal(rowCount(store.db, "workspace_graph_revisions"), 0);
  assert.equal(rowCount(store.db, "workspace_graph_commands"), 0);
  store.close();
});

test("layout commands validate groups atomically and stay outside semantic history", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Layout", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "layout-page-command",
      type: "add-node",
      node: {
        id: "layout-page",
        kind: "page",
        name: "Layout Page",
        artifactId: "layout-artifact",
        createIdentity: { initialTrackId: "layout-track" },
      },
    }],
  });
  const historyCounts = {
    revisions: rowCount(store.db, "workspace_graph_revisions"),
    commands: rowCount(store.db, "workspace_graph_commands"),
    snapshots: rowCount(store.db, "workspace_snapshots"),
  };
  const layout = store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    commands: [
      { type: "add-group", groupId: "journey", label: "Journey", bounds: { x: 10, y: 20, width: 600, height: 400 } },
      { type: "add-group", groupId: "checkout", label: "Checkout", bounds: { x: 40, y: 50, width: 300, height: 200 } },
      { type: "set-parent", objectId: "checkout", parentGroupId: "journey" },
      { type: "set-parent", objectId: "layout-page", parentGroupId: "checkout" },
      { type: "move", objectId: "layout-page", x: 80, y: 90 },
      { type: "rename-group", groupId: "checkout", label: "Checkout flow" },
      { type: "resize-group", groupId: "checkout", width: 320, height: 240 },
      { type: "set-collapsed", groupId: "checkout", collapsed: true },
      { type: "set-viewport", viewport: { x: -20, y: 30, zoom: 0.8 } },
    ],
  });
  assert.deepEqual(store.workspace.getLayout(project.id, "default"), layout);
  assert.deepEqual({
    revisions: rowCount(store.db, "workspace_graph_revisions"),
    commands: rowCount(store.db, "workspace_graph_commands"),
    snapshots: rowCount(store.db, "workspace_snapshots"),
  }, historyCounts);
  assert.equal(store.workspace.getGraph(project.id).revision, graph.graph.revision);

  const beforeRows = rowCount(store.db, "workspace_layout_nodes");
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    commands: [
      { type: "add-group", groupId: "temporary", label: "Temporary", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "set-parent", objectId: "journey", parentGroupId: "checkout" },
    ],
  }), /cycle/i);
  assert.equal(rowCount(store.db, "workspace_layout_nodes"), beforeRows);
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    commands: [{ type: "move", objectId: "missing-node", x: 1, y: 2 }],
  }), /missing|does not exist/i);
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    commands: [
      { type: "add-group", groupId: "duplicate", label: "One", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "add-group", groupId: "duplicate", label: "Two", bounds: { x: 0, y: 0, width: 10, height: 10 } },
    ],
  }), /duplicate/i);

  const afterDelete = store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    commands: [{ type: "delete-group", groupId: "checkout", ungroupChildren: true }],
  });
  assert.equal(afterDelete.objects.find(({ id }) => id === "layout-page")?.parentGroupId, null);
  assert.equal(afterDelete.objects.find(({ id }) => id === "checkout"), undefined);
  assert.equal(afterDelete.objects.find(({ id }) => id === "journey")?.parentGroupId, null);
  store.close();
});

test("layout graph revision guard rejects stale writes without changing layout", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Stale layout", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const first = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "stale-layout-page",
      type: "add-node",
      node: {
        id: "stale-layout-node",
        kind: "page",
        name: "Page",
        artifactId: "stale-layout-artifact",
        createIdentity: { initialTrackId: "stale-layout-track" },
      },
    }],
  });
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 1,
    expectedSnapshotId: first.snapshot.id,
    commands: [{ id: "stale-layout-rename", type: "rename-node", nodeId: "stale-layout-node", name: "Renamed" }],
  });
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    commands: [{ type: "move", objectId: "stale-layout-node", x: 10, y: 20 }],
  }), WorkspaceRevisionConflictError);
  assert.equal(rowCount(store.db, "workspace_layout_nodes"), 0);
  store.close();
});

test("graph nodes cannot claim an id already used by a layout group", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Cross-layer ids", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  store.workspace.saveLayout(project.id, {
    layoutId: "alternate",
    graphRevision: 0,
    commands: [{
      type: "add-group",
      groupId: "shared-id",
      label: "Existing group",
      bounds: { x: 0, y: 0, width: 200, height: 100 },
    }],
  });
  const countsBefore = [
    "workspace_artifacts",
    "artifact_tracks",
    "workspace_nodes",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table));
  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "claim-layout-group-id",
      type: "add-node",
      node: {
        id: "shared-id",
        kind: "page",
        name: "Conflicting page",
        artifactId: "conflicting-artifact",
        createIdentity: { initialTrackId: "conflicting-track" },
      },
    }],
  }), /layout group/i);
  assert.deepEqual([
    "workspace_artifacts",
    "artifact_tracks",
    "workspace_nodes",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
  ].map((table) => rowCount(store.db, table)), countsBefore);
  assert.equal(store.workspace.getGraph(project.id).revision, 0);
  assert.equal(store.workspace.getLayout(project.id, "alternate").objects[0]?.id, "shared-id");
  store.close();
});

test("layout group ids remain reserved by archived semantic node history", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Historical node ids", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const created = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "create-reserved-node",
      type: "add-node",
      node: {
        id: "historical-node-id",
        kind: "page",
        name: "Historical",
        artifactId: "historical-artifact",
        createIdentity: { initialTrackId: "historical-track" },
      },
    }],
  });
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 1,
    expectedSnapshotId: created.snapshot.id,
    commands: [{ id: "archive-reserved-node", type: "archive-node", nodeId: "historical-node-id" }],
  });
  assert.deepEqual(store.workspace.getGraph(project.id).nodes, []);
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 2,
    commands: [{
      type: "add-group",
      groupId: "historical-node-id",
      label: "Conflicting group",
      bounds: { x: 0, y: 0, width: 200, height: 100 },
    }],
  }), /semantic node identity/i);
  assert.throws(() => store.db.prepare(
    `INSERT INTO workspace_layout_nodes (
       workspace_id, layout_id, object_id, object_kind, x, y, width, height,
       parent_group_id, label, collapsed, updated_at
     ) VALUES (?, 'raw', 'historical-node-id', 'group', 0, 0, 200, 100, NULL, 'Raw', 0, 900)`,
  ).run(workspace.id), /semantic node identity/i);
  assert.equal(rowCount(store.db, "workspace_layout_nodes"), 0);
  assert.deepEqual(store.workspace.getGraphRevision(project.id, 1).nodes.map(({ id: nodeId }) => nodeId), [
    "historical-node-id",
  ]);
  store.close();
});

test("transaction rollback failure never replaces the original graph validation error", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Rollback preservation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const exec = store.db.exec.bind(store.db);
  Object.defineProperty(store.db, "exec", {
    configurable: true,
    value(sql: string) {
      if (sql === "ROLLBACK") throw new Error("injected rollback failure");
      return exec(sql);
    },
  });

  let caught: unknown;
  try {
    store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: 0,
      expectedSnapshotId: workspace.activeSnapshotId,
      commands: [{ id: "rename-missing", type: "rename-node", nodeId: "missing-node", name: "Missing" }],
    });
  } catch (error) {
    caught = error;
  } finally {
    Reflect.deleteProperty(store.db, "exec");
    if (store.db.isTransaction) exec("ROLLBACK");
  }
  assert.ok(caught instanceof WorkspaceGraphValidationError);
  assert.match(caught.message, /missing-node/);
  assert.doesNotMatch(caught.message, /injected rollback failure/);
  store.close();
});

test("graph publication rejects fractional and exhausted Snapshot sequences before allocating an id", () => {
  for (const sequence of [1.5, Number.MAX_SAFE_INTEGER]) {
    const baseClock = fakeClock();
    let idCalls = 0;
    const store = new Store(":memory:", {
      now: baseClock.now,
      id: () => {
        idCalls += 1;
        return baseClock.id();
      },
    });
    const project = store.createProject({ name: `Snapshot sequence ${sequence}`, mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    if (Number.isInteger(sequence)) {
      store.db.prepare("UPDATE workspace_snapshots SET sequence = ? WHERE id = ?")
        .run(sequence, workspace.activeSnapshotId);
    } else {
      store.db.prepare(
        `INSERT INTO workspace_snapshots (
           id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
           reason, provenance_json, created_by_run_id, created_at
         ) VALUES ('fractional-sequence-fixture', ?, ?, ?, 0, ?, 'fixture',
                   '{"kind":"legacy-migration","migration":"fractional-sequence"}', NULL, 500)`,
      ).run(workspace.id, sequence, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
    }
    const idsBefore = idCalls;
    const countsBefore = [
      "workspace_artifacts",
      "artifact_tracks",
      "workspace_nodes",
      "workspace_graph_revisions",
      "workspace_graph_commands",
      "workspace_snapshots",
    ].map((table) => rowCount(store.db, table));
    assert.throws(() => store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: 0,
      expectedSnapshotId: workspace.activeSnapshotId,
      commands: [{
        id: `sequence-command-${sequence}`,
        type: "add-node",
        node: {
          id: `sequence-node-${sequence}`,
          kind: "page",
          name: "Sequence page",
          artifactId: `sequence-artifact-${sequence}`,
          createIdentity: { initialTrackId: `sequence-track-${sequence}` },
        },
      }],
    }), /next Workspace Snapshot sequence must be a positive safe integer/);
    assert.equal(idCalls, idsBefore);
    assert.deepEqual([
      "workspace_artifacts",
      "artifact_tracks",
      "workspace_nodes",
      "workspace_graph_revisions",
      "workspace_graph_commands",
      "workspace_snapshots",
    ].map((table) => rowCount(store.db, table)), countsBefore);
    store.close();
  }
});

test("getGraph reads revision, nodes, and edges from one SQLite snapshot", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-graph-read-")), "graph.db");
  const reader = new Store(file, fakeClock());
  const project = reader.createProject({ name: "Graph read snapshot", mode: "standard" });
  const workspace = reader.workspace.ensureWorkspaceRecord(project.id);
  let writerId = 0;
  const writer = new Store(file, {
    now: () => 8_000 + ++writerId,
    id: () => `graph-writer-id-${++writerId}`,
  });
  const prepare = reader.db.prepare.bind(reader.db);
  let writerCommitted = false;
  Object.defineProperty(reader.db, "prepare", {
    configurable: true,
    value(sql: string) {
      if (!writerCommitted && sql.includes("FROM workspace_nodes n")) {
        writer.workspace.applyGraphCommands(project.id, {
          baseGraphRevision: 0,
          expectedSnapshotId: workspace.activeSnapshotId,
          commands: [{
            id: "concurrent-read-command",
            type: "add-node",
            node: {
              id: "concurrent-read-node",
              kind: "page",
              name: "Concurrent",
              artifactId: "concurrent-read-artifact",
              createIdentity: { initialTrackId: "concurrent-read-track" },
            },
          }],
        });
        writerCommitted = true;
      }
      return prepare(sql);
    },
  });
  let observed: ReturnType<WorkspaceStore["getGraph"]>;
  try {
    observed = reader.workspace.getGraph(project.id);
  } finally {
    Reflect.deleteProperty(reader.db, "prepare");
  }
  assert.equal(writerCommitted, true);
  assert.deepEqual(observed, {
    workspaceId: workspace.id,
    revision: 0,
    nodes: [],
    edges: [],
  });
  assert.equal(reader.workspace.getGraph(project.id).revision, 1);
  assert.deepEqual(reader.workspace.getGraph(project.id).nodes.map(({ id: nodeId }) => nodeId), [
    "concurrent-read-node",
  ]);
  writer.close();
  reader.close();
});

test("a second SQLite connection waiting behind a graph writer observes the committed revision", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-layout-race-")), "race.db");
  const store = new Store(file, fakeClock());
  const project = store.createProject({ name: "Layout race", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const first = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "race-page-command",
      type: "add-node",
      node: {
        id: "race-page",
        kind: "page",
        name: "Race",
        artifactId: "race-artifact",
        createIdentity: { initialTrackId: "race-track" },
      },
    }],
  });
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.moduleUrl).then(({ Store }) => {
      let nextId = 0;
      const store = new Store(workerData.file, { now: () => 9000 + ++nextId, id: () => "worker-id-" + ++nextId });
      parentPort.postMessage({ kind: "ready" });
      parentPort.on("message", (message) => {
        if (message.kind !== "save") return;
        parentPort.postMessage({ kind: "calling" });
        try {
          store.workspace.saveLayout(workerData.projectId, message.input);
          parentPort.postMessage({ kind: "result", ok: true });
        } catch (error) {
          parentPort.postMessage({ kind: "result", ok: false, name: error?.name, message: error?.message });
        } finally {
          store.close();
        }
      });
    }).catch((error) => parentPort.postMessage({ kind: "boot-error", message: error?.stack ?? String(error) }));
  `, {
    eval: true,
    workerData: { file, projectId: project.id, moduleUrl: new URL("../src/index.ts", import.meta.url).href },
  });
  const nextMessage = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  assert.deepEqual(await nextMessage(), { kind: "ready" });

  let resultPromise: Promise<Record<string, unknown>> | undefined;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const graphRow = store.db.prepare(
      "SELECT nodes_json, edges_json FROM workspace_graph_revisions WHERE workspace_id = ? AND revision = 1",
    ).get(workspace.id) as { nodes_json: string; edges_json: string };
    store.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES (?, 2, ?, ?, 'race-graph-2', 700)`,
    ).run(workspace.id, graphRow.nodes_json, graphRow.edges_json);
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at
       ) VALUES ('race-snapshot-2', ?, 3, ?, 2, ?, 'race',
                 '{"kind":"graph-command","commandIds":["race-manual"]}', NULL, 701)`,
    ).run(workspace.id, first.snapshot.id, workspace.activeKernelRevisionId);
    store.db.prepare(
      "UPDATE project_workspaces SET graph_revision = 2, active_snapshot_id = 'race-snapshot-2' WHERE id = ?",
    ).run(workspace.id);

    worker.postMessage({
      kind: "save",
      input: {
        layoutId: "default",
        graphRevision: 1,
        commands: [{ type: "move", objectId: "race-page", x: 10, y: 20 }],
      },
    });
    assert.deepEqual(await nextMessage(), { kind: "calling" });
    resultPromise = nextMessage();
    const blocked = await Promise.race([
      resultPromise.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 75)),
    ]);
    assert.equal(blocked, true, "layout writer returned while the graph transaction still held the write lock");
    store.db.exec("COMMIT");
  } catch (error) {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
    throw error;
  }
  assert.ok(resultPromise);
  const result = await resultPromise;
  assert.equal(result.kind, "result");
  assert.equal(result.ok, false);
  assert.equal(result.name, "WorkspaceRevisionConflictError");
  assert.equal(rowCount(store.db, "workspace_layout_nodes"), 0);
  await worker.terminate();
  store.close();
});
