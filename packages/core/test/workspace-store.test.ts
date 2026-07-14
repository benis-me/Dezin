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
  asWorkspaceProposalAudit,
  LegacyWorkspaceSeedDriftError,
  WorkspaceCommandReplayConflictError,
  WorkspaceLayoutConflictError,
  WorkspacePointerConflictError,
  WorkspaceProposalConflictError,
  WorkspaceProposalOwnershipError,
  WorkspaceProposalRevisionConflictError,
  WorkspaceProposalStateConflictError,
  WorkspaceProposalValidationError,
  WorkspaceRevisionConflictError,
  WorkspaceStore,
  WorkspaceStoreCodecError,
  type ArtifactRevisionRecord,
  type ArtifactTrackRecord,
  type ResourceKind,
  type StoreClock,
  type WorkspaceArtifactRecord,
  type WorkspaceGraphCommand,
  type WorkspaceProposal,
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
  "artifact_revision_resources",
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
  "workspace_proposals",
  "workspace_proposal_audit",
  "generation_plans",
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
  sourceRoot = expectedArtifactSourceRoot(workspaceId, id),
): void {
  db.prepare(
    `INSERT INTO workspace_artifacts
       (id, workspace_id, kind, name, source_root, active_track_id, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 10, 11)`,
  ).run(id, workspaceId, kind, `Name ${id}`, sourceRoot, activeTrackId);
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
    sealed?: 0 | 1;
  },
): void {
  const artifactRoot = (db.prepare(
    "SELECT source_root FROM workspace_artifacts WHERE id = ? AND workspace_id = ?",
  ).get(input.artifactId, input.workspaceId) as { source_root: string }).source_root;
  db.prepare(
    `INSERT INTO artifact_revisions (
       id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
       source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
       render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
       legacy_run_id, created_at, sealed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 13, ?)`,
  ).run(
    input.id,
    input.workspaceId,
    input.artifactId,
    input.trackId,
    input.sequence ?? 1,
    input.parentRevisionId ?? null,
    `commit-${input.id}`,
    `tree-${input.id}`,
    artifactRoot,
    input.kernelRevisionId,
    JSON.stringify({ frames: [{ id: "desktop", width: 1440, height: 900 }] }),
    JSON.stringify({ state: "passed", score: 98, findings: [] }),
    input.sealed ?? 1,
  );
}

function insertResource(
  db: DatabaseSync,
  workspaceId: string,
  id: string,
  headRevisionId: string | null = null,
  kind: ResourceKind = "research",
): void {
  db.prepare(
    `INSERT INTO resources (
       id, workspace_id, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'follow-head', NULL, 14, 15)`,
  ).run(id, workspaceId, kind, `Title ${id}`, headRevisionId);
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
  assert.throws(action, /constraint|ownership|belongs|delete workspace|immutable|active state/i);
  const after = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  assert.equal(after, before, `${table} changed after a rejected ownership write`);
}

interface LineageReadCounts {
  artifactRows: number;
  artifactReferenceReads: number;
  kernelRows: number;
  runOwnershipReads: number;
  snapshotRows: number;
}

function observeLineageReads(
  db: DatabaseSync,
  clock: StoreClock,
  counts: LineageReadCounts,
): WorkspaceStore {
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const normalized = sql.replace(/\s+/g, " ").trim();
          if ((normalized.includes("FROM artifact_revisions parent")
              && normalized.endsWith("WHERE parent.id = ?"))
            || (normalized.includes("FROM artifact_revisions revision")
              && normalized.endsWith("WHERE revision.id = ?"))) {
            counts.artifactRows += 1;
          }
          if (normalized === "SELECT * FROM shared_design_kernel_revisions WHERE id = ?") {
            counts.kernelRows += 1;
          }
          if (normalized === "SELECT * FROM artifact_tracks WHERE id = ?") {
            counts.artifactReferenceReads += 1;
          }
          if (normalized.includes("FROM runs run JOIN project_workspaces workspace")) {
            counts.runOwnershipReads += 1;
          }
          if (normalized === "SELECT * FROM workspace_snapshots WHERE id = ?") {
            counts.snapshotRows += 1;
          }
          if (normalized === "SELECT * FROM workspace_snapshots WHERE workspace_id = ? AND id = ?") {
            counts.snapshotRows += 1;
          }
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new WorkspaceStore(observed, clock);
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

function workspaceGraphChecksum(nodesJson: string, edgesJson: string): string {
  return createHash("sha256").update(`${nodesJson}\n${edgesJson}`).digest("hex");
}

function emptyWorkspaceGenerationPayload() {
  return {
    kind: "workspace-generation" as const,
    resourceOperations: [],
    artifactPlans: [],
    dependencyPlans: [],
    prototypeIntents: [],
    capabilities: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  };
}

function proposalPageCommand(
  suffix: string,
  name = `Page ${suffix}`,
): WorkspaceGraphCommand {
  return {
    id: `proposal-command-${suffix}`,
    type: "add-node",
    node: {
      id: `proposal-node-${suffix}`,
      kind: "page",
      name,
      artifactId: `proposal-artifact-${suffix}`,
      createIdentity: { initialTrackId: `proposal-track-${suffix}` },
    },
  };
}

function workspaceGenerationProposalInput(
  store: Store,
  projectId: string,
  operations: WorkspaceGraphCommand[],
  overrides: Record<string, unknown> = {},
) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  const layout = store.workspace.getLayout(projectId);
  return {
    projectId,
    kind: "workspace-generation" as const,
    baseGraphRevision: workspace.graphRevision,
    baseSnapshotId: workspace.activeSnapshotId,
    layoutId: layout.layoutId,
    baseLayoutChecksum: layout.checksum,
    operations,
    layoutOperations: [],
    generation: emptyWorkspaceGenerationPayload(),
    rationale: "Create the proposed workspace structure",
    assumptions: [],
    ...overrides,
  };
}

function insertRawWorkspaceProposal(db: DatabaseSync, proposal: WorkspaceProposal): void {
  db.prepare(
    `INSERT INTO workspace_proposals (
       id, workspace_id, base_graph_revision, base_snapshot_id, revision, kind, status,
       operations_json, layout_id, base_layout_checksum, base_layout_json,
       layout_operations_json, rationale, assumptions_json, generation_payload_json,
       review_json, created_by_run_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    proposal.id,
    proposal.workspaceId,
    proposal.baseGraphRevision,
    proposal.baseSnapshotId,
    proposal.revision,
    proposal.kind,
    proposal.status,
    JSON.stringify(proposal.operations),
    proposal.layoutId,
    proposal.baseLayoutChecksum,
    JSON.stringify(proposal.baseLayout),
    JSON.stringify(proposal.layoutOperations),
    proposal.rationale,
    JSON.stringify(proposal.assumptions),
    JSON.stringify(proposal.generation),
    JSON.stringify(proposal.review),
    proposal.createdByRunId,
    proposal.createdAt,
    proposal.updatedAt,
  );
}

function insertRawWorkspaceProposalAudit(db: DatabaseSync, proposal: WorkspaceProposal): void {
  db.prepare(
    `INSERT INTO workspace_proposal_audit (proposal_id, revision, payload_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(proposal.id, proposal.revision, JSON.stringify(proposal), proposal.updatedAt);
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

function standardArtifactRevisionInput(input: {
  artifactId: string;
  trackId: string;
  parentRevisionId: string | null;
  kernelRevisionId: string;
  tree: string;
  dependencies?: Array<{
    instanceId: string;
    componentArtifactId: string;
    componentRevisionId: string;
    createInstanceIdentity?: true;
    variantKey?: string;
    stateKey?: string;
    sourceLocator: { designNodeId: string; sourcePath?: string; selector?: string };
    overrides: Record<string, unknown>;
    status: "linked" | "detached";
  }>;
  resourcePins?: Array<{ resourceId: string; resourceRevisionId: string }>;
  producedByRunId?: string;
}) {
  return {
    artifactId: input.artifactId,
    trackId: input.trackId,
    parentRevisionId: input.parentRevisionId,
    sourceCommitHash: `commit-${input.tree}`,
    sourceTreeHash: input.tree,
    kernelRevisionId: input.kernelRevisionId,
    renderSpec: { frames: [{ id: "desktop", width: 1440, height: 900 }] },
    quality: { state: "passed", score: 98, findings: [] },
    contextPackHash: `context-${input.tree}`,
    ...(input.producedByRunId === undefined ? {} : { producedByRunId: input.producedByRunId }),
    dependencies: input.dependencies ?? [],
    resourcePins: input.resourcePins ?? [],
  };
}

function reuseInstanceDependency<T extends { createInstanceIdentity?: true }>(dependency: T): Omit<T, "createInstanceIdentity"> {
  const copy = { ...dependency };
  delete copy.createInstanceIdentity;
  return copy;
}

function addRevisionTestArtifacts(store: Store, projectId: string, expectedSnapshotId: string) {
  const workspace = store.workspace.getWorkspace(projectId)!;
  return store.workspace.applyGraphCommands(projectId, {
    baseGraphRevision: workspace.graphRevision,
    expectedSnapshotId,
    commands: [
      {
        id: `add-page-${workspace.graphRevision}`,
        type: "add-node" as const,
        node: {
          id: "revision-page-node",
          kind: "page" as const,
          name: "Revision page",
          artifactId: "revision-page",
          createIdentity: { initialTrackId: "revision-page-track" },
        },
      },
      {
        id: `add-component-${workspace.graphRevision}`,
        type: "add-node" as const,
        node: {
          id: "revision-component-node",
          kind: "component" as const,
          name: "Revision component",
          artifactId: "revision-component",
          createIdentity: { initialTrackId: "revision-component-track" },
        },
      },
    ],
  });
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

  assert.throws(() => store.workspace.ensureWorkspaceRecord(second.id), /constraint|immutable/i);
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
      kind: "informs" as const,
      sourceNodeId: "node-resource",
      targetNodeId: "node-page",
    }],
  };
  const historicalNodesJson = JSON.stringify(historicalGraph.nodes);
  const historicalEdgesJson = JSON.stringify(historicalGraph.edges);
  store.db.prepare(
    `INSERT INTO workspace_graph_revisions
       (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
     VALUES (?, 1, ?, ?, ?, 24)`,
  ).run(
    workspace.id,
    historicalNodesJson,
    historicalEdgesJson,
    workspaceGraphChecksum(historicalNodesJson, historicalEdgesJson),
  );
  store.db.prepare(
    `INSERT INTO workspace_snapshots
       (id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id, reason, provenance_json, created_by_run_id, created_at, sealed)
     VALUES ('snapshot-2', ?, 2, ?, 1, ?, 'test-checkpoint',
             '{"kind":"legacy-migration","migration":"test-fixture"}', NULL, 25, 0)`,
  ).run(workspace.id, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     VALUES (?, 'snapshot-2', 'artifact-page', 'track-main', 'revision-page-1')`,
  ).run(workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_resources (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, 'snapshot-2', 'resource-research', 'resource-revision-1')`,
  ).run(workspace.id);
  store.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = 'snapshot-2'").run();
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
    sourceRoot: expectedArtifactSourceRoot(workspace.id, "artifact-page"),
    legacyWrapped: false,
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
    artifactRoot: expectedArtifactSourceRoot(workspace.id, "artifact-page"),
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

  const pointerFailure = (action: () => void) => assert.throws(action, /ownership|belongs|immutable|active state|direct child/i);

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
    sealed: 0,
  });
  insertRevision(store.db, {
    id: "delete-component-revision",
    workspaceId: workspace.id,
    artifactId: "delete-component",
    trackId: "delete-component-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
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
  store.db.prepare("UPDATE artifact_revisions SET sealed = 1 WHERE id = 'delete-page-revision'").run();
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'delete-page-track' WHERE id = 'delete-page'").run();
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'delete-component-track' WHERE id = 'delete-component'").run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'delete-page-revision' WHERE id = 'delete-page-track'").run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'delete-component-revision' WHERE id = 'delete-component-track'").run();
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
    `INSERT INTO workspace_snapshots (
       id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
       reason, provenance_json, created_by_run_id, created_at, sealed
     ) VALUES ('delete-snapshot', ?, 2, ?, 0, ?, 'delete-fixture',
               '{"kind":"legacy-migration","migration":"delete-fixture"}', NULL, 2, 0)`,
  ).run(workspace.id, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts
       (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     VALUES (?, 'delete-snapshot', 'delete-page', 'delete-page-track', 'delete-page-revision'),
            (?, 'delete-snapshot', 'delete-component', 'delete-component-track', 'delete-component-revision')`,
  ).run(workspace.id, workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_resources (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, 'delete-snapshot', 'delete-resource', 'delete-resource-revision')`,
  ).run(workspace.id);
  store.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = 'delete-snapshot'").run();

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
    /constraint|active state|direct child/i,
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
    /kind ownership|identity.*immutable/i,
  );
  store.db.prepare(
    `INSERT INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('page-node', ?, 'page', 'page-1', NULL, NULL, 1, 1)`,
  ).run(workspace.id);
  assert.throws(
    () => store.db.prepare("UPDATE workspace_nodes SET artifact_id = 'component-1' WHERE id = 'page-node'").run(),
    /kind ownership|identity.*immutable/i,
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
    /component kind|identity.*immutable/i,
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
    /component kind|identity.*immutable/i,
  );
  store.close();
});

test("active, Head, and parent pointers cannot dangle when their owned target is deleted", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Pointer targets", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);

  assert.throws(
    () => store.db.prepare("DELETE FROM workspace_snapshots WHERE id = ?").run(workspace.activeSnapshotId),
    /constraint|immutable/i,
  );
  assert.throws(
    () => store.db.prepare("DELETE FROM shared_design_kernel_revisions WHERE id = ?").run(workspace.activeKernelRevisionId),
    /constraint|immutable/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET active_snapshot_id = NULL WHERE id = ?").run(workspace.id),
    /active snapshot|active state/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET active_kernel_revision_id = NULL WHERE id = ?").run(workspace.id),
    /active kernel|active state/i,
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
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'revision-parent' WHERE id = 'track-parent'").run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'revision-child' WHERE id = 'track-parent'").run();
  assert.throws(() => store.db.prepare("DELETE FROM artifact_tracks WHERE id = 'track-parent'").run(), /constraint|history/i);
  assert.throws(() => store.db.prepare("DELETE FROM artifact_revisions WHERE id = 'revision-parent'").run(), /constraint|immutable/i);
  assert.ok(store.db.prepare("SELECT id FROM artifact_revisions WHERE id = 'revision-child'").get());

  insertResource(store.db, workspace.id, "resource-head");
  insertResourceRevision(store.db, workspace.id, "resource-head", "resource-head-revision");
  store.db.prepare("UPDATE resources SET head_revision_id = 'resource-head-revision' WHERE id = 'resource-head'").run();
  assert.throws(
    () => store.db.prepare("DELETE FROM resource_revisions WHERE id = 'resource-head-revision'").run(),
    /constraint|immutable/i,
  );
  store.close();
});

test("workspace codecs reject corrupt immutable JSON instead of silently replacing it", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Corrupt JSON", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(store.db, workspace.id, "artifact-json");
  insertTrack(store.db, "artifact-json", "track-json");
  store.db.prepare(
    `INSERT INTO artifact_revisions (
       id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
       source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
       render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
       legacy_run_id, created_at
     ) VALUES ('revision-json', ?, 'artifact-json', 'track-json', 1, NULL,
               'commit-json', 'tree-json', ?, ?,
               '{', '{}', NULL, NULL, NULL, 13)`,
  ).run(
    workspace.id,
    expectedArtifactSourceRoot(workspace.id, "artifact-json"),
    workspace.activeKernelRevisionId,
  );
  assert.throws(() => store.workspace.listRevisions(project.id, "artifact-json"), /valid JSON/i);
  store.db.prepare(
    `INSERT INTO workspace_snapshots (
       id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
       reason, provenance_json, created_by_run_id, created_at
     ) VALUES ('snapshot-json-corrupt', ?, 2, ?, 0, ?, 'corrupt', '[]', NULL, 14)`,
  ).run(workspace.id, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
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
  assert.throws(
    () => store.workspace.getGraph(project.id),
    /mutable workspace graph does not match immutable graph revision/i,
  );
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

test("getGraph rejects a raw semantic node rename that is absent from the immutable revision", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Mutable rename drift", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const published = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "add-rename-drift-page",
      type: "add-node",
      node: {
        id: "rename-drift-page-node",
        kind: "page",
        name: "Original page",
        artifactId: "rename-drift-page",
        createIdentity: { initialTrackId: "rename-drift-page-track" },
      },
    }],
  });
  const immutable = store.workspace.getGraphRevision(project.id, published.graph.revision);

  store.db.prepare(
    "UPDATE workspace_artifacts SET name = 'Raw renamed page' WHERE id = 'rename-drift-page'",
  ).run();

  assert.throws(
    () => store.workspace.getGraph(project.id),
    /mutable workspace graph does not match immutable graph revision/i,
  );
  assert.deepEqual(store.workspace.getGraphRevision(project.id, published.graph.revision), immutable);
  store.close();
});

