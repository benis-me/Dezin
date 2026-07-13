import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { StoreClock } from "./store.ts";
import type { ProjectWorkspace, WorkspaceGraph } from "./workspace-types.ts";
import { validateWorkspaceGraph } from "./workspace-graph.ts";
import {
  asArtifactRevision,
  asArtifactTrack,
  asProjectWorkspace,
  asWorkspaceArtifact,
  asWorkspaceEdge,
  asWorkspaceGraphRevision,
  asWorkspaceNode,
  asWorkspaceSnapshotBase,
  type ArtifactRevisionRecord,
  type ArtifactTrackRecord,
  type WorkspaceArtifactRecord,
  type WorkspaceSnapshotRecord,
} from "./workspace-codecs.ts";
import type { Row } from "./store-codecs.ts";

const DEFAULT_KERNEL_PAYLOAD = {
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
} as const;

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireWorkspace(workspace: ProjectWorkspace | null, projectId: string): ProjectWorkspace {
  if (!workspace) throw new Error(`workspace not found for project: ${projectId}`);
  return workspace;
}

function requiredCell(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

export class WorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly clock: StoreClock;

  constructor(db: DatabaseSync, clock: StoreClock) {
    this.db = db;
    this.clock = clock;
  }

  ensureWorkspaceRecord(projectId: string): ProjectWorkspace {
    const existing = this.getWorkspace(projectId);
    if (existing) return existing;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const concurrent = this.getWorkspace(projectId);
      if (concurrent) {
        this.db.exec("COMMIT");
        return concurrent;
      }
      const project = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as Row | undefined;
      if (!project) throw new Error(`project not found: ${projectId}`);

      const workspaceId = this.clock.id();
      const kernelRevisionId = this.clock.id();
      const snapshotId = this.clock.id();
      const now = this.clock.now();
      const emptyNodes = "[]";
      const emptyEdges = "[]";
      const kernelPayload = JSON.stringify(DEFAULT_KERNEL_PAYLOAD);

      this.db.prepare(
        `INSERT INTO project_workspaces (
           id, project_id, graph_revision, active_snapshot_id,
           active_kernel_revision_id, created_at, updated_at
         ) VALUES (?, ?, 0, NULL, NULL, ?, ?)`,
      ).run(workspaceId, projectId, now, now);
      this.db.prepare(
        `INSERT INTO workspace_graph_revisions
           (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
         VALUES (?, 0, ?, ?, ?, ?)`,
      ).run(workspaceId, emptyNodes, emptyEdges, checksum(`${emptyNodes}\n${emptyEdges}`), now);
      this.db.prepare(
        `INSERT INTO shared_design_kernel_revisions
           (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
         VALUES (?, ?, 1, NULL, ?, ?, ?)`,
      ).run(kernelRevisionId, workspaceId, kernelPayload, checksum(kernelPayload), now);
      this.db.prepare(
        `INSERT INTO workspace_snapshots (
           id, workspace_id, sequence, parent_snapshot_id, graph_revision,
           kernel_revision_id, reason, provenance_json, created_by_run_id, created_at
         ) VALUES (?, ?, 1, NULL, 0, ?, 'workspace-created', ?, NULL, ?)`,
      ).run(snapshotId, workspaceId, kernelRevisionId, JSON.stringify({ kind: "workspace-created" }), now);
      this.db.prepare(
        `UPDATE project_workspaces
         SET active_snapshot_id = ?, active_kernel_revision_id = ?
         WHERE id = ?`,
      ).run(snapshotId, kernelRevisionId, workspaceId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the seed error if SQLite already ended the transaction.
      }
      throw error;
    }

    return requireWorkspace(this.getWorkspace(projectId), projectId);
  }

  getWorkspace(projectId: string): ProjectWorkspace | null {
    const row = this.db.prepare(
      `SELECT w.*, p.mode
       FROM project_workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE w.project_id = ?`,
    ).get(projectId) as Row | undefined;
    return row ? asProjectWorkspace(row) : null;
  }

  getGraph(projectId: string): WorkspaceGraph {
    const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
    const graph: WorkspaceGraph = {
      workspaceId: workspace.id,
      revision: workspace.graphRevision,
      nodes: this.listNodes(workspace.id),
      edges: this.listEdges(workspace.id),
    };
    validateWorkspaceGraph(graph);
    return graph;
  }

  getGraphRevision(projectId: string, revision: number): WorkspaceGraph {
    const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
    return this.requireGraphRevision(workspace.id, revision);
  }

  listArtifacts(projectId: string): WorkspaceArtifactRecord[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.db.prepare(
      `SELECT * FROM workspace_artifacts
       WHERE workspace_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(workspace.id) as Row[];
    return rows.map(asWorkspaceArtifact);
  }

  listTracks(projectId: string, artifactId: string): ArtifactTrackRecord[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.db.prepare(
      `SELECT t.*
       FROM artifact_tracks t
       JOIN workspace_artifacts a ON a.id = t.artifact_id
       WHERE a.workspace_id = ? AND a.id = ?
       ORDER BY t.created_at ASC, t.id ASC`,
    ).all(workspace.id, artifactId) as Row[];
    return rows.map(asArtifactTrack);
  }

  listRevisions(projectId: string, artifactId: string): ArtifactRevisionRecord[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.db.prepare(
      `SELECT * FROM artifact_revisions
       WHERE workspace_id = ? AND artifact_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(workspace.id, artifactId) as Row[];
    return rows.map(asArtifactRevision);
  }

  listSnapshots(projectId: string): WorkspaceSnapshotRecord[] {
    const workspace = this.getWorkspace(projectId);
    if (!workspace) return [];
    const rows = this.db.prepare(
      `SELECT * FROM workspace_snapshots
       WHERE workspace_id = ?
       ORDER BY sequence ASC, id ASC`,
    ).all(workspace.id) as Row[];
    return rows.map((row) => {
      const snapshot = asWorkspaceSnapshotBase(row);
      const artifactRows = this.db.prepare(
        `SELECT artifact_id, track_id, revision_id
         FROM workspace_snapshot_artifacts
         WHERE workspace_id = ? AND snapshot_id = ?
         ORDER BY artifact_id ASC`,
      ).all(workspace.id, snapshot.id) as Row[];
      const resourceRows = this.db.prepare(
        `SELECT resource_id, revision_id
         FROM workspace_snapshot_resources
         WHERE workspace_id = ? AND snapshot_id = ?
         ORDER BY resource_id ASC`,
      ).all(workspace.id, snapshot.id) as Row[];
      return {
        ...snapshot,
        graph: this.requireGraphRevision(workspace.id, snapshot.graphRevision),
        artifactTracks: Object.fromEntries(artifactRows.map((mapping) => [
          requiredCell(mapping.artifact_id, "Snapshot Artifact id"),
          requiredCell(mapping.track_id, "Snapshot Artifact Track id"),
        ])),
        artifactRevisions: Object.fromEntries(artifactRows.map((mapping) => [
          requiredCell(mapping.artifact_id, "Snapshot Artifact id"),
          mapping.revision_id == null ? null : requiredCell(mapping.revision_id, "Snapshot Artifact Revision id"),
        ])),
        resourceRevisions: Object.fromEntries(resourceRows.map((mapping) => [
          requiredCell(mapping.resource_id, "Snapshot Resource id"),
          requiredCell(mapping.revision_id, "Snapshot Resource Revision id"),
        ])),
      };
    });
  }

  private requireGraphRevision(workspaceId: string, revision: number): WorkspaceGraph {
    const row = this.db.prepare(
      `SELECT * FROM workspace_graph_revisions
       WHERE workspace_id = ? AND revision = ?`,
    ).get(workspaceId, revision) as Row | undefined;
    if (!row) throw new Error(`workspace graph revision not found: ${workspaceId}@${revision}`);
    return asWorkspaceGraphRevision(row);
  }

  private listNodes(workspaceId: string): WorkspaceGraph["nodes"] {
    const rows = this.db.prepare(
      `SELECT n.*, CASE WHEN n.kind = 'resource' THEN r.title ELSE a.name END AS name
       FROM workspace_nodes n
       LEFT JOIN workspace_artifacts a
         ON a.id = n.artifact_id AND a.workspace_id = n.workspace_id
       LEFT JOIN resources r
         ON r.id = n.resource_id AND r.workspace_id = n.workspace_id
       WHERE n.workspace_id = ? AND n.archived_at IS NULL
       ORDER BY n.created_at ASC, n.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(asWorkspaceNode);
  }

  private listEdges(workspaceId: string): WorkspaceGraph["edges"] {
    const rows = this.db.prepare(
      `SELECT e.*
       FROM workspace_edges e
       JOIN workspace_nodes source
         ON source.id = e.source_node_id AND source.workspace_id = e.workspace_id
       JOIN workspace_nodes target
         ON target.id = e.target_node_id AND target.workspace_id = e.workspace_id
       WHERE e.workspace_id = ?
         AND source.archived_at IS NULL
         AND target.archived_at IS NULL
       ORDER BY e.created_at ASC, e.id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(asWorkspaceEdge);
  }
}
