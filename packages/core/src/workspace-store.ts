import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { StoreClock } from "./store.ts";
import type {
  ArtifactPublicationExpectation,
  CreateArtifactRevisionInput,
  CreateKernelRevisionInput,
  KernelImpactAnalysis,
  KernelPublicationExpectation,
  NewWorkspaceNode,
  ProjectWorkspace,
  SharedDesignKernelRevision,
  WorkspaceGraph,
  WorkspaceGraphCommand,
  WorkspaceGraphMutationInput,
  WorkspaceGraphMutationResult,
  WorkspaceLayout,
  WorkspaceLayoutCommand,
  WorkspaceLayoutPatch,
  WorkspaceNode,
  WorkspaceSnapshotProvenance,
  WorkspaceSnapshotPublicationInput,
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
  asArtifactRevisionDependency,
  asArtifactRevisionResourcePin,
  asArtifactTrack,
  asProjectWorkspace,
  asSharedDesignKernelRevision,
  asWorkspaceArtifact,
  asWorkspaceEdge,
  asWorkspaceGraphRevision,
  asWorkspaceNode,
  asWorkspaceSnapshotBase,
  compareBinary,
  isWellFormedUtf16,
  normalizeArtifactPublicationExpectation,
  normalizeCreateArtifactRevisionInput,
  normalizeCreateKernelRevisionInput,
  normalizeKernelPublicationExpectation,
  normalizeWorkspaceGraphMutationInput,
  normalizeWorkspaceLayoutId,
  normalizeWorkspaceLayoutPatch,
  normalizeWorkspaceSnapshotPublicationInput,
  WorkspaceStoreCodecError,
  type ArtifactRevisionDependencyRecord,
  type ArtifactRevisionRecord,
  type ArtifactRevisionResourcePinRecord,
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
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUtf16(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function asOwnedArtifactRevision(row: Row): ArtifactRevisionRecord {
  const revision = asArtifactRevision(row);
  if (revision.artifactRoot !== requiredCell(row.owning_source_root, "owning Artifact source root")) {
    throw new WorkspaceGraphValidationError(
      `Artifact Revision ${revision.id} root does not match its owning Artifact source root`,
    );
  }
  return revision;
}

function safePathSegment(value: string): string {
  if (value.length <= 90 && /^(?!\.{1,2}$)[a-z0-9_-]+$/.test(value)) return `raw-${value}`;
  return `hash-${checksum(`workspace-path-segment-v1\0${value}`)}`;
}

function artifactSourceRoot(workspaceId: string, artifactId: string): string {
  return `workspaces/${safePathSegment(workspaceId)}/artifacts/${safePathSegment(artifactId)}`;
}

function graphsAreSemanticallyEqual(left: WorkspaceGraph, right: WorkspaceGraph): boolean {
  const byId = <T extends { id: string }>(values: readonly T[]): T[] => (
    [...values].sort((a, b) => compareBinary(a.id, b.id))
  );
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

type WorkspaceSnapshotBaseRecord = ReturnType<typeof asWorkspaceSnapshotBase>;

interface WorkspaceReadContext {
  artifactRevisions: Map<string, ArtifactRevisionRecord>;
  validatedArtifactRevisionIds: Set<string>;
  visitingArtifactRevisionIds: Set<string>;
  kernelRevisions: Map<string, SharedDesignKernelRevision>;
  validatedKernelRevisionIds: Set<string>;
  visitingKernelRevisionIds: Set<string>;
  snapshotBases: Map<string, WorkspaceSnapshotBaseRecord>;
  validatedSnapshotBaseIds: Set<string>;
  visitingSnapshotBaseIds: Set<string>;
  snapshotRecords: Map<string, WorkspaceSnapshotRecord>;
  visitingSnapshotRecordIds: Set<string>;
}

function createWorkspaceReadContext(): WorkspaceReadContext {
  return {
    artifactRevisions: new Map(),
    validatedArtifactRevisionIds: new Set(),
    visitingArtifactRevisionIds: new Set(),
    kernelRevisions: new Map(),
    validatedKernelRevisionIds: new Set(),
    visitingKernelRevisionIds: new Set(),
    snapshotBases: new Map(),
    validatedSnapshotBaseIds: new Set(),
    visitingSnapshotBaseIds: new Set(),
    snapshotRecords: new Map(),
    visitingSnapshotRecordIds: new Set(),
  };
}

export type WorkspacePointerKind = "artifact-head" | "kernel-head" | "active-snapshot";

export class WorkspacePointerConflictError extends Error {
  readonly pointer: WorkspacePointerKind;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly expectedId: string | null;
  readonly actualId: string | null;

  constructor(input: {
    pointer: WorkspacePointerKind;
    workspaceId: string;
    ownerId: string;
    expectedId: string | null;
    actualId: string | null;
  }) {
    super(`${input.pointer} conflict for ${input.ownerId}: expected ${input.expectedId ?? "null"}, current ${input.actualId ?? "null"}`);
    this.name = "WorkspacePointerConflictError";
    this.pointer = input.pointer;
    this.workspaceId = input.workspaceId;
    this.ownerId = input.ownerId;
    this.expectedId = input.expectedId;
    this.actualId = input.actualId;
  }
}

export class WorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly clock: StoreClock;
  private activeReadContext: WorkspaceReadContext | null = null;

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
      const immutable = this.requireGraphRevision(workspace.id, workspace.graphRevision);
      if (!graphsAreSemanticallyEqual(graph, immutable)) {
        throw new WorkspaceGraphValidationError(
          "mutable workspace graph does not match immutable graph revision",
        );
      }
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

  getArtifact(artifactId: string): WorkspaceArtifactRecord | null {
    const row = this.db.prepare("SELECT * FROM workspace_artifacts WHERE id = ?").get(artifactId) as Row | undefined;
    return row ? asWorkspaceArtifact(row) : null;
  }

  getTrack(trackId: string): ArtifactTrackRecord | null {
    const row = this.db.prepare("SELECT * FROM artifact_tracks WHERE id = ?").get(trackId) as Row | undefined;
    return row ? asArtifactTrack(row) : null;
  }

  getArtifactRevision(revisionId: string): ArtifactRevisionRecord | null {
    return this.transactionRead(() => {
      const revision = this.loadArtifactRevision(revisionId);
      if (revision === null) return null;
      this.validateArtifactRevisionLineage(revision);
      return revision;
    });
  }

  listArtifactRevisionDependencies(revisionId: string): ArtifactRevisionDependencyRecord[] {
    return this.transactionRead(() => {
      const revision = this.requireArtifactRevision(revisionId);
      const rows = this.db.prepare(
        `SELECT * FROM artifact_revision_dependencies
         WHERE revision_id = ? ORDER BY instance_id ASC`,
      ).all(revisionId) as Row[];
      const dependencies = rows.map(asArtifactRevisionDependency);
      this.validateArtifactDependencyRecords(revision, dependencies);
      return dependencies;
    });
  }

  listArtifactRevisionResourcePins(revisionId: string): ArtifactRevisionResourcePinRecord[] {
    return this.transactionRead(() => {
      const revision = this.requireArtifactRevision(revisionId);
      const rows = this.db.prepare(
        `SELECT * FROM artifact_revision_resources
         WHERE revision_id = ? ORDER BY resource_id ASC`,
      ).all(revisionId) as Row[];
      const pins = rows.map(asArtifactRevisionResourcePin);
      this.validateArtifactResourcePinRecords(revision, pins);
      return pins;
    });
  }

  getKernelRevision(revisionId: string): SharedDesignKernelRevision | null {
    return this.transactionRead(() => {
      const revision = this.loadKernelRevision(revisionId);
      if (revision === null) return null;
      this.validateKernelRevisionLineage(revision);
      return revision;
    });
  }

  analyzeKernelImpact(revisionId: string, baseSnapshotId: string): KernelImpactAnalysis {
    return this.transactionRead(() => {
      const revision = this.requireKernelRevision(revisionId);
      const snapshot = this.requireSnapshot(revision.workspaceId, baseSnapshotId);
      return this.computeKernelImpact(revision, snapshot);
    });
  }

  createArtifactRevision(unsafeInput: CreateArtifactRevisionInput): ArtifactRevisionRecord {
    const input = normalizeCreateArtifactRevisionInput(unsafeInput);
    return this.transactionImmediate(() => {
      const artifact = this.requireArtifact(input.artifactId);
      const track = this.requireTrack(input.trackId);
      if (artifact.archivedAt !== null) throw new WorkspaceGraphValidationError(`Artifact ${artifact.id} is archived`);
      if (artifact.sourceRoot !== artifactSourceRoot(artifact.workspaceId, artifact.id)) {
        throw new WorkspaceGraphValidationError(`Artifact ${artifact.id} does not have its server-derived source root`);
      }
      if (artifact.activeTrackId !== track.id || track.artifactId !== artifact.id) {
        throw new WorkspaceGraphValidationError(`Artifact Revision must target Artifact ${artifact.id}'s active Track`);
      }
      this.guardPointer({
        pointer: "artifact-head",
        workspaceId: artifact.workspaceId,
        ownerId: track.id,
        expectedId: input.parentRevisionId,
        actualId: track.headRevisionId,
      });
      const kernel = this.requireKernelRevision(input.kernelRevisionId);
      if (kernel.workspaceId !== artifact.workspaceId) {
        throw new WorkspaceGraphValidationError("Artifact Revision Kernel belongs to another Workspace");
      }
      this.validateRunOwnership(artifact.workspaceId, input.producedByRunId ?? null, "Artifact Revision");
      this.validateArtifactRevisionPins(artifact, input);
      const sequence = this.nextSafeSequence(
        "artifact_revisions",
        "track_id",
        track.id,
        "Artifact Revision",
      );
      const revisionId = this.clock.id();
      const now = this.clock.now();
      this.db.prepare(
        `INSERT INTO artifact_revisions (
           id, workspace_id, artifact_id, track_id, sequence, parent_revision_id,
           source_commit_hash, source_tree_hash, artifact_root, kernel_revision_id,
           render_spec_json, quality_json, context_pack_hash, produced_by_run_id,
           legacy_run_id, created_at, sealed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      ).run(
        revisionId,
        artifact.workspaceId,
        artifact.id,
        track.id,
        sequence,
        input.parentRevisionId,
        input.sourceCommitHash,
        input.sourceTreeHash,
        artifact.sourceRoot,
        input.kernelRevisionId,
        JSON.stringify(input.renderSpec),
        JSON.stringify(input.quality),
        input.contextPackHash ?? null,
        input.producedByRunId ?? null,
        now,
      );
      const insertDependency = this.db.prepare(
        `INSERT INTO artifact_revision_dependencies (
           workspace_id, owner_artifact_id, revision_id, instance_id, component_artifact_id,
           component_revision_id, variant_key, state_key, design_node_id,
           source_locator_json, overrides_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const dependency of input.dependencies) {
        const existing = this.db.prepare(
          "SELECT * FROM component_instances WHERE id = ?",
        ).get(dependency.instanceId) as Row | undefined;
        if (dependency.createInstanceIdentity === true) {
          if (existing) throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} already exists`);
          this.db.prepare(
            `INSERT INTO component_instances
               (id, workspace_id, owner_artifact_id, component_artifact_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(dependency.instanceId, artifact.workspaceId, artifact.id, dependency.componentArtifactId, now);
        } else if (!existing) {
          throw new WorkspaceGraphValidationError(
            `Component Instance ${dependency.instanceId} does not exist; createInstanceIdentity is required`,
          );
        } else if (existing.workspace_id !== artifact.workspaceId
          || existing.owner_artifact_id !== artifact.id
          || existing.component_artifact_id !== dependency.componentArtifactId) {
          throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} identity collision`);
        }
        insertDependency.run(
          artifact.workspaceId,
          artifact.id,
          revisionId,
          dependency.instanceId,
          dependency.componentArtifactId,
          dependency.componentRevisionId,
          dependency.variantKey ?? null,
          dependency.stateKey ?? null,
          dependency.sourceLocator.designNodeId,
          JSON.stringify(dependency.sourceLocator),
          JSON.stringify(dependency.overrides),
          dependency.status,
        );
      }
      const insertResourcePin = this.db.prepare(
        `INSERT INTO artifact_revision_resources
           (workspace_id, owner_artifact_id, revision_id, resource_id, resource_revision_id)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const pin of input.resourcePins) {
        insertResourcePin.run(artifact.workspaceId, artifact.id, revisionId, pin.resourceId, pin.resourceRevisionId);
      }
      const sealed = this.db.prepare(
        "UPDATE artifact_revisions SET sealed = 1 WHERE id = ? AND sealed = 0",
      ).run(revisionId);
      if (Number(sealed.changes) !== 1) {
        throw new WorkspaceGraphValidationError(`Artifact Revision ${revisionId} could not be sealed`);
      }
      return this.requireArtifactRevision(revisionId);
    });
  }

  publishArtifactRevision(
    revisionId: string,
    unsafeExpected: ArtifactPublicationExpectation,
  ): WorkspaceSnapshotRecord {
    const expected = normalizeArtifactPublicationExpectation(unsafeExpected);
    return this.transactionImmediate(() => {
      const revision = this.requireArtifactRevision(revisionId);
      const artifact = this.requireArtifact(revision.artifactId);
      const track = this.requireTrack(revision.trackId);
      if (artifact.workspaceId !== revision.workspaceId
        || artifact.activeTrackId !== track.id
        || track.artifactId !== artifact.id) {
        throw new WorkspaceGraphValidationError("Artifact publication target is not the active Track");
      }
      if (artifact.sourceRoot !== artifactSourceRoot(artifact.workspaceId, artifact.id)
        || revision.artifactRoot !== artifact.sourceRoot) {
        throw new WorkspaceGraphValidationError(
          "Artifact publication root must match the owning Artifact's server-derived source root",
        );
      }
      if (revision.parentRevisionId !== expected.expectedHeadRevisionId) {
        throw new WorkspaceGraphValidationError("Artifact Revision parent does not match the expected Head");
      }
      this.guardPointer({
        pointer: "artifact-head",
        workspaceId: revision.workspaceId,
        ownerId: track.id,
        expectedId: expected.expectedHeadRevisionId,
        actualId: track.headRevisionId,
      });
      const workspace = this.requireWorkspaceById(revision.workspaceId);
      this.validateArtifactCandidateForPublication(revision, expected.expectedHeadRevisionId);
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: expected.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      const parent = this.requireSnapshot(workspace.id, expected.expectedSnapshotId);
      if (revision.kernelRevisionId !== parent.kernelRevisionId) {
        throw new WorkspaceGraphValidationError(
          "Artifact publication Kernel must match the expected base Snapshot Kernel",
        );
      }
      const derived = this.deriveUsesGraphForArtifactPublication(workspace, parent, revision);
      if (derived.changed) {
        this.reconcileDerivedUsesEdges(derived.graph);
        this.insertImmutableGraphRevision(derived.graph);
      }
      const movedHead = this.db.prepare(
        `UPDATE artifact_tracks SET head_revision_id = ?
         WHERE id = ? AND artifact_id = ? AND head_revision_id IS ?`,
      ).run(revision.id, track.id, artifact.id, expected.expectedHeadRevisionId);
      if (Number(movedHead.changes) !== 1) {
        const actual = this.requireTrack(track.id);
        throw new WorkspacePointerConflictError({
          pointer: "artifact-head",
          workspaceId: workspace.id,
          ownerId: track.id,
          expectedId: expected.expectedHeadRevisionId,
          actualId: actual.headRevisionId,
        });
      }
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: expected.expectedSnapshotId,
        graphRevision: derived.graph.revision,
        reason: "artifact-published",
        provenance: {
          kind: "artifact-publication",
          revisionId: revision.id,
          ...(revision.producedByRunId === null ? {} : { runId: revision.producedByRunId }),
        },
        artifactOverrides: [{
          artifactId: revision.artifactId,
          trackId: revision.trackId,
          revisionId: revision.id,
        }],
        createdByRunId: revision.producedByRunId,
      });
      const movedSnapshot = this.db.prepare(
        `UPDATE project_workspaces
         SET graph_revision = ?, active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND graph_revision = ? AND active_snapshot_id IS ?`,
      ).run(
        derived.graph.revision,
        snapshot.id,
        this.clock.now(),
        workspace.id,
        workspace.graphRevision,
        expected.expectedSnapshotId,
      );
      if (Number(movedSnapshot.changes) !== 1) {
        const actual = this.requireWorkspaceById(workspace.id);
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          workspaceId: workspace.id,
          ownerId: workspace.id,
          expectedId: expected.expectedSnapshotId,
          actualId: actual.activeSnapshotId,
        });
      }
      return snapshot;
    });
  }

  createKernelRevision(unsafeInput: CreateKernelRevisionInput): SharedDesignKernelRevision {
    const input = normalizeCreateKernelRevisionInput(unsafeInput);
    return this.transactionImmediate(() => {
      const workspace = this.requireWorkspaceById(input.workspaceId);
      this.guardPointer({
        pointer: "kernel-head",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: input.parentRevisionId,
        actualId: workspace.activeKernelRevisionId,
      });
      this.validateKernelSharedAssets(workspace.id, input.sharedAssetRevisionIds);
      const sequence = this.nextSafeSequence(
        "shared_design_kernel_revisions",
        "workspace_id",
        workspace.id,
        "Shared Design Kernel Revision",
      );
      const payload = {
        tokens: input.tokens,
        typography: input.typography,
        sharedAssetRevisionIds: input.sharedAssetRevisionIds,
        brief: input.brief,
        terminology: input.terminology,
        exclusions: input.exclusions,
        responsiveFrames: input.responsiveFrames,
        qualityProfile: input.qualityProfile,
      };
      const payloadJson = JSON.stringify(payload);
      const revisionId = this.clock.id();
      this.db.prepare(
        `INSERT INTO shared_design_kernel_revisions
           (id, workspace_id, sequence, parent_revision_id, payload_json, checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revisionId,
        workspace.id,
        sequence,
        input.parentRevisionId,
        payloadJson,
        checksum(payloadJson),
        this.clock.now(),
      );
      return this.requireKernelRevision(revisionId);
    });
  }

  publishKernelRevision(
    revisionId: string,
    unsafeExpected: KernelPublicationExpectation,
  ): WorkspaceSnapshotRecord {
    const expected = normalizeKernelPublicationExpectation(unsafeExpected);
    return this.transactionImmediate(() => {
      const revision = this.requireKernelRevision(revisionId);
      const workspace = this.requireWorkspaceById(revision.workspaceId);
      if (revision.parentRevisionId !== expected.expectedKernelRevisionId) {
        throw new WorkspaceGraphValidationError("Kernel Revision parent does not match the expected active Kernel");
      }
      const parentKernel = this.requireKernelRevision(expected.expectedKernelRevisionId);
      if (parentKernel.workspaceId !== workspace.id || parentKernel.sequence >= revision.sequence) {
        throw new WorkspaceGraphValidationError(
          "Kernel Revision parent must be an earlier Revision in the same Workspace",
        );
      }
      this.guardPointer({
        pointer: "kernel-head",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: expected.expectedKernelRevisionId,
        actualId: workspace.activeKernelRevisionId,
      });
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: expected.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      const parent = this.requireSnapshot(workspace.id, expected.expectedSnapshotId);
      const impact = this.computeKernelImpact(revision, parent);
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: expected.expectedSnapshotId,
        graphRevision: workspace.graphRevision,
        kernelRevisionId: revision.id,
        reason: "kernel-published",
        provenance: { kind: "kernel-publication", kernelRevisionId: revision.id, impact },
      });
      const moved = this.db.prepare(
        `UPDATE project_workspaces
         SET active_kernel_revision_id = ?, active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND active_kernel_revision_id = ? AND active_snapshot_id = ? AND graph_revision = ?`,
      ).run(
        revision.id,
        snapshot.id,
        this.clock.now(),
        workspace.id,
        expected.expectedKernelRevisionId,
        expected.expectedSnapshotId,
        workspace.graphRevision,
      );
      if (Number(moved.changes) !== 1) {
        const actual = this.requireWorkspaceById(workspace.id);
        if (actual.activeKernelRevisionId !== expected.expectedKernelRevisionId) {
          throw new WorkspacePointerConflictError({
            pointer: "kernel-head",
            workspaceId: workspace.id,
            ownerId: workspace.id,
            expectedId: expected.expectedKernelRevisionId,
            actualId: actual.activeKernelRevisionId,
          });
        }
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          workspaceId: workspace.id,
          ownerId: workspace.id,
          expectedId: expected.expectedSnapshotId,
          actualId: actual.activeSnapshotId,
        });
      }
      return snapshot;
    });
  }

  createWorkspaceSnapshot(
    projectId: string,
    unsafeInput: WorkspaceSnapshotPublicationInput,
  ): WorkspaceSnapshotRecord {
    const input = normalizeWorkspaceSnapshotPublicationInput(unsafeInput);
    this.validatePublicCheckpointProvenance(input.provenance);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: input.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      this.validateRunOwnership(workspace.id, input.createdByRunId ?? null, "Workspace Snapshot");
      return this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: input.expectedSnapshotId,
        graphRevision: workspace.graphRevision,
        reason: input.reason,
        provenance: input.provenance,
        createdByRunId: input.createdByRunId ?? null,
      });
    });
  }

  publishSnapshot(
    projectId: string,
    unsafeInput: WorkspaceSnapshotPublicationInput,
  ): WorkspaceSnapshotRecord {
    const input = normalizeWorkspaceSnapshotPublicationInput(unsafeInput);
    this.validatePublicCheckpointProvenance(input.provenance);
    return this.transactionImmediate(() => {
      const workspace = requireWorkspace(this.getWorkspace(projectId), projectId);
      this.guardPointer({
        pointer: "active-snapshot",
        workspaceId: workspace.id,
        ownerId: workspace.id,
        expectedId: input.expectedSnapshotId,
        actualId: workspace.activeSnapshotId,
      });
      this.validateRunOwnership(workspace.id, input.createdByRunId ?? null, "Workspace Snapshot");
      const snapshot = this.createSnapshotInTransaction(workspace.id, {
        expectedSnapshotId: input.expectedSnapshotId,
        graphRevision: workspace.graphRevision,
        reason: input.reason,
        provenance: input.provenance,
        createdByRunId: input.createdByRunId ?? null,
      });
      const moved = this.db.prepare(
        `UPDATE project_workspaces SET active_snapshot_id = ?, updated_at = ?
         WHERE id = ? AND active_snapshot_id = ? AND graph_revision = ? AND active_kernel_revision_id = ?`,
      ).run(
        snapshot.id,
        this.clock.now(),
        workspace.id,
        input.expectedSnapshotId,
        workspace.graphRevision,
        workspace.activeKernelRevisionId,
      );
      if (Number(moved.changes) !== 1) {
        const actual = this.requireWorkspaceById(workspace.id);
        throw new WorkspacePointerConflictError({
          pointer: "active-snapshot",
          workspaceId: workspace.id,
          ownerId: workspace.id,
          expectedId: input.expectedSnapshotId,
          actualId: actual.activeSnapshotId,
        });
      }
      return snapshot;
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
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return [];
      const rows = this.db.prepare(
        `SELECT revision.*, artifact.source_root AS owning_source_root
         FROM artifact_revisions revision
         JOIN workspace_artifacts artifact
           ON artifact.id = revision.artifact_id AND artifact.workspace_id = revision.workspace_id
         WHERE revision.workspace_id = ? AND revision.artifact_id = ?
         ORDER BY revision.created_at ASC, revision.id ASC`,
      ).all(workspace.id, artifactId) as Row[];
      const context = this.readContext();
      const revisions = rows.map((row) => {
        const revision = asOwnedArtifactRevision(row);
        context.artifactRevisions.set(revision.id, revision);
        return revision;
      });
      return revisions.map((revision) => {
        this.validateArtifactRevisionLineage(revision);
        return revision;
      });
    });
  }

  listSnapshots(projectId: string): WorkspaceSnapshotRecord[] {
    return this.transactionRead(() => {
      const workspace = this.getWorkspace(projectId);
      if (!workspace) return [];
      const rows = this.db.prepare(
        `SELECT * FROM workspace_snapshots
         WHERE workspace_id = ?
         ORDER BY sequence ASC, id ASC`,
      ).all(workspace.id) as Row[];
      const context = this.readContext();
      const snapshots = rows.map((row) => {
        const snapshot = asWorkspaceSnapshotBase(row);
        context.snapshotBases.set(snapshot.id, snapshot);
        return snapshot;
      });
      return snapshots.map((snapshot) => this.requireSnapshot(workspace.id, snapshot.id));
    });
  }

  private requireWorkspaceById(workspaceId: string): ProjectWorkspace {
    const row = this.db.prepare(
      `SELECT workspace.*, project.mode
       FROM project_workspaces workspace
       JOIN projects project ON project.id = workspace.project_id
       WHERE workspace.id = ?`,
    ).get(workspaceId) as Row | undefined;
    if (!row) throw new Error(`workspace not found: ${workspaceId}`);
    return asProjectWorkspace(row);
  }

  private requireArtifact(artifactId: string): WorkspaceArtifactRecord {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    return artifact;
  }

  private requireTrack(trackId: string): ArtifactTrackRecord {
    const track = this.getTrack(trackId);
    if (!track) throw new Error(`Artifact Track not found: ${trackId}`);
    return track;
  }

  private loadArtifactRevision(revisionId: string): ArtifactRevisionRecord | null {
    const context = this.readContext();
    const cached = context.artifactRevisions.get(revisionId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      `SELECT revision.*, artifact.source_root AS owning_source_root
       FROM artifact_revisions revision
       JOIN workspace_artifacts artifact
         ON artifact.id = revision.artifact_id AND artifact.workspace_id = revision.workspace_id
       WHERE revision.id = ?`,
    ).get(revisionId) as Row | undefined;
    if (!row) return null;
    const revision = asOwnedArtifactRevision(row);
    context.artifactRevisions.set(revision.id, revision);
    return revision;
  }

  private requireArtifactRevision(revisionId: string): ArtifactRevisionRecord {
    const revision = this.loadArtifactRevision(revisionId);
    if (!revision) throw new Error(`Artifact Revision not found: ${revisionId}`);
    this.validateArtifactRevisionLineage(revision);
    return revision;
  }

  private loadKernelRevision(revisionId: string): SharedDesignKernelRevision | null {
    const context = this.readContext();
    const cached = context.kernelRevisions.get(revisionId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      "SELECT * FROM shared_design_kernel_revisions WHERE id = ?",
    ).get(revisionId) as Row | undefined;
    if (!row) return null;
    const revision = asSharedDesignKernelRevision(row);
    context.kernelRevisions.set(revision.id, revision);
    return revision;
  }

  private requireKernelRevision(revisionId: string): SharedDesignKernelRevision {
    const revision = this.loadKernelRevision(revisionId);
    if (!revision) throw new Error(`Shared Design Kernel Revision not found: ${revisionId}`);
    this.validateKernelRevisionLineage(revision);
    return revision;
  }

  private validateArtifactRevisionReferences(revision: ArtifactRevisionRecord): void {
    const track = this.requireTrack(revision.trackId);
    const kernel = this.requireKernelRevision(revision.kernelRevisionId);
    if (track.artifactId !== revision.artifactId || kernel.workspaceId !== revision.workspaceId) {
      throw new WorkspaceGraphValidationError(
        `Artifact Revision ${revision.id} has a cross-owner Track or Kernel reference`,
      );
    }
    this.validateRunOwnership(revision.workspaceId, revision.producedByRunId, "Artifact Revision");
  }

  private validateArtifactRevisionLineage(revision: ArtifactRevisionRecord): void {
    const context = this.readContext();
    if (context.validatedArtifactRevisionIds.has(revision.id)) return;
    const path: ArtifactRevisionRecord[] = [];
    let child = revision;
    try {
      while (!context.validatedArtifactRevisionIds.has(child.id)) {
        if (context.visitingArtifactRevisionIds.has(child.id)) {
          throw new WorkspaceGraphValidationError(`Artifact Revision ${revision.id} parent lineage contains a cycle`);
        }
        context.visitingArtifactRevisionIds.add(child.id);
        path.push(child);
        this.validateArtifactRevisionReferences(child);
        if (child.parentRevisionId === null) break;
        const parent = this.loadArtifactRevision(child.parentRevisionId);
        if (parent === null) {
          throw new WorkspaceGraphValidationError(`Artifact Revision ${revision.id} parent is not resolvable`);
        }
        if (parent.workspaceId !== child.workspaceId
          || parent.artifactId !== child.artifactId
          || parent.trackId !== child.trackId
          || parent.sequence >= child.sequence) {
          throw new WorkspaceGraphValidationError(
            `Artifact Revision ${revision.id} parent must be an earlier sealed Revision on the same Track`,
          );
        }
        child = parent;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        context.validatedArtifactRevisionIds.add(path[index]!.id);
      }
    } finally {
      for (const traversed of path) context.visitingArtifactRevisionIds.delete(traversed.id);
    }
  }

  private validateKernelRevisionLineage(revision: SharedDesignKernelRevision): void {
    const context = this.readContext();
    if (context.validatedKernelRevisionIds.has(revision.id)) return;
    const path: SharedDesignKernelRevision[] = [];
    let child = revision;
    try {
      while (!context.validatedKernelRevisionIds.has(child.id)) {
        if (context.visitingKernelRevisionIds.has(child.id)) {
          throw new WorkspaceGraphValidationError(`Kernel Revision ${revision.id} parent lineage contains a cycle`);
        }
        context.visitingKernelRevisionIds.add(child.id);
        path.push(child);
        this.validateKernelSharedAssets(child.workspaceId, child.sharedAssetRevisionIds);
        if (child.parentRevisionId === null) break;
        const parent = this.loadKernelRevision(child.parentRevisionId);
        if (parent === null) {
          throw new WorkspaceGraphValidationError(`Kernel Revision ${revision.id} parent is not resolvable`);
        }
        if (parent.workspaceId !== child.workspaceId || parent.sequence >= child.sequence) {
          throw new WorkspaceGraphValidationError(
            `Kernel Revision ${revision.id} parent must be an earlier Revision in the same Workspace`,
          );
        }
        child = parent;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        context.validatedKernelRevisionIds.add(path[index]!.id);
      }
    } finally {
      for (const traversed of path) context.visitingKernelRevisionIds.delete(traversed.id);
    }
  }

  private validateArtifactDependencyRecords(
    revision: ArtifactRevisionRecord,
    dependencies: readonly ArtifactRevisionDependencyRecord[],
  ): void {
    const instances = new Set<string>();
    for (const dependency of dependencies) {
      if (instances.has(dependency.instanceId)) {
        throw new WorkspaceGraphValidationError(`duplicate Component Instance ${dependency.instanceId}`);
      }
      instances.add(dependency.instanceId);
      if (dependency.workspaceId !== revision.workspaceId
        || dependency.ownerArtifactId !== revision.artifactId
        || dependency.revisionId !== revision.id
        || dependency.componentArtifactId === revision.artifactId) {
        throw new WorkspaceGraphValidationError(
          `Artifact Revision ${revision.id} has a cross-owner Component dependency`,
        );
      }
      const componentRevision = this.requireArtifactRevision(dependency.componentRevisionId);
      const component = this.requireArtifact(dependency.componentArtifactId);
      const componentTrack = this.requireTrack(componentRevision.trackId);
      const instance = this.db.prepare(
        `SELECT 1 FROM component_instances
         WHERE id = ? AND workspace_id = ? AND owner_artifact_id = ? AND component_artifact_id = ?`,
      ).get(
        dependency.instanceId,
        revision.workspaceId,
        revision.artifactId,
        dependency.componentArtifactId,
      );
      if (component.workspaceId !== revision.workspaceId
        || component.kind !== "component"
        || componentRevision.workspaceId !== revision.workspaceId
        || componentRevision.artifactId !== dependency.componentArtifactId
        || componentTrack.artifactId !== dependency.componentArtifactId
        || !instance) {
        throw new WorkspaceGraphValidationError(
          `Component Revision ${dependency.componentRevisionId} is not an exact stable same-Workspace pin`,
        );
      }
    }
  }

  private validateArtifactResourcePinRecords(
    revision: ArtifactRevisionRecord,
    pins: readonly ArtifactRevisionResourcePinRecord[],
  ): void {
    const resources = new Set<string>();
    for (const pin of pins) {
      if (resources.has(pin.resourceId)) {
        throw new WorkspaceGraphValidationError(`duplicate Artifact Revision Resource pin ${pin.resourceId}`);
      }
      resources.add(pin.resourceId);
      const owned = this.db.prepare(
        `SELECT 1
         FROM resource_revisions resource_revision
         JOIN resources resource
           ON resource.id = resource_revision.resource_id
          AND resource.workspace_id = resource_revision.workspace_id
         WHERE resource_revision.id = ? AND resource_revision.resource_id = ?
           AND resource_revision.workspace_id = ?`,
      ).get(pin.resourceRevisionId, pin.resourceId, revision.workspaceId);
      if (pin.workspaceId !== revision.workspaceId
        || pin.ownerArtifactId !== revision.artifactId
        || pin.revisionId !== revision.id
        || !owned) {
        throw new WorkspaceGraphValidationError(
          `Resource Revision ${pin.resourceRevisionId} is not an exact same-Workspace Resource pin`,
        );
      }
    }
  }

  private validateArtifactCandidateForPublication(
    revision: ArtifactRevisionRecord,
    expectedParentRevisionId: string | null,
  ): void {
    if (revision.parentRevisionId !== expectedParentRevisionId) {
      throw new WorkspaceGraphValidationError("Artifact Revision parent does not match the expected Head");
    }
    this.validateArtifactRevisionLineage(revision);
    this.listArtifactRevisionDependencies(revision.id);
    this.listArtifactRevisionResourcePins(revision.id);
  }

  private loadSnapshotBase(snapshotId: string): WorkspaceSnapshotBaseRecord | null {
    const context = this.readContext();
    const cached = context.snapshotBases.get(snapshotId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare(
      "SELECT * FROM workspace_snapshots WHERE id = ?",
    ).get(snapshotId) as Row | undefined;
    if (!row) return null;
    const snapshot = asWorkspaceSnapshotBase(row);
    context.snapshotBases.set(snapshot.id, snapshot);
    return snapshot;
  }

  private validateSnapshotLineage(snapshot: WorkspaceSnapshotBaseRecord): void {
    const context = this.readContext();
    if (context.validatedSnapshotBaseIds.has(snapshot.id)) return;
    const path: WorkspaceSnapshotBaseRecord[] = [];
    let child = snapshot;
    try {
      while (!context.validatedSnapshotBaseIds.has(child.id)) {
        if (context.visitingSnapshotBaseIds.has(child.id)) {
          throw new WorkspaceGraphValidationError(`Workspace Snapshot ${snapshot.id} parent lineage contains a cycle`);
        }
        context.visitingSnapshotBaseIds.add(child.id);
        path.push(child);
        const kernel = this.requireKernelRevision(child.kernelRevisionId);
        if (kernel.workspaceId !== child.workspaceId) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} parent Kernel belongs to another Workspace`,
          );
        }
        this.validateRunOwnership(child.workspaceId, child.createdByRunId, "Workspace Snapshot");
        if (child.parentSnapshotId === null) break;
        const parent = this.loadSnapshotBase(child.parentSnapshotId);
        if (parent === null) {
          throw new WorkspaceGraphValidationError(`Workspace Snapshot ${snapshot.id} parent is not resolvable`);
        }
        if (parent.workspaceId !== child.workspaceId || parent.sequence >= child.sequence) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} parent must be an earlier sealed Snapshot in the same Workspace`,
          );
        }
        child = parent;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        context.validatedSnapshotBaseIds.add(path[index]!.id);
      }
    } finally {
      for (const traversed of path) context.visitingSnapshotBaseIds.delete(traversed.id);
    }
  }

  private guardPointer(input: {
    pointer: WorkspacePointerKind;
    workspaceId: string;
    ownerId: string;
    expectedId: string | null;
    actualId: string | null;
  }): void {
    if (input.expectedId !== input.actualId) throw new WorkspacePointerConflictError(input);
  }

  private nextSafeSequence(
    table: "artifact_revisions" | "shared_design_kernel_revisions" | "workspace_snapshots",
    ownerColumn: "track_id" | "workspace_id",
    ownerId: string,
    label: string,
  ): number {
    const rows = this.db.prepare(
      `SELECT CAST(sequence AS TEXT) AS sequence_text, typeof(sequence) AS sequence_type
       FROM ${table} WHERE ${ownerColumn} = ?`,
    ).all(ownerId) as Array<{ sequence_text: unknown; sequence_type: unknown }>;
    let max = 0n;
    for (const row of rows) {
      if (row.sequence_type !== "integer"
        || typeof row.sequence_text !== "string"
        || !/^[1-9][0-9]*$/.test(row.sequence_text)) {
        throw new WorkspaceGraphValidationError(`next ${label} sequence must be a positive safe integer`);
      }
      const sequence = BigInt(row.sequence_text);
      if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WorkspaceGraphValidationError(`next ${label} sequence must be a positive safe integer`);
      }
      if (sequence > max) max = sequence;
    }
    if (max >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WorkspaceGraphValidationError(`next ${label} sequence must be a positive safe integer`);
    }
    return Number(max) + 1;
  }

  private validateRunOwnership(workspaceId: string, runId: string | null, label: string): void {
    if (runId === null) return;
    const row = this.db.prepare(
      `SELECT 1
       FROM runs run
       JOIN project_workspaces workspace ON workspace.project_id = run.project_id
       WHERE workspace.id = ? AND run.id = ?`,
    ).get(workspaceId, runId);
    if (!row) throw new WorkspaceGraphValidationError(`${label} Run belongs to another Project or does not exist`);
  }

  private validateArtifactRevisionPins(
    artifact: WorkspaceArtifactRecord,
    input: CreateArtifactRevisionInput,
  ): void {
    for (const dependency of input.dependencies) {
      if (dependency.componentArtifactId === artifact.id) {
        throw new WorkspaceGraphValidationError("an Artifact cannot use itself as a Component dependency");
      }
      const component = this.db.prepare(
        `SELECT component.workspace_id, component.kind, revision.artifact_id AS revision_artifact_id
         FROM workspace_artifacts component
         JOIN artifact_revisions revision
           ON revision.artifact_id = component.id AND revision.workspace_id = component.workspace_id
         WHERE component.id = ? AND revision.id = ?`,
      ).get(dependency.componentArtifactId, dependency.componentRevisionId) as {
        workspace_id: string;
        kind: string;
        revision_artifact_id: string;
      } | undefined;
      if (!component
        || component.workspace_id !== artifact.workspaceId
        || component.kind !== "component"
        || component.revision_artifact_id !== dependency.componentArtifactId) {
        throw new WorkspaceGraphValidationError(
          `Component Revision ${dependency.componentRevisionId} is not an exact same-Workspace Component pin`,
        );
      }
      const instance = this.db.prepare(
        "SELECT * FROM component_instances WHERE id = ?",
      ).get(dependency.instanceId) as Row | undefined;
      if (dependency.createInstanceIdentity === true) {
        if (instance) throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} already exists`);
      } else if (!instance) {
        throw new WorkspaceGraphValidationError(
          `Component Instance ${dependency.instanceId} does not exist; createInstanceIdentity is required`,
        );
      } else if (instance.workspace_id !== artifact.workspaceId
        || instance.owner_artifact_id !== artifact.id
        || instance.component_artifact_id !== dependency.componentArtifactId) {
        throw new WorkspaceGraphValidationError(`Component Instance ${dependency.instanceId} identity collision`);
      }
    }
    for (const pin of input.resourcePins) {
      const resource = this.db.prepare(
        `SELECT resource.workspace_id, revision.resource_id AS revision_resource_id
         FROM resources resource
         JOIN resource_revisions revision
           ON revision.resource_id = resource.id AND revision.workspace_id = resource.workspace_id
         WHERE resource.id = ? AND revision.id = ?`,
      ).get(pin.resourceId, pin.resourceRevisionId) as {
        workspace_id: string;
        revision_resource_id: string;
      } | undefined;
      if (!resource
        || resource.workspace_id !== artifact.workspaceId
        || resource.revision_resource_id !== pin.resourceId) {
        throw new WorkspaceGraphValidationError(
          `Resource Revision ${pin.resourceRevisionId} is not an exact same-Workspace Resource pin`,
        );
      }
    }
  }

  private validateKernelSharedAssets(workspaceId: string, revisionIds: readonly string[]): void {
    const seen = new Set<string>();
    for (const revisionId of revisionIds) {
      if (seen.has(revisionId)) throw new WorkspaceGraphValidationError(`duplicate shared Asset Revision ${revisionId}`);
      seen.add(revisionId);
      const row = this.db.prepare(
        `SELECT resource.workspace_id, resource.kind
         FROM resource_revisions revision
         JOIN resources resource
           ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
         WHERE revision.id = ?`,
      ).get(revisionId) as { workspace_id: string; kind: string } | undefined;
      if (!row || row.workspace_id !== workspaceId || row.kind !== "asset") {
        throw new WorkspaceGraphValidationError(
          `Shared Asset Revision ${revisionId} must belong to an Asset Resource in this Workspace`,
        );
      }
    }
  }

  private computeKernelImpact(
    target: SharedDesignKernelRevision,
    snapshot: WorkspaceSnapshotRecord,
  ): KernelImpactAnalysis {
    if (snapshot.workspaceId !== target.workspaceId
      || target.parentRevisionId !== snapshot.kernelRevisionId) {
      throw new WorkspaceGraphValidationError(
        "Kernel impact must compare a direct Kernel child against its exact base Snapshot",
      );
    }
    this.validateKernelSharedAssets(target.workspaceId, target.sharedAssetRevisionIds);
    const affectedArtifactRevisions: KernelImpactAnalysis["affectedArtifactRevisions"] = [];
    const mappings = Object.entries(snapshot.artifactRevisions)
      .sort(([left], [right]) => compareBinary(left, right));
    for (const [artifactId, revisionId] of mappings) {
      if (revisionId === null) continue;
      const revision = this.requireArtifactRevision(revisionId);
      const trackId = snapshot.artifactTracks[artifactId];
      if (trackId === undefined
        || revision.workspaceId !== target.workspaceId
        || revision.artifactId !== artifactId
        || revision.trackId !== trackId) {
        throw new WorkspaceGraphValidationError(`Kernel impact Artifact mapping ${artifactId} is corrupt`);
      }
      const pinnedKernel = this.getKernelRevision(revision.kernelRevisionId);
      if (!pinnedKernel || pinnedKernel.workspaceId !== target.workspaceId) {
        throw new WorkspaceGraphValidationError(
          `Kernel impact Artifact ${artifactId} has an invalid pinned Kernel Revision`,
        );
      }
      for (const dependency of this.listArtifactRevisionDependencies(revision.id)) {
        const componentRevision = this.getArtifactRevision(dependency.componentRevisionId);
        const instance = this.db.prepare(
          `SELECT 1 FROM component_instances
           WHERE id = ? AND workspace_id = ? AND owner_artifact_id = ? AND component_artifact_id = ?`,
        ).get(
          dependency.instanceId,
          target.workspaceId,
          artifactId,
          dependency.componentArtifactId,
        );
        if (!instance
          || !componentRevision
          || componentRevision.workspaceId !== target.workspaceId
          || componentRevision.artifactId !== dependency.componentArtifactId) {
          throw new WorkspaceGraphValidationError(
            `Kernel impact Artifact ${artifactId} has a corrupt Component dependency pin`,
          );
        }
      }
      for (const pin of this.listArtifactRevisionResourcePins(revision.id)) {
        const resource = this.db.prepare(
          `SELECT 1
           FROM resource_revisions revision
           JOIN resources resource
             ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
           WHERE revision.id = ? AND revision.resource_id = ? AND revision.workspace_id = ?`,
        ).get(pin.resourceRevisionId, pin.resourceId, target.workspaceId);
        if (!resource) {
          throw new WorkspaceGraphValidationError(
            `Kernel impact Artifact ${artifactId} has a corrupt Resource Revision pin`,
          );
        }
      }
      if (revision.kernelRevisionId !== target.id) {
        affectedArtifactRevisions.push({
          artifactId,
          revisionId: revision.id,
          pinnedKernelRevisionId: revision.kernelRevisionId,
        });
      }
    }
    return {
      workspaceId: target.workspaceId,
      baseSnapshotId: snapshot.id,
      fromKernelRevisionId: snapshot.kernelRevisionId,
      toKernelRevisionId: target.id,
      affectedArtifactRevisions,
    };
  }

  private validatePublicCheckpointProvenance(provenance: WorkspaceSnapshotProvenance): void {
    if (provenance.kind !== "plan-checkpoint") {
      throw new WorkspaceStoreCodecError(
        `public Snapshot checkpoint cannot claim ${provenance.kind} publication provenance`,
      );
    }
  }

  private deriveUsesGraphForArtifactPublication(
    workspace: ProjectWorkspace,
    parent: WorkspaceSnapshotRecord,
    revision: ArtifactRevisionRecord,
  ): { graph: WorkspaceGraph; changed: boolean } {
    if (parent.graphRevision !== workspace.graphRevision) {
      throw new WorkspaceGraphValidationError("active Snapshot graph does not match the Workspace graph pointer");
    }
    const current: WorkspaceGraph = {
      workspaceId: workspace.id,
      revision: workspace.graphRevision,
      nodes: this.listNodes(workspace.id),
      edges: this.listEdges(workspace.id),
    };
    validateWorkspaceGraph(current);
    if (!graphsAreSemanticallyEqual(current, parent.graph)) {
      throw new WorkspaceGraphValidationError("mutable Workspace graph does not match the active immutable graph");
    }
    const revisions = new Map(Object.entries(parent.artifactRevisions));
    revisions.set(revision.artifactId, revision.id);
    const artifactNodes = new Map<string, Extract<WorkspaceNode, { kind: "page" | "component" }>>();
    for (const node of current.nodes) {
      if (node.kind !== "resource") artifactNodes.set(node.artifactId, node);
    }
    const derived = new Map<string, WorkspaceGraph["edges"][number]>();
    for (const [ownerArtifactId, mappedRevisionId] of revisions) {
      if (mappedRevisionId === null) continue;
      const mappedRevision = this.requireArtifactRevision(mappedRevisionId);
      if (mappedRevision.workspaceId !== workspace.id || mappedRevision.artifactId !== ownerArtifactId) {
        throw new WorkspaceGraphValidationError(`Snapshot Artifact mapping ${ownerArtifactId} is corrupt`);
      }
      const ownerNode = artifactNodes.get(ownerArtifactId);
      if (!ownerNode) throw new WorkspaceGraphValidationError(`Artifact ${ownerArtifactId} has no active graph node`);
      for (const dependency of this.listArtifactRevisionDependencies(mappedRevisionId)) {
        if (dependency.status !== "linked") continue;
        const componentNode = artifactNodes.get(dependency.componentArtifactId);
        if (!componentNode || componentNode.kind !== "component") {
          throw new WorkspaceGraphValidationError(
            `linked Component ${dependency.componentArtifactId} has no active Component graph node`,
          );
        }
        const relationship = `${ownerArtifactId}\0${dependency.componentArtifactId}`;
        if (derived.has(relationship)) continue;
        const id = `derived-uses-${checksum(`uses-v1\0${workspace.id}\0${ownerArtifactId}\0${dependency.componentArtifactId}`)}`;
        derived.set(relationship, {
          id,
          workspaceId: workspace.id,
          kind: "uses",
          sourceNodeId: ownerNode.id,
          targetNodeId: componentNode.id,
        });
      }
    }
    const nonUses = current.edges.filter((edge) => edge.kind !== "uses");
    const nonUsesById = new Map(nonUses.map((edge) => [edge.id, edge]));
    for (const edge of derived.values()) {
      if (nonUsesById.has(edge.id)) {
        throw new WorkspaceGraphValidationError(`derived uses edge identity collision: ${edge.id}`);
      }
    }
    const desiredUses = [...derived.values()].sort((left, right) => compareBinary(left.id, right.id));
    const currentUses = current.edges
      .filter((edge) => edge.kind === "uses")
      .sort((left, right) => compareBinary(left.id, right.id));
    if (isDeepStrictEqual(currentUses, desiredUses)) return { graph: current, changed: false };
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw new WorkspaceGraphValidationError("workspace graph revision is exhausted and cannot advance");
    }
    const graph: WorkspaceGraph = {
      workspaceId: workspace.id,
      revision: current.revision + 1,
      nodes: current.nodes,
      edges: [...nonUses, ...desiredUses],
    };
    validateWorkspaceGraph(graph);
    return { graph, changed: true };
  }

  private reconcileDerivedUsesEdges(graph: WorkspaceGraph): void {
    this.db.prepare("DELETE FROM workspace_edges WHERE workspace_id = ? AND kind = 'uses'").run(graph.workspaceId);
    const insert = this.db.prepare(
      `INSERT INTO workspace_edges
         (id, workspace_id, kind, source_node_id, target_node_id, payload_json, created_at, updated_at)
       VALUES (?, ?, 'uses', ?, ?, '{}', ?, ?)`,
    );
    for (const edge of graph.edges) {
      if (edge.kind !== "uses") continue;
      const now = this.clock.now();
      insert.run(edge.id, graph.workspaceId, edge.sourceNodeId, edge.targetNodeId, now, now);
    }
  }

  private withWorkspaceReadContext<T>(operation: () => T): T {
    if (this.activeReadContext !== null) return operation();
    this.activeReadContext = createWorkspaceReadContext();
    try {
      return operation();
    } finally {
      this.activeReadContext = null;
    }
  }

  private readContext(): WorkspaceReadContext {
    if (this.activeReadContext === null) {
      throw new Error("WorkspaceStore immutable reads require a transaction-scoped context");
    }
    return this.activeReadContext;
  }

  private transactionImmediate<T>(operation: () => T): T {
    if (this.db.isTransaction) throw new Error("WorkspaceStore transaction wrapper cannot be nested");
    return this.withWorkspaceReadContext(() => {
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
    });
  }

  private transactionRead<T>(operation: () => T): T {
    return this.withWorkspaceReadContext(() => {
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
    });
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
    const artifacts = new Map<string, { trackId: string; revisionId: string | null }>();
    for (const [artifactId, trackId] of Object.entries(parent.artifactTracks)) {
      if (!Object.hasOwn(parent.artifactRevisions, artifactId)) {
        throw new WorkspaceGraphValidationError(`Snapshot Artifact ${artifactId} has no Revision mapping`);
      }
      artifacts.set(artifactId, { trackId, revisionId: parent.artifactRevisions[artifactId] ?? null });
    }
    const artifactOverrideIds = new Set<string>();
    for (const override of input.artifactOverrides ?? []) {
      if (artifactOverrideIds.has(override.artifactId)) {
        throw new WorkspaceGraphValidationError(`duplicate Snapshot Artifact override ${override.artifactId}`);
      }
      artifactOverrideIds.add(override.artifactId);
      artifacts.set(override.artifactId, { trackId: override.trackId, revisionId: override.revisionId });
    }
    for (const artifactId of new Set(input.artifactRemovals ?? [])) artifacts.delete(artifactId);

    const resources = new Map(Object.entries(parent.resourceRevisions));
    const resourceOverrideIds = new Set<string>();
    for (const override of input.resourceOverrides ?? []) {
      if (resourceOverrideIds.has(override.resourceId)) {
        throw new WorkspaceGraphValidationError(`duplicate Snapshot Resource override ${override.resourceId}`);
      }
      resourceOverrideIds.add(override.resourceId);
      resources.set(override.resourceId, override.revisionId);
    }
    for (const resourceId of new Set(input.resourceRemovals ?? [])) resources.delete(resourceId);

    const kernelRevisionId = input.kernelRevisionId ?? parent.kernelRevisionId;
    const graph = this.requireGraphRevision(workspaceId, input.graphRevision);
    const kernel = this.requireKernelRevision(kernelRevisionId);
    if (graph.workspaceId !== workspaceId || kernel.workspaceId !== workspaceId) {
      throw new WorkspaceGraphValidationError("Workspace Snapshot graph or Kernel belongs to another Workspace");
    }
    this.validateSnapshotMappings(workspaceId, graph, artifacts, resources);
    this.validateRunOwnership(workspaceId, input.createdByRunId ?? null, "Workspace Snapshot");
    const sequence = this.nextSafeSequence(
      "workspace_snapshots",
      "workspace_id",
      workspaceId,
      "Workspace Snapshot",
    );
    const snapshotId = this.clock.id();
    const now = this.clock.now();
    this.db.prepare(
      `INSERT INTO workspace_snapshots (
         id, workspace_id, sequence, parent_snapshot_id, graph_revision, kernel_revision_id,
         reason, provenance_json, created_by_run_id, created_at, sealed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      snapshotId,
      workspaceId,
      sequence,
      input.expectedSnapshotId,
      input.graphRevision,
      kernelRevisionId,
      input.reason,
      JSON.stringify(input.provenance),
      input.createdByRunId ?? null,
      now,
    );
    const insertArtifact = this.db.prepare(
      `INSERT INTO workspace_snapshot_artifacts
         (workspace_id, snapshot_id, artifact_id, track_id, revision_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [artifactId, mapping] of [...artifacts].sort(([left], [right]) => compareBinary(left, right))) {
      insertArtifact.run(workspaceId, snapshotId, artifactId, mapping.trackId, mapping.revisionId);
    }
    const insertResource = this.db.prepare(
      `INSERT INTO workspace_snapshot_resources
         (workspace_id, snapshot_id, resource_id, revision_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [resourceId, revisionId] of [...resources].sort(([left], [right]) => compareBinary(left, right))) {
      insertResource.run(workspaceId, snapshotId, resourceId, revisionId);
    }
    const sealed = this.db.prepare(
      "UPDATE workspace_snapshots SET sealed = 1 WHERE id = ? AND workspace_id = ? AND sealed = 0",
    ).run(snapshotId, workspaceId);
    if (Number(sealed.changes) !== 1) {
      throw new WorkspaceGraphValidationError(`Workspace Snapshot ${snapshotId} could not be sealed`);
    }
    return this.requireSnapshot(workspaceId, snapshotId);
  }

  private validateSnapshotMappings(
    workspaceId: string,
    graph: WorkspaceGraph,
    artifacts: ReadonlyMap<string, { trackId: string; revisionId: string | null }>,
    resources: ReadonlyMap<string, string>,
  ): void {
    const graphArtifacts = new Set<string>();
    const graphResources = new Set<string>();
    for (const node of graph.nodes) {
      if (node.kind === "resource") graphResources.add(node.resourceId);
      else graphArtifacts.add(node.artifactId);
    }
    if (graphArtifacts.size !== artifacts.size
      || [...graphArtifacts].some((artifactId) => !artifacts.has(artifactId))) {
      throw new WorkspaceGraphValidationError("Workspace Snapshot Artifact mapping keys must exactly match the graph");
    }
    for (const [artifactId, mapping] of artifacts) {
      const row = this.db.prepare(
        `SELECT artifact.active_track_id, track.head_revision_id, revision.id AS sealed_revision_id
         FROM workspace_artifacts artifact
         JOIN artifact_tracks track
           ON track.id = artifact.active_track_id AND track.artifact_id = artifact.id
         LEFT JOIN artifact_revisions revision
           ON revision.id = track.head_revision_id
          AND revision.workspace_id = artifact.workspace_id
          AND revision.artifact_id = artifact.id
          AND revision.track_id = track.id
          AND revision.sealed = 1
         WHERE artifact.id = ? AND artifact.workspace_id = ? AND artifact.archived_at IS NULL`,
      ).get(artifactId, workspaceId) as {
        active_track_id: string;
        head_revision_id: string | null;
        sealed_revision_id: string | null;
      } | undefined;
      if (!row
        || row.active_track_id !== mapping.trackId
        || row.head_revision_id !== mapping.revisionId
        || (row.head_revision_id !== null && row.sealed_revision_id !== row.head_revision_id)) {
        throw new WorkspaceGraphValidationError(
          `Workspace Snapshot Artifact mapping ${artifactId} must match its active Track and exact Head`,
        );
      }
    }
    for (const resourceId of graphResources) {
      const resource = this.db.prepare(
        `SELECT head_revision_id FROM resources
         WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
      ).get(resourceId, workspaceId) as { head_revision_id: string | null } | undefined;
      if (!resource) {
        throw new WorkspaceGraphValidationError(`Workspace Snapshot Resource ${resourceId} is not resolvable`);
      }
      if (resource.head_revision_id !== null && !resources.has(resourceId)) {
        throw new WorkspaceGraphValidationError(
          `Workspace Snapshot Resource ${resourceId} with a Head requires an explicit Snapshot pin`,
        );
      }
    }
    for (const [resourceId, revisionId] of resources) {
      if (!graphResources.has(resourceId)) {
        throw new WorkspaceGraphValidationError(`Workspace Snapshot Resource ${resourceId} has no active graph node`);
      }
      const row = this.db.prepare(
        `SELECT 1
         FROM resource_revisions revision
         JOIN resources resource
           ON resource.id = revision.resource_id AND resource.workspace_id = revision.workspace_id
         WHERE revision.id = ? AND revision.resource_id = ?
           AND revision.workspace_id = ? AND resource.archived_at IS NULL`,
      ).get(revisionId, resourceId, workspaceId);
      if (!row) throw new WorkspaceGraphValidationError(`Workspace Snapshot Resource mapping ${resourceId} is not resolvable`);
    }
  }

  private requireSnapshot(workspaceId: string, snapshotId: string): WorkspaceSnapshotRecord {
    const context = this.readContext();
    const cached = context.snapshotRecords.get(snapshotId);
    if (cached !== undefined) {
      if (cached.workspaceId !== workspaceId) throw new Error(`Workspace Snapshot not found: ${snapshotId}`);
      return cached;
    }
    const snapshot = this.loadSnapshotBase(snapshotId);
    if (snapshot === null || snapshot.workspaceId !== workspaceId) {
      throw new Error(`Workspace Snapshot not found: ${snapshotId}`);
    }
    this.validateSnapshotLineage(snapshot);
    const pending: WorkspaceSnapshotBaseRecord[] = [];
    let cursor = snapshot;
    try {
      while (!context.snapshotRecords.has(cursor.id)) {
        if (context.visitingSnapshotRecordIds.has(cursor.id)) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} provenance lineage contains a cycle`,
          );
        }
        context.visitingSnapshotRecordIds.add(cursor.id);
        pending.push(cursor);
        const needsParentRecord = cursor.provenance.kind === "artifact-publication"
          || cursor.provenance.kind === "kernel-publication";
        if (!needsParentRecord || cursor.parentSnapshotId === null) break;
        const parent = this.loadSnapshotBase(cursor.parentSnapshotId);
        if (parent === null || parent.workspaceId !== workspaceId) {
          throw new WorkspaceGraphValidationError(
            `Workspace Snapshot ${snapshot.id} parent is not resolvable`,
          );
        }
        cursor = parent;
      }
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const base = pending[index]!;
        const record = this.buildSnapshotRecord(workspaceId, base);
        context.snapshotRecords.set(record.id, record);
      }
    } finally {
      for (const traversed of pending) context.visitingSnapshotRecordIds.delete(traversed.id);
    }
    return context.snapshotRecords.get(snapshotId)!;
  }

  private buildSnapshotRecord(
    workspaceId: string,
    snapshot: WorkspaceSnapshotBaseRecord,
  ): WorkspaceSnapshotRecord {
    const context = this.readContext();
    const artifactRows = this.db.prepare(
      `SELECT artifact_id, track_id, revision_id FROM workspace_snapshot_artifacts
       WHERE workspace_id = ? AND snapshot_id = ? ORDER BY artifact_id ASC`,
    ).all(workspaceId, snapshot.id) as Row[];
    const resourceRows = this.db.prepare(
      `SELECT resource_id, revision_id FROM workspace_snapshot_resources
       WHERE workspace_id = ? AND snapshot_id = ? ORDER BY resource_id ASC`,
    ).all(workspaceId, snapshot.id) as Row[];
    const graph = this.requireGraphRevision(workspaceId, snapshot.graphRevision);
    const artifactTracks = Object.fromEntries(artifactRows.map((mapping) => [
      requiredCell(mapping.artifact_id, "Snapshot Artifact id"),
      requiredCell(mapping.track_id, "Snapshot Artifact Track id"),
    ]));
    const artifactRevisions = Object.fromEntries(artifactRows.map((mapping) => [
      requiredCell(mapping.artifact_id, "Snapshot Artifact id"),
      mapping.revision_id == null ? null : requiredCell(mapping.revision_id, "Snapshot Artifact Revision id"),
    ]));
    const resourceRevisions = Object.fromEntries(resourceRows.map((mapping) => [
      requiredCell(mapping.resource_id, "Snapshot Resource id"),
      requiredCell(mapping.revision_id, "Snapshot Resource Revision id"),
    ]));
    this.validateStoredSnapshotMappings(
      workspaceId,
      graph,
      artifactTracks,
      artifactRevisions,
      resourceRevisions,
    );
    const record: WorkspaceSnapshotRecord = {
      ...snapshot,
      graph,
      artifactTracks,
      artifactRevisions,
      resourceRevisions,
    };
    if (record.provenance.kind === "artifact-publication") {
      if (record.parentSnapshotId === null) {
        throw new WorkspaceGraphValidationError(
          `Artifact publication Snapshot ${record.id} must be a direct successor`,
        );
      }
      const revision = this.requireArtifactRevision(record.provenance.revisionId);
      const parent = context.snapshotRecords.get(record.parentSnapshotId);
      if (parent === undefined) {
        throw new WorkspaceGraphValidationError(
          `Artifact publication Snapshot ${record.id} parent audit record is not resolvable`,
        );
      }
      const provenanceRunId = record.provenance.runId ?? null;
      if (revision.workspaceId !== workspaceId
        || record.artifactTracks[revision.artifactId] !== revision.trackId
        || record.artifactRevisions[revision.artifactId] !== revision.id
        || parent.artifactTracks[revision.artifactId] !== revision.trackId
        || parent.artifactRevisions[revision.artifactId] !== revision.parentRevisionId
        || provenanceRunId !== revision.producedByRunId
        || record.createdByRunId !== revision.producedByRunId) {
        throw new WorkspaceGraphValidationError(
          `Artifact publication Snapshot ${record.id} audit provenance does not match immutable history`,
        );
      }
    }
    if (record.provenance.kind === "kernel-publication") {
      const impact = record.provenance.impact;
      if (record.parentSnapshotId === null
        || record.provenance.kernelRevisionId !== record.kernelRevisionId
        || impact === undefined) {
        throw new WorkspaceGraphValidationError(
          `Kernel publication Snapshot ${record.id} has incomplete audit provenance`,
        );
      }
      const target = this.requireKernelRevision(record.kernelRevisionId);
      const parent = context.snapshotRecords.get(record.parentSnapshotId);
      if (parent === undefined) {
        throw new WorkspaceGraphValidationError(
          `Kernel publication Snapshot ${record.id} parent audit record is not resolvable`,
        );
      }
      const expectedImpact = this.computeKernelImpact(target, parent);
      if (!isDeepStrictEqual(impact, expectedImpact)) {
        throw new WorkspaceGraphValidationError(
          `Kernel publication Snapshot ${record.id} impact audit does not match immutable history`,
        );
      }
    }
    return record;
  }

  private validateStoredSnapshotMappings(
    workspaceId: string,
    graph: WorkspaceGraph,
    artifactTracks: Readonly<Record<string, string>>,
    artifactRevisions: Readonly<Record<string, string | null>>,
    resourceRevisions: Readonly<Record<string, string>>,
  ): void {
    const graphArtifacts = new Map(
      graph.nodes
        .filter((node): node is Extract<WorkspaceNode, { kind: "page" | "component" }> => node.kind !== "resource")
        .map((node) => [node.artifactId, node.kind] as const),
    );
    const graphArtifactIds = [...graphArtifacts.keys()].sort(compareBinary);
    const mappedArtifactIds = Object.keys(artifactTracks).sort(compareBinary);
    const revisionArtifactIds = Object.keys(artifactRevisions).sort(compareBinary);
    if (!isDeepStrictEqual(graphArtifactIds, mappedArtifactIds)
      || !isDeepStrictEqual(mappedArtifactIds, revisionArtifactIds)) {
      throw new WorkspaceGraphValidationError(
        "stored Workspace Snapshot Artifact mappings must exactly match its immutable graph",
      );
    }
    for (const artifactId of mappedArtifactIds) {
      const trackId = artifactTracks[artifactId];
      const revisionId = artifactRevisions[artifactId];
      const artifactKind = graphArtifacts.get(artifactId);
      if (trackId === undefined || revisionId === undefined || artifactKind === undefined) {
        throw new WorkspaceGraphValidationError(`stored Workspace Snapshot Artifact ${artifactId} is incomplete`);
      }
      const owned = revisionId === null
        ? this.db.prepare(
            `SELECT 1
             FROM artifact_tracks track
             JOIN workspace_artifacts artifact ON artifact.id = track.artifact_id
             WHERE track.id = ? AND track.artifact_id = ? AND artifact.workspace_id = ?
               AND artifact.kind = ?`,
          ).get(trackId, artifactId, workspaceId, artifactKind)
        : this.db.prepare(
            `SELECT 1
             FROM artifact_revisions revision
             JOIN artifact_tracks track
               ON track.id = revision.track_id AND track.artifact_id = revision.artifact_id
             JOIN workspace_artifacts artifact
               ON artifact.id = revision.artifact_id AND artifact.workspace_id = revision.workspace_id
             WHERE revision.id = ? AND revision.workspace_id = ?
               AND revision.artifact_id = ? AND revision.track_id = ? AND revision.sealed = 1
               AND artifact.kind = ?`,
          ).get(revisionId, workspaceId, artifactId, trackId, artifactKind);
      if (!owned) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Artifact mapping ${artifactId} is not an exact owned Revision pin`,
        );
      }
      if (revisionId !== null) {
        const revision = this.requireArtifactRevision(revisionId);
        if (revision.workspaceId !== workspaceId
          || revision.artifactId !== artifactId
          || revision.trackId !== trackId) {
          throw new WorkspaceGraphValidationError(
            `stored Workspace Snapshot Artifact mapping ${artifactId} is not an exact owned Revision pin`,
          );
        }
      }
    }
    const graphResourceIds = new Set(
      graph.nodes.filter((node) => node.kind === "resource").map((node) => node.resourceId),
    );
    for (const resourceId of graphResourceIds) {
      const identity = this.db.prepare(
        "SELECT 1 FROM resources WHERE id = ? AND workspace_id = ?",
      ).get(resourceId, workspaceId);
      if (!identity) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Resource ${resourceId} has no owned identity`,
        );
      }
    }
    for (const [resourceId, revisionId] of Object.entries(resourceRevisions)) {
      if (!graphResourceIds.has(resourceId)) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Resource ${resourceId} has no immutable graph node`,
        );
      }
      const owned = this.db.prepare(
        `SELECT 1 FROM resource_revisions
         WHERE id = ? AND resource_id = ? AND workspace_id = ?`,
      ).get(revisionId, resourceId, workspaceId);
      if (!owned) {
        throw new WorkspaceGraphValidationError(
          `stored Workspace Snapshot Resource mapping ${resourceId} is not an exact owned Revision pin`,
        );
      }
    }
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