test("applyGraphCommands rejects a headless Resource-node drift without durable writes", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Headless Resource drift", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const published = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "add-headless-drift-page",
      type: "add-node",
      node: {
        id: "headless-drift-page-node",
        kind: "page",
        name: "Stable page",
        artifactId: "headless-drift-page",
        createIdentity: { initialTrackId: "headless-drift-page-track" },
      },
    }],
  });
  store.workspace.saveLayout(project.id, {
    layoutId: "drift-layout",
    graphRevision: published.graph.revision,
    baseLayoutChecksum: store.workspace.getLayout(project.id, "drift-layout").checksum,
    commands: [
      { type: "move", objectId: "headless-drift-page-node", x: 120, y: 80 },
      { type: "set-viewport", viewport: { x: -10, y: 20, zoom: 0.75 } },
    ],
  });
  insertResource(store.db, workspace.id, "headless-drift-resource");
  store.db.prepare(
    `INSERT INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('headless-drift-resource-node', ?, 'resource', NULL,
             'headless-drift-resource', NULL, 900, 900)`,
  ).run(workspace.id);

  assert.throws(
    () => store.workspace.getGraph(project.id),
    /mutable workspace graph does not match immutable graph revision/i,
  );
  const trackedTables = [
    "workspace_artifacts",
    "artifact_tracks",
    "resources",
    "workspace_nodes",
    "workspace_edges",
    "workspace_graph_revisions",
    "workspace_graph_commands",
    "workspace_snapshots",
    "workspace_snapshot_artifacts",
    "workspace_snapshot_resources",
    "workspace_layout_nodes",
    "workspace_layout_viewports",
  ] as const;
  const countsBefore = trackedTables.map((table) => rowCount(store.db, table));
  const workspaceBefore = store.workspace.getWorkspace(project.id);
  const immutableBefore = store.workspace.getGraphRevision(project.id, published.graph.revision);
  const layoutBefore = store.db.prepare(
    `SELECT * FROM workspace_layout_nodes WHERE workspace_id = ? AND layout_id = 'drift-layout'
     ORDER BY object_kind, object_id`,
  ).all(workspace.id);
  const viewportBefore = store.db.prepare(
    "SELECT * FROM workspace_layout_viewports WHERE workspace_id = ? AND layout_id = 'drift-layout'",
  ).all(workspace.id);

  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: published.graph.revision,
    expectedSnapshotId: published.snapshot.id,
    commands: [{
      id: "rename-after-headless-drift",
      type: "rename-node",
      nodeId: "headless-drift-page-node",
      name: "Must roll back",
    }],
  }), /mutable workspace graph does not match immutable graph revision/i);

  assert.deepEqual(trackedTables.map((table) => rowCount(store.db, table)), countsBefore);
  assert.deepEqual(store.workspace.getWorkspace(project.id), workspaceBefore);
  assert.deepEqual(store.workspace.getGraphRevision(project.id, published.graph.revision), immutableBefore);
  assert.deepEqual(store.db.prepare(
    `SELECT * FROM workspace_layout_nodes WHERE workspace_id = ? AND layout_id = 'drift-layout'
     ORDER BY object_kind, object_id`,
  ).all(workspace.id), layoutBefore);
  assert.deepEqual(store.db.prepare(
    "SELECT * FROM workspace_layout_viewports WHERE workspace_id = ? AND layout_id = 'drift-layout'",
  ).all(workspace.id), viewportBefore);
  assert.equal(
    (store.db.prepare("SELECT name FROM workspace_artifacts WHERE id = 'headless-drift-page'").get() as {
      name: string;
    }).name,
    "Stable page",
  );
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
    baseLayoutChecksum: store.workspace.getLayout(project.id).checksum,
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
    baseLayoutChecksum: store.workspace.getLayout(project.id).checksum,
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
    `INSERT INTO workspace_snapshots (
       id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
       reason, provenance_json, created_by_run_id, created_at, sealed
     ) VALUES ('resource-pinned-snapshot', ?, 3, ?, 1, ?, 'resource-fixture',
               '{"kind":"legacy-migration","migration":"resource-fixture"}', NULL, 30, 0)`,
  ).run(workspace.id, created.snapshot.id, workspace.activeKernelRevisionId);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts
       (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     SELECT workspace_id, 'resource-pinned-snapshot', artifact_id, track_id, revision_id
     FROM workspace_snapshot_artifacts WHERE snapshot_id = ?`,
  ).run(created.snapshot.id);
  store.db.prepare(
    `INSERT INTO workspace_snapshot_resources
       (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, 'resource-pinned-snapshot', 'resource-new', 'resource-new-revision')`,
  ).run(workspace.id);
  store.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = 'resource-pinned-snapshot'").run();
  store.db.prepare(
    "UPDATE project_workspaces SET active_snapshot_id = 'resource-pinned-snapshot' WHERE id = ?",
  ).run(workspace.id);

  const renamed = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 1,
    expectedSnapshotId: "resource-pinned-snapshot",
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
  const parentSnapshot = store.workspace.listSnapshots(project.id).find(({ id }) => id === "resource-pinned-snapshot");
  assert.equal(parentSnapshot?.artifactRevisions["artifact-component"], null);
  assert.equal(parentSnapshot?.resourceRevisions["resource-new"], "resource-new-revision");
  store.close();
});

test("existing identity attachment pins its exact current heads without re-deriving old Snapshot pins", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Existing pins", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertArtifact(
    store.db,
    workspace.id,
    "existing-artifact",
    "page",
    null,
    expectedArtifactSourceRoot(workspace.id, "existing-artifact"),
  );
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
  insertArtifact(
    store.db,
    workspace.id,
    "detached-artifact",
    "page",
    null,
    expectedArtifactSourceRoot(workspace.id, "detached-artifact"),
  );
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
  const attached = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "attach-detached",
      type: "add-node",
      node: {
        id: "transient-node",
        kind: "page",
        name: "Name detached-artifact",
        artifactId: "detached-artifact",
      },
    }],
  });
  const result = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: attached.graph.revision,
    expectedSnapshotId: attached.snapshot.id,
    commands: [{ id: "archive-detached", type: "archive-node", nodeId: "transient-node" }],
  });
  assert.deepEqual(result.graph.nodes, []);
  assert.equal(result.snapshot.artifactRevisions["detached-artifact"], undefined);
  const parent = store.workspace.listSnapshots(project.id).find(({ id }) => id === attached.snapshot.id);
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
  insertArtifact(store.db, workspace.id, "unsafe-existing", "page", null, "../escape");
  insertTrack(store.db, "unsafe-existing", "unsafe-existing-track");
  store.db.prepare(
    "UPDATE workspace_artifacts SET active_track_id = 'unsafe-existing-track' WHERE id = 'unsafe-existing'",
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
  insertArtifact(
    store.db,
    workspace.id,
    "mapped-artifact",
    "page",
    null,
    expectedArtifactSourceRoot(workspace.id, "mapped-artifact"),
  );
  insertTrack(store.db, "mapped-artifact", "mapped-track");
  insertRevision(store.db, {
    id: "mapped-revision",
    workspaceId: workspace.id,
    artifactId: "mapped-artifact",
    trackId: "mapped-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
  });
  store.db.prepare(
    "UPDATE workspace_artifacts SET active_track_id = 'mapped-track' WHERE id = 'mapped-artifact'",
  ).run();
  store.db.prepare("UPDATE artifact_tracks SET head_revision_id = 'mapped-revision' WHERE id = 'mapped-track'").run();
  insertResource(store.db, workspace.id, "mapped-resource");
  insertResourceRevision(store.db, workspace.id, "mapped-resource", "mapped-resource-revision");
  store.db.prepare("UPDATE resources SET head_revision_id = 'mapped-resource-revision' WHERE id = 'mapped-resource'").run();
  const attached = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "attach-mapped-artifact",
        type: "add-node",
        node: {
          id: "mapped-artifact-node",
          kind: "page",
          name: "Name mapped-artifact",
          artifactId: "mapped-artifact",
        },
      },
      {
        id: "attach-mapped-resource",
        type: "add-node",
        node: {
          id: "mapped-resource-node",
          kind: "resource",
          name: "Title mapped-resource",
          resourceId: "mapped-resource",
        },
      },
    ],
  });
  const result = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 1,
    expectedSnapshotId: attached.snapshot.id,
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
  assert.equal(result.snapshot.parentSnapshotId, attached.snapshot.id);
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
    baseLayoutChecksum: store.workspace.getLayout(project.id, "default").checksum,
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
    baseLayoutChecksum: layout.checksum,
    commands: [
      { type: "add-group", groupId: "temporary", label: "Temporary", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "set-parent", objectId: "journey", parentGroupId: "checkout" },
    ],
  }), /cycle/i);
  assert.equal(rowCount(store.db, "workspace_layout_nodes"), beforeRows);
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    baseLayoutChecksum: layout.checksum,
    commands: [{ type: "move", objectId: "missing-node", x: 1, y: 2 }],
  }), /missing|does not exist/i);
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    baseLayoutChecksum: layout.checksum,
    commands: [
      { type: "add-group", groupId: "duplicate", label: "One", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { type: "add-group", groupId: "duplicate", label: "Two", bounds: { x: 0, y: 0, width: 10, height: 10 } },
    ],
  }), /duplicate/i);

  const afterDelete = store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 1,
    baseLayoutChecksum: layout.checksum,
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
    baseLayoutChecksum: store.workspace.getLayout(project.id, "default").checksum,
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
    baseLayoutChecksum: store.workspace.getLayout(project.id, "alternate").checksum,
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
    baseLayoutChecksum: store.workspace.getLayout(project.id, "default").checksum,
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
    store.db.exec("DROP TRIGGER IF EXISTS snapshot_sequence_insert_guard");
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at
       ) VALUES (?, ?, ?, ?, 0, ?, 'fixture',
                 '{"kind":"legacy-migration","migration":"invalid-sequence"}', NULL, 500)`,
    ).run(
      `invalid-sequence-fixture-${sequence}`,
      workspace.id,
      sequence,
      workspace.activeSnapshotId,
      workspace.activeKernelRevisionId,
    );
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

test("aggregate Revision reads stay on one SQLite snapshot during a concurrent root cascade", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-revision-read-")), "revision.db");
  const reader = new Store(file, fakeClock());
  const project = reader.createProject({ name: "Revision read snapshot", mode: "standard" });
  const workspace = reader.workspace.ensureWorkspaceRecord(project.id);
  addRevisionTestArtifacts(reader, project.id, workspace.activeSnapshotId);
  const component = reader.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-component",
    trackId: "revision-component-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "aggregate-component",
  }));
  insertResource(reader.db, workspace.id, "aggregate-resource", null, "asset");
  insertResourceRevision(reader.db, workspace.id, "aggregate-resource", "aggregate-resource-v1");
  const page = reader.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "aggregate-page",
    dependencies: [{
      instanceId: "aggregate-instance",
      componentArtifactId: "revision-component",
      componentRevisionId: component.id,
      createInstanceIdentity: true,
      sourceLocator: { designNodeId: "aggregate.component" },
      overrides: {},
      status: "linked",
    }],
    resourcePins: [{
      resourceId: "aggregate-resource",
      resourceRevisionId: "aggregate-resource-v1",
    }],
  }));
  const writer = new Store(file, fakeClock());
  const prepare = reader.db.prepare.bind(reader.db);
  let writerCommitted = false;
  Object.defineProperty(reader.db, "prepare", {
    configurable: true,
    value(sql: string) {
      if (!writerCommitted && sql.includes("FROM artifact_revision_dependencies")) {
        writer.deleteProject(project.id);
        writerCommitted = true;
      }
      return prepare(sql);
    },
  });
  let dependencies: ReturnType<WorkspaceStore["listArtifactRevisionDependencies"]>;
  try {
    dependencies = reader.workspace.listArtifactRevisionDependencies(page.id);
  } finally {
    Reflect.deleteProperty(reader.db, "prepare");
  }
  assert.equal(writerCommitted, true);
  assert.deepEqual(dependencies.map(({ instanceId }) => instanceId), ["aggregate-instance"]);
  assert.equal(reader.workspace.getArtifactRevision(page.id), null);
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
       VALUES (?, 2, ?, ?, ?, 700)`,
    ).run(
      workspace.id,
      graphRow.nodes_json,
      graphRow.edges_json,
      workspaceGraphChecksum(graphRow.nodes_json, graphRow.edges_json),
    );
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('race-snapshot-2', ?, 3, ?, 2, ?, 'race',
                 '{"kind":"graph-command","commandIds":["race-manual"]}', NULL, 701, 0)`,
    ).run(workspace.id, first.snapshot.id, workspace.activeKernelRevisionId);
    store.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       SELECT workspace_id, 'race-snapshot-2', artifact_id, track_id, revision_id
       FROM workspace_snapshot_artifacts WHERE snapshot_id = ?`,
    ).run(first.snapshot.id);
    store.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = 'race-snapshot-2'").run();
    store.db.prepare(
      "UPDATE project_workspaces SET graph_revision = 2, active_snapshot_id = 'race-snapshot-2' WHERE id = ?",
    ).run(workspace.id);

    worker.postMessage({
      kind: "save",
      input: {
        layoutId: "default",
        graphRevision: 1,
        baseLayoutChecksum: store.workspace.getLayout(project.id, "default").checksum,
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
    await worker.terminate();
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

test("Artifact Revision candidates are monotonic, explicit, immutable dependency locks", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Revision candidates", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);

  insertResource(store.db, workspace.id, "revision-resource");
  insertResourceRevision(store.db, workspace.id, "revision-resource", "revision-resource-v1");
  const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-component",
    trackId: "revision-component-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "component-v1",
  }));
  const componentSnapshot = store.workspace.publishArtifactRevision(component.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const dependency = {
    instanceId: "hero-button",
    componentArtifactId: "revision-component",
    componentRevisionId: component.id,
    createInstanceIdentity: true as const,
    variantKey: "primary",
    stateKey: "default",
    sourceLocator: { designNodeId: "hero.button", sourcePath: "src/page.tsx", selector: "[data-design-node=hero-button]" },
    overrides: { label: "Start now", tone: { foreground: "accent" } },
    status: "linked" as const,
  };
  const first = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "page-v1",
    dependencies: [dependency],
    resourcePins: [{ resourceId: "revision-resource", resourceRevisionId: "revision-resource-v1" }],
  }));
  const second = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "page-v2",
    dependencies: [reuseInstanceDependency(dependency)],
    resourcePins: [{ resourceId: "revision-resource", resourceRevisionId: "revision-resource-v1" }],
  }));
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(first.parentRevisionId, null);
  assert.equal(first.artifactRoot, expectedArtifactSourceRoot(workspace.id, "revision-page"));
  assert.deepEqual(store.workspace.getArtifactRevision(first.id), first);
  assert.deepEqual(store.workspace.listArtifactRevisionDependencies(first.id), [{
    workspaceId: workspace.id,
    ownerArtifactId: "revision-page",
    revisionId: first.id,
    instanceId: "hero-button",
    componentArtifactId: "revision-component",
    componentRevisionId: component.id,
    variantKey: "primary",
    stateKey: "default",
    sourceLocator: dependency.sourceLocator,
    overrides: dependency.overrides,
    status: "linked",
  }]);
  assert.deepEqual(store.workspace.listArtifactRevisionResourcePins(first.id), [{
    workspaceId: workspace.id,
    ownerArtifactId: "revision-page",
    revisionId: first.id,
    resourceId: "revision-resource",
    resourceRevisionId: "revision-resource-v1",
  }]);
  assert.equal(componentSnapshot.artifactRevisions["revision-component"], component.id);

  const counts = {
    revisions: rowCount(store.db, "artifact_revisions"),
    instances: rowCount(store.db, "component_instances"),
    dependencies: rowCount(store.db, "artifact_revision_dependencies"),
    resources: rowCount(store.db, "artifact_revision_resources"),
  };
  assert.throws(() => store.workspace.createArtifactRevision({
    ...standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "bad-duplicate",
      dependencies: [reuseInstanceDependency(dependency), reuseInstanceDependency(dependency)],
    }),
  }), /duplicate.*instance/i);
  assert.throws(() => store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "bad-instance-recreate",
    dependencies: [dependency],
  })), /instance.*exists|collision/i);
  assert.deepEqual({
    revisions: rowCount(store.db, "artifact_revisions"),
    instances: rowCount(store.db, "component_instances"),
    dependencies: rowCount(store.db, "artifact_revision_dependencies"),
    resources: rowCount(store.db, "artifact_revision_resources"),
  }, counts);
  store.close();
});

test("Artifact candidate boundaries reject stale parents, unsafe nested JSON, cross-owner pins, and exhausted sequences", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Revision boundaries", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const otherProject = store.createProject({ name: "Other revision owner", mode: "standard" });
  const otherWorkspace = store.workspace.ensureWorkspaceRecord(otherProject.id);
  insertResource(store.db, otherWorkspace.id, "foreign-resource");
  insertResourceRevision(store.db, otherWorkspace.id, "foreign-resource", "foreign-resource-v1");

  assert.throws(() => store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: "missing-parent",
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "stale-parent",
  })), WorkspacePointerConflictError);
  assert.throws(() => store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "foreign-resource",
    resourcePins: [{ resourceId: "foreign-resource", resourceRevisionId: "foreign-resource-v1" }],
  })), /workspace|ownership|pin/i);
  let getterCalls = 0;
  const unsafeQuality = { state: "passed", score: 100 } as Record<string, unknown>;
  Object.defineProperty(unsafeQuality, "findings", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [];
    },
  });
  assert.throws(() => store.workspace.createArtifactRevision({
    ...standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "unsafe-json",
    }),
    quality: unsafeQuality,
  }), WorkspaceStoreCodecError);
  assert.equal(getterCalls, 0);

  insertRevision(store.db, {
    id: "exhausted-revision",
    workspaceId: workspace.id,
    artifactId: "revision-page",
    trackId: "revision-page-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
    sequence: Number.MAX_SAFE_INTEGER,
  });
  const revisionsBefore = rowCount(store.db, "artifact_revisions");
  assert.throws(() => store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "exhausted",
  })), /sequence.*safe integer|exhaust/i);
  assert.equal(rowCount(store.db, "artifact_revisions"), revisionsBefore);
  store.close();
});

test("Artifact publication independently CASes active Track Head and active Snapshot", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Artifact publication CAS", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const input = (tree: string, parentRevisionId: string | null) => standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree,
  });
  const candidateA = store.workspace.createArtifactRevision(input("tree-a", null));
  const candidateB = store.workspace.createArtifactRevision(input("tree-b", null));
  const publishedA = store.workspace.publishArtifactRevision(candidateA.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const snapshotsAfterA = rowCount(store.db, "workspace_snapshots");
  assert.throws(
    () => store.workspace.publishArtifactRevision(candidateB.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: publishedA.id,
    }),
    (error: unknown) => error instanceof WorkspacePointerConflictError
      && error.pointer === "artifact-head"
      && error.expectedId === null
      && error.actualId === candidateA.id,
  );
  const candidateC = store.workspace.createArtifactRevision(input("tree-c", candidateA.id));
  assert.throws(
    () => store.workspace.publishArtifactRevision(candidateC.id, {
      expectedHeadRevisionId: candidateA.id,
      expectedSnapshotId: graph.snapshot.id,
    }),
    (error: unknown) => error instanceof WorkspacePointerConflictError
      && error.pointer === "active-snapshot"
      && error.expectedId === graph.snapshot.id
      && error.actualId === publishedA.id,
  );
  assert.equal(store.workspace.getTrack("revision-page-track")?.headRevisionId, candidateA.id);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, publishedA.id);
  assert.equal(rowCount(store.db, "workspace_snapshots"), snapshotsAfterA);
  assert.deepEqual(store.workspace.getArtifactRevision(candidateB.id), candidateB);
  assert.deepEqual(store.workspace.getArtifactRevision(candidateC.id), candidateC);
  store.close();
});

test("derived uses edges advance once from exact linked pins and no-op for an unchanged set", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Derived uses", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-component",
    trackId: "revision-component-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "component-derived",
  }));
  const componentSnapshot = store.workspace.publishArtifactRevision(component.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  assert.equal(componentSnapshot.graphRevision, 1, "publishing without linked instances is a graph no-op");
  const dependency = {
    instanceId: "derived-instance",
    componentArtifactId: "revision-component",
    componentRevisionId: component.id,
    createInstanceIdentity: true as const,
    sourceLocator: { designNodeId: "page.component" },
    overrides: {},
    status: "linked" as const,
  };
  const pageOne = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "page-derived-one",
    dependencies: [dependency],
  }));
  const pageOneSnapshot = store.workspace.publishArtifactRevision(pageOne.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });
  assert.equal(pageOneSnapshot.graphRevision, 2);
  assert.deepEqual(pageOneSnapshot.graph.edges.map((edge) => ({
    kind: edge.kind,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
  })), [{
    kind: "uses",
    sourceNodeId: "revision-page-node",
    targetNodeId: "revision-component-node",
  }]);
  assert.deepEqual(store.workspace.getGraphRevision(project.id, 2), pageOneSnapshot.graph);

  const pageTwo = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: pageOne.id,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "page-derived-two",
    dependencies: [reuseInstanceDependency(dependency)],
  }));
  const pageTwoSnapshot = store.workspace.publishArtifactRevision(pageTwo.id, {
    expectedHeadRevisionId: pageOne.id,
    expectedSnapshotId: pageOneSnapshot.id,
  });
  assert.equal(pageTwoSnapshot.graphRevision, 2, "the same canonical uses set must not mint a graph revision");
  assert.equal(rowCount(store.db, "workspace_graph_revisions"), 3);

  const detached = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: pageTwo.id,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "page-detached",
    dependencies: [{ ...reuseInstanceDependency(dependency), status: "detached" }],
  }));
  const detachedSnapshot = store.workspace.publishArtifactRevision(detached.id, {
    expectedHeadRevisionId: pageTwo.id,
    expectedSnapshotId: pageTwoSnapshot.id,
  });
  assert.equal(detachedSnapshot.graphRevision, 3);
  assert.deepEqual(detachedSnapshot.graph.edges, []);
  assert.equal(store.workspace.getGraph(project.id).revision, 3);
  store.close();
});

test("derived uses publication rejects component cycles, edge-id collisions, and graph exhaustion atomically", () => {
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Uses cycle", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const graph = store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: 0,
      expectedSnapshotId: workspace.activeSnapshotId,
      commands: [
        {
          id: "add-component-a",
          type: "add-node",
          node: {
            id: "component-a-node",
            kind: "component",
            name: "Component A",
            artifactId: "component-a",
            createIdentity: { initialTrackId: "component-a-track" },
          },
        },
        {
          id: "add-component-b",
          type: "add-node",
          node: {
            id: "component-b-node",
            kind: "component",
            name: "Component B",
            artifactId: "component-b",
            createIdentity: { initialTrackId: "component-b-track" },
          },
        },
      ],
    });
    const componentBBase = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "component-b",
      trackId: "component-b-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "component-b-base",
    }));
    const componentA = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "component-a",
      trackId: "component-a-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "component-a-uses-b",
      dependencies: [{
        instanceId: "component-a-uses-b",
        componentArtifactId: "component-b",
        componentRevisionId: componentBBase.id,
        createInstanceIdentity: true,
        sourceLocator: { designNodeId: "a.b" },
        overrides: {},
        status: "linked",
      }],
    }));
    const componentASnapshot = store.workspace.publishArtifactRevision(componentA.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: graph.snapshot.id,
    });
    const componentBCycle = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "component-b",
      trackId: "component-b-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "component-b-uses-a",
      dependencies: [{
        instanceId: "component-b-uses-a",
        componentArtifactId: "component-a",
        componentRevisionId: componentA.id,
        createInstanceIdentity: true,
        sourceLocator: { designNodeId: "b.a" },
        overrides: {},
        status: "linked",
      }],
    }));
    const snapshotCount = rowCount(store.db, "workspace_snapshots");
    assert.throws(() => store.workspace.publishArtifactRevision(componentBCycle.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: componentASnapshot.id,
    }), /cycle/i);
    assert.equal(store.workspace.getTrack("component-b-track")?.headRevisionId, null);
    assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, componentASnapshot.id);
    assert.equal(rowCount(store.db, "workspace_snapshots"), snapshotCount);
    store.close();
  }

  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Uses collision", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const collisionId = `derived-uses-${createHash("sha256")
      .update(`uses-v1\0${workspace.id}\0revision-page\0revision-component`)
      .digest("hex")}`;
    const graph = store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: 0,
      expectedSnapshotId: workspace.activeSnapshotId,
      commands: [
        {
          id: "collision-page",
          type: "add-node",
          node: {
            id: "revision-page-node",
            kind: "page",
            name: "Page",
            artifactId: "revision-page",
            createIdentity: { initialTrackId: "revision-page-track" },
          },
        },
        {
          id: "collision-component",
          type: "add-node",
          node: {
            id: "revision-component-node",
            kind: "component",
            name: "Component",
            artifactId: "revision-component",
            createIdentity: { initialTrackId: "revision-component-track" },
          },
        },
        {
          id: "collision-resource",
          type: "add-node",
          node: {
            id: "collision-resource-node",
            kind: "resource",
            name: "Research",
            resourceId: "collision-resource",
            createIdentity: { resourceKind: "research", defaultPinPolicy: "manual" },
          },
        },
        {
          id: "collision-edge",
          type: "add-edge",
          edge: {
            id: collisionId,
            workspaceId: workspace.id,
            kind: "informs",
            sourceNodeId: "collision-resource-node",
            targetNodeId: "revision-page-node",
          },
        },
      ],
    });
    const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-component",
      trackId: "revision-component-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "collision-component",
    }));
    const componentSnapshot = store.workspace.publishArtifactRevision(component.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: graph.snapshot.id,
    });
    const page = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "collision-page",
      dependencies: [{
        instanceId: "collision-instance",
        componentArtifactId: "revision-component",
        componentRevisionId: component.id,
        createInstanceIdentity: true,
        sourceLocator: { designNodeId: "collision" },
        overrides: {},
        status: "linked",
      }],
    }));
    const snapshotCount = rowCount(store.db, "workspace_snapshots");
    assert.throws(() => store.workspace.publishArtifactRevision(page.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: componentSnapshot.id,
    }), /identity collision/i);
    assert.equal(store.workspace.getTrack("revision-page-track")?.headRevisionId, null);
    assert.equal(rowCount(store.db, "workspace_snapshots"), snapshotCount);
    store.close();
  }

  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Uses graph exhaustion", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
    const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-component",
      trackId: "revision-component-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "exhausted-component",
    }));
    const componentSnapshot = store.workspace.publishArtifactRevision(component.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: graph.snapshot.id,
    });
    const page = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "exhausted-page",
      dependencies: [{
        instanceId: "exhausted-instance",
        componentArtifactId: "revision-component",
        componentRevisionId: component.id,
        createInstanceIdentity: true,
        sourceLocator: { designNodeId: "exhausted" },
        overrides: {},
        status: "linked",
      }],
    }));
    const currentGraph = store.workspace.getGraph(project.id);
    const nodesJson = JSON.stringify(currentGraph.nodes);
    const edgesJson = JSON.stringify(currentGraph.edges);
    store.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, 800)`,
    ).run(
      workspace.id,
      Number.MAX_SAFE_INTEGER,
      nodesJson,
      edgesJson,
      workspaceGraphChecksum(nodesJson, edgesJson),
    );
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('exhausted-graph-snapshot', ?, 4, ?, ?, ?, 'fixture',
                 '{"kind":"legacy-migration","migration":"graph-exhaustion"}', NULL, 801, 0)`,
    ).run(
      workspace.id,
      componentSnapshot.id,
      Number.MAX_SAFE_INTEGER,
      workspace.activeKernelRevisionId,
    );
    store.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       SELECT workspace_id, 'exhausted-graph-snapshot', artifact_id, track_id, revision_id
       FROM workspace_snapshot_artifacts WHERE snapshot_id = ?`,
    ).run(componentSnapshot.id);
    store.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = 'exhausted-graph-snapshot'").run();
    store.db.prepare(
      `UPDATE project_workspaces
       SET graph_revision = ?, active_snapshot_id = 'exhausted-graph-snapshot'
       WHERE id = ?`,
    ).run(Number.MAX_SAFE_INTEGER, workspace.id);
    const snapshotCount = rowCount(store.db, "workspace_snapshots");
    assert.throws(() => store.workspace.publishArtifactRevision(page.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: "exhausted-graph-snapshot",
    }), /graph revision is exhausted/i);
    assert.equal(store.workspace.getTrack("revision-page-track")?.headRevisionId, null);
    assert.equal(rowCount(store.db, "workspace_snapshots"), snapshotCount);
    store.close();
  }
});

