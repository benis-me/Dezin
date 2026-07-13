import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { StoreClock } from "./store.ts";
import type {
  NewWorkspaceNode,
  ProjectWorkspace,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceGraphMutationInput,
  WorkspaceGraphMutationResult,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceLayoutPatch,
  WorkspaceNode,
  WorkspaceSnapshotProvenance,
} from "./workspace-types.ts";
import {
  applyWorkspaceGraphCommands,
  validateWorkspaceGraph,
  WorkspaceCommandReplayConflictError,
  WorkspaceGraphValidationError,
  WorkspaceRevisionConflictError,
} from "./workspace-graph.ts";
import {
  asArtifactRevision,
  asArtifactTrack,
  asProjectWorkspace,
  asWorkspaceArtifact,
  asWorkspaceEdge,
  asWorkspaceGraphRevision,
  asWorkspaceNode,
  asWorkspaceSnapshotBase,
  normalizeWorkspaceGraphMutationInput,
  normalizeWorkspaceLayoutId,
  normalizeWorkspaceLayoutPatch,
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

function safePathSegment(value: string): string {
  if (value.length <= 90 && /^(?!\.{1,2}$)[a-z0-9_-]+$/.test(value)) return `raw-${value}`;
  return `hash-${checksum(`workspace-path-segment-v1\0${value}`)}`;
}

function artifactSourceRoot(workspaceId: string, artifactId: string): string {
  return `workspaces/${safePathSegment(workspaceId)}/artifacts/${safePathSegment(artifactId)}`;
}

function graphsAreSemanticallyEqual(left: WorkspaceGraph, right: WorkspaceGraph): boolean {
  const byId = <T extends { id: string }>(values: readonly T[]): T[] => [...values].sort((a, b) => (
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  ));
  return left.workspaceId === right.workspaceId
    && left.revision === right.revision
    && isDeepStrictEqual(byId(left.nodes), byId(right.nodes))
    && isDeepStrictEqual(byId(left.edges), byId(right.edges));
}

interface GraphCommandRow extends Row {
  workspace_id: string;
  command_id: string;
  base_revision: number;
  result_revision: number;
  expected_snapshot_id: string;
  batch_hash: string;
  batch_index: number;
  batch_size: number;
  result_snapshot_id: string;
  payload_json: string;
}

interface SnapshotArtifactOverride {
  artifactId: string;
  trackId: string;
  revisionId: string | null;
}

interface SnapshotResourceOverride {
  resourceId: string;
  revisionId: string;
}

interface SnapshotCreationInput {
  expectedSnapshotId: string;
  graphRevision: number;
  kernelRevisionId?: string;
  reason: string;
  provenance: WorkspaceSnapshotProvenance;
  artifactOverrides?: readonly SnapshotArtifactOverride[];
  resourceOverrides?: readonly SnapshotResourceOverride[];
  artifactRemovals?: readonly string[];
  resourceRemovals?: readonly string[];
  createdByRunId?: string | null;
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
    return this.transactionRead(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const graph: WorkspaceGraph = {
        workspaceId: workspace.id,
        revision: workspace.graphRevision,
        nodes: this.listNodes(workspace.id),
        edges: this.listEdges(workspace.id),
      };
      validateWorkspaceGraph(graph);
      return graph;
    });
  }

  getGraphRevision(projectId: string, revision: number): WorkspaceGraph {
    const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
    return this.requireGraphRevision(workspace.id, revision);
  }

  applyGraphCommands(projectId: string, unsafeInput: WorkspaceGraphMutationInput): WorkspaceGraphMutationResult {
    const input = normalizeWorkspaceGraphMutationInput(unsafeInput);
    const payloads = input.commands.map((command) => JSON.stringify(command));
    const batchHash = checksum(`workspace-graph-command-batch-v1\0${JSON.stringify(input.commands)}`);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const replay = this.findExactGraphCommandReplay(workspace.id, input, payloads, batchHash);
      if (replay) return replay;

      const current = this.getGraph(projectId);
      if (current.revision !== input.baseGraphRevision) {
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, current.revision);
      }
      if (workspace.activeSnapshotId !== input.expectedSnapshotId) {
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, current.revision, {
          expectedSnapshotId: input.expectedSnapshotId,
          actualSnapshotId: workspace.activeSnapshotId,
        });
      }

      const applied = applyWorkspaceGraphCommands(current, input.commands);
      this.persistGraphDelta(current, applied, input.commands);
      const next: WorkspaceGraph = {
        workspaceId: current.workspaceId,
        revision: applied.revision,
        nodes: this.listNodes(current.workspaceId),
        edges: this.listEdges(current.workspaceId),
      };
      validateWorkspaceGraph(next);
      if (!graphsAreSemanticallyEqual(applied, next)) {
        throw new WorkspaceGraphValidationError("durable workspace graph does not match applied commands");
      }
      this.insertImmutableGraphRevision(next);
      const mappingOverrides = this.snapshotOverridesForGraphDelta(workspace.id, current, next, input.commands);
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: input.expectedSnapshotId,
        graphRevision: next.revision,
        reason: "graph-command",
        provenance: { kind: "graph-command", commandIds: input.commands.map((command) => command.id) },
        artifactOverrides: mappingOverrides.artifacts,
        resourceOverrides: mappingOverrides.resources,
        artifactRemovals: mappingOverrides.artifactRemovals,
        resourceRemovals: mappingOverrides.resourceRemovals,
      });
      const now = this.clock.now();
      const moved = this.db.prepare(
        `UPDATE project_workspaces
         SET graph_revision = ?, active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND graph_revision = ? AND active_snapshot_id IS ?`,
      ).run(next.revision, snapshot.id, now, workspace.id, input.baseGraphRevision, input.expectedSnapshotId);
      if (Number(moved.changes) !== 1) {
        const actual = requireWorkspace(this.getWorkspace(projectId), projectId);
        throw new WorkspaceRevisionConflictError(input.baseGraphRevision, actual.graphRevision, {
          expectedSnapshotId: input.expectedSnapshotId,
          actualSnapshotId: actual.activeSnapshotId,
        });
      }
      const insertCommand = this.db.prepare(
        `INSERT INTO workspace_graph_commands (
           workspace_id, command_id, base_revision, result_revision, expected_snapshot_id,
           batch_hash, batch_index, batch_size, result_snapshot_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let index = 0; index < input.commands.length; index += 1) {
        const command = input.commands[index];
        const payload = payloads[index];
        if (!command || payload === undefined) {
          throw new WorkspaceGraphValidationError(`missing normalized command at index ${index}`);
        }
        insertCommand.run(
          workspace.id,
          command.id,
          input.baseGraphRevision,
          next.revision,
          input.expectedSnapshotId,
          batchHash,
          index,
          input.commands.length,
          snapshot.id,
          payload,
          now,
        );
      }
      return { graph: next, snapshot };
    });
  }

  getLayout(projectId: string, unsafeLayoutId = "default"): WorkspaceLayout {
    return this.transactionRead(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const layoutId = normalizeWorkspaceLayoutId(unsafeLayoutId);
      const graph = this.getGraph(projectId);
      this.validateLayoutGroups(workspace.id, layoutId, new Set(graph.nodes.map((node) => node.id)));
      return this.getLayoutByWorkspaceId(workspace.id, layoutId);
    });
  }

  saveLayout(projectId: string, unsafeInput: WorkspaceLayoutPatch): WorkspaceLayout {
    const input = normalizeWorkspaceLayoutPatch(unsafeInput);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      const guarded = this.db.prepare(
        `UPDATE project_workspaces SET updated_at = ?
         WHERE id = ? AND graph_revision = ?`,
      ).run(this.clock.now(), workspace.id, input.graphRevision);
      if (Number(guarded.changes) !== 1) {
        throw new WorkspaceRevisionConflictError(input.graphRevision, workspace.graphRevision);
      }
      const graph = this.getGraph(projectId);
      this.applyLayoutCommandsInTransaction(workspace.id, graph, input.layoutId, input.commands);
      return this.getLayoutByWorkspaceId(workspace.id, input.layoutId);
    });
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

  private transactionImmediate<T>(operation: () => T): T {
    if (this.db.isTransaction) throw new Error("WorkspaceStore transaction wrapper cannot be nested");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the operation error if SQLite already ended the transaction.
        }
      }
      throw error;
    }
  }

  private transactionRead<T>(operation: () => T): T {
    if (this.db.isTransaction) return operation();
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the read error if SQLite already ended the transaction.
        }
      }
      throw error;
    }
  }

  private findExactGraphCommandReplay(
    workspaceId: string,
    input: WorkspaceGraphMutationInput,
    payloads: readonly string[],
    batchHash: string,
  ): WorkspaceGraphMutationResult | null {
    const findCommand = this.db.prepare(
      `SELECT * FROM workspace_graph_commands
       WHERE workspace_id = ? AND command_id = ?`,
    );
    const rows = input.commands.flatMap((command) => {
      const row = findCommand.get(workspaceId, command.id) as GraphCommandRow | undefined;
      return row ? [row] : [];
    });
    if (rows.length === 0) return null;
    const conflict = () => {
      throw new WorkspaceCommandReplayConflictError(input.commands.map((command) => command.id));
    };
    if (rows.length !== input.commands.length) return conflict();

    const first = rows[0];
    if (!first) return conflict();
    for (let index = 0; index < input.commands.length; index += 1) {
      const command = input.commands[index];
      const row = rows[index];
      if (!command || !row
        || row.command_id !== command.id
        || row.base_revision !== input.baseGraphRevision
        || row.expected_snapshot_id !== input.expectedSnapshotId
        || row.batch_hash !== batchHash
        || row.batch_index !== index
        || row.batch_size !== input.commands.length
        || row.payload_json !== payloads[index]
        || row.result_revision !== first.result_revision
        || row.result_snapshot_id !== first.result_snapshot_id) {
        return conflict();
      }
    }
    const storedBatchCount = Number((this.db.prepare(
      `SELECT COUNT(*) AS count FROM workspace_graph_commands
       WHERE workspace_id = ? AND batch_hash = ? AND base_revision = ?
         AND expected_snapshot_id IS ? AND result_revision = ? AND result_snapshot_id = ?`,
    ).get(
      workspaceId,
      batchHash,
      input.baseGraphRevision,
      input.expectedSnapshotId,
      first.result_revision,
      first.result_snapshot_id,
    ) as { count: number }).count);
    if (storedBatchCount !== input.commands.length) return conflict();
    const snapshot = this.requireSnapshot(workspaceId, first.result_snapshot_id);
    const expectedCommandIds = input.commands.map((command) => command.id);
    if (snapshot.graphRevision !== first.result_revision
      || snapshot.parentSnapshotId !== input.expectedSnapshotId
      || snapshot.provenance.kind !== "graph-command"
      || snapshot.provenance.commandIds.length !== expectedCommandIds.length
      || snapshot.provenance.commandIds.some((commandId, index) => commandId !== expectedCommandIds[index])) {
      return conflict();
    }
    return {
      graph: this.requireGraphRevision(workspaceId, first.result_revision),
      snapshot,
    };
  }

  private persistGraphDelta(
    current: WorkspaceGraph,
    next: WorkspaceGraph,
    commands: readonly WorkspaceGraphCommand[],
  ): void {
    const nodes = new Map(current.nodes.map((node) => [node.id, node]));
    for (const command of commands) {
      const now = this.clock.now();
      switch (command.type) {
        case "add-node": {
          if (this.db.prepare("SELECT 1 FROM workspace_nodes WHERE id = ?").get(command.node.id)) {
            throw new WorkspaceGraphValidationError(`workspace node identity collision: ${command.node.id}`);
          }
          if (this.db.prepare(
            `SELECT 1 FROM workspace_layout_nodes
             WHERE workspace_id = ? AND object_id = ? AND object_kind = 'group'
             LIMIT 1`,
          ).get(current.workspaceId, command.node.id)) {
            throw new WorkspaceGraphValidationError(`workspace node ${command.node.id} collides with a layout group`);
          }
          this.ensureNodeIdentity(current.workspaceId, command.node, now);
          this.db.prepare(
            `INSERT INTO workspace_nodes
               (id, workspace_id, kind, artifact_id, resource_id, archived_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
          ).run(
            command.node.id,
            current.workspaceId,
            command.node.kind,
            command.node.kind === "resource" ? null : command.node.artifactId,
            command.node.kind === "resource" ? command.node.resourceId : null,
            now,
            now,
          );
          const added = next.nodes.find((node) => node.id === command.node.id)
            ?? ({ ...command.node, workspaceId: current.workspaceId } as WorkspaceNode);
          nodes.set(command.node.id, added);
          break;
        }
        case "rename-node": {
          const node = nodes.get(command.nodeId);
          if (!node) throw new WorkspaceGraphValidationError(`node ${command.nodeId} does not exist`);
          if (node.kind === "resource") {
            this.requireOneChange(
              this.db.prepare("UPDATE resources SET title = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(command.name, now, node.resourceId, current.workspaceId),
              `rename Resource ${node.resourceId}`,
            );
          } else {
            this.requireOneChange(
              this.db.prepare("UPDATE workspace_artifacts SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(command.name, now, node.artifactId, current.workspaceId),
              `rename Artifact ${node.artifactId}`,
            );
          }
          this.requireOneChange(
            this.db.prepare("UPDATE workspace_nodes SET updated_at = ? WHERE id = ? AND workspace_id = ?")
              .run(now, node.id, current.workspaceId),
            `rename node ${node.id}`,
          );
          nodes.set(command.nodeId, { ...node, name: command.name });
          break;
        }
        case "archive-node": {
          const node = nodes.get(command.nodeId);
          if (!node) throw new WorkspaceGraphValidationError(`node ${command.nodeId} does not exist`);
          this.requireOneChange(this.db.prepare(
            "UPDATE workspace_nodes SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND archived_at IS NULL",
          ).run(now, now, node.id, current.workspaceId), `archive node ${node.id}`);
          if (node.kind === "resource") {
            this.requireOneChange(
              this.db.prepare("UPDATE resources SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(now, now, node.resourceId, current.workspaceId),
              `archive Resource ${node.resourceId}`,
            );
          } else {
            this.requireOneChange(
              this.db.prepare("UPDATE workspace_artifacts SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .run(now, now, node.artifactId, current.workspaceId),
              `archive Artifact ${node.artifactId}`,
            );
          }
          this.db.prepare(
            "DELETE FROM workspace_layout_nodes WHERE workspace_id = ? AND object_id = ? AND object_kind = 'node'",
          ).run(current.workspaceId, node.id);
          this.db.prepare(
            `DELETE FROM workspace_edges
             WHERE workspace_id = ? AND (source_node_id = ? OR target_node_id = ?)`,
          ).run(current.workspaceId, node.id, node.id);
          nodes.delete(command.nodeId);
          break;
        }
        case "add-edge": {
          if (this.db.prepare("SELECT 1 FROM workspace_edges WHERE id = ?").get(command.edge.id)) {
            throw new WorkspaceGraphValidationError(`workspace edge identity collision: ${command.edge.id}`);
          }
          const payload = command.edge.kind === "prototype" ? JSON.stringify({ status: "planned" }) : "{}";
          this.db.prepare(
            `INSERT INTO workspace_edges
               (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            command.edge.id,
            current.workspaceId,
            command.edge.kind,
            command.edge.sourceNodeId,
            command.edge.targetNodeId,
            payload,
            now,
            now,
          );
          break;
        }
        case "remove-edge":
          this.requireOneChange(
            this.db.prepare("DELETE FROM workspace_edges WHERE id = ? AND workspace_id = ?")
              .run(command.edgeId, current.workspaceId),
            `remove edge ${command.edgeId}`,
          );
          break;
        case "bind-prototype": {
          const edge = this.db.prepare(
            "SELECT kind FROM workspace_edges WHERE id = ? AND workspace_id = ?",
          ).get(command.edgeId, current.workspaceId) as { kind: string } | undefined;
          if (edge?.kind !== "prototype") {
            throw new WorkspaceGraphValidationError(`edge ${command.edgeId} is not a prototype edge`);
          }
          this.requireOneChange(
            this.db.prepare("UPDATE workspace_edges SET payload_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
              .run(
                JSON.stringify({ status: "interactive", binding: command.binding }),
                now,
                command.edgeId,
                current.workspaceId,
              ),
            `bind prototype edge ${command.edgeId}`,
          );
          break;
        }
      }
    }
  }

  private ensureNodeIdentity(workspaceId: string, node: NewWorkspaceNode, now: number): void {
    if (node.kind === "resource") {
      const existing = this.db.prepare("SELECT * FROM resources WHERE id = ?").get(node.resourceId) as Row | undefined;
      if (existing) {
        if (node.createIdentity !== undefined) {
          throw new WorkspaceGraphValidationError(`Resource identity collision: ${node.resourceId}`);
        }
        const matches = existing.workspace_id === workspaceId
          && existing.title === node.name
          && existing.archived_at == null;
        if (!matches) throw new WorkspaceGraphValidationError(`Resource identity collision: ${node.resourceId}`);
        return;
      }
      if (!node.createIdentity) {
        throw new WorkspaceGraphValidationError(`Resource identity ${node.resourceId} does not exist in this Workspace`);
      }
      this.db.prepare(
        `INSERT INTO resources (
           id, workspace_id, kind, title, head_revision_id, default_pin_policy,
           archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      ).run(
        node.resourceId,
        workspaceId,
        node.createIdentity.resourceKind,
        node.name,
        node.createIdentity.defaultPinPolicy,
        now,
        now,
      );
      return;
    }

    const existing = this.db.prepare("SELECT * FROM workspace_artifacts WHERE id = ?").get(node.artifactId) as Row | undefined;
    const derivedRoot = artifactSourceRoot(workspaceId, node.artifactId);
    if (existing) {
      if (node.createIdentity !== undefined) {
        throw new WorkspaceGraphValidationError(`Artifact identity collision: ${node.artifactId}`);
      }
      if (existing.workspace_id === workspaceId && existing.source_root !== derivedRoot) {
        throw new WorkspaceGraphValidationError(`Artifact ${node.artifactId} source root is not server-derived`);
      }
      const matches = existing.workspace_id === workspaceId
        && existing.kind === node.kind
        && existing.name === node.name
        && existing.source_root === derivedRoot
        && existing.archived_at == null
        && existing.active_track_id != null;
      if (!matches) throw new WorkspaceGraphValidationError(`Artifact identity collision: ${node.artifactId}`);
      return;
    }
    if (!node.createIdentity) {
      throw new WorkspaceGraphValidationError(`Artifact identity ${node.artifactId} does not exist in this Workspace`);
    }
    if (this.db.prepare("SELECT 1 FROM artifact_tracks WHERE id = ?").get(node.createIdentity.initialTrackId)) {
      throw new WorkspaceGraphValidationError(`Artifact Track identity collision: ${node.createIdentity.initialTrackId}`);
    }
    this.db.prepare(
      `INSERT INTO workspace_artifacts (
         id, workspace_id, kind, name, source_root, active_track_id, archived_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(node.artifactId, workspaceId, node.kind, node.name, derivedRoot, now, now);
    this.db.prepare(
      `INSERT INTO artifact_tracks
         (id, artifact_id, name, head_revision_id, legacy_variant_id, created_at)
       VALUES (?, ?, 'main', NULL, NULL, ?)`,
    ).run(node.createIdentity.initialTrackId, node.artifactId, now);
    this.requireOneChange(
      this.db.prepare("UPDATE workspace_artifacts SET active_track_id = ? WHERE id = ?")
        .run(node.createIdentity.initialTrackId, node.artifactId),
      `activate initial Track for Artifact ${node.artifactId}`,
    );
  }

  private requireOneChange(result: { changes: number | bigint }, operation: string): void {
    if (Number(result.changes) !== 1) {
      throw new WorkspaceGraphValidationError(`workspace index changed unexpectedly during ${operation}`);
    }
  }

  private insertImmutableGraphRevision(graph: WorkspaceGraph): void {
    const nodesJson = JSON.stringify(graph.nodes);
    const edgesJson = JSON.stringify(graph.edges);
    this.db.prepare(
      `INSERT INTO workspace_graph_revisions
         (workspace_id, revision, nodes_json, edges_json, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(graph.workspaceId, graph.revision, nodesJson, edgesJson, checksum(`${nodesJson}\n${edgesJson}`), this.clock.now());
  }

  private snapshotOverridesForGraphDelta(
    workspaceId: string,
    current: WorkspaceGraph,
    next: WorkspaceGraph,
    commands: readonly WorkspaceGraphCommand[],
  ): {
    artifacts: SnapshotArtifactOverride[];
    resources: SnapshotResourceOverride[];
    artifactRemovals: string[];
    resourceRemovals: string[];
  } {
    const currentNodeIds = new Set(current.nodes.map((node) => node.id));
    const nextNodeIds = new Set(next.nodes.map((node) => node.id));
    const artifacts: SnapshotArtifactOverride[] = [];
    const resources: SnapshotResourceOverride[] = [];
    for (const node of next.nodes) {
      if (currentNodeIds.has(node.id)) continue;
      if (node.kind === "resource") {
        const row = this.db.prepare(
          "SELECT head_revision_id FROM resources WHERE id = ? AND workspace_id = ?",
        ).get(node.resourceId, workspaceId) as { head_revision_id: string | null } | undefined;
        if (row?.head_revision_id) resources.push({ resourceId: node.resourceId, revisionId: row.head_revision_id });
      } else {
        const row = this.db.prepare(
          `SELECT a.active_track_id, t.head_revision_id
           FROM workspace_artifacts a
           JOIN artifact_tracks t ON t.id = a.active_track_id AND t.artifact_id = a.id
           WHERE a.id = ? AND a.workspace_id = ?`,
        ).get(node.artifactId, workspaceId) as { active_track_id: string; head_revision_id: string | null } | undefined;
        if (!row) throw new WorkspaceGraphValidationError(`Artifact ${node.artifactId} has no active Track`);
        artifacts.push({ artifactId: node.artifactId, trackId: row.active_track_id, revisionId: row.head_revision_id });
      }
    }
    const artifactRemovals = new Set<string>();
    const resourceRemovals = new Set<string>();
    for (const node of current.nodes) {
      if (nextNodeIds.has(node.id)) continue;
      if (node.kind === "resource") resourceRemovals.add(node.resourceId);
      else artifactRemovals.add(node.artifactId);
    }
    const lifecycleNodes = new Map<string, WorkspaceNode | NewWorkspaceNode>(
      current.nodes.map((node) => [node.id, node]),
    );
    for (const command of commands) {
      if (command.type === "add-node") {
        lifecycleNodes.set(command.node.id, command.node);
        continue;
      }
      if (command.type !== "archive-node") continue;
      const archived = lifecycleNodes.get(command.nodeId);
      if (!archived) {
        throw new WorkspaceGraphValidationError(`node ${command.nodeId} does not exist during Snapshot mapping update`);
      }
      if (archived.kind === "resource") resourceRemovals.add(archived.resourceId);
      else artifactRemovals.add(archived.artifactId);
      lifecycleNodes.delete(command.nodeId);
    }
    return {
      artifacts,
      resources,
      artifactRemovals: [...artifactRemovals],
      resourceRemovals: [...resourceRemovals],
    };
  }

  private createSnapshotInTransaction(workspaceId: string, input: SnapshotCreationInput): WorkspaceSnapshotRecord {
    const workspace = this.db.prepare(
      "SELECT graph_revision, active_snapshot_id, active_kernel_revision_id FROM project_workspaces WHERE id = ?",
    ).get(workspaceId) as {
      graph_revision: number;
      active_snapshot_id: string;
      active_kernel_revision_id: string;
    } | undefined;
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    if (workspace.active_snapshot_id !== input.expectedSnapshotId) {
      throw new WorkspaceRevisionConflictError(input.graphRevision, workspace.graph_revision, {
        expectedSnapshotId: input.expectedSnapshotId,
        actualSnapshotId: workspace.active_snapshot_id,
      });
    }
    const parent = this.requireSnapshot(workspaceId, input.expectedSnapshotId);
    const sequenceRow = this.db.prepare(
      `SELECT CAST(COALESCE(MAX(sequence), 0) AS TEXT) AS max_sequence,
              typeof(COALESCE(MAX(sequence), 0)) AS sequence_type
       FROM workspace_snapshots WHERE workspace_id = ?`,
    ).get(workspaceId) as { max_sequence: unknown; sequence_type: unknown };
    if (sequenceRow.sequence_type !== "integer"
      || typeof sequenceRow.max_sequence !== "string"
      || !/^(0|[1-9][0-9]*)$/.test(sequenceRow.max_sequence)) {
      throw new WorkspaceGraphValidationError("next Workspace Snapshot sequence must be a positive safe integer");
    }
    const maxSequence = BigInt(sequenceRow.max_sequence);
    if (maxSequence >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WorkspaceGraphValidationError("next Workspace Snapshot sequence must be a positive safe integer");
    }
    const sequence = Number(maxSequence) + 1;
    const snapshotId = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshotId,
      workspaceId,
      sequence,
      input.expectedSnapshotId,
      input.graphRevision,
      input.kernelRevisionId ?? parent.kernelRevisionId,
      input.reason,
      JSON.stringify(input.provenance),
      input.createdByRunId ?? null,
      now,
    );
    this.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       SELECT workspace_id, ?, artifact_id, track_id, revision_id
       FROM workspace_snapshot_artifacts
       WHERE workspace_id = ? AND snapshot_id = ?`,
    ).run(snapshotId, workspaceId, input.expectedSnapshotId);
    this.db.prepare(
      `INSERT INTO workspace_snapshot_resources
         (workspace_id, snapshot_id, resource_id, revision_id)
       SELECT workspace_id, ?, resource_id, revision_id
       FROM workspace_snapshot_resources
       WHERE workspace_id = ? AND snapshot_id = ?`,
    ).run(snapshotId, workspaceId, input.expectedSnapshotId);
    const upsertArtifact = this.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, artifact_id) DO UPDATE
       SET track_id = excluded.track_id, revision_id = excluded.revision_id`,
    );
    for (const override of input.artifactOverrides ?? []) {
      upsertArtifact.run(workspaceId, snapshotId, override.artifactId, override.trackId, override.revisionId);
    }
    const upsertResource = this.db.prepare(
      `INSERT INTO workspace_snapshot_resources
         (workspace_id, snapshot_id, resource_id, revision_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(snapshot_id, resource_id) DO UPDATE SET revision_id = excluded.revision_id`,
    );
    for (const override of input.resourceOverrides ?? []) {
      upsertResource.run(workspaceId, snapshotId, override.resourceId, override.revisionId);
    }
    const deleteArtifact = this.db.prepare(
      "DELETE FROM workspace_snapshot_artifacts WHERE workspace_id = ? AND snapshot_id = ? AND artifact_id = ?",
    );
    for (const artifactId of input.artifactRemovals ?? []) {
      deleteArtifact.run(workspaceId, snapshotId, artifactId);
    }
    const deleteResource = this.db.prepare(
      "DELETE FROM workspace_snapshot_resources WHERE workspace_id = ? AND snapshot_id = ? AND resource_id = ?",
    );
    for (const resourceId of input.resourceRemovals ?? []) {
      deleteResource.run(workspaceId, snapshotId, resourceId);
    }
    return this.requireSnapshot(workspaceId, snapshotId);
  }

  private requireSnapshot(workspaceId: string, snapshotId: string): WorkspaceSnapshotRecord {
    const row = this.db.prepare(
      "SELECT * FROM workspace_snapshots WHERE workspace_id = ? AND id = ?",
    ).get(workspaceId, snapshotId) as Row | undefined;
    if (!row) throw new Error(`Workspace Snapshot not found: ${snapshotId}`);
    const snapshot = asWorkspaceSnapshotBase(row);
    const artifactRows = this.db.prepare(
      `SELECT artifact_id, track_id, revision_id FROM workspace_snapshot_artifacts
       WHERE workspace_id = ? AND snapshot_id = ? ORDER BY artifact_id ASC`,
    ).all(workspaceId, snapshotId) as Row[];
    const resourceRows = this.db.prepare(
      `SELECT resource_id, revision_id FROM workspace_snapshot_resources
       WHERE workspace_id = ? AND snapshot_id = ? ORDER BY resource_id ASC`,
    ).all(workspaceId, snapshotId) as Row[];
    return {
      ...snapshot,
      graph: this.requireGraphRevision(workspaceId, snapshot.graphRevision),
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
  }

  private getLayoutByWorkspaceId(workspaceId: string, layoutId: string): WorkspaceLayout {
    const rows = this.db.prepare(
      `SELECT * FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ?
       ORDER BY object_kind ASC, object_id ASC`,
    ).all(workspaceId, layoutId) as Row[];
    const storedNumber = (value: unknown, label: string): number => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
      return value;
    };
    const storedPositive = (value: unknown, label: string): number => {
      const number = storedNumber(value, label);
      if (number <= 0) throw new Error(`${label} must be positive`);
      return number;
    };
    const objects: WorkspaceLayout["objects"] = rows.map((row) => {
      const id = requiredCell(row.object_id, "layout object id");
      const parentGroupId = row.parent_group_id == null ? null : requiredCell(row.parent_group_id, "layout parent group id");
      const x = storedNumber(row.x, `layout object ${id} x`);
      const y = storedNumber(row.y, `layout object ${id} y`);
      if (row.object_kind === "node") return { id, kind: "node" as const, x, y, parentGroupId };
      if (row.object_kind !== "group") throw new Error(`unsupported layout object kind ${String(row.object_kind)}`);
      if (row.collapsed !== 0 && row.collapsed !== 1) throw new Error(`layout group ${id} collapsed is invalid`);
      return {
        id,
        kind: "group" as const,
        x,
        y,
        width: storedPositive(row.width, `layout group ${id} width`),
        height: storedPositive(row.height, `layout group ${id} height`),
        parentGroupId,
        label: requiredCell(row.label, `layout group ${id} label`),
        collapsed: row.collapsed === 1,
      };
    });
    const viewportRow = this.db.prepare(
      "SELECT * FROM workspace_layout_viewports WHERE workspace_id = ? AND layout_id = ?",
    ).get(workspaceId, layoutId) as Row | undefined;
    return {
      workspaceId,
      layoutId,
      objects,
      viewport: viewportRow
        ? {
            x: storedNumber(viewportRow.x, "layout viewport x"),
            y: storedNumber(viewportRow.y, "layout viewport y"),
            zoom: storedPositive(viewportRow.zoom, "layout viewport zoom"),
          }
        : { x: 0, y: 0, zoom: 1 },
    };
  }

  private applyLayoutCommandsInTransaction(
    workspaceId: string,
    graph: WorkspaceGraph,
    layoutId: string,
    commands: readonly WorkspaceLayoutCommand[],
  ): void {
    const semanticNodeIds = new Set(graph.nodes.map((node) => node.id));
    const groupRow = (groupId: string) => this.db.prepare(
      `SELECT object_id FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
    ).get(workspaceId, layoutId, groupId) as Row | undefined;
    const anyObjectRow = (objectId: string) => this.db.prepare(
      `SELECT object_kind FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ? AND object_id = ?`,
    ).get(workspaceId, layoutId, objectId) as Row | undefined;
    const requireGroup = (groupId: string) => {
      if (!groupRow(groupId)) throw new WorkspaceGraphValidationError(`layout group ${groupId} does not exist`);
    };
    const ensureObject = (objectId: string, now: number): "node" | "group" => {
      const existing = anyObjectRow(objectId);
      if (existing?.object_kind === "group") return "group";
      if (existing?.object_kind === "node") {
        if (!semanticNodeIds.has(objectId)) {
          throw new WorkspaceGraphValidationError(`layout semantic object ${objectId} does not exist`);
        }
        return "node";
      }
      if (!semanticNodeIds.has(objectId)) {
        throw new WorkspaceGraphValidationError(`layout object ${objectId} does not exist`);
      }
      this.db.prepare(
        `INSERT INTO workspace_layout_nodes (
           workspace_id, layout_id, object_id, object_kind, x, y, width, height,
           parent_group_id, label, collapsed, updated_at
         ) VALUES (?, ?, ?, 'node', 0, 0, NULL, NULL, NULL, NULL, 0, ?)`,
      ).run(workspaceId, layoutId, objectId, now);
      return "node";
    };

    for (const command of commands) {
      const now = this.clock.now();
      switch (command.type) {
        case "add-group":
          if (this.db.prepare(
            "SELECT 1 FROM workspace_nodes WHERE workspace_id = ? AND id = ?",
          ).get(workspaceId, command.groupId)) {
            throw new WorkspaceGraphValidationError(
              `layout group ${command.groupId} collides with a reserved semantic node identity`,
            );
          }
          if (semanticNodeIds.has(command.groupId) || anyObjectRow(command.groupId)) {
            throw new WorkspaceGraphValidationError(`duplicate layout group id ${command.groupId}`);
          }
          this.db.prepare(
            `INSERT INTO workspace_layout_nodes (
               workspace_id, layout_id, object_id, object_kind, x, y, width, height,
               parent_group_id, label, collapsed, updated_at
             ) VALUES (?, ?, ?, 'group', ?, ?, ?, ?, NULL, ?, 0, ?)`,
          ).run(
            workspaceId,
            layoutId,
            command.groupId,
            command.bounds.x,
            command.bounds.y,
            command.bounds.width,
            command.bounds.height,
            command.label,
            now,
          );
          break;
        case "rename-group":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET label = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(command.label, now, workspaceId, layoutId, command.groupId);
          break;
        case "delete-group":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET parent_group_id = NULL, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND parent_group_id = ?`,
          ).run(now, workspaceId, layoutId, command.groupId);
          this.db.prepare(
            `DELETE FROM workspace_layout_nodes
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(workspaceId, layoutId, command.groupId);
          break;
        case "set-parent":
          ensureObject(command.objectId, now);
          if (command.parentGroupId !== null) requireGroup(command.parentGroupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET parent_group_id = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ?`,
          ).run(command.parentGroupId, now, workspaceId, layoutId, command.objectId);
          break;
        case "move":
          ensureObject(command.objectId, now);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET x = ?, y = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ?`,
          ).run(command.x, command.y, now, workspaceId, layoutId, command.objectId);
          break;
        case "resize-group":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET width = ?, height = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(command.width, command.height, now, workspaceId, layoutId, command.groupId);
          break;
        case "set-collapsed":
          requireGroup(command.groupId);
          this.db.prepare(
            `UPDATE workspace_layout_nodes SET collapsed = ?, updated_at = ?
             WHERE workspace_id = ? AND layout_id = ? AND object_id = ? AND object_kind = 'group'`,
          ).run(command.collapsed ? 1 : 0, now, workspaceId, layoutId, command.groupId);
          break;
        case "set-viewport":
          this.db.prepare(
            `INSERT INTO workspace_layout_viewports (workspace_id, layout_id, x, y, zoom, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, layout_id) DO UPDATE
             SET x = excluded.x, y = excluded.y, zoom = excluded.zoom, updated_at = excluded.updated_at`,
          ).run(workspaceId, layoutId, command.viewport.x, command.viewport.y, command.viewport.zoom, now);
          break;
      }
    }
    this.validateLayoutGroups(workspaceId, layoutId, semanticNodeIds);
  }

  private validateLayoutGroups(workspaceId: string, layoutId: string, semanticNodeIds: ReadonlySet<string>): void {
    const rows = this.db.prepare(
      `SELECT object_id, object_kind, parent_group_id FROM workspace_layout_nodes
       WHERE workspace_id = ? AND layout_id = ?`,
    ).all(workspaceId, layoutId) as Array<{ object_id: string; object_kind: string; parent_group_id: string | null }>;
    const groups = new Set(rows.filter((row) => row.object_kind === "group").map((row) => row.object_id));
    const reservedNodeIds = new Set((this.db.prepare(
      "SELECT id FROM workspace_nodes WHERE workspace_id = ?",
    ).all(workspaceId) as Array<{ id: string }>).map(({ id }) => id));
    const parents = new Map<string, string | null>();
    for (const row of rows) {
      if (row.object_kind !== "group" && row.object_kind !== "node") {
        throw new WorkspaceGraphValidationError(`unsupported layout object kind ${row.object_kind}`);
      }
      if (row.object_kind === "node" && !semanticNodeIds.has(row.object_id)) {
        throw new WorkspaceGraphValidationError(`layout semantic object ${row.object_id} does not exist`);
      }
      if (row.object_kind === "group" && reservedNodeIds.has(row.object_id)) {
        throw new WorkspaceGraphValidationError(`layout group ${row.object_id} collides with a semantic node identity`);
      }
      if (row.parent_group_id !== null && !groups.has(row.parent_group_id)) {
        throw new WorkspaceGraphValidationError(`layout parent group ${row.parent_group_id} does not exist`);
      }
      if (row.object_kind === "group") parents.set(row.object_id, row.parent_group_id);
    }
    const states = new Map<string, "visiting" | "done">();
    for (const groupId of groups) {
      if (states.get(groupId) === "done") continue;
      const path: string[] = [];
      let cursor: string | null | undefined = groupId;
      while (cursor !== null && cursor !== undefined && states.get(cursor) !== "done") {
        if (states.get(cursor) === "visiting") {
          throw new WorkspaceGraphValidationError("layout group parent cycle detected");
        }
        states.set(cursor, "visiting");
        path.push(cursor);
        cursor = parents.get(cursor);
      }
      for (const pathGroupId of path) states.set(pathGroupId, "done");
    }
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