test("Kernel candidates and publication use independent Kernel and Snapshot CAS with impact-safe pins", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Kernel publication", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  insertResource(store.db, workspace.id, "shared-asset", null, "asset");
  insertResourceRevision(store.db, workspace.id, "shared-asset", "shared-asset-v1");
  const kernelInput = (brief: string) => ({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: { accent: "#6633ff", radius: 12 },
    typography: { display: { family: "Inter", weight: 700 } },
    sharedAssetRevisionIds: ["shared-asset-v1"],
    brief,
    terminology: { cta: "primary action" },
    exclusions: ["generic dashboard"],
    responsiveFrames: [{ id: "desktop", name: "Desktop", width: 1440, height: 900 }],
    qualityProfile: {
      requiredFrameIds: ["desktop"],
      blockingSeverities: ["P0" as const, "P1" as const],
      requireRuntimeChecks: true,
      requireVisualReview: true,
    },
  });
  const candidateA = store.workspace.createKernelRevision(kernelInput("Direction A"));
  const candidateB = store.workspace.createKernelRevision(kernelInput("Direction B"));
  assert.equal(candidateA.sequence, 2);
  assert.equal(candidateB.sequence, 3);
  assert.deepEqual(store.workspace.getKernelRevision(candidateA.id), candidateA);
  const publishedA = store.workspace.publishKernelRevision(candidateA.id, {
    expectedKernelRevisionId: workspace.activeKernelRevisionId,
    expectedSnapshotId: workspace.activeSnapshotId,
  });
  assert.equal(publishedA.kernelRevisionId, candidateA.id);
  assert.equal(publishedA.provenance.kind, "kernel-publication");
  assert.throws(
    () => store.workspace.publishKernelRevision(candidateB.id, {
      expectedKernelRevisionId: workspace.activeKernelRevisionId,
      expectedSnapshotId: publishedA.id,
    }),
    (error: unknown) => error instanceof WorkspacePointerConflictError && error.pointer === "kernel-head",
  );
  const candidateC = store.workspace.createKernelRevision({
    ...kernelInput("Direction C"),
    parentRevisionId: candidateA.id,
  });
  assert.throws(
    () => store.workspace.publishKernelRevision(candidateC.id, {
      expectedKernelRevisionId: candidateA.id,
      expectedSnapshotId: workspace.activeSnapshotId,
    }),
    (error: unknown) => error instanceof WorkspacePointerConflictError && error.pointer === "active-snapshot",
  );
  assert.equal(store.workspace.getWorkspace(project.id)?.activeKernelRevisionId, candidateA.id);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, publishedA.id);
  store.close();
});

test("checkpoint publication always creates a fresh direct child and CASes the active Snapshot", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Snapshot checkpoint", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const inactive = store.workspace.createWorkspaceSnapshot(project.id, {
    expectedSnapshotId: workspace.activeSnapshotId,
    reason: "manual-checkpoint",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "inactive-proposal",
      planId: "inactive-plan",
      checkpointId: "inactive-checkpoint",
    },
  });
  assert.equal(inactive.parentSnapshotId, workspace.activeSnapshotId);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, workspace.activeSnapshotId);
  const published = store.workspace.publishSnapshot(project.id, {
    expectedSnapshotId: workspace.activeSnapshotId,
    reason: "plan-checkpoint",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "proposal-1",
      planId: "plan-1",
      checkpointId: "checkpoint-1",
    },
  });
  assert.notEqual(published.id, inactive.id);
  assert.equal(published.parentSnapshotId, workspace.activeSnapshotId);
  assert.deepEqual(published.artifactRevisions, inactive.artifactRevisions);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, published.id);
  const snapshotCount = rowCount(store.db, "workspace_snapshots");
  assert.throws(() => store.workspace.publishSnapshot(project.id, {
    expectedSnapshotId: workspace.activeSnapshotId,
    reason: "stale-checkpoint",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "stale-proposal",
      planId: "stale-plan",
      checkpointId: "stale-checkpoint",
    },
  }), WorkspacePointerConflictError);
  assert.equal(rowCount(store.db, "workspace_snapshots"), snapshotCount);
  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET active_snapshot_id = ? WHERE id = ?").run(inactive.id, workspace.id),
    /direct child|active state|snapshot/i,
  );
  assert.throws(
    () => store.workspace.createWorkspaceSnapshot(project.id, {
      expectedSnapshotId: published.id,
      reason: "restore-is-not-a-checkpoint",
      provenance: { kind: "restore", restoredSnapshotId: inactive.id },
    }),
    /cannot claim restore/i,
  );
  assert.throws(
    () => store.workspace.createWorkspaceSnapshot(project.id, {
      expectedSnapshotId: published.id,
      reason: "invalid-restore-provenance",
      provenance: { kind: "restore" },
    }),
    WorkspaceStoreCodecError,
  );
  store.close();
});

test("all revision, dependency, Snapshot, and identity history rejects mutation and replacement but root cascade succeeds", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Immutable publication history", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  insertResource(store.db, workspace.id, "immutable-resource");
  insertResourceRevision(store.db, workspace.id, "immutable-resource", "immutable-resource-v1");
  store.db.prepare("UPDATE resources SET head_revision_id = 'immutable-resource-v1' WHERE id = 'immutable-resource'").run();
  const resourceGraph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: graph.graph.revision,
    expectedSnapshotId: graph.snapshot.id,
    commands: [{
      id: "attach-immutable-resource",
      type: "add-node",
      node: {
        id: "immutable-resource-node",
        kind: "resource",
        name: "Title immutable-resource",
        resourceId: "immutable-resource",
      },
    }],
  });
  const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-component",
    trackId: "revision-component-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "immutable-component",
  }));
  const componentSnapshot = store.workspace.publishArtifactRevision(component.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: resourceGraph.snapshot.id,
  });
  const page = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "immutable-page",
    dependencies: [{
      instanceId: "immutable-instance",
      componentArtifactId: "revision-component",
      componentRevisionId: component.id,
      createInstanceIdentity: true,
      sourceLocator: { designNodeId: "immutable.node" },
      overrides: {},
      status: "linked",
    }],
    resourcePins: [{ resourceId: "immutable-resource", resourceRevisionId: "immutable-resource-v1" }],
  }));
  const pageSnapshot = store.workspace.publishArtifactRevision(page.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });

  const immutableRows = [
    ["shared_design_kernel_revisions", `id = '${workspace.activeKernelRevisionId}'`, "checksum"],
    ["artifact_revisions", `id = '${page.id}'`, "source_tree_hash"],
    ["artifact_revision_dependencies", `revision_id = '${page.id}'`, "status"],
    ["artifact_revision_resources", `revision_id = '${page.id}'`, "resource_revision_id"],
    ["resource_revisions", "id = 'immutable-resource-v1'", "checksum"],
    ["workspace_graph_revisions", `workspace_id = '${workspace.id}' AND revision = ${pageSnapshot.graphRevision}`, "checksum"],
    ["workspace_snapshots", `id = '${pageSnapshot.id}'`, "reason"],
    ["workspace_snapshot_artifacts", `snapshot_id = '${pageSnapshot.id}' AND artifact_id = 'revision-page'`, "revision_id"],
    ["workspace_snapshot_resources", `snapshot_id = '${pageSnapshot.id}' AND resource_id = 'immutable-resource'`, "revision_id"],
  ] as const;
  for (const [table, where, column] of immutableRows) {
    assert.throws(() => store.db.prepare(`UPDATE ${table} SET ${column} = ${column} WHERE ${where}`).run(), /immutable/i);
    assert.throws(() => store.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(), /immutable/i);
    assert.throws(
      () => store.db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE ${where}`).run(),
      /immutable/i,
    );
    assert.throws(
      () => store.db.prepare(
        `INSERT INTO ${table} SELECT * FROM ${table} WHERE ${where} AND true
         ON CONFLICT DO UPDATE SET ${column} = excluded.${column}`,
      ).run(),
      /immutable/i,
    );
  }
  for (const [table, where] of [
    ["workspace_artifacts", "id = 'revision-page'"],
    ["artifact_tracks", "id = 'revision-page-track'"],
    ["resources", "id = 'immutable-resource'"],
    ["component_instances", "id = 'immutable-instance'"],
  ] as const) {
    assert.throws(() => store.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(), /archive|immutable|history/i);
    assert.throws(
      () => store.db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE ${where}`).run(),
      /archive|immutable|history/i,
    );
  }
  assert.throws(() => store.db.prepare(
    `INSERT OR REPLACE INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('replacement-node-id', ?, 'page', 'shell-page', NULL, NULL, 2, 2)`,
  ).run(workspace.id), /immutable|replace|archive|history|ownership/i);
  store.deleteProject(project.id);
  for (const table of [...REQUIRED_WORKSPACE_TABLES, "artifact_revision_resources"] as const) {
    assert.equal(rowCount(store.db, table), 0, `${table} survived the root Project cascade`);
  }
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("candidate and Snapshot provenance reject foreign Project Runs at API and SQLite boundaries", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Run owner", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const foreignProject = store.createProject({ name: "Foreign Run owner", mode: "standard" });
  const foreignWorkspace = store.workspace.ensureWorkspaceRecord(foreignProject.id);
  store.db.prepare(
    "INSERT INTO conversations (id, project_id, title, created_at) VALUES ('foreign-conversation', ?, 'Foreign', 1)",
  ).run(foreignProject.id);
  store.db.prepare(
    `INSERT INTO runs
       (id, project_id, conversation_id, status, created_at)
     VALUES ('foreign-run', ?, 'foreign-conversation', 'succeeded', 2)`,
  ).run(foreignProject.id);

  const foreignRunInput = {
    ...standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "foreign-run",
    }),
    producedByRunId: "foreign-run",
  };
  assert.throws(() => store.workspace.createArtifactRevision(foreignRunInput), /another Project/i);
  assert.throws(
    () => store.db.prepare(
      `INSERT INTO artifact_revisions (
         id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
         source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
         render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
         legacy_run_id, created_at
       ) VALUES ('foreign-run-revision', ?, 'revision-page', 'revision-page-track', 1, NULL,
                 'commit', 'tree', 'root', ?, '{}', '{}', NULL, 'foreign-run', NULL, 3)`,
    ).run(workspace.id, workspace.activeKernelRevisionId),
    /another Project/i,
  );
  assert.throws(() => store.workspace.publishSnapshot(project.id, {
    expectedSnapshotId: store.workspace.getWorkspace(project.id)!.activeSnapshotId,
    reason: "foreign-run-checkpoint",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "proposal-run",
      planId: "plan-run",
      checkpointId: "checkpoint-run",
    },
    createdByRunId: "foreign-run",
  }), /another Project/i);
  assert.equal(rowCount(store.db, "artifact_revisions", `workspace_id = '${workspace.id}'`), 0);
  assert.equal(rowCount(store.db, "workspace_snapshots", `workspace_id = '${workspace.id}'`), 2);
  assert.equal(rowCount(store.db, "workspace_snapshots", `workspace_id = '${foreignWorkspace.id}'`), 1);
  store.close();
});

test("Kernel and graph readers reject polluted payloads and checksum mismatches", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Checksummed history", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const unsafeTokens = JSON.parse('{"__proto__":"polluted"}') as Record<string, string>;
  assert.throws(() => store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: unsafeTokens,
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Unsafe",
    terminology: {},
    exclusions: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  }), WorkspaceStoreCodecError);
  store.db.prepare(
    `INSERT INTO shared_design_kernel_revisions
       (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
     SELECT 'bad-kernel-checksum', workspace_id, 2, id, payload_json, 'bad', 5
     FROM shared_design_kernel_revisions WHERE id = ?`,
  ).run(workspace.activeKernelRevisionId);
  assert.throws(() => store.workspace.getKernelRevision("bad-kernel-checksum"), /checksum/i);
  store.db.prepare(
    `INSERT INTO workspace_graph_revisions
       (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
     VALUES (?, 1, '[]', '[]', 'bad', 6)`,
  ).run(workspace.id);
  assert.throws(() => store.workspace.getGraphRevision(project.id, 1), /checksum/i);
  store.close();
});

test("two SQLite connections serialize candidate sequences and publication CAS", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-publication-race-")), "race.db");
  const store = new Store(file, fakeClock());
  const project = store.createProject({ name: "Publication race", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const candidateA = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "race-a",
  }));
  const candidateB = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "race-b",
  }));

  const runWorker = (operation: string, payload: unknown, prefix: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.moduleUrl).then(({ Store }) => {
        let id = 0;
        const store = new Store(workerData.file, {
          now: () => 20_000 + ++id,
          id: () => workerData.prefix + "-" + ++id,
        });
        try {
          const result = store.workspace[workerData.operation](...workerData.payload);
          parentPort.postMessage({ ok: true, result });
        } catch (error) {
          parentPort.postMessage({
            ok: false,
            name: error?.name,
            message: error?.message,
            pointer: error?.pointer,
            expectedId: error?.expectedId,
            actualId: error?.actualId,
          });
        } finally {
          store.close();
        }
      }).catch((error) => parentPort.postMessage({ ok: false, name: error?.name, message: error?.stack }));
    `, {
      eval: true,
      workerData: {
        file,
        operation,
        payload,
        prefix,
        moduleUrl: new URL("../src/index.ts", import.meta.url).href,
      },
    });
    worker.once("message", (message) => {
      resolve(message as Record<string, unknown>);
      void worker.terminate();
    });
    worker.once("error", reject);
  });

  const publicationResults = await Promise.all([
    runWorker("publishArtifactRevision", [candidateA.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: graph.snapshot.id,
    }], "publisher-a"),
    runWorker("publishArtifactRevision", [candidateB.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: graph.snapshot.id,
    }], "publisher-b"),
  ]);
  assert.equal(publicationResults.filter(({ ok }) => ok === true).length, 1);
  const publicationLoser = publicationResults.find(({ ok }) => ok === false)!;
  assert.equal(publicationLoser.name, "WorkspacePointerConflictError");
  assert.equal(publicationLoser.pointer, "artifact-head");
  assert.doesNotMatch(String(publicationLoser.message), /SQLITE_BUSY/i);
  const publishedHead = store.workspace.getTrack("revision-page-track")!.headRevisionId!;
  const afterPublication = store.workspace.getWorkspace(project.id)!;
  assert.equal(store.workspace.listSnapshots(project.id).length, 3);

  const concurrentInput = (tree: string) => standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: publishedHead,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree,
  });
  const candidateResults = await Promise.all([
    runWorker("createArtifactRevision", [concurrentInput("race-c")], "candidate-c"),
    runWorker("createArtifactRevision", [concurrentInput("race-d")], "candidate-d"),
  ]);
  assert.ok(candidateResults.every(({ ok }) => ok === true));
  assert.deepEqual(
    candidateResults.map(({ result }) => (result as { sequence: number }).sequence).sort((left, right) => left - right),
    [3, 4],
  );

  const kernelBase = store.workspace.getWorkspace(project.id)!;
  const kernelInput = (brief: string) => ({
    workspaceId: workspace.id,
    parentRevisionId: kernelBase.activeKernelRevisionId,
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: [],
    brief,
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
  const kernelA = store.workspace.createKernelRevision(kernelInput("Race A"));
  const kernelB = store.workspace.createKernelRevision(kernelInput("Race B"));
  const kernelResults = await Promise.all([
    runWorker("publishKernelRevision", [kernelA.id, {
      expectedKernelRevisionId: kernelBase.activeKernelRevisionId,
      expectedSnapshotId: afterPublication.activeSnapshotId,
    }], "kernel-a"),
    runWorker("publishKernelRevision", [kernelB.id, {
      expectedKernelRevisionId: kernelBase.activeKernelRevisionId,
      expectedSnapshotId: afterPublication.activeSnapshotId,
    }], "kernel-b"),
  ]);
  assert.equal(kernelResults.filter(({ ok }) => ok === true).length, 1);
  const kernelLoser = kernelResults.find(({ ok }) => ok === false)!;
  assert.equal(kernelLoser.name, "WorkspacePointerConflictError");
  assert.equal(kernelLoser.pointer, "kernel-head");
  assert.doesNotMatch(String(kernelLoser.message), /SQLITE_BUSY/i);
  assert.equal(store.workspace.listSnapshots(project.id).length, 4);
  store.close();
});

test("sealed Artifact Revisions and Snapshots reject new child mappings after construction", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Sealed child sets", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-component",
    trackId: "revision-component-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "sealed-component",
  }));
  const componentSnapshot = store.workspace.publishArtifactRevision(component.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const page = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "sealed-page",
  }));
  const pageSnapshot = store.workspace.publishArtifactRevision(page.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });

  store.db.prepare(
    `INSERT INTO component_instances
       (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
     VALUES ('late-instance', ?, 'revision-page', 'revision-component', 1)`,
  ).run(workspace.id);
  assert.throws(() => store.db.prepare(
    `INSERT INTO artifact_revision_dependencies (
       workspace_id, owner_artifact_id, revision_id, instance_id, component_artifact_id,
       component_revision_id, variant_key, state_key, design_node_id,
       source_locator_json, overrides_json, status
     ) VALUES (?, 'revision-page', ?, 'late-instance', 'revision-component', ?,
               NULL, NULL, 'late.node', '{"designNodeId":"late.node"}', '{}', 'linked')`,
  ).run(workspace.id, page.id, component.id), /sealed|immutable/i);

  insertResource(store.db, workspace.id, "late-resource");
  insertResourceRevision(store.db, workspace.id, "late-resource", "late-resource-v1");
  assert.throws(() => store.db.prepare(
    `INSERT INTO artifact_revision_resources
       (workspace_id, owner_artifact_id, revision_id, resource_id, resource_revision_id)
     VALUES (?, 'revision-page', ?, 'late-resource', 'late-resource-v1')`,
  ).run(workspace.id, page.id), /sealed|immutable/i);
  assert.throws(() => store.db.prepare(
    `INSERT INTO workspace_snapshot_resources
       (workspace_id, snapshot_id, resource_id, revision_id)
     VALUES (?, ?, 'late-resource', 'late-resource-v1')`,
  ).run(workspace.id, pageSnapshot.id), /sealed|immutable/i);

  insertArtifact(store.db, workspace.id, "late-artifact");
  insertTrack(store.db, "late-artifact", "late-track");
  assert.throws(() => store.db.prepare(
    `INSERT INTO workspace_snapshot_artifacts
       (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
     VALUES (?, ?, 'late-artifact', 'late-track', NULL)`,
  ).run(workspace.id, pageSnapshot.id), /sealed|immutable/i);
  assert.equal(store.workspace.listArtifactRevisionDependencies(page.id).length, 0);
  assert.equal(store.workspace.listArtifactRevisionResourcePins(page.id).length, 0);
  store.close();
});

test("childless durable identities cannot be reparented, replaced, or upsert-mutated with recursive triggers off", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Identity shells", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const otherProject = store.createProject({ name: "Other owner", mode: "standard" });
  const otherWorkspace = store.workspace.ensureWorkspaceRecord(otherProject.id);
  insertArtifact(store.db, workspace.id, "shell-page");
  insertArtifact(store.db, workspace.id, "shell-page-other");
  insertArtifact(store.db, workspace.id, "shell-component", "component");
  insertTrack(store.db, "shell-page", "shell-track");
  insertResource(store.db, workspace.id, "shell-resource");
  store.db.prepare(
    `INSERT INTO component_instances
       (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
     VALUES ('shell-instance', ?, 'shell-page', 'shell-component', 1)`,
  ).run(workspace.id);
  store.db.prepare(
    `INSERT INTO workspace_nodes
       (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
     VALUES ('shell-node', ?, 'page', 'shell-page', NULL, NULL, 1, 1)`,
  ).run(workspace.id);
  store.db.exec("PRAGMA recursive_triggers = OFF");

  for (const [table, where] of [
    ["workspace_artifacts", "id = 'shell-page'"],
    ["artifact_tracks", "id = 'shell-track'"],
    ["resources", "id = 'shell-resource'"],
    ["component_instances", "id = 'shell-instance'"],
    ["workspace_nodes", "id = 'shell-node'"],
  ] as const) {
    assert.throws(
      () => store.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(),
      /immutable|archive|history/i,
      `${table} allowed direct identity deletion`,
    );
    assert.throws(
      () => store.db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE ${where}`).run(),
      /immutable|replace|archive|history/i,
      `${table} allowed INSERT OR REPLACE with recursive_triggers=OFF`,
    );
  }

  assert.throws(
    () => store.db.prepare("UPDATE workspace_artifacts SET source_root = '../../outside' WHERE id = 'shell-page'").run(),
    /identity|immutable/i,
  );
  store.db.prepare("UPDATE workspace_artifacts SET active_track_id = 'shell-track' WHERE id = 'shell-page'").run();
  assert.throws(
    () => store.db.prepare("UPDATE workspace_artifacts SET active_track_id = NULL WHERE id = 'shell-page'").run(),
    /cannot be cleared/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE artifact_tracks SET legacy_variant_id = 'moved-variant' WHERE id = 'shell-track'").run(),
    /identity|immutable/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE resources SET kind = 'asset' WHERE id = 'shell-resource'").run(),
    /identity|immutable/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE workspace_nodes SET artifact_id = 'shell-page-other' WHERE id = 'shell-node'").run(),
    /identity|immutable/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE component_instances SET owner_artifact_id = 'shell-page-other' WHERE id = 'shell-instance'").run(),
    /identity|immutable/i,
  );

  assert.throws(() => store.db.prepare(
    `INSERT INTO workspace_artifacts
       SELECT id, ?, kind, name, source_root, legacy_wrapped, active_track_id, archived_at, created_at, updated_at
       FROM workspace_artifacts WHERE id = 'shell-page'
     ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id`,
  ).run(otherWorkspace.id), /identity|immutable/i);
  assert.throws(() => store.db.prepare(
    `INSERT INTO artifact_tracks
       SELECT id, 'shell-page-other', name, head_revision_id, legacy_variant_id, created_at
       FROM artifact_tracks WHERE id = 'shell-track'
     ON CONFLICT(id) DO UPDATE SET artifact_id = excluded.artifact_id`,
  ).run(), /identity|immutable/i);
  assert.throws(() => store.db.prepare(
    `INSERT INTO resources
       SELECT id, ?, kind, title, head_revision_id, default_pin_policy, archived_at, created_at, updated_at
       FROM resources WHERE id = 'shell-resource'
     ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id`,
  ).run(otherWorkspace.id), /identity|immutable/i);
  assert.throws(() => store.db.prepare(
    `INSERT INTO workspace_nodes
       SELECT id, workspace_id, kind, 'shell-page-other', resource_id, archived_at, created_at, updated_at
       FROM workspace_nodes WHERE id = 'shell-node'
     ON CONFLICT(id) DO UPDATE SET artifact_id = excluded.artifact_id`,
  ).run(), /identity|immutable/i);
  assert.throws(() => store.db.prepare(
    `INSERT INTO component_instances
       SELECT id, workspace_id, 'shell-page-other', component_artifact_id, created_at
       FROM component_instances WHERE id = 'shell-instance'
     ON CONFLICT(id) DO UPDATE SET owner_artifact_id = excluded.owner_artifact_id`,
  ).run(), /identity|immutable/i);

  store.db.prepare("UPDATE workspace_artifacts SET name = 'Renamed shell' WHERE id = 'shell-page'").run();
  store.db.prepare("UPDATE artifact_tracks SET name = 'Renamed track' WHERE id = 'shell-track'").run();
  store.db.prepare(
    "UPDATE resources SET title = 'Renamed resource', default_pin_policy = 'manual' WHERE id = 'shell-resource'",
  ).run();
  store.db.prepare("UPDATE workspace_nodes SET archived_at = 123, updated_at = 124 WHERE id = 'shell-node'").run();
  assert.equal(store.workspace.getArtifact("shell-page")?.name, "Renamed shell");
  assert.equal(store.workspace.getTrack("shell-track")?.name, "Renamed track");
  store.close();
});

test("sequence allocation rejects corrupt lower rows and SQLite rejects new unsafe revision sequences", () => {
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Artifact sequence audit", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
    store.db.exec("DROP TRIGGER IF EXISTS artifact_revision_sequence_insert_guard");
    insertRevision(store.db, {
      id: "artifact-sequence-zero",
      workspaceId: workspace.id,
      artifactId: "revision-page",
      trackId: "revision-page-track",
      kernelRevisionId: workspace.activeKernelRevisionId,
      sequence: 0,
    });
    assert.throws(() => store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "after-zero",
    })), /positive safe integer/i);
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Kernel sequence audit", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    store.db.exec("DROP TRIGGER IF EXISTS kernel_revision_sequence_insert_guard");
    store.db.prepare(
      `INSERT INTO shared_design_kernel_revisions
         (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
       SELECT 'kernel-sequence-zero', workspace_id, 0, NULL, payload_json, checksum, 2
       FROM shared_design_kernel_revisions WHERE id = ?`,
    ).run(workspace.activeKernelRevisionId);
    assert.throws(() => store.workspace.createKernelRevision({
      workspaceId: workspace.id,
      parentRevisionId: workspace.activeKernelRevisionId,
      tokens: {},
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "after zero",
      terminology: {},
      exclusions: [],
      responsiveFrames: [],
      qualityProfile: {
        requiredFrameIds: [],
        blockingSeverities: [],
        requireRuntimeChecks: false,
        requireVisualReview: false,
      },
    }), /positive safe integer/i);
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Snapshot sequence audit", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    store.db.exec("DROP TRIGGER IF EXISTS snapshot_sequence_insert_guard");
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at
       ) VALUES ('snapshot-sequence-zero', ?, 0, NULL, 0, ?, 'corrupt',
                 '{"kind":"legacy-migration","migration":"sequence-zero"}', NULL, 2)`,
    ).run(workspace.id, workspace.activeKernelRevisionId);
    assert.throws(() => store.workspace.createWorkspaceSnapshot(project.id, {
      expectedSnapshotId: workspace.activeSnapshotId,
      reason: "after-zero",
      provenance: {
        kind: "plan-checkpoint",
        proposalId: "sequence-proposal",
        planId: "sequence-plan",
        checkpointId: "sequence-checkpoint",
      },
    }), /positive safe integer/i);
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Resource sequence guard", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    insertResource(store.db, workspace.id, "guarded-resource");
    assert.throws(
      () => insertResourceRevision(store.db, workspace.id, "guarded-resource", "resource-sequence-zero", 0),
      /positive safe integer/i,
    );
    assert.throws(() => store.db.prepare(
      `INSERT INTO resource_revisions (
         id, workspace_id, resource_id, sequence, manifest_path, summary,
         metadata_json, checksum, provenance_json, created_by_run_id, created_at
       ) VALUES ('resource-sequence-fraction', ?, 'guarded-resource', 0.5, 'x', 'x', '{}', 'x', '{}', NULL, 1)`,
    ).run(workspace.id), /positive safe integer/i);
    store.close();
  }
});

test("a graph Resource with a Head requires an explicit Snapshot pin before checkpoint publication", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Resource pin completeness", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "add-headless-resource",
      type: "add-node",
      node: {
        id: "headless-resource-node",
        kind: "resource",
        name: "Headless resource",
        resourceId: "headless-resource",
        createIdentity: { resourceKind: "research", defaultPinPolicy: "follow-head" },
      },
    }],
  });
  assert.equal(graph.snapshot.resourceRevisions["headless-resource"], undefined);
  insertResourceRevision(store.db, workspace.id, "headless-resource", "headless-resource-v1");
  store.db.prepare(
    "UPDATE resources SET head_revision_id = 'headless-resource-v1' WHERE id = 'headless-resource'",
  ).run();
  const before = rowCount(store.db, "workspace_snapshots");
  assert.throws(() => store.workspace.publishSnapshot(project.id, {
    expectedSnapshotId: graph.snapshot.id,
    reason: "missing-resource-pin",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "resource-proposal",
      planId: "resource-plan",
      checkpointId: "resource-checkpoint",
    },
  }), /explicit Snapshot pin|Resource mapping/i);
  assert.equal(rowCount(store.db, "workspace_snapshots"), before);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, graph.snapshot.id);
  store.close();
});

test("Artifact source roots are immutable and candidate creation fails closed on stored path corruption", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Artifact root integrity", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  assert.throws(
    () => store.db.prepare("UPDATE workspace_artifacts SET source_root = '../../outside' WHERE id = 'revision-page'").run(),
    /identity|immutable/i,
  );
  store.db.exec("DROP TRIGGER IF EXISTS workspace_artifact_identity_update_immutable");
  store.db.prepare("UPDATE workspace_artifacts SET source_root = '../../outside' WHERE id = 'revision-page'").run();
  assert.throws(() => store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "corrupt-root",
  })), /server-derived source root/i);
  assert.equal(rowCount(store.db, "artifact_revisions", "artifact_id = 'revision-page'"), 0);
  store.close();
});

test("Run and Workspace ownership cannot be reparented after immutable history references them", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Stable provenance owner", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const otherProject = store.createProject({ name: "Other provenance owner", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(otherProject.id);
  store.db.prepare(
    "INSERT INTO conversations (id, project_id, title, created_at) VALUES ('stable-owner-chat', ?, 'Stable', 1)",
  ).run(project.id);
  store.db.prepare(
    `INSERT INTO runs (id, project_id, conversation_id, status, created_at)
     VALUES ('stable-owner-run', ?, 'stable-owner-chat', 'succeeded', 2)`,
  ).run(project.id);
  store.workspace.createArtifactRevision({
    ...standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "stable-run-owner",
    }),
    producedByRunId: "stable-owner-run",
  });
  assert.throws(
    () => store.db.prepare("UPDATE runs SET project_id = ? WHERE id = 'stable-owner-run'").run(otherProject.id),
    /immutable|owning Project/i,
  );
  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET project_id = ? WHERE id = ?").run(otherProject.id, workspace.id),
    /immutable|owning Project/i,
  );
  store.close();
});

test("Kernel impact analysis is deterministic, auditable, and rejects corrupt exact pins atomically", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Kernel impact audit", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-component",
    trackId: "revision-component-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "impact-component",
  }));
  const componentSnapshot = store.workspace.publishArtifactRevision(component.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const page = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "impact-page",
    dependencies: [{
      instanceId: "impact-instance",
      componentArtifactId: "revision-component",
      componentRevisionId: component.id,
      createInstanceIdentity: true,
      sourceLocator: { designNodeId: "impact.component" },
      overrides: {},
      status: "linked",
    }],
  }));
  const pageSnapshot = store.workspace.publishArtifactRevision(page.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: componentSnapshot.id,
  });
  const kernel = store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: { accent: "#7c3aed" },
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Impact candidate",
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
  const impact = store.workspace.analyzeKernelImpact(kernel.id, pageSnapshot.id);
  assert.deepEqual(impact, {
    workspaceId: workspace.id,
    baseSnapshotId: pageSnapshot.id,
    fromKernelRevisionId: workspace.activeKernelRevisionId,
    toKernelRevisionId: kernel.id,
    affectedArtifactRevisions: [
      {
        artifactId: "revision-component",
        revisionId: component.id,
        pinnedKernelRevisionId: workspace.activeKernelRevisionId,
      },
      {
        artifactId: "revision-page",
        revisionId: page.id,
        pinnedKernelRevisionId: workspace.activeKernelRevisionId,
      },
    ],
  });
  const published = store.workspace.publishKernelRevision(kernel.id, {
    expectedKernelRevisionId: workspace.activeKernelRevisionId,
    expectedSnapshotId: pageSnapshot.id,
  });
  assert.deepEqual(published.provenance, {
    kind: "kernel-publication",
    kernelRevisionId: kernel.id,
    impact,
  });

  const nextKernel = store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: kernel.id,
    tokens: { accent: "#2563eb" },
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Corrupt impact candidate",
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
  store.db.exec("PRAGMA foreign_keys = OFF");
  store.db.exec("DROP TRIGGER IF EXISTS artifact_revision_update_immutable");
  store.db.prepare("UPDATE artifact_revisions SET kernel_revision_id = 'missing-kernel' WHERE id = ?").run(page.id);
  store.db.exec("PRAGMA foreign_keys = ON");
  const beforeSnapshots = rowCount(store.db, "workspace_snapshots");
  assert.throws(() => store.workspace.publishKernelRevision(nextKernel.id, {
    expectedKernelRevisionId: kernel.id,
    expectedSnapshotId: published.id,
  }), /Kernel impact|pinned Kernel|not found/i);
  assert.equal(rowCount(store.db, "workspace_snapshots"), beforeSnapshots);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeKernelRevisionId, kernel.id);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, published.id);
  store.close();
});

test("imported Artifact and Kernel candidates fail closed on invalid roots and shared Asset pins", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Imported candidate validation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  store.db.exec("DROP TRIGGER artifact_revision_root_insert_ownership");
  store.db.prepare(
    `INSERT INTO artifact_revisions (
       id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
       source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
       render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
       legacy_run_id, created_at, sealed
     ) VALUES ('imported-bad-root', ?, 'revision-page', 'revision-page-track', 1, NULL,
               'commit', 'tree', '../../outside', ?, '{}', '{}', NULL, NULL, NULL, 1, 1)`,
  ).run(workspace.id, workspace.activeKernelRevisionId);
  assert.throws(() => store.workspace.getArtifactRevision("imported-bad-root"), /owning Artifact source root/i);
  assert.throws(() => store.workspace.listRevisions(project.id, "revision-page"), /owning Artifact source root/i);
  const beforeSnapshots = rowCount(store.db, "workspace_snapshots");
  assert.throws(() => store.workspace.publishArtifactRevision("imported-bad-root", {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  }), /owning Artifact source root/i);
  assert.equal(store.workspace.getTrack("revision-page-track")?.headRevisionId, null);
  assert.equal(rowCount(store.db, "workspace_snapshots"), beforeSnapshots);

  const invalidKernelPayload = JSON.stringify({
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: ["missing-asset-revision"],
    brief: "Imported invalid asset",
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
  store.db.prepare(
    `INSERT INTO shared_design_kernel_revisions
       (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
     VALUES ('imported-bad-kernel', ?, 2, ?, ?, ?, 2)`,
  ).run(
    workspace.id,
    workspace.activeKernelRevisionId,
    invalidKernelPayload,
    createHash("sha256").update(invalidKernelPayload).digest("hex"),
  );
  assert.throws(() => store.workspace.getKernelRevision("imported-bad-kernel"), /Shared Asset Revision/i);
  assert.throws(() => store.workspace.publishKernelRevision("imported-bad-kernel", {
    expectedKernelRevisionId: workspace.activeKernelRevisionId,
    expectedSnapshotId: graph.snapshot.id,
  }), /Shared Asset Revision/i);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeKernelRevisionId, workspace.activeKernelRevisionId);
  assert.equal(rowCount(store.db, "workspace_snapshots"), beforeSnapshots);
  store.close();
});

test("stored Kernel payloads and duplicated dependency locators must already be canonical", () => {
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Canonical Kernel storage", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    for (const [resourceId, revisionId] of [["asset-a-resource", "asset-a"], ["asset-z-resource", "asset-z"]]) {
      insertResource(store.db, workspace.id, resourceId!, null, "asset");
      insertResourceRevision(store.db, workspace.id, resourceId!, revisionId!);
    }
    const insertKernel = (id: string, sequence: number, sharedAssetRevisionIds: string[]) => {
      const payload = JSON.stringify({
        tokens: {},
        typography: {},
        sharedAssetRevisionIds,
        brief: "Imported canonicality fixture",
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
      store.db.prepare(
        `INSERT INTO shared_design_kernel_revisions
           (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        workspace.id,
        sequence,
        workspace.activeKernelRevisionId,
        payload,
        createHash("sha256").update(payload).digest("hex"),
        sequence,
      );
    };
    insertKernel("whitespace-kernel", 2, [" asset-a "]);
    insertKernel("unsorted-kernel", 3, ["asset-z", "asset-a"]);
    assert.throws(() => store.workspace.getKernelRevision("whitespace-kernel"), /already be canonical/i);
    assert.throws(() => store.workspace.getKernelRevision("unsorted-kernel"), /already be canonical/i);
    store.close();
  }

  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Dependency locator binding", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
    const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-component",
      trackId: "revision-component-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "locator-component",
    }));
    const page = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "locator-page",
      dependencies: [{
        instanceId: "locator-instance",
        componentArtifactId: "revision-component",
        componentRevisionId: component.id,
        createInstanceIdentity: true,
        sourceLocator: { designNodeId: "locator.original" },
        overrides: {},
        status: "linked",
      }],
    }));
    store.db.exec("DROP TRIGGER artifact_revision_dependency_update_immutable");
    store.db.prepare(
      "UPDATE artifact_revision_dependencies SET design_node_id = 'locator.corrupt' WHERE revision_id = ?",
    ).run(page.id);
    assert.throws(
      () => store.workspace.listArtifactRevisionDependencies(page.id),
      /design node id must match/i,
    );
    store.close();
  }
});

test("Artifact publication revalidates imported aggregate pins and the base Snapshot Kernel", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Imported aggregate publication", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const component = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-component",
    trackId: "revision-component-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "aggregate-component-pin",
  }));
  insertResource(store.db, workspace.id, "aggregate-pin-resource", null, "asset");
  insertResourceRevision(store.db, workspace.id, "aggregate-pin-resource", "aggregate-pin-resource-v1");
  const page = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "aggregate-page-pin",
    dependencies: [{
      instanceId: "aggregate-pin-instance",
      componentArtifactId: "revision-component",
      componentRevisionId: component.id,
      createInstanceIdentity: true,
      sourceLocator: { designNodeId: "aggregate.pin" },
      overrides: {},
      status: "linked",
    }],
    resourcePins: [{
      resourceId: "aggregate-pin-resource",
      resourceRevisionId: "aggregate-pin-resource-v1",
    }],
  }));
  const futureKernel = store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Inactive future Kernel",
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
  const futurePinnedPage = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: futureKernel.id,
    tree: "future-kernel-page",
  }));
  const before = {
    snapshots: rowCount(store.db, "workspace_snapshots"),
    graphs: rowCount(store.db, "workspace_graph_revisions"),
  };
  assert.throws(() => store.workspace.publishArtifactRevision(futurePinnedPage.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  }), /Kernel must match the expected base Snapshot Kernel/i);

  store.db.exec("PRAGMA foreign_keys = OFF");
  store.db.exec(`
    DROP TRIGGER artifact_revision_dependency_update_immutable;
    DROP TRIGGER artifact_revision_resource_update_immutable;
    DROP TRIGGER artifact_revision_update_immutable;
  `);
  store.db.prepare(
    "UPDATE artifact_revision_dependencies SET component_revision_id = 'missing-component-revision' WHERE revision_id = ?",
  ).run(page.id);
  assert.throws(() => store.workspace.listArtifactRevisionDependencies(page.id), /not found|Component Revision/i);
  assert.throws(() => store.workspace.publishArtifactRevision(page.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  }), /not found|Component Revision/i);
  store.db.prepare(
    "UPDATE artifact_revision_dependencies SET component_revision_id = ? WHERE revision_id = ?",
  ).run(component.id, page.id);
  store.db.prepare(
    "UPDATE artifact_revision_resources SET resource_revision_id = 'missing-resource-revision' WHERE revision_id = ?",
  ).run(page.id);
  assert.throws(() => store.workspace.listArtifactRevisionResourcePins(page.id), /exact same-Workspace Resource pin/i);
  assert.throws(() => store.workspace.publishArtifactRevision(page.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  }), /exact same-Workspace Resource pin/i);
  store.db.prepare(
    "UPDATE artifact_revision_resources SET resource_revision_id = 'aggregate-pin-resource-v1' WHERE revision_id = ?",
  ).run(page.id);
  store.db.prepare(
    "UPDATE artifact_revisions SET kernel_revision_id = 'missing-kernel-revision' WHERE id = ?",
  ).run(page.id);
  assert.throws(() => store.workspace.getArtifactRevision(page.id), /Kernel Revision not found/i);
  assert.throws(() => store.workspace.publishArtifactRevision(page.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  }), /Kernel Revision not found/i);
  assert.equal(store.workspace.getTrack("revision-page-track")?.headRevisionId, null);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, graph.snapshot.id);
  assert.equal(rowCount(store.db, "workspace_snapshots"), before.snapshots);
  assert.equal(rowCount(store.db, "workspace_graph_revisions"), before.graphs);
  store.close();
});

test("Task 4 trigger upgrades self-heal stale definitions and first activation is coherent", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-task4-trigger-upgrade-")), "upgrade.db");
  const created = new Store(file, fakeClock());
  created.close();
  const stale = new DatabaseSync(file);
  stale.exec(`
    DROP TRIGGER workspace_active_snapshot_update_ownership;
    CREATE TRIGGER workspace_active_snapshot_update_ownership
    BEFORE UPDATE OF active_snapshot_id, id ON project_workspaces
    WHEN NEW.active_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workspace_snapshots
      WHERE id = NEW.active_snapshot_id AND workspace_id = NEW.id
    )
    BEGIN SELECT RAISE(ABORT, 'stale ownership trigger'); END;
    DROP TRIGGER workspace_active_state_transition_guard;
    CREATE TRIGGER workspace_active_state_transition_guard
    BEFORE UPDATE OF active_snapshot_id ON project_workspaces
    WHEN OLD.active_snapshot_id IS NOT NULL AND NEW.active_snapshot_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'stale active transition trigger'); END;
  `);
  stale.close();

  const upgraded = new Store(file, fakeClock());
  const triggerSql = (name: string) => (upgraded.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).get(name) as { sql: string }).sql;
  assert.match(triggerSql("workspace_active_snapshot_update_ownership"), /sealed\s*=\s*1/i);
  assert.match(triggerSql("workspace_active_state_transition_guard"), /json_each\(graph\.nodes_json\)/i);
  assert.match(triggerSql("kernel_parent_insert_ownership"), /sequence\s*<\s*NEW\.sequence/i);

  const project = upgraded.createProject({ name: "First activation coherence", mode: "standard" });
  const kernelPayload = JSON.stringify({
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Initial Kernel",
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
  upgraded.db.exec("BEGIN IMMEDIATE");
  try {
    upgraded.db.prepare(
      `INSERT INTO project_workspaces
         (id, project_id, graph_revision, active_snapshot_id, active_kernel_revision_id, created_at, updated_at)
       VALUES ('initial-activation-workspace', ?, 0, NULL, NULL, 1, 1)`,
    ).run(project.id);
    const emptyChecksum = workspaceGraphChecksum("[]", "[]");
    upgraded.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES ('initial-activation-workspace', 0, '[]', '[]', ?, 1),
              ('initial-activation-workspace', 1, '[]', '[]', ?, 2)`,
    ).run(emptyChecksum, emptyChecksum);
    upgraded.db.prepare(
      `INSERT INTO shared_design_kernel_revisions
         (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
       VALUES ('initial-activation-kernel', 'initial-activation-workspace', 1, NULL, ?, ?, 1)`,
    ).run(kernelPayload, createHash("sha256").update(kernelPayload).digest("hex"));
    upgraded.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('initial-activation-snapshot', 'initial-activation-workspace', 1, NULL, 1,
                 'initial-activation-kernel', 'initial',
                 '{"kind":"workspace-created"}', NULL, 1, 1)`,
    ).run();
    assert.throws(
      () => upgraded.db.prepare(
        `UPDATE project_workspaces
         SET active_snapshot_id = 'initial-activation-snapshot',
             active_kernel_revision_id = 'initial-activation-kernel', graph_revision = 0
         WHERE id = 'initial-activation-workspace'`,
      ).run(),
      /coherent direct child|active state/i,
    );
  } finally {
    upgraded.db.exec("ROLLBACK");
  }
  const workspace = upgraded.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(upgraded, project.id, workspace.activeSnapshotId);
  const storedGraph = upgraded.db.prepare(
    "SELECT nodes_json, edges_json FROM workspace_graph_revisions WHERE workspace_id = ? AND revision = 1",
  ).get(workspace.id) as { nodes_json: string; edges_json: string };
  const validNodes = JSON.parse(storedGraph.nodes_json) as Array<Record<string, unknown>>;
  const duplicateIdNodes = validNodes.map((node) => ({ ...node }));
  duplicateIdNodes[1]!.id = duplicateIdNodes[0]!.id;
  const kindMismatchNodes = validNodes.map((node) => ({ ...node }));
  const pageIndex = kindMismatchNodes.findIndex((node) => node.artifactId === "revision-page");
  kindMismatchNodes[pageIndex]!.kind = "component";
  for (const [revision, snapshotId, nodes] of [
    [2, "kind-mismatch-snapshot", kindMismatchNodes],
    [3, "duplicate-node-snapshot", duplicateIdNodes],
  ] as const) {
    const nodesJson = JSON.stringify(nodes);
    upgraded.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspace.id,
      revision,
      nodesJson,
      storedGraph.edges_json,
      workspaceGraphChecksum(nodesJson, storedGraph.edges_json),
      revision,
    );
    upgraded.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES (?, ?, ?, ?, ?, ?, 'corrupt-graph-shape',
                 '{"kind":"legacy-migration","migration":"corrupt-graph-shape"}', NULL, ?, 0)`,
    ).run(
      snapshotId,
      workspace.id,
      revision + 1,
      graph.snapshot.id,
      revision,
      workspace.activeKernelRevisionId,
      revision,
    );
    upgraded.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       SELECT workspace_id, ?, artifact_id, track_id, revision_id
       FROM workspace_snapshot_artifacts WHERE snapshot_id = ?`,
    ).run(snapshotId, graph.snapshot.id);
    upgraded.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = ?").run(snapshotId);
    assert.throws(
      () => upgraded.db.prepare(
        "UPDATE project_workspaces SET graph_revision = ?, active_snapshot_id = ? WHERE id = ?",
      ).run(revision, snapshotId, workspace.id),
      /coherent direct child|active state/i,
    );
  }
  assert.throws(
    () => upgraded.workspace.listSnapshots(project.id),
    /exact owned Revision pin|Artifact mapping/i,
  );
  upgraded.close();
});

test("Task 5 upgrades an old Task 4 Artifact table without changing normal identities", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dezin-task5-schema-upgrade-")), "upgrade.db");
  const created = new Store(file, fakeClock());
  const normalProject = created.createProject({ name: "Existing Workspace", mode: "standard" });
  const normalWorkspace = created.workspace.ensureWorkspaceRecord(normalProject.id);
  created.workspace.applyGraphCommands(normalProject.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: normalWorkspace.activeSnapshotId,
    commands: [{
      id: "add-existing-page",
      type: "add-node",
      node: {
        id: "existing-page-node",
        kind: "page",
        name: "Existing page",
        artifactId: "existing-page-artifact",
        createIdentity: { initialTrackId: "existing-page-track" },
      },
    }],
  });
  const legacyProject = created.createProject({ name: "Legacy to wrap", mode: "standard" });
  const normalBefore = created.db.prepare(
    `SELECT id, workspace_id, kind, name, source_root, active_track_id, archived_at, created_at, updated_at
     FROM workspace_artifacts WHERE id = 'existing-page-artifact'`,
  ).get();
  created.close();

  const task4 = new DatabaseSync(file);
  task4.exec(`
    DROP INDEX idx_workspace_artifacts_one_legacy_wrapper;
    DROP TRIGGER workspace_artifact_identity_update_immutable;
    DROP TRIGGER workspace_artifact_legacy_wrapper_insert_guard;
    DROP TRIGGER project_mode_legacy_workspace_guard;
    ALTER TABLE workspace_artifacts DROP COLUMN legacy_wrapped;
  `);
  assert.equal(
    (task4.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('workspace_artifacts') WHERE name = 'legacy_wrapped'")
      .get() as { count: number }).count,
    0,
  );
  task4.close();

  const upgraded = new Store(file, fakeClock());
  const markerColumn = upgraded.db.prepare(
    `SELECT "notnull" AS not_null, dflt_value
     FROM pragma_table_info('workspace_artifacts') WHERE name = 'legacy_wrapped'`,
  ).get() as { not_null: number; dflt_value: string };
  assert.deepEqual([markerColumn.not_null, markerColumn.dflt_value], [1, "0"]);
  assert.deepEqual(upgraded.db.prepare(
    `SELECT id, workspace_id, kind, name, source_root, active_track_id, archived_at, created_at, updated_at
     FROM workspace_artifacts WHERE id = 'existing-page-artifact'`,
  ).get(), normalBefore);
  assert.equal(upgraded.workspace.getArtifact("existing-page-artifact")?.legacyWrapped, false);
  const identityTrigger = upgraded.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'workspace_artifact_identity_update_immutable'",
  ).get() as { sql: string };
  const wrapperIndex = upgraded.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_artifacts_one_legacy_wrapper'",
  ).get() as { sql: string };
  assert.match(identityTrigger.sql, /legacy_wrapped/i);
  assert.match(wrapperIndex.sql, /WHERE legacy_wrapped = 1/i);
  assert.throws(
    () => upgraded.db.prepare(
      `INSERT INTO workspace_artifacts (
         id, workspace_id, kind, name, source_root,
         active_track_id, archived_at, created_at, updated_at
       ) VALUES ('invalid-upgraded-dot-root', ?, 'page', 'Invalid', '.', NULL, NULL, 1, 1)`,
    ).run(normalWorkspace.id),
    /legacy-wrapped/i,
  );

  const facts = upgraded.workspace.readLegacyStandardWorkspaceFacts(legacyProject.id);
  const migrated = upgraded.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: [],
  });
  assert.deepEqual(migrated.artifacts.map((artifact) => [artifact.legacyWrapped, artifact.sourceRoot]), [[true, "."]]);
  assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  upgraded.close();
});

test("public readers reject imported backward parent lineages", () => {
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Artifact parent read", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    insertArtifact(store.db, workspace.id, "lineage-artifact");
    insertTrack(store.db, "lineage-artifact", "lineage-track");
    store.db.exec("DROP TRIGGER artifact_revision_parent_insert_ownership");
    insertRevision(store.db, {
      id: "lineage-artifact-parent",
      workspaceId: workspace.id,
      artifactId: "lineage-artifact",
      trackId: "lineage-track",
      kernelRevisionId: workspace.activeKernelRevisionId,
      sequence: 2,
    });
    insertRevision(store.db, {
      id: "lineage-artifact-child",
      workspaceId: workspace.id,
      artifactId: "lineage-artifact",
      trackId: "lineage-track",
      kernelRevisionId: workspace.activeKernelRevisionId,
      sequence: 1,
      parentRevisionId: "lineage-artifact-parent",
    });
    assert.throws(
      () => store.workspace.getArtifactRevision("lineage-artifact-child"),
      /earlier sealed Revision on the same Track/i,
    );
    store.db.exec(`
      DROP TRIGGER artifact_revision_update_immutable;
      DROP TRIGGER artifact_revision_parent_update_ownership;
      PRAGMA foreign_keys = OFF;
    `);
    store.db.prepare(
      "UPDATE artifact_revisions SET parent_revision_id = 'missing-artifact-parent' WHERE id = 'lineage-artifact-child'",
    ).run();
    assert.throws(
      () => store.workspace.getArtifactRevision("lineage-artifact-child"),
      /parent is not resolvable/i,
    );
    const foreignProject = store.createProject({ name: "Foreign Artifact parent", mode: "standard" });
    const foreignWorkspace = store.workspace.ensureWorkspaceRecord(foreignProject.id);
    insertArtifact(store.db, foreignWorkspace.id, "foreign-lineage-artifact");
    insertTrack(store.db, "foreign-lineage-artifact", "foreign-lineage-track");
    insertRevision(store.db, {
      id: "foreign-lineage-artifact-parent",
      workspaceId: foreignWorkspace.id,
      artifactId: "foreign-lineage-artifact",
      trackId: "foreign-lineage-track",
      kernelRevisionId: foreignWorkspace.activeKernelRevisionId,
    });
    store.db.prepare(
      "UPDATE artifact_revisions SET parent_revision_id = 'foreign-lineage-artifact-parent' WHERE id = 'lineage-artifact-child'",
    ).run();
    assert.throws(
      () => store.workspace.getArtifactRevision("lineage-artifact-child"),
      /earlier sealed Revision on the same Track/i,
    );
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Kernel parent read", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    store.db.exec("DROP TRIGGER kernel_parent_insert_ownership");
    store.db.prepare(
      `INSERT INTO shared_design_kernel_revisions
         (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
       SELECT 'lineage-kernel-parent', workspace_id, 3, NULL, payload_json, checksum, 3
       FROM shared_design_kernel_revisions WHERE id = ?`,
    ).run(workspace.activeKernelRevisionId);
    store.db.prepare(
      `INSERT INTO shared_design_kernel_revisions
         (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
       SELECT 'lineage-kernel-child', workspace_id, 2, 'lineage-kernel-parent', payload_json, checksum, 2
       FROM shared_design_kernel_revisions WHERE id = ?`,
    ).run(workspace.activeKernelRevisionId);
    assert.throws(
      () => store.workspace.getKernelRevision("lineage-kernel-child"),
      /earlier Revision in the same Workspace/i,
    );
    store.db.exec(`
      DROP TRIGGER kernel_revision_update_immutable;
      DROP TRIGGER kernel_parent_update_ownership;
      PRAGMA foreign_keys = OFF;
    `);
    store.db.prepare(
      "UPDATE shared_design_kernel_revisions SET parent_revision_id = 'missing-kernel-parent' WHERE id = 'lineage-kernel-child'",
    ).run();
    assert.throws(() => store.workspace.getKernelRevision("lineage-kernel-child"), /parent is not resolvable/i);
    const foreignProject = store.createProject({ name: "Foreign Kernel parent", mode: "standard" });
    const foreignWorkspace = store.workspace.ensureWorkspaceRecord(foreignProject.id);
    store.db.prepare(
      "UPDATE shared_design_kernel_revisions SET parent_revision_id = ? WHERE id = 'lineage-kernel-child'",
    ).run(foreignWorkspace.activeKernelRevisionId);
    assert.throws(
      () => store.workspace.getKernelRevision("lineage-kernel-child"),
      /earlier Revision in the same Workspace/i,
    );
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Snapshot parent read", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    store.db.exec("DROP TRIGGER snapshot_parent_insert_ownership");
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('lineage-snapshot-parent', ?, 3, NULL, 0, ?, 'parent',
                 '{"kind":"legacy-migration","migration":"parent"}', NULL, 3, 1),
                ('lineage-snapshot-child', ?, 2, 'lineage-snapshot-parent', 0, ?, 'child',
                 '{"kind":"legacy-migration","migration":"child"}', NULL, 2, 1)`,
    ).run(
      workspace.id,
      workspace.activeKernelRevisionId,
      workspace.id,
      workspace.activeKernelRevisionId,
    );
    assert.throws(
      () => store.workspace.listSnapshots(project.id),
      /earlier sealed Snapshot in the same Workspace/i,
    );
    store.db.exec(`
      DROP TRIGGER workspace_snapshot_update_immutable;
      DROP TRIGGER snapshot_parent_update_ownership;
      PRAGMA foreign_keys = OFF;
    `);
    store.db.prepare(
      "UPDATE workspace_snapshots SET parent_snapshot_id = 'missing-snapshot-parent' WHERE id = 'lineage-snapshot-child'",
    ).run();
    assert.throws(() => store.workspace.listSnapshots(project.id), /parent is not resolvable/i);
    const foreignProject = store.createProject({ name: "Foreign Snapshot parent", mode: "standard" });
    const foreignWorkspace = store.workspace.ensureWorkspaceRecord(foreignProject.id);
    store.db.prepare(
      "UPDATE workspace_snapshots SET parent_snapshot_id = ? WHERE id = 'lineage-snapshot-child'",
    ).run(foreignWorkspace.activeSnapshotId);
    assert.throws(
      () => store.workspace.listSnapshots(project.id),
      /earlier sealed Snapshot in the same Workspace/i,
    );
    store.close();
  }
});

test("unsealed aggregates and stale active Snapshot mappings cannot become public state", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Sealed activation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
  const inactive = store.workspace.createWorkspaceSnapshot(project.id, {
    expectedSnapshotId: graph.snapshot.id,
    reason: "pre-head-checkpoint",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "activation-proposal",
      planId: "activation-plan",
      checkpointId: "activation-checkpoint",
    },
  });
  const candidate = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "revision-page",
    trackId: "revision-page-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "activation-candidate",
  }));
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(
      "UPDATE artifact_tracks SET head_revision_id = ? WHERE id = 'revision-page-track'",
    ).run(candidate.id);
    assert.throws(
      () => store.db.prepare("UPDATE project_workspaces SET active_snapshot_id = ? WHERE id = ?")
        .run(inactive.id, workspace.id),
      /coherent direct child|active state/i,
    );
  } finally {
    store.db.exec("ROLLBACK");
  }
  assert.equal(store.workspace.getTrack("revision-page-track")?.headRevisionId, null);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, graph.snapshot.id);

  insertRevision(store.db, {
    id: "unsealed-artifact-revision",
    workspaceId: workspace.id,
    artifactId: "revision-page",
    trackId: "revision-page-track",
    kernelRevisionId: workspace.activeKernelRevisionId,
    sequence: 2,
    parentRevisionId: candidate.id,
    sealed: 0,
  });
  assert.throws(() => store.workspace.getArtifactRevision("unsealed-artifact-revision"), /must be sealed/i);
  assert.throws(
    () => store.workspace.listArtifactRevisionDependencies("unsealed-artifact-revision"),
    /must be sealed/i,
  );
  assert.throws(
    () => store.workspace.listArtifactRevisionResourcePins("unsealed-artifact-revision"),
    /must be sealed/i,
  );
  assert.throws(() => store.workspace.listArtifactRevisionDependencies("missing-revision"), /not found/i);
  assert.throws(() => store.workspace.listArtifactRevisionResourcePins("missing-revision"), /not found/i);
  assert.throws(
    () => store.db.prepare(
      "UPDATE artifact_tracks SET head_revision_id = 'unsealed-artifact-revision' WHERE id = 'revision-page-track'",
    ).run(),
    /ownership|sealed/i,
  );
  store.db.prepare(
    `INSERT INTO workspace_snapshots (
       id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
       reason, provenance_json, created_by_run_id, created_at, sealed
     ) VALUES ('unsealed-snapshot', ?, 4, ?, 1, ?, 'unsealed',
               '{"kind":"legacy-migration","migration":"unsealed"}', NULL, 4, 0)`,
  ).run(workspace.id, graph.snapshot.id, workspace.activeKernelRevisionId);
  assert.throws(() => store.workspace.listSnapshots(project.id), /must be sealed/i);
  assert.throws(
    () => store.db.prepare("UPDATE project_workspaces SET active_snapshot_id = 'unsealed-snapshot' WHERE id = ?")
      .run(workspace.id),
    /ownership|sealed|active state/i,
  );
  store.close();
});

test("Snapshot readback binds mappings and Kernel impact to immutable history", () => {
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Snapshot mapping readback", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('corrupt-mapping-snapshot', ?, 3, ?, 1, ?, 'corrupt',
                 '{"kind":"legacy-migration","migration":"missing-mapping"}', NULL, 3, 1)`,
    ).run(workspace.id, graph.snapshot.id, workspace.activeKernelRevisionId);
    store.db.prepare(
      "UPDATE workspace_artifacts SET archived_at = 99 WHERE id IN ('revision-page', 'revision-component')",
    ).run();
    assert.throws(() => store.workspace.listSnapshots(project.id), /exactly match its immutable graph/i);
    assert.throws(
      () => store.db.prepare(
        "UPDATE project_workspaces SET active_snapshot_id = 'corrupt-mapping-snapshot' WHERE id = ?",
      ).run(workspace.id),
      /coherent direct child|active state/i,
    );
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Artifact audit readback", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
    const mapped = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "mapped-audit-candidate",
    }));
    const unrelated = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "unrelated-audit-candidate",
    }));
    const sequence = Number((store.db.prepare(
      "SELECT MAX(sequence) + 1 AS sequence FROM workspace_snapshots WHERE workspace_id = ?",
    ).get(workspace.id) as { sequence: number }).sequence);
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('corrupt-artifact-audit', ?, ?, ?, 1, ?, 'corrupt-audit', ?, NULL, ?, 0)`,
    ).run(
      workspace.id,
      sequence,
      graph.snapshot.id,
      workspace.activeKernelRevisionId,
      JSON.stringify({ kind: "artifact-publication", revisionId: unrelated.id }),
      sequence,
    );
    store.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       SELECT workspace_id, 'corrupt-artifact-audit', artifact_id, track_id,
              CASE WHEN artifact_id = 'revision-page' THEN ? ELSE revision_id END
       FROM workspace_snapshot_artifacts WHERE snapshot_id = ?`,
    ).run(mapped.id, graph.snapshot.id);
    store.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = 'corrupt-artifact-audit'").run();
    assert.throws(
      () => store.workspace.listSnapshots(project.id),
      /Artifact publication Snapshot.*audit provenance does not match immutable history/i,
    );
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Resource identity readback", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const nodesJson = JSON.stringify([{
      id: "missing-resource-node",
      workspaceId: workspace.id,
      kind: "resource",
      name: "Missing resource",
      resourceId: "missing-resource",
    }]);
    const edgesJson = "[]";
    store.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES (?, 1, ?, ?, ?, 2)`,
    ).run(workspace.id, nodesJson, edgesJson, workspaceGraphChecksum(nodesJson, edgesJson));
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('missing-resource-identity-snapshot', ?, 2, ?, 1, ?, 'corrupt-resource',
                 '{"kind":"legacy-migration","migration":"missing-resource-identity"}', NULL, 2, 1)`,
    ).run(workspace.id, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
    assert.throws(
      () => store.workspace.listSnapshots(project.id),
      /Resource missing-resource has no owned identity/i,
    );
    assert.throws(
      () => store.db.prepare(
        `UPDATE project_workspaces
         SET graph_revision = 1, active_snapshot_id = 'missing-resource-identity-snapshot'
         WHERE id = ?`,
      ).run(workspace.id),
      /coherent direct child|active state/i,
    );
    store.close();
  }
  {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Kernel audit readback", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const graph = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId);
    const kernel = store.workspace.createKernelRevision({
      workspaceId: workspace.id,
      parentRevisionId: workspace.activeKernelRevisionId,
      tokens: {},
      typography: {},
      sharedAssetRevisionIds: [],
      brief: "Audit target",
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
    const fakeImpact = {
      workspaceId: "fake-workspace",
      baseSnapshotId: "fake-snapshot",
      fromKernelRevisionId: workspace.activeKernelRevisionId,
      toKernelRevisionId: kernel.id,
      affectedArtifactRevisions: [],
    };
    store.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES ('corrupt-kernel-audit', ?, 3, ?, 1, ?, 'corrupt-audit', ?, NULL, 3, 0)`,
    ).run(
      workspace.id,
      graph.snapshot.id,
      kernel.id,
      JSON.stringify({ kind: "kernel-publication", kernelRevisionId: kernel.id, impact: fakeImpact }),
    );
    store.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       SELECT workspace_id, 'corrupt-kernel-audit', artifact_id, track_id, revision_id
       FROM workspace_snapshot_artifacts WHERE snapshot_id = ?`,
    ).run(graph.snapshot.id);
    store.db.prepare("UPDATE workspace_snapshots SET sealed = 1 WHERE id = 'corrupt-kernel-audit'").run();
    assert.throws(() => store.workspace.listSnapshots(project.id), /impact audit does not match/i);
    store.close();
  }
});

test("durable identifier ordering uses binary code-point order", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Binary ordering", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const revisionIds = ["z", "ä", "A", "a", "\ue000", "😀"];
  for (const revisionId of revisionIds) {
    insertResource(store.db, workspace.id, `asset-${revisionId}`, null, "asset");
    insertResourceRevision(store.db, workspace.id, `asset-${revisionId}`, revisionId);
  }
  const kernel = store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: { "😀": 1, "\ue000": 2 },
    typography: {},
    sharedAssetRevisionIds: revisionIds,
    brief: "Binary order",
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
  const sqliteOrder = (store.db.prepare(
    "SELECT id FROM resource_revisions WHERE workspace_id = ? ORDER BY id COLLATE BINARY ASC",
  ).all(workspace.id) as Array<{ id: string }>).map(({ id }) => id);
  assert.deepEqual(kernel.sharedAssetRevisionIds, ["A", "a", "z", "ä", "\ue000", "😀"]);
  assert.deepEqual(kernel.sharedAssetRevisionIds, sqliteOrder);
  assert.deepEqual(Object.keys(kernel.tokens), ["\ue000", "😀"]);
  assert.throws(() => store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: {},
    typography: {},
    sharedAssetRevisionIds: ["\ud800"],
    brief: "Malformed id",
    terminology: {},
    exclusions: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  }), /well-formed Unicode/i);
  assert.throws(() => store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: { "\ud800": 1 },
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "Malformed key",
    terminology: {},
    exclusions: [],
    responsiveFrames: [],
    qualityProfile: {
      requiredFrameIds: [],
      blockingSeverities: [],
      requireRuntimeChecks: false,
      requireVisualReview: false,
    },
  }), /keys must contain well-formed Unicode/i);
  const nodesBefore = rowCount(store.db, "workspace_nodes");
  assert.throws(() => store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "malformed-unicode-command",
      type: "add-node",
      node: {
        id: "\ud800",
        kind: "page",
        name: "Malformed",
        artifactId: "malformed-unicode-artifact",
        createIdentity: { initialTrackId: "malformed-unicode-track" },
      },
    }],
  }), /well-formed Unicode/i);
  assert.equal(rowCount(store.db, "workspace_nodes"), nodesBefore);
  store.close();
});

test("Kernel impact publication and readback share SQLite UTF-8 identifier order", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "UTF-8 Kernel impact", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [
      {
        id: "add-bmp-artifact",
        type: "add-node",
        node: {
          id: "bmp-node",
          kind: "page",
          name: "BMP page",
          artifactId: "\ue000",
          createIdentity: { initialTrackId: "bmp-track" },
        },
      },
      {
        id: "add-astral-artifact",
        type: "add-node",
        node: {
          id: "astral-node",
          kind: "page",
          name: "Astral page",
          artifactId: "😀",
          createIdentity: { initialTrackId: "astral-track" },
        },
      },
    ],
  });
  const bmpRevision = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "\ue000",
    trackId: "bmp-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "bmp-impact",
  }));
  const bmpSnapshot = store.workspace.publishArtifactRevision(bmpRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: graph.snapshot.id,
  });
  const astralRevision = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "😀",
    trackId: "astral-track",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "astral-impact",
  }));
  const artifactsSnapshot = store.workspace.publishArtifactRevision(astralRevision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: bmpSnapshot.id,
  });
  const kernel = store.workspace.createKernelRevision({
    workspaceId: workspace.id,
    parentRevisionId: workspace.activeKernelRevisionId,
    tokens: { accent: "#111827" },
    typography: {},
    sharedAssetRevisionIds: [],
    brief: "UTF-8 impact",
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
  const published = store.workspace.publishKernelRevision(kernel.id, {
    expectedKernelRevisionId: workspace.activeKernelRevisionId,
    expectedSnapshotId: artifactsSnapshot.id,
  });
  const provenance = published.provenance;
  assert.equal(provenance.kind, "kernel-publication");
  if (provenance.kind !== "kernel-publication") throw new Error("expected Kernel publication provenance");
  assert.deepEqual(
    provenance.impact?.affectedArtifactRevisions.map(({ artifactId }) => artifactId),
    ["\ue000", "😀"],
  );
  const readback = store.workspace.listSnapshots(project.id).at(-1);
  assert.deepEqual(readback?.provenance, provenance);
  store.close();
});

test("history reads validate each distinct Artifact, Kernel, and Snapshot lineage row once per transaction", () => {
  const clock = fakeClock();
  const store = new Store(":memory:", clock);
  const project = store.createProject({ name: "Linear history reads", mode: "standard" });
  const conversation = store.createConversation(project.id, "Lineage validation");
  const run = store.createRun(project.id, conversation.id);
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  let activeSnapshot = addRevisionTestArtifacts(store, project.id, workspace.activeSnapshotId).snapshot;
  let artifactHead: string | null = null;
  const artifactHistorySize = 64;
  const kernelHistorySize = 32;

  for (let index = 0; index < artifactHistorySize; index += 1) {
    const revision = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "revision-page",
      trackId: "revision-page-track",
      parentRevisionId: artifactHead,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: `linear-${index}`,
      producedByRunId: run.id,
    }));
    activeSnapshot = store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: artifactHead,
      expectedSnapshotId: activeSnapshot.id,
    });
    artifactHead = revision.id;
  }

  let activeKernelRevisionId = workspace.activeKernelRevisionId;
  for (let index = 0; index < kernelHistorySize; index += 1) {
    const kernel = store.workspace.createKernelRevision({
      workspaceId: workspace.id,
      parentRevisionId: activeKernelRevisionId,
      tokens: { accent: `#00000${index}` },
      typography: {},
      sharedAssetRevisionIds: [],
      brief: `Linear Kernel ${index}`,
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
    activeSnapshot = store.workspace.publishKernelRevision(kernel.id, {
      expectedKernelRevisionId: activeKernelRevisionId,
      expectedSnapshotId: activeSnapshot.id,
    });
    activeKernelRevisionId = kernel.id;
  }

  const counts: LineageReadCounts = {
    artifactRows: 0,
    artifactReferenceReads: 0,
    kernelRows: 0,
    runOwnershipReads: 0,
    snapshotRows: 0,
  };
  const observed = observeLineageReads(store.db, clock, counts);
  const resetCounts = () => {
    counts.artifactRows = 0;
    counts.artifactReferenceReads = 0;
    counts.kernelRows = 0;
    counts.runOwnershipReads = 0;
    counts.snapshotRows = 0;
  };

  const revisions = observed.listRevisions(project.id, "revision-page");
  assert.equal(revisions.length, artifactHistorySize);
  assert.equal(counts.artifactRows, 0, "the list query must preload every Artifact Revision header");
  assert.equal(counts.artifactReferenceReads, revisions.length);
  assert.equal(counts.runOwnershipReads, revisions.length);
  assert.equal(counts.kernelRows, 1);

  for (let read = 0; read < 2; read += 1) {
    resetCounts();
    assert.equal(observed.getArtifactRevision(artifactHead!)?.id, artifactHead);
    assert.equal(counts.artifactRows, revisions.length, "each outer read needs a fresh, linear Artifact context");
    assert.equal(
      counts.artifactReferenceReads,
      revisions.length,
      "each Artifact reference must be validated once in that outer read",
    );
    assert.equal(counts.runOwnershipReads, revisions.length);
    assert.equal(counts.kernelRows, 1);
  }

  resetCounts();
  const snapshots = observed.listSnapshots(project.id);
  assert.equal(snapshots.at(-1)?.id, activeSnapshot.id);
  assert.equal(counts.snapshotRows, 0, "the list query must preload every Snapshot header");
  assert.equal(counts.artifactRows, revisions.length);
  assert.equal(counts.artifactReferenceReads, revisions.length);
  assert.equal(counts.runOwnershipReads, revisions.length * 2);
  assert.equal(counts.kernelRows, kernelHistorySize + 1);

  resetCounts();
  const checkpoint = observed.publishSnapshot(project.id, {
    expectedSnapshotId: activeSnapshot.id,
    reason: "linear-history-checkpoint",
    provenance: {
      kind: "plan-checkpoint",
      proposalId: "linear-proposal",
      planId: "linear-plan",
      checkpointId: "linear-checkpoint",
    },
  });
  assert.equal(checkpoint.parentSnapshotId, activeSnapshot.id);
  assert.equal(counts.snapshotRows, snapshots.length + 1);
  assert.equal(counts.artifactRows, revisions.length);
  assert.equal(counts.artifactReferenceReads, revisions.length);
  assert.equal(counts.runOwnershipReads, revisions.length * 2);
  assert.equal(counts.kernelRows, kernelHistorySize + 1);
  store.close();
});

test("legacy Standard migration adopts the empty foundation as one wrapped Page", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Legacy Standard", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const beforeProject = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id);

  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const bundle = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: facts.successfulRuns.map((run) => ({
      ...run,
      gitSnapshot: { status: "unavailable" as const },
    })),
  });

  assert.equal(bundle.workspace.graphRevision, 1);
  assert.equal(bundle.graph.nodes.length, 1);
  assert.equal(bundle.artifacts.length, 1);
  assert.equal(bundle.artifacts[0]?.kind, "page");
  assert.equal(bundle.artifacts[0]?.sourceRoot, ".");
  assert.equal(bundle.artifacts[0]?.legacyWrapped, true);
  assert.equal(bundle.tracks.length, 1);
  assert.equal(bundle.tracks[0]?.name, "Legacy unassigned");
  assert.equal(bundle.tracks[0]?.legacyVariantId, null);
  assert.equal(bundle.revisions.length, 0);
  assert.equal(bundle.snapshots.length, 2);
  assert.equal(bundle.snapshots[1]?.parentSnapshotId, foundation.activeSnapshotId);
  assert.deepEqual(bundle.snapshots[1]?.provenance, {
    kind: "legacy-migration",
    migration: "legacy-standard-v1",
  });
  assert.deepEqual(store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id), beforeProject);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("legacy Standard migration preserves Variant and Run aliases with per-Track lineage", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Legacy history", mode: "standard" });
  const conversation = store.createConversation(project.id, "History");
  const variantA = store.createVariant(project.id, "A");
  const variantB = store.createVariant(project.id, "B");
  store.setActiveVariant(project.id, variantB.id);
  const runs = [
    store.createImportedRun(project.id, conversation.id, {
      variantId: variantA.id,
      status: "succeeded",
      commitHash: "1".repeat(40),
      createdAt: 10,
      finishedAt: 11,
      lintPassed: true,
      score: 100,
    }),
    store.createImportedRun(project.id, conversation.id, {
      variantId: variantB.id,
      status: "succeeded",
      commitHash: "2".repeat(40),
      createdAt: 20,
      finishedAt: 21,
    }),
    store.createImportedRun(project.id, conversation.id, {
      variantId: variantA.id,
      status: "succeeded",
      commitHash: "3".repeat(40),
      createdAt: 30,
      finishedAt: 31,
    }),
    store.createImportedRun(project.id, conversation.id, {
      variantId: null,
      status: "succeeded",
      commitHash: "4".repeat(40),
      createdAt: 40,
      finishedAt: 41,
    }),
  ];
  const legacyBefore = {
    project: store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id),
    variants: store.db.prepare("SELECT * FROM variants WHERE project_id = ? ORDER BY id").all(project.id),
    runs: store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(project.id),
  };
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const seed = {
    version: 1 as const,
    ...facts,
    project: { ...facts.project, mode: "standard" as const },
    successfulRuns: facts.successfulRuns.map((run, index) => ({
      ...run,
      gitSnapshot: {
        status: "verified" as const,
        sourceCommitHash: run.commitHash!,
        sourceTreeHash: String.fromCharCode(97 + index).repeat(40),
        artifactRoot: "." as const,
      },
    })),
  };

  const first = store.workspace.ensureLegacyStandardWorkspace(seed);
  const second = store.workspace.ensureLegacyStandardWorkspace(seed);
  assert.deepEqual(second, first);
  const aliased = new Map(first.tracks.filter((track) => track.legacyVariantId).map((track) => [track.legacyVariantId, track]));
  assert.equal(aliased.size, 2);
  assert.equal(first.artifacts[0]?.activeTrackId, aliased.get(variantB.id)?.id);
  assert.equal(first.tracks.filter((track) => track.legacyVariantId === null).length, 1);
  const revisionsByRun = new Map(first.revisions.map((revision) => [revision.legacyRunId, revision]));
  assert.deepEqual([...revisionsByRun.keys()].sort(), runs.map((run) => run.id).sort());
  const revisionA1 = revisionsByRun.get(runs[0]!.id)!;
  const revisionA2 = revisionsByRun.get(runs[2]!.id)!;
  assert.equal(revisionA1.trackId, aliased.get(variantA.id)?.id);
  assert.equal(revisionA1.sequence, 1);
  assert.equal(revisionA1.parentRevisionId, null);
  assert.equal(revisionA2.sequence, 2);
  assert.equal(revisionA2.parentRevisionId, revisionA1.id);
  assert.deepEqual(revisionA1.quality, { state: "unassessed", score: null, findings: [] });
  assert.equal(revisionA1.producedByRunId, null);
  assert.deepEqual({
    project: store.db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id),
    variants: store.db.prepare("SELECT * FROM variants WHERE project_id = ? ORDER BY id").all(project.id),
    runs: store.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(project.id),
  }, legacyBefore);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("legacy Workspace fact capture rejects corrupt legacy scalar values", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Corrupt facts", mode: "standard" });
  store.db.prepare("UPDATE projects SET sharingan = 2 WHERE id = ?").run(project.id);
  assert.throws(
    () => store.workspace.readLegacyStandardWorkspaceFacts(project.id),
    /sharingan.*zero or one/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id), null);
  store.close();
});

test("legacy migration rejects a shape-compatible but noncanonical foundation", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Corrupt foundation", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  const row = store.db.prepare(
    "SELECT payload_json FROM shared_design_kernel_revisions WHERE id = ?",
  ).get(foundation.activeKernelRevisionId) as { payload_json: string };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  payload.brief = "not the Task 2 foundation";
  const payloadJson = JSON.stringify(payload);
  store.db.exec("DROP TRIGGER kernel_revision_update_immutable");
  store.db.prepare(
    "UPDATE shared_design_kernel_revisions SET payload_json = ?, checksum = ? WHERE id = ?",
  ).run(
    payloadJson,
    createHash("sha256").update(payloadJson).digest("hex"),
    foundation.activeKernelRevisionId,
  );
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  assert.throws(
    () => store.workspace.ensureLegacyStandardWorkspace({
      version: 1,
      ...facts,
      project: { ...facts.project, mode: "standard" },
      successfulRuns: [],
    }),
    /canonical empty Workspace foundation/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id)?.graphRevision, 0);
  assert.equal(store.workspace.listArtifacts(project.id).length, 0);
  assert.equal(store.workspace.listSnapshots(project.id).length, 1);
  store.close();
});

test("legacy migration rejects a foundation polluted by layout state and rolls back", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Layout pollution", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  store.db.prepare(
    `INSERT INTO workspace_layout_nodes (
       workspace_id, layout_id, object_id, object_kind, x, y,
       width, height, parent_group_id, label, collapsed, updated_at
     ) VALUES (?, 'legacy-layout', 'legacy-group', 'group', 10, 20, 30, 40, NULL, 'Legacy', 0, 50)`,
  ).run(foundation.id);
  store.db.prepare(
    `INSERT INTO workspace_layout_viewports (workspace_id, layout_id, x, y, zoom, updated_at)
     VALUES (?, 'legacy-layout', 1, 2, 0.5, 50)`,
  ).run(foundation.id);
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);

  assert.throws(
    () => store.workspace.ensureLegacyStandardWorkspace({
      version: 1,
      ...facts,
      project: { ...facts.project, mode: "standard" },
      successfulRuns: [],
    }),
    /canonical empty Workspace foundation/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id)?.graphRevision, 0);
  assert.equal(store.workspace.listArtifacts(project.id).length, 0);
  assert.equal(store.workspace.listSnapshots(project.id).length, 1);
  assert.equal((store.db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_layout_nodes WHERE workspace_id = ?",
  ).get(foundation.id) as { count: number }).count, 1);
  assert.equal((store.db.prepare(
    "SELECT COUNT(*) AS count FROM workspace_layout_viewports WHERE workspace_id = ?",
  ).get(foundation.id) as { count: number }).count, 1);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("legacy migration preserves exact legacy names while canonicalizing Workspace display names", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "  Legacy name  ", mode: "standard" });
  const variant = store.createVariant(project.id, "  Branch name  ");
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  assert.equal(facts.project.name, "  Legacy name  ");
  assert.equal(facts.variants[0]?.name, "  Branch name  ");
  const bundle = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: [],
  });
  assert.equal(bundle.artifacts[0]?.name, "Legacy name");
  assert.equal(bundle.tracks.find((track) => track.legacyVariantId === variant.id)?.name, "Branch name");
  assert.equal(store.getProject(project.id)?.name, "  Legacy name  ");
  assert.equal(store.getVariant(variant.id)?.name, "  Branch name  ");
  store.close();
});

test("legacy migration gives deterministic display names to blank legacy names", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "   ", mode: "standard" });
  const variant = store.createVariant(project.id, "\t  ");
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const bundle = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: [],
  });
  assert.equal(bundle.artifacts[0]?.name, "Legacy page");
  assert.equal(
    bundle.tracks.find((track) => track.legacyVariantId === variant.id)?.name,
    `Legacy variant ${variant.id}`,
  );
  assert.equal(store.getProject(project.id)?.name, "   ");
  assert.equal(store.getVariant(variant.id)?.name, "\t  ");
  store.close();
});

test("Prototype legacy seed is rejected without creating Workspace state", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Prototype", mode: "prototype" });
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  assert.throws(
    () => store.workspace.ensureLegacyStandardWorkspace({
      version: 1,
      ...facts,
      successfulRuns: [],
    } as never),
    /mode is unsupported/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id), null);
  assert.equal(store.workspace.listArtifacts(project.id).length, 0);
  store.close();
});

test("verified legacy Git snapshots reject noncanonical full object ids before writing", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Strict Git seed", mode: "standard" });
  const conversation = store.createConversation(project.id, "Strict Git");
  const variant = store.createVariant(project.id, "Main");
  store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: "a".repeat(12),
    createdAt: 10,
    finishedAt: 11,
  });
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  assert.throws(
    () => store.workspace.ensureLegacyStandardWorkspace({
      version: 1,
      ...facts,
      project: { ...facts.project, mode: "standard" },
      successfulRuns: facts.successfulRuns.map((run) => ({
        ...run,
        gitSnapshot: {
          status: "verified" as const,
          sourceCommitHash: `${"a".repeat(40)} `,
          sourceTreeHash: "b".repeat(40),
          artifactRoot: "." as const,
        },
      })),
    }),
    /verified Git snapshot is not canonical|source commit hash must be canonical/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id), null);
  assert.equal(store.workspace.listArtifacts(project.id).length, 0);
  store.close();
});

test("an unavailable successful Run with an unknown Variant fails closed", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Unknown Variant", mode: "standard" });
  const conversation = store.createConversation(project.id, "Unknown Variant");
  const variant = store.createVariant(project.id, "Main");
  const run = store.createImportedRun(project.id, conversation.id, {
    variantId: variant.id,
    status: "succeeded",
    commitHash: null,
    createdAt: 10,
    finishedAt: 11,
  });
  store.db.exec("PRAGMA foreign_keys = OFF");
  store.db.prepare("UPDATE runs SET variant_id = 'missing-variant' WHERE id = ?").run(run.id);
  store.db.exec("PRAGMA foreign_keys = ON");
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);

  assert.throws(
    () => store.workspace.ensureLegacyStandardWorkspace({
      version: 1,
      ...facts,
      project: { ...facts.project, mode: "standard" },
      successfulRuns: facts.successfulRuns.map((candidate) => ({
        ...candidate,
        gitSnapshot: { status: "unavailable" as const },
      })),
    }),
    /references an unknown Variant/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id), null);
  assert.equal(store.workspace.listArtifacts(project.id).length, 0);
  store.close();
});

test("legacy seed drift rolls back all Workspace writes", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Drift", mode: "standard" });
  const variant = store.createVariant(project.id, "Before");
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  store.renameVariant(variant.id, "After");
  assert.throws(
    () => store.workspace.ensureLegacyStandardWorkspace({
      version: 1,
      ...facts,
      project: { ...facts.project, mode: "standard" },
      successfulRuns: [],
    }),
    LegacyWorkspaceSeedDriftError,
  );
  assert.equal(store.workspace.getWorkspace(project.id), null);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) AS count FROM workspace_artifacts").get() as { count: number }).count,
    0,
  );
  store.close();
});

test("a partial raw legacy marker is not treated as a completed migration", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Partial marker", mode: "standard" });
  const foundation = store.workspace.ensureWorkspaceRecord(project.id);
  store.db.prepare(
    `INSERT INTO workspace_artifacts (
       id, workspace_id, kind, name, source_root, legacy_wrapped,
       active_track_id, archived_at, created_at, updated_at
     ) VALUES ('partial-wrapper', ?, 'page', 'Partial', '.', 1, NULL, NULL, 10, 10)`,
  ).run(foundation.id);
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);

  assert.throws(
    () => store.workspace.ensureLegacyStandardWorkspace({
      version: 1,
      ...facts,
      project: { ...facts.project, mode: "standard" },
      successfulRuns: [],
    }),
    /completed legacy Workspace migration is invalid/i,
  );
  assert.equal(store.workspace.getWorkspace(project.id)?.graphRevision, 0);
  assert.equal(store.workspace.listArtifacts(project.id).length, 1);
  assert.equal(store.workspace.listTracks(project.id, "partial-wrapper").length, 0);
  assert.equal(store.workspace.listSnapshots(project.id).length, 1);
  store.close();
});

test("legacy wrapper marker and dot root reject raw mutation and REPLACE", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Marker boundary", mode: "standard" });
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const bundle = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: [],
  });
  const artifact = bundle.artifacts[0]!;
  assert.throws(
    () => store.db.prepare(
      `INSERT INTO workspace_artifacts (
         id, workspace_id, kind, name, source_root, legacy_wrapped,
         active_track_id, archived_at, created_at, updated_at
       ) VALUES ('replacement-wrapper', ?, 'page', 'Replacement', '.', 1, NULL, NULL, 1, 1)`,
    ).run(bundle.workspace.id),
    /legacy-wrapped|unique/i,
  );
  assert.throws(
    () => store.db.prepare(
      `INSERT OR REPLACE INTO workspace_artifacts (
         id, workspace_id, kind, name, source_root, legacy_wrapped,
         active_track_id, archived_at, created_at, updated_at
       ) VALUES ('replacement-wrapper', ?, 'page', 'Replacement', '.', 1, NULL, NULL, 1, 1)`,
    ).run(bundle.workspace.id),
    /legacy-wrapped|history|immutable/i,
  );
  assert.throws(
    () => store.db.prepare(
      "UPDATE workspace_artifacts SET legacy_wrapped = 0, source_root = 'other' WHERE id = ?",
    ).run(artifact.id),
    /identity|immutable/i,
  );
  assert.throws(
    () => store.db.prepare(
      `INSERT INTO workspace_artifacts (
         id, workspace_id, kind, name, source_root, legacy_wrapped,
         active_track_id, archived_at, created_at, updated_at
       ) VALUES ('normal-dot', ?, 'page', 'Invalid', '.', 0, NULL, NULL, 1, 1)`,
    ).run(bundle.workspace.id),
    /legacy-wrapped/i,
  );
  assert.equal(store.workspace.getArtifact(artifact.id)?.legacyWrapped, true);
  assert.equal(store.workspace.listArtifacts(project.id).length, 1);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.close();
});

test("a wrapped Page remains usable by graph commands and Artifact publication", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Editable wrapper", mode: "standard" });
  const facts = store.workspace.readLegacyStandardWorkspaceFacts(project.id);
  const migrated = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: [],
  });
  const artifact = migrated.artifacts[0]!;
  const track = migrated.tracks[0]!;
  const renamed = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: migrated.graph.revision,
    expectedSnapshotId: migrated.activeSnapshot.id,
    commands: [{
      id: "rename-wrapped-page",
      type: "rename-node",
      nodeId: migrated.graph.nodes[0]!.id,
      name: "Renamed wrapper",
    }],
  });
  const revision = store.workspace.createArtifactRevision({
    artifactId: artifact.id,
    trackId: track.id,
    parentRevisionId: null,
    sourceCommitHash: "a".repeat(40),
    sourceTreeHash: "b".repeat(40),
    kernelRevisionId: migrated.workspace.activeKernelRevisionId,
    renderSpec: { frames: [] },
    quality: { state: "unassessed", score: null, findings: [] },
    dependencies: [],
    resourcePins: [],
  });
  assert.equal(revision.artifactRoot, ".");
  const published = store.workspace.publishArtifactRevision(revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: renamed.snapshot.id,
  });
  assert.equal(published.artifactRevisions[artifact.id], revision.id);
  assert.equal(store.workspace.getTrack(track.id)?.headRevisionId, revision.id);
  assert.equal(store.workspace.getArtifact(artifact.id)?.name, "Renamed wrapper");
  const idempotent = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: [],
  });
  assert.equal(idempotent.workspace.graphRevision, 2);
  assert.equal(idempotent.activeSnapshot.id, published.id);
  assert.equal(idempotent.revisions.some((candidate) => candidate.id === revision.id), true);
  const archived = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: idempotent.graph.revision,
    expectedSnapshotId: idempotent.activeSnapshot.id,
    commands: [{
      id: "archive-wrapped-page",
      type: "archive-node",
      nodeId: migrated.graph.nodes[0]!.id,
    }],
  });
  const afterArchive = store.workspace.ensureLegacyStandardWorkspace({
    version: 1,
    ...facts,
    project: { ...facts.project, mode: "standard" },
    successfulRuns: [],
  });
  assert.equal(afterArchive.workspace.graphRevision, 3);
  assert.equal(afterArchive.activeSnapshot.id, archived.snapshot.id);
  assert.equal(afterArchive.graph.nodes.length, 0);
  assert.equal(afterArchive.artifacts[0]?.archivedAt !== null, true);
  store.close();
});

test("Workspace Proposal drafts isolate canonical state and retain immutable CAS audit revisions", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal audit", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const baseGraph = store.workspace.getGraph(project.id);
  const baseLayout = store.workspace.getLayout(project.id);
  const created = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    project.id,
    [proposalPageCommand("audit")],
  ));

  assert.equal(created.revision, 1);
  assert.equal(created.status, "draft");
  assert.deepEqual(created.baseGraph, baseGraph);
  assert.deepEqual(created.baseLayout, baseLayout);
  assert.deepEqual(store.workspace.getGraph(project.id), baseGraph);
  assert.deepEqual(store.workspace.getLayout(project.id), baseLayout);
  assert.deepEqual(store.workspace.getProposalRevision(created.id, 1), created);

  const updated = store.workspace.updateProposal(created.id, {
    expectedProposalRevision: 1,
    operations: created.operations,
    layoutOperations: [{ type: "move", objectId: "proposal-node-audit", x: 40, y: 60 }],
    generation: created.generation,
    rationale: "Place the proposed page deliberately",
    assumptions: ["The page starts without generated source"],
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.baseGraph, baseGraph);
  assert.deepEqual(updated.baseLayout, baseLayout);
  assert.equal(store.workspace.getProposalRevision(created.id, 1)?.rationale, created.rationale);
  assert.equal(store.workspace.getProposalRevision(created.id, 2)?.rationale, updated.rationale);
  assert.throws(() => store.workspace.updateProposal(created.id, {
    expectedProposalRevision: 1,
    operations: updated.operations,
    layoutOperations: updated.layoutOperations,
    generation: updated.generation,
    rationale: "Lost update",
    assumptions: [],
  }), WorkspaceProposalRevisionConflictError);
  assert.equal(rowCount(store.db, "workspace_proposal_audit"), 2);
  assert.throws(
    () => store.db.prepare("UPDATE workspace_proposal_audit SET payload_json = '{}' WHERE proposal_id = ? AND revision = 1")
      .run(created.id),
    /immutable|audit/i,
  );
  assert.throws(
    () => store.db.prepare("DELETE FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = 1").run(created.id),
    /immutable|audit|history/i,
  );

  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: baseGraph.revision,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [proposalPageCommand("canonical")],
  });
  assert.deepEqual(store.workspace.getProposal(created.id)?.baseGraph, baseGraph);
  store.close();
});

test("Proposal approval fails closed when the mutable row diverges from its exact audited revision", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal audit guard", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    project.id,
    [proposalPageCommand("audit-guard")],
  ));
  store.db.prepare(
    "UPDATE workspace_proposals SET operations_json = '[]' WHERE id = ?",
  ).run(proposal.id);

  assert.throws(
    () => store.workspace.approveProposal(proposal.id, "structure-only"),
    /immutable audit revision|audited revision/i,
  );
  assert.equal(store.workspace.getGraph(project.id).revision, 0);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, workspace.activeSnapshotId);
  assert.equal(rowCount(store.db, "generation_plans"), 0);
  store.close();
});

test("Proposal creating Runs are Project-owned at API and SQLite boundaries", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal Run owner", mode: "standard" });
  const foreignProject = store.createProject({ name: "Proposal foreign Run", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  store.workspace.ensureWorkspaceRecord(foreignProject.id);
  const foreignConversation = store.createConversation(foreignProject.id, "Foreign Proposal Run");
  const foreignRun = store.createRun(foreignProject.id, foreignConversation.id);
  const input = workspaceGenerationProposalInput(store, project.id, []);

  assert.throws(
    () => store.workspace.createProposal({ ...input, createdByRunId: foreignRun.id }),
    /another Project/i,
  );
  const proposal = store.workspace.createProposal(input);
  assert.throws(() => store.db.prepare(
    `INSERT INTO workspace_proposals (
       id, workspace_id, base_graph_revision, base_snapshot_id, revision, kind, status,
       operations_json, layout_id, base_layout_checksum, base_layout_json,
       layout_operations_json, rationale, assumptions_json, generation_payload_json,
       review_json, created_by_run_id, created_at, updated_at
     )
     SELECT 'raw-foreign-run-proposal', workspace_id, base_graph_revision, base_snapshot_id,
            revision, kind, status, operations_json, layout_id, base_layout_checksum,
            base_layout_json, layout_operations_json, rationale, assumptions_json,
            generation_payload_json, review_json, ?, created_at, updated_at
     FROM workspace_proposals WHERE id = ?`,
  ).run(foreignRun.id, proposal.id), /another Project/i);
  assert.equal(rowCount(store.db, "workspace_proposals"), 1);
  store.close();
});

test("stale Proposal approval commits conflicted review state before throwing and writes no graph Snapshot or Plan", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal conflict", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    project.id,
    [proposalPageCommand("stale")],
  ));
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [proposalPageCommand("user")],
  });
  const before = {
    graphRevisions: rowCount(store.db, "workspace_graph_revisions"),
    snapshots: rowCount(store.db, "workspace_snapshots"),
    plans: rowCount(store.db, "generation_plans"),
  };

  const conflicts: WorkspaceProposalConflictError[] = [];
  assert.throws(() => store.workspace.approveProposal(proposal.id, "structure-only"), (error) => {
    assert.ok(error instanceof WorkspaceRevisionConflictError);
    assert.ok(error instanceof WorkspaceProposalConflictError);
    conflicts.push(error);
    return true;
  });
  const conflict = conflicts[0];
  assert.ok(conflict);
  assert.equal(conflict.proposalId, proposal.id);
  assert.equal(conflict.actualRevision, 1);
  assert.equal(conflict.summary.graphChanged, true);
  assert.equal(conflict.summary.snapshotChanged, true);
  const conflicted = store.workspace.getProposal(proposal.id)!;
  assert.equal(conflicted.status, "conflicted");
  assert.equal(conflicted.review.kind, "conflict");
  assert.equal(conflicted.review.actualGraphRevision, 1);
  assert.deepEqual({
    graphRevisions: rowCount(store.db, "workspace_graph_revisions"),
    snapshots: rowCount(store.db, "workspace_snapshots"),
    plans: rowCount(store.db, "generation_plans"),
  }, before);
  store.close();
});

test("stale approval records conflict before validating layout against a concurrently changed graph", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal stale layout", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const added = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [proposalPageCommand("stale-layout-base")],
  });
  const baseLayout = store.workspace.getLayout(project.id);
  store.workspace.saveLayout(project.id, {
    graphRevision: added.graph.revision,
    baseLayoutChecksum: baseLayout.checksum,
    commands: [{ type: "move", objectId: "proposal-node-stale-layout-base", x: 20, y: 30 }],
  });
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    project.id,
    [proposalPageCommand("stale-layout-proposed")],
  ));
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: added.graph.revision,
    expectedSnapshotId: added.snapshot.id,
    commands: [{
      id: "archive-stale-layout-base",
      type: "archive-node",
      nodeId: "proposal-node-stale-layout-base",
    }],
  });

  assert.throws(
    () => store.workspace.approveProposal(proposal.id, "structure-only"),
    WorkspaceProposalConflictError,
  );
  assert.equal(store.workspace.getProposal(proposal.id)?.status, "conflicted");
  store.close();
});

test("structure-only Proposal approval applies graph and layout in one transaction with one Snapshot", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Structure approval", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    project.id,
    [proposalPageCommand("approved")],
    {
      layoutOperations: [
        { type: "add-group", groupId: "approved-group", label: "Approved", bounds: { x: 0, y: 0, width: 500, height: 300 } },
        { type: "set-parent", objectId: "proposal-node-approved", parentGroupId: "approved-group" },
      ],
    },
  ));
  const snapshotsBefore = rowCount(store.db, "workspace_snapshots");
  const result = store.workspace.approveProposal(proposal.id, "structure-only");

  assert.equal(result.proposal.status, "approved");
  assert.equal(result.graph.revision, 1);
  assert.equal(result.snapshot.graphRevision, 1);
  assert.equal(result.snapshot.provenance.kind, "proposal-approval");
  assert.equal(result.plan, null);
  assert.equal(rowCount(store.db, "workspace_snapshots"), snapshotsBefore + 1);
  assert.equal(rowCount(store.db, "generation_plans"), 0);
  assert.equal(store.workspace.getLayout(project.id).objects.find(({ id }) => id === "proposal-node-approved")?.parentGroupId, "approved-group");
  store.close();
});

test("generate approval creates an immutable non-executable Plan shell pinned to the approved revision and resulting Snapshot", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Generate approval", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    project.id,
    [proposalPageCommand("generated")],
  ));
  const snapshotsBefore = rowCount(store.db, "workspace_snapshots");
  const result = store.workspace.approveProposal(proposal.id, "generate");

  assert.ok(result.plan);
  assert.equal(result.plan.status, "approved");
  assert.equal(result.plan.proposalId, proposal.id);
  assert.equal(result.plan.proposalRevision, proposal.revision);
  assert.equal(result.plan.baseSnapshotId, result.snapshot.id);
  assert.equal(rowCount(store.db, "workspace_snapshots"), snapshotsBefore + 1);
  assert.deepEqual(store.workspace.getGenerationPlan(result.plan.id), result.plan);
  assert.deepEqual(store.workspace.getProposalRevision(proposal.id, proposal.revision), proposal);
  assert.throws(
    () => store.db.prepare("UPDATE generation_plans SET proposal_revision = proposal_revision + 1 WHERE id = ?")
      .run(result.plan!.id),
    /immutable|identity/i,
  );
  assert.throws(
    () => store.db.prepare("DELETE FROM generation_plans WHERE id = ?").run(result.plan!.id),
    /immutable|history/i,
  );
  store.close();
});

test("layout-only generate approval reuses the guarded graph Snapshot without inventing semantic history", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Layout-only approval", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const baseLayout = store.workspace.getLayout(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [], {
    layoutOperations: [{
      type: "add-group",
      groupId: "layout-only-group",
      label: "Layout only",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    }],
  }));
  const counts = {
    graphRevisions: rowCount(store.db, "workspace_graph_revisions"),
    snapshots: rowCount(store.db, "workspace_snapshots"),
  };
  const result = store.workspace.approveProposal(proposal.id, "generate");

  assert.equal(result.graph.revision, 0);
  assert.equal(result.snapshot.id, workspace.activeSnapshotId);
  assert.equal(result.plan?.baseSnapshotId, workspace.activeSnapshotId);
  assert.notEqual(store.workspace.getLayout(project.id).checksum, baseLayout.checksum);
  assert.deepEqual({
    graphRevisions: rowCount(store.db, "workspace_graph_revisions"),
    snapshots: rowCount(store.db, "workspace_snapshots"),
  }, counts);
  store.close();
});

test("layout CAS rejects a stale checksum and Proposal validation rejects unsupported or inconsistent generation intent", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal validation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const baseLayout = store.workspace.getLayout(project.id);
  const first = store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 0,
    baseLayoutChecksum: baseLayout.checksum,
    commands: [{
      type: "add-group",
      groupId: "fresh-group",
      label: "Fresh",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    }],
  });
  assert.throws(() => store.workspace.saveLayout(project.id, {
    layoutId: "default",
    graphRevision: 0,
    baseLayoutChecksum: baseLayout.checksum,
    commands: [{ type: "rename-group", groupId: "fresh-group", label: "Stale" }],
  }), WorkspaceLayoutConflictError);
  assert.equal(store.workspace.getLayout(project.id).checksum, first.checksum);

  const duplicateNames = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [
    proposalPageCommand("duplicate-a", "Same name"),
    proposalPageCommand("duplicate-b", "Same name"),
  ]));
  assert.throws(
    () => store.workspace.approveProposal(duplicateNames.id, "structure-only"),
    WorkspaceProposalValidationError,
  );

  const missingDependency = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [], {
    generation: {
      ...emptyWorkspaceGenerationPayload(),
      dependencyPlans: [{
        kind: "resource",
        ownerArtifactId: "missing-owner",
        resourceId: "missing-resource",
      }],
    },
  }));
  assert.throws(
    () => store.workspace.approveProposal(missingDependency.id, "generate"),
    /missing generation dependency/i,
  );
  assert.throws(() => store.workspace.createProposal({
    ...workspaceGenerationProposalInput(store, project.id, []),
    kind: "component-propagation",
    generation: {
      kind: "component-propagation",
      impactAnalysisId: "impact-1",
      componentArtifactId: "component-1",
      fromRevisionId: "component-v1",
      toRevisionId: "component-v2",
      selectedInstanceIds: [],
      overrideResolutions: [],
      requiredQaFrameIds: [],
    },
  } as never), /Task 13|component-propagation/i);
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, workspace.activeSnapshotId);
  store.close();
});

test("Proposal approval rejects an exact Resource revision policy whose owned revision is missing", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal exact Resource revision", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const graph = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [{
      id: "add-proposal-resource",
      type: "add-node",
      node: {
        id: "proposal-resource-node",
        kind: "resource",
        name: "Proposal research",
        resourceId: "proposal-resource",
        createIdentity: { resourceKind: "research", defaultPinPolicy: "pin-current" },
      },
    }],
  });
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [], {
    generation: {
      ...emptyWorkspaceGenerationPayload(),
      resourceOperations: [{
        operation: "reuse",
        nodeId: "proposal-resource-node",
        resourceId: "proposal-resource",
        kind: "research",
        title: "Proposal research",
        revisionPolicy: { kind: "exact", resourceRevisionId: "missing-resource-revision" },
      }],
    },
  }));

  assert.throws(
    () => store.workspace.approveProposal(proposal.id, "generate"),
    /missing generation dependency Resource Revision/i,
  );
  assert.equal(store.workspace.getProposal(proposal.id)?.status, "draft");
  assert.equal(store.workspace.getWorkspace(project.id)?.activeSnapshotId, graph.snapshot.id);
  assert.equal(rowCount(store.db, "generation_plans"), 0);
  store.close();
});

test("Proposal, audit, and Plan identities reject INSERT OR REPLACE with recursive triggers disabled", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal replace guards", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const auditProposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  const planProposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  const plan = store.workspace.approveProposal(planProposal.id, "generate").plan!;
  const replacedProposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  const proposalBefore = store.db.prepare("SELECT * FROM workspace_proposals WHERE id = ?").get(replacedProposal.id);
  const auditBefore = store.db.prepare(
    "SELECT * FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = 1",
  ).get(auditProposal.id);
  const planBefore = store.db.prepare("SELECT * FROM generation_plans WHERE id = ?").get(plan.id);
  store.db.exec("PRAGMA recursive_triggers = OFF");
  const rejected = (action: () => void) => {
    try {
      action();
      return false;
    } catch {
      return true;
    }
  };

  const results = [
    rejected(() => store.db.prepare(
      `INSERT OR REPLACE INTO workspace_proposal_audit
       SELECT * FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = 1`,
    ).run(auditProposal.id)),
    rejected(() => store.db.prepare(
      "INSERT OR REPLACE INTO generation_plans SELECT * FROM generation_plans WHERE id = ?",
    ).run(plan.id)),
    rejected(() => store.db.prepare(
      "INSERT OR REPLACE INTO workspace_proposals SELECT * FROM workspace_proposals WHERE id = ?",
    ).run(replacedProposal.id)),
  ];

  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual(store.db.prepare("SELECT * FROM workspace_proposals WHERE id = ?").get(replacedProposal.id), proposalBefore);
  assert.deepEqual(store.db.prepare(
    "SELECT * FROM workspace_proposal_audit WHERE proposal_id = ? AND revision = 1",
  ).get(auditProposal.id), auditBefore);
  assert.deepEqual(store.db.prepare("SELECT * FROM generation_plans WHERE id = ?").get(plan.id), planBefore);
  assert.equal(rowCount(store.db, "workspace_proposal_audit"), 3);
  assert.equal(rowCount(store.db, "generation_plans"), 1);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(
      (store.db.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>).map(
        (row) => row.quick_check,
      ),
      ["ok"],
    );
  store.deleteProject(project.id);
  assert.equal(rowCount(store.db, "workspace_proposals"), 0);
  assert.equal(rowCount(store.db, "workspace_proposal_audit"), 0);
  assert.equal(rowCount(store.db, "generation_plans"), 0);
  store.close();
});

test("SQLite rejects unsealed or graph-incoherent Proposal base Snapshots", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal Snapshot anchors", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  const changed = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [proposalPageCommand("snapshot-anchor")],
  });
  store.db.prepare(
    `INSERT INTO workspace_snapshots (
       id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
       reason, provenance_json, created_by_run_id, created_at, sealed
     ) VALUES ('unsealed-proposal-base', ?, 3, ?, 0, ?, 'fixture',
               '{"kind":"legacy-migration","migration":"proposal-anchor"}', NULL, 999, 0)`,
  ).run(workspace.id, workspace.activeSnapshotId, workspace.activeKernelRevisionId);
  const rejected = (candidate: WorkspaceProposal) => {
    try {
      insertRawWorkspaceProposal(store.db, candidate);
      return false;
    } catch {
      return true;
    }
  };

  assert.deepEqual([
    rejected({ ...proposal, id: "graph-incoherent-proposal", baseSnapshotId: changed.snapshot.id }),
    rejected({ ...proposal, id: "unsealed-base-proposal", baseSnapshotId: "unsealed-proposal-base" }),
  ], [true, true]);
  store.close();
});

test("Proposal readback rejects an imported base Snapshot whose graph does not match the base graph", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Imported Proposal anchor", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  const changed = store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [proposalPageCommand("imported-anchor")],
  });
  store.db.exec("DROP TRIGGER IF EXISTS workspace_proposal_base_snapshot_insert_guard");
  const imported = { ...proposal, id: "imported-incoherent-proposal", baseSnapshotId: changed.snapshot.id };
  insertRawWorkspaceProposal(store.db, imported);
  insertRawWorkspaceProposalAudit(store.db, imported);

  assert.throws(() => store.workspace.getProposal(imported.id), /base Snapshot.*graph|Snapshot.*base graph|incoherent/i);
  assert.throws(
    () => store.workspace.getProposalRevision(imported.id, imported.revision),
    /base Snapshot.*graph|Snapshot.*base graph|incoherent/i,
  );
  store.close();
});

test("Proposal readers require current-row coherence with the exact current audit revision", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal read coherence", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  store.db.prepare("UPDATE workspace_proposals SET rationale = 'forged current payload' WHERE id = ?")
    .run(proposal.id);
  const rejects = (read: () => unknown) => {
    try {
      read();
      return false;
    } catch {
      return true;
    }
  };

  assert.deepEqual([
    rejects(() => store.workspace.getProposal(proposal.id)),
    rejects(() => store.workspace.listProposals(project.id)),
  ], [true, true]);
  store.close();
});

test("Proposal readback rejects a current-row rollback to an older coherent audit revision", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal audit rollback", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const revisionOne = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  store.workspace.updateProposal(revisionOne.id, {
    expectedProposalRevision: 1,
    operations: revisionOne.operations,
    layoutOperations: revisionOne.layoutOperations,
    generation: revisionOne.generation,
    rationale: "Revision two",
    assumptions: ["newer"],
  });
  store.db.prepare(
    `UPDATE workspace_proposals
     SET revision = ?, operations_json = ?, layout_operations_json = ?, rationale = ?,
         assumptions_json = ?, generation_payload_json = ?, review_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    revisionOne.revision,
    JSON.stringify(revisionOne.operations),
    JSON.stringify(revisionOne.layoutOperations),
    revisionOne.rationale,
    JSON.stringify(revisionOne.assumptions),
    JSON.stringify(revisionOne.generation),
    JSON.stringify(revisionOne.review),
    revisionOne.updatedAt,
    revisionOne.id,
  );

  assert.throws(() => store.workspace.getProposal(revisionOne.id), /latest audit revision|audit history/i);
  store.close();
});

test("Proposal audit decoding cross-checks relational metadata and rejects empty review objects", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Proposal audit metadata", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  const row = {
    proposal_id: proposal.id,
    revision: proposal.revision,
    payload_json: JSON.stringify(proposal),
    created_at: proposal.updatedAt,
  };
  const rejects = (candidate: Record<string, unknown>) => {
    try {
      asWorkspaceProposalAudit(candidate);
      return false;
    } catch {
      return true;
    }
  };
  store.db.prepare("UPDATE workspace_proposals SET review_json = '{}' WHERE id = ?").run(proposal.id);

  assert.deepEqual([
    rejects({ ...row, proposal_id: "different-proposal" }),
    rejects({ ...row, revision: proposal.revision + 1 }),
    rejects({ ...row, created_at: proposal.updatedAt + 1 }),
  ], [true, true, true]);
  assert.throws(() => store.workspace.getProposal(proposal.id), /review.*kind|review/i);
  store.close();
});

test("graph-only Proposal approval conflicts when its audited base layout drifts", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Graph-only layout conflict", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    project.id,
    [proposalPageCommand("graph-only-layout")],
  ));
  const layout = store.workspace.getLayout(project.id);
  store.workspace.saveLayout(project.id, {
    graphRevision: workspace.graphRevision,
    baseLayoutChecksum: layout.checksum,
    commands: [{
      type: "add-group",
      groupId: "concurrent-layout-group",
      label: "Concurrent",
      bounds: { x: 0, y: 0, width: 200, height: 120 },
    }],
  });
  const conflicts: WorkspaceProposalConflictError[] = [];

  assert.throws(() => store.workspace.approveProposal(proposal.id, "structure-only"), (error) => {
    if (error instanceof WorkspaceProposalConflictError) conflicts.push(error);
    return error instanceof WorkspaceProposalConflictError;
  });
  assert.equal(conflicts[0]?.summary.layoutChanged, true);
  assert.equal(store.workspace.getProposal(proposal.id)?.status, "conflicted");
  assert.equal(store.workspace.getGraph(project.id).revision, 0);
  store.close();
});

test("raw component-propagation approval rejects before stale conflict mutation", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Imported propagation", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const seed = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, []));
  const imported: WorkspaceProposal = {
    ...seed,
    id: "imported-component-propagation",
    kind: "component-propagation",
    generation: {
      kind: "component-propagation",
      impactAnalysisId: "impact-imported",
      componentArtifactId: "component-imported",
      fromRevisionId: "component-imported-v1",
      toRevisionId: "component-imported-v2",
      selectedInstanceIds: [],
      overrideResolutions: [],
      requiredQaFrameIds: [],
    },
  };
  insertRawWorkspaceProposal(store.db, imported);
  insertRawWorkspaceProposalAudit(store.db, imported);
  store.workspace.applyGraphCommands(project.id, {
    baseGraphRevision: 0,
    expectedSnapshotId: workspace.activeSnapshotId,
    commands: [proposalPageCommand("propagation-stale")],
  });

  assert.throws(
    () => store.workspace.approveProposal(imported.id, "generate"),
    WorkspaceProposalValidationError,
  );
  const reloaded = store.workspace.getProposal(imported.id)!;
  assert.equal(reloaded.status, "draft");
  assert.deepEqual(reloaded.review, { kind: "none" });
  assert.equal(rowCount(store.db, "generation_plans"), 0);
  store.close();
});

test("Artifact create plans match proposed names, Track identities, and null base Revisions", () => {
  const rejectsCreate = (overrides: Record<string, unknown>) => {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Artifact create plan", mode: "standard" });
    store.workspace.ensureWorkspaceRecord(project.id);
    const command = proposalPageCommand("artifact-create");
    const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [command], {
      generation: {
        ...emptyWorkspaceGenerationPayload(),
        artifactPlans: [{
          operation: "create",
          nodeId: "proposal-node-artifact-create",
          artifactId: "proposal-artifact-artifact-create",
          kind: "page",
          name: "Page artifact-create",
          trackId: "proposal-track-artifact-create",
          baseRevisionId: null,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: [],
          ...overrides,
        }],
      },
    }));
    try {
      store.workspace.approveProposal(proposal.id, "generate");
      return false;
    } catch (error) {
      return error instanceof WorkspaceProposalValidationError;
    } finally {
      store.close();
    }
  };

  assert.deepEqual([
    rejectsCreate({ name: "Wrong final name" }),
    rejectsCreate({ trackId: "wrong-planned-track" }),
    rejectsCreate({ baseRevisionId: "unexpected-base-revision" }),
  ], [true, true, true]);
});

test("Artifact plans distinguish new planned identities from existing Revision bases", () => {
  const rejectsExistingPlan = (overrides: Record<string, unknown>) => {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Artifact revise plan", mode: "standard" });
    const workspace = store.workspace.ensureWorkspaceRecord(project.id);
    const added = store.workspace.applyGraphCommands(project.id, {
      baseGraphRevision: 0,
      expectedSnapshotId: workspace.activeSnapshotId,
      commands: [proposalPageCommand("artifact-revise")],
    });
    const revision = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
      artifactId: "proposal-artifact-artifact-revise",
      trackId: "proposal-track-artifact-revise",
      parentRevisionId: null,
      kernelRevisionId: workspace.activeKernelRevisionId,
      tree: "proposal-artifact-revise-v1",
    }));
    store.workspace.publishArtifactRevision(revision.id, {
      expectedHeadRevisionId: null,
      expectedSnapshotId: added.snapshot.id,
    });
    const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [], {
      generation: {
        ...emptyWorkspaceGenerationPayload(),
        artifactPlans: [{
          operation: "revise",
          nodeId: "proposal-node-artifact-revise",
          artifactId: "proposal-artifact-artifact-revise",
          kind: "page",
          name: "Page artifact-revise",
          trackId: "proposal-track-artifact-revise",
          baseRevisionId: revision.id,
          dependsOnArtifactIds: [],
          capabilityIds: [],
          responsiveFrameIds: [],
          ...overrides,
        }],
      },
    }));
    try {
      store.workspace.approveProposal(proposal.id, "generate");
      return false;
    } catch (error) {
      return error instanceof WorkspaceProposalValidationError;
    } finally {
      store.close();
    }
  };
  const rejectsPlannedRevise = () => {
    const store = new Store(":memory:", fakeClock());
    const project = store.createProject({ name: "Planned Artifact revise", mode: "standard" });
    store.workspace.ensureWorkspaceRecord(project.id);
    const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
      store,
      project.id,
      [proposalPageCommand("planned-revise")],
      {
        generation: {
          ...emptyWorkspaceGenerationPayload(),
          artifactPlans: [{
            operation: "revise",
            nodeId: "proposal-node-planned-revise",
            artifactId: "proposal-artifact-planned-revise",
            kind: "page",
            name: "Page planned-revise",
            trackId: "proposal-track-planned-revise",
            baseRevisionId: null,
            dependsOnArtifactIds: [],
            capabilityIds: [],
            responsiveFrameIds: [],
          }],
        },
      },
    ));
    try {
      store.workspace.approveProposal(proposal.id, "generate");
      return false;
    } catch (error) {
      return error instanceof WorkspaceProposalValidationError;
    } finally {
      store.close();
    }
  };

  assert.deepEqual([
    rejectsExistingPlan({ operation: "create", baseRevisionId: null }),
    rejectsExistingPlan({ baseRevisionId: null }),
    rejectsExistingPlan({ trackId: "missing-track" }),
    rejectsExistingPlan({ baseRevisionId: "missing-base-revision" }),
    rejectsPlannedRevise(),
  ], [true, true, true, true, true]);
});

test("valid Artifact create and revise plans preserve planned identities and exact Revision bases", () => {
  const store = new Store(":memory:", fakeClock());
  const project = store.createProject({ name: "Valid Artifact plans", mode: "standard" });
  const workspace = store.workspace.ensureWorkspaceRecord(project.id);
  const command = proposalPageCommand("valid-artifact-plan");
  const createProposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [command], {
    generation: {
      ...emptyWorkspaceGenerationPayload(),
      artifactPlans: [{
        operation: "create",
        nodeId: "proposal-node-valid-artifact-plan",
        artifactId: "proposal-artifact-valid-artifact-plan",
        kind: "page",
        name: "Page valid-artifact-plan",
        trackId: "proposal-track-valid-artifact-plan",
        baseRevisionId: null,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: [],
      }],
    },
  }));
  const created = store.workspace.approveProposal(createProposal.id, "generate");
  assert.equal(store.workspace.getArtifact("proposal-artifact-valid-artifact-plan")?.kind, "page");
  assert.equal(store.workspace.getTrack("proposal-track-valid-artifact-plan")?.artifactId, "proposal-artifact-valid-artifact-plan");

  const revision = store.workspace.createArtifactRevision(standardArtifactRevisionInput({
    artifactId: "proposal-artifact-valid-artifact-plan",
    trackId: "proposal-track-valid-artifact-plan",
    parentRevisionId: null,
    kernelRevisionId: workspace.activeKernelRevisionId,
    tree: "valid-artifact-plan-v1",
  }));
  store.workspace.publishArtifactRevision(revision.id, {
    expectedHeadRevisionId: null,
    expectedSnapshotId: created.snapshot.id,
  });
  const reviseProposal = store.workspace.createProposal(workspaceGenerationProposalInput(store, project.id, [], {
    generation: {
      ...emptyWorkspaceGenerationPayload(),
      artifactPlans: [{
        operation: "revise",
        nodeId: "proposal-node-valid-artifact-plan",
        artifactId: "proposal-artifact-valid-artifact-plan",
        kind: "page",
        name: "Page valid-artifact-plan",
        trackId: "proposal-track-valid-artifact-plan",
        baseRevisionId: revision.id,
        dependsOnArtifactIds: [],
        capabilityIds: [],
        responsiveFrameIds: [],
      }],
    },
  }));
  const revised = store.workspace.approveProposal(reviseProposal.id, "generate");
  assert.equal(revised.graph.revision, created.graph.revision);
  assert.equal(revised.plan?.baseSnapshotId, reviseProposal.baseSnapshotId);
  store.close();
});

test("project-scoped Proposal mutations enforce ownership and terminal state", () => {
  const store = new Store(":memory:", fakeClock());
  const firstProject = store.createProject({ name: "Proposal owner", mode: "standard" });
  const secondProject = store.createProject({ name: "Proposal foreign", mode: "standard" });
  store.workspace.ensureWorkspaceRecord(firstProject.id);
  store.workspace.ensureWorkspaceRecord(secondProject.id);
  const proposal = store.workspace.createProposal(workspaceGenerationProposalInput(
    store,
    firstProject.id,
    [proposalPageCommand("owned")],
  ));
  assert.throws(
    () => store.workspace.updateProposalForProject(secondProject.id, proposal.id, {
      expectedProposalRevision: proposal.revision,
      operations: proposal.operations,
      layoutOperations: proposal.layoutOperations,
      generation: proposal.generation,
      rationale: proposal.rationale,
      assumptions: proposal.assumptions,
    }),
    WorkspaceProposalOwnershipError,
  );
  const rejected = store.workspace.rejectProposalForProject(firstProject.id, proposal.id);
  assert.equal(rejected.status, "rejected");
  assert.throws(
    () => store.workspace.approveProposalForProject(firstProject.id, proposal.id, "generate"),
    WorkspaceProposalStateConflictError,
  );
  assert.equal(rowCount(store.db, "generation_plans"), 0);
  store.close();
});
